// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { bindSharedMarketHolding, advanceSharedMarketClock } from "../../../data/market/shared-context.js";
import { escapeHtml } from "../../../core/helpers.js";
import { buildingOperationalState } from "../../../core/building-state.js";
import { SkyholdData } from "../../../data/store.js";
import { clone, makeId } from "../../../data/utils.js";
import { stableDataHash } from "../../../data/storage-commit.js";
import { appendHoldingOperation } from "../../../data/operations.js";
import { mergeHoldingDefaults } from "../../../data/normalizers.js";
import { adjustResidentAttributesForAgeTransition, ageGroupFromAge, ageThresholdsFor, raceKeyFromResident } from "../../../generators/resident-rules.js";
import { financeBuildingFunctionBlockState, financeWorkerBlockState } from "../../../engines/economy/finance-obligations.js";
import { addCalendariaQd, calendariaDateKey, formatCalendariaDateTime, getCalendariaSnapshot, parseCalendariaDateInput, timestampForCalendariaDate } from "../../../integrations/calendaria-bridge.js";
import {
  advanceTendayClock,
  applyPreparedTenday,
  dueTendaySchedule,
  normalizeTendayQd,
  preparedTendayReplay,
  tendayDependencySnapshot
} from "./tenday-preview.js";
import { createFoundryChatMessage, foundryChatSpeaker } from "../../../integrations/foundry-runtime.js";
import { buildTendayChangeSet } from "../../../engines/tenday/change-set.js";
import { buildTendayOperationPayload } from "../../../engines/tenday/operation-payload.js";
import { recoverMarketStock } from "../../../engines/market/stock.js";
import { appendEconomyLedger } from "../../../engines/economy/ledger.js";
import {
  beginPerishableStoragePeriod,
  cancelPerishableStoragePeriod,
  finishPerishableStoragePeriod
} from "../../../engines/economy/perishable-storage.js";
import { normalizeFoodRationUnits } from "../../../engines/economy/food-rations.js";
import { openTendayApp, openTendayHistory } from "../../lazy-apps.js";
import { politicsDecisionContext } from "../../politics-decision-context.js";
import { prepareSequentialTendays } from "../../../engines/tenday/sequential.js";
import { politicsPeriodTracked } from "../../../engines/politics/period.js";

export const EconomyEventActions = {
  click: {
    "run-economy-period": "_onRunEconomyPeriod",
    "open-tenday-history": "_onOpenTendayHistory"
  }
};

export const EconomyEventDomain = {
async _onOpenTendayHistory(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!game.user?.isGM) return;
  const operationId = String(event.currentTarget?.dataset?.operationId ?? "");
  const data = SkyholdData.get();
  const holdingId = this._activeWritableHoldingId(data);
  const holding = (data?.holdings ?? []).find((row) => String(row?.id ?? "") === String(holdingId ?? ""));
  const operation = (holding?.log ?? []).find((row) => String(row?.operationId ?? row?.id ?? "") === operationId);
  if (!operation || String(operation.type ?? "") !== "tenday") {
    ui.notifications?.warn?.("Сохранённый отчёт десятника не найден.");
    return;
  }
  const app = await openTendayHistory({ holdingId, holdingName: holding.name, operation });
  if (!app) ui.notifications?.warn?.("Эта старая операция не содержит полного отчёта.");
},

async _onRunEconomyPeriod(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!game.user?.isGM) return;
  const qd = normalizeTendayQd(event.currentTarget?.dataset?.qd);
  const data = SkyholdData.get();
  const holdingId = this._activeWritableHoldingId(data);
  if (!holdingId) return this._warnNoActiveHolding();
  return openTendayApp({ holdingId, qd });
},

_tendayDependencyHash(data, holdingId) {
  const snapshot = tendayDependencySnapshot(data, holdingId);
  return snapshot ? stableDataHash(snapshot) : "";
},

_isPreparedTendayCurrent(prepared = {}, suppliedData = null) {
  if (!prepared?.holdingId || !prepared?.dependencyHash) return false;
  const data = suppliedData ?? SkyholdData.view();
  // External world settings are included in the hash, not the data revision.
  return this._tendayDependencyHash(data, prepared.holdingId) === prepared.dependencyHash;
},

