import { normalizeResourceCatalogRow, normalizeResourceId, validateResourceEconomyCatalog } from "../core/resources.js";
import { BUILTIN_RESOURCE_DEFS } from "./resources/builtin-resources.js";
import { RESOURCE_ECONOMY_VERSION } from "./resources/resource-economy-contract.js";
import { stableDataHash } from "./storage-commit.js";
import { clone, toNumber } from "./utils.js";
import { classifyStoredBuildingMaterialRecipe } from "./building-material-recipe-reset.js";
import { ECONOMY_V2_ACTIVATION_VERSION } from "./economy-v2-constants.js";

export { ECONOMY_V2_ACTIVATION_VERSION } from "./economy-v2-constants.js";
export const ECONOMY_V2_RESOLUTIONS = Object.freeze(["accept-inferred", "non-tradable"]);

export const NATIVE_RESOURCE_V1_FINGERPRINT_FIELDS = Object.freeze([
  "id", "label", "unitLabel", "quantityStep", "priceBasis", "packageMassKg", "packageVolumeL",
  "load", "foodValue", "dietGroup", "shelfLifeDays", "qualityTier", "icon", "category",
  "useInProduction", "useInConstruction", "cost", "img", "notes", "aliases", "marketTags", "nutritionTags"
]);

const NORMALIZED_NATIVE_RESOURCE_V1_FINGERPRINT_FIELDS = Object.freeze([
  "id", "label", "unitLabel", "quantityStep", "priceBasis", "packageMassKg", "packageVolumeL",
  "referencePriceCopper", "tradable", "cargoClass", "cargoPoints", "legacyLoad", "load",
  "rationPoints", "foodValue", "dietGroup", "legacyShelfLifeDays", "shelfLifeMode",
  "shelfLifeTendays", "shelfLifeDays", "qualityTier", "icon", "category", "useInProduction",
  "useInConstruction", "legacyCost", "cost", "img", "notes", "aliases", "marketTags",
  "nutritionTags", "contentSource", "contentVersion"
]);

function fingerprintValue(value) {
  return JSON.stringify(value ?? null);
}

function semanticMeta(meta = {}) {
  const result = {};
  for (const [key, value] of Object.entries(meta && typeof meta === "object" ? meta : {})) {
    if (["revision", "lastUpdated", "storageCommit"].includes(key)) continue;
    result[key] = key === "economyActivation" && value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).filter(([field]) => field !== "targetHash"))
      : value;
  }
  return result;
}

export function economyV2ActivationSourceHash(data = {}) {
  return stableDataHash({
    meta: semanticMeta(data?.meta),
    revision: Math.max(0, Math.floor(toNumber(data?.meta?.revision, 0))),
    holdings: data?.holdings ?? [],
    catalog: data?.catalog ?? {}
  });
}

export function economyV2RuntimeStatus(data = {}) {
  const version = Math.max(1, Math.floor(toNumber(data?.meta?.economyVersion, 1)));
  const activationVersion = Math.max(0, Math.floor(toNumber(data?.meta?.economyActivation?.version, 0)));
  const resources = Array.isArray(data?.catalog?.resources) ? data.catalog.resources : [];
  const issues = validateResourceEconomyCatalog(resources);
  const active = version >= RESOURCE_ECONOMY_VERSION;
  const economyCurrent = version === RESOURCE_ECONOMY_VERSION;
  const activationCurrent = activationVersion === ECONOMY_V2_ACTIVATION_VERSION;
  const futureEconomyVersion = version > RESOURCE_ECONOMY_VERSION;
  const futureActivationVersion = activationVersion > ECONOMY_V2_ACTIVATION_VERSION;
  const unsupportedFuture = futureEconomyVersion || futureActivationVersion;
  return {
    version,
    activationVersion,
    active,
    economyCurrent,
    activationCurrent,
    futureEconomyVersion,
    futureActivationVersion,
    unsupportedFuture,
    ready: economyCurrent && activationCurrent && issues.length === 0,
    issues,
    message: unsupportedFuture
      ? "Мир сохранён более новой версией Economy V2. Обновите модуль; текущая версия не будет понижать или перезаписывать эти данные."
      : !active
      ? "Сначала GM должен провести явную активацию Economy V2 на вкладке GM."
      : (!activationCurrent
        ? "GM должен обновить активацию Economy V2: проверить цены, двусторонний рынок, рецепты, зарплаты и флот, затем скачать новую резервную копию."
        : (issues.length ? "Каталог содержит ресурсы, которые ещё не подтверждены для Economy V2." : ""))
  };
}

