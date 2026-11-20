import { storageResourceId, isStorageMoneyResource, resourceLabel } from "../core/resources.js";
import { normalizeStorageRoomId } from "../engines/storage/capacity.js";
import { makeId, toNumber } from "./utils.js";

export const BUILDING_DEMOLITION_LOG_SOURCE = "Снос здания";

export function appendStorageLogEntries(holding, entries) {
  holding.storage ??= { notes: "", resources: [], moneyCopper: 0, log: [] };
  if (!Array.isArray(holding.storage.log)) holding.storage.log = [];
  const now = new Date().toISOString();
  const laputaDateText = String(holding.gm?.calendaria?.lastDateText ?? holding.gm?.calendaria?.lastDateKey ?? "").trim();
  for (const raw of entries) {
    const qty = Math.trunc(toNumber(raw?.qty, 0));
    if (!qty && raw?.kind !== "note") continue;
    const resourceId = storageResourceId(raw);
    const name = resourceId === "custom" ? String(raw?.name ?? "Ресурс") : resourceLabel(resourceId);
    const roomId = isStorageMoneyResource(raw) ? "" : normalizeStorageRoomId(raw?.roomId ?? raw?.storageRoomId);
    holding.storage.log.push({
      id: makeId("slog", 12),
      ts: raw?.ts ?? now,
      laputaDateText: String(raw?.laputaDateText ?? raw?.holdingDateText ?? laputaDateText),
      kind: String(raw?.kind ?? "manual"),
      resourceId,
      name,
      qty,
      roomId,
      source: String(raw?.source ?? ""),
      note: String(raw?.note ?? ""),
      period: String(raw?.period ?? ""),
      operationId: String(raw?.operationId ?? "")
    });
  }
  holding.storage.log = holding.storage.log.slice(-250);
}
