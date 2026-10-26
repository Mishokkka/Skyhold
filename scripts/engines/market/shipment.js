import { ageMarketCargo, cargoDeliveryQuantity, cargoShelfLife, marketLossInsurancePayoutCopper, marketInsurancePayoutCopper, viableCargoValueCopper } from "./cargo-aging.js";
import { marketShipmentSchedule } from "./shipment-schedule.js";
import { marketPurchasePaymentEntry } from "./purchase-payment.js";
import { marketTransportPlanForOrder } from "../../data/market/transport-plan.js";

function requireFunctions(dependencies = {}, names = []) {
  for (const name of names) {
    if (typeof dependencies[name] !== "function") throw new TypeError(`market shipment requires dependencies.${name}`);
  }
  return dependencies;
}

function cloneSerializable(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function bounded(value, fallback, min, max) {
  const parsed = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
}

function shipmentRiskSeed({ id = "", createdAt = "", plan = {} } = {}) {
  return [
    "shipment-risk-v2",
    String(id),
    String(createdAt),
    String(plan.quoteKey ?? ""),
    String(plan.marketId ?? "external-market"),
    String(plan.batchIndex ?? 0),
    String(plan.originRegionId ?? plan.logistics?.originRegionId ?? ""),
    String(plan.destinationRegionId ?? plan.logistics?.destinationRegionId ?? "")
  ].join("|");
}

export function retainMarketShipmentOrders(orders = [], archiveLimit = 300) {
  const rows = Array.isArray(orders) ? orders : [];
  const terminalStatuses = new Set(["delivered", "lost", "cancelled"]);
  const limit = Math.max(0, Math.floor(Number(archiveLimit) || 0));
  const archived = rows.filter((order) => terminalStatuses.has(String(order?.status ?? "")));
  const retainedArchive = new Set(limit > 0 ? archived.slice(-limit) : []);
  return rows.filter((order) => !terminalStatuses.has(String(order?.status ?? "")) || retainedArchive.has(order));
}

export function deterministicMarketShipmentUnit(seed = "") {
  let value = 2166136261;
  for (const char of String(seed ?? "")) {
    value ^= char.codePointAt(0);
    value = Math.imul(value, 16777619);
  }
  value >>>= 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) / 4294967295;
}

function marketOrderLines(plan = {}, itemDocuments = new Map()) {
  return (plan.lines ?? []).map((line) => ({
    offerId: String(line.id ?? ""),
    stockOfferId: String(line.stockOfferId ?? line.sourceOfferId ?? line.id ?? ""),
    sourceType: line.sourceType === "item" ? "item" : "resource",
    resourceId: String(line.resourceId ?? "custom"),
    itemUuid: String(line.itemUuid ?? ""),
    providerId: String(line.providerId ?? ""),
    providerLabel: String(line.providerLabel ?? ""),
    name: line.sourceType === "item" ? String(itemDocuments.get(line.id)?.name ?? line.name ?? "Товар") : String(line.name ?? "Товар"),
    qty: Math.max(0, Number(line.qty) || 0),
    unitPriceCopper: Math.max(0, Number(line.unitPriceCopper) || 0)
  })).filter((line) => line.qty > 0);
}

function marketOrderStockReservations(plan = {}) {
  const reservationOperationId = String(plan.stockReservationOperationId ?? "").trim();
  if (!reservationOperationId) return [];
  const rows = new Map();
  for (const line of plan.lines ?? []) {
    const offerId = String(line.stockOfferId ?? line.sourceOfferId ?? line.id ?? "").trim();
    const qty = Math.max(0, Math.floor(Number(line.qty) || 0));
    if (!offerId || !qty) continue;
    const key = `${String(plan.marketId ?? "external-market")}::${offerId}`;
    const previous = rows.get(key);
    if (previous) previous.qty += qty;
    else rows.set(key, {
      marketId: String(plan.marketId ?? "external-market"),
      offerId,
      qty,
      baseStock: Math.max(0, Math.floor(Number(line.stockBaseStock) || 0)),
      reservationOperationId
    });
  }
  return [...rows.values()];
}

function prepareCargo(plan = {}, itemDocuments = new Map(), dependencies = {}) {
  const cargo = [];
  for (const line of plan.lines ?? []) {
    if (line.sourceType === "item") {
      const item = itemDocuments.get(line.id);
      if (!item) return { ok: false, missingItem: line.id, message: `Market Item is unavailable: ${line.itemUuid || line.id}.` };
      const snapshot = dependencies.snapshotItemForStorage(item, line.qty, plan.targetRoomId);
      snapshot.itemUuid = String(line.itemUuid || item.uuid || snapshot.itemUuid || "");
      if (line.configuredName) snapshot.name = line.configuredName;
      if (line.configuredImg) snapshot.img = line.configuredImg;
      cargo.push({
        offerId: String(line.id ?? ""),
        sourceType: "item",
        name: String(snapshot.name ?? line.name ?? "Предмет"),
        providerId: String(line.providerId ?? ""),
        providerLabel: String(line.providerLabel ?? ""),
        qty: Math.max(0, Number(line.qty) || 0),
        targetRoomId: String(plan.targetRoomId || "outdoors"),
        item: cloneSerializable(snapshot)
      });
      continue;
    }
    cargo.push({
      offerId: String(line.id ?? ""),
      sourceType: "resource",
      resourceId: String(line.resourceId ?? "custom"),
      name: String(line.name ?? "Ресурс"),
      providerId: String(line.providerId ?? ""),
      providerLabel: String(line.providerLabel ?? ""),
      unit: "ед.",
      ageQd: Math.max(0, Number(line.ageQd) || 0),
      shelfLifeQd: cargoShelfLife(line),
      unitPriceCopper: Math.max(0, Number(line.unitPriceCopper) || 0),
      img: String(line.img ?? ""),
      load: Math.max(0, Number(line.load) || 0),
      qty: Math.max(0, Number(line.qty) || 0),
      targetRoomId: String(plan.targetRoomId || "outdoors")
    });
  }
  return { ok: true, cargo };
}

