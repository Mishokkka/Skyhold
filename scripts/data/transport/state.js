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

/** Transport is the only runtime model. This initializes an in-memory draft, never a world setting. */
export function ensureTransportState(data) {
  data.meta ??= {};
  data.meta.transportV2 ??= { version: 2,
    clockQd: Math.max(0, ...(data.holdings ?? []).map((holding) => Number(holding.gm?.calendaria?.lastQd ?? 0))), runs: [] };
  delete data.meta.transportV2.enabled;
  return data.meta.transportV2;
}
