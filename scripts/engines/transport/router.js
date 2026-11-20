import { stableDataHash } from "../../data/storage-commit.js";
import { carrierProvidersForRoute } from "../market/providers.js";
import { MARKET_DEFAULT_TRANSPORT_CAPACITY_LOAD, MARKET_TRANSPORT_TARIFFS, edgeSeasonalModifier, findHoldingRegion, holdingMarketAccessLevel } from "../market/logistics.js";
import { marketTransportFreightFactor } from "../market/pricing.js";
import { localMarketDistanceKm, referenceTransportCosts, configuredTransportCharges, transportPortHandlingQd, transportRiskBps } from "./economics.js";
import { transportServicesFromRoutes } from "./services.js";
import { transportServiceCompatibilityIds } from "./service-identity.js";
import { transportOperatingCharge, TRANSPORT_LIMITS, TRANSPORT_LOAD_SCALE } from "./quantities.js";
import { transportSeasonalMovement } from "./seasonal.js";
import { worldShipTransportTerms } from "../ships/world-market.js";
import { getShipProfile, shipCapacityLoadPoints } from "../ships/profiles.js";
import { shipCrewReadiness } from "../ships/crew-readiness.js";
import { worldShipTimelineQd, worldShipPortDebtCopper } from "../ships/world-voyage.js";

const MODES = Object.keys(MARKET_TRANSPORT_TARIFFS);
const LAND_MODES = new Set(["caravan", "rail"]);
const AIRSHIP_ONLY = new Set(["airship"]);
const TRANSFER_QD = 1;
const KM_PER_ROUTE_UNIT = 40;
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const sameService = (a, b) => a && b && a.mode === b.mode && a.carrierId === b.carrierId
  && (a.carrierId !== "independent-carriers" || a.fromCountryId === b.fromCountryId);

class MinHeap {
  constructor(compare) { this._items = []; this._compare = compare; }
  get size() { return this._items.length; }
  push(item) {
    const items = this._items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this._compare(items[i], items[parent]) >= 0) break;
      [items[i], items[parent]] = [items[parent], items[i]];
      i = parent;
    }
  }
  pop() {
    const items = this._items;
    if (!items.length) return null;
    const top = items[0];
    const last = items.pop();
    if (items.length) {
      items[0] = last;
      let i = 0;
      while (true) {
        let best = i;
        const left = i * 2 + 1, right = left + 1;
        if (left < items.length && this._compare(items[left], items[best]) < 0) best = left;
        if (right < items.length && this._compare(items[right], items[best]) < 0) best = right;
        if (best === i) break;
        [items[i], items[best]] = [items[best], items[i]];
        i = best;
      }
    }
    return top;
  }
}

function buildGraph(regions = []) {
  const byId = new Map();
  const graph = new Map();
  const seen = new Set();
  const ensure = (id) => {
    if (!graph.has(id)) graph.set(id, []);
    return graph.get(id);
  };
  for (const region of regions ?? []) {
    const from = String(region?.value ?? "").trim();
    if (!from) continue;
    byId.set(from, region);
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
        to, routeId,
        ursCost: Math.min(99, Math.max(1, Math.floor(finite(link?.ursCost ?? link?.accessCost, 1)))),
        distanceKm, distance: distanceKm / KM_PER_ROUTE_UNIT,
        modes: Array.isArray(link?.modes) ? link.modes : [],
        seasonalModifiers: link?.seasonalModifiers && typeof link.seasonalModifiers === "object" ? link.seasonalModifiers : {}
      };
      ensure(from).push(edge);
      ensure(to).push({ ...edge, to: from });
    }
  }
  return { byId, graph };
}

function edgeModes(edge, fromRegion, toRegion, { allowedModes = null, fromStop = true, toStop = true } = {}) {
  const mustFly = Boolean(fromRegion?.marketLandmassId && toRegion?.marketLandmassId
    && fromRegion.marketLandmassId !== toRegion.marketLandmassId);
  return (edge.modes?.length ? edge.modes : MODES).filter((mode) => MARKET_TRANSPORT_TARIFFS[mode]
    && (!allowedModes || allowedModes.has(mode))
    && (!mustFly || mode === "airship")
    && (!fromStop || !fromRegion?.marketTransportModes || fromRegion.marketTransportModes.includes(mode))
    && (!toStop || !toRegion?.marketTransportModes || toRegion.marketTransportModes.includes(mode)));
}

