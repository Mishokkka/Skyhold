function copper(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

/** One money receipt for the whole purchase; batch arrival is a cargo receipt. */
export function marketPurchasePaymentEntry(plan = {}, operationId = "") {
  return {
    kind: "market-purchase",
    resourceId: "money",
    name: "Покупка с доставкой",
    qty: -copper(plan.totalCopper),
    unit: "ММ",
    roomId: "treasury",
    source: String(plan.marketLabel ?? "Внешний рынок"),
    operationId: `${operationId}:payment`,
    note: `заказ ${operationId}; товары ${copper(plan.subtotalCopper)} ММ; доставка ${copper(plan.deliveryCopper)} ММ: маршрут ${copper(plan.routeCopper)}, обработка ${copper(plan.handlingCopper)}, страхование ${copper(plan.insuranceCopper)}, пошлины ${copper(plan.taxCopper)}, срочность ${copper(plan.expressSurchargeCopper)} ММ`
  };
}
