import { mergeResourceLots, normalizeResourceLots, resourceLotExpiredAtQd, sortResourceLots } from "../../core/resource-lots.js";

const EPSILON = 0.000001;

function finiteNonNegative(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : Math.max(0, Number(fallback) || 0);
}

function text(value = "") {
  return String(value ?? "").trim();
}

function rowIndex(holding, row) {
  return (holding?.storage?.resources ?? []).indexOf(row);
}

function sourceMatchesRow(source, row, index) {
  const rowId = text(row?.id);
  const sourceId = text(source?.storageRowId);
  if (sourceId) return Boolean(rowId) && sourceId === rowId;
  return Number.isInteger(Number(source?.storageRowIndex)) && Number(source.storageRowIndex) === index;
}

export function activeStorageReservationForRow(holding = {}, row = {}, index = rowIndex(holding, row)) {
  const lots = new Map();
  let qty = 0;
  let untrackedQty = 0;
  for (const order of holding?.special?.market?.exportBook?.orders ?? []) {
    if (String(order?.status ?? "") !== "reserved") continue;
    for (const source of order?.sources ?? []) {
      if (!sourceMatchesRow(source, row, index)) continue;
      qty += finiteNonNegative(source?.qty, 0);
      untrackedQty += finiteNonNegative(source?.untrackedQty, 0);
      for (const lot of source?.lots ?? []) {
        const lotId = text(lot?.id);
        if (!lotId) continue;
        lots.set(lotId, finiteNonNegative(lots.get(lotId), 0) + finiteNonNegative(lot?.qty, 0));
      }
    }
  }
  return { qty, untrackedQty, lots };
}

export function storageReservedQuantity(holding = {}, row = {}, index = rowIndex(holding, row)) {
  return Math.min(finiteNonNegative(row?.qty, 0), activeStorageReservationForRow(holding, row, index).qty);
}

export function storageAvailableQuantity(holding = {}, row = {}, index = rowIndex(holding, row)) {
  return Math.max(0, finiteNonNegative(row?.qty, 0) - storageReservedQuantity(holding, row, index));
}

export function validateStorageRowQuantityChange(holding = {}, row = {}, nextQty = 0, index = rowIndex(holding, row)) {
  const numeric = Number(nextQty);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return { ok: false, code: "invalid-quantity", message: "Количество на складе должно быть неотрицательным числом." };
  }
  const reservedQty = activeStorageReservationForRow(holding, row, index).qty;
  if (numeric + EPSILON < reservedQty) {
    return {
      ok: false,
      code: "reserved-quantity",
      reservedQty,
      availableQty: storageAvailableQuantity(holding, row, index),
      message: `Нельзя уменьшить общий запас ниже экспортного резерва ${reservedQty}. Сначала отмени или отправь заказ.`
    };
  }
  return { ok: true, nextQty: numeric, reservedQty, availableQty: Math.max(0, numeric - reservedQty) };
}

export function setStorageRowTotalQuantity(holding = {}, row = {}, nextQty = 0, index = rowIndex(holding, row)) {
  const validation = validateStorageRowQuantityChange(holding, row, nextQty, index);
  if (!validation.ok) return validation;
  const currentQty = finiteNonNegative(row?.qty, 0);
  if (validation.nextQty + EPSILON < currentQty) {
    const requested = currentQty - validation.nextQty;
    const consumed = consumeAvailableStorageLots(holding, row, requested);
    const consumedQty = consumed.reduce((sum, lot) => sum + finiteNonNegative(lot?.qty, 0), 0);
    // Untracked stock is intentionally not returned as synthetic lots.
    const appliedQty = currentQty - finiteNonNegative(row?.qty, 0);
    if (Math.max(consumedQty, appliedQty) + EPSILON < requested) {
      return { ok: false, code: "reserved-quantity", message: "Свободного запаса недостаточно: часть количества зарезервирована для экспорта." };
    }
  } else if (validation.nextQty > currentQty + EPSILON) {
    row.qty = validation.nextQty;
  }
  if (Math.abs(finiteNonNegative(row?.qty, 0) - validation.nextQty) <= EPSILON) row.qty = validation.nextQty;
  return { ...validation, previousQty: currentQty, changed: Math.abs(currentQty - validation.nextQty) > EPSILON };
}

export function validateStorageRowDeletion(holding = {}, row = {}, index = rowIndex(holding, row)) {
  const reservedQty = activeStorageReservationForRow(holding, row, index).qty;
  if (reservedQty > EPSILON) {
    return {
      ok: false,
      code: "reserved-quantity",
      reservedQty,
      message: `Нельзя удалить строку: ${reservedQty} ед. зарезервировано для активного экспортного заказа.`
    };
  }
  return { ok: true, reservedQty: 0 };
}

export function deleteStorageResourceRow(holding = {}, index = -1) {
  const rows = Array.isArray(holding?.storage?.resources) ? holding.storage.resources : [];
  const rowIndex = Number(index);
  const row = Number.isInteger(rowIndex) && rowIndex >= 0 ? rows[rowIndex] : null;
  if (!row) return { ok: false, code: "row-not-found", message: "Строка склада больше не существует." };
  const allowed = validateStorageRowDeletion(holding, row, rowIndex);
  if (!allowed.ok) return allowed;
  rows.splice(rowIndex, 1);
  // Old export snapshots may identify a source by array index only. Rebase
  // those references atomically so deleting another row cannot retarget cargo.
  for (const order of holding?.special?.market?.exportBook?.orders ?? []) {
    if (String(order?.status ?? "") !== "reserved") continue;
    for (const source of order?.sources ?? []) {
      const sourceId = text(source?.storageRowId);
      if (sourceId) {
        const freshIndex = rows.findIndex((candidate) => text(candidate?.id) === sourceId);
        if (freshIndex >= 0) source.storageRowIndex = freshIndex;
        continue;
      }
      const sourceIndex = Number(source?.storageRowIndex);
      if (Number.isInteger(sourceIndex) && sourceIndex > rowIndex) source.storageRowIndex = sourceIndex - 1;
    }
  }
  return { ok: true, row, index: rowIndex };
}

