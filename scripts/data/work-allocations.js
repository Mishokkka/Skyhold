import { buildingOperationalState } from "../core/building-state.js";
import { isMedicalBuilding } from "../core/building-specials.js";
import { normalizeAgricultureBuilding } from "./agriculture.js";
import { normalizeLivestockBuilding } from "./livestock.js";
import { isPlainObject, makeId, toNumber } from "./utils.js";
import { normalizeBuildingMaintenance, usesTechnicalMaintenance } from "./economy/maintenance.js";
import { isResidentPresent } from "./resident-presence.js";
import { normalLaborQdPerTenday, residentLaborCapacity } from "./labor-budget.js";
import { buildingLaborMode, staffAppointmentFor, staffWorkerIdsForBuilding, validateHybridLaborHolding, newHybridLaborIssues } from "./hybrid-labor.js";

export const WORK_ALLOCATION_SCHEMA_VERSION = 1;
export const WORK_ALLOCATION_MODE_LEGACY = "legacy";
export const WORK_ALLOCATION_MODE_EXPLICIT = "explicit";
export const WORK_ALLOCATION_NORMAL_QD_PER_TENDAY = 20;
export const WORK_ALLOCATION_OVERTIME_QD_PER_TENDAY = 10;
export const MAX_WORK_ALLOCATIONS_PER_PERSON = 24;
export const MAINTENANCE_WORK_SOURCE_ID = "maintenance";
export const MAINTENANCE_WORK_FUNCTION_ID = "maintenance";

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
  const mode = text(person?.workAllocationMode) === WORK_ALLOCATION_MODE_EXPLICIT
    ? WORK_ALLOCATION_MODE_EXPLICIT
    : WORK_ALLOCATION_MODE_LEGACY;
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
  person.workAllocationMode = mode;
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
  maximumNormalQd = normalLaborQdPerTenday(),
  maximumOvertimeQd = Math.floor(maximumNormalQd / 2)
} = {}) {
  const source = Array.isArray(rows) ? rows : [];
  const targetMap = targets instanceof Map
    ? targets
    : (Array.isArray(targets) ? new Map(targets.map((target) => [target.key, target])) : null);
  const issues = [];
  const normalized = source.slice(0, MAX_WORK_ALLOCATIONS_PER_PERSON).map((row, index) => normalizeWorkAllocation(row, index));
  if (source.length > MAX_WORK_ALLOCATIONS_PER_PERSON) {
    issues.push({ code: "allocation-count", message: `У одного работника допускается не более ${MAX_WORK_ALLOCATIONS_PER_PERSON} строк труда.` });
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
      issues.push({ code: "allocation-overtime", allocationId: row.id, targetKey: key, message: "Эта функция не разрешает переработку." });
    }
  }
  const totals = workAllocationTotals(normalized);
  const normalCap = whole(maximumNormalQd, WORK_ALLOCATION_NORMAL_QD_PER_TENDAY);
  const overtimeCap = whole(maximumOvertimeQd, WORK_ALLOCATION_OVERTIME_QD_PER_TENDAY);
  if (totals.normalQd > normalCap) issues.push({ code: "allocation-normal-cap", message: `Обычный труд превышает ${normalCap} QD за период.` });
  if (totals.overtimeQd > overtimeCap) issues.push({ code: "allocation-overtime-cap", message: `Переработка превышает ${overtimeCap} QD за период.` });
  if (totals.overtimeQd > Math.floor(totals.normalQd / 2)) {
    issues.push({ code: "allocation-overtime-days", message: "Каждый overtime-QD требует в тот же период два обычных рабочих QD выбранного дня." });
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
  return {
    key: workAllocationTargetKey(sourceId, functionId),
    sourceId,
    functionId,
    buildingId: sourceId,
    workersMax: buildingLaborMode(building) === "qd" ? 0 : whole(building?.workersMax),
    laborMode: buildingLaborMode(building),
    available: state.operational,
    blockedReason: state.operational ? "" : state.label,
    label: `${text(building?.name) || "Здание"} · ${label} · ${rate > 0 ? `${rate} ММ/день` : "ставка не задана"}`,
    overtimeAllowed: bool(overtimeAllowed),
    dailyRateCopper: rate,
    kind
  };
}

