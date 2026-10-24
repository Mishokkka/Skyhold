// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { requestStorageOperation, SkyholdData } from "../../../data/store.js";
import { clone } from "../../../data/utils.js";
import { createSafeIcon } from "../../../core/helpers.js";
import { foundryItemClass, renderFoundryDocumentSheet, resolveFoundryUuid } from "../../../integrations/foundry-runtime.js";
import { SkyholdResourceCatalogEditor } from "../../editors/resource-catalog-editor.js";
import { SkyholdStorageActionDialog } from "../../storage-action-dialog.js";
import { dispatchDelegatedAction } from "../../common/delegated-events.js";

export const StorageEventActions = {
  click: {
    "adjust-storage-money": "_onAdjustStorageMoney",
    "clear-storage-log": "_onClearStorageLog",
    "add-storage-resource": "_onAddStorageResource",
    "open-storage-item": "_onOpenStorageItem",
    "toggle-storage-batch-visible": "_onToggleStorageBatchVisible",
    "pick-storage-resource": "_onPickStorageResource",
    "toggle-storage-room-rail": "_onToggleStorageRoomRail",
    "storage-row-actions": "_onStorageRowActions",
    "storage-selection-move": "_onStorageSelectionMove"
  },
  publicClick: ["open-storage-item"]
};

const STORAGE_CONTEXT_MENU_WIDTH = 248;
const STORAGE_CONTEXT_MENU_HEIGHT = 176;

function createStorageContextMenuButton({ action = "", icon = "fa-solid fa-right-left", label = "", danger = false } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("role", "menuitem");
  button.dataset.action = String(action);
  if (danger) button.classList.add("danger");
  const text = document.createElement("span");
  text.textContent = String(label);
  button.append(createSafeIcon(icon), text);
  return button;
}

export const StorageEventDomain = {
_onAddStorageResource(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!game.user?.isGM) return;
  const data = SkyholdData.get();
  const holdingId = this._activeWritableHoldingId(data);
  if (!holdingId) return this._warnNoActiveHolding();
  const roomId = this._normalizeStorageRoomId(this.activeStorageRoomId || "outdoors");
  SkyholdResourceCatalogEditor.pick({
    onSelect: async (resource) => {
      const resourceId = String(resource?.id ?? "custom") || "custom";
      const name = resourceId === "custom"
        ? "Новый материал"
        : String(resource?.label ?? resourceId);
      try {
        const result = await requestStorageOperation({
          type: "addResourceRow",
          holdingId,
          resourceId,
          name,
          roomId,
          qty: 1
        });
        if (!result?.ok) {
          ui.notifications.warn(result?.message || "Не удалось добавить материал.");
          return;
        }
        this.activeTab = "storage";
        this.activeStorageTab = "resources";
        this.activeStorageRoomId = roomId;
        this._activeTabContextCache?.clear?.();
        this.requestRender({ focus: false, skipLoadingOverlay: true });
        ui.notifications.info(result.message || `${name}: добавлена 1 ед.`);
      } catch (error) {
        console.error("FBL Skyhold | Failed to add a selected storage resource", error);
        ui.notifications.error("Не удалось добавить материал. Подробности в консоли.");
      }
    }
  });
},

_onToggleStorageRoomRail(event) {
  event.preventDefault();
  event.stopPropagation();
  this.storageRoomRailCollapsed = !this.storageRoomRailCollapsed;
  const root = event.currentTarget?.closest?.(".fbls-storage-workspace");
  const rail = root?.querySelector?.(".fbls-storage-room-rail");
  rail?.classList?.toggle?.("is-collapsed", this.storageRoomRailCollapsed);
  root?.classList?.toggle?.("room-rail-collapsed", this.storageRoomRailCollapsed);
  const button = rail?.querySelector?.("[data-action='toggle-storage-room-rail']");
  if (button) {
    const collapsed = Boolean(this.storageRoomRailCollapsed);
    button.setAttribute("aria-pressed", collapsed ? "true" : "false");
    button.setAttribute("aria-label", collapsed ? "Развернуть список хранилищ" : "Свернуть список хранилищ");
    button.dataset.fblsTooltip = collapsed ? "Развернуть список хранилищ" : "Свернуть до иконок";
    const icon = button.querySelector("i");
    icon?.classList?.toggle?.("fa-angles-right", collapsed);
    icon?.classList?.toggle?.("fa-angles-left", !collapsed);
  }
},

