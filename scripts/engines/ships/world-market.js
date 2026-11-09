import { allResourceDefs } from "../../core/resources.js";
import { normalizeMarketEconomy } from "../../data/market/economy.js";
import { normalizeEventRegionOptions } from "../../data/random-events.js";
import { stableDataHash } from "../../data/storage-commit.js";
import { isResidentRestingOnShip } from "../../data/resident-presence.js";
import { composeMarketLocation, effectiveMarketLocations, marketLocationFactors } from "../market/composition.js";
import { shortestMarketRoute } from "../market/logistics.js";
import { getCalendariaSeasonSnapshot } from "../../integrations/calendaria-bridge.js";
import { attentionLevel, attentionLabel, contractGuidance } from "./contracts.js";
import { shipCrewComposition } from "./crew-readiness.js";
import { calculateShipCosts, getShipProfile, shipCapacityLoadPoints } from "./profiles.js";
import { shipIdleReserveCopper } from "./fleet-accounting.js";
import { bundleOutcomeReserves } from "./bundle-accounting.js";
import { laborWageRate } from "../economy/labor-wage-rate.js";
import { transportHandlingTerms } from "../transport/quantities.js";
import { localMarketDistanceKm, transportRationPrice, transportPortCapacity, transportPortHandlingQd, transportRiskBps, transportServiceCharge } from "../transport/economics.js";
import { validateTransportConfiguration } from "../transport/services.js";
import { customerTransportFare, ordinaryFreightBudget } from "./customer-fares.js";
import { clientCargoLifetime, clientCargoViableAt, startClientCargo } from "./client-cargo.js";
import { transportSeasonalCalendar, transportSeasonalMovement } from "../transport/seasonal.js";

// Customer consignments aggregate wholesale lots, not the retail stock purchasable by the settlement.
const WHOLESALE_LOTS = 20;

const normalized = (value) => String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase("ru");
const money = (value) => {
  const result = Math.ceil(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > 1_000_000_000) throw new Error("Смета корабля выходит за допустимые пределы.");
  return result;
};
const point = (port) => ({ kind: port.kind, id: port.id, regionId: port.regionId, label: port.label });
const publicOffer = (offer) => offer?.active !== false && offer?.visibility !== "gm";
const contextMarketSources = new WeakMap();

/** Own ships use the public world route graph, not the settlement's hired-carrier reach. */
export function buildShipWorldContext(data, holding, { offerLocationIds = null } = {}) {
  const regions = normalizeEventRegionOptions(data?.catalog?.eventRegions ?? [], { fallback: false });
  const resources = allResourceDefs({ catalogRows: data?.catalog?.resources });
  const economy = normalizeMarketEconomy(data?.catalog?.marketEconomy, { locations: regions });
  const region = regions.find((row) => [row.value, row.label, ...(row.aliases ?? [])].some((value) => normalized(value) === normalized(holding?.overview?.region)));
  const issues = [];
  if (!region) issues.push("У поселения не выбрана локация мирового рынка. Укажите регион поселения и воздушные связи в карте маршрутов.");
  const home = { kind: "home", id: String(holding?.id ?? "home"), regionId: String(region?.value ?? ""), label: holding?.name || "Поселение",
    localDistanceKm: localMarketDistanceKm(holding) };
  const includedOffers = offerLocationIds === null ? null : new Set([...offerLocationIds, home.regionId].filter(Boolean).map(String));
  const markets = effectiveMarketLocations({ economy, locations: regions, resources, isGM: false, normalizedEconomy: true, offerLocationIds: includedOffers });
  // Public transit points may be part of a flight even when they are not open ports.
  const publicCountries = new Set(economy.countries.filter((country) => country.visibility !== "gm")
    .map((country) => country.id));
  const mapRegionIds = regions.filter((row) => publicCountries.has(row.countryId)).map((row) => row.value);
  const ports = markets.filter((market) => market.transportModes.includes("airship")).map((market) => ({
    ...market, kind: "market", offers: market.offers.filter(publicOffer), outboundOffers: market.outboundOffers.filter(publicOffer),
    factors: marketLocationFactors(regions.find((row) => row.value === market.regionId), economy, regions, { normalizedEconomy: true })
  })).filter((port) => port.factors.enabled);
  if (!ports.length) issues.push("Нет открытых мировых портов с воздушным сообщением.");
  const calendar = holding.gm?.calendaria ?? {};
  const seasonId = getCalendariaSeasonSnapshot(calendar.lastDateTime, calendar.lastDateText)?.season?.key ?? "";
  const context = { ports, home, issues, regions, resources, mapRegionIds, seasonId, seasonalCalendar: transportSeasonalCalendar(holding) };
  contextMarketSources.set(context, {
    economy,
    hydratedPortIds: includedOffers === null
      ? new Set(ports.map((port) => port.id))
      : new Set(ports.filter((port) => includedOffers.has(port.id)).map((port) => port.id))
  });
  return context;
}

function portWithOffers(context, portOrId) {
  const id = String(typeof portOrId === "object" ? portOrId?.id : portOrId ?? "");
  const port = context.ports.find((row) => row.id === id);
  if (!port) return typeof portOrId === "object" ? portOrId : null;
  const source = contextMarketSources.get(context);
  if (!source || source.hydratedPortIds.has(id)) return port;
  const location = context.regions.find((row) => row.value === port.regionId);
  const market = composeMarketLocation({
    location,
    economy: source.economy,
    resources: context.resources,
    locations: context.regions,
    normalizedEconomy: true,
    includeOffers: true
  });
  port.offers = (market?.offers ?? []).filter(publicOffer);
  port.outboundOffers = (market?.outboundOffers ?? []).filter(publicOffer);
  source.hydratedPortIds.add(id);
  return port;
}

function commandOfferLocations(ship, extraIds = []) {
  return new Set([
    ship?.location?.id,
    ship?.location?.regionId,
    ...extraIds
  ].filter(Boolean).map(String));
}

