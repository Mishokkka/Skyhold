import { SkyholdData } from "../../data/store.js";
import { makeId } from "../../data/utils.js";
import { findReadableHoldingEntry } from "../../data/access-guard.js";
import { holdingPermissionContext } from "../../data/holding-permissions.js";
import { fieldValue } from "../../core/helpers.js";
import { bindGlobalInputGuard, bindInputGuards, replaceTabs, unbindGlobalInputGuard } from "../../utils/input-guards.js";
import { getSkyholdManager, requestSkyholdAppRender } from "../registry.js";
import { confirmBuildingWorkerAdmission } from "../common/building-worker-admission.js";
import { bindDelegatedActions, unbindDelegatedActions } from "../common/delegated-events.js";
import { bindFloatingTooltips, hideFloatingTooltip } from "../common/floating-tooltip.js";
import { WindowFrameMixin } from "../common/window-frame.js";
import { RenderSchedulerMixin } from "../common/render-scheduler.js";
import { ensureSkyholdTemplateGroup } from "../template-preload.js";
import {
  clearBuildingAudioTrack,
  pickBuildingAudioTrack,
  removeBuildingAudioTrackHeader,
  stopBuildingAudioTrack,
  syncBuildingAudioTrackHeader,
  syncBuildingAudioTrackPlayback
} from "../common/building-audio-track.js";
import { renderFoundryFilePicker } from "../../integrations/foundry-runtime.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const BASE_ACTIONS = {
  "unique-building-tab": "_onUniqueBuildingTab",
  "pick-unique-building-image": "_onPickBuildingImage",
  "clear-unique-building-image": "_onClearBuildingImage",
  "roll-construction": "_onRollConstruction",
  "roll-construction-crew": "_onRollConstructionCrew",
  "add-building-material": "_onAddBuildingMaterial",
  "delete-building-material": "_onDeleteBuildingMaterial",
  "add-building-prerequisite": "_onAddBuildingPrerequisite",
  "delete-building-prerequisite": "_onDeleteBuildingPrerequisite"
};

export class SkyholdUniqueBuildingApp extends WindowFrameMixin(RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2))) {
  static instances = new Set();

  static rerenderOpen({ skipFocused = true } = {}) {
    for (const app of SkyholdUniqueBuildingApp.instances) {
      const root = app.element;
      if (skipFocused && root && document.activeElement instanceof Element && root.contains(document.activeElement)) continue;
      app.requestRender?.();
    }
  }

  constructor({ holdingId, buildingId } = {}, options = {}) {
    super(options);
    this.holdingId = String(holdingId ?? "");
    this.buildingId = String(buildingId ?? "");
    this.activeUniqueBuildingTab = "unique";
    SkyholdUniqueBuildingApp.instances.add(this);
  }

