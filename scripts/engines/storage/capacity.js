function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const LEGACY_STORAGE_LOAD_TO_CARGO_POINTS = 10;
export const DEFAULT_OUTDOOR_SAFE_CAPACITY_CARGO_POINTS = 1000;

export function normalizeStorageRoomId(value = "outdoors") {
  const id = String(value ?? "").trim();
  return id || "outdoors";
}

export function storageUnitLoad(resource = {}) {
  const explicitCargoPoints = resource.cargoPoints ?? resource.unitCargoPoints;
  if (explicitCargoPoints !== undefined && explicitCargoPoints !== null && explicitCargoPoints !== "") {
    return Math.max(0, Math.ceil(toNumber(explicitCargoPoints, 0) - Number.EPSILON));
  }
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
    if (["light", "легкий", "лёгкий"].includes(text)) return 5;
    if (["normal", "обычный"].includes(text)) return 10;
    if (["heavy", "тяжелый", "тяжёлый"].includes(text)) return 20;
    const value = Number(text);
    if (Number.isFinite(value)) return Math.max(0, Math.ceil(value * LEGACY_STORAGE_LOAD_TO_CARGO_POINTS - Number.EPSILON));
  }
  return 10;
}

export function storageCapacityCargoPoints(storage = {}) {
  const explicit = storage?.capacityCargoPoints;
  if (explicit !== undefined && explicit !== null && explicit !== "") {
    return Math.max(0, Math.floor(toNumber(explicit, 0)));
  }
  return Math.max(0, toNumber(storage?.capacity, 0) * LEGACY_STORAGE_LOAD_TO_CARGO_POINTS);
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

export function buildStorageRooms({ holding, includeUnavailable = true, dependencies } = {}) {
  const deps = dependencies ?? {};
  const required = ["isMoneyResource", "safeNumber", "buildingFunctions", "buildingStatus", "formatNumber", "formatLoad", "storageRowLoad"];
  for (const name of required) {
    if (typeof deps[name] !== "function") throw new TypeError(`storage capacity engine requires dependencies.${name}`);
  }

  const usedByRoom = new Map();
  const addLoad = (roomIdRaw, load) => {
    const roomId = normalizeStorageRoomId(roomIdRaw);
    const value = Math.max(0, deps.safeNumber(load, 0));
    if (!value) return;
    usedByRoom.set(roomId, (usedByRoom.get(roomId) ?? 0) + value);
  };
  const resources = Array.isArray(holding?.storage?.resources) ? holding.storage.resources : [];
  const items = Array.isArray(holding?.storage?.items) ? holding.storage.items : [];
  for (const row of resources) {
    if (deps.isMoneyResource(row?.resourceId, row?.name)) continue;
    addLoad(row?.roomId ?? row?.storageRoomId, deps.storageRowLoad(row));
  }
  for (const row of items) addLoad(row?.roomId ?? row?.storageRoomId, deps.storageRowLoad(row));

  const outdoorCapacity = Math.max(1, Math.floor(deps.safeNumber(
    holding?.storage?.outdoorsSafeCapacityCargoPoints,
    DEFAULT_OUTDOOR_SAFE_CAPACITY_CARGO_POINTS
  )));
  const rows = [decorateStorageRoom({
    id: "outdoors",
    label: "Под открытым небом",
    buildingId: "",
    icon: "fa-solid fa-cloud",
    img: "",
    source: "base",
    statusLabel: "Базовое",
    statusClass: "built",
    available: true,
    unlimited: false,
    capacity: outdoorCapacity,
    capacityCargoPoints: outdoorCapacity,
    legacyCapacity: outdoorCapacity / LEGACY_STORAGE_LOAD_TO_CARGO_POINTS,
    used: usedByRoom.get("outdoors") ?? 0,
    security: 0,
    quality: 0,
    securityText: "0",
    qualityText: "0",
    notes: "Безопасная наружная площадка конечна; излишек получает один десятник отсрочки, затем подвергается порче, краже или потере."
  }, { formatLoad: deps.formatLoad })];

  for (const building of holding?.buildings?.list ?? []) {
    if (!deps.buildingFunctions(building).storage) continue;
    const status = deps.buildingStatus(building);
    const available = status.value === "built";
    if (!includeUnavailable && !available) continue;
    const storage = building.storage && typeof building.storage === "object" ? building.storage : {};
    const capacity = storageCapacityCargoPoints(storage);
    const id = String(building.id);
    rows.push(decorateStorageRoom({
      id,
      label: building.name || "Складское здание",
      buildingId: id,
      icon: String(building.icon ?? "fa-solid fa-warehouse"),
      img: String(building.img ?? building.image ?? ""),
      source: "building",
      statusLabel: status.label,
      statusClass: status.css,
      available,
      unlimited: capacity <= 0,
      capacity,
      capacityCargoPoints: capacity,
      legacyCapacity: Math.max(0, deps.safeNumber(storage.capacity, 0)),
      used: usedByRoom.get(id) ?? 0,
      security: Math.max(0, deps.safeNumber(storage.security, 0)),
      quality: Math.max(0, deps.safeNumber(storage.quality, 0)),
      securityText: deps.formatNumber(storage.security ?? 0),
      qualityText: deps.formatNumber(storage.quality ?? 0),
      notes: String(storage.notes ?? building.notes ?? "")
    }, { formatLoad: deps.formatLoad }));
  }
  return rows;
}

export function storageRoomOptionsFromRooms(rooms = [], selected = "outdoors") {
  const current = normalizeStorageRoomId(selected);
  const options = rooms
    .filter((room) => room.available)
    .map((room) => ({ value: room.id, label: room.label, selected: room.id === current }));
  if (current && !options.some((option) => option.value === current)) {
    const fallback = rooms.find((room) => room.id === current);
    options.push({ value: current, label: fallback ? `${fallback.label} (${fallback.statusLabel})` : `${current} (нет в списке)`, selected: true });
  }
  return options;
}

export function storageRoomLabelFromRooms(rooms = [], roomId = "outdoors") {
  const id = normalizeStorageRoomId(roomId);
  return rooms.find((room) => room.id === id)?.label ?? "Под открытым небом";
}

export function storageRoomsContext(rooms = []) {
  let builtCount = 0;
  let buildingCount = 0;
  for (const room of rooms) {
    if (room.available) builtCount += 1;
    if (room.source === "building") buildingCount += 1;
  }
  return { rows: rooms, hasRooms: rooms.length > 0, builtCount, buildingCount };
}