_onPickStorageResource(event) {
  event.preventDefault();
  if (!this._canUseStorage()) return;
  const button = event.currentTarget;
  const scope = String(button?.dataset?.storagePickerScope ?? "");
  const index = Number(button?.dataset?.storageResourceIndex ?? -1);
  SkyholdResourceCatalogEditor.pick({
    selectedId: String(button?.dataset?.resourceId ?? ""),
    onSelect: async (resource) => {
      if (scope === "row" && Number.isInteger(index) && index >= 0) {
        const updated = await this._updateActiveHolding((holding) => {
          const row = holding?.storage?.resources?.[index];
          if (!row) return SkyholdData.skipTransaction(false);
          row.resourceId = String(resource.id ?? "custom");
          if (row.resourceId !== "custom") row.name = String(resource.label ?? "");
          return true;
        }, { reason: "storage:pick-row-resource" });
        if (updated) this.requestRender({ focus: false });
        return;
      }
      const root = button.closest(scope === "move" ? ".fbls-storage-move" : ".fbls-storage-adjust");
      const hidden = root?.querySelector?.(scope === "move" ? "[data-storage-move-resource]" : "[data-storage-adjust-resource]");
      if (hidden) hidden.value = String(resource.id ?? "custom");
      button.dataset.resourceId = String(resource.id ?? "custom");
      const label = button.querySelector("strong");
      if (label) label.textContent = String(resource.label ?? resource.id ?? "Ресурс");
    }
  });
},
_onStorageBatchSelectionChange(event) {
  if (!this._canUseStorage()) return;
  const field = event.currentTarget;
  const rowType = String(field?.dataset?.storageBatchKind ?? "") === "items" ? "items" : "resources";
  const rowId = String(field?.dataset?.storageBatchSelect ?? "");
  if (!rowId) return;
  const selection = this.storageBatchSelection?.[rowType];
  if (!(selection instanceof Set)) return;
  if (field.checked) selection.add(rowId);
  else selection.delete(rowId);
  this._activeTabContextCache?.clear?.();
  this.requestRender({ focus: false, skipLoadingOverlay: true });
},

_onToggleStorageBatchVisible(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canUseStorage()) return;
  const rowType = String(event.currentTarget?.dataset?.storageBatchKind ?? "") === "items" ? "items" : "resources";
  const root = event.currentTarget?.closest?.(".fbls-storage-resources-layout");
  const fields = Array.from(root?.querySelectorAll?.(`[data-storage-batch-select][data-storage-batch-kind="${rowType}"]`) ?? []);
  const selection = this.storageBatchSelection?.[rowType];
  if (!(selection instanceof Set) || !fields.length) return;
  const allSelected = fields.every((field) => selection.has(String(field.dataset.storageBatchSelect ?? "")));
  for (const field of fields) {
    const rowId = String(field.dataset.storageBatchSelect ?? "");
    if (!rowId) continue;
    if (allSelected) selection.delete(rowId);
    else selection.add(rowId);
  }
  this._activeTabContextCache?.clear?.();
  this.requestRender({ focus: false, skipLoadingOverlay: true });
},

_closeStorageContextMenu({ restoreFocus = false } = {}) {
  try { this._storageContextCleanup?.(); } catch (_error) {}
  this._storageContextCleanup = null;
  document.querySelector(".fbls-storage-context-menu")?.remove?.();
  if (restoreFocus) this._storageContextAnchor?.focus?.({ preventScroll: true });
  this._storageContextAnchor = null;
},

