// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { escapeHtml, rollD6Pool } from "../../../core/helpers.js";
import {
  isMoneyResource,
  normalizeResourceId,
  resourceDef,
  resourceIcon,
  resourceImage,
  resourceItemUuid,
  resourceLabel,
  resourceOptions,
  resourceUnit
} from "../../../core/resources.js";
import { parseResourceCosts } from "../../../services/economy-service.js";
import { storageFillClass, storageRowLoad, storageUnitLoad } from "../../../services/storage-service.js";

export const FinanceStorageDomain = {
_storageUnitLoad(resource = {}) {
  return storageUnitLoad(resource);
},

_storageRowLoad(row = {}) {
  return storageRowLoad(row);
},

_storageFillClass(options = {}) {
  return storageFillClass(options);
},

_storageRooms(holding, { includeUnavailable = true } = {}) {
  const rows = [];
  const resources = Array.isArray(holding?.storage?.resources) ? holding.storage.resources : [];
  const items = Array.isArray(holding?.storage?.items) ? holding.storage.items : [];
  const usedByRoom = new Map();
  const addLoad = (roomIdRaw, load) => {
    const roomId = this._normalizeStorageRoomId(roomIdRaw);
    const value = Math.max(0, this._safeNumber(load, 0));
    if (!value) return;
    usedByRoom.set(roomId, (usedByRoom.get(roomId) ?? 0) + value);
  };
  for (const row of resources) {
    if (isMoneyResource(row?.resourceId, row?.name)) continue;
    addLoad(row?.roomId ?? row?.storageRoomId, this._storageRowLoad(row));
  }
  for (const row of items) addLoad(row?.roomId ?? row?.storageRoomId, this._storageRowLoad(row));

  rows.push(this._decorateStorageRoom({
    id: "outdoors",
    label: "Под открытым небом",
    buildingId: "",
    source: "base",
    statusLabel: "Базовое",
    statusClass: "built",
    available: true,
    unlimited: true,
    capacity: 0,
    used: usedByRoom.get("outdoors") ?? 0,
    security: 0,
    quality: 0,
    securityText: "0",
    qualityText: "0",
    notes: "Базовое складирование без лимита вместимости. Защищенность и качество хранения минимальные."
  }));

  for (const building of holding?.buildings?.list ?? []) {
    if (!this._buildingFunctions(building).storage) continue;
    const status = this._buildingStatus(building);
    const available = status.value === "built";
    if (!includeUnavailable && !available) continue;
    const storage = building.storage && typeof building.storage === "object" ? building.storage : {};
    const capacity = Math.max(0, this._safeNumber(storage.capacity, 0));
    const used = usedByRoom.get(String(building.id)) ?? 0;
    rows.push(this._decorateStorageRoom({
      id: String(building.id),
      label: building.name || "Складское здание",
      buildingId: String(building.id),
      source: "building",
      statusLabel: status.label,
      statusClass: status.css,
      available,
      unlimited: capacity <= 0,
      capacity,
      used,
      security: Math.max(0, this._safeNumber(storage.security, 0)),
      quality: Math.max(0, this._safeNumber(storage.quality, 0)),
      securityText: this._formatNumber(storage.security ?? 0),
      qualityText: this._formatNumber(storage.quality ?? 0),
      notes: String(storage.notes ?? building.notes ?? "")
    }));
  }

  return rows;
},

_storageRoomOptions(holding, selected = "outdoors") {
  return this._storageRoomOptionsFromRooms(this._storageRooms(holding, { includeUnavailable: true }), selected);
},

_storageRoomOptionsFromRooms(rooms = [], selected = "outdoors") {
  const current = this._normalizeStorageRoomId(selected);
  const options = rooms
    .filter((room) => room.available)
    .map((room) => ({ value: room.id, label: room.label, selected: room.id === current }));
  if (current && !options.some((option) => option.value === current)) {
    const fallback = rooms.find((room) => room.id === current);
    options.push({ value: current, label: fallback ? `${fallback.label} (${fallback.statusLabel})` : `${current} (нет в списке)`, selected: true });
  }
  return options;
},

_storageRoomLabel(holding, roomId = "outdoors") {
  return this._storageRoomLabelFromRooms(this._storageRooms(holding, { includeUnavailable: true }), roomId);
},

_storageRoomLabelFromRooms(rooms = [], roomId = "outdoors") {
  const id = this._normalizeStorageRoomId(roomId);
  return rooms.find((room) => room.id === id)?.label ?? "Под открытым небом";
},

_storageRoomsContext(holding, roomsArg = null) {
  const rooms = Array.isArray(roomsArg) ? roomsArg : this._storageRooms(holding, { includeUnavailable: true });
  return {
    rows: rooms,
    hasRooms: rooms.length > 0,
    builtCount: rooms.filter((room) => room.available).length,
    buildingCount: rooms.filter((room) => room.source === "building").length
  };
},

_storageContext(holding, canEdit = false, activeRoomId = "outdoors") {
  const activeSubtab = String(this.activeStorageTab ?? "resources");
  if (activeSubtab === "accounting") {
    return {
      rows: [],
      visibleRows: [],
      activeRoomRows: [],
      activeItemRows: [],
      activeRoomId: this._normalizeStorageRoomId(activeRoomId),
      activeRoom: null,
      resourceRooms: [],
      visibleCount: 0,
      activeRoomCount: 0,
      activeItemCount: 0,
      categoryCount: 0,
      hasRows: false,
      hasVisibleRows: false,
      hasActiveRoomRows: false,
      hasActiveItemRows: false,
      zeroCount: 0,
      categories: [],
      money: this._moneyContext(holding),
      rooms: { rows: [], hasRooms: false, builtCount: 0, buildingCount: 0 },
      roomOptions: [],
      moveFromOptions: [],
      moveToOptions: [],
      logRows: [],
      resourceOptions: [],
      actorOptions: [],
      hasActorOptions: false,
      targetActor: this._storageTargetActorContext(),
      notes: holding?.storage?.notes ?? "",
      adjustToolOpen: Boolean(this.storageToolState?.adjust),
      moveToolOpen: Boolean(this.storageToolState?.move)
    };
  }

  const roomsAll = this._storageRooms(holding, { includeUnavailable: true });
  const rawRows = (holding?.storage?.resources ?? [])
    .map((row, index) => ({ ...row, __storageIndex: index }))
    .filter((row) => !isMoneyResource(row?.resourceId, row?.name));
  const rawItemRows = (holding?.storage?.items ?? [])
    .map((row, index) => ({ ...row, __storageIndex: index }));
  const visibleRawRows = rawRows.filter((row) => Math.abs(this._safeNumber(row.qty, 0)) >= 0.0001);
  const visibleItemRows = rawItemRows.filter((row) => this._itemQuantity(row) > 0);

  let activeRoom = this._normalizeStorageRoomId(activeRoomId);
  const roomIds = new Set(roomsAll.map((room) => room.id));
  if (!roomIds.has(activeRoom)) activeRoom = "outdoors";

  const roomItemCounts = new Map();
  const addCount = (row) => {
    const roomId = this._normalizeStorageRoomId(row.roomId ?? row.storageRoomId);
    roomItemCounts.set(roomId, (roomItemCounts.get(roomId) ?? 0) + 1);
  };
  for (const row of visibleRawRows) addCount(row);
  for (const row of visibleItemRows) addCount(row);

  const roomsWithRows = new Set(roomItemCounts.keys());
  const activeRawRows = activeSubtab === "resources"
    ? visibleRawRows.filter((row) => this._normalizeStorageRoomId(row.roomId ?? row.storageRoomId) === activeRoom)
    : [];
  const activeRawItems = activeSubtab === "items"
    ? visibleItemRows.filter((row) => this._normalizeStorageRoomId(row.roomId ?? row.storageRoomId) === activeRoom)
    : [];
  const activeRoomRows = activeSubtab === "resources"
    ? this._prepareStorageRows(holding, canEdit, roomsAll, activeRawRows)
    : [];
  const activeItemRows = activeSubtab === "items"
    ? this._prepareStorageItemRows(holding, canEdit, roomsAll, activeRawItems)
    : [];
  const activeRoomInfo = roomsAll.find((room) => room.id === activeRoom) ?? roomsAll[0] ?? null;
  const resourceRooms = roomsAll
    .filter((room) => room.available || room.source === "base" || roomsWithRows.has(room.id))
    .map((room) => ({
      ...room,
      active: room.id === activeRoom,
      itemCount: roomItemCounts.get(room.id) ?? 0
    }));

  const byCategory = new Map();
  for (const row of activeRoomRows) byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + 1);
  const categories = Array.from(byCategory.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const moveToDefault = roomsAll.find((room) => room.available && room.id !== activeRoom)?.id ?? activeRoom;
  const targetActor = this._storageTargetActorContext();
  return {
    rows: activeRoomRows,
    visibleRows: visibleRawRows,
    activeRoomRows,
    activeItemRows,
    activeRoomId: activeRoom,
    activeRoom: activeRoomInfo,
    resourceRooms,
    visibleCount: visibleRawRows.length,
    itemCount: visibleItemRows.length,
    activeRoomCount: activeRoomRows.length,
    activeItemCount: activeItemRows.length,
    categoryCount: categories.length,
    hasRows: rawRows.length > 0,
    hasVisibleRows: visibleRawRows.length > 0,
    hasActiveRoomRows: activeRoomRows.length > 0,
    hasActiveItemRows: activeItemRows.length > 0,
    zeroCount: rawRows.length - visibleRawRows.length,
    categories,
    money: this._moneyContext(holding),
    rooms: this._storageRoomsContext(holding, roomsAll),
    roomOptions: ["resources", "items"].includes(activeSubtab) ? this._storageRoomOptionsFromRooms(roomsAll, activeRoom) : [],
    moveFromOptions: activeSubtab === "resources" ? this._storageRoomOptionsFromRooms(roomsAll, activeRoom) : [],
    moveToOptions: activeSubtab === "resources" ? this._storageRoomOptionsFromRooms(roomsAll, moveToDefault) : [],
    logRows: activeSubtab === "log" ? this._storageLogRows(holding, roomsAll) : [],
    resourceOptions: activeSubtab === "resources" ? resourceOptions("", "", { includeMoney: false }) : [],
    actorOptions: [],
    hasActorOptions: false,
    targetActor,
    notes: holding?.storage?.notes ?? "",
    adjustToolOpen: Boolean(this.storageToolState?.adjust),
    moveToolOpen: Boolean(this.storageToolState?.move)
  };
},

_storageLogRows(holding, roomsArg = null) {
  const rooms = Array.isArray(roomsArg) ? roomsArg : this._storageRooms(holding, { includeUnavailable: true });
  const log = Array.isArray(holding?.storage?.log) ? holding.storage.log : [];
  return [...log].reverse().slice(0, 80).map((row) => {
    const id = normalizeResourceId(row.resourceId, row.name);
    const name = id === "custom" ? (row.name || "Ресурс") : resourceLabel(id);
    const qty = this._safeNumber(row.qty, 0);
    const sign = qty > 0 ? "+" : "";
    const date = row.ts ? new Date(row.ts) : null;
    const realDateText = date && !Number.isNaN(date.getTime()) ? date.toLocaleString("ru-RU") : "—";
    const holdingDateText = String(holding?.gm?.calendaria?.lastDateText ?? holding?.gm?.calendaria?.lastDateKey ?? "").trim();
    const laputaDateText = String(row.laputaDateText ?? row.holdingDateText ?? holdingDateText).trim();
    const dateText = laputaDateText ? `${realDateText} · ${laputaDateText}` : realDateText;
    return {
      ...row,
      resourceId: id,
      name,
      icon: resourceIcon(id),
      qty,
      qtyText: `${sign}${this._formatNumber(qty)}`,
      qtyClass: qty > 0 ? "positive" : qty < 0 ? "negative" : "zero",
      dateText,
      realDateText,
      laputaDateText,
      kindLabel: this._storageLogKindLabel(row.kind),
      source: row.source || "—",
      roomLabel: row.roomId ? this._storageRoomLabelFromRooms(rooms, row.roomId) : "",
      note: [row.roomId ? this._storageRoomLabelFromRooms(rooms, row.roomId) : "", row.note || row.period || ""].filter(Boolean).join(" · ")
    };
  });
},

_storageLogKindLabel(kind = "") {
  switch (String(kind)) {
    case "manual-add": return "Пополнение";
    case "manual-spend": return "Списание";
    case "production": return "Производство";
    case "expense": return "Расход";
    case "income": return "Доход";
    case "collect": return "Сбор";
    case "move-out": return "Перемещение";
    case "move-in": return "Перемещение";
    default: return "Запись";
  }
},

_productionPreview(holding) {
  const result = [];
  for (const building of holding?.buildings?.list ?? []) {
    if (this._buildingStatus(building).value !== "built") continue;
    const functions = this._buildingFunctions(building);
    const lines = functions.production ? this._prepareProductionLines(building, 0, holding).filter((line) => line.active) : [];
    const income = functions.income ? this._buildingIncomeSummary(building, holding) : null;
    if (!lines.length && !income?.total) continue;
    result.push({
      name: building.name || "Здание",
      lines: lines.map((line) => ({ resource: line.resource, total: line.totalPreview ?? line.total, expenses: line.expenses || "" })),
      income: income?.total ?? 0
    });
  }
  return result;
},

_parseResourceCosts(text = "") {
  return parseResourceCosts(text);
},

_storageResourceIdentity(resource = {}) {
  const id = normalizeResourceId(resource.resourceId, resource.id, resource.name);
  return { id, name: id === "custom" ? String(resource.name ?? "").trim().toLowerCase() : "" };
},

_storageResourceMatches(row = {}, resource = {}) {
  const a = this._storageResourceIdentity(row);
  const b = this._storageResourceIdentity(resource);
  if (a.id !== b.id) return false;
  if (a.id !== "custom") return true;
  return a.name === b.name;
},

_storageFind(holding, resource = {}) {
  if (!holding.storage) holding.storage = { notes: "", resources: [], moneyCopper: 0, log: [] };
  if (!Array.isArray(holding.storage.resources)) holding.storage.resources = [];
  if (isMoneyResource(resource.resourceId, resource.id, resource.name)) return null;
  const roomId = this._normalizeStorageRoomId(resource.roomId ?? resource.storageRoomId);
  return holding.storage.resources.find((row) => this._normalizeStorageRoomId(row.roomId ?? row.storageRoomId) === roomId && this._storageResourceMatches(row, resource)) ?? null;
},

_storageQuantity(holding, resource = {}) {
  if (isMoneyResource(resource.resourceId, resource.id, resource.name)) return this._moneyCopper(holding);
  const hasRoom = resource.roomId !== undefined || resource.storageRoomId !== undefined;
  if (hasRoom) return this._safeNumber(this._storageFind(holding, resource)?.qty, 0);
  return (holding?.storage?.resources ?? [])
    .filter((row) => this._storageResourceMatches(row, resource))
    .reduce((sum, row) => sum + this._safeNumber(row.qty, 0), 0);
},

_storageAdd(holding, resource = {}, qty = 0) {
  if (!qty) return null;
  if (!holding.storage) holding.storage = { notes: "", resources: [], moneyCopper: 0, log: [] };
  if (!Array.isArray(holding.storage.resources)) holding.storage.resources = [];
  const id = normalizeResourceId(resource.resourceId, resource.id, resource.name);
  if (isMoneyResource(id, resource.name)) {
    this._addMoney(holding, qty);
    return { id: "money", resourceId: "money", name: "Деньги", qty: this._moneyCopper(holding), unit: "медн.", notes: "" };
  }
  const name = id === "custom" ? String(resource.name ?? "Ресурс") : resourceLabel(id);
  const roomId = this._normalizeStorageRoomId(resource.roomId ?? resource.storageRoomId);
  let row = this._storageFind(holding, { resourceId: id, name, roomId });
  if (!row) {
    row = {
      id: globalThis.foundry?.utils?.randomID?.(12) ?? `res-${Date.now()}`,
      resourceId: id,
      name,
      qty: 0,
      unit: resource.unit || resourceUnit(id),
      img: resource.img || resourceImage(id),
      itemUuid: resource.itemUuid || resourceItemUuid(id),
      itemId: resource.itemId || resourceDef(id)?.itemId || "",
      itemType: resource.itemType || resourceDef(id)?.itemType || "",
      cost: resource.cost || resourceDef(id)?.cost || "",
      roomId,
      forSale: Boolean(resource.forSale ?? false),
      notes: ""
    };
    holding.storage.resources.push(row);
  }
  row.resourceId = id;
  row.name = name;
  row.unit = row.unit || resourceUnit(id);
  row.img = row.img || resource.img || resourceImage(id);
  row.itemUuid = row.itemUuid || resource.itemUuid || resourceItemUuid(id);
  row.itemId = row.itemId || resource.itemId || resourceDef(id)?.itemId || "";
  row.itemType = row.itemType || resource.itemType || resourceDef(id)?.itemType || "";
  row.cost = row.cost || resource.cost || resourceDef(id)?.cost || "";
  if (resource.weight !== undefined && resource.weight !== null && resource.weight !== "") row.weight = this._storageUnitLoad(resource);
  if (resource.load !== undefined && resource.load !== null && resource.load !== "") row.load = this._storageUnitLoad(resource);
  row.roomId = roomId;
  row.qty = this._safeNumber(row.qty, 0) + qty;
  return row;
},

_storageAddWithOverflow(holding, resource = {}, qty = 0) {
  const amount = Math.max(0, Math.floor(this._safeNumber(qty, 0)));
  if (!amount) return [];
  const id = normalizeResourceId(resource.resourceId, resource.id, resource.name);
  if (isMoneyResource(id, resource.name)) {
    this._storageAdd(holding, resource, amount);
    return [{ roomId: "", qty: amount, overflowFrom: "" }];
  }

  const targetRoomId = this._normalizeStorageRoomId(resource.roomId ?? resource.storageRoomId);
  const rooms = this._storageRooms(holding, { includeUnavailable: true });
  const targetRoom = rooms.find((room) => room.id === targetRoomId);
  const placements = [];
  const addPlacement = (roomId, part, overflowFrom = "") => {
    const value = Math.max(0, Math.floor(this._safeNumber(part, 0)));
    if (!value) return;
    this._storageAdd(holding, { ...resource, resourceId: id, roomId }, value);
    placements.push({ roomId, qty: value, overflowFrom });
  };

  if (targetRoomId === "outdoors" || !targetRoom || !targetRoom.available || targetRoom.unlimited) {
    addPlacement(targetRoom && targetRoom.available ? targetRoomId : "outdoors", amount, targetRoom && !targetRoom.available ? targetRoomId : "");
    return placements;
  }

  const unitLoad = this._storageUnitLoad(resource);
  const freeLoad = Math.max(0, this._safeNumber(targetRoom.capacity, 0) - this._safeNumber(targetRoom.used, 0));
  const fitAmount = unitLoad <= 0 ? amount : Math.max(0, Math.floor((freeLoad + 0.0001) / unitLoad));
  if (fitAmount >= amount) {
    addPlacement(targetRoomId, amount);
    return placements;
  }
  if (fitAmount > 0) addPlacement(targetRoomId, fitAmount);
  addPlacement("outdoors", amount - fitAmount, targetRoomId);
  return placements;
},

_storagePlacementText(holding, placements = []) {
  if (!placements.length) return "—";
  return placements.map((item) => {
    const room = item.roomId ? this._storageRoomLabel(holding, item.roomId) : "Счетчик денег";
    const overflow = item.overflowFrom ? `, переполнение: ${this._storageRoomLabel(holding, item.overflowFrom)}` : "";
    return `${this._formatNumber(item.qty)} → ${room}${overflow}`;
  }).join("; ");
},

_storageCanPay(holding, costs = []) {
  const missing = [];
  for (const cost of costs) {
    const have = this._storageQuantity(holding, cost);
    if (have + 0.0001 < cost.qty) missing.push({ ...cost, have });
  }
  return { ok: missing.length === 0, missing };
},

_storagePay(holding, costs = []) {
  for (const cost of costs) {
    const amount = Math.max(0, this._safeNumber(cost.qty, 0));
    if (!amount) continue;
    if (isMoneyResource(cost.resourceId, cost.id, cost.name)) {
      this._addMoney(holding, -amount);
      continue;
    }
    const hasRoom = cost.roomId !== undefined || cost.storageRoomId !== undefined;
    if (hasRoom) {
      this._storageAdd(holding, cost, -amount);
      continue;
    }
    let rest = amount;
    for (const row of holding?.storage?.resources ?? []) {
      if (rest <= 0.0001) break;
      if (!this._storageResourceMatches(row, cost)) continue;
      const have = Math.max(0, this._safeNumber(row.qty, 0));
      if (!have) continue;
      const take = Math.min(have, rest);
      row.qty = have - take;
      rest -= take;
    }
  }
},

_storageDefaultActor() {
  const userActor = globalThis.game?.user?.character ?? null;
  if (userActor) return userActor;
  const controlled = globalThis.canvas?.tokens?.controlled ?? [];
  const controlledActor = controlled.find((token) => token?.actor)?.actor ?? null;
  if (controlledActor && (globalThis.game?.user?.isGM || controlledActor.isOwner)) return controlledActor;
  return null;
},

_storageDefaultActorId() {
  return String(this._storageDefaultActor()?.id ?? "");
},

_storageTargetActorContext() {
  const actor = this._storageDefaultActor();
  return actor
    ? { id: String(actor.id ?? ""), name: String(actor.name ?? "Персонаж"), hasActor: true }
    : { id: "", name: "Нет привязанного персонажа", hasActor: false };
},

_storageDepositSource(item = {}) {
  const actor = item?.parent;
  const actorDocumentName = actor?.documentName ?? actor?.constructor?.documentName;
  if (actorDocumentName === "Actor" && item?.id) {
    if (!game.user?.isGM && !actor.isOwner) {
      return { ok: false, message: "Можно класть в хранилище только предметы персонажа, которым ты владеешь." };
    }
    return { ok: true, requiresRemoval: true, actor };
  }

  if (game.user?.isGM) return { ok: true, requiresRemoval: false, actor: null };
  return { ok: false, message: "Игрок может класть в хранилище только предметы из инвентаря своего персонажа." };
},

_itemQuantity(itemOrData = {}) {
  const system = itemOrData.system ?? itemOrData.itemData?.system ?? {};
  const value = system.quantity ?? itemOrData.qty ?? itemOrData.quantity ?? 1;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : 1;
},

_itemTypeLabel(type = "") {
  const value = String(type ?? "");
  const labels = {
    rawMaterial: "Ресурс",
    gear: "Снаряжение",
    weapon: "Оружие",
    armor: "Броня",
    talent: "Талант",
    spell: "Заклинание"
  };
  return (labels[value] ?? value) || "Предмет";
},

_resourceIdForFoundryItem(item = {}) {
  const uuid = String(item.uuid ?? item.itemUuid ?? "");
  const id = String(item.id ?? item._id ?? "");
  const name = String(item.name ?? "");
  const candidates = [uuid, id, name];
  for (const def of this._resourceDefsForLookup()) {
    if (def.itemUuid && uuid && String(def.itemUuid) === uuid) return def.id;
    if (def.itemId && id && String(def.itemId) === id) return def.id;
    if (normalizeResourceId(name) === def.id) return def.id;
  }
  return normalizeResourceId(name);
},

_resourceDefsForLookup() {
  try {
    return resourceOptions("", "", { includeMoney: false })
      .map((option) => resourceDef(option.value))
      .filter(Boolean);
  } catch (_error) {
    return [];
  }
},

_snapshotItemForStorage(item = {}, qty = null, roomId = "outdoors") {
  const source = item.toObject ? item.toObject() : (foundry?.utils?.deepClone?.(item) ?? JSON.parse(JSON.stringify(item)));
  const amount = Math.max(1, Math.floor(this._safeNumber(qty ?? this._itemQuantity(source), 1)));
  const itemData = this._setItemQuantityData(source, amount);
  const parent = item.parent;
  const parentDocumentName = parent?.documentName ?? parent?.constructor?.documentName;
  return {
    id: globalThis.foundry?.utils?.randomID?.(12) ?? `sitem-${Date.now()}-${Math.random()}`,
    name: String(itemData.name ?? item.name ?? "Предмет"),
    type: String(itemData.type ?? item.type ?? "gear"),
    img: String(itemData.img ?? item.img ?? "icons/svg/item-bag.svg"),
    qty: amount,
    weight: String(itemData.system?.weight ?? ""),
    cost: String(itemData.system?.cost ?? ""),
    roomId: this._normalizeStorageRoomId(roomId),
    forSale: Boolean(item.forSale ?? itemData.forSale ?? false),
    sourceActorId: parentDocumentName === "Actor" ? String(parent.id ?? "") : "",
    sourceActorName: parentDocumentName === "Actor" ? String(parent.name ?? "") : "",
    itemUuid: String(item.uuid ?? ""),
    itemData,
    notes: ""
  };
},

async _storageReceiveFoundryItem(holding, item, { roomId = "outdoors" } = {}) {
  if (!item) return { ok: false, message: "Предмет не найден." };
  const targetRoom = this._normalizeStorageRoomId(roomId);
  const amount = this._itemQuantity(item);
  const source = this._storageDepositSource(item);
  if (!source.ok) return source;

  if (String(item.type) === "rawMaterial") {
    const resourceId = this._resourceIdForFoundryItem(item);
    const id = resourceId === "custom" ? "custom" : resourceId;
    const label = id === "custom" ? String(item.name ?? "Ресурс") : resourceLabel(id);
    if (source.requiresRemoval) {
      const removed = await this._removeQuantityFromActorItem(item, amount);
      if (!removed) return { ok: false, message: "Не удалось списать предмет из инвентаря персонажа." };
    }
    const placements = this._storageAddWithOverflow(holding, {
      resourceId: id,
      name: label,
      roomId: targetRoom,
      img: item.img,
      itemUuid: item.uuid,
      itemId: item.id,
      itemType: item.type,
      weight: item.system?.weight ?? ""
    }, amount);
    this._appendStorageLog(holding, placements.map((place) => ({
      kind: "manual-add",
      resourceId: id,
      name: label,
      qty: place.qty,
      roomId: place.roomId,
      source: "Инвентарь Foundry",
      note: (item.parent?.documentName ?? item.parent?.constructor?.documentName) === "Actor" ? `из ${item.parent.name}` : "перетаскивание"
    })));
    return { ok: true, message: `${label}: принято ${this._formatNumber(amount)}; ${this._storagePlacementText(holding, placements)}.` };
  }

  if (!holding.storage) holding.storage = { notes: "", resources: [], items: [], moneyCopper: 0, log: [] };
  if (!Array.isArray(holding.storage.items)) holding.storage.items = [];
  const snapshot = this._snapshotItemForStorage(item, amount, targetRoom);
  if (source.requiresRemoval) {
    const removed = await this._removeQuantityFromActorItem(item, amount);
    if (!removed) return { ok: false, message: "Не удалось списать предмет из инвентаря персонажа." };
  }
  holding.storage.items.push(snapshot);
  this._appendStorageLog(holding, [{ kind: "manual-add", resourceId: "custom", name: snapshot.name, qty: amount, roomId: targetRoom, source: "Предмет Foundry", note: snapshot.sourceActorName ? `из ${snapshot.sourceActorName}` : "перетаскивание" }]);
  return { ok: true, message: `${snapshot.name}: предмет принят в ${this._storageRoomLabel(holding, targetRoom)}.` };
},

_appendStorageLog(holding, entries = []) {
  if (!holding.storage) holding.storage = { notes: "", resources: [], moneyCopper: 0, log: [] };
  if (!Array.isArray(holding.storage.log)) holding.storage.log = [];
  const now = new Date().toISOString();
  const laputaDateText = String(holding?.gm?.calendaria?.lastDateText ?? holding?.gm?.calendaria?.lastDateKey ?? "").trim();
  for (const raw of entries) {
    const qty = this._safeNumber(raw?.qty, 0);
    if (!qty && raw?.kind !== "note") continue;
    const id = normalizeResourceId(raw?.resourceId, raw?.name);
    const name = id === "custom" ? String(raw?.name ?? "Ресурс") : resourceLabel(id);
    const roomId = isMoneyResource(id, name) ? "" : this._normalizeStorageRoomId(raw?.roomId ?? raw?.storageRoomId);
    holding.storage.log.push({
      id: globalThis.foundry?.utils?.randomID?.(12) ?? `slog-${Date.now()}-${Math.random()}`,
      ts: raw?.ts ?? now,
      laputaDateText: String(raw?.laputaDateText ?? raw?.holdingDateText ?? laputaDateText),
      kind: String(raw?.kind ?? "manual"),
      resourceId: id,
      name,
      qty,
      roomId,
      source: String(raw?.source ?? ""),
      note: String(raw?.note ?? ""),
      period: String(raw?.period ?? "")
    });
  }
  holding.storage.log = holding.storage.log.slice(-250);
},

_applyManualStorageChange(holding, { resourceId = "custom", name = "", qty = 0, note = "", kind = "manual-add", roomId = "outdoors" } = {}) {
  const amount = this._safeNumber(qty, 0);
  if (!amount) return { ok: false, message: "Укажи количество." };
  const id = normalizeResourceId(resourceId, name);
  const label = id === "custom" ? (String(name).trim() || "Ресурс") : resourceLabel(id);
  const targetRoom = this._normalizeStorageRoomId(roomId);
  let placements = [];
  if (amount > 0) placements = this._storageAddWithOverflow(holding, { resourceId: id, name: label, roomId: targetRoom }, amount);
  else this._storageAdd(holding, { resourceId: id, name: label, roomId: targetRoom }, amount);
  const entries = amount > 0 && placements.length
    ? placements.map((item) => ({ kind, resourceId: id, name: label, qty: item.qty, roomId: item.roomId, source: "Ручная правка", note: item.overflowFrom ? [note, `переполнение: ${this._storageRoomLabel(holding, item.overflowFrom)}`].filter(Boolean).join(" · ") : note }))
    : [{ kind, resourceId: id, name: label, qty: amount, roomId: targetRoom, source: "Ручная правка", note }];
  this._appendStorageLog(holding, entries);
  const suffix = isMoneyResource(id, label) ? "" : (amount > 0 ? `; ${this._storagePlacementText(holding, placements)}` : ` → ${this._storageRoomLabel(holding, targetRoom)}`);
  return { ok: true, message: `${label}: ${amount > 0 ? "+" : ""}${this._formatNumber(amount)}${suffix}.` };
},

_applyStorageMove(holding, { resourceId = "custom", name = "", qty = 0, fromRoomId = "outdoors", toRoomId = "outdoors", note = "" } = {}) {
  const amount = Math.max(0, this._safeNumber(qty, 0));
  if (!amount) return { ok: false, message: "Укажи количество." };
  const fromRoom = this._normalizeStorageRoomId(fromRoomId);
  const toRoom = this._normalizeStorageRoomId(toRoomId);
  if (fromRoom === toRoom) return { ok: false, message: "Выбери разные склады." };
  const id = normalizeResourceId(resourceId, name);
  if (isMoneyResource(id, name)) return { ok: false, message: "Деньги перемещаются через казну, не через склады." };
  const label = id === "custom" ? (String(name).trim() || "Ресурс") : resourceLabel(id);
  const fromRow = this._storageFind(holding, { resourceId: id, name: label, roomId: fromRoom });
  const have = Math.max(0, this._safeNumber(fromRow?.qty, 0));
  if (have + 0.0001 < amount) return { ok: false, message: `В складе '${this._storageRoomLabel(holding, fromRoom)}' нет ${this._formatNumber(amount)} ${label}. Есть ${this._formatNumber(have)}.` };
  const unit = fromRow?.unit || resourceUnit(id);
  const weight = this._storageUnitLoad(fromRow ?? {});
  this._storageAdd(holding, { resourceId: id, name: label, roomId: fromRoom, unit, weight }, -amount);
  const placements = this._storageAddWithOverflow(holding, { resourceId: id, name: label, roomId: toRoom, unit, weight }, amount);
  const entries = [
    { kind: "move-out", resourceId: id, name: label, qty: -amount, roomId: fromRoom, source: "Перемещение", note: [note, `в ${this._storageRoomLabel(holding, toRoom)}`].filter(Boolean).join(" · ") }
  ];
  for (const item of placements) {
    entries.push({ kind: "move-in", resourceId: id, name: label, qty: item.qty, roomId: item.roomId, source: "Перемещение", note: [note, `из ${this._storageRoomLabel(holding, fromRoom)}`, item.overflowFrom ? `переполнение: ${this._storageRoomLabel(holding, item.overflowFrom)}` : ""].filter(Boolean).join(" · ") });
  }
  this._appendStorageLog(holding, entries);
  return { ok: true, message: `${label}: ${this._formatNumber(amount)} из ${this._storageRoomLabel(holding, fromRoom)}; ${this._storagePlacementText(holding, placements)}.` };
},

_appendEconomyStorageLog(holding, report) {
  const summarized = this._summarizeEconomyReport(report);
  const entries = [];
  const rooms = this._storageRooms(holding, { includeUnavailable: true });
  const roomIdFromTail = (tail = "") => {
    const arrow = String(tail ?? "").match(/→\s*([^(.]+?)(?:\s*\(|\.|$)/);
    if (!arrow) return "";
    const label = arrow[1].trim();
    return rooms.find((room) => room.label === label)?.id ?? "";
  };
  const parse = (items = [], kind = "production") => {
    const rx = /^(.+?):\s*(.+?)\s*([+-])\s*([0-9]+(?:[.,][0-9]+)?)(.*)$/;
    for (const item of items) {
      const text = String(item ?? "").trim();
      if (!text || /готово к сбору/i.test(text)) continue;
      const match = text.match(rx);
      if (!match) continue;
      const source = match[1].trim();
      const resourceName = match[2].trim();
      const sign = match[3] === "-" ? -1 : 1;
      const qty = sign * (Number(String(match[4]).replace(",", ".")) || 0);
      const resourceId = normalizeResourceId(resourceName);
      const tail = String(match[5] ?? "");
      entries.push({
        kind,
        resourceId,
        name: resourceId === "custom" ? resourceName : resourceLabel(resourceId),
        qty,
        roomId: roomIdFromTail(tail),
        source,
        note: tail.replace(/^\s+|[.]$/g, "").trim(),
        period: summarized.periodLabel || ""
      });
    }
  };
  parse(summarized.produced ?? [], "production");
  parse(summarized.income ?? [], "income");
  parse(summarized.consumed ?? [], "expense");
  this._appendStorageLog(holding, entries);
  return summarized;
}
};
