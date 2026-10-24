import { clone, isPlainObject } from "./utils.js";

export const POLITICS_BALANCE_VERSION = 1;

export const POLITICS_EFFECT_FIELDS = Object.freeze([
  { id: "reputation", label: "Репутация", min: -20, max: 20, step: 1 },
  { id: "control", label: "Общий Контроль", min: -20, max: 20, step: 1 },
  { id: "unrestControl", label: "Контроль против беспорядков", min: -20, max: 20, step: 1 },
  { id: "defense", label: "Оборона", min: -30, max: 30, step: 1 },
  { id: "morale", label: "Довольство", min: -20, max: 20, step: 1 },
  { id: "moraleIfFullyFed", label: "Довольство при полном питании", min: -20, max: 20, step: 1 },
  { id: "marketAccess", label: "УРС", min: -10, max: 10, step: 1 },
  { id: "externalFlowPercent", label: "Внешний поток, %", min: -100, max: 200, step: 1 },
  { id: "productionPercent", label: "Производство, %", min: -100, max: 200, step: 1 },
  { id: "constructionPercent", label: "Строительство, %", min: -100, max: 200, step: 1 },
  { id: "foodMultiplierPercent", label: "Потребность пищи, %", min: 50, max: 200, step: 1, base: 100 },
  { id: "influenceCap", label: "Предел Влияния", min: -10, max: 20, step: 1 }
]);

export const POLITICS_PARAMETER_FIELDS = Object.freeze([
  { id: "copper", label: "Цена, ММ", min: 0, max: 1000000, step: 1 },
  { id: "influence", label: "Цена, Влияние", min: 0, max: 100, step: 1 },
  { id: "duration", label: "Срок, десятников", min: 0, max: 100, step: 1 },
  { id: "foodPerResident", label: "Готовой пищи на жителя", min: 0, max: 100, step: 1 },
  { id: "upkeepCopper", label: "Содержание, ММ/десятник", min: 0, max: 100000, step: 1 },
  { id: "cultureMin", label: "Культура для доступа", min: 0, max: 1000, step: 1 },
  { id: "reputationMin", label: "Репутация для доступа", min: 0, max: 100, step: 1 },
  { id: "technologyMin", label: "Технология для доступа", min: 0, max: 1000, step: 1 }
]);

export const POLITICS_CORE_FIELDS = Object.freeze([
  { id: "influenceBaseGain", label: "Базовое Влияние за десятник", base: 1, min: 0, max: 20 },
  { id: "influenceBonusGain", label: "Дополнительное Влияние от источника", base: 1, min: 0, max: 20 },
  { id: "influenceBaseCap", label: "Базовый предел Влияния", base: 6, min: 0, max: 100 },
  { id: "townHallCapBonus", label: "Предел от Ратуши", base: 2, min: 0, max: 100 },
  { id: "highCultureThreshold", label: "Культура для бонуса предела", base: 30, min: 0, max: 1000 },
  { id: "highCultureCapBonus", label: "Предел от высокой Культуры", base: 2, min: 0, max: 100 },
  { id: "systemChangeInfluence", label: "Цена смены системы", base: 2, min: 0, max: 100 },
  { id: "systemChangeCooldown", label: "Пауза между сменами системы", base: 3, min: 0, max: 100 },
  { id: "economySkillPercent", label: "Производство и стройка за Экономику, %", base: 2, min: -20, max: 20 },
  { id: "warSkillDefense", label: "Оборона за Войну", base: 2, min: -20, max: 20 },
  { id: "cultureSkillMorale", label: "Довольство за Культуру", base: 1, min: -20, max: 20 },
  { id: "diplomacySkillDivisor", label: "Пунктов Дипломатии за 1 УРС", base: 2, min: 1, max: 10 },
  { id: "representativeInfluenceCultureMin", label: "Культура представителя для Влияния", base: 2, min: 0, max: 3 }
]);

export const POLITICS_REQUIREMENTS = Object.freeze([
  { id: "market", label: "Работающий Рынок" },
  { id: "route", label: "Доступный маршрут" },
  { id: "guard", label: "Действующая охрана" },
  { id: "project", label: "Проект с бригадой" },
  { id: "production", label: "Действующее производство" },
  { id: "institution", label: "Дом собраний или Ратуша" },
  { id: "trialInstitution", label: "Дом собраний или Суд" },
  { id: "network", label: "Оплаченная Информсеть" },
  { id: "patron", label: "Соглашение патрона" },
  { id: "food-full", label: "Рацион полностью обеспечен" }
]);
const REQUIREMENT_IDS = new Set(POLITICS_REQUIREMENTS.map((row) => row.id));