async _showStorageContextMenu({ rowType = "resources", rowId = "", roomId = "outdoors", position = null, anchor = null } = {}) {
  this._closeStorageContextMenu();
  this._storageContextAnchor = anchor;
  const menu = document.createElement("div");
  menu.className = "fbl-skyhold fbls-storage-context-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Действия с позицией склада");
  menu.append(
    createStorageContextMenuButton({ action: "move", icon: "fa-solid fa-right-left", label: "Переместить" }),
    createStorageContextMenuButton({ action: "give", icon: "fa-solid fa-hand-holding", label: "Выдать" }),
    createStorageContextMenuButton({ action: "note", icon: "fa-solid fa-note-sticky", label: "Заметка" }),
    createStorageContextMenuButton({ action: "delete", icon: "fa-solid fa-trash", label: "Удалить", danger: true })
  );
  const left = Math.max(8, Math.min(window.innerWidth - STORAGE_CONTEXT_MENU_WIDTH, Number(position?.x ?? 0)));
  const top = Math.max(8, Math.min(window.innerHeight - STORAGE_CONTEXT_MENU_HEIGHT, Number(position?.y ?? 0)));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  document.body.appendChild(menu);
  const buttons = Array.from(menu.querySelectorAll("button"));
  buttons[0]?.focus();

  const onOutsidePointer = (event) => {
    if (event.target?.closest?.(".fbls-storage-context-menu")) return;
    this._closeStorageContextMenu();
  };
  const onEscape = (event) => {
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
      this._closeStorageContextMenu({ restoreFocus: true });
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && menu.contains(document.activeElement)) {
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  };
  document.addEventListener("pointerdown", onOutsidePointer, true);
  document.addEventListener("keydown", onEscape, true);
  this._storageContextCleanup = () => {
    document.removeEventListener("pointerdown", onOutsidePointer, true);
    document.removeEventListener("keydown", onEscape, true);
  };
  menu.addEventListener("click", (event) => {
    const button = event.target?.closest?.("button[data-action]");
    if (!button || !menu.contains(button)) return;
    event.preventDefault();
    event.stopPropagation();
    const action = String(button.dataset.action ?? "");
    this._closeStorageContextMenu({ restoreFocus: true });
    dispatchDelegatedAction(this, event, button, () => this._executeStorageContextAction({ action, rowType, rowId, roomId }));
  });
},

_onStorageRowActions(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canUseStorage()) return;
  const anchor = event.currentTarget;
  const row = anchor.closest("[data-storage-row-id]");
  if (!row) return;
  const bounds = anchor.getBoundingClientRect();
  return this._showStorageContextMenu({ rowType: row.dataset.storageRowType, rowId: row.dataset.storageRowId,
    roomId: row.dataset.storageRowRoomId, position: { x: bounds.left, y: bounds.bottom }, anchor });
},

_onStorageSelectionMove(event) {
  event.preventDefault();
  if (!this._canUseStorage()) return;
  const rowType = event.currentTarget.dataset.storageBatchKind === "items" ? "items" : "resources";
  const rowId = [...(this.storageBatchSelection?.[rowType] ?? [])][0];
  if (!rowId) return;
  return this._openStorageMoveDialog({ rowType, rowId, fromRoomId: this.activeStorageRoomId || "outdoors" });
},

_storageContextRow({ rowType = "resources", rowId = "", roomId = "outdoors" } = {}) {
  const data = SkyholdData.get();
  const holdingId = this._activeWritableHoldingId(data);
  const holdingIndex = (data?.holdings ?? []).findIndex((row) => String(row?.id ?? "") === String(holdingId ?? ""));
  const holding = holdingIndex >= 0 ? data.holdings[holdingIndex] : null;
  const type = rowType === "items" ? "items" : "resources";
  const rows = Array.isArray(holding?.storage?.[type]) ? holding.storage[type] : [];
  const row = rows.find((entry) => String(entry?.id ?? "") === String(rowId ?? "")) ?? null;
  return { data, holding, holdingIndex, holdingId, type, row, roomId: this._normalizeStorageRoomId(roomId) };
},

