import { buildingOperationalState } from "../core/building-state.js";
import { isMedicalBuilding } from "../core/building-specials.js";
import { normalizeAgricultureBuilding } from "./agriculture.js";
import { normalizeLivestockBuilding } from "./livestock.js";
import { isPlainObject, makeId, toNumber } from "./utils.js";
import { isResidentInPopulation, isResidentPresent } from "./resident-presence.js";
import { normalLaborQdPerTenday, residentLaborCapacity } from "./labor-budget.js";
import {
  buildingAcceptsWorkers,
  buildingLaborCapacityQd,
  buildingMinOperationalQd,
  newLaborIssues,
  reservedOccupation,
  validateBuildingLaborAndGoals
} from "./labor-model.js";

export const WORK_ALLOCATION_SCHEMA_VERSION = 1;
export const WORK_ALLOCATION_NORMAL_QD_PER_TENDAY = 20;
export const WORK_ALLOCATION_OVERTIME_QD_PER_TENDAY = 10;
export const MAX_WORK_ALLOCATIONS_PER_PERSON = 24;

function whole(value, fallback = 0) {
  return Math.max(0, Math.floor(toNumber(value, fallback)));
}

function text(value = "") {
  return String(value ?? "").trim();
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string") return ["1", "true", "yes", "on", "да"].includes(value.trim().toLocaleLowerCase("ru"));
  return Boolean(value);
}

export function workAllocationTargetKey(sourceId = "", functionId = "") {
  const source = text(sourceId);
  const fn = text(functionId);
  return source && fn ? `${source}::${fn}` : "";
}

export function parseWorkAllocationTargetKey(value = "") {
  const raw = text(value);
  const splitAt = raw.indexOf("::");
  if (splitAt <= 0 || splitAt >= raw.length - 2) return { sourceId: "", functionId: "" };
  return {
    sourceId: text(raw.slice(0, splitAt)),
    functionId: text(raw.slice(splitAt + 2))
  };
}

export function normalizeWorkAllocation(value = {}, index = 0) {
  const source = isPlainObject(value) ? value : {};
  const parsed = parseWorkAllocationTargetKey(source.targetKey);
  const sourceId = text(source.sourceId || parsed.sourceId);
  const functionId = text(source.functionId || parsed.functionId);
  return {
    schemaVersion: WORK_ALLOCATION_SCHEMA_VERSION,
    id: text(source.id) || makeId(`work-${index + 1}`),
    sourceId,
    functionId,
    normalQd: whole(source.normalQd ?? source.plannedNormalQd ?? source.qd),
    overtimeQd: whole(source.overtimeQd ?? source.plannedOvertimeQd),
    ...(source.volunteer === true ? { volunteer: true, volunteerReason: text(source.volunteerReason) } : {})
  };
}

export function normalizePersonWorkAllocations(person = {}) {
  const source = Array.isArray(person?.workAllocations) ? person.workAllocations : [];
  const rows = [];
  const ids = new Set();
  for (let index = 0; index < source.length; index += 1) {
    const row = normalizeWorkAllocation(source[index], index);
    let id = row.id;
    let suffix = 2;
    while (ids.has(id)) id = `${row.id}-${suffix++}`;
    ids.add(id);
    rows.push(id === row.id ? row : { ...row, id });
  }
  delete person.workAllocationMode;
  person.workAllocations = rows;
  return person;
}

export function workAllocationTotals(rows = []) {
  return (Array.isArray(rows) ? rows : []).reduce((totals, raw) => {
    const row = normalizeWorkAllocation(raw);
    totals.normalQd += row.normalQd;
    totals.overtimeQd += row.overtimeQd;
    totals.totalQd += row.normalQd + row.overtimeQd;
    return totals;
  }, { normalQd: 0, overtimeQd: 0, totalQd: 0 });
}

