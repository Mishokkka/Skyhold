import { toNumber } from "../data/utils.js";

export function normalizeStorageRoomId(value = "outdoors") {
  const id = String(value ?? "").trim();
  return id || "outdoors";
}

export function storageUnitLoad(resource = {}) {
  const candidates = [
    resource.load,
    resource.weight,
    resource.system?.weight,
    resource.system?.weight?.value,
    resource.item?.system?.weight,
    resource.item?.system?.weight?.value,
    resource.itemData?.system?.weight,
    resource.itemData?.system?.weight?.value
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === "") continue;
    const text = String(candidate).trim().toLowerCase().replace(",", ".");
    if (["tiny", "negligible", "невесомый", "ничтожный"].includes(text)) return 0;
    if (["light", "легкий", "лёгкий"].includes(text)) return 0.5;
    if (["normal", "обычный"].includes(text)) return 1;
    if (["heavy", "тяжелый", "тяжёлый"].includes(text)) return 2;
    const value = Number(text);
    if (Number.isFinite(value)) return Math.max(0, value);
  }
  return 1;
}

export function storageRowLoad(row = {}) {
  const qty = Math.max(0, toNumber(row?.qty ?? row?.quantity ?? row?.count, 0));
  return qty * storageUnitLoad(row);
}

export function storageFillClass({ capacity = 0, used = 0, unlimited = false } = {}) {
  const cap = Math.max(0, toNumber(capacity, 0));
  const load = Math.max(0, toNumber(used, 0));
  if (unlimited || cap <= 0) return "unlimited-capacity";
  if (load + 0.0001 >= cap) return "full-capacity";
  if (load / cap >= 0.75) return "near-capacity";
  return "ok-capacity";
}

export function decorateStorageRoom(room = {}, { formatLoad = (value) => String(value) } = {}) {
  const capacity = Math.max(0, toNumber(room.capacity, 0));
  const used = Math.max(0, toNumber(room.used, 0));
  const unlimited = Boolean(room.unlimited || capacity <= 0);
  const free = unlimited ? Infinity : Math.max(0, capacity - used);
  const fillPercent = unlimited ? 0 : Math.max(0, Math.min(100, Math.round((used / Math.max(1, capacity)) * 100)));
  const fillClass = storageFillClass({ capacity, used, unlimited });
  return {
    ...room,
    capacity,
    used,
    free: Number.isFinite(free) ? free : 0,
    usedText: formatLoad(used),
    freeText: unlimited ? "∞" : formatLoad(free),
    capacityText: unlimited ? "∞" : formatLoad(capacity),
    fillPercent,
    fillClass,
    fillTitle: unlimited ? "Без лимита" : `Заполнено ${fillPercent}%`,
    nearCapacity: fillClass === "near-capacity",
    fullCapacity: fillClass === "full-capacity",
    overCapacity: !unlimited && used > capacity
  };
}
