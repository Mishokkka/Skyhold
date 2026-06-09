import { CULTURE_NAMES, CULTURE_PROFILES } from "./name-pools.js";
import { TRAIT_BY_NAME, TRAIT_POOLS, traitBadges } from "./trait-definitions.js";
import {
  ageGroupFromAge,
  ageThresholdsFor,
  clampAgeForRace,
  normalizeBelief,
  raceKeyFromRace,
  representativeAgeForGroup,
  SOCIAL_BACKGROUND_OPTIONS,
  workerTypeFromAttributes
} from "./resident-rules.js";

export const RESIDENT_GENERATOR_OPTIONS = {
  cultures: [
    { value: "current", label: "Текущая зона владения" },
    { value: "random", label: "Случайно" },
    ...CULTURE_NAMES.map((name) => ({ value: name, label: name }))
  ],
  arrivals: [
    { value: "settlers", label: "Переселенцы" },
    { value: "workers", label: "Рабочие" },
    { value: "refugees", label: "Беженцы" },
    { value: "specialists", label: "Специалисты" },
    { value: "crew", label: "Команда корабля" },
    { value: "random", label: "Случайно" }
  ],
  ageModes: [
    { value: "normal", label: "Обычный разброс" },
    { value: "adults", label: "Только взрослые" },
    { value: "families", label: "С семьями" },
    { value: "young", label: "Молодые" }
  ],
  traitModes: [
    { value: "normal", label: "Обычные" },
    { value: "soft", label: "Мягкие" },
    { value: "danger", label: "Опасные" },
    { value: "none", label: "Без черт" }
  ]
};

const BACKGROUNDS = {
  settlers: ["крестьянин", "батрак", "пастух", "садовник", "огородник", "рыбак", "охотник", "сборщик", "пчеловод", "мельник", "пекарь", "повар", "возчик", "лавочник", "слуга", "ученик", "вдовец", "безземельный дворянин"],
  workers: ["каменщик", "плотник", "столяр", "лесоруб", "землекоп", "строитель", "кровельщик", "печник", "грузчик", "такелажник", "шахтер", "рудокоп", "карьерщик", "кузнец", "кожевник", "портной", "водонос", "чернорабочий"],
  refugees: ["беженец", "погорелец", "вдовец", "сирота", "разоренный лавочник", "дезертир", "изгнанник", "беглый должник", "паломник", "нищий", "бывший каторжник", "разжалованный чиновник", "прачка", "горничная"],
  specialists: ["писарь", "счетовод", "архивист", "лекарь", "аптекарь", "механик", "инженер", "чертежник", "учитель", "картограф", "мастеровой", "сакердот", "оружейник", "бронник", "ювелир", "оценщик", "переводчик", "повитуха"],
  crew: ["матрос", "моряк", "канонир", "рулевой", "боцман", "навигатор", "лоцман", "юнга", "кок", "корабельный плотник", "корабельный лекарь", "портовый рабочий", "контрабандист", "дозорный"],
  random: SOCIAL_BACKGROUND_OPTIONS
};

const FACE_BITS = [
  "узкое лицо", "широкое лицо", "резкие скулы", "мягкие черты лица", "крупный нос", "тонкий нос",
  "глубоко посаженные глаза", "прищуренные глаза", "бледное лицо", "смуглая кожа", "веснушки на щеках",
  "выступающий подбородок", "тонкие губы", "сломанный нос", "тяжелые веки", "круглые щеки"
];

const HAIR_BITS = [
  "темные прямые волосы", "светлые волнистые волосы", "рыжие волосы", "седые пряди", "короткие жесткие волосы",
  "густые вьющиеся волосы", "редеющие волосы", "выбритые виски", "густые брови", "тонкие брови",
  "черные спутанные волосы", "светлые редкие волосы", "длинные прямые волосы", "жесткая щетина", "аккуратная борода"
];