async _prepareTendayOperation({ holdingId = "", qd = 40, rationUnitsPerResident = null, dataView = null, dependencyHash: suppliedDependencyHash = "",
  operationId: suppliedOperationId = "", preparedAt: suppliedPreparedAt = "" } = {}) {
  if (!game.user?.isGM) return { ok: false, message: "Провести десятник может только GM." };
  const periodQd = normalizeTendayQd(qd);
  const data = dataView ?? SkyholdData.view();
  const id = String(holdingId ?? "");
  const source = (data?.holdings ?? []).find((holding) => String(holding?.id ?? "") === id);
  if (!source) return { ok: false, missing: true, message: "Владение для расчёта не найдено." };
  if (periodQd > 40 && politicsPeriodTracked(source, politicsDecisionContext(source, this, { data }))) {
    const prepared = await prepareSequentialTendays(this, { holdingId: id, qd: periodQd, data, rationUnitsPerResident,
      operationId: suppliedOperationId || makeId("tenday", 20), preparedAt: suppliedPreparedAt || new Date().toISOString() });
    if (!prepared.ok) return prepared;
    prepared.changeSet = buildTendayChangeSet(source, prepared.preparedHolding, {
      isFoodResource: (row) => this._isFoodResource(row), roomLabel: (holding, roomId) => this._storageRoomLabel(holding, roomId),
      formatNumber: (value) => this._formatNumber(value)
    });
    return prepared;
  }

  const operationId = suppliedOperationId || makeId("tenday", 20);
  const preparedAt = suppliedPreparedAt || new Date().toISOString();
  const sourceHash = stableDataHash(source);
  const dependencyHash = String(suppliedDependencyHash || this._tendayDependencyHash(data, id));
  const sourceSnapshot = clone(source);
  const previewHolding = clone(source);
  const sharedMarketDraft = data?.meta?.sharedMarkets?.enabled ? clone(data.meta.sharedMarkets) : null;
  bindSharedMarketHolding(previewHolding, sharedMarketDraft);
  if (!previewHolding.gm || typeof previewHolding.gm !== "object") previewHolding.gm = {};
  if (!previewHolding.gm.food || typeof previewHolding.gm.food !== "object") previewHolding.gm.food = {};
  const selectedRationUnits = normalizeFoodRationUnits(
    rationUnitsPerResident ?? previewHolding.gm.food.rationUnitsPerResident,
    10
  );
  previewHolding.gm.food.rationUnitsPerResident = selectedRationUnits;
  const calendariaGate = this._checkCalendariaEconomyAdvance(previewHolding, periodQd);
  if (!calendariaGate.ok) return { ok: false, blocked: true, message: calendariaGate.message, calendariaGate };

  beginPerishableStoragePeriod(previewHolding);
  let rawReport;
  try {
    rawReport = await this._runEconomyForQd(previewHolding, periodQd, { operationId, createdAt: preparedAt, data });
    finishPerishableStoragePeriod({
      holding: previewHolding,
      elapsedQd: periodQd,
      report: rawReport,
      appendLedger: appendEconomyLedger,
      formatNumber: (value) => this._formatNumber(value)
    });
  } catch (error) {
    cancelPerishableStoragePeriod(previewHolding);
    throw error;
  }
  const foodAvailable = Number(rawReport?.food?.availableBeforeConsumption);
  const readiness = await this._tendayReadinessContext(sourceSnapshot, {
    foodProjection: Number.isFinite(foodAvailable) ? { available: foodAvailable } : null
  });
  const recovery = this._advanceResidentRecovery(previewHolding, Math.floor(periodQd / 4));
  if (recovery.recovered) rawReport.work.push(`Выздоровело жителей: ${recovery.recovered}.`);
  // A game year is 240 days; count boundaries even when time advances by one day.
  const beforeAgeQd = Math.max(0, Number(sourceSnapshot?.gm?.calendaria?.lastQd) || 0);
  const elapsedYears = Math.floor((beforeAgeQd + periodQd) / 960) - Math.floor(beforeAgeQd / 960);
  if (!calendariaGate.snapshot?.available && elapsedYears > 0) {
    const aging = this._advanceResidentAges(previewHolding, elapsedYears);
    if (aging.changed) rawReport.work.push(`Возрастные категории изменились: ${aging.changed}.`);
    if (aging.educated) rawReport.work.push(`Школа дала развитие детям: ${aging.educated}.`);
  }
  const calendarAdvance = this._commitCalendariaEconomyAdvance(previewHolding, calendariaGate);
  if (calendarAdvance?.aging?.changed) rawReport.work.push(`Возрастные категории изменились: ${calendarAdvance.aging.changed}.`);
  if (calendarAdvance?.aging?.educated) rawReport.work.push(`Школа дала развитие детям: ${calendarAdvance.aging.educated}.`);
  const clock = advanceTendayClock(previewHolding, periodQd);
  advanceSharedMarketClock(previewHolding);
  const marketStockRecovery = recoverMarketStock({
    holding: previewHolding,
    currentTenday: clock.afterPeriod,
    updatedAt: `tenday:${clock.afterPeriod}`
  });
  rawReport.marketStockRecovery = marketStockRecovery;
  if (marketStockRecovery.recoveredQty > 0) rawReport.work.push(`Внешние рынки восстановили ${marketStockRecovery.recoveredQty} ед. запаса.`);
  const report = this._appendEconomyStorageLog(previewHolding, rawReport, { operationId });
  const eventPeriods = Math.max(1, Math.floor(periodQd / 40));
  const events = typeof this._prepareTendayRandomEvents === "function"
    ? this._prepareTendayRandomEvents(previewHolding, {
      periods: eventPeriods,
      operationId,
      regionOptions: data?.catalog?.eventRegions
    })
    : { periods: eventPeriods, entries: [], events: [], warnings: ["Модуль событий недоступен."] };
  const preparedHolding = mergeHoldingDefaults(previewHolding);
  const dueEvents = dueTendaySchedule(preparedHolding, clock.after);
  const changeSet = buildTendayChangeSet(sourceSnapshot, preparedHolding, {
    isFoodResource: (row) => this._isFoodResource(row),
    roomLabel: (holding, roomId) => this._storageRoomLabel(holding, roomId),
    formatNumber: (value) => this._formatNumber(value)
  });
  const warnings = [];
  if (this._safeNumber(report?.food?.hungryResidentDays, 0) > 0) warnings.push({ key: "food", severity: "danger", text: `Голод: ${report.food.hungryResidentDays} человеко-дней без пищи.` });
  if (this._safeNumber(report?.treasury?.deficit, 0) > 0) warnings.push({ key: "treasury", severity: "danger", text: `Дефицит казны: ${this._formatCopperCurrency(report.treasury.deficit)}.` });
  if ((report?.maintenance?.needsResolution ?? []).length) warnings.push({ key: "maintenance", severity: "warning", text: `Требуют решения GM после третьего пропуска обслуживания: ${report.maintenance.needsResolution.length}.` });
  if ((report?.skipped ?? []).length) warnings.push({ key: "skipped", severity: "warning", text: `Не выполнено операций: ${report.skipped.length}.` });
  if (dueEvents.length) warnings.push({ key: "due-events", severity: "warning", text: `Подошёл срок запланированных событий: ${dueEvents.length}.` });
  for (const text of events?.warnings ?? []) warnings.push({ key: "events", severity: "warning", text: String(text) });
  return {
    ok: true,
    operationId,
    holdingId: id,
    holdingName: String(source.name || "Владение"),
    qd: periodQd,
    rationUnitsPerResident: selectedRationUnits,
    periodLabel: String(report.periodLabel || `${periodQd} QD`),
    sourceHash,
    dependencyHash,
    dataRevision: Math.max(0, Number(data?.meta?.revision) || 0),
    preparedHolding,
    ...(sharedMarketDraft ? { preparedSharedMarkets: sharedMarketDraft } : {}),
    report,
    recovery,
    calendarAdvance,
    calendariaGate,
    clock,
    readiness,
    events,
    dueEvents,
    changeSet,
    warnings,
    preparedAt
  };
},