function marketShipmentBatchPlans(plan = {}) {
  const source = Array.isArray(plan.shipmentBatches) && plan.shipmentBatches.length
    ? plan.shipmentBatches
    : [{
        lines: plan.lines ?? [],
        subtotalCopper: plan.subtotalCopper,
        deliveryCopper: plan.deliveryCopper,
        totalCopper: plan.totalCopper,
        totalLoad: plan.totalLoad,
        routeCopper: plan.routeCopper,
        taxCopper: plan.taxCopper,
        handlingCopper: plan.handlingCopper,
        expressSurchargeCopper: plan.expressSurchargeCopper,
        insuranceCopper: plan.insuranceCopper,
        deliveryQd: plan.deliveryQd,
        capacityShare: plan.deliveryBreakdown?.capacityShare,
        riskProfile: {
          riskFactor: plan.riskFactor,
          lossChance: plan.riskLossChance,
          delayChance: plan.riskDelayChance,
          maxDelayQd: plan.riskMaxDelayQd,
          insuranceCoverageRate: plan.insuranceCoverageRate,
          insuredValueCopper: plan.insuredValueCopper,
          maximumInsurancePayoutCopper: plan.maximumInsurancePayoutCopper
        }
      }];
  const single = source.length === 1;
  return source.map((batch, index) => {
    const risk = batch.riskProfile ?? {};
    const lines = Array.isArray(batch.lines) ? batch.lines : [];
    return {
      ...plan,
      ...(Object.hasOwn(batch, "transportLegCosts") ? { transportLegCosts: batch.transportLegCosts } : {}),
      lines,
      merchantProviderIds: [...new Set(lines.map((line) => String(line?.providerId ?? "")).filter(Boolean))],
      subtotalCopper: Math.max(0, Number(batch.subtotalCopper) || 0),
      deliveryCopper: Math.max(0, Number(batch.deliveryCopper) || 0),
      totalCopper: Math.max(0, Number(batch.totalCopper) || 0),
      totalLoad: Math.max(0, Number(batch.totalLoad) || 0),
      billableLoad: Math.max(0, Number(batch.billableLoad ?? batch.totalLoad) || 0),
      routeCopper: Math.max(0, Number(batch.routeCopper) || 0),
      taxCopper: Math.max(0, Number(batch.taxCopper) || 0),
      handlingCopper: Math.max(0, Number(batch.handlingCopper) || 0),
      expressSurchargeCopper: Math.max(0, Number(batch.expressSurchargeCopper) || 0),
      insuranceCopper: Math.max(0, Number(batch.insuranceCopper) || 0),
      deliveryQd: Math.max(1, Number(batch.deliveryQd) || Number(plan.deliveryQd) || 1),
      chargedCapacityShare: Math.max(0, Number(batch.capacityShare) || 0),
      riskFactor: bounded(single ? plan.riskFactor : risk.riskFactor, 1, 0.25, 4),
      riskLossChance: bounded(single ? plan.riskLossChance : risk.lossChance, 0, 0, 0.08),
      riskDelayChance: bounded(single ? plan.riskDelayChance : risk.delayChance, 0, 0, 0.45),
      riskMaxDelayQd: Math.max(1, Math.min(20, Math.ceil(Number(single ? plan.riskMaxDelayQd : risk.maxDelayQd) || 1))),
      insuranceCoverageRate: bounded(risk.insuranceCoverageRate ?? plan.insuranceCoverageRate, 0, 0, 1),
      insuredValueCopper: Math.max(0, Math.floor(Number(risk.insuredValueCopper ?? batch.subtotalCopper) || 0)),
      maximumInsurancePayoutCopper: Math.max(0, Math.floor(Number(risk.maximumInsurancePayoutCopper) || 0)),
      batchIndex: index,
      batchCount: source.length
    };
  });
}

