import { MODULE_ID, SkyholdData } from "../../data/store.js";
import { findReadableHoldingEntry } from "../../data/access-guard.js";
import { fieldValue } from "../../core/helpers.js";
import { getSkyholdManager } from "../registry.js";
import { SkyholdBuildingEditor } from "./building-editor.js";
import { makeBlankBuildingTemplate } from "./helpers.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function getActiveSkyholdManager({ warn = false } = {}) {
  const manager = getSkyholdManager();
  if (!manager && warn) ui.notifications?.warn?.("FBL Skyhold manager is closed. Open it before using this editor action.");
  return manager;
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
    const { holding, index: holdingIndex } = findReadableHoldingEntry(data, this.holdingId, { fallback: true });
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
    SkyholdBuildingTemplateBrowser.instance?.render?.({ force: true, focus: false });
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

export class SkyholdBuildingTemplateBrowser extends HandlebarsApplicationMixin(ApplicationV2) {
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
    const { holding } = findReadableHoldingEntry(data, this.holdingId, { fallback: true });
    const manager = getActiveSkyholdManager();
    const canEdit = Boolean(game.user?.isGM);
    const catalog = manager?._buildingTemplateContext?.(holding, data) ?? { rows: [], availableCount: 0, lockedCount: 0, hiddenCount: 0 };
    const publicRows = catalog.publicRows ?? (catalog.rows ?? []).filter((row) => row.playerVisible !== false && row.visibility !== "gm");
    const hiddenRows = catalog.hiddenRows ?? (catalog.rows ?? []).filter((row) => row.playerVisible === false || row.visibility === "gm");
    if (!canEdit && this.availability === "hidden") this.availability = "all";
    const scopedRows = canEdit && this.availability === "hidden" ? hiddenRows : publicRows;
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

    const categoryCount = (id) => id === "all" ? scopedRows.length : scopedRows.filter((row) => String(row.templateCategory ?? row.primaryDev) === id).length;
    const tabs = [
      ["all", "Все", "fa-solid fa-layer-group"],
      ["food", "Еда", "fa-solid fa-utensils"],
      ["technology", "Технология", "fa-solid fa-wrench"],
      ["culture", "Культура", "fa-solid fa-music"],
      ["war", "Война", "fa-solid fa-shield-halved"],
      ["housing", "Жилье", "fa-solid fa-house"],
      ["storage", "Склады", "fa-solid fa-box-archive"]
    ].map(([id, label, icon]) => {
      const tabCount = categoryCount(id);
      return { id, label, icon, active: this.category === id, count: tabCount, tabCount };
    });
    const availabilitySource = [["all", "Все"], ["available", "Доступные"], ["locked", "Закрытые"]];
    if (canEdit) availabilitySource.push(["hidden", `Скрытые ${hiddenRows.length}`]);
    const availabilityTabs = availabilitySource.map(([id, label]) => ({ id, label, active: this.availability === id }));
    const canCreateProject = Boolean(game.user?.isGM || holding?.gm?.playersCanEditBuildings === true);
    return {
      ...context,
      holding,
      rows,
      search: this.search,
      hasRows: rows.length > 0,
      tabs,
      availabilityTabs,
      availableCount: publicRows.filter((row) => row.unlocked).length,
      lockedCount: publicRows.filter((row) => !row.unlocked).length,
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
    this._bindFloatingTooltips(root);
    root.querySelectorAll("[data-template-category]").forEach((button) => button.addEventListener("click", (event) => this._onCategory(event)));
    root.querySelectorAll("[data-template-availability]").forEach((button) => button.addEventListener("click", (event) => this._onAvailability(event)));
    root.querySelectorAll("[data-action='create-building-from-template']").forEach((button) => button.addEventListener("click", (event) => this._onCreateBuildingFromTemplate(event)));
    root.querySelectorAll("[data-action='create-building-template']").forEach((button) => button.addEventListener("click", (event) => this._onCreateTemplate(event)));
    root.querySelectorAll("[data-action='edit-building-template']").forEach((button) => button.addEventListener("click", (event) => this._onEditTemplate(event)));
    root.querySelectorAll("[data-action='delete-building-template']").forEach((button) => button.addEventListener("click", (event) => this._onDeleteTemplate(event)));
    root.querySelectorAll("[data-template-visibility]").forEach((checkbox) => checkbox.addEventListener("change", (event) => this._onTemplateVisibility(event)));
    root.querySelectorAll("[data-template-search]").forEach((field) => field.addEventListener("input", (event) => this._onSearch(event)));
  }

  _bindFloatingTooltips(root) {
    root.querySelectorAll("[data-fbls-tooltip]").forEach((element) => {
      element.addEventListener("mouseenter", (event) => this._showTooltip(event.currentTarget));
      // Не привязываем mousemove на каждую карточку: позиция считается при входе.
      element.addEventListener("mouseleave", () => this._hideTooltip());
    });
  }

