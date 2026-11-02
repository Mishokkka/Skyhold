import { authorityMarketLogistics } from "../market/authority-context.js";
import { prepareTransportCommerce } from "../market/transport-commerce.js";
import { transportServicesFromRoutes, validateTransportConfiguration } from "../../engines/transport/services.js";
import { findTransportPlans, planTransportChain, transportChainMatchesConstraints } from "../../engines/transport/planner.js";
import { cargoValue, shipTransportFunding, transportLoad, transportMoney, transportOperatingCharge } from "../../engines/transport/quantities.js";
import { stableDataHash } from "../../data/storage-commit.js";
import { findHoldingRegion } from "../../engines/market/logistics.js";
import { cargoShelfLife } from "../../engines/market/cargo-aging.js";
import { buildShipWorldContext, worldShipTransportTerms } from "../../engines/ships/world-market.js";
import { worldShipTimelineQd, worldShipPortDebtCopper } from "../../engines/ships/world-voyage.js";
import { shipCapacityLoadPoints } from "../../engines/ships/profiles.js";
import { shipCrewReadiness } from "../../engines/ships/crew-readiness.js";
import { transportClockOffsetQd, transportHoldingQd } from "../../data/transport/clock.js";
import { transportRelevantHolding } from "../../data/transport/state.js";
import { discoverTransportPorts } from "./transport-discovery.js";

export function transportSourceToken(data, holding) {
  return stableDataHash({ holding: transportRelevantHolding(holding), markets: data?.meta?.sharedMarkets,
    transport: data?.meta?.transportV2, catalog: data?.catalog });
}

function selectedCargo(context, request) {
  const outbound = request.direction === "outbound";
  const lines = outbound ? context.outbound?.plan?.lines ?? [] : context.plan?.lines ?? [];
  const quantities = request.quantities ?? {};
  for (const [id, qty] of Object.entries(quantities)) {
    if (!Number.isSafeInteger(qty) || qty < 0 || qty > 1000000) throw new Error("Количество должно быть целым неотрицательным числом.");
    if (qty && !lines.some((line) => (outbound ? line.resourceId === id : line.id === id) && line.qty === qty)) throw new Error("Выбранное количество больше доступного предложения или запаса.");
  }
  const definitions = new Map(context.resources.map((row) => [row.id, row]));
  const source = outbound ? context.outbound?.plan?.cargoReservations ?? [] : lines;
  const offers = new Map((context.outbound?.offers ?? []).map((row) => [row.resourceId, row]));
  const cargo = source.map((line, index) => {
    const resource = definitions.get(line.resourceId), offer = outbound ? offers.get(line.resourceId) : line;
    return { ...line, lotId: `${outbound ? `${line.rowId}:${line.batchId}` : line.id}:${index}`, qty: line.qty,
      unitLoad: transportLoad(offer?.load ?? (resource?.loadPoints ?? 4) / 4), unitCopper: line.unitPriceCopper,
      ageQd: line.ageQd ?? line.reservedAgeQd ?? 0, shelfLifeQd: cargoShelfLife(line), sourceType: line.sourceType ?? "resource" };
  });
  if (!cargo.length) throw new Error("Не выбраны товары для перевозки.");
  return { cargo, lines };
}