function createShipmentOrder({ plan, prepared, id, parentOperationId, createdAt, itemDocuments }) {
  const deliveryQd = Math.max(1, Math.floor(Number(plan.deliveryQd) || 1));
  const riskPending = Number(plan.riskLossChance) > 0 || Number(plan.riskDelayChance) > 0;
  const riskSeed = shipmentRiskSeed({ id, createdAt, plan });
  const transportPlan = marketTransportPlanForOrder(plan.logistics?.transportPlan, {
    transportLegCosts: plan.transportLegCosts, batchCount: 1, freightCopper: plan.routeCopper,
    insuranceCopper: plan.insuranceCopper, taxCopper: plan.taxCopper, handlingCopper: plan.handlingCopper,
    expressSurchargeCopper: plan.expressSurchargeCopper, deliveryCopper: plan.deliveryCopper, serviceLevel: plan.serviceLevel
  });
  return {
    id,
    operationId: id,
    parentOperationId,
    batchIndex: Math.max(0, Number(plan.batchIndex) || 0),
    batchCount: Math.max(1, Number(plan.batchCount) || 1),
    createdAt: String(createdAt || ""),
    orderedAt: String(createdAt || ""),
    status: "in-transit",
    dispatchStatus: "booked",
    dispatchedAt: "",
    deliveryMode: "scheduled",
    deliveryQd,
    standardDeliveryQd: Math.max(1, Math.floor(Number(plan.standardDeliveryQd) || deliveryQd)),
    serviceLevel: ["standard", "express", "charter"].includes(String(plan.serviceLevel ?? "")) ? String(plan.serviceLevel) : "standard",
    etaQd: deliveryQd,
    remainingQd: deliveryQd,
    marketId: String(plan.marketId ?? "external-market"),
    marketLabel: String(plan.marketLabel ?? "Внешний рынок"),
    quoteKey: String(plan.quoteKey ?? ""),
    locationId: String(plan.locationId ?? "standard"),
    locationText: String(plan.locationText ?? ""),
    targetRoomId: String(plan.targetRoomId || "outdoors"),
    originRegionId: String(plan.logistics?.originRegionId ?? ""),
    destinationRegionId: String(plan.logistics?.destinationRegionId ?? ""),
    routeDistance: Math.max(0, Number(plan.logistics?.distance) || 0),
    routeDistanceKm: Math.max(0, Number(plan.logistics?.distanceKm) || 0),
    routeHops: Math.max(0, Number(plan.logistics?.hops) || 0),
    routePath: Array.isArray(plan.logistics?.routePath) ? [...plan.logistics.routePath] : [],
    ...(transportPlan ? { transportPlan } : {}),
    transportMode: String(plan.logistics?.transportMode ?? ""),
    carrierId: String(plan.carrierId ?? plan.logistics?.carrierId ?? ""),
    carrierLabel: String(plan.carrierLabel ?? plan.logistics?.carrierLabel ?? ""),
    carrierCapacityFactor: Math.max(0.1, Number(plan.logistics?.carrierCapacityFactor) || 1),
    carrierCapacityLoad: Math.max(0, Number(plan.physicalCapacityLoad ?? plan.capacityLoad) || 0),
    bookingCapacityLoad: Math.max(0, Number(plan.bookingCapacityLoad) || 0),
    chargedCapacityShare: Math.max(0, Number(plan.chargedCapacityShare) || 0),
    totalLoad: Math.max(0, Number(plan.totalLoad) || 0),
    billableLoad: Math.max(0, Number(plan.billableLoad ?? plan.totalLoad) || 0),
    merchantProviderIds: Array.isArray(plan.merchantProviderIds) ? [...plan.merchantProviderIds] : [],
    accessLevel: Math.max(0, Number(plan.logistics?.accessLevel) || 0),
    requiredAccessLevel: Math.max(0, Number(plan.logistics?.requiredAccessLevel) || 0),
    routeCopper: Math.max(0, Number(plan.routeCopper) || 0),
    taxCopper: Math.max(0, Number(plan.taxCopper) || 0),
    handlingCopper: Math.max(0, Number(plan.handlingCopper) || 0),
    expressSurchargeCopper: Math.max(0, Number(plan.expressSurchargeCopper) || 0),
    insuranceCopper: Math.max(0, Number(plan.insuranceCopper) || 0),
    insuranceCoverageRate: bounded(plan.insuranceCoverageRate, 0, 0, 1),
    insuredValueCopper: Math.max(0, Math.floor(Number(plan.insuredValueCopper ?? plan.subtotalCopper) || 0)),
    maximumInsurancePayoutCopper: Math.max(0, Math.floor(Number(plan.maximumInsurancePayoutCopper) || 0)),
    insurancePayoutCopper: 0,
    insuranceOperationId: "",
    insurancePaidAt: "",
    riskFactor: bounded(plan.riskFactor ?? plan.logistics?.riskFactor, 1, 0.25, 4),
    riskLossChance: bounded(plan.riskLossChance, 0, 0, 0.08),
    riskDelayChance: bounded(plan.riskDelayChance, 0, 0, 0.45),
    riskMaxDelayQd: Math.max(1, Math.min(20, Math.ceil(Number(plan.riskMaxDelayQd) || 1))),
    riskSeed,
    riskResolutionId: `${id}:risk:v2`,
    riskResolutionVersion: 2,
    riskStatus: riskPending ? "pending" : "waived",
    riskOutcome: riskPending ? "pending" : "waived",
    riskProposedAt: "",
    riskProposal: null,
    riskResolutionOperationId: "",
    riskResolutionChoice: "",
    riskResolvedAt: "",
    riskLossRoll: null,
    riskDelayRoll: null,
    riskDelayDurationRoll: null,
    delayQd: 0,
    delayRemainingQd: 0,
    delayedAt: "",
    lostAt: "",
    cancelledAt: "",
    cancellationOperationId: "",
    cancellationRefundCopper: 0,
    cancellationWithheldCopper: 0,
    stockReservationOperationId: String(plan.stockReservationOperationId ?? ""),
    stockRestorationOperationId: "",
    stockRestoredAt: "",
    stockReservations: marketOrderStockReservations(plan),
    subtotalCopper: Math.max(0, Number(plan.subtotalCopper) || 0),
    deliveryCopper: Math.max(0, Number(plan.deliveryCopper) || 0),
    totalCopper: Math.max(0, Number(plan.totalCopper) || 0),
    lines: marketOrderLines(plan, itemDocuments),
    cargo: prepared.cargo
  };
}

