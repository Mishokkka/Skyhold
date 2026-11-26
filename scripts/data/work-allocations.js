import { buildingOperationalState } from "../core/building-state.js";
import { isMedicalBuilding } from "../core/building-specials.js";
import { normalizeAgricultureBuilding } from "./agriculture.js";
import { normalizeLivestockBuilding } from "./livestock.js";
import { isPlainObject, makeId, toNumber } from "./utils.js";
import { isResidentPresent } from "./resident-presence.js";
import { DEFAULT_NORMAL_LABOR_QD, holdingNormalLaborQd, residentLaborCapacity, WORKING_DAYS_PER_TENDAY } from "./labor-budget.js";
import { allocationFunctionId, allocationSourceId, allocationTotalQd, residentActiveQd } from "./labor-primitives.js";
import { buildingAcceptsWorkers, buildingCapacityQd, newLaborIssues, buildingWorkReservations, reservedOccupation, residentLaborUnavailableReason } from "./labor-model.js";
import { laborWageRate } from "../engines/economy/labor-wage-rate.js";
import { buildingCompositionStatus, workerAdmission } from "../engines/workers/building-qualification.js";

export { allocationNormalQd, allocationTotalQd, parseWorkAllocationTargetKey } from "./labor-primitives.js";

export const WORK_ALLOCATION_SCHEMA_VERSION = 1;
export const WORK_ALLOCATION_NORMAL_QD_PER_TENDAY = DEFAULT_NORMAL_LABOR_QD;
export const WORK_ALLOCATION_OVERTIME_QD_PER_TENDAY = Math.floor(DEFAULT_NORMAL_LABOR_QD / 2);
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

export function normalizeWorkAllocation(value = {}, index = 0) {
  const source = isPlainObject(value) ? value : {};
  const sourceId = allocationSourceId(source);
  const functionId = allocationFunctionId(source);
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
  maximumNormalQd = DEFAULT_NORMAL_LABOR_QD,
  maximumOvertimeQd = Math.floor(maximumNormalQd / 2)
} = {}) {
  const source = Array.isArray(rows) ? rows : [];
  const targetMap = targets instanceof Map
    ? targets
    : (Array.isArray(targets) ? new Map(targets.map((target) => [target.key, target])) : null);
  const issues = [];
  const normalized = source.map((row, index) => normalizeWorkAllocation(row, index));
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
      issues.push({ code: "allocation-overtime", allocationId: row.id, targetKey: key, actual: row.overtimeQd, limit: 0,
        message: "Эта функция не разрешает переработку." });
    }
  }
  const totals = workAllocationTotals(normalized);
  const normalCap = whole(maximumNormalQd, WORK_ALLOCATION_NORMAL_QD_PER_TENDAY);
  const overtimeCap = whole(maximumOvertimeQd, WORK_ALLOCATION_OVERTIME_QD_PER_TENDAY);
  if (totals.normalQd > normalCap) issues.push({ code: "allocation-normal-cap", actual: totals.normalQd, limit: normalCap,
    message: `Обычный труд превышает ${normalCap} QD за период.` });
  if (totals.overtimeQd > overtimeCap) issues.push({ code: "allocation-overtime-cap", actual: totals.overtimeQd, limit: overtimeCap,
    message: `Переработка превышает ${overtimeCap} QD за период.` });
  const dailyOvertimeCap = Math.floor(totals.normalQd / 2);
  if (totals.overtimeQd > dailyOvertimeCap) {
    issues.push({ code: "allocation-overtime-days", actual: totals.overtimeQd, limit: dailyOvertimeCap,
      message: "Каждый overtime-QD требует в тот же период два обычных рабочих QD выбранного дня." });
  }
  return { ok: issues.length === 0, rows: normalized, totals, issues };
}

function productionFunctionId(line = {}, index = 0) {
  return `production:${text(line?.id) || `line-${index + 1}`}`;
}

function productionLine(building, functionId) {
  const lines = building?.productionLines;
  return Array.isArray(lines) ? lines.find((line, index) => productionFunctionId(line, index) === functionId) : undefined;
}

export function functionDailyRate(building, functionId) {
  const rate = ["agriculture", "income", "livestock"].includes(functionId) ? building?.[functionId]?.wageDailyCopper
    : productionLine(building, functionId)?.wageDailyCopper;
  return whole(rate) || whole(building?.wageDailyCopper);
}

export function targetAllowsOvertime(building, functionId, { allowMedicalOvertime = true } = {}) {
  if (functionId === "medical") return Boolean(building && isMedicalBuilding(building) && allowMedicalOvertime
    && building.medical?.overtimeAllowed !== false);
  return productionLine(building, functionId)?.overtime === true;
}

export function remainingCollectionQd(line) {
  return Math.max(0, Math.ceil(toNumber(line?.collectQd, 0)) - Math.floor(toNumber(line?.collectProgressQd, 0)));
}