function ownServices(data, holding, ship, points, request, clockQd, world = buildShipWorldContext(data, holding)) {
  if (ship.navigationMode !== "world" || ship.condition !== "ready" || ship.activeVoyage || ship.orderBundle || ship.transportOrderId) throw new Error("Корабль занят или не готов к рейсу.");
  const readiness = shipCrewReadiness(holding, ship, { catalog: data.catalog });
  if (!readiness.ready) throw new Error(readiness.issues.map((row) => row.message).join(" "));
  if (worldShipTimelineQd(holding, ship) !== clockQd) throw new Error("Сначала явно доведите время корабля до текущей даты логистики.");
  if (worldShipPortDebtCopper(ship, clockQd) > 0) throw new Error("Сначала оплатите накопленное содержание корабля.");
  const capacityPoints = shipCapacityLoadPoints(ship);
  const home = request.homeEndpoint ?? world.home.regionId;
  const positionAtHome = !ship.location || ship.location.kind === "home";
  const position = positionAtHome ? home : ship.location.regionId;
  const services = [];
  const quote = (from, to, loadPoints, maxAccess, fromHome = from === home) => worldShipTransportTerms(data, holding, ship,
    from === home ? world.home.regionId : from, to === home ? world.home.regionId : to,
    { context: world, loadPoints, maxAccess, fromHome, toHome: to === home });
  const emptyQuotes = new Map();
  const emptyTerms = (from, to, fromHome = from === home) => {
    if (from === to && fromHome === (to === home)) return null;
    const key = JSON.stringify([from, to, fromHome]);
    if (!emptyQuotes.has(key)) {
      let terms = null;
      try { terms = quote(from, to, 0, request.accessLimit, fromHome); }
      catch (_error) { /* Cache unavailable pairs too, only for this quote. */ }
      emptyQuotes.set(key, terms);
    }
    return emptyQuotes.get(key);
  };
  for (const from of points) for (const to of points) {
    if (from === to) continue;
    try {
      // Preserve shorter and lower-access paths: a later hired/owned leg can
      // need the remaining access even when this pair alone fits the limit.
      let maxAccess = request.cargoAccessLimit;
      while (maxAccess >= 0) {
        const terms = quote(from, to, capacityPoints, maxAccess);
        // A local market remains a port even when this request uses the same
        // region ID as its warehouse endpoint. Position.kind survives requests.
        const atPickup = position === from && positionAtHome === (from === home);
        const approach = emptyTerms(position, from, positionAtHome), back = emptyTerms(to, from);
        const homeReturn = emptyTerms(to, home), abortReturn = emptyTerms(from, home);
        const variant = maxAccess === request.cargoAccessLimit ? "" : `:access:${terms.accessCost}`;
        services.push({ id: `owned:${ship.id}:${from}:${to}${variant}`, label: `${ship.name} · ${terms.distanceKm} км · УРС ${terms.accessCost}`,
          companyId: `owned:${ship.id}`, kind: "owned", shipId: ship.id,
          from, to, fromLabel: terms.from.label, toLabel: terms.to.label, capacity: capacityPoints * 1000, vehicles: 1,
          travelQd: Math.max(1, terms.durationQd), loadingQd: terms.loadingQd, unloadingQd: terms.unloadingQd,
          loadingCapacity: terms.loadingCapacity, unloadingCapacity: terms.unloadingCapacity,
          returnQd: back?.durationQd ?? 0, endReturnQd: homeReturn?.durationQd ?? 0, endReturnLocation: home,
          emptyAccessLimit: request.accessLimit,
          approachAvailable: atPickup || Boolean(approach), approachAccessCost: approach?.accessCost ?? 0,
          returnAvailable: Boolean(back), returnAccessCost: back?.accessCost ?? 0,
          endReturnAvailable: to === home || Boolean(homeReturn), endReturnAccessCost: homeReturn?.accessCost ?? 0,
          abortReturnAvailable: from === home || Boolean(abortReturn), abortReturnAccessCost: abortReturn?.accessCost ?? 0,
          abortReturnQd: abortReturn?.durationQd ?? 0,
          returnAtEnd: request.returnHome === true, approachQd: approach?.durationQd ?? 0,
          approachCopper: approach ? transportOperatingCharge(approach, approach.durationQd) : 0,
          handlingFlatCopper: terms.handlingFlatCopper, handlingMilliCopper: terms.handlingMilliCopper,
          operatingMilliCopperPerQd: terms.operatingMilliCopperPerQd, idleUpkeepCopperPerDay: terms.idleUpkeepCopperPerDay,
          startIdleUpkeepCopperPerDay: Object.values(terms.dailyCosts).reduce((sum, cost) => sum + cost, 0),
          returnOperatingMilliCopperPerQd: back?.operatingMilliCopperPerQd ?? terms.operatingMilliCopperPerQd,
          dailyCosts: terms.dailyCosts, returnDailyCosts: back?.dailyCosts ?? terms.dailyCosts,
          waitingMilliCopperPerQd: from === home && ship.homeUpkeepEnabled === false ? 0 : terms.operatingMilliCopperPerQd,
          accessCost: terms.accessCost, riskBps: Math.min(10000, Math.round((request.riskBps ?? 300) * terms.riskFactor)) });
        maxAccess = terms.accessCost - 1;
      }
    } catch (_error) { /* An unavailable pair is not a service; the selected complete chain is validated below. */ }
  }
  return services;
}

