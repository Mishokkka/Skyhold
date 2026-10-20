import { MODULE_ID } from "../../data/constants.js";
import { SkyholdData } from "../../data/store.js";
import { clone } from "../../data/utils.js";
import { stableDataHash } from "../../data/storage-commit.js";
import {
  EVENT_THRESHOLD_KEYS,
  cloneDefaultRandomEventTables,
  describeEventRequirement,
  eventRequirementFacts,
  normalizeEventRegionOptions,
  normalizeEventRequirement,
  normalizeEventTagThresholds,
  normalizeRandomEventTables
} from "../../data/random-events.js";
import { normalizeRandomEventEffect, normalizeRandomEventEffects } from "../../data/random-event-effects.js";
import { fieldValue } from "../../core/helpers.js";
import { dispatchDelegatedAction } from "../common/delegated-events.js";
import { RenderSchedulerMixin } from "../common/render-scheduler.js";
import { SaveStatus, syncSaveStatus } from "../common/save-status.js";
import { bindFloatingTooltips, FloatingTooltipsMixin } from "../common/floating-tooltip.js";
import { bindGlobalInputGuard, bindInputGuards, unbindGlobalInputGuard } from "../../utils/input-guards.js";
import { newEventEffect, newEventRow, newRequirement } from "./random-event/draft.js";
import {
  prepareRowContext,
  prepareTableControls,
  prepareTableSummary,
  rowSearchText
} from "./random-event/context.js";
import {
  EVENT_FIELDS,
  EFFECT_FIELDS,
  REQUIREMENT_FIELDS,
  REQUIREMENT_TYPE_BY_VALUE,
  cssEscape,
  dependencyKindFromTarget,
  eventFieldValue,
  effectFieldValue,
  normalizeDependency,
  requirementFieldValue
} from "./random-event/form.js";
import { SkyholdRandomEventContextEditor } from "./random-event/context-editor.js";
import { SkyholdRandomEventRowEditor } from "./random-event/row-editor.js";
import { removeEventContextHeaderButton, syncEventContextHeaderButton } from "./random-event/window-frame.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const THRESHOLD_FIELDS = new Set(["lowMax", "highMin"]);
const THRESHOLD_KEYS = new Set(EVENT_THRESHOLD_KEYS.map(({ key }) => key));

export class SkyholdRandomEventEditor extends FloatingTooltipsMixin(RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2))) {
  constructor({ holdingId = "", activeTable = "general" } = {}, options = {}) {
    super(options);
    this.holdingId = String(holdingId ?? "");
    this.activeTable = ["general", "external"].includes(String(activeTable ?? "")) ? String(activeTable) : "general";
    this.search = "";
    this._buildingTemplates = [];
    this._draftTables = null;
    this._draftSourceHash = "";
    this._draftHoldingId = "";
    this._dirty = false;
    this._saveStatus = new SaveStatus({ mode: "manual", onChange: () => this._syncSaveStatus() });
    this._lastPosition = null;
    this._listScrollTop = 0;
    this._eventFacts = null;
    this._previewHolding = null;
    this._regionOptions = [];
    this._rowEditors = new Map();
    this._contextEditor = null;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const holding = this._refreshDataCaches();
    const storedTables = normalizeRandomEventTables(holding?.gm?.eventTables);
    if (!this._draftTables || this._draftHoldingId !== this.holdingId) {
      this._draftTables = clone(storedTables);
      this._draftSourceHash = stableDataHash(storedTables);
      this._draftHoldingId = this.holdingId;
      this._dirty = false;
    }
    const tables = normalizeRandomEventTables(this._draftTables);
    const preparedTables = ["general", "external"].map((kind) => this._prepareTableSummary(kind, tables[kind]));
    const currentTable = this._prepareTableContext(this.activeTable, tables[this.activeTable]);

    return {
      ...context,
      canEdit: Boolean(game.user?.isGM && holding),
      holdingId: this.holdingId,
      holdingName: holding?.name ?? "Владение",
      tables: preparedTables,
      currentTable,
      search: this.search,
      dirty: this._dirty,
      saveStatus: this._saveStatus.context,
      hasHolding: Boolean(holding)
    };
  }

