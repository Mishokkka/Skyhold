export const STORAGE_ROW_CHANGED = "Позиция склада изменилась. Откройте действие заново.";
export const DUPLICATE_STORAGE_ROW = "У нескольких позиций склада одинаковый ID. Требуется проверка сохранения.";
export const MAX_STORAGE_BATCH_ROWS = 200;
export const STORAGE_BATCH_TOO_LARGE = `За раз можно переместить до ${MAX_STORAGE_BATCH_ROWS} позиций. Разделите выбор на несколько пакетов.`;

/** Keep ambiguous saved IDs distinguishable from missing rows. */
export function indexStorageRows(rows) {
  const index = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.id ?? "");
    if (id) index.set(id, index.has(id) ? null : row);
  }
  return index;
}

export function resolveStorageRow(rows, rowId) {
  const row = indexStorageRows(rows).get(String(rowId ?? ""));
  if (row) return { row };
  return { row: null, message: row === null ? DUPLICATE_STORAGE_ROW : STORAGE_ROW_CHANGED };
}

/** Resolve a whole selection in storage order, rejecting missing or ambiguous IDs. */
export function resolveStorageRows(rows, rowIds) {
  const ids = new Set(rowIds);
  if (ids.size > MAX_STORAGE_BATCH_ROWS) return { message: STORAGE_BATCH_TOO_LARGE };
  const selected = new Map([...indexStorageRows(rows)].filter(([id]) => ids.has(id)));
  const matchedRows = [...selected.values()];
  if (matchedRows.includes(null)) return { message: DUPLICATE_STORAGE_ROW };
  if (selected.size !== ids.size) return { message: STORAGE_ROW_CHANGED };
  return { rows: matchedRows, byId: selected };
}

export function storageLotKey(rowId, batchId) {
  return JSON.stringify([String(rowId ?? "").trim(), String(batchId ?? "").trim()]);
}

/** Keep physical sources distinct even when legacy rows reuse saved identifiers. */
export function indexStorageLots(rows, onlyRowId = "") {
  const index = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const rowId = String(row?.id ?? "").trim();
    if (!rowId || onlyRowId && rowId !== onlyRowId) continue;
    if (!index.has(rowId)) index.set(rowId, { materials: new Set(), batches: new Map() });
    const { materials, batches } = index.get(rowId);
    materials.add(String(row.resourceId ?? row.id).trim());
    for (const batch of Array.isArray(row.batches) ? row.batches : []) {
      const batchId = String(batch?.id ?? "").trim();
      if (!batchId) continue;
      if (!batches.has(batchId)) batches.set(batchId, []);
      batches.get(batchId).push({ row, batch });
    }
  }
  return index;
}

/** Contracts that recorded different materials for one pair require that discriminator in every run. */
export function conflictingStorageLotKeys(cargo = []) {
  const materialByKey = new Map();
  const conflicts = new Set();
  for (const lot of cargo ?? []) {
    const rowId = String(lot?.rowId ?? lot?.storageRowId ?? "").trim();
    const batchId = String(lot?.batchId ?? "").trim();
    const material = String(lot?.resourceId ?? "").trim();
    if (!rowId || !batchId || !material) continue;
    const key = storageLotKey(rowId, batchId);
    const previous = materialByKey.get(key);
    if (previous && previous !== material) conflicts.add(key);
    else materialByKey.set(key, material);
  }
  return conflicts;
}

/** A unique pair survives catalog renames. A known collision requires the frozen material ID. */
export function matchingStorageLots(index, cargo, conflicts) {
  const rowId = String(cargo?.rowId ?? cargo?.storageRowId ?? "").trim();
  const batchId = String(cargo?.batchId ?? "").trim();
  const entry = index.get(rowId);
  const lots = entry?.batches.get(batchId) ?? [];
  const resourceId = String(cargo?.resourceId ?? "").trim();
  const materialRequired = Boolean(resourceId && entry?.materials.has(resourceId)
    || conflicts?.has(storageLotKey(rowId, batchId)));
  const matches = materialRequired || lots.length > 1 && resourceId
    ? lots.filter(({ row }) => String(row.resourceId ?? row.id).trim() === resourceId)
    : lots;
  return { matches, materialRequired };
}
