import { buildingOperationalState } from "../../core/building-state.js";
import { maintenanceEfficiencyFactor } from "../../data/economy/maintenance.js";
import { WORK_ALLOCATION_MODE_EXPLICIT } from "../../data/work-allocations.js";
import { isResidentPresent } from "../../data/resident-presence.js";
import { residentLaborCapacity } from "../../data/labor-budget.js";
import { financeBuildingFunctionBlockState, financeWorkerBlockState } from "./finance-obligations.js";
import { buildingCompositionStatus } from "../workers/building-qualification.js";
import { buildingLaborMode, staffAppointmentWorkFunctions } from "../../data/hybrid-labor.js";

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

function functionMatches(actual = "", expected = "") {
  const actualId = text(actual);
  const expectedId = text(expected);
  if (!expectedId) return actualId !== "maintenance";
  if (actualId === expectedId) return true;
  return expectedId === "production" && actualId.startsWith("production:");
}

function completedTendayIndex(holding = {}) {
  return Math.max(0, Math.floor(whole(holding?.gm?.calendaria?.lastQd) / 40));
}

function traceLastTendayIndex(periodKey = "") {
  const match = /^tenday:(\d+)(?:-(\d+))?$/.exec(text(periodKey));
  if (!match) return 0;
  return whole(match[2] ?? match[1]);
}

function currentAssignmentMatches(person = {}, building = {}, functionId = "") {
  const buildingId = text(building?.id);
  const workerId = text(person?.id);
  if (!buildingId || !workerId) return false;
  if (person.staffAppointment) return text(person.staffAppointment.buildingId) === buildingId
    && staffAppointmentWorkFunctions(person).some((id) => functionMatches(id, functionId));
  if (text(person?.workAllocationMode) === WORK_ALLOCATION_MODE_EXPLICIT) {
    return (person?.workAllocations ?? []).some((allocation) => (
      text(allocation?.sourceId) === buildingId
      && functionMatches(allocation?.functionId, functionId)
      && (building?.activation?.anyWorkingFunction !== true || enabledFunction(building, allocation?.functionId))
      && whole(allocation?.normalQd) + whole(allocation?.overtimeQd) > 0
    ));
  }
  if (building?.activation?.anyWorkingFunction === true
    && !Object.keys(building.functions ?? {}).some((id) => enabledFunction(building, id))) return false;
  if ((building?.assignedWorkerIds ?? []).map(text).includes(workerId)) return true;
  return [buildingId, text(building?.name)].filter(Boolean).includes(text(person?.workAssignment));
}

function enabledFunction(building, functionId = "") {
  const [kind, lineId] = text(functionId).split(":");
  if (kind === "maintenance" || building.functions?.[kind] !== true) return false;
  return kind !== "production" || (building.productionLines ?? []).some((line) => line.active !== false && (!lineId || line.id === lineId));
}

function traceFunctionQd(serviceState = {}, functionId = "") {
  const entries = Object.entries(serviceState?.workedQdByFunction ?? {});
  if (!functionId) {
    const hasLines = entries.some(([id]) => id.startsWith("production:"));
    const unique = entries.filter(([id]) => id !== "maintenance" && !(hasLines && id === "production"));
    return entries.length ? unique.reduce((sum, [, qd]) => sum + whole(qd), 0) : whole(serviceState.workedQd);
  }
  const exact = entries.find(([recordedFunction]) => text(recordedFunction) === text(functionId));
  if (exact) return whole(exact[1]);
  const matched = entries.filter(([recordedFunction]) => functionMatches(recordedFunction, functionId));
  if (matched.length) return matched.reduce((sum, [, qd]) => sum + whole(qd), 0);
  // Never lend another function's work to this service. Old unscoped traces
  // only prove the one function they explicitly identify.
  return !functionId || functionMatches(serviceState?.functionId, functionId)
    ? whole(serviceState?.workedQd) : 0;
}

