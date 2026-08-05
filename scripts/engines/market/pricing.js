const KIND_LABELS = {
  material: "Материалы",
  resource: "Ресурсы",
  consumable: "Расходники",
  livestock: "Животные"
};

export const MARKET_INSURANCE_COVERAGE_RATE = 0.84;
export const MARKET_EXPRESS_SURCHARGE_RATE = 0.2;
export const MARKET_EXPRESS_ETA_FACTOR = 0.7;
export const MARKET_STANDARD_ETA_FACTOR = 1.25;
export const MARKET_CHARTER_ETA_FACTOR = 0.85;

export const MARKET_DELIVERY_SERVICES = Object.freeze({
  standard: Object.freeze({ id: "standard", label: "Попутный груз", capacityFactor: 0.2, etaFactor: MARKET_STANDARD_ETA_FACTOR, intervalFactor: 0.25, fullFixedFare: false, operatingLegFactor: 1, surchargeRate: 0 }),
  express: Object.freeze({ id: "express", label: "Ускоренная доставка", capacityFactor: 0.1, etaFactor: MARKET_EXPRESS_ETA_FACTOR, intervalFactor: 0.1, fullFixedFare: false, operatingLegFactor: 1, surchargeRate: MARKET_EXPRESS_SURCHARGE_RATE }),
  charter: Object.freeze({ id: "charter", label: "Выделенный рейс", capacityFactor: 1, etaFactor: MARKET_CHARTER_ETA_FACTOR, intervalFactor: 0.1, fullFixedFare: true, operatingLegFactor: 2, surchargeRate: 0 }),
  owned: Object.freeze({ id: "owned", label: "Свой корабль", capacityFactor: 1, etaFactor: 1, intervalFactor: 1, fullFixedFare: true, operatingLegFactor: 1, surchargeRate: 0 })
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

const CARGO_KG_PER_LOAD = 10;
const CARGO_LITRES_PER_LOAD = 20;
const CARGO_EPSILON = 0.0000001;

function pricingDependencies(dependencies = {}, required = []) {
  for (const name of required) {
    if (typeof dependencies[name] !== "function") {
      throw new TypeError(`FBL Skyhold | Market pricing requires dependency "${name}".`);
    }
  }
  return dependencies;
}

function cargoNonNegative(value, fallback = 0) {
  const parsed = Number(value);
  return Math.max(0, Number.isFinite(parsed) ? parsed : fallback);
}

function hasPhysicalValue(row, field) {
  return row && Object.hasOwn(row, field) && Number.isFinite(Number(row[field])) && Number(row[field]) >= 0;
}

function cargoUnitMetrics(line = {}, dependencies = {}) {
  const cargoPoints = dependencies.cargoPointsFromLegacy(line, { isMoney: false });
  const fallbackLoad = dependencies.legacyLoadFromCargoPoints(cargoPoints);
  const hasMass = hasPhysicalValue(line, "packageMassKg");
  const hasVolume = hasPhysicalValue(line, "packageVolumeL");
  const emptyPhysicalPair = hasMass && hasVolume
    && cargoNonNegative(line.packageMassKg, 0) === 0
    && cargoNonNegative(line.packageVolumeL, 0) === 0;
  const massKg = hasMass && !emptyPhysicalPair
    ? cargoNonNegative(line.packageMassKg, 0)
    : fallbackLoad * CARGO_KG_PER_LOAD;
  const volumeL = hasVolume && !emptyPhysicalPair
    ? cargoNonNegative(line.packageVolumeL, 0)
    : fallbackLoad * CARGO_LITRES_PER_LOAD;
  return {
    massKg,
    volumeL,
    cargoPoints,
    load: fallbackLoad
  };
}

function cargoLineMetrics(line = {}, quantity = line?.qty, dependencies = {}) {
  const qty = cargoNonNegative(quantity, 0);
  const unit = cargoUnitMetrics(line, dependencies);
  const massKg = qty * unit.massKg;
  const volumeL = qty * unit.volumeL;
  return {
    quantity: qty,
    massKg,
    volumeL,
    cargoPoints: qty * unit.cargoPoints,
    load: qty * unit.load
  };
}

function cargoMetrics(lines = [], dependencies = {}) {
  let massKg = 0;
  let volumeL = 0;
  let cargoPoints = 0;
  for (const line of Array.isArray(lines) ? lines : []) {
    const row = cargoLineMetrics(line, line?.qty, dependencies);
    massKg += row.massKg;
    volumeL += row.volumeL;
    cargoPoints += row.cargoPoints;
  }
  return {
    massKg,
    volumeL,
    cargoPoints,
    load: dependencies.legacyLoadFromCargoPoints(cargoPoints)
  };
}

function normalizeCargoCapacity(value = 0, dependencies = {}) {
  if (typeof value === "number" || typeof value === "string") {
    const load = cargoNonNegative(value, 0);
    const cargoPoints = Math.ceil(load * 10 - Number.EPSILON);
    return {
      massKg: load * CARGO_KG_PER_LOAD,
      volumeL: load * CARGO_LITRES_PER_LOAD,
      cargoPoints,
      load,
      massLimited: load > 0,
      volumeLimited: load > 0
    };
  }
  const source = value && typeof value === "object" ? value : {};
  const explicitCargoPoints = hasPhysicalValue(source, "capacityCargoPoints") || hasPhysicalValue(source, "cargoPoints");
  const configuredCargoPoints = hasPhysicalValue(source, "capacityCargoPoints")
    ? cargoNonNegative(source.capacityCargoPoints, 0)
    : (hasPhysicalValue(source, "cargoPoints") ? cargoNonNegative(source.cargoPoints, 0) : 0);
  const fallbackLoad = cargoNonNegative(source.capacityLoad ?? source.load, 0);
  const explicitMass = hasPhysicalValue(source, "capacityMassKg") || hasPhysicalValue(source, "massKg");
  const explicitVolume = hasPhysicalValue(source, "capacityVolumeL") || hasPhysicalValue(source, "volumeL");
  const massLimited = explicitMass || fallbackLoad > 0;
  const volumeLimited = explicitVolume || fallbackLoad > 0;
  const massKg = hasPhysicalValue(source, "capacityMassKg")
    ? cargoNonNegative(source.capacityMassKg, 0)
    : (hasPhysicalValue(source, "massKg") ? cargoNonNegative(source.massKg, 0) : fallbackLoad * CARGO_KG_PER_LOAD);
  const volumeL = hasPhysicalValue(source, "capacityVolumeL")
    ? cargoNonNegative(source.capacityVolumeL, 0)
    : (hasPhysicalValue(source, "volumeL") ? cargoNonNegative(source.volumeL, 0) : fallbackLoad * CARGO_LITRES_PER_LOAD);
  const axes = [];
  if (massLimited) axes.push(massKg / CARGO_KG_PER_LOAD);
  if (volumeLimited) axes.push(volumeL / CARGO_LITRES_PER_LOAD);
  return {
    massKg,
    volumeL,
    cargoPoints: explicitCargoPoints ? Math.floor(configuredCargoPoints) : Math.ceil((axes.length ? Math.min(...axes) : fallbackLoad) * 10 - Number.EPSILON),
    load: explicitCargoPoints ? dependencies.legacyLoadFromCargoPoints(configuredCargoPoints) : (axes.length ? Math.min(...axes) : fallbackLoad),
    massLimited,
    volumeLimited
  };
}

function scaleCargoCapacity(value = 0, factor = 1, dependencies = {}) {
  const capacity = normalizeCargoCapacity(value, dependencies);
  const scale = cargoNonNegative(factor, 1);
  return {
    massKg: capacity.massKg * scale,
    volumeL: capacity.volumeL * scale,
    cargoPoints: capacity.cargoPoints * scale,
    load: capacity.load * scale,
    massLimited: capacity.massLimited,
    volumeLimited: capacity.volumeLimited
  };
}

function cargoFitsCapacity(metrics = {}, capacity = 0, dependencies = {}) {
  const cargoPoints = cargoNonNegative(metrics.cargoPoints ?? metrics.totalCargoPoints, cargoNonNegative(metrics.load ?? metrics.totalLoad, 0) * 10);
  const limit = normalizeCargoCapacity(capacity, dependencies);
  return cargoPoints <= limit.cargoPoints + CARGO_EPSILON;
}

function cargoCapacityShare(metrics = {}, capacity = 0, dependencies = {}) {
  const cargoPoints = cargoNonNegative(metrics.cargoPoints ?? metrics.totalCargoPoints, cargoNonNegative(metrics.load ?? metrics.totalLoad, 0) * 10);
  const limit = normalizeCargoCapacity(capacity, dependencies);
  return limit.cargoPoints > 0 ? Math.max(0, cargoPoints / limit.cargoPoints) : (cargoPoints > 0 ? Number.POSITIVE_INFINITY : 0);
}

function cargoUnitsFitting(metrics = {}, capacity = 0, dependencies = {}) {
  const unitCargoPoints = cargoNonNegative(metrics.cargoPoints, cargoNonNegative(metrics.load, 0) * 10);
  const explicitPointLimit = capacity && typeof capacity === "object"
    && (Object.hasOwn(capacity, "capacityCargoPoints") || Object.hasOwn(capacity, "cargoPoints"));
  const limit = normalizeCargoCapacity(capacity, dependencies);
  if (!(unitCargoPoints > 0)) return Number.POSITIVE_INFINITY;
  if (explicitPointLimit && !(limit.cargoPoints > 0)) return 0;
  if (!(limit.cargoPoints > 0)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((limit.cargoPoints + CARGO_EPSILON) / unitCargoPoints));
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function marketOfferPriceMode(offer = {}) {
  const requested = String(offer.priceMode ?? offer.pricingMode ?? "").trim().toLowerCase();
  const customOffer = offer.sourceType === "item" || String(offer.resourceId ?? "custom") === "custom";
  if (requested === "catalog" && !customOffer) return "catalog";
  if (requested === "manual" && customOffer) return "manual";
  return "legacy";
}

function standardMarketResourceOffer(offer = {}) {
  const resourceId = String(offer.resourceId ?? "").trim();
  return offer.sourceType !== "item" && resourceId && resourceId !== "custom";
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

function appendBatchLine(batch, line, qty, dependencies = {}) {
  const unitPriceCopper = Math.max(1, Math.floor(finiteNumber(line.unitPriceCopper, 1)));
  const copy = { ...line, qty, lineCopper: qty * unitPriceCopper };
  batch.lines.push(copy);
  batch.subtotalCopper += copy.lineCopper;
  const metrics = cargoMetrics(batch.lines, dependencies);
  batch.totalMassKg = metrics.massKg;
  batch.totalVolumeL = metrics.volumeL;
  batch.totalCargoPoints = metrics.cargoPoints;
  batch.totalLoad = metrics.load;
}

function emptyBatch() {
  return { lines: [], subtotalCopper: 0, totalMassKg: 0, totalVolumeL: 0, totalCargoPoints: 0, totalLoad: 0 };
}

export function splitMarketShipmentLines(lines = [], capacityValue = 0, dependencies = {}) {
  const deps = pricingDependencies(dependencies, ["cargoPointsFromLegacy", "legacyLoadFromCargoPoints"]);
  const rows = (Array.isArray(lines) ? lines : []).filter((line) => Math.max(0, Math.floor(finiteNumber(line?.qty, 0))) > 0);
  if (!rows.length) return [];
  const capacity = normalizeCargoCapacity(capacityValue, deps);
  if (!(capacity.cargoPoints > 0)) {
    const batch = emptyBatch();
    for (const line of rows) appendBatchLine(batch, line, Math.max(0, Math.floor(finiteNumber(line.qty, 0))), deps);
    return [batch];
  }

  const batches = [];
  let batch = emptyBatch();
  const flush = () => {
    if (!batch.lines.length) return;
    batches.push(batch);
    batch = emptyBatch();
  };
  for (const line of rows) {
    let remaining = Math.max(0, Math.floor(finiteNumber(line.qty, 0)));
    const unit = cargoUnitMetrics(line, deps);
    if (!(unit.cargoPoints > 0)) {
      appendBatchLine(batch, line, remaining, deps);
      continue;
    }
    while (remaining > 0) {
      const available = {
        capacityCargoPoints: Math.max(0, capacity.cargoPoints - batch.totalCargoPoints)
      };
      const fits = cargoUnitsFitting(unit, available, deps);
      if (fits <= 0) {
        if (!batch.lines.length) {
          appendBatchLine(batch, line, 1, deps);
          remaining -= 1;
        }
        flush();
        continue;
      }
      const qty = Math.min(remaining, fits);
      appendBatchLine(batch, line, qty, deps);
      remaining -= qty;
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
  const rawLastQd = holding?.gm?.calendaria?.lastQd;
  if (rawLastQd !== undefined && rawLastQd !== null && rawLastQd !== "" && Number.isFinite(Number(rawLastQd))) {
    const elapsedQd = Math.max(0, Math.floor(Number(rawLastQd)));
    const quotePeriodQd = Math.max(4, Math.floor(finiteNumber(quotePeriodDays, 10) * 4));
    return `tenday:${Math.floor(elapsedQd / quotePeriodQd)}`;
  }
  const period = String(holding?.overview?.period ?? "").trim();
  if (period) return `holding:${period}`;
  const day = Math.floor(new Date(now).getTime() / 86400000);
  return `utc:${Math.floor(day / Math.max(1, Math.floor(finiteNumber(quotePeriodDays, 10))))}`;
}

function quoteOffer(offer, { holding, market, location, quoteKey, seedKey = quoteKey, resource, logistics = {} } = {}, dependencies = {}) {
  const volatility = clamp(finiteNumber(offer.volatility, 0.2), 0, 0.8);
  const movement = 1 + ((marketRandomUnit(`${seedKey}|${location.id}|${offer.id}|price`) * 2) - 1) * volatility;
  const categoryFactor = finiteNumber(location?.categoryFactors?.[offer.kind], 1);
  const reputation = finiteNumber(holding?.overview?.reputation, 0) + finiteNumber(holding?.gm?.modifiers?.reputation, 0);
  const reputationFactor = clamp(1 - reputation * 0.005, 0.88, 1.12);
  const priceMode = marketOfferPriceMode(offer);
  const referencePriceCopper = Math.max(0, finiteNumber(resource?.referencePriceCopper, 0));
  const catalogPriceFactor = Math.max(0.01, finiteNumber(offer.catalogPriceFactor, 1));
  const priceAnchorCopper = priceMode === "catalog"
    ? referencePriceCopper * catalogPriceFactor
    : finiteNumber(offer.basePriceCopper, 1);
  const askUnitCopper = Math.max(1, Math.round(priceAnchorCopper * finiteNumber(location.priceFactor, 1) * finiteNumber(logistics.priceFactor, 1) * categoryFactor * reputationFactor * movement));
  const stockMovement = 0.65 + marketRandomUnit(`${seedKey}|${location.id}|${offer.id}|stock`) * 0.7;
  const askStock = Math.max(0, Math.floor(finiteNumber(offer.baseAskStock ?? offer.baseStock, 0) * finiteNumber(location.availabilityFactor, 1) * finiteNumber(logistics.stockFactor, 1) * stockMovement));
  const bidSpreadRate = clamp(finiteNumber(offer.bidSpreadRate, 0.18), 0.05, 0.5);
  const bidUnitCopper = Math.max(0, Math.floor(askUnitCopper * (1 - bidSpreadRate)));
  const sourceBidDemand = Math.max(0, finiteNumber(offer.baseBidDemand, Math.floor(finiteNumber(offer.baseAskStock ?? offer.baseStock, 0) * 0.75)));
  const availability = Math.max(0.01, finiteNumber(location.availabilityFactor, 1) * finiteNumber(logistics.stockFactor, 1));
  const demandFactor = clamp(1 / availability, 0.4, 2.5);
  const demandMovement = 0.75 + marketRandomUnit(`${seedKey}|${location.id}|${offer.id}|demand`) * 0.5;
  const bidDemand = Math.max(0, Math.floor(sourceBidDemand * demandFactor * demandMovement));
  const liquidity = dependencies.normalizeMarketLiquidityQuote({
    market,
    offer: {
      ...offer,
      askUnitCopper,
      askStock,
      baseAskStock: askStock,
      bidUnitCopper,
      bidDemand,
      baseBidDemand: bidDemand
    },
    marketId: String(market?.id ?? "external-market"),
    quoteKey,
    offerId: String(offer.id ?? "")
  });
  const inheritedLoad = resource && (offer.loadMode === "auto"
    || (!offer.loadMode && String(offer.id ?? "").startsWith("market-") && String(offer.resourceId ?? "") !== "custom"));
  const packageMassKg = inheritedLoad
    ? Math.max(0, finiteNumber(resource?.packageMassKg, 0))
    : (Object.hasOwn(offer, "packageMassKg") ? Math.max(0, finiteNumber(offer.packageMassKg, 0)) : undefined);
  const packageVolumeL = inheritedLoad
    ? Math.max(0, finiteNumber(resource?.packageVolumeL, 0))
    : (Object.hasOwn(offer, "packageVolumeL") ? Math.max(0, finiteNumber(offer.packageVolumeL, 0)) : undefined);
  return {
    ...offer,
    priceMode,
    configuredName: String(offer.name ?? "").trim(),
    configuredImg: String(offer.img ?? "").trim(),
    name: String(offer.name ?? "").trim() || String(resource?.label ?? offer.resourceId ?? "Товар"),
    unit: String(!offer.unit || offer.unit === "ед." ? (resource?.unitLabel ?? resource?.unit ?? "ед.") : offer.unit),
    economyVersion: Math.max(1, Math.floor(finiteNumber(resource?.economyVersion ?? offer.economyVersion, 1))),
    legacyEconomy: resource?.legacyEconomy === true,
    loadMode: inheritedLoad ? "auto" : "manual",
    load: inheritedLoad ? Math.max(0, finiteNumber(resource?.load, 1)) : Math.max(0, finiteNumber(offer.load, 1)),
    cargoClass: inheritedLoad ? String(resource?.cargoClass ?? "10") : String(offer.cargoClass ?? "10"),
    cargoPoints: inheritedLoad
      ? Math.max(1, Math.ceil(finiteNumber(resource?.cargoPoints, finiteNumber(resource?.load, 1) * 10)))
      : Math.max(1, Math.ceil(finiteNumber(offer.cargoPoints, finiteNumber(offer.load, 1) * 10))),
    ...(packageMassKg === undefined ? {} : { packageMassKg }),
    ...(packageVolumeL === undefined ? {} : { packageVolumeL }),
    priceBasis: String(offer.priceBasis ?? "").trim() || String(resource?.priceBasis ?? ""),
    icon: String(offer.icon ?? "").trim() || String(resource?.icon ?? "fa-solid fa-box"),
    img: String(offer.img ?? "").trim() || String(resource?.img ?? ""),
    kindLabel: KIND_LABELS[offer.kind] ?? "Товары",
    priceAnchorCopper: Math.max(1, Math.round(priceAnchorCopper)),
    askUnitCopper: liquidity.askUnitCopper,
    askStock: liquidity.askStock,
    baseAskStock: liquidity.baseAskStock,
    bidUnitCopper: liquidity.bidUnitCopper,
    bidDemand: liquidity.bidDemand,
    baseBidDemand: liquidity.baseBidDemand,
    unitPriceCopper: liquidity.askUnitCopper,
    stock: liquidity.askStock,
    liquidityKey: liquidity.key,
    marketId: liquidity.marketId,
    quoteKey: liquidity.quoteKey,
    offerId: liquidity.offerId,
    spreadCopper: liquidity.askUnitCopper - liquidity.bidUnitCopper,
    spreadPercent: Math.round(((liquidity.askUnitCopper - liquidity.bidUnitCopper) / liquidity.askUnitCopper) * 100),
    movementPercent: Math.round((movement - 1) * 100),
    demandMovementPercent: Math.round((demandMovement - 1) * 100),
    movementClass: movement > 1.015 ? "up" : (movement < 0.985 ? "down" : "stable")
  };
}

export function prepareMarketQuote({ holding = {}, market = {}, resources = [], location: locationOverride = null, logistics = null } = {}, dependencies = {}) {
  const deps = pricingDependencies(dependencies, ["normalizeMarketLiquidityQuote", "resourceTradeReady"]);
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
    if (standardMarketResourceOffer(offer) && !deps.resourceTradeReady(resource)) return null;
    const accessDifficulty = Math.max(0, Math.floor(finiteNumber(offer.accessDifficulty, 0)), Math.floor(finiteNumber(resource?.marketAccessDifficulty, 0)));
    const requiredUrs = routeAccessCost + accessDifficulty;
    return { offer: { ...offer, accessDifficulty, requiredUrs }, resource, requiredUrs };
  }).filter((row) => row && (!enforceAccess || row.requiredUrs <= accessLevel));
  const offers = accessibleOffers.map(({ offer, resource }) => quoteOffer(offer, {
    holding,
    market,
    location,
    quoteKey,
    seedKey: marketQuoteKey,
    resource,
    logistics: logistics ?? {}
  }, deps));
  const deliveryMode = String(market.deliveryMode ?? "instant") === "scheduled" ? "scheduled" : "instant";
  const deliveryQd = deliveryMode === "scheduled"
    ? Math.max(1, Math.ceil(finiteNumber(market.baseDeliveryQd, 2) * Math.max(0.1, finiteNumber(location.deliveryQdFactor, 1)) + Math.max(0, finiteNumber(logistics?.travelQd, 0))))
    : 0;
  return { marketId: String(market.id ?? "external-market"), marketLabel: String(market.label ?? "Внешний рынок"), quoteKey, location, locationText: marketLocationText(holding), deliveryMode, deliveryQd, logistics: logistics ?? null, offers, hiddenOfferCount: Math.max(0, activeOffers.length - accessibleOffers.length) };
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

export function planMarketPurchase({ holding = {}, quote = {}, quantities = {}, targetRoomId = "outdoors", serviceLevel = "standard" } = {}, dependencies = {}) {
  const deps = pricingDependencies(dependencies, ["cargoPointsFromLegacy", "legacyLoadFromCargoPoints"]);
  const lines = [];
  let subtotalCopper = 0;
  for (const offer of quote.offers ?? []) {
    const requested = Math.max(0, Math.floor(finiteNumber(quantities?.[offer.id], 0)));
    const qty = Math.min(requested, Math.max(0, Math.floor(finiteNumber(offer.stock, 0))));
    if (!qty) continue;
    const lineCopper = qty * Math.max(1, Math.floor(finiteNumber(offer.unitPriceCopper, 1)));
    subtotalCopper += lineCopper;
    lines.push({ ...offer, qty, lineCopper, targetRoomId: String(targetRoomId || "outdoors") });
  }
  const totalMetrics = cargoMetrics(lines, deps);
  const totalMassKg = totalMetrics.massKg;
  const totalVolumeL = totalMetrics.volumeL;
  const totalCargoPoints = totalMetrics.cargoPoints;
  const totalLoad = totalMetrics.load;
  const location = quote.location ?? {};
  const logistics = quote.logistics ?? {};
  const physicalCapacity = normalizeCargoCapacity({
    capacityLoad: logistics?.capacityLoad,
    capacityCargoPoints: logistics?.capacityCargoPoints,
    capacityMassKg: logistics?.capacityMassKg,
    capacityVolumeL: logistics?.capacityVolumeL
  }, deps);
  const physicalCapacityLoad = physicalCapacity.load;
  const physicalCapacityCargoPoints = physicalCapacity.cargoPoints;
  const physicalCapacityMassKg = physicalCapacity.massKg;
  const physicalCapacityVolumeL = physicalCapacity.volumeL;
  const hasCapacityLimit = physicalCapacityCargoPoints > 0;
  const scheduled = quote.deliveryMode === "scheduled";
  const service = marketDeliveryService(serviceLevel, scheduled);
  const ownedVesselDelivery = service.id === "owned" && Boolean(logistics?.ownedVesselId);
  const bookingCapacity = hasCapacityLimit ? scaleCargoCapacity(physicalCapacity, scheduled ? service.capacityFactor : 1, deps) : normalizeCargoCapacity(0, deps);
  const bookingCapacityLoad = bookingCapacity.load;
  const bookingCapacityCargoPoints = bookingCapacity.cargoPoints;
  const bookingCapacityMassKg = bookingCapacity.massKg;
  const bookingCapacityVolumeL = bookingCapacity.volumeL;
  const capacityExceeded = lines.length > 0 && hasCapacityLimit && (ownedVesselDelivery
    ? !cargoFitsCapacity(totalMetrics, bookingCapacity, deps)
    : scheduled
      ? lines.some((line) => !cargoFitsCapacity(cargoLineMetrics(line, 1, deps), bookingCapacity, deps))
      : !cargoFitsCapacity(totalMetrics, bookingCapacity, deps));
  const batches = splitMarketShipmentLines(lines, scheduled ? bookingCapacity : 0, deps);
  const routeFlatCopper = Math.max(0, Math.ceil(finiteNumber(logistics.distanceFlatCopper, 0)));
  const loadRateCopper = Math.max(0, finiteNumber(logistics.distanceLoadCopper, 0));
  const freightRate = marketHistoricalFreightRate(logistics);
  const insuranceRate = marketHistoricalInsuranceRate({ location, logistics });
  const standardDeliveryQd = scheduled ? Math.max(1, Math.floor(finiteNumber(quote.deliveryQd, 1))) : 0;
  const firstDeliveryQd = scheduled ? Math.max(1, Math.ceil(standardDeliveryQd * service.etaFactor)) : 0;
  const dispatchIntervalQd = scheduled ? Math.max(1, Math.ceil(standardDeliveryQd * service.intervalFactor)) : 0;
  const deliveryFactor = Math.max(0.1, finiteNumber(logistics.deliveryFactor, 1));
  const handlingFlatCopper = Math.max(0, finiteNumber(location.deliveryFlatCopper, 0));
  const handlingLoadRateCopper = Math.max(0, finiteNumber(location.deliveryLoadCopper, 0));
  const taxRate = Math.max(0, finiteNumber(logistics.taxRate, 0));
  const fullVesselLoadCopper = hasCapacityLimit ? Math.max(0, Math.ceil(physicalCapacityLoad * loadRateCopper)) : 0;
  const fullOneWayOperatingCopper = routeFlatCopper + fullVesselLoadCopper;

  for (const [index, batch] of batches.entries()) {
    batch.index = index;
    batch.number = index + 1;
    batch.capacityShare = service.fullFixedFare
      ? 1
      : (hasCapacityLimit ? clamp(cargoCapacityShare(batch, physicalCapacity, deps), 0.02, 1) : 1);
    batch.billableLoad = service.fullFixedFare && hasCapacityLimit ? physicalCapacityLoad : batch.totalLoad;
    batch.loadCopper = Math.max(0, Math.ceil(batch.billableLoad * loadRateCopper));
    // Kept as a comparison benchmark for legacy reports. Cargo value no longer
    // sets freight: it affects only customs and optional insurance.
    batch.valueFreightCopper = Math.max(1, Math.ceil(batch.subtotalCopper * freightRate));
    batch.operatingLegFactor = service.operatingLegFactor;
    batch.fullOneWayOperatingCopper = hasCapacityLimit
      ? fullOneWayOperatingCopper
      : routeFlatCopper + batch.loadCopper;
    // Rideshare pays its occupied share of a revenue-producing one-way service.
    // A charter reserves the whole vehicle and must also fund its return/repositioning.
    batch.operationalFreightCopper = Math.max(0, Math.ceil(batch.fullOneWayOperatingCopper * batch.capacityShare * batch.operatingLegFactor));
    batch.routeCopper = batch.operationalFreightCopper;
    batch.handlingCopper = Math.max(0, Math.ceil((handlingFlatCopper + batch.totalLoad * handlingLoadRateCopper) * deliveryFactor));
    batch.insuranceCopper = ownedVesselDelivery ? 0 : Math.max(0, Math.ceil(batch.subtotalCopper * insuranceRate));
    batch.taxCopper = Math.max(0, Math.ceil(batch.subtotalCopper * taxRate));
    batch.expressSurchargeCopper = service.surchargeRate > 0
      ? Math.max(1, Math.ceil((batch.routeCopper + batch.handlingCopper) * service.surchargeRate))
      : 0;
    batch.deliveryCopper = batch.routeCopper + batch.handlingCopper + batch.insuranceCopper + batch.taxCopper + batch.expressSurchargeCopper;
    batch.totalCopper = batch.subtotalCopper + batch.deliveryCopper;
    batch.deliveryQd = scheduled ? firstDeliveryQd + index * dispatchIntervalQd : 0;
    batch.riskProfile = ownedVesselDelivery
      ? { riskFactor: 1, lossChance: 0, delayChance: 0, maxDelayQd: 0, insuranceCoverageRate: 0, insuredValueCopper: batch.subtotalCopper, maximumInsurancePayoutCopper: 0 }
      : marketShipmentRiskProfile({ logistics, deliveryQd: batch.deliveryQd, subtotalCopper: batch.subtotalCopper, insuranceCopper: batch.insuranceCopper });
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
  const expressSurchargeCopper = sumBatch("expressSurchargeCopper");
  const deliveryCopper = sumBatch("deliveryCopper");
  const deliveryQd = batches.length ? Math.max(...batches.map((batch) => batch.deliveryQd)) : 0;
  const totalCopper = subtotalCopper + deliveryCopper;
  const treasuryCopper = Math.max(0, Math.floor(finiteNumber(holding?.storage?.moneyCopper, 0)));
  const riskLossChance = batches.length ? 1 - batches.reduce((chance, batch) => chance * (1 - batch.riskProfile.lossChance), 1) : 0;
  const riskDelayChance = batches.length ? 1 - batches.reduce((chance, batch) => chance * (1 - batch.riskProfile.delayChance), 1) : 0;
  const riskMaxDelayQd = batches.length ? Math.max(...batches.map((batch) => batch.riskProfile.maxDelayQd)) : 0;
  const maximumInsurancePayoutCopper = batches.reduce((sum, batch) => sum + batch.riskProfile.maximumInsurancePayoutCopper, 0);
  const merchantProviderIds = [...new Set(lines.map((line) => String(line.providerId ?? "")).filter(Boolean))];
  const finalBatch = batches.at(-1) ?? {};
  const finalBatchLoad = finalBatch.totalLoad ?? 0;
  const finalBatchCargoPoints = finalBatch.totalCargoPoints ?? 0;
  const finalBatchMassKg = finalBatch.totalMassKg ?? 0;
  const finalBatchVolumeL = finalBatch.totalVolumeL ?? 0;
  const finalBatchCapacityShare = hasCapacityLimit ? cargoCapacityShare(finalBatch, bookingCapacity, deps) : 0;
  const capacityRemainingLoad = bookingCapacityLoad > 0 ? Math.max(0, bookingCapacityLoad - finalBatchLoad) : 0;
  const capacityRemainingCargoPoints = bookingCapacityCargoPoints > 0 ? Math.max(0, bookingCapacityCargoPoints - finalBatchCargoPoints) : 0;
  const capacityUtilization = finalBatchCapacityShare;
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
    physicalCapacityCargoPoints,
    physicalCapacityMassKg,
    physicalCapacityVolumeL,
    bookingCapacityLoad,
    bookingCapacityCargoPoints,
    bookingCapacityMassKg,
    bookingCapacityVolumeL,
    capacityShare,
    freightRate,
    valueFreightCopper,
    valueFreightCharged: false,
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
    taxCopper,
    expressSurchargeCopper,
    deliveryCopper,
    subtotalCopper,
    ownedVesselDelivery,
    ownedVesselId: String(logistics?.ownedVesselId ?? ""),
    ownedPickupQd: Math.max(0, finiteNumber(logistics?.ownedPickupQd, 0)),
    ownedCargoQd: Math.max(0, finiteNumber(logistics?.ownedCargoQd, 0)),
    ownedHandlingQd: Math.max(0, finiteNumber(logistics?.ownedHandlingQd, 0)),
    ownedOperatingCostCopper: Math.max(0, Math.ceil(finiteNumber(logistics?.ownedOperatingCostCopper, 0))),
    ownedReplacementReserveCopper: Math.max(0, Math.ceil(finiteNumber(logistics?.ownedReplacementReserveCopper, 0)))
  };
  return {
    ok: lines.length > 0 && totalCopper > 0 && treasuryCopper >= totalCopper && logistics?.ok !== false && !capacityExceeded,
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
    ownedVesselDelivery,
    ownedVesselId: String(logistics?.ownedVesselId ?? ""),
    ownedVesselName: String(logistics?.ownedVesselName ?? ""),
    ownedPickupRegionId: String(logistics?.ownedPickupRegionId ?? ""),
    ownedPickupLabel: String(logistics?.ownedPickupLabel ?? ""),
    ownedDestinationRegionId: String(logistics?.ownedDestinationRegionId ?? ""),
    ownedDestinationLabel: String(logistics?.ownedDestinationLabel ?? ""),
    ownedPickupQd: Math.max(0, finiteNumber(logistics?.ownedPickupQd, 0)),
    ownedCargoQd: Math.max(0, finiteNumber(logistics?.ownedCargoQd, 0)),
    ownedHandlingQd: Math.max(0, finiteNumber(logistics?.ownedHandlingQd, 0)),
    ownedOperatingCostCopper: Math.max(0, Math.ceil(finiteNumber(logistics?.ownedOperatingCostCopper, 0))),
    ownedReplacementReserveCopper: Math.max(0, Math.ceil(finiteNumber(logistics?.ownedReplacementReserveCopper, 0))),
    merchantProviderIds,
    deliveryBreakdown,
    routeCopper,
    taxCopper,
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
    totalCargoPoints,
    totalMassKg,
    totalVolumeL,
    capacityLoad: physicalCapacityLoad,
    capacityCargoPoints: physicalCapacityCargoPoints,
    physicalCapacityLoad,
    physicalCapacityCargoPoints,
    physicalCapacityMassKg,
    physicalCapacityVolumeL,
    bookingCapacityLoad,
    bookingCapacityCargoPoints,
    bookingCapacityMassKg,
    bookingCapacityVolumeL,
    finalBatchLoad,
    finalBatchCargoPoints,
    finalBatchMassKg,
    finalBatchVolumeL,
    finalBatchCapacityShare,
    capacityRemainingLoad,
    capacityRemainingCargoPoints,
    capacityUtilization,
    totalCopper,
    treasuryCopper,
    balanceAfterCopper: treasuryCopper - totalCopper
  };
}
