import { normalizeRandomEventEffects } from "./random-event-effects.js";
import { makeId, toNumber } from "./utils.js";

function normalizeTendayEventBundle(rows = []) {
  const source = Array.isArray(rows) ? rows.filter((row) => row && typeof row === "object") : [];
  const events = source.slice(0, 40).map((row, index) => ({
    period: Math.max(1, Math.floor(toNumber(row.period, 1))),
    kind: String(row.kind ?? "general") === "external" ? "external" : "general",
    eventId: String(row.eventId ?? ""),
    tableId: String(row.tableId ?? row.kind ?? "general"),
    tableTitle: String(row.tableTitle ?? "").slice(0, 300),
    title: String(row.title ?? "Событие").slice(0, 300),
    text: String(row.text ?? "").slice(0, 4000),
    gmText: String(row.gmText ?? "").slice(0, 4000),
    visibility: String(row.visibility ?? "public") === "gm" ? "gm" : "public",
    effects: normalizeRandomEventEffects(row.effects),
    roll: Math.max(0, toNumber(row.roll, 0)),
    totalWeight: Math.max(0, toNumber(row.totalWeight, 0)),
    newcomer: Boolean(row.newcomer),
    arrivalRoll: row.arrivalRoll === null || row.arrivalRoll === undefined ? null : Math.max(1, Math.min(100, Math.floor(toNumber(row.arrivalRoll, 1)))),
    decisionId: String(row.decisionId ?? `${row.eventId || "event"}:${index + 1}`),
    effectStatus: ["pending", "applied", "scheduled", "none"].includes(String(row.effectStatus ?? ""))
      ? String(row.effectStatus)
      : (normalizeRandomEventEffects(row.effects).some((effect) => Number(effect.amount) !== 0) ? "pending" : "none"),
    effectOperationId: String(row.effectOperationId ?? ""),
    scheduleId: String(row.scheduleId ?? "")
  }));
  return { events, total: source.length, truncated: source.length > events.length };
}

export function normalizeEventScheduleEntry(entry = {}, { archived = false } = {}) {
  const id = String(entry?.id || makeId("event-schedule", 20));
  const status = archived ? "archived" : (["scheduled", "applied"].includes(String(entry?.status ?? "")) ? String(entry.status) : "scheduled");
  const effects = normalizeRandomEventEffects(entry?.effects);
  return {
    id,
    eventId: String(entry?.eventId ?? ""),
    tableId: String(entry?.tableId ?? entry?.kind ?? "general"),
    title: String(entry?.title ?? "Событие").slice(0, 300),
    text: String(entry?.text ?? entry?.entry ?? "").slice(0, 4000),
    effects,
    dueQd: Math.max(0, Math.floor(toNumber(entry?.dueQd, 0))),
    dueLabel: String(entry?.dueLabel ?? "").slice(0, 300),
    status,
    createdAt: String(entry?.createdAt ?? ""),
    appliedAt: String(entry?.appliedAt ?? ""),
    archivedAt: String(entry?.archivedAt ?? ""),
    operationId: String(entry?.operationId ?? ""),
    hasEffects: effects.some((effect) => Number(effect.amount) !== 0),
    canApplyEffects: status === "scheduled" && effects.some((effect) => Number(effect.amount) !== 0),
    isApplied: status === "applied",
    statusLabel: status === "applied" ? "Эффекты применены" : status === "archived" ? "В архиве" : "Ожидает"
  };
}

export function normalizeEventSchedule(rows = [], { limit = null } = {}) {
  const normalized = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row === "object")
    .map((row) => normalizeEventScheduleEntry(row));
  return Number.isFinite(limit) ? normalized.slice(-Math.max(0, Math.floor(limit))) : normalized;
}

export function normalizeEventArchive(rows = [], { limit = null } = {}) {
  const normalized = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row === "object")
    .map((row) => normalizeEventScheduleEntry(row, { archived: true }));
  return Number.isFinite(limit) ? normalized.slice(-Math.max(0, Math.floor(limit))) : normalized;
}

export function normalizeLastEventRoll(lastRoll = null) {
  if (!lastRoll || typeof lastRoll !== "object") return lastRoll ?? null;
  const effects = normalizeRandomEventEffects(lastRoll.effects);
  const eventBundle = normalizeTendayEventBundle(lastRoll.events);
  const pendingDecisionEffects = eventBundle.events
    .filter((event) => event.effectStatus === "pending")
    .flatMap((event) => event.effects)
    .filter((effect) => Number(effect.amount) !== 0);
  const hasDecisionBundle = Array.isArray(lastRoll.events);
  const effectStatus = hasDecisionBundle
    ? (pendingDecisionEffects.length ? "pending" : (eventBundle.events.some((event) => event.effectStatus === "applied") ? "applied" : "none"))
    : (["pending", "applied"].includes(String(lastRoll.effectStatus ?? "")) ? String(lastRoll.effectStatus) : (effects.length ? "pending" : "none"));
  const eventCount = Math.max(eventBundle.total, Math.floor(toNumber(lastRoll.eventCount, 0)));
  return {
    ...lastRoll,
    kind: String(lastRoll.kind ?? lastRoll.tableId ?? "general"),
    eventId: String(lastRoll.eventId ?? ""),
    tableId: String(lastRoll.tableId ?? lastRoll.kind ?? "general"),
    effects,
    hasEffects: effects.some((effect) => Number(effect.amount) !== 0),
    effectStatus,
    effectOperationId: String(lastRoll.effectOperationId ?? ""),
    scheduleId: String(lastRoll.scheduleId ?? ""),
    ...(Array.isArray(lastRoll.events) ? {
      events: eventBundle.events,
      eventCount,
      eventsTruncated: Boolean(lastRoll.eventsTruncated) || eventCount > eventBundle.events.length
    } : {}),
    canApplyEffects: (hasDecisionBundle ? pendingDecisionEffects : effects).some((effect) => Number(effect.amount) !== 0) && effectStatus !== "applied",
    effectsApplied: effectStatus === "applied",
    canSchedule: Boolean(lastRoll.eventId) && !String(lastRoll.scheduleId ?? "")
  };
}