function currentPort(context, ship, { allowClosed = false } = {}) {
  if (!ship?.location || ship.location.kind === "home") {
    if (!context.home.regionId) throw new Error(context.issues[0]);
    return { ...context.home, offers: [], outboundOffers: [] };
  }
  const port = context.ports.find((row) => row.id === ship.location.id);
  if (!port && allowClosed) {
    const region = context.regions.find((row) => row.value === ship.location.regionId || row.value === ship.location.id);
    if (region) return { ...ship.location, regionId: region.value, offers: [] };
  }
  if (!port) throw new Error("Текущий порт корабля недоступен в мировом рынке. Проверьте настройки локации.");
  return port;
}

function rationPrice(context, port) {
  return transportRationPrice(context.resources, port);
}

function sailorDailyWage(person) {
  return laborWageRate({ volunteer: person.volunteerLabor, wageOverrideCopper: person.wageDailyOverrideCopper, dailyRateCopper: 12 }).effectiveDailyRateCopper ?? 0;
}

function crewEconomics(holding, ship) {
  const composition = shipCrewComposition(holding, ship);
  const people = composition.entries.filter((entry) => entry.living).map((entry) => entry.person);
  const crewCount = composition.totalCount;
  const abstractCount = composition.abstractCount;
  const crewDailyCopper = people.reduce((sum, person) => sum + sailorDailyWage(person), abstractCount * 12);
  return { crewCount, crewDailyCopper, abstractCount };
}

function homeCrewEconomics(holding, ship) {
  const composition = shipCrewComposition(holding, ship);
  const projectedReturn = Boolean(
    ship?.activeVoyage
    || ship?.status === "away"
    || (ship?.location && ship.location.kind !== "home")
  );
  const people = composition.entries
    .filter((entry) => entry.living && (projectedReturn || isResidentRestingOnShip(entry.person, holding)))
    .map((entry) => entry.person);
  const abstractCount = composition.abstractCount;
  const crewDailyCopper = people.reduce(
    (sum, person) => sum + sailorDailyWage(person),
    abstractCount * 12
  );
  const restingIds = new Set(people.map((person) => String(person.id)));
  const wageIssues = composition.issues.filter((issue) => issue.code === "wage-rate" && restingIds.has(issue.residentId));
  return { restingCount: people.length, crewDailyCopper, abstractCount, wageIssues };
}

/** Current home rate without changing stored bills, voyages or money. */
export function quoteWorldShipHomeUpkeep(data, holding, ship, { context = null } = {}) {
  const world = context ?? buildShipWorldContext(data, holding, { offerLocationIds: commandOfferLocations(ship) });
  const homePort = { ...world.ports.find((port) => port.regionId === world.home.regionId), ...world.home };
  const profile = getShipProfile(ship.profileId);
  const { restingCount, crewDailyCopper, abstractCount, wageIssues } = homeCrewEconomics(holding, ship);
  // Invalid legacy wages require an explicit correction. Keep the existing
  // home rate rather than silently making paid crew free or blocking a return.
  const rateFrozen = ship.homeUpkeepEnabled !== false && wageIssues.length > 0;
  const homeUpkeepCopperPerDay = ship.homeUpkeepEnabled === false ? 0 : rateFrozen
    ? money(ship.homeUpkeepCopperPerDay ?? profile.upkeepDailyCopper) : money(
    profile.upkeepDailyCopper
    + crewDailyCopper
    + (restingCount + abstractCount) * rationPrice(world, homePort)
  );
  return { homeUpkeepCopperPerDay, restingCrewCount: restingCount, abstractCrewCount: abstractCount, wageIssues, rateFrozen };
}

/** Refresh only on an explicit ship command; loading does not alter saved voyages or money. */
export function configureWorldShipEconomy(data, holding, ship, options = {}) {
  const quote = quoteWorldShipHomeUpkeep(data, holding, ship, options);
  ship.homeUpkeepCopperPerDay = quote.homeUpkeepCopperPerDay;
  if (ship.portBilling?.scope === "home") {
    const bill = ship.portBilling;
    const clockQd = Math.max(bill.lastCalculatedQd,
      Number(ship.timelineQd ?? holding.gm?.calendaria?.lastQd ?? 0));
    const accrued = money(bill.dailyCopper * (clockQd - bill.sinceQd) / 4);
    const carriedCopper = money(Math.max(0, bill.carriedCopper + accrued - bill.chargedCopper));
    ship.portBilling = { scope: "home", sinceQd: clockQd, dailyCopper: ship.homeUpkeepCopperPerDay, chargedCopper: 0, carriedCopper, lastCalculatedQd: clockQd };
    ship.pendingPortBillCopper = carriedCopper;
  }
  return quote;
}

function routeTerms(context, ship, from, to, { maxAccess = Infinity, includeRisk = false,
  startQd = Number(ship.timelineQd ?? context.seasonalCalendar?.anchorQd ?? 0), includeSeasonal = false } = {}) {
  const found = shortestMarketRoute(from.regionId, to.regionId, context.regions, { mode: "airship", maxAccess });
  if (!found) throw new Error(`Нет воздушного маршрута: ${from.label} → ${to.label}.`);
  const route = { ...found };
  if (from.regionId === to.regionId && from.kind !== to.kind) {
    const localDistance = Number((from.kind === "home" ? from : to).localDistanceKm ?? 20);
    route.distanceKm = localDistance;
    route.edges = [{ from: from.regionId, to: to.regionId, distanceKm: localDistance }];
  }
  const speedKmPerDay = Number(ship.speedKmPerDay || getShipProfile(ship.profileId).speedKmPerDay);
  if (!Number.isFinite(speedKmPerDay) || speedKmPerDay <= 0) throw new Error("Укажите положительную скорость корабля.");
  const economy = contextMarketSources.get(context)?.economy, factors = new Map();
  const riskAt = id => {
    if (!includeRisk) return 1;
    if (!factors.has(id)) factors.set(id, marketLocationFactors(context.regions.find(region => region.value === id),
      economy, context.regions, { normalizedEconomy: true }).risk);
    return factors.get(id);
  };
  const edges = route.edges.length ? route.edges : [{ from: from.regionId, to: to.regionId, distanceKm: route.distanceKm }];
  // The daily speed already includes ordinary nights and core rest. Calendar boundaries do not add stops.
  const seasonal = { calendar: { ...context.seasonalCalendar, fallbackSeasonId: context.seasonId }, costSeasonal: false,
    legs: edges.map(edge => ({ movementQd: edge.distanceKm * 4 / speedKmPerDay,
      riskFactor: riskAt(edge.from) * riskAt(edge.to), seasonalModifiers: edge.seasonalModifiers ?? {} })) };
  const movement = transportSeasonalMovement(seasonal, startQd);
  const result = { distanceKm: route.distanceKm, speedKmPerDay, durationQd: movement.durationQd, path: route.path, accessCost: route.accessCost };
  if (includeRisk) Object.assign(result, { riskFactor: movement.riskFactor, riskExposureQd: movement.riskExposureQd });
  if (includeSeasonal) result.seasonal = seasonal;
  return result;
}

