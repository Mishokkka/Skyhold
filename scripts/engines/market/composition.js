import { normalizeEventRegionOptions } from "../../data/random-events.js";
import { normalizeMarketEconomy } from "../../data/market/economy.js";
import { resolveMarketOfferEconomics } from "./pricing.js";

const UBIQUITY_RANK = Object.freeze({ essential: 1, common: 2, ordinary: 3, specialized: 4, restricted: 5 });
const NON_MATERIALIZING_TAGS = new Set(["all", "import", "export", "bulk", "resource", "material", "consumable", "edible", "food", "food.raw", "food.processed", "organic", "mineral", "metal", "construction", "textile", "hide", "fuel", "liquid", "medicinal", "medicine", "chemical", "luxury"]);

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function factor(value, fallback = 1) {
  if (value === null || value === undefined || value === "") return fallback;
  return Math.max(0, finite(value, fallback));
}

function normalized(value = "") {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("ru");
}

function tagMatches(candidate = "", selector = "") {
  const tag = normalized(candidate);
  const target = normalized(selector);
  if (!tag || !target) return false;
  if (target === "all") return true;
  return tag === target || tag.startsWith(`${target}.`) || tag.startsWith(`${target}-`);
}

function materializationTagMatches(candidate = "", selector = "") {
  const tag = normalized(candidate);
  const target = normalized(selector);
  if (!tag || !target || target === "all") return false;
  return tag === target || tag.startsWith(`${target}.`) || tag.startsWith(`${target}-`);
}

export function marketOfferTags(offer = {}, resource = {}) {
  const categoryTags = String(resource.categoryTag ?? "").trim()
    ? [resource.categoryTag]
    : (resource.materialGroups ?? []);
  return [...new Set([
    "all",
    String(offer.kind ?? ""),
    String(offer.resourceId ?? ""),
    String(resource.id ?? ""),
    String(resource.category ?? ""),
    ...(offer.tags ?? []),
    ...categoryTags,
    ...(resource.marketTags ?? [])
  ].map(normalized).filter(Boolean))];
}

function ruleMatches(rule = {}, offer = {}, tags = []) {
  if (rule.active === false) return false;
  const resourceIds = (rule.resourceIds ?? []).map(normalized);
  if (resourceIds.length && resourceIds.includes(normalized(offer.resourceId))) return true;
  const selectors = rule.targetTags ?? [];
  if (!selectors.length && !resourceIds.length) return true;
  return selectors.some((selector) => tags.some((tag) => tagMatches(tag, selector)));
}

function applyRules(offer = {}, resource = {}, sources = [], { direction = "inbound" } = {}) {
  const tags = marketOfferTags(offer, resource);
  let stockFactor = 1;
  let priceFactor = 1;
  let volatilityFactor = 1;
  const breakdown = [];
  let restricted = false;
  for (const source of sources) {
    for (const rule of source.rules ?? []) {
      if (!ruleMatches(rule, offer, tags)) continue;
      const stock = factor(rule.stockFactor, 1);
      const price = factor(rule.priceFactor, 1);
      const volatility = factor(rule.volatilityFactor, 1);
      const quantity = direction === "outbound" && ["produce", "consume"].includes(String(rule.mode ?? ""))
        ? 1 / Math.max(0.05, stock)
        : stock;
      stockFactor *= quantity;
      priceFactor *= price;
      volatilityFactor *= volatility;
      restricted ||= rule.mode === "restrict";
      breakdown.push({
        sourceId: String(source.id ?? ""),
        sourceLabel: String(source.label ?? source.id ?? "Модификатор"),
        ruleId: String(rule.id ?? ""),
        ruleLabel: String(rule.label ?? rule.id ?? "Правило"),
        mode: String(rule.mode ?? "adjust"),
        stockFactor: quantity,
        priceFactor: price,
        volatilityFactor: volatility
      });
    }
  }
  return { tags, stockFactor, priceFactor, volatilityFactor, breakdown, restricted };
}

function conditionById(economy = {}, id = "") {
  return economy.conditions.find((row) => row.active !== false && row.id === String(id ?? "")) ?? null;
}

function combinedConditions(location = {}, country = {}, economy = {}) {
  const countryCondition = conditionById(economy, country?.conditionId) ?? conditionById(economy, "stable") ?? {};
  const locationCondition = location?.marketConditionId && location.marketConditionId !== countryCondition.id
    ? conditionById(economy, location.marketConditionId)
    : null;
  return [countryCondition, locationCondition].filter(Boolean);
}

