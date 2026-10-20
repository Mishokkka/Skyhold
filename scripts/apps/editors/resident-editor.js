import { MODULE_ID } from "../../data/constants.js";
import { DisclosureState } from "../common/disclosure-state.js";
import { SkyholdData } from "../../data/store.js";
import { SaveStatus, syncSaveStatus } from "../common/save-status.js";
import { findReadableHoldingEntry } from "../../data/access-guard.js";
import { holdingPermissionContext } from "../../data/holding-permissions.js";
import { bindGlobalInputGuard, bindInputGuards, unbindGlobalInputGuard } from "../../utils/input-guards.js";
import { getSkyholdManager, requestSkyholdAppRender } from "../registry.js";
import { bindFloatingTooltips, hideFloatingTooltip } from "../common/floating-tooltip.js";
import { WindowFrameMixin } from "../common/window-frame.js";
import { focusApplicationContent, restoreApplicationFocus } from "../common/window-focus-keeper.js";
import { RenderSchedulerMixin } from "../common/render-scheduler.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class SkyholdResidentEditor extends WindowFrameMixin(RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2))) {
  static instances = new Set();

  static open({ holdingId = "", personId = "" } = {}) {
    const existing = [...this.instances].find((app) => app.holdingId === holdingId && app.personId === personId);
    if (existing) {
      existing.render({ force: true, focus: true });
      return existing;
    }
    const app = new this({ holdingId, personId }, {
      position: {
        width: 1260,
        height: "auto"
      }
    });
    app.render({ force: true, focus: true }).then(() => {
      const root = app.element;
      if (!root) return;
      app.setPosition({ width: 1260, height: "auto" });
      app._bindWindowFrameSync(root);
    });
    return app;
  }

  static rerenderOpen({ skipFocused = true } = {}) {
    for (const app of this.instances) {
      const root = app.element;
      if (skipFocused && root && document.activeElement instanceof Element && root.contains(document.activeElement)) continue;
      app.requestRender?.({ focus: false });
    }
  }

  constructor({ holdingId = "", personId = "" } = {}, options = {}) {
    super(options);
    this.holdingId = String(holdingId ?? "");
    this.personId = String(personId ?? "");
    this._skipCloseSave = false;
    this._saveStatus = new SaveStatus({ onChange: () => syncSaveStatus(this.element, this._saveStatus) });
    SkyholdResidentEditor.instances.add(this);
  }

  _manager({ warn = false } = {}) {
    const manager = getSkyholdManager();
    if (!manager && warn) ui.notifications?.warn?.("Открой менеджер поселения, чтобы редактировать жителя.");
    if (manager && String(manager.activeHoldingId ?? "") !== this.holdingId) {
      if (warn) ui.notifications?.warn?.("Редактор относится к другому владению. Вернись к нему в менеджере и открой жителя снова.");
      return null;
    }
    return manager;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const data = SkyholdData.get();
    const { holding, index: holdingIndex } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
    const manager = this._manager();
    const person = (holding?.people?.list ?? []).find((row) => String(row?.id ?? "") === this.personId);
    const canEdit = Boolean(person && manager && holdingPermissionContext(holding).canEditResidents);
    let prepared = null;
    if (canEdit) {
      const workOptionsContext = manager._residentWorkOptionsContext(holding);
      prepared = manager._preparePersonRows(holding, true, person.dead ? "cemetery" : "living", false, {
        workOptionsContext,
        editorPersonId: this.personId
      }).find((row) => String(row?.id ?? "") === this.personId) ?? null;
    }
    return {
      ...context,
      holdingIndex,
      holdingName: holding?.name || "Владение",
      person: prepared,
      hasPerson: Boolean(person),
      canEdit,
      isGM: Boolean(game.user?.isGM),
      saveStatus: this._saveStatus.context,
      error: !holding
        ? "Владение недоступно."
        : !person
          ? "Житель больше не найден."
          : !manager
            ? "Открой менеджер поселения и выбери нужное владение."
            : !canEdit
              ? "Нет права редактировать жителей этого владения."
              : ""
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    // ApplicationV2 applies its initial position after _onRender. The first
    // frame is therefore bound by open() only after render() fully resolves;
    // otherwise an intrinsic narrow frame can overwrite the requested width.
    if (!options?.isFirstRender) this._bindWindowFrameSync(root);
    bindInputGuards(root);
    bindGlobalInputGuard(this, root);
    bindFloatingTooltips(this, root);
    syncSaveStatus(root, this._saveStatus);
    this._selectionDisclosures ??= new DisclosureState();
    this._selectionDisclosures.bind(root);
    this._bindEditorEvents(root);
    focusApplicationContent(this, { root, options, preferredSelector: ".person-name input" });
  }

  _bindEditorEvents(root) {
    this._residentEditorAbortController?.abort?.();
    const controller = new AbortController();
    this._residentEditorAbortController = controller;
    const listener = { signal: controller.signal };
    root.addEventListener("input", (event) => {
      if (event.target?.matches?.("[data-field], [data-work-assignment-field], [data-work-allocation-target]")) this._saveStatus.markDirty();
    }, listener);

    root.querySelectorAll("[data-field]").forEach((field) => field.addEventListener("change", async (event) => {
      await this._saveDraft(event.currentTarget);
      if (String(field.dataset.field ?? "").endsWith(".workAllocationMode")) this.requestRender({ focus: false });
    }, listener));
    root.querySelectorAll("[data-work-allocation-target]").forEach((field) => field.addEventListener("change", async (event) => {
      if (await this._saveDraft(event.currentTarget)) this.requestRender({ focus: false });
    }, listener));

    root.querySelectorAll("[data-work-assignment-field]").forEach((field) => field.addEventListener("change", async (event) => {
      const manager = this._manager({ warn: true });
      if (!manager) return;
      await this._saveStatus.track(() => manager._onPersonEditorWorkAssignmentChange(event));
      this.requestRender({ focus: false });
    }, listener));

    root.querySelectorAll("[data-trait-add-field]").forEach((field) => field.addEventListener("change", async (event) => {
      const manager = this._manager({ warn: true });
      if (!manager) return;
      await manager._onTraitAddChange(event);
      bindFloatingTooltips(this, root);
      await this._saveDraft(field);
    }, listener));

    root.querySelectorAll("[data-action='remove-trait']").forEach((button) => button.addEventListener("click", async (event) => {
      const manager = this._manager({ warn: true });
      if (!manager) return;
      await manager._onRemoveTrait(event);
      bindFloatingTooltips(this, root);
      await this._saveDraft(button);
    }, listener));

    for (const [action, method] of [["add-work-allocation", "_onAddWorkAllocation"], ["remove-work-allocation", "_onRemoveWorkAllocation"]]) {
      root.querySelectorAll(`[data-action='${action}']`).forEach((button) => button.addEventListener("click", async (event) => {
        const manager = this._manager({ warn: true });
        if (!manager) return;
        await this._saveStatus.track(() => manager[method](event));
        this.requestRender({ focus: false });
      }, listener));
    }

    root.querySelectorAll("[data-action='close-person-editor']").forEach((button) => button.addEventListener("click", async (event) => {
      event.preventDefault();
      if (!await this._saveDraft(button)) return;
      this._skipCloseSave = true;
      await this.close();
    }, listener));
  }

  async _saveDraft(element = this.element) {
    const manager = this._manager({ warn: true });
    try {
      return await this._saveStatus.track(() => manager
        ? manager._savePersonEditorDraft({ currentTarget: element?.querySelector?.(".fbls-person-editor.v2") ?? element })
        : false);
    } catch (error) {
      console.error("FBL Skyhold | Failed to save resident editor", error);
      ui.notifications?.error?.("Не удалось сохранить жителя. Подробности в консоли.");
      return false;
    }
  }

  async _preClose(options) {
    await super._preClose(options);
    if (!this._skipCloseSave && this.element?.querySelector?.(".fbls-person-editor.v2") && !await this._saveDraft(this.element)) {
      throw Object.assign(new Error("Черновик жителя не сохранён; редактор остаётся открытым."), { code: "resident-draft-unsaved" });
    }
  }

  async close(options = {}) {
    try { return await super.close(options); }
    catch (error) {
      if (error.code !== "resident-draft-unsaved") throw error;
      return this;
    }
  }

  async _onClose(options) {
    this._selectionDisclosures?.close();
    await super._onClose(options);
    SkyholdResidentEditor.instances.delete(this);
    this._residentEditorAbortController?.abort?.();
    hideFloatingTooltip(this);
    unbindGlobalInputGuard(this);
    this._unbindWindowFrameSync();
    const manager = getSkyholdManager();
    const render = requestSkyholdAppRender({ deferForActiveWindow: false });
    if (render?.then) await render;
    restoreApplicationFocus(this, { root: manager?.element });
  }
}

SkyholdResidentEditor.DEFAULT_OPTIONS = {
  classes: ["fbl-skyhold", "fbl-skyhold-resident-editor"],
  tag: "section",
  window: {
    title: "Житель",
    icon: "fa-solid fa-user-pen",
    resizable: true
  },
  position: {
    width: 1260,
    height: "auto"
  }
};

SkyholdResidentEditor.PARTS = {
  body: { template: `modules/${MODULE_ID}/templates/resident-editor.hbs` }
};