function portHandlingQd(port, loadPoints) {
  return transportPortHandlingQd(port, loadPoints);
}

function portHandlingCopper(ports, loadPoints) {
  if (!loadPoints) return 0;
  return transportServiceCharge({ kind: "regular",
    ...transportHandlingTerms(ports.filter(port => port.kind !== "home").map(port => port.locationProfile)) }, loadPoints * 1000, 0).totalCopper;
}

function portForPoint(context, point) {
  return context.ports.find((port) => port.regionId === point?.regionId)
    ?? context.ports.find((port) => port.id === point?.id)
    ?? point;
}

/** View-only breakdown; the accepted quote stores only its total duration. */
export function worldShipTimeBreakdown(context, offer) {
  const load = Number(offer?.contract?.cargo?.loadPoints ?? 0);
  const origin = portForPoint(context, offer?.contract?.pickup ?? offer?.from);
  const destination = portForPoint(context, offer?.to);
  const loadingQd = portHandlingQd(origin, load);
  const unloadingQd = portHandlingQd(destination, load);
  return {
    flightQd: Number(offer?.quote?.durationQd ?? 0) - loadingQd - unloadingQd,
    loadingQd,
    unloadingQd
  };
}

function costsFor(context, holding, ship, from, to, route, cargo = null) {
  const crew = crewEconomics(holding, ship);
  // A home departure point carries no offers: resolve its market for the same ration price as home upkeep.
  const foodUnitCopper = rationPrice(context, portForPoint(context, from));
  // Client freight pays export at pickup and import at its actual destination.
  const customsExempt = cargo?.kind === "smuggling";
  const importTaxRate = customsExempt || to.kind === "home" ? 0 : (to.factors?.taxRate ?? 0);
  const exportTaxRate = customsExempt ? 0 : (portForPoint(context, from)?.factors?.exportTaxRate ?? 0);
  const values = {
    durationQd: route.durationQd, crewCount: crew.crewCount, crewDailyCopper: crew.crewDailyCopper,
    wageDailyCopper: 12, foodUnitCopper, handlingLoadPoints: 0, cargoValueCopper: cargo?.valueCopper ?? 0,
    taxRate: 0
  };
  const costs = calculateShipCosts(ship, values);
  costs.importTaxCopper = money((cargo?.valueCopper ?? 0) * importTaxRate);
  costs.exportTaxCopper = money((cargo?.valueCopper ?? 0) * exportTaxRate);
  costs.taxCopper = money(costs.importTaxCopper + costs.exportTaxCopper);
  // Use the port's handling table, without dispatch/hire charges for an external carrier.
  const handling = portHandlingCopper([from, to], cargo?.loadPoints ?? 0);
  costs.handlingCopper = handling;
  costs.totalCopper = costs.operatingCopper = money(costs.foodCopper + costs.crewCopper + costs.upkeepCopper + handling + costs.taxCopper);
  const daily = calculateShipCosts(ship, { ...values, foodUnitCopper: rationPrice(context, portForPoint(context, to)), durationQd: 4, cargoValueCopper: 0, taxRate: 0 });
  return { costs, dailyCopper: daily.totalCopper, foodUnitCopper };
}

/** Shared physical inputs for transport orders; customer rewards remain independent market offers. */
export function worldShipTransportTerms(data, holding, ship, fromRegionId, toRegionId,
  { context = null, loadPoints = 0, maxAccess = Infinity, fromHome = true, toHome = true, startQd = null } = {}) {
  const world = context ?? buildShipWorldContext(data, holding);
  const findPort = (id, atHome) => id === world.home.regionId && atHome ? world.home : world.ports.find((port) => port.regionId === id);
  const from = findPort(fromRegionId, fromHome), to = findPort(toRegionId, toHome);
  if (!from || !to) throw new Error("Для погрузки и выгрузки своего судна нужны доступные порты.");
  const loadingQd = portHandlingQd(from, loadPoints);
  const departureQd = startQd ?? Number(ship.timelineQd ?? holding.gm?.calendaria?.lastQd ?? 0) + loadingQd;
  const route = routeTerms(world, ship, from, to, { maxAccess, includeRisk: true, includeSeasonal: true, startQd: departureQd });
  const crew = crewEconomics(holding, ship);
  const dailyCopper = crew.crewDailyCopper + crew.crewCount * rationPrice(world, portForPoint(world, from))
    + getShipProfile(ship.profileId).upkeepDailyCopper;
  return { ...route, from: point(from), to: point(to),
    loadingQd, unloadingQd: portHandlingQd(to, loadPoints),
    loadingCapacity: transportPortCapacity(from), unloadingCapacity: transportPortCapacity(to),
    operatingMilliCopperPerQd: dailyCopper * 250,
    dailyCosts: { foodCopper: crew.crewCount * rationPrice(world, portForPoint(world, from)), crewCopper: crew.crewDailyCopper,
      upkeepCopper: getShipProfile(ship.profileId).upkeepDailyCopper },
    ...transportHandlingTerms([from, to].filter(port => port.kind !== "home").map(port => portForPoint(world, port).locationProfile)),
    idleUpkeepCopperPerDay: costsFor(world, holding, ship, from, to, { durationQd: 4 }).dailyCopper };
}

