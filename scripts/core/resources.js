import { makeId as makeGeneratedId } from "../utils/id.js";
import { BUILTIN_RESOURCE_DEFS, RESOURCE_DEFS } from "../data/resources/builtin-resources.js";
import { readWorldResourceCatalogRows, worldResourceCatalogCacheKey } from "../data/resources/resource-catalog-settings.js";
import { parseCurrencyCopper } from "./currency.js";
import { materialGroup } from "./material-groups.js";
import { syncResourceRowBatches } from "./resource-batches.js";

export { BUILTIN_RESOURCE_DEFS, RESOURCE_DEFS };

const FOOD_TYPES = new Set(["grain", "protein", "dairy", "fruit", "vegetable"]);
const LEGACY_FOOD_TYPE_ALIASES = Object.freeze({ meat: "protein" });
const LEGACY_SHELF_LIFE_QD = Object.freeze({
  day: 4,
  days: 4,
  "день": 4,
  "дня": 4,
  "дней": 4,
  "дн": 4,
  "сутки": 4,
  "суток": 4,
  tenday: 40,
  tendays: 40,
  "ten-day": 40,
  "ten-days": 40,
  "декада": 40,
  "декады": 40,
  "декад": 40,
  "десятник": 40,
  "десятника": 40,
  "десятников": 40,
  month: 120,
  months: 120,
  "месяц": 120,
  "месяца": 120,
  "месяцев": 120,
  year: 1440,
  years: 1440,
  "год": 1440,
  "года": 1440,
  "лет": 1440
});


function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object ?? {}, key);
}

function nonNegativeInteger(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(parsed))) : fallback;
}

function finiteNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function floorNonNegativeQuantity(value, fallback = 0) {
  const parsed = finiteNumber(value);
  return parsed === null ? fallback : Math.max(0, Math.floor(parsed));
}

function ceilNonNegativeQuantity(value, fallback = 0) {
  const parsed = finiteNumber(value);
  return parsed === null ? fallback : Math.max(0, Math.ceil(parsed));
}

function normalizedBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string") return ["1", "true", "yes", "on", "да"].includes(value.trim().toLocaleLowerCase("ru"));
  return Boolean(value);
}

function normalizeCategoryTagValue(value = "") {
  const raw = String(value ?? "").normalize("NFKC").trim();
  if (!raw) return "";
  const known = materialGroup(raw);
  if (known) return known.id;
  return raw
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9а-я.-]+/giu, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function legacyShelfLifeQd(value = "") {
  const text = String(value ?? "").normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/g, "е");
  const match = text.match(/([-+]?\d+(?:[.,]\d+)?)\s*([a-zа-я]+(?:-[a-zа-я]+)?)/iu);
  if (!match) return 0;
  const amount = finiteNumber(match[1]);
  const multiplier = LEGACY_SHELF_LIFE_QD[match[2]];
  if (amount === null || !multiplier) return 0;
  return nonNegativeInteger(amount * multiplier, 0);
}

export function normalizeKey(value) {
  let text = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»\"']/g, "")
    .replace(/\s+/g, " ");

  // Раньше неизвестные ресурсы могли сохраняться как "Другое: Древесина".
  // При распознавании убираем служебные префиксы, чтобы такие строки сливались
  // обратно с каноническими ресурсами.
  text = text
    .replace(/^(другое|custom|прочее)\s*[:：-]\s*/i, "")
    .replace(/^(raw\s*material|сырье|материал)\s*[:：-]\s*/i, "")
    .replace(/[\s_\-]+/g, " ")
    .trim();
  return text;
}