export function storageAvailableUsableQuantity(holding = {}, row = {}, {
  currentQd = 0,
  shelfLifeDays = 0,
  usableAtQd = null,
  storageQuality = 0
} = {}) {
  const available = storageAvailableQuantity(holding, row);
  const targetQd = usableAtQd === null || usableAtQd === undefined ? null : Math.max(0, Math.floor(finiteNonNegative(usableAtQd, 0)));
  const lifeDays = Math.max(0, Math.floor(finiteNonNegative(shelfLifeDays, 0)));
  if (targetQd === null || lifeDays <= 0) return available;
  const reservation = activeStorageReservationForRow(holding, row);
  const lots = normalizeResourceLots(row, { currentQd, shelfLifeDays: lifeDays, seedMissing: false });
  const trackedQty = lots.reduce((sum, lot) => sum + finiteNonNegative(lot?.qty, 0), 0);
  const usableTracked = lots.reduce((sum, lot) => {
    if (resourceLotExpiredAtQd(lot, targetQd, { fallbackShelfLifeDays: lifeDays, storageQuality })) return sum;
    const reservedQty = Math.min(finiteNonNegative(lot?.qty, 0), finiteNonNegative(reservation.lots.get(text(lot?.id)), 0));
    return sum + Math.max(0, finiteNonNegative(lot?.qty, 0) - reservedQty);
  }, 0);
  const untrackedQty = Math.max(0, finiteNonNegative(row?.qty, 0) - trackedQty);
  const availableUntrackedQty = Math.max(0, untrackedQty - reservation.untrackedQty);
  const untrackedExpired = resourceLotExpiredAtQd({
    receivedQd: currentQd,
    agedThroughQd: currentQd,
    ageDays: 0,
    shelfLifeDays: lifeDays
  }, targetQd, { fallbackShelfLifeDays: lifeDays, storageQuality });
  return Math.min(available, usableTracked + (untrackedExpired ? 0 : availableUntrackedQty));
}

export function consumeAvailableStorageLots(holding = {}, row = {}, qty = 0, {
  currentQd = 0,
  shelfLifeDays = 0,
  usableAtQd = null,
  storageQuality = 0
} = {}) {
  const amount = Math.min(storageAvailableUsableQuantity(holding, row, {
    currentQd,
    shelfLifeDays,
    usableAtQd,
    storageQuality
  }), finiteNonNegative(qty, 0));
  if (amount <= EPSILON) return [];
  const reservation = activeStorageReservationForRow(holding, row);
  // Keep legacy/untracked stock untracked in the source row. Seeding the whole
  // balance here would turn an export's reserved untracked portion into a new
  // lot and make its concrete dispatch snapshot stale.
  const lots = normalizeResourceLots(row, { currentQd, shelfLifeDays, seedMissing: false });
  const trackedQty = lots.reduce((sum, lot) => sum + finiteNonNegative(lot?.qty, 0), 0);
  let remaining = amount;
  const taken = [];
  const retained = [];
  for (const lot of sortResourceLots(lots)) {
    const lotQty = finiteNonNegative(lot?.qty, 0);
    if (usableAtQd !== null && usableAtQd !== undefined && resourceLotExpiredAtQd(lot, usableAtQd, { fallbackShelfLifeDays: shelfLifeDays, storageQuality })) {
      retained.push({ ...lot, qty: lotQty });
      continue;
    }
    const reservedQty = Math.min(lotQty, finiteNonNegative(reservation.lots.get(text(lot?.id)), 0));
    const availableQty = Math.max(0, lotQty - reservedQty);
    const take = Math.min(availableQty, remaining);
    if (take > EPSILON) taken.push({ ...lot, qty: take });
    const left = lotQty - take;
    if (left > EPSILON) retained.push({ ...lot, qty: left });
    remaining = Math.max(0, remaining - take);
  }
  const untrackedQty = Math.max(0, finiteNonNegative(row?.qty, 0) - trackedQty);
  const availableUntrackedQty = Math.max(0, untrackedQty - reservation.untrackedQty);
  const untrackedExpired = usableAtQd !== null && usableAtQd !== undefined && resourceLotExpiredAtQd({
    receivedQd: currentQd,
    agedThroughQd: currentQd,
    ageDays: 0,
    shelfLifeDays
  }, usableAtQd, { fallbackShelfLifeDays: shelfLifeDays, storageQuality });
  const untrackedTake = Math.min(untrackedExpired ? 0 : availableUntrackedQty, remaining);
  if (untrackedTake > EPSILON && finiteNonNegative(shelfLifeDays, 0) > 0) {
    taken.push(...normalizeResourceLots({ qty: untrackedTake }, { currentQd, shelfLifeDays }));
  }
  remaining = Math.max(0, remaining - untrackedTake);
  const consumed = amount - remaining;
  row.qty = Math.max(0, finiteNonNegative(row?.qty, 0) - consumed);
  row.lots = mergeResourceLots(retained);
  if (!row.lots.length) delete row.lots;
  return taken;
}