export function isExactNativeV1Resource(row = {}) {
  if (String(row?.contentSource ?? "") !== "fbl-skyhold.native-economy-full-reset") return false;
  if (Math.floor(toNumber(row?.contentVersion, 0)) !== 1) return false;
  const builtin = BUILTIN_RESOURCE_DEFS.find((candidate) => candidate.id === String(row?.id ?? ""));
  if (!builtin) return false;
  const rawMatch = row?.economyVersion === undefined && row?.referencePriceCopper === undefined
    && row?.cargoPoints === undefined && row?.rationPoints === undefined
    && NATIVE_RESOURCE_V1_FINGERPRINT_FIELDS.every((field) => {
    const legacyBuiltinValue = field === "cost" ? (builtin.legacyCost || undefined) : builtin[field];
    return fingerprintValue(row[field]) === fingerprintValue(legacyBuiltinValue);
  });
  if (rawMatch) return true;

  // SkyholdData exposes a safely normalized view, so an untouched V1 row has
  // compatibility fields derived from its old cost/load values. Recognize that
  // representation too, without treating a modified catalog row as native.
  if (row?.legacyEconomy !== true || Math.floor(toNumber(row?.legacyEconomyVersion, 0)) > 1) return false;
  const legacySource = Object.fromEntries(NATIVE_RESOURCE_V1_FINGERPRINT_FIELDS.map((field) => [
    field,
    field === "cost" ? (builtin.legacyCost || undefined) : builtin[field]
  ]));
  const normalizedNative = normalizeResourceCatalogRow({
    ...legacySource,
    contentSource: "fbl-skyhold.native-economy-full-reset",
    contentVersion: 1
  });
  const normalizedRow = normalizeResourceCatalogRow(row);
  return NORMALIZED_NATIVE_RESOURCE_V1_FINGERPRINT_FIELDS.every((field) => (
    fingerprintValue(normalizedRow[field]) === fingerprintValue(normalizedNative[field])
  ));
}

export function upgradeExactNativeV1Resource(row = {}) {
  if (!isExactNativeV1Resource(row)) return null;
  const builtin = BUILTIN_RESOURCE_DEFS.find((candidate) => candidate.id === String(row?.id ?? ""));
  return normalizeResourceCatalogRow({
    ...row,
    economyVersion: RESOURCE_ECONOMY_VERSION,
    legacyEconomy: false,
    quantityStep: 1,
    referencePriceCopper: builtin.referencePriceCopper,
    tradable: builtin.tradable,
    tradeDisabledReason: builtin.tradeDisabledReason,
    cargoClass: builtin.cargoClass,
    cargoPoints: builtin.cargoPoints,
    rationPoints: builtin.rationPoints,
    shelfLifeMode: builtin.shelfLifeMode,
    shelfLifeTendays: builtin.shelfLifeTendays,
    contentVersion: 2
  });
}

function inferredV2Resource(row = {}, resolution = "accept-inferred") {
  return normalizeResourceCatalogRow({
    ...row,
    economyVersion: RESOURCE_ECONOMY_VERSION,
    legacyEconomy: false,
    quantityStep: 1,
    ...(resolution === "non-tradable" ? {
      tradable: false,
      tradeDisabledReason: String(row?.tradeDisabledReason ?? "Не подтверждено GM при активации Economy V2.")
    } : {})
  });
}

function resourceResolution(resolutions = {}, row = {}) {
  const value = String(resolutions?.[String(row?.id ?? "")] ?? "");
  return ECONOMY_V2_RESOLUTIONS.includes(value) ? value : "";
}

function catalogPriceMap(resources = []) {
  const map = new Map(BUILTIN_RESOURCE_DEFS.map((row) => [row.id, row]));
  for (const row of Array.isArray(resources) ? resources : []) map.set(String(row?.id ?? ""), row);
  return map;
}

