// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { createHolding } from "../../../data/holding-factory.js";
import { SkyholdData } from "../../../data/store.js";
import { findReadableHoldingEntry } from "../../../data/access-guard.js";
import { normalizeBelief } from "../../../generators/resident-rules.js";
import { SkyholdCrewEditor } from "../../editors/crew-editor.js";
import { openMarketApp, openMassCombatApp } from "../../lazy-apps.js";
import { escapeHtml, fieldValue, rollD6Pool } from "../../../core/helpers.js";
import { createFoundryChatMessage, foundryChatSpeaker, foundryDialogV2, renderFoundryFilePicker } from "../../../integrations/foundry-runtime.js";
import { MORALE_BANDS } from "../../../engines/morale/morale-snapshot.js";
import { setStorageRowTotalQuantity } from "../../../engines/storage/reservations.js";

export const NavigationEventActions = {
  click: {
    tab: "_onTabClick",
    "building-category": "_onBuildingCategory",
    "special-subtab": "_onSpecialSubtab",
    "open-market": "_onOpenMarket",
    "roll-holding-stat": "_onRollHoldingStat",
    "show-morale-help": "_onShowMoraleHelp",
    "open-crew-editor": "_onOpenCrewEditor",
    "storage-subtab": "_onStorageSubtab",
    "storage-room-tab": "_onStorageRoomTab",
    "storage-search-result": "_onStorageSearchResult",
    "create-holding": "_onCreateHolding",
    "delete-holding": "_onDeleteHolding",
    "edit-holding-name": "_onEditHoldingName",
    "toggle-holding-visibility": "_onToggleHoldingVisibility",
    "pick-file": "_onPickFile"
  },
  publicClick: [
    "tab",
    "building-category",
    "special-subtab",
    "open-market",
    "roll-holding-stat",
    "show-morale-help",
    "open-crew-editor",
    "storage-subtab",
    "storage-room-tab",
    "storage-search-result"
  ]
};

export const NavigationEventDomain = {
async _onOpenMarket(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this.activeHoldingId) return;
  await openMarketApp({ holdingId: this.activeHoldingId });
},

_onOpenCrewEditor(event) {
  event.preventDefault();
  event.stopPropagation();
  const editor = new SkyholdCrewEditor({ holdingId: this.activeHoldingId });
  editor.render({ force: true, focus: true });
},

async _onRollHoldingStat(event) {
  event.preventDefault();
  event.stopPropagation();
  const stat = event.currentTarget?.dataset?.stat;
  const data = SkyholdData.get();
  const { holding } = findReadableHoldingEntry(data, this.activeHoldingId, { fallback: false });
  if (!holding || !stat) return;
  if (stat === "defense") {
    try {
      await openMassCombatApp({ holdingId: holding.id });
    } catch (error) {
      console.error("FBL Skyhold | Failed to open mass combat window", error);
      ui.notifications?.error?.("Не удалось открыть окно битвы за владение. Подробности в консоли.");
    }
    return;
  }
  if (stat === "reputation" && game.user?.isGM && typeof this._postReputationEventRoll === "function") {
    return this._postReputationEventRoll(holding);
  }

  const label = "Репутация";
  const value = Math.max(0, this._safeNumber(this._reputationSummary(holding).total, 0));
  if (!value) { ui.notifications.warn(`${label}: 0к6.`); return; }
  const rolls = rollD6Pool(value);
  const successes = rolls.filter((roll) => roll >= 6).length;
  const diceText = rolls.map((roll) => roll >= 6 ? `<strong>${roll}</strong>` : String(roll)).join(", ");
  await createFoundryChatMessage({
    speaker: foundryChatSpeaker({ alias: holding.name || "Владение" }),
    content: `<div class="fbls-chat-card"><h3>${label}: ${value}к6</h3><p><strong>Кости:</strong> ${diceText}</p><p><strong>Успехи:</strong> ${successes}</p></div>`
  });
},


async _onShowMoraleHelp(event) {
  event.preventDefault();
  event.stopPropagation();
  const rows = [
    ...MORALE_BANDS
  ].map((band) => ({ ...band, value: band.id }));
  const content = `<div class="fbls-dialog-text"><table class="fbls-table compact"><thead><tr><th>Уровень</th><th>Диапазон</th><th>Эффект</th></tr></thead><tbody>${rows.map((row) => `<tr><td><strong>${escapeHtml(row.label)}</strong></td><td>${escapeHtml(row.range)}</td><td>${escapeHtml(row.notes)}</td></tr>`).join("")}</tbody></table></div>`;
  await foundryDialogV2().wait({ window: { title: "Довольство: уровни" }, content, buttons: [{ action: "ok", label: "Закрыть", default: true }] });
},

