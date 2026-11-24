import { buildingOperationalState } from "../../core/building-state.js";
import { isMedicalBuilding } from "../../core/building-specials.js";
import { isResidentPresent } from "../../data/resident-presence.js";
import { normalLaborQdPerTenday, residentLaborCapacity } from "../../data/labor-budget.js";
import { financeBuildingFunctionBlockState, financeWorkerBlockState } from "./finance-obligations.js";
import { laborWageRate } from "./labor-wage-rate.js";
import { buildingCompositionStatus, workerAdmission } from "../workers/building-qualification.js";
import { buildingAcceptsWorkers, buildingMinOperationalQd, reservedOccupation } from "../../data/labor-model.js";

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
  if (!expectedId) return Boolean(actualId);
  if (actualId === expectedId) return true;
  return expectedId === "production" && actualId.startsWith("production:");
}

function enabledFunction(building, functionId = "") {
  const [kind, lineId] = text(functionId).split(":");
  if (building?.functions?.[kind] !== true) return false;
  return kind !== "production" || (building.productionLines ?? []).some((line) => line.active !== false && (!lineId || line.id === lineId));
}

function workerAllocatedQd(person = {}, building = {}, functionId = "") {
  const buildingId = text(building?.id);
  if (!buildingId) return 0;
  const anyWorking = building?.activation?.anyWorkingFunction === true;
  return (person?.workAllocations ?? []).reduce((sum, allocation) => {
    if (text(allocation?.sourceId) !== buildingId) return sum;
    if (!functionMatches(allocation?.functionId, functionId)) return sum;
    if (anyWorking && !enabledFunction(building, allocation?.functionId)) return sum;
    return sum + whole(allocation?.normalQd ?? allocation?.qd) + whole(allocation?.overtimeQd);
  }, 0);
}