function marketCountryFromEconomy(location = {}, economy = {}) {
  const countryId = String(location?.countryId ?? location?.marketCountryId ?? location?.value ?? "");
  return economy?.countries?.find((row) => row.id === countryId) ?? null;
}

export function marketCountryForLocation(location = {}, economySource = null, locations = []) {
  const economy = normalizeMarketEconomy(economySource, { locations });
  return marketCountryFromEconomy(location, economy);
}

export function marketLocationFactors(location = {}, economySource = null, locations = [], { normalizedEconomy = false } = {}) {
  const economy = normalizedEconomy ? economySource : normalizeMarketEconomy(economySource, { locations });
  const country = marketCountryFromEconomy(location, economy) ?? {
    id: String(location?.countryId ?? location?.value ?? ""),
    label: String(location?.label ?? "Неизвестное государство"),
    active: true,
    priceFactor: 1,
    stockFactor: 1,
    deliveryFactor: 1,
    timeFactor: 1,
    riskFactor: 1,
    taxRate: 0,
    conditionId: "stable"
  };
  const conditions = combinedConditions(location, country, economy);
  const conditionFactor = (key) => conditions.reduce((value, row) => value * factor(row?.[key], 1), 1);
  const legacyStatus = String(location?.marketStatus ?? "stable");
  const legacyCondition = !location?.marketConditionId && legacyStatus !== "stable" && legacyStatus !== country.conditionId
    ? conditionById(economy, legacyStatus)
    : null;
  const legacyFactor = (key) => factor(legacyCondition?.[key], 1);
  return {
    status: String(location?.marketConditionId || country.conditionId || legacyStatus || "stable"),
    enabled: country.active !== false && location?.marketEnabled !== false,
    price: factor(country.priceFactor, 1) * conditionFactor("priceFactor") * legacyFactor("priceFactor") * factor(location?.marketPriceFactor, 1),
    availability: factor(country.stockFactor, 1) * conditionFactor("stockFactor") * legacyFactor("stockFactor") * factor(location?.marketAvailabilityFactor, 1),
    delivery: factor(country.deliveryFactor, 1) * conditionFactor("deliveryFactor") * legacyFactor("deliveryFactor") * factor(location?.marketDeliveryFactor, 1),
    time: factor(country.timeFactor, 1) * conditionFactor("timeFactor") * legacyFactor("timeFactor") * factor(location?.marketTimeFactor, 1),
    risk: factor(country.riskFactor, 1) * conditionFactor("riskFactor") * legacyFactor("riskFactor") * factor(location?.marketRiskFactor, 1),
    volatility: conditionFactor("volatilityFactor") * legacyFactor("volatilityFactor"),
    export: factor(location?.marketExportFactor, 1),
    import: factor(location?.marketImportFactor, 1),
    taxRate: Math.max(0, Math.min(1, finite(country.taxRate, 0) + finite(location?.marketTaxRate, 0))),
    exportTaxRate: Math.max(0, Math.min(1, finite(country.exportTaxRate, 0))),
    countryId: country.id,
    countryLabel: country.label,
    countryConditionId: country.conditionId,
    locationConditionId: String(location?.marketConditionId ?? "")
  };
}

function mergeOfferRows(rows = []) {
  const result = new Map();
  for (const source of rows) {
    for (const offer of source.offers ?? []) {
      const id = String(offer?.id ?? "");
      if (!id) continue;
      const resourceId = String(offer?.resourceId ?? "");
      const key = offer?.sourceType === "item"
        ? `item:${String(offer?.itemUuid ?? id)}`
        : (resourceId && resourceId !== "custom" ? `resource:${resourceId}` : `offer:${id}`);
      const previous = result.get(key);
      result.set(key, previous ? { ...previous, ...offer, tags: [...new Set([...(previous.tags ?? []), ...(offer.tags ?? [])])] } : { ...offer });
    }
  }
  return [...result.values()];
}

