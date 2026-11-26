import { buildingOperationalState } from "../../core/building-state.js";
import { allocationTotalQd, buildWorkAllocationTargets, functionDailyRate, workAllocationTargetKey, workAllocationTotals, workFunctionMatches } from "../../data/work-allocations.js";
import { buildingAcceptsWorkers, buildingMinOperationalQd, reservedOccupation, residentLaborUnavailableReason } from "../../data/labor-model.js";
import { isMedicalBuilding } from "../../core/building-specials.js";
import { laborWageRate } from "./labor-wage-rate.js";
import { DEFAULT_NORMAL_LABOR_QD, normalLaborQdPerTenday, residentLaborCapacity } from "../../data/labor-budget.js";
import { financeBuildingFunctionBlockState, financeWorkerBlockState } from "./finance-obligations.js";
import { buildingCompositionStatus, workerAdmission } from "../workers/building-qualification.js";

function text(value = "") {
  return String(value ?? "").trim();
}

function whole(value, fallback = 0) {
  const number = Number(value);
  return Math.max(0, Math.floor(Number.isFinite(number) ? number : fallback));
}

function signedRound(value = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || !numeric) return 0;
  return Math.sign(numeric) * Math.round(Math.abs(numeric));
}

function completedTendayIndex(holding = {}) {
  return Math.max(0, Math.floor(whole(holding?.gm?.calendaria?.lastQd) / 40));
}

function traceLastTendayIndex(periodKey = "") {
  const match = /^tenday:(\d+)(?:-(\d+))?$/.exec(text(periodKey));
  if (!match) return 0;
  return whole(match[2] ?? match[1]);
}

function traceFunctionQd(serviceState = {}, functionId = "") {
  const entries = Object.entries(serviceState?.workedQdByFunction ?? {});
  if (!functionId) {
    const hasLines = entries.some(([id]) => id.startsWith("production:"));
    const unique = entries.filter(([id]) => !(hasLines && id === "production"));
    return entries.length ? unique.reduce((sum, [, qd]) => sum + whole(qd), 0) : whole(serviceState.workedQd);
  }
  const exact = entries.find(([recordedFunction]) => text(recordedFunction) === text(functionId));
  if (exact) return whole(exact[1]);
  const matched = entries.filter(([recordedFunction]) => workFunctionMatches(recordedFunction, functionId));
  if (matched.length) return matched.reduce((sum, [, qd]) => sum + whole(qd), 0);
  // Never lend another function's work to this service. Old unscoped traces
  // only prove the one function they explicitly identify.
  return !functionId || workFunctionMatches(serviceState?.functionId, functionId)
    ? whole(serviceState?.workedQd) : 0;
}

function traceFunctionWorkerIds(serviceState = {}, functionId = "") {
  const rows = serviceState?.activeWorkerIdsByFunction;
  if (rows && typeof rows === "object") {
    const matched = Object.entries(rows)
      .filter(([recordedFunction]) => workFunctionMatches(recordedFunction, functionId))
      .flatMap(([, ids]) => Array.isArray(ids) ? ids : []);
    return [...new Set(matched.map(text).filter(Boolean))];
  }
  return !functionId || workFunctionMatches(serviceState?.functionId, functionId)
    ? [...new Set((serviceState?.activeWorkerIds ?? []).map(text).filter(Boolean))] : [];
}

export function buildingServiceFunctionId(building = {}) {
  const functions = building?.functions ?? {};
  if (isMedicalBuilding(building)) return "medical";
  if (functions.culture === true
    && ["inn", "tavern"].includes(text(building.templateId || building.id))) return "culture";
  if (building?.activation?.anyWorkingFunction === true) return "";
  if (building?.activation?.requiresMeaningfulResult === true && functions.production === true) return "production";
  if (functions.culture === true) return "culture";
  if (functions.income === true) return "income";
  if (functions.defense === true) return "defense";
  if (functions.production === true) return "production";
  if (functions.storage === true) return "storage";
  if (functions.housing === true) return "housing";
  return "culture";
}

