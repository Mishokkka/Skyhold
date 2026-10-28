import { transportEpochQd } from "./clock.js";

export const transportOrders = (holding) => holding?.special?.transportV2?.orders ?? [];
export const activeTransportOrder = (order) => !["delivered", "lost", "cancelled"].includes(order.status);

/** Drop operational records only after every consumer has passed them. Order receipts retain history. */
export function pruneCompletedTransportRuns(data) {
  const state = data.meta?.transportV2;
  if (!state || !Array.isArray(data.holdings)) return;
  const orders = new Map();
  let cutoff = state.clockQd;
  for (const holding of data.holdings) for (const order of transportOrders(holding)) {
    orders.set(JSON.stringify([holding.id, order.id]), order);
    if (!activeTransportOrder(order)) continue;
    // Lagging orders may still join an old departure or need an old vehicle's return date.
    cutoff = Math.min(cutoff, order.lastProcessedQd);
    for (const stage of order.stages) for (const run of stage.runs) {
      if (!stage.receipts.some(receipt => receipt.runId === run.id && receipt.status === "arrived")) cutoff = Math.min(cutoff, run.startQd);
    }
  }
  state.runs = state.runs.filter(run => {
    if (run.status !== "arrived" || run.releaseQd > cutoff || run.incident?.status === "pending") return true;
    return !run.claims.length || run.claims.some(claim => {
      const order = orders.get(JSON.stringify([claim.holdingId, claim.orderId]));
      return !order || activeTransportOrder(order) || order.fundingNeededCopper > 0
        || (order.ownShipId && (!order.shipReleased || !order.shipCostsReconciled));
    });
  });
}

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
  const epoch = transportEpochQd(data);
  if (epoch !== null) data.meta.transportV2.calendarEpochQd = epoch;
  return data.meta.transportV2;
}
