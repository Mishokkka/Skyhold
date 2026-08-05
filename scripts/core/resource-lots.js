const EPSILON = 0.000001;

function finiteNonNegative(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : Math.max(0, Number(fallback) || 0);
}

function normalizedQd(value, fallback = 0) {
  return Math.max(0, Math.floor(finiteNonNegative(value, fallback)));
}

function normalizedShelfLifeDays(value, fallback = 0) {
  return Math.max(0, Math.floor(finiteNonNegative(value, fallback)));
}

export function resourceShelfLifeDaysForMode(row = {}, definition = {}) {
  const source = row && typeof row === "object" ? row : {};
  const fallback = definition && typeof definition === "object" ? definition : {};
  const mode = String(source.shelfLifeMode ?? fallback.shelfLifeMode ?? "").trim().toLowerCase();
  const tendays = Math.max(0, Math.floor(finiteNonNegative(source.shelfLifeTendays ?? fallback.shelfLifeTendays, 0)));
  if (mode === "tendays" && tendays > 0) return tendays * 10;
  return normalizedShelfLifeDays(source.shelfLifeDays ?? fallback.shelfLifeDays, 0);
}

function lotId(value = "", receivedQd = 0, index = 0) {
  const text = String(value ?? "").trim();
  return text || `lot-${receivedQd}-${index + 1}`;
}

export function normalizeResourceLot(raw = {}, {
  index = 0,
  defaultReceivedQd = 0,
  defaultShelfLifeDays = 0,
  defaultAgedThroughQd = null
} = {}) {
  const qty = finiteNonNegative(raw?.qty ?? raw?.quantity, 0);
  if (qty <= EPSILON) return null;
  const receivedQd = normalizedQd(raw?.receivedQd ?? raw?.acquiredQd, defaultReceivedQd);
  const shelfLifeDays = normalizedShelfLifeDays(raw?.shelfLifeDays, defaultShelfLifeDays);
  const fallbackAgedThroughQd = defaultAgedThroughQd === null
    ? receivedQd
    : Math.max(receivedQd, normalizedQd(defaultAgedThroughQd, receivedQd));
  const agedThroughQd = Math.max(receivedQd, normalizedQd(raw?.agedThroughQd, fallbackAgedThroughQd));
  const fallbackAgeDays = Math.max(0, (agedThroughQd - receivedQd) / 4);
  const ageDays = finiteNonNegative(raw?.ageDays, fallbackAgeDays);
  return {
    id: lotId(raw?.id, receivedQd, index),
    qty,
    receivedQd,
    shelfLifeDays,
    ageDays,
    agedThroughQd,
    source: String(raw?.source ?? "").trim()
  };
}

export function sortResourceLots(lots = []) {
  return [...(Array.isArray(lots) ? lots : [])].sort((left, right) => (
    normalizedQd(left?.receivedQd) - normalizedQd(right?.receivedQd)
    || String(left?.id ?? "").localeCompare(String(right?.id ?? ""))
  ));
}

export function mergeResourceLots(lots = []) {
  const merged = new Map();
  for (const lot of sortResourceLots(lots)) {
    const normalized = normalizeResourceLot(lot);
    if (!normalized) continue;
    const key = `${normalized.receivedQd}|${normalized.shelfLifeDays}|${normalized.ageDays}|${normalized.agedThroughQd}|${normalized.source}`;
    const current = merged.get(key);
    if (current) current.qty += normalized.qty;
    else merged.set(key, normalized);
  }
  return sortResourceLots([...merged.values()]);
}

export function splitResourceLots(lots = [], qty = 0) {
  let remaining = finiteNonNegative(qty, 0);
  const taken = [];
  const rest = [];
  for (const raw of sortResourceLots(lots)) {
    const lot = normalizeResourceLot(raw);
    if (!lot) continue;
    const take = Math.min(lot.qty, remaining);
    if (take > EPSILON) taken.push({ ...lot, qty: take });
    const left = lot.qty - take;
    if (left > EPSILON) rest.push({ ...lot, qty: left });
    remaining = Math.max(0, remaining - take);
  }
  return { taken, rest, missing: remaining };
}