async _executeStorageContextAction({ action = "", rowType = "resources", rowId = "", roomId = "outdoors" } = {}) {
  if (action === "move") return this._openStorageMoveDialog({ rowType, rowId, fromRoomId: roomId });
  if (action === "give") return this._openStorageGiveDialog({ rowType, rowId, roomId });
  if (action === "note") return this._openStorageNoteDialog({ rowType, rowId, roomId });
  if (action === "delete") return this._openStorageDeleteDialog({ rowType, rowId, roomId });
},

async _onStorageRowContextMenu(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canUseStorage()) return;
  const row = event.currentTarget;
  const rowType = String(row?.dataset?.storageRowType ?? "") === "items" ? "items" : "resources";
  const rowId = String(row?.dataset?.storageRowId ?? "");
  const roomId = this._normalizeStorageRoomId(row?.dataset?.storageRowRoomId || this.activeStorageRoomId || "outdoors");
  if (!rowId) return;
  await this._showStorageContextMenu({ rowType, rowId, roomId, position: { x: event.clientX, y: event.clientY } });
},

async _openStorageMoveDialog({ rowType = "resources", rowId = "", fromRoomId = "outdoors" } = {}) {
  const data = SkyholdData.get();
  const holdingId = this._activeWritableHoldingId(data);
  const source = (data?.holdings ?? []).find((holding) => String(holding?.id ?? "") === String(holdingId ?? ""));
  if (!source) return this._warnNoActiveHolding();

  const normalizedType = rowType === "items" ? "items" : "resources";
  const normalizedFromRoomId = this._normalizeStorageRoomId(fromRoomId);
  const sourceRows = Array.isArray(source?.storage?.[normalizedType]) ? source.storage[normalizedType] : [];
  const rowsInRoom = sourceRows.filter((row) => this._normalizeStorageRoomId(row?.roomId ?? row?.storageRoomId) === normalizedFromRoomId);
  const validIds = new Set(rowsInRoom.map((row) => String(row?.id ?? "")).filter(Boolean));
  const selectedIds = Array.from(this.storageBatchSelection?.[normalizedType] ?? []).map(String).filter((id) => validIds.has(id));
  const rowIds = selectedIds.length > 1 ? selectedIds : (validIds.has(String(rowId)) ? [String(rowId)] : []);
  if (!rowIds.length) {
    ui.notifications.warn("Позиция больше не находится в этом хранилище.");
    return;
  }

  const rooms = this._storageRooms(source, { includeUnavailable: true });
  const targetRooms = rooms.filter((room) => room.available && room.id !== normalizedFromRoomId);
  if (!targetRooms.length) {
    ui.notifications.warn("Нет другого доступного хранилища для перемещения.");
    return;
  }

  const rowById = new Map(sourceRows.map((row) => [String(row?.id ?? ""), row]));
  const labels = rowIds.map((id) => {
    const row = rowById.get(id) ?? {};
    if (normalizedType === "items") return String(row?.name ?? "Предмет");
    const resourceId = String(row?.resourceId ?? "custom");
    return resourceId === "custom" ? String(row?.name ?? "Ресурс") : String(row?.name ?? resourceId);
  });
  const sourceLabel = this._storageRoomLabel(source, normalizedFromRoomId);
  const selectionText = rowIds.length > 1
    ? `${rowIds.length} выбранных позиций`
    : `«${labels[0] || "Позиция"}»`;
  const singleRow = rowIds.length === 1 ? rowById.get(rowIds[0]) : null;
  const maxQuantity = singleRow
    ? Math.max(1, Math.floor(normalizedType === "items"
      ? this._itemQuantity(singleRow)
      : this._storageAvailableRowQuantity(source, singleRow)))
    : null;
  const dialogResult = await SkyholdStorageActionDialog.open({
    anchor: this,
    mode: "move",
    title: "Перемещение между хранилищами",
    icon: "fa-solid fa-right-left",
    description: `Переместить ${selectionText} из «${sourceLabel}».`,
    confirmLabel: "Переместить",
    allowQuantity: Boolean(singleRow),
    quantityHint: singleRow ? `Доступно от 1 до ${maxQuantity} ед.` : "",
    value: maxQuantity ?? 1,
    max: maxQuantity ?? 1,
    options: targetRooms.map((room, index) => ({ value: room.id, label: room.label, selected: index === 0 }))
  });
  const toRoomId = typeof dialogResult === "object" ? dialogResult?.destination : dialogResult;
  const moveQuantity = typeof dialogResult === "object" ? dialogResult?.quantity : null;
  const normalizedToRoomId = this._normalizeStorageRoomId(toRoomId);
  if (!toRoomId || normalizedToRoomId === normalizedFromRoomId) return;
  const rowQuantities = singleRow && moveQuantity
    ? { [rowIds[0]]: Math.max(1, Math.min(maxQuantity, Math.floor(Number(moveQuantity) || 1))) }
    : {};

  const prepared = clone(source);
  const preview = this._planStorageBatchMove(prepared, {
    rowType: normalizedType,
    rowIds,
    rowQuantities,
    fromRoomId: normalizedFromRoomId,
    toRoomId: normalizedToRoomId,
    operationId: "preview"
  });
  if (!preview.ok) {
    ui.notifications.warn(preview.message);
    return;
  }

  const applied = await requestStorageOperation({
    type: "batchMove",
    holdingId,
    expectedRevision: Math.max(0, Number(data?.meta?.revision) || 0),
    rowType: normalizedType,
    rowIds,
    rowQuantities,
    fromRoomId: normalizedFromRoomId,
    toRoomId: normalizedToRoomId
  });
  if (!applied) return;
  if (!applied.ok) {
    ui.notifications.warn(applied.message || "Не удалось переместить выбранные позиции.");
    return;
  }
  const selection = this.storageBatchSelection?.[normalizedType];
  for (const id of rowIds) selection?.delete?.(id);
  this.activeStorageRoomId = normalizedToRoomId;
  this.activeStorageTab = normalizedType;
  this._activeTabContextCache?.clear?.();
  this.requestRender({ focus: false, skipLoadingOverlay: true });
  ui.notifications.info(`Перемещено позиций: ${applied.moved}.`);
},