/** Housing remains usable without a caretaker; only the funded service improves comfort. */
export function buildingHousingComfort(holding = {}, building = {}) {
  const base = Number(building.housing?.comfort) || 0;
  const staffed = building.housing?.staffedComfort;
  if (!buildingAcceptsWorkers(building) || !Number.isFinite(staffed)) return base;
  const status = buildingConfirmedSocialStatus(holding, building, "housing");
  return status.active && status.laborFactor >= 1 ? staffed : base;
}

function prerequisiteAvailable(holding, id, mode, visited = new Set()) {
  return (holding?.buildings?.list ?? []).some((candidate) => {
    if (![text(candidate?.id), text(candidate?.templateId)].includes(id)) return false;
    if (!buildingOperationalState(candidate).operational) return false;
    return !["construction", "service"].includes(mode) || buildingServiceBlockReasons(holding, candidate, "", visited).active;
  });
}

export function buildingConstructionPrerequisitesMet(holding = {}, building = {}) {
  const modes = building?.prerequisiteModes ?? {};
  const all = (building?.requiredBuildingIds ?? []).map(text).filter(Boolean);
  const any = (building?.requiredAnyBuildingIds ?? []).map(text).filter(Boolean);
  const allMet = all.filter((id) => modes[id]).every((id) => prerequisiteAvailable(holding, id, modes[id]));
  const anyMet = !any.some((id) => modes[id]) || any.some((id) => prerequisiteAvailable(holding, id, modes[id]));
  return allMet && anyMet;
}

function dependencyState(holding = {}, building = {}, visited = new Set(), functionId = "") {
  const activeIds = new Set((holding?.buildings?.list ?? [])
    .filter((row) => buildingOperationalState(row).operational)
    .flatMap((row) => [text(row?.templateId), text(row?.id)])
    .filter(Boolean));
  const modes = building?.prerequisiteModes ?? {};
  const applies = (id) => modes[id] !== "construction" && (modes[id] !== "service" || functionId === buildingServiceFunctionId(building));
  const required = (building?.requiredBuildingIds ?? []).map(text).filter((id) => id && applies(id));
  const requiredAny = (building?.requiredAnyBuildingIds ?? []).map(text).filter((id) => id && applies(id));
  const met = (id) => modes[id] === "service" ? prerequisiteAvailable(holding, id, "service", visited) : activeIds.has(id);
  const missing = required.filter((id) => !met(id));
  const missingAny = requiredAny.length > 0 && !requiredAny.some(met);
  if (building?.requiresConstructionCenter === true && !activeIds.has("construction-center")) missing.push("construction-center");
  return { met: missing.length === 0 && !missingAny, missing: [...new Set(missing)], requiredAny, missingAny };
}

function hasActiveServiceContract(building = {}) {
  return buildingAcceptsWorkers(building) && Boolean(building.service || isMedicalBuilding(building)
    || buildingMinOperationalQd(building) || building.activation?.requiresMeaningfulResult
    || (building.functions?.housing && building.housing?.staffedComfort > building.housing?.comfort)
    || building.storage?.profileRequiresStaff);
}