function baseQuote(context, holding, ship, from, to, cargo, pickup = null) {
  const origin = pickup ?? from;
  const load = Number(cargo?.loadPoints ?? 0);
  const loadingQd = portHandlingQd(origin, load);
  const clockQd = Number(ship.timelineQd ?? holding.gm?.calendaria?.lastQd ?? 0);
  const approach = pickup ? routeTerms(context, ship, from, pickup, { includeRisk: true, startQd: clockQd }) : null;
  const approachQd = approach?.durationQd ?? 0;
  const route = routeTerms(context, ship, origin, to, { includeRisk: true, startQd: clockQd + approachQd + loadingQd });
  route.approachRiskExposureQd = 0;
  route.durationQd += loadingQd + portHandlingQd(to, load);
  if (route.durationQd > 100000) throw new Error("Маршрут слишком продолжительный.");
  const { costs, dailyCopper, foodUnitCopper } = costsFor(context, holding, ship, origin, to, route, cargo);
  if (approach) {
    const emptyCosts = costsFor(context, holding, ship, from, pickup, approach).costs;
    for (const key of Object.keys(costs)) costs[key] = money(costs[key] + emptyCosts[key]);
    route.distanceKm += approach.distanceKm;
    route.riskExposureQd += approach.riskExposureQd;
    route.approachRiskExposureQd = approach.riskExposureQd;
    route.durationQd += approach.durationQd;
    route.accessCost += approach.accessCost;
    route.path = [...approach.path, ...route.path.slice(1)];
    if (route.durationQd > 100000) throw new Error("Маршрут слишком продолжительный.");
  }
  const arrivalQd = clockQd + route.durationQd;
  const reserve = to.kind === "home" ? 0 : costsFor(context, holding, ship, to, context.home, routeTerms(context, ship, to, context.home, { startQd: arrivalQd })).costs.totalCopper;
  if (cargo) startClientCargo(cargo, arrivalQd - route.durationQd + approachQd + loadingQd, loadingQd);
  const idleReserveCopper = to.kind === "home" ? 0 : shipIdleReserveCopper(dailyCopper, arrivalQd);
  return {
    ...route, costs, operatingCopper: costs.totalCopper, preparationCopper: 0, rewardCopper: 0,
    idleUpkeepCopperPerDay: dailyCopper, returnReserveCopper: reserve,
    idleReserveCopper, recommendedBudgetCopper: money(costs.totalCopper + reserve + idleReserveCopper), foodUnitCopper
  };
}

const bundlePortKey = (port) => `${port?.kind}:${port?.id}`;

function customerRouteRisk(quote, kind, attention, baseRiskBps) {
  const approach = quote.approachRiskExposureQd ?? 0;
  const laden = Math.max(0, quote.riskExposureQd - approach);
  return { riskBps: transportRiskBps(approach + laden * (kind === "smuggling" ? 2 + attention / 10 : 1), baseRiskBps),
    approachRiskBps: transportRiskBps(approach, baseRiskBps) };
}

