import {
  isMoneyResource,
  normalizeResourceId,
  resourceDef,
  resourceIcon,
  resourceImage,
  resourceItemUuid,
  resourceLabel,
  resourceUnitLoad,
  resourceOptions
} from "../../../../core/resources.js";
import {
  buildStorageRooms,
  storageRoomLabelFromRooms,
  storageRoomOptionsFromRooms,
  storageRoomsContext,
  storageUnitLoad
} from "../../../../engines/storage/capacity.js";
import { buildStorageSearchRows } from "../../../../engines/storage/search.js";
import { storageEffectiveRowLoad, storageProfileEffectFactor } from "../../../../engines/storage/specialization.js";
import { financeBuildingFunctionBlockState } from "../../../../engines/economy/finance-obligations.js";

export const FinanceStorageContextDomain = {
_storageUnitLoad(resource = {}) {
  if (resource?.resourceId !== undefined && resource?.resourceId !== null && String(resource.resourceId).trim()) {
    const id = normalizeResourceId(resource.resourceId, resource.name);
    return id === "custom" ? 1 : resourceUnitLoad(id);
  }
  return storageUnitLoad(resource);
},

_storageRowLoad(row = {}) {
  const qty = Math.max(0, Math.floor(this._safeNumber(row?.qty ?? row?.quantity ?? row?.count, 0)));
  return qty * this._storageUnitLoad(row);
},

_formatStorageLoad(value = 0) {
  const number = this._safeNumber(value, 0);
  if (Math.abs(number - Math.round(number)) < 0.0001) return this._formatNumber(Math.round(number));
  return this._formatNumber(Math.round(number * 100) / 100);
},

_prepareStorageRows(holding, canEdit = false, roomsArg = null, rawRowsArg = null) {
  const rooms = Array.isArray(roomsArg) ? roomsArg : this._storageRooms(holding, { includeUnavailable: true });
  const roomOptionsCache = new Map();
  const roomLabelCache = new Map();
  const optionsFor = (roomId) => {
    const id = this._normalizeStorageRoomId(roomId);
    if (!roomOptionsCache.has(id)) roomOptionsCache.set(id, this._storageRoomOptionsFromRooms(rooms, id));
    return roomOptionsCache.get(id);
  };
  const labelFor = (roomId) => {
    const id = this._normalizeStorageRoomId(roomId);
    if (!roomLabelCache.has(id)) roomLabelCache.set(id, this._storageRoomLabelFromRooms(rooms, id));
    return roomLabelCache.get(id);
  };
  const rows = (Array.isArray(rawRowsArg) ? rawRowsArg : (holding?.storage?.resources ?? []))
    .filter((row) => !isMoneyResource(row?.resourceId, row?.name));
  return rows.map((row, index) => {
    const id = normalizeResourceId(row.resourceId, row.name);
    const def = id !== "custom" ? resourceDef(id) : null;
    const label = id === "custom" ? (row.name || "Ресурс") : resourceLabel(id);
    const qty = this._safeNumber(row.qty, 0);
    const roomId = this._normalizeStorageRoomId(row.roomId ?? row.storageRoomId);
    const priceCopper = this._resourcePriceCopper(row);
    const canMarkForSale = priceCopper > 0;
    return {
      ...row,
      _index: Number.isInteger(row.__storageIndex) ? row.__storageIndex : index,
      resourceId: id,
      label,
      icon: resourceIcon(id),
      img: id === "custom" ? String(row.img ?? "") : resourceImage(id),
      itemUuid: row.itemUuid || resourceItemUuid(id),
      category: def?.category ?? "Пользовательское",
      unit: "ед.",
      unitLoad: this._storageUnitLoad(row),
      loadText: this._formatStorageLoad(this._storageRowLoad(row)),
      resourceOptions: resourceOptions(id, row.name, { includeMoney: false }),
      roomId,
      roomLabel: labelFor(roomId),
      roomOptions: optionsFor(roomId),
      priceCopper,
      canMarkForSale,
      forSale: canMarkForSale && Boolean(row.forSale),
      saleTooltip: canMarkForSale ? "Пометить ресурс как доступный для продажи торговцами." : "У ресурса нет цены, поэтому его нельзя отметить к продаже.",
      isCustomResource: id === "custom",
      qty,
      qtyText: this._formatNumber(qty),
      qtyClass: qty > 0 ? "positive" : qty < 0 ? "negative" : "zero",
      isZero: Math.abs(qty) < 0.0001,
      canEdit
    };
  }).sort((a, b) => String(a.roomLabel).localeCompare(String(b.roomLabel), "ru") || String(a.category).localeCompare(String(b.category), "ru") || String(a.label).localeCompare(String(b.label), "ru"));
},

_prepareStorageItemRows(holding, canEdit = false, roomsArg = null, rawRowsArg = null) {
  const rooms = Array.isArray(roomsArg) ? roomsArg : this._storageRooms(holding, { includeUnavailable: true });
  const roomOptionsCache = new Map();
  const roomLabelCache = new Map();
  const optionsFor = (roomId) => {
    const id = this._normalizeStorageRoomId(roomId);
    if (!roomOptionsCache.has(id)) roomOptionsCache.set(id, this._storageRoomOptionsFromRooms(rooms, id));
    return roomOptionsCache.get(id);
  };
  const labelFor = (roomId) => {
    const id = this._normalizeStorageRoomId(roomId);
    if (!roomLabelCache.has(id)) roomLabelCache.set(id, this._storageRoomLabelFromRooms(rooms, id));
    return roomLabelCache.get(id);
  };
  const rows = Array.isArray(rawRowsArg) ? rawRowsArg : (holding?.storage?.items ?? []);
  return rows.map((row, index) => {
    const qty = this._itemQuantity(row);
    const roomId = this._normalizeStorageRoomId(row.roomId ?? row.storageRoomId);
    const priceCopper = this._itemPriceCopper(row);
    const canMarkForSale = priceCopper > 0;
    return {
      ...row,
      _index: Number.isInteger(row.__storageIndex) ? row.__storageIndex : index,
      qty,
      qtyText: this._formatNumber(qty),
      typeLabel: this._itemTypeLabel(row.type ?? row.itemData?.type),
      img: row.img || row.itemData?.img || "icons/svg/item-bag.svg",
      roomId,
      roomLabel: labelFor(roomId),
      roomOptions: optionsFor(roomId),
      loadText: this._formatStorageLoad(this._storageRowLoad(row)),
      priceCopper,
      canMarkForSale,
      forSale: canMarkForSale && Boolean(row.forSale),
      saleTooltip: canMarkForSale ? "Пометить предмет как доступный для продажи торговцами." : "У предмета нет цены, поэтому его нельзя отметить к продаже.",
      canEdit
    };
  }).sort((a, b) => String(a.name).localeCompare(String(b.name), "ru"));
},

_storageCapacityDependencies() {
  return {
    isMoneyResource,
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback),
    buildingFunctions: (building) => this._buildingFunctions(building),
    buildingStatus: (building) => this._buildingStatus(building),
    storageFunctionAvailable: (holding, building) => !financeBuildingFunctionBlockState({
      finance: holding?.finance,
      buildingId: String(building?.id ?? ""),
      functionId: "storage"
    }).blocked,
    storageProfileEffectFactor,
    storageEffectiveRowLoad,
    storageRowLoad: (row) => this._storageRowLoad(row),
    formatNumber: (value) => this._formatNumber(value),
    formatLoad: (value) => this._formatStorageLoad(value)
  };
},