async _openStorageGiveDialog({ rowType = "resources", rowId = "", roomId = "outdoors" } = {}) {
  const context = this._storageContextRow({ rowType, rowId, roomId });
  if (!context.holding || !context.row) return ui.notifications.warn("Позиция склада не найдена.");
  const isItem = context.type === "items";
  const label = isItem ? String(context.row.name ?? "Предмет") : String(context.row.name ?? context.row.resourceId ?? "Ресурс");
  const max = Math.max(1, Math.floor(isItem ? this._itemQuantity(context.row) : this._safeNumber(context.row.qty, 0)));
  const actor = this._storageDefaultActor();
  if (!actor?.id) return ui.notifications.warn("Не найден привязанный персонаж игрока.");
    const qty = await SkyholdStorageActionDialog.open({
      anchor: this,
      mode: "quantity",
    title: `Выдать: ${label}`,
    icon: "fa-solid fa-hand-holding",
    description: `Получатель: ${String(actor.name ?? "персонаж игрока")}. Доступно ${max} ед.`,
    quantityHint: `От 1 до ${max} ед.`,
    value: 1,
    max,
    confirmLabel: "Выдать"
  });
  if (!qty) return;
  return isItem
    ? this._giveStoredItem({ itemId: rowId, qty, actor, roomId: context.roomId })
    : this._withdrawStoredResource({ row: context.row, qty, actor, roomId: context.roomId });
},

