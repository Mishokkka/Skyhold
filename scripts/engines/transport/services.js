import { stableDataHash } from "../../data/storage-commit.js";
import { transportLoad, transportInteger, transportHandlingTerms, TRANSPORT_LIMITS } from "./quantities.js";
import { referenceTransportCosts, regularTransportRate, transportPortCapacity, transportRationPrice, transportRiskBps, TRANSPORT_ECONOMICS } from "./economics.js";

export const TRANSPORT_SERVICE_DEFAULTS = Object.freeze({
  regularIntervalQd: 40, regularFirstQd: 4, charterVehicles: 1, charterPreparationQd: 1,
  commercialLoadBps: 6500, storageMilliCopperPerLoadQd: 0, insuranceBps: 0, insuranceCoverageBps: 8400,
  riskBps: 300, carrierProfitBps: TRANSPORT_ECONOMICS.profitBps
});

export function validateTransportConfiguration(raw = {}) {
  const config = { ...TRANSPORT_SERVICE_DEFAULTS, ...raw };
  for (const field of ["regularIntervalQd", "commercialLoadBps"]) transportInteger(config[field], field, 1, 10000);
  transportInteger(config.charterVehicles, "число машин", 1, TRANSPORT_LIMITS.vehicles);
  for (const field of ["regularFirstQd", "charterPreparationQd", "storageMilliCopperPerLoadQd", "insuranceBps", "insuranceCoverageBps", "riskBps"]) transportInteger(config[field], field, 0, 10000);
  if (config.commercialLoadBps > 10000) throw new Error("Коммерческая загрузка не может превышать 100%.");
  config.overrides ??= {};
  transportInteger(config.carrierProfitBps, "надбавка перевозчика", 0, 10000);
  return config;
}

