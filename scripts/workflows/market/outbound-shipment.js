import { ageMarketCargo, cargoDeliveryQuantity, viableCargoValueRatio } from "../../engines/market/cargo-aging.js";
import {
  MAX_ACTIVE_OUTBOUND_ORDERS,
  activeMarketOutboundOrderCount,
  normalizeMarketOutboundState,
  retainMarketOutboundOrders
} from "../../data/market/outbound-state.js";
import {
  applyMarketOutboundDispatch,
  createMarketOutboundOrder,
  preflightMarketOutboundBooking
} from "../../engines/market/outbound.js";
import { reserveMarketDemand, settleMarketDemandReservations } from "../../engines/market/demand.js";
import { proposeMarketShipmentRisk, resolveMarketShipmentRisk } from "../../engines/market/shipment.js";
import { marketShipmentSchedule } from "../../engines/market/shipment-schedule.js";
import { adjustWorldShipFunds } from "../../engines/ships/world-voyage.js";

function text(value = "") {
  return String(value ?? "").trim();
}

function whole(value, fallback = 0, max = 1_000_000_000) {
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
  return Math.min(max, Math.max(0, normalized));
}

function requireFunctions(dependencies = {}, names = []) {
  for (const name of names) {
    if (typeof dependencies[name] !== "function") throw new TypeError(`outbound market shipment requires dependencies.${name}`);
  }
  return dependencies;
}

function ensureOutboundState(holding) {
  if (!holding.special || typeof holding.special !== "object") holding.special = { notes: "", list: [] };
  if (!holding.special.market || typeof holding.special.market !== "object") holding.special.market = { orders: [] };
  const outbound = normalizeMarketOutboundState(holding.special.market.outbound);
  holding.special.market.outbound = outbound;
  return outbound;
}

function orderById(outbound, orderId = "") {
  const id = text(orderId);
  return outbound.orders.find((order) => [order?.id, order?.operationId].some((candidate) => text(candidate) === id)) ?? null;
}

function appendOperation(order, operationId) {
  const id = text(operationId);
  order.historyOperationIds = [...new Set([...(order.historyOperationIds ?? []), id].filter(Boolean))].slice(-120);
}

function currentTreasury(holding) {
  return whole(holding?.storage?.moneyCopper);
}

function resourcesFor(holding) {
  return Array.isArray(holding?.storage?.resources) ? holding.storage.resources : [];
}

function ownShipForOrder(holding, order) {
  return order.ownShipId
    ? (holding.special?.ships?.list ?? []).find((ship) => ship.id === order.ownShipId)
    : null;
}

function creditOwnShip(holding, order, amountCopper, operationId, reason) {
  const ship = ownShipForOrder(holding, order);
  if (!ship || ship.status !== "away") throw new Error("Корабль собственной поставки недоступен для выплаты.");
  adjustWorldShipFunds(holding, ship, {
    operationId, voyageId: ship.orderBundle?.id ?? ship.activeVoyage?.id ?? "",
    kind: "income", amountCopper, reason
  });
}

