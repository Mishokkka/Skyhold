import { clone, isPlainObject, makeId, toBoolean, toNumber } from "../utils.js";

export function normalizeStorageItemRow(row) {
  if (!row || typeof row !== "object") return null;
  const itemData = isPlainObject(row.itemData) ? clone(row.itemData) : {};
  const system = isPlainObject(itemData.system) ? itemData.system : (isPlainObject(row.system) ? clone(row.system) : {});
  const qty = Math.max(0, toNumber(row.qty ?? row.quantity ?? system.quantity ?? 1, 1));
  return {
    id: String(row.id || makeId("sitem")),
    name: String(row.name ?? itemData.name ?? "Предмет"),
    type: String(row.type ?? itemData.type ?? "gear"),
    img: String(row.img ?? itemData.img ?? "icons/svg/item-bag.svg"),
    qty,
    weight: String(row.weight ?? system.weight ?? ""),
    ...((row.cargoPoints ?? row.unitCargoPoints) === undefined || (row.cargoPoints ?? row.unitCargoPoints) === null || (row.cargoPoints ?? row.unitCargoPoints) === ""
      ? {}
      : { cargoPoints: Math.max(0, Math.ceil(toNumber(row.cargoPoints ?? row.unitCargoPoints, 0))) }),
    ...(String(row.cargoClass ?? "").trim() ? { cargoClass: String(row.cargoClass).trim() } : {}),
    roomId: String(row.roomId ?? row.storageRoomId ?? "outdoors") || "outdoors",
    sourceActorId: String(row.sourceActorId ?? ""),
    sourceActorName: String(row.sourceActorName ?? ""),
    itemUuid: String(row.itemUuid ?? ""),
    itemData: {
      ...itemData,
      name: String(itemData.name ?? row.name ?? "Предмет"),
      type: String(itemData.type ?? row.type ?? "gear"),
      img: String(itemData.img ?? row.img ?? "icons/svg/item-bag.svg"),
      system
    },
    notes: String(row.notes ?? ""),
    forSale: toBoolean(row.forSale ?? row.sale ?? row.markedForSale, false)
  };
}

export function normalizeStorageLogRow(row) {
  if (!row || typeof row !== "object") return null;
  return {
    id: String(row.id || makeId("slog")),
    ts: String(row.ts ?? row.createdAt ?? row.date ?? new Date().toISOString()),
    laputaDateText: String(row.laputaDateText ?? row.holdingDateText ?? ""),
    kind: String(row.kind ?? row.type ?? "manual"),
    resourceId: String(row.resourceId ?? row.resource ?? "custom"),
    name: String(row.name ?? row.resourceName ?? row.label ?? ""),
    qty: toNumber(row.qty ?? row.amount ?? 0, 0),
    roomId: String(row.roomId ?? row.storageRoomId ?? ""),
    source: String(row.source ?? ""),
    note: String(row.note ?? row.reason ?? ""),
    period: String(row.period ?? ""),
    operationId: String(row.operationId ?? "")
  };
}