const ARCHETYPES = [
  { id: "laborer", label: "Разнорабочий", perk: { morale: 1 }, perkRequires: ["food-full"], directive: { productionPercent: 5, constructionPercent: 5, morale: -1 }, decree: { constructionPercent: 10, morale: 2 }, copper: 250, influence: 1, requires: ["project"] },
  { id: "strong", label: "Силач", perk: { defense: 1 }, perkRequires: ["guard"], directive: { constructionPercent: 15, productionPercent: -5, morale: -2 }, decree: { defense: 3, control: 1 }, copper: 350, influence: 1, duration: 2, requires: ["guard"] },
  { id: "nimble", label: "Ловкач", perk: { marketAccess: 1 }, perkRequires: ["route"], directive: { marketAccess: 2, control: -1, reputation: -1 }, decree: { externalFlowPercent: 15, marketAccess: 2 }, copper: 250, requires: ["market", "route"] },
  { id: "clever", label: "Умелец", perk: { productionPercent: 5 }, perkRequires: ["production"], directive: { productionPercent: 10, constructionPercent: -5 }, decree: { productionPercent: 15, reputation: 1 }, copper: 300, influence: 1, requires: ["production"] },
  { id: "negotiator", label: "Переговорщик", perk: { reputation: 1 }, perkRequires: ["institution"], directive: { reputation: 1, morale: 1, control: -1 }, decree: { reputation: 2, morale: 1 }, copper: 300, influence: 1, requires: ["institution"] },
  { id: "builder", label: "Строитель", perk: { constructionPercent: 5 }, perkRequires: ["project"], directive: { constructionPercent: 12, productionPercent: -8 }, decree: { constructionPercent: 20 }, copper: 400, influence: 1, duration: 2, requires: ["project"] },
  { id: "mechanic", label: "Механик", perk: { productionPercent: 2, constructionPercent: 2 }, directive: { productionPercent: 7, constructionPercent: 5, morale: -1 }, decree: { productionPercent: 10, constructionPercent: 10 }, copper: 350, influence: 1, requires: ["production", "project"] },
  { id: "foreman", label: "Бригадир", perk: { morale: 1 }, perkRequires: ["project"], directive: { control: 1, productionPercent: 5, morale: -1 }, decree: { constructionPercent: 10, control: 1, morale: 1 }, copper: 300, influence: 1, requires: ["project"] },
  { id: "artisan", label: "Ремесленник", perk: { productionPercent: 3, externalFlowPercent: 3 }, directive: { productionPercent: 5, externalFlowPercent: 10, morale: -1 }, decree: { externalFlowPercent: 10, productionPercent: 10, reputation: 1 }, copper: 350, influence: 1, duration: 2, requires: ["market", "production"] },
  { id: "courier", label: "Посыльный", perk: { externalFlowPercent: 5 }, perkRequires: ["market", "route"], directive: { marketAccess: 1, reputation: 1, morale: -1 }, decree: { marketAccess: 2, externalFlowPercent: 5 }, copper: 200, influence: 1, duration: 2, requires: ["route"] },
  { id: "administrator", label: "Управленец", perk: { influenceCap: 1 }, directive: { control: 1, constructionPercent: 5, morale: -1 }, decree: { control: 1, morale: 1 }, copper: 250, influence: 1, duration: 2, requires: ["institution"] },
  { id: "master", label: "Мастеровой", perk: { productionPercent: 4, constructionPercent: 4 }, directive: { productionPercent: 10, constructionPercent: 10, morale: -2 }, decree: { productionPercent: 15, constructionPercent: 15 }, copper: 450, influence: 2, requires: ["production", "project"] },
  { id: "agent", label: "Агент", perk: { unrestControl: 1 }, directive: { marketAccess: 1, control: 1, reputation: -1 }, decree: { defense: 2, control: 1 }, copper: 300, influence: 1, duration: 2, requires: ["network"] },
  { id: "sergeant", label: "Старшина", perk: { defense: 1, control: 1 }, perkRequires: ["guard"], directive: { defense: 2, control: 1, productionPercent: -5 }, decree: { defense: 4, control: 1 }, copper: 400, influence: 1, requires: ["guard"] },
  { id: "field_leader", label: "Полевой вожак", perk: { defense: 2 }, perkRequires: ["guard"], directive: { defense: 2, marketAccess: 1, control: -1 }, decree: { defense: 3, marketAccess: 1 }, copper: 350, influence: 1, duration: 2, requires: ["guard", "route"] },
  { id: "all_rounder", label: "Мастер на все руки", perk: { productionPercent: 3, constructionPercent: 3, reputation: 1 }, directive: { productionPercent: 5, constructionPercent: 5, reputation: 1, morale: -1 }, decree: { productionPercent: 10, constructionPercent: 10, morale: 1 }, copper: 500, influence: 2, requires: ["production", "project"] }
];

