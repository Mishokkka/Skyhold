const MAX_STOCK = 1_000_000_000;
const MAX_OPERATION_IDS = 80;

function boundedInteger(value, fallback = 0, min = 0, max = MAX_STOCK) {
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

export function marketStockKey(marketId = "", offerId = "") {
  return `${encodeURIComponent(String(marketId ?? "").trim())}::${encodeURIComponent(String(offerId ?? "").trim())}`;
}

export function marketStockRecoveryDuration(marketId = "", offerId = "") {
  return 2 + (stableSeed(`${marketId}|${offerId}|market-stock-recovery`) % 5);
}

// Compatibility alias for the first persistent-stock draft. The value is a
// complete recovery duration, not an interval between partial restocks.
export const marketStockRecoveryEvery = marketStockRecoveryDuration;

export function normalizeMarketStockState(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? (value.entries && typeof value.entries === "object" && !Array.isArray(value.entries) ? value.entries : value)
    : {};
  const result = {};
  // These are economic balances, not disposable history. Dropping a row would
  // reset exhausted stock and can discard references from an active shipment.
  for (const raw of Object.values(source)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const marketId = String(raw.marketId ?? "").trim().slice(0, 300);
    const offerId = String(raw.offerId ?? "").trim().slice(0, 500);
    if (!marketId || !offerId) continue;
    const baseStock = boundedInteger(raw.baseStock);
    const key = marketStockKey(marketId, offerId);
    const availableStock = Math.min(baseStock, boundedInteger(raw.availableStock, baseStock));
    const lastRecoveryTenday = boundedInteger(raw.lastRecoveryTenday);
    result[key] = {
      marketId,
      offerId,
      availableStock,
      baseStock,
      recoveryStartedTenday: boundedInteger(raw.recoveryStartedTenday, lastRecoveryTenday),
      recoveryStartStock: Math.min(baseStock, boundedInteger(raw.recoveryStartStock, availableStock)),
      recoveryDurationTendays: boundedInteger(
        raw.recoveryDurationTendays ?? raw.recoveryEveryTendays,
        marketStockRecoveryDuration(marketId, offerId),
        2,
        6
      ),
      lastRecoveryTenday,
      revision: boundedInteger(raw.revision, 0, 0, Number.MAX_SAFE_INTEGER),
      updatedAt: String(raw.updatedAt ?? "").slice(0, 160),
      reservationOperationIds: operationIds(raw.reservationOperationIds),
      restorationOperationIds: operationIds(raw.restorationOperationIds)
    };
  }
  return result;
}
