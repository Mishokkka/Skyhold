import { buildShipWorldContext, configureWorldShipEconomy, quoteWorldShipBundle, repriceWorldShipOffer, worldShipTimeBreakdown } from "./world-market.js";
import { shortestMarketRoute } from "../market/logistics.js";
import { contractGuidance } from "./contracts.js";
import { shipCapacityLoadPoints } from "./profiles.js";
import { shipCrewReadiness } from "./crew-readiness.js";
import { shipMoneySummary } from "./summary.js";
import { worldShipTimelineQd } from "./world-voyage.js";

const samePoint = (a, b) => a?.kind === b?.kind && a?.id === b?.id;

/** Transient, read-only plan. Uses the departure quotes; never stores navigation or rolls outcomes. */
export function previewShipOrders(data, holding, ship, { offerIds = [], style = "normal", budgetCopper = null } = {}) {
  if (!ship || ship.navigationMode !== "world" || ship.activeVoyage || ship.orderBundle
    || !["home", "market"].includes(ship.location?.kind)) throw new Error("Заказы можно планировать только между рейсами в порту.");
  if (!Array.isArray(offerIds) || offerIds.length < 1 || offerIds.length > 3) throw new Error("Выберите от одного до трёх заказов.");
  if (new Set(offerIds).size !== offerIds.length) throw new Error("Один заказ нельзя выбрать дважды.");
  if (!["normal", "cautious", "bold"].includes(style)) throw new Error("Неизвестный подход капитана.");
  if (budgetCopper !== null && (!Number.isSafeInteger(budgetCopper) || budgetCopper < 0)) throw new Error("Укажите неотрицательный бюджет в ЗМ.");
  const clockQd = worldShipTimelineQd(holding, ship);
  const period = Math.floor(clockQd / 40);
  const selected = offerIds.map((id) => (holding.special?.ships?.offers ?? []).find((offer) => offer.id === id));
  if (selected.some((offer) => !offer || offer.mode !== "world" || offer.shipId !== ship.id || offer.consumedBy
    || String(offer.period) !== String(period) || !samePoint(offer.from, ship.location))) {
    throw new Error("Один из выбранных заказов устарел или уже использован. Обновите список и выберите заказы снова.");
  }
  const locations = selected.flatMap((offer) => [offer.from, offer.to, offer.contract?.pickup])
    .flatMap((point) => [point?.id, point?.regionId]).filter(Boolean);
  const world = buildShipWorldContext(data, holding, { offerLocationIds: locations });
  // Departure refreshes home upkeep before settling its bill. Project that refresh on a detached record.
  const calculationShip = { ...ship, portBilling: ship.portBilling ? { ...ship.portBilling } : null };
  configureWorldShipEconomy(data, holding, calculationShip, { context: world });
  const offers = selected.map((offer) => repriceWorldShipOffer(data, holding, calculationShip, offer, { context: world }));
  const capacityLoadPoints = shipCapacityLoadPoints(ship);
  const hiddenCapacityLoadPoints = Number(ship.hiddenCapacityLoadPoints || 0);
  const hidden = (offer) => offer.contract.kind === "smuggling" ? offer.contract.cargo.loadPoints : 0;
  const origin = offers[0].from;
  const atOrigin = offers.filter((offer) => !offer.contract.pickup);
  const initialLoadPoints = atOrigin.reduce((sum, offer) => sum + offer.contract.cargo.loadPoints, 0);
  const initialHidden = atOrigin.reduce((sum, offer) => sum + hidden(offer), 0);
  if (initialLoadPoints > capacityLoadPoints) throw new Error(`При отправлении грузы не помещаются: ${initialLoadPoints} / ${capacityLoadPoints} ед. трюма.`);
  if (initialHidden > hiddenCapacityLoadPoints) throw new Error(`При отправлении грузы не помещаются в тайники: ${initialHidden} / ${hiddenCapacityLoadPoints} ед.`);

  const routes = new Map();
  const routeBetween = (from, to) => {
    const key = JSON.stringify([from.regionId, to.regionId]);
    if (!routes.has(key)) routes.set(key, shortestMarketRoute(from.regionId, to.regionId, world.regions, { mode: "airship" }));
    const route = routes.get(key);
    if (!route) throw new Error(`Нет воздушного маршрута: ${from.label} → ${to.label}.`);
    return route;
  };
  let totalDurationQd, distanceKm, totalOperatingCopper, recommendedBudgetCopper;
  let returnReserveCopper, idleReserveCopper, outcomeReserveCopper, firstLegCopper;
  let stops, legs;
  if (offers.length === 1) {
    const offer = offers[0];
    const { quote } = offer;
    const timing = worldShipTimeBreakdown(world, offer);
    const pickup = offer.contract.pickup ?? origin;
    const speed = quote.speedKmPerDay;
    legs = [];
    stops = [{ point: origin, pickupOfferIds: atOrigin.map((row) => row.id), deliveryOfferIds: [], loadAfterPoints: initialLoadPoints }];
    if (offer.contract.pickup) {
      const route = routeBetween(origin, pickup);
      legs.push({ from: origin, to: pickup, route, flightQd: Math.ceil(route.distanceKm * 4 / speed), loadOnLegPoints: 0, hiddenOnLegPoints: 0, offerIds: [] });
      stops.push({ point: pickup, pickupOfferIds: [offer.id], deliveryOfferIds: [], loadAfterPoints: offer.contract.cargo.loadPoints });
    }
    const route = routeBetween(pickup, offer.to);
    legs.push({ from: pickup, to: offer.to, route, flightQd: Math.ceil(route.distanceKm * 4 / speed), loadOnLegPoints: offer.contract.cargo.loadPoints, hiddenOnLegPoints: hidden(offer), offerIds: [offer.id] });
    stops.push({ point: offer.to, pickupOfferIds: [], deliveryOfferIds: [offer.id], loadAfterPoints: 0 });
    // Handling and approach remain exactly those of the single-order quote (no bundle minimum rest).
    stops[offer.contract.pickup ? 1 : 0].portQd = timing.loadingQd;
    stops.at(-1).portQd = timing.unloadingQd;
    totalDurationQd = quote.durationQd;
    distanceKm = quote.distanceKm;
    totalOperatingCopper = firstLegCopper = quote.operatingCopper;
    returnReserveCopper = quote.returnReserveCopper;
    idleReserveCopper = quote.idleReserveCopper;
    recommendedBudgetCopper = Math.max(quote.recommendedBudgetCopper,
      contractGuidance(offer.contract, style).suggestedBudgetCopper + returnReserveCopper + idleReserveCopper);
    outcomeReserveCopper = recommendedBudgetCopper - totalOperatingCopper - returnReserveCopper - idleReserveCopper;
  } else {
    let plan;
    try { plan = quoteWorldShipBundle(data, holding, calculationShip, offers, { context: world }); }
    catch (error) {
      if (/совместимого маршрута/.test(error.message)) {
        throw new Error(`${error.message} Проверьте порядок погрузок и место в трюме на промежуточных участках. Повторный заход в один порт пока не поддерживается.`);
      }
      throw error;
    }
    ({ totalDurationQd, distanceKm, totalOperatingCopper, recommendedBudgetCopper,
      returnReserveCopper, idleReserveCopper, outcomeReserveCopper } = plan);
    firstLegCopper = plan.stops[0].legOffer.quote.operatingCopper;
    const carried = new Set(atOrigin.map((offer) => offer.id));
    stops = [{ point: origin, pickupOfferIds: [...carried], deliveryOfferIds: [], loadAfterPoints: initialLoadPoints }];
    legs = plan.stops.map((stop) => {
      const from = stop.legOffer.from;
      const route = routeBetween(from, stop.point);
      const flightQd = Math.ceil(route.distanceKm * 4 / stop.legOffer.quote.speedKmPerDay);
      const leg = { from, to: stop.point, route, flightQd,
        loadOnLegPoints: stop.loadOnLegPoints, offerIds: [...carried],
        hiddenOnLegPoints: offers.filter((offer) => carried.has(offer.id)).reduce((sum, offer) => sum + hidden(offer), 0),
        operatingCopper: stop.legOffer.quote.operatingCopper,
        durationQd: stop.legOffer.quote.durationQd };
      // First bundle leg includes loading at the origin; don't invent a precise phase schedule yet.
      for (const id of stop.deliveryOfferIds) carried.delete(id);
      for (const id of stop.pickupOfferIds) carried.add(id);
      stops.push({ point: stop.point, pickupOfferIds: [...stop.pickupOfferIds], deliveryOfferIds: [...stop.deliveryOfferIds], loadAfterPoints: stop.loadAfterPoints });
      return leg;
    });
  }
  const blockers = [];
  if (ship.condition !== "ready") blockers.push("Корабль требует ремонта.");
  const readiness = shipCrewReadiness(holding, ship, { catalog: data.catalog });
  if (!readiness.ready) blockers.push(...readiness.issues.map((issue) => issue.message));
  if (clockQd > Number(holding.gm?.calendaria?.lastQd ?? 0)) blockers.push("Дата поселения раньше времени корабля. Отправление недоступно до восстановления даты.");
  if ((holding.special?.market?.outbound?.orders ?? []).some((order) => order.ownShipId === ship.id && !["delivered", "lost", "cancelled"].includes(order.status))) {
    blockers.push("Сначала завершите перевозку собственного товара во «Внешнем рынке».");
  }
  const money = shipMoneySummary(holding, calculationShip, { clockQd });
  const atHome = ship.location.kind === "home";
  const onboardCopper = Number(ship.onboardCopper ?? 0);
  const debtCopper = money.portDebtCopper;
  const walletAfterDebt = Math.max(0, onboardCopper - debtCopper);
  const homeDebtCopper = atHome ? Math.max(0, debtCopper - onboardCopper) : 0;
  // A debt without a billing record cannot be settled by the existing departure operation.
  if (!calculationShip.portBilling && debtCopper > 0) blockers.push("Неоплаченный портовый счёт требует урегулирования перед отправлением.");
  const flightQd = legs.reduce((sum, leg) => sum + leg.flightQd, 0);
  const rewardCopper = offers.reduce((sum, offer) => sum + offer.contract.rewardCopper, 0);
  return withShipOrderBudget({
    offers, world, origin, finalPoint: stops.at(-1).point, stops, legs, style, clockQd,
    totalDurationQd, flightQd, portQd: totalDurationQd - flightQd, distanceKm,
    initialLoadPoints, capacityLoadPoints, hiddenCapacityLoadPoints,
    maxLoadPoints: Math.max(...legs.map((leg) => leg.loadOnLegPoints)),
    totalOperatingCopper, rewardCopper, plannedMarginCopper: rewardCopper - totalOperatingCopper,
    nominalExitCopper: rewardCopper - totalOperatingCopper - returnReserveCopper,
    recommendedBudgetCopper, returnReserveCopper, idleReserveCopper, outcomeReserveCopper,
    firstLegCopper, onboardCopper, debtCopper, homeDebtCopper, walletAfterDebt,
    settlementCopper: Number(holding.storage?.moneyCopper ?? 0),
    departureBlockers: blockers, atHome, isBundle: offers.length > 1,
    departingAssignments: atHome ? readiness.departingAssignments : []
  }, budgetCopper);
}