function dispatchOrder({ holding, order, dispatchedAt, dependencies }) {
  if (text(order.dispatchStatus || "booked") !== "booked") {
    return { ok: true, replay: true, order, dispatchedQty: (order.cargo ?? []).reduce((sum, row) => sum + whole(row?.qty), 0) };
  }
  const dispatched = applyMarketOutboundDispatch({ resources: resourcesFor(holding), cargoReservations: order.cargoReservations });
  if (!dispatched.ok) return { ...dispatched, order };
  const operationId = `${order.operationId || order.id}:dispatch`;
  const waitingAges = new Map((order.cargo ?? []).map((row) => [JSON.stringify([row.lineId, row.rowId, row.batchId]), whole(row.ageQd, 0, Number.MAX_SAFE_INTEGER)]));
  if (Number(order.batchCount) > 1) {
    for (const row of dispatched.cargo) row.ageQd = Math.max(whole(row.ageQd, 0, Number.MAX_SAFE_INTEGER), waitingAges.get(JSON.stringify([row.lineId, row.rowId, row.batchId])) ?? 0);
  }
  order.cargo = dispatched.cargo;
  ageMarketCargo(order, 0);
  order.dispatchStatus = "departed";
  order.status = "in-transit";
  order.dispatchedAt = text(dispatchedAt);
  order.dispatchOperationId = operationId;
  appendOperation(order, operationId);
  dependencies.appendStorageLog(holding, dispatched.cargo.map((cargo) => ({
    kind: "market-outbound-dispatch",
    resourceId: text(cargo.resourceId),
    name: text(cargo.name || cargo.resourceId || "Товар"),
    qty: -whole(cargo.qty),
    unit: "ед.",
    roomId: text(cargo.rowId),
    source: text(order.marketLabel || "Внешний рынок"),
    note: `исходящая поставка ${order.operationId || order.id}; партия ${text(cargo.batchId)}; возраст ${whole(cargo.ageQd)} QD`,
    operationId
  })));
  return { ok: true, replay: false, order, operationId, dispatchedQty: dispatched.dispatchedQty };
}

function settleOrderDemand({ holding, order, outcome, operationId, at, currentTenday = null, reservations = order.demandReservations }) {
  const settlement = settleMarketDemandReservations({
    holding,
    reservations,
    outcome,
    operationId,
    currentTenday,
    updatedAt: text(at)
  });
  if (settlement.ok) {
    order.demandSettlementOperationId = operationId;
    order.demandSettlementOutcome = outcome;
    appendOperation(order, operationId);
  }
  return settlement;
}

export function createMarketOutboundShipment({
  holding,
  plan,
  operationId = "",
  createdAt = new Date().toISOString(),
  currentTenday = null,
  dependencies = {}
} = {}) {
  const deps = requireFunctions(dependencies, ["addMoney", "appendStorageLog"]);
  const id = text(operationId);
  if (!holding || !plan?.ok || !id) return { ok: false, message: "Outbound shipment requires a holding, confirmed plan and operation id." };
  const outbound = ensureOutboundState(holding);
  const replay = outbound.orders.filter((order) => [order.id, order.operationId, order.parentOperationId].includes(id));
  if (replay.length) return { ok: true, replay: true, order: replay[0], orders: replay, batchCount: replay.length };
  const batchPlans = plan.shipmentBatches?.length ? plan.shipmentBatches : [plan];
  const activeOrderCount = activeMarketOutboundOrderCount(outbound.orders);
  if (activeOrderCount + batchPlans.length > MAX_ACTIVE_OUTBOUND_ORDERS) {
    return {
      ok: false,
      capacityExceeded: true,
      activeOrderCount,
      activeOrderLimit: MAX_ACTIVE_OUTBOUND_ORDERS,
      message: `Active outbound shipment limit (${MAX_ACTIVE_OUTBOUND_ORDERS}) has been reached.`
    };
  }
  const cargoPreflight = preflightMarketOutboundBooking({
    resources: resourcesFor(holding),
    outboundState: outbound,
    cargoReservations: plan.cargoReservations
  });
  if (!cargoPreflight.ok) return cargoPreflight;
  const upfrontCopper = whole(plan.upfrontCopper);
  if (currentTreasury(holding) < upfrontCopper) return { ok: false, insufficientMoney: true, requiredCopper: upfrontCopper, availableCopper: currentTreasury(holding), message: "Outbound shipment costs are no longer affordable." };
  const orders = batchPlans.map((batchPlan, index) => createMarketOutboundOrder({
    plan: batchPlan, operationId: batchPlans.length > 1 ? `${id}:batch:${index + 1}` : id, createdAt
  }));
  if (orders.some((order) => !order)) return { ok: false, message: "Outbound shipment plan is invalid." };
  const order = orders[0];
  const demandOperationId = `${id}:demand-reserve`;
  const demand = reserveMarketDemand({
    holding,
    marketId: plan.marketId,
    lines: plan.demandLines ?? plan.lines,
    operationId: demandOperationId,
    currentTenday,
    updatedAt: text(createdAt)
  });
  if (!demand.ok) return { ...demand, message: demand.message || "Outbound market demand changed after preview." };
  for (const batchOrder of orders) {
    if (orders.length > 1) batchOrder.parentOperationId = id;
    const quantities = new Map();
    for (const line of batchOrder.lines) quantities.set(line.demandId, (quantities.get(line.demandId) ?? 0) + line.qty);
    batchOrder.demandReservations = demand.reservations.map((row) => ({ ...row, qty: quantities.get(row.demandId) ?? 0 })).filter((row) => row.qty > 0);
    batchOrder.demandReservationOperationId = demandOperationId;
    appendOperation(batchOrder, demandOperationId);
  }
  if (upfrontCopper > 0) deps.addMoney(holding, -upfrontCopper);
  const costOperationId = `${id}:upfront`;
  for (const batchOrder of orders) {
    batchOrder.upfrontOperationId = costOperationId;
    appendOperation(batchOrder, costOperationId);
  }
  deps.appendStorageLog(holding, [{
    kind: "market-outbound-upfront",
    resourceId: "money",
    name: "Расходы исходящей поставки",
    qty: -upfrontCopper,
    unit: "медн.",
    roomId: "treasury",
    source: text(order.marketLabel || "Внешний рынок"),
    note: `фрахт ${whole(plan.freightCopper)}; пошлина ${whole(plan.tariffCopper)}; страховка ${whole(plan.insuranceCopper)}; партий ${orders.length}`,
    operationId: costOperationId
  }]);
  outbound.orders.push(...orders);
  outbound.orders = retainMarketOutboundOrders(outbound.orders);
  outbound.operationIds = [...new Set([...(outbound.operationIds ?? []), id])].slice(-120);
  outbound.updatedAt = text(createdAt);
  return { ok: true, replay: false, order, orders, batchCount: orders.length, demand, upfrontCopper };
}