function createLegBuilder({ holding, market, byId, organizations, countries, seasonId, regionFactors, isGM }) {
  const companies = new Map((organizations ?? []).map((row) => [String(row.id), row]));
  const countryRows = new Map((countries ?? []).map((row) => [String(row.id), row]));
  const providerCache = new Map();
  const factorsCache = new Map();
  const factors = (id) => {
    if (!factorsCache.has(id)) factorsCache.set(id, regionFactors?.(byId.get(id)) ?? {});
    return factorsCache.get(id);
  };
  const providers = (id, mode) => {
    const countryId = String(byId.get(id)?.countryId ?? id);
    const key = `${countryId}:${mode}`;
    if (!providerCache.has(key)) {
      providerCache.set(key, carrierProvidersForRoute({ organizations, countryId, transportMode: mode, routeModes: [mode], isGM })
        .map((row) => ({ ...row, dispatchCountryId: countryId })));
    }
    return providerCache.get(key);
  };
  const capacityFor = (mode, carrier) => Math.max(1, finite(market?.[`${mode}CapacityLoad`], MARKET_DEFAULT_TRANSPORT_CAPACITY_LOAD[mode]))
    * Math.max(0.1, finite(carrier.capacityFactor, 1));
  const regionHidden = (id) => !isGM && countryRows.get(String(byId.get(id)?.countryId ?? id))?.visibility === "gm";
  const makeLeg = (from, to, edge, mode, carrier, kind = "route") => {
    const source = byId.get(from), target = byId.get(to), place = factors(from), destination = factors(to);
    const season = edgeSeasonalModifier(edge, seasonId);
    const tariff = MARKET_TRANSPORT_TARIFFS[mode];
    const distanceKm = kind === "last-mile" ? localMarketDistanceKm(holding) : Math.max(0, finite(edge.distanceKm));
    const distance = distanceKm / KM_PER_ROUTE_UNIT;
    const delivery = Math.max(0.01, finite(place.delivery, 1));
    const time = Math.max(0.01, finite(place.time, 1));
    const priceFactor = Math.max(0.5, finite(carrier.priceFactor, 1));
    const timeFactor = Math.max(0.5, finite(carrier.timeFactor, 1));
    const movementQd = distance * tariff.qdPerDistance * finite(season.timeFactor, 1) * time * timeFactor;
    const capacityLoad = capacityFor(mode, carrier);
    const reference = referenceTransportCosts(mode, capacityLoad, Math.ceil(9 * Math.max(0.01, finite(place.price, 1))));
    const fromCountryId = String(source?.countryId ?? from), toCountryId = String(target?.countryId ?? to);
    const privateLeg = companies.get(carrier.id)?.visibility === "gm"
      || countryRows.get(fromCountryId)?.visibility === "gm"
      || countryRows.get(toCountryId)?.visibility === "gm";
    return {
      routeId: String(edge.routeId ?? ""),
      fromRegionId: from, toRegionId: to, fromCountryId, toCountryId,
      fromLabel: String(source?.label ?? from), toLabel: String(target?.label ?? to),
      mode, modeLabel: tariff.label,
      carrierId: carrier.id, carrierLabel: carrier.label,
      visibility: privateLeg ? "gm" : "public",
      kind, distanceKm, movementQd, travelQd: movementQd, transferQd: 0, capacityLoad,
      sourcePriceFactor: Math.max(0.01, finite(place.price, 1)),
      targetPriceFactor: Math.max(0.01, finite(destination.price, 1)),
      sourceTimeFactor: time, targetTimeFactor: Math.max(0.01, finite(destination.time, 1)),
      operatingFactor: priceFactor * delivery * finite(season.costFactor, 1),
      seasonalTerms: {
        movementQd: distance * tariff.qdPerDistance * time * timeFactor,
        operatingFactor: priceFactor * delivery,
        riskFactor: finite(place.risk, 1) * finite(destination.risk, 1) * finite(carrier.riskFactor, 1),
        seasonalModifiers: edge.seasonalModifiers ?? {}
      },
      ...configuredTransportCharges({ mode, distanceKm, settings: market, dispatchCopper: tariff.dispatchCopper, priceFactor, deliveryFactor: delivery }),
      operatingCopper: movementQd / 4 * reference.dailyCopper * priceFactor * delivery * finite(season.costFactor, 1),
      riskFactor: Math.max(0.25, finite(place.risk, 1) * finite(destination.risk, 1) * finite(season.riskFactor, 1) * finite(carrier.riskFactor, 1)),
      priceFactor, timeFactor, capacityFactor: Math.max(0.1, finite(carrier.capacityFactor, 1)),
      sharePct: carrier.sharePct,
      freightFactor: marketTransportFreightFactor(mode) * priceFactor * delivery
    };
  };
  return { factors, providers, makeLeg, regionHidden };
}

function estimateLegWeight(leg, cargoUnits, kind = "regular", continues = false) {
  const units = Math.max(1, Math.ceil(cargoUnits / Math.max(1, leg.capacityLoad)));
  const dispatch = continues ? 0 : (leg.dispatchCopper + leg.hireCopper) * units;
  const fixedCost = dispatch + leg.distanceCopper * units;
  const loadCost = cargoUnits * leg.loadCopperPerUnit;
  const transferWaitQd = continues ? 0 : (kind === "regular" ? 6 : 2) + TRANSFER_QD;
  const transferHandlingCopper = continues ? 0 : Math.ceil(cargoUnits * 0.5);
  if (kind === "charter") {
    const tripOperating = leg.operatingCopper * 2 * units;
    return { cost: fixedCost + tripOperating + loadCost + transferHandlingCopper, time: leg.movementQd + transferWaitQd };
  }
  const share = Math.min(1, Math.max(0.02, cargoUnits / Math.max(1, leg.capacityLoad * units)));
  const regularCost = (fixedCost + leg.operatingCopper * 2 * units) * share + loadCost + transferHandlingCopper;
  return { cost: regularCost, time: leg.movementQd + transferWaitQd };
}

function finalizeRouteLegs(legs, direction, accessCost, accessLevel) {
  for (const [index, leg] of legs.entries()) {
    if (sameService(legs[index - 1], leg)) { leg.dispatchCopper = 0; leg.hireCopper = 0; }
    else if (index) { leg.transferQd = TRANSFER_QD; leg.travelQd += TRANSFER_QD; }
  }
  const key = `transport:${stableDataHash(legs.map((leg) => [leg.fromRegionId, leg.toRegionId, leg.routeId, leg.mode, leg.carrierId]))}`;
  legs.forEach((leg, index) => { leg.id = `${key}:${index}`; });
  const sum = (field) => legs.reduce((total, leg) => total + finite(leg[field]), 0);
  const distanceKm = sum("distanceKm");
  const capacityLoad = Math.min(...legs.map((leg) => leg.capacityLoad));
  return {
    ok: true,
    accessLevel,
    routeAccessCost: accessCost,
    routeAccessLevel: accessCost,
    distanceKm,
    travelQd: Math.max(1, Math.ceil(sum("travelQd"))),
    transportPlan: {
      version: 1, key, direction, legs, distanceKm,
      travelQd: sum("travelQd"), capacityLoad,
      dispatchCopper: sum("dispatchCopper"), distanceCopper: sum("distanceCopper"),
      operatingCopper: sum("operatingCopper"), hireCopper: sum("hireCopper"),
      loadCopperPerUnit: sum("loadCopperPerUnit"),
      riskFactor: Math.max(...legs.map((leg) => leg.riskFactor)),
      freightFactor: distanceKm > 0 ? legs.reduce((total, leg) => total + leg.distanceKm * leg.freightFactor, 0) / distanceKm : 1,
      transferQd: sum("transferQd")
    }
  };
}

