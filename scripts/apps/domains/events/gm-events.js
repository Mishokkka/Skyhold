// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { SkyholdData } from "../../../data/store.js";
import { isResidentInPopulation } from "../../../data/resident-presence.js";
import { clone, makeId } from "../../../data/utils.js";
import { escapeHtml, rollD6Pool } from "../../../core/helpers.js";
import { resourceLabel } from "../../../core/resources.js";
import { normalizeEventRegionOptions, normalizeRandomEventTables, rollRandomEventTable } from "../../../data/random-events.js";
import { controlIncidentSeverity } from "../../../engines/settlement/control.js";
import { createFoundryChatMessage, foundryChatSpeaker, foundryWhisperRecipients } from "../../../integrations/foundry-runtime.js";

function rollD100() {
  return Math.floor(Math.random() * 100) + 1;
}

function eventHoldingContext(app, holding = {}, { regionOptions = null } = {}) {
  return {
    ...holding,
    __eventMorale: app._calculateMorale?.(holding) ?? 0,
    __eventReputation: app._reputationSummary?.(holding)?.total ?? 0,
    __eventRegionOptions: normalizeEventRegionOptions(regionOptions ?? app._contextData?.catalog?.eventRegions)
  };
}

function rollEventForHolding(app, holding, kind = "general", options = {}) {
  const tables = normalizeRandomEventTables(holding?.gm?.eventTables);
  const table = tables[kind] ?? tables.general;
  return rollRandomEventTable(table, eventHoldingContext(app, holding, options));
}

function eventEntryText(result = null) {
  const row = result?.row;
  if (!row) return "Событие не найдено.";
  return String(row.text ?? "").trim() || String(row.title ?? "").trim();
}

function isGmOnlyEvent(result = null) {
  return String(result?.row?.visibility ?? "public") === "gm";
}

function eventChatOptions(results = []) {
  const list = Array.isArray(results) ? results : [results];
  if (!list.some((result) => isGmOnlyEvent(result))) return {};
  const recipients = foundryWhisperRecipients("GM").map((user) => user.id);
  return recipients.length ? { whisper: recipients } : {};
}

function eventResultHtml(result = null, { gmDetails = false } = {}) {
  const row = result?.row;
  if (!row) return "<p>В таблице нет активных событий.</p>";
  const title = String(row.title ?? "Событие").trim() || "Событие";
  const text = String(row.text ?? "").trim();
  const gmText = String(row.gmText ?? "").trim();
  const hints = [];
  if (row.combatPreset) hints.push(`Масс-комбат: ${row.combatPreset}`);
  if (row.chainId) hints.push(`Цепочка: ${row.chainId}`);
  if (row.nextEventId) hints.push(`Следующее: ${row.nextEventId}`);
  return `
    <section class="fbls-chat-event-roll">
      <h4>${escapeHtml(title)}</h4>
      <p>${escapeHtml(text || "—")}</p>
      ${gmDetails && gmText ? `<p><strong>ГМ:</strong> ${escapeHtml(gmText)}</p>` : ""}
      ${gmDetails && hints.length ? `<p><em>${hints.map((hint) => escapeHtml(hint)).join("; ")}</em></p>` : ""}
    </section>
  `;
}

function appendEventHistory(holding, results = []) {
  if (!holding.gm || typeof holding.gm !== "object") holding.gm = {};
  if (!Array.isArray(holding.gm.eventHistory)) holding.gm.eventHistory = [];
  const createdAt = new Date().toISOString();
  const entries = (Array.isArray(results) ? results : [results])
    .map((result) => result?.row ? ({
      id: String(result.row.id ?? ""),
      tableId: String(result.tableId ?? ""),
      title: String(result.row.title ?? ""),
      createdAt
    }) : null)
    .filter((entry) => entry?.id);
  holding.gm.eventHistory.push(...entries);
  holding.gm.eventHistory = holding.gm.eventHistory.slice(-80);
}