export function dispatchMarketOutboundShipment({ holding, orderId = "", dispatchedAt = new Date().toISOString(), dependencies = {} } = {}) {
  const deps = requireFunctions(dependencies, ["appendStorageLog"]);
  if (!holding) return { ok: false, message: "Outbound shipment holding is unavailable." };
  const outbound = ensureOutboundState(holding);
  const order = orderById(outbound, orderId);
  if (!order) return { ok: false, message: "Outbound shipment is unavailable." };
  if (["cancelled", "lost", "delivered"].includes(text(order.status))) return { ok: false, message: "Terminal outbound shipment cannot be dispatched.", order };
  if (marketShipmentSchedule(order).isWaiting) return { ok: false, waiting: true, order, message: "Партия ожидает принятого срока отправления." };
  const result = dispatchOrder({ holding, order, dispatchedAt, dependencies: deps });
  outbound.updatedAt = text(dispatchedAt);
  return result;
}

export function cancelMarketOutboundShipment({ holding, orderId = "", cancelledAt = new Date().toISOString(), dependencies = {} } = {}) {
  const deps = requireFunctions(dependencies, ["addMoney", "appendStorageLog"]);
  if (!holding) return { ok: false, message: "Outbound shipment holding is unavailable." };
  const outbound = ensureOutboundState(holding);
  const order = orderById(outbound, orderId);
  if (!order) return { ok: false, message: "Outbound shipment is unavailable." };
  if (text(order.status) === "cancelled") return { ok: true, replay: true, order, refundCopper: whole(order.cancellationRefundCopper) };
  if (text(order.dispatchStatus || "booked") !== "booked" || text(order.dispatchedAt)) {
    return { ok: false, cancellable: false, order, message: "Outbound shipment has already departed." };
  }
  const operationId = text(order.cancellationOperationId) || `${order.operationId || order.id}:cancel`;
  const demand = settleOrderDemand({ holding, order, outcome: "restored", operationId: `${operationId}:demand`, at: cancelledAt });
  if (!demand.ok) return { ...demand, order, message: demand.message || "Outbound demand reservation could not be restored." };
  const refundCopper = whole(order.upfrontCopper);
  if (refundCopper > 0) deps.addMoney(holding, refundCopper);
  order.status = "cancelled";
  order.dispatchStatus = "cancelled";
  order.cancelledAt = text(cancelledAt);
  order.remainingQd = 0;
  order.delayRemainingQd = 0;
  order.riskStatus = "waived";
  order.riskOutcome = "waived";
  order.cancellationOperationId = operationId;
  order.cancellationRefundCopper = refundCopper;
  appendOperation(order, operationId);
  deps.appendStorageLog(holding, [{
    kind: "market-outbound-refund",
    resourceId: "money",
    name: "Возврат за отменённую исходящую поставку",
    qty: refundCopper,
    unit: "медн.",
    roomId: "treasury",
    source: text(order.marketLabel || "Внешний рынок"),
    note: `отмена до отправки ${order.operationId || order.id}; товар не покидал склад`,
    operationId
  }]);
  outbound.updatedAt = text(cancelledAt);
  return { ok: true, replay: false, order, operationId, refundCopper, demand };
}

