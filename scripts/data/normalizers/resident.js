import { ageGroupFromAge, clampAgeForRace, normalizeBelief, normalizeResidentAttribute, representativeAgeForGroup } from "../../generators/resident-rules.js";
import { isPlainObject, makeId, toBoolean, toNumber } from "../utils.js";
import { normalizeMaintenancePointsPerTenday } from "../economy/maintenance.js";
import { normalizePersonWorkAllocations } from "../work-allocations.js";
import { normalizeWorkerTypeSet } from "./building.js";
import { normalizeStaffAppointment } from "../hybrid-labor.js";

const OBSOLETE_RESIDENT_SKILL_VALUES = new Set([
  "-", "нет", "none",
  "builder", "trader", "scribe", "healer", "priest", "guard", "sailor", "engineer",
  "разнорабочий", "силач", "ловкач", "умелец", "переговорщик", "строитель", "механик", "бригадир",
  "ремесленник", "посыльный", "управленец", "мастеровой", "агент", "старшина", "полевой вожак", "мастер на все руки"
]);

export function legacyResidentTraitFromSkill(value = "") {
  const raw = String(value ?? "").trim();
  return raw && !OBSOLETE_RESIDENT_SKILL_VALUES.has(raw.toLowerCase()) ? raw : "";
}

function appendUniqueTrait(value = "", addition = "") {
  const items = String(value ?? "").split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
  const candidate = String(addition ?? "").trim();
  if (candidate && !items.some((item) => item.toLowerCase() === candidate.toLowerCase())) items.push(candidate);
  return items.join(", ");
}

export function clearPersonReferences(holding, personId) {
  const id = String(personId ?? "");
  if (!id) return;
  for (const building of holding?.buildings?.list ?? []) {
    if (Array.isArray(building.assignedWorkerIds)) building.assignedWorkerIds = building.assignedWorkerIds.map((value) => String(value) === id ? "" : value);
    if (Array.isArray(building.workerAdmissionOverrideIds)) building.workerAdmissionOverrideIds = building.workerAdmissionOverrideIds.filter((value) => String(value) !== id);
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
    if (Array.isArray(person?.workAllocations)) {
      person.workAllocations = person.workAllocations.filter((row) => String(row?.sourceId ?? "") !== id);
    }
    if (person.staffAppointment?.buildingId === id) delete person.staffAppointment;
  }
  for (const kind of ["goals", "locks", "productionGoals"]) {
    if (Array.isArray(holding?.workforcePlan?.[kind])) {
      holding.workforcePlan[kind] = holding.workforcePlan[kind].filter((row) => String(row?.sourceId ?? "") !== id);
    }
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
  normalized.memberIds = [...new Set(normalized.memberIds.map((id) => String(id ?? "")).filter(Boolean))];
  // A leader is a separate paid position and contributes no worker dice.
  if (normalized.leaderId) normalized.memberIds = normalized.memberIds.filter((id) => id !== normalized.leaderId);
  normalized.distributed = toBoolean(normalized.distributed, false);
  normalized.wageDailyCopper = Math.max(0, Math.floor(toNumber(normalized.wageDailyCopper, 0)));
  normalized.lastConstructionPeriod = Math.max(0, Math.floor(toNumber(normalized.lastConstructionPeriod, 0)));
  normalized.lastConstructionOperationId = String(normalized.lastConstructionOperationId ?? "");
  if (!Array.isArray(normalized.distributedIds)) normalized.distributedIds = [];
  normalized.distributedIds = normalized.distributedIds.map((id) => String(id ?? "")).filter(Boolean);
  normalized.distributedLeaderId = String(normalized.distributedLeaderId ?? "");
  return normalized;
}

export function normalizePerson(person) {
  const legacyTrait = legacyResidentTraitFromSkill(person?.skill);
  person.id = String(person.id || makeId("person"));
  person.name = String(person.name ?? "");
  person.role = String(person.role ?? person.workplace ?? person.work ?? "");
  person.workAssignment = String(person.workAssignment ?? "");
  delete person.skill;
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
  person.traitsText = appendUniqueTrait(
    person.traitsText ?? (Array.isArray(person.traits) ? person.traits.join(", ") : ""),
    legacyTrait
  );
  delete person.workerTypeOverride;
  person.home = String(person.home ?? "");
  person.salary = toNumber(person.salary, 0);
  person.salaryModifier = toNumber(person.salaryModifier, 0);
  person.wageDailyOverrideCopper = person.wageDailyOverrideCopper === null
    || person.wageDailyOverrideCopper === undefined
    || person.wageDailyOverrideCopper === ""
    ? null
    : Math.max(0, Math.floor(toNumber(person.wageDailyOverrideCopper, 0)));
  person.volunteerLabor = toBoolean(person.volunteerLabor, false);
  person.volunteerReason = String(person.volunteerReason ?? "");
  normalizePersonWorkAllocations(person);
  if (person.staffAppointment !== undefined) person.staffAppointment = normalizeStaffAppointment(person.staffAppointment);
  person.maintenancePointsPerTenday = normalizeMaintenancePointsPerTenday(person.maintenancePointsPerTenday);
  if (!isPlainObject(person.attributes)) person.attributes = {};
  for (const key of ["strength", "agility", "wits", "empathy"]) {
    person.attributes[key] = normalizeResidentAttribute(person.attributes[key], 3);
  }
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
