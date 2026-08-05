import { ageGroupFromAge } from "../../generators/resident-rules.js";
import { asNumber } from "./rules.js";

function round2(value) {
  return Math.round(asNumber(value, 0) * 100) / 100;
}

export function personText(person = {}) {
  return [person.role, person.skill, person.background, person.traitsText, person.traits, person.status, person.notes, person.workerTypeLabel, person.type]
    .map((value) => String(value ?? "").toLowerCase())
    .join(" ");
}

export function personAssignmentText(person = {}) {
  return [person.workAssignment, person.role, person.skill, person.status]
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
  const text = `${person?.background ?? ""} ${person?.role ?? ""} ${person?.skill ?? ""}`.toLowerCase();
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
  return asNumber(attrs.wits, 0) >= 4 && (isMilitaryBackgroundResident(person) || isSoldierResident(person));
}

export function squadTypeProfile(type = "line") {
  const profiles = {
    line: { label: "Линейная пехота", tags: { infantry: 1 }, attrs: ["strength", "agility"], min: { strength: 3, agility: 3 }, salary: 10, note: "СИЛ 3+, ЛОВ 3+" },
    fusiliers: { label: "Фузилеры", tags: { shooters: 1 }, attrs: ["agility"], min: { strength: 3, agility: 4 }, salary: 12, note: "стрелки: ЛОВ 4+" },
    jaegers: { label: "Егеря", tags: { skirmishers: 1 }, attrs: ["agility", "wits"], min: { strength: 3, agility: 4, wits: 3 }, salary: 14, note: "застрельщики: ЛОВ 4+, РАЗ 3+" },
    grenadiers: { label: "Гренадеры", tags: { heavy: 1 }, attrs: ["strength", "agility"], min: { strength: 4, agility: 3 }, salary: 14, note: "тяжелые: СИЛ 4+" },
    sappers: { label: "Саперы", tags: { sappers: 1 }, attrs: ["wits", "strength"], min: { strength: 3, agility: 3, wits: 4 }, salary: 12, note: "саперы: РАЗ 4+" },
    artillery: { label: "Артиллерийская команда", tags: { siege: 1 }, attrs: ["wits"], min: { strength: 3, agility: 3, wits: 4 }, salary: 15, note: "осадные: РАЗ 4+" },
    cavalry: { label: "Драгуны / конные", tags: { mobile: 1 }, attrs: ["agility"], min: { strength: 3, agility: 4 }, salary: 16, note: "мобильность: ЛОВ 4+" },
    militia: { label: "Ополчение", tags: { infantry: 1 }, attrs: ["strength", "agility"], min: {}, salary: 0, note: "виртуальный гражданский отряд" }
  };
  return profiles[String(type)] ?? profiles.line;
}

export function isSuitableForSquadType(person = {}, type = "line") {
  const profile = squadTypeProfile(type);
  const attrs = person?.attributes && typeof person.attributes === "object" ? person.attributes : {};
  for (const [key, min] of Object.entries(profile.min ?? {})) {
    if (asNumber(attrs[key], 0) < asNumber(min, 0)) return false;
  }
  return true;
}

export function soldierEfficiency(person = {}, type = "line") {
  if (!isSuitableForSquadType(person, type)) return 0;
  const attrs = person?.attributes && typeof person.attributes === "object" ? person.attributes : {};
  const profile = squadTypeProfile(type);
  const keys = Array.isArray(profile.attrs) && profile.attrs.length ? profile.attrs : ["strength", "agility"];
  let value = 1;
  for (const key of keys) {
    const score = asNumber(attrs[key], 0);
    value += score >= 5 ? 0.25 : score >= 4 ? 0.15 : 0;
  }
  if (isMilitaryBackgroundResident(person)) value += 0.10;
  return Number.isFinite(Number(value)) ? Math.min(1.7, round2(value)) : 0;
}
