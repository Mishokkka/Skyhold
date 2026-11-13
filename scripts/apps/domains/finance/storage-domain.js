// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { clone, makeId } from "../../../data/utils.js";
import {
  isMoneyResource,
  isStorageMoneyResource,
  normalizeResourceId,
  normalizeResourceRow,
  resourceDef,
  resourceIcon,
  resourceLabel,
  resourceUnit,
  parseResourceCosts,
  storageResourceId,
  storageResourceStackKey
} from "../../../core/resources.js";
import { moveStorageResource } from "../../../engines/storage/move.js";
import { applyStorageBatchMove, planStorageBatchMove } from "../../../engines/storage/batch-move.js";
import { payStorageCosts } from "../../../engines/storage/payment.js";
import { planStorageCosts } from "../../../engines/storage/group-payment.js";
import { addStorageWithOverflow } from "../../../engines/storage/placement.js";
import { storageEffectiveRowLoad, storageProfileLoadMultiplier } from "../../../engines/storage/specialization.js";
import { indexStorageRows, resolveStorageRow, resolveStorageRows } from "../../../engines/storage/row-identity.js";
import { resourceMatchesMaterialGroup } from "../../../core/material-groups.js";
import { economyLedgerStorageRows } from "../../../engines/economy/ledger.js";
import { perishableStorageExpiresInQd } from "../../../engines/economy/perishable-storage.js";
import { FinanceStorageContextDomain } from "./storage/context-domain.js";
import { FinanceStorageItemDocumentDomain } from "./storage/item-document-domain.js";
import { composeDomainGroup } from "../compose-domain.js";
import { createMarketVisibility, marketLogSources } from "../../../data/market/visibility.js";
import { hiddenStorageRoomIds } from "../../../data/access-guard.js";
import {
  addResourceBatches,
  availableResourceBatchInventory,
  availableResourceRowQuantity,
  isResourceBatchPeriodActive,
  protectedResourceBatchIds,
  resourceBatchAgeQd,
  splitResourceBatchParts,
  syncResourceRowBatches,
  takeResourceBatchById,
  takeResourceBatches
} from "../../../core/resource-batches.js";

function legacyRecipeResource(cost) {
  if (cost?.storageRowId || String(cost?.resourceId ?? "").trim().toLowerCase() !== "custom") return cost;
  return { ...cost, resourceId: normalizeResourceId(cost.id, cost.name) };
}

const PUBLIC_STORAGE_SOURCES = new Set([
  "Склад", "Ручная правка", "Перемещение", "Пакетное перемещение",
  "Инвентарь Foundry", "Предмет Foundry", "Выдача Foundry",
  "Казна", "Питание поселения", "Порча сырья", "Порча запасов", "Управление кадров",
  "Перевозки", "Отправление груза"
]);
const MANUAL_STORAGE_LOG_KINDS = new Set(["manual-add", "manual-spend"]);

function publicStorageLogNote(row, visibleRoomNames) {
  const note = String(row.note ?? "");
  if (row.source === "Выдача Foundry" && note.startsWith("получатель: ")) return "";
  if ((row.source === "Предмет Foundry" || row.source === "Инвентарь Foundry") && note.startsWith("из ")) {
    return note.includes(" · переполнение: ") ? "переполнение" : "";
  }
  return note.replace(/(^| · |; |, )переполнение: ([\s\S]*)$/u,
    (match, prefix, label) => visibleRoomNames.has(label) ? match : `${prefix}переполнение`);
}

