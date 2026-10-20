import { escapeHtml } from "../../core/helpers.js";
import { MODULE_ID } from "../../data/constants.js";
import { SkyholdData } from "../../data/store.js";
import { makeId } from "../../data/utils.js";
import { findReadableHoldingEntry, warnNoHoldingAccess } from "../../data/access-guard.js";
import { holdingPermissionContext } from "../../data/holding-permissions.js";
import { getSkyholdManager, requestSkyholdAppRender } from "../registry.js";
import { bindDelegatedActions, unbindDelegatedActions } from "../common/delegated-events.js";
import { bindFloatingTooltips, hideFloatingTooltip } from "../common/floating-tooltip.js";
import { RenderSchedulerMixin } from "../common/render-scheduler.js";
import { ensureSkyholdTemplateGroup } from "../template-preload.js";
import { resolveUniqueBuilding } from "../unique-buildings/registry.js";
import { SkyholdBuildingEditor } from "./building-editor.js";
import { makeBlankBuildingTemplate } from "./helpers.js";
import { filterTemplateRows, templateBrowserScope, templatePassport, normalizeTemplateSearch, templateSearchText, templateListPresentation } from "../domains/building/template-browser-model.js";
import { rememberApplicationFocusReturn, restoreApplicationFocus, windowFrameForElement } from "../common/window-focus-keeper.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const TEMPLATE_BROWSER_ACTIONS = {
  "select-template": "_onSelectTemplate",
  "template-list": "_onTemplateList",
  "template-category": "_onCategory",
  "template-availability": "_onAvailability",
  "create-building-from-template": "_onCreateBuildingFromTemplate",
  "create-building-template": "_onCreateTemplate",
  "edit-building-template": "_onEditTemplate",
  "delete-building-template": "_onDeleteTemplate"
};

const uniqueTemplateEditorClasses = new WeakMap();

function getActiveSkyholdManager({ warn = false } = {}) {
  const manager = getSkyholdManager();
  if (!manager && warn) ui.notifications?.warn?.("FBL Skyhold manager is closed. Open it before using this editor action.");
  return manager;
}

function uniqueTemplateEditorClassFor(appClass) {
  if (uniqueTemplateEditorClasses.has(appClass)) return uniqueTemplateEditorClasses.get(appClass);

  class SkyholdUniqueBuildingTemplateEditor extends appClass {
    constructor({ holdingId, templateId } = {}, options = {}) {
      super({ holdingId, buildingId: templateId }, options);
      this.templateId = String(templateId ?? "");
      this.buildingId = this.templateId;
    }

    async _prepareContext(options) {
      const context = await super._prepareContext(options);
      const data = SkyholdData.get();
      const templateIndex = game.user?.isGM ? (data.catalog?.buildings ?? []).findIndex((item) => String(item.id) === String(this.templateId)) : -1;
      const template = templateIndex >= 0 ? data.catalog.buildings[templateIndex] : null;
      const { holding, index: holdingIndex } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
      const manager = getActiveSkyholdManager();
      const row = template && manager ? manager._prepareBuildingRow(holding, template, templateIndex, true, [], { basePath: `catalog.buildings.${templateIndex}`, isTemplate: true }) : null;
      if (row) this._prepareUniqueBuildingTabs(row, { canManageEditorTabs: true });
      return {
        ...context,
        canEdit: Boolean(game.user?.isGM),
        canManageEditorTabs: Boolean(game.user?.isGM),
        holding,
        holdingIndex,
        building: row,
        buildingIndex: templateIndex,
        hasBuilding: Boolean(row),
        editDevGain: this.editDevGain,
        constructionCrew: manager?._constructionCrew?.(holding) ?? { count: 0, dice: 0, names: "" },
        development: manager?._developmentSummary?.(holding) ?? null,
        isTemplateEditor: true
      };
    }

    _canEditBuilding() {
      return Boolean(game.user?.isGM);
    }

    _getMutableBuilding(data = SkyholdData.get()) {
      const buildingIndex = (data.catalog?.buildings ?? []).findIndex((item) => String(item.id) === String(this.templateId));
      const building = buildingIndex >= 0 ? data.catalog.buildings[buildingIndex] : null;
      return { data, holding: null, holdingIndex: -1, building, buildingIndex };
    }

    async _onBuildingWorkerChange(event) {
      event.preventDefault();
      event.stopPropagation();
    }

    async _onRollConstructionCrew(event) {
      event.preventDefault();
      event.stopPropagation();
    }

    async _onRollConstruction(event) {
      event.preventDefault();
      event.stopPropagation();
    }

    async _onClose(options) {
      await super._onClose(options);
      SkyholdBuildingTemplateBrowser.instance?.requestRender?.();
    }
  }

  const baseOptions = appClass.DEFAULT_OPTIONS ?? {};
  SkyholdUniqueBuildingTemplateEditor.DEFAULT_OPTIONS = {
    ...baseOptions,
    classes: [...new Set([...(baseOptions.classes ?? ["fbl-skyhold", "fbl-skyhold-unique-building"]), "fbl-skyhold-template-editor"])],
    window: {
      ...(baseOptions.window ?? {}),
      title: "Шаблон уникального здания",
      icon: baseOptions.window?.icon ?? "fa-solid fa-drafting-compass",
      resizable: true
    }
  };
  SkyholdUniqueBuildingTemplateEditor.PARTS = appClass.PARTS;
  uniqueTemplateEditorClasses.set(appClass, SkyholdUniqueBuildingTemplateEditor);
  return SkyholdUniqueBuildingTemplateEditor;
}

