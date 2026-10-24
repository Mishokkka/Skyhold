import { SkyholdData } from "../../../data/store.js";
import { clone, makeId } from "../../../data/utils.js";
import { stableDataHash } from "../../../data/storage-commit.js";
import { appendHoldingOperation, findHoldingOperation } from "../../../data/operations.js";
import { MAX_EVENT_SCHEDULE_ENTRIES, normalizeEventScheduleEntry } from "../../../data/event-automation.js";
import { applyRandomEventEffects } from "../../../engines/events/effect-executor.js";
import { escapeHtml } from "../../../core/helpers.js";
import { isMoneyResource } from "../../../core/resources.js";
import { foundryDialogV2 } from "../../../integrations/foundry-runtime.js";

const SCHEDULE_FULL_MESSAGE = `В плане уже ${MAX_EVENT_SCHEDULE_ENTRIES} событий. Архивируйте обработанные события, прежде чем добавлять новые.`;

export const EventAutomationActions = {
  click: {
    "apply-last-event-effects": "_onApplyEventEffects",
    "apply-scheduled-event-effects": "_onApplyEventEffects",
    "schedule-last-event": "_onScheduleLastEvent",
    "archive-scheduled-event": "_onArchiveScheduledEvent"
  }
};

export const EventAutomationDomain = {
_eventEffectDependencies() {
  return {
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback),
    normalizeStorageRoomId: (roomId) => this._normalizeStorageRoomId(roomId),
    storageResourceIdentity: (resource) => this._storageResourceIdentity(resource),
    isMoneyResource: (resource) => isMoneyResource(resource.resourceId, resource.name),
    storageQuantity: (holding, resource) => this._storageQuantity(holding, resource),
    storageAdd: (holding, resource, qty) => this._storageAdd(holding, resource, qty),
    storageAddWithOverflow: (holding, resource, qty) => this._storageAddWithOverflow(holding, resource, qty),
    storageRoomLabel: (holding, roomId) => this._storageRoomLabel(holding, roomId),
    formatNumber: (value) => this._formatNumber(value)
  };
},

_eventAutomationSource(holding, scheduleId = "") {
  if (scheduleId) {
    const scheduled = (holding?.gm?.eventSchedule ?? []).find((row) => String(row?.id ?? "") === String(scheduleId));
    if (!scheduled || ["applied", "done", "archived", "cancelled"].includes(scheduled.status)
      || ["applied", "done"].includes(scheduled.effectStatus)) return null;
    return { ...scheduled, scheduleId: scheduled.id };
  }
  const lastRoll = holding?.gm?.lastRoll;
  if (!lastRoll || typeof lastRoll !== "object" || ["applied", "done"].includes(lastRoll.effectStatus)) return null;
  if (Array.isArray(lastRoll.events)) {
    const pending = lastRoll.events.filter((row) => row && String(row.effectStatus ?? "pending") === "pending");
    if (!pending.length) return null;
    return { ...lastRoll, effects: pending.flatMap((row) => Array.isArray(row.effects) ? row.effects : []), scheduleId: "" };
  }
  return { ...lastRoll, scheduleId: "" };
},

_tendayEventDecision(holding, decisionId = "") {
  const id = String(decisionId ?? "");
  return (holding?.gm?.lastRoll?.events ?? []).find((row) => String(row?.decisionId ?? "") === id) ?? null;
},

_refreshTendayDecisionStatus(lastRoll = null) {
  if (!lastRoll || !Array.isArray(lastRoll.events)) return;
  const hasPending = lastRoll.events.some((row) => String(row?.effectStatus ?? "none") === "pending" && (row?.effects ?? []).some((effect) => Number(effect?.amount) !== 0));
  const hasApplied = lastRoll.events.some((row) => String(row?.effectStatus ?? "none") === "applied");
  lastRoll.effectStatus = hasPending ? "pending" : (hasApplied ? "applied" : "none");
},

_appendEventEffectStorageAudit(holding, source, result, operationId) {
  const entries = [];
  for (const change of result?.changes ?? []) {
    if (change.type === "money") {
      entries.push({ kind: change.amount >= 0 ? "income" : "expense", resourceId: "money", name: "Деньги", qty: change.amount, source: source.title || "Событие", note: "Эффект события", operationId });
    } else if (change.type === "resource") {
      if (change.amount < 0 || !Array.isArray(change.placements)) {
        entries.push({ kind: change.amount >= 0 ? "income" : "expense", resourceId: change.resourceId, name: change.name, qty: change.amount, roomId: change.roomId, source: source.title || "Событие", note: "Эффект события", operationId });
      } else {
        for (const placement of change.placements) entries.push({ kind: "income", resourceId: change.resourceId, name: change.name, qty: placement.qty, roomId: placement.roomId, source: source.title || "Событие", note: "Эффект события", operationId });
      }
    }
  }
  if (entries.length) this._appendStorageLog(holding, entries);
},

