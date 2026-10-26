export const transportOrders = (holding) => holding?.special?.transportV2?.orders ?? [];
export const activeTransportOrder = (order) => !["delivered", "lost", "cancelled"].includes(order.status);

export function transportCargoReservations(holding) {
  return transportOrders(holding).filter((order) => activeTransportOrder(order) && order.direction === "outbound")
    .flatMap((order) => (order.cargo ?? []).map((lot) => ({ ...lot, qty: Math.max(0, lot.qty - (order.dispatched?.[lot.lotId] ?? 0)
      - (order.sourceSpoiledPending?.[lot.lotId] ?? 0)) })))
    .filter((lot) => lot.qty > 0);
}

export function expireTransportReservation(holding, rowId, batchId) {
  for (const order of transportOrders(holding)) {
    if (!activeTransportOrder(order) || order.direction !== "outbound") continue;
    for (const lot of order.cargo ?? []) {
      if (lot.rowId !== rowId || lot.batchId !== batchId) continue;
      order.sourceSpoiledPending ??= {};
      order.sourceSpoiledPending[lot.lotId] = Math.max(0, lot.qty - (order.dispatched?.[lot.lotId] ?? 0));
    }
  }
}

/** No defaults are installed while loading a world; activation is an explicit GM operation. */
export function previewTransportActivation(data) {
  const blockers = [];
  for (const holding of data?.holdings ?? []) {
    const legacy = [...(holding.special?.market?.orders ?? []), ...(holding.special?.market?.outbound?.orders ?? [])];
    if (legacy.some((order) => !["delivered", "lost", "cancelled"].includes(order.status))) blockers.push(`${holding.name}: завершите существующие рыночные перевозки.`);
    if ((holding.special?.ships?.list ?? []).some((ship) => ship.activeVoyage || ship.orderBundle)) blockers.push(`${holding.name}: завершите принятые корабельные рейсы.`);
  }
  const dates = [...new Set((data?.holdings ?? []).map((holding) => Number(holding.gm?.calendaria?.lastQd ?? 0)))];
  if (dates.length > 1) blockers.push("Поселения находятся на разных датах. Согласуйте текущую дату логистики перед включением.");
  return { canActivate: !blockers.length, blockers, clockQd: Math.max(0, ...dates), alreadyEnabled: data?.meta?.transportV2?.enabled === true };
}
