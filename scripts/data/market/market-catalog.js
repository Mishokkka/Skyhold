import { toBoolean, toNumber } from "../utils.js";

const MARKET_KINDS = new Set(["material", "resource", "consumable"]);
const MARKET_VISIBILITY = new Set(["public", "gm"]);
const MARKET_SOURCE_TYPES = new Set(["resource", "item"]);
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
