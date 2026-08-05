import { MODULE_ID } from "../../data/constants.js";
import { SkyholdData } from "../../data/store.js";
import { makeId } from "../../data/utils.js";
import { findReadableHoldingEntry } from "../../data/access-guard.js";
import { holdingPermissionContext } from "../../data/holding-permissions.js";
import { fieldValue, joinList, splitList } from "../../core/helpers.js";
import { bindGlobalInputGuard, bindInputGuards, replaceTabs, unbindGlobalInputGuard } from "../../utils/input-guards.js";
import { getSkyholdManager, requestSkyholdAppRender } from "../registry.js";
import { bindDelegatedActions, unbindDelegatedActions } from "../common/delegated-events.js";
import { bindFloatingTooltips, hideFloatingTooltip } from "../common/floating-tooltip.js";
import { WindowFrameMixin } from "../common/window-frame.js";
import { focusApplicationContent, restoreApplicationFocus } from "../common/window-focus-keeper.js";
import { RenderSchedulerMixin } from "../common/render-scheduler.js";
import {
  clearBuildingAudioTrack,
  pickBuildingAudioTrack,
  removeBuildingAudioTrackHeader,
  stopBuildingAudioTrack,
  syncBuildingAudioTrackHeader,
  syncBuildingAudioTrackPlayback
} from "../common/building-audio-track.js";
import { getMassCombatRelationTags } from "../mass-combat/tag-config.js";
import { renderFoundryFilePicker } from "../../integrations/foundry-runtime.js";
import { SkyholdResourceCatalogEditor } from "./resource-catalog-editor.js";
import { isLivestockResource, parseResourceCosts, resourceLabel, serializeResourceCosts } from "../../core/resources.js";
import { materialGroupOptions } from "../../core/material-groups.js";
import { fundEnterpriseCapital } from "../../data/enterprise-capital-funding.js";
import { isWholeEconomyQuantity } from "../../core/economy-quantity-contract.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const BUILDING_EDITOR_ACTIONS = {
  "building-editor-tab": "_onEditorTab",
  "toggle-dev-gain-editor": "_onToggleDevGainEditor",
  "roll-construction-crew": "_onRollConstructionCrew",
  "remove-suitable-type": "_onRemoveSuitableType",
  "add-building-material": "_onAddBuildingMaterial",
  "delete-building-material": "_onDeleteBuildingMaterial",
  "pick-building-material": "_onPickBuildingMaterial",
  "add-building-prerequisite": "_onAddBuildingPrerequisite",
  "delete-building-prerequisite": "_onDeleteBuildingPrerequisite",
  "add-production-line": "_onAddProductionLine",
  "delete-production-line": "_onDeleteProductionLine",
  "pick-production-resource": "_onPickProductionResource",
  "add-production-expense-resource": "_onAddProductionExpenseResource",
  "add-production-expense-group": "_onAddProductionExpenseGroup",
  "pick-production-expense-resource": "_onPickProductionExpenseResource",
  "delete-production-expense": "_onDeleteProductionExpense",
  "add-building-content": "_onAddBuildingContent",
  "delete-building-content": "_onDeleteBuildingContent",
  "take-livestock-from-storage": "_onTakeLivestockFromStorage",
  "return-livestock-to-storage": "_onReturnLivestockToStorage",
  "collect-production-line": "_onCollectProductionLine",
  "pick-building-image": "_onPickBuildingImage",
  "clear-building-image": "_onClearBuildingImage",
  "fund-enterprise-capital": "_onFundEnterpriseCapital"
};

function getActiveSkyholdManager({ warn = false } = {}) {
  const manager = getSkyholdManager();
  if (!manager && warn) ui.notifications?.warn?.("FBL Skyhold manager is closed. Open it before using this editor action.");
  return manager;
}

export class SkyholdBuildingEditor extends WindowFrameMixin(RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2))) {
  static instances = new Set();

  static rerenderOpen({ skipFocused = true } = {}) {
    for (const app of SkyholdBuildingEditor.instances) {
      const root = app.element;
      if (skipFocused && root && document.activeElement instanceof Element && root.contains(document.activeElement)) continue;
      app.requestRender?.();
    }
  }

