import { politicsRuntimeEffects } from "../politics/runtime-effects.js";
import { marketTransportRoutes } from "./route-candidates.js";

export const MARKET_TRANSPORT_TARIFFS = Object.freeze({
  caravan: Object.freeze({ label: "Наземный караван", dispatchCopper: 6, distanceCopper: 2, loadDistanceCopper: 1, operatingCopperPerQd: 0, qdPerDistance: 4 }),
  rail: Object.freeze({ label: "Железная дорога", dispatchCopper: 12, distanceCopper: 3, loadDistanceCopper: 0.15, operatingCopperPerQd: 0, qdPerDistance: 1 }),
  // The marginal mass rate follows bulk sea freight. The time-based component
  // pays the airship premium that a small dedicated vessel cannot recover from
  // a large liner's ton-mile rate: crew, upkeep, lift system and capital wear.
  airship: Object.freeze({ label: "Наёмный воздушный корабль", dispatchCopper: 20, distanceCopper: 5, loadDistanceCopper: 0.02, operatingCopperPerQd: 20, qdPerDistance: 1.5 })
});

const TRANSPORT = MARKET_TRANSPORT_TARIFFS;
const KM_PER_ROUTE_UNIT = 40;
const MARKET_SEASON_IDS = new Set(["spring", "summer", "autumn", "winter"]);

export const MARKET_DEFAULT_TRANSPORT_CAPACITY_LOAD = Object.freeze({
  caravan: 400,
  rail: 8000,
  airship: 4000
});

const MARKET_TRANSPORT_CAPACITY_FIELDS = Object.freeze({
  caravan: "caravanCapacityLoad",
  rail: "railCapacityLoad",
  airship: "airshipCapacityLoad"
});

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalized(value = "") {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("ru");
}

function normalizedSeasonId(value = "") {
  const season = normalized(value);
  if (MARKET_SEASON_IDS.has(season)) return season;
  if (/весн/.test(season)) return "spring";
  if (/лет|summer/.test(season)) return "summer";
  if (/осен|autumn|fall/.test(season)) return "autumn";
  if (/зим|winter/.test(season)) return "winter";
  return "";
}

function marketRouteCapacityLoad(market = {}, modes = []) {
  const capacities = [...new Set(modes)]
    .map((mode) => {
      const field = MARKET_TRANSPORT_CAPACITY_FIELDS[mode];
      if (!field) return null;
      return Math.max(1, finite(market?.[field], MARKET_DEFAULT_TRANSPORT_CAPACITY_LOAD[mode]));
    })
    .filter((value) => Number.isFinite(value));
  return capacities.length ? Math.min(...capacities) : 0;
}

function edgeSeasonalModifier(edge = {}, seasonId = "") {
  const id = normalizedSeasonId(seasonId);
  const row = id ? edge?.seasonalModifiers?.[id] : null;
  if (!row?.enabled) return { active: false, seasonId: id, costFactor: 1, timeFactor: 1, riskFactor: 1 };
  return {
    active: true,
    seasonId: id,
    costFactor: Math.max(0.25, Math.min(4, finite(row.costFactor, 1))),
    timeFactor: Math.max(0.25, Math.min(4, finite(row.timeFactor, 1))),
    riskFactor: Math.max(0.25, Math.min(4, finite(row.riskFactor, 1)))
  };
}

function findRegion(regionId = "", regions = [], resolver = null) {
  if (typeof resolver === "function") return resolver(regionId, regions);
  const current = normalized(regionId);
  if (!current) return null;
  return (regions ?? []).find((region) => [region?.value, region?.label, ...(region?.aliases ?? [])].some((candidate) => normalized(candidate) === current)) ?? null;
}

function findHoldingRegion(holding = {}, regions = [], resolver = null) {
  return findRegion(holding?.overview?.region, regions, resolver);
}