export function normalizeResourceCatalogRow(row = {}) {
  const label = String(row.label ?? row.name ?? "Новый ресурс").trim() || "Новый ресурс";
  const rawId = String(row.id ?? "").trim();
  const id = safeResourceId(rawId || label);
  const aliases = Array.isArray(row.aliases)
    ? row.aliases.map((item) => String(item ?? "").trim()).filter(Boolean)
    : String(row.aliases ?? "").split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
  const materialGroups = (Array.isArray(row.materialGroups ?? row.groups) ? (row.materialGroups ?? row.groups) : String(row.materialGroups ?? row.groups ?? "").split(/[,;\n]/))
    .map((item) => materialGroup(String(item ?? "").trim())?.id ?? String(item ?? "").trim())
    .filter(Boolean);
  const marketTags = (Array.isArray(row.marketTags) ? row.marketTags : String(row.marketTags ?? "").split(/[,;\n]/))
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
  const isMoney = id === "money" || normalizedBoolean(row.isMoney, false);
  const categoryTagSource = hasOwn(row, "categoryTag") ? row.categoryTag : materialGroups[0];
  const categoryTag = normalizeCategoryTagValue(categoryTagSource);
  const canonicalPrice = finiteNumber(row.basePriceCopper);
  const basePriceCopper = canonicalPrice === null
    ? parseCurrencyCopper(row.cost, 0)
    : nonNegativeInteger(canonicalPrice, 0);
  const canonicalLoadPoints = finiteNumber(row.loadPoints);
  const legacyUnitLoad = finiteNumber(row.load) ?? finiteNumber(row.weight);
  const loadPoints = canonicalLoadPoints !== null
    ? nonNegativeInteger(canonicalLoadPoints, isMoney ? 0 : 4)
    : (legacyUnitLoad !== null ? nonNegativeInteger(legacyUnitLoad * 4, isMoney ? 0 : 4) : (isMoney ? 0 : 4));
  const canonicalShelfLifeQd = finiteNumber(row.shelfLifeQd);
  const legacyShelfLifeDays = finiteNumber(row.shelfLifeDays);
  const shelfLifeQd = canonicalShelfLifeQd !== null
    ? nonNegativeInteger(canonicalShelfLifeQd, 0)
    : (legacyShelfLifeDays !== null ? nonNegativeInteger(legacyShelfLifeDays * 4, 0) : legacyShelfLifeQd(row.shelfLife));
  const foodEdible = normalizedBoolean(row.foodEdible, false);
  const legacyFoodType = String(row.foodType ?? "").trim().toLocaleLowerCase("ru");
  const rawFoodType = LEGACY_FOOD_TYPE_ALIASES[legacyFoodType] ?? legacyFoodType;
  const foodType = foodEdible && FOOD_TYPES.has(rawFoodType) ? rawFoodType : "";

  return {
    id,
    label,
    unit: isMoney ? "медн." : "ед.",
    icon: String(row.icon ?? "fa-solid fa-cube").trim() || "fa-solid fa-cube",
    img: String(row.img ?? row.image ?? "").trim(),
    category: String(row.category ?? "Пользовательское").trim() || "Пользовательское",
    aliases,
    materialGroups,
    categoryTag,
    marketTags: [...new Set(marketTags)].slice(0, 80),
    itemUuid: String(row.itemUuid ?? "").trim(),
    itemId: String(row.itemId ?? "").trim(),
    itemType: String(row.itemType ?? "").trim(),
    basePriceCopper,
    loadPoints,
    noAutoConsume: normalizedBoolean(row.noAutoConsume, false),
    shelfLifeQd,
    foodEdible,
    foodType,
    // Legacy fields remain inert but round-trip through safe normalization so
    // old worlds and content packs do not lose source data before migration.
    cost: String(row.cost ?? "").trim(),
    shelfLife: String(row.shelfLife ?? "").trim(),
    marketAccessDifficulty: Math.max(0, Math.min(100, Math.floor(Number(row.marketAccessDifficulty ?? row.accessDifficulty ?? 0) || 0))),
    useInProduction: row.useInProduction !== false,
    useInConstruction: row.useInConstruction !== false,
    isMoney,
    hidden: Boolean(row.hidden),
    notes: String(row.notes ?? ""),
    contentVersion: Math.max(1, Math.floor(Number(row.contentVersion ?? row.version ?? 1) || 1)),
    contentSource: String(row.contentSource ?? row.source ?? "").trim().slice(0, 300)
  };
}

function safeResourceId(value = "") {
  const latin = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-z0-9а-я]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  const translit = transliterate(latin).replace(/[^a-z0-9-]+/g, "").replace(/^-+|-+$/g, "");
  return translit || makeGeneratedId("resource");
}

