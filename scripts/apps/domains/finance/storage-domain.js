// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { clone, makeId } from "../../../data/utils.js";
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
import { storageProfileLoadMultiplier } from "../../../engines/storage/specialization.js";
import { resourceMatchesMaterialGroup } from "../../../core/material-groups.js";
import { economyLedgerStorageRows } from "../../../engines/economy/ledger.js";
import { FinanceStorageContextDomain } from "./storage/context-domain.js";
import { FinanceStorageItemDocumentDomain } from "./storage/item-document-domain.js";
import { composeDomainGroup } from "../compose-domain.js";
import {
  addResourceBatches,
  availableResourceBatchInventory,
  availableResourceRowQuantity,
  isResourceBatchPeriodActive,
  protectedResourceBatchIds,
  splitResourceBatchParts,
  syncResourceRowBatches,
  takeResourceBatches
} from "../../../core/resource-batches.js";

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
  const storageRowId = String(resource.storageRowId ?? "").trim();
  const row = holding.storage.resources.find((candidate) => {
    if (storageRowId && String(candidate?.id ?? "") !== storageRowId) return false;
    return this._normalizeStorageRoomId(candidate.roomId ?? candidate.storageRoomId) === roomId && this._storageResourceMatches(candidate, resource);
  }) ?? null;
  if (row) syncResourceRowBatches(row, { makeId, compact: !isResourceBatchPeriodActive(holding), protectedBatchIds: protectedResourceBatchIds(holding, row) });
  return row;
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
      .reduce((sum, row) => sum + availableResourceRowQuantity(row, holding), 0);
  }
  if (hasRoom) return availableResourceRowQuantity(this._storageFind(holding, resource), holding);
  return (holding?.storage?.resources ?? [])
    .filter((row) => this._storageResourceMatches(row, resource))
    .reduce((sum, row) => sum + availableResourceRowQuantity(row, holding), 0);
},

_storageAvailableRowQuantity(holding, row = {}) {
  return availableResourceRowQuantity(row, holding);
},