export function buildWorkAllocationTargets(holding = {}, { includeMaintenance = true } = {}) {
  const targets = [];
  for (const building of holding?.buildings?.list ?? []) {
    const state = buildingOperationalState(building);
    const hybrid = ["staff", "qd", "passive"].includes(buildingLaborMode(building));
    if (!text(building?.id) || !state.operational && !hybrid) continue;
    if (includeMaintenance && usesTechnicalMaintenance(building) && normalizeBuildingMaintenance(building.maintenance).requiredPoints > 0) {
      targets.push({ ...targetRow(building, MAINTENANCE_WORK_FUNCTION_ID, "Техобслуживание", { dailyRateCopper: 18, kind: "maintenance" }), workersMax: 0 });
    }
    if (["passive", "invalid"].includes(buildingLaborMode(building))) continue;
    const medical = isMedicalBuilding(building);
    const productionEnabled = !medical && building?.functions?.production !== false;
    const agriculture = normalizeAgricultureBuilding(building?.agriculture, { building });
    const lines = productionEnabled && !agriculture && Array.isArray(building?.productionLines) ? building.productionLines : [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line?.active === false && !hybrid || (text(line?.source || "workers") !== "workers" && !(line?.requiresCollection && whole(line?.collectQd) > 0))) continue;
      const functionId = productionFunctionId(line, index);
      const label = text(line?.mode || line?.resource || line?.resourceId) || `Линия ${index + 1}`;
      const target = targetRow(building, functionId, label, {
        overtimeAllowed: line?.overtime === true,
        dailyRateCopper: whole(line?.wageDailyCopper) || whole(building?.wageDailyCopper),
        kind: "production"
      });
      const paused = line?.active === false;
      const collectionAvailable = state.operational && line?.requiresCollection === true && whole(line?.collectQd) > 0 && Number(line?.pendingQty) > 0;
      targets.push({ ...target, paused, collectionAvailable,
        available: target.available && (!paused || collectionAvailable),
        blockedReason: target.blockedReason || (paused && !collectionAvailable ? "Линия приостановлена" : "") });
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
      [functions.housing && ["staff", "qd"].includes(buildingLaborMode(building)), "housing", "Уход за жильём", "housing"],
      [isMedicalBuilding(building), "medical", "Медицинская помощь", "medical"]
    ];
    for (const [enabled, functionId, label, kind] of staffedFunctions) {
      if (!enabled || (buildingLaborMode(building) === "legacy" && whole(building?.workersMax) <= 0)) continue;
      targets.push(targetRow(building, functionId, label, {
        dailyRateCopper: whole(building?.wageDailyCopper),
        kind
      }));
    }
  }
  if (includeMaintenance) {
    targets.push({
      key: workAllocationTargetKey(MAINTENANCE_WORK_SOURCE_ID, MAINTENANCE_WORK_FUNCTION_ID),
      sourceId: MAINTENANCE_WORK_SOURCE_ID,
      functionId: MAINTENANCE_WORK_FUNCTION_ID,
      buildingId: "",
      workersMax: 0,
      available: true,
      blockedReason: "",
      label: "Поселение · трудовое обслуживание",
      overtimeAllowed: false,
      dailyRateCopper: 0,
      kind: "maintenance"
    });
  }
  return targets;
}

export function explicitWorkAllocationsForBuilding(person = {}, buildingId = "") {
  const id = text(buildingId);
  if (!id || !isResidentPresent(person) || text(person?.workAllocationMode) !== WORK_ALLOCATION_MODE_EXPLICIT) return [];
  return (Array.isArray(person?.workAllocations) ? person.workAllocations : []).filter((row) => (
    text(row?.sourceId) === id
    && text(row?.functionId) !== MAINTENANCE_WORK_FUNCTION_ID
    && whole(row?.normalQd) + whole(row?.overtimeQd) > 0
  ));
}

export function explicitWorkerIdsForBuilding(holding = {}, buildingId = "") {
  const id = text(buildingId);
  if (!id) return [];
  return (holding?.people?.list ?? [])
    .filter((person) => explicitWorkAllocationsForBuilding(person, id).length > 0)
    .map((person) => text(person?.id))
    .filter(Boolean);
}

/**
 * Return the distinct heads occupying a building's staffing capacity.
 *
 * Explicit QD plans supersede legacy slots. A resident split between several
 * functions of one building occupies one place there; a resident split between
 * several buildings occupies one place in every affected building.
 */