function transliterate(value = "") {
  const map = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
    н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh",
    щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya"
  };
  return String(value ?? "").replace(/[а-я]/g, (char) => map[char] ?? char);
}

export function getResourceCatalogRows({ rows = activeResourceContext?.rows ?? readWorldResourceCatalogRows(), includeHidden = false } = {}) {
  const normalized = Array.isArray(rows) ? rows.map((row) => normalizeResourceCatalogRow(row)) : [];
  return includeHidden ? normalized : normalized.filter((row) => !row.hidden);
}

let normalizedBuiltinResourceDefsCache = null;
let builtinResourceIndexCache = null;

function normalizedBuiltinResourceDefs() {
  normalizedBuiltinResourceDefsCache ??= BUILTIN_RESOURCE_DEFS.map((resource) => normalizeResourceCatalogRow(resource));
  return normalizedBuiltinResourceDefsCache;
}

function builtinResourceIndex() {
  // Most normalization work resolves only bundled resources. In Node checks
  // (and before Foundry settings are available) there is no world cache key;
  // rebuilding the full alias index for every production line or material row
  // made catalog normalization grow linearly with both templates and costs.
  // A resolved index is read-only in the same way as the keyed world index.
  builtinResourceIndexCache ??= buildResourceIndex(allResourceDefs({ catalogRows: [] }));
  return builtinResourceIndexCache;
}

export function allResourceDefs({ includeHidden = false, catalogRows } = {}) {
  const map = new Map();
  for (const resource of normalizedBuiltinResourceDefs()) map.set(resource.id, clonePlain(resource));
  for (const resource of getResourceCatalogRows({ rows: catalogRows ?? activeResourceContext?.rows ?? readWorldResourceCatalogRows(), includeHidden })) {
    map.set(resource.id, { ...resource });
  }
  return Array.from(map.values());
}

let cachedWorldResourceIndex = null;
let cachedWorldResourceIndexKey = "";
let activeResourceContext = null;

/** Scope synchronous normalization to its own draft, including hidden referenced resources. */
export function withResourceCatalog(rows, normalize) {
  const previous = activeResourceContext;
  const catalogRows = Array.isArray(rows) ? rows : [];
  activeResourceContext = { rows: catalogRows, index: buildResourceIndex(allResourceDefs({ catalogRows, includeHidden: true })) };
  try {
    return normalize();
  } finally {
    activeResourceContext = previous;
  }
}

function buildResourceIndex(definitions = []) {
  const byId = new Map();
  const aliases = new Map();
  for (const resource of definitions) {
    byId.set(resource.id, resource);
    aliases.set(normalizeKey(resource.id), resource.id);
    aliases.set(normalizeKey(resource.label), resource.id);
    for (const alias of resource.aliases ?? []) aliases.set(normalizeKey(alias), resource.id);
  }
  return { definitions, byId, aliases };
}

function createResourceIndex(definitions = null) {
  if (Array.isArray(definitions)) return buildResourceIndex(definitions);
  if (activeResourceContext) return activeResourceContext.index;

  const cacheKey = worldResourceCatalogCacheKey();
  if (cacheKey && cachedWorldResourceIndex && cacheKey === cachedWorldResourceIndexKey) {
    return cachedWorldResourceIndex;
  }

  const worldRows = readWorldResourceCatalogRows();
  const index = worldRows.length
    ? buildResourceIndex(allResourceDefs({ catalogRows: worldRows, includeHidden: true }))
    : builtinResourceIndex();
  if (cacheKey) {
    cachedWorldResourceIndexKey = cacheKey;
    cachedWorldResourceIndex = index;
  }
  return index;
}

function normalizeResourceIdFromIndex(index, candidates) {
  const values = candidates.length ? candidates : [""];

  // Сначала пробуем все кандидаты, кроме явного custom. Это важно для строк вида
  // { resourceId: "custom", resource: "Древесина" } из старых версий.
  for (const candidate of values) {
    const raw = String(candidate ?? "").trim();
    if (!raw || normalizeKey(raw) === "custom" || normalizeKey(raw) === "другое") continue;
    if (index.byId.has(raw)) return raw;
    const found = index.aliases.get(normalizeKey(raw));
    if (found) return found;
  }

  // Если ничего не нашли и был явный custom, оставляем custom. Иначе тоже custom.
  return "custom";
}

