import { marketStateFor, writeMarketState, sharedMarketTenday } from "../../data/market/shared-context.js";
import { marketStockKey, marketStockRecoveryDuration, normalizeMarketStockState } from "../../data/market/stock-state.js";

function integer(value, fallback = 0, min = 0, max = 1_000_000_000) {
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
  return Math.min(max, Math.max(min, normalized));
}

function ensureMarketStock(holding, stock, tenday) {
  writeMarketState(holding, "stock", stock, tenday);
}

function sourceOfferId(offer = {}) {
  return String(offer.stockOfferId ?? offer.sourceOfferId ?? offer.id ?? "").trim();
}

function stockGroups(lines = [], marketId = "") {
  const groups = new Map();
  for (const line of lines ?? []) {
    const offerId = sourceOfferId(line);
    const qty = integer(line?.qty);
    if (!offerId || !qty) continue;
    const key = marketStockKey(marketId, offerId);
    const baseStock = integer(line.stockBaseStock ?? line.stockStateBaseStock ?? line.stock);
    const revision = integer(line.stockStateRevision, 0, 0, Number.MAX_SAFE_INTEGER);
    const previous = groups.get(key);
    if (previous) {
      previous.qty += qty;
      previous.baseStock = Math.max(previous.baseStock, baseStock);
      previous.revisions.add(revision);
    } else {
      groups.set(key, { key, marketId, offerId, qty, baseStock, revisions: new Set([revision]) });
    }
  }
  return [...groups.values()];
}

export function marketStockTendayIndex(holding = {}) {
  return sharedMarketTenday(holding);
}

export function marketStockPlanToken(lines = []) {
  const rows = new Map();
  for (const line of lines ?? []) {
    const key = String(line?.stockKey ?? "").trim();
    if (!key) continue;
    rows.set(key, {
      key,
      revision: integer(line.stockStateRevision, 0, 0, Number.MAX_SAFE_INTEGER),
      baseStock: integer(line.stockBaseStock)
    });
  }
  return JSON.stringify([...rows.values()].sort((left, right) => left.key.localeCompare(right.key)));
}

export function overlayMarketQuoteStock({ holding = {}, quote = {} } = {}) {
  const stock = normalizeMarketStockState(marketStateFor(holding, "stock"));
  const marketId = String(quote.marketId ?? "external-market");
  const offers = (quote.offers ?? []).map((offer) => {
    const offerId = sourceOfferId(offer);
    const key = marketStockKey(marketId, offerId);
    const baseStock = integer(offer.stock);
    const state = stock[key] ?? null;
    const availableStock = state ? Math.min(baseStock, state.availableStock) : baseStock;
    return {
      ...offer,
      stock: availableStock,
      stockKey: key,
      stockOfferId: offerId,
      stockBaseStock: baseStock,
      stockStateBaseStock: state?.baseStock ?? baseStock,
      stockStateAvailable: availableStock,
      stockStateRevision: state?.revision ?? 0,
      stockStateInitialized: Boolean(state)
    };
  });
  return { ...quote, offers };
}

