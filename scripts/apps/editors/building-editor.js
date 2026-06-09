import { MODULE_ID, SkyholdData } from "../../data/store.js";
import { findReadableHoldingEntry } from "../../data/access-guard.js";
import { fieldValue, joinList, splitList } from "../../core/helpers.js";
import { getSkyholdAppClass, getSkyholdManager } from "../registry.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function getActiveSkyholdManager({ warn = false } = {}) {
  const manager = getSkyholdManager();
  if (!manager && warn) ui.notifications?.warn?.("FBL Skyhold manager is closed. Open it before using this editor action.");
  return manager;
}

export class SkyholdBuildingEditor extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor({ holdingId, buildingId } = {}, options = {}) {
    super(options);
    this.holdingId = holdingId;
    this.buildingId = buildingId;
    this.activeTab = "main";
    this.editDevGain = false;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const data = SkyholdData.get();
    const { holding, index: holdingIndex } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
    const buildingIndex = (holding?.buildings?.list ?? []).findIndex((item) => item.id === this.buildingId);
    const building = buildingIndex >= 0 ? holding.buildings.list[buildingIndex] : null;
    const manager = getActiveSkyholdManager();
    const canEdit = Boolean(game.user?.isGM || holding?.gm?.playersCanEditBuildings === true);
    const row = building && manager ? manager._prepareBuildingRow(holding, building, buildingIndex, canEdit) : null;
    if (row) this._prepareEditorTabs(row);

    return {
      ...context,
      canEdit,
      holding,
      holdingIndex,
      building: row,
      buildingIndex,
      hasBuilding: Boolean(row),
      editDevGain: this.editDevGain,
      constructionCrew: manager?._constructionCrew?.(holding) ?? { count: 0, dice: 0, names: "" },
      development: manager?._developmentSummary?.(holding) ?? null
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;

    this._bindInputGuards(root);
    this._bindGlobalInputGuard(root);
    this._bindFloatingTooltips(root);
    this._autosizeTextareas(root);

    root.querySelectorAll("[data-field]").forEach((field) => {
      field.addEventListener("change", (event) => this._onFieldChange(event));
    });

    root.querySelectorAll("[data-building-worker-field]").forEach((field) => {
      field.addEventListener("change", (event) => this._onBuildingWorkerChange(event));
    });

    root.querySelectorAll("[data-building-housing-field]").forEach((field) => {
      field.addEventListener("change", (event) => this._onBuildingHousingChange(event));
    });

    this._bindActionButtons(root);

    root.querySelectorAll("[data-suitable-type-add-field]").forEach((field) => {
      field.addEventListener("change", (event) => this._onSuitableTypeAddChange(event));
    });
  }

  _canEditBuilding() {
    if (game.user?.isGM) return true;
    const data = SkyholdData.get();
    const { holding } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
    return Boolean(holding?.gm?.playersCanEditBuildings === true);
  }

  _prepareEditorTabs(building) {
    const isMedical = Boolean(building?.isMedicalBuilding);
    const isSpecial = Boolean(building?.isSpecialBuilding);
    const tabs = [
      { id: "main", label: "Основное", icon: "fa-solid fa-sliders" },
      { id: "workers", label: isMedical ? "Врачи" : "Работники", icon: "fa-solid fa-users-gear" },
      { id: "construction", label: "Строительство", icon: "fa-solid fa-hammer" }
    ];
    if (building.showProductionBlock) tabs.push({ id: "production", label: "Производство", icon: "fa-solid fa-industry" });
    if (building.showIncomeBlock) tabs.push({ id: "income", label: "Доходность", icon: "fa-solid fa-coins" });
    if (building.showDefenseBlock) tabs.push({ id: "defense", label: "Оборона", icon: "fa-solid fa-shield-halved" });
    if (!isMedical && building.functions?.housing) tabs.push({ id: "housing", label: "Жилое", icon: "fa-solid fa-house" });
    if (building.functions?.storage) tabs.push({ id: "storage", label: "Складское", icon: "fa-solid fa-box-archive" });
    if (building.functions?.culture) tabs.push({ id: "culture", label: "Культура/Религия", icon: "fa-solid fa-music" });
    if (!tabs.some((tab) => tab.id === this.activeTab)) this.activeTab = tabs[0]?.id ?? "main";
    building.editorTabs = tabs.map((tab) => ({ ...tab, active: tab.id === this.activeTab }));
    building.showMedicalEditor = isMedical && this.activeTab === "workers";
    if (isMedical) {
      building.showEditorMain = this.activeTab === "main";
      building.showEditorWorkers = false;
      building.showEditorConstruction = this.activeTab === "construction";
      building.showEditorProduction = false;
      building.showEditorIncome = false;
      building.showEditorDefense = false;
      building.showEditorHousing = false;
      building.showEditorStorage = false;
      building.showEditorCulture = false;
      building.showEditorText = false;
      return;
    }
    if (isSpecial) {
      building.showEditorMain = false;
      building.showEditorWorkers = false;
      building.showEditorConstruction = !building.isBuilt;
      building.showEditorProduction = false;
      building.showEditorIncome = false;
      building.showEditorDefense = false;
      building.showEditorHousing = false;
      building.showEditorStorage = false;
      building.showEditorCulture = false;
      building.showEditorText = false;
      return;
    }
    building.showEditorMain = this.activeTab === "main";
    building.showEditorWorkers = this.activeTab === "workers";
    building.showEditorConstruction = this.activeTab === "construction";
    building.showEditorProduction = this.activeTab === "production";
    building.showEditorIncome = this.activeTab === "income";
    building.showEditorDefense = this.activeTab === "defense";
    building.showEditorHousing = this.activeTab === "housing";
    building.showEditorStorage = this.activeTab === "storage";
    building.showEditorCulture = this.activeTab === "culture";
    building.showEditorText = false;
  }