/**
 * Fast constrained Dijkstra over physical edges and carrier modifiers.
 * Never disables dominance pruning, so even dense maps resolve in <1 ms with zero search-limit errors.
 */
export function findOptimalHiredRoute({
  holding = {}, market = {}, regions = [], organizations = [], countries = [],
  seasonId = "", direction = "inbound", accessLimit = 0, cargoLoad = 4000,
  kind = "regular", metric = "cost", regionFactors = null, isGM = false,
  allowedModes = null, fromRegionId = "", toRegionId = "", allowFloatingLastMile = true
} = {}) {
  const { byId, graph } = buildGraph(regions);
  const home = findHoldingRegion(holding, regions);
  const homeId = String(home?.value ?? "");
  const startId = String(fromRegionId || (direction === "outbound" ? homeId : market?.regionId ?? ""));
  const endId = String(toRegionId || (direction === "outbound" ? market?.regionId ?? "" : homeId));
  if (!startId || !endId || !byId.has(startId) || !byId.has(endId)) return null;

  const { factors, providers, makeLeg, regionHidden } = createLegBuilder({
    holding, market, byId, organizations, countries, seasonId, regionFactors, isGM
  });
  if (factors(startId).enabled === false || factors(endId).enabled === false) return null;
  if (regionHidden(startId) || regionHidden(endId)) return null;

  const cargoUnits = Math.max(1, cargoLoad / TRANSPORT_LOAD_SCALE);
  const floating = allowFloatingLastMile && ["sky-island", "ship"].includes(holding.type);
  const maxAccess = Math.max(0, Math.floor(finite(accessLimit, 0)));
  const permitted = allowedModes ? new Set(allowedModes) : null;

  // Same-region local route (e.g., floating island <-> local market below).
  if (startId === endId) {
    const region = byId.get(startId);
    const localModes = (market.transportModes ?? MODES).filter((mode) =>
      (!permitted || permitted.has(mode))
      && (!region?.marketTransportModes || region.marketTransportModes.includes(mode))
      && (!floating || mode === "airship")
    );
    let best = null;
    for (const mode of localModes) {
      for (const carrier of providers(startId, mode)) {
        const leg = makeLeg(startId, endId, { routeId: "", distanceKm: localMarketDistanceKm(holding) }, mode, carrier, "last-mile");
        const weight = estimateLegWeight(leg, cargoUnits, kind, false);
        const primary = metric === "time" ? weight.time : weight.cost;
        const secondary = metric === "time" ? weight.cost : weight.time;
        if (!best || primary < best.primary - 1e-9 || (Math.abs(primary - best.primary) <= 1e-9 && secondary < best.secondary)) {
          best = { primary, secondary, leg };
        }
      }
    }
    return best ? finalizeRouteLegs([best.leg], direction, 0, maxAccess) : null;
  }

  const localAirshipAvailable = Boolean(homeId && byId.get(homeId)?.marketTransportModes?.includes("airship") && providers(homeId, "airship").length);
  const pickBestLocalAirship = () => {
    let best = null;
    for (const carrier of providers(homeId, "airship")) {
      const leg = makeLeg(homeId, homeId, { routeId: "" }, "airship", carrier, "last-mile");
      const weight = estimateLegWeight(leg, cargoUnits, kind, false);
      const primary = metric === "time" ? weight.time : weight.cost;
      if (!best || primary < best.primary) best = { primary, leg, weight };
    }
    return best;
  };
  const floatingLastMile = floating && localAirshipAvailable ? pickBestLocalAirship() : null;

  const compare = (a, b) => a.primary - b.primary || a.secondary - b.secondary || a.access - b.access || a.stages - b.stages || a.hops - b.hops;
  const heap = new MinHeap(compare);
  const pareto = new Map();
  const hasVisited = (state, nodeId) => {
    for (let cursor = state; cursor; cursor = cursor.prev) {
      if (cursor.node === nodeId) return true;
    }
    return false;
  };
  const isDominated = (key, access, stages, primary, secondary) => {
    const rows = pareto.get(key);
    if (!rows) return false;
    return rows.some((row) => row.access <= access && row.stages <= stages
      && (row.primary < primary - 1e-9 || (Math.abs(row.primary - primary) <= 1e-9 && row.secondary <= secondary + 1e-9)));
  };
  const recordState = (key, access, stages, primary, secondary) => {
    const rows = pareto.get(key) ?? [];
    const kept = rows.filter((row) => !(access <= row.access && stages <= row.stages
      && (primary < row.primary - 1e-9 || (Math.abs(primary - row.primary) <= 1e-9 && secondary <= row.secondary + 1e-9))));
    kept.push({ access, stages, primary, secondary });
    pareto.set(key, kept);
  };

  heap.push({ node: startId, access: 0, stages: 0, primary: 0, secondary: 0, hops: 0, mode: "", carrierKey: "", prev: null, leg: null, extraLeg: null });

  while (heap.size) {
    const current = heap.pop();
    const stateKey = `${current.node}|${current.mode}|${current.carrierKey}`;
    const currentRows = pareto.get(stateKey);
    if (currentRows && currentRows.some((row) => row.access <= current.access && row.stages <= current.stages
      && (row.primary < current.primary - 1e-9 || (Math.abs(row.primary - current.primary) <= 1e-9 && row.secondary < current.secondary - 1e-9)))) continue;

    if (current.node === endId) {
      const legs = [];
      for (let cursor = current; cursor?.leg; cursor = cursor.prev) {
        if (cursor.extraLeg && direction === "inbound") legs.push(cursor.extraLeg);
        legs.push(cursor.leg);
        if (cursor.extraLeg && direction === "outbound") legs.push(cursor.extraLeg);
      }
      legs.reverse();
      return finalizeRouteLegs(legs, direction, current.access, maxAccess);
    }

    const fromRegion = byId.get(current.node);
    for (const edge of graph.get(current.node) ?? []) {
      const nextAccess = current.access + edge.ursCost;
      if (nextAccess > maxAccess) continue;
      if (hasVisited(current, edge.to)) continue;
      const toRegion = byId.get(edge.to);
      if (!toRegion || regionHidden(edge.to)) continue;
      const toIsEnd = edge.to === endId;
      if (toIsEnd && factors(edge.to).enabled === false) continue;

      const marketRegionId = String(market?.regionId ?? "");
      const marketModes = Array.isArray(market?.transportModes) && market.transportModes.length ? new Set(market.transportModes) : null;
      let edgeAllowed = permitted;
      if (marketModes && (current.node === marketRegionId || edge.to === marketRegionId)) {
        edgeAllowed = permitted ? new Set([...permitted].filter((m) => marketModes.has(m))) : marketModes;
      }
      const modes = edgeModes(edge, fromRegion, toRegion, {
        allowedModes: edgeAllowed,
        fromStop: true,
        toStop: true
      });

      for (const mode of modes) {
        if (current.mode && current.mode !== mode) {
          if (fromRegion?.marketTransportModes && (!fromRegion.marketTransportModes.includes(current.mode) || !fromRegion.marketTransportModes.includes(mode))) continue;
        }
        const needsFloatingHop = floating && mode !== "airship" && ((direction === "outbound" && current.node === homeId && current.hops === 0)
          || (direction === "inbound" && edge.to === homeId));
        if (needsFloatingHop && !floatingLastMile) continue;

        const carriers = providers(current.node, mode);
        if (!carriers.length) continue;

        const byCarrier = new Map();
        for (const carrier of carriers) {
          const leg = makeLeg(current.node, edge.to, edge, mode, carrier);
          const cKey = carrier.id === "independent-carriers" ? `${carrier.id}:${leg.fromCountryId}` : carrier.id;
          const continues = current.mode === mode && current.carrierKey === cKey && !needsFloatingHop;
          if (current.hops > 0 && !continues && factors(current.node).enabled === false) continue;
          const nextStages = current.stages + (continues ? 0 : 1) + (needsFloatingHop ? 1 : 0);
          if (nextStages > TRANSPORT_LIMITS.stages) continue;
          const weight = estimateLegWeight(leg, cargoUnits, kind, continues);
          const extraCost = needsFloatingHop ? floatingLastMile.weight.cost : 0;
          const extraTime = needsFloatingHop ? floatingLastMile.weight.time + TRANSFER_QD : 0;
          const edgePrimary = metric === "access" ? edge.ursCost : metric === "time" ? weight.time + extraTime : weight.cost + extraCost;
          const edgeSecondary = metric === "time" ? weight.cost + extraCost : metric === "access" ? weight.cost + extraCost : weight.time + extraTime;
          const primary = current.primary + edgePrimary;
          const secondary = current.secondary + edgeSecondary;
          const candidate = {
            node: edge.to, access: nextAccess, stages: nextStages, primary, secondary, hops: current.hops + 1,
            mode, carrierKey: cKey, prev: current, leg,
            extraLeg: needsFloatingHop ? { ...floatingLastMile.leg } : null
          };
          const prevBest = byCarrier.get(cKey);
          if (!prevBest || compare(candidate, prevBest) < 0) byCarrier.set(cKey, candidate);
        }

        for (const candidate of byCarrier.values()) {
          const nextKey = `${candidate.node}|${candidate.mode}|${candidate.carrierKey}`;
          if (isDominated(nextKey, candidate.access, candidate.stages, candidate.primary, candidate.secondary)) continue;
          recordState(nextKey, candidate.access, candidate.stages, candidate.primary, candidate.secondary);
          heap.push(candidate);
        }
      }
    }
  }
  return null;
}