export class SkyholdBuildingTemplateEditor extends SkyholdBuildingEditor {
  constructor({ holdingId, templateId } = {}, options = {}) {
    super({ holdingId, buildingId: templateId }, options);
    this.templateId = templateId;
  }

  async _prepareContext(options) {
    await ensureSkyholdTemplateGroup("buildingEditor");
    const context = await super._prepareContext(options);
    const data = SkyholdData.get();
    const templateIndex = game.user?.isGM ? (data.catalog?.buildings ?? []).findIndex((item) => String(item.id) === String(this.templateId)) : -1;
    const template = templateIndex >= 0 ? data.catalog.buildings[templateIndex] : null;
    const { holding, index: holdingIndex } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
    const manager = getActiveSkyholdManager();
    const row = template && manager ? manager._prepareBuildingRow(holding, template, templateIndex, true, [], { basePath: `catalog.buildings.${templateIndex}`, isTemplate: true }) : null;
    if (row) this._prepareEditorTabs(row, { holding, data });
    return {
      ...context,
      canEdit: Boolean(game.user?.isGM),
      holding,
      holdingIndex,
      building: row,
      buildingIndex: templateIndex,
      hasBuilding: Boolean(row),
      editDevGain: this.editDevGain,
      constructionCrew: manager?._constructionCrew?.(holding) ?? { count: 0, dice: 0, names: "" },
      development: manager?._developmentSummary?.(holding) ?? null,
      isTemplateEditor: true
    };
  }

  _canEditBuilding() {
    return Boolean(game.user?.isGM);
  }

  _getMutableBuilding(data = SkyholdData.get()) {
    const buildingIndex = (data.catalog?.buildings ?? []).findIndex((item) => String(item.id) === String(this.templateId));
    const building = buildingIndex >= 0 ? data.catalog.buildings[buildingIndex] : null;
    return { data, holding: null, holdingIndex: -1, building, buildingIndex };
  }

