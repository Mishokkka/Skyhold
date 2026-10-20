function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

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
  const qty = Math.max(0, Math.floor(toNumber(row?.qty ?? row?.quantity ?? row?.count, 0)));
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
  const required = ["isMoneyResource", "safeNumber", "storageRowLoad", "buildingFunctions", "buildingStatus", "storageFunctionAvailable", "storageProfileEffectFactor", "storageEffectiveRowLoad", "formatNumber", "formatLoad"];
  for (const name of required) {
    if (typeof deps[name] !== "function") throw new TypeError(`storage capacity engine requires dependencies.${name}`);
  }

  const rows = [{
    id: "outdoors",
    label: "Под открытым небом",
    buildingId: "",
    icon: "fa-solid fa-cloud",
    img: "",
    source: "base",
    statusLabel: "Базовое",
    statusClass: "built",
    available: true,
    unlimited: true,
    capacity: 0,
    used: 0,
    security: 0,
    quality: 0,
    shelfLifeMultiplier: 1,
    securityText: "0",
    qualityText: "0",
    notes: "Базовое складирование без лимита вместимости. Защищенность и качество хранения минимальные.",
    profileEffectFactor: 0,
    profileCapacityMultiplier: 1,
    profileResourceIds: [],
    profileCategoryTags: [],
    profileMarketTags: [],
    profilePerishableFood: false
  }];

  for (const building of holding?.buildings?.list ?? []) {
    if (!deps.buildingFunctions(building).storage) continue;
    const status = deps.buildingStatus(building);
    const available = status.value === "built";
    if (!includeUnavailable && !available) continue;
    const storage = building.storage && typeof building.storage === "object" ? building.storage : {};
    const capacity = Math.max(0, deps.safeNumber(storage.capacity, 0));
    const id = String(building.id);
    const profileEffect = deps.storageProfileEffectFactor(holding, building);
    rows.push({
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
      used: 0,
      security: Math.max(0, deps.safeNumber(storage.security, 0)) * profileEffect,
      quality: Math.max(0, deps.safeNumber(storage.quality, 0)) * profileEffect,
      shelfLifeMultiplier: Math.max(1, deps.safeNumber(storage.shelfLifeMultiplier, 1)),
      profileLabel: String(storage.profileLabel ?? ""),
      profileResourceIds: [...(storage.profileResourceIds ?? [])],
      profileCategoryTags: [...(storage.profileCategoryTags ?? [])],
      profileMarketTags: [...(storage.profileMarketTags ?? [])],
      profilePerishableFood: storage.profilePerishableFood === true,
      autoReceive: storage.autoReceive === true,
      profileCapacityMultiplier: Math.max(0.01, Math.min(1, deps.safeNumber(storage.profileCapacityMultiplier, 1))),
      profileEffectFactor: profileEffect,
      profileRequiresStaff: storage.profileRequiresStaff === true,
      securityText: deps.formatNumber(Math.max(0, deps.safeNumber(storage.security, 0)) * profileEffect),
      qualityText: deps.formatNumber(Math.max(0, deps.safeNumber(storage.quality, 0)) * profileEffect),
      notes: String(storage.notes ?? building.notes ?? "")
    });
  }

  const roomById = new Map(rows.map((room) => [String(room.id), room]));
  const addLoad = (row, rawLoad) => {
    const roomId = normalizeStorageRoomId(row?.roomId ?? row?.storageRoomId);
    const room = roomById.get(roomId) ?? roomById.get("outdoors");
    const value = deps.storageEffectiveRowLoad(room, row, deps.safeNumber(rawLoad, 0));
    if (value > 0) room.used += value;
  };
  for (const row of Array.isArray(holding?.storage?.resources) ? holding.storage.resources : []) {
    if (!deps.isMoneyResource(row?.resourceId, row?.name)) addLoad(row, deps.storageRowLoad(row));
  }
  for (const row of Array.isArray(holding?.storage?.items) ? holding.storage.items : []) addLoad(row, deps.storageRowLoad(row));
  return rows.map((room) => decorateStorageRoom(room, { formatLoad: deps.formatLoad }));
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
  if (id === "auto") return "Предпочтительные склады";
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
