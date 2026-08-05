import { MODULE_ID } from "../../data/constants.js";
import { SkyholdData } from "../../data/store.js";
import { makeId } from "../../data/utils.js";
import { findReadableHoldingEntry, warnNoHoldingAccess } from "../../data/access-guard.js";
import { holdingPermissionContext } from "../../data/holding-permissions.js";
import { getSkyholdManager, requestSkyholdAppRender } from "../registry.js";
import { bindDelegatedActions, unbindDelegatedActions } from "../common/delegated-events.js";
import { bindFloatingTooltips, hideFloatingTooltip } from "../common/floating-tooltip.js";
import { RenderSchedulerMixin } from "../common/render-scheduler.js";
import { resolveUniqueBuilding } from "../unique-buildings/registry.js";
import { SkyholdBuildingEditor } from "./building-editor.js";
import { makeBlankBuildingTemplate } from "./helpers.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const TEMPLATE_BROWSER_ACTIONS = {
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
    const context = await super._prepareContext(options);
    const data = SkyholdData.get();
    const templateIndex = game.user?.isGM ? (data.catalog?.buildings ?? []).findIndex((item) => String(item.id) === String(this.templateId)) : -1;
    const template = templateIndex >= 0 ? data.catalog.buildings[templateIndex] : null;
    const { holding, index: holdingIndex } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
    const manager = getActiveSkyholdManager();
    const row = template && manager ? manager._prepareBuildingRow(holding, template, templateIndex, true, [], { basePath: `catalog.buildings.${templateIndex}`, isTemplate: true }) : null;
    if (row) this._prepareEditorTabs(row);
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
    SkyholdBuildingTemplateBrowser.instance = this;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const data = SkyholdData.get();
    const { holding } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
    const manager = getActiveSkyholdManager();
    const canEdit = Boolean(game.user?.isGM);
    const catalog = manager?._buildingTemplateContext?.(holding, data) ?? { rows: [], availableCount: 0, lockedCount: 0, hiddenCount: 0 };
    const publicRows = catalog.publicRows ?? (catalog.rows ?? []).filter((row) => row.playerVisible !== false && row.visibility !== "gm");
    const hiddenRows = catalog.hiddenRows ?? (catalog.rows ?? []).filter((row) => row.playerVisible === false || row.visibility === "gm");
    if (!canEdit && this.availability === "hidden") this.availability = "all";
    const scopedRows = canEdit && this.availability === "hidden" ? hiddenRows : publicRows;
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
    let rows = scopedRows;
    if (this.category !== "all") rows = rows.filter((row) => String(row.templateCategory ?? row.primaryDev) === this.category);
    if (this.availability === "available") rows = rows.filter((row) => row.unlocked);
    if (this.availability === "locked") rows = rows.filter((row) => !row.unlocked);
    const normalizeSearch = (value) => String(value ?? "")
      .toLowerCase()
      .replace(/ё/g, "е")
      .normalize?.("NFKD")
      .replace(/[\u0300-\u036f]/g, "") ?? String(value ?? "").toLowerCase().replace(/ё/g, "е");
    const search = normalizeSearch(this.search).trim();
    if (search) {
      rows = rows.filter((row) => [
        row.name, row.label, row.type, row.description, row.primaryDevLabel, row.templateCategory,
        row.functionLabels, row.productionLinesText, row.specialRequirements, row.sourceRequirement
      ].map(normalizeSearch).some((value) => value.includes(search)));
    }

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
    const availabilitySource = [["all", "Все"], ["available", "Доступные"], ["locked", "Закрытые"]];
    if (canEdit) availabilitySource.push(["hidden", `Скрытые ${hiddenRows.length}`]);
    const availabilityTabs = availabilitySource.map(([id, label]) => ({ id, label, active: this.availability === id }));
    const canCreateProject = holdingPermissionContext(holding).canEditBuildings;
    return {
      ...context,
      holding,
      hasHolding: Boolean(holding),
      rows,
      search: this.search,
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
    bindFloatingTooltips(this, root);
    bindDelegatedActions(this, root, TEMPLATE_BROWSER_ACTIONS);
    root.querySelectorAll("[data-template-visibility]").forEach((checkbox) => checkbox.addEventListener("change", (event) => this._onTemplateVisibility(event)));
    root.querySelectorAll("[data-template-search]").forEach((field) => field.addEventListener("input", (event) => this._onSearch(event)));
  }

  _onCategory(event) {
    event.preventDefault();
    this.category = String(event.currentTarget?.dataset?.templateCategory ?? "all");
    this.requestRender();
  }

  _onAvailability(event) {
    event.preventDefault();
    this.availability = String(event.currentTarget?.dataset?.templateAvailability ?? "all");
    this.requestRender();
  }

  _onSearch(event) {
    event.stopPropagation();
    this.search = String(event.currentTarget?.value ?? "");
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => {
      this.render({ force: true, focus: true });
    }, 80);
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
    }, { reason: "template-browser:create-template" });

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
    }, { reason: "template-browser:set-visibility" });
    if (!updated) return;
    this.requestRender();
  }

  async _confirmDeleteTemplate(template = {}) {
    const name = String(template?.name ?? "шаблон");
    const content = `<p>Удалить шаблон «${foundry.utils.escapeHTML?.(name) ?? name}»?</p><p class="fbls-muted-text">Постройки и проекты, уже созданные из него, не удалятся.</p>`;
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
    }, { reason: "template-browser:delete-template" });
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
    title: "Шаблоны зданий",
    icon: "fa-solid fa-drafting-compass",
    resizable: true
  },
  position: {
    width: 1040,
    height: 720
  }
};
SkyholdBuildingTemplateBrowser.PARTS = {
  body: { template: `modules/${MODULE_ID}/templates/building-template-browser.hbs` }
};
SkyholdBuildingTemplateBrowser.instance = null;