export function normalizeResourceLots(row = {}, {
  currentQd = 0,
  shelfLifeDays = 0,
  seedMissing = true,
  agedThroughQd = null
} = {}) {
  const totalQty = finiteNonNegative(row?.qty ?? row?.quantity, 0);
  const lifeDays = normalizedShelfLifeDays(shelfLifeDays, 0);
  if (lifeDays <= 0 && !Array.isArray(row?.lots)) return [];
  let lots = mergeResourceLots((Array.isArray(row?.lots) ? row.lots : [])
    .map((lot, index) => normalizeResourceLot(lot, {
      index,
      defaultReceivedQd: currentQd,
      defaultShelfLifeDays: lifeDays,
      defaultAgedThroughQd: agedThroughQd
    }))
    .filter(Boolean));
  const tracked = lots.reduce((sum, lot) => sum + lot.qty, 0);
  if (tracked > totalQty + EPSILON) lots = splitResourceLots(lots, tracked - totalQty).rest;
  const reconciled = lots.reduce((sum, lot) => sum + lot.qty, 0);
  if (seedMissing && lifeDays > 0 && totalQty > reconciled + EPSILON) {
    const receivedQd = normalizedQd(currentQd, 0);
    lots.push({
      id: lotId("", receivedQd, lots.length),
      qty: totalQty - reconciled,
      receivedQd,
      shelfLifeDays: lifeDays,
      ageDays: 0,
      agedThroughQd: receivedQd,
      source: "legacy-or-direct"
    });
  }
  return mergeResourceLots(lots);
}

export function addResourceLot(row = {}, qty = 0, {
  currentQd = 0,
  shelfLifeDays = 0,
  source = "",
  lots = null
} = {}) {
  const amount = finiteNonNegative(qty, 0);
  if (amount <= EPSILON) return [];
  const existingQty = finiteNonNegative(row.qty, 0);
  const lifeDays = normalizedShelfLifeDays(shelfLifeDays, 0);
  row.lots = normalizeResourceLots(row, { currentQd, shelfLifeDays: lifeDays });
  let incoming = [];
  if (Array.isArray(lots) && lots.length) {
    incoming = splitResourceLots(lots, amount).taken;
  } else if (lifeDays > 0) {
    const receivedQd = normalizedQd(currentQd, 0);
    incoming = [{
      id: lotId("", receivedQd, row.lots.length),
      qty: amount,
      receivedQd,
      shelfLifeDays: lifeDays,
      ageDays: 0,
      agedThroughQd: receivedQd,
      source: String(source ?? "").trim()
    }];
  }
  row.qty = existingQty + amount;
  if (incoming.length) row.lots = mergeResourceLots([...row.lots, ...incoming]);
  if (!row.lots.length) delete row.lots;
  return incoming;
}

export function consumeResourceLots(row = {}, qty = 0, {
  currentQd = 0,
  shelfLifeDays = 0
} = {}) {
  const have = finiteNonNegative(row.qty, 0);
  const amount = Math.min(have, finiteNonNegative(qty, 0));
  if (amount <= EPSILON) return [];
  const lifeDays = normalizedShelfLifeDays(shelfLifeDays, 0);
  const lots = normalizeResourceLots(row, { currentQd, shelfLifeDays: lifeDays });
  const split = splitResourceLots(lots, amount);
  row.qty = Math.max(0, have - amount);
  row.lots = split.rest;
  if (!row.lots.length) delete row.lots;
  return split.taken;
}

export function resourceLotExpiryQd(lot = {}) {
  const lifeDays = normalizedShelfLifeDays(lot?.shelfLifeDays, 0);
  if (!lifeDays) return null;
  return normalizedQd(lot?.receivedQd, 0) + lifeDays * 4;
}

