import { prepareMarketAuthorityContext, authorityMarketLogistics } from "../market/authority-context.js";
import { transportServicesFromRoutes, validateTransportConfiguration } from "../../engines/transport/services.js";
import { findTransportPlans, planTransportChain } from "../../engines/transport/planner.js";
import { cargoValue, shipTransportFunding, transportLoad, transportOperatingCharge } from "../../engines/transport/quantities.js";
import { stableDataHash } from "../../data/storage-commit.js";
import { findHoldingRegion } from "../../engines/market/logistics.js";
import { cargoShelfLife } from "../../engines/market/cargo-aging.js";
import { buildShipWorldContext, worldShipTransportTerms } from "../../engines/ships/world-market.js";
import { worldShipTimelineQd, worldShipPortDebtCopper } from "../../engines/ships/world-voyage.js";
import { shipCapacityLoadPoints } from "../../engines/ships/profiles.js";
import { shipCrewReadiness } from "../../engines/ships/crew-readiness.js";

export function transportSourceToken(data, holding) {
  return stableDataHash({ holding, markets: data?.meta?.sharedMarkets, transport: data?.meta?.transportV2, catalog: data?.catalog });
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

function ownServices(data, holding, ship, points, request, clockQd) {
  if (ship.navigationMode !== "world" || ship.condition !== "ready" || ship.activeVoyage || ship.orderBundle || ship.transportOrderId) throw new Error("Корабль занят или не готов к рейсу.");
  const readiness = shipCrewReadiness(holding, ship, { catalog: data.catalog });
  if (!readiness.ready) throw new Error(readiness.issues.map((row) => row.message).join(" "));
  if (worldShipTimelineQd(holding, ship) !== clockQd) throw new Error("Сначала явно доведите время корабля до текущей даты логистики.");
  if (worldShipPortDebtCopper(ship, clockQd) > 0) throw new Error("Сначала оплатите накопленное содержание корабля.");
  const world = buildShipWorldContext(data, holding), capacityPoints = shipCapacityLoadPoints(ship);
  const position = ship.location?.regionId ?? world.home.regionId;
  const services = [];
  for (const from of points) for (const to of points) {
    if (from === to) continue;
    try {
      const terms = worldShipTransportTerms(data, holding, ship, from, to, { context: world, loadPoints: capacityPoints });
      const approach = from === position ? null : worldShipTransportTerms(data, holding, ship, position, from, { context: world });
      const back = worldShipTransportTerms(data, holding, ship, to, from, { context: world });
      const home = to === world.home.regionId ? null : worldShipTransportTerms(data, holding, ship, to, world.home.regionId, { context: world });
      const abortReturn = from === world.home.regionId ? null : worldShipTransportTerms(data, holding, ship, from, world.home.regionId, { context: world });
      services.push({ id: `owned:${ship.id}:${from}:${to}`, label: ship.name, companyId: `owned:${ship.id}`, kind: "owned", shipId: ship.id,
        from, to, fromLabel: terms.from.label, toLabel: terms.to.label, capacity: capacityPoints * 1000, vehicles: 1,
        travelQd: Math.max(1, terms.durationQd), loadingQd: terms.loadingQd, unloadingQd: terms.unloadingQd,
        loadingCapacity: terms.loadingCapacity, unloadingCapacity: terms.unloadingCapacity,
        returnQd: back.durationQd, endReturnQd: home?.durationQd ?? 0, endReturnLocation: world.home.regionId,
        abortReturnQd: abortReturn?.durationQd ?? 0,
        returnAtEnd: request.returnHome === true, approachQd: approach?.durationQd ?? 0,
        approachCopper: approach ? transportOperatingCharge(approach, approach.durationQd) : 0,
        dispatchCopper: terms.handlingFlatCopper, handlingMilliCopper: terms.handlingMilliCopper,
        operatingMilliCopperPerQd: terms.operatingMilliCopperPerQd, idleUpkeepCopperPerDay: terms.idleUpkeepCopperPerDay,
        returnOperatingMilliCopperPerQd: back.operatingMilliCopperPerQd,
        dailyCosts: terms.dailyCosts, returnDailyCosts: back.dailyCosts,
        waitingMilliCopperPerQd: from === world.home.regionId && ship.homeUpkeepEnabled === false ? 0 : terms.operatingMilliCopperPerQd,
        accessCost: terms.accessCost, riskBps: request.riskBps ?? 300 });
    } catch (_error) { /* An unavailable pair is not a service; the selected complete chain is validated below. */ }
  }
  return services;
}

export function prepareTransportContext({ data, holding, request = {}, isGM = false }) {
  const direction = request.direction === "outbound" ? "outbound" : "inbound";
  const context = prepareMarketAuthorityContext({ data, holding, marketId: request.marketId, isGM,
    quantities: direction === "inbound" ? request.quantities : {}, outboundQuantities: direction === "outbound" ? request.quantities : {},
    targetRoomId: request.targetRoomId ?? "outdoors" });
  if (!context.market) throw new Error("Этот рынок недоступен поселению.");
  const { cargo, lines } = selectedCargo(context, { ...request, direction });
  const configuration = validateTransportConfiguration(data.catalog?.transportV2);
  const { logistics } = authorityMarketLogistics({ data, holding, market: context.market, direction, isGM });
  const difficulty = Math.max(0, ...lines.map((line) => Number(line.accessDifficulty
    ?? context.outbound?.offers?.find((offer) => offer.resourceId === line.resourceId)?.accessDifficulty ?? 0)));
  const routes = (logistics?.routeCandidates?.length ? logistics.routeCandidates : logistics?.ok ? [logistics] : [])
    .filter((route) => route.routeAccessCost + difficulty <= route.accessLevel);
  let services = transportServicesFromRoutes(routes, configuration, data.catalog.eventRegions);
  const home = findHoldingRegion(holding, data.catalog.eventRegions)?.value;
  if (!home) throw new Error("У поселения не определена локация.");
  const localService = services.some((service) => service.from === `${home}:holding` || service.to === `${home}:holding`);
  const endpoint = localService ? `${home}:holding` : home;
  const from = direction === "inbound" ? context.market.regionId : endpoint;
  const to = direction === "inbound" ? endpoint : context.market.regionId;
  const state = data.meta?.transportV2;
  const startQd = Math.max(Number(state?.clockQd ?? 0), Number(holding.gm?.calendaria?.lastQd ?? 0));
  if (Number(holding.gm?.calendaria?.lastQd ?? 0) < startQd) throw new Error("Дата поселения отстаёт от общей даты перевозок. Проведите недостающие периоды перед новым заказом.");
  const ship = request.ownShipId ? holding.special?.ships?.list?.find((row) => row.id === request.ownShipId) : null;
  if (request.ownShipId && !ship) throw new Error("Выбранный корабль не найден.");
  if (ship) {
    const points = [...new Set([home, context.market.regionId, ...services.flatMap((row) => [row.from, row.to])])].filter((id) => !id.endsWith(":holding")).slice(0, 24);
    services.push(...ownServices(data, holding, ship, points, { ...request, riskBps: configuration.riskBps }, startQd).map((service) => ({ ...service,
      from: service.from === home && direction === "outbound" ? endpoint : service.from,
      to: service.to === home && direction === "inbound" ? endpoint : service.to })));
  }
  services = services.filter((service) => isGM || service.visibility !== "gm");
  const search = findTransportPlans({ from, to, services, cargo, startQd, runs: state?.runs ?? [], priority: request.priority,
    pins: request.pins ?? {}, excluded: request.excluded ?? [], ownShipId: request.ownShipId ?? "", accessLimit: (logistics?.accessLevel ?? 0) - difficulty });
  let plan = search.plans[0];
  if (request.serviceIds?.length) {
    const selected = request.serviceIds.map((id) => services.find((row) => row.id === id));
    if (selected.some((row) => !row)) throw new Error("Выбранная услуга больше недоступна.");
    plan = planTransportChain({ cargo, services: selected, startQd, runs: state?.runs ?? [] });
    if (plan.stages[0].from !== from || plan.stages.at(-1).to !== to) throw new Error("Маршрут не соединяет рынок и поселение.");
    if (plan.ownShipId !== String(request.ownShipId ?? "")) throw new Error("План не соответствует выбранному кораблю.");
    if (plan.stages.reduce((sum, stage) => sum + (stage.service.accessCost ?? 0), 0) + difficulty > (logistics?.accessLevel ?? 0)) throw new Error("Недостаточно УРС для выбранного маршрута и товара.");
  }
  if (!plan) throw new Error(search.failures[0] ?? "Для выбранного груза нет доступной перевозки.");
  const valueCopper = cargoValue(cargo);
  const taxCopper = Math.ceil(valueCopper * (Number(logistics?.importTaxRate ?? 0) + Number(logistics?.exportTaxRate ?? 0)));
  const insuranceCopper = request.insurance === false ? 0 : Math.ceil(valueCopper * configuration.insuranceBps / 10000);
  const funding = shipTransportFunding({ expensesCopper: plan.ownExpensesCopper, reserveCopper: ship ? Number(request.reserveCopper ?? 0) : 0,
    onboardCopper: ship?.onboardCopper ?? 0 });
  const treasuryCopper = (direction === "inbound" ? valueCopper : 0) + taxCopper + insuranceCopper
    + plan.totalCopper - plan.ownExpensesCopper + funding.treasuryCopper;
  const commercial = { marketId: context.market.id, marketRegionId: context.market.regionId,
    marketLabel: context.quote.marketLabel ?? context.market.label ?? context.market.name, targetRoomId: request.targetRoomId ?? "outdoors",
    lines, taxCopper, insuranceCopper, insuranceCoverageBps: insuranceCopper ? configuration.insuranceCoverageBps : 0, reserveCopper: funding.reserveCopper,
    revenueOnBoard: direction === "outbound" && plan.stages.at(-1).service.kind === "owned" };
  return { plan, services, commercial, ship, lines, search, treasuryCopper, valueCopper, totalCopper: plan.totalCopper + taxCopper + insuranceCopper,
    warnings: cargo.filter((lot) => lot.shelfLifeQd > 0 && lot.ageQd + plan.arrivalQd - startQd >= lot.shelfLifeQd)
      .map((lot) => `${lot.name || lot.resourceId}: срок хранения истечёт до прибытия. Порча не покрывается страховкой.`),
    affordable: treasuryCopper <= (holding.storage.moneyCopper ?? 0), sourceToken: transportSourceToken(data, holding),
    planToken: stableDataHash({ plan, commercial, treasuryCopper }), from, to };
}
