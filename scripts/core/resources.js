import { makeId as makeGeneratedId } from "../utils/id.js";
import { BUILTIN_RESOURCE_DEFS, RESOURCE_DEFS } from "../data/resources/builtin-resources.js";
import { isLegacyRawMaterialItemBinding } from "../data/resources/legacy-raw-material-migration.js";
import { readWorldResourceCatalogRows, worldResourceCatalogCacheKey } from "../data/resources/resource-catalog-settings.js";
import { normalizeResourceEconomy } from "../data/resources/resource-economy-contract.js";
import { materialGroup } from "./material-groups.js";
import { normalizeProductionCadence } from "./production-cadence.js";
import { normalizeResourceLots } from "./resource-lots.js";

export { BUILTIN_RESOURCE_DEFS, RESOURCE_DEFS };
export { isLegacyRawMaterialItemBinding };
export {
  CARGO_POINT_CLASSES,
  RESOURCE_ECONOMY_VERSION,
  cargoPointsFromLegacy,
  effectiveRationPointsPerUnit,
  legacyLoadFromCargoPoints,
  normalizeResourceEconomy,
  resourceEconomyIssues,
  resourceTradeReady,
  validateResourceEconomyCatalog
} from "../data/resources/resource-economy-contract.js";

export const LIVESTOCK_RESOURCE_IDS = Object.freeze([
  "cattle", "pigs", "sheep", "goats", "horses", "chickens", "geese", "rabbits", "pigeons"
]);

export const DIET_GROUP_IDS = Object.freeze(["staple", "protein", "dairy", "produce"]);

export function isLivestockResource(...candidates) {
  return LIVESTOCK_RESOURCE_IDS.includes(normalizeResourceId(...candidates));
}

export function livestockResourceOptions(currentId = "") {
  const selected = normalizeResourceId(currentId);
  return [
    { value: "", label: "Ручное содержимое", selected: !LIVESTOCK_RESOURCE_IDS.includes(selected) },
    ...LIVESTOCK_RESOURCE_IDS.map((id) => ({ value: id, label: resourceLabel(id), selected: selected === id }))
  ];
}