function dicePoolHtml(rolls = []) {
  return rolls.map((roll) => roll >= 6 ? `<strong>${roll}</strong>` : String(roll)).join(", ");
}

function buildReputationEventRoll(app, holding, options = {}) {
  const reputation = Math.max(0, app._safeNumber?.(app._reputationSummary?.(holding)?.total, 0) ?? 0);
  const rolls = rollD6Pool(reputation);
  const successes = rolls.filter((roll) => roll >= 6).length;
  const external = [];
  let newcomerGranted = false;
  for (let index = 0; index < successes; index += 1) {
    const arrivalRoll = rollD100();
    const arrivalSuccess = arrivalRoll <= 66;
    const newcomer = arrivalSuccess && !newcomerGranted;
    if (newcomer) newcomerGranted = true;
    external.push({
      index: index + 1,
      arrivalRoll,
      newcomer,
      newcomerCapped: arrivalSuccess && !newcomer,
      event: rollEventForHolding(app, holding, "external", options)
    });
  }
  return { reputation, rolls, successes, external };
}

function buildControlIncidentRoll(app, holding) {
  const control = app?._controlSummary?.(holding) ?? {
    orderRequirement: 0,
    generalControl: 0,
    unrestOnlyControl: 0,
    crimeDeficit: 0,
    unrestDeficit: 0,
    rawMorale: app?._calculateMorale?.(holding) ?? 0,
    disorderMorale: app?._calculateMorale?.(holding) ?? 0,
    institutionalCeiling: null
  };
  const rolls = rollD6Pool(Math.max(0, Number(control.crimeDeficit) || 0));
  const successes = rolls.filter((roll) => roll >= 6).length;
  const severity = controlIncidentSeverity(control);
  const copy = {
    theft: {
      title: "Кража или нарушение порядка",
      text: "Недостаток общего Контроля дал кому-то возможность украсть припасы, нарушить запрет или проверить слабое место охраны.",
      gmText: "Выберите уместную малую потерю, подозреваемого либо след для расследования. Это не автоматическое списание ресурса."
    },
    sabotage: {
      title: "Саботаж",
      text: "Недовольство и слабая охрана превратили мелкое нарушение в умышленную порчу, срыв работы или опасную провокацию.",
      gmText: "Выберите одну функцию, запас или стройку под угрозой и дайте игрокам возможность расследовать происшествие до применения последствий."
    },
    riot: {
      title: "Беспорядки",
      text: "Накопившееся недовольство вырвалось наружу: толпа, драка, отказ подчиняться или открытый бунт требуют немедленного решения.",
      gmText: "Определите участников и требования. Контроль подавляет проявление, но не изменяет сырое довольство и не устраняет его причины."
    }
  }[severity.id];
  const incidents = Array.from({ length: successes }, (_, index) => ({
    tableId: "control",
    tableTitle: "Контроль поселения",
    roll: 6,
    totalWeight: Math.max(1, rolls.length),
    row: {
      id: `control-${severity.id}-${index + 1}`,
      title: copy.title,
      text: copy.text,
      gmText: copy.gmText,
      visibility: "public",
      effects: []
    }
  }));
  return { ...control, rolls, successes, severity, incidents };
}

function tendayEventResults(entries = []) {
  return (Array.isArray(entries) ? entries : []).flatMap((entry) => [
    entry?.general,
    ...(entry?.reputation?.external ?? []).map((item) => item?.event),
    ...(entry?.control?.incidents ?? [])
  ]).filter((result) => result?.row);
}

function tendayEventSnapshot(result = null, { period = 1, kind = "general", newcomer = false, arrivalRoll = null } = {}) {
  const row = result?.row;
  if (!row) return null;
  return {
    period,
    kind,
    eventId: String(row.id ?? ""),
    tableId: String(result.tableId ?? kind),
    tableTitle: String(result.tableTitle ?? ""),
    title: String(row.title ?? "Событие"),
    text: String(row.text ?? ""),
    gmText: String(row.gmText ?? ""),
    visibility: String(row.visibility ?? "public"),
    effects: clone(row.effects ?? []),
    roll: Number(result.roll) || 0,
    totalWeight: Number(result.totalWeight) || 0,
    newcomer: Boolean(newcomer),
    arrivalRoll: Number.isFinite(Number(arrivalRoll)) ? Number(arrivalRoll) : null
  };
}

