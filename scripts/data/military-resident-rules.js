import { ageGroupFromAge } from "../generators/resident-rules.js";
import { isResidentInPopulation } from "./resident-presence.js";

export const COMMANDER_MIN_WITS = 4;
export const DEFENSE_SQUAD_MIN_EFFICIENCY = 5;

const ARMAMENT_SUPPLY = Object.freeze({
  "armament-simple": "military-supplies-simple",
  "armament-complex": "military-supplies-complex",
  "armament-elite": "military-supplies-complex"
});

export function militarySupplyResourceForArmament(resourceId = "") {
  const id = String(resourceId ?? "").trim();
  return Object.hasOwn(ARMAMENT_SUPPLY, id) ? ARMAMENT_SUPPLY[id] : "";
}

export const MILITARY_SQUAD_TYPE_PROFILES = Object.freeze({
  line: {
    label: "Линейная пехота", tag: "Пехота", icon: "fa-solid fa-person-rifle", counterTag: "infantry",
    tags: { infantry: 1 }, attrs: ["strength", "agility"], min: { strength: 3, agility: 3 }, salary: 10,
    note: "СИЛ 3+, ЛОВ 3+", hint: "Универсальный строй. Нужны Сила 3+ и Ловкость 3+. Эффективность идет от Силы и Ловкости."
  },
  fusiliers: {
    label: "Фузилеры", tag: "Огневые", icon: "fa-solid fa-bullseye", counterTag: "shooters",
    tags: { shooters: 1 }, attrs: ["agility"], min: { strength: 3, agility: 4 }, salary: 12,
    note: "стрелки: ЛОВ 4+", hint: "Линейный стрелковый отряд. Нужны Сила 3+ и Ловкость 4+. Эффективность идет от Ловкости."
  },
  jaegers: {
    label: "Егеря", tag: "Егеря", icon: "fa-solid fa-eye", counterTag: "skirmishers",
    tags: { skirmishers: 1 }, attrs: ["agility", "wits"], min: { strength: 3, agility: 4, wits: 3 }, salary: 14,
    note: "застрельщики: ЛОВ 4+, РАЗ 3+", hint: "Легкая пехота, разведчики и охотники. Нужны Сила 3+, Ловкость 4+ и Разум 3+. Эффективность идет от Ловкости и Разума."
  },
  grenadiers: {
    label: "Гренадеры", tag: "Тяжелые", icon: "fa-solid fa-shield-halved", counterTag: "heavy",
    tags: { heavy: 1 }, attrs: ["strength"], min: { strength: 4, agility: 3 }, salary: 14,
    note: "тяжелые: СИЛ 4+", hint: "Отборные штурмовики. Нужны Сила 4+ и Ловкость 3+. Эффективность идет от Силы."
  },
  sappers: {
    label: "Саперы", tag: "Саперы", icon: "fa-solid fa-hammer", counterTag: "sappers",
    tags: { sappers: 1 }, attrs: ["wits"], min: { strength: 3, agility: 3, wits: 4 }, salary: 12,
    note: "саперы: РАЗ 4+", hint: "Инженерный отряд. Нужны Сила 3+, Ловкость 3+ и Разум 4+. Эффективность идет от Разума."
  },
  artillery: {
    label: "Артиллерийская команда", tag: "Осадные", icon: "fa-solid fa-tower-observation", counterTag: "siege",
    tags: { siege: 1 }, attrs: ["wits"], min: { strength: 3, agility: 3, wits: 4 }, salary: 15,
    note: "осадные: РАЗ 4+", hint: "Расчет тяжелого оружия. Нужны Сила 3+, Ловкость 3+ и Разум 4+. Эффективность идет от Разума."
  },
  cavalry: {
    label: "Драгуны / конные", tag: "Мобильные", icon: "fa-solid fa-horse", counterTag: "mobile",
    tags: { mobile: 1 }, attrs: ["agility"], min: { strength: 3, agility: 4 }, salary: 16,
    note: "мобильность: ЛОВ 4+", hint: "Быстрый отряд для вылазок и погони. Нужны Сила 3+ и Ловкость 4+. Эффективность идет от Ловкости."
  },
  militia: {
    label: "Ополчение", tag: "Ополчение", icon: "fa-solid fa-people-group", counterTag: "infantry",
    tags: { infantry: 1 }, attrs: ["strength", "agility"], min: {}, salary: 0,
    note: "виртуальный гражданский отряд", hint: "Временный гражданский отряд без профессионального допуска."
  }
});

