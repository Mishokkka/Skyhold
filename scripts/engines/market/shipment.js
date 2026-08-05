import { releaseMarketQuoteStock, reserveMarketQuoteStock } from "./stock.js";

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
    sourceOfferId: String(line.sourceOfferId ?? line.id ?? ""),
    sourceType: line.sourceType === "item" ? "item" : "resource",
    resourceId: String(line.resourceId ?? "custom"),
    itemUuid: String(line.itemUuid ?? ""),
    providerId: String(line.providerId ?? ""),
    providerLabel: String(line.providerLabel ?? ""),
    name: line.sourceType === "item" ? String(itemDocuments.get(line.id)?.name ?? line.name ?? "Товар") : String(line.name ?? "Товар"),
    qty: Math.max(0, Number(line.qty) || 0),
    unitPriceCopper: Math.max(0, Number(line.unitPriceCopper) || 0),
    economyVersion: Math.max(1, Math.floor(Number(line.economyVersion) || 1)),
    cargoClass: String(line.cargoClass ?? ""),
    unitCargoPoints: Math.max(0, Math.ceil(Number(line.cargoPoints) || 0)),
    totalCargoPoints: Math.max(0, Math.ceil((Number(line.cargoPoints) || 0) * (Number(line.qty) || 0))),
    packageMassKg: Math.max(0, Number(line.packageMassKg) || 0),
    packageVolumeL: Math.max(0, Number(line.packageVolumeL) || 0)
  })).filter((line) => line.qty > 0);
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
      unit: String(line.unit ?? "ед."),
      img: String(line.img ?? ""),
      loadMode: String(line.loadMode ?? "manual") === "auto" ? "auto" : "manual",
      economyVersion: Math.max(1, Math.floor(Number(line.economyVersion) || 1)),
      cargoClass: String(line.cargoClass ?? ""),
      cargoPoints: Math.max(1, Math.ceil(Number(line.cargoPoints) || (Number(line.load) || 0) * 10 || 1)),
      load: Math.max(0, Number(line.load) || 0),
      packageMassKg: Math.max(0, Number(line.packageMassKg) || 0),
      packageVolumeL: Math.max(0, Number(line.packageVolumeL) || 0),
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
        totalCargoPoints: plan.totalCargoPoints,
        totalMassKg: plan.totalMassKg,
        totalVolumeL: plan.totalVolumeL,
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
      lines,
      merchantProviderIds: [...new Set(lines.map((line) => String(line?.providerId ?? "")).filter(Boolean))],
      subtotalCopper: Math.max(0, Number(batch.subtotalCopper) || 0),
      deliveryCopper: Math.max(0, Number(batch.deliveryCopper) || 0),
      totalCopper: Math.max(0, Number(batch.totalCopper) || 0),
      totalLoad: Math.max(0, Number(batch.totalLoad) || 0),
      totalCargoPoints: Math.max(0, Number(batch.totalCargoPoints) || 0),
      totalMassKg: Math.max(0, Number(batch.totalMassKg) || 0),
      totalVolumeL: Math.max(0, Number(batch.totalVolumeL) || 0),
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
    serviceLevel: ["standard", "express", "charter", "owned"].includes(String(plan.serviceLevel ?? "")) ? String(plan.serviceLevel) : "standard",
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
    transportMode: String(plan.logistics?.transportMode ?? ""),
    carrierId: String(plan.carrierId ?? plan.logistics?.carrierId ?? ""),
    carrierLabel: String(plan.carrierLabel ?? plan.logistics?.carrierLabel ?? ""),
    ownedVesselDelivery: Boolean(plan.ownedVesselDelivery),
    ownedVesselId: String(plan.ownedVesselId ?? ""),
    ownedVesselName: String(plan.ownedVesselName ?? ""),
    ownedPickupRegionId: String(plan.ownedPickupRegionId ?? ""),
    ownedPickupLabel: String(plan.ownedPickupLabel ?? ""),
    ownedDestinationRegionId: String(plan.ownedDestinationRegionId ?? ""),
    ownedDestinationLabel: String(plan.ownedDestinationLabel ?? ""),
    ownedPickupQd: Math.max(0, Number(plan.ownedPickupQd) || 0),
    ownedCargoQd: Math.max(0, Number(plan.ownedCargoQd) || 0),
    ownedHandlingQd: Math.max(0, Number(plan.ownedHandlingQd) || 0),
    ownedOperatingCostCopper: Math.max(0, Number(plan.ownedOperatingCostCopper) || 0),
    ownedReplacementReserveCopper: Math.max(0, Number(plan.ownedReplacementReserveCopper) || 0),
    carrierCapacityFactor: Math.max(0.1, Number(plan.logistics?.carrierCapacityFactor) || 1),
    carrierCapacityLoad: Math.max(0, Number(plan.physicalCapacityLoad ?? plan.capacityLoad) || 0),
    carrierCapacityCargoPoints: Math.max(0, Number(plan.physicalCapacityCargoPoints ?? plan.capacityCargoPoints) || 0),
    carrierCapacityMassKg: Math.max(0, Number(plan.physicalCapacityMassKg) || 0),
    carrierCapacityVolumeL: Math.max(0, Number(plan.physicalCapacityVolumeL) || 0),
    bookingCapacityLoad: Math.max(0, Number(plan.bookingCapacityLoad) || 0),
    bookingCapacityCargoPoints: Math.max(0, Number(plan.bookingCapacityCargoPoints) || 0),
    bookingCapacityMassKg: Math.max(0, Number(plan.bookingCapacityMassKg) || 0),
    bookingCapacityVolumeL: Math.max(0, Number(plan.bookingCapacityVolumeL) || 0),
    chargedCapacityShare: Math.max(0, Number(plan.chargedCapacityShare) || 0),
    totalLoad: Math.max(0, Number(plan.totalLoad) || 0),
    totalCargoPoints: Math.max(0, Number(plan.totalCargoPoints) || 0),
    totalMassKg: Math.max(0, Number(plan.totalMassKg) || 0),
    totalVolumeL: Math.max(0, Number(plan.totalVolumeL) || 0),
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
    riskResolutionId: `${id}:risk:v1`,
    riskResolutionVersion: 1,
    riskStatus: riskPending ? "pending" : "waived",
    riskOutcome: riskPending ? "pending" : "waived",
    riskResolvedAt: "",
    riskLossRoll: null,
    riskDelayRoll: null,
    delayQd: 0,
    delayRemainingQd: 0,
    delayedAt: "",
    lostAt: "",
    cancelledAt: "",
    cancellationOperationId: "",
    cancellationRefundCopper: 0,
    cancellationWithheldCopper: 0,
    subtotalCopper: Math.max(0, Number(plan.subtotalCopper) || 0),
    deliveryCopper: Math.max(0, Number(plan.deliveryCopper) || 0),
    totalCopper: Math.max(0, Number(plan.totalCopper) || 0),
    lines: marketOrderLines(plan, itemDocuments),
    cargo: prepared.cargo
  };
}