function materializedOffers(source = {}, resources = []) {
  const selectors = [...new Set((source.rules ?? [])
    .filter((rule) => rule.active !== false && rule.mode === "produce")
    .flatMap((rule) => [...(rule.targetTags ?? []), ...(rule.resourceIds ?? [])])
    .map(normalized)
    .filter((tag) => tag && !NON_MATERIALIZING_TAGS.has(tag)))];
  if (!selectors.length) return [];
  const explicitIds = new Set((source.offers ?? []).map((offer) => String(offer?.resourceId ?? "")).filter((id) => id && id !== "custom"));
  const output = [];
  for (const resource of resources ?? []) {
    const resourceId = String(resource?.id ?? "");
    if (!resourceId || resourceId === "money" || resource.hidden || resource.isMoney || explicitIds.has(resourceId)) continue;
    const tags = marketOfferTags({ resourceId, kind: "material", tags: resource.marketTags ?? [] }, resource);
    if (!selectors.some((selector) => tags.some((tag) => materializationTagMatches(tag, selector)))) continue;
    const groups = new Set(resource.materialGroups ?? []);
    const kind = groups.has("edible") || groups.has("medicinal") ? "consumable" : (groups.has("fuel") || groups.has("mineral") ? "resource" : "material");
    output.push({
      id: `generated-${String(source.id ?? "market").replace(/[^a-z0-9-]+/gi, "-")}-${resourceId}`,
      active: true,
      visibility: "public",
      sourceType: "resource",
      resourceId,
      name: String(resource.label ?? resourceId),
      unit: "ед.",
      icon: String(resource.icon ?? "fa-solid fa-box"),
      img: String(resource.img ?? ""),
      kind,
      baseStock: 36,
      volatility: 0.28,
      priceFactor: 1,
      accessDifficulty: Math.max(0, Math.floor(finite(resource.marketAccessDifficulty, 0))),
      ubiquity: "specialized",
      forceAvailable: true,
      tags
    });
  }
  return output;
}

function sourceRows(country = {}, specialties = [], resources = []) {
  const row = (id, label, source) => ({ id, label, rules: source.rules ?? [], offers: [...materializedOffers({ ...source, id }, resources), ...(source.offers ?? [])] });
  return [
    row(`country:${country.id}`, country.label, country),
    ...specialties.map((specialty) => row(`specialty:${specialty.id}`, specialty.label, specialty))
  ];
}