export function createMarketShipment({ holding, plan, itemDocuments = new Map(), operationId = "", createdAt = new Date().toISOString(), dependencies = {} } = {}) {
  const deps = requireFunctions(dependencies, ["addMoney", "snapshotItemForStorage", "appendStorageLog"]);
  if (!holding || !plan?.ok || plan.deliveryMode !== "scheduled" || !(Number(plan.deliveryQd) > 0)) {
    return { ok: false, message: "Market shipment requires an affordable scheduled plan." };
  }
  const id = String(operationId ?? "").trim();
  if (!id) return { ok: false, message: "Market shipment requires an operation id." };
  const storedOrders = holding?.special?.market?.orders;
  const replayOrders = Array.isArray(storedOrders)
    ? storedOrders.filter((order) => String(order?.operationId || order?.id) === id || String(order?.parentOperationId ?? "") === id)
    : [];
  if (replayOrders.length) return { ok: true, replay: true, order: replayOrders[0], orders: replayOrders, batchCount: replayOrders.length };

  const batchPlans = marketShipmentBatchPlans(plan);
  const preparedOrders = [];
  for (const [index, batchPlan] of batchPlans.entries()) {
    const prepared = prepareCargo(batchPlan, itemDocuments, deps);
    if (!prepared.ok) return prepared;
    const batchId = batchPlans.length === 1 ? id : `${id}:batch:${index + 1}`;
    preparedOrders.push(createShipmentOrder({ plan: batchPlan, prepared, id: batchId, parentOperationId: id, createdAt, itemDocuments }));
  }
  const batchTotalCopper = preparedOrders.reduce((sum, order) => sum + order.totalCopper, 0);
  if (batchTotalCopper !== Math.max(0, Number(plan.totalCopper) || 0)) return { ok: false, message: "Market shipment batches do not reconcile to the confirmed total." };

  deps.addMoney(holding, -batchTotalCopper);
  if (!holding.special || typeof holding.special !== "object") holding.special = { notes: "", list: [] };
  if (!holding.special.market || typeof holding.special.market !== "object") holding.special.market = { orders: [] };
  if (!Array.isArray(holding.special.market.orders)) holding.special.market.orders = [];
  holding.special.market.orders.push(...preparedOrders);
  holding.special.market.orders = retainMarketShipmentOrders(holding.special.market.orders);
  deps.appendStorageLog(holding, [marketPurchasePaymentEntry(plan, id)]);
  return { ok: true, replay: false, order: preparedOrders[0], orders: preparedOrders, batchCount: preparedOrders.length };
}

export function marketShipmentCancellationQuote(order = {}) {
  const status = String(order?.status ?? "");
  const alreadyCancelled = status === "cancelled";
  const beforeDispatch = String(order?.dispatchStatus ?? "booked") === "booked"
    && !String(order?.dispatchedAt ?? "")
    && ["pending", "waived"].includes(String(order?.riskStatus ?? "pending"));
  const cancellable = ["pending", "in-transit"].includes(status) && beforeDispatch;
  const totalCopper = Math.max(0, Math.floor(Number(order?.totalCopper) || 0));
  const refundCopper = totalCopper;
  return {
    ok: cancellable || alreadyCancelled,
    cancellable,
    alreadyCancelled,
    refundCopper: alreadyCancelled ? Math.max(0, Math.floor(Number(order?.cancellationRefundCopper) || 0)) : refundCopper,
    withheldCopper: alreadyCancelled
      ? Math.max(0, Math.floor(Number(order?.cancellationWithheldCopper) || 0))
      : 0,
    reason: cancellable || alreadyCancelled ? "" : "Заказ уже передан перевозчику и не может быть отменён."
  };
}