export function createMarketShipment({ holding, plan, itemDocuments = new Map(), operationId = "", createdAt = new Date().toISOString(), dependencies = {} } = {}) {
  const deps = requireFunctions(dependencies, ["addMoney", "snapshotItemForStorage"]);
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

  const reservation = reserveMarketQuoteStock({ holding, plan, operationId: id, createdAt });
  if (!reservation.ok) return reservation;
  if (reservation.replay) return { ok: true, replay: true, order: null, orders: [], batchCount: 0, reservation: reservation.reservation };

  deps.addMoney(holding, -batchTotalCopper);
  if (!holding.special || typeof holding.special !== "object") holding.special = { notes: "", list: [] };
  if (!holding.special.market || typeof holding.special.market !== "object") holding.special.market = { orders: [] };
  if (!Array.isArray(holding.special.market.orders)) holding.special.market.orders = [];
  holding.special.market.orders.push(...preparedOrders);
  holding.special.market.orders = retainMarketShipmentOrders(holding.special.market.orders);
  return { ok: true, replay: false, order: preparedOrders[0], orders: preparedOrders, batchCount: preparedOrders.length, reservation: reservation.reservation };
}

export function marketShipmentCancellationQuote(order = {}) {
  const status = String(order?.status ?? "");
  const alreadyCancelled = status === "cancelled";
  const beforeDispatch = String(order?.dispatchStatus ?? "booked") === "booked"
    && !String(order?.dispatchedAt ?? "")
    && ["pending", "waived"].includes(String(order?.riskStatus ?? "pending"));
  const cancellable = ["pending", "in-transit"].includes(status) && beforeDispatch;
  const totalCopper = Math.max(0, Math.floor(Number(order?.totalCopper) || 0));
  const refundableCopper = order?.ownedVesselDelivery
    ? totalCopper
    : Math.max(0, Math.floor(
      Number(order?.subtotalCopper || 0)
      + Number(order?.insuranceCopper || 0)
      + Number(order?.taxCopper || 0)
    ));
  const refundCopper = Math.min(totalCopper, refundableCopper);
  return {
    ok: cancellable || alreadyCancelled,
    cancellable,
    alreadyCancelled,
    refundCopper: alreadyCancelled ? Math.max(0, Math.floor(Number(order?.cancellationRefundCopper) || 0)) : refundCopper,
    withheldCopper: alreadyCancelled
      ? Math.max(0, Math.floor(Number(order?.cancellationWithheldCopper) || 0))
      : Math.max(0, totalCopper - refundCopper),
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
  const stockRelease = releaseMarketQuoteStock({ holding, order, operationId, releasedAt: cancelledAt });
  if (!stockRelease.ok) return { ok: false, message: stockRelease.message, order, ...quote };
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
      note: `отмена до отправки ${order.operationId || order.id}; удержано ${deps.formatCurrency(quote.withheldCopper)}`,
      operationId
    }]);
  }
  return { ok: true, replay: false, order, operationId, stockRelease, ...quote };
}

