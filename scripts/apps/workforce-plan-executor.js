import { SkyholdData } from "../data/store.js";
import { canReadHolding } from "../data/access-guard.js";
import { holdingPermissionContext } from "../data/holding-permissions.js";
import { appendHoldingOperation, findHoldingOperation } from "../data/operations.js";
import { applyWorkforceDraft, workforceDraftError } from "./domains/workforce-planner.js";

/** Ordinary holding transactions retain the authority-GM socket/patch acknowledgement protocol. */
export async function executeWorkforcePlan(raw, { store = SkyholdData, getUser = () => globalThis.game?.user } = {}) {
  const { operationId, holdingId, expectedRevision, draft } = raw ?? {};
  if (typeof operationId !== "string" || !operationId || operationId.length > 100
    || typeof holdingId !== "string" || !holdingId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
    || !draft || !Array.isArray(draft.edited) || draft.edited.length > 500 || new Set(draft.edited).size !== draft.edited.length
    || draft.edited.some((id) => typeof id !== "string" || !id || !Array.isArray(draft.allocations?.[id]) || draft.allocations[id].length > 24)) {
    return { ok: false, reason: "Некорректный план работ." };
  }
  const requestSignature = JSON.stringify({ plan: draft.plan, edited: draft.edited,
    allocations: Object.fromEntries(draft.edited.map((id) => [id, draft.allocations[id]])),
    staffAppointments: Object.fromEntries(draft.edited.map((id) => [id, draft.staffAppointments?.[id] ?? null])) });
  if (requestSignature.length > 240000) return { ok: false, reason: "План слишком велик для одной операции." };
  return await store.updateHolding(holdingId, (holding, data) => {
    const user = getUser();
    const fail = (reason, extra = {}) => store.skipTransaction({ ok: false, reason, ...extra });
    if (!canReadHolding(holding, user) || !holdingPermissionContext(holding, { user }).canEditBuildings) return fail("Нет права менять назначения или активного ГМа.");
    const prior = findHoldingOperation(holding, operationId);
    if (prior) return store.skipTransaction(prior.type === "worker-assignment" && prior.payload?.requestSignature === requestSignature
      ? { ok: true, replay: true, summary: prior.summary } : { ok: false, reason: "Идентификатор операции уже использован." });
    if (Number(data.meta?.revision) !== expectedRevision) return fail("Данные изменились в другом окне. Черновик сохранён в окне; сравните его перед обновлением.", { conflict: true });
    const error = workforceDraftError(holding, draft, { isGM: user?.isGM === true });
    if (error) return fail(error);
    applyWorkforceDraft(holding, draft);
    const summary = `Сохранён общий план работ: изменены назначения ${draft.edited.length} жителей, а также общие цели и закрепления.`;
    appendHoldingOperation(holding, { operationId, type: "worker-assignment", title: "План работ", summary, createdAt: new Date().toISOString(),
      assigned: draft.edited.length, cleared: 0, payload: { workforcePlanner: true, expectedRevision, requestSignature } });
    return { ok: true, operationId, summary };
  }, { fallback: false, reason: "workforce:save-plan" }) ?? { ok: false, reason: "Поселение не найдено." };
}
