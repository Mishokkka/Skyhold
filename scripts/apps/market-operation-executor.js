import { COMMAND_ERROR } from "../data/command-result.js";
import { findHoldingOperation, appendHoldingOperation } from "../data/operations.js";
import { internalDemandBatchClockQd } from "../core/resource-batches.js";
import { retainMarketShipmentOrders, createMarketShipment } from "../engines/market/shipment.js";
import { applyMarketDelivery } from "../engines/market/delivery.js";
import { reserveMarketStock } from "../engines/market/stock.js";
import { resolveFoundryUuid } from "../integrations/foundry-runtime.js";
import { createMarketOutboundShipment, dispatchMarketOutboundShipment } from "../workflows/market/outbound-shipment.js";
import { departWorldShip, advanceWorldShips } from "../engines/ships/world-voyage.js";
import { embarkShipCrew } from "../engines/ships/crew.js";
import { getSkyholdWorkflowService } from "../workflows/skyhold-workflow-service.js";
import { SkyholdData } from "../data/store.js";
import {
  marketAuthoritySourceToken,
  marketPurchasePlanToken,
  prepareMarketAuthorityContext
} from "./market/authority-context.js";

const MARKET_OPERATION_TYPES = new Set(["purchase", "outbound"]);
const MARKET_SERVICE_LEVELS = new Set(["standard", "express", "charter"]);
const MARKET_UUID_RESOLVE_CONCURRENCY = 4;

function marketOperationError(message, code = COMMAND_ERROR.EXECUTION_FAILED, extra = {}) {
  const error = new Error(`FBL Skyhold | ${message}`);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function normalizedQuantities(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(source)
    .slice(0, 1_000)
    .map(([key, qty]) => [String(key ?? "").trim().slice(0, 300), Math.max(0, Math.min(1_000_000, Math.floor(Number(qty) || 0)))])
    .filter(([key, qty]) => key && qty > 0));
}

function normalizeMarketOperation(raw = {}) {
  const type = String(raw?.type ?? "").trim();
  if (!MARKET_OPERATION_TYPES.has(type)) throw marketOperationError("Unknown market operation.", COMMAND_ERROR.INVALID);
  const operationId = String(raw?.operationId ?? "").trim();
  const holdingId = String(raw?.holdingId ?? "").trim();
  const expectedRevision = Number(raw?.expectedRevision);
  const sourceToken = String(raw?.sourceToken ?? "").trim();
  const planToken = String(raw?.planToken ?? "");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) {
    throw marketOperationError("Market operation id is missing or invalid.", COMMAND_ERROR.INVALID);
  }
  if (!holdingId) throw marketOperationError("Market operation holding id is missing.", COMMAND_ERROR.INVALID);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw marketOperationError("Market operation expected revision is missing or invalid.", COMMAND_ERROR.INVALID);
  }
  if (!sourceToken || sourceToken.length > 200) {
    throw marketOperationError("Market operation source token is missing or invalid.", COMMAND_ERROR.INVALID);
  }
  if (!planToken || planToken.length > 100_000) {
    throw marketOperationError("Market operation plan token is missing or invalid.", COMMAND_ERROR.INVALID);
  }
  return {
    type,
    operationId,
    holdingId,
    expectedRevision,
    sourceToken,
    planToken,
    marketId: String(raw?.marketId ?? "").trim().slice(0, 300),
    carrierId: String(raw?.carrierId ?? "").trim().slice(0, 300),
    ownShipId: type === "outbound" ? String(raw?.ownShipId ?? "").trim().slice(0, 128) : "",
    targetRoomId: String(raw?.targetRoomId ?? "outdoors").trim().slice(0, 300) || "outdoors",
    serviceLevel: MARKET_SERVICE_LEVELS.has(String(raw?.serviceLevel ?? "")) ? String(raw.serviceLevel) : "standard",
    quantities: normalizedQuantities(raw?.quantities),
    insuranceEnabled: raw?.insuranceEnabled !== false
  };
}

function getUserById(userId) {
  return globalThis.game?.users?.get?.(userId)
    ?? (Array.isArray(globalThis.game?.users?.contents)
      ? globalThis.game.users.contents.find((user) => String(user?.id ?? "") === String(userId ?? ""))
      : null);
}

function holdingAllowsMarketOperation(holding, user) {
  if (!holding || !user) return false;
  if (user.isGM) return true;
  return holding.visibility !== "gm" && holding?.gm?.playersCanUseStorage === true;
}

function operationLogType(type) {
  return type === "outbound" ? "market-outbound" : "market-purchase";
}