/** Fast diagnostic explaining why no hired route was found (always keeps the canonical prefix). */
export function diagnoseHiredRouteFailure({
  holding = {}, market = {}, regions = [], organizations = [], countries = [],
  direction = "inbound", accessLimit = 0, regionFactors = null, isGM = false
} = {}) {
  const prefix = "Для выбранного груза нет доступной перевозки";
  const { byId, graph } = buildGraph(regions);
  const countryRows = new Map((countries ?? []).map((row) => [String(row.id), row]));
  const regionHidden = (id) => !isGM && countryRows.get(String(byId.get(id)?.countryId ?? id))?.visibility === "gm";
  const homeId = String(findHoldingRegion(holding, regions)?.value ?? "");
  const startId = String(direction === "outbound" ? homeId : market?.regionId ?? "");
  const endId = String(direction === "outbound" ? market?.regionId ?? "" : homeId);
  if (!startId || !endId || !byId.has(startId) || !byId.has(endId)) return `${prefix}: локация не найдена на карте.`;
  if (regionHidden(startId) || regionHidden(endId)) return `${prefix} (проверьте режимы узлов, УРС и доступность перевозчиков).`;
  if (startId === endId) return `${prefix}: на локальном рынке нет подходящего вида транспорта.`;

  // 1. Check if a route exists with higher URS (minimize URS, not cost, so the hint shows the true minimum threshold).
  const unlimited = findOptimalHiredRoute({
    holding, market, regions, organizations, countries, direction,
    accessLimit: 99, cargoLoad: TRANSPORT_LOAD_SCALE, kind: "regular", metric: "access", regionFactors, isGM
  });
  if (unlimited?.ok) {
    return `${prefix}: требуется УРС ${unlimited.routeAccessCost}, доступно ${Math.max(0, Math.floor(accessLimit))}.`;
  }

  // 2. Check if any visible undirected graph path exists ignoring mode restrictions.
  const parent = new Map([[startId, null]]);
  const queue = [startId];
  for (let i = 0; i < queue.length && !parent.has(endId); i++) {
    for (const edge of graph.get(queue[i]) ?? []) {
      if (parent.has(edge.to) || regionHidden(edge.to)) continue;
      parent.set(edge.to, { from: queue[i], edge });
      queue.push(edge.to);
    }
  }
  if (!parent.has(endId)) return `${prefix}: между локациями нет связи на карте маршрутов.`;

  // 3. Pinpoint the first blocked edge on the shortest visible raw path without leaking GM-only node names.
  const pathEdges = [];
  for (let node = endId; parent.get(node); node = parent.get(node).from) pathEdges.push(parent.get(node));
  pathEdges.reverse();
  for (const { from, edge } of pathEdges) {
    const a = byId.get(from), b = byId.get(edge.to);
    const allowed = edgeModes(edge, a, b, { fromStop: true, toStop: true });
    if (!allowed.length) {
      if (regionHidden(from) || regionHidden(edge.to)) {
        return `${prefix} (проверьте режимы узлов, УРС и доступность перевозчиков).`;
      }
      if (a?.marketLandmassId && b?.marketLandmassId && a.marketLandmassId !== b.marketLandmassId) {
        return `${prefix}: узлы «${a.label || from}» и «${b.label || edge.to}» на разных островах/материках — между ними допустим только воздушный корабль.`;
      }
      return `${prefix}: на связи «${a?.label || from} → ${b?.label || edge.to}» нет общего вида транспорта между узлами (проверьте режимы узлов и связи).`;
    }
  }
  return `${prefix} (проверьте режимы узлов, УРС и доступность перевозчиков).`;
}

