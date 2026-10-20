import { worldShipPortDebtCopper, worldShipTimelineQd } from "../../engines/ships/world-voyage.js";

const validMoney = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const samePoint = (left, right) => left?.kind === right?.kind && String(left?.id ?? "") === String(right?.id ?? "");

/** Invalid saved clocks remain visible for GM diagnosis rather than being repaired on opening. */
export function shipPresentationTimelineQd(holding, ship) {
  try { return worldShipTimelineQd(holding, ship); }
  catch (_error) { return NaN; }
}

/** Presentation only. The authority transaction still validates every command and saved identity. */
export function prepareShipCommandAvailability(holding, ship, { permissions, permissionReason = "", returnOffer = null, ownSale = null } = {}) {
  const shipQd = shipPresentationTimelineQd(holding, ship);
  const settlementQd = Number(holding.gm?.calendaria?.lastQd ?? 0);
  const clockIssue = !validTime(shipQd) || !validTime(settlementQd)
    ? "Время корабля или поселения требует проверки ГМа."
    : shipQd > settlementQd ? "Дата поселения раньше времени корабля. Восстановите дату перед приказом." : "";
  const commonIssues = [permissionReason, clockIssue].filter(Boolean);
  if (permissions && !permissions.canManageShips && !permissionReason) commonIssues.unshift("Управление кораблём недоступно.");
  const result = { clockIssue, clockBlocked: Boolean(clockIssue), departurePortBillCopper: null,
    continueBundle: null, resolveBundle: null, resolveWorld: null, returnHome: null };
  if (!ship.activeVoyage && !ship.orderBundle && ship.location?.kind === "market") {
    try { result.departurePortBillCopper = worldShipPortDebtCopper(ship, shipQd); }
    catch (_error) { /* Unknown billing is explained by the departure command, without repairing it. */ }
  }
  const finish = (issues, fields = {}) => {
    const blockers = [...commonIssues, ...issues];
    return { ...fields, blockers, allowed: blockers.length === 0, reasonText: blockers.join(" ") };
  };
  const departure = (offer, issues, departureQd) => {
    if (ship.condition !== "ready") issues.push("Корабль требует обслуживания; необходимо решение ГМа.");
    if (ship.activeVoyage) issues.push("Сначала завершите текущий участок рейса.");
    if (!offer?.quote || offer.mode !== "world" || offer.shipId !== ship.id || !samePoint(offer.from, ship.location)
      || !offer.to?.id || samePoint(offer.from, offer.to)) {
      issues.push("Сохранённый участок не соответствует порту корабля; проверьте маршрут с ГМом.");
      return finish(issues);
    }
    const quote = offer.quote;
    const atHome = ship.location?.kind === "home";
    const operatingCopper = quote.operatingCopper;
    const budgetCopper = atHome ? quote.recommendedBudgetCopper ?? operatingCopper : operatingCopper;
    const preparationCopper = atHome ? quote.preparationCopper ?? 0 : 0;
    const walletCopper = ship.onboardCopper ?? 0;
    const settlementCopper = atHome ? holding.storage?.moneyCopper : 0;
    if (![operatingCopper, budgetCopper, preparationCopper, walletCopper, settlementCopper].every(validMoney)
      || budgetCopper < operatingCopper || !validTime(departureQd)
      || !Number.isSafeInteger(quote.durationQd) || quote.durationQd < 1 || quote.durationQd > 100_000) {
      issues.push("Стоимость шага или доступные деньги требуют проверки ГМа.");
      return finish(issues);
    }
    let portBillCopper;
    try { portBillCopper = worldShipPortDebtCopper(ship, departureQd); }
    catch (_error) {
      issues.push("Счёт стоянки требует проверки ГМа.");
      return finish(issues);
    }
    const availableCopper = walletCopper + settlementCopper;
    const requiredCopper = portBillCopper + budgetCopper + preparationCopper;
    const shortageCopper = Math.max(0, requiredCopper - availableCopper);
    if (shortageCopper) issues.push(atHome ? "Недостаточно денег дома для этого отправления." : "Недостаточно бортовых денег для этого отправления.");
    return finish(issues, {
      hasCost: true, atHome, operatingCopper, portBillCopper, requiredCopper, availableCopper, shortageCopper,
      durationDays: Number(quote.durationQd ?? 0) / 4,
      needsFunds: shortageCopper > 0,
      fundsHint: atHome ? "Дома доступен перевод из казны в разделе «Финансы»."
        : "В чужом порту доступен только кошелёк корабля. ГМ может записать фактическое поступление в разделе «Финансы» с указанием причины."
    });
  };
  const bundle = ship.orderBundle;
  if (ownSale) return result;
  if (bundle?.status === "at-port") {
    const issues = [];
    const delayUntilQd = bundle.delayUntilQd ?? 0;
    const departureQd = Math.max(shipQd, delayUntilQd);
    if (!validTime(delayUntilQd)) issues.push("Срок задержки требует проверки ГМа.");
    else if (departureQd > settlementQd) issues.push("Задержка в порту ещё не закончилась.");
    const nextStop = bundle.stops?.[bundle.nextStopIndex];
    result.continueBundle = departure(nextStop?.legOffer, issues, departureQd);
  } else if (bundle?.status === "awaiting-outcome") {
    const stop = bundle.stops?.[bundle.nextStopIndex - 1];
    const issues = [];
    if (ship.activeVoyage || ship.location?.kind !== "market" || !samePoint(stop?.point, ship.location)) {
      issues.push("Корабль не находится в запланированном порту доставки; проверьте маршрут с ГМом.");
    }
    result.resolveBundle = finish(issues);
  } else if (!bundle && ship.activeVoyage?.awaitingOutcome) {
    const issues = [];
    if (ship.status !== "away" || ship.activeVoyage.mode !== "world" || !ship.activeVoyage.quote?.contract) {
      issues.push("Сохранённый рейс не соответствует ожидаемому исходу; требуется проверка ГМа.");
    }
    // An initial roll is allowed before funds are known; saved outcomes also remain retryable.
    result.resolveWorld = finish(issues);
  } else if (!bundle && !ship.activeVoyage && ship.location?.kind === "market" && returnOffer) {
    result.returnHome = departure(returnOffer, [], shipQd);
  }
  return result;
}