  async _onRollConstructionCrew(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  async _onRollConstruction(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  async _onClose(options) {
    await super._onClose(options);
    SkyholdBuildingTemplateBrowser.instance?.requestRender?.();
  }
}

SkyholdBuildingTemplateEditor.DEFAULT_OPTIONS = {
  classes: ["fbl-skyhold", "fbl-skyhold-building-editor", "fbl-skyhold-template-editor"],
  tag: "section",
  window: {
    title: "Шаблон здания",
    icon: "fa-solid fa-drafting-compass",
    resizable: true
  },
  position: {
    width: 980,
    height: 560
  }
};
SkyholdBuildingTemplateEditor.PARTS = {
  body: {
    template: `modules/${MODULE_ID}/templates/building-editor.hbs`
  }
};

export class SkyholdBuildingTemplateBrowser extends RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  constructor({ holdingId } = {}, options = {}) {
    super(options);
    this.holdingId = holdingId;
    this.category = "all";
    this.availability = "all";
    this.search = "";
    this.searchOpen = false;
    this.purpose = "all";
    this.stage = "all";
    this.sort = "name";
    this.selectedId = "";
    this.detailOpen = false;
    SkyholdBuildingTemplateBrowser.instance = this;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const data = SkyholdData.get();
    const { holding } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
    const manager = getActiveSkyholdManager();
    const canEdit = Boolean(game.user?.isGM);
    const catalog = manager?._buildingTemplateContext?.(holding, data) ?? { rows: [], availableCount: 0, lockedCount: 0, hiddenCount: 0 };
    if (!canEdit && this.availability === "hidden") this.availability = "all";
    const { publicRows, hiddenRows, scopedRows } = templateBrowserScope(catalog, holding, canEdit, this.availability);
    const stages = [...new Set(scopedRows.map((row) => Number(row.developmentStage ?? 0)))].sort((a, b) => a - b);
    if (this.stage !== "all" && !stages.some((stage) => String(stage) === this.stage)) this.stage = "all";
    const categoryCounts = new Map([["all", scopedRows.length]]);
    for (const row of scopedRows) {
      const id = String(row.templateCategory ?? row.primaryDev);
      categoryCounts.set(id, (categoryCounts.get(id) ?? 0) + 1);
    }
    let availableCount = 0;
    let lockedCount = 0;
    for (const row of publicRows) {
      if (row.unlocked) availableCount += 1;
      else lockedCount += 1;
    }
    let rows = filterTemplateRows(scopedRows, this).map((row) => ({ ...row, searchText: templateSearchText(row) }));
    const matching = rows.filter((row) => row.searchText.includes(normalizeTemplateSearch(this.search).trim()));
    const selected = matching.find((row) => String(row.id) === this.selectedId) ?? matching[0];
    this.selectedId = String(selected?.id ?? "");
    rows = rows.map((row) => ({ ...row, selected: String(row.id) === this.selectedId, ...templateListPresentation(row) }));

    const tabs = [
      ["all", "Все", "fa-solid fa-layer-group"],
      ["food", "Еда", "fa-solid fa-utensils"],
      ["technology", "Технология", "fa-solid fa-wrench"],
      ["culture", "Культура", "fa-solid fa-music"],
      ["war", "Война", "fa-solid fa-shield-halved"],
      ["housing", "Жилье", "fa-solid fa-house"],
      ["storage", "Склады", "fa-solid fa-box-archive"]
    ].map(([id, label, icon]) => {
      const tabCount = categoryCounts.get(id) ?? 0;
      return { id, label, icon, active: this.category === id, count: tabCount, tabCount };
    });
    const availabilitySource = [["all", "Все"], ["available", "Можно начать"], ["locked", "Не хватает условий"], ["built", "Построено"]];
    if (canEdit) availabilitySource.push(["hidden", `Скрытые ${hiddenRows.length}`]);
    const availabilityTabs = availabilitySource.map(([id, label]) => ({ id, label, active: this.availability === id }));
    const canCreateProject = holdingPermissionContext(holding).canEditBuildings;
    return {
      ...context,
      holding,
      hasHolding: Boolean(holding),
      rows,
      selected: templatePassport(selected, canEdit ? [...publicRows, ...hiddenRows] : publicRows,
        selected ? manager?._prepareProductionLines?.(selected, selected._index, holding, null, -1, `catalog.buildings.${selected._index}`, { includeEditorOptions: false }) : []),
      detailOpen: this.detailOpen,
      purposeOptions: [["all", "Любое назначение"], ["production", "Производство"], ["income", "Доход"], ["housing", "Жильё"], ["storage", "Хранение"], ["defense", "Оборона"], ["culture", "Культура"]].map(([id, label]) => ({ id, label, selected: id === this.purpose })),
      stageOptions: stages.map((id) => ({ id, selected: String(id) === this.stage })),
      sortByStage: this.sort === "stage",
      search: this.search,
      searchExpanded: this.searchOpen,
      hasRows: rows.length > 0,
      tabs,
      availabilityTabs,
      availableCount,
      lockedCount,
      hiddenCount: hiddenRows.length,
      development: catalog.development,
      canEdit,
      canCreateProject
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    this._syncDevelopmentHeader(root);
    bindFloatingTooltips(this, root);
    bindDelegatedActions(this, root, TEMPLATE_BROWSER_ACTIONS);
    root.querySelectorAll("[data-template-visibility]").forEach((checkbox) => checkbox.addEventListener("change", (event) => this._onTemplateVisibility(event)));
    root.querySelectorAll("[data-template-search]").forEach((field) => field.addEventListener("input", (event) => this._onSearch(event)));
    const searchDisclosure = root.querySelector("[data-template-search-disclosure]");
    searchDisclosure?.addEventListener("toggle", () => {
      this.searchOpen = searchDisclosure.open;
      if (searchDisclosure.open && searchDisclosure.contains(document.activeElement)) searchDisclosure.querySelector("input")?.focus();
    });
    root.querySelectorAll("[data-template-filter]").forEach((field) => field.addEventListener("change", (event) => {
      const key = event.currentTarget.dataset.templateFilter;
      if (!["purpose", "stage", "sort"].includes(key)) return;
      rememberApplicationFocusReturn(this, event.currentTarget);
      this[key] = event.currentTarget.value;
      this.requestRender();
    }));
    restoreApplicationFocus(this, { root });
    if (this._focusTemplateId) {
      const back = root.querySelector('[data-action="template-list"]');
      const target = this.detailOpen && back?.getClientRects().length ? back
        : [...root.querySelectorAll('[data-action="select-template"]')].find((button) => button.dataset.templateId === this._focusTemplateId);
      target?.focus({ preventScroll: true });
      this._focusTemplateId = null;
    }
    this._applySearchFilter(root, this.search);
  }

  _syncDevelopmentHeader(root) {
    const frame = windowFrameForElement(root) ?? root;
    const header = frame.querySelector?.(".window-header");
    const stats = root.querySelector(".fbls-template-browser-body [data-template-header-development]");
    if (!header || !stats) return;
    header.querySelectorAll("[data-template-header-development]").forEach((node) => node.remove());
    const title = header.querySelector(".window-title");
    if (title) title.after(stats);
    else header.append(stats);
  }

  _onSelectTemplate(event) {
    event.preventDefault();
    this.selectedId = String(event.currentTarget.dataset.templateId ?? "");
    this._focusTemplateId = this.selectedId;
    this.detailOpen = true;
    this.requestRender();
  }

  _onTemplateList(event) {
    event.preventDefault();
    this.detailOpen = false;
    this._focusTemplateId = this.selectedId;
    this.requestRender();
  }

  _onCategory(event) {
    event.preventDefault();
    rememberApplicationFocusReturn(this, event.currentTarget);
    this.category = String(event.currentTarget?.dataset?.templateCategory ?? "all");
    this.requestRender();
  }

  _onAvailability(event) {
    event.preventDefault();
    rememberApplicationFocusReturn(this, event.currentTarget);
    this.availability = String(event.currentTarget?.dataset?.templateAvailability ?? "all");
    this.requestRender();
  }

  _onSearch(event) {
    event.stopPropagation();
    this.search = String(event.currentTarget?.value ?? "");
    this._applySearchFilter(this.element, this.search);
  }

  _applySearchFilter(root = this.element, value = "") {
    const search = normalizeTemplateSearch(value).trim();
    const disclosure = root?.querySelector?.("[data-template-search-disclosure]");
    disclosure?.classList.toggle("has-query", Boolean(search));
    const summary = disclosure?.querySelector("summary");
    if (summary) summary.title = search ? `Поиск: ${value}` : "Поиск по названию, функции или материалу";
    const cards = Array.from(root?.querySelectorAll?.("[data-template-search-row]") ?? []);
    let visible = 0;
    for (const card of cards) {
      const show = !search || String(card.dataset.templateSearchRow ?? "").includes(search);
      if (card.hidden !== !show) card.hidden = !show;
      if (show) visible += 1;
    }
    const empty = root?.querySelector?.("[data-template-search-empty]");
    if (empty) empty.hidden = !search || visible > 0 || cards.length === 0;
    const count = root?.querySelector?.("[data-template-result-count]");
    if (count) count.textContent = String(visible);
    const selectedVisible = cards.some((card) => !card.hidden && card.dataset.templateId === this.selectedId);
    const detail = root?.querySelector?.("[data-template-passport]");
    if (detail) detail.hidden = !selectedVisible;
    const prompt = root?.querySelector?.("[data-template-select-prompt]");
    if (prompt) prompt.hidden = selectedVisible;
    return visible;
  }

  async _onCreateTemplate(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;

    const template = await SkyholdData.transaction((data) => {
      if (!data.catalog || typeof data.catalog !== "object") data.catalog = {};
      if (!Array.isArray(data.catalog.buildings)) data.catalog.buildings = [];
      const created = makeBlankBuildingTemplate(data.catalog.buildings.length + 1);
      data.catalog.buildings.push(created);
      return created;
    }, { reason: "template-browser:create-template", scope: "catalog" });

    this.category = "all";
    this.availability = "all";
    this.requestRender();
    new SkyholdBuildingTemplateEditor({ holdingId: this.holdingId, templateId: template.id }).render({ force: true, focus: true });
  }

  async _onEditTemplate(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    const templateId = String(event.currentTarget?.dataset?.templateId ?? "");
    if (!templateId) return;
    const template = (SkyholdData.get().catalog?.buildings ?? []).find((item) => String(item.id) === templateId);
    const uniqueRegistration = template ? resolveUniqueBuilding(template) : null;
    if (uniqueRegistration?.appClass) {
      const EditorClass = uniqueTemplateEditorClassFor(uniqueRegistration.appClass);
      new EditorClass({ holdingId: this.holdingId, templateId }).render({ force: true, focus: true });
      return;
    }
    new SkyholdBuildingTemplateEditor({ holdingId: this.holdingId, templateId }).render({ force: true, focus: true });
  }

  async _onTemplateVisibility(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    const templateId = String(event.currentTarget?.dataset?.templateVisibility ?? "");
    if (!templateId) return;
    const visibility = event.currentTarget.checked ? "public" : "gm";
    const updated = await SkyholdData.transaction((data) => {
      const template = (data.catalog?.buildings ?? []).find((item) => String(item.id) === templateId);
      if (!template) return SkyholdData.skipTransaction(false);
      template.visibility = visibility;
      return true;
    }, { reason: "template-browser:set-visibility", scope: "catalog" });
    if (!updated) return;
    this.requestRender();
  }

  async _confirmDeleteTemplate(template = {}) {
    const name = String(template?.name ?? "шаблон");
    const content = `<p>Удалить шаблон «${escapeHtml(name)}»?</p><p class="fbls-muted-text">Постройки и проекты, уже созданные из него, не удалятся.</p>`;
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (DialogV2?.confirm) {
      try {
        return await DialogV2.confirm({
          window: { title: "Удалить шаблон" },
          content,
          yes: { label: "Удалить" },
          no: { label: "Отмена" },
          rejectClose: false
        });
      } catch (error) {
        console.warn("FBL Skyhold | DialogV2 confirm failed, falling back to window.confirm", error);
      }
    }
    return globalThis.window?.confirm?.(`Удалить шаблон «${name}»?`) ?? false;
  }

  async _onDeleteTemplate(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    const templateId = String(event.currentTarget?.dataset?.templateId ?? "");
    if (!templateId) return;
    const data = SkyholdData.get();
    const templates = Array.isArray(data.catalog?.buildings) ? data.catalog.buildings : [];
    const index = templates.findIndex((item) => String(item.id) === templateId);
    if (index < 0) return;
    const template = templates[index];
    const confirmed = await this._confirmDeleteTemplate(template);
    if (!confirmed) return;
    const deleted = await SkyholdData.transaction((freshData) => {
      const freshTemplates = Array.isArray(freshData.catalog?.buildings) ? freshData.catalog.buildings : [];
      const freshIndex = freshTemplates.findIndex((item) => String(item.id) === templateId);
      if (freshIndex < 0) return SkyholdData.skipTransaction(null);
      const [removed] = freshTemplates.splice(freshIndex, 1);
      return { name: removed?.name || templateId };
    }, { reason: "template-browser:delete-template", scope: "catalog" });
    if (!deleted) return;
    this.requestRender();
    requestSkyholdAppRender();
    ui.notifications.info(`Шаблон «${deleted.name}» удален.`);
  }

  async _onCreateBuildingFromTemplate(event) {
    event.preventDefault();
    event.stopPropagation();
    const manager = getActiveSkyholdManager({ warn: true });
    if (!manager?._canEditBuildings?.()) return;
    const templateId = String(event.currentTarget?.dataset?.templateId ?? "");
    if (!templateId) return;
    const { holding: targetHolding } = findReadableHoldingEntry(SkyholdData.get(), this.holdingId, { fallback: false });
    if (!targetHolding) {
      warnNoHoldingAccess();
      this.requestRender();
      return;
    }
    const result = await SkyholdData.updateHolding(this.holdingId, (holding, data) => {
      const template = (data.catalog?.buildings ?? []).find((item) => String(item.id) === templateId);
      if (!holding || !template) return SkyholdData.skipTransaction({ ok: false, message: "Шаблон здания не найден." });
      const templateState = manager._buildingTemplateContext?.(holding, data)?.rows?.find((row) => String(row.id) === templateId);
      if (templateState && templateState.playerVisible === false && !game.user?.isGM) {
        return SkyholdData.skipTransaction({ ok: false, message: "Шаблон скрыт ГМом." });
      }
      if (templateState && !templateState.unlocked) {
        return SkyholdData.skipTransaction({ ok: false, message: `Шаблон закрыт: ${templateState.reasonText || "требования не выполнены"}.` });
      }
      // Материалы больше не списываются при создании blueprint-проекта.
      // Их можно довезти позже, пока проект уже виден в списке строительства.
      if (!holding.buildings) holding.buildings = { list: [] };
      if (!Array.isArray(holding.buildings.list)) holding.buildings.list = [];
      const id = makeId("b", 12);
      const building = manager._buildingFromTemplate(template, id);
      building.visibility = "public";
      holding.buildings.list.push(building);
      return { ok: true, holdingId: holding.id, buildingId: id, buildingName: building.name };
    }, { fallback: false, reason: "template-browser:create-building-from-template" });
    if (!result) {
      warnNoHoldingAccess();
      this.requestRender();
      return;
    }
    if (!result.ok) { ui.notifications.warn(result.message); return; }
    manager.activeHoldingId = result.holdingId;
    manager.activeTab = "buildings";
    manager.expandedBuildingId = result.buildingId;
    requestSkyholdAppRender();
    this.requestRender();
    ui.notifications.info(`${result.buildingName} добавлено в проекты строительства.`);
  }

  async _onClose(options) {
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = null;
    await super._onClose(options);
    unbindDelegatedActions(this);
    hideFloatingTooltip(this);
    if (SkyholdBuildingTemplateBrowser.instance === this) SkyholdBuildingTemplateBrowser.instance = null;
  }
}

SkyholdBuildingTemplateBrowser.DEFAULT_OPTIONS = {
  classes: ["fbl-skyhold", "fbl-skyhold-template-browser"],
  tag: "section",
  window: {
    title: "Шаблоны",
    icon: "fa-solid fa-drafting-compass",
    resizable: true
  },
  position: {
    width: 1180,
    height: 780
  }
};
SkyholdBuildingTemplateBrowser.PARTS = {
  body: { template: `modules/${MODULE_ID}/templates/building-template-browser.hbs` }
};
SkyholdBuildingTemplateBrowser.instance = null;