  _refreshDataCaches() {
    const data = SkyholdData.view();
    const holding = data.holdings.find((item) => String(item?.id ?? "") === this.holdingId) ?? null;
    this._previewHolding = holding;
    this._buildingTemplates = Array.isArray(data?.catalog?.buildings) ? data.catalog.buildings : [];
    this._regionOptions = normalizeEventRegionOptions(data?.catalog?.eventRegions);
    this._eventFacts = holding ? eventRequirementFacts(holding, { regionOptions: this._regionOptions }) : null;
    return holding;
  }

  _prepareTableSummary(kind, table = {}) {
    return prepareTableSummary(kind, table, this.activeTable);
  }

  _prepareTableControls() {
    return prepareTableControls(this._buildingTemplates, this._regionOptions);
  }

  _prepareRowContext(row = {}, index = 0, { full = false } = {}) {
    return prepareRowContext(row, index, {
      full,
      facts: this._eventFacts,
      buildingTemplates: this._buildingTemplates,
      regionOptions: this._regionOptions,
      holding: this._previewHolding
    });
  }

  _prepareTableContext(kind, table = {}) {
    const rows = (table.rows ?? []).map((row, index) => this._prepareRowContext(row, index));
    return {
      ...table,
      ...this._prepareTableSummary(kind, table),
      ...this._prepareTableControls(),
      rows,
      eventCount: rows.length,
      count: rows.length
    };
  }

  _prepareRowEditorContext(kind = this.activeTable, rowId = "") {
    this._refreshDataCaches();
    const tables = this._ensureDraftTables();
    const table = tables?.[kind] ?? null;
    const index = table?.rows?.findIndex?.((row) => String(row.id) === String(rowId)) ?? -1;
    const row = index >= 0 ? table.rows[index] : null;
    return {
      table,
      row,
      rowContext: row ? this._prepareRowContext(row, index, { full: true }) : null,
      tableContext: {
        ...(table ?? {}),
        ...this._prepareTableSummary(kind, table ?? {}),
        ...this._prepareTableControls()
      }
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
    this._filterRows(this.search);
    this._restoreListScroll();
    syncEventContextHeaderButton(this, root);
    bindFloatingTooltips(this, root);
    this._syncSaveStatus();
  }

  _bindEvents(root) {
    this._delegatedAbortController?.abort?.();
    const controller = new AbortController();
    this._delegatedAbortController = controller;
    const actions = {
      "event-editor-table": "_onSwitchTable",
      "event-editor-add": "_onAddRow",
      "event-editor-edit-row": "_onToggleRowEditor",
      "event-editor-delete": "_onDeleteRow",
      "event-editor-reset": "_onResetTable",
      "event-editor-save": "_onSave"
    };

    root.addEventListener("click", (event) => {
      const element = event.target?.closest?.("[data-action]");
      if (!element || !root.contains(element)) return;
      dispatchDelegatedAction(this, event, element, actions[String(element.dataset.action ?? "")]);
    }, { signal: controller.signal });

    root.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const search = target.closest?.("[data-event-search]");
      if (search && root.contains(search)) {
        this.search = String(search.value ?? "");
        this._filterRows(this.search);
      }
    }, { signal: controller.signal });