async _openStorageNoteDialog({ rowType = "resources", rowId = "", roomId = "outdoors" } = {}) {
  const context = this._storageContextRow({ rowType, rowId, roomId });
  if (!context.holding || !context.row) return ui.notifications.warn("Позиция склада не найдена.");
  const label = context.type === "items" ? String(context.row.name ?? "Предмет") : String(context.row.name ?? context.row.resourceId ?? "Ресурс");
    const note = await SkyholdStorageActionDialog.open({
      anchor: this,
      mode: "note",
    title: `Заметка: ${label}`,
    icon: "fa-solid fa-note-sticky",
    description: "Заметка показывается через секунду после наведения на строку.",
    note: String(context.row.notes ?? ""),
    confirmLabel: "Сохранить"
  });
  if (note === null) return;
  const saved = await this._updateActiveHolding((holding) => {
    const rows = Array.isArray(holding?.storage?.[context.type]) ? holding.storage[context.type] : [];
    const row = rows.find((entry) => String(entry?.id ?? "") === String(rowId));
    if (!row) return SkyholdData.skipTransaction(false);
    row.notes = this._sanitizeTextBlock(note).slice(0, 1000);
    return true;
  }, { reason: `storage:${context.type}:note` });
  if (saved) this.requestRender({ focus: false, skipLoadingOverlay: true });
},

async _openStorageDeleteDialog({ rowType = "resources", rowId = "", roomId = "outdoors" } = {}) {
  const context = this._storageContextRow({ rowType, rowId, roomId });
  if (!context.holding || !context.row) return ui.notifications.warn("Позиция склада не найдена.");
  const label = context.type === "items" ? String(context.row.name ?? "Предмет") : String(context.row.name ?? context.row.resourceId ?? "Ресурс");
    const confirmed = await SkyholdStorageActionDialog.open({
      anchor: this,
      mode: "confirm",
    title: `Удалить: ${label}`,
    icon: "fa-solid fa-trash",
    description: "Позиция будет безвозвратно удалена из хранилища.",
    confirmLabel: "Удалить",
    danger: true
  });
  if (!confirmed) return;
  const removed = await this._updateActiveHolding((holding) => {
    const rows = Array.isArray(holding?.storage?.[context.type]) ? holding.storage[context.type] : [];
    const index = rows.findIndex((entry) => String(entry?.id ?? "") === String(rowId));
    if (index < 0) return SkyholdData.skipTransaction(false);
    rows.splice(index, 1);
    return true;
  }, { reason: `storage:${context.type}:delete` });
  this.storageBatchSelection?.[context.type]?.delete?.(String(rowId));
  if (removed) this.requestRender({ focus: false, skipLoadingOverlay: true });
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
    const result = await this._updateActiveHolding((holding) => {
      const before = this._moneyCopper(holding);
      let total = before;

      if (buttonDelta) {
        total = before + (buttonDelta * this._moneyDenomFactor(buttonDenom));
      } else if (changedField) {
        const denom = String(changedField.dataset.storageMoneyField ?? "copper");
        const parsed = this._readMoneyInputValue(changedField.value);
        if (!parsed.ok) return SkyholdData.skipTransaction({ ok: false, message: "Введи число или операцию вида +3 / -2." });
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
      return { ok: true };
    }, { reason: "storage:set-money" });
    if (!result) return;
    if (!result.ok) { ui.notifications.warn(result.message); return; }
    this.activeTab = "storage";
    this.requestRender();
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
    if (uuid) item = await resolveFoundryUuid(uuid);
    if (!item) item = await foundryItemClass().implementation.fromDropData(dropData);
  } catch (error) {
    console.warn("FBL Skyhold | Failed to resolve dropped item", dropData, error);
  }
  const itemDocumentName = item?.documentName ?? item?.constructor?.documentName;
  if (!item || itemDocumentName !== "Item") {
    ui.notifications.warn("Перетащи сюда предмет Foundry.");
    return;
  }

  try {
    const roomId = String(event.currentTarget?.dataset?.roomId ?? this.activeStorageRoomId ?? "outdoors");
    const parent = item.parent;
    const parentDocumentName = parent?.documentName ?? parent?.constructor?.documentName;
    const result = await requestStorageOperation({
      type: "depositItem",
      holdingId: String(this.activeHoldingId ?? ""),
      actorId: parentDocumentName === "Actor" ? String(parent.id ?? "") : "",
      actorUuid: parentDocumentName === "Actor" ? String(parent.uuid ?? "") : "",
      itemId: String(item.id ?? ""),
      itemUuid: String(item.uuid ?? uuid ?? ""),
      roomId
    });
    if (!result) return;
    if (!result.ok) { ui.notifications.warn(result.message); return; }
    this.activeTab = "storage";
    this.activeStorageTab = String(item.type) === "rawMaterial" ? "resources" : "items";
    this.activeStorageRoomId = this._normalizeStorageRoomId(roomId);
    this.requestRender();
    ui.notifications.info(result.message);
  } catch (error) {
    console.error("FBL Skyhold | Failed to store dropped item", error);
    ui.notifications.error("Не удалось принять предмет. Подробности в консоли.");
  }
},

