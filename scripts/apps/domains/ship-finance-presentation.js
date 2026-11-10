import { prepareShipTransportFinance } from "./ship-transport-finance.js";
import { createMarketVisibility } from "../../data/market/visibility.js";

const amount = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const validAmount = (value) => Number.isSafeInteger(value) && value >= 0;
const DETAIL_LABELS = Object.freeze({
  funding: "Выделено из казны", depart: "Подготовка", income: "Поступление", expense: "Расход",
  "port-expense": "Стоянка", return: "Передано домой", "leg-start": "Отправление",
  "leg-complete": "Прибытие", "outing-complete": "Выход завершён", "bundle-plan": "Приняты заказы",
  "partial-start": "Начало учёта"
});

function detailRow(row, hideRoutes = false) {
  const transfer = row.kind === "funding" || row.kind === "return";
  const routeNote = ["leg-start", "leg-complete", "outing-complete"].includes(row.kind)
    || row.kind === "expense" && String(row.reason ?? "").startsWith("Автоматические расходы:");
  return {
    ...row,
    kindLabel: DETAIL_LABELS[row.kind] || (row.amountCopper > 0 ? "Поступление" : row.amountCopper < 0 ? "Расход" : "Запись"),
    // Old journal rows retain only text, not endpoint IDs. A private related
    // transport outing therefore uses a neutral route, without editing history.
    reason: hideRoutes && routeNote ? "Скрытый участок"
      : row.kind === "bundle-plan" ? "Договорная плата составных заказов включена в план." : row.reason,
    hasAmount: Number.isSafeInteger(row.amountCopper) && row.amountCopper !== 0,
    displayAmountCopper: transfer ? Math.abs(row.amountCopper) : row.amountCopper,
    isTransfer: transfer
  };
}

function pendingPayments(ship, ownSale, visibility) {
  const orders = ship.orderBundle ? (ship.orderBundle.orders ?? []).filter((order) => order.state !== "delivered" && !order.outcomeApplied)
    : ship.activeVoyage?.quote?.contract && !ship.activeVoyage.outcomeApplied
      ? [{ offer: ship.activeVoyage.quote, outcome: ship.activeVoyage.outcome }] : [];
  const rows = orders.map((order) => ({
    label: order.offer?.contract?.cargo?.name || (visibility.routeHidden(order.offer) ? "Заказ по скрытому маршруту" : order.offer?.title) || "Заказ",
    routeLabel: order.offer?.to?.label
      ? `${visibility.pointLabel(order.offer.contract?.pickup ?? order.offer.from, "Погрузка")} → ${visibility.pointLabel(order.offer.to)}` : "",
    amountCopper: amount(order.outcome?.rewardCopper ?? order.offer?.contract?.rewardCopper),
    basisLabel: order.outcome ? "По сохранённому исходу" : "Договорная плата до исхода"
  }));
  if (ownSale && !ownSale.revenueOperationId && !["delivered", "lost", "cancelled"].includes(ownSale.status)) {
    rows.push({ label: `Продажа: ${visibility.marketLabel(ownSale)}`,
      amountCopper: amount(ownSale.revenueCopper), basisLabel: "Ожидаемая выручка до расчёта продажи" });
  }
  return rows;
}

