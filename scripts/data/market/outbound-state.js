import { savedMarketTransportPlanFields } from "./transport-plan.js";

export const MAX_ACTIVE_OUTBOUND_ORDERS = 300;
export const MAX_TERMINAL_OUTBOUND_ORDERS = 200;
const MAX_OPERATION_IDS = 120;
export const MAX_OUTBOUND_CARGO_ROWS = 1_000;

const ORDER_STATUSES = new Set([
  "booked",
  "in-transit",
  "delayed",
  "needsResolution",
  "delivered",
  "lost",
  "cancelled"
]);

const DISPATCH_STATUSES = new Set(["booked", "departed", "delivered", "lost", "cancelled"]);

function whole(value, fallback = 0, max = 1_000_000_000) {
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
  return Math.min(max, Math.max(0, normalized));
}

function decimal(value, fallback = 0, min = 0, max = 1_000_000_000) {
  const parsed = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
}

function text(value = "", limit = 500) {
  return String(value ?? "").trim().slice(0, limit);
}

function uniqueText(value = [], limit = MAX_OPERATION_IDS) {
  return [...new Set((Array.isArray(value) ? value : []).map((row) => text(row, 300)).filter(Boolean))].slice(-limit);
}

function cargoRows(value = []) {
  const rows = [];
  // Existing consignments are obligations, not a display cache. Never truncate their cargo.
  for (const raw of (Array.isArray(value) ? value : [])) {
    if (!raw || typeof raw !== "object") continue;
    const resourceId = text(raw.resourceId ?? raw.id, 300);
    const rowId = text(raw.rowId ?? raw.storageRowId, 300);
    const batchId = text(raw.batchId, 300);
    const qty = whole(raw.qty);
    if (!resourceId || !rowId || !batchId || !qty) continue;
    rows.push({
      resourceId,
      rowId,
      batchId,
      qty,
      reservedAgeQd: whole(raw.reservedAgeQd ?? raw.ageQd, 0, Number.MAX_SAFE_INTEGER),
      ageQd: whole(raw.ageQd ?? raw.reservedAgeQd, 0, Number.MAX_SAFE_INTEGER),
      ...(raw.shelfLifeQd !== undefined ? { shelfLifeQd: whole(raw.shelfLifeQd) } : {}),
      spoiledQty: Math.min(qty, whole(raw.spoiledQty)),
      demandId: text(raw.demandId ?? raw.resourceId, 500),
      lineId: text(raw.lineId, 300),
      name: text(raw.name, 500),
      unitPriceCopper: whole(raw.unitPriceCopper),
      cargoValueCopper: whole(raw.cargoValueCopper ?? (qty * whole(raw.unitPriceCopper)))
    });
  }
  return rows;
}

function demandRows(value = []) {
  const rows = [];
  for (const raw of (Array.isArray(value) ? value : [])) {
    if (!raw || typeof raw !== "object") continue;
    const marketId = text(raw.marketId, 300);
    const demandId = text(raw.demandId ?? raw.resourceId ?? raw.offerId, 500);
    const reservationOperationId = text(raw.reservationOperationId, 300);
    const qty = whole(raw.qty);
    if (!marketId || !demandId || !reservationOperationId || !qty) continue;
    rows.push({ marketId, demandId, reservationOperationId, qty, baseDemand: whole(raw.baseDemand, qty) });
  }
  return rows;
}