function buildingHasIncomeFunction(building = {}) {
  if (Object.prototype.hasOwnProperty.call(building?.functions ?? {}, "income")) return building.functions.income === true;
  const income = building?.income ?? {};
  return Boolean(income.trade?.enabled || toNumber(income.base, 0) || toNumber(income.perWorker, 0) || text(income.formula));
}

function targetRow(building, functionId, label, {
  overtimeAllowed = false,
  dailyRateCopper = 0,
  kind = "building",
  mothballed = false
} = {}) {
  const sourceId = text(building?.id);
  const rate = whole(dailyRateCopper);
  const state = buildingOperationalState(building);
  return {
    key: workAllocationTargetKey(sourceId, functionId),
    sourceId,
    functionId,
    buildingId: sourceId,
    available: state.operational && !mothballed,
    blockedReason: mothballed ? "Здание законсервировано" : state.operational ? "" : state.label,
    functionName: label,
    label: `${text(building?.name) || "Здание"} · ${label} · ${rate > 0 ? `${rate} ММ/день` : "ставка не задана"}`,
    overtimeAllowed: bool(overtimeAllowed),
    dailyRateCopper: rate,
    kind
  };
}

export function buildWorkAllocationTargets(holding = {}, { allowMedicalOvertime = true, baseNormalQd } = {}) {
  const targets = [];
  for (const building of holding?.buildings?.list ?? []) {
    const state = buildingOperationalState(building);
    if (!text(building?.id) || !buildingAcceptsWorkers(building, { baseNormalQd })) continue;
    const mothballed = holding.finance?.buildingStates?.[building.id]?.mothballed === true;
    const medical = isMedicalBuilding(building);
    const productionEnabled = !medical && building?.functions?.production !== false;
    const agriculture = normalizeAgricultureBuilding(building?.agriculture, { building });
    const lines = productionEnabled && !agriculture && Array.isArray(building?.productionLines) ? building.productionLines : [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const collectionWork = line?.requiresCollection && whole(line?.collectQd) > 0;
      if (text(line?.source || "workers") !== "workers" && !collectionWork) continue;
      const functionId = productionFunctionId(line, index);
      const label = text(line?.mode || line?.resource || line?.resourceId) || `Линия ${index + 1}`;
      const target = targetRow(building, functionId, label, {
        overtimeAllowed: line?.overtime === true,
        mothballed,
        dailyRateCopper: whole(line?.wageDailyCopper) || whole(building?.wageDailyCopper),
        kind: "production"
      });
      const paused = line?.active === false;
      const collectionAvailable = state.operational && line?.requiresCollection === true && collectionWork && Number(line?.pendingQty) > 0;
      targets.push({ ...target, paused, collectionAvailable,
        available: target.available && (!paused || collectionAvailable) && (text(line?.source || "workers") === "workers" || collectionAvailable),
        blockedReason: target.blockedReason || (paused && !collectionAvailable ? "Линия приостановлена" : "") });
    }
    if (productionEnabled && agriculture?.enabled) {
      targets.push(targetRow(building, "agriculture", agriculture.kind === "field" ? "Полевые работы" : "Работы в саду", {
        mothballed,
        dailyRateCopper: whole(building?.wageDailyCopper),
        kind: "agriculture"
      }));
    }
    const livestock = normalizeLivestockBuilding(building?.livestock, { building });
    if (productionEnabled && livestock?.enabled) {
      targets.push(targetRow(building, "livestock", `Животноводство: ${livestock.profile.label}`, {
        mothballed,
        dailyRateCopper: whole(building?.wageDailyCopper),
        kind: "livestock"
      }));
    }
    if (!medical && buildingHasIncomeFunction(building)) {
      targets.push(targetRow(building, "income", "Доход и услуги", {
        mothballed,
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
        mothballed,
        dailyRateCopper: whole(building?.wageDailyCopper),
        overtimeAllowed: targetAllowsOvertime(building, functionId, { allowMedicalOvertime }),
        kind
      }));
    }
  }
  return targets;
}

export function buildingWorkAllocationsForBuilding(person = {}, buildingId = "") {
  const id = text(buildingId);
  if (!id || !isResidentPresent(person)) return [];
  return (Array.isArray(person?.workAllocations) ? person.workAllocations : []).filter((row) => (
    text(row?.sourceId) === id
    && whole(row?.normalQd) + whole(row?.overtimeQd) > 0
  ));
}

export function buildingWorkerIds(holding = {}, buildingId = "", functionId = "") {
  const id = text(buildingId?.id ?? buildingId);
  if (!id) return [];
  return (holding?.people?.list ?? [])
    .filter((person) => !person.dead && buildingWorkAllocationsForBuilding(person, id).some((row) => workFunctionMatches(row.functionId, functionId)))
    .map((person) => text(person?.id))
    .filter(Boolean);
}