export const POLITICS_ARCHETYPES = Object.freeze(ARCHETYPES.map(({ id, label }) => ({ id, label })));

const PERSONAL_NAMES = {
  laborer: ["Общее дело", "Всем миром"], strong: ["Тяжёлая повинность", "Поднять вал"],
  nimble: ["Обходные тропы", "Быстрый караван"], clever: ["Точная работа", "Образцовая партия"],
  negotiator: ["Открытый совет", "Посольский приём"], builder: ["Строительный график", "Ударная стройка"],
  mechanic: ["Наладка линий", "Ремонтная кампания"], foreman: ["Посменное управление", "Общий наряд"],
  artisan: ["Заказные изделия", "Выставка изделий"], courier: ["Срочные вести", "Срочная доставка"],
  administrator: ["Распределение обязанностей", "Перепись дворов"], master: ["Сложный заказ", "Большой заказ"],
  agent: ["Тихие связи", "Секретный доклад"], sergeant: ["Учения гарнизона", "Сбор дружины"],
  field_leader: ["Передовые дозоры", "Выход навстречу"], all_rounder: ["Согласованный курс", "Всенародный план"]
};

function row(id, kind, label, effects = {}, details = {}) {
  return { id, kind, label, effects, copper: 0, influence: 0, duration: 0, foodPerResident: 0, upkeepCopper: 0,
    cultureMin: 0, reputationMin: 0, technologyMin: 0, requires: [], archetypeId: "", slot: "", ...details };
}

const BUILTIN_ROWS = [
  row("system:governor", "system", "Наместник", { reputation: 1 }, { slots: ["supply", "order", "external"] }),
  row("system:elder-council", "system", "Совет общины", { morale: 1, control: 1 }, { cultureMin: 18, duration: 24, slots: ["supply", "order", "external"] }),
  row("system:elected-head", "system", "Избранный глава", { morale: 2 }, { cultureMin: 20, reputationMin: 3, duration: 12, slots: ["supply", "order", "labor", "external"] }),
  row("system:guild-council", "system", "Гильдейский совет", { marketAccess: 1, productionPercent: 5, morale: -1 }, { technologyMin: 22, requires: ["market"], duration: 12, slots: ["supply", "order", "labor", "external"] }),
  row("directive:ration-lean", "directive", "Бережливое снабжение", { foodMultiplierPercent: 90, morale: -1 }, { slot: "supply" }),
  row("directive:ration-generous", "directive", "Щедрый стол", { foodMultiplierPercent: 115, moraleIfFullyFed: 2 }, { slot: "supply" }),
  row("directive:gates-open", "directive", "Открытые ворота", { reputation: 1, marketAccess: 1, control: -1 }, { slot: "order" }),
  row("directive:gates-permits", "directive", "Досмотр", { control: 1, marketAccess: -1 }, { slot: "order" }),
  row("directive:gates-closed", "directive", "Закрытый режим", { control: 2, morale: -1, marketAccess: -2 }, { slot: "order" }),
  row("directive:labor-mobilization", "directive", "Строительный приоритет", { constructionPercent: 10, morale: -1 }, { slot: "labor" }),
  row("directive:labor-festivals", "directive", "Дни отдыха", { morale: 2, productionPercent: -5 }, { slot: "labor" }),
  row("directive:external-patron", "directive", "Покровительство", { defense: 2 }, { slot: "external", requires: ["patron"] }),
  row("directive:external-trade", "directive", "Торговые связи", { marketAccess: 1, externalFlowPercent: 5 }, { slot: "external" }),
  row("directive:external-network", "directive", "Информсеть", {}, { slot: "external", upkeepCopper: 60 }),
  row("decree:fair", "decree", "Ярмарка", { externalFlowPercent: 20, reputation: 1 }, { copper: 300, influence: 1, duration: 2, requires: ["market"] }),
  row("decree:festival", "decree", "Общинный праздник", { morale: 3 }, { copper: 200, duration: 1, foodPerResident: 2 }),
  row("decree:patrol-surge", "decree", "Усиленные патрули", { control: 2 }, { copper: 400, duration: 3, requires: ["guard"] }),
  row("decree:construction-drive", "decree", "Строительный аврал", { constructionPercent: 10 }, { copper: 300, influence: 1, duration: 2, requires: ["project"] }),
  row("decree:public-trial", "decree", "Публичное разбирательство", { reputation: 1, control: 1 }, { copper: 200, influence: 1, duration: 1, requires: ["trialInstitution"] }),
  row("decree:intel-support", "decree", "Сведения", {}, { copper: 300, influence: 1, duration: 3, requires: ["network"] }),
  ...ARCHETYPES.flatMap((type) => [
    row(`perk:${type.id}`, "perk", `${type.label}: перк`, type.perk, { archetypeId: type.id, requires: type.perkRequires ?? [] }),
    row(`directive:${type.id}`, "directive", PERSONAL_NAMES[type.id][0], type.directive, { archetypeId: type.id }),
    row(`decree:${type.id}`, "decree", PERSONAL_NAMES[type.id][1], type.decree, { archetypeId: type.id, copper: type.copper, influence: type.influence ?? 0, duration: type.duration ?? 1, requires: type.requires ?? [] })
  ])
];