function replayResult(holding, operation, userId) {
  const existing = findHoldingOperation(holding, operation.operationId);
  if (!existing) return null;
  if (existing.type !== operationLogType(operation.type)) {
    throw marketOperationError("Market operation id is already used by another operation.", COMMAND_ERROR.INVALID);
  }
  const payload = existing.payload && typeof existing.payload === "object" ? existing.payload : {};
  const order = operation.type === "outbound"
    ? (holding.special?.market?.outbound?.orders ?? []).find((row) => row.operationId === operation.operationId || row.parentOperationId === operation.operationId)
    : null;
  if (order && String(order.ownShipId ?? "") !== operation.ownShipId) {
    throw marketOperationError("Market operation id is already used by another carrier.", COMMAND_ERROR.INVALID);
  }
  if (payload.signature !== JSON.stringify(operation) || payload.userId !== String(userId)) {
    throw marketOperationError("Market operation id is already used by another or unverifiable operation.", COMMAND_ERROR.CONFLICT);
  }
  return {
    ok: true,
    replay: true,
    duplicate: true,
    operationId: operation.operationId,
    ...payload
  };
}

export async function resolveMarketItemDocuments(lines = [], resolveUuid = resolveFoundryUuid) {
  const itemLines = lines.filter((line) => line.sourceType === "item");
  const uuids = [];
  const seenUuids = new Set();
  for (const line of itemLines) {
    const uuid = String(line.itemUuid ?? "").trim();
    if (!uuid) throw marketOperationError(`Item UUID is missing for ${line.name || line.id}.`, COMMAND_ERROR.INVALID);
    if (!seenUuids.has(uuid)) {
      seenUuids.add(uuid);
      uuids.push(uuid);
    }
  }

  const resolvedByUuid = new Map();
  let cursor = 0;
  const workerCount = Math.min(MARKET_UUID_RESOLVE_CONCURRENCY, uuids.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < uuids.length) {
      const uuid = uuids[cursor++];
      let document = null;
      try {
        document = await resolveUuid(uuid);
      } catch (_error) {}
      resolvedByUuid.set(uuid, document);
    }
  }));

  const documents = new Map();
  for (const line of itemLines) {
    const uuid = String(line.itemUuid ?? "").trim();
    const document = resolvedByUuid.get(uuid) ?? null;
    const documentName = document?.documentName ?? document?.constructor?.documentName;
    if (!document || documentName !== "Item") {
      throw marketOperationError(`Market Item was not found: ${uuid}.`, COMMAND_ERROR.CONFLICT, { stale: true });
    }
    documents.set(line.id, document);
  }
  return documents;
}

function marketDependencies(workflow) {
  return {
    addMoney: (target, amount) => workflow._addMoney(target, amount),
    storageAddWithOverflow: (target, resource, qty) => workflow._storageAddWithOverflow(target, resource, qty),
    snapshotItemForStorage: (item, qty, roomId) => workflow._snapshotItemForStorage(item, qty, roomId),
    appendStorageLog: (target, entries) => workflow._appendStorageLog(target, entries),
    formatCurrency: (amount) => String(amount),
    internalDemandAvailableFromQd: (target) => internalDemandBatchClockQd(target)
  };
}