const BUILD_BITS = [
  "сухощавое телосложение", "коренастое телосложение", "широкие плечи", "узкие плечи", "высокий рост",
  "низкий рост", "жилистые руки", "крепкие запястья", "сутулая спина", "прямая осанка",
  "мощная шея", "тонкие пальцы", "тяжелая походка", "легкая походка", "непропорционально длинные руки"
];

const MARK_BITS = [
  "шрам на щеке", "шрам над бровью", "родимое пятно у глаза", "следы старых ожогов на руке", "выбитый зуб",
  "сбитые костяшки пальцев", "хромота после старой травмы", "кривоватая улыбка", "рассеченная губа", "слегка мутный глаз",
  "царапины на шее", "неровные ногти", "сломанный палец", "частые синяки на предплечьях", "шероховатая кожа ладоней"
];

export function generateResidents({ quantity = 3, culture = "current", arrival = "settlers", ageMode = "normal", traitMode = "normal", holding = null } = {}) {
  const count = clampNumber(quantity, 1, 20);
  const resolvedCulture = resolveCulture(culture, holding);
  const result = [];

  for (let i = 0; i < count; i += 1) {
    const arrivalKind = arrival === "random" ? pick(["settlers", "workers", "refugees", "specialists", "crew"]) : arrival;
    const actualCulture = resolvedCulture === "random" ? randomCulture() : resolvedCulture;
    result.push(generateResident({ culture: actualCulture, arrival: arrivalKind, ageMode, traitMode }));
  }

  return result;
}

export function generatorOptionSets(config = {}) {
  const withSelected = (items, selected) => items.map((item) => ({ ...item, selected: item.value === selected }));
  return {
    cultures: withSelected(RESIDENT_GENERATOR_OPTIONS.cultures, config.culture ?? "current"),
    arrivals: withSelected(RESIDENT_GENERATOR_OPTIONS.arrivals, config.arrival ?? "settlers"),
    ageModes: withSelected(RESIDENT_GENERATOR_OPTIONS.ageModes, config.ageMode ?? "normal"),
    traitModes: withSelected(RESIDENT_GENERATOR_OPTIONS.traitModes, config.traitMode ?? "normal")
  };
}

function generateResident({ culture, arrival, ageMode, traitMode }) {
  const profile = CULTURE_PROFILES[culture] ?? CULTURE_PROFILES["Нованд"];
  const sex = chance(50) ? "М" : "Ж";
  const firstName = pick(sex === "М" ? profile.male : profile.female);
  const surname = pick(profile.surnames);
  const raceData = rollRace(profile.raceWeights);
  const age = rollAge(ageMode, raceData.race, arrival);
  const ageGroup = ageGroupFromAge(age, raceData.label, raceData.subrace);
  const attributes = rollAttributes(ageGroup, arrival);
  const background = pick(BACKGROUNDS[arrival] ?? BACKGROUNDS.settlers);
  const traits = ageGroup === "Ре" ? [] : rollTraits(traitMode);
  const traitNames = traits.map((trait) => trait.name);
  const belief = normalizeBelief(rollBelief(profile, raceData.race));
  const moraleFromTraits = traits.reduce((sum, trait) => sum + Number(trait.morale || 0), 0);
  const id = `person-${randomId(10)}`;

  return {
    id,
    name: `${firstName} ${surname}`,
    role: arrival === "crew" ? "Свободный член команды" : "Свободен",
    skill: "",
    sex,
    age,
    ageGroup,
    culture,
    belief,
    background,
    race: raceData.label,
    subrace: raceData.subrace,
    salary: defaultSalary(arrival, ageGroup),
    salaryModifier: 0,
    moraleBase: -1,
    moraleWork: 0,
    moraleHome: 0,
    moraleManual: 0,
    moraleDelta: -1 + moraleFromTraits,
    home: "Без жилья",
    attributes,
    traitsText: traitNames.join(", "),
    appearance: buildAppearance(raceData, ageGroup),
    status: "",
    notes: `Сгенерирован: ${arrivalLabel(arrival)}. Возраст: ${age}. Прошлое: ${background}. Верование: ${belief}.`
  };
}