/** Plan several customer consignments without reserving stock or changing ship state. */
export function quoteWorldShipBundle(data, holding, ship, offers, { context = null } = {}) {
  if (ship.navigationMode !== "world" || ship.activeVoyage || ship.orderBundle) throw new Error("Корабль уже занят рейсом.");
  if (!Array.isArray(offers) || offers.length < 2 || offers.length > 3) throw new Error("Выберите два или три заказа.");
  if (new Set(offers.map((offer) => offer?.id)).size !== offers.length) throw new Error("Один заказ нельзя выбрать дважды.");
  if (new Set(offers.map(offer => offer.contract?.economics?.version ?? 0)).size > 1) {
    throw new Error("Обновите свободные предложения перед объединением заказов с разными условиями.");
  }
  offers = structuredClone(offers);
  const world = context ?? buildShipWorldContext(data, holding, {
    offerLocationIds: new Set(offers.flatMap((offer) => [offer?.from?.id, offer?.contract?.pickup?.id, offer?.to?.id]).filter(Boolean))
  });
  const origin = currentPort(world, ship);
  const originKey = bundlePortKey(origin);
  const capacity = shipCapacityLoadPoints(ship);
  const hiddenCapacity = Number(ship.hiddenCapacityLoadPoints || 0);
  const jobs = offers.map((offer) => {
    if (offer?.mode !== "world" || offer.shipId !== ship.id || !offer.contract
      || bundlePortKey(offer.from) !== originKey) throw new Error("Заказы должны быть свободны в текущем порту корабля.");
    const pickup = offer.contract.pickup ?? offer.from;
    const load = Number(offer.contract.cargo?.loadPoints);
    if (!Number.isSafeInteger(load) || load <= 0 || load > capacity) throw new Error("Некорректная вместимость заказа.");
    const hidden = offer.contract.kind === "smuggling" ? load : 0;
    if (hidden > hiddenCapacity) throw new Error("Груз не помещается в тайники.");
    return { offer, pickup, load, hidden };
  });
  const stops = new Map();
  for (const job of jobs) {
    for (const point of [job.pickup, job.offer.to]) {
      if (bundlePortKey(point) === originKey) continue;
      const port = world.ports.find((row) => row.id === point.id);
      if (!port || port.regionId !== point.regionId) throw new Error("Порт заказа больше недоступен.");
      stops.set(bundlePortKey(point), port);
    }
  }
  const stopPorts = [...stops.values()].sort((a, b) => bundlePortKey(a).localeCompare(bundlePortKey(b)));
  if (!stopPorts.length) throw new Error("У заказов нет порта доставки.");
  const initialJobs = jobs.filter((job) => bundlePortKey(job.pickup) === originKey);
  const startingLoad = initialJobs.reduce((sum, job) => sum + job.load, 0);
  const startingHidden = initialJobs.reduce((sum, job) => sum + job.hidden, 0);
  if (startingLoad > capacity || startingHidden > hiddenCapacity) throw new Error("Совместные грузы не помещаются на корабле.");
  const initialHandlingQd = portHandlingQd(origin, startingLoad);
  // With one visit per port, all its outgoing consignments must fit together.
  for (const port of stopPorts) {
    const pickups = jobs.filter((job) => bundlePortKey(job.pickup) === bundlePortKey(port));
    const load = pickups.reduce((sum, job) => sum + job.load, 0);
    const hidden = pickups.reduce((sum, job) => sum + job.hidden, 0);
    if (load > capacity) throw new Error(`В порту ${port.label} совместные грузы не помещаются: ${load} / ${capacity}.`);
    if (hidden > hiddenCapacity) throw new Error(`В порту ${port.label} перегружены тайники: ${hidden} / ${hiddenCapacity}.`);
  }
  let best = null;
  const routeCache = new Map();
  const legRoute = (from, to, startQd) => {
    const key = `${bundlePortKey(from)}>${bundlePortKey(to)}`;
    if (!routeCache.has(key)) {
      try { routeCache.set(key, routeTerms(world, ship, from, to, { includeRisk: true, includeSeasonal: true, startQd })); }
      catch (_error) { routeCache.set(key, null); }
    }
    const route = routeCache.get(key);
    if (!route) return null;
    const { seasonal, ...terms } = route, movement = transportSeasonalMovement(seasonal, startQd);
    return { ...terms, durationQd: movement.durationQd, riskExposureQd: movement.riskExposureQd, riskFactor: movement.riskFactor };
  };
  const visit = (sequence, remaining, carried, load, hidden, previous, durationQd, distanceKm, loadedAt) => {
    if (!remaining.length) {
      if (carried.size) return;
      const candidate = { sequence, durationQd, distanceKm };
      if (!best || durationQd < best.durationQd || (durationQd === best.durationQd && distanceKm < best.distanceKm)) best = candidate;
      return;
    }
    for (const port of remaining) {
      const route = legRoute(previous, port, Number(ship.timelineQd ?? holding.gm?.calendaria?.lastQd ?? 0) + durationQd);
      if (!route || route.distanceKm <= 0) continue;
      const nextCarried = new Set(carried);
      const deliveries = jobs.filter((job) => bundlePortKey(job.offer.to) === bundlePortKey(port));
      if (deliveries.some((job) => !nextCarried.has(job.offer.id))) continue;
      let nextLoad = load;
      let nextHidden = hidden;
      for (const job of deliveries) {
        nextCarried.delete(job.offer.id);
        nextLoad -= job.load;
        nextHidden -= job.hidden;
      }
      const pickups = jobs.filter((job) => bundlePortKey(job.pickup) === bundlePortKey(port));
      for (const job of pickups) {
        nextCarried.add(job.offer.id);
        nextLoad += job.load;
        nextHidden += job.hidden;
      }
      if (nextLoad > capacity || nextHidden > hiddenCapacity) continue;
      const handlingQd = portHandlingQd(port,
        deliveries.reduce((sum, job) => sum + job.load, 0) + pickups.reduce((sum, job) => sum + job.load, 0));
      const nextDurationQd = durationQd + route.durationQd + handlingQd;
      if (deliveries.some(job => clientCargoLifetime(job.offer.contract.cargo)
        && nextDurationQd - loadedAt.get(job.offer.id) >= clientCargoLifetime(job.offer.contract.cargo))) continue;
      const nextLoadedAt = new Map(loadedAt);
      const pickupHandlingQd = portHandlingQd(port, pickups.reduce((sum, job) => sum + job.load, 0));
      for (const job of pickups) nextLoadedAt.set(job.offer.id, nextDurationQd - pickupHandlingQd);
      visit([...sequence, port], remaining.filter((row) => row !== port), nextCarried,
        nextLoad, nextHidden, port, nextDurationQd, distanceKm + route.distanceKm, nextLoadedAt);
    }
  };
  visit([], stopPorts, new Set(initialJobs.map((job) => job.offer.id)), startingLoad, startingHidden,
    origin, initialHandlingQd, 0, new Map(initialJobs.map(job => [job.offer.id, 0])));
  if (!best) throw new Error("Для выбранных заказов нет совместимого маршрута и свободного места в трюме.");
  let previous = origin;
  let totalOperatingCopper = 0;
  let carriedLoadPoints = startingLoad;
  const newEconomics = offers.every(offer => offer.contract.economics?.version === 1);
  const carriedIds = new Set(initialJobs.map(job => job.offer.id));
  const configuration = validateTransportConfiguration(data.catalog?.transportV2);
  let loadedClockQd = Number(ship.timelineQd ?? holding.gm?.calendaria?.lastQd ?? 0) + initialHandlingQd;
  for (const job of initialJobs) startClientCargo(job.offer.contract.cargo, loadedClockQd, initialHandlingQd);
  const plannedStops = best.sequence.map((port, index) => {
    const route = legRoute(previous, port, loadedClockQd);
    const pickups = jobs.filter((job) => bundlePortKey(job.pickup) === bundlePortKey(port));
    const deliveries = jobs.filter((job) => bundlePortKey(job.offer.to) === bundlePortKey(port));
    const loadOnLegPoints = carriedLoadPoints;
    const cargoOfferIds = [...carriedIds];
    const illegalRisk = Math.max(1, ...jobs.filter(job => carriedIds.has(job.offer.id) && job.offer.contract.kind === "smuggling")
      .map(job => 2 + job.offer.contract.attention.level / 10));
    deliveries.forEach(job => carriedIds.delete(job.offer.id));
    pickups.forEach(job => carriedIds.add(job.offer.id));
    carriedLoadPoints += pickups.reduce((sum, job) => sum + job.load, 0)
      - deliveries.reduce((sum, job) => sum + job.load, 0);
    const handlingQd = portHandlingQd(port,
      pickups.reduce((sum, job) => sum + job.load, 0) + deliveries.reduce((sum, job) => sum + job.load, 0))
      + (index === 0 ? initialHandlingQd : 0);
    const durationQd = route.durationQd + handlingQd;
    loadedClockQd += durationQd - (index === 0 ? initialHandlingQd : 0);
    const pickupHandlingQd = portHandlingQd(port, pickups.reduce((sum, job) => sum + job.load, 0));
    for (const job of pickups) startClientCargo(job.offer.contract.cargo, loadedClockQd, pickupHandlingQd);
    const base = costsFor(world, holding, ship, previous, port, { durationQd });
    const costs = { ...base.costs };
    for (const job of deliveries) {
      const pickup = portForPoint(world, job.offer.contract.pickup ?? job.offer.from);
      const fees = costsFor(world, holding, ship, pickup, port, { durationQd: 0 }, job.offer.contract.cargo).costs;
      costs.taxCopper = money(costs.taxCopper + fees.taxCopper);
      costs.importTaxCopper = money((costs.importTaxCopper ?? 0) + fees.importTaxCopper);
      costs.exportTaxCopper = money((costs.exportTaxCopper ?? 0) + fees.exportTaxCopper);
    }
    costs.handlingCopper = money(portHandlingCopper([port],
      pickups.reduce((sum, job) => sum + job.load, 0) + deliveries.reduce((sum, job) => sum + job.load, 0))
      + (index === 0 ? portHandlingCopper([origin], startingLoad) : 0));
    costs.totalCopper = costs.operatingCopper = money(costs.foodCopper + costs.crewCopper + costs.upkeepCopper + costs.handlingCopper + costs.taxCopper);
    totalOperatingCopper = money(totalOperatingCopper + costs.totalCopper);
    const legOffer = {
      mode: "world", id: `bundle-leg-${index}`, shipId: ship.id,
      from: point(previous), to: point(port), contract: null,
      quote: {
        durationQd, distanceKm: route.distanceKm, speedKmPerDay: route.speedKmPerDay,
        operatingCopper: costs.totalCopper, preparationCopper: 0, rewardCopper: 0, costs,
        idleUpkeepCopperPerDay: costsFor(world, holding, ship, port, port, { durationQd: 4 }).dailyCopper,
        idleReserveCopper: 0, returnReserveCopper: 0, recommendedBudgetCopper: costs.totalCopper
      }
    };
    previous = port;
    return { point: point(port), pickupOfferIds: pickups.map((job) => job.offer.id),
      deliveryOfferIds: deliveries.map((job) => job.offer.id), loadOnLegPoints,
      loadAfterPoints: carriedLoadPoints, legOffer,
      ...(newEconomics ? { cargoOfferIds, economics: { version: 1,
        riskBps: transportRiskBps(route.riskExposureQd * illegalRisk, configuration.riskBps),
        repairCopper: getShipProfile(ship.profileId).upkeepDailyCopper * 30,
        precautionCopper: getShipProfile(ship.profileId).upkeepDailyCopper * 3,
        delayDailyCopper: legOffer.quote.idleUpkeepCopperPerDay } } : {}) };
  });
  const last = best.sequence.at(-1);
  const returnRoute = legRoute(last, world.home, loadedClockQd);
  if (!returnRoute) throw new Error("Нет воздушного маршрута обратно в поселение.");
  const returnReserveCopper = costsFor(world, holding, ship, last, world.home, returnRoute).costs.totalCopper;
  const arrivalQd = Number(ship.timelineQd ?? holding.gm?.calendaria?.lastQd ?? 0) + best.durationQd;
  const idleReserveCopper = shipIdleReserveCopper(plannedStops.at(-1).legOffer.quote.idleUpkeepCopperPerDay, arrivalQd);
  const outcomeReserveCopper = money(bundleOutcomeReserves(offers, totalOperatingCopper, { stops: plannedStops }).reduce((sum, reserve) => sum + reserve, 0));
  const recommendedBudgetCopper = money(totalOperatingCopper + returnReserveCopper + idleReserveCopper + outcomeReserveCopper);
  plannedStops[0].legOffer.quote.recommendedBudgetCopper = recommendedBudgetCopper;
  return {
    offers, stops: plannedStops, totalDurationQd: best.durationQd, distanceKm: best.distanceKm,
    totalOperatingCopper, returnReserveCopper, idleReserveCopper, outcomeReserveCopper, recommendedBudgetCopper,
    initialLoadPoints: startingLoad, capacityLoadPoints: capacity
  };
}

