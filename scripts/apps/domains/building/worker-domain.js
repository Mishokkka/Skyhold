// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { workerTypeStyleFromAttributes } from "../../../generators/resident-rules.js";
import { splitList, WORKER_TYPE_OPTIONS } from "../../../core/helpers.js";
import { canReadResident } from "../../../data/access-guard.js";
import { isResidentInPopulation } from "../../../data/resident-presence.js";
import { allocatedBuildingQd, buildingWorkerIds } from "../../../data/work-allocations.js";
import { DEFAULT_NORMAL_LABOR_QD } from "../../../data/labor-budget.js";
import {
  buildingCompositionStatus,
  workerAdmission,
  workerProductionQualification,
  workerProfileSummary,
  WORK_UNITS_PER_QD
} from "../../../engines/workers/building-qualification.js";

export const BuildingWorkerDomain = {
_workerTypeSelectOptions(current = "") {
  const selected = splitList(current);
  const selectedSet = new Set(selected.map((item) => item.toLowerCase()));
  return WORKER_TYPE_OPTIONS.map((name) => ({ name, selected: selectedSet.has(name.toLowerCase()) }));
},

_workerTypeAttributeKeys(typeName = "") {
  const raw = String(typeName ?? "").trim();
  const broad = {
    "все с сил": ["strength"],
    "все с лов": ["agility"],
    "все с раз": ["wits"],
    "все с эмп": ["empathy"]
  };
  const low = raw.toLowerCase();
  if (broad[low]) return broad[low];
  const exact = {
    "Разнорабочий": [], "Силач": ["strength"], "Ловкач": ["agility"], "Умелец": ["wits"],
    "Переговорщик": ["empathy"], "Строитель": ["strength", "agility"], "Механик": ["strength", "wits"],
    "Бригадир": ["strength", "empathy"], "Ремесленник": ["agility", "wits"], "Посыльный": ["agility", "empathy"],
    "Управленец": ["wits", "empathy"], "Мастеровой": ["strength", "agility", "wits"],
    "Агент": ["agility", "wits", "empathy"], "Старшина": ["strength", "wits", "empathy"],
    "Полевой вожак": ["strength", "agility", "empathy"], "Мастер на все руки": ["strength", "agility", "wits", "empathy"]
  };
  return exact[raw] ?? [];
},

_workerTypeCriterionKind(typeName = "") {
  return /^Все с /i.test(String(typeName ?? "").trim()) ? "broad" : "exact";
},

_workerTypeMatchesCriterion(personType = "", criterion = "") {
  const typeName = String(personType ?? "").trim();
  const rule = String(criterion ?? "").trim();
  if (!typeName || !rule) return false;
  if (this._workerTypeCriterionKind(rule) === "exact") return typeName.toLowerCase() === rule.toLowerCase();
  const wanted = new Set(this._workerTypeAttributeKeys(rule));
  if (!wanted.size) return false;
  return this._workerTypeAttributeKeys(typeName).some((key) => wanted.has(key));
},

_workerTypeChipStyle(typeName = "") {
  const attributes = Object.fromEntries(this._workerTypeAttributeKeys(typeName).map((key) => [key, 5]));
  return workerTypeStyleFromAttributes(attributes);
},

_suitableTypeBadges(current = "", basePath = "") {
  return splitList(current).map((name) => ({ name, path: basePath, style: this._workerTypeChipStyle(name), isBroad: this._workerTypeCriterionKind(name) === "broad" }));
},

_buildingWorkerAdmission(building = {}, person = {}) {
  return workerAdmission(building, person);
},

_buildingWorkerProfileSummary(building = {}) {
  return workerProfileSummary(building);
},

_buildingCompositionStatus(holding = {}, building = {}, assignedPeople = null, options = {}) {
  const people = assignedPeople ?? buildingWorkerIds(holding, building)
    .map((id) => (holding?.people?.list ?? []).find((person) => String(person?.id ?? "") === String(id ?? "")))
    .filter(Boolean);
  return buildingCompositionStatus(building, people, options);
},

_workerEfficiencyForPerson(_holding, building, person) {
  if (!person || person.dead || this._safeNumber(person?.injuredDays, 0) > 0) {
    return { value: 0, workUnits: 0, suitable: false, traitBonus: 0, matchedType: "", details: ["недоступен"] };
  }
  const admission = workerAdmission(building, person);
  if (admission.hard && !admission.eligible && !admission.overridden) {
    return { value: 0, workUnits: 0, suitable: false, traitBonus: 0, matchedType: "", details: [`нет допуска: ${admission.text}`] };
  }
  const qualification = admission.hard && !admission.eligible && admission.overridden
    ? { workUnits: WORK_UNITS_PER_QD, typeUnits: 0, positiveTraitUnits: 0, negativeTraitUnits: 0, matchedSelector: "", details: ["GM-допуск: без бонусов"] }
    : workerProductionQualification(building, person);
  return {
    value: qualification.workUnits / WORK_UNITS_PER_QD,
    workUnits: qualification.workUnits,
    suitable: qualification.typeUnits > 0,
    traitBonus: (qualification.positiveTraitUnits + qualification.negativeTraitUnits) / WORK_UNITS_PER_QD,
    matchedType: qualification.matchedSelector,
    details: qualification.details.map((detail) => `${person.name || "работник"}: ${detail}`),
    admission
  };
},

/**
 * Summarize active staffing, excluding unavailable residents without a cached context.
 * A supplied economy context retains its finance-specific blocked-worker selection.
 */
_buildingEffectiveWorkers(holding, building, workerContext = null, functionId = "") {
  const cache = functionId ? null : workerContext?.effectiveWorkers;
  if (cache?.has(building)) return cache.get(building);
  const cachedWorkers = functionId ? null : workerContext?.buildingWorkers?.get(building);
  const assignedIds = cachedWorkers?.assignedIds ?? buildingWorkerIds(holding, building, functionId);
  const activeAssignedPeople = (workerContext?.financeContext ? cachedWorkers?.economyAssignedPeople : cachedWorkers?.activeAssignedPeople) ?? null;
  const allPeople = holding?.people?.list ?? [];
  const assignedPeople = activeAssignedPeople ?? assignedIds
    .map((id) => allPeople.find((person) => String(person?.id ?? "") === id))
    .filter((person) => person && isResidentInPopulation(person, holding) && this._safeNumber(person?.injuredDays, 0) <= 0);
  let productionWorkUnitsPerQd = 0;
  let equivalentWorkers = 0;
  let publicProductionWorkUnitsPerQd = 0;
  let publicEquivalentWorkers = 0;
  let suitableCount = 0;
  let visibleCount = 0;
  let publicCount = 0;
  const details = [];
  const publicDetails = [];
  const publicPeople = [];
  const finance = workerContext?.financeContext;
  const activePeople = functionId && finance
    ? assignedPeople.filter((person) => !finance.blockedWorkerIds?.has(String(person.id))
      && allocatedBuildingQd(finance.plannedAssignmentsByWorkerId?.get(String(person.id)), building.id, functionId) > 0)
    : assignedPeople;
  for (const person of activePeople) {
    const result = this._workerEfficiencyForPerson(holding, building, person);
    const rows = finance && functionId ? finance.plannedAssignmentsByWorkerId?.get(String(person.id)) : person.workAllocations;
    const share = functionId
      ? Math.min(1.5, allocatedBuildingQd(rows, building.id, functionId) / DEFAULT_NORMAL_LABOR_QD)
      : 1;
    productionWorkUnitsPerQd += result.workUnits * share;
    equivalentWorkers += share;
    if (result.suitable) suitableCount += 1;
    if (person?.visibility !== "gm") {
      publicProductionWorkUnitsPerQd += result.workUnits * share;
      publicEquivalentWorkers += share;
      publicCount += 1;
      publicDetails.push(...result.details);
      publicPeople.push(person);
    }
    if (canReadResident(person)) {
      visibleCount += 1;
      details.push(...result.details);
    }
  }
  const composition = buildingCompositionStatus(building, activePeople, { excludeGroups: ["ЧУДОТВОРЕЦ"] });
  if (!composition.met) details.push(`не выполнен состав: ${composition.text}`);
  const publicComposition = buildingCompositionStatus(building, publicPeople, { excludeGroups: ["ЧУДОТВОРЕЦ"] });
  if (!publicComposition.met) publicDetails.push(`не выполнен состав: ${publicComposition.text}`);
  const result = {
    assigned: assignedIds.length,
    total: equivalentWorkers,
    productionEquivalent: productionWorkUnitsPerQd / WORK_UNITS_PER_QD,
    productionWorkUnitsPerQd,
    publicTotal: publicEquivalentWorkers,
    publicProductionEquivalent: publicProductionWorkUnitsPerQd / WORK_UNITS_PER_QD,
    publicDetail: [`${publicCount} раб.`, ...publicDetails].join(" · "),
    suitableCount,
    leaderBonus: 0,
    maintenanceFactor: 1,
    composition,
    detail: [`${visibleCount} раб.`, ...details].join(" · ")
  };
  cache?.set(building, result);
  return result;
}
};
