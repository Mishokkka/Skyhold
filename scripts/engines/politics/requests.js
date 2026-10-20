import { normalizePoliticsState } from "../../data/politics-state.js";
import { appendPoliticsHistory, politicsPeriodIndex } from "./rules.js";

export const POLITICS_WORKFLOW_ACTIONS = new Set(["petition", "resolve-petition", "request-decree", "request-intel", "resolve-request", "cancel-decree", "use-decree", "revolt"]);
const text = (value, limit = 500) => String(value ?? "").trim().slice(0, limit);
const fail = (reason) => ({ ok: false, reason });

/** Public records only. GM approval re-executes the original intent on current data. */
export function applyPoliticsWorkflow(holding, { action, payload = {}, actorId = "", operationId = "" }, applyIntent) {
  let state = normalizePoliticsState(holding.politics);
  const periodIndex = politicsPeriodIndex(holding.gm?.calendaria?.lastQd);
  const detail = { type: action, actorId, operationId, periodIndex };
  let storage;
  let summary;
  if (action === "petition") {
    const message = text(payload.message, 2000);
    if (!message) return fail("Напишите публичное обращение.");
    if (state.petitions.filter((entry) => entry.status === "pending").length >= 50) return fail("Сначала рассмотрите накопившиеся обращения.");
    state.petitions = [...state.petitions.filter((entry) => entry.status === "pending"),
      ...state.petitions.filter((entry) => entry.status !== "pending").slice(-49),
      { id: operationId, actorId, periodIndex, message, status: "pending" }];
    summary = `Публичное обращение: ${message}`;
  } else if (action === "resolve-petition") {
    const entry = state.petitions.find((row) => row.id === payload.id && row.status === "pending");
    const response = text(payload.response, 2000);
    if (!entry || !response) return fail("Выберите открытое обращение и укажите публичный ответ.");
    Object.assign(entry, { status: "resolved", response, resolvedPeriodIndex: periodIndex, resolvedBy: actorId });
    summary = `Ответ на обращение: ${response}`;
    detail.petitionId = entry.id;
  } else if (action === "request-decree" || action === "request-intel") {
    const decreeId = action === "request-intel" ? "intel-support" : text(payload.decreeId, 100);
    if (action === "request-decree") {
      const preflight = applyIntent({ action: "decree", payload: { decreeId } });
      if (!preflight.ok) return preflight;
      // Preflight is a pure draft: its payment and effects are not committed.
    } else if (!state.activeDecrees.some((entry) => entry.decreeId === decreeId && !entry.used && !entry.cancelled
      && entry.issuedPeriodIndex <= periodIndex && periodIndex < entry.expiresPeriodIndex)) return fail("Нет действующей карты «Сведения».");
    const topic = action === "request-intel" ? text(payload.topic, 500) : "";
    if (action === "request-intel" && !topic) return fail("Укажите маршрут, рынок или действующее лицо и вопрос для зацепки.");
    if (state.pendingApprovals.some((entry) => entry.status === "pending" && entry.action === action && entry.decreeId === decreeId)) return fail("Заявка по этому указу уже ожидает решения ГМа.");
    if (state.pendingApprovals.filter((entry) => entry.status === "pending").length >= 50) return fail("Сначала рассмотрите накопившиеся заявки.");
    state.pendingApprovals = [...state.pendingApprovals.filter((entry) => entry.status === "pending"),
      ...state.pendingApprovals.filter((entry) => entry.status !== "pending").slice(-49),
      { id: operationId, actorId, periodIndex, action, decreeId, topic, status: "pending" }];
    summary = action === "request-intel" ? `Запрос «Сведений»: ${topic}. Карта ожидает ответа ГМа.` : `Запрошено одобрение указа ${decreeId}. Оплата ещё не списана.`;
  } else if (action === "resolve-request") {
    const request = state.pendingApprovals.find((entry) => entry.id === payload.id && entry.status === "pending");
    const response = text(payload.response, 2000);
    if (!request || !response || typeof payload.approved !== "boolean") return fail("Выберите открытую заявку, решение и публичный ответ.");
    if (payload.approved) {
      const applied = applyIntent(request.action === "request-intel"
        ? { action: "use-decree", payload: { decreeId: "intel-support", topic: request.topic, response } }
        : { action: "decree", payload: { decreeId: request.decreeId } });
      if (!applied.ok) return applied;
      state = applied.state;
      storage = applied.storage;
    }
    Object.assign(state.pendingApprovals.find((entry) => entry.id === request.id), {
      status: payload.approved ? "approved" : "rejected", response, resolvedBy: actorId, resolvedPeriodIndex: periodIndex
    });
    detail.requestId = request.id;
    summary = `${payload.approved ? "Одобрена" : "Отклонена"} заявка ${request.decreeId}: ${response}`;
  } else if (action === "cancel-decree" || action === "use-decree") {
    const decreeId = text(payload.decreeId, 100);
    const entry = state.activeDecrees.find((row) => row.decreeId === decreeId && !row.cancelled && !row.used
      && row.issuedPeriodIndex <= periodIndex && periodIndex < row.expiresPeriodIndex);
    if (!entry) return fail("Указ уже завершён, отменён или использован.");
    const reason = text(payload.reason, 500);
    const topic = text(payload.topic, 500);
    const response = text(payload.response, 2000);
    if (action === "cancel-decree" && !reason) return fail("Укажите публичную причину отмены.");
    if (action === "use-decree" && (decreeId !== "intel-support" || !topic || !response)) return fail("Для «Сведений» укажите вопрос и публичную зацепку ГМа.");
    if (action === "cancel-decree") Object.assign(entry, { cancelled: true, cancellationReason: reason, cancelledPeriodIndex: periodIndex });
    else Object.assign(entry, { used: true, topic, response, usedPeriodIndex: periodIndex });
    // The original cooldown survives cancellation and use, including legacy cards.
    state.decreeCooldownUntil[decreeId] = Math.max(state.decreeCooldownUntil[decreeId] || 0, entry.expiresPeriodIndex);
    for (const request of state.pendingApprovals) if (request.status === "pending" && request.action === "request-intel" && decreeId === "intel-support") {
      Object.assign(request, { status: "resolved", response: response || reason, resolvedBy: actorId, resolvedPeriodIndex: periodIndex });
    }
    summary = action === "cancel-decree" ? `Указ ${decreeId} отменён без возврата оплаты: ${reason}` : `«Сведения» использованы. Вопрос: ${topic}. Зацепка: ${response}`;
    Object.assign(detail, { decreeId, reason, topic, response });
  } else if (action === "revolt") {
    const reason = text(payload.reason, 2000);
    if (!reason || typeof payload.active !== "boolean") return fail("Укажите состояние восстания и публичное сюжетное объяснение.");
    if (state.unresolvedRevolt === payload.active) return fail("Это состояние восстания уже записано.");
    state.unresolvedRevolt = payload.active;
    summary = `${payload.active ? "Началось восстание" : "Восстание разрешено"}: ${reason}`;
    Object.assign(detail, { active: payload.active, reason });
  } else return fail("Неизвестное действие с заявкой.");
  return { ok: true, state: appendPoliticsHistory(state, { ...detail, summary }), summary, ...(storage ? { storage } : {}) };
}