export const POLITICS_BUILTIN_ROWS = Object.freeze(BUILTIN_ROWS);

/** Loading is non-destructive: unknown future keys and rows survive normal commits. */
export function normalizePoliticsBalance(value) {
  const source = isPlainObject(value) ? clone(value) : {};
  return {
    ...source,
    version: Math.max(POLITICS_BALANCE_VERSION, Number.isSafeInteger(Number(source.version)) ? Number(source.version) : 1),
    core: isPlainObject(source.core) ? source.core : {},
    rows: isPlainObject(source.rows) ? source.rows : {},
    custom: Array.isArray(source.custom) ? source.custom.filter(isPlainObject) : []
  };
}

export function politicsBalanceNumber(value, field) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < field.min || number > field.max) return null;
  return number;
}

function effectiveNumber(value, field, fallback) {
  return politicsBalanceNumber(value, field) ?? fallback;
}

export function resolvedPoliticsCore(balance = {}) {
  const stored = normalizePoliticsBalance(balance).core;
  return Object.fromEntries(POLITICS_CORE_FIELDS.map((field) => [field.id, effectiveNumber(stored[field.id], field, field.base)]));
}

export function resolvedPoliticsRow(source, override = {}) {
  const effects = Object.fromEntries(POLITICS_EFFECT_FIELDS.map((field) => {
    const fallback = effectiveNumber(source.effects?.[field.id], field, field.base ?? 0);
    return [field.id, effectiveNumber(override?.effects?.[field.id], field, fallback)];
  }));
  const parameters = Object.fromEntries(POLITICS_PARAMETER_FIELDS.map((field) => {
    const fallback = effectiveNumber(source[field.id], field, 0);
    return [field.id, effectiveNumber(override?.[field.id], field, fallback)];
  }));
  const requires = Array.isArray(override?.requires) ? override.requires.filter((id) => REQUIREMENT_IDS.has(id)) : source.requires;
  return { ...source, ...parameters, effects, requires,
    ...(source.kind === "system" ? { slots: [...new Set((Array.isArray(override?.slots) ? override.slots : source.slots ?? [])
      .filter((slot) => ["supply", "order", "labor", "external"].includes(slot)))] } : {}),
    enabled: typeof override?.enabled === "boolean" ? override.enabled : source.enabled !== false };
}

export function resolvedPoliticsCatalog(balance = {}) {
  const state = normalizePoliticsBalance(balance);
  const builtins = POLITICS_BUILTIN_ROWS.map((source) => resolvedPoliticsRow(source, state.rows[source.id]));
  const custom = state.custom.filter((source) => (
    typeof source.id === "string" && /^custom-(directive|decree|perk)-[a-z0-9-]{6,60}$/.test(source.id)
    && ["directive", "decree", "perk"].includes(source.kind)
    && typeof source.label === "string" && source.label.trim().length > 0
  )).map((source) => resolvedPoliticsRow({ ...source, label: source.label.slice(0, 100),
    requires: Array.isArray(source.requires) ? source.requires.filter((id) => REQUIREMENT_IDS.has(id)) : [],
    archetypeId: POLITICS_ARCHETYPES.some((type) => type.id === source.archetypeId) ? source.archetypeId : "",
    slot: ["supply", "order", "labor", "external"].includes(source.slot) ? source.slot : ""
  }, source));
  return [...builtins, ...custom];
}

export function politicsCatalogRow(balance, id) {
  return resolvedPoliticsCatalog(balance).find((row) => row.id === String(id ?? "")) ?? null;
}