function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
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
  const nutritionTags = (Array.isArray(row.nutritionTags) ? row.nutritionTags : String(row.nutritionTags ?? "").split(/[,;\n]/))
    .map((item) => String(item ?? "").trim().toLowerCase())
    .filter(Boolean);
  const requestedDietGroup = String(row.dietGroup ?? "").trim().toLowerCase();
  const legacyDietGroup = nutritionTags.includes("dairy")
    ? "dairy"
    : (nutritionTags.includes("staple")
      ? "staple"
      : (nutritionTags.includes("protein")
        ? "protein"
        : (nutritionTags.some((tag) => tag === "produce" || tag === "fresh") ? "produce" : "")));
  const dietGroup = DIET_GROUP_IDS.includes(requestedDietGroup)
    ? requestedDietGroup
    : (Object.hasOwn(row, "dietGroup") ? "" : legacyDietGroup);
  const isMoney = id === "money" || Boolean(row.isMoney);
  const unitLabel = String(row.unitLabel ?? row.packageLabel ?? row.unit ?? (isMoney ? "монета" : "единица")).trim() || (isMoney ? "монета" : "единица");
  const packageMassKg = Math.max(0, Number(row.packageMassKg ?? row.massKg ?? 0) || 0);
  const packageVolumeL = Math.max(0, Number(row.packageVolumeL ?? row.volumeL ?? 0) || 0);
  const economy = normalizeResourceEconomy({ ...row, packageMassKg, packageVolumeL }, { isMoney });
  const stripLegacyItemBinding = isLegacyRawMaterialItemBinding(row);

  return {
    id,
    label,
    unit: isMoney ? "медн." : "ед.",
    unitLabel,
    // Economy V2 resources are indivisible FBL parties. A fractional step is
    // retained only by an explicitly legacy row until the GM activates V2.
    quantityStep: economy.legacyEconomy
      ? Math.max(0.001, Number(row.quantityStep ?? row.unitStep ?? 1) || 1)
      : 1,
    priceBasis: String(row.priceBasis ?? unitLabel).trim() || unitLabel,
    packageMassKg,
    packageVolumeL,
    economyVersion: economy.economyVersion,
    legacyEconomy: economy.legacyEconomy,
    legacyEconomyVersion: economy.legacyEconomyVersion,
    referencePriceCopper: economy.referencePriceCopper,
    tradable: economy.tradable,
    tradeReady: economy.tradeReady,
    tradeConfigurationError: economy.tradeConfigurationError,
    tradeDisabledReason: economy.tradeDisabledReason,
    cargoClass: economy.cargoClass,
    cargoPoints: economy.cargoPoints,
    legacyLoad: economy.legacyLoad,
    loadMode: economy.loadMode,
    load: economy.load,
    rationPoints: economy.rationPoints,
    foodValue: economy.foodValue,
    dietGroup,
    nutritionTags: [...new Set(nutritionTags)].slice(0, 40),
    legacyShelfLifeDays: economy.legacyShelfLifeDays,
    shelfLifeMode: economy.shelfLifeMode,
    shelfLifeTendays: economy.shelfLifeTendays,
    shelfLifeDays: economy.shelfLifeDays,
    qualityTier: String(row.qualityTier ?? "common").trim().toLowerCase() || "common",
    icon: String(row.icon ?? "fa-solid fa-cube").trim() || "fa-solid fa-cube",
    img: String(row.img ?? row.image ?? "").trim(),
    category: String(row.category ?? "Пользовательское").trim() || "Пользовательское",
    aliases,
    materialGroups,
    marketTags: [...new Set(marketTags)].slice(0, 80),
    itemUuid: stripLegacyItemBinding ? "" : String(row.itemUuid ?? "").trim(),
    itemId: stripLegacyItemBinding ? "" : String(row.itemId ?? "").trim(),
    itemType: stripLegacyItemBinding ? "" : String(row.itemType ?? "").trim(),
    legacyCost: economy.legacyCost,
    cost: economy.cost,
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

export function getResourceCatalogRows({ rows = readWorldResourceCatalogRows(), includeHidden = false } = {}) {
  const normalized = Array.isArray(rows) ? rows.map((row) => normalizeResourceCatalogRow(row)) : [];
  return includeHidden ? normalized : normalized.filter((row) => !row.hidden);
}

export function allResourceDefs({ includeHidden = false, catalogRows } = {}) {
  const map = new Map();
  for (const resource of BUILTIN_RESOURCE_DEFS) map.set(resource.id, clonePlain(resource));
  for (const resource of getResourceCatalogRows({ rows: catalogRows ?? readWorldResourceCatalogRows(), includeHidden })) {
    map.set(resource.id, { ...resource });
  }
  return Array.from(map.values());
}

let cachedWorldResourceIndex = null;
let cachedWorldResourceIndexKey = "";

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

  const cacheKey = worldResourceCatalogCacheKey();
  if (cacheKey && cachedWorldResourceIndex && cacheKey === cachedWorldResourceIndexKey) {
    return cachedWorldResourceIndex;
  }

  const index = buildResourceIndex(allResourceDefs());
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
  const raw = String(text ?? "").trim();
  if (!raw) return [];
  return raw
    .split(/[;,\n]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
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
      const group = materialGroup(name);
      if (group) return { resourceGroup: group.id, resourceId: `group:${group.id}`, name: group.label, qty: Math.max(0, qty) };
      const resourceId = normalizeResourceId(name);
      return { resourceId, name: resourceId === "custom" ? name : resourceLabel(resourceId), qty: Math.max(0, qty) };
    })
    .filter((item) => item.name && item.qty > 0);
}

export function serializeResourceCosts(items = []) {
  if (!Array.isArray(items)) return "";
  return items
    .map((item) => {
      const qty = Number(item?.qty ?? item?.quantity ?? 0);
      if (!Number.isFinite(qty) || qty <= 0) return "";
      const group = materialGroup(item?.resourceGroup ?? item?.resourceId);
      const resourceId = normalizeResourceId(item?.resourceId, item?.name);
      const name = group?.label
        ?? (resourceId === "custom" ? String(item?.name ?? "").trim() : resourceId);
      if (!name) return "";
      const quantity = String(Math.round(qty * 1000) / 1000);
      return `${name} ${quantity}`;
    })
    .filter(Boolean)
    .join(", ");
}