function resolveCulture(culture, holding) {
  if (culture && culture !== "current") return culture;
  const region = String(holding?.overview?.region ?? holding?.overview?.currentRegion ?? holding?.overview?.drift ?? "").trim();
  const found = CULTURE_NAMES.find((key) => region.toLowerCase().includes(key.toLowerCase()));
  if (found) return found;
  return "Нованд";
}

function randomCulture() {
  return pick(CULTURE_NAMES);
}

function rollRace(weights = {}) {
  const pickKey = weightedPick({ human: 80, elf: 12, dwarf: 5, other: 3, ...weights });
  if (pickKey === "human") return { race: "human", label: "Человек", subrace: weightedPick({ "Гвирл": 90, "Конкист": 10 }) };
  if (pickKey === "elf") return { race: "elf", label: "Эльф", subrace: weightedPick({ "Сенхедир": 75, "Аркандар": 25 }) };
  if (pickKey === "dwarf") return { race: "dwarf", label: "Дварф", subrace: weightedPick({ "Висверт": 80, "Галстер": 20 }) };
  return pick([
    { race: "thinOrc", label: "Орк (тонкий)", subrace: "-" },
    { race: "goblin", label: "Гоблин", subrace: "-" },
    { race: "volkolak", label: "Волколак", subrace: "-" }
  ]);
}

function rollAge(mode, raceKey, arrival) {
  const group = rollAgeGroup(mode, raceKey, arrival);
  const t = ageThresholdsFor(raceKey);
  if (group === "Ре") return randomInt(0, Math.max(0, t.young - 1));
  if (group === "Мл") return randomInt(t.young, Math.max(t.young, t.adult - 1));
  if (group === "Ст") return randomInt(t.old, t.max);
  return randomInt(t.adult, Math.max(t.adult, t.old - 1));
}

function rollAgeGroup(mode, raceKey, arrival) {
  if (mode === "adults") return "Вз";
  if (mode === "young") return "Мл";
  if (mode === "families") return weightedPick({ "Ре": 18, "Мл": 20, "Вз": 52, "Ст": 10 });
  if (["workers", "specialists", "crew"].includes(arrival)) return weightedPick({ "Мл": 25, "Вз": 62, "Ст": 13 });
  return weightedPick({ "Ре": 5, "Мл": 20, "Вз": 60, "Ст": 15 });
}

function rollAttributes(ageGroup, arrival) {
  const total = ageGroup === "Мл" ? 15 : ageGroup === "Ст" ? 13 : ageGroup === "Ре" ? 10 : 14;
  const minimum = ageGroup === "Ре" ? 1 : 2;
  const attrs = {
    strength: minimum,
    agility: minimum,
    wits: minimum,
    empathy: minimum
  };

  const preferred = preferredAttributes(arrival);
  const rareSixKey = chance(8) ? pick(["strength", "agility", "wits", "empathy"]) : null;
  let remaining = total - (minimum * 4);
  let guard = 0;

  while (remaining > 0 && guard < 100) {
    guard += 1;
    const key = pickWeightedAttribute(preferred);
    const cap = key === rareSixKey ? 6 : 5;
    if (attrs[key] >= cap) continue;
    attrs[key] += 1;
    remaining -= 1;
  }

  // Если предпочтения слишком часто уперлись в потолок, добиваем любой доступной характеристикой.
  while (remaining > 0) {
    const available = Object.keys(attrs).filter((key) => attrs[key] < (key === rareSixKey ? 6 : 5));
    if (!available.length) break;
    const key = pick(available);
    attrs[key] += 1;
    remaining -= 1;
  }

  return attrs;
}

function preferredAttributes(arrival) {
  if (arrival === "workers") return { strength: 5, agility: 2, wits: 1, empathy: 1 };
  if (arrival === "specialists") return { wits: 5, empathy: 2, agility: 1, strength: 1 };
  if (arrival === "crew") return { agility: 5, strength: 2, wits: 2, empathy: 1 };
  if (arrival === "refugees") return { empathy: 3, agility: 2, wits: 2, strength: 1 };
  return { strength: 1, agility: 1, wits: 1, empathy: 1 };
}

