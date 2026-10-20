import { DEFAULT_EXTERNAL_MARKET } from "./default-market.js";
import { clone, toBoolean, toNumber } from "../utils.js";

const MARKET_KINDS = new Set(["material", "resource", "consumable"]);
const MARKET_VISIBILITY = new Set(["public", "gm"]);
const MARKET_SOURCE_TYPES = new Set(["resource", "item"]);
const MARKET_DELIVERY_MODES = new Set(["instant", "scheduled"]);
const MARKET_TRANSPORT_MODES = new Set(["caravan", "rail", "airship"]);
const MARKET_UBIQUITY = new Set(["essential", "common", "ordinary", "specialized", "restricted"]);

function boundedNumber(value, fallback, min, max) {
  return Math.min(max, Math.max(min, toNumber(value, fallback)));
}

function optionalBoundedNumber(value, min, max, { integer = false } = {}) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const bounded = Math.min(max, Math.max(min, parsed));
  return integer ? Math.round(bounded) : bounded;
}

function hasValue(source = {}, key = "") {
  return Object.hasOwn(source, key) && source[key] !== undefined && source[key] !== null && source[key] !== "";
}

function splitTags(value = []) {
  const rows = Array.isArray(value) ? value : String(value ?? "").split(/[,;\n]/);
  return [...new Set(rows.map((item) => String(item ?? "").trim()).filter(Boolean))].slice(0, 40);
}

function transportModes(value = []) {
  const rows = Array.isArray(value) ? value : String(value ?? "").split(/[,;|\n]+/);
  const normalized = [...new Set(rows.map((item) => String(item ?? "").trim()).filter((item) => MARKET_TRANSPORT_MODES.has(item)))];
  return normalized.length ? normalized : ["caravan", "rail", "airship"];
}

export function normalizeMarketOffer(row = {}, index = 0) {
  const source = row && typeof row === "object" ? row : {};
  const itemUuid = String(source.itemUuid ?? source.uuid ?? "").trim();
  const sourceType = MARKET_SOURCE_TYPES.has(String(source.sourceType ?? ""))
    ? String(source.sourceType)
    : (itemUuid ? "item" : "resource");
  const resourceId = sourceType === "item" ? "custom" : String(source.resourceId ?? source.resource ?? "custom").trim() || "custom";
  const id = String(source.id ?? "").trim() || `market-offer-${index + 1}`;
  const legacyPrice = hasValue(source, "basePriceCopper")
    ? source.basePriceCopper
    : (hasValue(source, "priceCopper") ? source.priceCopper : null);
  const priceOverrideCopper = optionalBoundedNumber(
    Object.hasOwn(source, "priceOverrideCopper") ? source.priceOverrideCopper : legacyPrice,
    1,
    10_000_000,
    { integer: true }
  ) ?? (sourceType === "item" ? 1 : null);
  const legacyLoad = hasValue(source, "load")
    ? Number(source.load) * 4
    : (hasValue(source, "weight") ? Number(source.weight) * 4 : null);
  const loadOverridePoints = optionalBoundedNumber(
    Object.hasOwn(source, "loadOverridePoints")
      ? source.loadOverridePoints
      : legacyLoad,
    0,
    40_000,
    { integer: true }
  ) ?? (sourceType === "item" ? 4 : null);
  const normalized = {
    id,
    active: toBoolean(source.active, true),
    visibility: MARKET_VISIBILITY.has(String(source.visibility ?? "")) ? String(source.visibility) : "public",
    sourceType,
    resourceId,
    itemUuid: sourceType === "item" ? itemUuid : "",
    name: String(source.name ?? source.label ?? "").trim().slice(0, 300),
    unit: "ед.",
    icon: String(source.icon ?? "").trim().slice(0, 200),
    img: String(source.img ?? source.image ?? "").trim().slice(0, 500),
    kind: MARKET_KINDS.has(String(source.kind ?? "")) ? String(source.kind) : "resource",
    priceFactor: boundedNumber(source.priceFactor, 1, 0.05, 20),
    priceOverrideCopper,
    loadOverridePoints,
    volatility: boundedNumber(source.volatility, 0.2, 0, 0.8),
    baseStock: Math.floor(boundedNumber(source.baseStock ?? source.stock, 1, 0, 1_000_000)),
    baseDemand: Math.floor(boundedNumber(source.baseDemand ?? source.demand ?? source.baseStock ?? source.stock, 1, 0, 1_000_000)),
    origin: String(source.origin ?? "").trim().slice(0, 300),
    priceBasis: String(source.priceBasis ?? "").trim().slice(0, 500),
    historicalSource: String(source.historicalSource ?? source.priceSource ?? "").trim().slice(0, 1200),
    availabilityNotes: String(source.availabilityNotes ?? "").trim().slice(0, 1200),
    accessDifficulty: Math.floor(boundedNumber(source.accessDifficulty ?? source.marketAccessDifficulty, 0, 0, 100)),
    ubiquity: MARKET_UBIQUITY.has(String(source.ubiquity ?? "")) ? String(source.ubiquity) : "common",
    forceAvailable: toBoolean(source.forceAvailable, false),
    tags: splitTags(source.tags)
  };
  // Transitional aliases keep legacy consumers and content packs working while
  // preserving the meaningful difference between "inherit" and an explicit
  // override. New resource offers therefore do not receive silent 1/1 values.
  if (priceOverrideCopper !== null) normalized.basePriceCopper = priceOverrideCopper;
  if (loadOverridePoints !== null) normalized.load = loadOverridePoints / 4;
  return normalized;
}

