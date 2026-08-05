import { clone, isPlainObject, makeId, toBoolean, toNumber } from "./utils.js";
import { normalizeRandomEventEffects } from "./random-event-effects.js";
import { buildingOperationalState } from "../core/building-state.js";

export const RANDOM_EVENT_TABLE_KINDS = ["general", "external"];

const LEGACY_RARITY_WEIGHT = {
  common: 8,
  uncommon: 4,
  rare: 2,
  legendary: 1
};
const RANDOM_EVENT_TABLE_VERSION = 7;

export const EVENT_DEVELOPMENT_THRESHOLD_KEYS = [
  { key: "food", label: "Еда", lowTag: "low-food", highTag: "high-food" },
  { key: "technology", label: "Технология", lowTag: "low-technology", highTag: "high-technology" },
  { key: "culture", label: "Культура", lowTag: "low-culture", highTag: "high-culture" },
  { key: "war", label: "Война", lowTag: "low-war", highTag: "high-war" }
];

export const EVENT_THRESHOLD_KEYS = [
  ...EVENT_DEVELOPMENT_THRESHOLD_KEYS,
  { key: "population", label: "Население", lowTag: "low-population", highTag: "high-population", lowMax: 5, highMin: 15 },
  { key: "morale", label: "Довольство", lowTag: "low-morale", highTag: "high-morale", lowMax: -0.001, highMin: 1.501 },
  { key: "reputation", label: "Репутация", lowTag: "low-reputation", highTag: "high-reputation", lowMax: 0, highMin: 3 }
];

export const DEFAULT_EVENT_TAG_THRESHOLDS = Object.freeze(Object.fromEntries(
  EVENT_THRESHOLD_KEYS.map(({ key, lowMax = 0, highMin = 3 }) => [key, { lowMax, highMin }])
));


export const EVENT_REQUIREMENT_LOGIC_OPTIONS = [
  { value: "all", label: "Все условия", shortLabel: "И", description: "Событие доступно, только если выполнено каждое условие." },
  { value: "any", label: "Любое условие", shortLabel: "ИЛИ", description: "Событие доступно, если выполнено хотя бы одно условие." },
  { value: "none", label: "Ни одно условие", shortLabel: "НЕ", description: "Событие доступно, только если не выполнено ни одно условие." }
];

export const EVENT_REQUIREMENT_OPERATOR_OPTIONS = [
  { value: "present", label: "есть" },
  { value: "absent", label: "нет" },
  { value: "is", label: "равно" },
  { value: "is-not", label: "не равно" },
  { value: "contains", label: "содержит" },
  { value: "not-contains", label: "не содержит" },
  { value: "gte", label: "≥" },
  { value: "lte", label: "≤" },
  { value: "gt", label: ">" },
  { value: "lt", label: "<" },
  { value: "eq", label: "=" },
  { value: "neq", label: "≠" }
];

export const EVENT_REQUIREMENT_TYPE_OPTIONS = [
  { value: "feature", label: "Признак поселения", category: "Поселение", valueKind: "feature", defaultOperator: "present", operators: ["present", "absent"] },
  { value: "holding-type", label: "Тип владения", category: "Поселение", valueKind: "holding-type", defaultOperator: "is", operators: ["is", "is-not"] },
  { value: "population", label: "Живые жители", category: "Поселение", valueKind: "number", defaultOperator: "gte", operators: ["gte", "lte", "gt", "lt", "eq", "neq"] },
  { value: "morale", label: "Довольство", category: "Поселение", valueKind: "number", defaultOperator: "gte", operators: ["gte", "lte", "gt", "lt", "eq", "neq"] },
  { value: "reputation", label: "Репутация", category: "Поселение", valueKind: "number", defaultOperator: "gte", operators: ["gte", "lte", "gt", "lt", "eq", "neq"] },
  { value: "development", label: "Развитие", category: "Показатели", valueKind: "development", defaultOperator: "gte", operators: ["gte", "lte", "gt", "lt", "eq", "neq"] },
  { value: "building-template", label: "Здание из шаблона", category: "Здания", valueKind: "building-template", defaultOperator: "present", operators: ["present", "absent"] },
  { value: "building-function", label: "Функция здания", category: "Здания", valueKind: "building-function", defaultOperator: "present", operators: ["present", "absent"] },
  { value: "construction", label: "Стройка", category: "Здания", valueKind: "none", defaultOperator: "present", operators: ["present", "absent"] },
  { value: "storage", label: "Запасы/склад", category: "Хранилище", valueKind: "none", defaultOperator: "present", operators: ["present", "absent"] },
  { value: "defense", label: "Оборона", category: "Оборона", valueKind: "none", defaultOperator: "present", operators: ["present", "absent"] },
  { value: "region", label: "Регион", category: "Мир", valueKind: "region", defaultOperator: "is", operators: ["is", "is-not"] },
  { value: "faith", label: "Вера", category: "Мир", valueKind: "faith", defaultOperator: "present", operators: ["present", "absent"] },
  { value: "faction", label: "Фракция/тема", category: "Мир", valueKind: "faction", defaultOperator: "present", operators: ["present", "absent"] },
  { value: "calendar", label: "Календарь", category: "Мир", valueKind: "calendar", defaultOperator: "is", operators: ["is", "is-not"] },
  { value: "text", label: "Текст владения", category: "Ручной фильтр", valueKind: "text", defaultOperator: "contains", operators: ["contains", "not-contains"] }
];

export const EVENT_DEVELOPMENT_OPTIONS = [
  { value: "food", label: "Еда" },
  { value: "technology", label: "Технология" },
  { value: "culture", label: "Культура" },
  { value: "war", label: "Война" }
];

export const EVENT_HOLDING_TYPE_OPTIONS = [
  { value: "sky-island", label: "Остров-летяга" },
  { value: "settlement", label: "Поселение" },
  { value: "outpost", label: "Аванпост" },
  { value: "organization", label: "Организация" },
  { value: "skyhold", label: "Скайхолд/летяга" }
];

export const EVENT_BUILDING_FUNCTION_OPTIONS = [
  { value: "production", label: "Производство" },
  { value: "income", label: "Доход" },
  { value: "defense", label: "Оборона" },
  { value: "housing", label: "Жилье" },
  { value: "storage", label: "Склад" },
  { value: "culture", label: "Культура" }
];

export const EVENT_CALENDAR_OPTIONS = [
  { value: "season-zarost", label: "Зарость" },
  { value: "season-ukhudno", label: "Ухудно" },
  { value: "month-1", label: "Хладоход" },
  { value: "month-2", label: "Теплорост" },
  { value: "month-3", label: "Теплоход" },
  { value: "month-4", label: "Зноерост" },
  { value: "month-5", label: "Зноеход" },
  { value: "month-6", label: "Дождерост" },
  { value: "month-7", label: "Дождеход" },
  { value: "month-8", label: "Хладорост" }
];

export const EVENT_VISIBILITY_OPTIONS = [
  { value: "public", label: "В чат" },
  { value: "gm", label: "Только ГМу" }
];

export const EVENT_COMBAT_PRESET_OPTIONS = [
  { value: "", label: "Нет" },
  { value: "raid", label: "Налет" },
  { value: "assault", label: "Штурм" },
  { value: "sabotage", label: "Диверсия" },
  { value: "monster", label: "Чудовище" },
  { value: "panic", label: "Паника" }
];

export const EVENT_THRESHOLD_FEATURE_OPTIONS = EVENT_THRESHOLD_KEYS.flatMap(({ label, lowTag, highTag }) => [
  { value: lowTag, label: `Низкая ${label}`, description: `${label} не выше нижнего порога из настроек событий.` },
  { value: highTag, label: `Высокая ${label}`, description: `${label} не ниже верхнего порога из настроек событий.` }
]);

export const EVENT_DEVELOPMENT_FEATURE_OPTIONS = EVENT_THRESHOLD_FEATURE_OPTIONS;

export const EVENT_FEATURE_OPTIONS = [
  ...EVENT_THRESHOLD_FEATURE_OPTIONS,
  { value: "sky-island", label: "Небесный остров", description: "Владение является летящим островом или скайхолдом." },
  { value: "ship", label: "Корабли/летяги", description: "Поселение содержит корабельный или иной летный контекст." },
  { value: "settlement", label: "Поселение", description: "Владение является поселением или скайхолдом." },
  { value: "storage", label: "Есть склад", description: "Есть складская функция, складское здание или запасы." },
  { value: "housing", label: "Есть жилье", description: "Есть жилые места или вместимость жилья." },
  { value: "defense", label: "Есть оборона", description: "Есть оборонные здания, гарнизон или отряды." },
  { value: "production", label: "Есть производство", description: "Есть производственные здания или линии." },
  { value: "construction", label: "Идет стройка", description: "Есть недостроенные здания." },
  { value: "school", label: "Есть школа/архив", description: "В зданиях или заметках есть школа, ученики, библиотека или архив." },
  { value: "faith", label: "Есть вера/храм", description: "В зданиях или заметках есть храм, культ, часовня или религиозная тема." },
  { value: "port", label: "Есть порт/причал", description: "В зданиях или описании есть порт, гавань или причал." },
  { value: "trade", label: "Торговля", description: "Есть торговые места, репутация, порт или торговые заметки." },
  { value: "law", label: "Закон/чиновники", description: "Проверки, документы, жандармы, право или высокая репутация." },
  { value: "monster", label: "Чудовища", description: "Чудовища, охота, следы твари." }
];

export const EVENT_REGION_OPTIONS = [
  { value: "novand", label: "Нованд", pattern: /нованд|novand/i },
  { value: "sirastien", label: "Сирастьен", pattern: /сиростьен|сиростиен|sirastien|sir/i },
  { value: "izuaver", label: "Изуавер", pattern: /изуавер|izuaver/i },
  { value: "pai-orgul", label: "Пай Оргул", pattern: /пай\s*оргул|кавтур|kavtur|pai\s*orgul/i },
  { value: "lezhnyzem", label: "Лежнизем", pattern: /лежнизем|lezh/i },
  { value: "dichtbeir", label: "Дихтбейр", pattern: /дихтбейр|dicht/i },
  { value: "tiribor", label: "Тиробор", pattern: /тиробор|tiribor/i },
  { value: "yaknizem", label: "Якнизем", pattern: /якнизем|yakn/i },
  { value: "horslia-ontakwa", label: "Хорслия/Онтаква", pattern: /хорсли|онтакв|horsl|ontak/i },
  { value: "fletchenrand", label: "Флеченранд", pattern: /флеченранд|флёченранд|fletch|flachen/i },
  { value: "kaldvelg", label: "Кальдвельг", pattern: /кальдвельг|kald/i },
  { value: "naerder", label: "Наэрдэр", pattern: /наэрдэр|naer|naerd/i },
  { value: "sangren", label: "Сангрен", pattern: /сангрен|sangren/i },
  { value: "boltrask", label: "Болтраск", pattern: /болтраск|boltrask/i },
  { value: "sarroyo", label: "Сарройо", pattern: /сарройо|sarroyo/i },
  { value: "royu", label: "Ройу/Сагеки/Мидеки", pattern: /ройу|сагеки|мидеки|royu|sageki|mideki/i },
  { value: "seiku", label: "Сейку", pattern: /сейку|seiku/i },
  { value: "vilezh", label: "Вельеж", pattern: /вельеж|велье|vilezh|veliezh/i },
  { value: "black-desert", label: "Черная Пустыня", pattern: /черн[а-яё]*\s+пустын|black\s+desert/i }
];

export const DEFAULT_EVENT_REGION_OPTIONS = EVENT_REGION_OPTIONS.map(({ value, label }) => ({
  value,
  label,
  aliases: ""
}));