export function quoteWorldShipReturn(data, holding, ship, { context = null } = {}) {
  if (ship.navigationMode !== "world" || ship.activeVoyage || ship.orderBundle || ship.location?.kind !== "market") throw new Error("Возвращение доступно кораблю после исполнения заказов в чужом порту.");
  const world = context ?? buildShipWorldContext(data, holding, { offerLocationIds: commandOfferLocations(ship) });
  const from = currentPort(world, ship, { allowClosed: true });
  const quote = baseQuote(world, holding, ship, from, world.home, null);
  return { mode: "world", id: `return:${ship.id}:${from.id}`, shipId: ship.id, title: `Возвращение: ${world.home.label}`, from: point(from), to: point(world.home), quote, contract: null };
}

/** Reprice expenses before acceptance while preserving the customer's fee and cargo. */
export function repriceWorldShipOffer(data, holding, ship, offer, { context = null } = {}) {
  if (offer?.mode !== "world" || offer.shipId !== ship.id || !offer.contract) throw new Error("Некорректный мировой заказ.");
  const world = context ?? buildShipWorldContext(data, holding, { offerLocationIds: commandOfferLocations(ship, [offer.to?.id, offer.to?.regionId]) });
  const from = currentPort(world, ship);
  if (offer.from?.kind !== from.kind || offer.from?.id !== from.id) throw new Error("Заказ находится в другом порту.");
  const to = world.ports.find((port) => port.id === offer.to?.id);
  if (!to) throw new Error("Порт назначения больше недоступен.");
  if (((from.kind === "home" || from.regionId === world.home.regionId) && !offer.contract.pickup) || to.regionId === world.home.regionId
    || offer.contract.pickup?.regionId === world.home.regionId) {
    throw new Error("Домашнее поселение не выдаёт мировые заказы. ГМ должен обновить свободные предложения; принятые рейсы сохраняются.");
  }
  const pickup = offer.contract.pickup
    ? portWithOffers(world, offer.contract.pickup.id) : null;
  if (offer.contract.pickup && (!pickup || pickup.regionId !== offer.contract.pickup.regionId
    || pickup.regionId === from.regionId || pickup.regionId === to.regionId)) throw new Error("Порт погрузки больше недоступен.");
  const cargo = structuredClone(offer.contract.cargo);
  const capacity = shipCapacityLoadPoints(ship);
  if (!cargo || !Number.isSafeInteger(cargo.loadPoints) || cargo.loadPoints < 0 || cargo.loadPoints > capacity
    || (offer.contract.kind === "smuggling" && cargo.loadPoints > Number(ship.hiddenCapacityLoadPoints || 0))) throw new Error("Кораблю не хватает вместимости для этого заказа.");
  const quote = baseQuote(world, holding, ship, from, to, cargo, pickup);
  if (!clientCargoViableAt(cargo, Number(ship.timelineQd ?? holding.gm?.calendaria?.lastQd ?? 0) + quote.durationQd)) {
    throw new Error("Срок годности клиентского груза истечёт до доставки. Выберите другой заказ.");
  }
  const contract = {
    ...offer.contract,
    cargo,
    guidance: { operatingCopper: quote.operatingCopper, preparationCopper: 0 },
    routePlan: { ...offer.contract.routePlan, upkeepPerDayCopper: quote.idleUpkeepCopperPerDay }
  };
  if (contract.economics?.version === 1) contract.economics = { ...contract.economics,
    ...customerRouteRisk(quote, contract.kind, contract.attention.level, validateTransportConfiguration(data.catalog?.transportV2).riskBps),
    repairCopper: getShipProfile(ship.profileId).upkeepDailyCopper * 30,
    precautionCopper: getShipProfile(ship.profileId).upkeepDailyCopper * 3,
    delayDailyCopper: quote.idleUpkeepCopperPerDay };
  quote.rewardCopper = contract.rewardCopper;
  quote.recommendedBudgetCopper = money(contractGuidance(contract).suggestedBudgetCopper + quote.returnReserveCopper + quote.idleReserveCopper);
  return { ...offer, from: point(from), to: point(to), quote, contract };
}

