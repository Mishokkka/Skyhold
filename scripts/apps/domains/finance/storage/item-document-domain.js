import { normalizeResourceId, resourceDef, resourceLabel, resourceOptions } from "../../../../core/resources.js";
import { makeId } from "../../../../data/utils.js";
import { itemQuantity, itemQuantityUpdateData, setItemQuantityData } from "../../../../engines/storage/item-quantity.js";
import { resolveFoundryUuid } from "../../../../integrations/foundry-runtime.js";

function cloneFoundryData(value) {
  return foundry?.utils?.deepClone?.(value) ?? structuredClone(value);
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
  if (qty > take && item.update) {
    await item.update(itemQuantityUpdateData(qty - take));
    return receipt;
  }
  if (actor.deleteEmbeddedDocuments) {
    await actor.deleteEmbeddedDocuments("Item", [item.id]);
    return receipt;
  }
  return { ok: false };
},

async _restoreActorItemRemoval(receipt = null) {
  if (!receipt?.ok || !receipt.actorId) return false;
  const actor = globalThis.game?.actors?.get?.(receipt.actorId) ?? (receipt.actorUuid ? await resolveFoundryUuid(receipt.actorUuid) : null);
  if (!actor) return false;
  const existing = actor.items?.get?.(receipt.itemId);
  if (existing?.update) {
    await existing.update(itemQuantityUpdateData(receipt.previousQuantity));
    return true;
  }
  if (!actor.createEmbeddedDocuments || !receipt.previousData) return false;
  try {
    await actor.createEmbeddedDocuments("Item", [receipt.previousData], { keepId: true });
  } catch (_error) {
    const fallback = cloneFoundryData(receipt.previousData);
    delete fallback._id;
    delete fallback.id;
    await actor.createEmbeddedDocuments("Item", [fallback]);
  }
  return true;
},

async _removeCreatedActorItems(receipt = null) {
  if (receipt?.kind !== "created" || !receipt.actorId) return false;
  const actor = globalThis.game?.actors?.get?.(receipt.actorId) ?? (receipt.actorUuid ? await resolveFoundryUuid(receipt.actorUuid) : null);
  const itemIds = (Array.isArray(receipt.itemIds) ? receipt.itemIds : []).map(String).filter(Boolean);
  if (!actor?.deleteEmbeddedDocuments || !itemIds.length) return false;
  const existingIds = itemIds.filter((id) => actor.items?.get?.(id));
  if (!existingIds.length) return true;
  await actor.deleteEmbeddedDocuments("Item", existingIds);
  return true;
},

async _foundryItemDataForResource(resourceId = "custom", name = "Ресурс", qty = 1) {
  const id = normalizeResourceId(resourceId, name);
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
  return this._setItemQuantityData(source, qty);
},

async _withdrawResourceToActor(holding, { resourceId = "custom", name = "", qty = 1, roomId = "outdoors", actorId = "", actor: actorArg = null, operationId = "" } = {}) {
  const actor = actorArg ?? (actorId ? globalThis.game?.actors?.get?.(actorId) : this._storageDefaultActor());
  if (!actor) return { ok: false, message: "У текущего пользователя нет привязанного персонажа-получателя." };
  const amount = Math.max(1, Math.floor(this._safeNumber(qty, 1)));
  const id = normalizeResourceId(resourceId, name);
  const label = id === "custom" ? (String(name).trim() || "Ресурс") : resourceLabel(id);
  const room = this._normalizeStorageRoomId(roomId);
  const row = this._storageFind(holding, { resourceId: id, name: label, roomId: room });
  const have = Math.max(0, this._safeNumber(row?.qty, 0));
  if (have + 0.0001 < amount) return { ok: false, message: `В складе нет ${this._formatNumber(amount)} ${label}. Есть ${this._formatNumber(have)}.` };
  const itemData = await this._foundryItemDataForResource(id, label, amount);
  if (operationId) {
    if (!itemData.flags || typeof itemData.flags !== "object") itemData.flags = {};
    itemData.flags["fbl-skyhold"] = { ...(itemData.flags["fbl-skyhold"] ?? {}), storageOperationId: operationId };
  }
  const created = await actor.createEmbeddedDocuments("Item", [itemData]);
  const actorMutation = {
    kind: "created", actorId: String(actor.id ?? ""), actorUuid: String(actor.uuid ?? ""),
    itemIds: (Array.isArray(created) ? created : []).map((item) => String(item?.id ?? item?._id ?? "")).filter(Boolean)
  };
  try {
    this._storageAdd(holding, { resourceId: id, name: label, roomId: room }, -amount);
    this._appendStorageLog(holding, [{ kind: "manual-spend", resourceId: id, name: label, qty: -amount, roomId: room, source: "Выдача Foundry", note: `получатель: ${actor.name}`, operationId }]);
    return { ok: true, message: `${actor.name}: выдано ${this._formatNumber(amount)} ${label}.`, actorMutation };
  } catch (error) {
    await this._removeCreatedActorItems(actorMutation);
    throw error;
  }
},

