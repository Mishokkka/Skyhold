import { canReadHolding, canReadResident, hiddenBuildingIds } from "../data/access-guard.js";
import { canReadBuildingLaborWithdrawal } from "../data/building-demolition.js";
import { COMMAND_ERROR, commandError, commandFailure } from "../data/command-result.js";
import {
  applyBuildingLaborWithdrawal,
  applyWorkforcePlanAllocations,
  mutateResidentBuildingLabor,
  planBuildingLaborWithdrawal
} from "../data/labor-mutations.js";
import { canonicalSignatureV1 } from "../data/sha256.js";
import { workforceCommandProblem } from "../data/workforce-socket.js";
import { isWorkforcePlanRowVisible, lockedAllocationChangeError, mergePublicWorkAllocations, workforceIssueMessage,
  workforceKey, workforceLockKey, workforcePlan, workforcePlanChangeError, workforceProductionGoalKey } from "../data/workforce-plan.js";

function failure(operationId, code, message, revision) {
  return commandError(commandFailure({ operationId, code, message, revision, retryable: code === COMMAND_ERROR.CONFLICT }));
}

function applyPlanDelta(holding, command) {
  const plan = structuredClone(workforcePlan(holding));
  const locks = new Map(plan.locks.map((row) => [workforceLockKey(row), row]));
  const goals = new Map(plan.productionGoals.map((row) => [workforceProductionGoalKey(row), row]));
  for (const [personId, sourceId, functionId, enabled] of command.locks ?? []) {
    const row = { personId, sourceId, functionId };
    const key = workforceLockKey(row);
    const existing = locks.get(key);
    if (enabled && !existing) locks.set(key, row);
    if (!enabled) locks.delete(key);
  }
  for (const [sourceId, functionId, preparedUnits] of command.productionGoals ?? []) {
    const baseRow = { sourceId, functionId, preparedUnits };
    const key = workforceProductionGoalKey(baseRow);
    const existing = goals.get(key);
    if (preparedUnits) {
      goals.set(key, existing?.visibility ? { ...baseRow, visibility: existing.visibility } : baseRow);
    } else {
      goals.delete(key);
    }
  }
  return { version: 2, locks: [...locks.values()], productionGoals: [...goals.values()] };
}