    root.addEventListener("input", (event) => {
      const target = event.target;
      const search = target?.closest?.("[data-event-search]");
      if (search && root.contains(search)) {
        this.search = String(search.value ?? "");
        this._filterRows(this.search);
        return;
      }
    }, { signal: controller.signal });
  }

  async _onClose(options) {
    this._commitOpenEditors();
    await super._onClose(options);
    this._delegatedAbortController?.abort?.();
    this._delegatedAbortController = null;
    unbindGlobalInputGuard(this);
    removeEventContextHeaderButton(this);
    for (const editor of this._rowEditors.values()) editor.close?.({ force: true });
    this._rowEditors.clear();
    this._contextEditor?.close?.({ force: true });
    this._contextEditor = null;
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
    this._captureListScroll();
    this.requestRender({ focus: false, ...options });
  }

  _captureListScroll() {
    const list = this.element?.querySelector?.(".fbls-event-list");
    if (list) this._listScrollTop = Number(list.scrollTop) || 0;
  }

  _restoreListScroll() {
    const list = this.element?.querySelector?.(".fbls-event-list");
    if (!list) return;
    const top = Number(this._listScrollTop) || 0;
    const restore = () => { list.scrollTop = top; };
    restore();
    if (globalThis.requestAnimationFrame) requestAnimationFrame(restore);
  }

  _markDirty() {
    this._dirty = true;
    this._saveStatus.markDirty();
  }

  _syncSaveStatus() {
    syncSaveStatus(this.element, this._saveStatus);
    for (const editor of this._rowEditors?.values() ?? []) syncSaveStatus(editor.element, this._saveStatus);
  }

  _commitOpenEditors() {
    for (const editor of this._rowEditors.values()) editor._commitVisibleInputsToDraft?.();
  }

  _forgetRowEditor(rowId = "") {
    this._rowEditors.delete(String(rowId ?? ""));
  }

  _onOpenContextEditor() {
    if (!game.user?.isGM || !this.holdingId) return;
    if (this._contextEditor?.rendered) {
      this._contextEditor.render({ force: true, focus: true });
      return;
    }
    this._contextEditor = new SkyholdRandomEventContextEditor({ holdingId: this.holdingId, owner: this });
    this._contextEditor.render({ force: true, focus: true });
  }

  _openRowEditor(kind = this.activeTable, rowId = "") {
    if (!game.user?.isGM || !rowId || !["general", "external"].includes(kind)) return;
    const key = `${kind}:${rowId}`;
    const existing = this._rowEditors.get(key);
    if (existing?.rendered) {
      existing.render({ force: true, focus: true });
      return;
    }
    const editor = new SkyholdRandomEventRowEditor({ owner: this, holdingId: this.holdingId, tableKind: kind, rowId });
    this._rowEditors.set(key, editor);
    editor.render({ force: true, focus: true });
  }

  _ensureDraftTables() {
    if (this._draftTables) return this._draftTables;
    const data = SkyholdData.view();
    const holding = data.holdings.find((item) => String(item?.id ?? "") === this.holdingId) ?? null;
    this._draftTables = clone(normalizeRandomEventTables(holding?.gm?.eventTables));
    this._draftSourceHash = stableDataHash(this._draftTables);
    this._draftHoldingId = String(holding?.id ?? this.holdingId ?? "");
    return this._draftTables;
  }

  _updateDraftTables(updater) {
    if (typeof updater !== "function") return false;
    const tables = this._ensureDraftTables();
    const changed = updater(tables);
    if (changed) this._markDirty();
    return Boolean(changed);
  }

  _findDraftRow(kind = this.activeTable, rowId = "") {
    if (!["general", "external"].includes(kind) || !rowId) return null;
    const tables = this._ensureDraftTables();
    return tables?.[kind]?.rows?.find?.((item) => String(item.id) === String(rowId)) ?? null;
  }

  _syncRequirementEditors(root = this.element) {
    root?.querySelectorAll?.("[data-event-requirement-controls]").forEach((editor) => {
      const type = String(editor.querySelector?.("[data-event-requirement-type]")?.value ?? editor.querySelector?.("[data-event-requirement-field='type']")?.value ?? "feature");
      const definition = REQUIREMENT_TYPE_BY_VALUE.get(type) ?? REQUIREMENT_TYPE_BY_VALUE.get("feature");
      const valueKind = definition.valueKind ?? "feature";
      editor.querySelectorAll?.("[data-event-requirement-value-wrap]").forEach((wrap) => {
        const kinds = String(wrap.dataset.eventRequirementValueWrap ?? "").split(/\s+/).filter(Boolean);
        const visible = kinds.includes(valueKind) || (valueKind === "development" && kinds.includes("number"));
        wrap.hidden = !visible;
        wrap.querySelectorAll?.("input, select, textarea").forEach((input) => { input.disabled = !visible; });
        if (["INPUT", "SELECT", "TEXTAREA"].includes(wrap.tagName)) wrap.disabled = !visible;
      });
      const operator = editor.querySelector?.("[data-event-requirement-operator], [data-event-requirement-field='operator']");
      if (operator) {
        const allowed = new Set(definition.operators ?? []);
        for (const option of operator.options ?? []) {
          const visible = !allowed.size || allowed.has(option.value);
          option.hidden = !visible;
          option.disabled = !visible;
        }
        if (allowed.size && !allowed.has(operator.value)) operator.value = definition.defaultOperator;
      }
    });
  }

  _autoGrowTextareas(root = this.element) {
    root?.querySelectorAll?.("textarea[data-event-autogrow]").forEach((textarea) => this._autoGrowTextarea(textarea));
  }

  _autoGrowTextarea(textarea) {
    if (!(textarea instanceof HTMLTextAreaElement)) return;
    const maxHeight = 260;
    textarea.style.height = "auto";
    const next = Math.min(maxHeight, Math.max(44, textarea.scrollHeight));
    textarea.style.height = `${next}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }

  _refreshRowSearchText(kind, rowId) {
    const row = this._findDraftRow(kind, rowId);
    if (!row) return;
    const selector = `[data-event-row-id="${cssEscape(rowId)}"]`;
    const control = this.element?.querySelector?.(selector);
    const tableRow = control?.closest?.("[data-event-search-text]");
    if (tableRow) tableRow.dataset.eventSearchText = rowSearchText(row, this._buildingTemplates, this._regionOptions);
  }

  _refreshRequirementLabel(kind, rowId, requirementId, dependencyKind = "requirements") {
    const row = this._findDraftRow(kind, rowId);
    const dependencies = normalizeDependency(dependencyKind, row?.[dependencyKind]);
    const rule = dependencies.rules.find?.((item) => String(item.id) === String(requirementId));
    if (!rule) return;
    const control = this.element?.querySelector?.(`[data-event-dependency-kind="${cssEscape(dependencyKind)}"] [data-event-requirement-id="${cssEscape(requirementId)}"]`);
    const card = control?.closest?.("[data-event-requirement-controls]");
    const label = card?.querySelector?.(".fbls-event-requirement-label");
    if (label) label.textContent = describeEventRequirement(rule, { buildingTemplates: this._buildingTemplates, regionOptions: this._regionOptions });
    this._refreshRowSearchText(kind, rowId);
  }

  _setEventFieldFromTarget(target, { final = false } = {}) {
    const kind = String(target.dataset.eventTableKind ?? this.activeTable);
    const rowId = String(target.dataset.eventRowId ?? "");
    const field = String(target.dataset.eventField ?? "");
    if (!rowId || !["general", "external"].includes(kind) || !EVENT_FIELDS.has(field)) return false;
    const row = this._findDraftRow(kind, rowId);
    if (!row) return false;
    const value = eventFieldValue(field, target, { final });
    if (row[field] === value) return false;
    row[field] = value;
    this._markDirty();
    this._refreshRowSearchText(kind, rowId);
    return true;
  }

  _setRequirementLogicFromTarget(target) {
    const kind = String(target.dataset.eventTableKind ?? this.activeTable);
    const rowId = String(target.dataset.eventRowId ?? "");
    const logic = String(target.value ?? "all");
    const row = this._findDraftRow(kind, rowId);
    if (!row) return false;
    const dependencyKind = dependencyKindFromTarget(target);
    row[dependencyKind] = normalizeDependency(dependencyKind, row[dependencyKind]);
    const next = ["all", "any", "none"].includes(logic) ? logic : "all";
    if (row[dependencyKind].logic === next) return false;
    row[dependencyKind].logic = next;
    this._markDirty();
    return true;
  }

  _applyRequirementField(kind, rowId, requirementId, field, value, dependencyKind = "requirements") {
    if (!rowId || !requirementId || !["general", "external"].includes(kind) || !REQUIREMENT_FIELDS.has(field)) return false;
    const row = this._findDraftRow(kind, rowId);
    if (!row) return false;
    row[dependencyKind] = normalizeDependency(dependencyKind, row[dependencyKind]);
    const rule = row[dependencyKind].rules.find((item) => String(item.id) === requirementId);
    if (!rule) return false;
    if (field === "type") {
      if (String(rule.type) === String(value || "feature")) return false;
      const next = newRequirement(String(value || "feature"), this._buildingTemplates, this._regionOptions);
      rule.type = next.type;
      rule.operator = next.operator;
      rule.key = next.key;
      rule.value = next.value;
      rule.number = next.number;
    } else {
      if (rule[field] === value) return false;
      rule[field] = value;
      const normalized = normalizeEventRequirement(rule);
      Object.assign(rule, normalized);
    }
    this._markDirty();
    return true;
  }

  _setRequirementFieldFromTarget(target) {
    if (target.disabled) return false;
    const kind = String(target.dataset.eventTableKind ?? this.activeTable);
    const rowId = String(target.dataset.eventRowId ?? "");
    const requirementId = String(target.dataset.eventRequirementId ?? "");
    const field = String(target.dataset.eventRequirementField ?? "");
    const dependencyKind = dependencyKindFromTarget(target);
    const value = requirementFieldValue(field, target);
    const changed = this._applyRequirementField(kind, rowId, requirementId, field, value, dependencyKind);
    if (changed) this._refreshRequirementLabel(kind, rowId, requirementId, dependencyKind);
    return changed;
  }

  _applyEffectField(kind, rowId, effectId, field, value) {
    if (!rowId || !effectId || !["general", "external"].includes(kind) || !EFFECT_FIELDS.has(field)) return false;
    const row = this._findDraftRow(kind, rowId);
    if (!row) return false;
    row.effects = normalizeRandomEventEffects(row.effects);
    const effect = row.effects.find((item) => String(item.id) === effectId);
    if (!effect) return false;
    if (field === "type") {
      if (String(effect.type) === String(value || "resource")) return false;
      const next = newEventEffect(String(value || "resource"));
      Object.assign(effect, next, { id: effect.id, note: effect.note, amount: effect.amount || next.amount });
    } else {
      if (effect[field] === value) return false;
      effect[field] = value;
      Object.assign(effect, normalizeRandomEventEffect(effect));
    }
    this._markDirty();
    return true;
  }

  _setEffectFieldFromTarget(target) {
    if (target.disabled) return false;
    const kind = String(target.dataset.eventTableKind ?? this.activeTable);
    const rowId = String(target.dataset.eventRowId ?? "");
    const effectId = String(target.dataset.eventEffectId ?? "");
    const field = String(target.dataset.eventEffectField ?? "");
    return this._applyEffectField(kind, rowId, effectId, field, effectFieldValue(field, target));
  }

  _addDraftEffect(kind, rowId, type = "resource") {
    const row = this._findDraftRow(kind, rowId);
    if (!row) return false;
    row.effects = normalizeRandomEventEffects(row.effects);
    row.effects.push(newEventEffect(type));
    this._markDirty();
    return true;
  }

  _deleteDraftEffect(kind, rowId, effectId) {
    const row = this._findDraftRow(kind, rowId);
    if (!row) return false;
    row.effects = normalizeRandomEventEffects(row.effects);
    const before = row.effects.length;
    row.effects = row.effects.filter((effect) => String(effect.id) !== String(effectId));
    if (row.effects.length === before) return false;
    this._markDirty();
    return true;
  }

  _commitVisibleInputsToDraft(root = this.element) {
    root?.querySelectorAll?.("[data-event-field]").forEach((target) => {
      if (!target.disabled) this._setEventFieldFromTarget(target, { final: true });
    });
    root?.querySelectorAll?.("[data-event-requirement-logic]").forEach((target) => {
      if (!target.disabled) this._setRequirementLogicFromTarget(target);
    });
    root?.querySelectorAll?.("[data-event-requirement-field]").forEach((target) => {
      if (!target.disabled) this._setRequirementFieldFromTarget(target);
    });
    root?.querySelectorAll?.("[data-event-effect-field]").forEach((target) => {
      if (!target.disabled) this._setEffectFieldFromTarget(target);
    });
  }

  _onSwitchTable(event) {
    event.preventDefault();
    event.stopPropagation();
    this._commitOpenEditors();
    const kind = String(event.currentTarget?.dataset?.eventTableKind ?? "general");
    if (!["general", "external"].includes(kind)) return;
    this.activeTable = kind;
    this._requestRenderPreservingPosition();
  }

  _onToggleRowEditor(event) {
    event.preventDefault();
    event.stopPropagation();
    this._commitOpenEditors();
    const kind = String(event.currentTarget?.dataset?.eventTableKind ?? this.activeTable);
    const rowId = String(event.currentTarget?.dataset?.eventRowId ?? "");
    if (!rowId || !["general", "external"].includes(kind)) return;
    this.activeTable = kind;
    this._openRowEditor(kind, rowId);
  }

  _onAddRow(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    this._commitOpenEditors();
    const kind = String(event.currentTarget?.dataset?.eventTableKind ?? this.activeTable);
    if (!["general", "external"].includes(kind)) return;
    const row = newEventRow(kind);
    this._updateDraftTables((tables) => {
      tables[kind].rows.push(row);
      return true;
    });
    this.activeTable = kind;
    this._requestRenderPreservingPosition();
    this._openRowEditor(kind, String(row.id ?? ""));
  }

  async _onDeleteRow(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    const kind = String(event.currentTarget?.dataset?.eventTableKind ?? this.activeTable);
    const rowId = String(event.currentTarget?.dataset?.eventRowId ?? "");
    if (!rowId || !["general", "external"].includes(kind)) return;
    const confirmed = await this._confirm({
      title: "Удалить событие",
      content: "Удалить это событие из таблицы? Изменение вступит в силу после сохранения."
    });
    if (!confirmed) return;
    this._commitOpenEditors();
    this._rowEditors.get(`${kind}:${rowId}`)?.close?.({ force: true });
    this._forgetRowEditor(`${kind}:${rowId}`);
    this._updateDraftTables((tables) => {
      const before = tables[kind].rows.length;
      tables[kind].rows = tables[kind].rows.filter((row) => String(row.id) !== rowId);
      return tables[kind].rows.length !== before;
    });
    this._requestRenderPreservingPosition();
  }

  async _onResetTable(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    const kind = String(event.currentTarget?.dataset?.eventTableKind ?? this.activeTable);
    if (!["general", "external"].includes(kind)) return;
    const confirmed = await this._confirm({
      title: "Сбросить таблицу",
      content: "Вернуть выбранную таблицу к текущему дефолтному набору модуля? Изменение вступит в силу после сохранения."
    });
    if (!confirmed) return;
    this._commitOpenEditors();
    this._updateDraftTables((tables) => {
      const defaults = cloneDefaultRandomEventTables();
      tables[kind] = defaults[kind];
      return true;
    });
    this._requestRenderPreservingPosition();
  }

  async _onThresholdChange(event, target) {
    event.preventDefault();
    if (!game.user?.isGM || !this.holdingId) return;
    const key = String(target.dataset.eventThresholdKey ?? "");
    const field = String(target.dataset.eventThresholdField ?? "");
    if (!THRESHOLD_KEYS.has(key) || !THRESHOLD_FIELDS.has(field)) return;
    const value = Math.floor(Number(fieldValue(target)) || 0);
    const saved = await SkyholdData.updateHolding(this.holdingId, (holding) => {
      if (!holding.gm || typeof holding.gm !== "object") holding.gm = {};
      const thresholds = normalizeEventTagThresholds(holding.gm.eventTagThresholds);
      thresholds[key][field] = value;
      holding.gm.eventTagThresholds = normalizeEventTagThresholds(thresholds);
      return true;
    }, { fallback: false, reason: `event-editor:threshold:${key}:${field}` });
    if (saved) this._requestRenderPreservingPosition();
  }

  async _saveDraftTables({ render = true } = {}) {
    if (!game.user?.isGM || !this.holdingId) return;
    if (this._saveTablesPromise) return this._saveTablesPromise;
    this._commitOpenEditors();
    const tablesToSave = normalizeRandomEventTables(this._ensureDraftTables());
    if (!this._saveStatus.dirty.has("draft")) this._saveStatus.markDirty();
    const revision = this._saveStatus.revision;
    this._saveTablesPromise = this._saveStatus.track(async () => {
      const saved = await SkyholdData.updateHolding(this.holdingId, (holding) => {
        if (stableDataHash(normalizeRandomEventTables(holding?.gm?.eventTables)) !== this._draftSourceHash) {
          ui.notifications?.warn?.("Таблицы событий изменились после открытия. Черновик сохранён в окне; откройте актуальные таблицы в другом окне и перенесите правки.");
          return SkyholdData.skipTransaction(false);
        }
        if (!holding.gm || typeof holding.gm !== "object") holding.gm = {};
        holding.gm.eventTables = tablesToSave;
        return true;
      }, { fallback: false, reason: "event-editor:save" });
      if (!saved) return false;
      if (this._saveStatus.revision === revision) this._draftTables = clone(tablesToSave);
      this._draftSourceHash = stableDataHash(tablesToSave);
      this._dirty = this._saveStatus.revision !== revision;
      ui.notifications?.info?.("События сохранены.");
      if (render) this._requestRenderPreservingPosition();
      return true;
    }).catch((error) => {
      console.error("FBL Skyhold | Failed to save event tables", error);
      ui.notifications?.error?.("Не удалось сохранить события. Черновик остаётся в окне.");
      return false;
    }).finally(() => { this._saveTablesPromise = null; });
    return this._saveTablesPromise;
  }

  async _onSave(event) {
    event.preventDefault();
    event.stopPropagation();
    await this._saveDraftTables();
  }

  _filterRows(query = "") {
    const needle = String(query ?? "").trim().toLowerCase();
    this.element?.querySelectorAll?.("[data-event-search-text]").forEach((row) => {
      row.hidden = Boolean(needle && !String(row.dataset.eventSearchText ?? "").includes(needle));
    });
  }

  async _confirm({ title = "Подтвердить", content = "" } = {}) {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (DialogV2?.confirm) {
      try {
        return await DialogV2.confirm({
          window: { title },
          content: `<p>${content}</p>`,
          modal: true
        });
      } catch (_error) {
        return false;
      }
    }
    return Boolean(globalThis.window?.confirm?.(content));
  }
}

SkyholdRandomEventEditor.DEFAULT_OPTIONS = {
  classes: ["fbl-skyhold", "fbl-skyhold-random-event-editor"],
  tag: "section",
  window: {
    title: "Случайные события",
    icon: "fa-solid fa-table-list",
    resizable: true
  },
  position: {
    width: 1180,
    height: 720
  }
};

SkyholdRandomEventEditor.PARTS = {
  body: {
    template: `modules/${MODULE_ID}/templates/random-event-editor.hbs`
  }
};
