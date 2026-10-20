import { ageGroupFromAge } from "../../generators/resident-rules.js";
import {
  COMMANDER_MIN_WITS,
  militarySquadTypeProfile,
  residentSoldierEfficiency,
  residentSuitableForSquadType
} from "../../data/military-resident-rules.js";
import { asNumber } from "./rules.js";

export function personText(person = {}) {
  return [person.role, person.background, person.traitsText, person.traits, person.status, person.notes, person.workerTypeLabel, person.type]
    .map((value) => String(value ?? "").toLowerCase())
    .join(" ");
}

export function personAssignmentText(person = {}) {
  return [person.workAssignment, person.role, person.status]
    .map((value) => String(value ?? "").toLowerCase())
    .join(" ");
}

export function isInjuredResident(person = {}) {
  const hasExplicitCounter = Object.hasOwn(person ?? {}, "injuredDays");
  const days = asNumber(person?.injuredDays, 0);
  if (days > 0) return true;
  if (hasExplicitCounter) return false;
  return /ранен|тяжело|сломлен|injured|wound/i.test(String(person?.status ?? ""));
}

export function isAdultResident(person) {
  if (!person || person.dead || isInjuredResident(person)) return false;
  const group = String(person.ageGroup ?? ageGroupFromAge(person.age, person.race, person.subrace) ?? "");
  return group && group !== "Ре";
}

export function isMilitaryResident(person = {}) {
  const text = `${personAssignmentText(person)} ${personText(person)}`;
  if (String(person?.workAssignment ?? "") === "soldier") return true;
  return /(guard|soldier|veteran|mercenary|militia|ranger|scout|musketeer|gunner|sapper|warden|bodyguard|страж|солдат|ветеран|наемник|наёмник|ополчен|дозор|егерь|разведчик|мушкетер|мушкетёр|канонир|сап[её]р|тюремщик|телохранитель|охран)/i.test(text);
}

export function hasResidentWords(person = {}, pattern) {
  return pattern.test(personText(person));
}

export function residentCombatTrait(person = {}) {
  const attrs = person?.attributes && typeof person.attributes === "object" ? person.attributes : {};
  const strength = asNumber(attrs.strength, 0);
  const agility = asNumber(attrs.agility, 0);
  const wits = asNumber(attrs.wits, 0);
  return {
    military: isMilitaryResident(person) ? 1 : 0,
    strong: strength >= 5 || agility >= 5 ? 1 : 0,
    competent: strength >= 4 || agility >= 4 || wits >= 4 ? 1 : 0
  };
}

export function isSoldierResident(person = {}) {
  const attrs = person?.attributes && typeof person.attributes === "object" ? person.attributes : {};
  const strongEnough = asNumber(attrs.strength, 0) >= 3 && asNumber(attrs.agility, 0) >= 3;
  if (!strongEnough) return false;
  return /(солдат|страж|гвард|мушкет[её]р|фузил[её]р|егерь|ветеран|наемник|наёмник|канонир|артиллер|сап[её]р|guard|soldier|musketeer|fusilier|jaeger|rifle|veteran|mercenary|gunner|sapper)/i.test(personText(person)) || isMilitaryResident(person);
}

export function isMilitaryBackgroundResident(person = {}) {
  const text = `${person?.background ?? ""} ${person?.role ?? ""} ${person?.traitsText ?? person?.traits ?? ""}`.toLowerCase();
  return /(солдат|ветеран|на[её]мник|страж|сторож|дозор|егерь|дезертир|канонир|артиллер|сап[её]р|тюремщик|палач|телохранитель|ополчен|мушкет|развед|офицер|сержант)/i.test(text);
}

export function isSergeantCandidate(person = {}) {
  if (!isSoldierResident(person) || isInjuredResident(person) || person?.dead) return false;
  const attrs = person?.attributes && typeof person.attributes === "object" ? person.attributes : {};
  return isMilitaryBackgroundResident(person) && [attrs.strength, attrs.agility, attrs.wits, attrs.empathy].some((value) => asNumber(value, 0) >= 5);
}

export function isCommanderCandidate(person = {}) {
  if (isInjuredResident(person) || person?.dead) return false;
  const attrs = person?.attributes && typeof person.attributes === "object" ? person.attributes : {};
  return asNumber(attrs.wits, 0) >= COMMANDER_MIN_WITS && (isMilitaryBackgroundResident(person) || isSoldierResident(person));
}

export function squadTypeProfile(type = "line") {
  return militarySquadTypeProfile(type);
}

export function isSuitableForSquadType(person = {}, type = "line") {
  const attrs = person?.attributes && typeof person.attributes === "object" ? person.attributes : {};
  return residentSuitableForSquadType(attrs, type);
}

export function soldierEfficiency(person = {}, type = "line") {
  const attrs = person?.attributes && typeof person.attributes === "object" ? person.attributes : {};
  return residentSoldierEfficiency(attrs, type, { militaryBackground: isMilitaryBackgroundResident(person) });
}