async _withdrawStoredResource({ row = null, qty = 1, actor = null, roomId = "outdoors" } = {}) {
  const actorId = String(actor?.id ?? "");
  if (!actorId) return ui.notifications.warn("Не найден привязанный персонаж игрока.");
  try {
    const result = await requestStorageOperation({
      type: "withdrawResource",
      holdingId: String(this.activeHoldingId ?? ""),
      actorId,
      actorUuid: String(actor?.uuid ?? ""),
      resourceId: String(row?.resourceId ?? "custom"),
      name: String(row?.name ?? ""),
      qty,
      roomId
    });
    if (!result) return;
    if (!result.ok) { ui.notifications.warn(result.message); return; }
    this.activeTab = "storage";
    this.activeStorageTab = "resources";
    this.activeStorageRoomId = this._normalizeStorageRoomId(roomId);
    this.requestRender();
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
    const holding = data.holdings.find((entry) => entry.id === this.activeHoldingId);
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
      const cls = globalThis.CONFIG?.Item?.documentClass ?? foundryItemClass().implementation;
      if (cls) document = new cls(itemData, { temporary: true, parent: null });
    } catch (error) {
      console.warn("FBL Skyhold | Temporary Item creation failed", error);
    }

    if (!document?.sheet && row.itemUuid && game.user?.isGM) {
      try { document = await resolveFoundryUuid(row.itemUuid); } catch (_error) {}
    }
    if (!document?.sheet) { ui.notifications.warn("Не удалось открыть карточку предмета."); return; }
    renderFoundryDocumentSheet(document);
  } catch (error) {
    console.error("FBL Skyhold | Failed to open stored item", error);
    ui.notifications.error("Не удалось открыть предмет склада. Подробности в консоли.");
  }
},

async _giveStoredItem({ itemId = "", qty = 1, actor = null, roomId = "outdoors" } = {}) {
  const actorId = String(actor?.id ?? "");
  if (!actorId) return ui.notifications.warn("Не найден привязанный персонаж игрока.");
  try {
    const result = await requestStorageOperation({
      type: "giveStoredItem",
      holdingId: String(this.activeHoldingId ?? ""),
      actorId,
      actorUuid: String(actor?.uuid ?? ""),
      itemId,
      qty
    });
    if (!result) return;
    if (!result.ok) { ui.notifications.warn(result.message); return; }
    this.activeTab = "storage";
    this.activeStorageTab = "items";
    this.activeStorageRoomId = this._normalizeStorageRoomId(roomId);
    this.requestRender({ focus: false, skipLoadingOverlay: true });
    ui.notifications.info(result.message);
  } catch (error) {
    console.error("FBL Skyhold | Failed to give stored item", error);
    ui.notifications.error("Не удалось выдать предмет. Подробности в консоли.");
  }
},

async _onClearStorageLog(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!game.user?.isGM) return;
  if (!await this._confirmAction("Очистить лог хранилища", "Удалить все записи лога хранилища? Записи нельзя восстановить.")) return;
  const cleared = await this._updateActiveHolding((holding) => {
    if (!holding.storage) holding.storage = { notes: "", resources: [], log: [] };
    holding.storage.log = [];
    return true;
  }, { reason: "storage:clear-log" });
  if (!cleared) return;
  this.activeTab = "storage";
  this.activeStorageTab = "log";
  this.requestRender();
  ui.notifications.info("Лог хранилища очищен.");
}
};