export function reserveMarketStock({ holding = null, marketId = "", lines = [], operationId = "", currentTenday = null, updatedAt = "" } = {}) {
  const id = String(operationId ?? "").trim();
  const resolvedMarketId = String(marketId ?? "").trim();
  if (!holding || !resolvedMarketId || !id) return { ok: false, message: "Market stock reservation requires holding, market and operation ids." };
  const groups = stockGroups(lines, resolvedMarketId);
  if (!groups.length) return { ok: false, empty: true, message: "Market stock reservation is empty." };
  if (groups.some((row) => row.revisions.size !== 1)) return { ok: false, stale: true, message: "Market stock revisions disagree inside one offer." };

  const stock = normalizeMarketStockState(marketStateFor(holding, "stock"));
  const replayRows = groups.filter((row) => stock[row.key]?.reservationOperationIds?.includes(id));
  if (replayRows.length) {
    if (replayRows.length !== groups.length) return { ok: false, stale: true, message: "Market stock reservation is only partially applied." };
    return { ok: true, replay: true, reservations: groups.map((row) => ({ marketId: row.marketId, offerId: row.offerId, qty: row.qty, baseStock: stock[row.key].baseStock })) };
  }

  const prepared = [];
  const tenday = sharedMarketTenday(holding, currentTenday);
  for (const group of groups) {
    const existing = stock[group.key] ?? null;
    const expectedRevision = [...group.revisions][0];
    if ((existing?.revision ?? 0) !== expectedRevision) return { ok: false, stale: true, key: group.key, message: "Market stock changed after quote preview." };
    const baseStock = group.baseStock;
    const availableStock = existing ? Math.min(baseStock, existing.availableStock) : baseStock;
    if (group.qty > availableStock) return { ok: false, insufficient: true, key: group.key, requested: group.qty, availableStock, message: "Market stock is insufficient." };
    prepared.push({ group, existing, baseStock, availableStock });
  }

  const reservations = [];
  for (const row of prepared) {
    const previous = row.existing ?? {};
    const reservationOperationIds = [...new Set([...(previous.reservationOperationIds ?? []), id])].slice(-80);
    const availableStock = row.availableStock - row.group.qty;
    stock[row.group.key] = {
      marketId: row.group.marketId,
      offerId: row.group.offerId,
      availableStock,
      baseStock: row.baseStock,
      recoveryStartedTenday: tenday,
      recoveryStartStock: availableStock,
      recoveryDurationTendays: previous.recoveryDurationTendays ?? marketStockRecoveryDuration(row.group.marketId, row.group.offerId),
      lastRecoveryTenday: tenday,
      revision: integer(previous.revision, 0, 0, Number.MAX_SAFE_INTEGER - 1) + 1,
      updatedAt: String(updatedAt ?? ""),
      reservationOperationIds,
      restorationOperationIds: previous.restorationOperationIds ?? []
    };
    reservations.push({ marketId: row.group.marketId, offerId: row.group.offerId, qty: row.group.qty, baseStock: row.baseStock, reservationOperationId: id });
  }
  ensureMarketStock(holding, stock, tenday);
  return { ok: true, replay: false, reservations };
}

export function restoreMarketStockReservations({ holding = null, reservations = [], operationId = "", currentTenday = null, updatedAt = "" } = {}) {
  const id = String(operationId ?? "").trim();
  if (!holding || !id) return { ok: false, message: "Market stock restoration requires holding and operation ids." };
  const grouped = new Map();
  for (const reservation of reservations ?? []) {
    const marketId = String(reservation?.marketId ?? "").trim();
    const offerId = String(reservation?.offerId ?? "").trim();
    const qty = integer(reservation?.qty);
    if (!marketId || !offerId || !qty) continue;
    const key = marketStockKey(marketId, offerId);
    const previous = grouped.get(key);
    if (previous) previous.qty += qty;
    else grouped.set(key, { key, marketId, offerId, qty, baseStock: integer(reservation.baseStock, qty) });
  }
  const rows = [...grouped.values()];
  if (!rows.length) return { ok: true, replay: true, restoredQty: 0, rows: [] };
  const stock = normalizeMarketStockState(marketStateFor(holding, "stock"));
  const replayRows = rows.filter((row) => stock[row.key]?.restorationOperationIds?.includes(id));
  if (replayRows.length) {
    if (replayRows.length !== rows.length) return { ok: false, stale: true, message: "Market stock restoration is only partially applied." };
    return { ok: true, replay: true, restoredQty: 0, rows: [] };
  }

  const tenday = sharedMarketTenday(holding, currentTenday);
  const restored = [];
  for (const row of rows) {
    const previous = stock[row.key] ?? {
      marketId: row.marketId,
      offerId: row.offerId,
      availableStock: 0,
      baseStock: row.baseStock,
      recoveryStartedTenday: tenday,
      recoveryStartStock: 0,
      recoveryDurationTendays: marketStockRecoveryDuration(row.marketId, row.offerId),
      lastRecoveryTenday: tenday,
      revision: 0,
      reservationOperationIds: [],
      restorationOperationIds: []
    };
    const baseStock = Math.max(previous.baseStock, row.baseStock);
    const availableStock = Math.min(baseStock, previous.availableStock + row.qty);
    const restoredQty = availableStock - previous.availableStock;
    stock[row.key] = {
      ...previous,
      availableStock,
      baseStock,
      revision: integer(previous.revision, 0, 0, Number.MAX_SAFE_INTEGER - 1) + 1,
      updatedAt: String(updatedAt ?? ""),
      restorationOperationIds: [...new Set([...(previous.restorationOperationIds ?? []), id])].slice(-80)
    };
    restored.push({ marketId: row.marketId, offerId: row.offerId, qty: restoredQty, baseStock });
  }
  ensureMarketStock(holding, stock, tenday);
  return { ok: true, replay: false, restoredQty: restored.reduce((sum, row) => sum + row.qty, 0), rows: restored };
}