export async function executeWorkforcePlan(raw, { senderId, store } = {}) {
  const operationId = raw?.operationId;
  const problem = workforceCommandProblem(raw);
  if (problem) throw failure(operationId, COMMAND_ERROR.INVALID, problem);
  const { holdingId, expectedRevision } = raw;
  const signature = canonicalSignatureV1(raw);
  const result = await store.updateHolding(holdingId, (holding, data) => {
    const currentRevision = data.meta.revision;
    const fail = (code, message) => { throw failure(operationId, code, message, currentRevision); };
    const prior = holding.operations?.find((row) => row.operationId === operationId && row.senderId === senderId && row.holdingId === holdingId);
    if (prior) {
      if (prior.signature !== signature) fail(COMMAND_ERROR.CONFLICT, "Идентификатор операции уже использован другой командой.");
      return store.skipTransaction(prior.result);
    }
    if (expectedRevision !== currentRevision) fail(COMMAND_ERROR.CONFLICT, "Данные изменились. Сверьте черновик с актуальным общим планом.");
    const sender = globalThis.game?.users?.get(senderId);
    if (!sender || !canReadHolding(holding, sender) || (!sender.isGM && holding.gm?.playersCanEditBuildings !== true)) {
      fail(COMMAND_ERROR.FORBIDDEN, "Нет права менять общий план работ.");
    }
    const isGM = sender.isGM === true;
    const people = new Map((holding.people?.list ?? []).map((row) => [String(row.id), row]));
    const buildings = new Map((holding.buildings?.list ?? []).map((row) => [String(row.id), row]));
    const hidden = hiddenBuildingIds(holding, isGM);
    const kind = raw.kind ?? "save-plan";
    let receipt;
    if (kind === "withdraw-building-labor") {
      const building = buildings.get(raw.buildingId);
      if (!building || hidden.has(raw.buildingId)) fail(COMMAND_ERROR.FORBIDDEN, "Здание недоступно.");
      const current = planBuildingLaborWithdrawal(holding, raw.buildingId, raw.functionId ?? "");
      if (!canReadBuildingLaborWithdrawal(holding, current, sender)) fail(COMMAND_ERROR.FORBIDDEN, "Часть назначений доступна только ГМу.");
      if (current.token !== raw.token) fail(COMMAND_ERROR.CONFLICT, "Распределение труда изменилось. Обновите предпросмотр.");
      const applied = applyBuildingLaborWithdrawal(holding, current, { confirmed: true });
      if (!applied.ok) fail(applied.stale ? COMMAND_ERROR.CONFLICT : COMMAND_ERROR.INVALID,
        workforceIssueMessage(holding, applied.issues?.[0], { isGM }) || applied.message || "Не удалось освободить работников.");
      receipt = { ok: true, operationId, revision: currentRevision + 1, personIds: applied.personIds,
        summary: `Освобождено жителей: ${applied.personIds.length}.` };
    } else if (kind === "remove-resident-allocation") {
      const person = people.get(raw.personId);
      const building = buildings.get(raw.buildingId);
      if (!canReadResident(person, sender) || !building || hidden.has(raw.buildingId)) {
        fail(COMMAND_ERROR.FORBIDDEN, "Назначение недоступно. Обновите окно или обратитесь к ГМу.");
      }
      const check = mutateResidentBuildingLabor(holding, { personId: raw.personId, buildingId: raw.buildingId,
        functionId: raw.functionId ?? "", action: "remove", isGM, preserveAllocationSourceIds: hidden });
      if (!check.ok) {
        const issue = check.orphanedOvertime ? check.issues.find((row) => row.code === "allocation-overtime-days") : check.issues?.[0];
        fail(check.forbidden ? COMMAND_ERROR.FORBIDDEN : COMMAND_ERROR.INVALID, isGM && check.orphanedOvertime
          ? check.message
          : (workforceIssueMessage(holding, issue, { isGM }) || check.message || "Не удалось снять назначение."));
      }
      receipt = { ok: true, operationId, revision: currentRevision + 1, summary: "Назначение снято." };
    } else if (kind === "add-resident-allocation") {
      if (!isGM && raw.allowAdmissionOverride !== undefined) fail(COMMAND_ERROR.FORBIDDEN, "Допусками к работе управляет ГМ.");
      const person = people.get(raw.personId);
      const building = buildings.get(raw.buildingId);
      if (!canReadResident(person, sender) || !building || hidden.has(raw.buildingId)) {
        fail(COMMAND_ERROR.FORBIDDEN, "Назначение недоступно. Обновите окно или обратитесь к ГМу.");
      }
      const targetLockKey = workforceLockKey({ personId: raw.personId, sourceId: raw.buildingId, functionId: raw.functionId });
      const existingLock = (holding.workforcePlan?.locks ?? []).find((row) => workforceLockKey(row) === targetLockKey);
      if (existingLock) {
        fail(COMMAND_ERROR.FORBIDDEN, !isGM && !isWorkforcePlanRowVisible(existingLock, { buildings, people, isGM })
          ? "Назначение недоступно. Обновите окно или обратитесь к ГМу."
          : "Сначала снимите закрепление назначения.");
      }
      const check = mutateResidentBuildingLabor(holding, {
        personId: raw.personId,
        buildingId: raw.buildingId,
        functionId: raw.functionId,
        action: "add",
        normalQd: raw.normalQd,
        overtimeQd: raw.overtimeQd,
        allowAdmissionOverride: isGM && raw.allowAdmissionOverride === true,
        preserveAllocationSourceIds: hidden,
        isGM
      });
      if (!check.ok) {
        fail(check.forbidden ? COMMAND_ERROR.FORBIDDEN : COMMAND_ERROR.INVALID,
          workforceIssueMessage(holding, check.issues?.[0], { isGM }) || check.message || "Не удалось добавить назначение.");
      }
      receipt = { ok: true, operationId, revision: currentRevision + 1, summary: "Назначение сохранено." };
    } else {
      const { allocationsByPersonId, admissionOverrideBuildingIds } = raw;
      if (!isGM && admissionOverrideBuildingIds !== undefined) fail(COMMAND_ERROR.FORBIDDEN, "Допусками к работе управляет ГМ.");
      const plan = applyPlanDelta(holding, raw);
      const planError = workforcePlanChangeError(holding, plan, { isGM });
      if (planError) fail(COMMAND_ERROR.FORBIDDEN, planError);
      const updates = Object.entries(allocationsByPersonId).map(([personId, tuples]) => {
        const person = people.get(personId);
        if (!canReadResident(person, sender) || tuples.some(([id]) => !buildings.has(id) || hidden.has(id))) {
          fail(COMMAND_ERROR.FORBIDDEN, "Назначение недоступно. Обновите окно или обратитесь к ГМу.");
        }
        const previous = new Map((person.workAllocations ?? []).map((row) => [workforceKey(row), row]));
        const nextAllocations = tuples.map(([sourceId, functionId, normalQd, overtimeQd]) => {
          const row = { sourceId, functionId, normalQd, overtimeQd };
          return { ...previous.get(workforceKey(row)), ...row };
        });
        return { personId, nextAllocations: mergePublicWorkAllocations(person.workAllocations ?? [], nextAllocations, hidden),
          admissionOverrideBuildingIds: admissionOverrideBuildingIds?.[personId] };
      });
      const updatesById = new Map(updates.map((row) => [String(row.personId), row.nextAllocations]));
      const afterPreview = {
        ...holding,
        workforcePlan: plan,
        people: {
          ...holding.people,
          list: (holding.people?.list ?? []).map((person) => updatesById.has(String(person.id))
            ? { ...person, workAllocations: updatesById.get(String(person.id)) }
            : person)
        }
      };
      const lockError = lockedAllocationChangeError(holding, afterPreview, plan, { isGM });
      if (lockError) fail(COMMAND_ERROR.FORBIDDEN, lockError);
      const check = applyWorkforcePlanAllocations(holding, { updates, preserveAllocationSourceIds: hidden });
      if (!check.ok) fail(COMMAND_ERROR.INVALID, workforceIssueMessage(holding, check.issues?.[0], { isGM })
        || check.message || "Общий план отклонён.");
      holding.workforcePlan = plan;
      receipt = { ok: true, operationId, revision: currentRevision + 1, summary: `Общий план сохранён. Изменено жителей: ${updates.length}.` };
    }
    holding.operations = [...(holding.operations ?? []), { operationId, senderId, holdingId, signature, result: receipt }].slice(-250);
    return receipt;
  }, { fallback: false, reason: `workforce:${raw?.kind ?? "save-plan"}`, localAuthority: true });
  if (!result) throw failure(operationId, COMMAND_ERROR.FORBIDDEN, "Поселение недоступно.");
  return result;
}