export function prepareTendayRandomEvents(app, holding, { periods = 1, regionOptions = null, operationId = "" } = {}) {
  const periodCount = Math.max(1, Math.floor(app?._safeNumber?.(periods, 1) ?? 1));
  const entries = [];
  const warnings = [];
  for (let index = 0; index < periodCount; index += 1) {
    const general = rollEventForHolding(app, holding, "general", { regionOptions });
    const reputation = buildReputationEventRoll(app, holding, { regionOptions });
    const control = buildControlIncidentRoll(app, holding);
    if (!general) warnings.push(`Десятник ${index + 1}: в общей таблице нет активных событий.`);
    const periodResults = [general, ...reputation.external.map((item) => item.event), ...control.incidents].filter((result) => result?.row);
    appendEventHistory(holding, periodResults);
    entries.push({ index: index + 1, general, reputation, control });
  }

  const title = periodCount > 1 ? `События ${periodCount} десятников` : "События десятника";
  const results = tendayEventResults(entries);
  const events = [];
  for (const entry of entries) {
    const general = tendayEventSnapshot(entry.general, { period: entry.index, kind: "general" });
    if (general) events.push(general);
    for (const external of entry.reputation.external) {
      const snapshot = tendayEventSnapshot(external.event, {
        period: entry.index,
        kind: "external",
        newcomer: external.newcomer,
        arrivalRoll: external.arrivalRoll
      });
      if (snapshot) events.push(snapshot);
    }
    for (const incident of entry.control.incidents) {
      const snapshot = tendayEventSnapshot(incident, { period: entry.index, kind: "control" });
      if (snapshot) events.push(snapshot);
    }
  }
  const bundleId = String(operationId || makeId("tenday-events", 20));
  events.forEach((event, index) => {
    const hasEventEffects = (event.effects ?? []).some((effect) => Number(effect?.amount) !== 0);
    event.decisionId = `${bundleId}:event:${index + 1}`;
    event.effectStatus = hasEventEffects ? "pending" : "none";
    event.effectOperationId = "";
    event.scheduleId = "";
  });
  const effects = events.flatMap((event) => event.effects ?? []);
  const hasEffects = effects.some((effect) => Number(effect?.amount) !== 0);
  if (!holding.gm || typeof holding.gm !== "object") holding.gm = {};
  holding.gm.lastRoll = {
    kind: "tenday",
    eventId: `tenday:${bundleId}`,
    tableId: "tenday",
    title,
    result: entries.map((entry) => `#${entry.index}: общее ${entry.general ? `${entry.general.roll}/${entry.general.totalWeight}` : "нет"}; репутация ${entry.reputation.successes}/${entry.reputation.reputation}; Контроль ${entry.control.successes}/${entry.control.crimeDeficit}`).join(" | "),
    entry: events.map((event) => event.title).filter(Boolean).join("; ") || "Активных событий нет.",
    effects: clone(effects),
    hasEffects,
    effectStatus: hasEffects ? "pending" : "none",
    effectOperationId: "",
    scheduleId: "",
    events,
    eventCount: events.length,
    eventsTruncated: false,
    createdAt: new Date().toISOString()
  };
  return { periods: periodCount, entries, events, results, effects, hasEffects, title, warnings, lastRoll: holding.gm.lastRoll };
}