export function composeMarketLocation({ location = {}, economy: economySource = null, resources = [], locations = [], normalizedEconomy = false, includeOffers = true } = {}) {
  const economy = normalizedEconomy ? economySource : normalizeMarketEconomy(economySource, { locations });
  const country = marketCountryFromEconomy(location, economy);
  if (!country || country.active === false || location?.marketEnabled === false) return null;
  const size = economy.sizeProfiles.find((row) => row.active !== false && row.id === String(location?.marketSizeId ?? ""))
    ?? economy.sizeProfiles.find((row) => row.id === "town")
    ?? { id: "town", label: "Городской рынок", maxUbiquity: "ordinary", stockFactor: 1, priceFactor: 1, handlingFactor: 1 };
  const specialtyIds = new Set(location?.marketSpecialtyIds ?? []);
  const specialties = economy.specialties.filter((row) => row.active !== false && specialtyIds.has(row.id));
  const sources = includeOffers ? sourceRows(country, specialties, resources) : [];
  const resourcesById = includeOffers ? new Map((resources ?? []).map((row) => [String(row.id ?? ""), row])) : new Map();
  const mergedOffers = includeOffers ? mergeOfferRows([{ offers: economy.baseOffers }, ...sources]) : [];
  const offers = mergedOffers.map((offer) => {
    const resource = resourcesById.get(String(offer.resourceId ?? "")) ?? {};
    const effectiveOffer = resolveMarketOfferEconomics(offer, resource);
    const applied = applyRules(effectiveOffer, resource, sources);
    const maxRank = UBIQUITY_RANK[size.maxUbiquity] ?? UBIQUITY_RANK.ordinary;
    const offerRank = UBIQUITY_RANK[offer.ubiquity] ?? UBIQUITY_RANK.common;
    const forceAvailable = offer.forceAvailable || !economy.baseOffers.some((row) => row.id === offer.id);
    if (!forceAvailable && offerRank > maxRank) return null;
    if (applied.restricted && !forceAvailable) return null;
    const baseStock = Math.max(0, Math.floor(finite(offer.baseStock, 0) * factor(size.stockFactor, 1) * applied.stockFactor));
    if (baseStock <= 0 && !forceAvailable) return null;
    return {
      ...effectiveOffer,
      accessDifficulty: Math.max(0, Math.floor(finite(effectiveOffer.accessDifficulty, 0)), Math.floor(finite(resource.marketAccessDifficulty, 0))),
      basePriceCopper: Math.max(1, Math.round(finite(effectiveOffer.basePriceCopper, 1) * factor(size.priceFactor, 1) * applied.priceFactor)),
      baseStock,
      volatility: Math.max(0, Math.min(0.8, finite(offer.volatility, 0.2) * applied.volatilityFactor)),
      tags: applied.tags,
      composition: applied.breakdown,
      compositionSource: forceAvailable ? "specialty" : "base"
    };
  }).filter(Boolean);
  const outboundOffers = mergedOffers.map((offer) => {
    if (offer.sourceType === "item") return null;
    const resource = resourcesById.get(String(offer.resourceId ?? "")) ?? {};
    const effectiveOffer = resolveMarketOfferEconomics(offer, resource);
    const applied = applyRules(effectiveOffer, resource, sources, { direction: "outbound" });
    const maxRank = UBIQUITY_RANK[size.maxUbiquity] ?? UBIQUITY_RANK.ordinary;
    const offerRank = UBIQUITY_RANK[offer.ubiquity] ?? UBIQUITY_RANK.common;
    const forceAvailable = offer.forceAvailable || !economy.baseOffers.some((row) => row.id === offer.id);
    if (!forceAvailable && offerRank > maxRank) return null;
    if (applied.restricted && !forceAvailable) return null;
    const baseDemand = Math.max(0, Math.floor(finite(offer.baseDemand, finite(offer.baseStock, 0)) * factor(size.stockFactor, 1) * applied.stockFactor));
    if (baseDemand <= 0 && !forceAvailable) return null;
    return {
      ...effectiveOffer,
      accessDifficulty: Math.max(0, Math.floor(finite(effectiveOffer.accessDifficulty, 0)), Math.floor(finite(resource.marketAccessDifficulty, 0))),
      basePriceCopper: Math.max(1, Math.round(finite(effectiveOffer.basePriceCopper, 1) * factor(size.priceFactor, 1) * applied.priceFactor)),
      baseDemand,
      volatility: Math.max(0, Math.min(0.8, finite(offer.volatility, 0.2) * applied.volatilityFactor)),
      tags: applied.tags,
      composition: applied.breakdown,
      compositionSource: forceAvailable ? "specialty" : "base"
    };
  }).filter(Boolean);
  const settings = economy.settings;
  return {
    id: String(location.value ?? ""),
    label: String(location.label ?? location.value ?? "Рынок"),
    active: true,
    visibility: country.visibility ?? "public",
    regionId: String(location.value ?? ""),
    countryId: country.id,
    countryLabel: country.label,
    origin: country.label,
    description: String(location.marketNotes ?? country.description ?? ""),
    quotePeriodDays: settings.quotePeriodDays,
    deliveryMode: settings.deliveryMode,
    baseDeliveryQd: settings.baseDeliveryQd,
    accessLevelOverride: 0,
    transportModes: Array.isArray(location.marketTransportModes) ? location.marketTransportModes : ["caravan", "airship"],
    deliveryDistanceCopper: settings.deliveryDistanceCopper,
    deliveryLoadDistanceCopper: settings.deliveryLoadDistanceCopper,
    airshipHireCopper: settings.airshipHireCopper,
    caravanCapacityLoad: settings.caravanCapacityLoad,
    railCapacityLoad: settings.railCapacityLoad,
    airshipCapacityLoad: settings.airshipCapacityLoad,
    sizeProfileId: size.id,
    sizeLabel: size.label,
    specialtyIds: [...specialtyIds],
    specialtyLabels: specialties.map((row) => row.label),
    conditionLabel: combinedConditions(location, country, economy).map((row) => row.label).join(" · "),
    locationProfile: {
      id: `market-location:${String(location.value ?? "")}`,
      label: `${size.label} · ${country.label}`,
      priceFactor: 1,
      availabilityFactor: 1,
      deliveryFlatCopper: settings.handlingFlatCopper * factor(size.handlingFactor, 1),
      deliverySubtotalRate: settings.handlingSubtotalRate,
      deliveryLoadCopper: settings.handlingLoadCopper * factor(size.handlingFactor, 1),
      deliveryQdFactor: 1,
      categoryFactors: {}
    },
    offers,
    outboundOffers
  };
}

export function effectiveMarketLocations({ economy: economySource = null, locations = [], resources = [], isGM = false, normalizedEconomy = false, offerLocationIds = null } = {}) {
  const normalizedLocations = normalizeEventRegionOptions(locations, { fallback: false });
  const economy = normalizedEconomy ? economySource : normalizeMarketEconomy(economySource, { locations: normalizedLocations });
  const included = offerLocationIds === null ? null : new Set(Array.from(offerLocationIds ?? [], String));
  return normalizedLocations.map((location) => composeMarketLocation({
    location,
    economy,
    resources,
    locations: normalizedLocations,
    normalizedEconomy: true,
    includeOffers: included === null || included.has(String(location.value ?? ""))
  }))
    .filter((market) => market && market.active && (isGM || market.visibility !== "gm"));
}
