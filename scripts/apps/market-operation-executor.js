import { appendHoldingOperation } from "../data/operations.js";
import { economyV2RuntimeStatus } from "../data/economy-v2-activation.js";
import { formatCopperCurrencyCompact as formatCopperCurrency } from "../core/currency.js";
import { applyMarketDelivery } from "../engines/market/delivery.js";
import { createMarketShipment, cancelMarketShipment, marketShipmentCancellationQuote, retainMarketShipmentOrders } from "../engines/market/shipment.js";
import { prepareMarketExport, dispatchMarketExport, retainMarketExportOrders } from "../engines/market/export.js";
import { createMarketExportLiquidityDemandAdapter } from "../engines/market/export-liquidity-adapter.js";
import { assignFleetMarketDelivery, cancelFleetMarketDelivery } from "../engines/fleet/enterprise.js";

async function resolveItemDocuments(lines = [], resolveUuid) {
  const documents = new Map();
  for (const line of lines) {
    if (line?.sourceType !== "item") continue;
    const uuid = String(line?.itemUuid ?? "").trim();
    const document = uuid && typeof resolveUuid === "function" ? await resolveUuid(uuid) : null;
    const documentName = document?.documentName ?? document?.constructor?.documentName;
    if (!document || documentName !== "Item") return { ok: false, message: `Item не найден: ${uuid}.` };
    documents.set(line.id, document);
  }
  return { ok: true, documents };
}

function dependenciesFor(logic) {
  return {
    addMoney: (holding, amount) => logic._addMoney(holding, amount),
    storageAddWithOverflow: (holding, resource, qty) => logic._storageAddWithOverflow(holding, resource, qty),
    snapshotItemForStorage: (item, qty, roomId) => logic._snapshotItemForStorage(item, qty, roomId),
    appendStorageLog: (holding, entries) => logic._appendStorageLog(holding, entries),
    formatCurrency: (amount) => formatCopperCurrency(amount)
  };
}

function ensureMarketState(holding) {
  if (!holding.special || typeof holding.special !== "object") holding.special = { notes: "", list: [] };
  if (!holding.special.market || typeof holding.special.market !== "object") holding.special.market = { orders: [] };
  if (!Array.isArray(holding.special.market.orders)) holding.special.market.orders = [];
  return holding.special.market;
}