function reputationRollHtml(result = {}) {
  const rolls = Array.isArray(result.rolls) ? result.rolls : [];
  const external = Array.isArray(result.external) ? result.external : [];
  const diceLine = result.reputation > 0 ? dicePoolHtml(rolls) : "0к6";
  const eventBlocks = external.length
    ? external.map((item) => `
      <div class="fbls-chat-reputation-event">
        <p><strong>Успех ${item.index}.</strong> Новый житель: ${item.newcomer ? "да" : "нет"} (d100: ${item.arrivalRoll}, шанс 66%${item.newcomerCapped ? "; лимит одного новичка за десятник уже использован" : ""}).</p>
        ${eventResultHtml(item.event, { gmDetails: isGmOnlyEvent(item.event) })}
      </div>
    `).join("")
    : "<p>Шестерок нет: внешнее событие репутации не приходит.</p>";
  return `
    <section class="fbls-chat-reputation-roll">
      <h4>Проверка репутации</h4>
      <p><strong>Репутация:</strong> ${result.reputation}к6</p>
      <p><strong>Кости:</strong> ${diceLine}</p>
      <p><strong>Успехи:</strong> ${result.successes}</p>
      ${eventBlocks}
    </section>
  `;
}

function controlRollHtml(result = {}) {
  const rolls = Array.isArray(result?.rolls) ? result.rolls : [];
  const diceLine = rolls.length ? dicePoolHtml(rolls) : "0к6";
  const ceiling = result?.institutionalCeiling === null || result?.institutionalCeiling === undefined
    ? "нет полного институционального охвата"
    : String(result.institutionalCeiling);
  return `
    <section class="fbls-chat-control-roll">
      <h4>Проверка Контроля</h4>
      <p><strong>Норматив:</strong> ${Number(result?.orderRequirement) || 0}; <strong>общий Контроль:</strong> ${Number(result?.generalControl) || 0}; <strong>только против беспорядков:</strong> ${Number(result?.unrestOnlyControl) || 0}.</p>
      <p><strong>Недостаток охраны:</strong> ${Number(result?.crimeDeficit) || 0}к6; <strong>кости:</strong> ${diceLine}; <strong>инциденты:</strong> ${Number(result?.successes) || 0}.</p>
      <p><strong>Сырое довольство:</strong> ${Number(result?.rawMorale) || 0}; <strong>для беспорядков:</strong> ${Number(result?.disorderMorale) || 0}; <strong>потолок:</strong> ${escapeHtml(ceiling)}.</p>
    </section>
  `;
}

export const GmEventActions = {
  click: {
    "add-defense-squad": "_onAddDefenseSquad",
    "delete-defense-squad": "_onDeleteDefenseSquad",
    "fill-defense-squad-best": "_onFillDefenseSquadBest",
    "assign-defense-armament": "_onAssignDefenseArmament",
    "unassign-defense-armament": "_onUnassignDefenseArmament",
    "roll-event-table": "_onRollEventTable",
    "reset-data": "_onResetData"
  }
};

export const GmEventDomain = {
async _onAddDefenseSquad(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canManageDefense?.()) return;
  const added = await this._updateActiveHolding((holding) => {
    if (!holding.gm) holding.gm = {};
    if (!holding.gm.defense) holding.gm.defense = {};
    if (!Array.isArray(holding.gm.defense.squads)) holding.gm.defense.squads = [];
    const number = holding.gm.defense.squads.length + 1;
    holding.gm.defense.squads.push({ id: makeId("squad"), name: `${number}-й отряд`, type: "line", sergeantId: "", equipped: false, armamentResourceId: "", armamentSourceRoomId: "outdoors", memberIds: ["", "", "", ""], notes: "" });
  }, { reason: "gm:add-defense-squad" });
  if (!added) return;
  this.activeTab = "defense";
  this.requestRender();
},