export function validateWorkAllocationPlan(rows = [], {
  targets = null,
  holding = null,
  maximumNormalQd = normalLaborQdPerTenday(holding),
  maximumOvertimeQd = Math.floor(maximumNormalQd / 2)
} = {}) {
  const source = Array.isArray(rows) ? rows : [];
  const targetMap = targets instanceof Map
    ? targets
    : (Array.isArray(targets) ? new Map(targets.map((target) => [target.key, target])) : null);
  const issues = [];
  const normalized = source.slice(0, MAX_WORK_ALLOCATIONS_PER_PERSON).map((row, index) => normalizeWorkAllocation(row, index));
  if (source.length > MAX_WORK_ALLOCATIONS_PER_PERSON) {
    issues.push({
      code: "allocation-count",
      actual: source.length,
      limit: MAX_WORK_ALLOCATIONS_PER_PERSON,
      message: `У одного работника допускается не более ${MAX_WORK_ALLOCATIONS_PER_PERSON} строк труда.`
    });
  }
  const seenTargets = new Set();
  for (const row of normalized) {
    const key = workAllocationTargetKey(row.sourceId, row.functionId);
    const hasWork = row.normalQd > 0 || row.overtimeQd > 0;
    if (hasWork && !key) issues.push({ code: "allocation-target", allocationId: row.id, message: "Для выделенных QD нужно выбрать рабочую функцию." });
    if (key && seenTargets.has(key)) issues.push({ code: "allocation-duplicate", allocationId: row.id, targetKey: key, message: "Одна рабочая функция не может повторяться в плане жителя." });
    if (key) seenTargets.add(key);
    const target = key && targetMap ? targetMap.get(key) : null;
    if (hasWork && targetMap && !target) issues.push({ code: "allocation-unknown", allocationId: row.id, targetKey: key, message: "Выбранная рабочая функция больше недоступна." });
    if (row.overtimeQd > 0 && target && !target.overtimeAllowed) {
      issues.push({
        code: "allocation-overtime",
        allocationId: row.id,
        targetKey: key,
        actual: row.overtimeQd,
        limit: 0,
        message: "Эта функция не разрешает переработку."
      });
    }
  }
  const totals = workAllocationTotals(normalized);
  const normalCap = whole(maximumNormalQd, WORK_ALLOCATION_NORMAL_QD_PER_TENDAY);
  const overtimeCap = whole(maximumOvertimeQd, WORK_ALLOCATION_OVERTIME_QD_PER_TENDAY);
  if (totals.normalQd > normalCap) {
    issues.push({
      code: "allocation-normal-cap",
      actual: totals.normalQd,
      limit: normalCap,
      message: `Обычный труд превышает ${normalCap} QD за период.`
    });
  }
  if (totals.overtimeQd > overtimeCap) {
    issues.push({
      code: "allocation-overtime-cap",
      actual: totals.overtimeQd,
      limit: overtimeCap,
      message: `Переработка превышает ${overtimeCap} QD за период.`
    });
  }
  const dailyOvertimeCap = Math.floor(totals.normalQd / 2);
  if (totals.overtimeQd > dailyOvertimeCap) {
    issues.push({
      code: "allocation-overtime-days",
      actual: totals.overtimeQd,
      limit: dailyOvertimeCap,
      message: "Каждый overtime-QD требует в тот же период два обычных рабочих QD."
    });
  }
  return { ok: issues.length === 0, rows: normalized, totals, issues };
}

function productionFunctionId(line = {}, index = 0) {
  return `production:${text(line?.id) || `line-${index + 1}`}`;
}

function buildingHasIncomeFunction(building = {}) {
  if (Object.prototype.hasOwnProperty.call(building?.functions ?? {}, "income")) return building.functions.income === true;
  const income = building?.income ?? {};
  return Boolean(income.trade?.enabled || toNumber(income.base, 0) || toNumber(income.perWorker, 0) || text(income.formula));
}

function targetRow(building, functionId, label, {
  overtimeAllowed = false,
  dailyRateCopper = 0,
  kind = "building"
} = {}) {
  const sourceId = text(building?.id);
  const rate = whole(dailyRateCopper);
  const state = buildingOperationalState(building);
  const capacityQd = buildingLaborCapacityQd(building);
  return {
    key: workAllocationTargetKey(sourceId, functionId),
    sourceId,
    functionId,
    buildingId: sourceId,
    functionName: label,
    capacityQd,
    minOperationalQd: buildingMinOperationalQd(building),
    available: state.operational,
    blockedReason: state.operational ? "" : state.label,
    label: `${text(building?.name) || "Здание"} · ${label} · ${rate > 0 ? `${rate} ММ/день` : "ставка не задана"}`,
    overtimeAllowed: bool(overtimeAllowed),
    dailyRateCopper: rate,
    kind
  };
}