/** Budget typing must not rebuild markets, shortest paths or order permutations. */
export function withShipOrderBudget(plan, budgetCopper = null) {
  if (budgetCopper !== null && (!Number.isSafeInteger(budgetCopper) || budgetCopper < 0)) throw new Error("Укажите неотрицательный бюджет в ЗМ.");
  const { atHome, recommendedBudgetCopper, walletAfterDebt, homeDebtCopper, firstLegCopper } = plan;
  const targetBudgetCopper = atHome ? (budgetCopper ?? recommendedBudgetCopper) : walletAfterDebt;
  const transferCopper = atHome ? Math.max(0, targetBudgetCopper - walletAfterDebt) : 0;
  const shortageCopper = atHome
    ? Math.max(0, homeDebtCopper + transferCopper - plan.settlementCopper)
    : Math.max(0, plan.debtCopper + firstLegCopper - plan.onboardCopper);
  const blockers = [...plan.departureBlockers];
  if (atHome && targetBudgetCopper < firstLegCopper) blockers.push("Выбранный бюджет меньше расходов первого участка.");
  if (shortageCopper > 0) blockers.push("Не хватает денег для погашения стоянки и отправления с выбранным бюджетом.");
  return { ...plan, targetBudgetCopper, transferCopper, settlementWithdrawalCopper: homeDebtCopper + transferCopper,
    shortageCopper, blockers, canDepart: blockers.length === 0,
    reserveShortageCopper: Math.max(0, recommendedBudgetCopper - Math.max(walletAfterDebt, targetBudgetCopper)) };
}
