import { toNumber } from "../data/utils.js";

export const ATTRIBUTE_META = {
  strength: { short: "С", label: "Сила", color: "rgba(156, 49, 43, 0.92)" },
  agility: { short: "Л", label: "Ловкость", color: "rgba(47, 122, 75, 0.92)" },
  wits: { short: "Р", label: "Разум", color: "rgba(48, 90, 170, 0.92)" },
  empathy: { short: "Э", label: "Эмпатия", color: "rgba(178, 67, 159, 0.92)" }
};

export const ATTRIBUTE_ORDER = ["strength", "agility", "wits", "empathy"];

export const AGE_THRESHOLDS = {
  human: { young: 18, adult: 30, old: 55, max: 70 },
  elf: { young: 18, adult: 30, old: 90, max: 200 },
  dwarf: { young: 30, adult: 60, old: 100, max: 130 },
  thinOrc: { young: 10, adult: 20, old: 30, max: 40 },
  goblin: { young: 10, adult: 20, old: 30, max: 40 },
  volkolak: { young: 15, adult: 25, old: 40, max: 50 }
};

export const AGE_GROUP_LABELS = {
  "Ре": "Ребенок",
  "Мл": "Молодой",
  "Вз": "Взрослый",
  "Ст": "Старый"
};

export function raceKeyFromResident(person = {}) {
  return raceKeyFromRace(person.race, person.subrace);
}

export function raceKeyFromRace(race = "", subrace = "") {
  const raw = `${race} ${subrace}`.toLowerCase();
  if (raw.includes("эльф")) return "elf";
  if (raw.includes("дварф")) return "dwarf";
  if (raw.includes("гоблин")) return "goblin";
  if (raw.includes("волколак")) return "volkolak";
  if (raw.includes("орк")) return "thinOrc";
  return "human";
}

export function ageThresholdsFor(raceKey = "human") {
  return AGE_THRESHOLDS[raceKey] ?? AGE_THRESHOLDS.human;
}

export function clampAgeForRace(age, race = "", subrace = "") {
  const key = raceKeyFromRace(race, subrace);
  const t = ageThresholdsFor(key);
  const parsed = Number(age);
  if (!Number.isFinite(parsed)) return t.adult;
  return Math.max(0, Math.min(t.max, Math.floor(parsed)));
}

export function ageGroupFromAge(age, race = "", subrace = "") {
  const key = raceKeyFromRace(race, subrace);
  const t = ageThresholdsFor(key);
  const value = clampAgeForRace(age, race, subrace);
  if (value < t.young) return "Ре";
  if (value < t.adult) return "Мл";
  if (value < t.old) return "Вз";
  return "Ст";
}

export function representativeAgeForGroup(group = "Вз", race = "", subrace = "") {
  const key = raceKeyFromRace(race, subrace);
  const t = ageThresholdsFor(key);
  if (group === "Ре") return Math.max(0, Math.floor(t.young * 0.65));
  if (group === "Мл") return t.young;
  if (group === "Ст") return t.old;
  return t.adult;
}

export function attributeSummary(attrs = {}) {
  const rawValues = ATTRIBUTE_ORDER.map((key) => toNumber(attrs[key], 0));
  if (rawValues.every((value) => value <= 0)) return "Характеристики не заданы";
  return ATTRIBUTE_ORDER.map((key) => `${ATTRIBUTE_META[key].short}${toNumber(attrs[key], 0)}`).join(" · ");
}

export function outstandingAttributeKeys(attrs = {}) {
  return ATTRIBUTE_ORDER.filter((key) => toNumber(attrs[key], 0) >= 5);
}

export function workerTypeFromAttributes(attrs = {}) {
  const keys = outstandingAttributeKeys(attrs);
  if (!keys.length) return "Разнорабочий";

  const id = keys.join("+");
  const labels = {
    strength: "Силач",
    agility: "Ловкач",
    wits: "Умелец",
    empathy: "Переговорщик",
    "strength+agility": "Строитель",
    "strength+wits": "Механик",
    "strength+empathy": "Бригадир",
    "agility+wits": "Ремесленник",
    "agility+empathy": "Посыльный",
    "wits+empathy": "Управленец",
    "strength+agility+wits": "Мастеровой",
    "agility+wits+empathy": "Агент",
    "strength+wits+empathy": "Старшина",
    "strength+agility+empathy": "Полевой вожак",
    "strength+agility+wits+empathy": "Мастер на все руки"
  };
  return labels[id] ?? "Универсал";
}