export function buildingServiceFunctionId(building = {}) {
  const functions = building?.functions ?? {};
  if (isMedicalBuilding(building)) return "medical";
  if (functions.culture === true && ["inn", "tavern"].includes(text(building.templateId || building.id))) return "culture";
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

/** Housing remains usable without a caretaker; only the allocated service improves comfort. */
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

function hasStaffedHousingComfort(building = {}) {
  return building?.functions?.housing === true
    && Number.isFinite(building?.housing?.staffedComfort)
    && building.housing.staffedComfort > (Number(building?.housing?.comfort) || 0);
}

function hasActiveServiceContract(building = {}) {
  if (!buildingAcceptsWorkers(building)) return false;
  return Boolean(
    building?.service
    || buildingMinOperationalQd(building) > 0
    || building?.activation?.requiresMeaningfulResult === true
    || hasStaffedHousingComfort(building)
  );
}

function functionDailyRate(building = {}, functionId = "") {
  const fn = text(functionId);
  if (fn.startsWith("production:")) {
    const lineId = fn.slice("production:".length);
    const lines = Array.isArray(building?.productionLines) ? building.productionLines : [];
    const line = lines.find((item, index) => (text(item?.id) || `line-${index + 1}`) === lineId);
    return whole(line?.wageDailyCopper) || whole(building?.wageDailyCopper);
  }
  if (fn === "agriculture") return whole(building?.agriculture?.wageDailyCopper) || whole(building?.wageDailyCopper);
  if (fn === "livestock") return whole(building?.livestock?.wageDailyCopper) || whole(building?.wageDailyCopper);
  if (fn === "income") return whole(building?.income?.wageDailyCopper) || whole(building?.wageDailyCopper);
  return whole(building?.wageDailyCopper);
}

function targetAllowsOvertime(building = {}, functionId = "") {
  const fn = text(functionId);
  if (!fn.startsWith("production:")) return false;
  const lineId = fn.slice("production:".length);
  const lines = Array.isArray(building?.productionLines) ? building.productionLines : [];
  const line = lines.find((item, index) => (text(item?.id) || `line-${index + 1}`) === lineId);
  return line?.overtime === true;
}

export function buildingActiveWorkerSummary(holding = {}, building = {}, functionIdArg = "") {
  const functionId = text(functionIdArg);
  const fullWorkerQd = Math.max(1, normalLaborQdPerTenday(holding));
  const workers = [];
  const rejectedReasons = [];
  let qd = 0;
  let equivalentWorkers = 0;
  if (!buildingAcceptsWorkers(building)) {
    return { workers, count: 0, qd: 0, equivalentWorkers: 0, fullWorkerQd, rejectedReasons };
  }

  const targetBuildingId = text(building?.id);
  const buildingsById = new Map((holding?.buildings?.list ?? []).map((item) => [text(item?.id), item]));
  if (targetBuildingId) buildingsById.set(targetBuildingId, building);

  for (const person of holding?.people?.list ?? []) {
    const id = text(person?.id);
    if (!id || person.dead || !isResidentPresent(person) || whole(person?.injuredDays) > 0) continue;
    if (financeWorkerBlockState({ finance: holding?.finance, workerId: id }).blocked) continue;
    const workerQd = workerAllocatedQd(person, building, functionId);
    if (workerQd <= 0) continue;
    const reserved = reservedOccupation(holding, person);
    if (reserved) {
      rejectedReasons.push(`${text(person?.name) || "Житель"}: ${reserved.label}`);
      continue;
    }
    const admission = workerAdmission(building, person);
    if (admission?.hard && !admission.eligible && !admission.overridden) {
      rejectedReasons.push(`${text(person?.name) || "Житель"}: нет допуска`);
      continue;
    }
    const rows = Array.isArray(person?.workAllocations) ? person.workAllocations : [];
    const cap = residentLaborCapacity(person, holding);
    let totalNormalQd = 0;
    let totalOvertimeQd = 0;
    let contractValid = true;
    for (const row of rows) {
      const rowNormalQd = whole(row?.normalQd ?? row?.qd);
      const rowOvertimeQd = whole(row?.overtimeQd);
      if (!rowNormalQd && !rowOvertimeQd) continue;
      totalNormalQd += rowNormalQd;
      totalOvertimeQd += rowOvertimeQd;
      const rowBuilding = buildingsById.get(text(row?.sourceId));
      if (!rowBuilding) continue;
      if (rowOvertimeQd > 0 && !targetAllowsOvertime(rowBuilding, row?.functionId)) {
        rejectedReasons.push(`${text(person?.name) || "Житель"}: сверхурочные недоступны`);
        contractValid = false;
        break;
      }
      const wage = laborWageRate({
        volunteer: person?.volunteerLabor === true || row?.volunteer === true,
        wageOverrideCopper: person?.wageDailyOverrideCopper,
        dailyRateCopper: functionDailyRate(rowBuilding, row?.functionId)
      });
      if (!wage.ok) {
        rejectedReasons.push(`${text(person?.name) || "Житель"}: нужна ставка или договор о бесплатном труде`);
        contractValid = false;
        break;
      }
    }
    if (!contractValid) continue;
    if (totalNormalQd > cap.normalQd || totalOvertimeQd > cap.overtimeQd || totalOvertimeQd > Math.floor(totalNormalQd / 2)) {
      rejectedReasons.push(`${text(person?.name) || "Житель"}: план (${totalNormalQd}+${totalOvertimeQd} QD) превышает лимит (${cap.normalQd}+${cap.overtimeQd} QD)`);
      continue;
    }
    workers.push(person);
    qd += workerQd;
    equivalentWorkers += Math.min(1, workerQd / fullWorkerQd);
  }
  return { workers, count: workers.length, qd, equivalentWorkers, fullWorkerQd, rejectedReasons: [...new Set(rejectedReasons)] };
}

/**
 * Unified immediate social service status: once allocated QD reaches
 * `minOperationalQd` (and hard dependencies/composition/fuel are met),
 * the service activates at 100% with no past-tenday confirmation lag.
 */
export function buildingConfirmedSocialStatus(holding = {}, building = {}, functionIdArg = "", _options = {}) {
  const functionId = text(functionIdArg) || buildingServiceFunctionId(building);
  const status = buildingServiceBlockReasons(holding, building, functionId);
  return {
    ...status,
    periodKey: ""
  };
}

/** A harmful staffed function follows allocated work, not positive-service finance gates. */
export function buildingConfirmedHarmActive(holding = {}, building = {}, functionIdArg = "") {
  if (!buildingOperationalState(building).operational) return false;
  if (building?.activation?.harmWhileOperational === true) return true;
  if (!hasActiveServiceContract(building)) return true;
  const functionId = text(functionIdArg) || buildingServiceFunctionId(building);
  return buildingActiveWorkerSummary(holding, building, functionId).qd > 0;
}

export function buildingServiceBlockReasons(holding = {}, building = {}, functionIdArg = "", visited = new Set()) {
  if (visited.has(building)) return { active: false, maintenanceFactor: 1, laborFactor: 0, reasons: [{ code: "dependency-cycle", text: "циклическая зависимость услуг" }] };
  const nextVisited = new Set(visited).add(building);
  const reasons = [];
  const activeServiceContract = hasActiveServiceContract(building);
  if (!buildingOperationalState(building).operational) reasons.push({ code: "not-operational", text: "здание строится, повреждено или законсервировано" });
  const functionId = text(functionIdArg) || buildingServiceFunctionId(building);
  const financeBlock = financeBuildingFunctionBlockState({ finance: holding?.finance, buildingId: text(building?.id), functionId });
  if (financeBlock.blocked) reasons.push({ code: "finance-blocked", text: "функция остановлена неоплаченными обязательствами" });
  if (activeServiceContract
    && building?.serviceState?.fuelBlocked === true
    && (!functionId || building?.serviceState?.functionId === functionId)) {
    reasons.push({ code: "service-stopped", text: text(building?.serviceState?.reason) || "не хватает топлива для функции" });
  }
  const dependencies = dependencyState(holding, building, nextVisited, functionId);
  if (!dependencies.met) {
    reasons.push({
      code: "dependency-missing",
      text: dependencies.missingAny
        ? `не работает ни одна альтернативная зависимость: ${dependencies.requiredAny.join(", ")}`
        : `не работают зависимости: ${dependencies.missing.join(", ")}`
    });
  }

  const acceptsWorkers = buildingAcceptsWorkers(building);
  const activation = building?.activation ?? {};
  const anyFunction = activation.requiresMeaningfulResult === true && (!functionId || functionId === "production");
  const workforce = buildingActiveWorkerSummary(holding, building, anyFunction ? "" : functionId);
  const configuredMinQd = acceptsWorkers ? buildingMinOperationalQd(building) : 0;
  const needsStaffedService = Boolean(
    building?.service
    || building?.activation?.requiresMeaningfulResult === true
    || hasStaffedHousingComfort(building)
    || isMedicalBuilding(building)
  );
  const requiredQd = acceptsWorkers
    ? (configuredMinQd > 0 ? configuredMinQd : (needsStaffedService ? 1 : 0))
    : 0;
  if (requiredQd > 0 && workforce.qd < requiredQd) {
    const suffix = workforce.rejectedReasons?.length ? ` (${workforce.rejectedReasons.join("; ")})` : "";
    reasons.push({ code: "qd-missing", text: `нужно QD: ${requiredQd}, выделено: ${workforce.qd}${suffix}` });
  }
  if (acceptsWorkers && workforce.count > 0 && !buildingCompositionStatus(building, workforce.workers, { excludeGroups: ["ЧУДОТВОРЕЦ"] }).met) {
    reasons.push({ code: "composition-missing", text: "не выполнено обязательное условие состава работников" });
  }
  const active = reasons.length === 0;
  return { reasons, workforce, functionId, maintenanceFactor: 1, laborFactor: active ? 1 : 0, active };
}

/**
 * Returns the current factor for an active settlement service (100% or 0%).
 */
export function buildingServiceEffectFactor(holding = {}, building = {}, functionIdArg = "") {
  const status = buildingServiceBlockReasons(holding, building, functionIdArg);
  return status.active ? status.laborFactor : 0;
}

export function buildingServiceCapacity(holding = {}, building = {}, functionIdArg = "") {
  const service = building?.service;
  const status = buildingServiceBlockReasons(holding, building, functionIdArg);
  if (!service || !status.active) return 0;
  return serviceCapacityForWorkforce(service, building, status.workforce, status.laborFactor);
}

function serviceCapacityForWorkforce(service = {}, building = {}, workforce = {}, laborFactor = 1) {
  const workers = Number(workforce.equivalentWorkers ?? 0);
  let capacity = whole(service.capacity) * laborFactor;
  if (whole(service.capacityBase) || whole(service.capacityPerWorker)) {
    capacity = whole(service.capacityBase) * laborFactor + workers * whole(service.capacityPerWorker);
  }
  if (whole(service.capacityPerWorkerStep)) {
    const minWorkers = buildingMinOperationalQd(building) / (Number(workforce?.fullWorkerQd) || 20);
    const extraWorkers = Math.max(0, workers - minWorkers);
    capacity = whole(service.capacityBase) * laborFactor + Math.floor(extraWorkers / Math.max(1, whole(service.workerStep, 1))) * whole(service.capacityPerWorkerStep);
  }
  const maximum = whole(service.maximumCapacity);
  if (maximum > 0) capacity = Math.min(capacity, maximum);
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
  const status = buildingConfirmedSocialStatus(holding, building, functionId, { leisure: true });
  if (!status.active) return 0;
  const nominalCapacity = whole(leisure.capacity);
  const qdPerCapacity = Math.max(0.01, Number(leisure.qdPerCapacity) || 1);
  const laborCapacity = Math.floor(status.workforce.qd / qdPerCapacity);
  return Math.max(0, Math.floor(Math.min(nominalCapacity, laborCapacity)));
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
  const workforce = buildingActiveWorkerSummary(holding, building, functionId);
  return buildingCompositionStatus(building, workforce.workers).met;
}

export function scaleIntegerBuildingEffect(value, factor = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || !numeric) return 0;
  const activeFactor = Math.max(0, Math.min(1, Number(factor) || 0));
  if (activeFactor <= 0) return 0;
  if (numeric < 0) return signedRound(numeric);
  return signedRound(numeric * activeFactor);
}