export function cancelMarketShipment({ holding, orderId = "", cancelledAt = new Date().toISOString(), dependencies = {} } = {}) {
  const deps = requireFunctions(dependencies, ["addMoney", "appendStorageLog", "formatCurrency"]);
  const id = String(orderId ?? "").trim();
  const orders = holding?.special?.market?.orders;
  const order = Array.isArray(orders) ? orders.find((row) => [row?.id, row?.operationId].some((value) => String(value ?? "") === id)) : null;
  if (!order) return { ok: false, message: "Market shipment is unavailable." };
  const quote = marketShipmentCancellationQuote(order);
  if (!quote.ok) return { ok: false, message: quote.reason, order, ...quote };
  if (quote.alreadyCancelled) return { ok: true, replay: true, order, ...quote };

  const operationId = String(order.cancellationOperationId || `${order.operationId || order.id}:cancel`);
  let stockRestoration = { ok: true, replay: true, restoredQty: 0 };
  const stockReservations = Array.isArray(order.stockReservations) ? order.stockReservations : [];
  if (stockReservations.length && !String(order.stockRestoredAt ?? "")) {
    if (typeof deps.restoreMarketStock !== "function") return { ok: false, message: "Market shipment cancellation requires stock restoration.", order, ...quote };
    stockRestoration = deps.restoreMarketStock({
      holding,
      reservations: stockReservations,
      operationId,
      updatedAt: String(cancelledAt || "")
    });
    if (!stockRestoration?.ok) return { ok: false, message: stockRestoration?.message || "Market stock restoration failed.", order, ...quote };
    order.stockRestorationOperationId = operationId;
    order.stockRestoredAt = String(cancelledAt || "");
  }
  order.status = "cancelled";
  order.dispatchStatus = "cancelled";
  order.remainingQd = 0;
  order.delayRemainingQd = 0;
  order.riskStatus = "waived";
  order.riskOutcome = "waived";
  order.cancelledAt = String(cancelledAt || "");
  order.cancellationOperationId = operationId;
  order.cancellationRefundCopper = quote.refundCopper;
  order.cancellationWithheldCopper = quote.withheldCopper;
  if (quote.refundCopper > 0) {
    deps.addMoney(holding, quote.refundCopper);
    deps.appendStorageLog(holding, [{
      kind: "market-refund",
      resourceId: "money",
      name: "Возврат за отменённый заказ",
      qty: quote.refundCopper,
      unit: "ММ",
      roomId: "treasury",
      source: String(order.marketLabel ?? "Внешний рынок"),
      note: `отмена до отправки ${order.operationId || order.id}; полный возврат`,
      operationId
    }]);
  }
  return { ok: true, replay: false, order, operationId, stockRestoration, ...quote };
}

export function proposeMarketShipmentRisk({ order, proposedAt = new Date().toISOString(), elapsedQd = 0, dependencies = {} } = {}) {
  if (!order || String(order.riskStatus ?? "") !== "pending") {
    return {
      ok: Boolean(order),
      replay: String(order?.riskStatus ?? "") === "needsResolution",
      event: String(order?.riskStatus ?? "") === "needsResolution",
      outcome: String(order?.riskProposal?.outcome ?? order?.riskOutcome ?? "waived"),
      proposal: order?.riskProposal ?? null,
      order
    };
  }
  if (marketShipmentSchedule(order).isWaiting) {
    return { ok: true, replay: false, event: false, waiting: true, outcome: "pending", proposal: null, order };
  }
  const randomUnit = typeof dependencies.riskUnit === "function" ? dependencies.riskUnit : deterministicMarketShipmentUnit;
  const resolutionId = String(order.riskResolutionId || `${order.operationId || order.id}:risk:v2`);
  const seed = String(order.riskSeed || `${resolutionId}|legacy-seed`);
  const lossRoll = bounded(randomUnit(`${seed}|loss`), 1, 0, 0.999999999);
  const delayRoll = bounded(randomUnit(`${seed}|delay`), 1, 0, 0.999999999);
  const durationRoll = bounded(randomUnit(`${seed}|delay-duration`), 0, 0, 0.999999999);
  const lossChance = bounded(order.riskLossChance, 0, 0, 0.08);
  const delayChance = bounded(order.riskDelayChance, 0, 0, 0.45);
  const maxDelayQd = Math.max(1, Math.min(20, Math.ceil(Number(order.riskMaxDelayQd) || 1)));
  const delayQd = 1 + Math.floor(durationRoll * maxDelayQd);
  const outcome = lossRoll < lossChance ? "lost" : (delayRoll < delayChance ? "delayed" : "clear");

  order.riskSeed = seed;
  order.riskResolutionId = resolutionId;
  order.riskResolutionVersion = 2;
  order.riskLossRoll = lossRoll;
  order.riskDelayRoll = delayRoll;
  order.riskDelayDurationRoll = durationRoll;

  if (outcome === "clear") {
    order.riskStatus = "resolved";
    order.riskOutcome = "clear";
    order.riskResolvedAt = String(proposedAt || "");
    return { ok: true, replay: false, event: false, outcome, proposal: null, order };
  }

  // Date and value refer to the same checkpoint. Later GM deliberation cannot reprice this loss.
  ageMarketCargo(order, elapsedQd);
  const insuredValueCopper = viableCargoValueCopper(order, order.insuredValueCopper ?? order.subtotalCopper);
  const insuranceCoverageRate = bounded(order.insuranceCoverageRate, 0, 0, 1);
  const calculatedPayoutCopper = Math.floor(insuredValueCopper * insuranceCoverageRate);
  const maximumInsurancePayoutCopper = Math.max(0, Math.floor(Number(order.maximumInsurancePayoutCopper) || calculatedPayoutCopper));
  const potentialInsurancePayoutCopper = marketInsurancePayoutCopper(order);
  const proposal = {
    id: resolutionId,
    outcome,
    proposedAt: String(proposedAt || ""),
    lossRoll,
    lossChance,
    delayRoll,
    delayChance,
    delayDurationRoll: durationRoll,
    maxDelayQd,
    delayQd,
    insuredValueCopper,
    insuranceCoverageRate,
    maximumInsurancePayoutCopper,
    potentialInsurancePayoutCopper,
    proposedInsurancePayoutCopper: outcome === "lost" ? potentialInsurancePayoutCopper : 0
  };
  order.status = "needsResolution";
  order.riskStatus = "needsResolution";
  order.riskOutcome = "pending";
  order.riskProposedAt = String(proposedAt || "");
  order.riskProposal = proposal;
  return { ok: true, replay: false, event: true, outcome, proposal, order, operationId: resolutionId };
}