export function buildWorkAllocationTargets(holding = {}) {
  const targets = [];
  for (const building of holding?.buildings?.list ?? []) {
    const state = buildingOperationalState(building);
    if (!text(building?.id) || !buildingAcceptsWorkers(building)) continue;
    const medical = isMedicalBuilding(building);
    const productionEnabled = !medical && building?.functions?.production !== false;
    const agriculture = normalizeAgricultureBuilding(building?.agriculture, { building });
    const lines = productionEnabled && !agriculture && Array.isArray(building?.productionLines) ? building.productionLines : [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (text(line?.source || "workers") !== "workers" && !(line?.requiresCollection && whole(line?.collectQd) > 0)) continue;
      const functionId = productionFunctionId(line, index);
      const label = text(line?.mode || line?.resource || line?.resourceId) || `Линия ${index + 1}`;
      const target = targetRow(building, functionId, label, {
        overtimeAllowed: line?.overtime === true,
        dailyRateCopper: whole(line?.wageDailyCopper) || whole(building?.wageDailyCopper),
        kind: "production"
      });
      const paused = line?.active === false;
      const collectionAvailable = state.operational && line?.requiresCollection === true && whole(line?.collectQd) > 0 && Number(line?.pendingQty) > 0;
      targets.push({
        ...target,
        paused,
        collectionAvailable,
        available: target.available && (!paused || collectionAvailable),
        blockedReason: target.blockedReason || (paused && !collectionAvailable ? "Линия приостановлена" : "")
      });
    }
    if (productionEnabled && agriculture?.enabled) {
      targets.push(targetRow(building, "agriculture", agriculture.kind === "field" ? "Полевые работы" : "Работы в саду", {
        dailyRateCopper: whole(building?.wageDailyCopper),
        kind: "agriculture"
      }));
    }
    const livestock = normalizeLivestockBuilding(building?.livestock, { building });
    if (productionEnabled && livestock?.enabled) {
      targets.push(targetRow(building, "livestock", `Животноводство: ${livestock.profile.label}`, {
        dailyRateCopper: whole(building?.wageDailyCopper),
        kind: "livestock"
      }));
    }
    if (!medical && buildingHasIncomeFunction(building)) {
      targets.push(targetRow(building, "income", "Доход и услуги", {
        dailyRateCopper: whole(building?.income?.wageDailyCopper) || whole(building?.wageDailyCopper),
        kind: "income"
      }));
    }
    const functions = !medical && building?.functions && typeof building.functions === "object" ? building.functions : {};
    const staffedFunctions = [
      [functions.defense, "defense", "Оборона", "defense"],
      [functions.culture, "culture", "Услуги учреждения", "culture"],
      [functions.storage, "storage", "Охрана и работа склада", "storage"],
      [functions.housing, "housing", "Уход за жильём", "housing"],
      [isMedicalBuilding(building), "medical", "Медицинская помощь", "medical"]
    ];
    for (const [enabled, functionId, label, kind] of staffedFunctions) {
      if (!enabled) continue;
      targets.push(targetRow(building, functionId, label, {
        dailyRateCopper: whole(building?.wageDailyCopper),
        kind
      }));
    }
  }
  return targets;
}

export function workFunctionMatches(actual, expected = "") {
  const fn = text(actual);
  if (!fn) return false;
  if (!expected || fn === expected) return true;
  return expected === "production" && (fn.startsWith("production:") || fn === "agriculture" || fn === "livestock");
}

export function allocatedBuildingQd(rows = [], buildingId = "", functionId = "", allowedFunctions = null) {
  const id = text(buildingId);
  return (Array.isArray(rows) ? rows : []).reduce((sum, row) => {
    const fn = text(row?.functionId);
    if (text(row?.sourceId) !== id || !workFunctionMatches(fn, functionId) || (allowedFunctions && !allowedFunctions.has(fn))) return sum;
    return sum + whole(row?.normalQd ?? row?.qd) + whole(row?.overtimeQd);
  }, 0);
}