async _applyPreparedTendayOperation(prepared = {}) {
  if (!game.user?.isGM) return { ok: false, message: "Провести десятник может только GM." };
  if (!prepared?.ok || !prepared?.preparedHolding || !prepared?.holdingId) return { ok: false, message: "Подготовленный расчёт десятника отсутствует." };
  const payload = buildTendayOperationPayload(prepared);
  const result = await SkyholdData.updateHolding(prepared.holdingId, (holding, data) => {
    const replay = preparedTendayReplay(holding, prepared.operationId);
    if (replay) {
      return SkyholdData.skipTransaction({
        ok: true,
        replay: true,
        duplicate: true,
        holding: clone(holding),
        operationId: prepared.operationId
      });
    }
    const dependencyHash = this._tendayDependencyHash(data, prepared.holdingId);
    if (!dependencyHash || dependencyHash !== prepared.dependencyHash) {
      return SkyholdData.skipTransaction({ ok: false, stale: true, message: "Владение или влияющий каталог изменились после расчёта. Подготовь десятник заново." });
    }
    const applied = applyPreparedTenday(holding, prepared.preparedHolding, prepared.sourceHash, { hash: stableDataHash, clone });
    if (!applied.ok) {
      return SkyholdData.skipTransaction({ ok: false, stale: true, message: "Владение изменилось после расчёта. Подготовь десятник заново." });
    }
    if (prepared.preparedSharedMarkets) data.meta.sharedMarkets = clone(prepared.preparedSharedMarkets);
    appendHoldingOperation(holding, {
      operationId: prepared.operationId,
      type: "tenday",
      createdAt: new Date().toISOString(),
      title: `Проведён десятник №${prepared.clock?.afterPeriod ?? "—"}: ${prepared.holdingName}`,
      summary: `Казна ${prepared.changeSet?.money?.deltaText ?? "0"}; изменено ресурсов ${prepared.changeSet?.resources?.length ?? 0}; стройки ${prepared.report?.construction?.attempts ?? 0}; события ${prepared.events?.events?.length ?? 0}.`,
      payload
    });
    return { ok: true, holding: clone(holding), operationId: prepared.operationId };
  }, { fallback: false, reason: `economy:tenday:${prepared.operationId}` });
  if (!result?.ok) return result ?? { ok: false, message: "Не удалось записать десятник." };
  if (result.replay) return { ...result, chatPosted: false, chatError: "", prepared };

  let chatPosted = true;
  let chatError = "";
  try {
    await this._postTendaySummaryChat(result.holding, prepared);
  } catch (error) {
    chatPosted = false;
    chatError = error?.message ?? String(error);
    console.error("FBL Skyhold | Tenday committed, but chat summary failed", error);
    ui.notifications.warn("Десятник проведён, но краткую карточку не удалось отправить в чат.");
  }
  this.requestRender?.();
  return { ...result, chatPosted, chatError, prepared };
},