export function resolveMarketOutboundShipmentRisk({
  holding,
  orderId = "",
  outcome = "proposal",
  delayQd = null,
  operationId = "",
  resolvedAt = new Date().toISOString(),
  dependencies = {}
} = {}) {
  const deps = requireFunctions(dependencies, ["addMoney", "appendStorageLog", "formatCurrency"]);
  if (!holding) return { ok: false, resolved: false, message: "Outbound shipment holding is unavailable." };
  const outbound = ensureOutboundState(holding);
  const order = orderById(outbound, orderId);
  if (!order) return { ok: false, resolved: false, message: "Outbound shipment risk event is unavailable." };
  const riskDependencies = order.ownShipId ? {
    ...deps,
    addMoney: (target, amount) => creditOwnShip(target, order, amount,
      `${order.operationId || order.id}:insurance`, "Страховая выплата за груз")
  } : deps;
  const risk = resolveMarketShipmentRisk({
    holding,
    order,
    outcome,
    delayQd,
    operationId,
    resolvedAt,
    dependencies: riskDependencies
  });
  if (!risk.ok) return risk;
  let demand = null;
  if (risk.outcome === "lost") {
    const demandOperationId = `${order.operationId || order.id}:demand-loss`;
    demand = settleOrderDemand({ holding, order, outcome: "restored", operationId: demandOperationId, at: resolvedAt });
    if (!demand.ok) return { ...risk, ok: false, demand, message: demand.message || "Lost outbound shipment could not restore market demand." };
  }
  let delivered = null;
  if (risk.outcome === "clear" && order.ownShipId && whole(order.remainingQd) === 0) {
    const ship = ownShipForOrder(holding, order);
    if (ship?.status === "away" && !ship.activeVoyage && ship.location?.kind === "market"
      && ship.location.regionId === order.marketId) {
      delivered = deliverOrder({ holding, order, deliveredAt: resolvedAt, dependencies: deps });
      if (!delivered.ok) return { ...risk, ok: false, delivered, message: delivered.message };
    }
  }
  appendOperation(order, risk.operationId);
  outbound.updatedAt = text(resolvedAt);
  return { ...risk, demand, delivered };
}