export function buildingActiveWorkerSummary(holding = {}, building = {}, functionId = "") {
  const buildingId = text(building.id);
  const targets = new Map(buildWorkAllocationTargets({ buildings: { list: [building] } }).map((row) => [row.key, row]));
  const summary = { workers: [], count: 0, qd: 0, equivalentWorkers: 0, blocked: [] };
  const budget = normalLaborQdPerTenday(holding);
  for (const person of holding.people?.list ?? []) {
    const rows = (person.workAllocations ?? []).filter((row) => text(row.sourceId) === buildingId
      && workFunctionMatches(row.functionId, functionId) && allocationTotalQd(row) > 0);
    if (!rows.length) continue;
    const totals = workAllocationTotals(person.workAllocations);
    const limits = residentLaborCapacity(person, budget);
    const admission = workerAdmission(building, person);
    const unavailable = residentLaborUnavailableReason(holding, person) || reservedOccupation(holding, person)?.label
      || (totals.normalQd > limits.normalQd || totals.overtimeQd > Math.min(limits.overtimeQd, Math.floor(totals.normalQd / 2)) ? "превышен личный бюджет QD" : "")
      || (admission.hard && !admission.eligible && !admission.overridden ? "не выполнен допуск к работе" : "")
      || (financeWorkerBlockState({ finance: holding?.finance, workerId: text(person.id) }).blocked ? "долг по оплате труда" : "");
    if (unavailable) { summary.blocked.push({ code: "worker-unavailable", text: unavailable }); continue; }
    let qd = 0;
    for (const row of rows) {
      const target = targets.get(workAllocationTargetKey(buildingId, row.functionId));
      const wage = laborWageRate({ dailyRateCopper: functionDailyRate(building, row.functionId),
        wageOverrideCopper: person.wageDailyOverrideCopper, volunteer: person.volunteerLabor === true || row.volunteer === true });
      if (!wage.ok) { summary.blocked.push({ code: "work-target-unpaid", text: "для работы нужна ставка или добровольный труд" }); continue; }
      if (!target?.available || row.overtimeQd > 0 && !target.overtimeAllowed
        || financeBuildingFunctionBlockState({ finance: holding.finance, buildingId, functionId: row.functionId }).blocked) continue;
      qd += allocationTotalQd(row);
    }
    if (!qd) continue;
    summary.workers.push(person);
    summary.qd += qd;
    summary.equivalentWorkers += qd / DEFAULT_NORMAL_LABOR_QD;
  }
  summary.count = summary.workers.length;
  return summary;
}

/**
 * Returns a positive social effect status backed by the latest completed
 * tenday. Assignments alone are a forecast and never confirm morale or
 * reputation. Recorded workers must still be available and assigned to the
 * same building function, preventing a stale trace from surviving a shutdown
 * or a later reassignment.
 */
export function buildingConfirmedSocialStatus(holding = {}, building = {}, functionIdArg = "") {
  const functionId = text(functionIdArg) || buildingServiceFunctionId(building);
  const base = buildingServiceBlockReasons(holding, building, functionId);
  if (!hasActiveServiceContract(building)) return { ...base, periodKey: text(building?.serviceState?.periodKey) };
  const reasons = base.reasons.filter((reason) => !["workers-missing", "qd-missing", "result-missing", "service-stopped", "composition-missing"].includes(reason.code));
  const state = building?.serviceState ?? {};
  const completedIndex = completedTendayIndex(holding);
  const traceIndex = traceLastTendayIndex(state?.periodKey);
  if (completedIndex <= 0 || traceIndex !== completedIndex) {
    reasons.push({ code: "activity-unconfirmed", text: "нет подтверждённой работы за последний завершённый десятник" });
  }

  const people = new Map(buildingActiveWorkerSummary(holding, building, functionId).workers.map((person) => [text(person.id), person]));
  const recordedIds = traceFunctionWorkerIds(state, functionId);
  const workers = recordedIds.map((id) => people.get(id)).filter(Boolean);
  const workerQd = state?.workedQdByWorkerAndFunction;
  const qd = workerQd && typeof workerQd === "object"
    ? workers.reduce((sum, person) => sum + traceFunctionQd({ workedQdByFunction: workerQd[text(person.id)] }, functionId), 0)
    : workers.length === recordedIds.length ? traceFunctionQd(state, functionId) : 0;
  const minOperationalQd = buildingMinOperationalQd(building);
  if (qd < Math.max(1, minOperationalQd)) {
    reasons.push({ code: "qd-missing", text: `нужно фактических QD: ${Math.max(1, minOperationalQd)}, подтверждено: ${qd}` });
  }
  if (!buildingCompositionStatus(building, workers, { excludeGroups: ["ЧУДОТВОРЕЦ"] }).met) {
    reasons.push({ code: "composition-missing", text: "не выполнено обязательное условие состава работников" });
  }

  const meaningfulByFunction = state?.meaningfulResultByFunction;
  const meaningfulResult = meaningfulByFunction && typeof meaningfulByFunction === "object"
    ? Object.entries(meaningfulByFunction).some(([recordedFunction, value]) => workFunctionMatches(recordedFunction, functionId) && value === true)
    : state?.meaningfulResult === true;
  if (building?.activation?.requiresMeaningfulResult === true && functionId === "production" && !meaningfulResult) {
    reasons.push({ code: "result-missing", text: "за период нет содержательного результата функции" });
  }
  const uniqueReasons = [...new Map(reasons.map((reason) => [`${reason.code}:${reason.text}`, reason])).values()];
  return {
    active: uniqueReasons.length === 0,
    reasons: uniqueReasons,
    functionId,
    workforce: { workers, count: workers.length, qd, equivalentWorkers: qd / DEFAULT_NORMAL_LABOR_QD },
    laborFactor: uniqueReasons.length === 0 ? 1 : 0,
    periodKey: text(state?.periodKey)
  };
}