function shipmentOrderById(holding, orderId = "") {
  const id = String(orderId ?? "").trim();
  const orders = holding?.special?.market?.orders;
  return Array.isArray(orders)
    ? orders.find((row) => [row?.id, row?.operationId].some((value) => String(value ?? "") === id))
    : null;
}

export function resolveMarketShipmentRisk({ holding, order: suppliedOrder = null, orderId = "", outcome = "proposal", delayQd = null, operationId = "", resolvedAt = new Date().toISOString(), dependencies = {} } = {}) {
  const order = suppliedOrder ?? shipmentOrderById(holding, orderId);
  if (!holding || !order) return { ok: false, resolved: false, message: "Market shipment risk event is unavailable.", order };
  const resolutionOperationId = String(operationId || `${order.riskResolutionId || order.operationId || order.id}:gm-resolution`).trim();
  if (String(order.riskStatus ?? "") === "resolved" && String(order.riskResolutionOperationId ?? "")) {
    return {
      ok: true,
      resolved: true,
      replay: true,
      outcome: String(order.riskOutcome ?? "clear"),
      order,
      operationId: String(order.riskResolutionOperationId),
      payoutCopper: Math.max(0, Math.floor(Number(order.insurancePayoutCopper) || 0)),
      delayQd: Math.max(0, Math.ceil(Number(order.delayQd) || 0))
    };
  }
  if (String(order.status ?? "") !== "needsResolution" || String(order.riskStatus ?? "") !== "needsResolution" || !order.riskProposal) {
    return { ok: false, resolved: false, message: "Market shipment has no unresolved risk event.", order };
  }
  const requested = String(outcome ?? "proposal");
  const selectedOutcome = requested === "proposal" ? String(order.riskProposal.outcome ?? "") : requested;
  if (!["clear", "delayed", "lost"].includes(selectedOutcome)) {
    return { ok: false, resolved: false, message: "Market shipment risk outcome is invalid.", order };
  }
  const deps = requireFunctions(dependencies, ["addMoney", "appendStorageLog", "formatCurrency"]);
  const at = String(resolvedAt || "");
  order.riskStatus = "resolved";
  order.riskOutcome = selectedOutcome;
  order.riskResolvedAt = at;
  order.riskResolutionOperationId = resolutionOperationId;
  order.riskResolutionChoice = requested === "proposal" ? "proposal" : (selectedOutcome === "clear" ? "cancelled" : "changed");

  if (selectedOutcome === "clear") {
    order.status = "in-transit";
    order.delayQd = 0;
    order.delayRemainingQd = 0;
    return { ok: true, resolved: true, replay: false, outcome: "clear", order, operationId: resolutionOperationId, payoutCopper: 0, delayQd: 0 };
  }

  if (selectedOutcome === "delayed") {
    const resolvedDelayQd = Math.max(1, Math.min(20, Math.ceil(Number(delayQd ?? order.riskProposal.delayQd) || 1)));
    order.status = "delayed";
    order.delayQd = resolvedDelayQd;
    order.delayRemainingQd = resolvedDelayQd;
    order.delayedAt = at;
    order.remainingQd = Math.max(0, Number(order.remainingQd ?? order.deliveryQd) || 0) + resolvedDelayQd;
    order.etaQd = Math.max(0, Number(order.etaQd ?? order.deliveryQd) || 0) + resolvedDelayQd;
    return { ok: true, resolved: true, replay: false, outcome: "delayed", order, delayQd: resolvedDelayQd, operationId: resolutionOperationId, payoutCopper: 0 };
  }

  order.status = "lost";
  order.dispatchStatus = "lost";
  order.remainingQd = 0;
  order.delayRemainingQd = 0;
  order.lostAt = at;
  const coverageRate = bounded(order.insuranceCoverageRate, 0, 0, 1);
  // A changed delay becomes a new loss now. Incomplete legacy events have no recoverable dated value.
  const payout = marketLossInsurancePayoutCopper(order);
  order.insurancePayoutCopper = payout;
  order.insuranceOperationId = String(order.insuranceOperationId || `${order.operationId || order.id}:insurance`);
  if (payout > 0 && !order.insurancePaidAt) {
    deps.addMoney(holding, payout);
    order.insurancePaidAt = at;
    deps.appendStorageLog(holding, [{
      kind: "market-insurance",
      resourceId: "money",
      name: "Страховая выплата",
      qty: payout,
      unit: "ММ",
      roomId: order.ownShipId ? `ship:${order.ownShipId}` : "treasury",
      source: String(order.marketLabel ?? "Страховщик"),
      note: `утрата заказа ${order.operationId || order.id}; покрытие ${Math.round(coverageRate * 100)}%; выплата ${deps.formatCurrency(payout)}`,
      operationId: order.insuranceOperationId
    }]);
  }
  return { ok: true, resolved: true, replay: false, outcome: "lost", order, payoutCopper: payout, delayQd: 0, operationId: resolutionOperationId, insuranceOperationId: order.insuranceOperationId };
}