_onBuildingCategory(event) {
  event.preventDefault();
  const category = event.currentTarget?.dataset?.category || "all";
  this.activeBuildingCategory = category;
  this.requestRender();
},

_onStorageSubtab(event) {
  event.preventDefault();
  const tab = event.currentTarget?.dataset?.storageTab || "resources";
  this.activeStorageTab = ["resources", "items", "accounting", "market", "log"].includes(tab) ? tab : "resources";
  this.requestRender();
},

_onStorageRoomTab(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!["resources", "items"].includes(this.activeStorageTab)) this.activeStorageTab = "resources";
  this.activeStorageRoomId = this._normalizeStorageRoomId(event.currentTarget?.dataset?.roomId || "outdoors");
  this.requestRender();
},

_onStorageSearchInput(event) {
  this.storageSearchQuery = String(event.currentTarget?.value ?? "");
  this._applyStorageSearchFilter?.(this.element, this.storageSearchQuery);
},

_applyStorageSearchFilter(root = this.element, value = "") {
  const search = String(value ?? "").trim().toLocaleLowerCase("ru");
  const panel = root?.querySelector?.("[data-storage-search-panel]");
  const rows = Array.from(root?.querySelectorAll?.("[data-storage-search-row]") ?? []);
  let visible = 0;
  for (const row of rows) {
    const haystack = String(row.dataset.storageSearchRow ?? row.textContent ?? "").toLocaleLowerCase("ru");
    const show = Boolean(search) && haystack.includes(search);
    row.hidden = !show;
    if (show) visible += 1;
  }
  if (panel) panel.hidden = !search;
  const count = root?.querySelector?.("[data-storage-search-count]");
  if (count) count.textContent = String(visible);
  const empty = root?.querySelector?.("[data-storage-search-empty]");
  if (empty) empty.hidden = !search || visible > 0;
  return visible;
},

_onStorageSearchResult(event) {
  event.preventDefault();
  event.stopPropagation();
  this.activeStorageTab = event.currentTarget?.dataset?.storageSubtab === "items" ? "items" : "resources";
  this.activeStorageRoomId = this._normalizeStorageRoomId(event.currentTarget?.dataset?.roomId || "outdoors");
  this._pendingStorageSearchTarget = {
    type: this.activeStorageTab,
    id: String(event.currentTarget?.dataset?.storageTargetId ?? "")
  };
  this.requestRender();
},

_flashStorageSearchTarget(root = this.element) {
  const pending = this._pendingStorageSearchTarget;
  this._pendingStorageSearchTarget = null;
  if (!pending?.id || !root?.querySelectorAll) return;
  const flash = () => {
    const target = Array.from(root.querySelectorAll("[data-storage-row-type][data-storage-row-id]"))
      .find((row) => row.dataset.storageRowType === pending.type && row.dataset.storageRowId === pending.id);
    if (!target) return;
    target.classList.remove("storage-search-hit");
    void target.offsetWidth;
    target.classList.add("storage-search-hit");
    target.scrollIntoView?.({ block: "center", inline: "nearest", behavior: "smooth" });
    globalThis.setTimeout?.(() => target.classList.remove("storage-search-hit"), 2200);
  };
  if (globalThis.requestAnimationFrame) requestAnimationFrame(() => requestAnimationFrame(flash));
  else globalThis.setTimeout?.(flash, 0);
},

_onPeopleSubtab(event) {
  event.preventDefault();
  event.stopPropagation();
  this.activePeopleTab = "living";
  this.editingPersonId = null;
  this.expandedPersonId = null;
  this.activeTab = "people";
  this.requestRender();
},

_onSpecialSubtab(event) {
  event.preventDefault();
  event.stopPropagation();
  const tab = String(event.currentTarget?.dataset?.specialTab ?? "records");
  this.activeSpecialTab = ["records", "fleet", "cemetery", "defense"].includes(tab) ? tab : "records";
  this.editingPersonId = null;
  this.expandedPersonId = null;
  this.activeTab = "special";
  this.requestRender();
},

_onTabClick(event) {
  event.preventDefault();
  const tab = event.currentTarget?.dataset?.fblsTab;
  if (!tab) return;

  this.activeTab = tab;
  if (tab !== "people") {
    this.editingPersonId = null;
    this.expandedPersonId = null;
  }
  if (tab !== "buildings") this.expandedBuildingId = null;
  this.requestRender();
},

_onSelectHolding(event) {
  event.preventDefault();
  const holdingId = event.currentTarget?.value;
  if (!holdingId) return;

  this.activeHoldingId = holdingId;
  this.activeTab = "overview";
  this.editingPersonId = null;
  this.expandedPersonId = null;
  this.expandedBuildingId = null;
  this.activeBuildingCategory = "all";
  this.requestRender();
},

