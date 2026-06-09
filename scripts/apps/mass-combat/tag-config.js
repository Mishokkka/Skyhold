import { MODULE_ID, SETTING_MASS_COMBAT_TAGS, notifySkyholdChanged } from "../../data/store.js";

export const DEFAULT_MASS_COMBAT_TAGS = {
  infantry: { label: "Пехота", short: "Пех.", icon: "fa-solid fa-person-rifle", hint: "Базовая линейная сила. Сама ничего не контрит, но многие планы и враги работают против нее." },
  shooters: { label: "Огневые", short: "Огонь", icon: "fa-solid fa-bullseye", hint: "Линейные стрелки, мушкетеры, арбалетчики, огневые позиции и стрелковые башни." },
  mobile: { label: "Мобильные", short: "Моб.", icon: "fa-solid fa-horse", hint: "Конница, налетчики, летающие бойцы, быстрые звери, абордажные группы." },
  heavy: { label: "Тяжелые", short: "Тяж.", icon: "fa-solid fa-shield-halved", hint: "Гренадеры, тяжелая пехота, ударные группы, хорошо держащие строй." },
  sappers: { label: "Саперы", short: "Сап.", icon: "fa-solid fa-hammer", hint: "Инженеры, подкопщики, минеры, разрушители ворот и механизмов." },
  siege: { label: "Осадные", short: "Осада", icon: "fa-solid fa-tower-observation", hint: "Пушки, тараны, огневые смеси, осадные машины и крупное разрушительное оружие." },
  skirmishers: { label: "Егеря", short: "Егеря", icon: "fa-solid fa-eye", hint: "Легкая пехота, разведчики, охотники, лазутчики и стрелки малых групп." },
  monsters: { label: "Монстры", short: "Монст.", icon: "fa-solid fa-paw", hint: "Тролли, великаны, демоны, крупные твари и прочие проблемы с зубами." },
  sacred: { label: "Сакральное", short: "Сакр.", icon: "fa-solid fa-sun", hint: "Жрецы, колдуны, ритуальные силы, чудеса, страх и моральное давление." }
};

export const MASS_COMBAT_SYSTEM_TAGS = {
  garrison: { label: "Гарнизон", short: "Гарн.", icon: "fa-solid fa-chess-rook", hint: "Укрепленные позиции, башни, стены и стационарная охрана.", system: true },
  militia: { label: "Ополчение", short: "Ополч.", icon: "fa-solid fa-people-group", hint: "Наспех собранные жители без полноценной строевой подготовки.", system: true }
};

export const COUNTER_STRENGTH = {
  base: 0.25,
  strong: 0.50,
  full: 0.75
};

export const DEFAULT_MASS_COMBAT_TAG_COUNTERS = {
  shooters: { infantry: COUNTER_STRENGTH.strong, skirmishers: COUNTER_STRENGTH.base, sacred: COUNTER_STRENGTH.strong },
  mobile: { shooters: COUNTER_STRENGTH.strong, skirmishers: COUNTER_STRENGTH.strong, siege: COUNTER_STRENGTH.strong },
  heavy: { infantry: COUNTER_STRENGTH.strong, shooters: COUNTER_STRENGTH.base, mobile: COUNTER_STRENGTH.base },
  sappers: { garrison: COUNTER_STRENGTH.strong, siege: COUNTER_STRENGTH.base, heavy: COUNTER_STRENGTH.base },
  siege: { garrison: COUNTER_STRENGTH.full, heavy: COUNTER_STRENGTH.base, shooters: COUNTER_STRENGTH.base },
  skirmishers: { shooters: COUNTER_STRENGTH.base, sappers: COUNTER_STRENGTH.strong, siege: COUNTER_STRENGTH.base },
  monsters: { infantry: COUNTER_STRENGTH.strong, militia: COUNTER_STRENGTH.strong, mobile: COUNTER_STRENGTH.base },
  sacred: { monsters: COUNTER_STRENGTH.strong, heavy: COUNTER_STRENGTH.base, sacred: COUNTER_STRENGTH.base }
};

const DEFAULT_TAG_ORDER = Object.keys(DEFAULT_MASS_COMBAT_TAGS);
const SYSTEM_TAG_ORDER = Object.keys(MASS_COMBAT_SYSTEM_TAGS);
let cachedConfigKey = "";
let cachedConfig = null;

