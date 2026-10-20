import { residentShipAssignment } from "../../data/resident-presence.js";
import { ageGroupFromAge, ageThresholdsFor, raceKeyFromResident } from "../../generators/resident-rules.js";
import { getShipProfile } from "./profiles.js";
import { isMagnifiqueShip } from "./crew-roster.js";
import { laborWageRate } from "../economy/labor-wage-rate.js";

function text(value = "") {
  return String(value ?? "").trim();
}

function count(value, fallback = 0) {
  const parsed = Number(value);
  return Math.max(0, Math.floor(Number.isFinite(parsed) ? parsed : fallback));
}

function requiredCrew(ship, issues) {
  const explicit = Number(ship?.crewTarget);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  try {
    return count(getShipProfile(ship?.profileId).crewTarget);
  } catch (_error) {
    issues.push({ code: "profile", message: "Не удалось определить требуемую численность команды: у корабля нет известного профиля." });
    return 0;
  }
}

function childWorkThreshold(person) {
  const thresholds = ageThresholdsFor(raceKeyFromResident(person));
  return Math.min(Math.max(0, Math.floor(Number(thresholds?.young) || 18) - 1), 12);
}

function residentAgeGroup(person) {
  return text(person?.ageGroup) || ageGroupFromAge(person?.age, person?.race, person?.subrace);
}

function assignmentLabels(holding, residentId, person) {
  const labels = [];
  const work = text(person?.workAssignment);
  if (work && !["Свободен", "Без работы", "Ребенок"].includes(work)) labels.push(`работа: ${work}`);
  if (Array.isArray(person?.workAllocations) && person.workAllocations.length) labels.push(`план работ: ${person.workAllocations.length}`);

  for (const building of holding?.buildings?.list ?? []) {
    const slots = (building?.assignedWorkerIds ?? []).filter((id) => text(id) === residentId).length;
    if (slots) labels.push(`здание «${text(building?.name || building?.id) || "без названия"}»`);
    if ((building?.workerAdmissionOverrideIds ?? []).some((id) => text(id) === residentId)) {
      labels.push(`допуск: «${text(building?.name || building?.id) || "здание"}»`);
    }
  }

  for (const crew of holding?.constructionCrews ?? []) {
    const crewName = text(crew?.name || crew?.id) || "строительная бригада";
    const leader = text(crew?.leaderId) === residentId || text(crew?.distributedLeaderId) === residentId;
    const member = (crew?.memberIds ?? []).some((id) => text(id) === residentId)
      || (crew?.distributedIds ?? []).some((id) => text(id) === residentId);
    if (leader) labels.push(`руководит стройкой «${crewName}»`);
    else if (member) labels.push(`стройка «${crewName}»`);
  }
  if ((holding?.constructionCrewIds ?? []).some((id) => text(id) === residentId)) labels.push("старая строительная бригада");

  const defense = holding?.gm?.defense ?? {};
  if (text(defense?.commanderId) === residentId) labels.push("командование обороной");
  for (const squad of defense?.squads ?? []) {
    const squadName = text(squad?.name || squad?.id) || "отряд";
    if (text(squad?.sergeantId) === residentId) labels.push(`командует отрядом «${squadName}»`);
    else if ((squad?.memberIds ?? []).some((id) => text(id) === residentId)) labels.push(`отряд «${squadName}»`);
  }
  return [...new Set(labels)];
}

/**
 * Resolve the effective crew without mutating the holding. A declared linked
 * resident always occupies their slot, even when missing or unfit, so an
 * abstract sailor cannot silently conceal a broken roster reference.
 */
