export const STORAGE_ROW_CHANGED = "Позиция склада изменилась. Откройте действие заново.";
export const DUPLICATE_STORAGE_ROW = "У нескольких позиций склада одинаковый ID. Требуется проверка сохранения.";

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
  const selected = new Map([...indexStorageRows(rows)].filter(([id]) => ids.has(id)));
  const matchedRows = [...selected.values()];
  if (matchedRows.includes(null)) return { message: DUPLICATE_STORAGE_ROW };
  if (selected.size !== ids.size) return { message: STORAGE_ROW_CHANGED };
  return { rows: matchedRows, byId: selected };
}
