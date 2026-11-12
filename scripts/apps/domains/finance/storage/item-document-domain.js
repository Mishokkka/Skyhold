import { normalizeResourceId, resourceDef, resourceLabel, resourceOptions, storageResourceId } from "../../../../core/resources.js";
import { MODULE_ID } from "../../../../data/constants.js";
import { makeId } from "../../../../data/utils.js";
import { itemQuantity, itemQuantityUpdateData, setItemQuantityData } from "../../../../engines/storage/item-quantity.js";
import { resolveStorageRow, STORAGE_ROW_CHANGED } from "../../../../engines/storage/row-identity.js";
import { resolveFoundryActorReference, resolveFoundryUuid } from "../../../../integrations/foundry-runtime.js";

function cloneFoundryData(value) {
  return foundry?.utils?.deepClone?.(value) ?? structuredClone(value);
}

function setStorageItemFlag(itemData, key, value) {
  itemData.flags = { ...itemData.flags, [MODULE_ID]: { ...itemData.flags?.[MODULE_ID], [key]: value } };
  return itemData;
}

export const FinanceStorageItemDocumentDomain = {
_setItemQuantityData(itemData = {}, qty = 1) {
  return setItemQuantityData(itemData, qty, { clone: cloneFoundryData });
},

_itemQuantity(itemOrData = {}) {
  return itemQuantity(itemOrData);
},

async _removeQuantityFromActorItem(item, amount = 1) {
  const actor = item?.parent;
  const actorDocumentName = actor?.documentName ?? actor?.constructor?.documentName;
  if (!actor || actorDocumentName !== "Actor" || !item.id) return { ok: false };
  if (!game.user?.isGM && !actor.isOwner) return { ok: false };
  const qty = this._itemQuantity(item);
  const take = Math.max(1, Math.floor(this._safeNumber(amount, 1)));
  if (take > qty) return { ok: false };
  const previousData = item.toObject ? item.toObject() : cloneFoundryData(item);
  const receipt = {
    ok: true,
    kind: qty > take ? "updated" : "deleted",
    actorId: String(actor.id ?? ""),
    actorUuid: String(actor.uuid ?? ""),
    itemId: String(item.id ?? ""),
    previousQuantity: qty,
    previousData
  };
  if (qty > take) {
    if (!item.update) return { ok: false };
    const updated = await item.update(itemQuantityUpdateData(qty - take));
    const remaining = this._itemQuantity(updated ?? actor.items?.get?.(item.id) ?? item);
    if (remaining === qty - take) return receipt;
    if (remaining !== qty && !await this._restoreActorItemRemoval(receipt)) {
      throw new Error("Не удалось восстановить исходное количество предмета.");
    }
    return { ok: false };
  }
  if (actor.deleteEmbeddedDocuments) {
    await actor.deleteEmbeddedDocuments("Item", [item.id]);
    if (!actor.items?.get?.(item.id)) return receipt;
  }
  return { ok: false };
},

async _restoreActorItemRemoval(receipt = null) {
  if (!receipt?.ok || !(receipt.actorUuid || receipt.actorId)) return false;
  const actor = await resolveFoundryActorReference(receipt);
  if (!actor) return false;
  const existing = actor.items?.get?.(receipt.itemId);
  if (existing?.update) {
    const restored = await existing.update(itemQuantityUpdateData(receipt.previousQuantity));
    return this._itemQuantity(restored ?? actor.items?.get?.(receipt.itemId) ?? existing) === receipt.previousQuantity;
  }
  if (!actor.createEmbeddedDocuments || !receipt.previousData) return false;
  let created;
  try {
    created = await actor.createEmbeddedDocuments("Item", [receipt.previousData], { keepId: true });
  } catch (_error) {
    const fallback = cloneFoundryData(receipt.previousData);
    delete fallback._id;
    delete fallback.id;
    created = await actor.createEmbeddedDocuments("Item", [fallback]);
  }
  return Boolean(created?.[0] && this._itemQuantity(created[0]) === receipt.previousQuantity);
},

async _removeCreatedActorItems(receipt = null) {
  if (receipt?.kind !== "created" || !(receipt.actorUuid || receipt.actorId)) return false;
  const actor = await resolveFoundryActorReference(receipt);
  const itemIds = (Array.isArray(receipt.itemIds) ? receipt.itemIds : []).map(String).filter(Boolean);
  if (!actor?.deleteEmbeddedDocuments || !itemIds.length) return false;
  const existingIds = itemIds.filter((id) => actor.items?.get?.(id));
  if (!existingIds.length) return true;
  await actor.deleteEmbeddedDocuments("Item", existingIds);
  return existingIds.every((id) => !actor.items?.get?.(id));
},

/** Foundry can resolve a vetoed creation with an empty array. Confirm its result before debiting stock. */
async _createStorageTransferItem(actor, itemData, qty, operationId) {
  if (operationId) setStorageItemFlag(itemData, "storageOperationId", operationId);
  const created = await actor.createEmbeddedDocuments("Item", [itemData]);
  const itemIds = (Array.isArray(created) ? created : []).map((item) => String(item?.id ?? item?._id ?? "")).filter(Boolean);
  if (!itemIds.length) return { ok: false, message: "Foundry не создал предмет у персонажа." };
  const actorMutation = { kind: "created", actorId: String(actor.id ?? ""), actorUuid: String(actor.uuid ?? ""), itemIds };
  if (itemIds.length !== 1 || this._itemQuantity(created[0]) !== qty) {
    if (!await this._removeCreatedActorItems(actorMutation)) throw new Error("Не удалось отменить выдачу предмета с изменённым количеством.");
    return { ok: false, message: "Foundry изменил количество при создании предмета. Выдача отменена." };
  }
  return { ok: true, actorMutation };
},

async _foundryItemDataForResource(resourceId = "custom", name = "Ресурс", qty = 1) {
  const id = storageResourceId({ resourceId, name });
  const def = id !== "custom" ? resourceDef(id) : null;
  let source = null;
  const uuid = def?.itemUuid || "";
  if (uuid) {
    try {
      const doc = await resolveFoundryUuid(uuid);
      if (doc?.toObject) source = doc.toObject();
    } catch (_error) {}
  }
  source ??= {
    name: id === "custom" ? (name || "Ресурс") : resourceLabel(id),
    type: def?.itemType || "rawMaterial",
    img: def?.img || "icons/svg/item-bag.svg",
    system: { quantity: 1, cost: def?.cost || "" }
  };
  return setStorageItemFlag(this._setItemQuantityData(source, qty), "storageResourceId", id);
},

async _withdrawResourceToActor(holding, { resourceId = "custom", name = "", qty = 1, roomId = "outdoors", storageRowId = "", actorId = "", actor: actorArg = null, operationId = "" } = {}) {
  const actor = actorArg ?? (actorId ? globalThis.game?.actors?.get?.(actorId) : this._storageDefaultActor());
  if (!actor) return { ok: false, message: "У текущего пользователя нет привязанного персонажа-получателя." };
  const amount = Math.max(1, Math.floor(this._safeNumber(qty, 1)));
  const id = storageResourceId({ resourceId, name });
  const label = id === "custom" ? (String(name).trim() || "Ресурс") : resourceLabel(id);
  const room = this._normalizeStorageRoomId(roomId);
  if (storageRowId) {
    const selection = resolveStorageRow(holding?.storage?.resources, storageRowId);
    if (!selection.row) return { ok: false, message: selection.message };
  }
  const resource = { resourceId: id, name: label, roomId: room, storageRowId };
  const row = this._storageFind(holding, resource);
  if (!row) return { ok: false, message: STORAGE_ROW_CHANGED };
  const have = this._storageAvailableRowQuantity(holding, row);
  if (have < amount) return { ok: false, message: `На складе свободно ${this._formatNumber(have)} ед. ресурса «${label}». Запрошено ${this._formatNumber(amount)}.` };
  const itemData = await this._foundryItemDataForResource(id, label, amount);
  const transfer = await this._createStorageTransferItem(actor, itemData, amount, operationId);
  if (!transfer.ok) return transfer;
  const { actorMutation } = transfer;
  try {
    const taken = this._storageTake(holding, resource, amount);
    if (taken.takenQty !== amount) throw new Error("Не удалось списать подтверждённое количество со склада.");
    this._appendStorageLog(holding, [{ kind: "manual-spend", resourceId: id, name: label, qty: -amount, roomId: room, source: "Выдача Foundry", note: `получатель: ${actor.name}`, operationId }]);
    return { ok: true, message: `${actor.name}: выдано ${this._formatNumber(amount)} ${label}.`, actorMutation };
  } catch (error) {
    if (!await this._removeCreatedActorItems(actorMutation)) throw new Error("Не удалось отменить выдачу предмета.", { cause: error });
    throw error;
  }
},

async _giveStoredItemToActor(holding, { itemId = "", itemIndex = -1, qty = 1, actorId = "", actor: actorArg = null, operationId = "" } = {}) {
  const actor = actorArg ?? (actorId ? globalThis.game?.actors?.get?.(actorId) : this._storageDefaultActor());
  if (!actor) return { ok: false, message: "У текущего пользователя нет привязанного персонажа-получателя." };
  if (!Array.isArray(holding?.storage?.items)) return { ok: false, message: "В хранилище нет предметов." };
  const stableId = String(itemId ?? "");
  const items = holding.storage.items;
  const { row, message } = stableId ? resolveStorageRow(items, stableId) : { row: items[Number(itemIndex)] };
  if (!row) return { ok: false, message: message ?? "Предмет не найден." };
  const have = this._itemQuantity(row);
  const amount = Math.max(1, Math.floor(this._safeNumber(qty, 1)));
  if (amount > have) return { ok: false, message: `На складе осталось ${this._formatNumber(have)} ед. предмета «${row.name}».` };
  const itemData = this._setItemQuantityData(row.itemData ?? row, amount);
  const transfer = await this._createStorageTransferItem(actor, itemData, amount, operationId);
  if (!transfer.ok) return transfer;
  const { actorMutation } = transfer;
  try {
    if (have > amount) {
      const remaining = have - amount;
      row.qty = remaining;
      if (row.itemData?.system && typeof row.itemData.system === "object") row.itemData.system.quantity = remaining;
      if (row.system && typeof row.system === "object") row.system.quantity = remaining;
    } else items.splice(items.indexOf(row), 1);
    this._appendStorageLog(holding, [{ kind: "manual-spend", resourceId: "custom", name: row.name, qty: -amount, roomId: row.roomId, source: "Выдача Foundry", note: `получатель: ${actor.name}`, operationId }]);
    return { ok: true, message: `${actor.name}: выдан предмет ${row.name} (${this._formatNumber(amount)}).`, actorMutation };
  } catch (error) {
    if (!await this._removeCreatedActorItems(actorMutation)) throw new Error("Не удалось отменить выдачу предмета.", { cause: error });
    throw error;
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

_storageTargetActorContext() {
  const actor = this._storageDefaultActor();
  return actor ? { id: String(actor.id ?? ""), name: String(actor.name ?? "Персонаж"), hasActor: true } : { id: "", name: "Нет привязанного персонажа", hasActor: false };
},

_storageDepositSource(item = {}) {
  const actor = item?.parent;
  const actorDocumentName = actor?.documentName ?? actor?.constructor?.documentName;
  if (actorDocumentName === "Actor" && item?.id) {
    if (!game.user?.isGM && !actor.isOwner) return { ok: false, message: "Можно класть в хранилище только предметы персонажа, которым ты владеешь." };
    return { ok: true, requiresRemoval: true, actor };
  }
  if (game.user?.isGM) return { ok: true, requiresRemoval: false, actor: null };
  return { ok: false, message: "Игрок может класть в хранилище только предметы из инвентаря своего персонажа." };
},

_itemTypeLabel(type = "") {
  const value = String(type ?? "");
  const label = ({ rawMaterial: "Ресурс", gear: "Снаряжение", weapon: "Оружие", armor: "Броня", talent: "Талант", spell: "Заклинание" })[value] ?? value;
  return label || "Предмет";
},

_resourceIdForFoundryItem(item = {}) {
  const issuedId = item.getFlag?.(MODULE_ID, "storageResourceId") ?? item.flags?.[MODULE_ID]?.storageResourceId;
  if (typeof issuedId === "string" && issuedId.trim()) return storageResourceId({ resourceId: issuedId });
  const uuid = String(item.uuid ?? item.itemUuid ?? "");
  const id = String(item.id ?? item._id ?? "");
  const name = String(item.name ?? "");
  for (const def of this._resourceDefsForLookup()) {
    if (def.itemUuid && uuid && String(def.itemUuid) === uuid) return def.id;
    if (def.itemId && id && String(def.itemId) === id) return def.id;
    if (normalizeResourceId(name) === def.id) return def.id;
  }
  return normalizeResourceId(name);
},

_resourceDefsForLookup() {
  try { return resourceOptions("", "", { includeMoney: false }).map((option) => resourceDef(option.value)).filter(Boolean); }
  catch (_error) { return []; }
},

_snapshotItemForStorage(item = {}, qty = null, roomId = "outdoors") {
  const source = item.toObject ? item.toObject() : cloneFoundryData(item);
  const amount = Math.max(1, Math.floor(this._safeNumber(qty ?? this._itemQuantity(source), 1)));
  const itemData = this._setItemQuantityData(source, amount);
  const parent = item.parent;
  const parentDocumentName = parent?.documentName ?? parent?.constructor?.documentName;
  return {
    id: makeId("sitem", 12), name: String(itemData.name ?? item.name ?? "Предмет"),
    type: String(itemData.type ?? item.type ?? "gear"), img: String(itemData.img ?? item.img ?? "icons/svg/item-bag.svg"),
    qty: amount, weight: String(itemData.system?.weight ?? ""), cost: String(itemData.system?.cost ?? ""),
    roomId: this._normalizeStorageRoomId(roomId), forSale: Boolean(item.forSale ?? itemData.forSale ?? false),
    sourceActorId: parentDocumentName === "Actor" ? String(parent.id ?? "") : "",
    sourceActorName: parentDocumentName === "Actor" ? String(parent.name ?? "") : "",
    itemUuid: String(item.uuid ?? ""), itemData, notes: ""
  };
},

async _storageReceiveFoundryItem(holding, item, { roomId = "outdoors", operationId = "" } = {}) {
  if (!item) return { ok: false, message: "Предмет не найден." };
  const targetRoom = this._normalizeStorageRoomId(roomId);
  const amount = this._itemQuantity(item);
  const source = this._storageDepositSource(item);
  if (!source.ok) return source;
  if (!amount) return { ok: false, message: "В стопке нет предметов." };
  const snapshot = String(item.type) === "rawMaterial" ? null : this._snapshotItemForStorage(item, amount, targetRoom);
  if (snapshot) snapshot.roomId = this._storageItemDepositRoom(holding, snapshot, targetRoom);
  let actorMutation = null;
  try {
    if (source.requiresRemoval) {
      actorMutation = await this._removeQuantityFromActorItem(item, amount);
      if (!actorMutation?.ok) return { ok: false, message: "Не удалось списать предмет из инвентаря персонажа." };
    }
    if (!snapshot) {
      const resourceId = this._resourceIdForFoundryItem(item);
      const id = resourceId === "custom" ? "custom" : resourceId;
      const label = id === "custom" ? String(item.name ?? "Ресурс") : resourceLabel(id);
      const placements = this._storageAddWithOverflow(holding, { resourceId: id, name: label, roomId: targetRoom, img: item.img, itemUuid: item.uuid, itemId: item.id, itemType: item.type, weight: item.system?.weight ?? "" }, amount);
      this._appendStorageLog(holding, placements.map((place) => ({ kind: "manual-add", resourceId: id, name: label, qty: place.qty, roomId: place.roomId, source: "Инвентарь Foundry", note: (item.parent?.documentName ?? item.parent?.constructor?.documentName) === "Actor" ? `из ${item.parent.name}` : "перетаскивание", operationId })));
      const placedRoom = placements.find((place) => place.roomId === targetRoom)?.roomId ?? placements[0]?.roomId;
      return { ok: true, roomId: placedRoom, message: `${label}: принято ${this._formatNumber(amount)}; ${this._storagePlacementText(holding, placements)}.`, actorMutation };
    }
    if (!holding.storage) holding.storage = { notes: "", resources: [], items: [], moneyCopper: 0, log: [] };
    if (!Array.isArray(holding.storage.items)) holding.storage.items = [];
    holding.storage.items.push(snapshot);
    const overflow = snapshot.roomId !== targetRoom;
    const note = [snapshot.sourceActorName ? `из ${snapshot.sourceActorName}` : "перетаскивание",
      overflow ? `переполнение: ${this._storageRoomLabel(holding, targetRoom)}` : ""].filter(Boolean).join(" · ");
    this._appendStorageLog(holding, [{ kind: "manual-add", resourceId: "custom", name: snapshot.name, qty: amount,
      roomId: snapshot.roomId, source: "Предмет Foundry", note, operationId }]);
    const roomLabel = this._storageRoomLabel(holding, snapshot.roomId);
    return { ok: true, roomId: snapshot.roomId, message: `${snapshot.name}: предмет принят в ${roomLabel}${overflow ? " (выбранное помещение недоступно или заполнено)" : ""}.`, actorMutation };
  } catch (error) {
    if (actorMutation?.ok && !await this._restoreActorItemRemoval(actorMutation)) {
      throw new Error("Не удалось восстановить предмет в инвентаре персонажа.", { cause: error });
    }
    throw error;
  }
}
};