export function resourceLotExpiredAtQd(lot = {}, targetQd = 0, {
  fallbackShelfLifeDays = 0,
  storageQuality = 0
} = {}) {
  const lifeDays = normalizedShelfLifeDays(lot?.shelfLifeDays, fallbackShelfLifeDays);
  if (!lifeDays) return false;
  const effectiveLifeDays = storageQualityEffectiveShelfLifeDays(lifeDays, storageQuality);
  const receivedQd = normalizedQd(lot?.receivedQd, 0);
  const agedThroughQd = Math.max(receivedQd, normalizedQd(lot?.agedThroughQd, receivedQd));
  const projectedAgeDays = finiteNonNegative(lot?.ageDays, 0)
    + Math.max(0, normalizedQd(targetQd, agedThroughQd) - agedThroughQd) / 4;
  return projectedAgeDays + EPSILON >= Math.max(1, effectiveLifeDays);
}

export const STORAGE_QUALITY_SHELF_LIFE_PERIOD_DAYS = 10;

export function storageQualityShelfLifeBonusPeriods(quality = 0) {
  return Math.max(0, Math.floor(finiteNonNegative(quality, 0)));
}

export function storageQualityEffectiveShelfLifeDays(shelfLifeDays = 0, quality = 0) {
  const baseDays = normalizedShelfLifeDays(shelfLifeDays, 0);
  if (!baseDays) return 0;
  return baseDays + storageQualityShelfLifeBonusPeriods(quality) * STORAGE_QUALITY_SHELF_LIFE_PERIOD_DAYS;
}

/** Compatibility ratio derived from additive whole-tenday quality periods. */
export function storageQualityShelfLifeFactor(quality = 0, shelfLifeDays = STORAGE_QUALITY_SHELF_LIFE_PERIOD_DAYS) {
  const baseDays = Math.max(1, normalizedShelfLifeDays(shelfLifeDays, STORAGE_QUALITY_SHELF_LIFE_PERIOD_DAYS));
  return storageQualityEffectiveShelfLifeDays(baseDays, quality) / baseDays;
}

export function ageResourceLots(row = {}, {
  fromQd = 0,
  toQd = fromQd,
  shelfLifeDays = 0,
  storageQuality = 0
} = {}) {
  const lifeDays = normalizedShelfLifeDays(shelfLifeDays, 0);
  if (lifeDays <= 0) return { expired: [], expiredQty: 0, remainingQty: finiteNonNegative(row?.qty, 0), shelfLifeFactor: 1 };

  const startQd = normalizedQd(fromQd, 0);
  const targetQd = Math.max(startQd, normalizedQd(toQd, startQd));
  const shelfLifeBonusPeriods = storageQualityShelfLifeBonusPeriods(storageQuality);
  const effectiveShelfLifeDays = storageQualityEffectiveShelfLifeDays(lifeDays, storageQuality);
  const shelfLifeFactor = effectiveShelfLifeDays / Math.max(1, lifeDays);
  const lots = normalizeResourceLots(row, {
    currentQd: startQd,
    shelfLifeDays: lifeDays,
    agedThroughQd: startQd
  });
  const expired = [];
  const remaining = [];
  for (const lot of lots) {
    const agedThroughQd = Math.max(lot.receivedQd, Math.min(targetQd, normalizedQd(lot.agedThroughQd, lot.receivedQd)));
    const elapsedQd = Math.max(0, targetQd - agedThroughQd);
    const ageDays = finiteNonNegative(lot.ageDays, 0) + elapsedQd / 4;
    const aged = { ...lot, ageDays, agedThroughQd: targetQd };
    const lotEffectiveShelfLifeDays = storageQualityEffectiveShelfLifeDays(lot.shelfLifeDays || lifeDays, storageQuality);
    if (ageDays + EPSILON >= Math.max(1, lotEffectiveShelfLifeDays)) expired.push(aged);
    else remaining.push(aged);
  }

  const expiredQty = expired.reduce((sum, lot) => sum + lot.qty, 0);
  row.qty = Math.max(0, finiteNonNegative(row?.qty, 0) - expiredQty);
  row.lots = mergeResourceLots(remaining);
  if (!row.lots.length) delete row.lots;
  return { expired, expiredQty, remainingQty: row.qty, shelfLifeFactor, shelfLifeBonusPeriods, effectiveShelfLifeDays };
}
