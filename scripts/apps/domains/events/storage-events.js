// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { createHolding, SkyholdData } from "../../../data/store.js";
import { generateResidents } from "../../../generators/resident-generator.js";
import { ageGroupFromAge, normalizeBelief } from "../../../generators/resident-rules.js";
import { SkyholdBuildingEditor, SkyholdCrewEditor } from "../../editors.js";
import { SkyholdMassCombatApp } from "../../mass-combat.js";
import { escapeHtml, fieldValue, joinList, rollD66, rollD6Pool, splitList } from "../../../core/helpers.js";
import { GM_ROLLS, gmRollEntry } from "../../../data/gm-rolls.js";
import { addCalendariaQd, formatCalendariaDateTime, getCalendariaSnapshot, parseCalendariaDateInput, timestampForCalendariaDate } from "../../../integrations/calendaria-bridge.js";

export const StorageEventDomain = {
async _onAdjustStorage(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canUseStorage()) return;

  const button = event.currentTarget;
  const mode = button?.dataset?.mode === "spend" ? "spend" : "add";
  const root = button.closest(".fbls-storage-adjust");
  if (!root) return;

  const resourceSelect = root.querySelector("[data-storage-adjust-resource]");
  const customInput = root.querySelector("[data-storage-adjust-custom]");
  const qtyInput = root.querySelector("[data-storage-adjust-qty]");
  const noteInput = root.querySelector("[data-storage-adjust-note]");
  const roomSelect = root.querySelector("[data-storage-adjust-room]");

  const resourceId = String(resourceSelect?.value ?? "custom");
  const name = resourceId === "custom" ? String(customInput?.value ?? "").trim() : "";
  const rawQty = Math.abs(this._safeNumber(qtyInput?.value, 0));
  const qty = mode === "spend" ? -rawQty : rawQty;
  const note = String(noteInput?.value ?? "").trim();
  const roomId = String(roomSelect?.value ?? "outdoors") || "outdoors";

  try {
    const data = SkyholdData.get();
    const holding = data.holdings.find((item) => item.id === this.activeHoldingId) ?? data.holdings[0];
    if (!holding) return;
    const result = this._applyManualStorageChange(holding, {
      resourceId,
      name,
      qty,
      note,
      kind: mode === "spend" ? "manual-spend" : "manual-add",
      roomId
    });
    if (!result.ok) { ui.notifications.warn(result.message); return; }
    await SkyholdData.set(data);
    this.activeTab = "storage";
    this.activeStorageTab = "resources";
    this.activeStorageRoomId = this._normalizeStorageRoomId(roomId);
    this.render({ force: true, focus: false });
    ui.notifications.info(result.message);
  } catch (error) {
    console.error("FBL Skyhold | Failed to adjust storage", error);
    ui.notifications.error("Не удалось изменить хранилище. Подробности в консоли.");
  }
},

async _onMoveStorageResource(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canUseStorage()) return;

  const root = event.currentTarget?.closest?.(".fbls-storage-move");
  if (!root) return;
  const resourceSelect = root.querySelector("[data-storage-move-resource]");
  const customInput = root.querySelector("[data-storage-move-custom]");
  const qtyInput = root.querySelector("[data-storage-move-qty]");
  const fromSelect = root.querySelector("[data-storage-move-from]");
  const toSelect = root.querySelector("[data-storage-move-to]");
  const noteInput = root.querySelector("[data-storage-move-note]");

  const resourceId = String(resourceSelect?.value ?? "custom");
  const name = resourceId === "custom" ? String(customInput?.value ?? "").trim() : "";
  const qty = Math.max(0, this._safeNumber(qtyInput?.value, 0));
  const fromRoomId = String(fromSelect?.value ?? "outdoors") || "outdoors";
  const toRoomId = String(toSelect?.value ?? "outdoors") || "outdoors";
  const note = String(noteInput?.value ?? "").trim();

  try {
    const data = SkyholdData.get();
    const holding = data.holdings.find((item) => item.id === this.activeHoldingId) ?? data.holdings[0];
    if (!holding) return;
    const result = this._applyStorageMove(holding, { resourceId, name, qty, fromRoomId, toRoomId, note });
    if (!result.ok) { ui.notifications.warn(result.message); return; }
    await SkyholdData.set(data);
    this.activeTab = "storage";
    this.activeStorageTab = "resources";
    this.activeStorageRoomId = this._normalizeStorageRoomId(toRoomId);
    this.render({ force: true, focus: false });
    ui.notifications.info(result.message);
  } catch (error) {
    console.error("FBL Skyhold | Failed to move storage resource", error);
    ui.notifications.error("Не удалось переместить ресурс. Подробности в консоли.");
  }
},