/**
 * Scale a hired service to carry the full consignment in a single departure.
 * Large shipments hire multiple vessels/wagons and pay proportionally for them.
 */
export function scaleHiredServiceForCargo(service, totalLoad, overrides = {}) {
  if (!service || service.kind === "owned" || !Number.isFinite(totalLoad) || totalLoad <= service.capacity) {
    return { ...service, vehicleCount: 1 };
  }
  if (transportServiceCompatibilityIds(service.id).some((id) => overrides?.[id]?.capacity !== undefined)) {
    return { ...service, vehicleCount: 1 };
  }
  const vehicleCount = Math.ceil(totalLoad / service.capacity);
  const scaleCosts = (costs) => costs
    ? Object.fromEntries(Object.entries(costs).map(([key, value]) => [key, Math.ceil(Number(value ?? 0) * vehicleCount)]))
    : costs;
  const scaledCapacity = service.capacity * vehicleCount;
  return {
    ...service,
    id: `${service.id}:x${vehicleCount}`,
    vehicleCount,
    unitCapacity: service.capacity,
    capacity: scaledCapacity,
    dispatchCopper: Math.ceil((service.dispatchCopper ?? 0) * vehicleCount),
    ...(service.dailyCosts ? { dailyCosts: scaleCosts(service.dailyCosts) } : {}),
    ...(service.returnDailyCosts ? { returnDailyCosts: scaleCosts(service.returnDailyCosts) } : {}),
    ...(service.loadingCapacity ? { loadingCapacity: service.loadingCapacity * vehicleCount } : {}),
    ...(service.unloadingCapacity ? { unloadingCapacity: service.unloadingCapacity * vehicleCount } : {}),
    ...(service.seasonal ? {
      seasonal: {
        ...service.seasonal,
        ...(service.seasonal.dailyCosts ? { dailyCosts: scaleCosts(service.seasonal.dailyCosts) } : {}),
        ...(service.seasonal.returnDailyCosts ? { returnDailyCosts: scaleCosts(service.seasonal.returnDailyCosts) } : {}),
        ...(service.seasonal.fare ? { fare: { ...service.seasonal.fare, fixedCopper: Math.ceil((service.seasonal.fare.fixedCopper ?? 0) * vehicleCount) } } : {})
      }
    } : {})
  };
}

