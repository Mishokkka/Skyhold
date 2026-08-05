import { normalizeHoldingOperationLog } from "../operations.js";
import { normalizeEventArchive, normalizeEventSchedule, normalizeLastEventRoll } from "../event-automation.js";

export function normalizeEventHistory(rows = [], { limit = null } = {}) {
  const normalized = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      id: String(row?.id ?? row?.eventId ?? ""),
      tableId: String(row?.tableId ?? row?.kind ?? ""),
      title: String(row?.title ?? ""),
      createdAt: String(row?.createdAt ?? "")
    }))
    .filter((row) => row.id);
  return Number.isFinite(limit) ? normalized.slice(-Math.max(0, Math.floor(limit))) : normalized;
}

export { normalizeEventArchive, normalizeEventSchedule, normalizeHoldingOperationLog, normalizeLastEventRoll };