_moneyDenomFactor(key = "copper") {
  if (key === "gold") return 100;
  if (key === "silver") return 10;
  return 1;
},

_readMoneyInputValue(value = "") {
  const text = String(value ?? "").trim().replace(",", ".");
  const match = text.match(/^([+-]?)(\d+(?:\.\d+)?)$/);
  if (!match) return { ok: false, mode: "set", value: 0 };
  return {
    ok: true,
    mode: match[1] === "+" || match[1] === "-" ? "delta" : "set",
    sign: match[1] === "-" ? -1 : 1,
    value: Math.floor(Number(match[2]) || 0)
  };
},

async _setStorageMoneyFromUi({ changedField = null, buttonDelta = 0, buttonDenom = "copper" } = {}) {
  if (!this._canUseStorage()) return;
  const root = changedField?.closest?.(".fbls-storage-money-counter") ?? this.element?.querySelector?.(".fbls-storage-money-counter");
  if (!root) return;
  try {
    const data = SkyholdData.get();
    const holding = data.holdings.find((item) => item.id === this.activeHoldingId) ?? data.holdings[0];
    if (!holding) return;
    const before = this._moneyCopper(holding);
    let total = before;

    if (buttonDelta) {
      total = before + (buttonDelta * this._moneyDenomFactor(buttonDenom));
    } else if (changedField) {
      const denom = String(changedField.dataset.storageMoneyField ?? "copper");
      const parsed = this._readMoneyInputValue(changedField.value);
      if (!parsed.ok) { ui.notifications.warn("Введи число или операцию вида +3 / -2."); return; }
      if (parsed.mode === "delta") total = before + parsed.sign * parsed.value * this._moneyDenomFactor(denom);
      else {
        const readPlain = (key) => {
          const field = root.querySelector(`[data-storage-money-field="${key}"]`);
          const parsedField = this._readMoneyInputValue(field?.value ?? "0");
          return parsedField.ok && parsedField.mode === "set" ? parsedField.value : 0;
        };
        total = readPlain("gold") * 100 + readPlain("silver") * 10 + readPlain("copper");
      }
    }

    total = Math.max(0, Math.floor(total));
    this._setMoneyCopper(holding, total);
    const diff = total - before;
    if (diff) this._appendStorageLog(holding, [{ kind: diff > 0 ? "income" : "expense", resourceId: "money", name: "Деньги", qty: diff, source: "Казна", note: "Ручная правка" }]);
    await SkyholdData.set(data);
    this.activeTab = "storage";
    this.render({ force: true, focus: false });
  } catch (error) {
    console.error("FBL Skyhold | Failed to update money counter", error);
    ui.notifications.error("Не удалось изменить счетчик денег. Подробности в консоли.");
  }
},

async _onStorageMoneyChange(event) {
  event.preventDefault();
  event.stopPropagation();
  return this._setStorageMoneyFromUi({ changedField: event.currentTarget });
},

async _onAdjustStorageMoney(event) {
  event.preventDefault();
  event.stopPropagation();
  const button = event.currentTarget;
  const denom = String(button?.dataset?.moneyDenom ?? "copper");
  const delta = button?.dataset?.moneyOp === "minus" ? -1 : 1;
  return this._setStorageMoneyFromUi({ buttonDelta: delta, buttonDenom: denom });
},