_applyEventEffectsToHolding(holding, source, operationId) {
  const result = applyRandomEventEffects({
    holding,
    effects: source?.effects ?? [],
    dependencies: this._eventEffectDependencies()
  });
  if (!result.ok) return result;
  this._appendEventEffectStorageAudit(holding, source, result, operationId);
  appendHoldingOperation(holding, {
    operationId,
    type: "event-effect",
    createdAt: new Date().toISOString(),
    title: `Эффекты: ${source?.title || "Событие"}`,
    summary: result.changes.map((change) => change.text).join("; "),
    payload: {
      eventId: String(source?.eventId ?? ""),
      tableId: String(source?.tableId ?? source?.kind ?? ""),
      scheduleId: String(source?.scheduleId ?? ""),
      changes: result.changes
    }
  });
  return { ...result, operationId };
},

async _onApplyEventEffects(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!game.user?.isGM) return;
  const scheduleId = String(event.currentTarget?.dataset?.eventScheduleId ?? "");
  const data = SkyholdData.get();
  const holding = data.holdings.find((row) => String(row?.id ?? "") === String(this.activeHoldingId ?? ""));
  if (!holding) return;
  const source = this._eventAutomationSource(holding, scheduleId);
  if (!source) return ui.notifications.warn("Событие для применения не найдено.");
  const previewHolding = clone(holding);
  const preview = applyRandomEventEffects({ holding: previewHolding, effects: source.effects, dependencies: this._eventEffectDependencies() });
  if (!preview.ok) return ui.notifications.warn(preview.message);
  const confirmed = await foundryDialogV2().confirm({
    window: { title: `Применить эффекты: ${source.title || "Событие"}` },
    content: `<div class="fbls-dialog-text"><p>Изменения будут записаны в журнал операций.</p><ul>${preview.changes.map((change) => `<li>${escapeHtml(change.text)}</li>`).join("")}</ul></div>`,
    modal: true
  });
  if (!confirmed) return;

  const sourceHash = stableDataHash(holding);
  const operationId = makeId("event-effect", 20);
  const applied = await SkyholdData.updateHolding(holding.id, (freshHolding) => {
    if (stableDataHash(freshHolding) !== sourceHash) return SkyholdData.skipTransaction({ ok: false, stale: true, message: "Владение изменилось после предпросмотра. Проверь эффекты ещё раз." });
    if (findHoldingOperation(freshHolding, operationId)) return SkyholdData.skipTransaction({ ok: true, duplicate: true, operationId, changes: [] });
    const freshSource = this._eventAutomationSource(freshHolding, scheduleId);
    if (!freshSource) return SkyholdData.skipTransaction({ ok: false, message: "Событие больше не найдено." });
    const result = this._applyEventEffectsToHolding(freshHolding, freshSource, operationId);
    if (!result.ok) return SkyholdData.skipTransaction(result);
    const now = new Date().toISOString();
    if (scheduleId) {
      const scheduled = (freshHolding.gm.eventSchedule ?? []).find((row) => String(row?.id ?? "") === scheduleId);
      if (scheduled) Object.assign(scheduled, { status: "applied", appliedAt: now, operationId });
    }
    if (String(freshHolding?.gm?.lastRoll?.eventId ?? "") === String(freshSource.eventId ?? "")) {
      for (const decision of freshHolding.gm.lastRoll.events ?? []) {
        if (String(decision?.effectStatus ?? "pending") !== "pending") continue;
        decision.effectStatus = "applied";
        decision.effectOperationId = operationId;
      }
      freshHolding.gm.lastRoll.effectStatus = "applied";
      freshHolding.gm.lastRoll.effectOperationId = operationId;
    }
    return result;
  }, { fallback: false, reason: `event-effect:${operationId}` });
  if (!applied?.ok) return ui.notifications.warn(applied?.message || "Не удалось применить эффекты события.");
  this.requestRender();
  ui.notifications.info(`Эффекты применены: ${applied.changes.length}.`);
},