function appendInstantPurchaseOrder(holding, plan, itemDocuments, operationId, createdAt) {
  if (!holding.special || typeof holding.special !== "object") holding.special = { notes: "", list: [] };
  if (!holding.special.market || typeof holding.special.market !== "object") holding.special.market = { orders: [] };
  if (!Array.isArray(holding.special.market.orders)) holding.special.market.orders = [];
  holding.special.market.orders.push({
    id: operationId,
    operationId,
    createdAt,
    orderedAt: createdAt,
    deliveredAt: createdAt,
    status: "delivered",
    dispatchStatus: "delivered",
    dispatchedAt: createdAt,
    deliveryMode: "instant",
    deliveryQd: 0,
    standardDeliveryQd: 0,
    serviceLevel: "standard",
    etaQd: 0,
    remainingQd: 0,
    stockReservationOperationId: operationId,
    stockRestorationOperationId: "",
    stockRestoredAt: "",
    stockReservations: plan.stockReservations,
    marketId: plan.marketId,
    marketLabel: plan.marketLabel,
    quoteKey: plan.quoteKey,
    locationId: plan.locationId,
    locationText: plan.locationText,
    targetRoomId: plan.targetRoomId,
    originRegionId: String(plan.logistics?.originRegionId ?? ""),
    destinationRegionId: String(plan.logistics?.destinationRegionId ?? ""),
    routeDistance: Math.max(0, Number(plan.logistics?.distance) || 0),
    routeDistanceKm: Math.max(0, Number(plan.logistics?.distanceKm) || 0),
    routeHops: Math.max(0, Number(plan.logistics?.hops) || 0),
    routePath: Array.isArray(plan.logistics?.routePath) ? [...plan.logistics.routePath] : [],
    transportMode: String(plan.logistics?.transportMode ?? ""),
    carrierId: plan.carrierId,
    carrierLabel: plan.carrierLabel,
    carrierCapacityFactor: Math.max(0.1, Number(plan.logistics?.carrierCapacityFactor) || 1),
    carrierCapacityLoad: Math.max(0, Number(plan.capacityLoad) || 0),
    totalLoad: Math.max(0, Number(plan.totalLoad) || 0),
    merchantProviderIds: [...plan.merchantProviderIds],
    accessLevel: Math.max(0, Number(plan.logistics?.accessLevel) || 0),
    requiredAccessLevel: Math.max(0, Number(plan.logistics?.requiredAccessLevel) || 0),
    routeCopper: plan.routeCopper,
    taxCopper: plan.taxCopper,
    handlingCopper: plan.handlingCopper,
    expressSurchargeCopper: 0,
    insuranceCopper: plan.insuranceCopper,
    subtotalCopper: plan.subtotalCopper,
    deliveryCopper: plan.deliveryCopper,
    totalCopper: plan.totalCopper,
    lines: plan.lines.map((line) => ({
      offerId: line.id,
      stockOfferId: String(line.stockOfferId ?? line.sourceOfferId ?? line.id ?? ""),
      sourceType: line.sourceType,
      resourceId: line.resourceId,
      itemUuid: String(line.itemUuid ?? ""),
      name: line.sourceType === "item" ? String(itemDocuments.get(line.id)?.name ?? line.name) : line.name,
      providerId: String(line.providerId ?? ""),
      providerLabel: String(line.providerLabel ?? ""),
      qty: line.qty,
      unitPriceCopper: line.unitPriceCopper
    }))
  });
  holding.special.market.orders = retainMarketShipmentOrders(holding.special.market.orders);
}

async function applyPurchase({ holding, operation, context, workflow, resolveUuid, createdAt }) {
  const plan = context.plan;
  if (!plan?.ok || marketPurchasePlanToken(plan) !== operation.planToken) {
    throw marketOperationError("Market purchase preview is stale.", COMMAND_ERROR.CONFLICT, { stale: true });
  }
  const itemDocuments = await resolveMarketItemDocuments(plan.lines, resolveUuid);
  const reservation = reserveMarketStock({
    holding,
    marketId: plan.marketId,
    lines: plan.lines,
    operationId: operation.operationId,
    updatedAt: createdAt
  });
  if (!reservation.ok) {
    throw marketOperationError("Market stock changed after preview.", COMMAND_ERROR.CONFLICT, { stale: true });
  }
  plan.stockReservationOperationId = operation.operationId;
  plan.stockReservations = reservation.reservations;
  const dependencies = marketDependencies(workflow);
  const delivery = plan.deliveryMode === "scheduled"
    ? createMarketShipment({ holding, plan, itemDocuments, operationId: operation.operationId, createdAt, dependencies })
    : applyMarketDelivery({ holding, plan, itemDocuments, operationId: operation.operationId, dependencies });
  if (!delivery.ok) {
    throw marketOperationError(delivery.message || "Market delivery could not be created.", COMMAND_ERROR.CONFLICT, { stale: true });
  }
  if (!holding.special || typeof holding.special !== "object") holding.special = { notes: "", list: [] };
  if (!holding.special.market || typeof holding.special.market !== "object") holding.special.market = { orders: [] };
  holding.special.market.preferredRoomId = plan.targetRoomId;
  if (plan.deliveryMode !== "scheduled") {
    appendInstantPurchaseOrder(holding, plan, itemDocuments, operation.operationId, createdAt);
  }
  appendHoldingOperation(holding, {
    operationId: operation.operationId,
    type: "market-purchase",
    createdAt,
    title: `Покупка: ${plan.marketLabel}`,
    summary: `${plan.lines.length} позиций; всего ${plan.totalCopper} мед.`,
    payload: {
      marketId: plan.marketId,
      quoteKey: plan.quoteKey,
      totalCopper: plan.totalCopper,
      scheduled: plan.deliveryMode === "scheduled",
      firstDeliveryQd: plan.firstDeliveryQd,
      deliveryQd: plan.deliveryQd,
      serviceLevel: plan.serviceLevel,
      batchCount: plan.batchCount
    }
  });
  return {
    ok: true,
    replay: false,
    operationId: operation.operationId,
    totalCopper: plan.totalCopper,
    scheduled: plan.deliveryMode === "scheduled",
    firstDeliveryQd: plan.firstDeliveryQd,
    deliveryQd: plan.deliveryQd,
    serviceLevel: plan.serviceLevel,
    batchCount: plan.batchCount
  };
}