  async _prepareContext(options) {
    await ensureSkyholdTemplateGroup("uniqueBuilding");
    const context = await super._prepareContext(options);
    const data = SkyholdData.get();
    const { holding, index: holdingIndex } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
    const buildingIndex = (holding?.buildings?.list ?? []).findIndex((item) => String(item?.id ?? "") === this.buildingId);
    const building = buildingIndex >= 0 ? holding.buildings.list[buildingIndex] : null;
    const manager = getSkyholdManager();
    const permissions = holdingPermissionContext(holding);
    const canManageEditorTabs = permissions.isGM;
    const canEdit = permissions.canEditBuildings;
    const prepared = building && manager ? manager._prepareBuildingRow(holding, building, buildingIndex, canEdit) : building;
    if (prepared) this._prepareUniqueBuildingTabs(prepared, { canManageEditorTabs });
    return {
      ...context,
      holding,
      holdingIndex,
      building: prepared,
      buildingIndex,
      hasBuilding: Boolean(building),
      canEdit,
      canManageEditorTabs,
      constructionCrew: manager?._constructionCrew?.(holding) ?? { count: 0, dice: 0, names: "" }
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
    bindInputGuards(root, { textareaSanitizer: (value) => replaceTabs(value, "  ") });
    bindGlobalInputGuard(this, root);
    bindFloatingTooltips(this, root);
    bindDelegatedActions(this, root, { ...BASE_ACTIONS, ...this.uniqueBuildingActions });
    root.querySelectorAll("[data-field]").forEach((field) => {
      field.addEventListener("change", (event) => this._onFieldChange(event));
    });
    root.querySelectorAll("[data-building-worker-field]").forEach((field) => {
      field.addEventListener("change", (event) => this._onBuildingWorkerChange(event));
    });
  }

  get uniqueBuildingActions() {
    return {};
  }

  _prepareUniqueBuildingTabs(building, { canManageEditorTabs = false } = {}) {
    const tabs = [
      { id: "unique", label: "Уникальное", icon: "fa-solid fa-star" },
      { id: "main", label: "Основное", icon: "fa-solid fa-sliders" },
      { id: "construction", label: "Строительство", icon: "fa-solid fa-hammer" }
    ];
    if (!canManageEditorTabs || !tabs.some((tab) => tab.id === this.activeUniqueBuildingTab)) this.activeUniqueBuildingTab = "unique";
    building.showUniqueBuildingTabs = canManageEditorTabs;
    building.uniqueBuildingTabs = tabs.map((tab) => ({ ...tab, active: tab.id === this.activeUniqueBuildingTab }));
    building.showUniqueBuildingBody = this.activeUniqueBuildingTab === "unique";
    building.showEditorMain = canManageEditorTabs && this.activeUniqueBuildingTab === "main";
    building.showEditorConstruction = canManageEditorTabs && this.activeUniqueBuildingTab === "construction";
    building.showEditorWorkers = false;
    building.showEditorProduction = false;
    building.showEditorIncome = false;
    building.showEditorDefense = false;
    building.showEditorHousing = false;
    building.showEditorStorage = false;
    building.showEditorCulture = false;
    building.showEditorText = false;
  }

  _onUniqueBuildingTab(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    const next = String(event.currentTarget?.dataset?.uniqueBuildingTab ?? "");
    if (!next || next === this.activeUniqueBuildingTab) return;
    this.activeUniqueBuildingTab = next;
    this.requestRender();
  }

  _canEditBuilding() {
    const data = SkyholdData.get();
    const { holding } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
    return holdingPermissionContext(holding).canEditBuildings;
  }

  _getMutableBuilding(data = SkyholdData.get()) {
    const { holding, index: holdingIndex } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
    const buildingIndex = (holding?.buildings?.list ?? []).findIndex((item) => String(item?.id ?? "") === this.buildingId);
    const building = buildingIndex >= 0 ? holding.buildings.list[buildingIndex] : null;
    return { data, holding, holdingIndex, building, buildingIndex };
  }

  async _updateMutableBuilding(updater, { reason = "unique-building:update", requireHolding = false } = {}) {
    return SkyholdData.transaction(async (data) => {
      const current = this._getMutableBuilding(data);
      if (!current.building || (requireHolding && !current.holding)) return SkyholdData.skipTransaction(null);
      const result = await updater(current);
      return result === undefined ? true : result;
    }, { reason, scope: "holdings" });
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
    const path = field?.dataset?.field;
    if (!path) return;
    const value = fieldValue(field);
    const updated = await SkyholdData.transaction((data) => {
      const scopedPath = this._resolveBuildingScopedPath(data, path);
      if (!scopedPath) return SkyholdData.skipTransaction(false);
      foundry.utils.setProperty(data, scopedPath, value);
      return true;
    }, { reason: `unique-building:field:${path}`, scope: "holdings" });
    if (!updated) return;
    this.requestRender();
    requestSkyholdAppRender();
  }

  async _onBuildingWorkerChange(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const field = event.currentTarget;
    const slotMatch = String(field?.dataset?.buildingWorkerField ?? "").match(/\.assignedWorkerIds\.(\d+)$/);
    if (!slotMatch) return;
    const manager = getSkyholdManager();
    if (!manager) return;
    const current = this._getMutableBuilding();
    const person = (current.holding?.people?.list ?? []).find((row) => String(row?.id ?? "") === String(field.value ?? ""));
    const decision = await confirmBuildingWorkerAdmission({ manager, building: current.building, person });
    if (!decision.allowed) { this.requestRender(); return; }
    const updated = await this._updateMutableBuilding(({ holding, building }) => {
      return manager._setBuildingSlot(holding, building.id, Number(slotMatch[1]), field.value || "", decision)
        || SkyholdData.skipTransaction(false);
    }, { reason: "unique-building:worker-change", requireHolding: true });
    if (!updated) return;
    this.requestRender();
    requestSkyholdAppRender();
  }

  async _onPickBuildingImage(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const { building } = this._getMutableBuilding();
    if (!building) return;
    renderFoundryFilePicker({
      type: "image",
      current: String(building.img ?? building.image ?? ""),
      callback: async (picked) => {
        const updated = await this._updateMutableBuilding(({ building: current }) => {
          current.img = String(picked ?? "");
        }, { reason: "unique-building:set-image" });
        if (!updated) return;
        this.requestRender();
        requestSkyholdAppRender();
      }
    });
  }

  async _onClearBuildingImage(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const updated = await this._updateMutableBuilding(({ building }) => {
      building.img = "";
      building.image = "";
    }, { reason: "unique-building:clear-image" });
    if (!updated) return;
    this.requestRender();
    requestSkyholdAppRender();
  }

  async _onPickBuildingAudioTrack() {
    return pickBuildingAudioTrack(this, { reason: "unique-building:set-audio-track" });
  }

  async _onClearBuildingAudioTrack() {
    return clearBuildingAudioTrack(this, { reason: "unique-building:clear-audio-track" });
  }

  async _onRollConstructionCrew(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const manager = getSkyholdManager();
    if (!manager) return;
    manager.activeHoldingId = this.holdingId;
    await manager._onRollConstructionCrew(event);
  }

  async _onRollConstruction(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const manager = getSkyholdManager();
    if (!manager) return;
    manager.activeHoldingId = this.holdingId;
    await manager._onRollConstruction(event);
    this.requestRender();
  }

  async _onAddBuildingMaterial(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const updated = await this._updateMutableBuilding(({ building }) => {
      if (!Array.isArray(building.materialCosts)) building.materialCosts = [];
      building.materialCosts.push({ id: makeId("material", 12), name: "Материал", qty: 0 });
    }, { reason: "unique-building:add-material" });
    if (!updated) return;
    this.requestRender();
    requestSkyholdAppRender();
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
    }, { reason: "unique-building:delete-material" });
    if (!updated) return;
    this.requestRender();
    requestSkyholdAppRender();
  }

  async _onAddBuildingPrerequisite(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const field = event.currentTarget?.dataset?.prerequisiteMode === "any" ? "requiredAnyBuildingIds" : "requiredBuildingIds";
    const updated = await this._updateMutableBuilding(({ building }) => {
      if (!Array.isArray(building[field])) building[field] = [];
      building[field].push("");
    }, { reason: "unique-building:add-prerequisite" });
    if (!updated) return;
    this.requestRender();
    requestSkyholdAppRender();
  }

  async _onDeleteBuildingPrerequisite(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const index = Number(event.currentTarget?.dataset?.index);
    if (!Number.isFinite(index)) return;
    const field = event.currentTarget?.dataset?.prerequisiteMode === "any" ? "requiredAnyBuildingIds" : "requiredBuildingIds";
    const updated = await this._updateMutableBuilding(({ building }) => {
      if (!Array.isArray(building[field])) return SkyholdData.skipTransaction(false);
      building[field].splice(index, 1);
      return true;
    }, { reason: "unique-building:delete-prerequisite" });
    if (!updated) return;
    this.requestRender();
    requestSkyholdAppRender();
  }

  async _onClose(options) {
    stopBuildingAudioTrack(this);
    removeBuildingAudioTrackHeader(this);
    await super._onClose(options);
    unbindDelegatedActions(this);
    hideFloatingTooltip(this);
    unbindGlobalInputGuard(this);
    this._unbindWindowFrameSync();
    SkyholdUniqueBuildingApp.instances.delete(this);
    const manager = getSkyholdManager();
    if (manager?._pendingExternalRerender) requestSkyholdAppRender({ deferForActiveWindow: false });
  }
}