/** Financial explanations from existing receipts and accepted snapshots, without changing any ledger. */
export function prepareShipFinancePresentation(holding, ship, { money, outingReport, ownSale = null, data = null, isGM = true } = {}) {
  const visibility = createMarketVisibility(data, { isGM });
  const mandatoryShortageCopper = money?.calculationValid ? Math.max(0, money.obligationsCopper - money.balanceCopper) : null;
  const reserveShortageCopper = money?.reserveKnown ? Math.max(0, money.shortageCopper - mandatoryShortageCopper) : null;
  const transport = prepareShipTransportFinance(holding, ship, outingReport, { data, isGM });
  const payments = [...pendingPayments(ship, ownSale, visibility), ...transport.pendingPayments];
  let outing = null;
  if (outingReport) {
    // A sale starts its ship outing with the same operationId. Never attach another ship's or another outing's costs.
    const sale = (holding.special?.market?.outbound?.orders ?? []).find((order) => order.ownShipId === ship.id
      && order.operationId === outingReport.id) ?? null;
    const legacyExpenseKnown = Boolean(sale?.upfrontOperationId && validAmount(sale.upfrontCopper));
    const marketExpenseKnown = Boolean(sale || transport.present) && (!sale || legacyExpenseKnown) && transport.known;
    const legacyExpenseCopper = legacyExpenseKnown ? sale.upfrontCopper : 0;
    const marketExpenseCopper = legacyExpenseCopper + transport.expenseCopper;
    const futureStops = outingReport.ongoing ? (ship.orderBundle?.stops ?? [])
      .slice(amount(ship.orderBundle?.nextStopIndex) + (ship.activeVoyage ? 1 : 0)) : [];
    const futureOperatingCopper = futureStops.reduce((sum, stop) => sum + amount(stop.legOffer?.quote?.operatingCopper), 0);
    const futureDurationQd = futureStops.reduce((sum, stop) => sum + amount(stop.legOffer?.quote?.durationQd), 0);
    const plannedExpenseCopper = outingReport.plannedExpenseCopper + futureOperatingCopper + legacyExpenseCopper + transport.plannedExpenseCopper;
    const plannedIncomeCopper = outingReport.plannedIncomeCopper + amount(sale?.revenueCopper) + transport.plannedIncomeCopper;
    const netCopper = outingReport.netCopper - marketExpenseCopper + transport.treasuryIncomeCopper;
    const startQd = outingReport.knownSinceQd ?? outingReport.startedAtQd;
    const relatedPassages = (holding.special?.ships?.history ?? []).filter(row => row.shipId === ship.id
      && (row.id === outingReport.lastCompletedLegId || row.startedAtQd >= startQd
        && (outingReport.ongoing || row.startedAtQd < outingReport.completedAtQd)));
    const currentRoutes = outingReport.ongoing ? [ship.activeVoyage?.quote, ...(ship.orderBundle?.orders ?? []).map(order => order.offer)] : [];
    const hideRoutes = transport.hideOutingRoutes || sale && visibility.marketHidden(sale)
      || [...relatedPassages, ...currentRoutes].some(visibility.routeHidden);
    const details = [...(outingReport.details ?? []).map(row => detailRow(row, hideRoutes)), ...transport.details];
    if (legacyExpenseKnown && legacyExpenseCopper > 0) details.push({
      kindLabel: "Расходы рынка", reason: `Продажа: ${visibility.marketLabel(sale)}. Оплачено казной при отправлении.`,
      timeLabel: "При отправлении", hasAmount: true, displayAmountCopper: -legacyExpenseCopper, isTransfer: false
    });
    outing = {
      ...outingReport, netCopper, marketExpenseCopper, marketExpenseKnown,
      hasSale: Boolean(sale) || transport.hasSale, hasTransport: transport.present, transportPending: transport.pending,
      hasMarketExpenses: Boolean(sale) || transport.present, treasuryIncomeCopper: transport.treasuryIncomeCopper,
      saleCostsUnknown: Boolean(sale || transport.present) && !marketExpenseKnown,
      shipExpenseCopper: outingReport.expenseCopper, totalExpenseCopper: outingReport.expenseCopper + marketExpenseCopper,
      plannedIncomeCopper, plannedExpenseCopper, plannedNetCopper: plannedIncomeCopper - plannedExpenseCopper,
      plannedDays: outingReport.plannedDays + futureDurationQd / 4,
      varianceCopper: netCopper - (plannedIncomeCopper - plannedExpenseCopper),
      canComparePlan: !outingReport.partial && !outingReport.ongoing && !transport.pending
        && (!(sale || transport.present) || marketExpenseKnown),
      details
    };
  }
  return { mandatoryShortageCopper, reserveShortageCopper, pendingPayments: payments, outing };
}