export function resolveMarketShipmentRisk({ holding, order, resolvedAt = new Date().toISOString(), dependencies = {} } = {}) {
  const deps = requireFunctions(dependencies, ["addMoney", "appendStorageLog", "formatCurrency"]);
  if (!holding || !order || order.riskStatus !== "pending") return { resolved: false, outcome: String(order?.riskOutcome ?? "waived"), order };
  const randomUnit = typeof deps.riskUnit === "function" ? deps.riskUnit : deterministicMarketShipmentUnit;
  const resolutionId = String(order.riskResolutionId || `${order.operationId || order.id}:risk:v1`);
  const lossRoll = bounded(randomUnit(`${resolutionId}|loss`), 1, 0, 0.999999999);
  const delayRoll = bounded(randomUnit(`${resolutionId}|delay`), 1, 0, 0.999999999);
  order.riskResolutionId = resolutionId;
  order.riskResolutionVersion = 1;
  order.riskStatus = "resolved";
  order.riskResolvedAt = String(resolvedAt || "");
  order.riskLossRoll = lossRoll;
  order.riskDelayRoll = delayRoll;

  if (lossRoll < bounded(order.riskLossChance, 0, 0, 0.08)) {
    order.riskOutcome = "lost";
    order.status = "lost";
    order.dispatchStatus = "lost";
    order.remainingQd = 0;
    order.delayRemainingQd = 0;
    order.lostAt = String(resolvedAt || "");
    const insuredValue = Math.max(0, Math.floor(Number(order.insuredValueCopper ?? order.subtotalCopper) || 0));
    const coverageRate = bounded(order.insuranceCoverageRate, 0, 0, 1);
    const calculatedPayout = Math.floor(insuredValue * coverageRate);
    const maximumPayout = Math.max(0, Math.floor(Number(order.maximumInsurancePayoutCopper) || calculatedPayout));
    const payout = Math.min(calculatedPayout, maximumPayout);
    order.insurancePayoutCopper = payout;
    order.insuranceOperationId = String(order.insuranceOperationId || `${order.operationId || order.id}:insurance`);
    if (payout > 0 && !order.insurancePaidAt) {
      deps.addMoney(holding, payout);
      order.insurancePaidAt = String(resolvedAt || "");
      deps.appendStorageLog(holding, [{
        kind: "market-insurance",
        resourceId: "money",
        name: "Страховая выплата",
        qty: payout,
        unit: "ММ",
        roomId: "treasury",
        source: String(order.marketLabel ?? "Страховщик"),
        note: `утрата заказа ${order.operationId || order.id}; покрытие ${Math.round(coverageRate * 100)}%; выплата ${deps.formatCurrency(payout)}`,
        operationId: order.insuranceOperationId
      }]);
    }
    return { resolved: true, outcome: "lost", order, payoutCopper: payout, operationId: order.insuranceOperationId };
  }

  if (delayRoll < bounded(order.riskDelayChance, 0, 0, 0.45)) {
    const durationRoll = bounded(randomUnit(`${resolutionId}|delay-duration`), 0, 0, 0.999999999);
    const maxDelayQd = Math.max(1, Math.min(20, Math.ceil(Number(order.riskMaxDelayQd) || 1)));
    const delayQd = 1 + Math.floor(durationRoll * maxDelayQd);
    order.riskOutcome = "delayed";
    order.status = "delayed";
    order.delayQd = delayQd;
    order.delayRemainingQd = delayQd;
    order.delayedAt = String(resolvedAt || "");
    order.remainingQd = Math.max(0, Number(order.remainingQd ?? order.deliveryQd) || 0) + delayQd;
    order.etaQd = Math.max(0, Number(order.etaQd ?? order.deliveryQd) || 0) + delayQd;
    return { resolved: true, outcome: "delayed", order, delayQd, operationId: `${order.operationId || order.id}:delay` };
  }

  order.riskOutcome = "clear";
  return { resolved: true, outcome: "clear", order };
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
  const deliveryOperationId = String(order.deliveryOperationId || `${order.operationId || order.id}:arrival`);

  for (const cargo of order.cargo ?? []) {
    if (cargo.sourceType === "item") {
      const snapshot = cloneSerializable(cargo.item);
      snapshot.roomId = String(cargo.targetRoomId || order.targetRoomId || "outdoors");
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
    const storageResource = {
      resourceId: cargo.resourceId,
      name: cargo.name,
      unit: cargo.unit,
      img: cargo.img,
      roomId: String(cargo.targetRoomId || order.targetRoomId || "outdoors")
    };
    // Старые заказы без loadMode считаются ручным исключением; новые auto-грузы
    // продолжают наследовать живую физику каталога после помещения на склад.
    if (cargo.loadMode !== "auto") storageResource.load = cargo.load;
    if (cargo.resourceId === "custom") {
      storageResource.economyVersion = cargo.economyVersion;
      storageResource.cargoClass = cargo.cargoClass;
      storageResource.cargoPoints = cargo.cargoPoints;
    }
    const placements = dependencies.storageAddWithOverflow(holding, storageResource, cargo.qty);
    for (const placement of placements) {
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
  const deps = requireFunctions(dependencies, ["addMoney", "storageAddWithOverflow", "appendStorageLog", "formatCurrency"]);
  const qd = Math.max(0, Math.floor(Number(elapsedQd) || 0));
  const forced = String(forceOrderId ?? "").trim();
  const report = { advancedQd: qd, delivered: [], delayed: [], lost: [], inTransit: [], ignored: 0 };
  const orders = holding?.special?.market?.orders;
  if (!Array.isArray(orders)) return { ok: true, ...report };

  for (const order of orders) {
    const id = String(order?.id ?? order?.operationId ?? "");
    const force = Boolean(forced && (id === forced || String(order?.operationId ?? "") === forced));
    if (forced && !force) continue;
    if (!["pending", "in-transit", "delayed"].includes(String(order?.status ?? ""))) {
      report.ignored += 1;
      continue;
    }
    if (order.status === "pending") order.status = "in-transit";
    if (!force && qd > 0 && String(order.dispatchStatus ?? "booked") === "booked") {
      order.dispatchStatus = "departed";
      order.dispatchedAt = String(deliveredAt || "");
    }
    if (force && String(order.dispatchStatus ?? "booked") === "booked") {
      order.dispatchStatus = "departed";
      order.dispatchedAt = String(deliveredAt || "");
    }
    if (!force && qd > 0 && order.riskStatus === "pending") {
      const risk = resolveMarketShipmentRisk({ holding, order, resolvedAt: deliveredAt, dependencies: deps });
      if (risk.outcome === "lost") {
        report.lost.push({
          orderId: id,
          orderOperationId: String(order.operationId ?? id),
          operationId: risk.operationId,
          marketLabel: String(order.marketLabel ?? "Внешний рынок"),
          lostAt: String(order.lostAt ?? deliveredAt ?? ""),
          payoutCopper: Math.max(0, Number(risk.payoutCopper) || 0),
          cargoCount: (order.cargo ?? []).length
        });
        continue;
      }
      if (risk.outcome === "delayed") report.delayed.push({
        orderId: id,
        orderOperationId: String(order.operationId ?? id),
        operationId: risk.operationId,
        marketLabel: String(order.marketLabel ?? "Внешний рынок"),
        delayedAt: String(order.delayedAt ?? deliveredAt ?? ""),
        delayQd: Math.max(1, Number(risk.delayQd) || 1)
      });
    }
    const current = Math.max(0, Number(order.remainingQd ?? order.deliveryQd ?? order.etaQd) || 0);
    order.remainingQd = force ? 0 : Math.max(0, current - qd);
    if (!force && order.status === "delayed") {
      order.delayRemainingQd = Math.max(0, Number(order.delayRemainingQd) - qd);
      if (order.delayRemainingQd <= 0) order.status = "in-transit";
    }
    if (order.remainingQd > 0) {
      report.inTransit.push({ orderId: id, status: order.status, remainingQd: order.remainingQd });
      continue;
    }
    const arrival = deliverOrder(holding, order, deps, deliveredAt);
    if (!arrival.ok) return { ok: false, ...report, message: arrival.message, failedOrderId: id };
    report.delivered.push(arrival);
  }
  return { ok: true, ...report };
}

export function deliverMarketShipmentNow(options = {}) {
  return advanceMarketShipments({ ...options, elapsedQd: 0, forceOrderId: options.orderId ?? options.forceOrderId });
}