/** A harmful staffed function follows actual work, not positive-service finance gates. */
export function buildingConfirmedHarmActive(holding = {}, building = {}, functionIdArg = "") {
  if (!buildingOperationalState(building).operational) return false;
  if (building?.activation?.harmWhileOperational === true) return true;
  if (!hasActiveServiceContract(building)) return true;
  const completedIndex = completedTendayIndex(holding);
  if (completedIndex <= 0 || traceLastTendayIndex(building?.serviceState?.periodKey) !== completedIndex) return false;
  const functionId = text(functionIdArg) || buildingServiceFunctionId(building);
  return traceFunctionQd(building?.serviceState, functionId) > 0;
}

export function buildingServiceBlockReasons(holding = {}, building = {}, functionIdArg = "", visited = new Set()) {
  if (visited.has(building)) return { active: false, reasons: [{ code: "dependency-cycle", text: "циклическая зависимость услуг" }] };
  const nextVisited = new Set(visited).add(building);
  const reasons = [];
  const activeServiceContract = hasActiveServiceContract(building);
  if (!buildingOperationalState(building).operational) reasons.push({ code: "not-operational", text: "здание строится, повреждено или законсервировано" });
  const functionId = text(functionIdArg) || buildingServiceFunctionId(building);
  const financeBlock = financeBuildingFunctionBlockState({ finance: holding?.finance, buildingId: text(building?.id), functionId });
  if (financeBlock.blocked) reasons.push({ code: "finance-blocked", text: "функция остановлена неоплаченными обязательствами" });
  // serviceState is an execution trace, not a universal on/off switch. Old
  // saves can contain a stopped trace on passive monuments; only buildings
  // with an actual staffed/service activation contract may be blocked by it.
  if (activeServiceContract
    && building?.serviceState?.functionId === functionId
    && building?.serviceState?.fuelBlocked === true) {
    reasons.push({ code: "service-stopped", text: text(building?.serviceState?.reason) || "функция остановлена" });
  }
  const dependencies = dependencyState(holding, building, nextVisited, functionId);
  if (!dependencies.met) reasons.push({
    code: "dependency-missing",
    text: dependencies.missingAny
      ? `не работает ни одна альтернативная зависимость: ${dependencies.requiredAny.join(", ")}`
      : `не работают зависимости: ${dependencies.missing.join(", ")}`
  });
  const workforce = buildingActiveWorkerSummary(holding, building, functionId);
  const minOperationalQd = hasActiveServiceContract(building) ? Math.max(1, buildingMinOperationalQd(building)) : 0;
  if (workforce.qd < minOperationalQd) {
    reasons.push({ code: "qd-missing", text: `нужно QD: ${minOperationalQd}, выделено: ${workforce.qd}` });
    reasons.push(...new Map(workforce.blocked.map((row) => [row.code + row.text, row])).values());
  }
  if (buildingAcceptsWorkers(building) && !buildingCompositionStatus(building, workforce.workers, { excludeGroups: ["ЧУДОТВОРЕЦ"] }).met) {
    reasons.push({ code: "composition-missing", text: "не выполнено обязательное условие состава работников" });
  }
  const active = reasons.length === 0;
  return { reasons, workforce, functionId, laborFactor: active ? 1 : 0, active };
}