async _applyTendayEventDecision({ holdingId = "", decisionId = "" } = {}) {
  if (!game.user?.isGM) return { ok: false, message: "Только GM может применять эффекты событий." };
  const holding = (SkyholdData.get()?.holdings ?? []).find((row) => String(row?.id ?? "") === String(holdingId ?? ""));
  const source = this._tendayEventDecision(holding, decisionId);
  if (!holding || !source) return { ok: false, message: "Решение события больше не найдено." };
  if (String(source.effectStatus ?? "pending") !== "pending") return { ok: false, message: "Это решение уже обработано." };
  const previewHolding = clone(holding);
  const previewSource = this._tendayEventDecision(previewHolding, decisionId);
  const preview = applyRandomEventEffects({ holding: previewHolding, effects: previewSource?.effects ?? [], dependencies: this._eventEffectDependencies() });
  if (!preview.ok) return preview;
  const confirmed = await foundryDialogV2().confirm({
    window: { title: `Применить: ${source.title || "Событие"}` },
    content: `<div class="fbls-dialog-text"><p>Эффекты будут записаны как отдельная операция.</p><ul>${preview.changes.map((change) => `<li>${escapeHtml(change.text)}</li>`).join("")}</ul></div>`,
    modal: true
  });
  if (!confirmed) return { ok: false, cancelled: true };
  const sourceHash = stableDataHash(holding);
  const operationId = makeId("event-effect", 20);
  return SkyholdData.updateHolding(holding.id, (freshHolding) => {
    if (stableDataHash(freshHolding) !== sourceHash) return SkyholdData.skipTransaction({ ok: false, stale: true, message: "Владение изменилось; проверьте решение ещё раз." });
    const decision = this._tendayEventDecision(freshHolding, decisionId);
    if (!decision || String(decision.effectStatus ?? "pending") !== "pending") return SkyholdData.skipTransaction({ ok: false, message: "Решение уже обработано." });
    const result = this._applyEventEffectsToHolding(freshHolding, { ...decision, scheduleId: "" }, operationId);
    if (!result.ok) return SkyholdData.skipTransaction(result);
    decision.effectStatus = "applied";
    decision.effectOperationId = operationId;
    this._refreshTendayDecisionStatus(freshHolding.gm.lastRoll);
    return { ...result, decisionId, status: "applied" };
  }, { fallback: false, reason: `event-decision:${operationId}` });
},

async _scheduleTendayEventDecision({ holdingId = "", decisionId = "" } = {}) {
  if (!game.user?.isGM) return { ok: false, message: "Только GM может планировать события." };
  const scheduleId = makeId("event-schedule", 20);
  const operationId = makeId("event-schedule-op", 20);
  return SkyholdData.updateHolding(holdingId, (freshHolding) => {
    const decision = this._tendayEventDecision(freshHolding, decisionId);
    if (!decision || String(decision.effectStatus ?? "pending") !== "pending") return SkyholdData.skipTransaction({ ok: false, message: "Решение уже обработано или не найдено." });
    if (!freshHolding.gm || typeof freshHolding.gm !== "object") freshHolding.gm = {};
    if (!Array.isArray(freshHolding.gm.eventSchedule)) freshHolding.gm.eventSchedule = [];
    if (freshHolding.gm.eventSchedule.length >= MAX_EVENT_SCHEDULE_ENTRIES) {
      return SkyholdData.skipTransaction({ ok: false, capacityExceeded: true, message: SCHEDULE_FULL_MESSAGE });
    }
    const dueQd = Math.max(0, Number(freshHolding?.gm?.calendaria?.lastQd) || 0) + 40;
    const entry = normalizeEventScheduleEntry({
      id: scheduleId,
      eventId: decision.eventId,
      tableId: decision.tableId || decision.kind,
      title: decision.title,
      text: decision.text,
      effects: decision.effects,
      dueQd,
      dueLabel: `Следующий десятник · QD ${dueQd}`,
      createdAt: new Date().toISOString()
    });
    freshHolding.gm.eventSchedule.push(entry);
    decision.effectStatus = "scheduled";
    decision.scheduleId = scheduleId;
    this._refreshTendayDecisionStatus(freshHolding.gm.lastRoll);
    appendHoldingOperation(freshHolding, { operationId, type: "event-schedule", createdAt: new Date().toISOString(), title: `Запланировано: ${entry.title}`, summary: entry.dueLabel, payload: { scheduleId, eventId: entry.eventId, decisionId } });
    return { ok: true, decisionId, scheduleId, status: "scheduled" };
  }, { fallback: false, reason: `event-decision-schedule:${operationId}` });
},

