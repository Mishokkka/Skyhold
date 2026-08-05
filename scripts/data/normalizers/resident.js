import { ageGroupFromAge, clampAgeForRace, normalizeBelief, representativeAgeForGroup } from "../../generators/resident-rules.js";
import { isPlainObject, makeId, toBoolean, toNumber } from "../utils.js";
import { normalizeWorkerTypeSet } from "./building.js";
import { defaultBoardFoodDaily, normalizeCompensationType } from "../../core/compensation.js";
import { normalizeEmploymentTerms } from "../labor/employment-terms.js";
import { normalizeFoodProvisionMode } from "../food-provision.js";

function optionalSafeQd(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const qd = Math.floor(numeric);
  return Number.isSafeInteger(qd) ? qd : null;
}

function nonnegativeSafeInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  const whole = Math.floor(numeric);
  return Number.isSafeInteger(whole) ? whole : fallback;
}

export function clearPersonReferences(holding, personId) {
  const id = String(personId ?? "");
  if (!id) return;
  for (const building of holding?.buildings?.list ?? []) {
    if (Array.isArray(building.assignedWorkerIds)) building.assignedWorkerIds = building.assignedWorkerIds.map((value) => String(value) === id ? "" : value);
  }
  for (const person of holding?.people?.list ?? []) if (String(person?.id ?? "") === id) person.home = "";
  for (const crew of holding?.constructionCrews ?? []) {
    if (Array.isArray(crew.memberIds)) crew.memberIds = crew.memberIds.filter((value) => String(value) !== id);
    if (Array.isArray(crew.distributedIds)) crew.distributedIds = crew.distributedIds.filter((value) => String(value) !== id);
    if (String(crew.leaderId ?? "") === id) crew.leaderId = "";
  }
  if (Array.isArray(holding?.constructionCrewIds)) holding.constructionCrewIds = holding.constructionCrewIds.filter((value) => String(value) !== id);
  const defense = holding?.gm?.defense;
  if (defense && typeof defense === "object") {
    if (String(defense.commanderId ?? "") === id) defense.commanderId = "";
    for (const squad of defense.squads ?? []) {
      if (!squad || typeof squad !== "object") continue;
      if (String(squad.sergeantId ?? "") === id) squad.sergeantId = "";
      if (Array.isArray(squad.memberIds)) squad.memberIds = squad.memberIds.map((value) => String(value ?? "") === id ? "" : value);
    }
  }
  for (const vessel of holding?.special?.fleet?.vessels ?? []) {
    if (Array.isArray(vessel?.crew?.memberIds)) vessel.crew.memberIds = vessel.crew.memberIds.filter((value) => String(value ?? "") !== id);
  }
}

export function clearBuildingReferences(holding, building) {
  const id = String(building?.id ?? "");
  const name = String(building?.name ?? "");
  if (!id && !name) return;
  for (const person of holding?.people?.list ?? []) {
    const assigned = String(person?.workAssignment ?? "");
    if (assigned === id || (name && assigned === name)) {
      person.workAssignment = "";
      person.role = "Свободен";
    }
    const home = String(person?.home ?? "");
    if (home === id || (name && home === name)) person.home = "";
  }
  for (const candidate of holding?.buildings?.list ?? []) {
    if (!Array.isArray(candidate.requiredBuildingIds)) continue;
    candidate.requiredBuildingIds = candidate.requiredBuildingIds.filter((value) => {
      const text = String(value ?? "");
      return text !== id && (!name || text !== name);
    });
  }
}

export function normalizeConstructionCrew(crew, index = 0) {
  const normalized = isPlainObject(crew) ? crew : {};
  normalized.id = String(normalized.id || makeId("crew"));
  normalized.name = String(normalized.name || (index ? `Стройбригада ${index + 1}` : "Стройбригада"));
  normalized.leaderId = String(normalized.leaderId ?? "");
  normalized.suitableWorkerTypes = normalizeWorkerTypeSet(normalized.suitableWorkerTypes ?? "").line;
  if (!Array.isArray(normalized.memberIds)) normalized.memberIds = Array.isArray(normalized.ids) ? normalized.ids : [];
  normalized.memberIds = normalized.memberIds.map((id) => String(id ?? "")).filter(Boolean);
  normalized.distributed = toBoolean(normalized.distributed, false);
  if (!Array.isArray(normalized.distributedIds)) normalized.distributedIds = [];
  normalized.distributedIds = normalized.distributedIds.map((id) => String(id ?? "")).filter(Boolean);
  return normalized;
}