function normalizeOrder(raw = {}, index = 0) {
  const operationId = text(raw.operationId ?? raw.id ?? `outbound-${index + 1}`, 300);
  const id = text(raw.id ?? operationId, 300) || `outbound-${index + 1}`;
  const statusCandidate = text(raw.status, 40);
  const dispatchCandidate = text(raw.dispatchStatus, 40);
  const cargoReservations = cargoRows(raw.cargoReservations ?? raw.cargo);
  const cargo = cargoRows(raw.cargo ?? cargoReservations);
  return {
    ...raw,
    ...savedMarketTransportPlanFields(raw),
    id,
    operationId: operationId || id,
    ...(raw.ownShipId ? { ownShipId: text(raw.ownShipId, 128) } : {}),
    status: ORDER_STATUSES.has(statusCandidate) ? statusCandidate : "booked",
    dispatchStatus: DISPATCH_STATUSES.has(dispatchCandidate) ? dispatchCandidate : "booked",
    marketId: text(raw.marketId || "external-market", 300),
    marketLabel: text(raw.marketLabel || "Внешний рынок", 500),
    countryId: text(raw.countryId, 300),
    createdAt: text(raw.createdAt, 160),
    dispatchedAt: text(raw.dispatchedAt, 160),
    deliveredAt: text(raw.deliveredAt, 160),
    lostAt: text(raw.lostAt, 160),
    cancelledAt: text(raw.cancelledAt, 160),
    deliveryQd: whole(raw.deliveryQd, 1, 100_000),
    remainingQd: whole(raw.remainingQd ?? raw.deliveryQd, 1, 100_000),
    etaQd: whole(raw.etaQd ?? raw.deliveryQd, 1, 100_000),
    delayQd: whole(raw.delayQd, 0, 100_000),
    delayRemainingQd: whole(raw.delayRemainingQd, 0, 100_000),
    cargoReservations,
    cargo,
    demandReservations: demandRows(raw.demandReservations),
    buyerAllocations: Array.isArray(raw.buyerAllocations) ? [...raw.buyerAllocations] : [],
    revenueCopper: whole(raw.revenueCopper),
    freightCopper: whole(raw.freightCopper),
    tariffCopper: whole(raw.tariffCopper),
    insuranceCopper: whole(raw.insuranceCopper),
    upfrontCopper: whole(raw.upfrontCopper),
    insuredValueCopper: whole(raw.insuredValueCopper),
    insuranceCoverageRate: decimal(raw.insuranceCoverageRate, 0, 0, 1),
    maximumInsurancePayoutCopper: whole(raw.maximumInsurancePayoutCopper),
    insurancePayoutCopper: whole(raw.insurancePayoutCopper),
    riskFactor: decimal(raw.riskFactor, 1, 0.25, 4),
    riskLossChance: decimal(raw.riskLossChance, 0, 0, 0.08),
    riskDelayChance: decimal(raw.riskDelayChance, 0, 0, 0.45),
    riskMaxDelayQd: whole(raw.riskMaxDelayQd, 1, 20),
    historyOperationIds: uniqueText(raw.historyOperationIds)
  };
}

export function normalizeMarketOutboundState(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const rawOrders = Array.isArray(source.orders) ? source.orders : (Array.isArray(value) ? value : []);
  return {
    version: 1,
    orders: retainMarketOutboundOrders(rawOrders.map(normalizeOrder)),
    operationIds: uniqueText(source.operationIds),
    updatedAt: text(source.updatedAt, 160)
  };
}

export function retainMarketOutboundOrders(orders = [], archiveLimit = MAX_TERMINAL_OUTBOUND_ORDERS) {
  const terminal = new Set(["delivered", "lost", "cancelled"]);
  const rows = Array.isArray(orders) ? orders : [];
  const archived = rows.filter((order) => terminal.has(String(order?.status ?? "")));
  const limit = whole(archiveLimit, MAX_TERMINAL_OUTBOUND_ORDERS, MAX_TERMINAL_OUTBOUND_ORDERS);
  const keptArchive = new Set(limit > 0 ? archived.slice(-limit) : []);
  return rows.filter((order) => !terminal.has(String(order?.status ?? "")) || keptArchive.has(order));
}

export function activeMarketOutboundOrderCount(orders = []) {
  const terminal = new Set(["delivered", "lost", "cancelled"]);
  return (Array.isArray(orders) ? orders : [])
    .filter((order) => !terminal.has(String(order?.status ?? "")))
    .length;
}