function clone(value) {
  if (globalThis.foundry?.utils?.deepClone) return globalThis.foundry.utils.deepClone(value);
  return JSON.parse(JSON.stringify(value ?? null));
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function safeMassCombatTagKey(value = "") {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cleanTagRow(key, raw = {}, fallback = {}, { system = false } = {}) {
  const id = safeMassCombatTagKey(key);
  if (!id) return null;
  return {
    label: String(raw.label ?? fallback.label ?? id).trim() || id,
    short: String(raw.short ?? fallback.short ?? raw.label ?? fallback.short ?? id).trim() || id,
    icon: String(raw.icon ?? fallback.icon ?? "fa-solid fa-circle").trim() || "fa-solid fa-circle",
    hint: String(raw.hint ?? fallback.hint ?? "").trim(),
    enabled: system ? true : raw.enabled !== false,
    system
  };
}

function tagOrder(raw = {}) {
  const rawTags = isPlainObject(raw.tags) ? raw.tags : {};
  const custom = Object.keys(rawTags).map(safeMassCombatTagKey).filter((key) => key && !DEFAULT_TAG_ORDER.includes(key) && !SYSTEM_TAG_ORDER.includes(key));
  const savedOrder = Array.isArray(raw.tagOrder) ? raw.tagOrder.map(safeMassCombatTagKey).filter(Boolean) : [];
  return [...new Set([...savedOrder, ...DEFAULT_TAG_ORDER, ...custom])];
}

function cacheKey(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch (_error) {
    return `${Date.now()}:${Math.random()}`;
  }
}

export function clearMassCombatTagConfigCache() {
  cachedConfigKey = "";
  cachedConfig = null;
}

export function massCombatTagField(side = "attacker", key = "") {
  const tagKey = safeMassCombatTagKey(key);
  if (!tagKey) return "";
  const prefix = side === "defender" ? "defender" : "attacker";
  return `${prefix}${tagKey[0].toUpperCase()}${tagKey.slice(1)}`;
}

export function parseMassCombatTagField(field = "") {
  const match = String(field ?? "").match(/^(defender|attacker)(.+)$/);
  if (!match) return null;
  const key = safeMassCombatTagKey(`${match[2][0]?.toLowerCase() ?? ""}${match[2].slice(1)}`);
  return key ? { side: match[1], key } : null;
}

export function isMassCombatUnitTagField(field = "", { side = "" } = {}) {
  const parsed = parseMassCombatTagField(field);
  if (!parsed) return false;
  if (side && parsed.side !== side) return false;
  return Boolean(getMassCombatTags()[parsed.key]);
}

export function normalizeMassCombatTagConfig(raw = {}) {
  const source = isPlainObject(raw) ? raw : {};
  const rawTags = isPlainObject(source.tags) ? source.tags : {};
  const tags = {};
  const order = tagOrder(source);

  for (const key of order) {
    const row = cleanTagRow(key, rawTags[key] ?? {}, DEFAULT_MASS_COMBAT_TAGS[key] ?? {});
    if (row) tags[key] = row;
  }

  for (const key of SYSTEM_TAG_ORDER) {
    const row = cleanTagRow(key, rawTags[key] ?? {}, MASS_COMBAT_SYSTEM_TAGS[key] ?? {}, { system: true });
    if (row) tags[key] = row;
  }

  const allKeys = Object.keys(tags);
  const enabledKeys = allKeys.filter((key) => tags[key]?.enabled !== false);
  const sourceCounters = isPlainObject(source.counters) ? source.counters : DEFAULT_MASS_COMBAT_TAG_COUNTERS;
  const counters = {};
  for (const sourceKey of enabledKeys) {
    const rawRow = isPlainObject(sourceCounters[sourceKey]) ? sourceCounters[sourceKey] : {};
    const row = {};
    for (const targetKey of enabledKeys) {
      const value = asNumber(rawRow[targetKey], 0);
      if (value > 0) row[targetKey] = Math.max(0, Math.min(1, value));
    }
    if (Object.keys(row).length) counters[sourceKey] = row;
  }

  return {
    version: 1,
    tagOrder: order.filter((key) => tags[key] && tags[key].system !== true),
    tags,
    counters
  };
}

export function defaultMassCombatTagConfig() {
  return normalizeMassCombatTagConfig({
    tags: { ...clone(DEFAULT_MASS_COMBAT_TAGS), ...clone(MASS_COMBAT_SYSTEM_TAGS) },
    counters: clone(DEFAULT_MASS_COMBAT_TAG_COUNTERS),
    tagOrder: DEFAULT_TAG_ORDER
  });
}

export function getMassCombatTagConfig() {
  let stored = {};
  try {
    stored = globalThis.game?.settings?.get?.(MODULE_ID, SETTING_MASS_COMBAT_TAGS) ?? {};
  } catch (_error) {
    stored = {};
  }
  const key = cacheKey(stored);
  if (cachedConfig && cachedConfigKey === key) return cachedConfig;
  cachedConfigKey = key;
  cachedConfig = Object.keys(stored ?? {}).length ? normalizeMassCombatTagConfig(stored) : defaultMassCombatTagConfig();
  return cachedConfig;
}

export function getMassCombatTags({ includeSystem = false } = {}) {
  const config = getMassCombatTagConfig();
  return Object.fromEntries(Object.entries(config.tags).filter(([, tag]) => tag.enabled !== false && (includeSystem || tag.system !== true)));
}

export function getMassCombatRelationTags() {
  return getMassCombatTags({ includeSystem: true });
}

export function getMassCombatUnitTagKeys() {
  return Object.keys(getMassCombatTags());
}

export function getMassCombatTagCounters() {
  return getMassCombatTagConfig().counters;
}

export function tagLabel(key, { includeSystem = true } = {}) {
  const tags = includeSystem ? getMassCombatRelationTags() : getMassCombatTags();
  return tags[key]?.label ?? key;
}

export function prepareMassCombatTagEditorContext() {
  const config = getMassCombatTagConfig();
  const tags = Object.entries(config.tags).map(([key, tag], index) => ({
    key,
    index,
    ...tag,
    locked: tag.system === true,
    enabledChecked: tag.enabled !== false,
    sourceValues: Object.fromEntries(Object.keys(config.tags).map((targetKey) => [targetKey, Math.round(asNumber(config.counters?.[key]?.[targetKey], 0) * 100)]))
  }));
  const counterRows = tags.map((source) => ({
    source,
    cells: tags.map((target) => ({
      sourceKey: source.key,
      targetKey: target.key,
      value: source.sourceValues[target.key] ?? 0,
      disabled: !source.enabledChecked || !target.enabledChecked
    }))
  }));
  return {
    tags,
    counterRows,
    tagCount: tags.filter((tag) => !tag.locked).length,
    relationCount: Object.values(config.counters).reduce((sum, row) => sum + Object.keys(row ?? {}).length, 0)
  };
}

export async function setMassCombatTagConfig(raw = {}) {
  if (!globalThis.game?.user?.isGM) return null;
  const next = normalizeMassCombatTagConfig(raw);
  clearMassCombatTagConfigCache();
  await globalThis.game.settings.set(MODULE_ID, SETTING_MASS_COMBAT_TAGS, clone(next));
  cachedConfigKey = cacheKey(next);
  cachedConfig = next;
  notifySkyholdChanged();
  return next;
}

export async function saveMassCombatTagConfigFromForm(root) {
  if (!globalThis.game?.user?.isGM) return null;
  const rows = Array.from(root?.querySelectorAll?.("[data-tag-key]") ?? []);
  const tags = {};
  const tagOrder = [];
  for (const row of rows) {
    const key = safeMassCombatTagKey(row.dataset.tagKey);
    if (!key) continue;
    const system = row.dataset.tagSystem === "true";
    const enabled = system || row.querySelector("[data-tag-field='enabled']")?.checked !== false;
    const tag = cleanTagRow(key, {
      label: row.querySelector("[data-tag-field='label']")?.value,
      short: row.querySelector("[data-tag-field='short']")?.value,
      icon: row.querySelector("[data-tag-field='icon']")?.value,
      hint: row.querySelector("[data-tag-field='hint']")?.value,
      enabled
    }, DEFAULT_MASS_COMBAT_TAGS[key] ?? MASS_COMBAT_SYSTEM_TAGS[key] ?? {}, { system });
    if (!tag) continue;
    tags[key] = tag;
    if (!system) tagOrder.push(key);
  }

  const enabledKeys = Object.keys(tags).filter((key) => tags[key]?.enabled !== false);
  const counters = {};
  for (const sourceKey of enabledKeys) {
    const row = {};
    for (const targetKey of enabledKeys) {
      const selector = `[data-counter-source="${sourceKey}"][data-counter-target="${targetKey}"]`;
      const value = Math.max(0, Math.min(100, asNumber(root.querySelector(selector)?.value, 0)));
      if (value > 0) row[targetKey] = value / 100;
    }
    if (Object.keys(row).length) counters[sourceKey] = row;
  }

  return setMassCombatTagConfig({ tags, tagOrder, counters });
}

export async function resetMassCombatTagConfig() {
  if (!globalThis.game?.user?.isGM) return null;
  return setMassCombatTagConfig(defaultMassCombatTagConfig());
}

export function makeCustomMassCombatTagKey(existingKeys = []) {
  const existing = new Set(existingKeys.map(safeMassCombatTagKey));
  for (let index = 1; index < 100; index += 1) {
    const key = `custom-${index}`;
    if (!existing.has(key)) return key;
  }
  return `custom-${Date.now()}`;
}

export async function addMassCombatCustomTag() {
  if (!globalThis.game?.user?.isGM) return null;
  const config = clone(getMassCombatTagConfig());
  const key = makeCustomMassCombatTagKey(Object.keys(config.tags));
  config.tags[key] = {
    label: `Новый тег ${config.tagOrder.length + 1}`,
    short: "Новый",
    icon: "fa-solid fa-circle",
    hint: "",
    enabled: true,
    system: false
  };
  config.tagOrder.push(key);
  return setMassCombatTagConfig(config);
}
