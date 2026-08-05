// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { makeId } from "../../../data/utils.js";
import {
  isMoneyResource,
  normalizeResourceId,
  resourceDef,
  resourceIcon,
  resourceImage,
  resourceItemUuid,
  resourceLabel,
  resourceUnit,
  parseResourceCosts
} from "../../../core/resources.js";
import { moveStorageResource } from "../../../engines/storage/move.js";
import { applyStorageBatchMove, planStorageBatchMove } from "../../../engines/storage/batch-move.js";
import { payStorageCosts } from "../../../engines/storage/payment.js";
import { planStorageCosts } from "../../../engines/storage/group-payment.js";
import { addStorageWithOverflow } from "../../../engines/storage/placement.js";
import { resourceMatchesMaterialGroup } from "../../../core/material-groups.js";
import { economyLedgerStorageRows } from "../../../engines/economy/ledger.js";
import { FinanceStorageContextDomain } from "./storage/context-domain.js";
import { FinanceStorageItemDocumentDomain } from "./storage/item-document-domain.js";
import { composeDomainGroup } from "../compose-domain.js";
import { addResourceLot, resourceShelfLifeDaysForMode } from "../../../core/resource-lots.js";
import { consumeAvailableStorageLots, storageAvailableQuantity, storageAvailableUsableQuantity } from "../../../engines/storage/reservations.js";

