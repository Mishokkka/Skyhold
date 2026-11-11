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
