import { marketRandomUnit } from "./pricing.js";

const INDEPENDENT_MERCHANT_ID = "independent-merchants";
const INDEPENDENT_CARRIER_ID = "independent-carriers";
const MERCHANT_QUOTE_FACTOR_MIN = 0.75;
const MERCHANT_QUOTE_FACTOR_MAX = 1.25;
const MERCHANT_VOLATILITY_MAX = 0.1;

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bounded(value, fallback, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, finite(value, fallback)));
}

function normalized(value = "") {
  return String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase("ru");
}

function tagMatches(tag = "", selector = "") {
  const candidate = normalized(tag);
  const target = normalized(selector);
  if (!candidate || !target) return false;
  if (target === "all") return true;
  return candidate === target || candidate.startsWith(`${target}.`) || candidate.startsWith(`${target}-`) || candidate.includes(target);
}

function shareRow(organization = {}, role = "merchant", countryId = "") {
  return (organization?.[role]?.countryShares ?? []).find((row) => row.active !== false && String(row.countryId ?? "") === String(countryId ?? "")) ?? null;
}

function carrierShare(row = {}, transportMode = "", routeModes = []) {
  const modeShares = row?.modeShares ?? {};
  const modes = transportMode === "multimodal" ? [...new Set(routeModes)] : [transportMode].filter(Boolean);
  const explicit = modes.map((mode) => modeShares[mode]).filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)));
  return explicit.length ? Math.min(...explicit.map(Number)) : Math.max(0, finite(row?.sharePct, 0));
}

function normalizedShares(providers = [], independentLabel = "Независимые торговцы") {
  const total = providers.reduce((sum, row) => sum + Math.max(0, finite(row.sharePct, 0)), 0);
  const scale = total > 100 ? 100 / total : 1;
  const normalizedProviders = providers.map((row) => ({ ...row, sharePct: Math.max(0, finite(row.sharePct, 0)) * scale }));
  const independentShare = Math.max(0, 100 - normalizedProviders.reduce((sum, row) => sum + row.sharePct, 0));
  if (independentShare > 0 || !normalizedProviders.length) normalizedProviders.push({
    id: independentLabel === "Независимые перевозчики" ? INDEPENDENT_CARRIER_ID : INDEPENDENT_MERCHANT_ID,
    label: independentLabel,
    independent: true,
    sharePct: normalizedProviders.length ? independentShare : 100,
    priceFactor: 1,
    priceVolatility: independentLabel === "Независимые перевозчики" ? 0 : 0.08,
    stockStability: 0.82,
    timeFactor: 1,
    riskFactor: independentLabel === "Независимые перевозчики" ? 1.08 : 1,
    capacityFactor: 1
  });
  return normalizedProviders;
}

export function merchantProvidersForCountry({ organizations = [], countryId = "", isGM = false } = {}) {
  const providers = [];
  for (const organization of organizations ?? []) {
    if (organization?.active === false || !organization?.merchant?.enabled || (!isGM && organization.visibility === "gm")) continue;
    const presence = shareRow(organization, "merchant", countryId);
    if (!presence || !(finite(presence.sharePct, 0) > 0)) continue;
    providers.push({
      id: String(organization.id ?? ""),
      label: String(organization.label ?? organization.id ?? "Торговая организация"),
      icon: String(organization.icon ?? "fa-solid fa-building-columns"),
      independent: false,
      sharePct: finite(presence.sharePct, 0),
      includeTags: organization.merchant.includeTags ?? [],
      excludeTags: organization.merchant.excludeTags ?? [],
      priceFactor: bounded(organization.merchant.priceFactor, 1, MERCHANT_QUOTE_FACTOR_MIN, MERCHANT_QUOTE_FACTOR_MAX),
      priceVolatility: bounded(organization.merchant.priceVolatility, 0.04, 0, MERCHANT_VOLATILITY_MAX),
      stockStability: Math.max(0.25, finite(organization.merchant.stockStability, 1))
    });
  }
  return normalizedShares(providers, "Независимые торговцы");
}

function providerEligible(provider = {}, offer = {}) {
  if (provider.independent) return true;
  const tags = offer.tags ?? [];
  if ((provider.excludeTags ?? []).some((selector) => tags.some((tag) => tagMatches(tag, selector)))) return false;
  const include = provider.includeTags ?? [];
  return !include.length || include.some((selector) => tags.some((tag) => tagMatches(tag, selector)));
}