/** Customer-owned transport jobs. The settlement never buys or sells this cargo. */
export function generateWorldShipOffers(data, holding, ship, { period, random = Math.random, context = null } = {}) {
  if (ship.navigationMode !== "world" || ship.activeVoyage) throw new Error("Заказы доступны кораблю на стоянке.");
  if (ship.orderBundle) throw new Error("Новые заказы доступны после завершения составного рейса.");
  const world = context ?? buildShipWorldContext(data, holding, { offerLocationIds: commandOfferLocations(ship) });
  const from = currentPort(world, ship);
  const needsExternalPickup = from.kind === "home" || from.regionId === world.home.regionId;
  const periodKey = String(period ?? "");
  if (!periodKey || periodKey.length > 80) throw new Error("Не указан период предложений.");
  const destinations = world.ports.filter((port) => port.regionId !== from.regionId && port.regionId !== world.home.regionId && shortestMarketRoute(from.regionId, port.regionId, world.regions, { mode: "airship" }) && shortestMarketRoute(port.regionId, world.home.regionId, world.regions, { mode: "airship" }));
  if (!destinations.length) throw new Error("Нет доступных портов с воздушным маршрутом и путём домой. Проверьте связи на карте мирового рынка.");
  if (needsExternalPickup && destinations.length < 2) throw new Error("Для мирового заказа нужны два внешних поселения: погрузка и доставка. Домашнее поселение не является заказчиком. Добавьте доступные воздушные порты.");
  const draw = () => {
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error("Некорректный источник случайных чисел.");
    return value;
  };
  const capacity = shipCapacityLoadPoints(ship);
  if (!capacity) return [];
  const configuration = validateTransportConfiguration(data.catalog?.transportV2);
  const activity = Math.max(0.6, Math.min(1.4, Number(from.factors?.availability ?? 1)));
  const boardRoll = Math.max(0, Math.min(0.999999, draw() + (activity - 1) * 0.1));
  const offerSlots = boardRoll < 0.05 ? 0 : boardRoll < 0.15 ? 1 : boardRoll < 0.25 ? 2 : boardRoll < 0.75 ? 3 : 4;
  const offers = [];
  for (let index = 0; index < offerSlots; index++) {
    const to = portWithOffers(world, destinations[Math.floor(draw() * destinations.length)]);
    const directionKey = `port:${to.id}`;
    const level = attentionLevel(ship, directionKey);
    const illegalChance = level >= 8 ? 0.8 : level >= 5 ? 0.55 : 0.25;
    const hidden = Math.max(0, Number(ship.hiddenCapacityLoadPoints || 0));
    const kind = index === 0 ? (draw() < 0.2 ? "commission" : "freight")
      : index === 1 ? (draw() < 0.65 ? "commission" : "freight")
        : (draw() < illegalChance && hidden > 0 ? "smuggling" : "freight");
    const pickupCandidates = needsExternalPickup || (index >= 2 && draw() < 0.35)
      ? destinations.filter((port) => port.regionId !== to.regionId
        && shortestMarketRoute(port.regionId, to.regionId, world.regions, { mode: "airship" })) : [];
    const pickup = pickupCandidates.length ? portWithOffers(world, pickupCandidates[Math.floor(draw() * pickupCandidates.length)]) : null;
    if (needsExternalPickup && !pickup) continue;
    const origin = pickup ?? from;
    const demandByResource = new Map((to.outboundOffers ?? []).map((row) => [row.resourceId, row]));
    const goods = (origin.offers ?? []).filter((row) => row.sourceType !== "item" && row.loadPoints > 0 && row.baseStock > 0 && demandByResource.get(row.resourceId)?.baseDemand > 0);
    if (!goods.length && kind !== "commission") continue;
    const availableQuantity = (good) => Math.min(
      Math.floor(good.baseStock * (origin.factors?.availability ?? 1) * WHOLESALE_LOTS),
      Math.floor(demandByResource.get(good.resourceId).baseDemand * (to.factors?.availability ?? 1) * WHOLESALE_LOTS)
    );
    const limit = kind === "smuggling" ? Math.min(capacity, hidden) : capacity;
    const bestLoad = goods.reduce((best, good) => Math.max(best, Math.min(limit, availableQuantity(good) * good.loadPoints)), 0);
    const suitable = goods.filter((good) => availableQuantity(good) * good.loadPoints >= Math.min(limit * 0.6, bestLoad));
    const choice = suitable.length ? Math.floor(draw() * suitable.length) : 0;
    const loadShare = suitable.length ? 0.6 + draw() * 0.35 : 0.6;
    // Prefer a useful full lot, but test smaller consignments if the bulk goods cannot afford delivery.
    const preferred = new Set(suitable);
    const candidates = [...suitable.slice(choice), ...suitable.slice(0, choice), ...goods.filter(good => !preferred.has(good))];
    const maxLoad = kind === "commission" ? Math.floor(capacity * 0.2) : limit;
    const routeCache = new Map();
    const referenceRoute = profile => {
      if (!routeCache.has(profile.id)) {
        const startQd = Number(ship.timelineQd ?? holding.gm?.calendaria?.lastQd ?? 0) + portHandlingQd(origin, profile.capacityLoadPoints);
        const route = routeTerms(world, profile, origin, to, { includeRisk: true, includeSeasonal: true, startQd });
        const movement = transportSeasonalMovement({ ...route.seasonal, costSeasonal: true }, startQd);
        const backStartQd = startQd + route.durationQd + 2 * portHandlingQd(to, profile.capacityLoadPoints);
        const back = routeTerms(world, profile, to, origin, { includeSeasonal: true, startQd: backStartQd });
        const returning = transportSeasonalMovement({ ...back.seasonal, costSeasonal: true }, backStartQd);
        routeCache.set(profile.id, { ...route, operatingFactor: movement.operatingFactor,
          returnDurationQd: back.durationQd, returnOperatingFactor: returning.operatingFactor });
      }
      return routeCache.get(profile.id);
    };
    let selected = null;
    for (let attempt = 0; attempt < (kind === "commission" ? 1 : candidates.length); attempt++) {
      const good = candidates[attempt];
      const quantity = good ? Math.min(Math.floor(maxLoad * loadShare / good.loadPoints), availableQuantity(good)) : 0;
      if (kind !== "commission" && quantity <= 0) continue;
      const cargo = { kind, resourceId: kind === "commission" ? "" : good.resourceId,
        name: kind === "commission" ? "Пассажиры и почта" : good.name,
        quantity: kind === "commission" ? 1 : quantity,
        loadPoints: kind === "commission" ? maxLoad : quantity * good.loadPoints,
        valueCopper: kind === "commission" ? 0 : money(quantity * good.basePriceCopper * (origin.factors?.price ?? 1)) };
      const lifetime = kind === "commission" ? 0 : Number(world.resources.find(row => row.id === cargo.resourceId)?.shelfLifeQd ?? 0);
      if (lifetime > 0) cargo.shelfLifeQd = lifetime;
      const taxCopper = kind === "smuggling" ? 0 : money(cargo.valueCopper * (origin.factors?.exportTaxRate ?? 0))
        + money(cargo.valueCopper * (to.factors?.taxRate ?? 0));
      const fare = customerTransportFare({ cargo, origin, destination: to, resources: world.resources, configuration,
        referenceRoute, attention: level, taxCopper });
      const customerBudgetCopper = kind === "freight" ? ordinaryFreightBudget(cargo, demandByResource.get(good.resourceId), to) : null;
      if (customerBudgetCopper !== null && fare.rewardCopper > customerBudgetCopper) continue;
      const quote = clientCargoLifetime(cargo) ? baseQuote(world, holding, ship, from, to, cargo, pickup) : null;
      if (quote && !clientCargoViableAt(cargo, Number(ship.timelineQd ?? holding.gm?.calendaria?.lastQd ?? 0) + quote.durationQd)) continue;
      selected = { cargo, fare, customerBudgetCopper, quote }; break;
    }
    if (!selected) continue;
    const { cargo, fare, customerBudgetCopper } = selected;
    const quote = selected.quote ?? baseQuote(world, holding, ship, from, to, cargo, pickup);
    const rewardCopper = fare.rewardCopper;
    const repairCopper = getShipProfile(ship.profileId).upkeepDailyCopper * 30;
    const contract = { kind, rewardCopper, directionKey, destination: to.label, attention: { level, label: attentionLabel(level) },
      guidance: { operatingCopper: quote.operatingCopper, preparationCopper: 0 },
      routePlan: { upkeepPerDayCopper: quote.idleUpkeepCopperPerDay }, cargo,
      economics: { version: 1, ...fare, customerBudgetCopper, repairCopper,
        ...customerRouteRisk(quote, kind, level, configuration.riskBps),
        delayDailyCopper: quote.idleUpkeepCopperPerDay, precautionCopper: Math.ceil(repairCopper / 10) } };
    if (pickup) contract.pickup = point(pickup);
    const guidance = contractGuidance(contract);
    quote.rewardCopper = rewardCopper;
    quote.recommendedBudgetCopper = money(guidance.suggestedBudgetCopper + quote.returnReserveCopper + quote.idleReserveCopper);
    const offerKey = [ship.id, from.kind, from.id, periodKey];
    const id = `world-${stableDataHash(offerKey)}-${stableDataHash([...offerKey].reverse())}-${index}`;
    offers.push({ mode: "world", id, shipId: ship.id, period: periodKey, kind, title: `${kind === "smuggling" ? "Груз без декларации" : cargo.name}${pickup ? `: ${pickup.label}` : ""} → ${to.label}`, from: point(from), to: point(to), quote, contract });
  }
  return offers;
}

/** An empty repositioning leg, paid by the ship with no customer fee. */
export function quoteWorldShipRelocation(data, holding, ship, destinationId, { context = null } = {}) {
  if (ship.navigationMode !== "world" || ship.activeVoyage || ship.orderBundle
    || !["home", "market"].includes(ship.location?.kind)) throw new Error("Передислокация доступна свободному кораблю в порту.");
  const world = context ?? buildShipWorldContext(data, holding, { offerLocationIds: commandOfferLocations(ship) });
  const from = currentPort(world, ship, { allowClosed: true });
  const to = world.ports.find((port) => port.id === destinationId);
  if (!to) throw new Error("Порт назначения недоступен в мировом рынке.");
  if (to.regionId === from.regionId) throw new Error("Корабль уже находится в этой локации.");
  if (to.regionId === world.home.regionId) throw new Error("Для возвращения в поселение выберите приказ «Лететь домой».");
  const quote = baseQuote(world, holding, ship, from, to, null);
  return { mode: "world", id: `relocate:${ship.id}:${from.id}:${to.id}`, shipId: ship.id,
    title: `Передислокация: ${to.label}`, from: point(from), to: point(to), quote, contract: null };
}
