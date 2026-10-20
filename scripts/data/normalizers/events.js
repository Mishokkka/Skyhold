import { normalizeHoldingOperationLog } from "../operations.js";
import { normalizeEventArchive, normalizeEventSchedule, normalizeLastEventRoll } from "../event-automation.js";

export function normalizeEventHistory(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      id: String(row?.id ?? row?.eventId ?? ""),
      tableId: String(row?.tableId ?? row?.kind ?? ""),
      title: String(row?.title ?? ""),
      createdAt: String(row?.createdAt ?? "")
    }))
    .filter((row) => row.id)
    .slice(-80);
}

export { normalizeEventArchive, normalizeEventSchedule, normalizeHoldingOperationLog, normalizeLastEventRoll };
