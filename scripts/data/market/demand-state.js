const MAX_DEMAND = 1_000_000_000;
const MAX_OPERATION_IDS = 80;
const MAX_RESERVATIONS = 300;

function boundedInteger(value, fallback = 0, min = 0, max = MAX_DEMAND) {
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
  return Math.min(max, Math.max(min, normalized));
}

function stableSeed(value = "") {
  let hash = 2166136261;
  for (const char of String(value ?? "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function operationIds(value = []) {
  const rows = Array.isArray(value) ? value : [];
  return [...new Set(rows.map((row) => String(row ?? "").trim()).filter(Boolean))].slice(-MAX_OPERATION_IDS);
}

function reservationRows(value = {}) {
  const source = Array.isArray(value) ? value : Object.values(value && typeof value === "object" ? value : {});
  const rows = {};
  for (const raw of source.slice(-MAX_RESERVATIONS)) {
    if (!raw || typeof raw !== "object") continue;
    const operationId = String(raw.operationId ?? raw.id ?? "").trim().slice(0, 300);
    const qty = boundedInteger(raw.qty);
    if (!operationId || !qty) continue;
    rows[operationId] = {
      operationId,
      qty,
      createdTenday: boundedInteger(raw.createdTenday),
      createdAt: String(raw.createdAt ?? "").slice(0, 160)
    };
  }
  return rows;
}

export function marketDemandKey(marketId = "", demandId = "") {
  return `${encodeURIComponent(String(marketId ?? "").trim())}::${encodeURIComponent(String(demandId ?? "").trim())}`;
}

export function marketDemandRecoveryDuration(marketId = "", demandId = "") {
  return 2 + (stableSeed(`${marketId}|${demandId}|market-demand-recovery`) % 5);
}

/** Dated partial sales share one recovery cohort per game-date/duration, not per FIFO lot. */
export function normalizeDemandRecoveryLots(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const qty = boundedInteger(row?.qty), startedTenday = boundedInteger(row?.startedTenday);
    const durationTendays = boundedInteger(row?.durationTendays, 2, 2, 6);
    if (!qty) continue;
    const key = `${startedTenday}:${durationTendays}`;
    const prior = groups.get(key);
    groups.set(key, { qty: boundedInteger(qty + (prior?.qty ?? 0)), startedTenday, durationTendays });
  }
  return [...groups.values()].sort((a, b) => a.startedTenday - b.startedTenday || a.durationTendays - b.durationTendays);
}

export function normalizeMarketDemandState(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? (value.entries && typeof value.entries === "object" && !Array.isArray(value.entries) ? value.entries : value)
    : {};
  const result = {};
  // Preserve every balance and reservation, including entries after the old
  // history cap. Normal loading must never discard shipment obligations.
  for (const raw of Object.values(source)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const marketId = String(raw.marketId ?? "").trim().slice(0, 300);
    const demandId = String(raw.demandId ?? raw.resourceId ?? raw.offerId ?? "").trim().slice(0, 500);
    if (!marketId || !demandId) continue;
    const baseDemand = boundedInteger(raw.baseDemand);
    const reservations = reservationRows(raw.reservations);
    const reservedDemand = Math.min(baseDemand, Object.values(reservations).reduce((sum, row) => sum + row.qty, 0));
    const consumedOutstanding = Math.min(baseDemand - reservedDemand, boundedInteger(raw.consumedOutstanding));
    const key = marketDemandKey(marketId, demandId);
    result[key] = {
      marketId,
      demandId,
      baseDemand,
      availableDemand: Math.max(0, baseDemand - reservedDemand - consumedOutstanding),
      reservedDemand,
      consumedOutstanding,
      ...(Array.isArray(raw.recoveryLots) ? { recoveryLots: normalizeDemandRecoveryLots(raw.recoveryLots) } : {}),
      reservations,
      recoveryStartedTenday: boundedInteger(raw.recoveryStartedTenday),
      recoveryStartConsumed: Math.min(baseDemand, boundedInteger(raw.recoveryStartConsumed, consumedOutstanding)),
      recoveryDurationTendays: boundedInteger(raw.recoveryDurationTendays, marketDemandRecoveryDuration(marketId, demandId), 2, 6),
      lastRecoveryTenday: boundedInteger(raw.lastRecoveryTenday),
      revision: boundedInteger(raw.revision, 0, 0, Number.MAX_SAFE_INTEGER),
      updatedAt: String(raw.updatedAt ?? "").slice(0, 160),
      reservationOperationIds: operationIds(raw.reservationOperationIds),
      consumptionOperationIds: operationIds(raw.consumptionOperationIds),
      restorationOperationIds: operationIds(raw.restorationOperationIds)
    };
  }
  return result;
}