function activationSummary(data = {}) {
  const resources = Array.isArray(data?.catalog?.resources) ? data.catalog.resources : [];
  const prices = catalogPriceMap(resources);
  let stockUnits = 0;
  let stockValueCopper = 0;
  let activeOrders = 0;
  let buildings = 0;
  let residents = 0;
  let fleetAssets = 0;
  let productionLines = 0;
  let activeProjects = 0;
  let payrollAccounts = 0;
  let payrollArrearsCopper = 0;
  let fleetCashCopper = 0;
  let fleetReserveCopper = 0;
  let marketAskStock = 0;
  let marketBidDemand = 0;
  let activeExports = 0;
  const recipeClassifications = [];
  for (const template of data?.catalog?.buildings ?? []) {
    recipeClassifications.push(classifyStoredBuildingMaterialRecipe(template, { kind: "template" }));
  }
  for (const holding of data?.holdings ?? []) {
    buildings += (holding?.buildings?.list ?? []).length;
    residents += (holding?.people?.list ?? []).filter((person) => person?.dead !== true && person?.deceased !== true).length;
    const vessels = holding?.special?.fleet?.ships ?? holding?.special?.fleet?.vessels ?? [];
    fleetAssets += vessels.length;
    for (const vessel of vessels) {
      fleetCashCopper += Math.max(0, toNumber(vessel?.finances?.cashCopper, 0));
      fleetReserveCopper += Math.max(0, toNumber(vessel?.finances?.replacementReserveCopper, 0));
    }
    for (const building of holding?.buildings?.list ?? []) {
      recipeClassifications.push(classifyStoredBuildingMaterialRecipe(building, { kind: "instance" }));
      productionLines += (building?.productionLines ?? []).length;
      const constructionStatus = String(building?.constructionStatus ?? building?.status ?? "").toLowerCase();
      if (["planned", "building", "construction", "under-construction"].includes(constructionStatus)) activeProjects += 1;
    }
    activeOrders += (holding?.special?.market?.orders ?? []).filter((order) => ["pending", "in-transit", "delayed"].includes(String(order?.status ?? ""))).length;
    activeExports += (holding?.special?.market?.exportBook?.orders ?? []).filter((order) => ["reserved", "in-transit"].includes(String(order?.status ?? ""))).length;
    for (const line of holding?.special?.market?.liquidity?.lines ?? []) {
      marketAskStock += Math.max(0, Math.floor(toNumber(line?.askStock, 0)));
      marketBidDemand += Math.max(0, Math.floor(toNumber(line?.bidDemand, 0)));
    }
    const accounts = holding?.gm?.economy?.labor?.payroll?.accounts ?? {};
    const accountRows = Array.isArray(accounts) ? accounts : Object.values(accounts);
    payrollAccounts += accountRows.length;
    payrollArrearsCopper += accountRows.reduce((sum, account) => sum + Math.max(0, toNumber(account?.arrearsCopper, 0)), 0);
    for (const stock of holding?.storage?.resources ?? []) {
      const qty = Math.max(0, toNumber(stock?.qty, 0));
      const id = normalizeResourceId(stock?.resourceId, stock?.name);
      const def = prices.get(id);
      stockUnits += qty;
      stockValueCopper += qty * Math.max(0, toNumber(def?.referencePriceCopper, 0));
    }
  }
  return {
    activationVersion: Math.max(0, Math.floor(toNumber(data?.meta?.economyActivation?.version, 0))),
    economyVersion: Math.max(1, Math.floor(toNumber(data?.meta?.economyVersion, 1))),
    catalogResources: resources.length,
    tradableResources: resources.filter((row) => row?.tradable === true).length,
    catalogReferencePriceCopper: Math.round(resources.reduce((sum, row) => sum + Math.max(0, toNumber(row?.referencePriceCopper, 0)), 0)),
    legacyResources: resources.filter((row) => row?.legacyEconomy === true || Math.floor(toNumber(row?.economyVersion, 1)) < RESOURCE_ECONOMY_VERSION).length,
    stockUnits: Math.round(stockUnits * 1_000_000) / 1_000_000,
    stockValueCopper: Math.round(stockValueCopper),
    activeOrders,
    buildings,
    residents,
    fleetAssets,
    productionLines,
    activeProjects,
    payrollAccounts,
    payrollArrearsCopper: Math.round(payrollArrearsCopper),
    fleetCashCopper: Math.round(fleetCashCopper),
    fleetReserveCopper: Math.round(fleetReserveCopper),
    marketAskStock,
    marketBidDemand,
    activeExports,
    legacyBuildingRecipes: recipeClassifications.filter((row) => row.classification.startsWith("legacy-calibration")).length,
    customizedBuildingRecipes: recipeClassifications.filter((row) => row.classification === "customized").length
  };
}