function routeGraph(regions = []) {
  const graph = new Map();
  const seen = new Set();
  const ensure = (id) => {
    if (!graph.has(id)) graph.set(id, []);
    return graph.get(id);
  };
  for (const region of regions ?? []) {
    const from = String(region?.value ?? "").trim();
    if (!from) continue;
    ensure(from);
    for (const link of region?.marketLinks ?? []) {
      const to = String(link?.regionId ?? "").trim();
      if (!to || to === from) continue;
      const routeId = String(link?.routeId ?? "").trim().slice(0, 128);
      const key = `${[from, to].sort().join("::")}\u0000${routeId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const distanceKm = Math.max(1, finite(link?.distanceKm, KM_PER_ROUTE_UNIT));
      const edge = {
        to,
        routeId,
        ursCost: Math.min(99, Math.max(1, Math.floor(finite(link?.ursCost ?? link?.accessCost, 1)))),
        distanceKm,
        distance: distanceKm / KM_PER_ROUTE_UNIT,
        modes: Array.isArray(link?.modes) ? link.modes : [],
        seasonalModifiers: link?.seasonalModifiers && typeof link.seasonalModifiers === "object" ? link.seasonalModifiers : {}
      };
      ensure(from).push(edge);
      ensure(to).push({ ...edge, to: from });
    }
  }
  return graph;
}

export function marketRegionAccessCostMap({ holding = {}, regions = [], dependencies = {} } = {}) {
  const destination = findHoldingRegion(holding, regions, dependencies.regionResolver);
  const costs = new Map();
  const start = String(destination?.value ?? "").trim();
  if (!start) return costs;
  const graph = routeGraph(regions);
  const visited = new Set();
  costs.set(start, 0);
  while (true) {
    let current = "";
    let currentCost = Infinity;
    for (const [regionId, cost] of costs) {
      if (!visited.has(regionId) && cost < currentCost) {
        current = regionId;
        currentCost = cost;
      }
    }
    if (!current) break;
    visited.add(current);
    for (const edge of graph.get(current) ?? []) {
      const nextCost = currentCost + edge.ursCost;
      if (nextCost >= (costs.get(edge.to) ?? Infinity)) continue;
      costs.set(edge.to, nextCost);
    }
  }
  return costs;
}

export function shortestMarketRouteDistanceKm(fromId = "", toId = "", regions = [], { mode = "" } = {}) {
  return shortestMarketRoute(fromId, toId, regions, { mode })?.distanceKm ?? null;
}

export function shortestMarketRoute(fromId = "", toId = "", regions = [], { mode = "", allowedModes = [], metric = "distance" } = {}) {
  const from = String(fromId ?? "").trim();
  const to = String(toId ?? "").trim();
  if (!from || !to) return null;
  if (from === to) return { distance: 0.5, distanceKm: KM_PER_ROUTE_UNIT / 2, hops: 0, accessCost: 0, path: [from], edges: [] };
  const graph = routeGraph(regions);
  const routes = new Map([[from, { score: 0, distance: 0, distanceKm: 0, hops: 0, accessCost: 0, path: [from], edges: [] }]]);
  const visited = new Set();
  while (true) {
    let current = "";
    let currentRoute = null;
    for (const [id, route] of routes) {
      if (visited.has(id)) continue;
      if (!currentRoute || route.score < currentRoute.score || (route.score === currentRoute.score && route.distanceKm < currentRoute.distanceKm)) {
        current = id;
        currentRoute = route;
      }
    }
    if (!current) break;
    if (current === to) return currentRoute;
    visited.add(current);
    for (const edge of graph.get(current) ?? []) {
      if (mode && edge.modes?.length && !edge.modes.includes(mode)) continue;
      if (allowedModes.length && edge.modes?.length && !edge.modes.some((candidate) => allowedModes.includes(candidate))) continue;
      const distanceKm = currentRoute.distanceKm + edge.distanceKm;
      const distance = distanceKm / KM_PER_ROUTE_UNIT;
      const hops = currentRoute.hops + 1;
      const accessCost = currentRoute.accessCost + edge.ursCost;
      const score = metric === "hops" ? hops : (metric === "access" ? accessCost : distanceKm);
      const previous = routes.get(edge.to);
      if (previous && (previous.score < score || (previous.score === score && previous.distanceKm <= distanceKm))) continue;
      routes.set(edge.to, {
        score,
        distance,
        distanceKm,
        hops,
        accessCost,
        path: [...currentRoute.path, edge.to],
        edges: [...currentRoute.edges, { from: current, ...edge, ...(mode ? { selectedMode: mode } : {}) }]
      });
    }
  }
  return null;
}

export function holdingMarketAccessLevel(holding = {}, { politicsMarketAccess = null } = {}) {
  const manual = holding?.gm?.modifiers?.marketConnectionsLevel;
  const legacy = holding?.special?.market?.accessLevelOverride;
  const politics = politicsMarketAccess ?? politicsRuntimeEffects(holding)?.marketAccess ?? 0;
  const level = Math.max(0, Math.floor(finite(manual, finite(legacy, 1)) + politics));
  return { level, source: politics ? "GM · УРС + Политика" : "GM · УРС" };
}

function logisticsRegionFactors(region = {}, resolver = null) {
  const factors = typeof resolver === "function" ? resolver(region) : {};
  const importFactor = Math.max(0, finite(factors.import, 1));
  const priceFactor = Math.max(0.01, finite(factors.price, 1));
  return {
    enabled: factors.enabled ?? region?.marketEnabled !== false,
    price: priceFactor,
    buyPrice: priceFactor * importFactor,
    demand: importFactor,
    stock: Math.max(0, finite(factors.availability, 1) * finite(factors.export, 1)),
    delivery: Math.max(0.01, finite(factors.delivery, 1)),
    time: Math.max(0.01, finite(factors.time, 1)),
    risk: Math.max(0.01, finite(factors.risk, 1)),
    taxRate: Math.max(0, Math.min(1, finite(factors.taxRate ?? region?.marketTaxRate, 0))),
    exportTaxRate: Math.max(0, Math.min(1, finite(factors.exportTaxRate, 0)))
  };
}

export function resolveMarketLogistics({ holding = {}, market = {}, regions = [], seasonId = "", dependencies = {},
  direction = "inbound", selectedRoute = null, singleRoute = false, accessLevel = null } = {}) {
  const destination = findHoldingRegion(holding, regions, dependencies.regionResolver);
  const origin = findRegion(market.regionId, regions, dependencies.regionResolver);
  const sameRegion = Boolean(origin && destination && origin.value === destination.value);
  const crossLandmass = Boolean(origin?.marketLandmassId && destination?.marketLandmassId && origin.marketLandmassId !== destination.marketLandmassId);
  const marketModes = new Set(Array.isArray(market.transportModes) ? market.transportModes : ["caravan", "rail", "airship"]);
  const destinationModes = new Set(destination?.marketTransportModes ?? ["caravan", "airship"]);
  const originModes = new Set(origin?.marketTransportModes ?? ["caravan", "airship"]);
  const airshipRequired = holding?.type === "sky-island" || holding?.type === "ship" || crossLandmass || destination?.marketAirshipOnly || origin?.marketAirshipOnly;
  const routeRequired = Boolean(origin && destination && !sameRegion);
  const access = Number.isFinite(accessLevel) ? { level: Math.max(0, Math.floor(accessLevel)), source: "УРС с действующими политическими источниками" } : holdingMarketAccessLevel(holding);
  const byId = new Map(regions.map((region) => [String(region.value), region]));
  const modesForEdge = (fromId, edge) => {
    const fromRegion = byId.get(fromId), toRegion = byId.get(edge.to);
    const mustFly = fromRegion?.marketAirshipOnly || toRegion?.marketAirshipOnly
      || (fromRegion?.marketLandmassId && toRegion?.marketLandmassId && fromRegion.marketLandmassId !== toRegion.marketLandmassId);
    // A supplier controls its terminal leg. Carriers can change at intermediate ports.
    const atMarket = fromId === origin?.value || edge.to === origin?.value;
    return (edge.modes?.length ? edge.modes : Object.keys(TRANSPORT)).filter((mode) => TRANSPORT[mode]
      && (!atMarket || marketModes.has(mode)) && (!mustFly || mode === "airship")
      && (!fromRegion?.marketTransportModes || fromRegion.marketTransportModes.includes(mode))
      && (!toRegion?.marketTransportModes || toRegion.marketTransportModes.includes(mode)));
  };
  const search = selectedRoute || !routeRequired ? { routes: [], limited: false } : marketTransportRoutes({
    graph: routeGraph(regions), from: destination.value, to: origin.value, maxAccess: access.level,
    modesForEdge,
    termsForEdge: (edge, transport) => {
      const terms = TRANSPORT[transport];
      const seasonal = edgeSeasonalModifier(edge, seasonId);
      return { flat: edge.distance * terms.distanceCopper * seasonal.costFactor,
        load: edge.distance * terms.loadDistanceCopper * seasonal.costFactor,
        time: edge.distance * terms.qdPerDistance * seasonal.timeFactor,
        operating: edge.distance * terms.qdPerDistance * seasonal.timeFactor * terms.operatingCopperPerQd,
        risk: seasonal.riskFactor };
    }
  });
  const graphRoute = selectedRoute ?? search.routes.sort((a, b) => a.accessCost - b.accessCost || a.distanceKm - b.distanceKm
    || a.time - b.time || a.mask - b.mask)[0] ?? null;
  const routeModes = (graphRoute?.edges ?? []).map((edge, index) => {
    if (edge.selectedMode) return edge.selectedMode;
    const candidates = modesForEdge(edge.from ?? graphRoute.path[index], edge);
    if (candidates.includes("rail")) return "rail";
    if (candidates.includes("caravan")) return "caravan";
    return candidates.includes("airship") ? "airship" : "";
  }).filter(Boolean);
  const needsAerialDelivery = ["sky-island", "ship"].includes(String(holding?.type ?? ""));
  const holdingLegUsesAirship = routeModes[0] === "airship";
  // An air leg elsewhere cannot deliver directly to a floating holding.
  const airshipLastMile = needsAerialDelivery && !holdingLegUsesAirship
    && marketModes.has("airship") && destinationModes.has("airship");
  const airshipAvailable = needsAerialDelivery ? holdingLegUsesAirship || airshipLastMile
    : marketModes.has("airship") || routeModes.includes("airship");
  const usedModes = [...new Set([...routeModes, ...(airshipLastMile ? ["airship"] : [])])];
  let transportMode = usedModes.length > 1 ? "multimodal" : (usedModes[0] ?? "");
  if (!routeRequired && !transportMode) {
    if (airshipRequired && marketModes.has("airship") && originModes.has("airship")) transportMode = "airship";
    else if (marketModes.has("rail") && destinationModes.has("rail") && originModes.has("rail")) transportMode = "rail";
    else if (marketModes.has("caravan") && destinationModes.has("caravan") && originModes.has("caravan")) transportMode = "caravan";
    else if (marketModes.has("airship") && originModes.has("airship")) transportMode = "airship";
  }

  const fallbackDistanceKm = sameRegion ? 20 : (crossLandmass ? 240 : (origin && destination ? 120 : 40));
  const distanceKm = graphRoute?.distanceKm ?? fallbackDistanceKm;
  const distance = distanceKm / KM_PER_ROUTE_UNIT;
  const hops = graphRoute?.hops ?? (sameRegion ? 0 : 1);
  const routeAccessLevel = Math.max(0, Math.floor(finite(graphRoute?.accessCost, sameRegion ? 0 : 1)));
  const requiredAccessLevel = routeAccessLevel;

  const originFactors = logisticsRegionFactors(origin, dependencies.regionFactors);
  const destinationFactors = logisticsRegionFactors(destination, dependencies.regionFactors);
  const fallbackMode = TRANSPORT[transportMode] ? transportMode : (usedModes[0] ?? "");
  const mode = TRANSPORT[fallbackMode] ?? null;
  const reasons = [];
  if (search.limited) reasons.push("Сеть содержит слишком много альтернатив для точного расчёта. Упростите связи между рынками.");
  if (!destination) reasons.push("Регион поселения не найден в каталоге логистики.");
  if (origin && !originFactors.enabled) reasons.push("Торговля в регионе поставщика отключена.");
  if (destination && !destinationFactors.enabled) reasons.push("Регион поселения закрыт для торговли.");
  if (routeRequired && !graphRoute) reasons.push("Между регионом поселения и рынком нет связи на карте маршрутов.");
  if (airshipRequired && !airshipAvailable) reasons.push(needsAerialDelivery
    ? "Воздушная связь с владением недоступна: нужен воздушный участок у региона поселения или перевозчик местного участка."
    : "Для доставки между материками нужен доступный воздушный перевозчик.");
  if (crossLandmass && graphRoute && !routeModes.includes("airship")) reasons.push("Межматериковая часть маршрута не имеет воздушной связи.");
  if (!transportMode) reasons.push("Нет общего способа доставки между регионами.");
  if (access.level < requiredAccessLevel) reasons.push(`Для этого рынка нужен УРС ${requiredAccessLevel}, у поселения УРС ${access.level}.`);
  const activeSeasonId = normalizedSeasonId(seasonId);
  const routeSegments = graphRoute?.edges?.length
    ? graphRoute.edges.map((edge, index) => ({ edge, mode: TRANSPORT[routeModes[index]], seasonal: edgeSeasonalModifier(edge, activeSeasonId) })).filter((row) => row.mode)
    : (mode ? [{ edge: { distance }, mode }] : []);
  const dispatchModes = new Set(routeModes);
  if (!graphRoute?.edges?.length && fallbackMode) dispatchModes.add(fallbackMode);
  if (airshipLastMile) dispatchModes.add("airship");
  const routeDistanceCopper = routeSegments.reduce((sum, row) => sum + row.edge.distance * row.mode.distanceCopper * (row.seasonal?.costFactor ?? 1), 0);
  const routeLoadCopper = routeSegments.reduce((sum, row) => sum + row.edge.distance * row.mode.loadDistanceCopper * (row.seasonal?.costFactor ?? 1), 0);
  const routeTravelQd = routeSegments.reduce((sum, row) => sum + row.edge.distance * row.mode.qdPerDistance * (row.seasonal?.timeFactor ?? 1), 0) + (airshipLastMile ? 1 : 0);
  const routeOperatingTimeCopper = routeSegments.reduce((sum, row) => sum + row.edge.distance * row.mode.qdPerDistance * (row.seasonal?.timeFactor ?? 1) * row.mode.operatingCopperPerQd, 0)
    + (airshipLastMile ? TRANSPORT.airship.operatingCopperPerQd : 0);
  const seasonalDistance = routeSegments.reduce((sum, row) => sum + (row.seasonal?.active ? row.edge.distance : 0), 0);
  const seasonalRiskWeighted = routeSegments.reduce((sum, row) => sum + row.edge.distance * (row.seasonal?.riskFactor ?? 1), 0);
  const routeDistanceUnits = routeSegments.reduce((sum, row) => sum + row.edge.distance, 0);
  const seasonalRiskFactor = routeDistanceUnits > 0 ? seasonalRiskWeighted / routeDistanceUnits : 1;
  const dispatchCopper = [...dispatchModes].reduce((sum, transport) => sum + (TRANSPORT[transport]?.dispatchCopper ?? 0), 0);
  const usesAirship = transportMode === "airship" || routeModes.includes("airship") || airshipLastMile;
  const travelQd = mode ? Math.max(1, Math.ceil(routeTravelQd * originFactors.time)) : 0;
  const capacityModes = usedModes.length ? usedModes : [transportMode].filter(Boolean);
  const baseCapacityLoad = marketRouteCapacityLoad(market, capacityModes);
  const configuredDistanceFlatCopper = distance * Math.max(0, finite(market.deliveryDistanceCopper, 0));
  const configuredDistanceLoadCopper = distance * Math.max(0, finite(market.deliveryLoadDistanceCopper, 0));
  const operatingTimeBeforeFactorCopper = routeOperatingTimeCopper * originFactors.time;
  const routeFlatBeforeFactorCopper = dispatchCopper + routeDistanceCopper + configuredDistanceFlatCopper + operatingTimeBeforeFactorCopper;
  const routeLoadBeforeFactorCopper = routeLoadCopper + configuredDistanceLoadCopper;
  const airshipHireCopper = usesAirship ? Math.max(0, finite(market.airshipHireCopper, 120)) : 0;
  const result = {
    ok: reasons.length === 0,
    reasons,
    destinationRegionId: String(destination?.value ?? ""),
    destinationLabel: String(destination?.label ?? holding?.overview?.region ?? "Неизвестный регион"),
    originRegionId: String(origin?.value ?? market.regionId ?? ""),
    originLabel: String(origin?.label ?? market.origin ?? "Неизвестный источник"),
    originStatus: String(origin?.marketStatus ?? "stable"),
    destinationStatus: String(destination?.marketStatus ?? "stable"),
    sameRegion,
    distance,
    distanceKm,
    distanceText: `${Number.isInteger(distanceKm) ? distanceKm : Number(distanceKm.toFixed(1))} км`,
    hops,
    routeAccessCost: routeAccessLevel,
    routePath: graphRoute?.path ?? [],
    routeModes,
    seasonId: activeSeasonId,
    seasonalEdgeCount: routeSegments.filter((row) => row.seasonal?.active).length,
    seasonalDistanceKm: seasonalDistance * KM_PER_ROUTE_UNIT,
    seasonalRiskFactor,
    routeAccessLevel,
    requiredAccessLevel,
    accessLevel: access.level,
    accessSource: access.source,
    transportMode,
    capacityModes,
    baseCapacityLoad,
    capacityLoad: baseCapacityLoad,
    transportLabel: transportMode === "multimodal" ? `Смешанный маршрут: ${usedModes.map((item) => TRANSPORT[item]?.label).filter(Boolean).join(" + ")}` : (mode?.label ?? "Маршрут недоступен"),
    airshipRequired: Boolean(airshipRequired),
    priceFactor: originFactors.price,
    outboundPriceFactor: originFactors.buyPrice,
    demandFactor: originFactors.demand,
    stockFactor: originFactors.stock,
    deliveryFactor: originFactors.delivery,
    travelQd,
    riskFactor: originFactors.risk * destinationFactors.risk * seasonalRiskFactor,
    direction,
    importTaxRate: direction === "outbound" ? originFactors.taxRate : destinationFactors.taxRate,
    exportTaxRate: direction === "outbound" ? destinationFactors.exportTaxRate : originFactors.exportTaxRate,
    taxRate: (direction === "outbound" ? originFactors.taxRate + destinationFactors.exportTaxRate : destinationFactors.taxRate + originFactors.exportTaxRate),
    dispatchCopper,
    routeDistanceCopper,
    routeOperatingTimeCopper: operatingTimeBeforeFactorCopper,
    operatingTimeCopper: mode ? Math.ceil(operatingTimeBeforeFactorCopper * originFactors.delivery) : 0,
    configuredDistanceFlatCopper,
    configuredDistanceLoadCopper,
    routeFlatBeforeFactorCopper,
    routeLoadBeforeFactorCopper,
    airshipHireCopper,
    distanceFlatCopper: mode ? Math.ceil(routeFlatBeforeFactorCopper * originFactors.delivery) + airshipHireCopper : 0,
    distanceLoadCopper: mode ? routeLoadBeforeFactorCopper * originFactors.delivery : 0
  };
  if (!singleRoute && search.routes.length) {
    const candidates = search.routes.map((route) => resolveMarketLogistics({
      holding, market, regions, seasonId, dependencies, direction, accessLevel, selectedRoute: route, singleRoute: true
    })).filter((route) => route.ok);
    // Keep search-limit failures: a partial search cannot establish the cheapest route.
    if (!result.ok && !search.limited && candidates.length) return { ...candidates[0], routeCandidates: candidates };
    result.routeCandidates = candidates;
  }
  return result;
}