async _onDeleteDefenseSquad(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canManageDefense?.()) return;
  const id = String(event.currentTarget?.dataset?.squadId ?? "");
  if (!id) return;
  const squad = SkyholdData.view().holdings.find((row) => row.id === this.activeHoldingId)?.gm?.defense?.squads?.find((row) => String(row.id) === id);
  if (!squad || !await this._confirmAction("Расформировать отряд", `Расформировать «${escapeHtml(squad.name || "отряд")}»? Назначения будут сняты, комплект вооружения вернётся на склад.`)) return;
  const deleted = await this._updateActiveHolding((holding) => {
    if (!holding?.gm?.defense?.squads) return SkyholdData.skipTransaction(false);
    const target = holding.gm.defense.squads.find((row) => String(row.id) === id);
    if (target?.armamentResourceId) {
      const placements = this._storageAddWithOverflow?.(holding, {
        resourceId: target.armamentResourceId,
        roomId: target.armamentSourceRoomId || "outdoors"
      }, 1) ?? [];
      this._appendStorageLog?.(holding, placements.map((row) => ({
        kind: "military-armament-return",
        resourceId: target.armamentResourceId,
        name: resourceLabel(target.armamentResourceId),
        qty: row.qty,
        roomId: row.roomId,
        source: target.name || "Расформированный отряд",
        note: "Комплект возвращён при расформировании отряда"
      })));
    }
    const before = holding.gm.defense.squads.length;
    holding.gm.defense.squads = holding.gm.defense.squads.filter((row) => String(row.id) !== id);
    this._applyDefenseSalaries?.(holding);
    return holding.gm.defense.squads.length !== before;
  }, { reason: "gm:delete-defense-squad" });
  if (!deleted) return;
  this.activeTab = "defense";
  this.requestRender();
},

async _onAssignDefenseArmament(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canManageDefense?.()) return;
  const squadId = String(event.currentTarget?.dataset?.squadId ?? "");
  const resourceId = String(event.currentTarget?.closest?.(".fbls-defense-squad")?.querySelector?.("[data-defense-armament-choice]")?.value ?? "");
  if (!squadId || !["armament-simple", "armament-complex", "armament-elite"].includes(resourceId)) return;
  const result = await this._updateActiveHolding((holding) => {
    const squad = holding?.gm?.defense?.squads?.find((row) => String(row?.id ?? "") === squadId);
    if (!squad) return SkyholdData.skipTransaction({ ok: false, message: "Отряд не найден." });
    if (String(squad.armamentResourceId ?? "") === resourceId) return SkyholdData.skipTransaction({ ok: true, unchanged: true });
    const payment = this._storageCanPay?.(holding, [{ resourceId, qty: 1 }]);
    if (!payment?.ok) return SkyholdData.skipTransaction({ ok: false, message: "На складе нет выбранной единицы Вооружения." });
    this._storagePay(holding, payment.costs);
    this._appendStorageLog?.(holding, payment.costs.map((row) => ({
      kind: "military-armament-assign",
      resourceId,
      name: resourceLabel(resourceId),
      qty: -Math.max(0, this._safeNumber(row?.qty, 0)),
      roomId: row?.roomId ?? "",
      source: squad.name || "Отряд",
      note: "Комплект закреплён за отрядом"
    })));
    if (squad.armamentResourceId) {
      const returnedResourceId = squad.armamentResourceId;
      const placements = this._storageAddWithOverflow?.(holding, {
        resourceId: squad.armamentResourceId,
        roomId: squad.armamentSourceRoomId || "outdoors"
      }, 1) ?? [];
      this._appendStorageLog?.(holding, placements.map((row) => ({
        kind: "military-armament-return",
        resourceId: returnedResourceId,
        name: resourceLabel(returnedResourceId),
        qty: row.qty,
        roomId: row.roomId,
        source: squad.name || "Отряд",
        note: "Прежний комплект возвращён при замене"
      })));
    }
    squad.armamentResourceId = resourceId;
    squad.armamentSourceRoomId = String(payment.costs?.[0]?.roomId ?? "outdoors") || "outdoors";
    squad.equipped = true;
    return { ok: true };
  }, { reason: "gm:assign-defense-armament" });
  if (!result?.ok) {
    if (result?.message) ui.notifications.warn(result.message);
    return;
  }
  this.requestRender();
},