async _onFieldChange(event) {
  event.preventDefault();
  const field = event.currentTarget;
  const path = field.dataset.field;
  if (!path) return;
  if (!this._canPlayerWriteFieldPath(path)) return;

  let value = fieldValue(field);
  if (field instanceof HTMLTextAreaElement && this._sanitizeTextBlock) value = this._sanitizeTextBlock(value);
  if (path.endsWith(".belief")) value = normalizeBelief(value);

  try {
    if (/^catalog\.resources\.\d+\.[A-Za-z][A-Za-z0-9]*$/.test(path)) {
      if (!game.user?.isGM) return;
      await SkyholdData.transaction((data) => {
        foundry.utils.setProperty(data, path, value);
        return true;
      }, { reason: `resource-catalog:field:${path}` });
    } else if (/^holdings\.\d+\.storage\.resources\.\d+\.qty$/.test(path)) {
      if (!game.user?.isGM) return;
      const result = await SkyholdData.transaction((data) => {
        const scopedPath = this._resolveActiveHoldingScopedPath(data, path);
        if (!scopedPath) return SkyholdData.skipTransaction({ ok: false, message: "Активное владение изменилось; повтори правку." });
        const match = scopedPath.match(/^holdings\.(\d+)\.storage\.resources\.(\d+)\.qty$/);
        const holding = data.holdings?.[Number(match?.[1] ?? -1)];
        const rowIndex = Number(match?.[2] ?? -1);
        const row = holding?.storage?.resources?.[rowIndex];
        if (!holding || !row) return SkyholdData.skipTransaction({ ok: false, message: "Строка склада больше не существует." });
        const applied = setStorageRowTotalQuantity(holding, row, value, rowIndex);
        return applied.ok ? applied : SkyholdData.skipTransaction(applied);
      }, { reason: `storage:resource-quantity:${path}` });
      if (!result?.ok) {
        ui.notifications.warn(result?.message || "Количество не изменено.");
        this.requestRender();
        return;
      }
    } else if (/^holdings\.\d+\.gm\.defense\./.test(path) && this._sanitizeDefenseAssignments) {
      await SkyholdData.transaction((data) => {
        const scopedPath = this._resolveActiveHoldingScopedPath(data, path);
        if (!scopedPath) return SkyholdData.skipTransaction(false);
        const match = scopedPath.match(/^holdings\.(\d+)\./);
        const holding = data.holdings?.[Number(match?.[1] ?? -1)];
        if (holding) {
          const assignsResident = /\.gm\.defense\.(?:commanderId|squads\.\d+\.(?:sergeantId|memberIds\.\d+))$/.test(scopedPath);
          if (assignsResident && value) this._clearPersonFromAssignments?.(holding, String(value));
          foundry.utils.setProperty(data, scopedPath, value);
          this._sanitizeDefenseAssignments(holding);
          this._applyDefenseSalaries?.(holding);
        } else foundry.utils.setProperty(data, scopedPath, value);
      }, { reason: `field:${path}` });
    } else if (/^holdings\.\d+\.people\.list\.\d+\.salaryModifier$/.test(path) && this._applyPersonSalaryForAssignment) {
      await SkyholdData.transaction((data) => {
        const scopedPath = this._resolveActiveHoldingScopedPath(data, path);
        if (!scopedPath) return SkyholdData.skipTransaction(false);
        foundry.utils.setProperty(data, scopedPath, value);
        const match = scopedPath.match(/^holdings\.(\d+)\.people\.list\.(\d+)\.salaryModifier$/);
        const holding = data.holdings?.[Number(match?.[1] ?? -1)];
        const person = holding?.people?.list?.[Number(match?.[2] ?? -1)];
        const building = (holding?.buildings?.list ?? []).find((item) => String(item.id) === String(person?.workAssignment));
        if (holding && person) this._applyPersonSalaryForAssignment(holding, person, building ?? null);
      }, { reason: `field:${path}` });
    } else {
      const updated = await this._updateActiveHoldingPath(path, value, { reason: `field:${path}` });
      if (!updated) return;
    }
    // change-события приходят после завершения редактирования, поэтому безопасно
    // перерисовывать окно и сразу обновлять расчетные сводки, вкладки и бейджи.
    this.requestRender();
  } catch (error) {
    console.error("FBL Skyhold | Failed to update field", error);
    ui.notifications.error(path.startsWith("catalog.resources.") ? "Не удалось сохранить ресурс каталога. Подробности в консоли." : "Не удалось сохранить поле владения. Подробности в консоли.");
  }
},