export const SOCIAL_BACKGROUND_OPTIONS = [
  "крестьянин", "батрак", "пастух", "садовник", "огородник", "виноградарь", "рыбак", "охотник", "сборщик", "пчеловод", "травник", "водонос", "молочник", "сыровар", "скотник", "коновал",
  "мельник", "пекарь", "повар", "кок", "трактирщик", "пивовар", "мясник", "коптильщик", "солильщик", "кладовщик припасов",
  "лесоруб", "плотник", "столяр", "каменщик", "землекоп", "строитель", "кровельщик", "печник", "чернорабочий", "грузчик", "возчик", "такелажник", "канатчик", "дорожник", "мостовщик",
  "шахтер", "рудокоп", "каменотес", "карьерщик", "плавильщик", "углежог", "кузнец", "оружейник", "бронник", "слесарь", "жестянщик", "литейщик", "кожевник", "сапожник", "портной", "ткач", "красильщик", "гончар", "стеклодув", "ювелир", "резчик", "переплетчик",
  "ремесленник", "мастеровой", "механик", "инженер", "часовщик", "приборист", "чертежник", "ученик", "подмастерье", "лаборант", "изобретатель-самоучка",
  "писарь", "счетовод", "архивист", "картограф", "учитель", "гувернер", "переводчик", "вестовой", "почтальон", "лавочник", "мелкий торговец", "торговец", "коммивояжер", "меняла", "ростовщик", "оценщик", "аукционист",
  "банщик", "лекарь", "цирюльник", "повитуха", "аптекарь", "костоправ", "сиделка", "санитар", "гробовщик", "жрец", "сакердот", "паломник", "могильщик", "певчий", "храмовый служка", "еретик",
  "солдат", "ветеран", "наемник", "сторож", "дозорный", "егерь", "дезертир", "канонир", "сапер", "тюремщик", "палач", "телохранитель", "ополченец", "мушкетер", "разведчик",
  "матрос", "моряк", "рулевой", "боцман", "навигатор", "лоцман", "юнга", "портовый рабочий", "крановщик", "контрабандист", "корабельный плотник", "корабельный лекарь",
  "слуга", "дворецкий", "горничная", "кучер", "садовый сторож", "прачка", "няня", "домоправитель", "курьер", "посыльный", "ночной сторож",
  "нищий", "сирота", "вдовец", "погорелец", "беженец", "изгнанник", "беглый должник", "разоренный лавочник", "бывший каторжник", "амнистированный", "безземельный дворянин", "разжалованный чиновник",
  "вор", "карманник", "мошенник", "скупщик краденого", "бродяга", "игрок", "артист", "музыкант", "актер", "фокусник", "акробат", "шут", "уличный рассказчик"
];

export function socialBackgroundOptions(current = "") {
  const selected = String(current ?? "").trim();
  const collator = new Intl.Collator("ru", { sensitivity: "base" });
  const sorted = [...SOCIAL_BACKGROUND_OPTIONS].sort((a, b) => collator.compare(a, b));
  const options = ["", ...sorted].map((value) => ({
    value,
    label: value || "Не указано",
    selected: value === selected
  }));
  if (selected && !options.some((item) => item.value === selected)) options.push({ value: selected, label: `${selected} (свое)`, selected: true });
  return options;
}

export const SPECIAL_SKILL_DEFINITIONS = [
  { value: "", label: "Нет", description: "Спецнавык не задан." },
  { value: "Builder", label: "Builder / Строитель", description: "Профессиональный строитель. Выполняет требования Builder и помогает сложным проектам." },
  { value: "Trader", label: "Trader / Торговец", description: "Умеет торговаться, вести лавку и продавать товары поселения." },
  { value: "Scribe", label: "Scribe / Писарь", description: "Грамота, учет, архивы, библиотека, скрипторий и администрация." },
  { value: "Healer", label: "Healer / Лекарь", description: "Лечение, баня, санитария и уход за больными." },
  { value: "Priest", label: "Priest / Жрец", description: "Культовые здания, погребальные практики, святилища и обряды." },
  { value: "Guard", label: "Guard / Стражник", description: "Оборона, охрана складов, башни, темницы и военная дисциплина." },
  { value: "Sailor", label: "Sailor / Моряк", description: "Пирсы, маяки, корабли, снабжение и навигация." },
  { value: "Engineer", label: "Engineer / Механик", description: "Механизмы, сложные мастерские, генераторы и техническая инфраструктура." }
];

export function specialSkillOptions(current = "") {
  const selected = String(current ?? "").trim();
  const normalized = selected.toLowerCase();
  const options = SPECIAL_SKILL_DEFINITIONS.map((skill) => ({
    ...skill,
    selected: String(skill.value).toLowerCase() === normalized || String(skill.label).toLowerCase() === normalized
  }));
  if (selected && !options.some((item) => item.selected)) options.push({ value: selected, label: selected, description: "Пользовательский спецнавык.", selected: true });
  return options;
}

export function specialSkillDescription(value = "") {
  const raw = String(value ?? "").trim().toLowerCase();
  return SPECIAL_SKILL_DEFINITIONS.find((skill) => String(skill.value).toLowerCase() === raw || String(skill.label).toLowerCase() === raw)?.description ?? "Пользовательский спецнавык.";
}

export function workerTypeStyleFromAttributes(attrs = {}) {
  const keys = outstandingAttributeKeys(attrs);
  if (!keys.length) return "";
  if (keys.length === 1) return `background: ${ATTRIBUTE_META[keys[0]].color}; color: #f4f0e8;`;

  const stops = keys.map((key, index) => {
    const pct = keys.length === 1 ? 0 : Math.round((index / (keys.length - 1)) * 100);
    return `${ATTRIBUTE_META[key].color} ${pct}%`;
  }).join(", ");

  return `background: linear-gradient(90deg, ${stops}); color: #f4f0e8;`;
}

export function normalizeBelief(value = "") {
  const raw = String(value ?? "").trim();
  const low = raw.toLowerCase();
  if (!raw) return "";
  if (low.includes("млад")) return "Младой";
  if (low.includes("ржав")) return "Ржавый";
  if (low === "стальная вера" || low.includes("стальн")) return "Ржавый";
  return raw;
}