export function shipCrewComposition(holding = {}, ship = {}, { catalog } = {}) {
  void catalog;
  const issues = [];
  const warnings = [];
  const shipId = text(ship?.id);
  if (!shipId) issues.push({ code: "ship-id", message: "У корабля отсутствует устойчивый ID." });

  const declaredIds = Array.isArray(ship?.crewResidentIds) ? ship.crewResidentIds.map(text) : [];
  const emptyCount = declaredIds.filter((id) => !id).length;
  if (emptyCount) issues.push({ code: "resident-id", message: `В составе команды ${emptyCount} пустых ссылок на жителей.` });
  const residentIds = declaredIds.filter(Boolean);
  const duplicateIds = [...new Set(residentIds.filter((id, index) => residentIds.indexOf(id) !== index))];
  for (const residentId of duplicateIds) {
    issues.push({ code: "duplicate-resident", residentId, message: `Житель ${residentId} указан в составе команды больше одного раза.` });
  }
  const uniqueIds = [...new Set(residentIds)];
  const peopleById = new Map();
  const duplicatePeopleIds = new Set();
  for (const person of holding?.people?.list ?? []) {
    const residentId = text(person?.id);
    if (!residentId) continue;
    if (peopleById.has(residentId)) duplicatePeopleIds.add(residentId);
    else peopleById.set(residentId, person);
  }
  for (const residentId of duplicatePeopleIds) {
    if (uniqueIds.includes(residentId)) {
      issues.push({ code: "duplicate-resident-record", residentId, message: `В поселении найдено несколько жителей с ID ${residentId}; состав команды неоднозначен.` });
    }
  }

  const entries = uniqueIds.map((residentId) => {
    const person = peopleById.get(residentId);
    if (!person) {
      issues.push({ code: "missing", residentId, message: `Житель ${residentId} отсутствует в поселении.` });
      return { residentId, person: null, living: false, fit: false, assignments: [] };
    }
    const name = text(person?.name) || residentId;
    const assignment = residentShipAssignment(person);
    const dead = person?.dead === true;
    const injured = count(person?.injuredDays) > 0;
    const awayOther = assignment?.away === true && text(assignment.shipId) !== shipId;
    const ageGroup = residentAgeGroup(person);
    const age = Number(person?.age);
    const underage = ageGroup === "Ре" && (!Number.isFinite(age) || age < childWorkThreshold(person));
    if (dead) issues.push({ code: "dead", residentId, message: `${name}: погибший житель числится в экипаже.` });
    if (!dead && injured) issues.push({ code: "injured", residentId, message: `${name}: ранение не позволяет выйти в новый рейс.` });
    if (!dead && awayOther) issues.push({ code: "away-other-ship", residentId, message: `${name}: уже находится на другом корабле.` });
    if (!dead && underage) issues.push({ code: "underage", residentId, message: `${name}: возраст не позволяет работать в составе команды.` });
    const wage = laborWageRate({ volunteer: person.volunteerLabor, wageOverrideCopper: person.wageDailyOverrideCopper, dailyRateCopper: 12 });
    if (!dead && !wage.ok) issues.push({ code: "wage-rate", residentId, message: `${name}: укажите положительное дневное жалование или явно включите добровольный труд.` });
    return {
      residentId,
      person,
      living: !dead,
      fit: !dead && !injured && !awayOther && !underage,
      assignments: []
    };
  });

  const requiredCount = requiredCrew(ship, issues);
  const isNamedRoster = isMagnifiqueShip(ship) || Number(ship?.magnifiqueCrewRoster?.version) > 0;
  const abstractCount = isNamedRoster ? 0 : Math.max(0, requiredCount - uniqueIds.length);
  const linkedCount = entries.filter((entry) => entry.person).length;
  const livingLinkedCount = entries.filter((entry) => entry.living).length;
  const fitLinkedCount = entries.filter((entry) => entry.fit).length;
  const totalCount = livingLinkedCount + abstractCount;
  const readyCount = fitLinkedCount + abstractCount;
  if (abstractCount > 0) warnings.push({ code: "abstract-crew", message: `${abstractCount} членов команды пока учитываются без именных жителей.` });
  if (uniqueIds.length > requiredCount) warnings.push({ code: "crew-over-target", message: `Связанных членов команды больше штатной численности: ${uniqueIds.length} из ${requiredCount}.` });
  if (readyCount < requiredCount) {
    issues.push({ code: "crew-shortfall", message: `К выходу готовы ${readyCount} из ${requiredCount} требуемых членов команды.` });
  }

  return {
    shipId,
    isNamedRoster,
    requiredCount,
    linkedCount,
    livingLinkedCount,
    fitLinkedCount,
    abstractCount,
    readyCount,
    totalCount,
    residents: entries.filter((entry) => entry.person).map((entry) => entry.person),
    entries,
    issues,
    warnings
  };
}

export function shipCrewReadiness(holding = {}, ship = {}, { catalog } = {}) {
  const composition = shipCrewComposition(holding, ship, { catalog });
  const departingAssignments = composition.entries
    .map((entry) => ({ ...entry, assignments: entry.person ? assignmentLabels(holding, entry.residentId, entry.person) : [] }))
    .filter((entry) => entry.fit && entry.assignments.length)
    .map((entry) => ({
      residentId: entry.residentId,
      name: text(entry.person?.name) || entry.residentId,
      label: entry.assignments.join("; ")
    }));
  return {
    ready: composition.issues.length === 0 && composition.readyCount >= composition.requiredCount,
    issues: composition.issues,
    warnings: composition.warnings,
    linkedCount: composition.linkedCount,
    readyCount: composition.readyCount,
    abstractCount: composition.abstractCount,
    requiredCount: composition.requiredCount,
    totalCount: composition.totalCount,
    departingAssignments
  };
}
