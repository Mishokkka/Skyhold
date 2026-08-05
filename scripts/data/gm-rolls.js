// Compatibility facade for older imports. The GM tab now uses editable random
// event tables stored on each holding under gm.eventTables.
export {
  DEFAULT_RANDOM_EVENT_TABLES as GM_ROLLS,
  normalizeRandomEventTables,
  rollRandomEventTable
} from "./random-events.js";

export function gmRollEntry(table, result) {
  const rows = Array.isArray(table?.rows) ? table.rows : [];
  if (!rows.length) return "—";
  const index = Math.max(0, (Number(result) || 1) - 1) % rows.length;
  const row = rows[index];
  return [row?.title, row?.text, row?.effect].map((part) => String(part ?? "").trim()).filter(Boolean).join(" — ") || "—";
}