function tendayStorageSourceIds(holding, rows, keyFor) {
  const requested = new Set(rows.map((row) => row.operationId).filter(Boolean));
  const sources = new Map();
  for (const operation of holding?.log ?? []) {
    const ledger = operation.payload?.economy?.ledger;
    if (operation.type !== "tenday" || !requested.has(operation.operationId)
      || !Array.isArray(ledger?.rows) || ledger.truncated || ledger.total !== ledger.rows.length) continue;
    for (const entry of economyLedgerStorageRows(ledger.rows, { operationId: operation.operationId })) {
      if (entry.operationId !== operation.operationId) continue;
      const key = keyFor(entry);
      // Identical visible rows from different producers do not establish provenance.
      sources.set(key, sources.has(key) && sources.get(key) !== entry.sourceId ? null : entry.sourceId);
    }
  }
  return sources;
}

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
  const isGM = Boolean(globalThis.game?.user?.isGM);
  const hiddenRooms = hiddenStorageRoomIds(holding, isGM);
  let visibleLog = log;
  if (hiddenRooms.size) {
    const hiddenRoom = (id) => hiddenRooms.has(this._normalizeStorageRoomId(id));
    const isMove = (row) => row.kind === "move-in" || row.kind === "move-out"
      || (row.kind === "note" && row.source === "Пакетное перемещение");
    const hiddenMoves = new Set(log.filter((row) => isMove(row) && row.operationId && hiddenRoom(row.roomId)).map((row) => row.operationId));
    const knownMoves = new Set();
    // The receipts retain requested rooms and actual destinations even when the storage journal is truncated.
    for (const operation of holding?.log ?? []) {
      const result = operation.payload?.result;
      if (!Array.isArray(result?.placements)) continue;
      if (result.placements.some((placement) => hiddenRoom(placement.roomId))) hiddenMoves.add(operation.operationId);
      let request;
      try {
        request = JSON.parse(operation.payload.signature);
      } catch {
        continue;
      }
      if (request?.type !== "batchMove" || !request.fromRoomId || !request.toRoomId) continue;
      knownMoves.add(operation.operationId);
      if (hiddenRoom(request.fromRoomId) || hiddenRoom(request.toRoomId)) hiddenMoves.add(operation.operationId);
    }
    visibleLog = log.filter((row) => !hiddenRoom(row.roomId) && !(isMove(row) && hiddenMoves.has(row.operationId)))
      .filter((row) => !isMove(row) || row.kind !== "note" || knownMoves.has(row.operationId))
      .map((row) => isMove(row) && !knownMoves.has(row.operationId) ? { ...row, note: "" } : row);
  }
  const rows = visibleLog.slice(-80).reverse();
  const sources = marketLogSources(holding, rows);
  const visibility = createMarketVisibility(this._contextData, { isGM });
  const visibleRoomNames = new Set(rooms.filter((room) => !hiddenRooms.has(room.id)).map((room) => room.label));
  const sourceKey = (row, resourceId = storageResourceId(row)) => JSON.stringify([
    row.operationId, row.kind, resourceId, resourceId === "custom" ? row.name : "",
    isStorageMoneyResource(row) ? "" : this._normalizeStorageRoomId(row.roomId), Math.trunc(row.qty), row.source, row.note || ""
  ]);
  const tendaySources = isGM ? null : tendayStorageSourceIds(holding, rows, sourceKey);
  const publicBuildingNames = new Map((holding?.buildings?.list ?? []).filter((building) => !hiddenRooms.has(String(building.id)))
    .map((building) => [String(building.id), building.name]));
  return rows.map((row) => {
    const id = storageResourceId(row);
    const name = id === "custom" ? (row.name || "Ресурс") : resourceLabel(id);
    const qty = this._safeNumber(row.qty, 0);
    const sign = qty > 0 ? "+" : "";
    const date = row.ts ? new Date(row.ts) : null;
    const realDateText = date && !Number.isNaN(date.getTime()) ? date.toLocaleString("ru-RU") : "—";
    const holdingDateText = String(holding?.gm?.calendaria?.lastDateText ?? holding?.gm?.calendaria?.lastDateKey ?? "").trim();
    const laputaDateText = String(row.laputaDateText ?? row.holdingDateText ?? holdingDateText).trim();
    const dateText = laputaDateText ? `${realDateText} · ${laputaDateText}` : realDateText;
    const roomLabel = row.roomId ? labelFor(row.roomId) : "";
    const market = sources.get(row.operationId);
    let source = visibility.logSource(row, market);
    if (!isGM) {
      if (market && (row.source === market.marketLabel || String(row.kind).startsWith("market-"))) {
        source = visibility.marketLabel(market);
      } else if (row.source && !String(row.kind).startsWith("market-")
        && !MANUAL_STORAGE_LOG_KINDS.has(row.kind) && !PUBLIC_STORAGE_SOURCES.has(row.source)) {
        const buildingId = tendaySources.get(sourceKey(row, id));
        source = publicBuildingNames.get(buildingId) || "Источник недоступен";
      }
    }
    // Legacy generated notes store the intended room as text. Only known public room names survive in a player view.
    const note = isGM ? row.note : publicStorageLogNote(row, visibleRoomNames);
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
      source,
      roomLabel,
      note: [roomLabel, note || row.period || ""].filter(Boolean).join(" · ")
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
  const id = storageResourceId(resource);
  return { id, name: id === "custom" ? String(resource.name ?? "").trim().toLowerCase() : "" };
},

_storageResourceMatches(row = {}, resource = {}) {
  const a = this._storageResourceIdentity(row);
  const b = this._storageResourceIdentity(resource);
  if (a.id !== b.id) return false;
  if (a.id !== "custom") return true;
  return a.name === b.name;
},

_findCompatibleStorageStack(holding, resource, roomId) {
  const key = storageResourceStackKey({ ...resource, roomId });
  const batchIds = new Set((Array.isArray(resource.batches) ? resource.batches : []).map((batch) => batch?.id));
  const rows = holding?.storage?.resources ?? [];
  const rowsById = indexStorageRows(rows);
  return rows.find((candidate) =>
    this._normalizeStorageRoomId(candidate.roomId ?? candidate.storageRoomId) === roomId
      && rowsById.get(String(candidate.id ?? "")) === candidate
      && this._storageResourceMatches(candidate, resource)
      && storageResourceStackKey({ ...candidate, roomId }) === key
      && !(Array.isArray(candidate.batches) && candidate.batches.some((batch) => batchIds.has(batch?.id)))) ?? null;
},

_replenishStorageSaleStock(holding, resource, roomId) {
  if (resource.resourceId === "custom" || resource.forSale !== undefined) return resource;
  const rows = (holding?.storage?.resources ?? []).filter((row) =>
    this._normalizeStorageRoomId(row.roomId ?? row.storageRoomId) === roomId
      && this._storageResourceMatches(row, resource));
  if (!rows.length || rows.some((row) => !row.forSale)) return resource;
  const marked = { ...resource, forSale: true };
  const key = storageResourceStackKey(marked);
  // Replenish an established sale stock when this material has one policy in the room.
  // With competing policies, new unspecified stock stays off sale.
  return rows.every((row) => storageResourceStackKey({ ...row, roomId }) === key) ? marked : resource;
},

_storageFind(holding, resource = {}) {
  if (!holding.storage) holding.storage = { notes: "", resources: [], moneyCopper: 0, log: [] };
  if (!Array.isArray(holding.storage.resources)) holding.storage.resources = [];
  if (isStorageMoneyResource(resource)) return null;
  const roomId = this._normalizeStorageRoomId(resource.roomId ?? resource.storageRoomId);
  const storageRowId = String(resource.storageRowId ?? "");
  const row = holding.storage.resources.find((candidate) => {
    if (storageRowId && String(candidate?.id ?? "") !== storageRowId) return false;
    return this._normalizeStorageRoomId(candidate.roomId ?? candidate.storageRoomId) === roomId && this._storageResourceMatches(candidate, resource);
  }) ?? null;
  if (row) syncResourceRowBatches(row, { makeId, compact: !isResourceBatchPeriodActive(holding), protectedBatchIds: protectedResourceBatchIds(holding, row) });
  return row;
},

_storageQuantity(holding, resource = {}) {
  if (isStorageMoneyResource(resource)) return this._moneyCopper(holding);
  const resourceGroup = String(resource.resourceGroup ?? "").trim();
  const hasRoom = resource.roomId !== undefined || resource.storageRoomId !== undefined;
  const roomId = this._normalizeStorageRoomId(resource.roomId ?? resource.storageRoomId);
  const matches = (row) => (!hasRoom || this._normalizeStorageRoomId(row.roomId ?? row.storageRoomId) === roomId)
    && (resourceGroup ? this._storageResourceMatchesGroup(row, resourceGroup) : this._storageResourceMatches(row, resource));
  const rows = holding?.storage?.resources ?? [];
  const rowId = String(resource.storageRowId ?? "");
  if (rowId && !resourceGroup) {
    const { row } = resolveStorageRow(rows, rowId);
    return row && matches(row) ? availableResourceRowQuantity(row, holding) : 0;
  }
  return rows.filter(matches).reduce((sum, row) => sum + availableResourceRowQuantity(row, holding), 0);
},

_storageAvailableRowQuantity(holding, row = {}) {
  return availableResourceRowQuantity(row, holding);
},

_setStorageResourceQuantity(holding, row, quantity) {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    return { ok: false, message: "Введите целое неотрицательное количество." };
  }
  const before = row.qty;
  const delta = quantity - before;
  if (!delta) return { ok: true };
  if (delta < 0) {
    const available = this._storageAvailableRowQuantity(holding, row);
    if (-delta > available) return { ok: false, message: `В этой позиции зарезервировано ${before - available} ед. Сначала завершите или отмените перевозку.` };
    const taken = takeResourceBatches(row, -delta, { holding, makeId });
    if (taken.takenQty !== -delta) throw new Error("Не удалось изменить количество партии.");
  } else {
    addResourceBatches(row, { qty: delta }, { holding, makeId });
  }
  this._appendStorageLog(holding, [{
    kind: delta > 0 ? "manual-add" : "manual-spend", resourceId: row.resourceId, name: row.name,
    roomId: row.roomId, qty: delta, source: "Склад", note: "Ручная правка количества"
  }]);
  return { ok: true };
},

