import { activeTransportOrder, transportOrders } from "../../data/transport/state.js";
import { transportLocalQd } from "../../data/transport/clock.js";
import { createMarketVisibility } from "../../data/market/visibility.js";

const amount = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const validAmount = value => Number.isSafeInteger(value) && value >= 0;
const valueOf = cargo => (cargo ?? []).reduce((sum, lot) => sum + amount(lot.qty) * amount(lot.unitCopper), 0);

function outstandingRevenue(order) {
  const lostValue = (order.stages ?? []).reduce((sum, stage) => sum
    + valueOf((stage.receipts ?? []).filter(receipt => receipt.status === "arrived").flatMap(receipt => receipt.cargo))
    - valueOf(stage.received), 0);
  const sourceSpoiledValue = (order.cargo ?? []).reduce((sum, lot) => sum
    + amount(order.sourceSpoiledPending?.[lot.lotId]) * amount(lot.unitCopper), 0);
  return Math.max(0, valueOf(order.cargo) - valueOf(order.received) - lostValue - sourceSpoiledValue);
}

/** Add only the accepted transport operations belonging to this outing; never write a ledger. */
export function prepareShipTransportFinance(holding, ship, outingReport, { data = null, isGM = true } = {}) {
  const visibility = createMarketVisibility(data, { isGM });
  const labelFor = order => visibility.marketLabel(order.commercial);
  const accepted = transportOrders(holding).filter(order => order.ownShipId === ship.id && order.shipStarted && order.status !== "cancelled");
  const pendingPayments = accepted.filter(order => order.direction === "outbound" && activeTransportOrder(order))
    .map(order => ({ label: `Продажа: ${labelFor(order)}`,
      amountCopper: outstandingRevenue(order),
      basisLabel: `Остаток после известных потерь; поступит ${order.commercial?.revenueOnBoard ? "на борт" : "в казну"}` }))
    .filter(row => row.amountCopper > 0);
  const orders = outingReport ? accepted.filter(order => {
    if (order.id === outingReport.id) return true;
    const start = transportLocalQd(order, order.plan.startQd);
    // A ship can accept several transport orders during one outing. The next
    // outing may start at exactly the previous one's completion, so exclude it.
    return start >= (outingReport.knownSinceQd ?? outingReport.startedAtQd)
      && (outingReport.ongoing || start < outingReport.completedAtQd);
  }) : [];
  const result = { present: orders.length > 0, hasSale: orders.some(order => order.direction === "outbound"),
    known: true, pending: false, pendingPayments, plannedIncomeCopper: 0, plannedExpenseCopper: 0,
    expenseCopper: 0, treasuryIncomeCopper: 0, details: [] };
  for (const order of orders) {
    const market = order.commercial ?? {}, money = order.money ?? {};
    const goodsCopper = order.direction === "inbound" ? valueOf(order.cargo) : 0;
    const known = [money.commercialSpentCopper, money.spentCopper, order.shipExpenseRecordedCopper].every(validAmount)
      && (order.history ?? []).some(row => row.kind === "booked");
    result.known &&= known;
    result.pending ||= activeTransportOrder(order) || !order.shipReleased || !order.shipCostsReconciled || order.fundingNeededCopper > 0;
    result.plannedIncomeCopper += order.direction === "outbound" ? valueOf(order.plan.cargo) : 0;
    result.plannedExpenseCopper += amount(order.plan.totalCopper) - amount(order.plan.ownExpensesCopper)
      + amount(market.taxCopper) + amount(market.insuranceCopper);
    // Goods are inventory, not an operating expense. Own expenses and onboard
    // sale proceeds are already recorded in the ship outing and must not recur.
    const expense = known ? Math.max(0, money.commercialSpentCopper - goodsCopper)
      + Math.max(0, money.spentCopper - order.shipExpenseRecordedCopper) : 0;
    const income = (order.direction === "outbound" && !market.revenueOnBoard ? valueOf(order.received) : 0)
      + amount(order.insurancePaidCopper);
    result.expenseCopper += expense;
    result.treasuryIncomeCopper += income;
    const reason = `Перевозка: ${labelFor(order)}. По проведённым операциям казны и резерва.`;
    if (expense) result.details.push({ kindLabel: "Расходы перевозки вне борта", reason,
      timeLabel: "По заказу", hasAmount: true, displayAmountCopper: -expense, isTransfer: false });
    if (income) result.details.push({ kindLabel: "Выручка и страхование в казну", reason,
      timeLabel: "По заказу", hasAmount: true, displayAmountCopper: income, isTransfer: false });
  }
  return result;
}