function applyOutbound({ holding, operation, context, workflow, createdAt }) {
  const plan = context.outbound?.plan;
  if (!plan?.ok || String(plan.planToken ?? "") !== operation.planToken) {
    throw marketOperationError("Market outbound preview is stale.", COMMAND_ERROR.CONFLICT, { stale: true });
  }
  const ownShip = operation.ownShipId
    ? holding.special?.ships?.list?.find((row) => row.id === operation.ownShipId) : null;
  if (operation.ownShipId && (!ownShip || plan.route?.ownShipId !== ownShip.id || !context.outbound?.ownShip?.voyageOffer)) {
    throw marketOperationError("Own ship sale quote changed.", COMMAND_ERROR.CONFLICT, { stale: true });
  }
  const booked = createMarketOutboundShipment({
    holding,
    plan,
    operationId: operation.operationId,
    createdAt,
    dependencies: marketDependencies(workflow)
  });
  if (!booked.ok) {
    const code = booked.capacityExceeded ? COMMAND_ERROR.CONFLICT : (booked.stale ? COMMAND_ERROR.CONFLICT : COMMAND_ERROR.INVALID);
    throw marketOperationError(booked.message || "Outbound shipment could not be booked.", code, booked);
  }
  if (ownShip && !booked.replay) {
    const departure = departWorldShip(holding, ownShip, {
      operationId: operation.operationId, offer: context.outbound.ownShip.voyageOffer,
      clockQd: holding.gm?.calendaria?.lastQd ?? 0
    });
    if (!departure.ok) throw marketOperationError("Недостаточно денег для рейса собственного корабля.", COMMAND_ERROR.INVALID);
    embarkShipCrew(holding, ownShip, holding.gm?.calendaria?.lastQd ?? 0);
    booked.order.ownShipId = ownShip.id;
    const dispatched = dispatchMarketOutboundShipment({
      holding, orderId: booked.order.id, dispatchedAt: createdAt,
      dependencies: marketDependencies(workflow)
    });
    if (!dispatched.ok) throw marketOperationError(dispatched.message || "Складской товар изменился до отправки.", COMMAND_ERROR.CONFLICT);
  }
  if (!booked.replay) {
    appendHoldingOperation(holding, {
      operationId: operation.operationId,
      type: "market-outbound",
      createdAt,
      title: `Исходящая продажа: ${plan.marketLabel}`,
      summary: `${ownShip ? `Отправлен ${ownShip.name}` : "Забронировано"} ${plan.lines.reduce((sum, line) => sum + line.qty, 0)} ед.; рыночные расходы ${plan.upfrontCopper} мед.; выручка ${plan.revenueCopper} мед.`,
      payload: {
        marketId: plan.marketId,
        routeId: plan.route?.id,
        upfrontCopper: plan.upfrontCopper,
        revenueCopper: plan.revenueCopper,
        deliveryQd: plan.deliveryQd,
        batchCount: booked.batchCount ?? 1
      }
    });
  }
  return {
    ok: true,
    replay: booked.replay,
    operationId: operation.operationId,
    upfrontCopper: plan.upfrontCopper,
    revenueCopper: plan.revenueCopper,
    deliveryQd: plan.deliveryQd,
    batchCount: booked.batchCount ?? 1,
    ownShipId: ownShip?.id ?? ""
  };
}