function applyBuildingRecipeReset(target = {}) {
  const changes = [];
  const applyRows = (rows = [], context = {}) => {
    for (const record of Array.isArray(rows) ? rows : []) {
      const planned = classifyStoredBuildingMaterialRecipe(record, { kind: context.kind });
      if (planned.plannedPatch) Object.assign(record, clone(planned.plannedPatch));
      if (planned.action !== "none" || planned.plannedPatch) {
        changes.push({
          scope: context.kind,
          holdingId: String(context.holdingId ?? ""),
          id: String(record?.id ?? ""),
          name: String(record?.name ?? record?.id ?? "Здание"),
          classification: planned.classification,
          action: planned.action,
          protectedReasons: [...(planned.protection?.reasons ?? [])],
          beforeFingerprint: planned.storedFingerprint,
          afterFingerprint: planned.action === "replace-with-source" ? planned.sourceFingerprint : planned.storedFingerprint
        });
      }
    }
  };
  applyRows(target?.catalog?.buildings, { kind: "template" });
  for (const holding of target?.holdings ?? []) {
    applyRows(holding?.buildings?.list, { kind: "instance", holdingId: holding?.id });
  }
  return changes;
}

export function planEconomyV2Activation({ data, resolutions = {}, operationId = "", now = null } = {}) {
  if (!data || typeof data !== "object") throw new TypeError("FBL Skyhold | Economy V2 activation requires a data root.");
  const baseRevision = Math.max(0, Math.floor(toNumber(data?.meta?.revision, 0)));
  const sourceHash = economyV2ActivationSourceHash(data);
  const id = String(operationId ?? "").trim() || `economy-v2-${sourceHash}`;
  const target = clone(data);
  const storedEconomyVersion = Math.max(1, Math.floor(toNumber(data?.meta?.economyVersion, 1)));
  const storedActivationVersion = Math.max(0, Math.floor(toNumber(data?.meta?.economyActivation?.version, 0)));
  const futureBlockers = [];
  if (storedEconomyVersion > RESOURCE_ECONOMY_VERSION) {
    futureBlockers.push({
      code: "future-economy-version",
      message: `Мир использует Economy ${storedEconomyVersion}; эта версия модуля поддерживает только Economy ${RESOURCE_ECONOMY_VERSION} и не будет выполнять понижение.`
    });
  }
  if (storedActivationVersion > ECONOMY_V2_ACTIVATION_VERSION) {
    futureBlockers.push({
      code: "future-activation-version",
      message: `Мир использует активацию Economy V2 v${storedActivationVersion}; эта версия модуля поддерживает только v${ECONOMY_V2_ACTIVATION_VERSION} и не будет выполнять понижение.`
    });
  }
  if (futureBlockers.length) {
    return {
      operationId: id,
      baseRevision,
      sourceHash,
      targetHash: sourceHash,
      before: activationSummary(data),
      after: activationSummary(target),
      changes: [],
      buildingRecipeChanges: [],
      blockers: futureBlockers,
      canApply: false,
      target
    };
  }
  target.catalog ??= {};
  const sourceRows = Array.isArray(data?.catalog?.resources) ? data.catalog.resources : [];
  const changes = [];
  const blockers = [];
  target.catalog.resources = sourceRows.map((source) => {
    const exact = upgradeExactNativeV1Resource(source);
    if (exact) {
      changes.push({ id: String(source?.id ?? ""), mode: "exact-native", before: clone(source), after: clone(exact) });
      return exact;
    }
    const normalized = normalizeResourceCatalogRow(source);
    if (normalized.legacyEconomy !== true && normalized.economyVersion >= RESOURCE_ECONOMY_VERSION) return normalized;
    const resolution = resourceResolution(resolutions, normalized);
    const inferred = inferredV2Resource(normalized, resolution || "accept-inferred");
    changes.push({ id: normalized.id, mode: resolution || "needs-decision", before: clone(source), after: clone(inferred) });
    if (!resolution) {
      blockers.push({ code: "resource-resolution", resourceId: normalized.id, message: `${normalized.label}: подтвердите рассчитанные поля V2 или отключите торговлю.` });
      return normalized;
    }
    return inferred;
  });
  const buildingRecipeChanges = applyBuildingRecipeReset(target);

  for (const issue of validateResourceEconomyCatalog(target.catalog.resources)) {
    if (issue.code === "economy-version" && blockers.some((row) => row.resourceId === issue.id)) continue;
    blockers.push({ ...issue, resourceId: issue.id });
  }
  target.meta ??= {};
  target.meta.economyVersion = RESOURCE_ECONOMY_VERSION;
  target.meta.economyActivation = {
    version: ECONOMY_V2_ACTIVATION_VERSION,
    operationId: id,
    fromVersion: Math.max(1, Math.floor(toNumber(data?.meta?.economyVersion, 1))),
    toVersion: RESOURCE_ECONOMY_VERSION,
    activatedAt: now ? String(now) : null,
    sourceHash,
    targetHash: "",
    activatedRevision: baseRevision + 1
  };
  target.meta.economyActivation.targetHash = economyV2ActivationSourceHash(target);
  return {
    operationId: id,
    baseRevision,
    sourceHash,
    targetHash: target.meta.economyActivation.targetHash,
    before: activationSummary(data),
    after: activationSummary(target),
    changes,
    buildingRecipeChanges,
    blockers,
    canApply: blockers.length === 0,
    target
  };
}