export function normalizePerson(person) {
  person.id = String(person.id || makeId("person"));
  person.name = String(person.name ?? "");
  person.role = String(person.role ?? person.workplace ?? person.work ?? "");
  person.workAssignment = String(person.workAssignment ?? "");
  person.skill = String(person.skill ?? "");
  person.sex = String(person.sex ?? "");
  person.race = String(person.race ?? "");
  person.subrace = String(person.subrace ?? "");
  person.ageGroup = String(person.ageGroup ?? "Вз");
  person.age = person.age === undefined || person.age === null || person.age === ""
    ? representativeAgeForGroup(person.ageGroup, person.race, person.subrace)
    : clampAgeForRace(person.age, person.race, person.subrace);
  person.ageGroup = ageGroupFromAge(person.age, person.race, person.subrace);
  person.culture = String(person.culture ?? "");
  person.belief = normalizeBelief(person.belief ?? "");
  person.background = String(person.background ?? "");
  person.appearance = String(person.appearance ?? "");
  person.traitsText = String(person.traitsText ?? (Array.isArray(person.traits) ? person.traits.join(", ") : ""));
  delete person.workerTypeOverride;
  person.home = String(person.home ?? "");
  const legacySalary = Math.max(0, toNumber(person.salary, 0));
  const hadCompensationFields = ["compensationType", "cashWageDaily", "boardFoodDaily", "housingProvided", "shareRate", "compensationNote"]
    .some((key) => Object.hasOwn(person, key));
  person.salaryModifier = toNumber(person.salaryModifier, 0);
  person.compensationType = normalizeCompensationType(person.compensationType, {
    salary: person.cashWageDaily ?? legacySalary,
    assigned: Boolean(String(person.workAssignment ?? "").trim() || !["", "Свободен", "Без работы", "Ребенок"].includes(String(person.role ?? "")))
  });
  person.baseWageDaily = Math.max(0, toNumber(person.baseWageDaily, Math.max(0, legacySalary - person.salaryModifier)));
  person.cashWageDaily = Math.max(0, toNumber(person.cashWageDaily, legacySalary));
  person.boardFoodDaily = Math.max(0, toNumber(person.boardFoodDaily, hadCompensationFields ? defaultBoardFoodDaily(person.compensationType) : 1));
  person.foodProvisionMode = normalizeFoodProvisionMode(person.foodProvisionMode, { boardFoodDaily: person.boardFoodDaily });
  if (person.foodProvisionMode === "settlement") person.boardFoodDaily = 1;
  else if (person.foodProvisionMode === "self") person.boardFoodDaily = 0;
  const homeText = String(person.home ?? "").trim();
  person.housingProvided = toBoolean(person.housingProvided, !hadCompensationFields && Boolean(homeText) && !/без жилья|нет жилья|homeless/i.test(homeText));
  person.shareRate = Math.max(0, Math.min(1, toNumber(person.shareRate, 0)));
  person.compensationNote = String(person.compensationNote ?? (!hadCompensationFields
    ? (legacySalary > 0
      ? "Миграция: прежняя ставка сохранена как денежная часть; пансион — 1 человеко-день в день."
      : "Миграция: прежняя нулевая ставка сохранена; GM должен проверить основание договора.")
    : "")).trim();
  // Compatibility alias for macros and old integrations. cashWageDaily is authoritative.
  person.salary = person.cashWageDaily;
  // Economy V2 contracts are opt-in through a valid wageClassId. Legacy daily
  // aliases remain untouched and never infer a full tariff during normalization.
  Object.assign(person, normalizeEmploymentTerms(person));
  person.volunteerReason = String(person.volunteerReason ?? "").trim();
  person.volunteerTermStartQd = optionalSafeQd(person.volunteerTermStartQd);
  person.volunteerTermEndQd = optionalSafeQd(person.volunteerTermEndQd);
  person.coercionBasis = String(person.coercionBasis ?? "").trim();
  person.hungerStreakTendays = nonnegativeSafeInteger(person.hungerStreakTendays, 0);
  const hadAttributes = isPlainObject(person.attributes);
  if (!hadAttributes) person.attributes = {};
  const attributeFallback = hadAttributes ? 3 : 0;
  for (const key of ["strength", "agility", "wits", "empathy"]) person.attributes[key] = toNumber(person.attributes[key], attributeFallback);
  const oldMorale = toNumber(person.moraleDelta, null);
  if (person.moraleBase === undefined) person.moraleBase = -1;
  person.moraleBase = toNumber(person.moraleBase, -1);
  person.moraleWork = toNumber(person.moraleWork, 0);
  person.moraleHome = toNumber(person.moraleHome, 0);
  person.moraleManual = person.moraleManual === undefined ? (oldMorale === null ? 0 : oldMorale - person.moraleBase - person.moraleWork - person.moraleHome) : toNumber(person.moraleManual, 0);
  person.moraleDelta = person.moraleBase + person.moraleWork + person.moraleHome + person.moraleManual;
  const status = String(person.status ?? "").trim();
  person.dead = toBoolean(person.dead ?? person.isDead ?? /погиб|мертв|мёртв|dead|deceased/i.test(status), false);
  person.deathDate = String(person.deathDate ?? "");
  person.deathNote = String(person.deathNote ?? "");
  person.injuredDays = Math.max(0, Math.floor(toNumber(person.injuredDays, 0)));
  if (!Array.isArray(person.educationMilestones)) person.educationMilestones = [];
  person.educationMilestones = person.educationMilestones.map((value) => String(value ?? "").trim()).filter(Boolean);
  person.actorUuid = String(person.actorUuid ?? "");
  person.status = person.dead && !status ? "Погиб" : (person.injuredDays > 0 && !/ранен/i.test(status) ? `Ранен (${person.injuredDays} дн.)` : status);
  person.notes = String(person.notes ?? "").trim();
}