export function createMarketOperationExecutor({
  updateHolding = (holdingId, updater, options) => SkyholdData.updateHolding(holdingId, updater, options),
  skipTransaction = (value) => SkyholdData.skipTransaction(value),
  getUser = getUserById,
  resolveUuid = resolveFoundryUuid,
  getWorkflow = () => getSkyholdWorkflowService(),
  prepareContext = prepareMarketAuthorityContext,
  sourceTokenFor = marketAuthoritySourceToken,
  now = () => new Date().toISOString()
} = {}) {
  const operationResults = new Map();

  async function executeOnce(rawOperation, { userId = "", remote = false } = {}) {
    const operation = normalizeMarketOperation(rawOperation);
    const requester = getUser(userId);
    if (!requester) throw marketOperationError("Market operation requester was not found.", COMMAND_ERROR.FORBIDDEN);
    if (remote && requester.isGM) {
      throw marketOperationError("Remote market operations cannot claim GM authority.", COMMAND_ERROR.FORBIDDEN);
    }
    const result = await updateHolding(operation.holdingId, async (holding, data) => {
      if (!holdingAllowsMarketOperation(holding, requester)) {
        throw marketOperationError("No permission for market operations on this holding.", COMMAND_ERROR.FORBIDDEN);
      }
      if (operation.ownShipId && !requester.isGM && holding.gm?.playersCanManageShips !== true) {
        throw marketOperationError("No permission to send the settlement ship.", COMMAND_ERROR.FORBIDDEN);
      }
      const replay = replayResult(holding, operation, userId);
      if (replay) return skipTransaction(replay);
      const currentRevision = Math.max(0, Math.floor(Number(data?.meta?.revision) || 0));
      if (operation.expectedRevision !== currentRevision) {
        throw marketOperationError("Market data changed after preview.", COMMAND_ERROR.CONFLICT, {
          stale: true,
          revision: currentRevision
        });
      }
      const currentSourceToken = sourceTokenFor({
        data,
        holding,
        marketId: operation.marketId,
        carrierId: operation.carrierId
      });
      if (operation.sourceToken !== currentSourceToken) {
        throw marketOperationError("Market quote source changed after preview.", COMMAND_ERROR.CONFLICT, {
          stale: true,
          revision: currentRevision
        });
      }
      if (operation.ownShipId) {
        const ship = holding.special?.ships?.list?.find((row) => row.id === operation.ownShipId);
        if (!ship) throw marketOperationError("Own ship is unavailable.", COMMAND_ERROR.CONFLICT);
        const catchUp = advanceWorldShips(holding, holding.gm?.calendaria?.lastQd ?? 0, { shipId: ship.id });
        if (catchUp.blocked.length) throw marketOperationError(catchUp.blocked[0].message, COMMAND_ERROR.CONFLICT);
      }
      const context = prepareContext({
        data,
        holding,
        marketId: operation.marketId,
        carrierId: operation.carrierId,
        quantities: operation.type === "purchase" ? operation.quantities : {},
        targetRoomId: operation.targetRoomId,
        serviceLevel: operation.serviceLevel,
        outboundQuantities: operation.type === "outbound" ? operation.quantities : {},
        outboundInsuranceEnabled: operation.insuranceEnabled,
        ownShipId: operation.ownShipId,
        isGM: Boolean(requester.isGM)
      });
      if (!context.market) {
        throw marketOperationError("Requested market is unavailable.", COMMAND_ERROR.FORBIDDEN);
      }
      const workflow = getWorkflow();
      const createdAt = now();
      const response = await (operation.type === "outbound"
        ? applyOutbound({ holding, operation, context, workflow, createdAt })
        : applyPurchase({ holding, operation, context, workflow, resolveUuid, createdAt }));
      const receipt = findHoldingOperation(holding, operation.operationId);
      if (!receipt) throw marketOperationError("Market operation receipt is missing.");
      Object.assign(receipt.payload, { signature: JSON.stringify(operation), userId: String(userId) });
      return response;
    }, { fallback: false, reason: `market-operation:${operation.type}` });
    if (!result) throw marketOperationError("Market operation holding was not found.", COMMAND_ERROR.INVALID);
    return result;
  }

  return async function executeMarketOperation(rawOperation, context = {}) {
    const operation = normalizeMarketOperation(rawOperation);
    const key = operation.operationId;
    const signature = JSON.stringify([String(context.userId ?? ""), Boolean(context.remote), operation]);
    if (operationResults.has(key)) {
      const cached = operationResults.get(key);
      if (cached.signature !== signature) {
        throw marketOperationError("Market operation id is already used by another target.", COMMAND_ERROR.INVALID);
      }
      const prior = await cached.promise;
      return { ...prior, replay: true, duplicate: true };
    }
    const pending = executeOnce(operation, context);
    operationResults.set(key, { signature, promise: pending });
    if (operationResults.size > 500) operationResults.delete(operationResults.keys().next().value);
    try {
      return await pending;
    } catch (error) {
      operationResults.delete(key);
      throw error;
    }
  };
}

export const executeMarketOperation = createMarketOperationExecutor();