function allocationRows(stock = 0, providers = [], seed = "") {
  const totalStock = Math.max(0, Math.floor(finite(stock, 0)));
  if (!totalStock) return [];
  const rows = providers.map((provider) => {
    const stability = Math.max(0.25, finite(provider.stockStability, 1));
    const noiseRange = Math.max(0, Math.min(0.35, (1 / stability) * 0.08));
    const noise = 1 + ((marketRandomUnit(`${seed}|${provider.id}|share`) * 2) - 1) * noiseRange;
    return { provider, weight: Math.max(0, finite(provider.sharePct, 0) * noise) };
  });
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0) || 1;
  const allocations = rows.map((row) => {
    const exact = totalStock * row.weight / totalWeight;
    return { ...row, exact, qty: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = totalStock - allocations.reduce((sum, row) => sum + row.qty, 0);
  allocations.sort((a, b) => b.remainder - a.remainder || b.weight - a.weight || a.provider.id.localeCompare(b.provider.id));
  for (let index = 0; remaining > 0 && allocations.length; index = (index + 1) % allocations.length) {
    allocations[index].qty += 1;
    remaining -= 1;
  }
  return allocations.filter((row) => row.qty > 0);
}

export function allocateQuoteToMerchantProviders({ offers = [], organizations = [], countryId = "", quoteKey = "", isGM = false } = {}) {
  const providers = merchantProvidersForCountry({ organizations, countryId, isGM });
  const result = [];
  for (const offer of offers ?? []) {
    const eligibleCompanies = providers.filter((provider) => providerEligible(provider, offer));
    const excludedShare = providers.filter((provider) => !providerEligible(provider, offer)).reduce((sum, row) => sum + row.sharePct, 0);
    let eligible = eligibleCompanies.map((row) => ({ ...row }));
    if (excludedShare > 0) {
      const independent = eligible.find((row) => row.independent);
      if (independent) independent.sharePct += excludedShare;
      else eligible.push({ id: INDEPENDENT_MERCHANT_ID, label: "Независимые торговцы", independent: true, sharePct: excludedShare, priceFactor: 1, priceVolatility: 0.08, stockStability: 0.82 });
    }
    if (!eligible.length) eligible = [{ id: INDEPENDENT_MERCHANT_ID, label: "Независимые торговцы", independent: true, sharePct: 100, priceFactor: 1, priceVolatility: 0.08, stockStability: 0.82 }];
    const allocations = allocationRows(offer.stock, eligible, `${quoteKey}|${offer.id}`);
    for (const allocation of allocations) {
      const provider = allocation.provider;
      const variation = 1 + ((marketRandomUnit(`${quoteKey}|${offer.id}|${provider.id}|price`) * 2) - 1)
        * Math.max(0, finite(provider.priceVolatility, 0));
      const providerFactor = bounded(
        finite(provider.priceFactor, 1) * variation,
        1,
        MERCHANT_QUOTE_FACTOR_MIN,
        MERCHANT_QUOTE_FACTOR_MAX
      );
      const baseAskCopper = Math.max(1, Math.round(finite(offer.unitPriceCopper ?? offer.askUnitCopper, 1)));
      const bidFloorCopper = Math.max(0, Math.floor(finite(offer.bidUnitCopper ?? offer.bidCopper, 0)));
      const unitPriceCopper = Math.max(bidFloorCopper + 1, Math.round(baseAskCopper * providerFactor));
      const effectiveProviderFactor = unitPriceCopper / baseAskCopper;
      const movementPercent = Math.round(((1 + finite(offer.movementPercent, 0) / 100) * effectiveProviderFactor - 1) * 100);
      result.push({
        ...offer,
        id: `${offer.id}::merchant:${provider.id}`,
        sourceOfferId: String(offer.sourceOfferId ?? offer.id ?? ""),
        providerId: provider.id,
        providerLabel: provider.label,
        providerIcon: provider.icon ?? (provider.independent ? "fa-solid fa-user-group" : "fa-solid fa-building-columns"),
        providerIndependent: Boolean(provider.independent),
        providerSharePct: provider.sharePct,
        origin: provider.label,
        stock: allocation.qty,
        unitPriceCopper,
        movementPercent,
        movementClass: movementPercent > 1 ? "up" : (movementPercent < -1 ? "down" : "stable")
      });
    }
  }
  return { offers: result, providers };
}

function carrierSupports(carrier = {}, transportMode = "", routeModes = []) {
  if (carrier.independent) return true;
  const modes = new Set(carrier.modes ?? []);
  if (transportMode === "multimodal") return [...new Set(routeModes)].every((mode) => modes.has(mode));
  return !transportMode || modes.has(transportMode);
}

export function carrierProvidersForRoute({ organizations = [], countryId = "", transportMode = "", routeModes = [], isGM = false } = {}) {
  const providers = [];
  for (const organization of organizations ?? []) {
    if (organization?.active === false || !organization?.carrier?.enabled || (!isGM && organization.visibility === "gm")) continue;
    const presence = shareRow(organization, "carrier", countryId);
    if (!presence) continue;
    const candidate = {
      id: String(organization.id ?? ""),
      label: String(organization.label ?? organization.id ?? "Транспортная организация"),
      icon: String(organization.icon ?? "fa-solid fa-truck-fast"),
      independent: false,
      modes: organization.carrier.modes ?? [],
      sharePct: carrierShare(presence, transportMode, routeModes),
      priceFactor: Math.max(0.5, finite(organization.carrier.priceFactor, 1)),
      timeFactor: Math.max(0.5, finite(organization.carrier.timeFactor, 1)),
      riskFactor: Math.max(0.25, finite(organization.carrier.riskFactor, 1)),
      capacityFactor: Math.max(0.1, finite(organization.carrier.capacityFactor, 1))
    };
    if (candidate.sharePct > 0 && carrierSupports(candidate, transportMode, routeModes)) providers.push(candidate);
  }
  return normalizedShares(providers, "Независимые перевозчики")
    .filter((carrier) => carrierSupports(carrier, transportMode, routeModes))
    .sort((a, b) => a.priceFactor - b.priceFactor || b.sharePct - a.sharePct || a.label.localeCompare(b.label, "ru"));
}

export function carrierCapacityForLogistics(logistics = {}, carrier = null) {
  const baseCapacityLoad = Math.max(0, finite(logistics?.baseCapacityLoad ?? logistics?.capacityLoad, 0));
  const baseCapacityMassKg = Math.max(0, finite(logistics?.baseCapacityMassKg ?? logistics?.capacityMassKg, baseCapacityLoad * 10));
  const baseCapacityVolumeL = Math.max(0, finite(logistics?.baseCapacityVolumeL ?? logistics?.capacityVolumeL, baseCapacityLoad * 20));
  const capacityFactor = Math.max(0.1, finite(carrier?.capacityFactor, 1));
  return {
    baseCapacityLoad,
    baseCapacityMassKg,
    baseCapacityVolumeL,
    capacityFactor,
    capacityLoad: baseCapacityLoad > 0 ? baseCapacityLoad * capacityFactor : 0,
    capacityMassKg: baseCapacityMassKg > 0 ? baseCapacityMassKg * capacityFactor : 0,
    capacityVolumeL: baseCapacityVolumeL > 0 ? baseCapacityVolumeL * capacityFactor : 0
  };
}

export function applyCarrierToLogistics(logistics = {}, carrier = null) {
  const capacity = carrierCapacityForLogistics(logistics, carrier);
  if (!carrier) return {
    ...logistics,
    carrierId: "",
    carrierLabel: "",
    carrierCapacityFactor: capacity.capacityFactor,
    capacityLoad: capacity.capacityLoad,
    capacityMassKg: capacity.capacityMassKg,
    capacityVolumeL: capacity.capacityVolumeL
  };
  const priceFactor = Math.max(0.5, finite(carrier.priceFactor, 1));
  const timeFactor = Math.max(0.5, finite(carrier.timeFactor, 1));
  const riskFactor = Math.max(0.25, finite(carrier.riskFactor, 1));
  return {
    ...logistics,
    carrierId: String(carrier.id ?? ""),
    carrierLabel: String(carrier.label ?? "Перевозчик"),
    carrierSharePct: Math.max(0, finite(carrier.sharePct, 0)),
    carrierPriceFactor: priceFactor,
    carrierTimeFactor: timeFactor,
    carrierRiskFactor: riskFactor,
    carrierCapacityFactor: capacity.capacityFactor,
    capacityLoad: capacity.capacityLoad,
    capacityMassKg: capacity.capacityMassKg,
    capacityVolumeL: capacity.capacityVolumeL,
    distanceFlatCopper: Math.max(0, Math.ceil(finite(logistics.distanceFlatCopper, 0) * priceFactor)),
    distanceLoadCopper: Math.max(0, finite(logistics.distanceLoadCopper, 0) * priceFactor),
    operatingTimeCopper: Math.max(0, Math.ceil(finite(logistics.operatingTimeCopper, 0) * priceFactor)),
    airshipHireCopper: Math.max(0, Math.ceil(finite(logistics.airshipHireCopper, 0) * priceFactor)),
    travelQd: Math.max(0, Math.ceil(finite(logistics.travelQd, 0) * timeFactor)),
    riskFactor: Math.max(0.01, finite(logistics.riskFactor, 1) * riskFactor),
    transportLabel: `${String(logistics.transportLabel ?? "Маршрут")} · ${String(carrier.label ?? "Перевозчик")}`
  };
}

export const MARKET_INDEPENDENT_PROVIDER_IDS = Object.freeze({ merchant: INDEPENDENT_MERCHANT_ID, carrier: INDEPENDENT_CARRIER_ID });