async _onUnassignDefenseArmament(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canManageDefense?.()) return;
  const squadId = String(event.currentTarget?.dataset?.squadId ?? "");
  if (!squadId) return;
  const result = await this._updateActiveHolding((holding) => {
    const squad = holding?.gm?.defense?.squads?.find((row) => String(row?.id ?? "") === squadId);
    if (!squad?.armamentResourceId) return SkyholdData.skipTransaction({ ok: false, message: "У отряда нет закрепленного Вооружения." });
    const returnedResourceId = squad.armamentResourceId;
    const placements = this._storageAddWithOverflow?.(holding, {
      resourceId: squad.armamentResourceId,
      roomId: squad.armamentSourceRoomId || "outdoors"
    }, 1) ?? [];
    this._appendStorageLog?.(holding, placements.map((row) => ({
      kind: "military-armament-return",
      resourceId: returnedResourceId,
      name: resourceLabel(returnedResourceId),
      qty: row.qty,
      roomId: row.roomId,
      source: squad.name || "Отряд",
      note: "Комплект снят с отряда"
    })));
    squad.armamentResourceId = "";
    squad.armamentSourceRoomId = "outdoors";
    squad.equipped = false;
    return { ok: true };
  }, { reason: "gm:unassign-defense-armament" });
  if (!result?.ok) {
    if (result?.message) ui.notifications.warn(result.message);
    return;
  }
  this.requestRender();
},

async _onFillDefenseSquadBest(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canManageDefense?.()) return;
  const squadId = String(event.currentTarget?.dataset?.squadId ?? "");
  if (!squadId) return;

  const result = await this._updateActiveHolding((holding) => {
    const squads = holding?.gm?.defense?.squads;
    const squad = Array.isArray(squads) ? squads.find((item) => String(item.id) === squadId) : null;
    if (!holding || !squad) return SkyholdData.skipTransaction({ ok: false, message: "" });

    const squadType = String(squad.type ?? "line") === "militia" ? "line" : String(squad.type ?? "line");
    const commanderId = String(holding?.gm?.defense?.commanderId ?? "");
    const otherSquadIds = new Set();
    for (const other of squads) {
      if (String(other.id) === squadId) continue;
      if (other?.sergeantId) otherSquadIds.add(String(other.sergeantId));
      for (const id of (Array.isArray(other?.memberIds) ? other.memberIds : []).slice(0, 4)) if (id) otherSquadIds.add(String(id));
    }

    const candidates = (holding?.people?.list ?? [])
      .filter((person) => person && isResidentInPopulation(person, holding) && !this._isResidentInjured?.(person))
      .filter((person) => !this._isChildResident?.(person))
      .filter((person) => this._isSuitableForSquadType?.(person, squadType))
      .filter((person) => String(person.id) !== commanderId)
      .filter((person) => !otherSquadIds.has(String(person.id)))
      .map((person) => {
        const efficiency = Number(this._soldierEfficiency?.(person, squadType) ?? 0);
        const sergeant = this._isSergeantCandidate?.(person) ? 0.35 : 0;
        const military = this._isMilitaryBackgroundResident?.(person) ? 0.35 : 0;
        const soldier = this._isSoldierResident?.(person) ? 0.25 : 0;
        const free = !String(person.workAssignment ?? "").trim() ? 0.05 : 0;
        return { person, score: (Number.isFinite(efficiency) ? efficiency : 0) + sergeant + military + soldier + free };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score);

    const selected = [];
    const sergeantCandidate = candidates.find((row) => this._isSergeantCandidate?.(row.person));
    const first = sergeantCandidate ?? candidates[0];
    if (first) selected.push(first.person);
    for (const row of candidates) {
      if (selected.length >= 5) break;
      if (selected.some((person) => String(person.id) === String(row.person.id))) continue;
      selected.push(row.person);
    }

    if (!selected.length) {
      return SkyholdData.skipTransaction({ ok: false, message: "Нет подходящих жителей для этого типа отряда." });
    }

    for (const person of selected) {
      this._clearPersonFromAssignments?.(holding, person.id);
      person.workAssignment = "soldier";
      if (!/^\s*(солдат|сержант)\b/i.test(String(person.role ?? ""))) person.role = "Солдат";
    }
    squad.sergeantId = String(selected[0]?.id ?? "");
    squad.memberIds = selected.slice(1, 5).map((person) => String(person.id));
    while (squad.memberIds.length < 4) squad.memberIds.push("");
    this._sanitizeDefenseAssignments?.(holding);
    this._applyDefenseSalaries?.(holding);
    return { ok: true };
  }, { reason: "gm:fill-defense-squad-best" });

  if (!result?.ok) {
    if (result?.message) ui.notifications.warn(result.message);
    return;
  }
  this.activeTab = "defense";
  this.requestRender();
},