export const MANAGER_SQUAD_TYPE_PROFILES = Object.freeze(Object.fromEntries(
  Object.entries(MILITARY_SQUAD_TYPE_PROFILES).filter(([type]) => type !== "militia")
));

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function militarySquadTypeProfile(type = "line") {
  return MILITARY_SQUAD_TYPE_PROFILES[String(type)] ?? MILITARY_SQUAD_TYPE_PROFILES.line;
}

export function residentSuitableForSquadType(attributes = {}, type = "line") {
  const profile = militarySquadTypeProfile(type);
  return Object.entries(profile.min ?? {}).every(([key, minimum]) => number(attributes?.[key], 0) >= number(minimum, 0));
}

export function residentSoldierEfficiency(attributes = {}, type = "line", { militaryBackground = false } = {}) {
  if (!residentSuitableForSquadType(attributes, type)) return 0;
  const profile = militarySquadTypeProfile(type);
  const keys = Array.isArray(profile.attrs) && profile.attrs.length ? profile.attrs : ["strength", "agility"];
  let value = 1;
  for (const key of keys) {
    const score = number(attributes?.[key], 0);
    value += score >= 5 ? 0.25 : score >= 4 ? 0.15 : 0;
  }
  if (militaryBackground) value += 0.10;
  return Math.min(1.7, Math.round(value * 100) / 100);
}

export function hasMilitaryServiceBackground(person = {}) {
  return /(солдат|ветеран|на[её]мник|страж|сторож|дозор|егерь|дезертир|канонир|артиллер|сап[её]р|тюремщик|палач|телохранитель|ополчен|мушкет|развед)/i.test(String(person.background ?? ""));
}

export function hasSergeantTraining(person = {}) {
  const attrs = person.attributes ?? {};
  return hasMilitaryServiceBackground(person)
    && [attrs.strength, attrs.agility, attrs.wits, attrs.empathy].some((value) => number(value) >= 5);
}

export function isAvailableDefenseResident(person, holding) {
  if (!person || !isResidentInPopulation(person, holding) || number(person.injuredDays) > 0) return false;
  if (!Object.hasOwn(person, "injuredDays") && /ранен|тяжело|сломлен|injured|wound/i.test(String(person.status ?? ""))) return false;
  const ageGroup = person.ageGroup ?? (person.age == null ? "" : ageGroupFromAge(person.age, person.race, person.subrace));
  return ageGroup !== "Ре";
}

/** The defense roster and the battle use one calculation, without loading the battle window. */
export function evaluateDefenseSquad(squad, availablePeopleById, { supplied = false } = {}) {
  const first = String(squad.sergeantId ?? "");
  const members = Array.isArray(squad.memberIds) ? squad.memberIds : [];
  const ids = new Set([first, ...members.slice(0, 4).map((id) => String(id ?? ""))].filter(Boolean));
  const type = squad.type === "militia" ? "line" : squad.type;
  const combatants = [];
  let base = 0;
  let sergeantBonus = 0;
  for (const id of ids) {
    const person = availablePeopleById.get(id);
    if (!person) continue;
    const efficiency = residentSoldierEfficiency(person.attributes, type, { militaryBackground: hasMilitaryServiceBackground(person) });
    if (efficiency <= 0) continue;
    combatants.push(person);
    base += efficiency;
    if (id === first && hasSergeantTraining(person)) sergeantBonus = 0.10;
  }
  const effective = Math.round(base * (1 + sergeantBonus) * (supplied ? 1.20 : 1) * 100) / 100;
  return { combatants, effective, sergeantBonus, ready: effective >= DEFENSE_SQUAD_MIN_EFFICIENCY };
}