/**
 * Returns the current factor for an active settlement service.
 * Passive monuments and unstaffed structural effects stay at full strength;
 * staffed services require an operational building and paid staff.
 */
export function buildingServiceEffectFactor(holding = {}, building = {}, functionIdArg = "") {
  const status = buildingServiceBlockReasons(holding, building, functionIdArg);
  return status.active ? status.laborFactor : 0;
}

export function buildingServiceCapacity(holding = {}, building = {}, functionIdArg = "") {
  const service = building?.service;
  const status = buildingServiceBlockReasons(holding, building, functionIdArg);
  if (!service || !status.active) return 0;
  const functionId = text(functionIdArg) || buildingServiceFunctionId(building);
  const workforce = buildingActiveWorkerSummary(holding, building, functionId);
  return serviceCapacityForWorkforce(service, building, workforce, status.laborFactor);
}

function serviceCapacityForWorkforce(service = {}, building = {}, workforce = {}, laborFactor = 1) {
  const workers = Number(workforce.equivalentWorkers ?? 0);
  let capacity = whole(service.capacity) * laborFactor;
  if (whole(service.capacityBase) || whole(service.capacityPerWorker)) {
    capacity = whole(service.capacityBase) * laborFactor + workers * whole(service.capacityPerWorker);
  }
  if (whole(service.capacityPerWorkerStep)) {
    const minWorkers = buildingMinOperationalQd(building) / DEFAULT_NORMAL_LABOR_QD;
    const extraWorkers = Math.max(0, workers - minWorkers);
    capacity = whole(service.capacityBase) * laborFactor + Math.floor(extraWorkers / Math.max(1, whole(service.workerStep, 1))) * whole(service.capacityPerWorkerStep);
  }
  const maximum = whole(service.maximumCapacity);
  if (maximum > 0) capacity = Math.min(capacity, maximum);
  // An incomplete service slot covers nobody.
  return Math.max(0, Math.floor(capacity));
}

export function buildingConfirmedServiceCapacity(holding = {}, building = {}, functionIdArg = "") {
  const service = building?.service;
  if (!service) return 0;
  const status = buildingConfirmedSocialStatus(holding, building, functionIdArg);
  if (!status.active) return 0;
  return serviceCapacityForWorkforce(service, building, status.workforce, status.laborFactor ?? 1);
}

export function buildingConfirmedLeisureCapacity(holding = {}, building = {}) {
  const leisure = building?.service?.leisure;
  if (!leisure || !text(leisure.kind)) return 0;
  const functionId = text(leisure.functionId) || "culture";
  const status = buildingConfirmedSocialStatus(holding, building, functionId);
  if (!status.active) return 0;
  const nominalCapacity = whole(leisure.capacity);
  const qdPerCapacity = Math.max(0.01, Number(leisure.qdPerCapacity) || 1);
  const laborCapacity = Math.floor(status.workforce.qd / qdPerCapacity);
  return Math.max(0, Math.min(nominalCapacity, laborCapacity));
}

export function buildingNominalMorale(building = {}) {
  const leisure = building?.service?.leisure;
  if (leisure && text(leisure.kind)) return whole(leisure.capacity);
  const value = Number(building?.moraleDelta);
  return Number.isFinite(value) ? value : 0;
}

export function buildingWonderworkingActive(holding = {}, building = {}) {
  const profile = building?.workerProfile;
  if (!(profile?.composition ?? []).some((row) => String(row?.group ?? "").toUpperCase() === "ЧУДОТВОРЕЦ")) return false;
  const functionId = buildingServiceFunctionId(building);
  if (buildingServiceEffectFactor(holding, building, functionId) <= 0) return false;
  return buildingCompositionStatus(building, buildingActiveWorkerSummary(holding, building, functionId).workers).met;
}

export function scaleIntegerBuildingEffect(value, factor = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || !numeric) return 0;
  const activeFactor = Math.max(0, Math.min(1, Number(factor) || 0));
  if (activeFactor <= 0) return 0;
  // An active building applies the full penalty.
  if (numeric < 0) return signedRound(numeric);
  return signedRound(numeric * activeFactor);
}