async _onStorageDrop(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canUseStorage()) return;
  event.currentTarget?.classList?.remove?.("dragover");

  let dropData = null;
  try {
    dropData = JSON.parse(event.dataTransfer?.getData("text/plain") || "{}");
  } catch (_error) {}
  const uuid = dropData?.uuid || dropData?.itemUuid || dropData?.documentUuid;
  let item = null;
  try {
    if (uuid && globalThis.fromUuid) item = await globalThis.fromUuid(uuid);
    if (!item && globalThis.Item?.implementation?.fromDropData) item = await globalThis.Item.implementation.fromDropData(dropData);
  } catch (error) {
    console.warn("FBL Skyhold | Failed to resolve dropped item", dropData, error);
  }
  const itemDocumentName = item?.documentName ?? item?.constructor?.documentName;
  if (!item || itemDocumentName !== "Item") {
    ui.notifications.warn("Перетащи сюда предмет Foundry.");
    return;
  }

  try {
    const data = SkyholdData.get();
    const holding = data.holdings.find((entry) => entry.id === this.activeHoldingId) ?? data.holdings[0];
    if (!holding) return;
    const roomId = String(event.currentTarget?.dataset?.roomId ?? this.activeStorageRoomId ?? "outdoors");
    const result = await this._storageReceiveFoundryItem(holding, item, { roomId });
    if (!result.ok) { ui.notifications.warn(result.message); return; }
    await SkyholdData.set(data);
    this.activeTab = "storage";
    this.activeStorageTab = String(item.type) === "rawMaterial" ? "resources" : "items";
    this.activeStorageRoomId = this._normalizeStorageRoomId(roomId);
    this.render({ force: true, focus: false });
    ui.notifications.info(result.message);
  } catch (error) {
    console.error("FBL Skyhold | Failed to store dropped item", error);
    ui.notifications.error("Не удалось принять предмет. Подробности в консоли.");
  }
},

async _onWithdrawStorageResource(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canUseStorage()) return;
  const button = event.currentTarget;
  const card = button.closest(".fbls-storage-resource-card");
  const resourceId = String(button.dataset.resourceId ?? "custom");
  const name = String(button.dataset.resourceName ?? "");
  const roomId = String(button.dataset.roomId ?? this.activeStorageRoomId ?? "outdoors");
  const qty = Math.max(1, this._safeNumber(card?.querySelector("[data-storage-withdraw-qty]")?.value, 1));
  const actorId = this._storageDefaultActorId();
  if (!actorId) {
    ui.notifications.warn("Не найден привязанный персонаж игрока.");
    return;
  }
  try {
    const data = SkyholdData.get();
    const holding = data.holdings.find((entry) => entry.id === this.activeHoldingId) ?? data.holdings[0];
    if (!holding) return;
    const result = await this._withdrawResourceToActor(holding, { resourceId, name, qty, roomId, actorId });
    if (!result.ok) { ui.notifications.warn(result.message); return; }
    await SkyholdData.set(data);
    this.activeTab = "storage";
    this.activeStorageTab = "resources";
    this.activeStorageRoomId = this._normalizeStorageRoomId(roomId);
    this.render({ force: true, focus: false });
    ui.notifications.info(result.message);
  } catch (error) {
    console.error("FBL Skyhold | Failed to withdraw resource", error);
    ui.notifications.error("Не удалось выдать ресурс. Подробности в консоли.");
  }
},