export const buildingStaffingWorkerIds = buildingWorkerIds;
export const explicitWorkerIdsForBuilding = buildingWorkerIds;
export const explicitWorkAllocationsForBuilding = buildingWorkAllocationsForBuilding;

export function isProductionWorkFunction(functionId = "") {
  const id = text(functionId);
  return id === "production" || id.startsWith("production:") || id === "agriculture" || id === "livestock";
}

export function workFunctionScope(functionId = "") {
  const id = text(functionId);
  return isProductionWorkFunction(id) ? "production" : id;
}

export function workFunctionMatches(actual, expected) {
  const exp = text(expected);
  const act = text(actual);
  return !exp || act === exp || (exp === "production" && isProductionWorkFunction(act));
}

export function residentWorkUnavailable(holding, person) {
  return residentLaborUnavailableReason(holding, person) || reservedOccupation(holding, person)?.label || "";
}

function v2LaborState(holding, { strictWageCheck, baseNormalQd, workingDays, allowMedicalOvertime, useDaysOffBudget }, collectingWarnings) {
  const budget = useDaysOffBudget ? holdingNormalLaborQd(holding, { workingDays, baseNormalQd }) : baseNormalQd;
  const targets = buildWorkAllocationTargets(holding, { allowMedicalOvertime, baseNormalQd });
  const targetMap = new Map(targets.map((target) => [target.key, target]));
  const buildings = new Map((holding.buildings?.list ?? []).map((building) => [text(building.id), building]));
  const issues = [], warnings = [];
  const plans = new Map(), workers = new Map();
  for (const person of holding.people?.list ?? []) {
    const activeQd = residentActiveQd(person);
    if (!activeQd) continue;
    const personId = text(person.id), personName = text(person.name) || "Житель";
    const add = (issue) => issues.push({ ...issue, personId, personName });
    const unavailable = residentLaborUnavailableReason(holding, person);
    const occupation = reservedOccupation(holding, person);
    if (unavailable) add({ code: "resident-unavailable", evidence: unavailable, actual: activeQd, limit: 0, message: unavailable });
    else if (occupation) {
      add({ code: "reserved-occupation", evidence: occupation.kind, actual: activeQd, limit: 0,
        message: `${personName}: занятость «${occupation.label}» несовместима с планом QD.` });
    }
    const capacity = residentLaborCapacity(person, budget);
    const plan = validateWorkAllocationPlan(person.workAllocations, {
      targets: targetMap, maximumNormalQd: capacity.normalQd, maximumOvertimeQd: capacity.overtimeQd
    });
    plans.set(personId, plan);
    plan.issues.forEach(add);
    const override = person.wageDailyOverrideCopper;
    if (strictWageCheck && override != null && !(Number.isSafeInteger(override) && override > 0)) {
      add({ code: "invalid-wage-override", actual: activeQd, limit: 0, message: "Ставка жителя должна быть положительным целым числом или не задана." });
    }
    for (const row of plan.rows) {
      const actual = allocationTotalQd(row);
      if (!actual) continue;
      const buildingId = row.sourceId;
      const target = targetMap.get(workAllocationTargetKey(buildingId, row.functionId));
      const building = buildings.get(buildingId);
      const fields = { buildingId, functionId: row.functionId, actual, limit: 0 };
      if (!target) continue;
      if (!target.available) {
        add({ code: "work-target-unavailable", ...fields, message: target.blockedReason || "Выбранная работа сейчас недоступна." });
      }
      if (strictWageCheck) {
        const volunteer = person.volunteerLabor === true || row.volunteer === true;
        const dailyRateCopper = functionDailyRate(building, row.functionId);
        const wage = laborWageRate({ volunteer, wageOverrideCopper: override, dailyRateCopper });
        if (!wage.ok) {
          add({ code: "work-target-unpaid", ...fields, message: "Для выбранной работы нужна ставка или добровольный труд." });
        }
      }
      if (!building) continue;
      const admission = workerAdmission(building, person);
      if (admission.hard && !admission.eligible && !admission.overridden) {
        add({ code: "admission-denied", ...fields, message: `${personName}: не выполнен допуск к работе (${admission.text}).` });
      }
      if (!unavailable) {
        if (!workers.has(buildingId)) workers.set(buildingId, new Map());
        workers.get(buildingId).set(personId, person);
      }
    }
  }
  const reservations = buildingWorkReservations(holding);
  for (const [buildingId, building] of buildings) {
    const limit = buildingCapacityQd(building, { baseNormalQd });
    const actual = reservations.get(buildingId) ?? 0;
    const buildingName = text(building.name) || "Здание";
    if (limit !== null && actual > limit) {
      issues.push({ code: "allocation-capacity", buildingId, buildingName, actual, limit, message: `${buildingName}: план использует ${actual}/${limit} QD.` });
    }
    if (collectingWarnings && workers.has(buildingId)) {
      const composition = buildingCompositionStatus(building, [...workers.get(buildingId).values()], { excludeGroups: ["ЧУДОТВОРЕЦ"] });
      if (!composition.met) warnings.push({ code: "composition-unmet", buildingId, buildingName,
        message: `${buildingName}: не выполнен состав работников (${composition.text}).` });
    }
  }
  return { targets, targetMap, plans, issues, warnings };
}

