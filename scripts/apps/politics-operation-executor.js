import { SkyholdData } from "../data/store.js";
import { appendHoldingOperation, findHoldingOperation } from "../data/operations.js";
import { applyPoliticsAct } from "../engines/politics/acts.js";
import { getSkyholdManager } from "./registry.js";
import { politicsDecisionContext } from "./politics-decision-context.js";
import { politicsPlayerActionAllowed } from "../data/politics-permissions.js";

/** Intent commands are validated and committed only on the authority GM. */
export async function executePoliticsOperation(raw = {}, {
  store = SkyholdData,
  getUser = (id) => id ? globalThis.game?.users?.get?.(id) : globalThis.game?.user,
  getManager = getSkyholdManager,
  userId = null,
  remote = false
} = {}) {
  if (!getUser()?.isGM) return { ok: false, reason: "Только ГМ может оформить политический акт." };
  const requester = getUser(userId);
  if (!requester || (remote && requester.isGM)) return { ok: false, reason: "Недопустимый отправитель политического действия." };
  const operationId = String(raw.operationId ?? "").trim();
  const holdingId = String(raw.holdingId ?? "").trim();
  const expectedRevision = Number(raw.expectedRevision);
  if (!operationId || operationId.length > 100 || !holdingId || holdingId.length > 100 || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return { ok: false, reason: "Некорректные данные политического действия." };
  }
  const action = String(raw.action ?? "");
  const payload = raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload) ? raw.payload : {};
  let requestSignature;
  try { requestSignature = JSON.stringify({ action, payload }); }
  catch { return { ok: false, reason: "Некорректное политическое действие." }; }
  if (requestSignature.length > 5000) return { ok: false, reason: "Политическое действие слишком велико." };
  const result = await store.updateHolding(holdingId, (holding, data) => {
    if (!getUser()?.isGM) return store.skipTransaction({ ok: false, reason: "Полномочия ГМа утрачены." });
    const user = getUser(userId);
    if (!user || !politicsPlayerActionAllowed(holding, action, user)) return store.skipTransaction({ ok: false, reason: "Нет права на это политическое действие." });
    const prior = findHoldingOperation(holding, operationId);
    if (prior) return store.skipTransaction(prior.type === "politics" && prior.payload?.requestSignature === requestSignature
      && (prior.payload?.actorId === String(user.id ?? "") || (!prior.payload?.actorId && user.isGM))
      ? { ok: true, replay: true, operationId, summary: prior.summary }
      : { ok: false, reason: "Идентификатор действия уже использован." });
    if (expectedRevision !== Number(data?.meta?.revision)) {
      return store.skipTransaction({ ok: false, conflict: true, reason: "Данные поселения изменились. Повторите действие после обновления окна." });
    }
    if (action === "resolve-request" && payload.approved === true) {
      const request = holding.politics?.pendingApprovals?.find((entry) => entry.id === payload.id && entry.status === "pending");
      const author = request && getUser(request.actorId);
      if (!author || !politicsPlayerActionAllowed(holding, request.action, author)) return store.skipTransaction({ ok: false, reason: "Автор заявки больше не имеет права на запрошенное действие." });
    }
    const context = politicsDecisionContext(holding, getManager(), { data });
    const appliedAction = !user.isGM && action === "decree" && holding.politics?.stage === "charter"
      && holding.politics?.charter?.approvalRequired ? "request-decree" : action;
    const applied = applyPoliticsAct(holding, { action: appliedAction, payload, operationId, actorId: String(user.id ?? ""), context });
    if (!applied.ok || applied.noop) return store.skipTransaction(applied);
    holding.politics = applied.state;
    if (applied.storage) holding.storage = applied.storage;
    appendHoldingOperation(holding, {
      operationId, type: "politics", createdAt: new Date().toISOString(),
      title: "Политический акт", summary: applied.summary, payload: { action, requestSignature, actorId: String(user.id ?? "") }
    });
    return { ok: true, operationId, summary: applied.summary };
  }, { fallback: false, reason: `politics:${action}` });
  return result ?? { ok: false, reason: "Поселение не найдено." };
}