  constructor({ holdingId, buildingId } = {}, options = {}) {
    super(options);
    this.holdingId = holdingId;
    this.buildingId = buildingId;
    this.activeTab = "main";
    this.editDevGain = false;
    SkyholdBuildingEditor.instances.add(this);
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const data = SkyholdData.get();
    const { holding, index: holdingIndex } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
    const buildingIndex = (holding?.buildings?.list ?? []).findIndex((item) => item.id === this.buildingId);
    const building = buildingIndex >= 0 ? holding.buildings.list[buildingIndex] : null;
    const manager = getActiveSkyholdManager();
    const canEdit = holdingPermissionContext(holding).canEditBuildings;
    const row = building && manager ? manager._prepareBuildingRow(holding, building, buildingIndex, canEdit) : null;
    const combatTag = String(building?.defense?.combatTag ?? "garrison");
    const combatTagOptions = Object.entries(getMassCombatRelationTags())
      .filter(([key]) => key !== "militia")
      .sort(([a], [b]) => Number(b === "garrison") - Number(a === "garrison"))
      .map(([value, tag]) => ({ value, label: tag.label, selected: value === combatTag }));
    if (row) {
      row.defenseCombatTag = combatTagOptions.some((option) => option.selected) ? combatTag : "garrison";
      row.defenseCombatTagLabel = combatTagOptions.find((option) => option.selected)?.label
        ?? getMassCombatRelationTags().garrison?.label
        ?? "Гарнизон";
      this._prepareEditorTabs(row);
    }

    return {
      ...context,
      canEdit,
      holding,
      holdingIndex,
      building: row,
      buildingIndex,
      combatTagOptions,
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

    this._bindWindowFrameSync(root);
    syncBuildingAudioTrackPlayback(this, context?.building);
    syncBuildingAudioTrackHeader(this, root, {
      building: context?.building,
      canManage: Boolean(game.user?.isGM),
      onPick: () => this._onPickBuildingAudioTrack(),
      onClear: () => this._onClearBuildingAudioTrack()
    });
    this._bindInputGuards(root);
    this._bindGlobalInputGuard(root);
    bindFloatingTooltips(this, root);
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

    root.querySelectorAll("[data-production-expense-field]").forEach((field) => {
      field.addEventListener("change", (event) => this._onProductionExpenseFieldChange(event));
    });

    bindDelegatedActions(this, root, BUILDING_EDITOR_ACTIONS);

    root.querySelectorAll("[data-suitable-type-add-field]").forEach((field) => {
      field.addEventListener("change", (event) => this._onSuitableTypeAddChange(event));
    });

    focusApplicationContent(this, {
      root,
      options,
      preferredSelector: ".fbls-building-editor-tab.active, [data-action='building-editor-tab']"
    });
  }

  _canEditBuilding() {
    const data = SkyholdData.get();
    const { holding } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
    return holdingPermissionContext(holding).canEditBuildings;
  }

  _prepareEditorTabs(building) {
    const isSpecial = Boolean(building?.isSpecialBuilding);
    const tabs = [
      { id: "main", label: "Основное", icon: "fa-solid fa-sliders" },
      { id: "workers", label: "Работники", icon: "fa-solid fa-users-gear" },
      { id: "construction", label: "Строительство", icon: "fa-solid fa-hammer" }
    ];
    if (!isSpecial) tabs.push({ id: "capital", label: "Капитал", icon: "fa-solid fa-landmark" });
    if (building.showProductionBlock) tabs.push({ id: "production", label: "Производство", icon: "fa-solid fa-industry" });
    if (building.showIncomeBlock) tabs.push({ id: "income", label: "Доходность", icon: "fa-solid fa-coins" });
    if (building.showDefenseBlock) tabs.push({ id: "defense", label: "Оборона", icon: "fa-solid fa-shield-halved" });
    if (building.functions?.housing) tabs.push({ id: "housing", label: "Жилое", icon: "fa-solid fa-house" });
    if (building.functions?.storage) tabs.push({ id: "storage", label: "Складское", icon: "fa-solid fa-box-archive" });
    if (building.functions?.culture) tabs.push({ id: "culture", label: "Культура/Религия", icon: "fa-solid fa-music" });
    if (!tabs.some((tab) => tab.id === this.activeTab)) this.activeTab = tabs[0]?.id ?? "main";
    building.editorTabs = tabs.map((tab) => ({ ...tab, active: tab.id === this.activeTab }));
    if (isSpecial) {
      building.showEditorMain = false;
      building.showEditorWorkers = false;
      building.showEditorConstruction = !building.isBuilt;
      building.showEditorCapital = false;
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
    building.showEditorCapital = this.activeTab === "capital";
    building.showEditorProduction = this.activeTab === "production";
    building.showEditorIncome = this.activeTab === "income";
    building.showEditorDefense = this.activeTab === "defense";
    building.showEditorHousing = this.activeTab === "housing";
    building.showEditorStorage = this.activeTab === "storage";
    building.showEditorCulture = this.activeTab === "culture";
    building.showEditorText = false;
  }

  _onEditorTab(event) {
    event.preventDefault();
    event.stopPropagation();
    const next = String(event.currentTarget?.dataset?.editorTab ?? "");
    if (!next || next === this.activeTab) return;
    this.activeTab = next;
    this.requestRender();
  }

  _onToggleDevGainEditor(event) {
    event.preventDefault();
    event.stopPropagation();
    this.editDevGain = !this.editDevGain;
    this.requestRender();
  }

  _bindInputGuards(root) {
    bindInputGuards(root, { textareaSanitizer: (value) => replaceTabs(value, "  ") });
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
    bindGlobalInputGuard(this, root);
  }

  _unbindGlobalInputGuard() {
    unbindGlobalInputGuard(this);
  }

  async _onClose(options) {
    stopBuildingAudioTrack(this);
    removeBuildingAudioTrackHeader(this);
    await super._onClose(options);
    SkyholdBuildingEditor.instances.delete(this);
    unbindDelegatedActions(this);
    hideFloatingTooltip(this);
    this._unbindGlobalInputGuard();
    this._unbindWindowFrameSync();
    const manager = getActiveSkyholdManager();
    const managerRender = requestSkyholdAppRender();
    if (managerRender?.then) await managerRender;
    restoreApplicationFocus(this, { root: manager?.element });
  }

  async _onPickBuildingAudioTrack() {
    return pickBuildingAudioTrack(this, { reason: "building-editor:set-audio-track" });
  }

  async _onClearBuildingAudioTrack() {
    return clearBuildingAudioTrack(this, { reason: "building-editor:clear-audio-track" });
  }

  _resolveBuildingScopedPath(data, path = "") {
    const text = String(path ?? "");
    const holdingMatch = text.match(/^holdings\.\d+\.buildings\.list\.\d+(?:\.(.+))?$/);
    if (holdingMatch) {
      const { holdingIndex, buildingIndex } = this._getMutableBuilding(data);
      if (holdingIndex < 0 || buildingIndex < 0) return "";
      return `holdings.${holdingIndex}.buildings.list.${buildingIndex}${holdingMatch[1] ? `.${holdingMatch[1]}` : ""}`;
    }

    const catalogMatch = text.match(/^catalog\.buildings\.\d+(?:\.(.+))?$/);
    if (catalogMatch) {
      const { buildingIndex } = this._getMutableBuilding(data);
      if (buildingIndex < 0) return "";
      return `catalog.buildings.${buildingIndex}${catalogMatch[1] ? `.${catalogMatch[1]}` : ""}`;
    }

    return "";
  }

  async _onFieldChange(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;

    const field = event.currentTarget;
    const path = field.dataset.field;
    if (!path) return;
    if (/\.enterpriseCapital(?:\.|$)/.test(path) && !game.user?.isGM) {
      ui.notifications?.warn?.("Параметры капитала предприятия изменяет только ГМ.");
      return;
    }

    const value = fieldValue(field);
    if (field.matches?.("[data-economy-whole-quantity]") && !isWholeEconomyQuantity(value, { allowZero: true })) {
      ui.notifications?.warn?.("Economy V2: количество должно быть целым числом. Дробное значение не сохранено.");
      this.requestRender({ focus: false });
      return;
    }

    try {
      const updated = await SkyholdData.transaction((data) => {
        const scopedPath = this._resolveBuildingScopedPath(data, path);
        if (!scopedPath) return SkyholdData.skipTransaction(false);
        if (/\.functions\.culture$/.test(scopedPath) && value === false) {
          foundry.utils.setProperty(data, scopedPath, false);
          foundry.utils.setProperty(data, scopedPath.replace(/\.functions\.culture$/, ".religion.religious"), false);
        } else {
          foundry.utils.setProperty(data, scopedPath, value);
          if (/\.contents\.\d+\.resourceId$/.test(scopedPath) && isLivestockResource(value)) {
            foundry.utils.setProperty(data, scopedPath.replace(/\.resourceId$/, ".name"), resourceLabel(value));
          }
        }
        return true;
      }, { reason: `building-editor:field:${path}` });
      if (!updated) return;
      const shouldRefresh = /workersMax|workersMin|constructionStatus|lifecycle|condition|repair|requiredBuildingIds|materialCosts|contents|type$|functions|productionLines|expenseMode|autoCollect|income|defense|requirements|bonuses|suitableWorkerTypes|workerTypeEffects|religion|enterpriseCapital|\.img$|\.image$|icon$/.test(path);
      if (shouldRefresh) this.requestRender();
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
    const parts = path.match(/\.assignedWorkerIds\.(\d+)$/);
    try {
      if (parts) {
        const manager = getActiveSkyholdManager({ warn: true });
        if (!manager) return;
        const updated = await this._updateMutableBuilding(({ holding, building }) => {
          if (!holding || !building) return SkyholdData.skipTransaction(false);
          manager._setBuildingSlot(holding, building.id, Number(parts[1]), field.value || "");
          return true;
        }, { reason: "building-editor:worker-change", requireHolding: true });
        if (!updated) return;
      } else {
        const updated = await SkyholdData.transaction((data) => {
          const scopedPath = this._resolveBuildingScopedPath(data, path);
          if (!scopedPath) return SkyholdData.skipTransaction(false);
          foundry.utils.setProperty(data, scopedPath, field.value || "");
          return true;
        }, { reason: "building-editor:worker-change" });
        if (!updated) return;
      }
      this.requestRender();
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
      const manager = getActiveSkyholdManager({ warn: true });
      if (!manager) return;
      const updated = await this._updateMutableBuilding(({ holding, building }) => {
        manager._setHousingSlot(holding, building.id, slot, value);
      }, { reason: "building-editor:housing-change", requireHolding: true });
      if (!updated) return;
      this.requestRender();
      requestSkyholdAppRender();
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
      const updated = await SkyholdData.transaction((data) => {
        const scopedPath = this._resolveBuildingScopedPath(data, path);
        if (!scopedPath) return SkyholdData.skipTransaction(false);
        const list = splitList(foundry.utils.getProperty(data, scopedPath));
        if (!list.some((item) => item.toLowerCase() === value.toLowerCase())) list.push(value);
        foundry.utils.setProperty(data, scopedPath, joinList(list));
        return true;
      }, { reason: "building-editor:add-suitable-type" });
      if (!updated) return;
      this.requestRender();
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
      const updated = await SkyholdData.transaction((data) => {
        const scopedPath = this._resolveBuildingScopedPath(data, path);
        if (!scopedPath) return SkyholdData.skipTransaction(false);
        const list = splitList(foundry.utils.getProperty(data, scopedPath)).filter((item) => item.toLowerCase() !== value);
        foundry.utils.setProperty(data, scopedPath, joinList(list));
        return true;
      }, { reason: "building-editor:remove-suitable-type" });
      if (!updated) return;
      this.requestRender();
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
    const current = String(building.img ?? building.image ?? "");
    renderFoundryFilePicker({
      type: "image",
      current,
      callback: async (picked) => {
        try {
          const updated = await this._updateMutableBuilding(({ building }) => {
            building.img = String(picked ?? "");
          }, { reason: "building-editor:set-image" });
          if (!updated) return;
          this.requestRender();
          requestSkyholdAppRender();
        } catch (error) {
          console.error("FBL Skyhold | Failed to set building image", error);
          ui.notifications.error("Не удалось сохранить картинку здания. Подробности в консоли.");
        }
      }
    });
  }

  async _onClearBuildingImage(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!this._canEditBuilding()) return;
    const updated = await this._updateMutableBuilding(({ building }) => {
      building.img = "";
      building.image = "";
    }, { reason: "building-editor:clear-image" });
    if (!updated) return;
    this.requestRender();
    requestSkyholdAppRender();
  }

  async _onAddBuildingMaterial(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const updated = await this._updateMutableBuilding(({ building }) => {
      if (!Array.isArray(building.materialCosts)) building.materialCosts = [];
      building.materialCosts.push({ id: makeId("material", 12), name: "Материал", qty: 0 });
    }, { reason: "building-editor:add-material" });
    if (!updated) return;
    this.requestRender();
  }

  async _onDeleteBuildingMaterial(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const index = Number(event.currentTarget?.dataset?.index);
    if (!Number.isFinite(index)) return;
    const updated = await this._updateMutableBuilding(({ building }) => {
      if (!Array.isArray(building.materialCosts)) return SkyholdData.skipTransaction(false);
      building.materialCosts.splice(index, 1);
      return true;
    }, { reason: "building-editor:delete-material" });
    if (!updated) return;
    this.requestRender();
  }

  _onPickBuildingMaterial(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const index = Number(event.currentTarget?.dataset?.index ?? -1);
    const row = this._getMutableBuilding()?.building?.materialCosts?.[index];
    if (!Number.isInteger(index) || index < 0 || !row) return;
    SkyholdResourceCatalogEditor.pick({
      selectedId: row.resourceId,
      onSelect: async (resource) => {
        const updated = await this._updateMutableBuilding(({ building }) => {
          const target = building?.materialCosts?.[index];
          if (!target) return SkyholdData.skipTransaction(false);
          target.resourceId = String(resource.id ?? "custom");
          if (target.resourceId !== "custom") target.name = String(resource.label ?? resource.id ?? "Материал");
          return true;
        }, { reason: "building-editor:pick-construction-material" });
        if (updated) this.requestRender({ focus: false });
      }
    });
  }

  async _onAddBuildingPrerequisite(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const updated = await this._updateMutableBuilding(({ building }) => {
      if (!Array.isArray(building.requiredBuildingIds)) building.requiredBuildingIds = [];
      building.requiredBuildingIds.push("");
    }, { reason: "building-editor:add-prerequisite" });
    if (!updated) return;
    this.requestRender();
  }

  async _onDeleteBuildingPrerequisite(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const index = Number(event.currentTarget?.dataset?.index);
    if (!Number.isFinite(index)) return;
    const updated = await this._updateMutableBuilding(({ building }) => {
      if (!Array.isArray(building.requiredBuildingIds)) return SkyholdData.skipTransaction(false);
      building.requiredBuildingIds.splice(index, 1);
      return true;
    }, { reason: "building-editor:delete-prerequisite" });
    if (!updated) return;
    this.requestRender();
  }


  async _onAddProductionLine(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const updated = await this._updateMutableBuilding(({ building }) => {
      if (!Array.isArray(building.productionLines)) building.productionLines = [];
      if (!building.functions || typeof building.functions !== "object") building.functions = {};
      building.functions.production = true;
      building.productionLines.push({ id: makeId("prod", 12), active: true, mode: "Новая линия", source: "workers", cadence: "day", cadenceEvery: 1, laborQdPerBatch: 1, maxBatchesPerCadence: 0, contentId: "", contentUnitsPerBatch: 1, resourceId: "wood", resource: "Древесина", outputQty: 1, formula: "", expenses: "", requiresCollection: false, passive: false, collectQd: 0, pendingQty: 0, workInProgress: null, storageRoomId: "outdoors", seasons: { spring: true, summer: true, autumn: true, winter: true } });
    }, { reason: "building-editor:add-production-line" });
    if (!updated) return;
    this.requestRender();
  }

  async _onDeleteProductionLine(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const index = Number(event.currentTarget?.dataset?.index);
    if (!Number.isFinite(index)) return;
    const updated = await this._updateMutableBuilding(({ building }) => {
      if (!Array.isArray(building.productionLines)) return SkyholdData.skipTransaction(false);
      building.productionLines.splice(index, 1);
      return true;
    }, { reason: "building-editor:delete-production-line" });
    if (!updated) return;
    this.requestRender();
  }

  _onPickProductionResource(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const index = Number(event.currentTarget?.dataset?.index ?? -1);
    const line = this._getMutableBuilding()?.building?.productionLines?.[index];
    if (!Number.isInteger(index) || index < 0 || !line) return;
    SkyholdResourceCatalogEditor.pick({
      selectedId: line.resourceId,
      onSelect: async (resource) => {
        const updated = await this._updateMutableBuilding(({ building }) => {
          const target = building?.productionLines?.[index];
          if (!target) return SkyholdData.skipTransaction(false);
          target.resourceId = String(resource.id ?? "custom");
          if (target.resourceId !== "custom") target.resource = String(resource.label ?? resource.id ?? "Ресурс");
          return true;
        }, { reason: "building-editor:pick-production-resource" });
        if (!updated) return;
        this.requestRender({ focus: false });
        requestSkyholdAppRender();
      }
    });
  }

  async _updateProductionExpenses(lineIndex, change, reason) {
    if (!this._canEditBuilding() || !Number.isInteger(lineIndex) || lineIndex < 0) return false;
    const updated = await this._updateMutableBuilding(({ building }) => {
      const line = building?.productionLines?.[lineIndex];
      if (!line) return SkyholdData.skipTransaction(false);
      const items = parseResourceCosts(line.expenses);
      const changed = change(items, line);
      if (changed === false) return SkyholdData.skipTransaction(false);
      line.expenses = serializeResourceCosts(items);
      return true;
    }, { reason });
    if (!updated) return false;
    this.requestRender({ focus: false });
    requestSkyholdAppRender();
    return true;
  }

  _onAddProductionExpenseResource(event) {
    event.preventDefault();
    const lineIndex = Number(event.currentTarget?.dataset?.lineIndex ?? -1);
    if (!this._canEditBuilding() || !Number.isInteger(lineIndex) || lineIndex < 0) return;
    SkyholdResourceCatalogEditor.pick({
      onSelect: async (resource) => {
        await this._updateProductionExpenses(lineIndex, (items) => {
          items.push({
            resourceId: String(resource?.id ?? "custom"),
            name: String(resource?.label ?? resource?.id ?? "Ресурс"),
            qty: 1
          });
        }, "building-editor:add-production-expense-resource");
      }
    });
  }

  async _onAddProductionExpenseGroup(event) {
    event.preventDefault();
    const lineIndex = Number(event.currentTarget?.dataset?.lineIndex ?? -1);
    await this._updateProductionExpenses(lineIndex, (items) => {
      const used = new Set(items.map((item) => String(item?.resourceGroup ?? "")));
      const group = materialGroupOptions().find((item) => !used.has(item.id)) ?? materialGroupOptions()[0];
      if (!group) return false;
      items.push({ resourceGroup: group.id, resourceId: `group:${group.id}`, name: group.label, qty: 1 });
      return true;
    }, "building-editor:add-production-expense-group");
  }

  _onPickProductionExpenseResource(event) {
    event.preventDefault();
    const lineIndex = Number(event.currentTarget?.dataset?.lineIndex ?? -1);
    const expenseIndex = Number(event.currentTarget?.dataset?.expenseIndex ?? -1);
    const line = this._getMutableBuilding()?.building?.productionLines?.[lineIndex];
    const item = parseResourceCosts(line?.expenses)[expenseIndex];
    if (!this._canEditBuilding() || !item || item.resourceGroup) return;
    SkyholdResourceCatalogEditor.pick({
      selectedId: item.resourceId,
      onSelect: async (resource) => {
        await this._updateProductionExpenses(lineIndex, (items) => {
          const target = items[expenseIndex];
          if (!target) return false;
          target.resourceGroup = "";
          target.resourceId = String(resource?.id ?? "custom");
          target.name = String(resource?.label ?? resource?.id ?? "Ресурс");
          return true;
        }, "building-editor:pick-production-expense-resource");
      }
    });
  }

  async _onDeleteProductionExpense(event) {
    event.preventDefault();
    const lineIndex = Number(event.currentTarget?.dataset?.lineIndex ?? -1);
    const expenseIndex = Number(event.currentTarget?.dataset?.expenseIndex ?? -1);
    await this._updateProductionExpenses(lineIndex, (items) => {
      if (!items[expenseIndex]) return false;
      items.splice(expenseIndex, 1);
      return true;
    }, "building-editor:delete-production-expense");
  }

  async _onProductionExpenseFieldChange(event) {
    const field = event.currentTarget;
    const lineIndex = Number(field?.dataset?.lineIndex ?? -1);
    const expenseIndex = Number(field?.dataset?.expenseIndex ?? -1);
    const kind = String(field?.dataset?.productionExpenseField ?? "");
    await this._updateProductionExpenses(lineIndex, (items) => {
      const target = items[expenseIndex];
      if (!target) return false;
      if (kind === "qty") {
        const qty = Number(field.value);
        if (!isWholeEconomyQuantity(qty)) {
          ui.notifications?.warn?.("Economy V2: расход сырья должен быть целым положительным числом. Дробное значение не сохранено.");
          return false;
        }
        target.qty = qty;
        return true;
      }
      if (kind === "group") {
        const group = materialGroupOptions(String(field.value)).find((item) => item.selected);
        if (!group) return false;
        target.resourceGroup = group.id;
        target.resourceId = `group:${group.id}`;
        target.name = group.label;
        return true;
      }
      return false;
    }, `building-editor:change-production-expense-${kind || "field"}`);
  }

  async _onAddBuildingContent(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const updated = await this._updateMutableBuilding(({ building }) => {
      if (!Array.isArray(building.contents)) building.contents = [];
      building.contents.push({ id: makeId("content", 12), name: "Содержимое", resourceId: "", qty: 0, capacity: 0, notes: "" });
    }, { reason: "building-editor:add-content" });
    if (!updated) return;
    this.requestRender();
  }

  async _onDeleteBuildingContent(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const index = Number(event.currentTarget?.dataset?.index);
    if (!Number.isFinite(index)) return;
    const current = this._getMutableBuilding()?.building?.contents?.[index];
    if (isLivestockResource(current?.resourceId) && Number(current?.qty) > 0) {
      ui.notifications?.warn?.("Сначала верните животных на склад, затем удаляйте строку содержимого.");
      return;
    }
    const updated = await this._updateMutableBuilding(({ building }) => {
      if (!Array.isArray(building.contents)) return SkyholdData.skipTransaction(false);
      const removed = building.contents[index];
      const removedId = String(removed?.id ?? "");
      building.contents.splice(index, 1);
      if (removedId && Array.isArray(building.productionLines)) {
        for (const line of building.productionLines) if (String(line.contentId ?? "") === removedId) line.contentId = "";
      }
      return true;
    }, { reason: "building-editor:delete-content" });
    if (!updated) return;
    this.requestRender();
  }

  _contentTransferAmount(event) {
    const row = event.currentTarget?.closest?.(".fbls-content-row-card");
    const value = Number(row?.querySelector?.("[data-content-transfer-qty]")?.value ?? 0);
    return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  }

  async _transferLivestock(event, direction = "into-building") {
    event.preventDefault();
    event.stopPropagation();
    if (!this._canEditBuilding()) return;
    const manager = getActiveSkyholdManager({ warn: true });
    if (!manager) return;
    const index = Number(event.currentTarget?.dataset?.index);
    const amount = this._contentTransferAmount(event);
    if (!Number.isInteger(index) || index < 0 || amount <= 0) {
      ui.notifications?.warn?.("Укажите целое количество животных для перемещения.");
      return;
    }

    const result = await this._updateMutableBuilding(({ holding, building }) => {
      const content = building?.contents?.[index];
      const resourceId = String(content?.resourceId ?? "");
      if (!content || !isLivestockResource(resourceId)) return SkyholdData.skipTransaction({ ok: false, message: "Строка не связана со складским видом животных." });
      const label = resourceLabel(resourceId);
      const currentQty = Math.max(0, Math.floor(Number(content.qty) || 0));
      const capacity = Math.max(0, Math.floor(Number(content.capacity) || 0));

      if (direction === "into-building") {
        const available = Math.max(0, Math.floor(manager._storageQuantity(holding, { resourceId }) || 0));
        if (available < amount) return SkyholdData.skipTransaction({ ok: false, message: `${label}: на складе ${available}, требуется ${amount}.` });
        if (capacity > 0 && currentQty + amount > capacity) return SkyholdData.skipTransaction({ ok: false, message: `${content.name || label}: вместимость ${capacity}, свободно ${Math.max(0, capacity - currentQty)}.` });
        const paid = manager._storagePay(holding, [{ resourceId, name: label, qty: amount }]);
        if (!paid?.ok) return SkyholdData.skipTransaction({ ok: false, message: `${label}: не удалось списать животных со склада.` });
        content.qty = currentQty + amount;
        manager._appendStorageLog(holding, [{ kind: "livestock-to-building", resourceId, name: label, qty: -amount, source: building.name || "Здание", note: `размещено как содержимое «${content.name || label}»` }]);
      } else {
        if (currentQty < amount) return SkyholdData.skipTransaction({ ok: false, message: `${content.name || label}: в здании ${currentQty}, требуется ${amount}.` });
        content.qty = currentQty - amount;
        const placements = manager._storageAddWithOverflow(holding, { resourceId, name: label, roomId: "outdoors", lotSource: "building-content" }, amount);
        manager._appendStorageLog(holding, placements.map((placement) => ({ kind: "livestock-from-building", resourceId, name: label, qty: placement.qty, roomId: placement.roomId, source: building.name || "Здание", note: `возвращено из содержимого «${content.name || label}»` })));
      }
      return { ok: true, label, amount, currentQty: content.qty };
    }, { reason: `building-editor:livestock:${direction}`, requireHolding: true });

    if (!result?.ok) {
      if (result?.message) ui.notifications?.warn?.(result.message);
      return;
    }
    this.requestRender({ focus: false });
    requestSkyholdAppRender();
    ui.notifications?.info?.(`${result.label}: ${result.amount} ${direction === "into-building" ? "перемещено в здание" : "возвращено на склад"}.`);
  }

  _onTakeLivestockFromStorage(event) {
    return this._transferLivestock(event, "into-building");
  }

  _onReturnLivestockToStorage(event) {
    return this._transferLivestock(event, "to-storage");
  }

  async _onCollectProductionLine(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const index = Number(event.currentTarget?.dataset?.index);
    if (!Number.isFinite(index)) return;
    const manager = getActiveSkyholdManager({ warn: true });
    if (!manager) return;
    const result = await this._updateMutableBuilding(({ holding, building }) => {
      const line = building?.productionLines?.[index];
      if (!holding || !building || !line) return SkyholdData.skipTransaction(null);
      const collected = manager._collectProductionLine(holding, building, line);
      return collected?.ok ? collected : SkyholdData.skipTransaction(collected);
    }, { reason: "building-editor:collect-production-line", requireHolding: true });
    if (!result) return;
    this.requestRender();
    requestSkyholdAppRender();
    if (result?.ok) ui.notifications.info(result.message || "Ресурс собран.");
    else ui.notifications.warn(result?.message || "Нечего собирать.");
  }

  async _onFundEnterpriseCapital(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!this._canEditBuilding() || !game.user?.isGM) {
      ui.notifications?.warn?.("Перевод капитала из казны выполняет только ГМ.");
      return;
    }
    const operationId = makeId("enterprise-capital", 20);
    const createdAt = new Date().toISOString();
    const result = await this._updateMutableBuilding(({ holding, building }) => {
      if (!holding || !building) return SkyholdData.skipTransaction({ ok: false, message: "Предприятие не найдено." });
      const applied = fundEnterpriseCapital(holding, {
        buildingId: building.id,
        operationId,
        createdAt
      });
      return applied.ok && !applied.duplicate ? applied : SkyholdData.skipTransaction(applied);
    }, { reason: "building-editor:fund-enterprise-capital", requireHolding: true });
    if (!result) return;
    if (!result.ok) {
      ui.notifications?.warn?.(result.message || "Не удалось профинансировать предприятие.");
      return;
    }
    this.requestRender();
    requestSkyholdAppRender();
    const manager = getActiveSkyholdManager();
    const amountText = manager?._formatCopperCurrency?.(result.transferredCopper) ?? `${result.transferredCopper} ММ`;
    const commissioningText = manager?._formatCopperCurrency?.(result.commissioningCopper) ?? `${result.commissioningCopper} ММ`;
    const reserveText = manager?._formatCopperCurrency?.(result.reserveCopper) ?? `${result.reserveCopper} ММ`;
    const suffix = result.ready
      ? " Предприятие готово к работе."
      : (!result.landRightReady && result.shortfallCopper <= 0
        ? " Денежная часть закрыта; владению ещё нужно право на землю."
        : ` Осталось перевести ${manager?._formatCopperCurrency?.(result.shortfallCopper) ?? `${result.shortfallCopper} ММ`}.`);
    ui.notifications?.info?.(`Из казны переведено ${amountText}: ввод ${commissioningText}, резерв ${reserveText}.${suffix}`);
  }

  _getMutableBuilding(data = SkyholdData.get()) {
    const { holding, index: holdingIndex } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
    const buildingIndex = (holding?.buildings?.list ?? []).findIndex((item) => item.id === this.buildingId);
    const building = buildingIndex >= 0 ? holding.buildings.list[buildingIndex] : null;
    return { data, holding, holdingIndex, building, buildingIndex };
  }

  async _updateMutableBuilding(updater, { reason = "building-editor:update", requireHolding = false } = {}) {
    if (typeof updater !== "function") return null;
    return SkyholdData.transaction(async (data) => {
      const context = this._getMutableBuilding(data);
      if (!context.building || (requireHolding && !context.holding)) return SkyholdData.skipTransaction(null);
      const result = await updater(context);
      return result === undefined ? true : result;
    }, { reason });
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
    this.requestRender();
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
    width: 1180,
    height: 500
  }
};
SkyholdBuildingEditor.PARTS = {
  body: {
    template: `modules/${MODULE_ID}/templates/building-editor.hbs`
  }
};