function traceFunctionWorkerIds(serviceState = {}, functionId = "") {
  const rows = serviceState?.activeWorkerIdsByFunction;
  if (rows && typeof rows === "object") {
    const matched = Object.entries(rows)
      .filter(([recordedFunction]) => functionMatches(recordedFunction, functionId))
      .flatMap(([, ids]) => Array.isArray(ids) ? ids : []);
    return [...new Set(matched.map(text).filter(Boolean))];
  }
  return !functionId || functionMatches(serviceState?.functionId, functionId)
    ? [...new Set((serviceState?.activeWorkerIds ?? []).map(text).filter(Boolean))] : [];
}

export function buildingServiceFunctionId(building = {}) {
  const functions = building?.functions ?? {};
  if (buildingLaborMode(building) !== "legacy" && functions.culture === true
    && ["inn", "tavern"].includes(text(building.templateId || building.id))) return "culture";
  if (building?.activation?.anyWorkingFunction === true) return "";
  if (building?.activation?.requiresMeaningfulResult === true && functions.production === true) return "production";
  if (functions.culture === true) return "culture";
  if (functions.income === true) return "income";
  if (functions.defense === true) return "defense";
  if (functions.production === true) return "production";
  if (functions.storage === true) return "storage";
  return "culture";
}

function workerAllocatedToFunction(person = {}, buildingId = "", functionId = "") {
  if (person.staffAppointment) return text(person.staffAppointment.buildingId) === buildingId
    && functionMatches(person.staffAppointment.primaryFunctionId, functionId);
  if (text(person?.workAllocationMode) !== WORK_ALLOCATION_MODE_EXPLICIT) return true;
  return (person?.workAllocations ?? []).some((allocation) => (
    text(allocation?.sourceId) === buildingId
    && text(allocation?.functionId) !== "maintenance"
    && functionMatches(allocation?.functionId, functionId)
    && whole(allocation?.normalQd) + whole(allocation?.overtimeQd) > 0
  ));
}

function workerAllocatedQd(person = {}, buildingId = "", functionId = "") {
  if (person.staffAppointment) return text(person.staffAppointment.buildingId) === buildingId
    && functionMatches(person.staffAppointment.primaryFunctionId, functionId)
    ? residentLaborCapacity(person).normalQd + whole(person.staffAppointment.overtimeQd) : 0;
  if (text(person?.workAllocationMode) !== WORK_ALLOCATION_MODE_EXPLICIT) return residentLaborCapacity(person).normalQd;
  return (person?.workAllocations ?? []).reduce((sum, allocation) => {
    if (text(allocation?.sourceId) !== buildingId) return sum;
    if (text(allocation?.functionId) === "maintenance") return sum;
    if (!functionMatches(allocation?.functionId, functionId)) return sum;
    return sum + whole(allocation?.normalQd) + whole(allocation?.overtimeQd);
  }, 0);
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
  if (buildingLaborMode(building) === "passive") return false;
  const activation = building?.activation ?? {};
  return Boolean(
    building?.service
    || whole(building?.workersMax) > 0
    || whole(building?.workerProfile?.workersMax) > 0
    || (building?.workerProfile?.composition ?? []).length > 0
    || whole(activation?.minWorkers) > 0
    || whole(activation?.minOperationalQd ?? building?.minOperationalQd) > 0
    || activation?.requiresMeaningfulResult === true
  );
}