function isMoneyResourceFromIndex(index, candidates) {
  const id = normalizeResourceIdFromIndex(index, candidates);
  if (id === "money") return true;
  const def = id !== "custom" ? index.byId.get(id) : null;
  if (def?.isMoney) return true;
  // Если строка распознана как конкретный rawMaterial (Gold/Silver), не превращаем ее в казну.
  if (def && id !== "custom") return false;
  return candidates.some((candidate) => /(деньг|монет|money|coin|coins|медн|серебр|золот)/i.test(String(candidate ?? "")));
}

export function normalizeResourceId(...candidates) {
  return normalizeResourceIdFromIndex(createResourceIndex(), candidates);
}

export function parseResourceCosts(text = "") {
  const raw = String(text ?? "").split(/\r?\n/).map((line) => line.split("#")[0]).join("\n").trim();
  if (!raw) return [];
  return raw
    .split(/[;,\n]|\s+И\s+/i)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const choices = part.split(/\s+ИЛИ\s+/i);
      if (choices.length > 1) {
        const alternatives = choices.flatMap((choice) => parseResourceCosts(choice));
        return { resourceId: "custom", name: part, qty: 1, alternatives };
      }
      const tail = part.match(/^(.*?)([-+]?\d+(?:[.,]\d+)?)\s*$/);
      const head = part.match(/^([-+]?\d+(?:[.,]\d+)?)\s+(.+)$/);
      let name = part;
      let qty = 1;
      if (tail && tail[1].trim()) {
        name = tail[1].trim();
        qty = Number(String(tail[2]).replace(",", "."));
      } else if (head) {
        qty = Number(String(head[1]).replace(",", "."));
        name = head[2].trim();
      }
      if (!Number.isFinite(qty)) qty = 1;
      qty = ceilNonNegativeQuantity(qty, 1);
      const group = materialGroup(name);
      if (group) return { resourceGroup: group.id, resourceId: `group:${group.id}`, name: group.label, qty };
      const resourceId = normalizeResourceId(name);
      return { resourceId, name: resourceId === "custom" ? name : resourceLabel(resourceId), qty };
    })
    .filter((item) => item.name && item.qty > 0);
}

export function resourceDef(...candidates) {
  const index = createResourceIndex();
  const key = normalizeResourceIdFromIndex(index, candidates);
  return index.byId.get(key) ?? null;
}

function resourceCandidateValues(candidates = []) {
  return candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [candidate];
    return [candidate.resourceId, candidate.id, candidate.name, candidate.label];
  }).filter((candidate) => candidate !== undefined && candidate !== null && candidate !== "");
}

function directCanonicalCandidate(candidates = [], key = "") {
  return candidates.find((candidate) => candidate && typeof candidate === "object" && hasOwn(candidate, key)) ?? null;
}

function inlineDefinitionCandidate(candidates = []) {
  return candidates.find((candidate) => candidate
    && typeof candidate === "object"
    && !String(candidate.resourceId ?? "").trim()
    && (hasOwn(candidate, "id") || hasOwn(candidate, "label") || hasOwn(candidate, "category"))) ?? null;
}

function definitionForCandidates(candidates = []) {
  const values = resourceCandidateValues(candidates);
  return values.length ? resourceDef(...values) : null;
}

export function resourceBasePriceCopper(...candidates) {
  const direct = directCanonicalCandidate(candidates, "basePriceCopper");
  const directValue = direct ? finiteNumber(direct.basePriceCopper) : null;
  if (directValue !== null) return nonNegativeInteger(directValue, 0);
  const inline = inlineDefinitionCandidate(candidates);
  if (inline) return parseCurrencyCopper(inline.cost, 0);
  return nonNegativeInteger(definitionForCandidates(candidates)?.basePriceCopper, 0);
}