/** Collapse transit-only nodes before rounding movement or charging dispatch. */
export function transportServicesFromRoutes(routes = [], rawConfiguration = {}, regions = [], { markets = [], resources = [], homeRegionId = "", homeEndpoint = "" } = {}) {
  const config = validateTransportConfiguration(rawConfiguration), result = new Map();
  const handling = new Map(markets.map(market => [market.regionId, market.locationProfile]));
  for (const route of routes) {
    const groups = [];
    for (const leg of route.transportPlan?.legs ?? []) {
      const source = regions.find((row) => row.value === leg.fromRegionId), destination = regions.find((row) => row.value === leg.toRegionId);
      const link = source?.marketLinks?.find((row) => row.regionId === leg.toRegionId && (!leg.routeId || row.routeId === leg.routeId))
        ?? destination?.marketLinks?.find((row) => row.regionId === leg.fromRegionId && (!leg.routeId || row.routeId === leg.routeId));
      const accessCost = leg.fromRegionId === leg.toRegionId ? 0 : Number(link?.ursCost ?? link?.accessCost ?? 1);
      const riskExposureQd = Number(leg.movementQd ?? 0) * Number(leg.riskFactor ?? 1);
      const previous = groups.at(-1);
      const same = previous && previous.mode === leg.mode && previous.carrierId === leg.carrierId
        && previous.toRegionId === leg.fromRegionId && leg.kind !== "last-mile"
        && (leg.carrierId !== "independent-carriers" || previous.fromCountryId === leg.fromCountryId);
      if (same) {
        previous.toRegionId = leg.toRegionId; previous.toLabel = leg.toLabel;
        previous.capacityLoad = Math.min(previous.capacityLoad, leg.capacityLoad);
        for (const field of ["movementQd", "distanceKm", "distanceCopper", "operatingCopper", "loadCopperPerUnit"]) previous[field] += Number(leg[field] ?? 0);
        previous.routeIds.push(leg.routeId);
        previous.accessCost += accessCost;
        previous.riskExposureQd += riskExposureQd;
        previous.operatingFactorSum += Number(leg.movementQd ?? 0) * Number(leg.operatingFactor ?? 1);
        previous.targetPriceFactor = leg.targetPriceFactor;
        previous.targetTimeFactor = leg.targetTimeFactor;
        previous.riskFactor = Math.max(previous.riskFactor ?? 1, leg.riskFactor ?? 1);
      } else groups.push({ ...leg, routeIds: [leg.routeId], accessCost, riskExposureQd,
        operatingFactorSum: Number(leg.movementQd ?? 0) * Number(leg.operatingFactor ?? 1) });
    }
    for (const [index, group] of groups.entries()) {
      const from = group.fromRegionId, to = group.toRegionId;
      // A local last mile is still a physical leg with two different endpoints.
      const outbound = route.transportPlan.direction === "outbound";
      const legacySource = from === to && outbound ? `${from}:holding` : from;
      const legacyDestination = from === to && !outbound ? `${to}:holding` : to;
      // Attach only the route's holding end. A transit/transfer port in the
      // same region stays a port; a direct flight already reaches the holding.
      const source = homeEndpoint && outbound && index === 0 && from === homeRegionId ? homeEndpoint : legacySource;
      const destination = homeEndpoint && !outbound && index === groups.length - 1 && to === homeRegionId ? homeEndpoint : legacyDestination;
      // Endpoint labels must not reset published schedules, fleet occupancy or overrides.
      const key = stableDataHash([legacySource, legacyDestination, group.mode, group.carrierId, group.routeIds]);
      const travelQd = Math.max(group.distanceKm === 0 ? 0 : 1, Math.ceil(group.movementQd));
      const port = (id, price, time) => ({ ...markets.find(row => row.regionId === id), factors: { price: price ?? 1, time: time ?? 1 } });
      const origin = port(from, group.sourcePriceFactor, group.sourceTimeFactor), target = port(to, group.targetPriceFactor, group.targetTimeFactor);
      const costsAt = (place, load = group.capacityLoad) => referenceTransportCosts(group.mode, load, resources.length ? transportRationPrice(resources, place) : 9).dailyCosts;
      const factor = group.movementQd > 0 ? group.operatingFactorSum / group.movementQd : Number(group.operatingFactor ?? 1);
      const scaled = costs => Object.fromEntries(Object.entries(costs).map(([key, value]) => [key, Math.ceil(value * factor)]));
      const dailyCosts = scaled(costsAt(origin)), returnDailyCosts = scaled(costsAt(target));
      const loadingCapacity = transportPortCapacity(origin), unloadingCapacity = transportPortCapacity(target);
      const capacity = transportLoad(group.capacityLoad);
      const loadingQd = Math.max(1, Math.ceil(capacity / loadingCapacity)), unloadingQd = Math.max(1, Math.ceil(capacity / unloadingCapacity));
      const dispatchCopper = Math.ceil(group.dispatchCopper + group.hireCopper + 2 * group.distanceCopper);
      const loadMilliCopper = Math.ceil(group.loadCopperPerUnit * 1000);
      const base = { from: source, to: destination, fromLabel: group.fromLabel, toLabel: group.toLabel, companyId: group.carrierId,
        ...transportHandlingTerms((from === to ? [from] : [from, to].filter(id => id !== homeRegionId)).map(id => handling.get(id))),
        label: `${group.carrierLabel} · ${group.modeLabel}`, mode: group.mode, visibility: group.visibility,
        capacity, travelQd, loadingQd, unloadingQd,
        profitBps: config.carrierProfitBps, storageIncluded: true, storageMilliCopperPerLoadQd: 0,
        riskBps: transportRiskBps(group.riskExposureQd, config.riskBps),
        distanceKm: group.distanceKm, accessCost: group.accessCost };
      const regular = { ...base, id: `regular:${key}`, kind: "regular", firstQd: config.regularFirstQd,
        intervalQd: config.regularIntervalQd, dispatchCopper: 1, returnQd: 0,
        loadMilliCopper: regularTransportRate({ capacityLoad: group.capacityLoad, travelQd, loadingQd, unloadingQd,
          dailyCosts, returnDailyCosts, fixedCopper: Math.ceil(group.dispatchCopper + group.hireCopper + group.distanceCopper),
          loadMilliCopper, commercialLoadBps: config.commercialLoadBps }) };
      const charter = { ...base, id: `charter:${key}`, kind: "charter", firstQd: 0, loadingCapacity, unloadingCapacity,
        preparationQd: config.charterPreparationQd,
        vehicles: config.charterVehicles, returnQd: travelQd,
        dispatchCopper, dailyCosts, returnDailyCosts, loadMilliCopper };
      for (const service of [regular, charter]) {
        const override = config.overrides[service.id] ?? {};
        let resized = service;
        if (override.capacity !== undefined && override.capacity !== capacity) {
          transportInteger(override.capacity, "вместимость услуги", 1);
          const load = override.capacity / 4000;
          const costs = scaled(costsAt(origin, load)), back = scaled(costsAt(target, load));
          const loading = Math.max(1, Math.ceil(override.capacity / loadingCapacity)), unloading = Math.max(1, Math.ceil(override.capacity / unloadingCapacity));
          resized = { ...service, loadingQd: loading, unloadingQd: unloading,
            ...(service.kind === "charter" ? { dailyCosts: costs, returnDailyCosts: back } : {
              loadMilliCopper: regularTransportRate({ capacityLoad: load, travelQd, loadingQd: loading, unloadingQd: unloading,
                dailyCosts: costs, returnDailyCosts: back, fixedCopper: Math.ceil(group.dispatchCopper + group.hireCopper + group.distanceCopper),
                loadMilliCopper, commercialLoadBps: config.commercialLoadBps }) }) };
        }
        const applied = { ...resized, ...override, id: service.id, from: service.from, to: service.to, kind: service.kind, companyId: service.companyId,
          storageIncluded: true, storageMilliCopperPerLoadQd: 0, storageCopperPerLoadQd: 0 };
        if (service.kind === "regular" && !Object.hasOwn(override, "loadMilliCopper") && !Object.hasOwn(override, "loadCopper")) {
          applied.loadMilliCopper = regularTransportRate({ capacityLoad: applied.capacity / 4000,
            travelQd: applied.travelQd, loadingQd: applied.loadingQd, unloadingQd: applied.unloadingQd,
            dailyCosts: scaled(costsAt(origin, applied.capacity / 4000)), returnDailyCosts: scaled(costsAt(target, applied.capacity / 4000)),
            fixedCopper: Math.ceil(group.dispatchCopper + group.hireCopper + group.distanceCopper),
            loadMilliCopper, commercialLoadBps: config.commercialLoadBps });
        }
        if (Object.hasOwn(override, "loadCopper") && !Object.hasOwn(override, "loadMilliCopper")) delete applied.loadMilliCopper;
        if (service.kind === "charter" && Object.hasOwn(override, "travelQd") && !Object.hasOwn(override, "returnQd")) applied.returnQd = applied.travelQd;
        // Existing explicit price overrides remain authoritative over the new norm.
        if (Object.hasOwn(override, "operatingMilliCopperPerQd") || Object.hasOwn(override, "operatingCopperPerQd")) {
          delete applied.dailyCosts; delete applied.returnDailyCosts;
        }
        if (Object.hasOwn(override, "returnOperatingMilliCopperPerQd")) delete applied.returnDailyCosts;
        if (Object.hasOwn(override, "loadingQd")) delete applied.loadingCapacity;
        if (Object.hasOwn(override, "unloadingQd")) delete applied.unloadingCapacity;
        result.set(service.id, applied);
      }
    }
  }
  return [...result.values()];
}