async _onScheduleLastEvent(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!game.user?.isGM) return;
  const data = SkyholdData.get();
  const holding = data.holdings.find((row) => String(row?.id ?? "") === String(this.activeHoldingId ?? ""));
  const source = this._eventAutomationSource(holding);
  if (!holding || !source?.eventId) return ui.notifications.warn("Сначала брось таблицу событий.");
  const scheduleId = makeId("event-schedule", 20);
  const operationId = makeId("event-schedule-op", 20);
  const result = await SkyholdData.updateHolding(holding.id, (freshHolding) => {
    if (!freshHolding.gm || typeof freshHolding.gm !== "object") freshHolding.gm = {};
    if (!Array.isArray(freshHolding.gm.eventSchedule)) freshHolding.gm.eventSchedule = [];
    const lastRoll = freshHolding.gm.lastRoll;
    if (!lastRoll?.eventId) return SkyholdData.skipTransaction({ ok: false, message: "Последнее событие больше не найдено." });
    const pendingSource = this._eventAutomationSource(freshHolding);
    if (Array.isArray(lastRoll.events) && !(pendingSource?.effects ?? []).some((effect) => Number(effect?.amount) !== 0)) return SkyholdData.skipTransaction({ ok: false, message: "Неразобранных эффектов нет." });
    const existing = freshHolding.gm.eventSchedule.find((row) => String(row?.id ?? "") === String(lastRoll.scheduleId ?? ""));
    if (existing) return SkyholdData.skipTransaction({ ok: true, duplicate: true, scheduleId: existing.id });
    if (freshHolding.gm.eventSchedule.length >= MAX_EVENT_SCHEDULE_ENTRIES) {
      return SkyholdData.skipTransaction({ ok: false, capacityExceeded: true, message: SCHEDULE_FULL_MESSAGE });
    }
    const dueQd = Math.max(0, Number(freshHolding?.gm?.calendaria?.lastQd) || 0) + 40;
    const entry = normalizeEventScheduleEntry({
      id: scheduleId,
      eventId: lastRoll.eventId,
      tableId: lastRoll.tableId || lastRoll.kind,
      title: lastRoll.title,
      text: lastRoll.entry,
      effects: pendingSource.effects,
      dueQd,
      dueLabel: `Следующий десятник · QD ${dueQd}`,
      createdAt: new Date().toISOString()
    });
    if (entry.effects.length < (pendingSource.effects ?? []).length) {
      return SkyholdData.skipTransaction({ ok: false, capacityExceeded: true, message: "В одну запись плана не помещаются все эффекты. Запланируйте события по отдельности, чтобы сохранить каждое решение." });
    }
    freshHolding.gm.eventSchedule.push(entry);
    lastRoll.scheduleId = scheduleId;
    for (const decision of lastRoll.events ?? []) {
      if (String(decision?.effectStatus ?? "pending") !== "pending") continue;
      decision.effectStatus = "scheduled";
      decision.scheduleId = scheduleId;
    }
    this._refreshTendayDecisionStatus(lastRoll);
    appendHoldingOperation(freshHolding, { operationId, type: "event-schedule", createdAt: new Date().toISOString(), title: `Запланировано: ${entry.title}`, summary: entry.dueLabel, payload: { scheduleId, eventId: entry.eventId } });
    return { ok: true, scheduleId };
  }, { fallback: false, reason: `event-schedule:${operationId}` });
  if (!result?.ok) return ui.notifications.warn(result?.message || "Не удалось запланировать событие.");
  this.requestRender();
  ui.notifications.info("Событие добавлено в план следующего десятника.");
},

async _onArchiveScheduledEvent(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!game.user?.isGM) return;
  const scheduleId = String(event.currentTarget?.dataset?.eventScheduleId ?? "");
  if (!scheduleId) return;
  const confirmed = await foundryDialogV2().confirm({ window: { title: "Архивировать событие" }, content: "<p>Убрать событие из активного плана в архив?</p>", modal: true });
  if (!confirmed) return;
  const operationId = makeId("event-archive", 20);
  const result = await this._updateActiveHolding((holding) => {
    const index = (holding?.gm?.eventSchedule ?? []).findIndex((row) => String(row?.id ?? "") === scheduleId);
    if (index < 0) return SkyholdData.skipTransaction({ ok: false, message: "Запланированное событие не найдено." });
    const [entry] = holding.gm.eventSchedule.splice(index, 1);
    if (!Array.isArray(holding.gm.eventArchive)) holding.gm.eventArchive = [];
    const archived = normalizeEventScheduleEntry({ ...entry, status: "archived", archivedAt: new Date().toISOString() }, { archived: true });
    holding.gm.eventArchive.push(archived);
    holding.gm.eventArchive = holding.gm.eventArchive.slice(-160);
    appendHoldingOperation(holding, { operationId, type: "event-schedule", createdAt: new Date().toISOString(), title: `Архивировано: ${entry.title}`, summary: entry.status === "applied" ? "Эффекты применены" : "Без применения эффектов", payload: { scheduleId, eventId: entry.eventId } });
    return { ok: true };
  }, { reason: `event-archive:${operationId}` });
  if (!result?.ok) return ui.notifications.warn(result?.message || "Не удалось архивировать событие.");
  this.requestRender();
}
};