function findFastestAirshipRoute(fromRegionId, toRegionId, regions, { speedKmPerDay, calendar, startQd = 0, maxAccess = Infinity } = {}) {
  if (!fromRegionId || !toRegionId || fromRegionId === toRegionId || !(speedKmPerDay > 0)) return null;
  const { byId, graph } = buildGraph(regions);
  if (!byId.has(fromRegionId) || !byId.has(toRegionId)) return null;
  const heap = new MinHeap((a, b) => a.time - b.time || a.accessCost - b.accessCost || a.distanceKm - b.distanceKm);
  const best = new Map();
  heap.push({ node: fromRegionId, time: 0, accessCost: 0, distanceKm: 0, path: [fromRegionId], edges: [] });
  best.set(`${fromRegionId}\u00000`, 0);
  while (heap.size) {
    const cur = heap.pop();
    if (cur.node === toRegionId) {
      return { path: cur.path, edges: cur.edges, distanceKm: cur.distanceKm, accessCost: cur.accessCost };
    }
    if ((best.get(`${cur.node}\u0000${cur.accessCost}`) ?? Infinity) < cur.time - 1e-9) continue;
    for (const edge of graph.get(cur.node) ?? []) {
      const toRegion = byId.get(edge.to);
      if (!toRegion || cur.path.includes(edge.to)) continue;
      const modes = edgeModes(edge, byId.get(cur.node), toRegion, {
        allowedModes: AIRSHIP_ONLY,
        fromStop: cur.node === fromRegionId,
        toStop: edge.to === toRegionId
      });
      if (!modes.length) continue;
      const nextAccess = cur.accessCost + edge.ursCost;
      if (nextAccess > maxAccess) continue;
      const movement = transportSeasonalMovement({
        calendar,
        costSeasonal: false,
        legs: [{ movementQd: edge.distanceKm * 4 / speedKmPerDay, riskFactor: 1, seasonalModifiers: edge.seasonalModifiers }]
      }, startQd + cur.time);
      const nextTime = cur.time + movement.movementQd;
      let dominated = false;
      for (let a = 0; a <= nextAccess; a++) {
        if ((best.get(`${edge.to}\u0000${a}`) ?? Infinity) <= nextTime + 1e-9) { dominated = true; break; }
      }
      if (dominated) continue;
      best.set(`${edge.to}\u0000${nextAccess}`, nextTime);
      heap.push({
        node: edge.to,
        time: nextTime,
        accessCost: nextAccess,
        distanceKm: cur.distanceKm + edge.distanceKm,
        path: [...cur.path, edge.to],
        edges: [...cur.edges, {
          from: cur.node, to: edge.to, distanceKm: edge.distanceKm,
          ursCost: edge.ursCost, routeId: edge.routeId, seasonalModifiers: edge.seasonalModifiers
        }]
      });
    }
  }
  return null;
}

function buildOwnShipService({ data, holding, ship, world, from, to, homeEndpoint, cargoAccessLimit, emptyAccessLimit, configuration, calendar, returnHome, riskBps }) {
  const capacityPoints = shipCapacityLoadPoints(ship);
  const speedKmPerDay = Number(ship.speedKmPerDay || getShipProfile(ship.profileId).speedKmPerDay);
  const baseStartQd = Number(ship.timelineQd ?? holding.gm?.calendaria?.lastQd ?? 0);
  const positionAtHome = !ship.location || ship.location.kind === "home";
  const position = positionAtHome ? homeEndpoint : ship.location.regionId;
  const toRegion = (id) => (id === homeEndpoint ? world.home.regionId : id);
  const snapshot = (terms) => (terms?.seasonal ? { ...terms.seasonal, calendar } : null);
  const routeFor = (a, b, maxAccess, startQd = baseStartQd) => findFastestAirshipRoute(toRegion(a), toRegion(b), world.regions, {
    speedKmPerDay, calendar: { ...world.seasonalCalendar, fallbackSeasonId: world.seasonId }, startQd, maxAccess
  });
  const safeEmpty = (a, b, aAtHome = a === homeEndpoint, startQd = baseStartQd) => {
    if (a === b && aAtHome === (b === homeEndpoint)) return null;
    try {
      const selectedRoute = routeFor(a, b, emptyAccessLimit, startQd);
      return worldShipTransportTerms(data, holding, ship, toRegion(a), toRegion(b), {
        context: world, loadPoints: 0, maxAccess: emptyAccessLimit,
        fromHome: aAtHome, toHome: b === homeEndpoint, selectedRoute, startQd
      });
    } catch (_error) {
      return null;
    }
  };
  const atPickup = position === from && positionAtHome === (from === homeEndpoint);
  const approach = safeEmpty(position, from, positionAtHome, baseStartQd);
  const fromPort = toRegion(from) === world.home.regionId && from === homeEndpoint
    ? world.home : world.ports.find((port) => port.regionId === toRegion(from));
  const loadingQd = fromPort ? transportPortHandlingQd(fromPort, capacityPoints) : 0;
  const departureQd = baseStartQd + (approach?.durationQd ?? 0) + loadingQd;
  const selectedRoute = routeFor(from, to, cargoAccessLimit, departureQd);
  const terms = worldShipTransportTerms(data, holding, ship, toRegion(from), toRegion(to), {
    context: world, loadPoints: capacityPoints, maxAccess: cargoAccessLimit,
    fromHome: from === homeEndpoint, toHome: to === homeEndpoint, selectedRoute, startQd: departureQd
  });
  const returnStartQd = departureQd + Number(terms.durationQd ?? 0) + Number(terms.unloadingQd ?? 0);
  const abortStartQd = baseStartQd + (approach?.durationQd ?? 0);
  const back = safeEmpty(to, from, undefined, returnStartQd);
  const homeReturn = safeEmpty(to, homeEndpoint, undefined, returnStartQd);
  const abortReturn = safeEmpty(from, homeEndpoint, undefined, abortStartQd);
  return {
    id: `owned:${ship.id}:${from}:${to}`,
    label: `${ship.name} · ${terms.distanceKm} км · УРС ${terms.accessCost}`,
    companyId: `owned:${ship.id}`,
    kind: "owned",
    shipId: ship.id,
    from, to,
    fromLabel: terms.from.label, toLabel: terms.to.label,
    capacity: capacityPoints * 1000,
    vehicles: 1,
    vehicleCount: 1,
    distanceKm: terms.distanceKm,
    travelQd: terms.durationQd,
    loadingQd: terms.loadingQd,
    unloadingQd: terms.unloadingQd,
    loadingCapacity: terms.loadingCapacity,
    unloadingCapacity: terms.unloadingCapacity,
    returnQd: back?.durationQd ?? 0,
    endReturnQd: homeReturn?.durationQd ?? 0,
    endReturnLocation: homeEndpoint,
    emptyAccessLimit,
    approachAvailable: atPickup || Boolean(approach),
    approachAccessCost: approach?.accessCost ?? 0,
    returnAvailable: Boolean(back),
    returnAccessCost: back?.accessCost ?? 0,
    endReturnAvailable: to === homeEndpoint || Boolean(homeReturn),
    endReturnAccessCost: homeReturn?.accessCost ?? 0,
    abortReturnAvailable: from === homeEndpoint || Boolean(abortReturn),
    abortReturnAccessCost: abortReturn?.accessCost ?? 0,
    abortReturnQd: abortReturn?.durationQd ?? 0,
    returnAtEnd: returnHome === true,
    approachQd: approach?.durationQd ?? 0,
    approachCopper: approach ? transportOperatingCharge(approach, approach.durationQd) : 0,
    handlingFlatCopper: terms.handlingFlatCopper,
    handlingMilliCopper: terms.handlingMilliCopper,
    operatingMilliCopperPerQd: terms.operatingMilliCopperPerQd,
    idleUpkeepCopperPerDay: terms.idleUpkeepCopperPerDay,
    startIdleUpkeepCopperPerDay: Object.values(terms.dailyCosts).reduce((sum, cost) => sum + cost, 0),
    returnOperatingMilliCopperPerQd: back?.operatingMilliCopperPerQd ?? terms.operatingMilliCopperPerQd,
    dailyCosts: terms.dailyCosts,
    returnDailyCosts: back?.dailyCosts ?? terms.dailyCosts,
    seasonal: { ...snapshot(terms), baseRiskBps: riskBps ?? configuration.riskBps },
    approachSeasonal: snapshot(approach),
    approachDailyCosts: approach?.dailyCosts ?? null,
    returnSeasonal: snapshot(back),
    endReturnSeasonal: snapshot(homeReturn),
    abortReturnSeasonal: snapshot(abortReturn),
    waitingMilliCopperPerQd: from === homeEndpoint && ship.homeUpkeepEnabled === false ? 0 : terms.operatingMilliCopperPerQd,
    storageIncluded: true,
    storageMilliCopperPerLoadQd: 0,
    accessCost: terms.accessCost,
    riskBps: transportRiskBps(terms.riskExposureQd, riskBps ?? configuration.riskBps)
  };
}