_advanceResidentRecovery(holding, days = 0) {
  const delta = Math.max(0, Math.floor(this._safeNumber(days, 0)));
  if (!delta) return { recovered: 0 };
  let recovered = 0;
  for (const person of holding?.people?.list ?? []) {
    const current = Math.max(0, Math.floor(this._safeNumber(person?.injuredDays, 0)));
    if (!current) continue;
    const next = Math.max(0, current - delta);
    person.injuredDays = next;
    if (next <= 0) {
      recovered += 1;
      if (/ранен|тяжело|сломлен|injured|wound/i.test(String(person.status ?? ""))) person.status = "";
      if (person.battleCondition) person.battleCondition = "";
    } else {
      person.status = `Ранен (${next} дн.)`;
    }
  }
  return { recovered };
},

_advanceResidentAges(holding, years = 1) {
  const count = Math.max(0, Math.floor(this._safeNumber(years, 0)));
  if (!count) return { aged: 0, changed: 0 };
  const school = this._schoolEducationContext(holding);
  let aged = 0;
  let changed = 0;
  let educated = 0;
  for (const person of holding?.people?.list ?? []) {
    if (!person || person.dead) continue;
    const oldAge = Math.max(0, Math.floor(this._safeNumber(person.age, 0)));
    const oldGroup = ageGroupFromAge(person.age, person.race, person.subrace);
    const newAge = Math.max(0, oldAge + count);
    if (school.active) educated += this._applySchoolEducation(holding, person, oldAge, newAge, school);
    person.age = newAge;
    const newGroup = ageGroupFromAge(person.age, person.race, person.subrace);
    person.ageGroup = newGroup;
    aged += 1;
    if (oldGroup !== newGroup) {
      changed += 1;
      const groups = ["Ре", "Мл", "Вз", "Ст"];
      const oldIndex = groups.indexOf(oldGroup);
      const newIndex = groups.indexOf(newGroup);
      const names = { strength: "Сила", agility: "Ловкость", wits: "Разум", empathy: "Эмпатия" };
      const transitionNotes = [];
      if (oldIndex >= 0 && newIndex > oldIndex) {
        for (let index = oldIndex + 1; index <= newIndex; index += 1) {
          const fromGroup = groups[index - 1];
          const toGroup = groups[index];
          const adjusted = adjustResidentAttributesForAgeTransition(person.attributes, fromGroup, toGroup);
          person.attributes = adjusted.attributes;
          const changeText = adjusted.changes
            .map(({ key, delta }) => `${names[key]} ${delta > 0 ? "+" : ""}${delta}`)
            .join(", ");
          transitionNotes.push(`${fromGroup} → ${toGroup}${changeText ? `; ${changeText}` : ""}`);
        }
      }
      const prefix = oldGroup === "Ре" ? "Вырос" : "Возрастная категория изменилась";
      person.notes = [String(person.notes ?? "").trim(), `${prefix}: ${transitionNotes.join("; ") || `${oldGroup} → ${newGroup}`}.`].filter(Boolean).join("\n");
    }
  }
  return { aged, changed, educated };
},

