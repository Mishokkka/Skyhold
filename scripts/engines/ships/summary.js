import { contractGuidance } from "./contracts.js";
import { bundleOutcomeReserves } from "./bundle-accounting.js";

/** Read-only cash and readiness presentation; never settles a bill or changes a quote. */
const amount = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

function pendingIncidentReserve(ship, quote) {
  if (ship.orderBundle) {
    const orders = ship.orderBundle.orders ?? [];
    const reserves = bundleOutcomeReserves(orders.map((order) => order.offer), ship.orderBundle.totalOperatingCopper);
    return orders.reduce((sum, order, index) => sum + (order.outcome || order.outcomeApplied ? 0 : reserves[index]), 0);
  }
  if (!quote?.contract || ship.activeVoyage?.outcome) return 0;
  const saved = Math.max(0, amount(quote.recommendedBudgetCopper) - amount(quote.operatingCopper)
    - amount(quote.returnReserveCopper) - amount(quote.idleReserveCopper));
  try {
    const styled = contractGuidance(quote.contract, ship.activeVoyage?.style ?? "normal");
    return Math.max(saved, styled.suggestedBudgetCopper - styled.operatingCopper);
  } catch (_error) {
    // Older incomplete snapshots still have a saved budget; viewing does not repair them.
    return saved;
  }
}

export function shipMoneySummary(holding, ship, { returnOffer = null, clockQd = 0 } = {}) {
  const atHome = ship.location?.kind === "home" && !ship.activeVoyage;
  const quote = ship.activeVoyage?.quote;
  const bill = ship.portBilling;
  const accrued = bill ? Math.max(0, amount(bill.carriedCopper)
    + Math.ceil(amount(bill.dailyCopper) * Math.max(0, Math.max(clockQd, amount(bill.lastCalculatedQd)) - amount(bill.sinceQd)) / 4)
    - amount(bill.chargedCopper)) : 0;
  const portDebtCopper = Math.max(amount(ship.pendingPortBillCopper), accrued);
  const outcomeDueCopper = (ship.activeVoyage?.outcome && !ship.activeVoyage.outcomeApplied
    ? amount(ship.activeVoyage.outcome.expenseCopper) : 0)
    + (ship.orderBundle?.orders ?? []).reduce((sum, order) => sum + (order.outcome && !order.outcomeApplied ? amount(order.outcome.expenseCopper) : 0), 0);
  const obligationsCopper = portDebtCopper + outcomeDueCopper;
  const balanceCopper = atHome ? amount(holding.storage?.moneyCopper) + amount(ship.onboardCopper) : amount(ship.onboardCopper);
  const returning = quote?.to?.kind === "home";
  const returnReserveCopper = atHome || returning ? 0
    : amount(ship.orderBundle?.returnReserveCopper ?? quote?.returnReserveCopper ?? returnOffer?.quote?.operatingCopper ?? returnOffer?.costs?.totalCopper);
  const idleReserveCopper = atHome || returning ? 0
    : amount(ship.orderBundle?.idleReserveCopper ?? quote?.idleReserveCopper ?? amount(ship.idleUpkeepCopperPerDay) * 2);
  let incidentReserveCopper = 0;
  let calculationValid = Number.isSafeInteger(clockQd) && clockQd >= 0 && [holding.storage?.moneyCopper, ship.onboardCopper, ship.pendingPortBillCopper,
    bill?.dailyCopper, bill?.chargedCopper, bill?.carriedCopper].every((value) => value == null
      || Number.isSafeInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 1_000_000_000);
  try { incidentReserveCopper = pendingIncidentReserve(ship, quote); }
  catch (_error) { calculationValid = false; }
  const remainingOperatingCopper = (ship.orderBundle?.stops ?? [])
    .slice((ship.orderBundle?.nextStopIndex ?? 0) + (ship.activeVoyage ? 1 : 0))
    .reduce((sum, stop) => sum + amount(stop.legOffer?.quote?.operatingCopper), 0);
  const reserveKnown = calculationValid && (atHome || returning || Boolean(ship.orderBundle || quote || returnOffer));
  const reserveCopper = returnReserveCopper + idleReserveCopper + incidentReserveCopper + remainingOperatingCopper;
  const remainderCopper = balanceCopper - obligationsCopper - reserveCopper;
  return {
    atHome, calculationValid, balanceCopper, walletCopper: amount(ship.onboardCopper), settlementCopper: amount(holding.storage?.moneyCopper), portDebtCopper, outcomeDueCopper, obligationsCopper,
    returnReserveCopper, idleReserveCopper, incidentReserveCopper, remainingOperatingCopper, reserveCopper, reserveKnown,
    freeCopper: reserveKnown ? Math.max(0, remainderCopper) : null,
    shortageCopper: Math.max(0, -remainderCopper),
    balanceLabel: atHome ? "Доступно дома" : "Деньги на борту"
  };
}

