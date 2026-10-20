import { economyDayIndex } from "../../core/economy-calendar.js";
import { marketMoneyInRange, MAX_MARKET_OPERATION_COPPER } from "../../data/market/money-limits.js";

const KIND_LABELS = {
  material: "Материалы",
  resource: "Ресурсы",
  consumable: "Расходники"
};

export const MARKET_INSURANCE_COVERAGE_RATE = 0.84;
export const MARKET_EXPRESS_SURCHARGE_RATE = 0.2;
export const MARKET_EXPRESS_ETA_FACTOR = 0.7;
export const MARKET_STANDARD_ETA_FACTOR = 1.25;
export const MARKET_CHARTER_ETA_FACTOR = 0.85;

export const MARKET_DELIVERY_SERVICES = Object.freeze({
  standard: Object.freeze({ id: "standard", label: "Попутный груз", capacityFactor: 0.2, etaFactor: MARKET_STANDARD_ETA_FACTOR, intervalFactor: 0.25, fullFixedFare: false, operatingLegFactor: 1, surchargeRate: 0 }),
  express: Object.freeze({ id: "express", label: "Ускоренная доставка", capacityFactor: 0.1, etaFactor: MARKET_EXPRESS_ETA_FACTOR, intervalFactor: 0.1, fullFixedFare: false, operatingLegFactor: 1, surchargeRate: MARKET_EXPRESS_SURCHARGE_RATE }),
  charter: Object.freeze({ id: "charter", label: "Выделенный рейс", capacityFactor: 1, etaFactor: MARKET_CHARTER_ETA_FACTOR, intervalFactor: 0.1, fullFixedFare: true, operatingLegFactor: 2, surchargeRate: 0 })
});

// Calibrated against late-18th/19th-century sea trade: ordinary freight plus
// peacetime insurance commonly consumed about one fifth of a long-haul cargo's
// value, while premium fast passages were usually 10-25% above normal freight.
export const MARKET_FREIGHT_BASE_RATE = 0.05;
export const MARKET_FREIGHT_MIN_RATE = 0.04;
export const MARKET_FREIGHT_MAX_RATE = 0.22;
export const MARKET_INSURANCE_MAX_RATE = 0.4;

const FREIGHT_TRANSPORT_FACTORS = Object.freeze({
  rail: 0.8,
  caravan: 1,
  airship: 1.15,
  multimodal: 1.1
});