export function validateHoldingWorkAllocations(holding = {}, options = {}) {
  const { previousHolding = null, replacedPersonId, strictWageCheck = true, baseNormalQd, workingDays, allowMedicalOvertime, useDaysOffBudget,
    checkedPersonIds = [], conserving = false } = options;
  const settings = { strictWageCheck, baseNormalQd: baseNormalQd ?? holdingNormalLaborQd(null, { workingDays }),
    workingDays, allowMedicalOvertime, useDaysOffBudget: useDaysOffBudget ?? true };
  const current = v2LaborState(holding, settings, true);
  let issues = current.issues;
  if (previousHolding) {
    const replaced = new Set((Array.isArray(replacedPersonId) ? replacedPersonId : [replacedPersonId]).map(text));
    const before = new Map((previousHolding.people?.list ?? []).map((person) => [text(person.id), person]));
    const changed = new Set((holding.people?.list ?? []).filter((person) => {
      const prior = before.get(text(person.id));
      return JSON.stringify(person.workAllocations ?? []) !== JSON.stringify(prior?.workAllocations ?? []);
    }).map((person) => text(person.id)));
    const checked = new Set([...checkedPersonIds.map(text), ...changed]);
    const previousIssues = v2LaborState(previousHolding, settings, false).issues;
    const canRetain = (issue) => {
      if (!checked.has(issue.personId) || conserving) return true;
      if (!["resident-unavailable", "work-target-unavailable"].includes(issue.code)) return false;
      const previous = new Map((before.get(issue.personId)?.workAllocations ?? []).map((row) => [workAllocationTargetKey(row.sourceId, row.functionId), row]));
      return (current.plans.get(issue.personId)?.rows ?? []).every((row) => {
        if (issue.buildingId && (row.sourceId !== issue.buildingId || row.functionId !== issue.functionId)) return true;
        const prior = previous.get(workAllocationTargetKey(row.sourceId, row.functionId));
        return row.normalQd <= whole(prior?.normalQd) && row.overtimeQd <= whole(prior?.overtimeQd);
      });
    };
    issues = newLaborIssues(previousIssues.filter(canRetain), issues);
    for (const personId of changed) {
      const prior = before.get(personId);
      const occupation = prior && reservedOccupation(previousHolding, prior);
      const currentPlan = current.plans.get(personId);
      const stillUnavailable = current.issues.some((issue) => issue.personId === personId
        && ["reserved-occupation", "resident-unavailable"].includes(issue.code));
      if (currentPlan && !conserving && !replaced.has(personId) && !stillUnavailable && occupation) {
        issues.push({ code: "reserved-occupation", personId, message: "Сначала освободите действующее назначение жителя." });
      }
    }
  }
  return { ...current, ok: issues.length === 0, issues };
}

export function allocatedBuildingQd(rows = [], sourceId = "", functionId = "") {
  return (rows ?? []).reduce((total, row) => {
    if (allocationSourceId(row) !== text(sourceId)) return total;
    return workFunctionMatches(allocationFunctionId(row), functionId) ? total + allocationTotalQd(row) : total;
  }, 0);
}

export function plannedAssignmentQd(assignments = [], sourceId = "", functionId = "") {
  const source = text(sourceId);
  const fn = text(functionId);
  return (Array.isArray(assignments) ? assignments : []).reduce((sum, row) => {
    if (text(row?.sourceId) !== source || text(row?.functionId) !== fn) return sum;
    return sum + whole(row?.normalQd) + whole(row?.overtimeQd);
  }, 0);
}

export function buildPlannedWorkSlots(assignments = [], periodQd = 40, { normalQdPerDay = 2, overtimeQdPerDay = 1, workingDays = WORKING_DAYS_PER_TENDAY } = {}) {
  const elapsed = whole(periodQd);
  const normalDaily = Math.max(0, Math.min(2, whole(normalQdPerDay, 2)));
  const overtimeDaily = normalDaily >= 2 ? Math.max(0, Math.min(1, whole(overtimeQdPerDay, 1))) : 0;
  const normalSteps = [];
  const overtimeSteps = [];
  for (let step = 0; step < elapsed; step += 1) {
    if (Math.floor(step / 4) % 10 >= workingDays) continue;
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
    // Spread each herd's paid QD over the days. Other work fills the remaining slots.
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