function pickWeightedAttribute(weights) {
  return weightedPick(weights);
}

function rollTraits(mode) {
  if (mode === "none") return [];

  const count = weightedPickNumber({ 0: 45, 1: 44, 2: 10, 3: 1 });
  if (count <= 0) return [];

  let names = [...TRAIT_POOLS.soft, ...TRAIT_POOLS.neutral];
  if (mode === "soft") names = [...TRAIT_POOLS.soft, ...TRAIT_POOLS.soft, ...TRAIT_POOLS.neutral.filter((name) => Number(TRAIT_BY_NAME[name.toLowerCase()]?.morale ?? 0) >= 0)];
  if (mode === "danger") names = [...TRAIT_POOLS.soft, ...TRAIT_POOLS.neutral, ...TRAIT_POOLS.dangerous, ...TRAIT_POOLS.dangerous];
  if (mode === "normal") names = [...TRAIT_POOLS.soft, ...TRAIT_POOLS.neutral, ...TRAIT_POOLS.dangerous];

  const result = [];
  const used = new Set();
  while (result.length < count && used.size < names.length) {
    const name = pick(names);
    if (used.has(name)) continue;
    used.add(name);
    const def = TRAIT_BY_NAME[name.toLowerCase()];
    if (def) result.push(def);
  }
  return result;
}

function rollBelief(profile, race) {
  if (race === "dwarf" && chance(70)) return "Рамбар";
  if (race === "elf" && chance(65)) return "Тримунэлия";
  return weightedPick(profile.beliefs ?? { "Ржавый": 60, "Народные святыни": 20, "Скепсис": 20 });
}

function defaultSalary(arrival, ageGroup) {
  if (ageGroup === "Ре") return 0;
  if (arrival === "specialists") return 10;
  if (arrival === "crew") return 5;
  if (arrival === "workers") return 5;
  return 0;
}

function buildAppearance(raceData, ageGroup) {
  const bits = [pick(FACE_BITS), pick(HAIR_BITS), pick(BUILD_BITS)];
  if (chance(70)) bits.push(pick(MARK_BITS));
  if (raceData.race === "elf") bits.push("удлиненные черты лица");
  if (raceData.race === "dwarf") bits.push("плотная посадка корпуса");
  if (raceData.race === "thinOrc") bits.push("сухая жилистая фигура");
  if (raceData.race === "goblin") bits.push("маленький рост и крупные глаза");
  if (raceData.race === "volkolak") bits.push("звериная пластика и густые волосы");
  if (ageGroup === "Ст") bits.push("глубокие морщины");
  if (ageGroup === "Ре") bits.push("детские округлые черты");
  return Array.from(new Set(bits)).join(", ");
}

function arrivalLabel(value) {
  return RESIDENT_GENERATOR_OPTIONS.arrivals.find((item) => item.value === value)?.label ?? value;
}

function chance(percent) {
  return Math.random() * 100 < percent;
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function weightedPick(weights) {
  const entries = Object.entries(weights).filter(([, weight]) => Number(weight) > 0);
  const total = entries.reduce((sum, [, weight]) => sum + Number(weight), 0);
  let roll = Math.random() * total;
  for (const [key, weight] of entries) {
    roll -= Number(weight);
    if (roll <= 0) return key;
  }
  return entries.at(-1)?.[0];
}

function weightedPickNumber(weights) {
  return Number(weightedPick(weights));
}

function clampNumber(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function randomInt(min, max) {
  const low = Math.ceil(min);
  const high = Math.floor(max);
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

function randomId(length = 10) {
  if (globalThis.foundry?.utils?.randomID) return globalThis.foundry.utils.randomID(length);
  return Math.random().toString(36).slice(2, 2 + length);
}
