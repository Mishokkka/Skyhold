import { MODULE_ID } from "../../../data/constants.js";
import { bindGlobalInputGuard, bindInputGuards, unbindGlobalInputGuard } from "../../../utils/input-guards.js";
import { dispatchDelegatedAction } from "../../common/delegated-events.js";
import { RenderSchedulerMixin } from "../../common/render-scheduler.js";
import { buildRequirementFromEditor, dependencyKindFromTarget, normalizeDependency } from "./form.js";
import { SkyholdResourceCatalogEditor } from "../resource-catalog-editor.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class SkyholdRandomEventRowEditor extends RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  constructor({ owner = null, holdingId = "", tableKind = "general", rowId = "" } = {}, options = {}) {
    super(options);
    this.owner = owner;
    this.holdingId = String(holdingId ?? "");
    this.tableKind = ["general", "external"].includes(String(tableKind ?? "")) ? String(tableKind) : "general";
    this.rowId = String(rowId ?? "");
    this._lastPosition = null;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const prepared = this.owner?._prepareRowEditorContext?.(this.tableKind, this.rowId) ?? {};
    const row = prepared.rowContext ?? null;
    return {
      ...context,
      hasRow: Boolean(row),
      holdingId: this.holdingId,
      tableKind: this.tableKind,
      rowId: this.rowId,
      tableTitle: prepared.tableContext?.title ?? "Событие",
      currentTable: prepared.tableContext,
      row
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    this._restorePosition();
    bindInputGuards(root);
    bindGlobalInputGuard(this, root);
    this._bindEvents(root);
    this.owner?._syncRequirementEditors?.(root);
    this.owner?._autoGrowTextareas?.(root);
  }

  _bindEvents(root) {
    this._delegatedAbortController?.abort?.();
    const controller = new AbortController();
    this._delegatedAbortController = controller;
    const actions = {
      "event-row-editor-save": "_onSave",
      "event-editor-add-requirement": "_onAddRequirement",
      "event-editor-delete-requirement": "_onDeleteRequirement",
      "event-editor-add-effect": "_onAddEffect",
      "event-editor-delete-effect": "_onDeleteEffect",
      "event-editor-pick-resource": "_onPickEffectResource"
    };

    root.addEventListener("click", (event) => {
      const element = event.target?.closest?.("[data-action]");
      if (!element || !root.contains(element)) return;
      dispatchDelegatedAction(this, event, element, actions[String(element.dataset.action ?? "")]);
    }, { signal: controller.signal });

    root.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const effectField = target.closest?.("[data-event-effect-field]");
      if (effectField && root.contains(effectField)) {
        this._onEffectFieldChange(event, effectField);
        return;
      }
      const requirementField = target.closest?.("[data-event-requirement-field]");
      if (requirementField && root.contains(requirementField)) {
        this._onRequirementFieldChange(event, requirementField);
        return;
      }
      const requirementLogic = target.closest?.("[data-event-requirement-logic]");
      if (requirementLogic && root.contains(requirementLogic)) {
        this._onRequirementLogicChange(event, requirementLogic);
        return;
      }
      const addType = target.closest?.("[data-event-requirement-type]");
      if (addType && root.contains(addType)) this.owner?._syncRequirementEditors?.(root);
      const field = target.closest?.("[data-event-field]");
      if (field && root.contains(field)) this._onEventFieldChange(event, field);
    }, { signal: controller.signal });

    root.addEventListener("input", (event) => {
      const target = event.target;
      const autogrow = target?.closest?.("[data-event-autogrow]");
      if (autogrow && root.contains(autogrow)) this.owner?._autoGrowTextarea?.(autogrow);
      const field = target?.closest?.("[data-event-field]");
      if (field && root.contains(field)) this._onEventFieldInput(event, field);
    }, { signal: controller.signal });
  }

  _capturePosition() {
    const position = this.position ?? null;
    if (!position) return;
    const saved = {};
    for (const key of ["left", "top", "width", "height"]) {
      const value = Number(position[key]);
      if (Number.isFinite(value)) saved[key] = value;
    }
    if (Object.keys(saved).length) this._lastPosition = saved;
  }

  _restorePosition() {
    if (!this._lastPosition || typeof this.setPosition !== "function") return;
    try {
      this.setPosition(this._lastPosition);
    } catch (_error) {
      // Foundry may reject position changes during teardown; safe to ignore.
    }
  }

  _requestRenderPreservingPosition(options = {}) {
    this._capturePosition();
    this.requestRender({ focus: false, ...options });
  }

  _commitVisibleInputsToDraft(root = this.element) {
    this.owner?._commitVisibleInputsToDraft?.(root);
  }

  _onEventFieldChange(event, target) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    this.owner?._setEventFieldFromTarget?.(target, { final: true });
  }

  _onEventFieldInput(_event, target) {
    if (!game.user?.isGM) return;
    this.owner?._setEventFieldFromTarget?.(target);
  }

  _onRequirementLogicChange(event, target) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    const changed = this.owner?._setRequirementLogicFromTarget?.(target);
    if (changed) this._requestRenderPreservingPosition();
  }

  _onRequirementFieldChange(event, target) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    const field = String(target.dataset.eventRequirementField ?? "");
    const changed = this.owner?._setRequirementFieldFromTarget?.(target);
    if (!changed) return;
    if (field !== "type") this.owner?._syncRequirementEditors?.(target.closest?.("[data-event-requirement-controls]") ?? this.element);
    this._requestRenderPreservingPosition();
  }

  _onEffectFieldChange(event, target) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    const changed = this.owner?._setEffectFieldFromTarget?.(target);
    if (changed && String(target.dataset.eventEffectField ?? "") === "type") this._requestRenderPreservingPosition();
  }

  async _onSave(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    this._commitVisibleInputsToDraft();
    const saved = await this.owner?._saveDraftTables?.({ render: false });
    if (saved) this._requestRenderPreservingPosition();
  }

  _onAddRequirement(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    this._commitVisibleInputsToDraft();
    const button = event.currentTarget;
    const kind = String(button?.dataset?.eventTableKind ?? this.tableKind);
    const rowId = String(button?.dataset?.eventRowId ?? this.rowId);
    if (!rowId || !["general", "external"].includes(kind)) return;
    const editor = button.closest?.("[data-event-requirement-controls]");
    const requirement = buildRequirementFromEditor(editor, this.owner?._buildingTemplates ?? [], this.owner?._regionOptions ?? []);
    if (!requirement) return;
    const dependencyKind = dependencyKindFromTarget(button);
    this.owner?._updateDraftTables?.((tables) => {
      const row = tables[kind].rows.find((item) => String(item.id) === rowId);
      if (!row) return false;
      row[dependencyKind] = normalizeDependency(dependencyKind, row[dependencyKind]);
      row[dependencyKind].rules.push(requirement);
      return true;
    });
    this._requestRenderPreservingPosition();
  }

  _onDeleteRequirement(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    this._commitVisibleInputsToDraft();
    const button = event.currentTarget;
    const kind = String(button?.dataset?.eventTableKind ?? this.tableKind);
    const rowId = String(button?.dataset?.eventRowId ?? this.rowId);
    const requirementId = String(button?.dataset?.eventRequirementId ?? "");
    const dependencyKind = dependencyKindFromTarget(button);
    if (!rowId || !requirementId || !["general", "external"].includes(kind)) return;
    this.owner?._updateDraftTables?.((tables) => {
      const row = tables[kind].rows.find((item) => String(item.id) === rowId);
      if (!row) return false;
      row[dependencyKind] = normalizeDependency(dependencyKind, row[dependencyKind]);
      const before = row[dependencyKind].rules.length;
      row[dependencyKind].rules = row[dependencyKind].rules.filter((rule) => String(rule.id) !== requirementId);
      return row[dependencyKind].rules.length !== before;
    });
    this._requestRenderPreservingPosition();
  }

  _onAddEffect(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    this._commitVisibleInputsToDraft();
    if (this.owner?._addDraftEffect?.(this.tableKind, this.rowId, "resource")) this._requestRenderPreservingPosition();
  }

  _onDeleteEffect(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    this._commitVisibleInputsToDraft();
    const effectId = String(event.currentTarget?.dataset?.eventEffectId ?? "");
    if (effectId && this.owner?._deleteDraftEffect?.(this.tableKind, this.rowId, effectId)) this._requestRenderPreservingPosition();
  }

  _onPickEffectResource(event) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    const button = event.currentTarget;
    const kind = String(button?.dataset?.eventTableKind ?? this.tableKind);
    const rowId = String(button?.dataset?.eventRowId ?? this.rowId);
    const effectId = String(button?.dataset?.eventEffectId ?? "");
    if (!effectId || !["general", "external"].includes(kind)) return;
    SkyholdResourceCatalogEditor.pick({
      selectedId: String(button?.dataset?.resourceId ?? ""),
      onSelect: (resource) => {
        const changed = this.owner?._updateDraftTables?.((tables) => {
          const row = tables?.[kind]?.rows?.find((item) => String(item.id) === rowId);
          const effect = row?.effects?.find((item) => String(item.id) === effectId);
          if (!effect) return false;
          effect.resourceId = String(resource.id ?? "custom");
          if (effect.resourceId !== "custom") effect.name = String(resource.label ?? "");
          return true;
        });
        if (changed) this._requestRenderPreservingPosition();
      }
    });
  }

  async _onClose(options) {
    this._commitVisibleInputsToDraft();
    await super._onClose(options);
    this._delegatedAbortController?.abort?.();
    this._delegatedAbortController = null;
    unbindGlobalInputGuard(this);
    this.owner?._forgetRowEditor?.(`${this.tableKind}:${this.rowId}`);
    if (this.owner?.rendered) this.owner._requestRenderPreservingPosition?.();
  }
}

SkyholdRandomEventRowEditor.DEFAULT_OPTIONS = {
  classes: ["fbl-skyhold", "fbl-skyhold-random-event-row-editor"],
  tag: "section",
  window: {
    title: "Событие",
    icon: "fa-solid fa-pen-to-square",
    resizable: true
  },
  position: {
    width: 820,
    height: 720
  }
};

SkyholdRandomEventRowEditor.PARTS = {
  body: {
    template: `modules/${MODULE_ID}/templates/random-event-row-editor.hbs`
  }
};