async _confirmAction(title, content) {
  try {
    return await foundryDialogV2().confirm({
      window: { title },
      content: `<p>${content}</p>`,
      modal: true
    });
  } catch (error) {
    console.warn("FBL Skyhold | Dialog confirmation failed, falling back to browser confirm", error);
  }

  return window.confirm(String(content).replace(/<[^>]*>/g, ""));
},

async _onPickFile(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!game.user?.isGM) return;
  const button = event.currentTarget;
  const target = String(button?.dataset?.filePickerTarget ?? "");
  const pickerType = String(button?.dataset?.filePickerType ?? "audio") || "audio";
  let field = null;
  if (target) {
    field = Array.from(this.element?.querySelectorAll?.("[data-field]") ?? []).find((input) => String(input.dataset.field ?? "") === target) ?? null;
  }
  field ||= button?.closest?.(".fbls-file-picker-row")?.querySelector?.("[data-field]");
  if (!field) return;
  const openPicker = (path = "") => {
    renderFoundryFilePicker({
      type: pickerType,
      current: path || "",
      callback: (picked) => {
        field.value = String(picked ?? "");
        field.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
  };
  openPicker(String(field.value ?? ""));
},

async _promptText({ title = "Ввод", label = "Значение", value = "" } = {}) {
  const safeTitle = escapeHtml(title);
  const safeLabel = escapeHtml(label);
  const safeValue = escapeHtml(value);
  try {
      return await foundryDialogV2().prompt({
        window: { title: safeTitle },
        content: `<form class="fbls-prompt-form"><label><span>${safeLabel}</span><input type="text" name="value" value="${safeValue}" autofocus /></label></form>`,
        ok: {
          label: "Сохранить",
          callback: (event, button) => {
            const form = button?.form ?? event?.target?.closest?.("form") ?? document.querySelector(".fbls-prompt-form");
            return String(form?.elements?.value?.value ?? value);
          }
        },
        rejectClose: false
      });
  } catch (error) {
    console.warn("FBL Skyhold | DialogV2 prompt failed, falling back to window.prompt", error);
  }
  return globalThis.window?.prompt?.(title, value);
},

async _onEditHoldingName(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!game.user?.isGM) return;
  const data = SkyholdData.get();
  const { holding } = findReadableHoldingEntry(data, this.activeHoldingId, { fallback: false });
  if (!holding) return;
  const current = String(holding.name ?? "");
  const raw = await this._promptText({ title: "Название владения", label: "Название", value: current });
  if (raw === null || raw === undefined) return;
  const next = String(raw).trim();
  if (!next || next === current || next.toLowerCase() === "ok") return;
  await SkyholdData.updateHolding(holding.id, (freshHolding) => {
    freshHolding.name = next;
  }, { reason: "holding:rename" });
  this.requestRender();
},

async _onToggleHoldingVisibility(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!game.user?.isGM) return;
  const data = SkyholdData.get();
  const { holding } = findReadableHoldingEntry(data, this.activeHoldingId, { fallback: false });
  if (!holding) return;
  await SkyholdData.updateHolding(holding.id, (freshHolding) => {
    freshHolding.visibility = freshHolding.visibility === "gm" ? "public" : "gm";
  }, { reason: "holding:toggle-visibility" });
  this.requestRender();
},

async _onCreateHolding(event) {
  event.preventDefault();
  if (!game.user?.isGM) return;

  try {
    const holding = createHolding({ name: "Новое владение" });
    await SkyholdData.addHolding(holding);
    this.activeHoldingId = holding.id;
    this.activeTab = "overview";
    this.requestRender();
  } catch (error) {
    console.error("FBL Skyhold | Failed to create holding", error);
    ui.notifications.error("Не удалось создать владение. Подробности в консоли.");
  }
},

async _onDeleteHolding(event) {
  event.preventDefault();
  if (!game.user?.isGM) return;

  const data = SkyholdData.get();
  const holding = data.holdings.find((item) => item.id === this.activeHoldingId);
  if (!holding) return;

  if (data.holdings.length <= 1) {
    ui.notifications.warn("Нельзя удалить последнее владение.");
    return;
  }

  const confirmed = await this._confirmAction("Удалить владение", `Удалить владение «${escapeHtml(holding.name)}»? Это нельзя отменить.`);
  if (!confirmed) return;

  try {
    await SkyholdData.deleteHolding(holding.id);
    this.activeHoldingId = null;
    this.activeTab = "overview";
    this.requestRender();
  } catch (error) {
    console.error("FBL Skyhold | Failed to delete holding", error);
    ui.notifications.error("Не удалось удалить владение. Подробности в консоли.");
  }
}
};
