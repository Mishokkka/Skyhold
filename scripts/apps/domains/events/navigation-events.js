// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { createHolding, SkyholdData } from "../../../data/store.js";
import { findReadableHoldingEntry } from "../../../data/access-guard.js";
import { generateResidents } from "../../../generators/resident-generator.js";
import { ageGroupFromAge, normalizeBelief } from "../../../generators/resident-rules.js";
import { SkyholdBuildingEditor, SkyholdCrewEditor } from "../../editors.js";
import { SkyholdMassCombatApp } from "../../mass-combat.js";
import { escapeHtml, fieldValue, joinList, rollD66, rollD6Pool, splitList } from "../../../core/helpers.js";
import { GM_ROLLS, gmRollEntry } from "../../../data/gm-rolls.js";
import { addCalendariaQd, formatCalendariaDateTime, getCalendariaSnapshot, parseCalendariaDateInput, timestampForCalendariaDate } from "../../../integrations/calendaria-bridge.js";

export const NavigationEventDomain = {
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
  const { holding } = findReadableHoldingEntry(data, this.activeHoldingId, { fallback: true });
  if (!holding || !stat) return;
  if (stat === "defense") {
    new SkyholdMassCombatApp({ holdingId: holding.id }).render({ force: true, focus: true });
    return;
  }

  const label = "Репутация";
  const value = Math.max(0, this._safeNumber(this._reputationSummary(holding).total, 0));
  if (!value) { ui.notifications.warn(`${label}: 0к6.`); return; }
  const rolls = rollD6Pool(value);
  const successes = rolls.filter((roll) => roll >= 6).length;
  const diceText = rolls.map((roll) => roll >= 6 ? `<strong>${roll}</strong>` : String(roll)).join(", ");
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ alias: holding.name || "Владение" }),
    content: `<div class="fbls-chat-card"><h3>${label}: ${value}к6</h3><p><strong>Кости:</strong> ${diceText}</p><p><strong>Успехи:</strong> ${successes}</p></div>`
  });
},


async _onShowMoraleHelp(event) {
  event.preventDefault();
  event.stopPropagation();
  const rows = [
    this._moraleState(-31),
    this._moraleState(-20),
    this._moraleState(-5),
    this._moraleState(5),
    this._moraleState(20),
    this._moraleState(31)
  ];
  const content = `<div class="fbls-dialog-text"><table class="fbls-table compact"><thead><tr><th>Уровень</th><th>Диапазон</th><th>Эффект</th></tr></thead><tbody>${rows.map((row) => `<tr><td><strong>${escapeHtml(row.label)}</strong></td><td>${escapeHtml(row.range)}</td><td>${escapeHtml(row.notes)}</td></tr>`).join("")}</tbody></table></div>`;
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (DialogV2?.wait) {
    await DialogV2.wait({ window: { title: "Довольство: уровни" }, content, buttons: [{ action: "ok", label: "Закрыть", default: true }] });
    return;
  }
  new Dialog({ title: "Довольство: уровни", content, buttons: { ok: { label: "Закрыть" } } }).render(true);
},

_onBuildingCategory(event) {
  event.preventDefault();
  const category = event.currentTarget?.dataset?.category || "all";
  this.activeBuildingCategory = category;
  this.render({ force: true, focus: false });
},

_onStorageSubtab(event) {
  event.preventDefault();
  const tab = event.currentTarget?.dataset?.storageTab || "resources";
  this.activeStorageTab = ["resources", "items", "accounting", "log"].includes(tab) ? tab : "resources";
  this.render({ force: true, focus: false });
},

_onToggleStorageTool(event) {
  event.preventDefault();
  event.stopPropagation();
  const tool = String(event.currentTarget?.dataset?.storageTool ?? "");
  if (!["adjust", "move"].includes(tool)) return;
  if (!this.storageToolState || typeof this.storageToolState !== "object") this.storageToolState = { adjust: false, move: false };
  this.storageToolState[tool] = !this.storageToolState[tool];
  this.activeTab = "storage";
  this.activeStorageTab = "resources";
  this.render({ force: true, focus: false });
},

_onStorageRoomTab(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!["resources", "items"].includes(this.activeStorageTab)) this.activeStorageTab = "resources";
  this.activeStorageRoomId = this._normalizeStorageRoomId(event.currentTarget?.dataset?.roomId || "outdoors");
  this.render({ force: true, focus: false });
},

_onPeopleSubtab(event) {
  event.preventDefault();
  event.stopPropagation();
  this.activePeopleTab = "living";
  this.editingPersonId = null;
  this.expandedPersonId = null;
  this.activeTab = "people";
  this.render({ force: true, focus: false });
},