export function buildingWorkAllocationsForBuilding(person = {}, buildingId = "", functionId = "") {
  const id = text(buildingId);
  if (!id || !isResidentPresent(person) || person?.dead) return [];
  return (Array.isArray(person?.workAllocations) ? person.workAllocations : []).filter((row) => (
    text(row?.sourceId) === id
    && (!functionId || workFunctionMatches(row?.functionId, functionId))
    && whole(row?.normalQd ?? row?.qd) + whole(row?.overtimeQd) > 0
  ));
}

export const explicitWorkAllocationsForBuilding = buildingWorkAllocationsForBuilding;

export function buildingWorkerIds(holding = {}, buildingOrId = "", functionId = "") {
  const buildingObj = buildingOrId && typeof buildingOrId === "object" ? buildingOrId : null;
  const id = text(buildingObj ? buildingObj.id : buildingOrId);
  if (!id) return [];
  const building = (holding?.buildings?.list ?? []).find((row) => text(row?.id) === id) ?? buildingObj;
  if (!building || !buildingAcceptsWorkers(building)) return [];
  return (holding?.people?.list ?? [])
    .filter((person) => buildingWorkAllocationsForBuilding(person, id, functionId).length > 0)
    .map((person) => text(person?.id))
    .filter(Boolean);
}

export const explicitWorkerIdsForBuilding = buildingWorkerIds;
export const buildingStaffingWorkerIds = buildingWorkerIds;

export function residentWorkUnavailable(holding, person) {
  if (person?.dead) return "Умер";
  if (!isResidentInPopulation(person, holding)) return "Вне поселения / отдых экипажа";
  if (whole(person?.injuredDays) > 0) return "Ранен";
  if (residentLaborCapacity(person, holding).normalQd === 0) return "Не может работать по возрасту";
  return reservedOccupation(holding, person)?.label ?? "";
}

function workAllocationChangeIssues(previousHolding, holding, targetMap, replacedPersonId) {
  const previousPeople = new Map((previousHolding?.people?.list ?? []).map((person) => [text(person.id), person]));
  const issues = [];
  for (const person of holding?.people?.list ?? []) {
    const personId = text(person.id);
    const prior = previousPeople.get(personId);
    if (JSON.stringify(prior?.workAllocations ?? []) === JSON.stringify(person.workAllocations ?? [])) continue;
    const previousRows = new Map((Array.isArray(prior?.workAllocations) ? prior.workAllocations : []).map((row) => [
      workAllocationTargetKey(row?.sourceId, row?.functionId), row
    ]));
    const unavailable = residentWorkUnavailable(holding, person)
      || (personId !== replacedPersonId && prior ? reservedOccupation(previousHolding, prior)?.label : "");
    for (const row of Array.isArray(person.workAllocations) ? person.workAllocations : []) {
      if (!row) continue;
      const key = workAllocationTargetKey(row.sourceId, row.functionId);
      const old = previousRows.get(key);
      if (whole(row.normalQd ?? row.qd) <= whole(old?.normalQd ?? old?.qd)
        && whole(row.overtimeQd) <= whole(old?.overtimeQd)) continue;
      const target = targetMap.get(key);
      const reason = unavailable || (target?.available === false ? target.blockedReason || "Выбранная работа сейчас недоступна" : "");
      if (reason) issues.push({
        code: unavailable ? "resident-unavailable" : "work-target-unavailable",
        personId,
        sourceId: text(row.sourceId),
        functionId: text(row.functionId),
        message: `${text(person.name) || "Житель"}: ${reason}.`
      });
    }
  }
  return issues;
}