function deliverOrder(holding, order, dependencies, deliveredAt) {
  const storageEntries = [];
  const delivered = [];
  for (const cargo of order.cargo ?? []) {
    if (!(Number(cargo?.qty) > 0)) return { ok: false, message: `Shipment cargo quantity is invalid: ${cargo?.offerId || order.id}.` };
    if (cargo.sourceType === "item" && (!cargo.item || typeof cargo.item !== "object")) {
      return { ok: false, message: `Shipment Item snapshot is unavailable: ${cargo.offerId}.` };
    }
  }
  if (!holding.storage || typeof holding.storage !== "object") holding.storage = { resources: [], items: [], moneyCopper: 0, log: [] };
  if (!Array.isArray(holding.storage.items)) holding.storage.items = [];
  ageMarketCargo(order, 0);
  const deliveryOperationId = String(order.deliveryOperationId || `${order.operationId || order.id}:arrival`);

  for (const cargo of order.cargo ?? []) {
    const deliveredQty = cargoDeliveryQuantity(cargo);
    if (deliveredQty < cargo.qty) storageEntries.push({ kind: "market-spoilage", resourceId: cargo.resourceId, name: cargo.name,
      qty: -(cargo.qty - deliveredQty), roomId: "transit", source: order.marketLabel,
      note: "Груз испортился в пути; естественная порча не страхуется.", operationId: deliveryOperationId });
    if (!deliveredQty) continue;
    const internalDemandAvailableFromQd = Math.max(0, Math.floor(Number(dependencies.internalDemandAvailableFromQd(holding)) || 0));
    if (cargo.sourceType === "item") {
      const snapshot = cloneSerializable(cargo.item);
      snapshot.roomId = String(cargo.targetRoomId || order.targetRoomId || "outdoors");
      snapshot.internalDemandAvailableFromQd = internalDemandAvailableFromQd;
      holding.storage.items.push(snapshot);
      storageEntries.push({
        kind: "market-arrival",
        resourceId: "custom",
        name: String(snapshot.name ?? cargo.name ?? "Предмет"),
        qty: Math.max(0, Number(cargo.qty) || 0),
        roomId: snapshot.roomId,
        source: order.marketLabel,
        note: `Item UUID; прибытие заказа ${order.operationId}; доставка ${dependencies.formatCurrency(order.deliveryCopper)}`,
        operationId: deliveryOperationId
      });
      delivered.push({ offerId: cargo.offerId, sourceType: "item", name: snapshot.name, qty: cargo.qty, roomId: snapshot.roomId });
      continue;
    }
    const placements = dependencies.storageAddWithOverflow(holding, {
      resourceId: cargo.resourceId,
      name: cargo.name,
      unit: cargo.unit,
      img: cargo.img,
      roomId: String(cargo.targetRoomId || order.targetRoomId || "outdoors"),
      arrivalShelfLifeQd: cargo.shelfLifeQd,
      batches: [{ qty: deliveredQty, ageQd: (Number(cargo.ageQd) || 0) + (Number(order.postArrivalElapsedQd) || 0), internalDemandAvailableFromQd }]
    }, deliveredQty);
    for (const placement of placements) {
      if (placement.spoiledQty) storageEntries.push({ kind: "market-spoilage", resourceId: cargo.resourceId, name: cargo.name,
        qty: -placement.spoiledQty, roomId: placement.roomId, source: order.marketLabel,
        note: "Груз прибыл, но истёкший срок хранения не позволяет использовать его к концу периода.", operationId: deliveryOperationId });
      if (!placement.qty) continue;
      storageEntries.push({
        kind: "market-arrival",
        resourceId: cargo.resourceId,
        name: cargo.name,
        qty: placement.qty,
        roomId: placement.roomId,
        source: order.marketLabel,
        note: `прибытие заказа ${order.operationId}; доставка ${dependencies.formatCurrency(order.deliveryCopper)}`,
        operationId: deliveryOperationId
      });
      delivered.push({ offerId: cargo.offerId, sourceType: "resource", name: cargo.name, qty: placement.qty, roomId: placement.roomId });
    }
  }
  dependencies.appendStorageLog(holding, storageEntries);
  order.status = "delivered";
  order.dispatchStatus = "delivered";
  if (order.riskStatus === "pending") {
    order.riskStatus = "waived";
    order.riskOutcome = "waived";
  }
  order.remainingQd = 0;
  order.deliveredAt = String(deliveredAt || "");
  order.deliveryOperationId = deliveryOperationId;
  return { ok: true, orderId: order.id, orderOperationId: order.operationId, operationId: deliveryOperationId, deliveredAt: order.deliveredAt, marketLabel: order.marketLabel, delivered, storageEntries };
}