_schoolEducationContext(holding) {
  const buildings = (holding?.buildings?.list ?? []).filter((building) => {
    const id = `${String(building?.id ?? "")} ${String(building?.templateId ?? "")}`.toLowerCase();
    const name = String(building?.name ?? "").toLowerCase();
    if (!buildingOperationalState(building).operational || !(id === "school" || id.includes("school") || name.includes("школ"))) return false;
    return !financeBuildingFunctionBlockState({ finance: holding?.finance, buildingId: String(building?.id ?? ""), functionId: "culture" }).blocked;
  });
  const peopleById = new Map((holding?.people?.list ?? []).map((person) => [String(person?.id ?? ""), person]));
  const teachers = [];
  for (const building of buildings) {
    for (const id of Array.isArray(building?.assignedWorkerIds) ? building.assignedWorkerIds : []) {
      const person = peopleById.get(String(id));
      if (!person || person.dead || this._safeNumber(person?.injuredDays, 0) > 0) continue;
      if (financeWorkerBlockState({ finance: holding?.finance, workerId: String(person?.id ?? "") }).blocked) continue;
      const group = ageGroupFromAge(person.age, person.race, person.subrace);
      if (group === "Ре") continue;
      teachers.push(person);
    }
  }
  const teacherCount = teachers.length;
  const requiredTeachers = buildings.length ? Math.min(...buildings.map((building) => Math.max(1, Math.floor(this._safeNumber(building?.workersMin, 1))))) : 1;
  return { active: teacherCount >= requiredTeachers, teacherCount, requiredTeachers };
},

_childEducationMilestones(person = {}) {
  const thresholds = ageThresholdsFor(raceKeyFromResident(person));
  const young = Math.max(1, Math.floor(this._safeNumber(thresholds?.young, 18)));
  return [
    { key: "child-third-1", age: Math.max(1, Math.floor(young / 3)), label: "первая треть детства" },
    { key: "child-third-2", age: Math.max(1, Math.floor((young * 2) / 3)), label: "вторая треть детства" },
    { key: "child-end", age: young, label: "выход из детства" }
  ];
},

_applySchoolEducation(holding, person = {}, oldAge = 0, newAge = 0, school = {}) {
  const oldGroup = ageGroupFromAge(oldAge, person.race, person.subrace);
  if (oldGroup !== "Ре") return 0;
  if (!Array.isArray(person.educationMilestones)) person.educationMilestones = [];
  const done = new Set(person.educationMilestones.map((value) => String(value)));
  let resolutions = 0;
  for (const milestone of this._childEducationMilestones(person)) {
    if (done.has(milestone.key)) continue;
    if (!(oldAge < milestone.age && newAge >= milestone.age)) continue;
    person.educationMilestones.push(milestone.key);
    const operationId = `school-milestone:${String(person?.id ?? "resident")}:${milestone.key}:${milestone.age}`;
    appendHoldingOperation(holding, {
      operationId,
      type: "system",
      title: `Решение ГМа: обучение ${person.name || "ребёнка"}`,
      summary: `${person.name || "Ребёнок"} достиг(ла) вехи «${milestone.label}» при работающей Школе. ГМ решает ролевой результат; характеристики и черты автоматически не меняются.`,
      payload: { needsResolution: true, resolutionKind: "school-milestone", residentId: person.id, milestone: milestone.key, age: milestone.age, teacherCount: school.teacherCount }
    });
    person.notes = [String(person.notes ?? "").trim(), `Школа: достигнута веха «${milestone.label}»; результат ожидает решения ГМа.`].filter(Boolean).join("\n");
    resolutions += 1;
  }
  return resolutions;
},