function deliverOrder({ holding, order, deliveredAt, currentTenday = null, dependencies }) {
  const demandOperationId = `${order.operationId || order.id}:demand-delivery`;
  ageMarketCargo(order, 0);
  const viableByDemand = new Map();
  for (const row of order.cargo ?? []) {
    const key = row.demandId || row.resourceId;
    viableByDemand.set(key, (viableByDemand.get(key) ?? 0) + cargoDeliveryQuantity(row));
  }
  const reservations = (order.demandReservations ?? []).map((row) => {
    const consumedQty = Math.min(row.qty, viableByDemand.get(row.demandId) ?? 0);
    viableByDemand.set(row.demandId, Math.max(0, (viableByDemand.get(row.demandId) ?? 0) - consumedQty));
    return { ...row, consumedQty };
  });
  const demand = settleOrderDemand({ holding, order, outcome: "consumed", operationId: demandOperationId, at: deliveredAt, currentTenday, reservations });
  if (!demand.ok) return { ok: false, order, demand, message: demand.message || "Outbound demand reservation could not be consumed." };
  const revenueCopper = Math.floor(whole(order.revenueCopper) * viableCargoValueRatio(order));
  order.actualRevenueCopper = revenueCopper;
  order.spoiledQty = (order.cargo ?? []).reduce((sum, row) => sum + whole(row.qty) - cargoDeliveryQuantity(row), 0);
  const revenueOperationId = text(order.revenueOperationId) || `${order.operationId || order.id}:revenue`;
  if (!text(order.revenueOperationId) && revenueCopper > 0) {
    if (order.ownShipId) creditOwnShip(holding, order, revenueCopper, revenueOperationId, "Продажа собственного груза");
    else dependencies.addMoney(holding, revenueCopper);
  }
  order.revenueOperationId = revenueOperationId;
  order.status = "delivered";
  order.dispatchStatus = "delivered";
  order.deliveredAt = text(deliveredAt);
  order.remainingQd = 0;
  if (order.riskStatus === "pending") {
    order.riskStatus = "waived";
    order.riskOutcome = "waived";
  }
  appendOperation(order, revenueOperationId);
  dependencies.appendStorageLog(holding, [{
    kind: "market-outbound-revenue",
    resourceId: "money",
    name: "Выручка исходящей поставки",
    qty: revenueCopper,
    unit: "медн.",
    roomId: order.ownShipId ? `ship:${order.ownShipId}` : "treasury",
    source: text(order.marketLabel || "Внешний рынок"),
    note: `поставка ${order.operationId || order.id} доставлена; испорчено ${order.spoiledQty} ед.; оплачен и потреблён только пригодный груз`,
    operationId: revenueOperationId
  }]);
  return { ok: true, order, operationId: revenueOperationId, revenueCopper, demand };
}