  _showTooltip(element) {
    const text = String(element?.dataset?.fblsTooltip ?? "").trim();
    if (!text) return;
    this._hideTooltip();
    const tooltip = document.createElement("div");
    tooltip.className = "fbls-floating-tooltip";
    tooltip.textContent = text;
    document.body.appendChild(tooltip);
    this._activeTooltip = tooltip;
    this._positionTooltip(element);
  }

  _positionTooltip(element) {
    const tooltip = this._activeTooltip;
    if (!tooltip || !element) return;
    const rect = element.getBoundingClientRect();
    const margin = 10;
    const maxLeft = window.innerWidth - tooltip.offsetWidth - margin;
    let left = rect.left + rect.width / 2 - tooltip.offsetWidth / 2;
    left = Math.max(margin, Math.min(maxLeft, left));
    let top = rect.top - tooltip.offsetHeight - margin;
    if (top < margin) top = rect.bottom + margin;
    top = Math.max(margin, Math.min(window.innerHeight - tooltip.offsetHeight - margin, top));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  _hideTooltip() {
    this._activeTooltip?.remove?.();
    this._activeTooltip = null;
  }

  _onCategory(event) {
    event.preventDefault();
    this.category = String(event.currentTarget?.dataset?.templateCategory ?? "all");
    this.render({ force: true, focus: false });
  }

  _onAvailability(event) {
    event.preventDefault();
    this.availability = String(event.currentTarget?.dataset?.templateAvailability ?? "all");
    this.render({ force: true, focus: false });
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

    const data = SkyholdData.get();
    if (!data.catalog || typeof data.catalog !== "object") data.catalog = {};
    if (!Array.isArray(data.catalog.buildings)) data.catalog.buildings = [];

    const template = makeBlankBuildingTemplate(data.catalog.buildings.length + 1);
    data.catalog.buildings.push(template);
    await SkyholdData.set(data);

    this.category = "all";
    this.availability = "all";
    this.render({ force: true, focus: false });
    new SkyholdBuildingTemplateEditor({ holdingId: this.holdingId, templateId: template.id }).render({ force: true, focus: true });
  }

  async _onEditTemplate(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    const templateId = String(event.currentTarget?.dataset?.templateId ?? "");
    if (!templateId) return;
    new SkyholdBuildingTemplateEditor({ holdingId: this.holdingId, templateId }).render({ force: true, focus: true });
  }

  async _onTemplateVisibility(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    const templateId = String(event.currentTarget?.dataset?.templateVisibility ?? "");
    if (!templateId) return;
    const data = SkyholdData.get();
    const template = (data.catalog?.buildings ?? []).find((item) => String(item.id) === templateId);
    if (!template) return;
    template.visibility = event.currentTarget.checked ? "public" : "gm";
    await SkyholdData.set(data);
    this.render({ force: true, focus: false });
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
    templates.splice(index, 1);
    await SkyholdData.set(data);
    this.render({ force: true, focus: false });
    getSkyholdManager()?.render?.({ force: true, focus: false });
    ui.notifications.info(`Шаблон «${template?.name || templateId}» удален.`);
  }

  async _onCreateBuildingFromTemplate(event) {
    event.preventDefault();
    event.stopPropagation();
    const manager = getActiveSkyholdManager({ warn: true });
    if (!manager?._canEditBuildings?.()) return;
    const templateId = String(event.currentTarget?.dataset?.templateId ?? "");
    if (!templateId) return;
    const data = SkyholdData.get();
    const { holding } = findReadableHoldingEntry(data, this.holdingId, { fallback: true });
    const template = (data.catalog?.buildings ?? []).find((item) => String(item.id) === templateId);
    if (!holding || !template) { ui.notifications.warn("Шаблон здания не найден."); return; }
    const templateState = manager._buildingTemplateContext?.(holding, data)?.rows?.find((row) => String(row.id) === templateId);
    if (templateState && templateState.playerVisible === false && !game.user?.isGM) {
      ui.notifications.warn("Шаблон скрыт ГМом.");
      return;
    }
    if (templateState && !templateState.unlocked) {
      ui.notifications.warn(`Шаблон закрыт: ${templateState.reasonText || "требования не выполнены"}.`);
      return;
    }
    // Материалы больше не списываются при создании blueprint-проекта.
    // Их можно довезти позже, пока проект уже виден в списке строительства.
    if (!holding.buildings) holding.buildings = { list: [] };
    if (!Array.isArray(holding.buildings.list)) holding.buildings.list = [];
    const id = foundry.utils.randomID?.(12) ?? `b-${Date.now()}`;
    const building = manager._buildingFromTemplate(template, id);
    holding.buildings.list.push(building);
    await SkyholdData.set(data);
    manager.activeHoldingId = holding.id;
    manager.activeTab = "buildings";
    manager.expandedBuildingId = id;
    manager.render?.({ force: true, focus: false });
    this.render({ force: true, focus: false });
    ui.notifications.info(`${building.name} добавлено в проекты строительства.`);
  }

  async _onClose(options) {
    await super._onClose(options);
    this._hideTooltip();
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