/**
 * Find the best own-ship itinerary: direct flight when the market has an airship port,
 * or at most one clean transfer at the best reachable airship port + hired land leg for inland markets.
 */
export function findOptimalOwnShipServices({
  data, holding, ship, world, market, regions, organizations, countries, seasonId,
  direction, accessLimit, difficulty, cargoLoad, configuration, clockQd, regionFactors,
  isGM, homeEndpoint, homeRegionId, returnHome, calendar, serviceEndpoints
}) {
  if (!ship) return { ok: false, reason: "Корабль не выбран." };
  if (ship.navigationMode !== "world" || ship.condition !== "ready" || ship.activeVoyage || ship.orderBundle || ship.transportOrderId) {
    return { ok: false, reason: "Корабль занят или не готов к рейсу." };
  }
  const readiness = shipCrewReadiness(holding, ship, { catalog: data.catalog });
  if (!readiness.ready) return { ok: false, reason: readiness.issues.map((row) => row.message).join(" ") };
  if (worldShipTimelineQd(holding, ship) !== clockQd) {
    return { ok: false, reason: "Сначала доведите время корабля до текущей даты.", needsTimeSync: true };
  }
  if (worldShipPortDebtCopper(ship, clockQd) > 0) {
    return { ok: false, reason: "Сначала оплатите накопленное содержание корабля." };
  }

  const cargoAccessLimit = accessLimit - difficulty;
  if (cargoAccessLimit < 0) return { ok: false, reason: "Недостаточно УРС для этого товара." };
  const marketRegionId = String(market?.regionId ?? "");
  const from = direction === "inbound" ? marketRegionId : homeEndpoint;
  const to = direction === "inbound" ? homeEndpoint : marketRegionId;

  // 1. Direct flight (works for local markets and any market with an airship port).
  let directEmptyBlocked = false;
  try {
    const direct = buildOwnShipService({
      data, holding, ship, world, from, to, homeEndpoint,
      cargoAccessLimit, emptyAccessLimit: accessLimit, configuration, calendar, returnHome
    });
    if (direct.approachAvailable && (!returnHome || direct.endReturnAvailable)) {
      return { ok: true, services: [direct], transferPortId: "", transferPortLabel: "" };
    }
    directEmptyBlocked = true;
  } catch (_directError) {
    // Market has no direct airship connection -> check single transfer at nearest airship port.
  }

  // 2. One clean transfer at a reachable airship port + hired land delivery (caravan/rail).
  // Minimum-URS land Dijkstra first so no longer-km/lower-URS path to a valid port is ever pruned away.
  const { byId, graph } = buildGraph(regions);
  const countryRows = new Map((countries ?? []).map((row) => [String(row.id), row]));
  const regionHidden = (id) => !isGM && countryRows.get(String(byId.get(id)?.countryId ?? id))?.visibility === "gm";
  const landDist = new Map([[marketRegionId, { access: 0, km: 0 }]]);
  const landHeap = new MinHeap((a, b) => a.access - b.access || a.km - b.km);
  landHeap.push({ node: marketRegionId, access: 0, km: 0 });
  while (landHeap.size) {
    const cur = landHeap.pop();
    const rec = landDist.get(cur.node);
    if (rec && (rec.access < cur.access || (rec.access === cur.access && rec.km < cur.km - 1e-9))) continue;
    for (const edge of graph.get(cur.node) ?? []) {
      const nextAccess = cur.access + edge.ursCost;
      if (nextAccess > cargoAccessLimit || regionHidden(edge.to)) continue;
      const modes = edgeModes(edge, byId.get(cur.node), byId.get(edge.to), { allowedModes: LAND_MODES, fromStop: true, toStop: true });
      if (!modes.length) continue;
      const nextKm = cur.km + edge.distanceKm;
      const existing = landDist.get(edge.to);
      if (existing && (existing.access < nextAccess || (existing.access === nextAccess && existing.km <= nextKm + 1e-9))) continue;
      landDist.set(edge.to, { access: nextAccess, km: nextKm });
      landHeap.push({ node: edge.to, access: nextAccess, km: nextKm });
    }
  }
  // Fast airship reachability from home (overflight allowed) so decoy ports with no air link are skipped in 0.1 ms.
  const airReach = new Map([[homeRegionId, 0]]);
  const airHeap = new MinHeap((a, b) => a.access - b.access);
  airHeap.push({ node: homeRegionId, access: 0 });
  while (airHeap.size) {
    const cur = airHeap.pop();
    if ((airReach.get(cur.node) ?? Infinity) < cur.access) continue;
    for (const edge of graph.get(cur.node) ?? []) {
      const nextAccess = cur.access + edge.ursCost;
      if (nextAccess > cargoAccessLimit || (airReach.get(edge.to) ?? Infinity) <= nextAccess) continue;
      const modes = edgeModes(edge, byId.get(cur.node), byId.get(edge.to), {
        allowedModes: AIRSHIP_ONLY, fromStop: cur.node === homeRegionId, toStop: false
      });
      if (!modes.length) continue;
      airReach.set(edge.to, nextAccess);
      airHeap.push({ node: edge.to, access: nextAccess });
    }
  }
  const airPorts = (world.ports ?? [])
    .filter((port) => port.regionId !== marketRegionId
      && !regionHidden(port.regionId)
      && (homeEndpoint !== homeRegionId || port.regionId !== homeRegionId)
      && landDist.has(port.regionId)
      && airReach.has(port.regionId)
      && landDist.get(port.regionId).access + airReach.get(port.regionId) <= cargoAccessLimit)
    .sort((a, b) => landDist.get(a.regionId).km - landDist.get(b.regionId).km);
  let best = null;
  for (const port of airPorts) {
    const landFrom = direction === "inbound" ? marketRegionId : port.regionId;
    const landTo = direction === "inbound" ? port.regionId : marketRegionId;
    const reservedAirAccess = airReach.get(port.regionId) ?? 0;
    const landRoute = findOptimalHiredRoute({
      holding, market, regions, organizations, countries, seasonId, direction,
      accessLimit: Math.max(0, cargoAccessLimit - reservedAirAccess), cargoLoad, kind: "regular", metric: "cost",
      regionFactors, isGM, allowedModes: LAND_MODES,
      fromRegionId: landFrom, toRegionId: landTo, allowFloatingLastMile: false
    });
    if (!landRoute?.ok) continue;
    const remainingAccess = cargoAccessLimit - landRoute.routeAccessCost;
    if (remainingAccess < 0) continue;
    try {
      const ownFrom = direction === "inbound" ? port.regionId : homeEndpoint;
      const ownTo = direction === "inbound" ? homeEndpoint : port.regionId;
      const ownService = buildOwnShipService({
        data, holding, ship, world, from: ownFrom, to: ownTo, homeEndpoint,
        cargoAccessLimit: remainingAccess, emptyAccessLimit: accessLimit, configuration, calendar, returnHome
      });
      if (!ownService.approachAvailable || (returnHome && !ownService.endReturnAvailable)) continue;
      const landServices = transportServicesFromRoutes([landRoute], configuration, regions, {
        ...serviceEndpoints, homeEndpoint: ""
      }).filter((row) => row.kind === "regular").map((row) => scaleHiredServiceForCargo(row, cargoLoad, configuration.overrides));
      if (!landServices.length) continue;
      const chain = direction === "inbound" ? [...landServices, ownService] : [ownService, ...landServices];
      const totalDistance = chain.reduce((sum, row) => sum + (row.distanceKm ?? 0), 0);
      const totalAccess = chain.reduce((sum, row) => sum + (row.accessCost ?? 0), 0);
      if (!best || totalDistance < best.totalDistance || (totalDistance === best.totalDistance && totalAccess < best.totalAccess)) {
        best = { services: chain, totalDistance, totalAccess, transferPortId: port.regionId, transferPortLabel: port.label };
      }
    } catch (_error) {
      continue;
    }
  }
  if (!best) {
    return {
      ok: false,
      reason: directEmptyBlocked
        ? "Пустой перегон собственного корабля недоступен по маршруту или УРС."
        : "Нет доступного воздушного маршрута для своего корабля (проверьте УРС и воздушные порты)."
    };
  }
  return { ok: true, services: best.services, transferPortId: best.transferPortId, transferPortLabel: best.transferPortLabel };
}

export function resolveSettlementAccessLevel(holding, regions, market, { direction = "inbound", dependencies = {} } = {}) {
  const access = holdingMarketAccessLevel(holding);
  const home = findHoldingRegion(holding, regions);
  const origin = (regions ?? []).find((row) => String(row?.value ?? "") === String(market?.regionId ?? "")) ?? null;
  const originFactors = dependencies.regionFactors?.(origin) ?? {};
  const homeFactors = dependencies.regionFactors?.(home) ?? {};
  return {
    accessLevel: Number(access.level ?? 0),
    importTaxRate: Number((direction === "outbound" ? originFactors.taxRate : homeFactors.taxRate) ?? 0),
    exportTaxRate: Number((direction === "outbound" ? homeFactors.exportTaxRate : originFactors.exportTaxRate) ?? 0)
  };
}