export function advanceMarketOutboundShipments({
  holding,
  elapsedQd = 0,
  currentTenday = null,
  advancedAt = new Date().toISOString(),
  dependencies = {}
} = {}) {
  const deps = requireFunctions(dependencies, ["addMoney", "appendStorageLog"]);
  if (!holding) return { ok: false, message: "Outbound shipment holding is unavailable." };
  const qd = whole(elapsedQd, 0, 100_000);
  const outbound = ensureOutboundState(holding);
  const report = { ok: true, advancedQd: qd, dispatched: [], delivered: [], inTransit: [], needsResolution: [], blocked: [], ignored: 0 };
  for (const order of outbound.orders) {
    if (["cancelled", "lost", "delivered"].includes(text(order.status))) {
      report.ignored += 1;
      continue;
    }
    const remainingBeforeAdvance = whole(order.remainingQd ?? order.deliveryQd);
    const ownShip = order.ownShipId ? ownShipForOrder(holding, order) : null;
    if (ownShip) {
      const flightRemainingQd = ownShip.activeVoyage
        ? whole(ownShip.activeVoyage.remainingQd ?? order.deliveryQd)
        : ownShip.location?.kind === "market" ? 0 : whole(order.remainingQd ?? order.deliveryQd);
      order.remainingQd = flightRemainingQd + whole(order.delayRemainingQd);
    }
    if (text(order.status) === "needsResolution" || text(order.riskStatus) === "needsResolution") {
      ageMarketCargo(order, qd);
      report.needsResolution.push({ orderId: order.id, proposal: order.riskProposal });
      continue;
    }
    if (!qd) {
      report.inTransit.push({ orderId: order.id, status: order.status, remainingQd: whole(order.remainingQd) });
      continue;
    }
    const schedule = marketShipmentSchedule(order);
    const waitingElapsedQd = Math.min(qd, schedule.waitingQd);
    const travelElapsedQd = qd - waitingElapsedQd;
    if (waitingElapsedQd > 0) {
      ageMarketCargo(order, waitingElapsedQd);
      order.remainingQd = schedule.remainingQd - waitingElapsedQd;
    }
    if (schedule.isWaiting && qd < schedule.waitingQd) {
      report.inTransit.push({ orderId: order.id, status: order.status, remainingQd: order.remainingQd, waitingQd: schedule.waitingQd - waitingElapsedQd });
      continue;
    }
    if (text(order.dispatchStatus || "booked") === "booked") {
      const dispatch = dispatchOrder({ holding, order, dispatchedAt: advancedAt, dependencies: deps });
      if (!dispatch.ok) {
        report.blocked.push({ orderId: order.id, stage: "dispatch", message: dispatch.message, stale: Boolean(dispatch.stale) });
        continue;
      }
      report.dispatched.push({ orderId: order.id, qty: dispatch.dispatchedQty });
    }
    if (travelElapsedQd > 0 && text(order.riskStatus) === "pending") {
      const risk = proposeMarketShipmentRisk({ order, proposedAt: advancedAt, elapsedQd: travelElapsedQd, dependencies: deps });
      if (risk.event) {
        report.needsResolution.push({ orderId: order.id, operationId: risk.operationId, proposal: risk.proposal, newEvent: !risk.replay });
        continue;
      }
    }
    ageMarketCargo(order, Math.min(travelElapsedQd, Math.max(0, remainingBeforeAdvance - waitingElapsedQd)));
    if (text(order.status) === "delayed") {
      order.delayRemainingQd = Math.max(0, whole(order.delayRemainingQd) - travelElapsedQd);
      if (!order.delayRemainingQd) order.status = "in-transit";
    }
    order.remainingQd = ownShip
      ? (ownShip.activeVoyage ? whole(ownShip.activeVoyage.remainingQd ?? order.deliveryQd) : 0) + whole(order.delayRemainingQd)
      : Math.max(0, whole(order.remainingQd ?? order.deliveryQd) - travelElapsedQd);
    if (order.remainingQd > 0) {
      report.inTransit.push({ orderId: order.id, status: order.status, remainingQd: order.remainingQd });
      continue;
    }
    if (order.ownShipId) {
      const ship = ownShipForOrder(holding, order);
      if (!ship || ship.status !== "away") {
        report.blocked.push({ orderId: order.id, stage: "arrival", message: "Собственный корабль поставки не найден." });
        continue;
      }
      if (ship.activeVoyage || ship.location?.kind !== "market" || ship.location.regionId !== order.marketId) {
        report.inTransit.push({ orderId: order.id, status: order.status, remainingQd: 0 });
        continue;
      }
    }
    const delivered = deliverOrder({ holding, order, deliveredAt: advancedAt, currentTenday, dependencies: deps });
    if (!delivered.ok) {
      report.blocked.push({ orderId: order.id, stage: "delivery", message: delivered.message, stale: Boolean(delivered.demand?.stale) });
      continue;
    }
    report.delivered.push({
      orderId: order.id,
      orderOperationId: order.operationId,
      operationId: delivered.operationId,
      marketId: order.marketId,
      marketLabel: order.marketLabel,
      revenueCopper: delivered.revenueCopper,
      ownShipId: order.ownShipId ?? "",
      demandQty: delivered.demand.qty
    });
  }
  outbound.orders = retainMarketOutboundOrders(outbound.orders);
  outbound.updatedAt = text(advancedAt);
  return report;
}