export function resourceLoadPoints(...candidates) {
  const direct = directCanonicalCandidate(candidates, "loadPoints");
  const directValue = direct ? finiteNumber(direct.loadPoints) : null;
  if (directValue !== null) return nonNegativeInteger(directValue, 0);
  const inline = inlineDefinitionCandidate(candidates);
  if (inline) {
    const legacyUnitLoad = finiteNumber(inline.load) ?? finiteNumber(inline.weight);
    if (legacyUnitLoad !== null) return nonNegativeInteger(legacyUnitLoad * 4, 0);
    return inline.isMoney === true || String(inline.id ?? "") === "money" ? 0 : 4;
  }
  const definition = definitionForCandidates(candidates);
  const definitionValue = finiteNumber(definition?.loadPoints);
  if (definitionValue !== null) return nonNegativeInteger(definitionValue, 0);
  const values = resourceCandidateValues(candidates).map((value) => normalizeKey(value));
  const money = Boolean(definition?.isMoney)
    || candidates.some((candidate) => candidate && typeof candidate === "object" && candidate.isMoney === true)
    || values.includes("money");
  return money ? 0 : 4;
}

export function resourceUnitLoad(...candidates) {
  return resourceLoadPoints(...candidates) / 4;
}

export function resourceShelfLifeQd(...candidates) {
  const direct = directCanonicalCandidate(candidates, "shelfLifeQd");
  const directValue = direct ? finiteNumber(direct.shelfLifeQd) : null;
  if (directValue !== null) return nonNegativeInteger(directValue, 0);
  const inline = inlineDefinitionCandidate(candidates);
  if (inline) {
    const legacyDays = finiteNumber(inline.shelfLifeDays);
    if (legacyDays !== null) return nonNegativeInteger(legacyDays * 4, 0);
    return legacyShelfLifeQd(inline.shelfLife);
  }
  return nonNegativeInteger(definitionForCandidates(candidates)?.shelfLifeQd, 0);
}

export function resourceCategoryTag(...candidates) {
  const direct = directCanonicalCandidate(candidates, "categoryTag");
  if (direct) return normalizeCategoryTagValue(direct.categoryTag);
  const inline = inlineDefinitionCandidate(candidates);
  if (inline) {
    const groups = Array.isArray(inline.materialGroups ?? inline.groups)
      ? (inline.materialGroups ?? inline.groups)
      : String(inline.materialGroups ?? inline.groups ?? "").split(/[,;\n]/);
    return normalizeCategoryTagValue(groups[0]);
  }
  return normalizeCategoryTagValue(definitionForCandidates(candidates)?.categoryTag);
}

export function resourceLabel(resource = "") {
  const index = createResourceIndex();
  if (resource && typeof resource === "object") {
    const id = normalizeResourceIdFromIndex(index, [resource.id, resource.resourceId, resource.name, resource.label]);
    const def = id !== "custom" ? index.byId.get(id) : null;
    return def?.label ?? String(resource.name ?? resource.label ?? "Ресурс");
  }
  const id = normalizeResourceIdFromIndex(index, [resource]);
  return index.byId.get(id)?.label ?? String(resource || "Ресурс").replace(/^(Другое|Custom)\s*[:：-]\s*/i, "");
}

export function resourceUnit(...candidates) {
  const def = resourceDef(...candidates);
  return def?.unit ?? "ед.";
}

export function resourceIcon(...candidates) {
  const def = resourceDef(...candidates);
  return def?.icon ?? "fa-solid fa-cube";
}

export function resourceImage(...candidates) {
  const def = resourceDef(...candidates);
  return def?.img ?? "";
}

export function resourceItemUuid(...candidates) {
  const def = resourceDef(...candidates);
  return def?.itemUuid ?? "";
}

export function isMoneyResource(...candidates) {
  return isMoneyResourceFromIndex(createResourceIndex(), candidates);
}

export function resourceOptions(currentId = "", currentName = "", { includeMoney = true } = {}) {
  const index = createResourceIndex();
  const selectedId = normalizeResourceIdFromIndex(index, [currentId, currentName]);
  const options = index.definitions
    .filter((resource) => includeMoney || !isMoneyResourceFromIndex(index, [resource.id, resource.label]))
    .map((resource) => ({
      value: resource.id,
      label: resource.label,
      selected: selectedId === resource.id
    }));
  const customName = String(currentName ?? "").trim().replace(/^(Другое|Custom)\s*[:：-]\s*/i, "");
  options.push({ value: "custom", label: customName ? `Другое: ${customName}` : "Другое", selected: selectedId === "custom" });
  return options;
}