  _bindActionButtons(root) {
    const actionMap = {
      "building-editor-tab": "_onEditorTab",
      "toggle-dev-gain-editor": "_onToggleDevGainEditor",
      "roll-construction": "_onRollConstruction",
      "roll-construction-crew": "_onRollConstructionCrew",
      "remove-suitable-type": "_onRemoveSuitableType",
      "add-building-material": "_onAddBuildingMaterial",
      "delete-building-material": "_onDeleteBuildingMaterial",
      "add-building-prerequisite": "_onAddBuildingPrerequisite",
      "delete-building-prerequisite": "_onDeleteBuildingPrerequisite",
      "add-production-line": "_onAddProductionLine",
      "delete-production-line": "_onDeleteProductionLine",
      "add-building-content": "_onAddBuildingContent",
      "delete-building-content": "_onDeleteBuildingContent",
      "collect-production-line": "_onCollectProductionLine",
      "pick-building-image": "_onPickBuildingImage",
      "clear-building-image": "_onClearBuildingImage"
    };
    root.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", (event) => {
        const method = actionMap[event.currentTarget?.dataset?.action];
        if (!method || typeof this[method] !== "function") return;
        this[method](event);
      });
    });
  }

  _onEditorTab(event) {
    event.preventDefault();
    event.stopPropagation();
    const next = String(event.currentTarget?.dataset?.editorTab ?? "");
    if (!next || next === this.activeTab) return;
    this.activeTab = next;
    this.render({ force: true, focus: false });
  }

  _onToggleDevGainEditor(event) {
    event.preventDefault();
    event.stopPropagation();
    this.editDevGain = !this.editDevGain;
    this.render({ force: true, focus: false });
  }

  _bindInputGuards(root) {
    const stop = (event) => event.stopPropagation();
    const sanitizeTabs = (event) => {
      const field = event.currentTarget;
      if (!(field instanceof HTMLTextAreaElement)) return;
      const value = String(field.value ?? "");
      if (!value.includes("	")) return;
      const start = field.selectionStart;
      const end = field.selectionEnd;
      const beforeTabs = value.slice(0, start).split("	").length - 1;
      const beforeEndTabs = value.slice(0, end).split("	").length - 1;
      field.value = value.replace(/	/g, "  ");
      field.selectionStart = Math.max(0, start + beforeTabs);
      field.selectionEnd = Math.max(0, end + beforeEndTabs);
    };
    root.querySelectorAll("input, textarea, select").forEach((field) => {
      if (field instanceof HTMLTextAreaElement) {
        field.addEventListener("input", sanitizeTabs);
        field.addEventListener("paste", () => setTimeout(() => sanitizeTabs({ currentTarget: field }), 0));
      }
      for (const eventName of ["keydown", "keyup", "keypress", "input", "beforeinput", "paste", "copy", "cut", "mousedown", "mouseup", "click", "dblclick"]) {
        field.addEventListener(eventName, stop, { capture: true });
        field.addEventListener(eventName, stop);
      }
    });
  }


  _autosizeTextareas(root) {
    const resize = (field) => {
      if (!(field instanceof HTMLTextAreaElement)) return;
      field.style.height = "auto";
      field.style.height = `${Math.max(64, field.scrollHeight + 2)}px`;
    };
    root.querySelectorAll("textarea").forEach((field) => {
      resize(field);
      field.addEventListener("input", () => resize(field));
      field.addEventListener("change", () => resize(field));
    });
  }

  _bindGlobalInputGuard(root) {
    this._unbindGlobalInputGuard();
    const editableSelector = "input, textarea, select, [contenteditable='true']";
    this._globalInputGuard = (event) => {
      const target = event.target;
      const active = document.activeElement;
      const targetInside = target instanceof Element && root.contains(target);
      const activeInside = active instanceof Element && root.contains(active);
      const targetEditable = target instanceof Element && Boolean(target.closest(editableSelector));
      const activeEditable = active instanceof Element && Boolean(active.closest(editableSelector));
      if ((targetInside && targetEditable) || (activeInside && activeEditable)) event.stopImmediatePropagation();
    };
    for (const eventName of ["keydown", "keyup", "keypress"]) window.addEventListener(eventName, this._globalInputGuard, true);
  }

  _unbindGlobalInputGuard() {
    if (!this._globalInputGuard) return;
    for (const eventName of ["keydown", "keyup", "keypress"]) window.removeEventListener(eventName, this._globalInputGuard, true);
    this._globalInputGuard = null;
  }

  async _onClose(options) {
    await super._onClose(options);
    this._hideTooltip?.();
    this._unbindGlobalInputGuard();
    getSkyholdAppClass()?.instance?.render({ force: true, focus: false });
  }

  async _onFieldChange(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;

    const field = event.currentTarget;
    const path = field.dataset.field;
    if (!path) return;

    const value = fieldValue(field);

    try {
      if (/\.functions\.culture$/.test(path) && value === false) {
        const data = SkyholdData.get();
        foundry.utils.setProperty(data, path, false);
        foundry.utils.setProperty(data, path.replace(/\.functions\.culture$/, ".religion.religious"), false);
        await SkyholdData.set(data);
      } else {
        await SkyholdData.update(path, value);
      }
      const shouldRefresh = /workersMax|workersMin|constructionStatus|requiredBuildingIds|materialCosts|contents|type$|functions|productionLines|expenseMode|autoCollect|income|defense|requirements|bonuses|suitableWorkerTypes|workerTypeEffects|religion|\.img$|\.image$|icon$/.test(path);
      if (shouldRefresh) this.render({ force: true, focus: false });
    } catch (error) {
      console.error("FBL Skyhold | Failed to update building field", error);
      ui.notifications.error("Не удалось сохранить поле постройки. Подробности в консоли.");
    }
  }

  async _onBuildingWorkerChange(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const field = event.currentTarget;
    const path = field.dataset.buildingWorkerField;
    if (!path) return;
    const parts = path.match(/holdings\.(\d+)\.buildings\.list\.(\d+)\.assignedWorkerIds\.(\d+)$/);
    try {
      const data = SkyholdData.get();
      if (parts) {
        const holding = data.holdings[Number(parts[1])];
        const building = holding?.buildings?.list?.[Number(parts[2])];
        const manager = getActiveSkyholdManager({ warn: true });
        if (!manager) return;
        manager._setBuildingSlot(holding, building?.id, Number(parts[3]), field.value || "");
        await SkyholdData.set(data);
      } else {
        await SkyholdData.update(path, field.value || "");
      }
      this.render({ force: true, focus: false });
    } catch (error) {
      console.error("FBL Skyhold | Failed to assign building worker", error);
      ui.notifications.error("Не удалось назначить работника. Подробности в консоли.");
    }
  }

  async _onBuildingHousingChange(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const slot = Number(event.currentTarget?.dataset?.housingSlot);
    if (!Number.isFinite(slot)) return;
    const value = String(event.currentTarget?.value ?? "");
    try {
      const data = SkyholdData.get();
      const { holding, building } = this._getMutableBuilding(data);
      const manager = getActiveSkyholdManager({ warn: true });
      if (!holding || !building || !manager) return;
      manager._setHousingSlot(holding, building.id, slot, value);
      await SkyholdData.set(data);
      this.render({ force: true, focus: false });
      getSkyholdAppClass()?.instance?.render({ force: true, focus: false });
    } catch (error) {
      console.error("FBL Skyhold | Failed to assign housing slot", error);
      ui.notifications.error("Не удалось назначить жильца. Подробности в консоли.");
    }
  }

  async _onSuitableTypeAddChange(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const field = event.currentTarget;
    const path = field.dataset.suitableTypeAddField;
    const value = String(field.value ?? "").trim();
    if (!path || !value) return;
    try {
      const data = SkyholdData.get();
      const list = splitList(foundry.utils.getProperty(data, path));
      if (!list.some((item) => item.toLowerCase() === value.toLowerCase())) list.push(value);
      foundry.utils.setProperty(data, path, joinList(list));
      await SkyholdData.set(data);
      this.render({ force: true, focus: false });
    } catch (error) {
      console.error("FBL Skyhold | Failed to add suitable type", error);
      ui.notifications.error("Не удалось добавить подходящий тип. Подробности в консоли.");
    }
  }

  async _onRemoveSuitableType(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const button = event.currentTarget;
    const path = button.dataset.suitableTypesField;
    const value = String(button.dataset.suitableType ?? "").trim().toLowerCase();
    if (!path || !value) return;
    try {
      const data = SkyholdData.get();
      const list = splitList(foundry.utils.getProperty(data, path)).filter((item) => item.toLowerCase() !== value);
      foundry.utils.setProperty(data, path, joinList(list));
      await SkyholdData.set(data);
      this.render({ force: true, focus: false });
    } catch (error) {
      console.error("FBL Skyhold | Failed to remove suitable type", error);
      ui.notifications.error("Не удалось убрать подходящий тип. Подробности в консоли.");
    }
  }

  async _onPickBuildingImage(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!this._canEditBuilding()) return;
    const data = SkyholdData.get();
    const { building } = this._getMutableBuilding(data);
    if (!building) return;
    const Picker = globalThis.FilePicker ?? foundry?.applications?.apps?.FilePicker;
    if (!Picker) {
      ui.notifications.warn("FilePicker Foundry не найден.");
      return;
    }
    const current = String(building.img ?? building.image ?? "");
    new Picker({
      type: "image",
      current,
      callback: async (picked) => {
        try {
          const next = SkyholdData.get();
          const { building: nextBuilding } = this._getMutableBuilding(next);
          if (!nextBuilding) return;
          nextBuilding.img = String(picked ?? "");
          await SkyholdData.set(next);
          this.render({ force: true, focus: false });
          getSkyholdAppClass()?.instance?.render({ force: true, focus: false });
        } catch (error) {
          console.error("FBL Skyhold | Failed to set building image", error);
          ui.notifications.error("Не удалось сохранить картинку здания. Подробности в консоли.");
        }
      }
    }).render(true);
  }

  async _onClearBuildingImage(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!this._canEditBuilding()) return;
    const data = SkyholdData.get();
    const { building } = this._getMutableBuilding(data);
    if (!building) return;
    building.img = "";
    await SkyholdData.set(data);
    this.render({ force: true, focus: false });
    getSkyholdAppClass()?.instance?.render({ force: true, focus: false });
  }

  async _onAddBuildingMaterial(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const data = SkyholdData.get();
    const { building } = this._getMutableBuilding(data);
    if (!building) return;
    if (!Array.isArray(building.materialCosts)) building.materialCosts = [];
    building.materialCosts.push({ id: foundry.utils.randomID(12), name: "Материал", qty: 0 });
    await SkyholdData.set(data);
    this.render({ force: true, focus: false });
  }

  async _onDeleteBuildingMaterial(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const index = Number(event.currentTarget?.dataset?.index);
    if (!Number.isFinite(index)) return;
    const data = SkyholdData.get();
    const { building } = this._getMutableBuilding(data);
    if (!building || !Array.isArray(building.materialCosts)) return;
    building.materialCosts.splice(index, 1);
    await SkyholdData.set(data);
    this.render({ force: true, focus: false });
  }

  async _onAddBuildingPrerequisite(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const data = SkyholdData.get();
    const { building } = this._getMutableBuilding(data);
    if (!building) return;
    if (!Array.isArray(building.requiredBuildingIds)) building.requiredBuildingIds = [];
    building.requiredBuildingIds.push("");
    await SkyholdData.set(data);
    this.render({ force: true, focus: false });
  }

  async _onDeleteBuildingPrerequisite(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const index = Number(event.currentTarget?.dataset?.index);
    if (!Number.isFinite(index)) return;
    const data = SkyholdData.get();
    const { building } = this._getMutableBuilding(data);
    if (!building || !Array.isArray(building.requiredBuildingIds)) return;
    building.requiredBuildingIds.splice(index, 1);
    await SkyholdData.set(data);
    this.render({ force: true, focus: false });
  }


  async _onAddProductionLine(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const data = SkyholdData.get();
    const { building } = this._getMutableBuilding(data);
    if (!building) return;
    if (!Array.isArray(building.productionLines)) building.productionLines = [];
    if (!building.functions || typeof building.functions !== "object") building.functions = {};
    building.functions.production = true;
    building.productionLines.push({ id: foundry.utils.randomID?.(12) ?? `prod-${Date.now()}`, active: true, mode: "Новая линия", source: "workers", period: "day", contentId: "", resourceId: "wood", resource: "Древесина", outputQty: 1, workQd: 1, formula: "", expenses: "", requiresCollection: false, collectQd: 0, pendingQty: 0, storageRoomId: "outdoors", seasons: { spring: true, summer: true, autumn: true, winter: true } });
    await SkyholdData.set(data);
    this.render({ force: true, focus: false });
  }

  async _onDeleteProductionLine(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const index = Number(event.currentTarget?.dataset?.index);
    if (!Number.isFinite(index)) return;
    const data = SkyholdData.get();
    const { building } = this._getMutableBuilding(data);
    if (!building || !Array.isArray(building.productionLines)) return;
    building.productionLines.splice(index, 1);
    await SkyholdData.set(data);
    this.render({ force: true, focus: false });
  }

  async _onAddBuildingContent(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const data = SkyholdData.get();
    const { building } = this._getMutableBuilding(data);
    if (!building) return;
    if (!Array.isArray(building.contents)) building.contents = [];
    building.contents.push({ id: foundry.utils.randomID?.(12) ?? `content-${Date.now()}`, name: "Содержимое", qty: 0, capacity: 0, notes: "" });
    await SkyholdData.set(data);
    this.render({ force: true, focus: false });
  }

  async _onDeleteBuildingContent(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const index = Number(event.currentTarget?.dataset?.index);
    if (!Number.isFinite(index)) return;
    const data = SkyholdData.get();
    const { building } = this._getMutableBuilding(data);
    if (!building || !Array.isArray(building.contents)) return;
    const removed = building.contents[index];
    const removedId = String(removed?.id ?? "");
    building.contents.splice(index, 1);
    if (removedId && Array.isArray(building.productionLines)) {
      for (const line of building.productionLines) if (String(line.contentId ?? "") === removedId) line.contentId = "";
    }
    await SkyholdData.set(data);
    this.render({ force: true, focus: false });
  }

  async _onCollectProductionLine(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const index = Number(event.currentTarget?.dataset?.index);
    if (!Number.isFinite(index)) return;
    const data = SkyholdData.get();
    const { holding, building } = this._getMutableBuilding(data);
    const line = building?.productionLines?.[index];
    const manager = getActiveSkyholdManager({ warn: true });
    if (!holding || !building || !line || !manager) return;
    const result = manager._collectProductionLine(holding, building, line);
    await SkyholdData.set(data);
    this.render({ force: true, focus: false });
    getSkyholdAppClass()?.instance?.render({ force: true, focus: false });
    if (result?.ok) ui.notifications.info(result.message || "Ресурс собран.");
    else ui.notifications.warn(result?.message || "Нечего собирать.");
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
    if (this._activeTooltip) {
      this._activeTooltip.remove();
      this._activeTooltip = null;
    }
  }

  _getMutableBuilding(data = SkyholdData.get()) {
    const { holding, index: holdingIndex } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
    const buildingIndex = (holding?.buildings?.list ?? []).findIndex((item) => item.id === this.buildingId);
    const building = buildingIndex >= 0 ? holding.buildings.list[buildingIndex] : null;
    return { data, holding, holdingIndex, building, buildingIndex };
  }

  async _onRollConstructionCrew(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!this._canEditBuilding()) return;
    const manager = getActiveSkyholdManager({ warn: true });
    if (!manager) return;
    manager.activeHoldingId = this.holdingId;
    await manager._onRollConstructionCrew(event);
  }

  async _onRollConstruction(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!this._canEditBuilding()) return;
    const manager = getActiveSkyholdManager({ warn: true });
    if (!manager) return;
    manager.activeHoldingId = this.holdingId;
    await manager._onRollConstruction(event);
    this.render({ force: true, focus: false });
  }
}

SkyholdBuildingEditor.DEFAULT_OPTIONS = {
  classes: ["fbl-skyhold", "fbl-skyhold-building-editor"],
  tag: "section",
  window: {
    title: "Постройка",
    icon: "fa-solid fa-building",
    resizable: true
  },
  position: {
    width: 940,
    height: 500
  }
};
SkyholdBuildingEditor.PARTS = {
  body: {
    template: `modules/${MODULE_ID}/templates/building-editor.hbs`
  }
};