_checkCalendariaEconomyAdvance(holding, qd = 0) {
  const snapshot = getCalendariaSnapshot();
  if (!snapshot.available) return { ok: true, snapshot, targetDateTime: null, targetTimestamp: null };
  const calendar = holding?.gm?.calendaria ?? {};
  const lastDateTime = calendar.lastDateTime && typeof calendar.lastDateTime === "object" ? calendar.lastDateTime : null;
  const lastTimestamp = Number(calendar.lastTimestamp);
  if (!lastDateTime || !Number.isFinite(lastTimestamp) || snapshot.timestamp === null || snapshot.timestamp === undefined) {
    return { ok: true, snapshot, targetDateTime: null, targetTimestamp: null };
  }
  const targetDateTime = addCalendariaQd(lastDateTime, qd);
  const targetTimestamp = timestampForCalendariaDate(targetDateTime);
  if (Number.isFinite(targetTimestamp) && Number.isFinite(Number(snapshot.timestamp)) && targetTimestamp > Number(snapshot.timestamp) + 0.0001) {
    return {
      ok: false,
      snapshot,
      targetDateTime,
      targetTimestamp,
      message: `Нельзя обновить владение дальше текущей даты Calendaria. Последнее обновление: ${formatCalendariaDateTime(lastDateTime)}; попытка: ${formatCalendariaDateTime(targetDateTime)}; сейчас: ${snapshot.text}.`
    };
  }
  return { ok: true, snapshot, targetDateTime, targetTimestamp };
},

_commitCalendariaEconomyAdvance(holding, gate = {}) {
  const snapshot = gate.snapshot ?? getCalendariaSnapshot();
  if (!snapshot.available) return { available: false, aging: null, dateTime: null, timestamp: null };
  if (!holding.gm) holding.gm = {};
  if (!holding.gm.calendaria || typeof holding.gm.calendaria !== "object") holding.gm.calendaria = {};
  const previous = holding.gm.calendaria.lastDateTime && typeof holding.gm.calendaria.lastDateTime === "object" ? holding.gm.calendaria.lastDateTime : null;
  const dateTime = gate.targetDateTime ?? snapshot.dateTime;
  let aging = null;
  if (previous && dateTime && Number.isFinite(Number(previous.year)) && Number.isFinite(Number(dateTime.year)) && Number(dateTime.year) > Number(previous.year)) {
    aging = this._advanceResidentAges(holding, Math.max(1, Math.floor(Number(dateTime.year) - Number(previous.year))));
  }
  const timestamp = Number.isFinite(Number(gate.targetTimestamp)) ? Number(gate.targetTimestamp) : snapshot.timestamp;
  holding.gm.calendaria.lastDateTime = dateTime ? (foundry?.utils?.deepClone?.(dateTime) ?? JSON.parse(JSON.stringify(dateTime))) : null;
  holding.gm.calendaria.lastTimestamp = Number.isFinite(Number(timestamp)) ? Number(timestamp) : null;
  holding.gm.calendaria.lastDateKey = calendariaDateKey(dateTime);
  holding.gm.calendaria.lastDateText = dateTime ? formatCalendariaDateTime(dateTime) : "";
  return { available: true, aging, dateTime, timestamp: holding.gm.calendaria.lastTimestamp };
},

