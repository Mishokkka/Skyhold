export const COMMANDER_MIN_WITS = 4;

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