function splitAliases(value = "") {
  if (Array.isArray(value)) return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  return String(value ?? "")
    .split(/[,;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function slugFromLabel(value = "") {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    || "";
}

const MARKET_REGION_STATUSES = new Set(["thriving", "stable", "strained", "disrupted", "ruined", "blockaded"]);
const MARKET_TRANSPORT_MODES = new Set(["caravan", "rail", "airship"]);
const MARKET_ROUTE_SEASONS = ["spring", "summer", "autumn", "winter"];
export const LEGACY_MARKET_ROUTE_UNIT_KM = 40;

function normalizeMarketTransportModes(value = []) {
  const rows = Array.isArray(value) ? value : String(value ?? "").split(/[,;|\n]+/);
  const result = [...new Set(rows.map((item) => String(item ?? "").trim()).filter((item) => MARKET_TRANSPORT_MODES.has(item)))];
  return result.length ? result : ["caravan", "airship"];
}

function normalizeMarketSeasonalModifiers(value = {}) {
  const source = isPlainObject(value) ? value : {};
  return Object.fromEntries(MARKET_ROUTE_SEASONS.map((seasonId) => {
    const row = isPlainObject(source[seasonId]) ? source[seasonId] : {};
    return [seasonId, {
      enabled: toBoolean(row.enabled, false),
      costFactor: Math.min(4, Math.max(0.25, toNumber(row.costFactor, 1))),
      timeFactor: Math.min(4, Math.max(0.25, toNumber(row.timeFactor, 1))),
      riskFactor: Math.min(4, Math.max(0.25, toNumber(row.riskFactor, 1)))
    }];
  }));
}

function normalizeMarketLinks(value = []) {
  const rows = Array.isArray(value) ? value : String(value ?? "").split(/[,;\n]+/);
  const result = [];
  const seen = new Set();
  for (const raw of rows) {
    const source = raw && typeof raw === "object" ? raw : {};
    const parts = typeof raw === "string" ? raw.split(":") : [];
    const regionId = String(source.regionId ?? source.targetId ?? source.id ?? parts[0] ?? "").trim();
    if (!regionId || seen.has(regionId)) continue;
    seen.add(regionId);
    const stringDistance = String(parts[1] ?? "").trim();
    const explicitStringKm = /(?:km|км)$/i.test(stringDistance)
      ? Number.parseFloat(stringDistance.replace(/(?:km|км)$/i, "").replace(",", "."))
      : undefined;
    const explicitDistanceKm = source.distanceKm ?? source.km ?? explicitStringKm;
    const distanceKm = explicitDistanceKm === undefined || explicitDistanceKm === null || explicitDistanceKm === ""
      ? toNumber(source.distance ?? parts[1], 1) * LEGACY_MARKET_ROUTE_UNIT_KM
      : toNumber(explicitDistanceKm, LEGACY_MARKET_ROUTE_UNIT_KM);
    const rawPathPoints = Array.isArray(source.pathPoints ?? source.waypoints) ? (source.pathPoints ?? source.waypoints) : [];
    const pathPoints = rawPathPoints.slice(0, 100).map((point) => ({
      x: Math.min(12000, Math.max(0, toNumber(point?.x, 0))),
      y: Math.min(8000, Math.max(0, toNumber(point?.y, 0)))
    }));
    result.push({
      regionId,
      ursCost: Math.min(99, Math.max(1, Math.floor(toNumber(source.ursCost ?? source.accessCost ?? source.difficulty, 1)))),
      distanceKm: Math.min(100000, Math.max(1, distanceKm)),
      distanceMode: String(source.distanceMode ?? "") === "scaled" ? "scaled" : "manual",
      pathPoints,
      modes: normalizeMarketTransportModes(source.modes ?? parts[2] ?? []),
      seasonalModifiers: normalizeMarketSeasonalModifiers(source.seasonalModifiers ?? source.seasons)
    });
  }
  return result.slice(0, 100);
}

export function normalizeEventRegionOption(row = {}, index = 0) {
  const source = isPlainObject(row) ? row : {};
  const label = String(source.label ?? source.name ?? source.title ?? source.value ?? source.id ?? "").trim() || `Region ${index + 1}`;
  const rawValue = String(source.value ?? source.id ?? source.key ?? "").trim();
  const value = rawValue || slugFromLabel(label) || `region-${index + 1}`;
  const marketProfile = ["standard", "connected", "remote", "aerial"].includes(String(source.marketProfile ?? ""))
    ? String(source.marketProfile)
    : "";
  const marketFactor = (factor) => {
    if (factor === undefined || factor === null || factor === "") return null;
    return Math.min(4, Math.max(0.25, toNumber(factor, 1)));
  };
  const marketTaxRate = source.marketTaxRate === undefined || source.marketTaxRate === null || source.marketTaxRate === ""
    ? 0
    : Math.min(1, Math.max(0, toNumber(source.marketTaxRate, 0)));
  return {
    value,
    label,
    aliases: splitAliases(source.aliases ?? source.alias ?? source.patternText ?? ""),
    countryId: String(source.countryId ?? source.marketCountryId ?? value).trim().slice(0, 160) || value,
    marketSizeId: String(source.marketSizeId ?? source.sizeProfileId ?? "town").trim().slice(0, 160) || "town",
    marketSpecialtyIds: splitAliases(source.marketSpecialtyIds ?? source.specialtyIds ?? source.specialties ?? "").slice(0, 80),
    marketConditionId: String(source.marketConditionId ?? source.locationConditionId ?? "").trim().slice(0, 160),
    marketTags: splitAliases(source.marketTags ?? source.tags ?? "").slice(0, 80),
    marketProfile,
    marketPriceFactor: marketFactor(source.marketPriceFactor),
    marketAvailabilityFactor: marketFactor(source.marketAvailabilityFactor),
    marketDeliveryFactor: marketFactor(source.marketDeliveryFactor),
    marketTimeFactor: marketFactor(source.marketTimeFactor),
    marketRiskFactor: marketFactor(source.marketRiskFactor),
    marketExportFactor: marketFactor(source.marketExportFactor),
    marketImportFactor: marketFactor(source.marketImportFactor),
    marketTaxRate,
    marketStatus: MARKET_REGION_STATUSES.has(String(source.marketStatus ?? "")) ? String(source.marketStatus) : "stable",
    marketEnabled: toBoolean(source.marketEnabled, true),
    marketLandmassId: String(source.marketLandmassId ?? source.landmassId ?? source.continentId ?? "").trim().slice(0, 120),
    marketAirshipOnly: toBoolean(source.marketAirshipOnly, false),
    marketTransportModes: normalizeMarketTransportModes(source.marketTransportModes ?? source.transportModes),
    marketLinks: normalizeMarketLinks(source.marketLinks ?? source.links),
    marketMapX: Math.min(12000, Math.max(0, toNumber(source.marketMapX ?? source.mapX, 0))),
    marketMapY: Math.min(8000, Math.max(0, toNumber(source.marketMapY ?? source.mapY, 0))),
    marketNotes: String(source.marketNotes ?? "").trim().slice(0, 2000),
    contentVersion: Math.max(1, Math.floor(toNumber(source.contentVersion ?? source.version, 1))),
    contentSource: String(source.contentSource ?? source.source ?? "")
  };
}

export function normalizeEventRegionOptions(source = null, { fallback = true } = {}) {
  const rows = Array.isArray(source)
    ? source
    : (fallback ? DEFAULT_EVENT_REGION_OPTIONS : []);
  const result = [];
  const seen = new Set();
  for (const row of rows) {
    const normalized = normalizeEventRegionOption(row, result.length);
    const key = String(normalized.value ?? "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

export function eventRegionOptionValue(value = "", regionOptions = EVENT_REGION_OPTIONS) {
  const options = normalizeEventRegionOptions(regionOptions);
  const text = String(value ?? "").trim();
  if (!text) return options[0]?.value ?? "";
  const lower = text.toLowerCase();
  const option = options.find((entry) => {
    if (String(entry.value).toLowerCase() === lower) return true;
    if (String(entry.label).toLowerCase() === lower) return true;
    if ((entry.aliases ?? []).some((alias) => String(alias).toLowerCase() === lower)) return true;
    return EVENT_REGION_OPTIONS.find((fallback) => (
      String(fallback.value).toLowerCase() === String(entry.value).toLowerCase()
      && fallback.pattern?.test?.(text)
    ));
  });
  return option?.value ?? text;
}

export const EVENT_FAITH_OPTIONS = [
  { value: "any", label: "Любая вера", pattern: /храм|святил|часов|церк|вера|культ|temple|shrine|chapel|church|faith|cult/i },
  { value: "rambar", label: "Рамбар", pattern: /рамбар|фильминд|rambar/i },
  { value: "trimunelia", label: "Тримунэлия/луны", pattern: /тримунэл|муна|трео|триа|аэль|trimun/i },
  { value: "crimson-pike", label: "Багровая Щука", pattern: /багров[а-яё]*\s+щук|домитран|янтарн[а-яё]*\s+церк|crimson/i },
  { value: "steel-faith", label: "Стальная вера", pattern: /стальн[а-яё]*\s+вер|ржав|младой/i },
  { value: "faeliran", label: "Фаэлиранство", pattern: /фаэлир|ралхазай|будильник|faelir/i }
];

export const EVENT_FACTION_OPTIONS = [
  { value: "stl", label: "Свободная Торговая Лига", pattern: /свободн[а-яё]*\s+торгов[а-яё]*\s+лиг|стл\b|free\s+trade/i },
  { value: "elbow", label: "Гильдия Локтя", pattern: /гильди[а-яё]*\s+локт|локтя|elbow/i },
  { value: "potroshiteli", label: "Потрошители", pattern: /потрошител|acrochet|muttantis/i },
  { value: "memory", label: "Общество Память", pattern: /общество\s+[“\"]?памят|каден|memory/i },
  { value: "cartographers", label: "Картографы", pattern: /картограф|юли[а-яё]*\s+люци|cartograph/i },
  { value: "miracle-workers", label: "Чудотворцы", pattern: /чудотвор|miracle/i },
  { value: "defenders", label: "Защитники Альбугрира", pattern: /защитник[а-яё]*\s+альбугрир|defenders/i },
  { value: "blagostni", label: "Благостные", pattern: /благостн|отряд[а-яё]*\s+благ/i }
];

export const EVENT_CONTEXT_TAG_OPTIONS = [
  ...EVENT_FEATURE_OPTIONS.map((option) => ({ ...option, category: "Признаки" })),
  ...EVENT_REGION_OPTIONS.map((option) => ({ ...option, category: "Регионы", description: `Региональный след: ${option.label}.` })),
  ...EVENT_FAITH_OPTIONS.map((option) => ({ ...option, category: "Вера", description: `След веры: ${option.label}.` })),
  ...EVENT_FACTION_OPTIONS.map((option) => ({ ...option, category: "Фракции", description: `След фракции или темы: ${option.label}.` })),
  ...EVENT_CALENDAR_OPTIONS.map((option) => ({ ...option, category: "Календарь", description: `Календарный след: ${option.label}.` }))
];

export const EVENT_TAG_MODE_OPTIONS = [
  { value: "require", label: "Требует" },
  { value: "context", label: "Подходит" },
  { value: "block", label: "Исключает" }
];
function mergeEventText(text = "", effect = "") {
  const main = String(text ?? "").trim();
  const extra = String(effect ?? "").trim();
  if (!extra) return main;
  if (!main) return extra;
  if (main.includes(extra)) return main;
  return `${main}\n\n${extra}`;
}

function eventRow(id, rarity, title, text, effect, _condition = "", tags = "") {
  return {
    id,
    weight: LEGACY_RARITY_WEIGHT[rarity] ?? 4,
    title,
    text: mergeEventText(text, effect),
    tags
  };
}

export const DEFAULT_RANDOM_EVENT_TABLES = {
  general: {
    id: "general",
    version: RANDOM_EVENT_TABLE_VERSION,
    title: "Общие события",
    rollTitle: "Общее событие",
    description: "Внутренние события конца десятника: быт, здания, люди, развитие, довольство и странности самого владения.",
    rows: [
      eventRow("gen-quiet-tenday", "common", "Тихий десятник", "Работы идут без громких происшествий. Люди спорят о мелочах, но к концу десятника сами находят равновесие.", "Без прямого эффекта; хорошая пауза для личных сцен жителей.", "Любое владение.", "people"),
      eventRow("gen-ledger-found", "common", "Сверка закромов", "При разборе старых ведомостей находится плохо учтенный запас или вещь, которую давно считали потерянной.", "Выберите малый ресурс, расходник или предмет низкой ценности; он возвращается в хранилище.", "Лучше работает, если есть склад или кладовая.", "storage,technology"),
      eventRow("gen-clever-shift", "common", "Ловкая смена", "Одна рабочая группа находит простой прием, экономящий время: переставленные козлы, новый порядок переноски, удачный шаблон.", "Одна стройка или производственная линия получает небольшой разовый бонус по решению ГМа.", "Есть активные рабочие, производство или стройка.", "production,construction,technology"),
      eventRow("gen-common-supper", "common", "Общий ужин", "Жители сами собирают вечернюю трапезу, зовут соседей и внезапно начинают говорить друг с другом мягче.", "Можно потратить еду/серебро на праздник; при щедрой поддержке +1 довольства до конца следующего десятника.", "Особенно заметно при низком довольстве.", "food,culture,low-morale"),
      eventRow("gen-dry-room", "common", "Сухая комната", "Кто-то наконец понимает, где в поселении меньше всего сырости, и переносит туда самое уязвимое добро.", "Один риск порчи припасов, книг, ткани или пороха в ближайший месяц считается заранее предотвращенным.", "Есть хранилище, книги, ткань, порох или еда.", "storage,technology"),
      eventRow("gen-good-watch", "common", "Верный дозор", "Караул замечает проблему раньше, чем она становится бедой: трещину, дым, чужую тень, следы у склада.", "Следующее негативное событие с кражей, пожаром или проникновением можно смягчить.", "Есть дозор, стража, укрепления или военные жители.", "war,defense"),
      eventRow("gen-garden-beds", "common", "Грядки на краю", "Между строениями появляются ящики с зеленью, грибные мешки, сушильные сетки или маленький сад.", "Малый запас еды или зацепка на постоянное улучшение пищевой инфраструктуры.", "Особенно подходит владениям с Едой 1+ или нехваткой пайков.", "food,housing"),
      eventRow("gen-children-help", "common", "Мелкие руки, острые глаза", "Дети, юнги или младшие помощники замечают то, что взрослые обходили взглядом.", "ГМ дает подсказку о скрытой проблеме поселения или ближайшей возможности.", "Есть дети, ученики или много свободных жителей.", "people,culture"),
      eventRow("gen-friendly-argument", "common", "Спор о приоритетах", "Две группы жителей требуют разного: больше еды, лучше жилье, новую мастерскую, стену, храм или склад.", "Выбор приоритета может дать +1 к одной теме и раздражение сторонников другой.", "Любое развивающееся поселение.", "people,development"),
      eventRow("gen-crowded-corners", "common", "Тесные углы", "В жилье, бараках или каютах становится слишком шумно и тесно; мелкие обиды перестают быть мелкими.", "Если свободного жилья нет, отметьте напряжение: возможен штраф довольства или сцена конфликта.", "Мало жилья или много жителей.", "housing,people,low-morale"),
      eventRow("gen-sour-barrel", "common", "Кислая бочка", "Часть запасов портится из-за сырости, дурной пробки, старой соли или чужой небрежности.", "Потеряйте малый запас еды/сырья или потратьте время на переборку.", "Есть припасы без хорошего склада.", "food,storage"),
      eventRow("gen-work-injury", "common", "Травма на работе", "Один житель получает вывих, ожог, порез или удар грузом.", "Житель временно ранен или одна работа замедляется до лечения.", "Есть стройка, мастерская, шахта, кухня или тяжелый труд.", "people,production,construction"),
      eventRow("gen-local-custom", "common", "Новый обычай", "Жители придумывают местную привычку: знак приветствия, вечернюю песню, запретное слово, общий жест перед работой.", "Если обычай поддержать, он может стать чертой поселения; если высмеять, кто-то обидится.", "Особенно хорошо при Культуре 1+.", "culture,people"),
      eventRow("gen-small-repairs", "common", "Починка между делом", "Старые доски, болты, канаты и петли приводят в порядок без приказа сверху.", "Следующий мелкий ремонт здания стоит меньше или занимает меньше времени.", "Есть поврежденные или старые здания.", "technology,construction"),
      eventRow("gen-water-check", "common", "Проверка воды", "Колодец, цистерна, ледник, сборник дождя или бочки требуют внимания: вода пахнет иначе.", "ГМ выбирает: тревога ложная, нужен фильтр, или это след следующего события.", "Есть отдельный источник воды или пищевое развитие.", "food,storage"),
      eventRow("gen-bad-tools", "common", "Уставший инструмент", "Самый нужный инструмент ломается именно тогда, когда его нельзя заменить без задержки.", "Одна работа получает помеху, пока инструмент не починят или не заменят.", "Есть активная стройка или производство.", "technology,production,construction"),
      eventRow("gen-useful-routine", "common", "Хороший порядок", "Кто-то незаметный вводит порядок: где лежат ключи, кто закрывает двери, как отмечают приход и расход.", "До следующего десятника один риск путаницы, кражи или потери можно отменить.", "Есть склад, казна или большой список жителей.", "storage,people,technology"),
      eventRow("gen-old-map-note", "uncommon", "Пометка на старой карте", "В документах поселения находят отметку, которую раньше принимали за пятно или ошибку.", "Это может быть короткий маршрут, старый тайник, опасное место или чужая граница.", "Есть архив, старый владелец, руины или библиотека.", "culture,technology,mystic"),
      eventRow("gen-apprentice-pride", "uncommon", "Гордость ученика", "Младший работник делает вещь лучше, чем ожидали наставники, и ждет признания.", "Если его поддержать, один житель получает сцену роста или новую роль.", "Есть мастерская, школа, ремесленник или свободные жители.", "people,technology,culture"),
      eventRow("gen-faithful-sign", "uncommon", "Знак веры", "Верующие видят совпадение: трещину в форме символа, сон в святой день, песню, всплывшую в нужный миг.", "ГМ решает, это знак, самовнушение или повод для религиозного спора.", "Есть храм, святилище, разные верования или высокая Культура.", "faith,culture,mystic"),
      eventRow("gen-rambar-rest", "uncommon", "Рамбарский отдых", "Дварфы, ремесленники или просто уставшая смена настаивают: работа без отдыха делает брак, а не мастерство.", "Если дать людям день отдыха, следующая ремесленная или строительная работа получает доверие и небольшой бонус.", "Есть мастерская, шахта, кузня, дварфы или высокая Технология.", "faith,rambar,technology,production,construction"),
      eventRow("gen-pike-suspicion", "uncommon", "Скверна механизма", "Кто-то из верующих Багровой Щуки видит в сложном устройстве кавтурскую волю и требует остановить работу.", "Нужен суд, спор или уступка; до решения одно технологическое здание может работать хуже.", "Есть сложный механизм, высокая Технология или дихтбейрские верующие.", "faith,crimson-pike,technology,low-morale"),
      eventRow("gen-memory-circle", "uncommon", "Кружок Памяти", "Жители начинают собирать старые письма, имена, слухи и версии событий, споря о том, кто переписывает историю.", "Можно оформить местную хронику, но при грубом запрете кружок станет подпольным.", "Есть архив, старые преступления, новандцы, сангренцы или образованные жители.", "culture,memory,novand,sangren,fletchenrand"),
      eventRow("gen-training-yard", "uncommon", "Самовольная тренировка", "Несколько жителей начинают учиться держать строй, стрелять, тушить пожар или действовать по сигналу.", "Можно начать подготовку ополчения, дозора или аварийной команды.", "Есть Война 1+, оборона или тревожные соседи.", "war,defense,people"),
      eventRow("gen-hidden-nook", "uncommon", "Найденная ниша", "За стеной, под настилом, в старом трюме или между скалами находится сухое место.", "Можно получить малый тайник, складскую ячейку или уютное жилье для одного-двух человек.", "Есть старое строение, корабль или остров-летяга.", "storage,housing,sky-island,ship"),
      eventRow("gen-soft-boycott", "uncommon", "Тихий отказ", "Люди формально работают, но делают ровно столько, чтобы их нельзя было обвинить.", "До выяснения причины одно здание или бригада работает хуже.", "Низкое довольство, задержка оплаты или спор о приоритетах.", "low-morale,people,production"),
      eventRow("gen-missing-key", "uncommon", "Пропавший ключ", "Ключ, печать, пломба, пароль или журнал оказывается не там, где должен быть.", "Это может быть ошибка учета, кража или проверка безопасности.", "Есть склад, казна, тюрьма, архив или важная дверь.", "storage,war,technology"),
      eventRow("gen-housing-request", "uncommon", "Просьба о доме", "Семья, пара, одинокий специалист или больной житель просит отдельное место.", "Если дать жилье, возможен рост довольства; отказ оставляет личную обиду.", "Есть дефицит жилья или новые жители.", "housing,people"),
      eventRow("gen-market-corner", "uncommon", "Малый рынок", "Жители устраивают обмен без участия внешних купцов: лишние сапоги, соль, ткань, услуги, новости.", "Можно обменять один малый ресурс на другой или дать сцену слухов.", "Есть 8+ жителей или Культура 1+.", "culture,storage,people"),
      eventRow("gen-burnt-smell", "uncommon", "Запах гари", "Огонь еще не начался, но где-то уже перегрелось дерево, масло, проводка, смола или печь.", "Нужно потратить время/ресурс на профилактику; если проигнорировать, следующий пожарный риск усиливается.", "Есть кузня, кухня, механизм, мастерская или корабельный отсек.", "technology,production,ship"),
      eventRow("gen-visitor-inside", "uncommon", "Чужое лицо внутри", "Кто-то клянется, что давно тут живет или работает, но его имени нет ни в одном списке.", "ГМ решает, это ошибка, беглец, шпион, родня жителя или что-то страннее.", "Поселение с большим населением или слабым учетом.", "people,mystic"),
      eventRow("gen-old-debt", "uncommon", "Старый долг", "Всплывает обязательство прежнего владельца, умершего жителя или нынешней администрации.", "Заплатить, отказать или судиться; любой выбор создает последствие.", "Есть история владения, старые документы или внешние связи.", "culture,reputation"),
      eventRow("gen-shared-song", "uncommon", "Песня, которая прижилась", "Рабочая песня или молитва внезапно собирает людей лучше приказа.", "При поддержке дает малый бонус к довольству или следующей общей работе.", "Культура 1+ или высокий боевой/трудовой дух.", "culture,high-morale,people"),
      eventRow("gen-cracked-beam", "uncommon", "Треснувшая опора", "Одна балка, канат, несущий камень или ребро корпуса держится хуже, чем думали.", "Выберите здание или узел: ему нужен ремонт до следующей нагрузки.", "Есть старые здания, высота, мосты, палубы или причалы.", "construction,technology,sky-island,ship"),
      eventRow("gen-forgotten-room", "rare", "Комната без плана", "За знакомой дверью оказывается помещение, которого нет на чертежах и в памяти строителей.", "Внутри может быть тайник, опасность, чужой знак или короткая мини-сцена.", "Старое владение, руины, корабль, остров-летяга.", "mystic,technology,storage"),
      eventRow("gen-returned-hunters", "rare", "Охотники вернулись не одни", "Добыча богата, но в рассказе охотников есть дыра: кто-то или что-то отпустило их с условием.", "Получите ресурс и обязательство, метку или будущую угрозу.", "Есть охота, фуражиры, лес/скалы или внешние вылазки.", "food,people,mystic"),
      eventRow("gen-name-on-wall", "rare", "Имя на стене", "На видном месте появляется имя живого жителя, выцарапанное так, будто надпись старая.", "Житель получает страх, сон или чужое внимание; расследование может стать мини-сценой.", "Любое поселение; сильнее при низком довольстве.", "mystic,people,low-morale"),
      eventRow("gen-engine-whisper", "rare", "Шепот в механизме", "Старый механизм, труба, колокол, якорь или пустая шахта повторяет отдельные слова.", "Слова могут быть предупреждением, обманом или эхо чужой молитвы.", "Технология 2+, корабль, летяга или заброшенный механизм.", "technology,mystic,ship,sky-island"),
      eventRow("gen-trimunelia-candles", "rare", "Три свечи", "Ночью кто-то ставит три свечи: одну для памяти, одну для тайны, одну для действия. Утром каждая указывает на разного жителя.", "Сцена Тримунэлии: Муна, Триа и Аэль могут подсветить скорбь, секрет и смелое решение.", "Есть тримунэлийцы, обсерватория, храм, спор о правде или сильная Культура.", "faith,trimunelia,culture,mystic"),
      eventRow("gen-black-dust", "rare", "Черная пыль", "У порога, в фильтре, на подоконнике или в складской щели находят тонкую черную пыль.", "Пыль портит один малый запас или отмечает место для грядущей опасности.", "Подходит регионам рядом с пустошами, странными ветрами или проклятыми зонами.", "mystic,storage,food"),
      eventRow("gen-secret-kindness", "rare", "Тайная доброта", "Кто-то анонимно помогает тем, кто слабее: оставляет еду, чинит обувь, закрывает долги.", "Если найти благодетеля и не наказать, поселение получает сильную сцену доверия.", "Есть бедность, раненые, сироты или низкое довольство.", "people,culture,low-morale"),
      eventRow("gen-fraeliran-vigil", "rare", "Вечернее бдение", "Несколько жителей молча смотрят в небо или в черное зеркало, обсуждая не спасение, а достоинство перед концом.", "Фаэлиранская сцена может успокоить панику или, наоборот, посеять апатию.", "Есть эльфы, философы, утраты, низкое довольство или культовые споры.", "faith,faeliran,culture,mystic,low-morale"),
      eventRow("gen-mirror-window", "rare", "Окно в отражении", "Зеркало, вода, полированная пластина или стекло показывает комнату поселения такой, какой она еще не стала.", "ГМ показывает будущую опасность, успех или ложное видение.", "Есть вода, стекло, храм, лаборатория или странный предмет.", "mystic,culture,technology"),
      eventRow("gen-sabotage-thread", "rare", "Нить саботажа", "Несколько мелких поломок складываются в рисунок: кто-то знает расписание и слабые места.", "Начните расследование; до раскрытия один тип работ под угрозой.", "Есть враги, недовольные, секреты или высокая репутация.", "low-morale,reputation,technology,war"),
      eventRow("gen-wakers-mark", "legendary", "Метка Будильников", "На ядре, якоре, своде или главном механизме находят черный круг с короткой фразой о пробуждении Ралхазая.", "Завязка: фаэлиранская секта готовит саботаж, который может угрожать самому существованию владения.", "Есть важный механизм, летяга, высокий риск падения или фаэлиранский след.", "faith,faeliran,mystic,technology,sky-island"),
      eventRow("gen-noon-shadow", "legendary", "Тень в полдень", "В ясный день над поселением проходит тень от того, чего никто не видит.", "Завязка: после тени остается метка, письмо, болезнь, благословение или маршрут.", "Очень редкое потустороннее событие.", "mystic,sky-island,reputation"),
      eventRow("gen-dead-bell", "legendary", "Колокол без звонаря", "Колокол, сигнальная труба, гонг или пустой котел звучит сам, называя время, которого не должно быть.", "Завязка: в этот час кто-то пропал, родился, умер, вернулся или заключил сделку.", "Есть сигнальный предмет, храм, караул или старая история.", "mystic,culture,war"),
      eventRow("gen-door-in-wall", "legendary", "Дверь, которой не строили", "На одну ночь в поселении появляется дверь, люк или лестница; утром их может уже не быть.", "Завязка мини-приключения внутри самого владения.", "Старое строение, руины, остров-летяга или странный фундамент.", "mystic,technology,housing"),
      eventRow("gen-founders-dream", "legendary", "Сон основателя", "Несколько жителей видят один и тот же сон о том, зачем это место вообще должно существовать.", "Если сон принять как клятву, владение может получить новую особенность или цель.", "Высокая Культура, религиозное напряжение или момент кризиса.", "mystic,culture,high-morale"),
      eventRow("gen-hungry-absence", "legendary", "Голодное отсутствие", "Из поселения исчезает не вещь, а возможность: все помнят склад, комнату, человека или день, но найти их нельзя.", "Завязка: вернуть можно только выяснив, кто или что забрало место из памяти.", "Очень редкая внутренняя мистика.", "mystic,storage,people")
    ]
  },
  external: {
    id: "external",
    version: RANDOM_EVENT_TABLE_VERSION,
    title: "Внешние события",
    rollTitle: "Внешнее событие",
    description: "События репутации: торговля, власти, беженцы, соседи, вера, чудовища, война и странности внешнего мира.",
    rows: [
      eventRow("ext-trade-skiff", "common", "Торговый корабль", "К владению подходит малый торговый рейс: еда, ткань, инструменты, новости и чужие просьбы.", "Можно торговать; при хорошей встрече репутация укрепляется.", "Особенно часто при Репутации 1+ и безопасной стоянке.", "trade,reputation,sky-island,ship"),
      eventRow("ext-itinerant-craft", "common", "Бродячие мастера", "Несколько ремесленников ищут работу на десятник: починка, печи, замки, обувь, снасти, крыши.", "Можно нанять временную помощь или предложить кому-то остаться.", "Подходит поселениям с жильем и оплатой.", "people,technology,housing"),
      eventRow("ext-food-caravan", "common", "Караван с припасами", "Караванщики везут простую еду и готовы обменять ее на защиту, ночлег, ремонт или сведения.", "Доступна выгодная сделка с едой или услугой.", "Хорошо при нехватке еды.", "food,trade"),
      eventRow("ext-local-pilgrims", "common", "Паломники у ворот", "Небольшая группа верующих просит воды, ночлега и права помолиться на безопасном месте.", "Принять, отказать или поставить условия; возможны слухи и религиозные связи.", "Есть храм, святилище или заметная репутация.", "faith,culture,reputation"),
      eventRow("ext-lost-runner", "common", "Заблудший гонец", "Измотанный посыльный приносит письмо не по адресу, но письмо явно важное.", "Передать, вскрыть, продать или скрыть; каждое решение создает внешний след.", "Любой регион.", "reputation,culture"),
      eventRow("ext-new-settler", "common", "Человек с полезными руками", "Кандидат в жители приходит с понятной историей и навыком: кухня, караул, плотник, писарь, пастух.", "ГМ генерирует кандидата; его можно принять или отказать.", "Выпадает особенно уместно на успехе репутации.", "people,reputation"),
      eventRow("ext-minor-official", "common", "Младший чиновник", "Представитель округа, дома, порта или старой власти просит сведения о положении дел.", "Можно показать порядок, скрыть проблемы или превратить визит в сделку.", "Поселение известно внешней власти.", "reputation,law"),
      eventRow("ext-weather-debris", "common", "Небесный мусор", "Ветер приносит обломки чужого груза, обрывки паруса, бумагу, пепел или сломанную вывеску.", "Находка дает ресурс, слух или след чужой беды.", "Летяги, корабли, высокие места.", "sky-island,ship,storage"),
      eventRow("ext-route-rumor", "common", "Весть о тихом маршруте", "Путники рассказывают о воздушном течении, броде, перевале или ночной стоянке, где стало безопаснее.", "Следующая внешняя поездка/торговля может получить преимущество.", "Есть маршруты, дрейф или торговля.", "trade,sky-island"),
      eventRow("ext-wounded-stranger", "common", "Раненый чужак", "У границы находят раненого человека: жандарм, разбойник, разведчик, паломник или беглый слуга.", "Лечить, допросить, выдать или спрятать; за ним может прийти другая сторона.", "Любое поселение.", "people,law,war"),
      eventRow("ext-beast-tracks", "common", "Следы чудовища", "У стоянки, под островом или на соседнем пути находят следы крупной твари.", "Если не принять меры, следующая внешняя опасность может стать нападением.", "Дикий регион, низкая оборона или свежая добыча.", "monster,war,food"),
      eventRow("ext-tax-question", "common", "Вопрос о пошлине", "Кто-то с печатью заявляет, что владение задолжало сбор за стоянку, проход, добычу или торговлю.", "Платить, спорить, подкупать или искать юридическую лазейку.", "Репутация привлекает чиновников.", "law,trade,reputation"),
      eventRow("ext-distant-famine", "common", "Голодная весть", "С большой земли приходят новости о недороде, болезнях и людях, готовых идти куда угодно.", "Цены на еду растут; скоро могут прийти беженцы.", "Особенно уместно рядом с населенными регионами.", "food,people,trade"),
      eventRow("ext-foreign-flag", "common", "Чужой флаг", "Рядом замечен корабль, отряд или караван с флагом, который не называют вслух.", "Это может быть разведка, торговля, контрабанда или охота за кем-то.", "Любой внешний маршрут.", "ship,trade,war"),
      eventRow("ext-novand-paper", "uncommon", "Новандская бумага", "Прибывает документ с правильной печатью и слишком общими формулировками.", "Он требует учета, сведений, подписи или присутствия свидетеля.", "Нованд, Вельеж или зоны их влияния.", "law,reputation,novand,vilezh"),
      eventRow("ext-gendarme-visit", "uncommon", "Визит жандармов", "Жандармы изучают недавнее преступление, старый лагерь, пропажу людей или слух о контрабанде.", "Сотрудничество дает доверие; ложь может вернуться проверкой.", "Есть преступление, беглецы, рабский след или высокая репутация.", "law,war,reputation"),
      eventRow("ext-free-league-buyer", "uncommon", "Фактор СТЛ", "Представитель Свободной Торговой Лиги хочет купить конкретный ресурс, оформить перевозку, страховку или маленькую банковскую услугу.", "Можно выгодно продать запас; сделка создаст ожидание новых поставок и аккуратный бумажный след.", "Есть склад, производство или торговая репутация.", "trade,storage,reputation,stl"),
      eventRow("ext-refugee-family", "uncommon", "Семья с узлами", "К поселению приходит семья или маленькая артель с вещами, детьми, ремеслом и страхом за спиной.", "ГМ генерирует 1-3 кандидатов; за ними может тянуться внешний конфликт.", "Репутация убежища или слухи о безопасности.", "people,housing,reputation"),
      eventRow("ext-elbow-contract", "uncommon", "Контракт Гильдии Локтя", "Гильдия Локтя предлагает рабочих, мушкетеров, носильщиков или редкого специалиста на ясных, но жестких условиях.", "Можно закрыть кадровую дыру; нарушение договора быстро испортит репутацию.", "Есть деньги, стройка, охрана или нужда в специалистах.", "people,war,trade,reputation,elbow"),
      eventRow("ext-cartographer", "uncommon", "Картографы Юлия Люциуса", "Картографическое сообщество просит разрешения снять высоту, направление ветра, форму края или странность маршрута.", "За помощь дает карту, слух о новом острове или безопасный маршрут.", "Летяга, башня, высокие скалы или порт.", "sky-island,technology,trade,cartographers"),
      eventRow("ext-preacher-debate", "uncommon", "Проповедник у площади", "Харизматичный проповедник говорит о бедах мира так, будто знает личные тайны жителей.", "Дать слово, выгнать или спорить; возможен рост веры или раскол.", "Есть разные верования или высокая Культура.", "faith,culture,people"),
      eventRow("ext-blagostni-aid", "uncommon", "Отряд блага", "Благостни приходят с лекарством, пайками, сбором пожертвований или предложением помочь тем, кто стал заложником беды.", "Можно получить помощь, но поселение попросят отчитаться, кому оно само готово помогать.", "Недавняя атака, голод, болезнь, беженцы или низкое довольство.", "people,food,reputation,blagostni"),
      eventRow("ext-sangren-games", "uncommon", "Сангренский вызов", "Посланцы Сангрена ищут участников, судей или площадку для соревнования, турнира, стрельбы или игры на честь первых побед.", "Участие дает славу и связи; проигрыш тоже может стать красивой историей.", "Есть бойцы, спортсмены, высокая Война или гордая община.", "war,culture,reputation,sangren"),
      eventRow("ext-yaknizem-overflight", "uncommon", "Якниземский перелет", "Торговое судно идет с грузом для земель воюющих ханов и предлагает оплату за стоянку, ремонт или молчание.", "Быстрая прибыль, но груз может быть военным, спорным или опасным.", "Маршруты к Гристону, корабли, летяги, торговля.", "trade,ship,war,yaknizem"),
      eventRow("ext-deserter-offer", "uncommon", "Дезертир с предложением", "Бывший солдат знает склад, заставу, тропу или слабое место врага и хочет защиты.", "Можно получить военную зацепку, но его будут искать.", "Есть оборона, война или связи с гарнизонами.", "war,people,law"),
      eventRow("ext-port-fever", "uncommon", "Портовая лихорадка", "С прибывшими товарами приходит болезнь, которую сначала принимают за усталость от пути.", "Нужен карантин, лекарь или жесткое решение о торговле.", "Частая торговля, беженцы или порт.", "food,people,trade"),
      eventRow("ext-smuggler-lamp", "uncommon", "Контрабандный фонарь", "Ночью кто-то подает сигнал поселению, уверенный, что здесь его ждут.", "Ответить, поймать, проигнорировать или выдать знак за свой.", "Есть берег, причал, край острова или скрытые связи.", "trade,law,ship"),
      eventRow("ext-mercenary-band", "uncommon", "Наемная полурота", "Вооруженные люди ищут работу, ночлег и оплату; дисциплина держится на одном командире.", "Можно нанять защиту или получить проблему у ворот.", "Есть угроза налета, деньги или высокая репутация.", "war,people,reputation"),
      eventRow("ext-kaldvelg-pirates", "uncommon", "Кальдвельгские тени", "Следом за торговым маршрутом появляются люди, говорящие слишком мягко для простых моряков и слишком внимательно считающие склады.", "Это разведка пиратов, скупщики краденого или начало будущего налета.", "Есть причал, склад, торговля или воздушные пути.", "war,trade,ship,kaldvelg"),
      eventRow("ext-monster-attack", "uncommon", "Атака чудовища", "Существо из пустошей, глубин, облаков или нижних земель выходит прямо к владению.", "Запустите оборонную сцену, охоту или масс-комбат малого масштаба.", "Низкая оборона, дикий регион или предыдущие следы.", "monster,war,sky-island"),
      eventRow("ext-runaway-property", "uncommon", "Охотники за беглецом", "Люди с документами требуют выдать того, кто якобы принадлежит, должен или служит им.", "Решение влияет на репутацию, закон и мораль поселения.", "Есть беженцы, бывшие рабы, должники или чужие семьи.", "law,people,reputation"),
      eventRow("ext-island-neighbor", "uncommon", "Сосед просит огня", "Близкое владение или корабль просит помощь: огонь, воду, лекаря, канат, молитву, свидетеля.", "Помощь создает союз или долг; отказ тоже запомнят.", "Есть соседи или активные маршруты.", "trade,culture,reputation"),
      eventRow("ext-courtly-envoy", "rare", "Посланник большого дома", "Человек с хорошими манерами и опасной охраной предлагает покровительство или маленькую услугу.", "Принять покровительство, отказаться или торговаться; это политическая зацепка.", "Высокая репутация или стратегическое место.", "reputation,law,trade"),
      eventRow("ext-vilezh-inquiry", "rare", "Вельежский следователь", "Следователь из Вельежского округа задает вопросы о деле, которое поселение считало забытым.", "Можно раскрыть правду, скрыть детали или перевести подозрения.", "Старые преступления, лагеря, исчезновения, жандармы.", "law,reputation,vilezh"),
      eventRow("ext-potroshiteli-contract", "rare", "Потрошители назначают цену", "L'Acrochet Muttantis слышали о чудовище поблизости и готовы взяться за дело, но цена выглядит почти непосильной.", "Можно нанять элитных охотников, собрать всем поселением плату или попытаться решить угрозу самим.", "Есть следы чудовища, нежить, Черная Пустыня или страх жителей.", "monster,war,trade,potroshiteli"),
      eventRow("ext-memory-kadens", "rare", "Кадены у дверей", "Люди Общества “Память” ищут старый документ, свидетеля или место, которое, по их словам, вычеркнули из официальной истории.", "Помощь даст союзников и скандал; отказ может породить слух о сокрытии правды.", "Есть Нованд, Сангрен, Флеченранд, старый лагерь, архив или политическая тайна.", "culture,law,reputation,memory,novand,sangren,fletchenrand"),
      eventRow("ext-free-miracle-workers", "rare", "Свободный чудотворец", "Чудотворец из Изуавера просит убежища, сцену для демонстрации или защиту от людей, считающих его опасным.", "Он может решить одну странную проблему, но привлечет страх, зависть или чиновников.", "Есть мистическая странность, Изуавер, высокая Культура или политический интерес.", "mystic,culture,law,izuaver,miracle-workers"),
      eventRow("ext-defenders-albugrir", "rare", "Защитники Альбугрира", "Отряд легендарных воителей просит припасы, проводника или место для раненых перед спуском в Черную Пустыню.", "Помощь дает славу и возможный долг Защитников; отказ тоже запомнят.", "Есть Черная Пустыня, кавтуры, военная репутация или высокий риск чудовищ.", "war,monster,reputation,black-desert,defenders"),
      eventRow("ext-fletchenrand-dispute", "rare", "Спор универсариев", "Две группы флеченрандских универсариев объявляют чужую гипотезу вредной и хотят проверить ее на вашем механизме, карте или странности.", "Можно получить знание и врага из другого университета.", "Есть сложные механизмы, карты, Флеченранд или высокая Технология.", "technology,culture,fletchenrand,mystic"),
      eventRow("ext-dichtbeir-amber", "rare", "Янтарная церковь", "Посланник Дихтбейра видит в поселении ересь, чужой культ или подозрительный механизм и предлагает очистить проблему по закону Щуки.", "Согласие может остановить конфликт, но ударит по свободе; отказ делает поселение заметным для экзархов.", "Есть Багровая Щука, Дихтбейр, чудотворство или высокая Технология.", "faith,crimson-pike,dichtbeir,law,technology"),
      eventRow("ext-black-desert-wind", "rare", "Ветер Черной Пустыни", "Черный сухой ветер приносит песок, гарь, больные сны и следы существ, не похожих на зверей.", "Проверьте запасы и здоровье; может появиться проклятая зацепка.", "Регионы рядом с пустошами или мистической угрозой.", "mystic,monster,food,black-desert"),
      eventRow("ext-dead-ship", "rare", "Мертвый корабль", "К владению дрейфует судно без ответа. На борту есть груз, но нет нормальной тишины.", "Абордаж/осмотр становится мини-приключением.", "Корабельные маршруты, летяги, туман.", "ship,mystic,trade"),
      eventRow("ext-naerder-silence", "rare", "Наэрдэрское молчание", "Закрытый посланник с Наэрдэра просит передать письмо без подписи и не задавать вопросов о тысячах людей, оставшихся за стенами.", "Письмо ведет к тайному долгу, заложнику или трагедии острова.", "Есть северные маршруты, Кальдвельг/Наэрдэр или политические тайны.", "law,culture,naerder,kaldvelg"),
      eventRow("ext-escaped-prisoners", "rare", "Сломанные кандалы", "Несколько беглецов просят впустить их до рассвета; у них разные версии одного побега.", "Принятие может дать жителей, врагов или правду о чужой тюрьме.", "Есть законники, рабский след или низкие земли.", "people,law,war"),
      eventRow("ext-red-seal-order", "rare", "Приказ с красной печатью", "Документ требует реквизиции еды, людей, помещения или корабельного места ради внешней нужды.", "Подчиниться, торговаться, подделать ответ или сопротивляться.", "Война, голод, карантин или сильная власть рядом.", "law,war,food"),
      eventRow("ext-boltrask-genealogist", "rare", "Болтраскский наследник", "Чудотворец Пути Наследия ищет родство, брачный расчет или пропавшую ветвь семьи среди жителей и гостей.", "Можно получить покровителя, спор о происхождении или неприятное требование вернуть человека.", "Есть дворянские связи, Болтраск, беженцы или тайное прошлое жителя.", "people,law,boltrask,mystic"),
      eventRow("ext-sarroyo-paper", "rare", "Тсукамовая бумага", "Торговец из Сарройо привозит дешевую бумажную ткань, книги, листы для карт и подозрительно хорошо упакованные культурные ценности.", "Можно улучшить учет/архив или вскрыть след бандитской перепродажи.", "Есть архив, карты, торговля или культурные предметы.", "trade,culture,sarroyo,storage"),
      eventRow("ext-royu-feud", "rare", "Две печати Ройу", "Два гонца из Сагеки и Мидеки требуют признать взаимоисключающие документы и едва не хватаются за оружие.", "Любое решение создает врага; нейтралитет потребует ловкости и свидетелей.", "Есть связи с Сейку, военные грузы или чужие документы.", "law,war,royu,seiku"),
      eventRow("ext-strange-patron", "rare", "Покровитель без имени", "Через посредника приходит подарок: деньги, редкий материал, лекарство или чертеж без подписи.", "Дар полезен, но принятие создает невидимый долг.", "Высокая репутация, тайные круги, редкие проекты.", "reputation,trade,mystic"),
      eventRow("ext-holy-dispute", "rare", "Чужой святой спор", "Две религиозные группы просят поселение стать нейтральным свидетелем спора о реликвии или чуде.", "Суд, отказ или укрытие реликвии меняют религиозные связи.", "Есть Культура, вера или репутация честного места.", "faith,culture,reputation"),
      eventRow("ext-pirate-test", "rare", "Пиратская проба", "Незнакомый капитан проверяет защиту: маленькая кража, ложный сигнал, разведка или наглый торг.", "Если слабость видна, следующим событием может быть налет.", "Есть торговля, причал, склад или слабая оборона.", "war,trade,ship"),
      eventRow("ext-sky-whale-shadow", "rare", "Тень огромного тела", "Под островом, над облаками или за туманом проходит силуэт невозможного размера.", "Он не атакует сразу, но меняет маршруты, погоду или поведение зверей.", "Летяги, высота, дикие воздушные пути.", "sky-island,monster,mystic"),
      eventRow("ext-foreign-healer", "rare", "Лекарь с тяжелой сумкой", "Странствующий лекарь предлагает помощь, но просит не деньги, а право осмотреть местную странность.", "Можно вылечить раненого/болезнь и получить медицинскую зацепку.", "Есть раненые, болезнь или необычный объект.", "people,mystic,trade"),
      eventRow("ext-masked-market", "rare", "Рынок под масками", "На одну ночь рядом возникает нелегальный обмен: люди не называют имен, товары не задают вопросов.", "Редкая покупка или продажа, но возможен долг/улика.", "Высокая репутация, контрабанда, странный регион.", "trade,law,mystic"),
      eventRow("ext-raid-warning", "rare", "Предупреждение о налете", "Союзник, пленник или испуганный торговец сообщает: на поселение смотрят как на добычу.", "Подготовьте оборону; налет может начаться в этом или следующем десятнике.", "Высокая репутация, богатый склад, слабая защита.", "war,reputation,storage"),
      eventRow("ext-lowerlands-delegation", "rare", "Послы нижних земель", "Грубая, уставшая или непривычная делегация приносит просьбу, угрозу или выгодный обмен.", "Сделка открывает новый региональный след.", "Поселение доступно с земли или известно по торговле.", "trade,culture,people"),
      eventRow("ext-saintless-procession", "legendary", "Процессия без святого", "Ночью мимо проходит процессия с пустыми носилками; участники уверены, что несут кого-то великого.", "Завязка: они ищут место, тело, имя или чудо, связанное с владением.", "Очень редкое религиозно-мистическое событие.", "faith,mystic,culture"),
      eventRow("ext-house-that-seeks", "legendary", "Дом ищет хозяина", "К поселению прибывает фрагмент чужого дома, комнаты или корабля, будто сам нашел дорогу.", "Завязка мини-приключения: внутри есть просьба, ловушка или наследство.", "Летяги, туман, сильная репутация или странные маршруты.", "mystic,housing,sky-island"),
      eventRow("ext-war-in-the-clouds", "legendary", "Бой над облаками", "Далеко в небе или за хребтами идет сражение; его обломки и беглецы падают к поселению.", "Выберите: спасать, прятаться, грабить поле боя или принимать сторону.", "Региональная война, летяги, корабли.", "war,ship,sky-island"),
      eventRow("ext-name-buyers", "legendary", "Покупатели имен", "Аккуратные чужаки предлагают серебро за имена мертвых, пропавших или еще не рожденных жителей.", "Продажа дает выгоду и страшное последствие; отказ может привлечь внимание.", "Есть кладбище, сироты, старая кровь или мистика.", "mystic,people,trade"),
      eventRow("ext-godly-audit", "legendary", "Проверка невозможного суда", "Кто-то или что-то предъявляет поселению обвинение на языке закона, веры и сна одновременно.", "Завязка: нужно доказать право владения существовать, хранить тайну или укрывать человека.", "Редчайшее событие для высокой репутации или религиозного конфликта.", "mystic,faith,law,reputation")
    ]
  }
};

const EXPANDED_RANDOM_EVENT_ROWS = {
  general: [
    eventRow("gen-shared-tools", "common", "Общий ящик инструментов", "Кто-то собирает разрозненные молотки, иглы, ключи, веревки и мелкие запасные детали в один понятный набор, которым перестают владеть все и никто.", "Следующая мелкая работа по строительству, ремонту или производству получает небольшой бонус либо обходится дешевле.", "Есть активная стройка, мастерская или часто ломающиеся узлы.", "technology,construction,production"),
    eventRow("gen-washed-lines", "common", "Большая стирка", "Поселение на день заполняют мокрые веревки, спор о мыле, украденном теплом месте и чужих пятнах на лучшей рубахе.", "Без прямого эффекта; хорошая сцена для бытовых разговоров, ревности и маленьких просьб.", "Есть жилье, казармы или много жителей.", "housing,people,culture"),
    eventRow("gen-work-song", "common", "Песня смены", "Одна из рабочих групп подхватывает ритм, который неожиданно помогает держать темп: кто-то стучит, кто-то поет, кто-то просто перестает ворчать.", "До конца следующей работы можно один раз смягчить усталость, ссору или небольшой штраф довольства.", "Есть производство, стройка или жители с культурными занятиями.", "culture,production,construction,people"),
    eventRow("gen-kitchen-quarrel", "common", "Ссора у котла", "Спор о пайках, очереди и чужой ложке вспыхивает громче, чем должен был. Претензии быстро становятся не о еде, а о справедливости.", "Если не разобрать конфликт, возможен временный штраф довольства или отказ одного жителя работать в прежней смене.", "Нехватка еды, низкое довольство или общая кухня.", "food,people,low-morale"),
    eventRow("gen-roof-patches", "common", "Латки на крыше", "Несколько жителей без приказа закрывают самые раздражающие щели: там, где капало, дуло или сыпалась пыль.", "Один риск порчи припасов, болезни от сырости или мелкого ремонта можно считать заранее сниженным.", "Есть жилье, склад или поврежденные постройки.", "housing,storage,construction"),
    eventRow("gen-missing-fasteners", "common", "Куда делись гвозди", "Нужных крепежей, заклепок, штифтов или ремней оказывается меньше, чем записано. Кто-то брал по мелочи, но теперь это стало заметно.", "Потратьте мелкий ресурс/серебро или задержите одну работу до пополнения запасов.", "Есть стройка, производство, склад или много мелкого учета.", "storage,technology,construction"),
    eventRow("gen-watch-gossip", "common", "Дозорные разговорились", "Ночной караул замечает не угрозу, а странную закономерность в чужих привычках, тайных встречах или поздних огнях.", "ГМ получает повод открыть малую тайну жителя, здания или соседней группы без немедленной опасности.", "Есть дозор, оборона или плотное население.", "defense,people,culture"),
    eventRow("gen-storeroom-inventory", "common", "Учет по-новому", "Скучная перепись припасов внезапно показывает, что часть расходов можно закрыть менее ценным запасом или старой заменой.", "Один ближайший бытовой расход можно уменьшить, заменить ресурсом или превратить в сцену обмена.", "Есть склад, казна, торговля или нехватка ресурсов.", "storage,trade,technology"),
    eventRow("gen-childish-question", "common", "Детский вопрос", "Самый младший помощник задает вопрос, на который взрослые давно перестали отвечать: почему это стоит здесь, кому это принадлежит, зачем все делают именно так.", "Вопрос вскрывает неэффективность, забытый запрет или маленькую тайну; ГМ выбирает, полезна она или неудобна.", "Есть дети, ученики или новые жители.", "people,culture,technology"),
    eventRow("gen-better-bedding", "common", "Сухая солома и нормальные одеяла", "Кто-то приводит спальные места в человеческий вид: чинит лежаки, сушит ткань, делит углы честнее.", "До конца следующего десятника один конфликт из-за жилья или усталости можно смягчить.", "Есть жилье или нехватка комфорта.", "housing,people,high-morale"),
    eventRow("gen-smoke-in-room", "common", "Дым в жилом углу", "Плохая тяга, треснувшая труба или неверно поставленная жаровня наполняет помещение едким дымом.", "Нужен мелкий ремонт; без него один житель может временно заболеть, а довольство слегка просядет.", "Есть жилье, кухня, мастерская или холодный сезон.", "housing,food,people"),
    eventRow("gen-corner-market", "common", "Уголок обмена", "Жители начинают менять друг у друга мелочи: лишний паек на услугу, пуговицы на табак, обещание на старый нож.", "Можно оформить местный рынок, но при низком довольстве он легко станет очагом обид и долгов.", "Есть разные семьи, ремесленники или дефицитные мелочи.", "people,trade,culture"),
    eventRow("gen-borrowed-hands", "common", "Свободные руки нашлись", "Несколько жителей на один день закрывают чужую смену без долгих просьб: помочь донести, подлатать, просеять, разобрать.", "Одна простая работа получает дополнительную помощь или завершается без обычной задержки.", "Есть свободные жители или высокое довольство.", "people,production,construction,high-morale"),
    eventRow("gen-water-queue", "common", "Очередь у воды", "У источника, цистерны или бочки собирается очередь, и вместе с ведрами люди приносят слухи, жалобы и старые просьбы.", "ГМ выбирает одну бытовую проблему, которую жители наконец проговаривают вслух.", "Есть источник воды, кухня или напряжение из-за быта.", "food,storage,people"),
    eventRow("gen-old-offense", "common", "Старая обида всплыла", "Короткая фраза возвращает давнюю ссору: кто кого бросил в беде, кто получил лучшее место, кто присвоил чужую заслугу.", "Если конфликт не уладить, два жителя или две группы хуже работают вместе до конца следующего десятника.", "Есть низкое довольство, тесное жилье или жители с общим прошлым.", "people,low-morale,housing"),
    eventRow("gen-clear-paths", "common", "Расчищенные проходы", "Мусор, ящики, старые доски и временные заграждения наконец исчезают с самых ходовых мест.", "Следующий пожар, тревога, перенос груза или эвакуация получает преимущество по решению ГМа.", "Есть склад, оборона, производство или тесная планировка.", "storage,defense,production"),
    eventRow("gen-feast-leftovers", "common", "Удачные остатки", "После общей трапезы или переработки внезапно остается больше полезного, чем ожидали: бульон, ткань, уголь, масло, мелкая тара.", "Получите малый запас еды или расходника либо снизьте цену ближайшего бытового снабжения.", "Есть кухня, производство еды или хорошие запасы.", "food,storage,production"),
    eventRow("gen-small-rule", "common", "Новое правило на стене", "Кто-то вывешивает простое правило: кто запирает склад, кто моет инструменты, кто отвечает за ночной огонь.", "Если правило поддержать, оно снижает один бытовой риск; если высмеять, его автор обидится.", "Есть склад, мастерская, оборона или часто повторяющаяся проблема.", "storage,technology,defense"),
    eventRow("gen-apprentice-lesson", "uncommon", "Урок без наставника", "Ученик или новичок сам разбирается с задачей, которая раньше требовала старшего, и теперь ходит слишком гордый.", "Один житель получает сцену роста; можно улучшить его роль, навыковую репутацию или доверие группы.", "Есть ученики, свободные жители, школа или мастерская.", "people,technology,culture"),
    eventRow("gen-rambar-rest-demand", "uncommon", "Право на добрый отдых", "Верующие Рамбара или просто уставшие мастера требуют один вечер без приказов, чтобы работа снова была радостной, а не каторжной.", "Если дать отдых, следующее производство или стройка получает небольшой бонус; если отказать, возможна усталость или ворчание.", "Есть ремесленники, высокая нагрузка или вера Рамбара.", "rambar,production,construction,people"),
    eventRow("gen-moon-ledger", "uncommon", "Запись при трех огнях", "В ночной смене кто-то находит ведомость, где важные цифры будто меняются при свете разных свечей.", "ГМ выбирает: это ошибка учета, след тайного долга или мистическая подсказка к ресурсам поселения.", "Есть архив, казна, вера Тримунэлии или странные записи.", "trimunelia,storage,culture,mystic"),
    eventRow("gen-secret-cache", "uncommon", "Тайник под настилом", "Под старой доской, за кирпичом или в двойном дне ящика находится небольшой тайник прежних жильцов.", "Получите малую ценность, записку или предмет-зацепку; владелец тайника может объявиться позже.", "Есть старые здания, руины, склад или чужое прошлое.", "storage,housing,mystic"),
    eventRow("gen-humming-crystal", "uncommon", "Гул под ногами", "В одну и ту же пору пол, балки или камень острова начинают тихо отдавать низким звуком, который слышат не все.", "Гул может подсказать маршрут дрейфа, неисправность или присутствие чего-то в глубине острова.", "Летяг, остров, механизм подъема или высокая технология.", "sky-island,technology,mystic"),
    eventRow("gen-unsent-letters", "uncommon", "Непосланные письма", "В вещах жителя или в общем хламе находятся письма, которые никто так и не отправил.", "Письма открывают личную связь, угрозу, наследство или просьбу, которую можно разыграть сценой.", "Есть архив, умершие, беглецы или далекие связи.", "people,culture,law"),
    eventRow("gen-omen-at-work", "uncommon", "Дурная примета в смене", "Инструмент падает трижды, имя произносится не к месту, а один из работников отказывается продолжать без очищения или знака.", "Без сцены успокоения одна работа получает помеху; религиозный ответ может превратить событие в плюс довольства.", "Есть суеверные жители, вера, мастерская или опасный труд.", "faith,people,production,low-morale"),
    eventRow("gen-locked-door", "uncommon", "Дверь, которую никто не строил", "В знакомом здании обнаруживается дверь, люк или ниша, которую все уверены не замечать раньше.", "Мини-зацепка: внутри может быть старый долг, опасная полость, чужой склад или невозможный проход.", "Есть старые здания, мистическая особенность или высокий уровень Культуры/Технологии.", "housing,technology,mystic"),
    eventRow("gen-machinery-spark", "uncommon", "Искра в механизме", "Мелкий механизм, насос, подъемник или станок дергается и дает искру в самый неудобный момент.", "Потребуется ремонт или проверка; игнорирование может привести к пожару, травме или подозрениям Янтарной Церкви.", "Есть механизмы, производство или высокая Технология.", "technology,production,crimson-pike"),
    eventRow("gen-school-play", "uncommon", "Учебная постановка", "Дети, ученики или скучающие жители разыгрывают историю поселения так смешно и точно, что взрослым становится неловко.", "Можно снять напряжение, открыть забытую заслугу или дать +1 довольства при поддержке праздника.", "Есть школа, дети, высокая Культура или общественная площадь.", "culture,people,high-culture"),
    eventRow("gen-false-accusation", "uncommon", "Обвинение без тела", "Кого-то обвиняют в краже, порче или предательстве, но улики слишком аккуратны и слишком вовремя найдены.", "Нужна проверка; поспешный суд снизит довольство или создаст врага внутри поселения.", "Есть склад, низкое довольство, законники или ценные запасы.", "law,storage,people,low-morale"),
    eventRow("gen-good-silence", "uncommon", "Хорошая тишина", "В поселении на несколько часов становится тихо не от страха, а от сосредоточенности: все заняты нужным делом.", "Одна группа жителей восстанавливает силы; ГМ может снять малую усталость, раздражение или последствия бессонной ночи.", "Высокое довольство, Рамбар, усталые смены или много жителей.", "people,rambar,high-morale"),
    eventRow("gen-cemetery-light", "rare", "Огонь на месте памяти", "Ночью на могиле, старом знаке или пустом углу появляется ровный свет, который не гаснет от ветра.", "Завязка: свет указывает на невыполненное обещание, спрятанную вещь или имя, которое нельзя забыть.", "Есть кладбище, погибшие, Общество Память или вера Тримунэлии.", "mystic,people,memory,trimunelia"),
    eventRow("gen-broken-lift-echo", "rare", "Эхо сорванного подъема", "Остров или ключевой узел здания на миг ведет себя так, будто его тянут вниз: канаты звенят, пол уходит, люди хватаются за стены.", "Проверьте важный механизм или конструкцию; без ремонта следующий шторм/дрейф/удар будет опаснее.", "Летяг, подъемные механизмы, старые узлы или след Будильников.", "sky-island,technology,faeliran"),
    eventRow("gen-dream-map", "legendary", "Карта, приснившаяся всем", "Несколько жителей просыпаются с одинаковым фрагментом карты в памяти, но каждый помнит свой кусок и спорит о направлении.", "Завязка мини-приключения: карта ведет к месту, которое может быть реальным, будущим или украденным из сна.", "Высокая Культура, Тримунэлия, летяг или странные сны.", "mystic,trimunelia,cartographers,sky-island")
  ],
  external: [
    eventRow("ext-small-caravan", "common", "Малый караван", "К поселению подходит небольшой караван, лодка, телега или грузовая платформа с простыми товарами и усталыми людьми.", "Можно выгодно купить один базовый ресурс, продать излишки или узнать свежие слухи маршрута.", "Поселение известно, есть торговля, порт или открытый маршрут.", "trade,reputation,port"),
    eventRow("ext-weathered-mail", "common", "Почта с запозданием", "Приходит пачка писем, ведомостей и чужих уведомлений, которые должны были попасть сюда много дней назад.", "Одно письмо дает зацепку: долг, наследство, просьбу, угрозу или ошибочный приказ.", "Высокая репутация, торговые связи или жители с прошлым.", "law,culture,people,high-reputation"),
    eventRow("ext-wandering-mason", "common", "Бродячий мастер", "Мастер на короткой остановке предлагает починить, измерить или усилить то, что давно раздражает местных.", "За плату или услугу можно снизить стоимость ближайшего ремонта/стройки либо получить совет по зданию.", "Есть поврежденные здания, стройка или хорошая репутация.", "construction,technology,trade"),
    eventRow("ext-lost-soldier", "common", "Солдат не той войны", "Одинокий вооруженный человек просит воды и ночлега. Его форма, клятва или страхи относятся к конфликту, который здесь понимают плохо.", "Можно получить бойца, врага по следу или сведения о войне неподалеку.", "Есть военные маршруты, низкая защита или пограничный регион.", "war,people,law"),
    eventRow("ext-food-broker", "common", "Закупщик пайков", "Посредник ищет место, где можно быстро купить или обменять еду, сухари, соль, крупу и все, что переживет дорогу.", "Продажа дает деньги/репутацию; отказ может оставить запас, но упустить связь.", "Есть избыток еды или торговля.", "food,trade,reputation"),
    eventRow("ext-tax-clerk", "common", "Счетовод с печатью", "Чиновник, сборщик или самозванец предъявляет старую бумагу, где поселение почему-то числится должником.", "Разобраться, заплатить, доказать ошибку или выставить его прочь; любое решение оставляет бумажный след.", "Есть законная власть рядом, высокая репутация или спорное владение.", "law,trade,reputation"),
    eventRow("ext-jandarmerie-question", "common", "Вопрос жандарма", "Жандарм, дознаватель или окружной представитель задает вежливые вопросы о недавнем преступлении, пропавших людях или старом лагере.", "Честность даст правовую связь; сокрытие может защитить тайну, но создаст риск проверки позже.", "Есть Нованд, Вельеж, преступление, лагерь или высокая репутация.", "law,novand,vilezh,reputation"),
    eventRow("ext-route-rumor", "common", "Слух о новом маршруте", "Пилот, проводник или торговец рассказывает о безопасном обходе, новом ветре, военном посту или странной зоне молчания.", "ГМ отмечает маршрут, который даст выгоду или угрозу при следующем путешествии/торговле.", "Есть порт, летяги, торговля или картографы.", "port,trade,cartographers,sky-island"),
    eventRow("ext-novand-wine", "uncommon", "Новандское вино", "Грузчик с Нованда предлагает несколько бочек вина, слишком дешевых для своего качества и слишком поспешных для честной сделки.", "Можно устроить праздник, перепродать товар или выяснить, от кого груз увезли.", "Нованд, торговля, культура или низкое довольство.", "novand,trade,culture"),
    eventRow("ext-sirastien-arms", "uncommon", "Сирастьенский агент", "Представитель оружейной артели интересуется, нужны ли поселению мушкеты, порох, наемные инструкторы или просто тихий склад.", "Сделка укрепляет оборону, но привлекает внимание врагов Сирастьена и местных законников.", "Сирастьен, война, оборона или высокая репутация.", "sirastien,war,trade,defense"),
    eventRow("ext-izuaver-petition", "uncommon", "Прошение чудотворца", "Чудотворец из Изуавера просит поселение стать нейтральной площадкой для разговора, исцеления или опасной демонстрации дара.", "Можно получить чудо, долг гильдии или конфликт с теми, кто чудотворение не терпит.", "Изуавер, вера, больные жители или высокий уровень Культуры.", "izuaver,miracle-workers,faith,mystic"),
    eventRow("ext-pai-orgul-scrap", "uncommon", "Кавтурский лом", "Торговец предлагает странные детали из Пай Оргула: полезные, запрещенные, пахнущие дымом и слишком хорошо подходящие к местным поломкам.", "Детали ускорят ремонт/проект, но могут стать поводом для религиозных или правовых претензий.", "Пай Оргул, высокая Технология, механизмы или Янтарная Церковь.", "pai-orgul,technology,crimson-pike,trade"),
    eventRow("ext-dichtbeir-refugee", "uncommon", "Беглец от янтарного суда", "Человек с обожженной печатью на документах просит убежища и уверяет, что виноват только в неправильной молитве или механизме.", "Принять - получить жителя и врага; выдать - получить благодарность властей и тяжелый осадок.", "Дихтбейр, вера, механизмы или спор о законе.", "dichtbeir,crimson-pike,law,people"),
    eventRow("ext-tiribor-ore", "uncommon", "Тироборская проба руды", "Молчаливые торговцы из Тиробора предлагают оценить или обменять необычный металл, не объясняя, почему им нужна именно ваша площадка.", "Можно получить редкий материал, заказ на хранение или тайный горный конфликт.", "Тиробор, производство, кузница или торговый путь.", "tiribor,trade,technology"),
    eventRow("ext-yaknizem-escort", "uncommon", "Якниземский пролет", "Караван с якниземскими знаками просит права пройти над поселением или рядом с ним, обещая плату за молчание и огни.", "Согласие дает товар/слухи, но может вовлечь в ханские разборки; отказ может вызвать обиду сильных всадников неба.", "Якнизем, воздушный маршрут, порт или война.", "yaknizem,trade,war,sky-island"),
    eventRow("ext-horslia-regulator", "uncommon", "Регулятор из Хорслии-Онатквы", "Деловой инспектор ищет место для учета труда, долгов или добычи, говоря о компромиссе так, будто это оружие.", "Он может помочь с доходом/рабочими правилами, но потребует прозрачности и доли влияния.", "Хорслия, Онатква, шахты, трудовой конфликт или доход.", "horslia-ontakwa,law,trade,production"),
    eventRow("ext-fletchenrand-patent", "uncommon", "Флеченрандский патент", "Письмо утверждает, что один из ваших механизмов, чертежей или методов нарушает чье-то университетское право.", "Можно заплатить, спорить, украсть встречный патент или вызвать универсариев на проверку.", "Флеченранд, высокая Технология, мастерские или архив.", "fletchenrand,technology,law"),
    eventRow("ext-kaldvelg-ransom", "uncommon", "Кальдвельгский выкуп", "Пиратский посредник предлагает купить свободу пленника, вернуть груз или оплатить неприкосновенность будущих рейсов.", "Сделка может спасти людей, но признает поселение платежеспособной целью; отказ грозит налетом позже.", "Кальдвельг, порт, торговля или слабая оборона.", "kaldvelg,war,trade,ship"),
    eventRow("ext-naerder-sealed-box", "uncommon", "Ящик без отправителя", "Закрытый ящик с северными отметками прибывает вместе с просьбой не открывать его до определенного дня.", "Хранение даст плату и тайну; вскрытие даст зацепку и врагов, которые знают, что вы вскрыли.", "Наэрдэр, северные маршруты, склад или тайные связи.", "naerder,storage,law,mystic"),
    eventRow("ext-sangren-champion", "uncommon", "Сангренский вызов", "Путешествующий чемпион предлагает честное состязание: стрельба, ремесло, спор, бег по канатам или трудовой рекорд.", "Победа дает репутацию/приз; поражение все равно может поднять дух, если устроить праздник.", "Сангрен, высокая Культура, спорт, ремесло или гордое поселение.", "sangren,culture,reputation"),
    eventRow("ext-boltrask-marriage", "uncommon", "Брачный расчет Болтраска", "Посланник с родословными схемами ищет среди жителей подходящую связь, наследника или свидетеля старого союза.", "Можно получить покровительство, проблему личной свободы или человека, которого внезапно считают важным.", "Болтраск, семьи, дворянство или скрытое прошлое.", "boltrask,people,law"),
    eventRow("ext-sarroyo-printer", "uncommon", "Дешевая печать Сарройо", "Печатник или тсуками-продавец предлагает листовки, книги учета, карты, вывески и слишком красивые копии важных бумаг.", "Можно улучшить архив/культуру или создать документы, которые потом придется объяснять.", "Сарройо, Культура, архив, торговля.", "sarroyo,seiku,culture,storage"),
    eventRow("ext-seiku-bandit-art", "uncommon", "Краденая культурная ценность", "У поселения пытаются продать предмет искусства, книгу или ритуальную вещь с явными следами чужой крови и плохой легендой.", "Покупка дает ценность и врагов; отказ может привести к попытке спрятать предмет у вас без спроса.", "Сейку, Сарройо, Ройу, торговля или культурные предметы.", "seiku,sarroyo,royu,trade,culture"),
    eventRow("ext-stl-debt", "uncommon", "Вежливый долг СТЛ", "Фактор Свободной Торговой Лиги предлагает помощь сейчас, оплату потом и договор, где самые мелкие строки написаны увереннее крупных.", "Можно получить ресурс/перевозку/кредит; долг станет будущим внешним событием.", "Высокая репутация, торговля, нехватка ресурсов или СТЛ.", "stl,trade,high-reputation"),
    eventRow("ext-elbow-strikebreakers", "uncommon", "Локти по найму", "Группа работников из Гильдий Локтя предлагает заменить недовольную смену, но местные понимают это как угрозу.", "Найм ускорит работу и снизит довольство; отказ может оставить проблему труда нерешенной.", "Есть низкое довольство, стройка, производство или Гильдии Локтя.", "elbow,people,production,low-morale"),
    eventRow("ext-blagostni-quarantine", "uncommon", "Отряд блага", "Благостни приходят с лекарствами, одеялами и строгими вопросами о раненых, больных и голодных.", "Можно вылечить часть беды или получить гуманитарный запас; сокрытие проблем ухудшит отношения.", "Есть болезни, голод, раненые, война или Благостни.", "blagostni,people,food,war"),
    eventRow("ext-memory-testimony", "uncommon", "Каден ищет свидетельство", "Представитель Общества Память просит записать историю поселения, особенно неудобные имена, рабские следы и исчезнувшие документы.", "Запись может дать репутацию честного места или открыть конфликт с теми, кто предпочитает молчание.", "Нованд, Память, старый лагерь, архив или жители с прошлым.", "memory,novand,culture,law"),
    eventRow("ext-free-miracle-shelter", "rare", "Свободный чудотворец просит кров", "Чудотворец без свиты просит безопасную комнату на одну ночь, обещая не чудить без разрешения. Обещает слишком аккуратно.", "Если пустить, можно получить исцеление, защиту от духа или опасного преследователя утром.", "Изуавер, чудотворцы, раненые, мистика или высокая репутация.", "miracle-workers,izuaver,mystic,people"),
    eventRow("ext-cartographers-new-island", "rare", "Черновик нового острова", "Картографы Юлия Люциуса показывают несовпадающий с известными картами фрагмент суши и просят местный ориентир для сверки.", "Можно открыть маршрут, получить карту или стать точкой в большом исследовательском деле.", "Картографы, летяг, высокие маршруты или странный дрейф.", "cartographers,sky-island,culture"),
    eventRow("ext-defenders-scarred", "rare", "Раненый Защитник Альбугрира", "Воин с оружием, испорченным черным песком, просит не славы, а воды, перевязки и места, где никто не будет спрашивать о нижних землях.", "Помощь дает сильного союзника и страшное предупреждение; отказ может оставить на поселении дурную славу.", "Черная Пустыня, Защитники Альбугрира, монстры или раненые.", "defenders,black-desert,monster,people"),
    eventRow("ext-potroshiteli-bait", "rare", "Приманка Потрошителей", "Потрошители уверяют, что чудовище идет по следу именно сюда, и предлагают использовать поселение как удобную клетку с наживкой.", "Согласие готовит охоту и риск для зданий; отказ не гарантирует, что чудовище сменит маршрут.", "Потрошители, монстр, высокая репутация или след недавней твари.", "potroshiteli,monster,war"),
    eventRow("ext-black-desert-column", "rare", "Черная колонна внизу", "Снизу или с дальнего края горизонта виден столб черной пыли, который движется против ветра и будто считает расстояние до поселения.", "Это предупреждение о кавтурах, проклятии, беглецах или грядущем смещении маршрутов; готовьте оборону/запасы.", "Черная Пустыня, кавтуры, низкие маршруты или мистическая угроза.", "black-desert,pai-orgul,monster,mystic"),
    eventRow("ext-crimson-pike-inspector", "rare", "Экзарх Багровой Щуки", "Строгий представитель Янтарной Церкви требует осмотреть механизмы, книги и верования, чтобы отсечь волю кавтуров.", "Проверка может очистить подозрение или разрушить свободу поселения; отказ создает религиозно-правового врага.", "Дихтбейр, Багровая Щука, механизмы, чудотворение или чужие культы.", "crimson-pike,dichtbeir,law,faith,technology"),
    eventRow("ext-three-moon-envoy", "rare", "Посланник трех лун", "Наблюдатель Тримунэлии просит одну ночь не гасить три огня и не лгать под ними, потому что поселение попало в чужое предзнаменование.", "Ночь может открыть тайну, примирить спор или дать сновидческую карту; ложь оставит мистический след.", "Тримунэлия, вера, тайны, карты или ночные события.", "trimunelia,faith,mystic,culture"),
    eventRow("ext-wakers-sabotage", "legendary", "Будильники у ключевого узла", "Следы ведут к тем, кто верит, что мир надо разбудить падением: они уже нашли важный кристалл, подъемный механизм или основу острова.", "Завязка мини-приключения и возможный масс-комбат/диверсия: остановить их нужно до следующего большого движения.", "Фаэлиранство, летяг, ключевые механизмы или странные проповеди о конце.", "faeliran,sky-island,technology,war"),
    eventRow("ext-name-storm", "legendary", "Буря чужих имен", "Над поселением проходит буря, в которой вместо грома слышны имена людей, которых здесь никто не знает, хотя некоторые отвечают во сне.", "Завязка: каждое имя связано с будущим гостем, мертвым должником или жителем, которого реальность пока не пустила внутрь.", "Высокая репутация, мистика, Тримунэлия, Память или сильный дрейф.", "mystic,reputation,trimunelia,memory")
  ]
};

DEFAULT_RANDOM_EVENT_TABLES.general.rows.push(...EXPANDED_RANDOM_EVENT_ROWS.general);
DEFAULT_RANDOM_EVENT_TABLES.external.rows.push(...EXPANDED_RANDOM_EVENT_ROWS.external);


function optionLabel(options = [], value = "") {
  const key = String(value ?? "");
  return options.find((option) => String(option.value) === key)?.label ?? key;
}

const REQUIREMENT_TYPE_BY_VALUE = new Map(EVENT_REQUIREMENT_TYPE_OPTIONS.map((option) => [option.value, option]));
const REGION_VALUES = new Set(EVENT_REGION_OPTIONS.map((option) => option.value));
const FAITH_VALUES = new Set(EVENT_FAITH_OPTIONS.map((option) => option.value));
const FACTION_VALUES = new Set(EVENT_FACTION_OPTIONS.map((option) => option.value));
const FEATURE_VALUES = new Set(EVENT_FEATURE_OPTIONS.map((option) => option.value));
const DEVELOPMENT_VALUES = new Set(EVENT_DEVELOPMENT_OPTIONS.map((option) => option.value));
const BUILDING_FUNCTION_VALUES = new Set(EVENT_BUILDING_FUNCTION_OPTIONS.map((option) => option.value));
const HOLDING_TYPE_VALUES = new Set(EVENT_HOLDING_TYPE_OPTIONS.map((option) => option.value));
const CALENDAR_VALUES = new Set(EVENT_CALENDAR_OPTIONS.map((option) => option.value));
const VISIBILITY_VALUES = new Set(EVENT_VISIBILITY_OPTIONS.map((option) => option.value));
const COMBAT_PRESET_VALUES = new Set(EVENT_COMBAT_PRESET_OPTIONS.map((option) => option.value));
const IGNORED_FEATURE_VALUES = new Set(["people", "mystic", "development"]);
const IGNORED_CALENDAR_VALUES = new Set(["shadow-day"]);
const LEGACY_FEATURE_VALUE_MAP = new Map([
  ["small-population", "low-population"],
  ["large-population", "high-population"],
  ["reputation", "high-reputation"]
]);

function splitLegacyTags(value = "") {
  return String(value ?? "")
    .split(/[,;\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function tagName(token = "") {
  return String(token ?? "").replace(/^[+!]/, "");
}

function normalizeRequirementLogic(value = "all") {
  const logic = String(value ?? "all");
  return ["all", "any", "none"].includes(logic) ? logic : "all";
}

function defaultOperatorForType(type = "feature") {
  return REQUIREMENT_TYPE_BY_VALUE.get(type)?.defaultOperator ?? "present";
}

function normalizeRequirementOperator(type = "feature", operator = "") {
  const definition = REQUIREMENT_TYPE_BY_VALUE.get(type);
  const allowed = Array.isArray(definition?.operators) ? definition.operators : [];
  const value = String(operator ?? "");
  if (allowed.includes(value)) return value;
  return defaultOperatorForType(type);
}

function normalizeRequirementType(value = "feature") {
  const type = String(value ?? "feature");
  return REQUIREMENT_TYPE_BY_VALUE.has(type) ? type : "feature";
}

function normalizeRequirementNumber(value = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export function normalizeEventRequirement(rule = {}, fallbackId = "") {
  if (!isPlainObject(rule)) return null;
  const sourceType = normalizeRequirementType(rule.type ?? rule.kind ?? "feature");
  const id = String(rule.id || fallbackId || makeId("req"));
  const key = String(rule.key ?? rule.stat ?? rule.field ?? "").trim();
  const rawValue = String(rule.value ?? rule.target ?? "").trim();
  const legacyShipType = sourceType === "holding-type" && rawValue === "ship";
  const type = legacyShipType ? "feature" : sourceType;
  const sourceOperator = String(rule.operator ?? rule.op ?? "");
  const operator = legacyShipType
    ? (sourceOperator === "is-not" ? "absent" : "present")
    : normalizeRequirementOperator(type, sourceOperator);
  const value = type === "feature" ? (LEGACY_FEATURE_VALUE_MAP.get(rawValue) ?? rawValue) : rawValue;
  const number = normalizeRequirementNumber(rule.number ?? rule.amount ?? rule.valueNumber ?? rule.threshold ?? rule.value ?? 0);
  return { id, type, operator, key, value, number };
}

function isIgnoredEventRequirement(rule = null) {
  if (rule?.type === "feature") return IGNORED_FEATURE_VALUES.has(String(rule.value ?? ""));
  if (rule?.type === "calendar") return IGNORED_CALENDAR_VALUES.has(String(rule.value ?? ""));
  return false;
}

function legacyDevelopmentRequirement(key = "", operator = "gte", number = 1) {
  return { id: makeId("req"), type: "development", operator, key, value: "", number };
}

function legacyTagToRequirement(token = "") {
  const key = tagName(token);
  if (!key) return null;
  if (IGNORED_FEATURE_VALUES.has(key)) return null;
  if (key.startsWith("low-")) {
    const devKey = key.slice(4);
    if (DEVELOPMENT_VALUES.has(devKey) || FEATURE_VALUES.has(key)) return { id: makeId("req"), type: "feature", operator: "present", key: "", value: key, number: 0 };
  }
  if (key.startsWith("high-")) {
    const devKey = key.slice(5);
    if (DEVELOPMENT_VALUES.has(devKey) || FEATURE_VALUES.has(key)) return { id: makeId("req"), type: "feature", operator: "present", key: "", value: key, number: 0 };
  }
  if (DEVELOPMENT_VALUES.has(key)) return legacyDevelopmentRequirement(key, "gte", 1);
  if (LEGACY_FEATURE_VALUE_MAP.has(key)) return { id: makeId("req"), type: "feature", operator: "present", key: "", value: LEGACY_FEATURE_VALUE_MAP.get(key), number: 0 };
  if (REGION_VALUES.has(key)) return { id: makeId("req"), type: "region", operator: "is", key: "", value: key, number: 0 };
  if (FAITH_VALUES.has(key)) return { id: makeId("req"), type: "faith", operator: "present", key: "", value: key, number: 0 };
  if (FACTION_VALUES.has(key)) return { id: makeId("req"), type: "faction", operator: "present", key: "", value: key, number: 0 };
  if (CALENDAR_VALUES.has(key)) return { id: makeId("req"), type: "calendar", operator: "is", key: "", value: key, number: 0 };
  if (BUILDING_FUNCTION_VALUES.has(key)) return { id: makeId("req"), type: "building-function", operator: "present", key: "", value: key, number: 0 };
  if (key === "construction") return { id: makeId("req"), type: "construction", operator: "present", key: "", value: "", number: 0 };
  if (key === "storage") return { id: makeId("req"), type: "storage", operator: "present", key: "", value: "", number: 0 };
  if (key === "defense") return { id: makeId("req"), type: "defense", operator: "present", key: "", value: "", number: 0 };
  if (FEATURE_VALUES.has(key)) return { id: makeId("req"), type: "feature", operator: "present", key: "", value: key, number: 0 };
  return null;
}

function invertRequirement(rule = null) {
  if (!rule) return null;
  const inverted = { ...rule, id: makeId("req") };
  const map = {
    present: "absent",
    absent: "present",
    is: "is-not",
    "is-not": "is",
    contains: "not-contains",
    "not-contains": "contains",
    gte: "lt",
    gt: "lte",
    lte: "gt",
    lt: "gte",
    eq: "neq",
    neq: "eq"
  };
  inverted.operator = normalizeRequirementOperator(inverted.type, map[inverted.operator] ?? "absent");
  return inverted;
}

export function legacyTagsToRequirements(tags = "") {
  const tokens = splitLegacyTags(tags);
  const rules = [];
  let hasStrictToken = false;
  for (const token of tokens) {
    const blocked = token.startsWith("!");
    const strict = blocked || token.startsWith("+");
    if (!strict) continue;
    hasStrictToken = true;
    const rule = legacyTagToRequirement(token);
    if (!rule) continue;
    const cleanId = tagName(token).replace(/[^a-z0-9_-]+/gi, "-") || "tag";
    const normalizedRule = blocked ? invertRequirement(rule) : rule;
    normalizedRule.id = `legacy-${cleanId}-${rules.length + 1}`;
    rules.push(normalizedRule);
  }
  return {
    logic: hasStrictToken || rules.length <= 1 ? "all" : "any",
    rules: rules.map((rule, index) => normalizeEventRequirement(rule, `req-${index + 1}`)).filter(Boolean)
  };
}

export function legacyTagsToBoosts(tags = "") {
  const rules = [];
  for (const token of splitLegacyTags(tags)) {
    if (token.startsWith("!") || token.startsWith("+")) continue;
    const rule = legacyTagToRequirement(token);
    if (!rule) continue;
    const cleanId = tagName(token).replace(/[^a-z0-9_-]+/gi, "-") || "tag";
    rule.id = `boost-${cleanId}-${rules.length + 1}`;
    rules.push(rule);
  }
  return {
    logic: "any",
    rules: rules.map((rule, index) => normalizeEventRequirement(rule, `boost-${index + 1}`)).filter(Boolean)
  };
}

export function normalizeRandomEventRequirements(source = null, legacyTags = "") {
  if (Array.isArray(source)) {
    return {
      logic: "all",
      rules: source.map((rule, index) => normalizeEventRequirement(rule, `req-${index + 1}`)).filter((rule) => rule && !isIgnoredEventRequirement(rule))
    };
  }
  if (isPlainObject(source)) {
    const rulesSource = Array.isArray(source.rules) ? source.rules : (Array.isArray(source.items) ? source.items : []);
    return {
      logic: normalizeRequirementLogic(source.logic ?? source.mode ?? "all"),
      rules: rulesSource.map((rule, index) => normalizeEventRequirement(rule, `req-${index + 1}`)).filter((rule) => rule && !isIgnoredEventRequirement(rule))
    };
  }
  return legacyTagsToRequirements(legacyTags);
}

export function normalizeRandomEventBoosts(source = null, legacyTags = "") {
  if (Array.isArray(source)) {
    return {
      logic: "any",
      rules: source.map((rule, index) => normalizeEventRequirement(rule, `boost-${index + 1}`)).filter((rule) => rule && !isIgnoredEventRequirement(rule))
    };
  }
  if (isPlainObject(source)) {
    const rulesSource = Array.isArray(source.rules) ? source.rules : (Array.isArray(source.items) ? source.items : []);
    return {
      logic: "any",
      rules: rulesSource.map((rule, index) => normalizeEventRequirement(rule, `boost-${index + 1}`)).filter((rule) => rule && !isIgnoredEventRequirement(rule))
    };
  }
  return legacyTagsToBoosts(legacyTags);
}

export function normalizeRandomEventRow(row = {}, fallbackId = "") {
  if (!isPlainObject(row)) return null;
  const id = String(row.id || fallbackId || makeId("event"));
  const rarity = ["common", "uncommon", "rare", "legendary"].includes(String(row.rarity ?? "")) ? String(row.rarity) : "uncommon";
  const text = mergeEventText(row.text ?? row.entry ?? row.description ?? "", row.effect ?? row.result ?? "");
  const visibility = VISIBILITY_VALUES.has(String(row.visibility ?? "")) ? String(row.visibility) : "public";
  const combatPreset = COMBAT_PRESET_VALUES.has(String(row.combatPreset ?? "")) ? String(row.combatPreset ?? "") : "";
  return {
    id,
    weight: Math.max(0, toNumber(row.weight, LEGACY_RARITY_WEIGHT[rarity] ?? 4)),
    title: String(row.title ?? row.name ?? "Событие"),
    text,
    requirements: normalizeRandomEventRequirements(row.requirements ?? row.dependencyRules ?? null, row.tags ?? row.contextTags ?? ""),
    boosts: normalizeRandomEventBoosts(row.boosts ?? row.context ?? row.contextRules ?? null, row.tags ?? row.contextTags ?? ""),
    visibility,
    gmText: String(row.gmText ?? row.gmNotes ?? row.secret ?? ""),
    cooldown: Math.max(0, Math.floor(toNumber(row.cooldown ?? row.repeatCooldown, 0))),
    chainId: String(row.chainId ?? row.chain ?? ""),
    nextEventId: String(row.nextEventId ?? row.nextEvent ?? ""),
    combatPreset,
    effects: normalizeRandomEventEffects(row.effects ?? row.effectActions ?? []),
    contentVersion: Math.max(1, Math.floor(toNumber(row.contentVersion ?? row.version, 1))),
    contentSource: String(row.contentSource ?? row.source ?? "")
  };
}

function mergeDefaultEventRows(defaultRows = [], sourceRows = []) {
  const sourceById = new Map();
  const consumed = new Set();
  for (const row of sourceRows) {
    const id = String(row?.id ?? "");
    if (id && !sourceById.has(id)) sourceById.set(id, row);
  }

  const merged = defaultRows.map((row) => {
    const id = String(row?.id ?? "");
    if (id && sourceById.has(id)) {
      consumed.add(id);
      return sourceById.get(id);
    }
    return row;
  });

  for (const row of sourceRows) {
    const id = String(row?.id ?? "");
    if (id && consumed.has(id)) continue;
    merged.push(row);
  }

  return merged;
}

export function normalizeRandomEventTables(source = null) {
  const sourceTables = isPlainObject(source) ? source : {};
  const result = {};

  for (const kind of RANDOM_EVENT_TABLE_KINDS) {
    const defaults = DEFAULT_RANDOM_EVENT_TABLES[kind];
    const tableSource = isPlainObject(sourceTables[kind]) ? sourceTables[kind] : null;
    const sourceRows = Array.isArray(tableSource?.rows) ? tableSource.rows : null;
    const defaultVersion = Math.max(1, toNumber(defaults.version, 1));
    const sourceVersion = Math.max(0, toNumber(tableSource?.version, 0));
    const rowSource = sourceRows
      ? (sourceVersion < defaultVersion ? mergeDefaultEventRows(defaults.rows, sourceRows) : sourceRows)
      : defaults.rows;
    const rows = rowSource
      .map((row, index) => normalizeRandomEventRow(row, `${kind}-${index + 1}`))
      .filter(Boolean);

    result[kind] = {
      id: kind,
      version: defaultVersion,
      title: String(tableSource?.title ?? defaults.title),
      rollTitle: String(tableSource?.rollTitle ?? defaults.rollTitle),
      description: String(tableSource?.description ?? defaults.description),
      rows
    };
  }

  return result;
}

export function cloneDefaultRandomEventTables() {
  return clone(normalizeRandomEventTables(null));
}

export function normalizeEventTagThresholds(source = {}) {
  const result = {};
  for (const { key } of EVENT_THRESHOLD_KEYS) {
    const fallback = DEFAULT_EVENT_TAG_THRESHOLDS[key];
    const row = isPlainObject(source?.[key]) ? source[key] : {};
    let lowMax = toNumber(row.lowMax ?? row.low ?? row.maxLow, fallback.lowMax);
    let highMin = toNumber(row.highMin ?? row.high ?? row.minHigh, fallback.highMin);
    if (key === "morale" && lowMax === -1 && highMin === 16) {
      lowMax = fallback.lowMax;
      highMin = fallback.highMin;
    }
    result[key] = {
      lowMax,
      highMin: Math.max(highMin, lowMax + 1)
    };
  }
  return result;
}

export function eventTagThresholdRows(source = {}) {
  const thresholds = normalizeEventTagThresholds(source);
  return EVENT_THRESHOLD_KEYS.map((definition) => ({
    ...definition,
    lowMax: thresholds[definition.key].lowMax,
    highMin: thresholds[definition.key].highMin
  }));
}


function normalizeText(value = "") {
  return String(value ?? "").toLowerCase();
}

function collectHoldingText(holding = {}, people = [], allBuildings = []) {
  return [
    holding?.name,
    holding?.type,
    holding?.overview?.region,
    holding?.overview?.currentRegion,
    holding?.overview?.drift,
    holding?.overview?.altitude,
    holding?.overview?.status,
    holding?.overview?.description,
    holding?.overview?.publicNotes,
    holding?.people?.notes,
    holding?.buildings?.notes,
    holding?.storage?.notes,
    holding?.special?.notes,
    holding?.gm?.notes,
    ...people.map((person) => [person?.name, person?.culture, person?.belief, person?.background, person?.role, person?.notes, person?.traitsText].join(" ")),
    ...allBuildings.map((building) => [building?.id, building?.templateId, building?.name, building?.type, building?.effect, building?.notes, building?.location].join(" "))
  ].map((value) => normalizeText(value)).join(" ");
}

function detectOptions(text = "", options = []) {
  const result = new Set();
  for (const option of options) {
    if (option?.pattern?.test?.(text)) result.add(String(option.value));
  }
  return result;
}

function detectSelectedOption(text = "", options = []) {
  const value = String(text ?? "").trim();
  if (!value) return new Set();
  const lower = value.toLowerCase();
  const result = new Set();
  for (const option of options) {
    if (
      String(option.value).toLowerCase() === lower
      || String(option.label).toLowerCase() === lower
      || (option.aliases ?? []).some((alias) => String(alias).toLowerCase() === lower)
      || option?.pattern?.test?.(value)
    ) {
      result.add(String(option.value));
    }
  }
  return result;
}

function normalizeHoldingType(type = "") {
  const value = String(type ?? "settlement").trim().toLowerCase();
  if (value === "skyhold" || value === "sky island" || value === "sky-island") return "sky-island";
  if (HOLDING_TYPE_VALUES.has(value)) return value;
  return value || "settlement";
}

function eventCalendarFacts(holding = {}) {
  const dateTime = holding?.__eventCalendar?.dateTime ?? holding?.gm?.calendaria?.lastDateTime ?? null;
  const month = Math.floor(toNumber(dateTime?.month, 0));
  const day = Math.floor(toNumber(dateTime?.day, 0));
  const tags = new Set();
  if (month >= 1 && month <= 8) {
    tags.add(`month-${month}`);
    if ([2, 3, 4, 5].includes(month)) tags.add("season-zarost");
    if ([1, 6, 7, 8].includes(month)) tags.add("season-ukhudno");
  }
  return { dateTime, month, day, tags };
}

export function eventRequirementFacts(holding = {}, { regionOptions = null } = {}) {
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead);
  const allBuildings = holding?.buildings?.list ?? [];
  const buildings = allBuildings.filter((building) => buildingOperationalState(building).operational);
  const dev = holding?.overview?.development ?? {};
  const morale = Number(holding?.__eventMorale ?? holding?.overview?.morale ?? 0);
  const reputation = Number(holding?.__eventReputation ?? holding?.overview?.reputation ?? 0);
  const type = normalizeHoldingType(holding?.type ?? "settlement");
  const text = collectHoldingText(holding, people, allBuildings);
  const features = new Set([type]);
  const buildingTemplateIds = new Set();
  const buildingFunctions = new Set();
  const calendar = eventCalendarFacts(holding);
  const eventHistory = Array.isArray(holding?.gm?.eventHistory) ? holding.gm.eventHistory : [];
  const eventHistoryIds = eventHistory.map((entry) => String(entry?.id ?? entry?.eventId ?? "")).filter(Boolean);
  const thresholds = normalizeEventTagThresholds(holding?.gm?.eventTagThresholds);
  const applyThresholdFeature = (key, value) => {
    const threshold = thresholds[key];
    if (!threshold) return;
    if (value <= threshold.lowMax) features.add(`low-${key}`);
    if (value >= threshold.highMin) features.add(`high-${key}`);
  };

  if (type === "sky-island" || type === "skyhold") features.add("sky-island");
  if (type === "settlement" || type === "sky-island") features.add("settlement");
  applyThresholdFeature("population", people.length);
  applyThresholdFeature("morale", morale);
  applyThresholdFeature("reputation", reputation);
  if (reputation > 0) features.add("trade");
  if (reputation >= thresholds.reputation.highMin) features.add("law");
  if (allBuildings.some((building) => {
    const state = buildingOperationalState(building);
    return state.lifecycle === "planned" || state.lifecycle === "building" || state.repairActive;
  })) features.add("construction");

  const development = {};
  for (const key of ["food", "technology", "culture", "war"]) {
    const value = toNumber(dev?.[key], 0) + toNumber(holding?.gm?.modifiers?.[key], 0);
    development[key] = value;
    applyThresholdFeature(key, value);
  }

  for (const building of buildings) {
    const templateId = String(building?.templateId || building?.id || "").trim();
    if (templateId) buildingTemplateIds.add(templateId);
    const functions = building?.functions ?? {};
    for (const key of ["production", "income", "defense", "housing", "storage", "culture"]) {
      if (functions[key]) {
        buildingFunctions.add(key);
        if (FEATURE_VALUES.has(key)) features.add(key);
      }
    }
    if ((building?.productionLines ?? []).length) {
      features.add("production");
      buildingFunctions.add("production");
    }
    if (toNumber(building?.housing?.capacity, 0) > 0) {
      features.add("housing");
      buildingFunctions.add("housing");
    }
    if (toNumber(building?.storage?.capacity, 0) > 0) {
      features.add("storage");
      buildingFunctions.add("storage");
    }
    if (toNumber(building?.defense?.base, 0) > 0 || toNumber(building?.defense?.maxDice, 0) > 0) {
      features.add("defense");
      buildingFunctions.add("defense");
    }
  }
  if (holding?.gm?.defense?.squads?.length) features.add("defense");
  if ((holding?.storage?.resources ?? []).length || (holding?.storage?.items ?? []).length) features.add("storage");
  if ((holding?.special?.fleet?.vessels ?? []).length) features.add("ship");
  if (/school|школ|учен|библиот|archive|архив/i.test(text)) features.add("school");
  if (/market|trade|merchant|inn|tavern|рынок|торг|купец|трактир|таверн|постоял/i.test(text)) features.add("trade");
  if (/ship|sky|island|летяг|кораб|остров|небес/i.test(text)) features.add("ship");
  if (/порт|гаван|причал|port|harbor|harbour/i.test(text)) {
    features.add("port");
    features.add("ship");
    features.add("trade");
  }
  if (/храм|святил|часов|церк|вера|культ|temple|shrine|chapel|church|faith|cult/i.test(text)) features.add("faith");
  if (/чудовищ|монстр|твар|monster|beast/i.test(text)) features.add("monster");
  if (/закон|чинов|жандар|провер|документ|law|audit|official/i.test(text)) features.add("law");

  const explicitRegion = holding?.overview?.region ?? "";
  const regions = detectSelectedOption(explicitRegion, normalizeEventRegionOptions(regionOptions ?? holding?.__eventRegionOptions ?? null));
  const faiths = detectOptions(text, EVENT_FAITH_OPTIONS);
  const factions = detectOptions(text, EVENT_FACTION_OPTIONS);
  if (faiths.size) features.add("faith");
  if (factions.has("stl")) features.add("trade");
  if (factions.has("potroshiteli")) features.add("monster");

  return {
    type,
    population: people.length,
    morale,
    reputation,
    development,
    buildings: buildings.length,
    buildingTemplateIds,
    buildingFunctions,
    calendar,
    eventHistory,
    eventHistoryIds,
    features,
    regions,
    faiths,
    factions,
    text
  };
}

export function holdingRandomEventTags(holding = {}, options = {}) {
  const facts = eventRequirementFacts(holding, options);
  return new Set([...facts.features, ...facts.regions, ...facts.faiths, ...facts.factions, ...facts.calendar.tags]);
}

function compareNumber(actual = 0, operator = "gte", expected = 0) {
  const left = Number(actual) || 0;
  const right = Number(expected) || 0;
  if (operator === "lte") return left <= right;
  if (operator === "gt") return left > right;
  if (operator === "lt") return left < right;
  if (operator === "eq") return left === right;
  if (operator === "neq") return left !== right;
  return left >= right;
}

function compareSet(set = new Set(), operator = "present", value = "") {
  const key = String(value ?? "").trim();
  const present = key === "any" ? set.size > 0 : set.has(key);
  return operator === "absent" || operator === "is-not" ? !present : present;
}

function compareText(text = "", operator = "contains", value = "") {
  const needle = normalizeText(value).trim();
  if (!needle) return operator === "not-contains";
  const present = normalizeText(text).includes(needle);
  return operator === "not-contains" ? !present : present;
}

export function evaluateEventRequirement(rule = {}, holdingOrFacts = {}) {
  const facts = holdingOrFacts?.features instanceof Set ? holdingOrFacts : eventRequirementFacts(holdingOrFacts);
  const normalized = normalizeEventRequirement(rule);
  if (!normalized) return { ok: true, rule: null };
  const { type, operator, key, value, number } = normalized;
  let ok = true;
  if (type === "feature") ok = compareSet(facts.features, operator, value);
  else if (type === "region") ok = compareSet(facts.regions, operator, value);
  else if (type === "faith") ok = compareSet(facts.faiths, operator, value);
  else if (type === "faction") ok = compareSet(facts.factions, operator, value);
  else if (type === "calendar") ok = compareSet(facts.calendar?.tags ?? new Set(), operator, value);
  else if (type === "building-template") ok = compareSet(facts.buildingTemplateIds, operator, value);
  else if (type === "building-function") ok = compareSet(facts.buildingFunctions, operator, value);
  else if (type === "construction") ok = compareSet(facts.features, operator, "construction");
  else if (type === "storage") ok = compareSet(facts.features, operator, "storage");
  else if (type === "defense") ok = compareSet(facts.features, operator, "defense");
  else if (type === "development") ok = compareNumber(facts.development?.[DEVELOPMENT_VALUES.has(key) ? key : "food"] ?? 0, operator, number);
  else if (type === "population") ok = compareNumber(facts.population, operator, number);
  else if (type === "morale") ok = compareNumber(facts.morale, operator, number);
  else if (type === "reputation") ok = compareNumber(facts.reputation, operator, number);
  else if (type === "holding-type") {
    const expected = normalizeHoldingType(value);
    ok = operator === "is-not" ? facts.type !== expected : facts.type === expected;
  } else if (type === "text") ok = compareText(facts.text, operator, value);
  return { ok, rule: normalized };
}

export function randomEventContext(row = {}, holding = {}, options = {}) {
  const normalizedRow = normalizeRandomEventRow(row, row?.id ?? "");
  const regionOptions = normalizeEventRegionOptions(options.regionOptions ?? holding?.__eventRegionOptions ?? null);
  const facts = options.facts ?? eventRequirementFacts(holding, { regionOptions });
  const requirements = normalizeRandomEventRequirements(normalizedRow.requirements ?? null, row.tags ?? "");
  const boosts = normalizeRandomEventBoosts(normalizedRow.boosts ?? null, row.tags ?? "");
  const checks = requirements.rules.map((rule) => evaluateEventRequirement(rule, facts));
  const boostChecks = boosts.rules.map((rule) => evaluateEventRequirement(rule, facts));
  const passed = checks.filter((check) => check.ok);
  const boostPassed = boostChecks.filter((check) => check.ok);
  const blocked = [];
  let eligible = true;
  if (checks.length) {
    if (requirements.logic === "any") eligible = passed.length > 0;
    else if (requirements.logic === "none") eligible = passed.length === 0;
    else eligible = passed.length === checks.length;
  }
  const cooldown = Math.max(0, Math.floor(toNumber(normalizedRow.cooldown, 0)));
  if (cooldown > 0) {
    const recent = facts.eventHistoryIds.slice(-cooldown);
    if (recent.includes(String(normalizedRow.id))) {
      eligible = false;
      blocked.push(`Кулдаун: выпадало в последних ${cooldown}`);
    }
  }
  return {
    eligible,
    matches: boostPassed.length,
    weight: eligible ? contextualRandomEventWeight(normalizedRow, holding, { context: { matches: boostPassed.length, eligible } }) : 0,
    facts,
    holdingTags: holdingRandomEventTags(holding, { regionOptions }),
    rowTags: requirements.rules.map((rule) => describeEventRequirement(rule, { regionOptions })),
    required: checks.filter((check) => !check.ok).map((check) => describeEventRequirement(check.rule, { regionOptions })),
    blocked: [
      ...blocked,
      ...(requirements.logic === "none" ? passed.map((check) => describeEventRequirement(check.rule, { regionOptions })) : [])
    ],
    requirements,
    boosts,
    checks,
    boostChecks,
    boostMatches: boostPassed.map((check) => describeEventRequirement(check.rule, { regionOptions })),
    boostMisses: boostChecks.filter((check) => !check.ok).map((check) => describeEventRequirement(check.rule, { regionOptions }))
  };
}

function valueLabelForRequirement(rule = {}, buildingTemplateLabels = new Map(), regionOptions = EVENT_REGION_OPTIONS) {
  if (rule.type === "development") return optionLabel(EVENT_DEVELOPMENT_OPTIONS, rule.key || "food");
  if (rule.type === "feature") return optionLabel(EVENT_FEATURE_OPTIONS, rule.value);
  if (rule.type === "region") return optionLabel(normalizeEventRegionOptions(regionOptions), rule.value);
  if (rule.type === "faith") return optionLabel(EVENT_FAITH_OPTIONS, rule.value);
  if (rule.type === "faction") return optionLabel(EVENT_FACTION_OPTIONS, rule.value);
  if (rule.type === "calendar") return optionLabel(EVENT_CALENDAR_OPTIONS, rule.value);
  if (rule.type === "building-function") return optionLabel(EVENT_BUILDING_FUNCTION_OPTIONS, rule.value);
  if (rule.type === "building-template") return buildingTemplateLabels.get(String(rule.value)) ?? String(rule.value || "шаблон");
  if (rule.type === "holding-type") return optionLabel(EVENT_HOLDING_TYPE_OPTIONS, rule.value);
  if (["population", "morale", "reputation"].includes(rule.type)) return String(rule.number ?? 0);
  if (rule.type === "text") return String(rule.value ?? "");
  return "";
}

export function describeEventRequirement(rule = {}, { buildingTemplates = [], regionOptions = EVENT_REGION_OPTIONS } = {}) {
  const normalized = normalizeEventRequirement(rule);
  if (!normalized) return "Условие";
  const buildingTemplateLabels = new Map((Array.isArray(buildingTemplates) ? buildingTemplates : []).map((template) => [String(template.id), String(template.name ?? template.id)]));
  const typeLabel = optionLabel(EVENT_REQUIREMENT_TYPE_OPTIONS, normalized.type);
  const operatorLabel = optionLabel(EVENT_REQUIREMENT_OPERATOR_OPTIONS, normalized.operator);
  const valueLabel = valueLabelForRequirement(normalized, buildingTemplateLabels, regionOptions);
  if (["construction", "storage", "defense"].includes(normalized.type)) return `${typeLabel}: ${operatorLabel}`;
  if (normalized.type === "development") return `${typeLabel}: ${valueLabel} ${operatorLabel} ${normalized.number}`;
  if (["population", "morale", "reputation"].includes(normalized.type)) return `${typeLabel} ${operatorLabel} ${normalized.number}`;
  if (normalized.type === "text") return `${typeLabel} ${operatorLabel} «${valueLabel}»`;
  return `${typeLabel}: ${operatorLabel} ${valueLabel}`;
}

export function contextualRandomEventWeight(row = {}, holding = {}, options = {}) {
  const base = Math.max(0, toNumber(row.weight, 0));
  if (!base) return 0;

  const context = options.context ?? randomEventContext(row, holding, options);
  if (!context.eligible) return 0;
  const matches = context.matches;

  const multiplier = 1 + Math.min(1.4, matches * 0.18);
  return Math.max(1, Math.round(base * multiplier));
}

export function rollRandomEventTable(table = {}, holding = {}, { random = Math.random, regionOptions = null } = {}) {
  const effectiveRegionOptions = regionOptions ?? holding?.__eventRegionOptions ?? null;
  const rows = (Array.isArray(table?.rows) ? table.rows : [])
    .map((row, index) => {
      const normalizedRow = normalizeRandomEventRow(row, `${table?.id ?? "event"}-${index + 1}`);
      return { row: normalizedRow, weight: contextualRandomEventWeight(normalizedRow, holding, { regionOptions: effectiveRegionOptions }) };
    })
    .filter((item) => item.weight > 0);
  if (!rows.length) return null;

  const totalWeight = rows.reduce((sum, item) => sum + item.weight, 0);
  const roll = Math.floor((typeof random === "function" ? random() : Math.random()) * totalWeight) + 1;
  let cursor = 0;
  for (const item of rows) {
    cursor += item.weight;
    if (roll <= cursor) {
      return {
        tableId: table.id ?? "",
        tableTitle: table.rollTitle ?? table.title ?? "Событие",
        roll,
        totalWeight,
        weight: item.weight,
        row: item.row
      };
    }
  }
  const last = rows[rows.length - 1];
  return {
    tableId: table.id ?? "",
    tableTitle: table.rollTitle ?? table.title ?? "Событие",
    roll: totalWeight,
    totalWeight,
    weight: last.weight,
    row: last.row
  };
}