export function resourceDef(...candidates) {
  const index = createResourceIndex();
  const key = normalizeResourceIdFromIndex(index, candidates);
  return index.byId.get(key) ?? null;
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
  return def?.unitLabel ?? def?.unit ?? "ед.";
}

const COMPACT_RESOURCE_UNITS = new Map([
  ["малый мешок", "мешок"],
  ["партия заготовок", "партия"],
  ["малый слиток", "слиток"],
  ["крица или пакет прутков", "крица"],
  ["часть шкуры", "шкура"],
  ["продовольственная партия", "партия"],
  ["сложенная шкура", "шкура"],
  ["обработанный блок", "блок"],
  ["брусок или горшок", "брусок"],
  ["связка пиломатериала", "связка"],
  ["спрессованная кипа", "кипа"]
]);

/** A display-only abbreviation; canonical package labels remain untouched. */
export function compactResourceUnit(unit = "ед.") {
  const full = String(unit ?? "").trim() || "ед.";
  return COMPACT_RESOURCE_UNITS.get(full.toLowerCase()) ?? full;
}

export function resourceUnitShort(...candidates) {
  return compactResourceUnit(resourceUnit(...candidates));
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

export function normalizeResourceRow(row = {}, { currentQd = 0, seedPerishableLots = true } = {}) {
  const index = createResourceIndex();
  const id = normalizeResourceIdFromIndex(index, [row.resourceId, row.id, row.name, row.label]);
  const def = id !== "custom" ? index.byId.get(id) : null;
  const name = String(row.name ?? row.label ?? def?.label ?? "Ресурс").replace(/^(Другое|Custom)\s*[:：-]\s*/i, "");
  const qty = Number(row.qty ?? row.quantity ?? row.count ?? 0) || 0;
  // Recognized resources stay governed by the live authority catalog. Holding
  // rows are quantities/lots, not price or cargo snapshots; otherwise an old
  // row would silently override a later GM catalog correction.
  const economy = normalizeResourceEconomy(def ?? row, { isMoney: id === "money" || def?.isMoney === true });
  const shelfLifeDays = economy.shelfLifeDays;
  const stripLegacyItemBinding = isLegacyRawMaterialItemBinding(row);
  const quantityStep = id === "custom"
    ? Math.max(0.001, Number(row.quantityStep ?? 1) || 1)
    : Math.max(0.001, Number(def?.quantityStep ?? 1) || 1);
  const fractionalRemainder = quantityStep >= 1 && qty > 0
    ? Math.round((qty - Math.floor(qty)) * 1_000_000) / 1_000_000
    : 0;
  const normalized = {
    id: String(row.rowId ?? row._rowId ?? row.uuid ?? row._id ?? row.key ?? row.id ?? makeGeneratedId("res", 12)),
    resourceId: id,
    name: id === "custom" ? name : def.label,
    img: String(id === "custom" ? (row.img ?? "") : (def?.img ?? row.img ?? "")),
    itemUuid: stripLegacyItemBinding ? "" : String(row.itemUuid ?? def?.itemUuid ?? ""),
    itemId: stripLegacyItemBinding ? "" : String(row.itemId ?? def?.itemId ?? ""),
    itemType: stripLegacyItemBinding ? "" : String(row.itemType ?? def?.itemType ?? ""),
    cost: economy.cost,
    qty,
    quantityStep,
    ...(fractionalRemainder > 0.000001 ? { legacyRemainder: fractionalRemainder } : {}),
    unit: id === "money" || def?.isMoney ? "медн." : (def?.unitLabel ?? row.unit ?? "ед."),
    notes: String(row.notes ?? ""),
    roomId: String(row.roomId ?? row.storageRoomId ?? "outdoors"),
    forSale: Boolean(row.forSale ?? row.sale ?? row.markedForSale ?? false)
  };
  if (id === "custom") {
    normalized.economyVersion = economy.economyVersion;
    normalized.referencePriceCopper = economy.referencePriceCopper;
    normalized.tradable = economy.tradable;
    normalized.cargoClass = economy.cargoClass;
    normalized.cargoPoints = economy.cargoPoints;
    normalized.rationPoints = economy.rationPoints;
    normalized.shelfLifeTendays = economy.shelfLifeTendays;
  }
  const lots = normalizeResourceLots({ ...row, qty }, { currentQd, shelfLifeDays, seedMissing: seedPerishableLots });
  if (lots.length) normalized.lots = lots;
  for (const key of ["load", "weight", "foodValue"]) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") normalized[key] = Math.max(0, Number(row[key]) || 0);
  }
  normalized.load = economy.load;
  normalized.foodValue = economy.foodValue;
  if (row.category !== undefined && row.category !== null && row.category !== "") normalized.category = String(row.category);
  return normalized;
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

function normalizeProductionWorkInProgress(value = null, line = {}, index = createResourceIndex()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const laborRequiredQd = Math.max(1, Number(value?.laborRequiredQd ?? value?.requiredLaborQd ?? line?.laborQdPerBatch ?? 1) || 1);
  const laborDoneQd = Math.max(0, Math.min(laborRequiredQd, Number(value?.laborDoneQd ?? value?.completedLaborQd ?? 0) || 0));
  const resourceId = normalizeResourceIdFromIndex(index, [value?.resourceId, value?.resource, line?.resourceId, line?.resource]);
  const def = resourceId !== "custom" ? index.byId.get(resourceId) : null;
  const resource = resourceId === "custom"
    ? String(value?.resource ?? line?.resource ?? "Ресурс")
    : String(def?.label ?? value?.resource ?? line?.resource ?? resourceId);
  const inputCosts = Array.isArray(value?.inputCosts) ? value.inputCosts.map((cost) => {
    const inputResourceId = normalizeResourceIdFromIndex(index, [cost?.resourceId, cost?.name]);
    const inputDef = inputResourceId !== "custom" ? index.byId.get(inputResourceId) : null;
    return {
      resourceId: inputResourceId,
      name: inputResourceId === "custom" ? String(cost?.name ?? "Ресурс") : String(inputDef?.label ?? cost?.name ?? inputResourceId),
      qty: Math.max(0, Number(cost?.qty ?? 0) || 0),
      roomId: String(cost?.roomId ?? cost?.storageRoomId ?? "")
    };
  }).filter((cost) => cost.qty > 0) : [];
  return {
    schema: 1,
    source: "workers",
    startedQd: Math.max(0, Math.floor(Number(value?.startedQd ?? 0) || 0)),
    cadenceKey: String(value?.cadenceKey ?? ""),
    laborRequiredQd,
    laborDoneQd,
    // Preserve an old fractional WIP snapshot verbatim. Economy V2 validates
    // it as a blocker at runtime; safe normalization must not silently repair
    // authored state by rounding it down.
    outputQty: Math.max(0, Number(value?.outputQty ?? 0) || 0),
    resourceId,
    resource,
    storageRoomId: String(value?.storageRoomId ?? line?.storageRoomId ?? line?.roomId ?? "outdoors") || "outdoors",
    requiresCollection: Boolean(value?.requiresCollection),
    formula: String(value?.formula ?? line?.formula ?? ""),
    formulaResult: String(value?.formulaResult ?? ""),
    inputsCommitted: value?.inputsCommitted !== false,
    inputCosts
  };
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
  const legacyPeriod = String(line?.period ?? line?.periodType ?? "day").trim().toLowerCase();
  const cadence = normalizeProductionCadence(line?.cadence ?? legacyPeriod, "day");
  const outputQty = Math.max(0, Number((line?.outputQty ?? line?.output ?? line?.quantity ?? legacyBase) || legacyPerWorker || 1) || 1);
  const legacyWorkQd = Math.max(1, Number(line?.workQd ?? line?.workerQD ?? line?.cycleQd ?? line?.cycleQD ?? 1) || 1);
  const cadenceEvery = Math.max(1, Math.floor(Number(line?.cadenceEvery ?? (source === "workers" ? 1 : legacyWorkQd)) || 1));
  const contentUnitsPerBatch = line?.contentUnitsPerBatch === undefined || line?.contentUnitsPerBatch === null || line?.contentUnitsPerBatch === ""
    ? 1
    : Math.max(0, Math.floor(Number(line.contentUnitsPerBatch) || 0));
  const laborQdPerBatch = source === "workers"
    ? Math.max(1, Number(line?.laborQdPerBatch ?? legacyWorkQd) || 1)
    : Math.max(0, Number(line?.laborQdPerBatch ?? 0) || 0);
  const legacyMaxBatches = source === "workers" && cadence === "tenday" ? 1 : (source === "workers" ? 0 : 1);
  const maxBatchesPerCadence = Math.max(0, Math.floor(Number(line?.maxBatchesPerCadence ?? legacyMaxBatches) || 0));
  const rawExpenseMode = String(line?.expenseMode ?? line?.costMode ?? "cycle").trim().toLowerCase();
  const expenseMode = ["cycle", "unit"].includes(rawExpenseMode) ? rawExpenseMode : "cycle";
  const rawAutoCollect = String(line?.autoCollect ?? line?.collectionMode ?? "none").trim().toLowerCase();
  const autoCollect = ["none", "building", "worker"].includes(rawAutoCollect) ? rawAutoCollect : "none";
  const stripLegacyItemBinding = isLegacyRawMaterialItemBinding(line);
  const requiresCollection = Boolean(line?.requiresCollection ?? line?.collect ?? false);
  // Old time/content lines without a collection operation were implicitly
  // passive. Preserve that authored behavior once, but make the resulting row
  // explicit so new and edited lines cannot create output accidentally.
  const passive = source !== "workers" && Boolean(line?.passive ?? !requiresCollection);
  const workInProgress = normalizeProductionWorkInProgress(line?.workInProgress ?? line?.wip, line, index);

  return {
    id,
    active: line?.active !== false,
    mode: String(line?.mode ?? "Всегда"),
    source,
    cadence,
    cadenceEvery,
    laborQdPerBatch,
    maxBatchesPerCadence,
    cadenceKey: String(line?.cadenceKey ?? ""),
    batchesInCadence: Math.max(0, Math.floor(Number(line?.batchesInCadence ?? 0) || 0)),
    // Временные алиасы для импортов и старых макросов. Движок использует
    // только cadence/laborQdPerBatch/maxBatchesPerCadence.
    period: cadence,
    contentId: String(line?.contentId ?? line?.contentKey ?? line?.content ?? ""),
    contentUnitsPerBatch,
    resourceId,
    resource: resourceId === "custom" ? resource : def.label,
    // Совместимость со старой схемой. Эти поля пока сохраняются,
    // но новая экономика считает производство через рабочие QD и циклы.
    base: legacyBase,
    perWorker: legacyPerWorker,
    outputQty,
    workQd: source === "workers" ? laborQdPerBatch : cadenceEvery,
    formula: String(line?.formula ?? ""),
    expenses: String(line?.expenses ?? ""),
    expenseMode,
    requiresCollection,
    passive,
    collectQd: Math.max(0, Number(line?.collectQd ?? line?.collectionQd ?? 0) || 0),
    autoCollect,
    daylightCollectionOnly: Boolean(line?.daylightCollectionOnly ?? line?.daylightOnly ?? false),
    daylightProductionOnly: Boolean(line?.daylightProductionOnly ?? false),
    overtime: Boolean(line?.overtime ?? line?.overwork ?? false),
    pendingQty: Math.max(0, Number(line?.pendingQty ?? line?.storedQty ?? line?.readyQty ?? 0) || 0),
    workInProgress,
    storageRoomId: String(line?.storageRoomId ?? line?.roomId ?? "outdoors"),
    seasons: normalizeProductionSeasons(line?.seasons),
    itemUuid: stripLegacyItemBinding ? "" : String(line?.itemUuid ?? def?.itemUuid ?? ""),
    itemId: stripLegacyItemBinding ? "" : String(line?.itemId ?? def?.itemId ?? "")
  };
}

export function storageResourceKey(resource = {}) {
  const id = normalizeResourceId(resource.resourceId, resource.id, resource.name);
  const roomId = String(resource.roomId ?? resource.storageRoomId ?? "outdoors") || "outdoors";
  const resourceKey = id !== "custom" ? `id:${id}` : `custom:${normalizeKey(resource.name)}`;
  return `room:${roomId}|${resourceKey}`;
}
