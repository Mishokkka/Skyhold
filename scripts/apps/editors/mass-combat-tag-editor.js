import { MODULE_ID } from "../../data/constants.js";
import {
  addMassCombatCustomTag,
  prepareMassCombatTagEditorContext,
  resetMassCombatTagConfig,
  saveMassCombatTagConfigFromForm
} from "../mass-combat/tag-config.js";
import { dispatchDelegatedAction } from "../common/delegated-events.js";
import { RenderSchedulerMixin } from "../common/render-scheduler.js";
import { bindGlobalInputGuard, bindInputGuards, unbindGlobalInputGuard } from "../../utils/input-guards.js";
import { createSafeIcon } from "../../core/helpers.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class SkyholdMassCombatTagEditor extends RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    return {
      ...context,
      canEdit: Boolean(game.user?.isGM),
      editor: prepareMassCombatTagEditorContext()
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    this._bindInputGuards(root);
    this._bindGlobalInputGuard(root);
    this._bindDelegatedEvents(root);
  }

  _bindDelegatedEvents(root) {
    this._delegatedAbortController?.abort?.();
    const controller = new AbortController();
    this._delegatedAbortController = controller;
    const actions = {
      "save-mass-tags": "_onSave",
      "add-mass-tag": "_onAddTag",
      "reset-mass-tags": "_onReset",
      "open-mass-tag-icon-picker": "_onOpenIconPicker",
      "close-mass-tag-icon-picker": "_onCloseIconPicker",
      "select-mass-tag-icon": "_onSelectIcon",
      "apply-mass-tag-icon": "_onApplyIcon"
    };
    root.addEventListener("click", (event) => {
      const element = event.target?.closest?.("[data-action]");
      if (!element || !root.contains(element)) return;
      dispatchDelegatedAction(this, event, element, actions[String(element.dataset.action ?? "")]);
    }, { signal: controller.signal });
    root.addEventListener("input", (event) => {
      const search = event.target?.closest?.("[data-mass-icon-search]");
      if (search && root.contains(search)) {
        this._filterIconPicker(search.value);
        return;
      }
      const iconField = event.target?.closest?.("[data-tag-field='icon']");
      if (!iconField || !root.contains(iconField)) return;
      this._refreshTagIconPreview(iconField.closest("[data-tag-key]"), iconField.value);
      const picker = root.querySelector("[data-mass-icon-picker]");
      if (!picker?.hidden && picker.dataset.tagKey === iconField.closest("[data-tag-key]")?.dataset.tagKey) {
        this._refreshPickerPreview(iconField.value);
      }
    }, { signal: controller.signal });
  }

  _bindInputGuards(root) {
    bindInputGuards(root);
  }

  _bindGlobalInputGuard(root) {
    bindGlobalInputGuard(this, root);
  }

  _unbindGlobalInputGuard() {
    unbindGlobalInputGuard(this);
  }

  async _onClose(options) {
    await super._onClose(options);
    this._delegatedAbortController?.abort?.();
    this._delegatedAbortController = null;
    this._unbindGlobalInputGuard();
  }

  async _onSave(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    try {
      this._applyPendingIcon({ close: false });
      await saveMassCombatTagConfigFromForm(this.element);
      ui.notifications?.info?.("Матрица контров сохранена.");
      this.requestRender();
    } catch (error) {
      console.error("FBL Skyhold | Failed to save mass combat tag config", error);
      ui.notifications?.error?.("Не удалось сохранить матрицу контров. Подробности в консоли.");
    }
  }

  async _onAddTag(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    await addMassCombatCustomTag();
    this.requestRender();
  }

  _onOpenIconPicker(event) {
    event.preventDefault();
    event.stopPropagation();
    const row = event.currentTarget?.closest?.("[data-tag-key]");
    const picker = this.element?.querySelector?.("[data-mass-icon-picker]");
    const iconField = row?.querySelector?.("[data-tag-field='icon']");
    if (!row || !picker || !iconField) return;
    picker.dataset.tagKey = String(row.dataset.tagKey ?? "");
    picker.dataset.pendingIcon = String(iconField.value ?? "").trim();
    picker.hidden = false;
    this._filterIconPicker("");
    const search = picker.querySelector("[data-mass-icon-search]");
    if (search) search.value = "";
    this._refreshPickerPreview(iconField.value);
    picker.scrollIntoView?.({ block: "nearest" });
    search?.focus?.();
  }

  _onCloseIconPicker(event) {
    event.preventDefault();
    event.stopPropagation();
    this._closeIconPicker();
  }

  _onSelectIcon(event) {
    event.preventDefault();
    event.stopPropagation();
    const picker = this.element?.querySelector?.("[data-mass-icon-picker]");
    const iconClass = String(event.currentTarget?.dataset?.iconClass ?? "").trim();
    if (!picker || !iconClass) return;
    picker.dataset.pendingIcon = iconClass;
    this._refreshPickerPreview(iconClass);
  }

  _onApplyIcon(event) {
    event.preventDefault();
    event.stopPropagation();
    this._applyPendingIcon({ close: true });
  }

  _applyPendingIcon({ close = true } = {}) {
    const picker = this.element?.querySelector?.("[data-mass-icon-picker]");
    const tagKey = String(picker?.dataset?.tagKey ?? "");
    const iconClass = String(picker?.dataset?.pendingIcon ?? "").trim();
    if (!picker || !tagKey || !iconClass) return false;
    const row = Array.from(this.element?.querySelectorAll?.(".fbls-mass-tag-table tbody tr[data-tag-key]") ?? [])
      .find((item) => String(item.dataset.tagKey ?? "") === tagKey);
    const iconField = row?.querySelector?.("[data-tag-field='icon']");
    if (!iconField) return false;
    iconField.value = iconClass;
    iconField.setAttribute("value", iconClass);
    row.dataset.draftIcon = iconClass;
    this._refreshTagIconPreview(row, iconClass);
    if (close) {
      this._closeIconPicker();
      iconField.focus?.();
    }
    return true;
  }

  _closeIconPicker() {
    const picker = this.element?.querySelector?.("[data-mass-icon-picker]");
    if (!picker) return;
    picker.hidden = true;
    picker.dataset.tagKey = "";
    picker.dataset.pendingIcon = "";
  }

  _filterIconPicker(query = "") {
    const needle = String(query ?? "").trim().toLowerCase();
    this.element?.querySelectorAll?.("[data-icon-search]").forEach((button) => {
      button.hidden = Boolean(needle && !String(button.dataset.iconSearch ?? "").includes(needle));
    });
  }

  _refreshTagIconPreview(row, iconClass = "") {
    const preview = row?.querySelector?.("[data-icon-preview]");
    if (!preview) return;
    preview.replaceChildren(createSafeIcon(iconClass));
  }

  _refreshPickerPreview(iconClass = "") {
    const picker = this.element?.querySelector?.("[data-mass-icon-picker]");
    const preview = picker?.querySelector?.("[data-mass-icon-picker-preview]");
    const value = picker?.querySelector?.("[data-mass-icon-picker-value]");
    if (preview) preview.replaceChildren(createSafeIcon(iconClass));
    if (value) value.textContent = String(iconClass ?? "").trim() || "fa-solid fa-circle";
    picker?.querySelectorAll?.("[data-icon-class]").forEach((button) => {
      button.classList.toggle("selected", String(button.dataset.iconClass ?? "") === String(iconClass ?? "").trim());
    });
  }

  async _onReset(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    const confirmed = await this._confirmReset();
    if (!confirmed) return;
    await resetMassCombatTagConfig();
    ui.notifications?.info?.("Матрица контров сброшена к дефолту.");
    this.requestRender();
  }

  async _confirmReset() {
    const content = "<p>Сбросить теги и контры боя к дефолтной матрице модуля?</p>";
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (DialogV2?.confirm) {
      try {
        return await DialogV2.confirm({
          window: { title: "Сбросить матрицу контров" },
          content,
          modal: true
        });
      } catch (_error) {
        return false;
      }
    }
    return Boolean(globalThis.window?.confirm?.("Сбросить теги и контры боя к дефолту?"));
  }
}

SkyholdMassCombatTagEditor.DEFAULT_OPTIONS = {
  classes: ["fbl-skyhold", "fbl-skyhold-mass-tag-editor"],
  tag: "section",
  window: {
    title: "Теги и контры боя",
    icon: "fa-solid fa-circle-nodes",
    resizable: true
  },
  position: {
    width: 1060,
    height: 720
  }
};

SkyholdMassCombatTagEditor.PARTS = {
  body: {
    template: `modules/${MODULE_ID}/templates/mass-combat-tag-editor.hbs`
  }
};