_storageAdd(holding, resource = {}, qty = 0) {
  const amount = Math.trunc(this._safeNumber(qty, 0));
  if (!amount) return null;
  if (!holding.storage) holding.storage = { notes: "", resources: [], moneyCopper: 0, log: [] };
  if (!Array.isArray(holding.storage.resources)) holding.storage.resources = [];
  const id = storageResourceId(resource);
  if (isStorageMoneyResource(resource)) {
    this._addMoney(holding, amount);
    return { id: "money", resourceId: "money", name: "Деньги", qty: this._moneyCopper(holding), unit: "медн.", notes: "" };
  }
  const name = id === "custom" ? String(resource.name ?? "Ресурс") : resourceLabel(id);
  const roomId = this._normalizeStorageRoomId(resource.roomId ?? resource.storageRoomId);
  const identity = { resourceId: id, name, roomId, storageRowId: resource.storageRowId };
  let incoming = { ...resource, ...identity };
  let row = resource.storageRowId || amount < 0 ? this._storageFind(holding, identity) : null;
  if (!row && amount > 0 && !resource.storageRowId && !resource.separateRow) {
    incoming = this._replenishStorageSaleStock(holding, incoming, roomId);
    row = this._findCompatibleStorageStack(holding, incoming, roomId);
  }
  if (!row && amount < 0) return null;
  if (!row) {
    row = normalizeResourceRow({ ...incoming, rowId: makeId("res", 12), qty: 0, batches: [] });
    holding.storage.resources.push(row);
  }
  if (amount > 0) {
    const input = Object.prototype.hasOwnProperty.call(resource, "batches")
      ? { batches: resource.batches }
      : { qty: amount, ageQd: resource.ageQd, internalDemandAvailableFromQd: resource.internalDemandAvailableFromQd };
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
    storageResourceId,
    isStorageMoneyResource,
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

_storageCanPay(holding, costs = [], { eligibleResourceRow, explicitResource = false } = {}) {
  return planStorageCosts({
    holding,
    costs,
    eligibleResourceRow,
    dependencies: this._storageCostPlanningDependencies({ explicitResource })
  });
},

_storagePay(holding, costs = [], { captureReceipt = false, eligibleResourceRow, explicitResource = false } = {}) {
  const { resourceSources, ...plan } = planStorageCosts({
    holding,
    costs,
    eligibleResourceRow,
    trackResourceSources: true,
    dependencies: this._storageCostPlanningDependencies({ explicitResource })
  });
  if (!plan.ok) return plan;
  const receipt = payStorageCosts({
    holding,
    costs: plan.costs,
    resourceSources,
    captureReceipt,
    dependencies: this._storagePaymentDependencies()
  });
  return captureReceipt ? { ...plan, receipt } : plan;
},

_restoreProductionResource(holding, resource, qty) {
  const previousId = String(resource.storageRowId || resource.id || "");
  const exact = previousId ? resolveStorageRow(holding.storage.resources, previousId).row : null;
  const roomId = this._normalizeStorageRoomId(resource.roomId ?? resource.storageRoomId);
  const samePolicy = exact && storageResourceStackKey(exact) === storageResourceStackKey({ ...resource, roomId });
  const custom = storageResourceId(resource) === "custom";
  const occupied = holding.storage.resources.some((row) => row.id === previousId);
  const dependencies = this._storagePlacementDependencies();
  return addStorageWithOverflow({
    holding, resource: { ...resource, roomId }, qty,
    acceptBatch: (placed, batch) => perishableStorageExpiresInQd(holding, placed, resourceBatchAgeQd(holding, batch)) > 0,
    dependencies: {
      ...dependencies,
      storageAdd: (draft, placed, amount) => {
        const originalRoom = placed.roomId === roomId;
        const existing = originalRoom && samePolicy ? exact
          : custom ? null : this._findCompatibleStorageStack(draft, placed, placed.roomId);
        // Only the original room can reclaim the receipt's row ID.
        const id = existing?.id || (originalRoom && previousId && !occupied ? previousId : makeId("res", 12));
        if (!existing) {
          draft.storage.resources.push(normalizeResourceRow({ ...placed, rowId: id, qty: 0, batches: [] }));
        }
        return this._storageAdd(draft, { ...placed, storageRowId: id }, amount);
      }
    }
  });
},

_storageResourceMatchesGroup(row = {}, groupId = "") {
  const id = storageResourceId(row);
  const definition = id === "custom" ? null : resourceDef(id);
  if (row.noAutoConsume === true || definition?.noAutoConsume === true) return false;
  return resourceMatchesMaterialGroup(row, groupId, definition);
},

_storageCostPlanningDependencies({ explicitResource = false } = {}) {
  return {
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback),
    isMoneyResource: explicitResource ? (resourceId, id, name) => isStorageMoneyResource({ resourceId, id, name }) : isMoneyResource,
    storageResourceMatches: (row, resource) => this._storageResourceMatches(row, explicitResource ? resource : legacyRecipeResource(resource)),
    resourceMatchesGroup: (row, groupId) => this._storageResourceMatchesGroup(row, groupId),
    normalizeRoomId: (roomId) => this._normalizeStorageRoomId(roomId),
    resourceBatches: (row, holding) => availableResourceBatchInventory(row, holding)
  };
},

_storagePaymentDependencies() {
  return {
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback),
    isMoneyResource,
    storageQuantity: (holding, resource) => this._storageQuantity(holding, legacyRecipeResource(resource)),
    addMoney: (holding, amount) => this._addMoney(holding, amount),
    storageAdd: (holding, resource, qty) => this._storageAdd(holding, resource, qty),
    takeResourceBatch: (holding, row, batchId, qty) => takeResourceBatchById(row, batchId, qty, { holding, makeId }),
    storageTake: (holding, resource, qty) => this._storageTake(holding, legacyRecipeResource(resource), qty),
    storageResourceMatches: (row, resource) => this._storageResourceMatches(row, legacyRecipeResource(resource))
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
    const id = storageResourceId(raw);
    const name = id === "custom" ? String(raw?.name ?? "Ресурс") : resourceLabel(id);
    const roomId = isStorageMoneyResource(raw) ? "" : this._normalizeStorageRoomId(raw?.roomId ?? raw?.storageRoomId);
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

_applyManualStorageChange(holding, { resourceId = "", name = "", qty = 0, note = "", kind = "manual-add", roomId = "outdoors",
  operationId = "", separateRow = false } = {}) {
  const amount = Math.trunc(this._safeNumber(qty, 0));
  if (!amount) return { ok: false, message: "Укажи количество." };
  const id = storageResourceId({ resourceId, name });
  const label = id === "custom" ? (String(name).trim() || "Ресурс") : resourceLabel(id);
  const targetRoom = this._normalizeStorageRoomId(roomId);
  let placements = [];
  if (amount > 0) placements = this._storageAddWithOverflow(holding, { resourceId: id, name: label, roomId: targetRoom, separateRow }, amount);
  else {
    const rowsById = indexStorageRows(holding?.storage?.resources);
    const payment = this._storagePay(holding, [{ resourceId: id, name: label, roomId: targetRoom, qty: -amount }], {
      explicitResource: true,
      eligibleResourceRow: (row) => rowsById.get(String(row.id ?? "")) === row
    });
    if (!payment.ok) {
      const available = payment.missing[0]?.have ?? 0;
      return { ok: false, message: `${label}: нельзя списать ${this._formatNumber(Math.abs(amount))}. Доступно ${this._formatNumber(available)}.` };
    }
  }
  const entries = amount > 0 && placements.length
    ? placements.map((item) => ({ kind, resourceId: id, name: label, qty: item.qty, roomId: item.roomId, source: "Ручная правка", note: item.overflowFrom ? [note, `переполнение: ${this._storageRoomLabel(holding, item.overflowFrom)}`].filter(Boolean).join(" · ") : note, operationId }))
    : [{ kind, resourceId: id, name: label, qty: amount, roomId: targetRoom, source: "Ручная правка", note, operationId }];
  this._appendStorageLog(holding, entries);
  const suffix = isStorageMoneyResource({ resourceId: id, name: label }) ? "" : (amount > 0 ? `; ${this._storagePlacementText(holding, placements)}` : ` → ${this._storageRoomLabel(holding, targetRoom)}`);
  return { ok: true, message: `${label}: ${amount > 0 ? "+" : ""}${this._formatNumber(amount)}${suffix}.` };
},

_applyStorageMove(holding, { resourceId = "", name = "", qty = 0, fromRoomId = "outdoors", toRoomId = "outdoors", note = "" } = {}) {
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

_storageBatchMoveDependencies(hiddenRooms = new Set()) {
  const storageRooms = (holding, options) => {
    const rooms = this._storageRooms(holding, options);
    return hiddenRooms.size ? rooms.filter((room) => !hiddenRooms.has(room.id)) : rooms;
  };
  const placementDependencies = { ...this._storagePlacementDependencies(), storageRooms };
  return {
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback),
    normalizeStorageRoomId: (roomId) => this._normalizeStorageRoomId(roomId),
    itemQuantity: (row) => this._itemQuantity(row),
    resolveStorageRows,
    storageRooms,
    storageRowLoad: (row) => this._storageRowLoad(row),
    storageEffectiveRowLoad,
    storageRoomLabel: (holding, roomId) => this._storageRoomLabel(holding, roomId),
    addResourceWithOverflow: (holding, resource, qty) => addStorageWithOverflow({
      holding, resource, qty, dependencies: placementDependencies
    }),
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
    dependencies: this._storageBatchMoveDependencies(options.hiddenRooms)
  });
},

_applyStorageBatchMove(holding, options = {}) {
  return applyStorageBatchMove({
    holding,
    ...options,
    dependencies: this._storageBatchMoveDependencies(options.hiddenRooms)
  });
},

_storageMoveDependencies() {
  return {
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback),
    normalizeStorageRoomId: (roomId) => this._normalizeStorageRoomId(roomId),
    storageResourceId,
    isStorageMoneyResource,
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