export function buildingActiveWorkerSummary(holding = {}, building = {}, functionIdArg = "") {
  const buildingId = text(building?.id);
  const functionId = text(functionIdArg);
  const people = new Map((holding?.people?.list ?? []).map((person) => [text(person?.id), person]));
  const recorded = text(building?.serviceState?.periodKey)
    && Array.isArray(building?.serviceState?.activeWorkerIds)
    ? new Set(traceFunctionWorkerIds(building.serviceState, functionId))
    : null;
  const candidateIds = recorded ?? new Set((building?.assignedWorkerIds ?? []).map((workerId) => text(workerId)).filter(Boolean));
  if (!recorded) {
    for (const person of people.values()) {
      if (!person.staffAppointment && text(person?.workAllocationMode) !== WORK_ALLOCATION_MODE_EXPLICIT) continue;
      if (workerAllocatedToFunction(person, buildingId, functionId)) candidateIds.add(text(person?.id));
    }
  }
  const workers = [];
  let qd = 0, equivalentWorkers = 0;
  for (const id of candidateIds) {
    const person = people.get(id);
    if (!id || !person || person.dead || !isResidentPresent(person) || whole(person?.injuredDays) > 0) continue;
    if (financeWorkerBlockState({ finance: holding?.finance, workerId: id }).blocked) continue;
    if (!recorded && !workerAllocatedToFunction(person, buildingId, functionId)) continue;
    const workerQd = recorded ? 0 : workerAllocatedQd(person, buildingId, functionId);
    if (workerQd <= 0) continue;
    workers.push(person);
    qd += workerQd;
    equivalentWorkers += Math.min(1, workerQd / 20);
  }
  if (recorded) {
    const activeWorkers = [...candidateIds]
      .map((id) => people.get(id))
      .filter((person) => person && !person.dead && isResidentPresent(person) && whole(person?.injuredDays) <= 0)
      .filter((person) => !financeWorkerBlockState({ finance: holding?.finance, workerId: text(person?.id) }).blocked)
      .filter((person) => buildingLaborMode(building) === "legacy" || currentAssignmentMatches(person, building, functionId));
    const recordedQd = functionId ? traceFunctionQd(building?.serviceState, functionId) : whole(building?.serviceState?.workedQd);
    const workerQd = building.serviceState?.workedQdByWorkerAndFunction;
    const equivalent = workerQd ? activeWorkers.reduce((sum, person) => sum + Math.min(1,
      traceFunctionQd({ workedQdByFunction: workerQd[text(person.id)] }, functionId) / 20), 0)
      : Math.min(activeWorkers.length, recordedQd / 20);
    const eligibleQd = workerQd ? activeWorkers.reduce((sum, person) => sum
      + traceFunctionQd({ workedQdByFunction: workerQd[text(person.id)] }, functionId), 0)
      : activeWorkers.length === candidateIds.size ? recordedQd : 0;
    return { workers: activeWorkers, count: activeWorkers.length, qd: eligibleQd, equivalentWorkers: equivalent };
  }
  return { workers, count: workers.length, qd, equivalentWorkers };
}

/**
 * Returns a positive social effect status backed by the latest completed
 * tenday. Assignments alone are a forecast and never confirm morale or
 * reputation. Recorded workers must still be available and assigned to the
 * same building function, preventing a stale trace from surviving a shutdown
 * or a later reassignment.
 */
