import { ageResourceLots, resourceShelfLifeDaysForMode } from "../../core/resource-lots.js";
import { normalizeRationBuffer } from "../../data/ration-buffer.js";
import { effectiveConsumerRationPoints } from "../resource-ration-points.js";
import { applyStorageOverflow } from "./overflow.js";

function finiteNonNegative(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : Math.max(0, Number(fallback) || 0);
}

export function applyStorageSpoilage({
  holding,
  fromQd = 0,
  toQd = fromQd,
  resourceDefinitions = [],
  rooms = []
} = {}) {
  if (!holding || typeof holding !== "object") throw new TypeError("storage spoilage requires a holding draft");
  const definitions = new Map((Array.isArray(resourceDefinitions) ? resourceDefinitions : [])
    .map((row) => [String(row?.id ?? row?.resourceId ?? ""), row])
    .filter(([id]) => id));
  const roomIndex = new Map((Array.isArray(rooms) ? rooms : [])
    .map((room) => [String(room?.id ?? "outdoors") || "outdoors", room]));
  const rows = [];

  for (const resource of holding?.storage?.resources ?? []) {
    const resourceId = String(resource?.resourceId ?? resource?.id ?? "");
    const definition = definitions.get(resourceId) ?? {};
    const shelfLifeDays = resourceShelfLifeDaysForMode(resource, definition);
    if (!shelfLifeDays) continue;
    const roomId = String(resource?.roomId ?? resource?.storageRoomId ?? "outdoors") || "outdoors";
    const room = roomIndex.get(roomId) ?? roomIndex.get("outdoors") ?? {};
    const storageQuality = finiteNonNegative(room?.quality, 0);
    const result = ageResourceLots(resource, { fromQd, toQd, shelfLifeDays, storageQuality });
    if (result.expiredQty <= 0) continue;
    const foodValue = effectiveConsumerRationPoints(resource, definition);
    rows.push({
      resourceId,
      name: String((resource?.name ?? definition?.label ?? resourceId) || "Ресурс"),
      unit: String(resource?.unit ?? definition?.unitLabel ?? definition?.unit ?? "ед."),
      qty: result.expiredQty,
      foodPersonDays: result.expiredQty * foodValue,
      roomId,
      roomLabel: String(room?.label ?? roomId),
      storageQuality,
      shelfLifeDays,
      shelfLifeFactor: result.shelfLifeFactor,
      shelfLifeBonusPeriods: result.shelfLifeBonusPeriods,
      effectiveShelfLifeDays: result.effectiveShelfLifeDays,
      expiredLots: result.expired
    });
  }

  if (!holding.storage || typeof holding.storage !== "object" || Array.isArray(holding.storage)) holding.storage = {};
  const rationBuffer = normalizeRationBuffer(holding.storage.rationBuffer);
  const retainedBufferEntries = [];
  const targetQd = Math.max(0, Math.floor(Number(toQd) || 0));
  for (const entry of rationBuffer.entries) {
    if (!entry.expiresQd || targetQd < entry.expiresQd) {
      retainedBufferEntries.push(entry);
      continue;
    }
    const roomId = String(entry.sourceRoomId || "outdoors");
    const room = roomIndex.get(roomId) ?? roomIndex.get("outdoors") ?? {};
    rows.push({
      kind: "ration-buffer",
      resourceId: entry.resourceId,
      name: entry.name,
      unit: "рац.",
      qty: entry.points,
      foodPersonDays: entry.points,
      roomId,
      roomLabel: String(room?.label ?? roomId),
      storageQuality: 0,
      shelfLifeDays: entry.shelfLifeDays,
      shelfLifeTendays: entry.shelfLifeTendays,
      shelfLifeFactor: 1,
      openedQd: entry.openedQd,
      expiresQd: entry.expiresQd,
      sourceRowId: entry.sourceRowId,
      expiredLots: []
    });
  }
  rationBuffer.entries = retainedBufferEntries;
  holding.storage.rationBuffer = rationBuffer;
  const overflow = applyStorageOverflow({ holding, fromQd, toQd, resourceDefinitions, rooms });
  rows.push(...overflow.rows);

  return {
    fromQd: Math.max(0, Math.floor(Number(fromQd) || 0)),
    toQd: Math.max(0, Math.floor(Number(toQd) || 0)),
    rows,
    totalQty: rows.reduce((sum, row) => sum + row.qty, 0),
    bufferRationPoints: rows.filter((row) => row.kind === "ration-buffer").reduce((sum, row) => sum + row.qty, 0),
    foodPersonDays: rows.reduce((sum, row) => sum + row.foodPersonDays, 0),
    hasLosses: rows.length > 0,
    overflow
  };
}

export function storageSpoilageLedgerRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    domain: "system",
    kind: row.kind === "ration-buffer" ? "ration-buffer" : "resource",
    resourceId: row.resourceId,
    name: row.name,
    qty: -row.qty,
    unit: row.unit,
    roomId: row.roomId,
    source: row.kind === "ration-buffer" ? "Буфер открытых рационов" : (String(row.kind ?? "").startsWith("overflow-") ? "Переполнение склада" : "Хранение"),
    note: row.kind === "ration-buffer"
      ? `Порча открытых рационов; открыт QD ${row.openedQd}; истёк QD ${row.expiresQd}.`
      : (String(row.kind ?? "").startsWith("overflow-")
        ? `${row.lossKind === "theft" ? "Кража" : (row.lossKind === "spoilage" ? "Порча" : "Потеря")} после отсрочки переполнения; безопасность ${row.storageSecurity}; класс ${row.cargoClass || row.unitCargoPoints}.`
        : `Порча; качество ${row.storageQuality}; базовый срок ${row.shelfLifeDays} дн.; добавлено периодов ${row.shelfLifeBonusPeriods ?? 0}.`),
    meta: {
      storageKind: "spoilage",
      overflow: String(row.kind ?? "").startsWith("overflow-"),
      lossKind: row.lossKind ?? "",
      shelfLifeFactor: row.shelfLifeFactor,
      rationBuffer: row.kind === "ration-buffer",
      sourceRowId: row.sourceRowId ?? "",
      expiresQd: row.expiresQd ?? 0
    }
  }));
}
