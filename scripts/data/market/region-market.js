function normalized(value = "") {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("ru");
}

function finiteFactor(value, fallback = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MARKET_STATUS_FACTORS = {
  thriving: { price: 0.95, availability: 1.2, delivery: 0.9, time: 0.9, risk: 0.8, export: 1.2, import: 1.1 },
  stable: { price: 1, availability: 1, delivery: 1, time: 1, risk: 1, export: 1, import: 1 },
  strained: { price: 1.08, availability: 0.85, delivery: 1.15, time: 1.2, risk: 1.25, export: 0.9, import: 1.1 },
  disrupted: { price: 1.2, availability: 0.55, delivery: 1.4, time: 1.5, risk: 1.6, export: 0.55, import: 1.25 },
  ruined: { price: 1.45, availability: 0.25, delivery: 1.8, time: 2, risk: 2.2, export: 0.25, import: 1.5 },
  blockaded: { price: 1.6, availability: 0.15, delivery: 2.2, time: 2.5, risk: 3, export: 0.1, import: 1.75 }
};

export function marketRegionFactors(region = {}) {
  const status = MARKET_STATUS_FACTORS[String(region?.marketStatus ?? "stable")] ?? MARKET_STATUS_FACTORS.stable;
  return {
    status: String(region?.marketStatus ?? "stable"),
    enabled: region?.marketEnabled !== false,
    price: status.price * finiteFactor(region?.marketPriceFactor),
    availability: status.availability * finiteFactor(region?.marketAvailabilityFactor),
    delivery: status.delivery * finiteFactor(region?.marketDeliveryFactor),
    time: status.time * finiteFactor(region?.marketTimeFactor),
    risk: status.risk * finiteFactor(region?.marketRiskFactor),
    export: status.export * finiteFactor(region?.marketExportFactor),
    import: status.import * finiteFactor(region?.marketImportFactor),
    taxRate: Math.max(0, Math.min(1, Number(region?.marketTaxRate) || 0))
  };
}

export function marketRegionForValue(value = "", regionOptions = []) {
  const current = normalized(value);
  if (!current) return null;
  return (regionOptions ?? []).find((row) => [row?.value, row?.label, ...(row?.aliases ?? [])]
    .some((candidate) => normalized(candidate) === current)) ?? null;
}

export function marketRegionForHolding(holding = {}, regionOptions = []) {
  return marketRegionForValue(holding?.overview?.region, regionOptions);
}

export function marketLocationForHolding({ holding = {}, regionOptions = [], profiles = [], fallbackLocation = null } = {}) {
  const region = marketRegionForHolding(holding, regionOptions);
  if (!region) return null;
  const explicitProfileId = String(region.marketProfile ?? "").trim();
  const hasFactors = [region.marketPriceFactor, region.marketAvailabilityFactor, region.marketDeliveryFactor, region.marketTimeFactor, region.marketRiskFactor, region.marketExportFactor, region.marketImportFactor, region.marketTaxRate]
    .some((value) => value !== undefined && value !== null && value !== "");
  const hasState = String(region.marketStatus ?? "stable") !== "stable" || region.marketEnabled === false;
  if (!explicitProfileId && !hasFactors && !hasState) return null;

  const base = (profiles ?? []).find((profile) => profile.id === explicitProfileId)
    ?? fallbackLocation
    ?? (profiles ?? []).find((profile) => profile.id === "standard")
    ?? {};
  const priceFactor = finiteFactor(region.marketPriceFactor);
  const availabilityFactor = finiteFactor(region.marketAvailabilityFactor);
  const deliveryFactor = finiteFactor(region.marketDeliveryFactor);
  const factors = marketRegionFactors(region);
  return {
    ...base,
    id: `region:${String(region.value ?? "unknown")}:${String(base.id ?? "standard")}`,
    label: `${String(region.label ?? region.value ?? "Регион")} · ${String(base.label ?? "Обычный маршрут")}`,
    priceFactor: finiteFactor(base.priceFactor) * priceFactor * (factors.price / finiteFactor(region.marketPriceFactor)) * factors.import,
    availabilityFactor: finiteFactor(base.availabilityFactor) * availabilityFactor * (factors.availability / finiteFactor(region.marketAvailabilityFactor)),
    deliveryFlatCopper: Math.max(0, finiteFactor(base.deliveryFlatCopper, 0) * deliveryFactor * (factors.delivery / finiteFactor(region.marketDeliveryFactor))),
    deliverySubtotalRate: Math.max(0, finiteFactor(base.deliverySubtotalRate, 0)),
    deliveryLoadCopper: Math.max(0, finiteFactor(base.deliveryLoadCopper, 0) * deliveryFactor * (factors.delivery / finiteFactor(region.marketDeliveryFactor))),
    deliveryQdFactor: finiteFactor(base.deliveryQdFactor) * factors.time,
    marketRiskFactor: factors.risk,
    marketTaxRate: factors.taxRate,
    marketEnabled: factors.enabled,
    marketStatus: factors.status
  };
}