async _onRollEventTable(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!game.user?.isGM) return;

  const data = SkyholdData.get();
  const holding = data.holdings.find((item) => item.id === this.activeHoldingId);
  if (!holding) return;

  const kind = String(event.currentTarget?.dataset?.eventTableKind ?? "general");
  const result = rollEventForHolding(this, holding, kind);
  if (!result) {
    ui.notifications.warn("В этой таблице нет активных событий.");
    return;
  }
  const holdingName = holding.name || "Владение";

  await SkyholdData.updateHolding(holding.id, (freshHolding) => {
    if (!freshHolding.gm) freshHolding.gm = {};
    appendEventHistory(freshHolding, result);
    freshHolding.gm.lastRoll = {
      kind,
      tableId: String(result.tableId ?? kind),
      eventId: String(result.row?.id ?? ""),
      title: String(result.row?.title ?? result.tableTitle ?? "Событие"),
      tableTitle: result.tableTitle,
      result: `${result.roll}/${result.totalWeight}`,
      entry: eventEntryText(result),
      effects: clone(result.row?.effects ?? []),
      hasEffects: (result.row?.effects ?? []).some((effect) => Number(effect?.amount) !== 0),
      effectStatus: (result.row?.effects ?? []).length ? "pending" : "none",
      effectOperationId: "",
      scheduleId: "",
      createdAt: new Date().toISOString()
    };
  }, { reason: "gm:roll" });

  await createFoundryChatMessage({
    speaker: foundryChatSpeaker({ alias: holdingName }),
    content: `
      <div class="fbls-chat-card">
        <h3>${escapeHtml(result.tableTitle)}</h3>
        <p><strong>${escapeHtml(holding.name)}.</strong></p>
        ${eventResultHtml(result, { gmDetails: isGmOnlyEvent(result) })}
      </div>
    `,
    ...eventChatOptions(result)
  });
  this.requestRender();
},

async _postReputationEventRoll(holding) {
  if (!holding) return null;
  const result = buildReputationEventRoll(this, holding);
  if (!result.reputation) ui.notifications.warn("Репутация равна 0: проверка не даст внешних событий.");

  if (game.user?.isGM) {
    await SkyholdData.updateHolding(holding.id, (freshHolding) => {
      if (!freshHolding.gm) freshHolding.gm = {};
      appendEventHistory(freshHolding, result.external.map((item) => item.event));
      freshHolding.gm.lastRoll = {
        kind: "reputation",
        title: "Проверка репутации",
        result: `${result.successes}/${result.reputation}`,
        entry: result.external.map((item) => eventEntryText(item.event)).join("; ") || "Внешних событий нет.",
        createdAt: new Date().toISOString()
      };
    }, { reason: "gm:roll-reputation-event" });
  }

  await createFoundryChatMessage({
    speaker: foundryChatSpeaker({ alias: holding.name || "Владение" }),
    content: `
      <div class="fbls-chat-card">
        <h3>Проверка репутации</h3>
        <p><strong>${escapeHtml(holding.name)}.</strong></p>
        ${reputationRollHtml(result)}
      </div>
    `,
    ...eventChatOptions(result.external.map((item) => item.event))
  });
  this.requestRender?.();
  return result;
},