async _onOpenStorageItem(event) {
  event.preventDefault();
  event.stopPropagation();
  const itemIndex = Number(event.currentTarget?.dataset?.index ?? -1);
  if (!Number.isFinite(itemIndex) || itemIndex < 0) return;
  try {
    const data = SkyholdData.get();
    const holding = data.holdings.find((entry) => entry.id === this.activeHoldingId) ?? data.holdings[0];
    const row = holding?.storage?.items?.[itemIndex];
    if (!row) { ui.notifications.warn("Предмет склада не найден."); return; }

    let document = null;
    const itemData = foundry?.utils?.deepClone?.(row.itemData ?? row) ?? JSON.parse(JSON.stringify(row.itemData ?? row));
    itemData.name = itemData.name || row.name || "Предмет";
    itemData.type = itemData.type || row.type || "gear";
    itemData.img = itemData.img || row.img || "icons/svg/item-bag.svg";
    itemData.system = itemData.system && typeof itemData.system === "object" ? itemData.system : {};
    if (row.qty !== undefined || row.quantity !== undefined) itemData.system.quantity = this._itemQuantity(row);
    const ownerLevel = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    const userId = String(game.user?.id ?? "");
    itemData.ownership = { ...(itemData.ownership && typeof itemData.ownership === "object" ? itemData.ownership : {}), default: ownerLevel };
    if (userId) itemData.ownership[userId] = ownerLevel;
    delete itemData._id;
    delete itemData.id;
    delete itemData.pack;
    delete itemData.folder;
    delete itemData.sort;
    if (itemData.flags?.core?.sourceId) delete itemData.flags.core.sourceId;

    try {
      const cls = globalThis.CONFIG?.Item?.documentClass ?? globalThis.Item?.implementation ?? globalThis.Item;
      if (cls) document = new cls(itemData, { temporary: true, parent: null });
    } catch (error) {
      console.warn("FBL Skyhold | Temporary Item creation failed", error);
    }

    if (!document?.sheet && row.itemUuid && globalThis.fromUuid && game.user?.isGM) {
      try { document = await globalThis.fromUuid(row.itemUuid); } catch (_error) {}
    }
    if (!document?.sheet) { ui.notifications.warn("Не удалось открыть карточку предмета."); return; }
    document.sheet.render(true);
  } catch (error) {
    console.error("FBL Skyhold | Failed to open stored item", error);
    ui.notifications.error("Не удалось открыть предмет склада. Подробности в консоли.");
  }
},

async _onGiveStorageItem(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canUseStorage()) return;
  const button = event.currentTarget;
  const card = button.closest(".fbls-storage-item-card");
  const itemIndex = Number(button.dataset.index ?? -1);
  const qty = Math.max(1, this._safeNumber(card?.querySelector("[data-storage-item-give-qty]")?.value, 1));
  const actorId = this._storageDefaultActorId();
  if (!actorId) {
    ui.notifications.warn("Не найден привязанный персонаж игрока.");
    return;
  }
  try {
    const data = SkyholdData.get();
    const holding = data.holdings.find((entry) => entry.id === this.activeHoldingId) ?? data.holdings[0];
    if (!holding) return;
    const result = await this._giveStoredItemToActor(holding, { itemIndex, qty, actorId });
    if (!result.ok) { ui.notifications.warn(result.message); return; }
    await SkyholdData.set(data);
    this.activeTab = "storage";
    this.activeStorageTab = "items";
    this.render({ force: true, focus: false });
    ui.notifications.info(result.message);
  } catch (error) {
    console.error("FBL Skyhold | Failed to give stored item", error);
    ui.notifications.error("Не удалось выдать предмет. Подробности в консоли.");
  }
},

async _onCleanStorageZeros(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!game.user?.isGM) return;
  const data = SkyholdData.get();
  const holding = data.holdings.find((item) => item.id === this.activeHoldingId) ?? data.holdings[0];
  if (!holding?.storage?.resources) return;
  const before = holding.storage.resources.length;
  holding.storage.resources = holding.storage.resources.filter((row) => Math.abs(this._safeNumber(row.qty, 0)) > 0.0001);
  const removed = before - holding.storage.resources.length;
  await SkyholdData.set(data);
  this.activeTab = "storage";
  this.render({ force: true, focus: false });
  ui.notifications.info(removed ? `Удалено нулевых ресурсов: ${removed}.` : "Нулевых ресурсов нет.");
},

async _onClearStorageLog(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!game.user?.isGM) return;
  const data = SkyholdData.get();
  const holding = data.holdings.find((item) => item.id === this.activeHoldingId) ?? data.holdings[0];
  if (!holding) return;
  if (!holding.storage) holding.storage = { notes: "", resources: [], log: [] };
  holding.storage.log = [];
  await SkyholdData.set(data);
  this.activeTab = "storage";
  this.activeStorageTab = "log";
  this.render({ force: true, focus: false });
  ui.notifications.info("Лог хранилища очищен.");
}
};