export function normalizeResourceRow(row = {}, { compactBatches = true } = {}) {
  const index = createResourceIndex();
  const id = normalizeResourceIdFromIndex(index, [row.resourceId, row.id, row.name, row.label]);
  const def = id !== "custom" ? index.byId.get(id) : null;
  const name = String(row.name ?? row.label ?? def?.label ?? "Ресурс").replace(/^(Другое|Custom)\s*[:：-]\s*/i, "");
  const normalized = {
    id: String(row.rowId ?? row._rowId ?? row.uuid ?? row._id ?? row.key ?? row.id ?? makeGeneratedId("res", 12)),
    resourceId: id,
    name: id === "custom" ? name : def.label,
    img: String(id === "custom" ? (row.img ?? "") : (def?.img ?? row.img ?? "")),
    itemUuid: String(row.itemUuid ?? def?.itemUuid ?? ""),
    itemId: String(row.itemId ?? def?.itemId ?? ""),
    itemType: String(row.itemType ?? def?.itemType ?? ""),
    cost: String(row.cost ?? def?.cost ?? ""),
    qty: floorNonNegativeQuantity(row.qty ?? row.quantity ?? row.count, 0),
    unit: id === "money" || def?.isMoney ? "медн." : "ед.",
    notes: String(row.notes ?? ""),
    roomId: String(row.roomId ?? row.storageRoomId ?? "outdoors"),
    forSale: Boolean(row.forSale ?? row.sale ?? row.markedForSale ?? false),
    noAutoConsume: Boolean(row.noAutoConsume ?? false),
    foodEdible: Boolean(row.foodEdible ?? false),
    foodType: String(row.foodType ?? "").trim().toLowerCase(),
    shelfLifeQd: nonNegativeInteger(row.shelfLifeQd, 0),
    categoryTag: normalizeCategoryTagValue(row.categoryTag)
  };
  if (hasOwn(row, "batches")) normalized.batches = row.batches;
  return syncResourceRowBatches(normalized, { makeId: makeGeneratedId, compact: compactBatches });
}


function normalizeProductionSeasons(value = null) {
  const defs = ["spring", "summer", "autumn", "winter"];
  const fallback = Object.fromEntries(defs.map((key) => [key, true]));
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const normalized = {};
  let enabled = 0;
  for (const key of defs) {
    const active = value[key] !== false;
    normalized[key] = Boolean(active);
    if (active) enabled += 1;
  }
  return enabled ? normalized : fallback;
}