_prepareTendayRandomEvents(holding, options = {}) {
  return prepareTendayRandomEvents(this, holding, options);
},

async _postPreparedTendayRandomEventsChat(holding, prepared = {}) {
  if (!holding) return null;
  const periodCount = Math.max(1, Math.floor(this._safeNumber?.(prepared.periods, 1) ?? 1));
  const entries = Array.isArray(prepared.entries) ? prepared.entries : [];
  const title = String(prepared.title || (periodCount > 1 ? `События ${periodCount} десятников` : "События десятника"));
  await createFoundryChatMessage({
    speaker: foundryChatSpeaker({ alias: holding.name || "Владение" }),
    content: `
      <div class="fbls-chat-card">
        <h3>${escapeHtml(title)}</h3>
        <p><strong>${escapeHtml(holding.name)}.</strong></p>
        ${entries.map((entry) => `
          <section>
            ${periodCount > 1 ? `<h4>Десятник ${entry.index}</h4>` : ""}
            <h4>Общее событие</h4>
            ${eventResultHtml(entry.general, { gmDetails: isGmOnlyEvent(entry.general) })}
            ${reputationRollHtml(entry.reputation)}
            ${controlRollHtml(entry.control)}
          </section>
        `).join("")}
      </div>
    `,
    ...eventChatOptions(tendayEventResults(entries))
  });
  this.requestRender?.();
  return prepared;
},

async _postTenDayRandomEvents(holding, { periods = 1 } = {}) {
  if (!holding) return null;
  const operationId = makeId("tenday-events", 20);
  const prepared = await SkyholdData.updateHolding(holding.id, (freshHolding, data) => {
    return this._prepareTendayRandomEvents(freshHolding, {
      periods,
      operationId,
      regionOptions: data?.catalog?.eventRegions
    });
  }, { fallback: false, reason: "gm:roll-tenday-events" });
  if (!prepared) return null;
  for (const warning of prepared.warnings ?? []) ui.notifications.warn(warning);
  const current = SkyholdData.get()?.holdings?.find((row) => String(row?.id ?? "") === String(holding.id ?? "")) ?? holding;
  await this._postPreparedTendayRandomEventsChat(current, prepared);
  return prepared;
},

async _onRollReputationEvent(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!game.user?.isGM) return;

  const data = SkyholdData.get();
  const holding = data.holdings.find((item) => item.id === this.activeHoldingId);
  if (!holding) return;
  return this._postReputationEventRoll(holding);
},

async _onRollTendayEvents(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!game.user?.isGM) return;

  const data = SkyholdData.get();
  const holding = data.holdings.find((item) => item.id === this.activeHoldingId);
  if (!holding) return;
  return this._postTenDayRandomEvents(holding);
},

async _onImportLaputa(event) {
  event.preventDefault();
  if (!game.user?.isGM) return;

  const confirmed = await this._confirmAction("Импорт Лапуты", "Импортировать данные Лапуты из встроенного снимка Лапута.xlsx? Текущие жители, здания, особое и хранилище Лапуты будут заменены. ID сцены, видимость и старые ГМ-заметки будут сохранены.");
  if (!confirmed) return;

  try {
    await SkyholdData.importLaputa();
    this.activeHoldingId = "laputa";
    this.activeTab = "overview";
    this.editingPersonId = null;
    this.requestRender();
    ui.notifications.info("Лапута импортирована из встроенных данных.");
  } catch (error) {
    console.error("FBL Skyhold | Failed to import Laputa", error);
    ui.notifications.error("Не удалось импортировать Лапуту. Подробности в консоли.");
  }
},

async _onResetData(event) {
  event.preventDefault();
  if (!game.user?.isGM) return;

  const confirmed = await this._confirmAction("Сброс данных", "Сбросить все данные всех владений к стартовым значениям? Это нельзя отменить.");
  if (!confirmed) return;

  await SkyholdData.reset();
  this.activeHoldingId = null;
  this.activeTab = "overview";
  this.editingPersonId = null;
  this.requestRender();
}
};