async _onCalendariaLastDateChange(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!game.user?.isGM) return;
  const value = String(event.currentTarget?.value ?? "").trim();
  try {
    const snapshot = getCalendariaSnapshot();
    const parsed = parseCalendariaDateInput(value, snapshot.dateTime);
    if (!parsed && value && /^-?\d+\D+\d{1,2}\D+\d{1,2}/.test(value)) {
      ui.notifications.warn("Такого месяца нет в активном календаре Calendaria. Для этого календаря используйте месяц из доступного диапазона.");
      this.requestRender();
      return;
    }
    const result = await this._updateActiveHolding((holding) => {
      if (!holding.gm) holding.gm = {};
      if (!holding.gm.calendaria || typeof holding.gm.calendaria !== "object") holding.gm.calendaria = {};
      if (!parsed && value) {
        holding.gm.calendaria.lastDateText = value;
        holding.gm.calendaria.lastDateTime = null;
        holding.gm.calendaria.lastTimestamp = null;
        holding.gm.calendaria.lastDateKey = value;
        return { warnTextDate: true };
      }
      if (parsed) {
        const timestamp = timestampForCalendariaDate(parsed);
        holding.gm.calendaria.lastDateTime = parsed;
        holding.gm.calendaria.lastTimestamp = Number.isFinite(Number(timestamp)) ? Number(timestamp) : null;
        holding.gm.calendaria.lastDateKey = calendariaDateKey(parsed);
        holding.gm.calendaria.lastDateText = formatCalendariaDateTime(parsed);
        return { warnTextDate: false };
      }
      holding.gm.calendaria.lastDateText = "";
      holding.gm.calendaria.lastDateTime = null;
      holding.gm.calendaria.lastTimestamp = null;
      holding.gm.calendaria.lastDateKey = "";
      return { warnTextDate: false };
    }, { reason: "economy:set-calendaria-date" });
    if (!result) return;
    if (result.warnTextDate) ui.notifications.warn("Дата сохранена как текст. Для защиты от перегонки времени используй формат ГГГГ-ММ-ДД ЧЧ:ММ.");
    this.requestRender();
  } catch (error) {
    console.error("FBL Skyhold | Failed to set Calendaria last update date", error);
    ui.notifications.error("Не удалось сохранить дату последнего обновления. Подробности в консоли.");
  }
},

async _postTendaySummaryChat(holding, prepared = {}) {
  const report = prepared?.report ?? {};
  const changeSet = prepared?.changeSet ?? {};
  const money = changeSet?.money ?? { before: 0, after: 0, delta: 0 };
  const moneyDelta = this._safeNumber(money.delta, 0);
  const moneyDeltaText = `${moneyDelta > 0 ? "+" : moneyDelta < 0 ? "−" : ""}${this._formatCopperCurrency(Math.abs(moneyDelta))}`;
  const food = report?.food ?? {};
  const publicEvents = (prepared?.events?.events ?? []).filter((event) => String(event?.visibility ?? "public") !== "gm");
  const publicTitles = publicEvents.slice(0, 3).map((event) => String(event?.title ?? "Событие"));
  const publicEventText = publicTitles.length
    ? `${publicTitles.join("; ")}${publicEvents.length > publicTitles.length ? `; ещё ${publicEvents.length - publicTitles.length}` : ""}`
    : (prepared?.events?.events?.length ? "Результат доступен GM." : "Активных событий нет.");
  const construction = report?.construction ?? {};
  const skipped = report?.skipped ?? [];
  await createFoundryChatMessage({
    speaker: foundryChatSpeaker({ alias: holding.name || "Владение" }),
    content: `
      <div class="fbls-chat-card fbls-chat-tenday-summary">
        <h3>Десятник №${escapeHtml(prepared?.clock?.afterPeriod ?? "—")}: ${escapeHtml(holding.name || "Владение")}</h3>
        <p><strong>Казна:</strong> ${escapeHtml(this._formatCopperCurrency(money.before))} → ${escapeHtml(this._formatCopperCurrency(money.after))} (${escapeHtml(moneyDeltaText)}).</p>
        <p><strong>Пища:</strong> съедено ${this._safeNumber(food.eaten, 0)} из ${this._safeNumber(food.needed, 0)}${this._safeNumber(food.hungryResidentDays, 0) > 0 ? `; голод ${this._safeNumber(food.hungryResidentDays, 0)} человеко-дней` : ""}.</p>
        <p><strong>Хозяйство:</strong> производственных изменений ${(report.produced ?? []).length}, расходных ${(report.consumed ?? []).length}; стройки ${this._safeNumber(construction.attempts, 0)}, завершено ${this._safeNumber(construction.completed, 0)}${skipped.length ? `; не выполнено ${skipped.length}` : ""}.</p>
        <p><strong>События:</strong> ${escapeHtml(publicEventText)}</p>
      </div>
    `
  });
},

async _onRunTenDayEconomy(event) {
  return this._onRunEconomyPeriod(event);
}
};