export function advanceMarketShipments({ holding, elapsedQd = 0, forceOrderId = "", deliveredAt = new Date().toISOString(), dependencies = {} } = {}) {
  const deps = requireFunctions(dependencies, ["addMoney", "storageAddWithOverflow", "appendStorageLog", "formatCurrency", "internalDemandAvailableFromQd"]);
  const qd = Math.max(0, Math.floor(Number(elapsedQd) || 0));
  const forced = String(forceOrderId ?? "").trim();
  const report = { advancedQd: qd, delivered: [], delayed: [], lost: [], needsResolution: [], inTransit: [], ignored: 0 };
  const orders = holding?.special?.market?.orders;
  if (!Array.isArray(orders)) return { ok: true, ...report };

  for (const order of orders) {
    const id = String(order?.id ?? order?.operationId ?? "");
    const force = Boolean(forced && (id === forced || String(order?.operationId ?? "") === forced));
    let manualRiskWaiver = false;
    if (forced && !force) continue;
    if (!["pending", "in-transit", "delayed", "needsResolution"].includes(String(order?.status ?? ""))) {
      report.ignored += 1;
      continue;
    }
    if (String(order.status ?? "") === "needsResolution" || String(order.riskStatus ?? "") === "needsResolution") {
      ageMarketCargo(order, qd);
      report.needsResolution.push({
        orderId: id,
        orderOperationId: String(order.operationId ?? id),
        operationId: String(order.riskResolutionId || `${order.operationId || id}:risk:v2`),
        marketLabel: String(order.marketLabel ?? "Внешний рынок"),
        proposedAt: String(order.riskProposedAt ?? ""),
        newEvent: false
      });
      continue;
    }
    const schedule = marketShipmentSchedule(order);
    const waitingElapsedQd = force ? 0 : Math.min(qd, schedule.waitingQd);
    const travelElapsedQd = qd - waitingElapsedQd;
    if (waitingElapsedQd > 0) order.remainingQd = schedule.remainingQd - waitingElapsedQd;
    if (!force && schedule.isWaiting && qd < schedule.waitingQd) {
      ageMarketCargo(order, qd);
      report.inTransit.push({ orderId: id, status: order.status, remainingQd: order.remainingQd, waitingQd: schedule.waitingQd - waitingElapsedQd });
      continue;
    }
    if (order.status === "pending" && (force || qd > 0)) order.status = "in-transit";
    if (!force && qd > 0 && String(order.dispatchStatus ?? "booked") === "booked") {
      order.dispatchStatus = "departed";
      order.dispatchedAt = String(deliveredAt || "");
    }
    if (force && String(order.dispatchStatus ?? "booked") === "booked") {
      order.dispatchStatus = "departed";
      order.dispatchedAt = String(deliveredAt || "");
    }
    if (!force && travelElapsedQd > 0 && order.riskStatus === "pending") {
      const risk = proposeMarketShipmentRisk({ order, proposedAt: deliveredAt, elapsedQd: qd, dependencies: deps });
      if (risk.event) {
        report.needsResolution.push({
          orderId: id,
          orderOperationId: String(order.operationId ?? id),
          operationId: String(risk.operationId ?? order.riskResolutionId ?? ""),
          marketLabel: String(order.marketLabel ?? "Внешний рынок"),
          proposedAt: String(order.riskProposedAt ?? deliveredAt ?? ""),
          newEvent: !risk.replay
        });
        continue;
      }
    }
    if (force && String(order.riskStatus ?? "") === "pending") {
      const riskResolutionId = String(order.riskResolutionId || `${order.operationId || id}:risk:v2`);
      order.riskResolutionId = riskResolutionId;
      order.riskStatus = "waived";
      order.riskOutcome = "waived";
      order.riskResolvedAt = String(deliveredAt || "");
      order.riskResolutionOperationId = String(order.riskResolutionOperationId || `${riskResolutionId}:manual-delivery`);
      order.riskResolutionChoice = "manual-delivery";
      manualRiskWaiver = true;
    }
    ageMarketCargo(order, force ? 0 : Math.min(qd, schedule.remainingQd));
    order.postArrivalElapsedQd = force ? 0 : Math.max(0, qd - schedule.remainingQd);
    const current = Math.max(0, Number(order.remainingQd ?? order.deliveryQd ?? order.etaQd) || 0);
    order.remainingQd = force ? 0 : Math.max(0, current - travelElapsedQd);
    if (!force && order.status === "delayed") {
      order.delayRemainingQd = Math.max(0, Number(order.delayRemainingQd) - travelElapsedQd);
      if (order.delayRemainingQd <= 0) order.status = "in-transit";
    }
    if (order.remainingQd > 0) {
      report.inTransit.push({ orderId: id, status: order.status, remainingQd: order.remainingQd });
      continue;
    }
    const arrival = deliverOrder(holding, order, deps, deliveredAt);
    if (!arrival.ok) return { ok: false, ...report, message: arrival.message, failedOrderId: id };
    arrival.riskWaived = manualRiskWaiver;
    arrival.riskWaiverOperationId = manualRiskWaiver ? String(order.riskResolutionOperationId ?? "") : "";
    report.delivered.push(arrival);
  }
  return { ok: true, ...report };
}

export function deliverMarketShipmentNow(options = {}) {
  return advanceMarketShipments({ ...options, elapsedQd: 0, forceOrderId: options.orderId ?? options.forceOrderId });
}