const FinanceStorageCoreDomain = {
_storageLogRows(holding, roomsArg = null) {
  const rooms = Array.isArray(roomsArg) ? roomsArg : this._storageRooms(holding, { includeUnavailable: true });
  const roomLabelCache = new Map();
  const labelFor = (roomId) => {
    const id = this._normalizeStorageRoomId(roomId);
    if (!roomLabelCache.has(id)) roomLabelCache.set(id, this._storageRoomLabelFromRooms(rooms, id));
    return roomLabelCache.get(id);
  };
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
    const roomLabel = row.roomId ? labelFor(row.roomId) : "";
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
      roomLabel,
      note: [roomLabel, row.note || row.period || ""].filter(Boolean).join(" · ")
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
  const storageRooms = this._storageRooms(holding, { includeUnavailable: true });
  const workerContext = this._economyWorkerContext?.(holding) ?? null;
  for (const building of holding?.buildings?.list ?? []) {
    if (this._buildingStatus(building).value !== "built") continue;
    const functions = this._buildingFunctions(building);
    const lines = functions.production ? this._prepareProductionLines(building, 0, holding, storageRooms).filter((line) => line.active) : [];
    const income = functions.income ? this._buildingIncomeSummary(building, holding, workerContext) : null;
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
  const exactRowId = String(resource.storageRowId ?? "").trim();
  if (exactRowId) {
    return holding.storage.resources.find((row) => (
      String(row?.id ?? "") === exactRowId
      && this._normalizeStorageRoomId(row.roomId ?? row.storageRoomId) === roomId
      && this._storageResourceMatches(row, resource)
    )) ?? null;
  }
  const hasExactRowIndex = resource.storageRowIndex !== undefined && resource.storageRowIndex !== null && resource.storageRowIndex !== "";
  const exactRowIndex = Number(resource.storageRowIndex);
  if (hasExactRowIndex && Number.isInteger(exactRowIndex) && exactRowIndex >= 0) {
    const row = holding.storage.resources[exactRowIndex];
    return row
      && this._normalizeStorageRoomId(row.roomId ?? row.storageRoomId) === roomId
      && this._storageResourceMatches(row, resource)
      ? row
      : null;
  }
  return holding.storage.resources.find((row) => this._normalizeStorageRoomId(row.roomId ?? row.storageRoomId) === roomId && this._storageResourceMatches(row, resource)) ?? null;
},

_storageQuantity(holding, resource = {}) {
  if (isMoneyResource(resource.resourceId, resource.id, resource.name)) return this._moneyCopper(holding);
  const resourceGroup = String(resource.resourceGroup ?? "").trim();
  const hasRoom = resource.roomId !== undefined || resource.storageRoomId !== undefined;
  if (resourceGroup) {
    const roomId = hasRoom ? this._normalizeStorageRoomId(resource.roomId ?? resource.storageRoomId) : "";
    return (holding?.storage?.resources ?? [])
      .filter((row) => !hasRoom || this._normalizeStorageRoomId(row.roomId ?? row.storageRoomId) === roomId)
      .filter((row) => this._storageResourceMatchesGroup(row, resourceGroup))
      .reduce((sum, row) => sum + this._storageAvailableQuantity(holding, row), 0);
  }
  if (hasRoom) return this._storageAvailableQuantity(holding, this._storageFind(holding, resource));
  return (holding?.storage?.resources ?? [])
    .filter((row) => this._storageResourceMatches(row, resource))
    .reduce((sum, row) => sum + this._storageAvailableQuantity(holding, row), 0);
},

_storageAvailableQuantity(holding, row = null) {
  if (!row) return 0;
  return storageAvailableQuantity(holding, row);
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
  if (!row && qty < 0) return null;
  if (!row) {
    row = {
      id: makeId("res", 12),
      resourceId: id,
      name,
      qty: 0,
      unit: resourceUnit(id, name),
      img: id === "custom" ? String(resource.img ?? "") : resourceImage(id),
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
  row.unit = resourceUnit(id, name);
  row.img = id === "custom" ? (row.img || resource.img || "") : resourceImage(id);
  row.itemUuid = row.itemUuid || resource.itemUuid || resourceItemUuid(id);
  row.itemId = row.itemId || resource.itemId || resourceDef(id)?.itemId || "";
  row.itemType = row.itemType || resource.itemType || resourceDef(id)?.itemType || "";
  row.cost = row.cost || resource.cost || resourceDef(id)?.cost || "";
  if (resource.cargoPoints !== undefined && resource.cargoPoints !== null && resource.cargoPoints !== "") {
    row.cargoPoints = Math.max(0, Math.ceil(this._safeNumber(resource.cargoPoints, 0)));
  }
  if (resource.weight !== undefined && resource.weight !== null && resource.weight !== "") row.weight = resource.weight;
  if (resource.load !== undefined && resource.load !== null && resource.load !== "") row.load = Math.max(0, this._safeNumber(resource.load, 0));
  row.roomId = roomId;
  const currentQd = Math.max(0, this._safeNumber(resource.receivedQd ?? resource.acquiredQd ?? holding?.gm?.calendaria?.lastQd, 0));
  const definition = resourceDef(id);
  const shelfLifeDays = resourceShelfLifeDaysForMode({ ...row, ...resource }, definition);
  if (qty > 0) {
    addResourceLot(row, qty, {
      currentQd,
      shelfLifeDays,
      source: resource.lotSource ?? resource.source ?? "",
      lots: resource.lots
    });
  } else {
    consumeAvailableStorageLots(holding, row, Math.abs(qty), { currentQd, shelfLifeDays });
  }
  return row;
},

_storageTakeLots(holding, resource = {}, qty = 0, { usableAtQd = null } = {}) {
  const row = resource?.qty !== undefined && (holding?.storage?.resources ?? []).includes(resource)
    ? resource
    : this._storageFind(holding, resource);
  if (!row) return [];
  const id = normalizeResourceId(row.resourceId, row.id, row.name);
  const currentQd = Math.max(0, this._safeNumber(holding?.gm?.calendaria?.lastQd, 0));
  const shelfLifeDays = resourceShelfLifeDaysForMode(row, resourceDef(id));
  const roomId = String(row?.roomId ?? row?.storageRoomId ?? "outdoors") || "outdoors";
  const storageQuality = Math.max(0, this._safeNumber(this._storageRooms(holding, { includeUnavailable: true }).find((room) => String(room?.id ?? "") === roomId)?.quality, 0));
  return consumeAvailableStorageLots(holding, row, qty, {
    currentQd,
    shelfLifeDays,
    usableAtQd,
    storageQuality
  });
},

_storageUsableQuantityAtQd(holding, row = {}, targetQd = 0) {
  const id = normalizeResourceId(row.resourceId, row.id, row.name);
  const currentQd = Math.max(0, this._safeNumber(holding?.gm?.calendaria?.lastQd, 0));
  const shelfLifeDays = resourceShelfLifeDaysForMode(row, resourceDef(id));
  const roomId = String(row?.roomId ?? row?.storageRoomId ?? "outdoors") || "outdoors";
  const storageQuality = Math.max(0, this._safeNumber(this._storageRooms(holding, { includeUnavailable: true }).find((room) => String(room?.id ?? "") === roomId)?.quality, 0));
  return storageAvailableUsableQuantity(holding, row, { currentQd, shelfLifeDays, usableAtQd: targetQd, storageQuality });
},

_storageAddWithOverflow(holding, resource = {}, qty = 0) {
  return addStorageWithOverflow({
    holding,
    resource,
    qty,
    dependencies: this._storagePlacementDependencies()
  });
},

_storagePlacementDependencies() {
  return {
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback),
    normalizeResourceId,
    isMoneyResource,
    normalizeStorageRoomId: (roomId) => this._normalizeStorageRoomId(roomId),
    storageRooms: (holding, options) => this._storageRooms(holding, options),
    storageAdd: (holding, resource, qty) => this._storageAdd(holding, resource, qty),
    storageUnitLoad: (resource) => this._storageUnitLoad(resource)
  };
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
  return planStorageCosts({
    holding,
    costs,
    dependencies: this._storageCostPlanningDependencies()
  });
},

_storagePay(holding, costs = []) {
  const plan = this._storageCanPay(holding, costs);
  if (!plan.ok) return plan;
  payStorageCosts({
    holding,
    costs: plan.costs,
    dependencies: this._storagePaymentDependencies()
  });
  return plan;
},

_storageResourceMatchesGroup(row = {}, groupId = "") {
  const id = normalizeResourceId(row.resourceId, row.id, row.name);
  return resourceMatchesMaterialGroup(row, groupId, id === "custom" ? null : resourceDef(id));
},

_storageCostPlanningDependencies() {
  return {
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback),
    isMoneyResource,
    storageResourceMatches: (row, resource) => this._storageResourceMatches(row, resource),
    resourceMatchesGroup: (row, groupId) => this._storageResourceMatchesGroup(row, groupId),
    storageAvailableQuantity: (holding, row) => this._storageAvailableQuantity(holding, row),
    normalizeRoomId: (roomId) => this._normalizeStorageRoomId(roomId)
  };
},

_storagePaymentDependencies() {
  return {
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback),
    isMoneyResource,
    storageQuantity: (holding, resource) => this._storageQuantity(holding, resource),
    addMoney: (holding, amount) => this._addMoney(holding, amount),
    storageAdd: (holding, resource, qty) => this._storageAdd(holding, resource, qty),
    storageResourceMatches: (row, resource) => this._storageResourceMatches(row, resource),
    storageAvailableQuantity: (holding, row) => this._storageAvailableQuantity(holding, row)
  };
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
      id: makeId("slog", 12),
      ts: raw?.ts ?? now,
      laputaDateText: String(raw?.laputaDateText ?? raw?.holdingDateText ?? laputaDateText),
      kind: String(raw?.kind ?? "manual"),
      resourceId: id,
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
},

_applyManualStorageChange(holding, { resourceId = "custom", name = "", qty = 0, note = "", kind = "manual-add", roomId = "outdoors" } = {}) {
  const amount = this._safeNumber(qty, 0);
  if (!amount) return { ok: false, message: "Укажи количество." };
  const id = normalizeResourceId(resourceId, name);
  const label = id === "custom" ? (String(name).trim() || "Ресурс") : resourceLabel(id);
  const targetRoom = this._normalizeStorageRoomId(roomId);
  let placements = [];
  if (amount > 0) placements = this._storageAddWithOverflow(holding, { resourceId: id, name: label, roomId: targetRoom }, amount);
  else {
    const available = this._storageQuantity(holding, { resourceId: id, name: label, roomId: targetRoom });
    if (available + 0.0001 < Math.abs(amount)) {
      return { ok: false, message: `${label}: нельзя списать ${this._formatNumber(Math.abs(amount))}. Доступно ${this._formatNumber(available)}.` };
    }
    this._storageAdd(holding, { resourceId: id, name: label, roomId: targetRoom }, amount);
  }
  const entries = amount > 0 && placements.length
    ? placements.map((item) => ({ kind, resourceId: id, name: label, qty: item.qty, roomId: item.roomId, source: "Ручная правка", note: item.overflowFrom ? [note, `переполнение: ${this._storageRoomLabel(holding, item.overflowFrom)}`].filter(Boolean).join(" · ") : note }))
    : [{ kind, resourceId: id, name: label, qty: amount, roomId: targetRoom, source: "Ручная правка", note }];
  this._appendStorageLog(holding, entries);
  const suffix = isMoneyResource(id, label) ? "" : (amount > 0 ? `; ${this._storagePlacementText(holding, placements)}` : ` → ${this._storageRoomLabel(holding, targetRoom)}`);
  return { ok: true, message: `${label}: ${amount > 0 ? "+" : ""}${this._formatNumber(amount)}${suffix}.` };
},

_applyStorageMove(holding, { resourceId = "custom", name = "", qty = 0, fromRoomId = "outdoors", toRoomId = "outdoors", note = "" } = {}) {
  return moveStorageResource({
    holding,
    resourceId,
    name,
    qty,
    fromRoomId,
    toRoomId,
    note,
    dependencies: this._storageMoveDependencies()
  });
},

_storageBatchMoveDependencies() {
  return {
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback),
    normalizeStorageRoomId: (roomId) => this._normalizeStorageRoomId(roomId),
    itemQuantity: (row) => this._itemQuantity(row),
    storageRooms: (holding, options) => this._storageRooms(holding, options),
    storageRowLoad: (row) => this._storageRowLoad(row),
    storageAvailableQuantity: (holding, row) => this._storageAvailableQuantity(holding, row),
    storageRoomLabel: (holding, roomId) => this._storageRoomLabel(holding, roomId),
    addResourceWithOverflow: (holding, resource, qty) => this._storageAddWithOverflow(holding, resource, qty),
    takeResourceLots: (holding, resource, qty) => this._storageTakeLots(holding, resource, qty),
    appendStorageLog: (holding, entries) => this._appendStorageLog(holding, entries),
    formatNumber: (value) => this._formatNumber(value)
  };
},