_storageRooms(holding, { includeUnavailable = true } = {}) {
  return buildStorageRooms({ holding, includeUnavailable, dependencies: this._storageCapacityDependencies() });
},

_storageRoomOptions(holding, selected = "outdoors") {
  return this._storageRoomOptionsFromRooms(this._storageRooms(holding, { includeUnavailable: true }), selected);
},

_storageRoomOptionsFromRooms(rooms = [], selected = "outdoors") {
  return storageRoomOptionsFromRooms(rooms, selected);
},

_storageRoomLabel(holding, roomId = "outdoors") {
  return this._storageRoomLabelFromRooms(this._storageRooms(holding, { includeUnavailable: true }), roomId);
},

_storageRoomLabelFromRooms(rooms = [], roomId = "outdoors") {
  return storageRoomLabelFromRooms(rooms, roomId);
},

_storageRoomsContext(holding, roomsArg = null) {
  const rooms = Array.isArray(roomsArg) ? roomsArg : this._storageRooms(holding, { includeUnavailable: true });
  return storageRoomsContext(rooms);
},

_storageSearchRows(holding, roomsArg = null) {
  const rooms = Array.isArray(roomsArg) ? roomsArg : this._storageRooms(holding, { includeUnavailable: true });
  return buildStorageSearchRows({
    resources: holding?.storage?.resources ?? [],
    items: holding?.storage?.items ?? [],
    dependencies: {
      safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback),
      itemQuantity: (item) => this._itemQuantity(item),
      normalizeRoomId: (roomId) => this._normalizeStorageRoomId(roomId),
      roomLabel: (roomId) => this._storageRoomLabelFromRooms(rooms, roomId),
      resourceLabel: (row) => {
        const id = normalizeResourceId(row?.resourceId, row?.name);
        return id === "custom" ? String(row?.name || "Ресурс") : resourceLabel(id);
      }
    }
  });
},