export function buildingStaffingWorkerIds(holding = {}, buildingId = "") {
  const id = text(buildingId);
  const building = (holding?.buildings?.list ?? []).find((row) => text(row?.id) === id);
  if (!id || !building) return [];
  const mode = buildingLaborMode(building);
  if (mode === "staff") return staffWorkerIdsForBuilding(holding, id);
  if (mode === "qd") return explicitWorkerIdsForBuilding(holding, id);
  if (mode === "passive" || mode === "invalid") return [];
  const explicitPersonIds = new Set((holding?.people?.list ?? [])
    .filter((person) => isResidentPresent(person) && text(person?.workAllocationMode) === WORK_ALLOCATION_MODE_EXPLICIT)
    .map((person) => text(person?.id))
    .filter(Boolean));
  const ids = new Set((building?.assignedWorkerIds ?? [])
    .map((workerId) => text(workerId))
    .filter((workerId) => workerId && !explicitPersonIds.has(workerId))
    .filter((workerId) => isResidentPresent((holding?.people?.list ?? []).find((person) => text(person?.id) === workerId))));
  for (const workerId of explicitWorkerIdsForBuilding(holding, id)) ids.add(workerId);
  return [...ids];
}

export function validateHoldingWorkAllocations(holding = {}, { previousHolding = null } = {}) {
  const targets = buildWorkAllocationTargets(holding);
  const targetMap = new Map(targets.map((target) => [target.key, target]));
  const issues = [];
  const plans = new Map();
  for (const person of holding?.people?.list ?? []) {
    if (!isResidentPresent(person)) continue;
    if (text(person?.workAllocationMode) !== WORK_ALLOCATION_MODE_EXPLICIT) continue;
    if (staffAppointmentFor(person)) continue;
    const personId = text(person?.id);
    const capacity = residentLaborCapacity(person);
    const validation = validateWorkAllocationPlan(person?.workAllocations, {
      targets: targetMap, maximumNormalQd: capacity.normalQd, maximumOvertimeQd: capacity.overtimeQd
    });
    plans.set(personId, validation);
    for (const issue of validation.issues) issues.push({ ...issue, personId, personName: text(person?.name) || "Житель" });
    const specialAssignment = text(person?.workAssignment);
    if (["soldier", "defenseCommander", "construction"].includes(specialAssignment)
      || specialAssignment.startsWith("construction:")
      || specialAssignment.startsWith("construction-leader:")) {
      issues.push({ code: "allocation-incompatible", personId, personName: text(person?.name) || "Житель", message: "Явный план QD несовместим с военным или строительным назначением." });
    }
  }

  for (const building of holding?.buildings?.list ?? []) {
    if (buildingLaborMode(building) !== "legacy") continue;
    const buildingId = text(building?.id);
    const workersMax = whole(building?.workersMax);
    const assigned = buildingStaffingWorkerIds(holding, buildingId).length;
    if (workersMax >= 0 && assigned > workersMax) {
      issues.push({ code: "allocation-capacity", buildingId, buildingName: text(building?.name) || "Здание", message: `${text(building?.name) || "Здание"}: план использует ${assigned}/${workersMax} рабочих мест.` });
    }
  }
  const hybridIssues = validateHybridLaborHolding(holding, { targets: targetMap }).issues;
  issues.push(...(previousHolding ? newHybridLaborIssues(
    validateHybridLaborHolding(previousHolding, { targets: buildWorkAllocationTargets(previousHolding) }).issues, hybridIssues
  ) : hybridIssues));
  return { ok: issues.length === 0, targets, targetMap, plans, issues };
}

export function plannedAssignmentQd(assignments = [], sourceId = "", functionId = "") {
  const source = text(sourceId);
  const fn = text(functionId);
  return (Array.isArray(assignments) ? assignments : []).reduce((sum, row) => {
    if (text(row?.sourceId) !== source || text(row?.functionId) !== fn) return sum;
    return sum + whole(row?.normalQd) + whole(row?.overtimeQd);
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
    // Keep maintenance first, then spread each herd's paid QD over the days;
    // other work fills the remaining slots without creating extra labor.
    const takeFirstFree = () => normalSteps.find((step) => !slots.has(step));
    for (const row of queued.filter((row) => row.functionId === MAINTENANCE_WORK_FUNCTION_ID)) slots.set(takeFirstFree(), row);
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
    for (const row of queued.filter((row) => !["livestock", MAINTENANCE_WORK_FUNCTION_ID].includes(row.functionId))) slots.set(takeFirstFree(), row);
  } else queued.forEach((row, index) => slots.set(normalSteps[index], row));
  overtimeQueue.slice(0, overtimeSteps.length).forEach((row, index) => slots.set(overtimeSteps[index], row));
  return slots;
}
