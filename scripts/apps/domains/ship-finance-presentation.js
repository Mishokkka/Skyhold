const amount = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const validAmount = (value) => Number.isSafeInteger(value) && value >= 0;
const DETAIL_LABELS = Object.freeze({
  funding: "Выделено из казны", depart: "Подготовка", income: "Поступление", expense: "Расход",
  "port-expense": "Стоянка", return: "Передано домой", "leg-start": "Отправление",
  "leg-complete": "Прибытие", "outing-complete": "Выход завершён", "bundle-plan": "Приняты заказы",
  "partial-start": "Начало учёта"
});

function detailRow(row) {
  const transfer = row.kind === "funding" || row.kind === "return";
  return {
    ...row,
    kindLabel: DETAIL_LABELS[row.kind] || (row.amountCopper > 0 ? "Поступление" : row.amountCopper < 0 ? "Расход" : "Запись"),
    reason: row.kind === "bundle-plan" ? "Договорная плата составных заказов включена в план." : row.reason,
    hasAmount: Number.isSafeInteger(row.amountCopper) && row.amountCopper !== 0,
    displayAmountCopper: transfer ? Math.abs(row.amountCopper) : row.amountCopper,
    isTransfer: transfer
  };
}

function pendingPayments(ship, ownSale) {
  const orders = ship.orderBundle ? (ship.orderBundle.orders ?? []).filter((order) => order.state !== "delivered" && !order.outcomeApplied)
    : ship.activeVoyage?.quote?.contract && !ship.activeVoyage.outcomeApplied
      ? [{ offer: ship.activeVoyage.quote, outcome: ship.activeVoyage.outcome }] : [];
  const rows = orders.map((order) => ({
    label: order.offer?.contract?.cargo?.name || order.offer?.title || "Заказ",
    routeLabel: order.offer?.to?.label
      ? `${order.offer.contract?.pickup?.label || order.offer.from?.label || "Погрузка"} → ${order.offer.to.label}` : "",
    amountCopper: amount(order.outcome?.rewardCopper ?? order.offer?.contract?.rewardCopper),
    basisLabel: order.outcome ? "По сохранённому исходу" : "Договорная плата до исхода"
  }));
  if (ownSale && !ownSale.revenueOperationId && !["delivered", "lost", "cancelled"].includes(ownSale.status)) {
    rows.push({ label: `Продажа: ${ownSale.marketLabel || "Внешний рынок"}`,
      amountCopper: amount(ownSale.revenueCopper), basisLabel: "Ожидаемая выручка до расчёта продажи" });
  }
  return rows;
}

/** Financial explanations from existing receipts and accepted snapshots, without changing any ledger. */
export function prepareShipFinancePresentation(holding, ship, { money, outingReport, ownSale = null } = {}) {
  const mandatoryShortageCopper = money?.calculationValid ? Math.max(0, money.obligationsCopper - money.balanceCopper) : null;
  const reserveShortageCopper = money?.reserveKnown ? Math.max(0, money.shortageCopper - mandatoryShortageCopper) : null;
  const payments = pendingPayments(ship, ownSale);
  let outing = null;
  if (outingReport) {
    // A sale starts its ship outing with the same operationId. Never attach another ship's or another outing's costs.
    const sale = (holding.special?.market?.outbound?.orders ?? []).find((order) => order.ownShipId === ship.id
      && order.operationId === outingReport.id) ?? null;
    const marketExpenseKnown = Boolean(sale?.upfrontOperationId && validAmount(sale.upfrontCopper));
    const marketExpenseCopper = marketExpenseKnown ? sale.upfrontCopper : 0;
    const futureStops = outingReport.ongoing ? (ship.orderBundle?.stops ?? [])
      .slice(amount(ship.orderBundle?.nextStopIndex) + (ship.activeVoyage ? 1 : 0)) : [];
    const futureOperatingCopper = futureStops.reduce((sum, stop) => sum + amount(stop.legOffer?.quote?.operatingCopper), 0);
    const futureDurationQd = futureStops.reduce((sum, stop) => sum + amount(stop.legOffer?.quote?.durationQd), 0);
    const plannedExpenseCopper = outingReport.plannedExpenseCopper + futureOperatingCopper + marketExpenseCopper;
    const plannedIncomeCopper = outingReport.plannedIncomeCopper + amount(sale?.revenueCopper);
    const netCopper = outingReport.netCopper - marketExpenseCopper;
    const details = (outingReport.details ?? []).map(detailRow);
    if (marketExpenseKnown && marketExpenseCopper > 0) details.push({
      kindLabel: "Расходы рынка", reason: `Продажа: ${sale.marketLabel || "Внешний рынок"}. Оплачено казной при отправлении.`,
      timeLabel: "При отправлении", hasAmount: true, displayAmountCopper: -marketExpenseCopper, isTransfer: false
    });
    outing = {
      ...outingReport, netCopper, marketExpenseCopper, marketExpenseKnown,
      hasSale: Boolean(sale), saleCostsUnknown: Boolean(sale && !marketExpenseKnown),
      shipExpenseCopper: outingReport.expenseCopper, totalExpenseCopper: outingReport.expenseCopper + marketExpenseCopper,
      plannedIncomeCopper, plannedExpenseCopper, plannedNetCopper: plannedIncomeCopper - plannedExpenseCopper,
      plannedDays: outingReport.plannedDays + futureDurationQd / 4,
      varianceCopper: netCopper - (plannedIncomeCopper - plannedExpenseCopper),
      canComparePlan: !outingReport.partial && !outingReport.ongoing && (!sale || marketExpenseKnown),
      details
    };
  }
  return { mandatoryShortageCopper, reserveShortageCopper, pendingPayments: payments, outing };
}