_storageContext(holding, canEdit = false, activeRoomId = "outdoors") {
  const activeSubtab = String(this.activeStorageTab ?? "resources");
  if (activeSubtab === "accounting") {
    return {
      rows: [], visibleRows: [], activeRoomRows: [], activeItemRows: [],
      activeRoomId: this._normalizeStorageRoomId(activeRoomId), activeRoom: null, resourceRooms: [], resourceRoomCount: 0,
      visibleCount: 0, itemCount: 0, activeRoomCount: 0, activeItemCount: 0, categoryCount: 0,
      hasRows: false, hasVisibleRows: false, hasActiveRoomRows: false, hasActiveItemRows: false,
      zeroCount: 0, categories: [], money: this._moneyContext(holding),
      rooms: { rows: [], hasRooms: false, builtCount: 0, buildingCount: 0 },
      roomOptions: [], moveFromOptions: [], moveToOptions: [], logRows: [], resourceOptions: [],
      actorOptions: [], hasActorOptions: false, targetActor: this._storageTargetActorContext(),
      searchQuery: String(this.storageSearchQuery ?? ""), searchRows: this._storageSearchRows(holding),
      notes: holding?.storage?.notes ?? "",
      batchSelection: { rowType: "resources", selectedCount: 0, totalCount: 0, hasSelection: false, allSelected: false }
    };
  }

  const roomsAll = this._storageRooms(holding, { includeUnavailable: true });
  const rawRows = (holding?.storage?.resources ?? []).map((row, index) => ({ ...row, __storageIndex: index })).filter((row) => !isMoneyResource(row?.resourceId, row?.name));
  const rawItemRows = (holding?.storage?.items ?? []).map((row, index) => ({ ...row, __storageIndex: index }));
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
  const activeRawRows = activeSubtab === "resources" ? visibleRawRows.filter((row) => this._normalizeStorageRoomId(row.roomId ?? row.storageRoomId) === activeRoom) : [];
  const activeRawItems = activeSubtab === "items" ? visibleItemRows.filter((row) => this._normalizeStorageRoomId(row.roomId ?? row.storageRoomId) === activeRoom) : [];
  const activeRoomRows = activeSubtab === "resources" ? this._prepareStorageRows(holding, canEdit, roomsAll, activeRawRows) : [];
  const activeItemRows = activeSubtab === "items" ? this._prepareStorageItemRows(holding, canEdit, roomsAll, activeRawItems) : [];
  const batchRowType = activeSubtab === "items" ? "items" : "resources";
  const batchSet = this.storageBatchSelection?.[batchRowType] instanceof Set ? this.storageBatchSelection[batchRowType] : new Set();
  const batchRows = batchRowType === "items" ? activeItemRows : activeRoomRows;
  for (const row of batchRows) row.batchSelected = batchSet.has(String(row.id ?? ""));
  const selectedBatchRows = batchRows.filter((row) => row.batchSelected);
  const activeRoomInfo = roomsAll.find((room) => room.id === activeRoom) ?? roomsAll[0] ?? null;
  const resourceRooms = roomsAll.filter((room) => room.available || room.source === "base" || roomsWithRows.has(room.id)).map((room) => ({ ...room, active: room.id === activeRoom, itemCount: roomItemCounts.get(room.id) ?? 0 }));
  const byCategory = new Map();
  for (const row of activeRoomRows) byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + 1);
  const categories = Array.from(byCategory.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const moveToDefault = roomsAll.find((room) => room.available && room.id !== activeRoom)?.id ?? activeRoom;
  const targetActor = this._storageTargetActorContext();
  const selectableResourceOptions = activeSubtab === "resources" ? resourceOptions("", "", { includeMoney: false }) : [];
  const defaultResourceOption = selectableResourceOptions.find((row) => row.selected) ?? selectableResourceOptions[0] ?? { value: "custom", label: "Другой материал…" };
  return {
    rows: activeRoomRows, visibleRows: visibleRawRows, activeRoomRows, activeItemRows,
    activeRoomId: activeRoom, activeRoom: activeRoomInfo, resourceRooms, resourceRoomCount: resourceRooms.length,
    visibleCount: visibleRawRows.length, itemCount: visibleItemRows.length,
    activeRoomCount: activeRoomRows.length, activeItemCount: activeItemRows.length,
    categoryCount: categories.length, hasRows: rawRows.length > 0, hasVisibleRows: visibleRawRows.length > 0,
    hasActiveRoomRows: activeRoomRows.length > 0, hasActiveItemRows: activeItemRows.length > 0,
    zeroCount: rawRows.length - visibleRawRows.length, categories, money: this._moneyContext(holding),
    rooms: this._storageRoomsContext(holding, roomsAll),
    roomOptions: ["resources", "items"].includes(activeSubtab) ? this._storageRoomOptionsFromRooms(roomsAll, activeRoom) : [],
    moveFromOptions: activeSubtab === "resources" ? this._storageRoomOptionsFromRooms(roomsAll, activeRoom) : [],
    moveToOptions: ["resources", "items"].includes(activeSubtab) ? this._storageRoomOptionsFromRooms(roomsAll, moveToDefault) : [],
    logRows: activeSubtab === "log" ? this._storageLogRows(holding, roomsAll) : [],
    resourceOptions: selectableResourceOptions,
    defaultResourceId: defaultResourceOption.value,
    defaultResourceLabel: defaultResourceOption.label,
    actorOptions: [], hasActorOptions: false, targetActor,
    searchQuery: String(this.storageSearchQuery ?? ""), searchRows: this._storageSearchRows(holding, roomsAll),
    notes: holding?.storage?.notes ?? "",
    batchSelection: {
      rowType: batchRowType,
      selectedCount: selectedBatchRows.length,
      totalCount: batchRows.length,
      hasSelection: selectedBatchRows.length > 0,
      allSelected: batchRows.length > 0 && selectedBatchRows.length === batchRows.length
    }
  };
}
};