export function normalizeMarketCatalogRow(row = {}, index = 0) {
  const source = row && typeof row === "object" ? row : {};
  const sourceSchemaVersion = Math.max(1, Math.floor(toNumber(source.schemaVersion, 1)));
  const hasLegacyCapacityDefaults = sourceSchemaVersion < 2
    && Number(source.caravanCapacityLoad) === 80
    && Number(source.railCapacityLoad) === 480
    && Number(source.airshipCapacityLoad) === 200;
  const id = String(source.id ?? "").trim() || `market-${index + 1}`;
  const offers = [];
  const seen = new Set();
  for (const rawOffer of Array.isArray(source.offers) ? source.offers : []) {
    const offer = normalizeMarketOffer(rawOffer, offers.length);
    if (!offer.id || seen.has(offer.id)) continue;
    seen.add(offer.id);
    offers.push(offer);
  }
  return {
    schemaVersion: 2,
    id,
    label: String(source.label ?? source.name ?? id).trim().slice(0, 300) || id,
    active: toBoolean(source.active, true),
    visibility: MARKET_VISIBILITY.has(String(source.visibility ?? "")) ? String(source.visibility) : "public",
    quotePeriodDays: Math.floor(boundedNumber(source.quotePeriodDays ?? source.refreshPeriodDays, 10, 1, 365)),
    deliveryMode: MARKET_DELIVERY_MODES.has(String(source.deliveryMode ?? "")) ? String(source.deliveryMode) : "instant",
    baseDeliveryQd: Math.floor(boundedNumber(source.baseDeliveryQd ?? source.deliveryQd, 8, 1, 1460)),
    regionId: String(source.regionId ?? source.originRegionId ?? "").trim().slice(0, 160),
    accessLevelOverride: Math.floor(boundedNumber(source.accessLevelOverride, 0, 0, 4)),
    transportModes: transportModes(source.transportModes),
    deliveryDistanceCopper: boundedNumber(source.deliveryDistanceCopper, 0, 0, 1_000_000),
    deliveryLoadDistanceCopper: boundedNumber(source.deliveryLoadDistanceCopper, 0, 0, 1_000_000),
    airshipHireCopper: boundedNumber(source.airshipHireCopper, 120, 0, 10_000_000),
    caravanCapacityLoad: hasLegacyCapacityDefaults ? 400 : boundedNumber(source.caravanCapacityLoad, 400, 1, 1_000_000),
    railCapacityLoad: hasLegacyCapacityDefaults ? 8000 : boundedNumber(source.railCapacityLoad, 8000, 1, 1_000_000),
    airshipCapacityLoad: hasLegacyCapacityDefaults ? 4000 : boundedNumber(source.airshipCapacityLoad, 4000, 1, 1_000_000),
    origin: String(source.origin ?? "").trim().slice(0, 300),
    description: String(source.description ?? "").trim().slice(0, 4000),
    tags: splitTags(source.tags),
    locationProfiles: Array.isArray(source.locationProfiles) ? clone(source.locationProfiles) : [],
    offers,
    contentVersion: Math.max(1, Math.floor(toNumber(source.contentVersion ?? source.version, 1))),
    contentSource: String(source.contentSource ?? source.source ?? "").trim().slice(0, 300)
  };
}

export function normalizeMarketCatalog(rows = []) {
  const result = [];
  const seen = new Set();
  for (const rawRow of Array.isArray(rows) ? rows : []) {
    const row = normalizeMarketCatalogRow(rawRow, result.length);
    if (!row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    result.push(row);
  }
  return result.slice(0, 100);
}

function mergeMarket(base, override) {
  const offerMap = new Map((base.offers ?? []).map((offer) => [offer.id, { ...offer, isBuiltinOffer: true }]));
  for (const offer of override.offers ?? []) {
    const previous = offerMap.get(offer.id);
    offerMap.set(offer.id, { ...(previous ?? {}), ...offer, isBuiltinOffer: Boolean(previous?.isBuiltinOffer) });
  }
  return {
    ...base,
    ...override,
    locationProfiles: override.locationProfiles?.length ? clone(override.locationProfiles) : clone(base.locationProfiles ?? []),
    offers: Array.from(offerMap.values()),
    isBuiltin: true,
    isOverride: true
  };
}

export function effectiveMarketCatalog(rows = []) {
  const fallback = { ...normalizeMarketCatalogRow(DEFAULT_EXTERNAL_MARKET), isBuiltin: true, isOverride: false };
  fallback.offers = fallback.offers.map((offer) => ({ ...offer, isBuiltinOffer: true }));
  const overrides = normalizeMarketCatalog(rows);
  const result = [];
  const fallbackOverride = overrides.find((row) => row.id === fallback.id);
  result.push(fallbackOverride ? mergeMarket(fallback, fallbackOverride) : fallback);
  for (const row of overrides) {
    if (row.id === fallback.id) continue;
    result.push({ ...row, isBuiltin: false, isOverride: true, offers: row.offers.map((offer) => ({ ...offer, isBuiltinOffer: false })) });
  }
  return result;
}

export function marketCatalogSummary(rows = []) {
  const markets = effectiveMarketCatalog(rows);
  return {
    marketCount: markets.length,
    activeMarketCount: markets.filter((market) => market.active).length,
    offerCount: markets.reduce((sum, market) => sum + market.offers.filter((offer) => offer.active).length, 0),
    hasOverride: normalizeMarketCatalog(rows).some((market) => market.id === DEFAULT_EXTERNAL_MARKET.id)
  };
}
