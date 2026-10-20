// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { workerTypeStyleFromAttributes } from "../../../generators/resident-rules.js";
import { splitList, WORKER_TYPE_OPTIONS } from "../../../core/helpers.js";
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
  const people = assignedPeople ?? (building?.assignedWorkerIds ?? [])
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

_buildingEffectiveWorkers(holding, building, workerContext = null) {
  if (workerContext?.effectiveWorkers?.has(building)) return workerContext.effectiveWorkers.get(building);
  const cachedWorkers = workerContext?.buildingWorkers?.get(building);
  const assignedIds = cachedWorkers?.assignedIds ?? (building?.assignedWorkerIds ?? []).filter(Boolean).map(String);
  const activeAssignedPeople = (workerContext?.financeContext ? cachedWorkers?.economyAssignedPeople : cachedWorkers?.activeAssignedPeople) ?? null;
  const allPeople = holding?.people?.list ?? [];
  const assignedPeople = activeAssignedPeople ?? assignedIds
    .map((id) => allPeople.find((person) => String(person?.id ?? "") === id))
    .filter((person) => person && !person.dead && this._safeNumber(person?.injuredDays, 0) <= 0);
  let productionWorkUnitsPerQd = 0;
  let suitableCount = 0;
  const details = [];
  for (const person of assignedPeople) {
    const result = this._workerEfficiencyForPerson(holding, building, person);
    productionWorkUnitsPerQd += result.workUnits;
    if (result.suitable) suitableCount += 1;
    details.push(...result.details);
  }
  const composition = buildingCompositionStatus(building, assignedPeople, { excludeGroups: ["ЧУДОТВОРЕЦ"] });
  if (!composition.met) details.push(`не выполнен состав: ${composition.text}`);
  const maintenanceFactor = Math.max(0, Math.min(1, this._maintenanceEfficiencyFactor?.(building)
    ?? (this._safeNumber(building?.maintenance?.backlogTendays, 0) >= 2 ? 0.5 : 1)));
  const result = {
    assigned: assignedIds.length,
    total: assignedPeople.length,
    productionEquivalent: productionWorkUnitsPerQd / WORK_UNITS_PER_QD,
    productionWorkUnitsPerQd,
    suitableCount,
    leaderBonus: 0,
    maintenanceFactor,
    composition,
    detail: [`${assignedPeople.length} раб.`, ...details].join(" · ")
  };
  if (workerContext?.effectiveWorkers) workerContext.effectiveWorkers.set(building, result);
  return result;
}
};