export function applyEconomyV2Activation({ data, plan } = {}) {
  if (!data || typeof data !== "object" || !plan?.target) throw new TypeError("FBL Skyhold | Economy V2 activation plan is required.");
  const currentActivation = data?.meta?.economyActivation;
  if (Math.floor(toNumber(data?.meta?.economyVersion, 1)) > RESOURCE_ECONOMY_VERSION
    || Math.floor(toNumber(currentActivation?.version, 0)) > ECONOMY_V2_ACTIVATION_VERSION) {
    return { ok: false, future: true, message: "Активация остановлена: мир сохранён более новой версией экономики." };
  }
  if (Math.floor(toNumber(data?.meta?.economyVersion, 1)) >= RESOURCE_ECONOMY_VERSION
    && Math.floor(toNumber(currentActivation?.version, 0)) >= ECONOMY_V2_ACTIVATION_VERSION
    && String(currentActivation?.operationId ?? "") === String(plan.operationId ?? "")) {
    return { ok: true, replay: true, changed: false, data };
  }
  if (plan.canApply !== true || (plan.blockers ?? []).length) return { ok: false, blockers: clone(plan.blockers ?? []), message: "Активация заблокирована нерешёнными ресурсами." };
  const preparedTargetHash = economyV2ActivationSourceHash(plan.target);
  const targetActivation = plan.target?.meta?.economyActivation;
  if (preparedTargetHash !== String(plan.targetHash ?? "")
    || String(targetActivation?.targetHash ?? "") !== preparedTargetHash
    || String(targetActivation?.sourceHash ?? "") !== String(plan.sourceHash ?? "")
    || String(targetActivation?.operationId ?? "") !== String(plan.operationId ?? "")) {
    return { ok: false, invalid: true, message: "Предпросмотр Economy V2 повреждён или был изменён." };
  }
  const currentRevision = Math.max(0, Math.floor(toNumber(data?.meta?.revision, 0)));
  if (currentRevision !== Math.max(0, Math.floor(toNumber(plan.baseRevision, 0))) || economyV2ActivationSourceHash(data) !== String(plan.sourceHash ?? "")) {
    return { ok: false, stale: true, message: "Данные изменились после предпросмотра Economy V2." };
  }
  const target = clone(plan.target);
  for (const key of Object.keys(data)) delete data[key];
  Object.assign(data, target);
  return { ok: true, replay: false, changed: true, data };
}