export function prepareTransportContext({ data, holding, request = {}, isGM = false, allowIncomplete = false }) {
  const direction = request.direction === "outbound" ? "outbound" : "inbound";
  const context = prepareTransportCommerce({ data, holding, request: { ...request, direction }, isGM });
  const { cargo, lines } = selectedCargo(context, { ...request, direction });
  const configuration = validateTransportConfiguration(data.catalog?.transportV2);
  const { logistics } = authorityMarketLogistics({ data, holding, market: context.market, direction, isGM, preservePhysicalRoutes: true });
  const difficulty = Math.max(0, ...lines.map((line) => Number(line.accessDifficulty
    ?? context.outbound?.offers?.find((offer) => offer.resourceId === line.resourceId)?.accessDifficulty ?? 0)));
  const routes = (logistics?.routeCandidates?.length ? logistics.routeCandidates : logistics?.ok ? [logistics] : [])
    .filter((route) => route.routeAccessCost + difficulty <= route.accessLevel);
  const home = findHoldingRegion(holding, data.catalog.eventRegions)?.value;
  if (!home) throw new Error("У поселения не определена локация.");
  const endpoint = ["sky-island", "ship"].includes(holding.type) || context.market.regionId === home ? `${home}:holding` : home;
  const serviceEndpoints = { markets: context.markets, homeRegionId: home, homeEndpoint: endpoint };
  let services = transportServicesFromRoutes(routes, configuration, data.catalog.eventRegions, serviceEndpoints);
  const ship = request.ownShipId ? holding.special?.ships?.list?.find((row) => row.id === request.ownShipId) : null;
  if (request.ownShipId && !ship) throw new Error("Выбранный корабль не найден.");
  const world = ship ? buildShipWorldContext(data, holding) : null;
  const discovery = ship ? discoverTransportPorts({ world, holding, marketRegionId: context.market.regionId,
    endpoint, accessLimit: (logistics?.accessLevel ?? 0) - difficulty, request, services }) : null;
  let routeSearchLimited = Boolean(logistics?.searchLimited);
  if (ship) {
    // A usable mixed route need not be a complete hired route. The own ship can
    // bridge a gap in carrier coverage to a port with a valid hired connection.
    const known = new Set([home, context.market.regionId, ...services.flatMap(service => [service.from, service.to])]
      .map(id => id.replace(/:holding$/, "")));
    const transfers = discovery.transfers.filter(port => !known.has(port.regionId));
    const connections = [];
    for (const port of transfers) {
      const atPort = { ...holding, type: "village", overview: { ...holding.overview, region: port.regionId } };
      for (const endpoints of [{ holding, market: port }, { holding: atPort, market: context.market }]) {
        const leg = authorityMarketLogistics({ data, ...endpoints, direction, isGM, preservePhysicalRoutes: true }).logistics;
        routeSearchLimited ||= Boolean(leg?.searchLimited);
        connections.push(...(leg?.routeCandidates?.length ? leg.routeCandidates : leg?.ok ? [leg] : [])
          .filter(route => route.routeAccessCost + difficulty <= route.accessLevel));
      }
    }
    const extra = transportServicesFromRoutes(connections, configuration, data.catalog.eventRegions, serviceEndpoints);
    services = [...new Map([...extra, ...services].map(service => [service.id, service])).values()];
  }
  const from = direction === "inbound" ? context.market.regionId : endpoint;
  const to = direction === "inbound" ? endpoint : context.market.regionId;
  const state = data.meta?.transportV2;
  const clockOffsetQd = transportClockOffsetQd(data, holding);
  const startQd = transportHoldingQd(data, holding);
  if (startQd < Number(state?.clockQd ?? 0)) throw new Error("Дата поселения отстаёт от общей даты перевозок. Проведите недостающие периоды перед новым заказом.");
  if (ship) {
    services.push(...ownServices(data, holding, ship, discovery.points, { ...request, riskBps: configuration.riskBps,
      accessLimit: logistics?.accessLevel ?? 0, cargoAccessLimit: (logistics?.accessLevel ?? 0) - difficulty,
      homeEndpoint: endpoint }, startQd - clockOffsetQd, world));
  }
  services = services.filter((service) => isGM || service.visibility !== "gm");
  const search = findTransportPlans({ from, to, services, cargo, startQd, runs: state?.runs ?? [], priority: request.priority,
    pins: request.pins ?? {}, excluded: request.excluded ?? [], ownShipId: request.ownShipId ?? "", accessLimit: (logistics?.accessLevel ?? 0) - difficulty });
  search.limits = { ports: Boolean(discovery?.limited), routes: routeSearchLimited, plans: search.limited };
  search.limited ||= search.limits.ports || search.limits.routes;
  let plan = search.plans[0];
  if (request.serviceIds?.length) {
    const selected = request.serviceIds.map((id) => services.find((row) => row.id === id));
    if (selected.some((row) => !row)) throw new Error("Выбранная услуга больше недоступна.");
    if (!transportChainMatchesConstraints(selected, request)) throw new Error("Маршрут не соблюдает закрепления или исключения перевозчиков.");
    plan = planTransportChain({ cargo, services: selected, startQd, runs: state?.runs ?? [] });
    if (plan.stages[0].from !== from || plan.stages.at(-1).to !== to) throw new Error("Маршрут не соединяет рынок и поселение.");
    if (plan.ownShipId !== String(request.ownShipId ?? "")) throw new Error("План не соответствует выбранному кораблю.");
    if (plan.stages.reduce((sum, stage) => sum + (stage.service.accessCost ?? 0), 0) + difficulty > (logistics?.accessLevel ?? 0)) throw new Error("Недостаточно УРС для выбранного маршрута и товара.");
  }
  if (!plan) {
    const message = search.limited
      ? `Поиск достиг лимита вариантов без подходящего плана. Это не означает, что маршрута нет. Уточните ${ship ? "порт поиска, " : ""}закрепления участков или исключите часть перевозчиков и повторите расчёт.`
      : search.failures[0] ?? "Для выбранного груза нет доступной перевозки.";
    if (allowIncomplete) return { plan: null, services, search, discovery, from, to, ship, lines, error: message,
      affordable: false, sourceToken: transportSourceToken(data, holding) };
    throw new Error(message);
  }
  const valueCopper = cargoValue(cargo);
  const taxCopper = Math.ceil(valueCopper * (Number(logistics?.importTaxRate ?? 0) + Number(logistics?.exportTaxRate ?? 0)));
  const insuranceCopper = request.insurance === false ? 0 : Math.ceil(valueCopper * configuration.insuranceBps / 10000);
  const funding = shipTransportFunding({ expensesCopper: plan.ownExpensesCopper, reserveCopper: ship ? Number(request.reserveCopper ?? 0) : 0,
    onboardCopper: ship?.onboardCopper ?? 0 });
  const totalCopper = transportMoney([plan.totalCopper, taxCopper, insuranceCopper]);
  const treasuryCopper = transportMoney([direction === "inbound" ? valueCopper : 0, taxCopper, insuranceCopper,
    plan.totalCopper - plan.ownExpensesCopper, funding.treasuryCopper]);
  const commercial = { marketId: context.market.id, marketRegionId: context.market.regionId,
    marketLabel: context.quote.marketLabel ?? context.market.label ?? context.market.name, targetRoomId: request.targetRoomId ?? "outdoors",
    lines, taxCopper, insuranceCopper, insuranceCoverageBps: insuranceCopper ? configuration.insuranceCoverageBps : 0, reserveCopper: funding.reserveCopper,
    revenueOnBoard: direction === "outbound" && plan.stages.at(-1).service.kind === "owned" };
  return { plan, services, commercial, ship, lines, search, discovery, treasuryCopper, valueCopper, totalCopper, clockOffsetQd,
    warnings: cargo.filter((lot) => lot.shelfLifeQd > 0 && lot.ageQd + plan.arrivalQd - startQd >= lot.shelfLifeQd)
      .map((lot) => `${lot.name || lot.resourceId}: срок хранения истечёт до прибытия. Порча не покрывается страховкой.`),
    affordable: treasuryCopper <= (holding.storage.moneyCopper ?? 0), sourceToken: transportSourceToken(data, holding),
    planToken: stableDataHash({ plan, commercial, treasuryCopper }), from, to };
}