export async function applyMarketOperation({ operation, holding, data, requester, logic, resolveUuid, now = () => new Date().toISOString() } = {}) {
  if (operation.type === "marketCancelShipment") {
    const order = holding?.special?.market?.orders?.find?.((row) => [row?.id, row?.operationId].some((value) => String(value ?? "") === operation.orderId));
    const quote = marketShipmentCancellationQuote(order);
    if (!quote.cancellable) return { ok: false, message: quote.reason || "Эту поставку уже нельзя отменить." };
    const cancelledAt = now();
    if (order?.ownedVesselId) {
      const released = cancelFleetMarketDelivery(holding, { vesselId: order.ownedVesselId, orderId: order.id, operationId: `${operation.operationId}:fleet`, cancelledAt });
      if (!released.ok) return { ok: false, message: released.message };
    }
    if (!order.cancellationOperationId) order.cancellationOperationId = operation.operationId;
    const cancelled = cancelMarketShipment({ holding, orderId: operation.orderId, cancelledAt, dependencies: dependenciesFor(logic) });
    if (!cancelled.ok) return { ok: false, message: cancelled.message };
    if (!cancelled.replay) appendHoldingOperation(holding, {
      operationId: operation.operationId,
      type: "market-purchase",
      createdAt: cancelledAt,
      title: `Отменена поставка: ${cancelled.order.marketLabel}`,
      summary: `Возврат ${formatCopperCurrency(cancelled.refundCopper)} · удержано ${formatCopperCurrency(cancelled.withheldCopper)}.`,
      payload: { orderId: operation.orderId, refundCopper: cancelled.refundCopper, withheldCopper: cancelled.withheldCopper }
    });
    return { ok: true, replay: cancelled.replay, operationId: operation.operationId, refundCopper: cancelled.refundCopper };
  }

  const { createHeadlessMarketAdapter } = await import("./market-app.js");
  const adapter = createHeadlessMarketAdapter({ holdingId: operation.holdingId, ...operation });
  const snapshot = adapter._marketSnapshot({ isGM: requester?.isGM === true, data });
  const runtime = economyV2RuntimeStatus(data);
  if (!runtime.ready) return { ok: false, economyInactive: true, message: runtime.message };
  if (!snapshot.holding || snapshot.marketIntegrity?.ready === false) {
    return { ok: false, message: snapshot.marketIntegrity?.issues?.[0]?.message ?? "Рынок недоступен или нарушает контракт Market V2." };
  }
  if (operation.expectedSourceHash && snapshot.sourceHash !== operation.expectedSourceHash) {
    return { ok: false, stale: true, message: "Данные поселения или котировки изменились. Открой рынок заново." };
  }

  if (operation.type === "marketPurchase") {
    const plan = snapshot.plan;
    if (!plan?.ok || plan.empty || plan.marketId !== operation.marketId || plan.quoteKey !== operation.expectedQuoteKey || plan.totalCopper !== operation.expectedTotalCopper) {
      return { ok: false, stale: true, message: "Корзина, цена, маршрут или доступная вместимость изменились." };
    }
    const resolved = await resolveItemDocuments(plan.lines, resolveUuid);
    if (!resolved.ok) return resolved;
    const createdAt = now();
    const deps = dependenciesFor(logic);
    const delivery = plan.deliveryMode === "scheduled"
      ? createMarketShipment({ holding, plan, itemDocuments: resolved.documents, operationId: operation.operationId, createdAt, dependencies: deps })
      : applyMarketDelivery({ holding, plan, itemDocuments: resolved.documents, operationId: operation.operationId, dependencies: deps });
    if (!delivery.ok) return { ok: false, stale: true, message: delivery.message || "Не удалось применить рыночную поставку." };
    if (delivery.replay) return { ok: true, replay: true, duplicate: true, operationId: operation.operationId, totalCopper: plan.totalCopper };
    if (plan.ownedVesselDelivery) {
      const assigned = assignFleetMarketDelivery(holding, {
        vesselId: plan.ownedVesselId,
        plan,
        orderIds: (delivery.orders ?? [delivery.order]).map((order) => order?.id).filter(Boolean),
        departureQd: Math.max(0, Number(holding?.gm?.calendaria?.lastQd) || 0),
        operationId: operation.operationId,
        acceptedAt: createdAt
      });
      if (!assigned.ok) return { ok: false, stale: true, message: assigned.message };
    }
    const marketState = ensureMarketState(holding);
    marketState.preferredRoomId = plan.targetRoomId;
    if (plan.deliveryMode !== "scheduled") marketState.orders.push({
      id: operation.operationId,
      operationId: operation.operationId,
      createdAt,
      orderedAt: createdAt,
      deliveredAt: createdAt,
      status: "delivered",
      dispatchStatus: "delivered",
      deliveryMode: "instant",
      deliveryQd: 0,
      serviceLevel: "standard",
      etaQd: 0,
      remainingQd: 0,
      marketId: plan.marketId,
      marketLabel: plan.marketLabel,
      quoteKey: plan.quoteKey,
      locationId: plan.locationId,
      targetRoomId: plan.targetRoomId,
      totalCopper: plan.totalCopper,
      lines: plan.lines.map((line) => ({ offerId: line.id, resourceId: line.resourceId, itemUuid: line.itemUuid, name: line.name, qty: line.qty, unitPriceCopper: line.unitPriceCopper }))
    });
    marketState.orders = retainMarketShipmentOrders(marketState.orders);
    appendHoldingOperation(holding, {
      operationId: operation.operationId,
      type: "market-purchase",
      createdAt,
      title: `Покупка: ${plan.marketLabel}`,
      summary: `${plan.lines.length} позиций · товары ${formatCopperCurrency(plan.subtotalCopper)} · доставка ${formatCopperCurrency(plan.deliveryCopper)}.`,
      payload: { marketId: plan.marketId, quoteKey: plan.quoteKey, totalCopper: plan.totalCopper, deliveryMode: plan.deliveryMode, deliveryQd: plan.deliveryQd, serviceLevel: plan.serviceLevel }
    });
    return { ok: true, operationId: operation.operationId, totalCopper: plan.totalCopper, scheduled: plan.deliveryMode === "scheduled", firstDeliveryQd: plan.firstDeliveryQd, deliveryQd: plan.deliveryQd, serviceLevel: plan.serviceLevel, batchCount: plan.batchCount };
  }

  if (operation.type === "marketExport") {
    const plan = snapshot.exportPlan;
    const fingerprint = adapter._exportPlanFingerprint(plan);
    if (!plan?.ready || operation.exportQuantity <= 0 || fingerprint !== operation.expectedFingerprint) {
      return { ok: false, stale: true, message: "Запас, спрос, маршрут или стоимость отправки изменились." };
    }
    const marketState = ensureMarketState(holding);
    if (!marketState.liquidity || typeof marketState.liquidity !== "object") marketState.liquidity = { schemaVersion: 1, lines: [], reservations: [], receipts: [] };
    if (!marketState.exportBook || typeof marketState.exportBook !== "object") marketState.exportBook = { version: 1, orders: [], advanceRuns: [] };
    if (!Array.isArray(marketState.exportBook.orders)) marketState.exportBook.orders = [];
    if (!Array.isArray(marketState.exportBook.advanceRuns)) marketState.exportBook.advanceRuns = [];
    const createdAt = now();
    const demand = createMarketExportLiquidityDemandAdapter(marketState.liquidity);
    const prepared = prepareMarketExport({ holding, book: marketState.exportBook, quote: plan.prepare.quote, cargo: plan.prepare.cargo, operationId: `${operation.operationId}:prepare`, preparedAt: createdAt, dependencies: { demand } });
    if (!prepared.ok) return { ok: false, stale: true, message: prepared.message };
    const dispatched = dispatchMarketExport({ holding, book: marketState.exportBook, orderId: prepared.order.id, operationId: `${operation.operationId}:dispatch`, dispatchedAt: createdAt });
    if (!dispatched.ok) return { ok: false, stale: true, message: dispatched.message };
    if (!dispatched.replay) logic._appendStorageLog(holding, (dispatched.order?.sources ?? []).map((source) => ({
      kind: "market-export-dispatch",
      resourceId: plan.resourceId,
      name: String(snapshot.sellQuote?.offers?.find?.((row) => String(row?.id ?? "") === String(plan.offerId ?? ""))?.name ?? plan.resourceId ?? "Товар"),
      qty: -Math.max(0, Number(source.qty) || 0),
      roomId: String(source?.roomId ?? source?.storageRoomId ?? ""),
      source: String(snapshot.sellQuote?.marketLabel ?? "Внешний рынок"),
      note: `Отправлено на продажу; выручка после прибытия, ETA ${plan.eta.qd} QD`,
      operationId: `${operation.operationId}:dispatch`,
      orderId: prepared.order.id
    })));
    marketState.exportBook.orders = retainMarketExportOrders(marketState.exportBook.orders);
    appendHoldingOperation(holding, {
      operationId: operation.operationId,
      type: "market-export",
      createdAt,
      title: `Экспорт: ${plan.resourceId}`,
      summary: `${plan.totalQty} ед. отправлено · расходы ${formatCopperCurrency(plan.dispatchCash.requiredCopper)} · ETA ${plan.eta.qd} QD.`,
      payload: { orderId: prepared.order.id, marketId: plan.exportQuote.market.id, offerId: plan.offerId, resourceId: plan.resourceId, qty: plan.totalQty, upfrontCostsCopper: plan.dispatchCash.requiredCopper, etaQd: plan.eta.qd }
    });
    return { ok: true, operationId: operation.operationId, orderId: prepared.order.id, qty: plan.totalQty, upfrontCostsCopper: plan.dispatchCash.requiredCopper, etaQd: plan.eta.qd };
  }

  return { ok: false, message: "Неизвестная операция внешнего рынка." };
}