const RISK_TRANSPORT_FACTORS = Object.freeze({
  rail: 0.5,
  caravan: 0.85,
  airship: 1.15,
  multimodal: 1.1
});

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalFinite(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function resolveMarketOfferEconomics(offer = {}, resource = {}) {
  const sourceType = offer.sourceType === "item" ? "item" : "resource";
  const explicitPrice = Object.hasOwn(offer, "priceOverrideCopper")
    ? optionalFinite(offer.priceOverrideCopper)
    : optionalFinite(offer.basePriceCopper);
  const canonicalPrice = sourceType === "item" ? 0 : (optionalFinite(resource.basePriceCopper) ?? 0);
  const priceFactor = Math.max(0, optionalFinite(offer.priceFactor) ?? 1);
  const basePriceCopper = Math.max(1, Math.round((explicitPrice ?? canonicalPrice) * priceFactor));
  const legacyLoad = (optionalFinite(offer.load) === null ? null : optionalFinite(offer.load) * 4)
    ?? (optionalFinite(offer.weight) === null ? null : optionalFinite(offer.weight) * 4);
  const explicitLoadPoints = Object.hasOwn(offer, "loadOverridePoints")
    ? optionalFinite(offer.loadOverridePoints)
    : legacyLoad;
  const canonicalLoadPoints = sourceType === "item"
    ? 4
    : (optionalFinite(resource.loadPoints) ?? (resource.isMoney ? 0 : 4));
  const loadPoints = Math.max(0, Math.round(sourceType === "item" ? (explicitLoadPoints ?? canonicalLoadPoints) : canonicalLoadPoints));
  return {
    ...offer,
    basePriceCopper,
    loadPoints,
    load: loadPoints / 4,
    economicsResolved: true,
    priceSource: explicitPrice === null ? (sourceType === "item" ? "item-default" : "resource") : "offer-override",
    loadSource: sourceType !== "item" ? "resource" : (explicitLoadPoints === null ? "item-default" : "offer-override")
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function marketHistoricalFreightRate(logistics = {}) {
  const distanceKm = Math.max(0, finiteNumber(logistics.distanceKm, 0));
  const accessCost = Math.max(0, finiteNumber(logistics.routeAccessLevel ?? logistics.routeAccessCost, logistics.hops));
  const distancePremium = Math.min(0.04, distanceKm * 0.00004);
  const accessPremium = Math.min(0.04, accessCost * 0.01);
  const transportFactor = FREIGHT_TRANSPORT_FACTORS[String(logistics.transportMode ?? "")] ?? 1;
  const regionalFactor = clamp(finiteNumber(logistics.deliveryFactor, 1), 0.5, 2);
  const carrierFactor = clamp(finiteNumber(logistics.carrierPriceFactor, 1), 0.5, 2);
  return clamp((MARKET_FREIGHT_BASE_RATE + distancePremium + accessPremium) * transportFactor * regionalFactor * carrierFactor, MARKET_FREIGHT_MIN_RATE, MARKET_FREIGHT_MAX_RATE);
}

export function marketHistoricalInsuranceRate({ location = {}, logistics = {} } = {}) {
  const distanceKm = Math.max(0, finiteNumber(logistics.distanceKm, 0));
  const accessCost = Math.max(0, finiteNumber(logistics.routeAccessLevel ?? logistics.routeAccessCost, logistics.hops));
  const historicalBaseRate = 0.01 + Math.min(0.0225, accessCost * 0.0075) + Math.min(0.01, distanceKm * 0.00001);
  const configuredBaseRate = Math.max(0, finiteNumber(location.deliverySubtotalRate, 0));
  const riskFactor = Math.max(0.25, finiteNumber(logistics.riskFactor, 1));
  return clamp(Math.max(configuredBaseRate, historicalBaseRate) * riskFactor, 0.005, MARKET_INSURANCE_MAX_RATE);
}

function marketDeliveryService(serviceLevel = "standard", scheduled = true) {
  if (!scheduled) return MARKET_DELIVERY_SERVICES.standard;
  return MARKET_DELIVERY_SERVICES[String(serviceLevel ?? "")] ?? MARKET_DELIVERY_SERVICES.standard;
}

function appendBatchLine(batch, line, qty) {
  const unitPriceCopper = Math.max(1, Math.floor(finiteNumber(line.unitPriceCopper, 1)));
  const load = Math.max(0, finiteNumber(line.load, 1));
  const copy = { ...line, qty, lineCopper: qty * unitPriceCopper };
  batch.lines.push(copy);
  batch.subtotalCopper += copy.lineCopper;
  batch.totalLoad += qty * load;
}

export function splitMarketShipmentLines(lines = [], capacityLoad = 0) {
  const rows = (Array.isArray(lines) ? lines : []).filter((line) => Math.max(0, Math.floor(finiteNumber(line?.qty, 0))) > 0);
  if (!rows.length) return [];
  const capacity = Math.max(0, finiteNumber(capacityLoad, 0));
  if (!(capacity > 0)) {
    const batch = { lines: [], subtotalCopper: 0, totalLoad: 0 };
    for (const line of rows) appendBatchLine(batch, line, Math.max(0, Math.floor(finiteNumber(line.qty, 0))));
    return [batch];
  }

  const batches = [];
  let batch = { lines: [], subtotalCopper: 0, totalLoad: 0 };
  const flush = () => {
    if (!batch.lines.length) return;
    batches.push(batch);
    batch = { lines: [], subtotalCopper: 0, totalLoad: 0 };
  };
  for (const line of rows) {
    let remaining = Math.max(0, Math.floor(finiteNumber(line.qty, 0)));
    const unitLoad = Math.max(0, finiteNumber(line.load, 1));
    if (!(unitLoad > 0)) {
      appendBatchLine(batch, line, remaining);
      continue;
    }
    while (remaining > 0) {
      const available = Math.max(0, capacity - batch.totalLoad);
      const fits = Math.floor((available + 0.0000001) / unitLoad);
      if (fits <= 0) {
        if (!batch.lines.length) {
          appendBatchLine(batch, line, 1);
          remaining -= 1;
        }
        flush();
        continue;
      }
      const qty = Math.min(remaining, fits);
      appendBatchLine(batch, line, qty);
      remaining -= qty;
      if (batch.totalLoad >= capacity - 0.0000001) flush();
    }
  }
  flush();
  return batches;
}

export function marketSeed(value = "") {
  let hash = 2166136261;
  for (const char of String(value ?? "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function marketRandomUnit(seed = "") {
  let value = marketSeed(seed) || 1;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) / 4294967295;
}

export function marketLocationText(holding = {}) {
  return String(holding?.overview?.region ?? "").trim() || "Регион не указан";
}

export function resolveMarketLocation(holding = {}, profiles = []) {
  const haystack = marketLocationText(holding).toLocaleLowerCase("ru");
  const rows = Array.isArray(profiles) ? profiles : [];
  return rows.find((profile) => (profile.match ?? []).some((token) => haystack.includes(String(token).toLocaleLowerCase("ru"))))
    ?? rows.find((profile) => profile.id === "standard")
    ?? rows[rows.length - 1]
    ?? { id: "standard", label: "Обычный маршрут", priceFactor: 1, availabilityFactor: 1, deliveryFlatCopper: 8, deliverySubtotalRate: 0.02, deliveryLoadCopper: 1, deliveryQdFactor: 1, categoryFactors: {} };
}

export function marketQuotePeriodKey(holding = {}, { now = new Date(), quotePeriodDays = 10 } = {}) {
  const periodDays = Math.max(1, Math.floor(finiteNumber(quotePeriodDays, 10)));
  const gameDay = economyDayIndex(holding);
  if (gameDay !== null) return `game:${Math.floor(gameDay / periodDays)}:${periodDays}`;
  const calendaria = String(holding?.gm?.calendaria?.lastDateKey ?? holding?.gm?.calendaria?.lastDateText ?? "").trim();
  if (calendaria) return `calendaria:${calendaria}`;
  const period = String(holding?.overview?.period ?? "").trim();
  if (period) return `holding:${period}`;
  const day = Math.floor(new Date(now).getTime() / 86400000);
  return `utc:${Math.floor(day / Math.max(1, Math.floor(finiteNumber(quotePeriodDays, 10))))}`;
}

function quoteOffer(offer, { location, quoteKey, resource, logistics = {} } = {}) {
  const volatility = clamp(finiteNumber(offer.volatility, 0.2), 0, 0.8);
  const movement = 1 + ((marketRandomUnit(`${quoteKey}|${location.id}|${offer.id}|price`) * 2) - 1) * volatility;
  const categoryFactor = finiteNumber(location?.categoryFactors?.[offer.kind], 1);
  const unitPriceCopper = Math.max(1, Math.round(finiteNumber(offer.basePriceCopper, 1) * finiteNumber(location.priceFactor, 1) * finiteNumber(logistics.priceFactor, 1) * categoryFactor * movement));
  const stockMovement = 0.65 + marketRandomUnit(`${quoteKey}|${location.id}|${offer.id}|stock`) * 0.7;
  const stock = Math.max(0, Math.floor(finiteNumber(offer.baseStock, 0) * finiteNumber(location.availabilityFactor, 1) * finiteNumber(logistics.stockFactor, 1) * stockMovement));
  return {
    ...offer,
    configuredName: String(offer.name ?? "").trim(),
    configuredImg: String(offer.img ?? "").trim(),
    name: String(offer.name ?? "").trim() || String(resource?.label ?? offer.resourceId ?? "Товар"),
    unit: "ед.",
    icon: String(offer.icon ?? "").trim() || String(resource?.icon ?? "fa-solid fa-box"),
    img: String(offer.img ?? "").trim() || String(resource?.img ?? ""),
    kindLabel: KIND_LABELS[offer.kind] ?? "Товары",
    unitPriceCopper,
    stock,
    movementPercent: Math.round((movement - 1) * 100),
    movementClass: movement > 1.015 ? "up" : (movement < 0.985 ? "down" : "stable")
  };
}

function quoteOutboundOffer(offer, { location, quoteKey, resource, logistics = {}, inboundPriceCopper = 0 } = {}) {
  const volatility = clamp(finiteNumber(offer.volatility, 0.2), 0, 0.8);
  const movement = 1 + ((marketRandomUnit(`${quoteKey}|${location.id}|${offer.id}|outbound-price`) * 2) - 1) * volatility;
  const categoryFactor = finiteNumber(location?.categoryFactors?.[offer.kind], 1);
  const directionalPriceFactor = finiteNumber(logistics.outboundPriceFactor, finiteNumber(logistics.priceFactor, 1));
  let unitPriceCopper = Math.max(1, Math.round(finiteNumber(offer.basePriceCopper, 1) * finiteNumber(location.priceFactor, 1) * directionalPriceFactor * categoryFactor * movement));
  if (logistics.sameRegion && finiteNumber(inboundPriceCopper, 0) > 0) unitPriceCopper = Math.min(unitPriceCopper, Math.floor(finiteNumber(inboundPriceCopper, 1)));
  const demandMovement = 0.65 + marketRandomUnit(`${quoteKey}|${location.id}|${offer.id}|outbound-demand`) * 0.7;
  const demand = Math.max(0, Math.floor(finiteNumber(offer.baseDemand, 0) * finiteNumber(location.demandFactor, 1) * finiteNumber(logistics.demandFactor, 1) * demandMovement));
  return {
    ...offer,
    configuredName: String(offer.name ?? "").trim(),
    configuredImg: String(offer.img ?? "").trim(),
    name: String(offer.name ?? "").trim() || String(resource?.label ?? offer.resourceId ?? "Товар"),
    unit: "ед.",
    icon: String(offer.icon ?? "").trim() || String(resource?.icon ?? "fa-solid fa-box"),
    img: String(offer.img ?? "").trim() || String(resource?.img ?? ""),
    kindLabel: KIND_LABELS[offer.kind] ?? "Товары",
    unitPriceCopper,
    demand,
    movementPercent: Math.round((movement - 1) * 100),
    movementClass: movement > 1.015 ? "up" : (movement < 0.985 ? "down" : "stable")
  };
}

export function prepareMarketQuote({ holding = {}, market = {}, resources = [], location: locationOverride = null, logistics = null } = {}) {
  const location = locationOverride ?? resolveMarketLocation(holding, market.locationProfiles);
  const quoteKey = marketQuotePeriodKey(holding, { quotePeriodDays: market.quotePeriodDays });
  const marketQuoteKey = `${quoteKey}|market:${String(market.id ?? "external-market")}`;
  const resourceById = new Map((resources ?? []).map((row) => [String(row.id ?? row.resourceId ?? ""), row]));
  const routeAccessCost = Math.max(0, Math.floor(finiteNumber(logistics?.routeAccessLevel ?? logistics?.routeAccessCost, finiteNumber(logistics?.hops, 0))));
  const accessLevel = Math.max(0, Math.floor(finiteNumber(logistics?.accessLevel, 0)));
  const enforceAccess = Boolean(logistics && Object.hasOwn(logistics, "accessLevel"));
  const activeOffers = (market.offers ?? []).filter((offer) => offer?.active !== false);
  const accessibleOffers = activeOffers.map((offer) => {
    const resource = resourceById.get(String(offer.resourceId ?? ""));
    const effectiveOffer = offer.economicsResolved ? offer : resolveMarketOfferEconomics(offer, resource ?? {});
    const accessDifficulty = Math.max(0, Math.floor(finiteNumber(effectiveOffer.accessDifficulty, 0)), Math.floor(finiteNumber(resource?.marketAccessDifficulty, 0)));
    const requiredUrs = routeAccessCost + accessDifficulty;
    return { offer: { ...effectiveOffer, accessDifficulty, requiredUrs }, resource, requiredUrs };
  }).filter((row) => !enforceAccess || row.requiredUrs <= accessLevel);
  const offers = accessibleOffers.map(({ offer, resource }) => quoteOffer(offer, {
    holding,
    location,
    quoteKey: marketQuoteKey,
    resource,
    logistics: logistics ?? {}
  }));
  const deliveryMode = String(market.deliveryMode ?? "instant") === "scheduled" ? "scheduled" : "instant";
  const deliveryBaseQd = finiteNumber(market.baseDeliveryQd, 2) * Math.max(0.1, finiteNumber(location.deliveryQdFactor, 1));
  const deliveryQd = deliveryMode === "scheduled"
    ? Math.max(1, Math.ceil(deliveryBaseQd + Math.max(0, finiteNumber(logistics?.travelQd, 0))))
    : 0;
  return { marketId: String(market.id ?? "external-market"), marketLabel: String(market.label ?? "Внешний рынок"), quoteKey, location, locationText: marketLocationText(holding), deliveryMode, deliveryBaseQd, deliveryQd, logistics: logistics ?? null, offers, hiddenOfferCount: Math.max(0, activeOffers.length - accessibleOffers.length) };
}

export function prepareMarketOutboundQuote({ holding = {}, market = {}, resources = [], location: locationOverride = null, logistics = null, inboundOffers = [] } = {}) {
  const location = locationOverride ?? resolveMarketLocation(holding, market.locationProfiles);
  const quoteKey = marketQuotePeriodKey(holding, { quotePeriodDays: market.quotePeriodDays });
  const marketQuoteKey = `${quoteKey}|market:${String(market.id ?? "external-market")}`;
  const resourceById = new Map((resources ?? []).map((row) => [String(row.id ?? row.resourceId ?? ""), row]));
  const inboundPriceByResource = new Map();
  for (const offer of inboundOffers ?? []) {
    const resourceId = String(offer?.resourceId ?? "");
    const price = Math.max(0, Math.floor(finiteNumber(offer?.unitPriceCopper, 0)));
    if (!resourceId || !price) continue;
    const current = inboundPriceByResource.get(resourceId);
    if (!current || price < current) inboundPriceByResource.set(resourceId, price);
  }
  const routeAccessCost = Math.max(0, Math.floor(finiteNumber(logistics?.routeAccessLevel ?? logistics?.routeAccessCost, finiteNumber(logistics?.hops, 0))));
  const accessLevel = Math.max(0, Math.floor(finiteNumber(logistics?.accessLevel, 0)));
  const enforceAccess = Boolean(logistics && Object.hasOwn(logistics, "accessLevel"));
  const activeOffers = (market.outboundOffers ?? []).filter((offer) => offer?.active !== false && offer?.sourceType !== "item");
  const accessibleOffers = activeOffers.map((offer) => {
    const resource = resourceById.get(String(offer.resourceId ?? ""));
    const effectiveOffer = offer.economicsResolved ? offer : resolveMarketOfferEconomics(offer, resource ?? {});
    const accessDifficulty = Math.max(0, Math.floor(finiteNumber(effectiveOffer.accessDifficulty, 0)), Math.floor(finiteNumber(resource?.marketAccessDifficulty, 0)));
    const requiredUrs = routeAccessCost + accessDifficulty;
    return { offer: { ...effectiveOffer, accessDifficulty, requiredUrs }, resource, requiredUrs };
  }).filter((row) => !enforceAccess || row.requiredUrs <= accessLevel);
  const offers = accessibleOffers.map(({ offer, resource }) => quoteOutboundOffer(offer, {
    holding,
    location,
    quoteKey: marketQuoteKey,
    resource,
    logistics: logistics ?? {},
    inboundPriceCopper: inboundPriceByResource.get(String(offer.resourceId ?? "")) ?? 0
  }));
  return {
    marketId: String(market.id ?? "external-market"),
    marketLabel: String(market.label ?? "Внешний рынок"),
    quoteKey,
    location,
    locationText: marketLocationText(holding),
    logistics: logistics ?? null,
    offers,
    hiddenOfferCount: Math.max(0, activeOffers.length - accessibleOffers.length)
  };
}

export function marketShipmentRiskProfile({ logistics = {}, deliveryQd = 0, subtotalCopper = 0, insuranceCopper = 0 } = {}) {
  const distanceKm = Math.max(0, finiteNumber(logistics.distanceKm, 0));
  const distanceUnits = Math.max(0.5, distanceKm / 40);
  const exposure = Math.sqrt(distanceUnits);
  const riskFactor = clamp(finiteNumber(logistics.riskFactor, 1), 0.25, 4);
  const transportMode = String(logistics.transportMode ?? "");
  const transportFactor = RISK_TRANSPORT_FACTORS[transportMode] ?? 0.85;
  const lossChance = clamp(0.003 * exposure * riskFactor * transportFactor, 0.001, 0.08);
  const delayChance = clamp(0.04 + 0.025 * exposure * riskFactor * transportFactor, 0.04, 0.45);
  const maxDelayQd = Math.max(1, Math.min(20, Math.ceil(Math.max(1, finiteNumber(deliveryQd, 1)) * 0.25 * riskFactor)));
  const insuranceCoverageRate = insuranceCopper > 0 ? MARKET_INSURANCE_COVERAGE_RATE : 0;
  const insuredValueCopper = Math.max(0, Math.floor(finiteNumber(subtotalCopper, 0)));
  return {
    riskFactor,
    lossChance,
    delayChance,
    maxDelayQd,
    insuranceCoverageRate,
    insuredValueCopper,
    maximumInsurancePayoutCopper: Math.floor(insuredValueCopper * insuranceCoverageRate)
  };
}

export function planMarketPurchase({ holding = {}, quote = {}, quantities = {}, targetRoomId = "outdoors", serviceLevel = "standard", transportOnly = false } = {}) {
  if (quote.logistics?.ok !== false && quote.logistics?.routeCandidates?.length) {
    const selected = (quote.offers ?? []).filter((offer) => Number(quantities?.[offer.id]) > 0);
    const difficulty = Math.max(0, ...selected.map((offer) => finiteNumber(offer.accessDifficulty, 0)));
    const reference = quote.logistics.routeCandidates.find((route) => route.routePath.join("|") === quote.logistics.routePath.join("|")
      && route.routeModes.join("|") === quote.logistics.routeModes.join("|"));
    const capacityOverride = reference && quote.logistics.capacityLoad !== reference.capacityLoad ? quote.logistics.capacityLoad : null;
    const plans = quote.logistics.routeCandidates.filter((route) => route.ok !== false
      && route.routeAccessCost + difficulty <= route.accessLevel).map((candidate) => {
      const route = capacityOverride === null ? candidate : { ...candidate, capacityLoad: Math.min(candidate.capacityLoad, capacityOverride) };
      return planMarketPurchase({
        holding, quantities, targetRoomId, serviceLevel, transportOnly, quote: { ...quote, logistics: route,
          deliveryQd: quote.deliveryMode === "scheduled" ? Math.max(1, Math.ceil(finiteNumber(quote.deliveryBaseQd, 0) + route.travelQd)) : 0 }
      });
    }).filter((plan) => !plan.capacityExceeded && !plan.amountExceeded);
    plans.sort((a, b) => a.totalCopper - b.totalCopper || a.deliveryQd - b.deliveryQd
      || a.logistics.routePath.join("|").localeCompare(b.logistics.routePath.join("|")));
    if (plans.length) return plans[0];
    const { routeCandidates: _routes, ...fallback } = quote.logistics;
    return planMarketPurchase({ holding, quantities, targetRoomId, serviceLevel, transportOnly, quote: { ...quote, logistics: fallback } });
  }
  const lines = [];
  let subtotalCopper = 0;
  let totalLoad = 0;
  for (const offer of quote.offers ?? []) {
    const requested = Math.max(0, Math.floor(finiteNumber(quantities?.[offer.id], 0)));
    const qty = Math.min(requested, Math.max(0, Math.floor(finiteNumber(offer.stock, 0))));
    if (!qty) continue;
    const lineCopper = qty * Math.max(1, Math.floor(finiteNumber(offer.unitPriceCopper, 1)));
    subtotalCopper += lineCopper;
    totalLoad += qty * Math.max(0, finiteNumber(offer.load, 1));
    lines.push({ ...offer, qty, lineCopper, targetRoomId: String(targetRoomId || "outdoors") });
  }
  const location = quote.location ?? {};
  const logistics = quote.logistics ?? {};
  const physicalCapacityLoad = Math.max(0, finiteNumber(logistics?.capacityLoad, 0));
  const hasCapacityLimit = physicalCapacityLoad > 0;
  const scheduled = quote.deliveryMode === "scheduled";
  const service = marketDeliveryService(serviceLevel, scheduled);
  const bookingCapacityLoad = hasCapacityLimit ? physicalCapacityLoad * (scheduled ? service.capacityFactor : 1) : 0;
  const capacityExceeded = lines.length > 0 && bookingCapacityLoad > 0 && (scheduled
    ? lines.some((line) => Math.max(0, finiteNumber(line.load, 1)) > bookingCapacityLoad + 0.0001)
    : totalLoad > bookingCapacityLoad + 0.0001);
  const batches = splitMarketShipmentLines(lines, scheduled ? bookingCapacityLoad : 0);
  const routeFlatCopper = Math.max(0, Math.ceil(finiteNumber(logistics.distanceFlatCopper, 0)));
  const loadRateCopper = Math.max(0, finiteNumber(logistics.distanceLoadCopper, 0));
  const freightRate = marketHistoricalFreightRate(logistics);
  // Instant/GM-local delivery has no in-transit loss resolution, therefore it
  // must not charge a policy that can never pay out.
  const insuranceRate = scheduled ? marketHistoricalInsuranceRate({ location, logistics }) : 0;
  const standardDeliveryQd = scheduled ? Math.max(1, Math.floor(finiteNumber(quote.deliveryQd, 1))) : 0;
  const firstDeliveryQd = scheduled ? Math.max(1, Math.ceil(standardDeliveryQd * service.etaFactor)) : 0;
  const dispatchIntervalQd = scheduled ? Math.max(1, Math.ceil(standardDeliveryQd * service.intervalFactor)) : 0;
  const deliveryFactor = Math.max(0.1, finiteNumber(logistics.deliveryFactor, 1));
  const handlingFlatCopper = Math.max(0, finiteNumber(location.deliveryFlatCopper, 0));
  const handlingLoadRateCopper = Math.max(0, finiteNumber(location.deliveryLoadCopper, 0));
  const taxRate = Math.max(0, finiteNumber(logistics.taxRate, 0));
  const hasDirectionalTaxes = Object.hasOwn(logistics, "importTaxRate");
  const importTaxRate = hasDirectionalTaxes ? Math.max(0, finiteNumber(logistics.importTaxRate, 0)) : taxRate;
  const exportTaxRate = Math.max(0, finiteNumber(logistics.exportTaxRate, 0));
  const fullVesselLoadCopper = hasCapacityLimit ? Math.max(0, Math.ceil(physicalCapacityLoad * loadRateCopper)) : 0;
  const fullOneWayOperatingCopper = routeFlatCopper + fullVesselLoadCopper;

  for (const [index, batch] of batches.entries()) {
    batch.index = index;
    batch.number = index + 1;
    batch.capacityShare = service.fullFixedFare
      ? 1
      : (hasCapacityLimit ? clamp(batch.totalLoad / physicalCapacityLoad, 0.02, 1) : 1);
    batch.billableLoad = service.fullFixedFare && hasCapacityLimit ? physicalCapacityLoad : batch.totalLoad;
    batch.loadCopper = Math.max(0, Math.ceil(batch.billableLoad * loadRateCopper));
    batch.valueFreightCopper = Math.max(1, Math.ceil(batch.subtotalCopper * freightRate));
    batch.operatingLegFactor = service.operatingLegFactor;
    batch.fullOneWayOperatingCopper = hasCapacityLimit
      ? fullOneWayOperatingCopper
      : routeFlatCopper + batch.loadCopper;
    // Rideshare pays its occupied share of a revenue-producing one-way service.
    // A charter reserves the whole vehicle and must also fund its return/repositioning.
    batch.operationalFreightCopper = Math.max(0, Math.ceil(batch.fullOneWayOperatingCopper * batch.capacityShare * batch.operatingLegFactor));
    batch.routeCopper = Math.max(batch.valueFreightCopper, batch.operationalFreightCopper);
    batch.handlingCopper = Math.max(0, Math.ceil((handlingFlatCopper + batch.totalLoad * handlingLoadRateCopper) * deliveryFactor));
    batch.insuranceCopper = Math.max(0, Math.ceil(batch.subtotalCopper * insuranceRate));
    batch.importTaxCopper = Math.max(0, Math.ceil(batch.subtotalCopper * importTaxRate));
    batch.exportTaxCopper = Math.max(0, Math.ceil(batch.subtotalCopper * exportTaxRate));
    batch.taxCopper = batch.importTaxCopper + batch.exportTaxCopper;
    batch.expressSurchargeCopper = service.surchargeRate > 0
      ? Math.max(1, Math.ceil((batch.routeCopper + batch.handlingCopper) * service.surchargeRate))
      : 0;
    batch.deliveryCopper = batch.routeCopper + batch.handlingCopper + batch.insuranceCopper + batch.taxCopper + batch.expressSurchargeCopper;
    batch.totalCopper = batch.subtotalCopper + batch.deliveryCopper;
    batch.deliveryQd = scheduled ? firstDeliveryQd + index * dispatchIntervalQd : 0;
    batch.departureQd = scheduled ? index * dispatchIntervalQd : 0;
    batch.transportQd = firstDeliveryQd;
    batch.riskProfile = marketShipmentRiskProfile({ logistics, deliveryQd: firstDeliveryQd, subtotalCopper: batch.subtotalCopper, insuranceCopper: batch.insuranceCopper });
  }

  const sumBatch = (field) => batches.reduce((sum, batch) => sum + Math.max(0, finiteNumber(batch[field], 0)), 0);
  const capacityShare = sumBatch("capacityShare");
  const loadCopper = sumBatch("loadCopper");
  const billableLoad = sumBatch("billableLoad");
  const valueFreightCopper = sumBatch("valueFreightCopper");
  const operationalFreightCopper = sumBatch("operationalFreightCopper");
  const routeCopper = sumBatch("routeCopper");
  const handlingCopper = sumBatch("handlingCopper");
  const insuranceCopper = sumBatch("insuranceCopper");
  const taxCopper = sumBatch("taxCopper");
  const importTaxCopper = sumBatch("importTaxCopper");
  const exportTaxCopper = sumBatch("exportTaxCopper");
  const expressSurchargeCopper = sumBatch("expressSurchargeCopper");
  const deliveryCopper = sumBatch("deliveryCopper");
  const deliveryQd = batches.length ? Math.max(...batches.map((batch) => batch.deliveryQd)) : 0;
  const totalCopper = subtotalCopper + deliveryCopper;
  const treasuryCopper = Math.max(0, Math.floor(finiteNumber(holding?.storage?.moneyCopper, 0)));
  const riskLossChance = batches.length ? 1 - batches.reduce((chance, batch) => chance * (1 - batch.riskProfile.lossChance), 1) : 0;
  const riskDelayChance = batches.length ? 1 - batches.reduce((chance, batch) => chance * (1 - batch.riskProfile.delayChance), 1) : 0;
  const riskMaxDelayQd = batches.length ? Math.max(...batches.map((batch) => batch.riskProfile.maxDelayQd)) : 0;
  const maximumInsurancePayoutCopper = batches.reduce((sum, batch) => sum + batch.riskProfile.maximumInsurancePayoutCopper, 0);
  // The outbound adapter quotes freight without purchasing the cargo. Its own
  // planner validates revenue and insured value; do not impose a fictitious
  // inbound goods+delivery payment on that transport estimate.
  const amountExceeded = !(transportOnly ? [deliveryCopper] : [subtotalCopper, deliveryCopper, totalCopper, maximumInsurancePayoutCopper])
    .every(marketMoneyInRange);
  const merchantProviderIds = [...new Set(lines.map((line) => String(line.providerId ?? "")).filter(Boolean))];
  const finalBatchLoad = batches.at(-1)?.totalLoad ?? 0;
  const capacityRemainingLoad = bookingCapacityLoad > 0 ? Math.max(0, bookingCapacityLoad - finalBatchLoad) : 0;
  const capacityUtilization = bookingCapacityLoad > 0 ? finalBatchLoad / bookingCapacityLoad : 0;
  const deliveryBreakdown = {
    distanceKm: Math.max(0, finiteNumber(logistics.distanceKm, 0)),
    hops: Math.max(0, Math.floor(finiteNumber(logistics.hops, 0))),
    accessCost: Math.max(0, Math.floor(finiteNumber(logistics.routeAccessLevel ?? logistics.routeAccessCost, finiteNumber(logistics.hops, 0)))),
    dispatchCopper: Math.max(0, Math.ceil(finiteNumber(logistics.dispatchCopper, 0))),
    routeDistanceCopper: Math.max(0, Math.ceil(finiteNumber(logistics.routeDistanceCopper, 0))),
    configuredDistanceFlatCopper: Math.max(0, Math.ceil(finiteNumber(logistics.configuredDistanceFlatCopper, 0))),
    routeFlatBeforeFactorCopper: Math.max(0, Math.ceil(finiteNumber(logistics.routeFlatBeforeFactorCopper, 0))),
    airshipHireCopper: Math.max(0, Math.ceil(finiteNumber(logistics.airshipHireCopper, 0))),
    operatingTimeCopper: Math.max(0, Math.ceil(finiteNumber(logistics.operatingTimeCopper, 0))),
    distanceFactor: Math.max(0.01, finiteNumber(logistics.deliveryFactor, 1)),
    carrierPriceFactor: Math.max(0.5, finiteNumber(logistics.carrierPriceFactor, 1)),
    routeFlatCopper,
    batchCount: batches.length,
    serviceLevel: service.id,
    serviceLabel: service.label,
    physicalCapacityLoad,
    bookingCapacityLoad,
    capacityShare,
    freightRate,
    valueFreightCopper,
    operationalFreightCopper,
    operatingLegFactor: service.operatingLegFactor,
    fullVesselLoadCopper,
    fullOneWayOperatingCopper,
    routeCopper,
    loadRateCopper,
    billableLoad,
    loadCopper,
    handlingFlatCopper,
    handlingLoadRateCopper,
    handlingCopper,
    insuranceRate,
    insuranceCopper,
    taxRate,
    importTaxRate,
    exportTaxRate,
    importTaxCopper,
    exportTaxCopper,
    taxCopper,
    expressSurchargeCopper,
    deliveryCopper,
    subtotalCopper
  };
  return {
    ok: lines.length > 0 && totalCopper > 0 && treasuryCopper >= totalCopper && logistics?.ok !== false && !capacityExceeded && !amountExceeded,
    amountExceeded,
    amountLimitCopper: MAX_MARKET_OPERATION_COPPER,
    empty: lines.length === 0,
    insufficientFunds: lines.length > 0 && treasuryCopper < totalCopper,
    inaccessible: logistics?.ok === false,
    hasCapacityLimit,
    capacityExceeded,
    quoteKey: String(quote.quoteKey ?? ""),
    marketId: String(quote.marketId ?? "external-market"),
    marketLabel: String(quote.marketLabel ?? "Внешний рынок"),
    locationId: String(location.id ?? "standard"),
    locationLabel: String(location.label ?? "Обычный маршрут"),
    locationText: String(quote.locationText ?? ""),
    targetRoomId: String(targetRoomId || "outdoors"),
    deliveryMode: scheduled ? "scheduled" : "instant",
    serviceLevel: service.id,
    serviceLabel: service.label,
    standardDeliveryQd,
    firstDeliveryQd,
    deliveryQd,
    dispatchIntervalQd,
    logistics,
    carrierId: String(logistics?.carrierId ?? ""),
    carrierLabel: String(logistics?.carrierLabel ?? ""),
    merchantProviderIds,
    deliveryBreakdown,
    routeCopper,
    taxCopper,
    importTaxCopper,
    exportTaxCopper,
    handlingCopper,
    expressSurchargeCopper,
    insuranceCopper,
    insuranceRate,
    riskFactor: clamp(finiteNumber(logistics.riskFactor, 1), 0.25, 4),
    riskLossChance,
    riskDelayChance,
    riskMaxDelayQd,
    insuranceCoverageRate: insuranceCopper > 0 ? MARKET_INSURANCE_COVERAGE_RATE : 0,
    insuredValueCopper: subtotalCopper,
    maximumInsurancePayoutCopper,
    lines,
    shipmentBatches: batches,
    batchCount: batches.length,
    subtotalCopper,
    deliveryCopper,
    totalLoad,
    capacityLoad: physicalCapacityLoad,
    physicalCapacityLoad,
    bookingCapacityLoad,
    finalBatchLoad,
    capacityRemainingLoad,
    capacityUtilization,
    totalCopper,
    treasuryCopper,
    balanceAfterCopper: treasuryCopper - totalCopper
  };
}