export function normalizeProductionLine(line = {}, makeId = null) {
  const id = String(line?.id || makeId?.("prod") || makeGeneratedId("prod", 12));
  const index = createResourceIndex();
  const resourceId = normalizeResourceIdFromIndex(index, [line?.resourceId, line?.resource, line?.name]);
  const def = resourceId !== "custom" ? index.byId.get(resourceId) : null;
  const resource = String(line?.resource ?? line?.name ?? def?.label ?? "Ресурс").replace(/^(Другое|Custom)\s*[:：-]\s*/i, "");
  const legacyBase = Number(line?.base ?? 0) || 0;
  const legacyPerWorker = Number(line?.perWorker ?? 0) || 0;
  const rawSource = String(line?.source ?? line?.sourceType ?? line?.productionSource ?? "workers").trim().toLowerCase();
  const source = ["workers", "time", "content"].includes(rawSource) ? rawSource : "workers";
  const rawPeriod = String(line?.period ?? line?.periodType ?? "day").trim().toLowerCase();
  const period = ["qd", "day", "tenday"].includes(rawPeriod) ? rawPeriod : "day";
  const explicitOutput = line?.outputQty ?? line?.output ?? line?.quantity;
  const outputQty = floorNonNegativeQuantity(explicitOutput ?? (legacyBase || legacyPerWorker || 1), 1);
  const workQd = Math.max(1, ceilNonNegativeQuantity(line?.workQd ?? line?.workerQD ?? line?.cycleQd ?? line?.cycleQD, 1));
  const rawExpenseMode = String(line?.expenseMode ?? line?.costMode ?? "cycle").trim().toLowerCase();
  const expenseMode = ["cycle", "unit"].includes(rawExpenseMode) ? rawExpenseMode : "cycle";
  const rawAutoCollect = String(line?.autoCollect ?? line?.collectionMode ?? "none").trim().toLowerCase();
  const autoCollect = ["none", "building", "worker"].includes(rawAutoCollect) ? rawAutoCollect : "none";

  return {
    id,
    active: line?.active !== false,
    mode: String(line?.mode ?? "Всегда"),
    source,
    period,
    contentId: String(line?.contentId ?? line?.contentKey ?? line?.content ?? ""),
    resourceId,
    resource: resourceId === "custom" ? resource : def.label,
    // Совместимость со старой схемой. Эти поля пока сохраняются,
    // но новая экономика считает производство через рабочие QD и циклы.
    base: legacyBase,
    perWorker: legacyPerWorker,
    outputQty,
    workQd,
    waitDays: Number.isFinite(Number(line?.waitDays)) ? Math.max(0, Math.ceil(Number(line.waitDays) * 4) / 4) : 0,
    repeat: line?.repeat !== false,
    batchCapacity: floorNonNegativeQuantity(line?.batchCapacity, 0),
    batchStartQty: Math.max(1, floorNonNegativeQuantity(line?.batchStartQty, 1)),
    fixedExpenses: String(line?.fixedExpenses ?? ""),
    ...(Array.isArray(line?.waitingBatches) ? { waitingBatches: JSON.parse(JSON.stringify(line.waitingBatches)) } : {}),
    formula: String(line?.formula ?? ""),
    expenses: String(line?.expenses ?? ""),
    expenseMode,
    requiresCollection: Boolean(line?.requiresCollection ?? line?.collect ?? false),
    collectQd: ceilNonNegativeQuantity(line?.collectQd ?? line?.collectionQd, 0),
    autoCollect,
    overtime: Boolean(line?.overtime ?? line?.overwork ?? false),
    // Integer production work (1 QD = 10,000 units). Inputs are consumed when
    // a batch is opened, so carried progress can never exist without funded raw materials.
    workProgressUnits: floorNonNegativeQuantity(line?.workProgressUnits, 0),
    workInputsReserved: Boolean(line?.workInputsReserved),
    workReservedOutputQty: floorNonNegativeQuantity(line?.workReservedOutputQty, 0),
    workReservedFormula: String(line?.workReservedFormula ?? ""),
    ...(line?.workReservedInputs && typeof line.workReservedInputs === "object"
      ? { workReservedInputs: JSON.parse(JSON.stringify(line.workReservedInputs)) } : {}),
    ...(line?.productionBonusRemainder && typeof line.productionBonusRemainder === "object"
      ? { productionBonusRemainder: { resourceId: String(line.productionBonusRemainder.resourceId ?? ""),
        name: String(line.productionBonusRemainder.name ?? ""),
        units: Number.isSafeInteger(line.productionBonusRemainder.units) && line.productionBonusRemainder.units >= 0 && line.productionBonusRemainder.units < 10_000
          ? line.productionBonusRemainder.units : 0 } } : {}),
    pendingQty: floorNonNegativeQuantity(line?.pendingQty ?? line?.storedQty ?? line?.readyQty, 0),
    storageRoomId: String(line?.storageRoomId ?? line?.roomId ?? "outdoors"),
    seasons: normalizeProductionSeasons(line?.seasons),
    itemUuid: String(line?.itemUuid ?? def?.itemUuid ?? ""),
    itemId: String(line?.itemId ?? def?.itemId ?? "")
  };
}

export function storageResourceKey(resource = {}) {
  const id = normalizeResourceId(resource.resourceId, resource.id, resource.name);
  const roomId = String(resource.roomId ?? resource.storageRoomId ?? "outdoors") || "outdoors";
  const resourceKey = id !== "custom" ? `id:${id}` : `custom:${normalizeKey(resource.name)}`;
  return `room:${roomId}|${resourceKey}`;
}
