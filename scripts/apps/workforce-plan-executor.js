import { canReadHolding, canReadResident, hiddenBuildingIds, residentHasHiddenWork } from "../data/access-guard.js";
import { COMMAND_ERROR, commandError, commandFailure } from "../data/command-result.js";
import { applyWorkforcePlanAllocations } from "../data/labor-mutations.js";
import { canonicalSignatureV1 } from "../data/sha256.js";
import { workforceCommandProblem } from "../data/workforce-socket.js";
import { workforceIssueMessage, workforceKey, workforceLockKey, workforcePlan,
  workforcePlanChangeError, workforceProductionGoalKey } from "../data/workforce-plan.js";

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
    if (enabled && !locks.has(key)) locks.set(key, row);
    if (!enabled) locks.delete(key);
  }
  for (const [sourceId, functionId, preparedUnits] of command.productionGoals ?? []) {
    const row = { sourceId, functionId, preparedUnits };
    const key = workforceProductionGoalKey(row);
    if (preparedUnits) goals.set(key, row);
    else goals.delete(key);
  }
  return { version: 2, locks: [...locks.values()], productionGoals: [...goals.values()] };
}

export async function executeWorkforcePlan(raw, { senderId, store } = {}) {
  const operationId = raw?.operationId;
  const problem = workforceCommandProblem(raw);
  if (problem) throw failure(operationId, COMMAND_ERROR.INVALID, problem);
  const { holdingId, expectedRevision, allocationsByPersonId, admissionOverrideBuildingIds } = raw;
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
    if (!isGM && admissionOverrideBuildingIds !== undefined) fail(COMMAND_ERROR.FORBIDDEN, "Допусками к работе управляет ГМ.");
    const plan = applyPlanDelta(holding, raw);
    const planError = workforcePlanChangeError(holding, plan, { isGM });
    if (planError) fail(COMMAND_ERROR.FORBIDDEN, planError);
    const people = new Map((holding.people?.list ?? []).map((row) => [String(row.id), row]));
    const buildings = new Map((holding.buildings?.list ?? []).map((row) => [String(row.id), row]));
    const hidden = hiddenBuildingIds(holding, isGM);
    const updates = Object.entries(allocationsByPersonId).map(([personId, tuples]) => {
      const person = people.get(personId);
      if (!canReadResident(person, sender) || residentHasHiddenWork(holding, person, hidden)
        || tuples.some(([id]) => !buildings.has(id) || hidden.has(id))) {
        fail(COMMAND_ERROR.FORBIDDEN, "Назначение недоступно. Обновите окно или обратитесь к ГМу.");
      }
      const previous = new Map((person.workAllocations ?? []).map((row) => [workforceKey(row), row]));
      const nextAllocations = tuples.map(([sourceId, functionId, normalQd, overtimeQd]) => {
        const row = { sourceId, functionId, normalQd, overtimeQd };
        return { ...previous.get(workforceKey(row)), ...row };
      });
      return { personId, nextAllocations, admissionOverrideBuildingIds: admissionOverrideBuildingIds?.[personId] };
    });
    const check = applyWorkforcePlanAllocations(holding, { updates });
    if (!check.ok) fail(COMMAND_ERROR.INVALID, workforceIssueMessage(holding, check.issues?.[0], { isGM })
      || check.message || "Общий план отклонён.");
    holding.workforcePlan = plan;
    const receipt = { ok: true, operationId, revision: currentRevision + 1, summary: `Общий план сохранён. Изменено жителей: ${updates.length}.` };
    holding.operations = [...(holding.operations ?? []), { operationId, senderId, holdingId, signature, result: receipt }].slice(-250);
    return receipt;
  }, { fallback: false, reason: "workforce:save-plan", localAuthority: true });
  if (!result) throw failure(operationId, COMMAND_ERROR.FORBIDDEN, "Поселение недоступно.");
  return result;
}