export function shipNextAction(ship, { readiness, money, offers = [], returnOffer = null } = {}) {
  if (ship.orderBundle?.status === "awaiting-outcome") return ship.orderBundle.waitingFunds
    ? "Нужны бортовые деньги для исхода составного рейса" : "Подвести итоги доставленных заказов";
  if (ship.orderBundle?.status === "at-port") return "Отправиться в следующий порт составного рейса";
  if (ship.orderBundle?.status === "final-delay") return "Дождаться окончания задержки в порту";
  if (ship.orderBundle?.status === "travelling") return "Составной рейс — дождаться следующего порта";
  if (ship.activeVoyage?.awaitingOutcome) return money?.shortageCopper && ship.activeVoyage?.waitingFunds
    ? "Нужны бортовые деньги для сохранённого исхода" : "Подвести итог заказа";
  if (ship.activeVoyage) return "В пути — дождаться прибытия";
  if (ship.condition !== "ready") return "Корабль не исправен — требуется решение ГМ";
  if (money?.obligationsCopper > money?.balanceCopper) return "Не хватает денег для оплаты счёта";
  if (readiness && !readiness.ready) return returnOffer
    ? "Команда не готова к новому заказу; можно вернуться домой" : "Уточнить готовность команды";
  if (offers.length) return "Выбрать заказ и подход капитана";
  if (returnOffer) return "Узнать местные предложения или лететь домой";
  return "Узнать предложения в этом порту";
}

export function shipOutingSummary(ship, { clockQd = 0, obligationsCopper = 0 } = {}) {
  const report = ship.currentOuting ?? ship.lastOuting;
  if (!report || report.version !== 1) return null;
  const ongoing = Boolean(ship.currentOuting);
  const start = amount(report.knownSinceQd ?? report.startedAtQd);
  const end = ongoing ? Math.max(start, clockQd, amount(ship.activeVoyage?.lastProcessedQd), amount(ship.portBilling?.lastCalculatedQd)) : amount(report.completedAtQd);
  const incomeCopper = amount(report.incomeCopper);
  const expenseCopper = amount(report.expenseCopper);
  const plannedExpenseCopper = amount(report.plannedOperatingCopper) + amount(report.plannedPreparationCopper);
  const plannedIncomeCopper = amount(report.plannedRewardCopper);
  const netCopper = incomeCopper - expenseCopper;
  return {
    ...report, ongoing, incomeCopper, expenseCopper, netCopper,
    plannedIncomeCopper, plannedExpenseCopper, plannedNetCopper: plannedIncomeCopper - plannedExpenseCopper,
    varianceCopper: netCopper - (plannedIncomeCopper - plannedExpenseCopper),
    durationDays: Math.max(0, end - start) / 4, plannedDays: amount(report.plannedDurationQd) / 4,
    balanceCopper: ongoing ? amount(ship.onboardCopper) : amount(report.returnedCopper),
    obligationsCopper: ongoing ? obligationsCopper : 0,
    details: (report.details ?? []).slice(-40).reverse().map((row) => ({
      ...row, elapsedDays: Math.max(0, amount(row.clockQd) - start) / 4
    }))
  };
}