export function recoverMarketStock({ holding = null, currentTenday = null, baseStockByKey = null, updatedAt = "" } = {}) {
  if (!holding) return { ok: false, message: "Market stock recovery requires a holding." };
  const tenday = sharedMarketTenday(holding, currentTenday);
  const stock = normalizeMarketStockState(marketStateFor(holding, "stock"));
  const recovered = [];
  let changed = false;
  const capFor = (key, row) => {
    const supplied = baseStockByKey instanceof Map ? baseStockByKey.get(key) : baseStockByKey?.[key];
    return supplied === undefined || supplied === null ? row.baseStock : integer(supplied);
  };
  for (const [key, row] of Object.entries(stock).sort(([left], [right]) => left.localeCompare(right))) {
    const baseStock = capFor(key, row);
    let availableStock = Math.min(baseStock, row.availableStock);
    const duration = integer(row.recoveryDurationTendays, marketStockRecoveryDuration(row.marketId, row.offerId), 2, 6);
    const recoveryStartedTenday = integer(row.recoveryStartedTenday, row.lastRecoveryTenday);
    const recoveryStartStock = Math.min(baseStock, integer(row.recoveryStartStock, availableStock));
    const elapsed = Math.max(0, tenday - recoveryStartedTenday);
    const progress = Math.min(1, elapsed / duration);
    const targetStock = Math.min(baseStock, Math.floor(recoveryStartStock + (baseStock - recoveryStartStock) * progress));
    const recoveredQty = Math.max(0, targetStock - availableStock);
    availableStock = Math.max(availableStock, targetStock);
    const nextRecoveryTenday = recoveredQty > 0 ? tenday : row.lastRecoveryTenday;
    if (availableStock === row.availableStock
      && baseStock === row.baseStock
      && nextRecoveryTenday === row.lastRecoveryTenday
      && duration === row.recoveryDurationTendays) continue;
    stock[key] = {
      ...row,
      availableStock,
      baseStock,
      recoveryStartedTenday,
      recoveryStartStock,
      lastRecoveryTenday: nextRecoveryTenday,
      recoveryDurationTendays: duration,
      revision: integer(row.revision, 0, 0, Number.MAX_SAFE_INTEGER - 1) + 1,
      updatedAt: String(updatedAt ?? "")
    };
    changed = true;
    if (recoveredQty > 0) recovered.push({ key, marketId: row.marketId, offerId: row.offerId, qty: recoveredQty, availableStock, baseStock });
  }
  if (changed) ensureMarketStock(holding, stock, tenday);
  return { ok: true, changed, currentTenday: tenday, recoveredQty: recovered.reduce((sum, row) => sum + row.qty, 0), recovered };
}