async _giveStoredItemToActor(holding, { itemId = "", itemIndex = -1, qty = 1, actorId = "", actor: actorArg = null, operationId = "" } = {}) {
  const actor = actorArg ?? (actorId ? globalThis.game?.actors?.get?.(actorId) : this._storageDefaultActor());
  if (!actor) return { ok: false, message: "У текущего пользователя нет привязанного персонажа-получателя." };
  if (!Array.isArray(holding?.storage?.items)) return { ok: false, message: "В хранилище нет предметов." };
  const stableId = String(itemId ?? "");
  const index = stableId ? holding.storage.items.findIndex((item) => String(item?.id ?? "") === stableId) : Number(itemIndex);
  const row = holding.storage.items[index];
  if (!row) return { ok: false, message: "Предмет не найден." };
  const have = this._itemQuantity(row);
  const amount = Math.max(1, Math.min(have, Math.floor(this._safeNumber(qty, 1))));
  const itemData = this._setItemQuantityData(row.itemData ?? row, amount);
  if (operationId) {
    if (!itemData.flags || typeof itemData.flags !== "object") itemData.flags = {};
    itemData.flags["fbl-skyhold"] = { ...(itemData.flags["fbl-skyhold"] ?? {}), storageOperationId: operationId };
  }
  const created = await actor.createEmbeddedDocuments("Item", [itemData]);
  const actorMutation = {
    kind: "created", actorId: String(actor.id ?? ""), actorUuid: String(actor.uuid ?? ""),
    itemIds: (Array.isArray(created) ? created : []).map((item) => String(item?.id ?? item?._id ?? "")).filter(Boolean)
  };
  try {
    if (have > amount) {
      const remaining = have - amount;
      row.qty = remaining;
      if (row.itemData?.system && typeof row.itemData.system === "object") row.itemData.system.quantity = remaining;
      if (row.system && typeof row.system === "object") row.system.quantity = remaining;
    } else holding.storage.items.splice(index, 1);
    this._appendStorageLog(holding, [{ kind: "manual-spend", resourceId: "custom", name: row.name, qty: -amount, roomId: row.roomId, source: "Выдача Foundry", note: `получатель: ${actor.name}`, operationId }]);
    return { ok: true, message: `${actor.name}: выдан предмет ${row.name} (${this._formatNumber(amount)}).`, actorMutation };
  } catch (error) {
    await this._removeCreatedActorItems(actorMutation);
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
  let actorMutation = null;
  try {
    if (source.requiresRemoval) {
      actorMutation = await this._removeQuantityFromActorItem(item, amount);
      if (!actorMutation?.ok) return { ok: false, message: "Не удалось списать предмет из инвентаря персонажа." };
    }
    if (String(item.type) === "rawMaterial") {
      const resourceId = this._resourceIdForFoundryItem(item);
      const id = resourceId === "custom" ? "custom" : resourceId;
      const label = id === "custom" ? String(item.name ?? "Ресурс") : resourceLabel(id);
      const placements = this._storageAddWithOverflow(holding, { resourceId: id, name: label, roomId: targetRoom, img: item.img, itemUuid: item.uuid, itemId: item.id, itemType: item.type, weight: item.system?.weight ?? "" }, amount);
      this._appendStorageLog(holding, placements.map((place) => ({ kind: "manual-add", resourceId: id, name: label, qty: place.qty, roomId: place.roomId, source: "Инвентарь Foundry", note: (item.parent?.documentName ?? item.parent?.constructor?.documentName) === "Actor" ? `из ${item.parent.name}` : "перетаскивание", operationId })));
      return { ok: true, message: `${label}: принято ${this._formatNumber(amount)}; ${this._storagePlacementText(holding, placements)}.`, actorMutation };
    }
    if (!holding.storage) holding.storage = { notes: "", resources: [], items: [], moneyCopper: 0, log: [] };
    if (!Array.isArray(holding.storage.items)) holding.storage.items = [];
    const snapshot = this._snapshotItemForStorage(item, amount, targetRoom);
    holding.storage.items.push(snapshot);
    this._appendStorageLog(holding, [{ kind: "manual-add", resourceId: "custom", name: snapshot.name, qty: amount, roomId: targetRoom, source: "Предмет Foundry", note: snapshot.sourceActorName ? `из ${snapshot.sourceActorName}` : "перетаскивание", operationId }]);
    return { ok: true, message: `${snapshot.name}: предмет принят в ${this._storageRoomLabel(holding, targetRoom)}.`, actorMutation };
  } catch (error) {
    if (actorMutation?.ok) await this._restoreActorItemRemoval(actorMutation);
    throw error;
  }
}
};