export function buildingConfirmedSocialStatus(holding = {}, building = {}, functionIdArg = "", options = {}) {
  const functionId = text(functionIdArg) || buildingServiceFunctionId(building);
  const base = buildingServiceBlockReasons(holding, building, functionId);
  const laborMode = buildingLaborMode(building);
  if (laborMode === "passive") return { ...base, periodKey: text(building?.serviceState?.periodKey) };
  const reasons = base.reasons.filter((reason) => !["workers-missing", "qd-missing", "result-missing", "service-stopped", "composition-missing"].includes(reason.code));
  const state = building?.serviceState ?? {};
  const completedIndex = completedTendayIndex(holding);
  const traceIndex = traceLastTendayIndex(state?.periodKey);
  if (completedIndex <= 0 || traceIndex !== completedIndex) {
    reasons.push({ code: "activity-unconfirmed", text: "нет подтверждённой работы за последний завершённый десятник" });
  }

  const people = new Map((holding?.people?.list ?? []).map((person) => [text(person?.id), person]));
  const recordedIds = traceFunctionWorkerIds(state, functionId);
  const workers = recordedIds.map((id) => people.get(id)).filter((person) => (
    person && !person.dead && isResidentPresent(person) && whole(person?.injuredDays) <= 0
    && !financeWorkerBlockState({ finance: holding?.finance, workerId: text(person?.id) }).blocked
    && currentAssignmentMatches(person, building, functionId)
  ));
  const workerQd = state?.workedQdByWorkerAndFunction;
  const qd = workerQd && typeof workerQd === "object"
    ? workers.reduce((sum, person) => sum + traceFunctionQd({ workedQdByFunction: workerQd[text(person.id)] }, functionId), 0)
    : workers.length === recordedIds.length ? traceFunctionQd(state, functionId) : 0;
  const leisure = options?.leisure === true ? building?.service?.leisure : null;
  const minWorkers = laborMode === "legacy" ? Math.max(1, whole(building?.workersMin), whole(leisure?.minWorkers ?? building?.activation?.minWorkers)) : 0;
  const minOperationalQd = whole(building?.activation?.minOperationalQd ?? building?.minOperationalQd);
  if (workers.length < minWorkers) reasons.push({ code: "workers-missing", text: `нужно работников: ${minWorkers}, подтверждено: ${workers.length}` });
  if (qd <= 0 || laborMode === "legacy" && qd < minOperationalQd) {
    reasons.push({ code: "qd-missing", text: `нужно фактических QD: ${Math.max(1, minOperationalQd)}, подтверждено: ${qd}` });
  }
  if (workers.length > 0 && !buildingCompositionStatus(building, workers, { excludeGroups: ["ЧУДОТВОРЕЦ"] }).met) {
    reasons.push({ code: "composition-missing", text: "не выполнено обязательное условие состава работников" });
  }

  const meaningfulByFunction = state?.meaningfulResultByFunction;
  const meaningfulResult = meaningfulByFunction && typeof meaningfulByFunction === "object"
    ? Object.entries(meaningfulByFunction).some(([recordedFunction, value]) => functionMatches(recordedFunction, functionId) && value === true)
    : state?.meaningfulResult === true;
  if (building?.activation?.requiresMeaningfulResult === true && functionId === "production" && !meaningfulResult) {
    reasons.push({ code: "result-missing", text: "за период нет содержательного результата функции" });
  }
  const uniqueReasons = [...new Map(reasons.map((reason) => [`${reason.code}:${reason.text}`, reason])).values()];
  return {
    active: uniqueReasons.length === 0,
    reasons: uniqueReasons,
    functionId,
    workforce: { workers, count: workers.length, qd, equivalentWorkers: workerQd
      ? workers.reduce((sum, person) => sum + Math.min(1, traceFunctionQd({ workedQdByFunction: workerQd[text(person.id)] }, functionId) / 20), 0)
      : Math.min(workers.length, qd / 20) },
    maintenanceFactor: base.maintenanceFactor,
    laborFactor: laborMode === "legacy" || minOperationalQd <= 0 ? 1 : Math.min(1, qd / minOperationalQd),
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
  if (visited.has(building)) return { active: false, maintenanceFactor: 0, reasons: [{ code: "dependency-cycle", text: "циклическая зависимость услуг" }] };
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
    && building?.serviceState?.active === false) {
    reasons.push({ code: "service-stopped", text: text(building?.serviceState?.reason) || "функция остановлена" });
  }
  const dependencies = dependencyState(holding, building, nextVisited, functionId);
  if (!dependencies.met) reasons.push({
    code: "dependency-missing",
    text: dependencies.missingAny
      ? `не работает ни одна альтернативная зависимость: ${dependencies.requiredAny.join(", ")}`
      : `не работают зависимости: ${dependencies.missing.join(", ")}`
  });
  const activation = building?.activation ?? {};
  const anyFunction = activation.requiresMeaningfulResult === true && (!functionId || functionId === "production");
  const workforce = buildingActiveWorkerSummary(holding, building, anyFunction ? "" : functionId);
  const laborMode = buildingLaborMode(building);
  const minWorkers = laborMode === "legacy" ? Math.max(whole(building?.workersMin), whole(activation.minWorkers)) : 0;
  if (workforce.count < minWorkers) reasons.push({ code: "workers-missing", text: `нужно работников: ${minWorkers}, действует: ${workforce.count}` });
  const minOperationalQd = laborMode === "passive" ? 0 : Math.max(
    laborMode !== "legacy" && activeServiceContract ? 1 : 0, whole(activation.minOperationalQd ?? building?.minOperationalQd));
  if (workforce.qd < (laborMode === "legacy" ? minOperationalQd : Math.min(1, minOperationalQd))) {
    reasons.push({ code: "qd-missing", text: `нужно QD: ${minOperationalQd}, выделено: ${workforce.qd}` });
  }
  if (laborMode !== "passive" && activation.requiresMeaningfulResult === true
    && (laborMode === "legacy" || anyFunction) && building?.serviceState?.meaningfulResult !== true) {
    reasons.push({ code: "result-missing", text: "за период нет содержательного результата функции" });
  }
  if (laborMode !== "passive" && workforce.count > 0 && !buildingCompositionStatus(building, workforce.workers, { excludeGroups: ["ЧУДОТВОРЕЦ"] }).met) {
    reasons.push({ code: "composition-missing", text: "не выполнено обязательное условие состава работников" });
  }
  const maintenanceFactor = activeServiceContract
    ? Math.max(0, Math.min(1, maintenanceEfficiencyFactor(building?.maintenance)))
    : 1;
  if (maintenanceFactor <= 0) reasons.push({ code: "maintenance-stopped", text: "обслуживание полностью остановило функцию" });
  const laborFactor = laborMode === "legacy" || laborMode === "passive" || minOperationalQd <= 0
    ? 1 : Math.min(1, workforce.qd / minOperationalQd);
  return { reasons, workforce, functionId, maintenanceFactor, laborFactor, active: reasons.length === 0 };
}