_planStorageBatchMove(holding, options = {}) {
  return planStorageBatchMove({
    holding,
    ...options,
    dependencies: this._storageBatchMoveDependencies()
  });
},

_applyStorageBatchMove(holding, options = {}) {
  return applyStorageBatchMove({
    holding,
    ...options,
    dependencies: this._storageBatchMoveDependencies()
  });
},

_storageMoveDependencies() {
  return {
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback),
    normalizeStorageRoomId: (roomId) => this._normalizeStorageRoomId(roomId),
    normalizeResourceId,
    isMoneyResource,
    resourceLabel,
    resourceUnit,
    storageFind: (holding, resource) => this._storageFind(holding, resource),
    storageUnitLoad: (resource) => this._storageUnitLoad(resource),
    storageAvailableQuantity: (holding, row) => this._storageAvailableQuantity(holding, row),
    storageAdd: (holding, resource, qty) => this._storageAdd(holding, resource, qty),
    storageAddWithOverflow: (holding, resource, qty) => this._storageAddWithOverflow(holding, resource, qty),
    takeResourceLots: (holding, resource, qty) => this._storageTakeLots(holding, resource, qty),
    storageRoomLabel: (holding, roomId) => this._storageRoomLabel(holding, roomId),
    appendStorageLog: (holding, entries) => this._appendStorageLog(holding, entries),
    storagePlacementText: (holding, placements) => this._storagePlacementText(holding, placements),
    formatNumber: (value) => this._formatNumber(value)
  };
},

_appendEconomyStorageLog(holding, report, { operationId = "" } = {}) {
  const summarized = this._summarizeEconomyReport(report);
  if (Array.isArray(summarized.ledger) && summarized.ledger.length) {
    this._appendStorageLog(holding, economyLedgerStorageRows(summarized.ledger, {
      operationId,
      period: summarized.periodLabel || ""
    }));
    return summarized;
  }

  // Compatibility path for reports saved before ledger schema 2. New economy
  // runs never depend on parsing presentation strings.
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
        period: summarized.periodLabel || "",
        operationId: String(operationId ?? "")
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

export const FinanceStorageDomain = composeDomainGroup("FinanceStorageDomain", [
  ["FinanceStorageContextDomain", FinanceStorageContextDomain],
  ["FinanceStorageCoreDomain", FinanceStorageCoreDomain],
  ["FinanceStorageItemDocumentDomain", FinanceStorageItemDocumentDomain]
]);