export function validateHoldingWorkAllocations(holding = {}, { previousHolding = null, replacedPersonId = "" } = {}) {
  const targets = buildWorkAllocationTargets(holding);
  const targetMap = new Map(targets.map((target) => [target.key, target]));
  const issues = [];
  const plans = new Map();
  for (const person of holding?.people?.list ?? []) {
    if (!isResidentPresent(person) || person?.dead) continue;
    const personId = text(person?.id);
    const capacity = residentLaborCapacity(person, holding);
    const validation = validateWorkAllocationPlan(person?.workAllocations, {
      targets: targetMap,
      holding,
      maximumNormalQd: capacity.normalQd,
      maximumOvertimeQd: capacity.overtimeQd
    });
    plans.set(personId, validation);
    for (const issue of validation.issues) issues.push({ ...issue, personId, personName: text(person?.name) || "Житель" });
    if (validation.totals.totalQd > 0) {
      const reserved = reservedOccupation(holding, person);
      if (reserved) {
        issues.push({
          code: "allocation-incompatible",
          personId,
          personName: text(person?.name) || "Житель",
          evidence: reserved.kind,
          message: `План QD несовместим с занятостью (${reserved.label}).`
        });
      }
    }
  }

  issues.push(...validateBuildingLaborAndGoals(holding, { targets: targetMap, skipResidentBudget: true }).issues);
  const blockingIssues = previousHolding
    ? [...workAllocationChangeIssues(previousHolding, holding, targetMap, text(replacedPersonId)),
      ...newLaborIssues(validateHoldingWorkAllocations(previousHolding).issues, issues)]
    : issues;
  return { ok: blockingIssues.length === 0, targets, targetMap, plans, issues: blockingIssues };
}

export function plannedAssignmentQd(assignments = [], sourceId = "", functionId = "") {
  const source = text(sourceId);
  const fn = text(functionId);
  return (Array.isArray(assignments) ? assignments : []).reduce((sum, row) => {
    if (text(row?.sourceId) !== source || text(row?.functionId) !== fn) return sum;
    return sum + whole(row?.normalQd ?? row?.qd) + whole(row?.overtimeQd);
  }, 0);
}

export function buildPlannedWorkSlots(assignments = [], periodQd = 40, { normalQdPerDay = 2, overtimeQdPerDay = 1 } = {}) {
  const elapsed = whole(periodQd);
  const normalDaily = Math.max(0, Math.min(2, whole(normalQdPerDay, 2)));
  const overtimeDaily = normalDaily >= 2 ? Math.max(0, Math.min(1, whole(overtimeQdPerDay, 1))) : 0;
  const normalSteps = [];
  const overtimeSteps = [];
  for (let step = 0; step < elapsed; step += 1) {
    const withinDay = step % 4;
    if (withinDay < normalDaily) normalSteps.push(step);
    else if (withinDay < normalDaily + overtimeDaily) overtimeSteps.push(step);
  }
  const normalQueue = [];
  const overtimeQueue = [];
  for (const raw of Array.isArray(assignments) ? assignments : []) {
    const row = normalizeWorkAllocation(raw);
    const base = { sourceId: row.sourceId, functionId: row.functionId };
    for (let index = 0; index < row.normalQd; index += 1) normalQueue.push({ ...base, overtime: false });
    for (let index = 0; index < row.overtimeQd; index += 1) overtimeQueue.push({ ...base, overtime: true });
  }
  const slots = new Map();
  const queued = normalQueue.slice(0, normalSteps.length);
  if (queued.some((row) => row.functionId === "livestock")) {
    // Daily care must not be packed into the first five days of a tenday.
    // Spread each herd's paid QD over the days; other work fills remaining slots.
    const takeFirstFree = () => normalSteps.find((step) => !slots.has(step));
    const herds = new Map();
    for (const row of queued.filter((row) => row.functionId === "livestock")) {
      if (!herds.has(row.sourceId)) herds.set(row.sourceId, []);
      herds.get(row.sourceId).push(row);
    }
    for (const rows of herds.values()) {
      while (rows.length) {
        for (let day = 0; day * 4 < elapsed && rows.length; day += 1) {
          const step = normalSteps.find((value) => Math.floor(value / 4) === day && !slots.has(value));
          if (step !== undefined) slots.set(step, rows.shift());
        }
      }
    }
    for (const row of queued.filter((row) => row.functionId !== "livestock")) slots.set(takeFirstFree(), row);
  } else queued.forEach((row, index) => slots.set(normalSteps[index], row));
  overtimeQueue.slice(0, overtimeSteps.length).forEach((row, index) => slots.set(overtimeSteps[index], row));
  return slots;
}