/**
 * Returns the current factor for an active settlement service.
 * Passive monuments and unstaffed structural effects stay at full strength;
 * staffed services require an operational building, paid staff and maintenance.
 */
export function buildingServiceEffectFactor(holding = {}, building = {}, functionIdArg = "") {
  const status = buildingServiceBlockReasons(holding, building, functionIdArg);
  return status.active ? status.maintenanceFactor * status.laborFactor : 0;
}

export function buildingServiceCapacity(holding = {}, building = {}, functionIdArg = "") {
  const service = building?.service;
  const status = buildingServiceBlockReasons(holding, building, functionIdArg);
  if (!service || !status.active) return 0;
  const functionId = text(functionIdArg) || buildingServiceFunctionId(building);
  const workforce = buildingActiveWorkerSummary(holding, building, functionId);
  return serviceCapacityForWorkforce(service, building, workforce, status.maintenanceFactor, status.laborFactor);
}

function serviceCapacityForWorkforce(service = {}, building = {}, workforce = {}, serviceFactor = 1, laborFactor = 1) {
  const legacy = buildingLaborMode(building) === "legacy";
  const workers = legacy ? workforce.count : Number(workforce.equivalentWorkers ?? 0);
  let capacity = whole(service.capacity) * laborFactor;
  if (whole(service.capacityBase) || whole(service.capacityPerWorker)) {
    capacity = whole(service.capacityBase) * laborFactor + workers * whole(service.capacityPerWorker);
  }
  if (whole(service.capacityPerWorkerStep)) {
    const minWorkers = legacy ? whole(building?.activation?.minWorkers)
      : whole(building?.activation?.minOperationalQd ?? building?.minOperationalQd) / 20;
    const extraWorkers = Math.max(0, workers - minWorkers);
    capacity = whole(service.capacityBase) * laborFactor + Math.floor(extraWorkers / Math.max(1, whole(service.workerStep, 1))) * whole(service.capacityPerWorkerStep);
  }
  const maximum = whole(service.maximumCapacity);
  if (maximum > 0) capacity = Math.min(capacity, maximum);
  // Capacity is a real pool, so partial maintenance reduces the number of
  // residents/buildings that can actually be served. Unlike a fixed integer
  // bonus it is rounded down: an incomplete service slot covers nobody.
  return Math.max(0, Math.floor(capacity * serviceFactor));
}

