import { SkyholdData } from "../data/store.js";
import { canReadHolding } from "../data/access-guard.js";
import { holdingPermissionContext } from "../data/holding-permissions.js";
import { isSheriffAppointment } from "../data/control-appointments.js";
import { appendHoldingOperation, findHoldingOperation } from "../data/operations.js";
import { buildingOperationalState } from "../core/building-state.js";
import { controlServiceFunctionId } from "../engines/settlement/control.js";
import { controlResidentAvailable, hasControlEffect } from "./domains/control-context.js";
import { getSkyholdManager } from "./registry.js";

/** Uses the ordinary holding transaction; player commits retain the authority-GM patch protocol. */
export async function executeControlWorkOperation(raw = {}, {
  store = SkyholdData, getUser = () => globalThis.game?.user, getManager = getSkyholdManager
} = {}) {
  const operationId = String(raw.operationId ?? "").trim();
  const holdingId = String(raw.holdingId ?? "").trim();
  const action = String(raw.action ?? "");
  const buildingId = String(raw.buildingId ?? "");
  const residentId = String(raw.residentId ?? "");
  const expectedRevision = Number(raw.expectedRevision);
  if (!operationId || operationId.length > 100 || !holdingId || holdingId.length > 100
    || buildingId.length > 100 || residentId.length > 100 || !["sheriff", "add", "remove"].includes(action)
    || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return { ok: false, reason: "Некорректные данные назначения." };
  }
  const requestSignature = JSON.stringify({ action, buildingId, residentId });
  const result = await store.updateHolding(holdingId, (holding, data) => {
    const user = getUser();
    const manager = getManager();
    const fail = (reason, extra = {}) => store.skipTransaction({ ok: false, reason, ...extra });
    if (!canReadHolding(holding, user) || !holdingPermissionContext(holding, { user }).canEditBuildings) {
      return fail("Нет права назначать жителей на работу или активного ГМа.");
    }
    if (!manager?._assignPersonToBuilding || !manager?._setPersonFree || !manager?._clearPersonFromAssignments) {
      return fail("Главное окно поселения недоступно для назначения.");
    }
    const prior = findHoldingOperation(holding, operationId);
    if (prior) return store.skipTransaction(prior.type === "worker-assignment" && prior.payload?.requestSignature === requestSignature
      ? { ok: true, replay: true, summary: prior.summary } : { ok: false, reason: "Идентификатор действия уже использован." });
    if (expectedRevision !== Number(data?.meta?.revision)) return fail("Данные поселения изменились. Повторите назначение после обновления окна.", { conflict: true });
    // Explicit GM admissions remain GM-owned. Ordinary player assignments may
    // use an existing exception but cannot add or revoke one through a patch.
    const gmAdmissions = new Map((holding.buildings?.list ?? []).map((building) =>
      [String(building.id), [...(building.workerAdmissionOverrideIds ?? [])]]));
    const person = (holding.people?.list ?? []).find((row) => String(row.id) === residentId);
    if (residentId && (!person || !user?.isGM && person.visibility === "gm")) return fail("Житель недоступен.");
    let cleared = 0;
    let summary;
    if (action === "sheriff") {
      if (person && !controlResidentAvailable(holding, person, manager, { sheriff: true })) return fail("Житель занят или не может работать. Сначала освободите его от прежней работы.");
      const sheriffs = (holding.people?.list ?? []).filter((row) => isSheriffAppointment(row) && !row.dead);
      if (sheriffs.some((row) => (row.workAllocations ?? []).some((work) => Number(work?.normalQd ?? work?.qd ?? 0) > 0 || Number(work?.overtimeQd ?? 0) > 0)
        || manager._assignedWorkerSet?.(holding)?.has(String(row.id)) || !user?.isGM && row.visibility === "gm")) {
        return fail("Прежний шериф связан с другим назначением. Сначала освободите его в разделе жителей.");
      }
      if ((sheriffs.length === 1 && String(sheriffs[0].id) === residentId) || (!sheriffs.length && !residentId)) {
        return store.skipTransaction({ ok: true, noop: true, summary: "Назначение не изменилось." });
      }
      for (const sheriff of sheriffs) {
        manager._clearPersonFromAssignments(holding, sheriff.id);
        manager._setPersonFree(holding, sheriff.id);
        cleared += 1;
      }
      if (person) {
        manager._clearPersonFromAssignments(holding, person.id);
        person.workAllocations = [];
        person.workAssignment = "other";
        person.role = "Шериф";
      }
      summary = person ? `Шериф: ${person.name || "Житель"}.` : "Должность шерифа освобождена.";
    } else {
      const building = (holding.buildings?.list ?? []).find((row) => String(row.id) === buildingId);
      if (!person || !building || !hasControlEffect(building) || !user?.isGM && building.visibility === "gm") return fail("Учреждение или житель недоступны.");
      if (action === "add") {
        if (!buildingOperationalState(building).operational) return fail("Назначение доступно после постройки и восстановления здания.");
        if (!controlResidentAvailable(holding, person, manager)) return fail("Житель занят или не может работать.");
        const assigned = manager._assignPersonToBuilding(holding, person.id, building.id, {
          functionId: controlServiceFunctionId(building),
          allowAdmissionOverride: user?.isGM === true && raw.allowAdmissionOverride === true
        });
        if (!assigned) return fail("Нет свободных QD, вместимости здания или не выполнен обязательный допуск.");
        summary = `${person.name || "Житель"} назначен: ${building.name || "Учреждение"}.`;
      } else {
        const removed = manager._removePersonFromBuilding?.(holding, building.id, person.id);
        if (!removed) return fail("Рабочее назначение уже изменилось.");
        cleared = 1;
        summary = `${person.name || "Житель"} освобождён: ${building.name || "Учреждение"}.`;
      }
    }
    if (!user?.isGM) {
      for (const building of holding.buildings?.list ?? []) building.workerAdmissionOverrideIds = gmAdmissions.get(String(building.id));
    }
    appendHoldingOperation(holding, { operationId, type: "worker-assignment", createdAt: new Date().toISOString(),
      title: "Назначение службы Контроля", summary, assigned: residentId && action !== "remove" ? 1 : 0,
      cleared, payload: { requestSignature, action, buildingId, residentId } });
    return { ok: true, operationId, summary };
  }, { fallback: false, reason: `control:work:${action}` });
  return result ?? { ok: false, reason: "Поселение не найдено." };
}