_onSpecialSubtab(event) {
  event.preventDefault();
  event.stopPropagation();
  const tab = String(event.currentTarget?.dataset?.specialTab ?? "records");
  this.activeSpecialTab = ["records", "cemetery", "defense"].includes(tab) ? tab : "records";
  this.editingPersonId = null;
  this.expandedPersonId = null;
  this.activeTab = "special";
  this.render({ force: true, focus: false });
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
  this.render({ force: true, focus: false });
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
  this.render({ force: true, focus: false });
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
    if (/^holdings\.\d+\.gm\.defense\./.test(path) && this._sanitizeDefenseAssignments) {
      const data = SkyholdData.get();
      foundry.utils.setProperty(data, path, value);
      const match = path.match(/^holdings\.(\d+)\./);
      const holding = data.holdings?.[Number(match?.[1] ?? -1)];
      if (holding) {
        this._sanitizeDefenseAssignments(holding);
        this._applyDefenseSalaries?.(holding);
      }
      await SkyholdData.set(data);
    } else if (/^holdings\.\d+\.people\.list\.\d+\.salaryModifier$/.test(path) && this._applyPersonSalaryForAssignment) {
      const data = SkyholdData.get();
      foundry.utils.setProperty(data, path, value);
      const match = path.match(/^holdings\.(\d+)\.people\.list\.(\d+)\.salaryModifier$/);
      const holding = data.holdings?.[Number(match?.[1] ?? -1)];
      const person = holding?.people?.list?.[Number(match?.[2] ?? -1)];
      const building = (holding?.buildings?.list ?? []).find((item) => String(item.id) === String(person?.workAssignment));
      if (holding && person) this._applyPersonSalaryForAssignment(holding, person, building ?? null);
      await SkyholdData.set(data);
    } else {
      await SkyholdData.update(path, value);
    }
    // change-события приходят после завершения редактирования, поэтому безопасно
    // перерисовывать окно и сразу обновлять расчетные сводки, вкладки и бейджи.
    this.render({ force: true, focus: false });
  } catch (error) {
    console.error("FBL Skyhold | Failed to update field", error);
    ui.notifications.error("Не удалось сохранить поле владения. Подробности в консоли.");
  }
},

async _confirmAction(title, content) {
  try {
    if (globalThis.Dialog?.confirm) {
      return await globalThis.Dialog.confirm({
        title,
        content: `<p>${content}</p>`,
        yes: () => true,
        no: () => false,
        defaultYes: false
      });
    }

    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (DialogV2?.confirm) {
      return await DialogV2.confirm({
        window: { title },
        content: `<p>${content}</p>`,
        modal: true
      });
    }
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
    const Picker = globalThis.FilePicker ?? foundry?.applications?.apps?.FilePicker;
    if (!Picker) {
      ui.notifications.warn("FilePicker Foundry не найден.");
      return;
    }
    new Picker({
      type: pickerType,
      current: path || "",
      callback: (picked) => {
        field.value = String(picked ?? "");
        field.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }).render(true);
  };
  openPicker(String(field.value ?? ""));
},

async _promptText({ title = "Ввод", label = "Значение", value = "" } = {}) {
  const safeTitle = escapeHtml(title);
  const safeLabel = escapeHtml(label);
  const safeValue = escapeHtml(value);
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (DialogV2?.prompt) {
    try {
      return await DialogV2.prompt({
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
  }
  return globalThis.window?.prompt?.(title, value);
},

async _onEditHoldingName(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!game.user?.isGM) return;
  const data = SkyholdData.get();
  const { holding } = findReadableHoldingEntry(data, this.activeHoldingId, { fallback: true });
  if (!holding) return;
  const current = String(holding.name ?? "");
  const raw = await this._promptText({ title: "Название владения", label: "Название", value: current });
  if (raw === null || raw === undefined) return;
  const next = String(raw).trim();
  if (!next || next === current || next.toLowerCase() === "ok") return;
  holding.name = next;
  await SkyholdData.set(data);
  this.render({ force: true, focus: false });
},

async _onToggleHoldingVisibility(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!game.user?.isGM) return;
  const data = SkyholdData.get();
  const { holding } = findReadableHoldingEntry(data, this.activeHoldingId, { fallback: true });
  if (!holding) return;
  holding.visibility = holding.visibility === "gm" ? "public" : "gm";
  await SkyholdData.set(data);
  this.render({ force: true, focus: false });
},

async _onCreateHolding(event) {
  event.preventDefault();
  if (!game.user?.isGM) return;

  try {
    const holding = createHolding({ name: "Новое владение" });
    await SkyholdData.addHolding(holding);
    this.activeHoldingId = holding.id;
    this.activeTab = "overview";
    this.render({ force: true, focus: false });
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
    this.render({ force: true, focus: false });
  } catch (error) {
    console.error("FBL Skyhold | Failed to delete holding", error);
    ui.notifications.error("Не удалось удалить владение. Подробности в консоли.");
  }
}
};