_storageAdd(holding, resource = {}, qty = 0) {
  const amount = Math.trunc(this._safeNumber(qty, 0));
  if (!amount) return null;
  if (!holding.storage) holding.storage = { notes: "", resources: [], moneyCopper: 0, log: [] };
  if (!Array.isArray(holding.storage.resources)) holding.storage.resources = [];
  const id = normalizeResourceId(resource.resourceId, resource.id, resource.name);
  if (isMoneyResource(id, resource.name)) {
    this._addMoney(holding, amount);
    return { id: "money", resourceId: "money", name: "Деньги", qty: this._moneyCopper(holding), unit: "медн.", notes: "" };
  }
  const name = id === "custom" ? String(resource.name ?? "Ресурс") : resourceLabel(id);
  const roomId = this._normalizeStorageRoomId(resource.roomId ?? resource.storageRoomId);
  let row = this._storageFind(holding, { resourceId: id, name, roomId, storageRowId: resource.storageRowId });
  if (!row && amount < 0) return null;
  if (!row) {
    row = {
      id: makeId("res", 12),
      resourceId: id,
      name,
      qty: 0,
      batches: [],
      unit: "ед.",
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
  row.unit = "ед.";
  row.img = id === "custom" ? (row.img || resource.img || "") : resourceImage(id);
  row.itemUuid = row.itemUuid || resource.itemUuid || resourceItemUuid(id);
  row.itemId = row.itemId || resource.itemId || resourceDef(id)?.itemId || "";
  row.itemType = row.itemType || resource.itemType || resourceDef(id)?.itemType || "";
  row.cost = row.cost || resource.cost || resourceDef(id)?.cost || "";
  row.roomId = roomId;
  if (amount > 0) {
    const input = Object.prototype.hasOwnProperty.call(resource, "batches")
      ? { batches: resource.batches }
      : { qty: amount, ageQd: resource.ageQd };
    addResourceBatches(row, input, { holding, makeId });
  } else takeResourceBatches(row, Math.abs(amount), { holding, makeId });
  return row;
},

_storageTake(holding, resource = {}, qty = 0) {
  const amount = Math.max(0, Math.floor(this._safeNumber(qty, 0)));
  const row = this._storageFind(holding, resource);
  if (!row || !amount) return { requested: amount, takenQty: 0, batches: [], shortfall: amount, row: row ?? null };
  return { ...takeResourceBatches(row, amount, { holding, makeId }), row };
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
    splitTransferBatches: (batches, qty) => splitResourceBatchParts(batches, qty),
    storageUnitLoad: (resource) => this._storageUnitLoad(resource),
    storageProfileLoadMultiplier
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

_storagePay(holding, costs = [], { captureReceipt = false } = {}) {
  const plan = this._storageCanPay(holding, costs);
  if (!plan.ok) return plan;
  const receipt = payStorageCosts({
    holding,
    costs: plan.costs,
    captureReceipt,
    dependencies: this._storagePaymentDependencies()
  });
  return captureReceipt ? { ...plan, receipt } : plan;
},

_restoreProductionResource(holding, resource, qty) {
  // Recreate the original custom metadata if its empty inventory row was removed.
  if (!this._storageFind(holding, resource)) {
    const row = { ...resource, qty: 0, batches: [] };
    delete row.storageRowId;
    holding.storage.resources.push(row);
  }
  return this._storageAdd(holding, resource, qty);
},

_storageResourceMatchesGroup(row = {}, groupId = "") {
  const id = normalizeResourceId(row.resourceId, row.id, row.name);
  const definition = id === "custom" ? null : resourceDef(id);
  if (row.noAutoConsume === true || definition?.noAutoConsume === true) return false;
  return resourceMatchesMaterialGroup(row, groupId, definition);
},

_storageCostPlanningDependencies() {
  return {
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback),
    isMoneyResource,
    storageResourceMatches: (row, resource) => this._storageResourceMatches(row, resource),
    resourceMatchesGroup: (row, groupId) => this._storageResourceMatchesGroup(row, groupId),
    normalizeRoomId: (roomId) => this._normalizeStorageRoomId(roomId),
    resourceBatches: (row, holding) => availableResourceBatchInventory(row, holding)
  };
},

_storagePaymentDependencies() {
  return {
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback),
    isMoneyResource,
    storageQuantity: (holding, resource) => this._storageQuantity(holding, resource),
    addMoney: (holding, amount) => this._addMoney(holding, amount),
    storageAdd: (holding, resource, qty) => this._storageAdd(holding, resource, qty),
    storageTake: (holding, resource, qty) => this._storageTake(holding, resource, qty),
    storageResourceMatches: (row, resource) => this._storageResourceMatches(row, resource)
  };
},

_appendStorageLog(holding, entries = []) {
  if (!holding.storage) holding.storage = { notes: "", resources: [], moneyCopper: 0, log: [] };
  if (!Array.isArray(holding.storage.log)) holding.storage.log = [];
  const now = new Date().toISOString();
  const laputaDateText = String(holding?.gm?.calendaria?.lastDateText ?? holding?.gm?.calendaria?.lastDateKey ?? "").trim();
  for (const raw of entries) {
    const qty = Math.trunc(this._safeNumber(raw?.qty, 0));
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

_applyManualStorageChange(holding, { resourceId = "custom", name = "", qty = 0, note = "", kind = "manual-add", roomId = "outdoors", operationId = "" } = {}) {
  const amount = Math.trunc(this._safeNumber(qty, 0));
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
    ? placements.map((item) => ({ kind, resourceId: id, name: label, qty: item.qty, roomId: item.roomId, source: "Ручная правка", note: item.overflowFrom ? [note, `переполнение: ${this._storageRoomLabel(holding, item.overflowFrom)}`].filter(Boolean).join(" · ") : note, operationId }))
    : [{ kind, resourceId: id, name: label, qty: amount, roomId: targetRoom, source: "Ручная правка", note, operationId }];
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
    storageRoomLabel: (holding, roomId) => this._storageRoomLabel(holding, roomId),
    addResourceWithOverflow: (holding, resource, qty) => this._storageAddWithOverflow(holding, resource, qty),
    clone,
    makeId,
    setItemQuantity: (row, qty) => {
      const amount = Math.max(1, Math.floor(this._safeNumber(qty, 1)));
      row.qty = amount;
      if (row.quantity !== undefined) row.quantity = amount;
      if (row.itemData?.system && typeof row.itemData.system === "object") row.itemData.system.quantity = amount;
      if (row.system && typeof row.system === "object") row.system.quantity = amount;
      return row;
    },
    takeResourceRow: (holding, row, qty) => takeResourceBatches(row, qty, { holding, makeId }),
    resourceAvailableQuantity: (holding, row) => this._storageAvailableRowQuantity(holding, row),
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
    storageAvailableQuantity: (holding, row) => this._storageAvailableRowQuantity(holding, row),
    storageUnitLoad: (resource) => this._storageUnitLoad(resource),
    storageAdd: (holding, resource, qty) => this._storageAdd(holding, resource, qty),
    storageTake: (holding, resource, qty) => this._storageTake(holding, resource, qty),
    storageAddWithOverflow: (holding, resource, qty) => this._storageAddWithOverflow(holding, resource, qty),
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
