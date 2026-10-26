import { stableDataHash } from "../../data/storage-commit.js";
import { carrierProvidersForRoute } from "./providers.js";
import { MARKET_DEFAULT_TRANSPORT_CAPACITY_LOAD, MARKET_TRANSPORT_TARIFFS, resolveMarketLogistics, findHoldingRegion, edgeSeasonalModifier } from "./logistics.js";
import { marketTransportFreightFactor } from "./pricing.js";

export const AUTO_CARRIERS = "auto-carriers";
const MODES = Object.keys(MARKET_TRANSPORT_TARIFFS);
const TRANSFER_QD = 1;
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const sameService = (a, b) => a && b && a.mode === b.mode && a.carrierId === b.carrierId
  && (a.carrierId !== "independent-carriers" || a.fromCountryId === b.fromCountryId);

/** Country presence is the dispatch country's service market. A permitted link authorizes arrival across its border. */
export function planMarketTransport({ holding = {}, market = {}, regions = [], organizations = [], countries = [], isGM = false,
  seasonId = "", direction = "inbound", dependencies = {}, accessLevel = null, carrierId = AUTO_CARRIERS } = {}) {
  const byId = new Map(regions.map((row) => [String(row.value), row]));
  const companies = new Map(organizations.map((row) => [String(row.id), row]));
  const countryRows = new Map(countries.map((row) => [String(row.id), row]));
  const home = findHoldingRegion(holding, regions, dependencies.regionResolver);
  const localId = String(home?.value ?? ""), floating = ["sky-island", "ship"].includes(holding.type);
  const cache = new Map(), factorsCache = new Map();
  const factors = (id) => {
    if (!factorsCache.has(id)) factorsCache.set(id, dependencies.regionFactors?.(byId.get(id)) ?? {});
    return factorsCache.get(id);
  };
  const preferredCompany = carrierId && carrierId !== AUTO_CARRIERS && !carrierId.startsWith("transport:") ? carrierId : "";
  const providers = (id, mode) => {
    const countryId = String(byId.get(id)?.countryId ?? id), key = `${countryId}:${mode}`;
    if (!cache.has(key)) cache.set(key, carrierProvidersForRoute({ organizations, countryId, transportMode: mode, routeModes: [mode], isGM })
      .filter((row) => !preferredCompany || row.id === preferredCompany).map((row) => ({ ...row, dispatchCountryId: countryId })));
    return cache.get(key);
  };
  const capacityFor = (mode, carrier) => Math.max(1, finite(market[`${mode}CapacityLoad`], MARKET_DEFAULT_TRANSPORT_CAPACITY_LOAD[mode]))
    * Math.max(0.1, finite(carrier.capacityFactor, 1));
  const makeLeg = (edge, mode, carrier, kind = "route") => {
    const from = direction === "outbound" ? edge.from : edge.to, to = direction === "outbound" ? edge.to : edge.from;
    const source = byId.get(from), target = byId.get(to), place = factors(from), destination = factors(to), season = edgeSeasonalModifier(edge, seasonId);
    const tariff = MARKET_TRANSPORT_TARIFFS[mode], distanceKm = kind === "last-mile" ? 0 : Math.max(0, finite(edge.distanceKm));
    const distance = distanceKm / 40, delivery = Math.max(0.01, finite(place.delivery, 1)), time = Math.max(0.01, finite(place.time, 1));
    const priceFactor = Math.max(0.5, finite(carrier.priceFactor, 1)), timeFactor = Math.max(0.5, finite(carrier.timeFactor, 1));
    const movementQd = (kind === "last-mile" ? 1 : distance * tariff.qdPerDistance * finite(season.timeFactor, 1)) * time * timeFactor;
    const fromCountryId = String(source?.countryId ?? from), toCountryId = String(target?.countryId ?? to);
    const privateLeg = companies.get(carrier.id)?.visibility === "gm" || countryRows.get(fromCountryId)?.visibility === "gm"
      || countryRows.get(toCountryId)?.visibility === "gm";
    return { routeId: String(edge.routeId ?? ""), fromRegionId: from, toRegionId: to, fromCountryId, toCountryId,
      fromLabel: String(source?.label ?? from), toLabel: String(target?.label ?? to), mode, modeLabel: tariff.label,
      carrierId: carrier.id, carrierLabel: carrier.label, visibility: privateLeg ? "gm" : "public", kind,
      distanceKm, movementQd, travelQd: movementQd, transferQd: 0, capacityLoad: capacityFor(mode, carrier),
      dispatchCopper: tariff.dispatchCopper * priceFactor,
      hireCopper: mode === "airship" ? Math.max(0, finite(market.airshipHireCopper, 120)) * priceFactor : 0,
      distanceCopper: distance * (tariff.distanceCopper * finite(season.costFactor, 1) + Math.max(0, finite(market.deliveryDistanceCopper))) * priceFactor * delivery,
      loadCopperPerUnit: distance * (tariff.loadDistanceCopper * finite(season.costFactor, 1) + Math.max(0, finite(market.deliveryLoadDistanceCopper))) * priceFactor * delivery,
      operatingCopper: movementQd * tariff.operatingCopperPerQd * priceFactor * delivery,
      riskFactor: Math.max(0.25, finite(place.risk, 1) * finite(destination.risk, 1) * finite(season.riskFactor, 1) * finite(carrier.riskFactor, 1)),
      priceFactor, timeFactor, capacityFactor: Math.max(0.1, finite(carrier.capacityFactor, 1)), sharePct: carrier.sharePct,
      freightFactor: marketTransportFreightFactor(mode) * priceFactor * delivery };
  };
  const localAvailable = Boolean(home?.marketTransportModes?.includes("airship") && providers(localId, "airship").length);
  const network = {
    localAirshipAvailable: localAvailable,
    servicesForEdge: (from, edge, mode) => {
      const dispatch = direction === "outbound" ? from : edge.to;
      const rows = providers(dispatch, mode).map((carrier) => ({ carrier }));
      if (floating && from === localId && mode !== "airship") return localAvailable
        ? rows.flatMap((row) => providers(localId, "airship").map((localAirship) => ({ ...row, localAirship }))) : [];
      return rows;
    },
    termsForEdge: (edge, mode, service, current) => {
      const leg = makeLeg(edge, mode, service.carrier), previous = current.edges.at(-1);
      const continues = previous?.selectedMode === mode && previous?.service?.carrier.id === service.carrier.id
        && (!service.carrier.independent || previous.service.carrier.dispatchCountryId === service.carrier.dispatchCountryId);
      if (continues) { leg.dispatchCopper = 0; leg.hireCopper = 0; }
      const legs = [leg];
      if (service.localAirship) legs.push(makeLeg({ from: localId, to: localId }, "airship", service.localAirship, "last-mile"));
      const curves = {};
      for (const row of legs) curves[row.capacityLoad] = (curves[row.capacityLoad] ?? 0) + row.dispatchCopper + row.hireCopper
        + row.distanceCopper + row.operatingCopper + row.capacityLoad * row.loadCopperPerUnit;
      return { flat: legs.reduce((sum, row) => sum + row.dispatchCopper + row.hireCopper + row.distanceCopper, 0),
        load: legs.reduce((sum, row) => sum + row.loadCopperPerUnit, 0),
        operating: legs.reduce((sum, row) => sum + row.operatingCopper, 0),
        time: legs.reduce((sum, row) => sum + row.movementQd, 0) + ((previous && !continues) ? TRANSFER_QD : 0) + (service.localAirship ? TRANSFER_QD : 0),
        risk: Math.max(...legs.map((row) => row.riskFactor)), capacity: Math.min(...legs.map((row) => row.capacityLoad)), curves,
        valueCost: leg.distanceKm * leg.freightFactor };
    }
  };
  const args = { holding, market, regions, seasonId, direction, dependencies, accessLevel, transportNetwork: network };
  let base = resolveMarketLogistics(args), raw = base.routeCandidates?.length ? base.routeCandidates : base.ok ? [base] : [];
  if (base.sameRegion && home) {
    const modes = (market.transportModes ?? MODES).filter((mode) => home.marketTransportModes?.includes(mode)
      && (!floating && !home.marketAirshipOnly || mode === "airship"));
    raw = modes.flatMap((mode) => providers(localId, mode).map((carrier) => resolveMarketLogistics({ ...args, singleRoute: true,
      selectedRoute: { path: [localId], edges: [{ from: localId, to: localId, distanceKm: 20, distance: 0.5, selectedMode: mode,
        modes: [mode], service: { carrier } }], distanceKm: 20, distance: 0.5, hops: 0, accessCost: 0 }
    }))).filter((row) => row.ok);
  }
  // Legacy logistics can estimate an unconfigured endpoint; a real agreement needs actual legs.
  const candidates = raw.filter((route) => route.transportEdges?.length).map((route) => {
    const { transportEdges = [], routeCandidates: _alternatives, ...legacy } = route;
    const oriented = direction === "inbound" ? [...transportEdges].reverse() : transportEdges;
    const legs = oriented.map((edge) => makeLeg(edge, edge.selectedMode, edge.service.carrier));
    const localAirship = transportEdges[0]?.service?.localAirship;
    if (localAirship) {
      const last = makeLeg({ from: localId, to: localId }, "airship", localAirship, "last-mile");
      if (direction === "inbound") legs.push(last); else legs.unshift(last);
    }
    for (const [index, leg] of legs.entries()) {
      if (sameService(legs[index - 1], leg)) { leg.dispatchCopper = 0; leg.hireCopper = 0; }
      else if (index) { leg.transferQd = TRANSFER_QD; leg.travelQd += TRANSFER_QD; }
    }
    const key = `transport:${stableDataHash(legs.map((leg) => [leg.fromRegionId, leg.toRegionId, leg.routeId, leg.mode, leg.carrierId]))}`;
    legs.forEach((leg, index) => { leg.id = `${key}:${index}`; });
    const sum = (field) => legs.reduce((total, leg) => total + finite(leg[field]), 0);
    const distanceKm = sum("distanceKm"), capacityLoad = Math.min(...legs.map((leg) => leg.capacityLoad));
    const transportPlan = { version: 1, key, direction, legs, distanceKm, travelQd: sum("travelQd"), capacityLoad,
      dispatchCopper: sum("dispatchCopper"), distanceCopper: sum("distanceCopper"), operatingCopper: sum("operatingCopper"),
      hireCopper: sum("hireCopper"), loadCopperPerUnit: sum("loadCopperPerUnit"), riskFactor: Math.max(...legs.map((leg) => leg.riskFactor)),
      freightFactor: distanceKm > 0 ? legs.reduce((total, leg) => total + leg.distanceKm * leg.freightFactor, 0) / distanceKm : 1,
      transferQd: sum("transferQd") };
    const identities = new Set(legs.map((leg) => leg.carrierId === "independent-carriers" ? `${leg.carrierId}:${leg.fromCountryId}` : leg.carrierId));
    return { ...legacy, transportPlan, carrierId: identities.size === 1 ? legs[0].carrierId : key,
      carrierLabel: identities.size === 1 ? legs[0].carrierLabel : "Составная перевозка", carrierSharePct: Math.min(...legs.map((leg) => leg.sharePct)), carrierPriceFactor: 1,
      carrierRiskFactor: 1, carrierTimeFactor: 1, carrierCapacityFactor: 1, baseCapacityLoad: capacityLoad, capacityLoad,
      travelQd: Math.max(1, Math.ceil(transportPlan.travelQd)), riskFactor: transportPlan.riskFactor,
      distanceFlatCopper: Math.ceil(transportPlan.dispatchCopper + transportPlan.distanceCopper + transportPlan.operatingCopper + transportPlan.hireCopper),
      distanceLoadCopper: transportPlan.loadCopperPerUnit, dispatchCopper: transportPlan.dispatchCopper,
      routeDistanceCopper: transportPlan.distanceCopper, configuredDistanceFlatCopper: 0, configuredDistanceLoadCopper: 0,
      routeFlatBeforeFactorCopper: transportPlan.dispatchCopper + transportPlan.distanceCopper + transportPlan.operatingCopper,
      routeLoadBeforeFactorCopper: transportPlan.loadCopperPerUnit,
      operatingTimeCopper: transportPlan.operatingCopper, routeOperatingTimeCopper: transportPlan.operatingCopper,
      airshipHireCopper: transportPlan.hireCopper };
  });
  const automatic = { id: AUTO_CARRIERS, label: "Автоматически · самый выгодный план", automatic: true, capacityFactor: 1, priceFactor: 1 };
  const descriptors = candidates.map((logistics) => ({ id: logistics.transportPlan.key, label: "Маршрут по участкам", chain: true,
    logistics, transportPlan: logistics.transportPlan, capacityLoad: logistics.capacityLoad, travelQd: logistics.travelQd, priceFactor: 1, capacityFactor: 1 }));
  const chosen = descriptors.find((row) => row.id === carrierId);
  const selected = chosen ? [chosen.logistics] : candidates;
  const staleChain = carrierId?.startsWith("transport:") && !chosen;
  // Callers persist this descriptor across recalculations, including unsuccessful ones.
  const carrier = chosen ?? (staleChain ? { id: carrierId, label: "Выбранный план недоступен", unavailable: true }
    : preferredCompany && candidates.length ? { id: preferredCompany, label: candidates[0].carrierLabel } : automatic);
  if (!selected.length || !base.ok && !base.sameRegion) return { logistics: { ...base, ok: false,
    reasons: base.reasons?.length ? base.reasons : ["Нет доступной цепочки перевозчиков для маршрута."], routeCandidates: [] }, carriers: [automatic, ...descriptors], carrier };
  base = { ...selected[0], routeCandidates: selected };
  if (staleChain) base = { ...base, ok: false, reasons: ["Выбранный маршрут изменился или больше недоступен. Выберите другой вариант."], routeCandidates: [] };
  return { logistics: base, carriers: [automatic, ...descriptors], carrier };
}