export function buildingConfirmedServiceCapacity(holding = {}, building = {}, functionIdArg = "") {
  const service = building?.service;
  if (!service) return 0;
  const status = buildingConfirmedSocialStatus(holding, building, functionIdArg);
  if (!status.active) return 0;
  return serviceCapacityForWorkforce(service, building, status.workforce, status.maintenanceFactor, status.laborFactor ?? 1);
}

export function buildingConfirmedLeisureCapacity(holding = {}, building = {}) {
  const leisure = building?.service?.leisure;
  if (!leisure || !text(leisure.kind)) return 0;
  const functionId = text(leisure.functionId) || "culture";
  const status = buildingConfirmedSocialStatus(holding, building, functionId, { leisure: true });
  if (!status.active) return 0;
  const nominalCapacity = whole(leisure.capacity);
  const qdPerCapacity = Math.max(0.01, Number(leisure.qdPerCapacity) || 1);
  const laborCapacity = Math.floor(status.workforce.qd / qdPerCapacity);
  return Math.max(0, Math.floor(Math.min(nominalCapacity, laborCapacity) * status.maintenanceFactor));
}

export function buildingNominalMorale(building = {}) {
  const leisure = building?.service?.leisure;
  if (leisure && text(leisure.kind)) return whole(leisure.capacity);
  const value = Number(building?.moraleDelta);
  return Number.isFinite(value) ? value : 0;
}

export function buildingWonderworkingActive(holding = {}, building = {}) {
  const people = new Map((holding?.people?.list ?? []).map((person) => [text(person?.id), person]));
  const profile = building?.workerProfile;
  if (!(profile?.composition ?? []).some((row) => String(row?.group ?? "").toUpperCase() === "ЧУДОТВОРЕЦ")) return false;
  const functionId = buildingServiceFunctionId(building);
  if (buildingServiceEffectFactor(holding, building, functionId) <= 0) return false;
  const buildingId = text(building?.id);
  const candidateIds = new Set(buildingActiveWorkerSummary(holding, building, functionId).workers.map((person) => text(person.id)));
  for (const person of people.values()) {
    if (text(person?.workAllocationMode) === WORK_ALLOCATION_MODE_EXPLICIT
      && workerAllocatedToFunction(person, buildingId, functionId)) candidateIds.add(text(person?.id));
  }
  const assigned = [...candidateIds]
    .map((id) => people.get(id))
    .filter((person) => person && !person.dead && isResidentPresent(person) && whole(person?.injuredDays) <= 0)
    .filter((person) => !financeWorkerBlockState({ finance: holding?.finance, workerId: text(person?.id) }).blocked)
    .filter((person) => currentAssignmentMatches(person, building, functionId));
  return buildingCompositionStatus(building, assigned).met;
}

export function scaleIntegerBuildingEffect(value, factor = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || !numeric) return 0;
  const activeFactor = Math.max(0, Math.min(1, Number(factor) || 0));
  if (activeFactor <= 0) return 0;
  // Poor maintenance may reduce a positive service, but it must never turn a
  // dangerous or unpleasant active building into a smaller penalty.
  if (numeric < 0) return signedRound(numeric);
  return signedRound(numeric * activeFactor);
}
