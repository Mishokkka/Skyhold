import { SkyholdData, requestWorkforceOperation } from "../../data/store.js";
import { makeId } from "../../data/utils.js";
import { canReadResident, findReadableHoldingEntry } from "../../data/access-guard.js";
import { holdingPermissionContext } from "../../data/holding-permissions.js";
import { droppedLocksForAllocationChange, mutateResidentBuildingLabor } from "../../data/labor-mutations.js";
import { normalLaborQdPerTenday, residentLaborCapacity } from "../../data/labor-budget.js";
import { buildingLaborCapacityQd, buildingReservedQd, uncollectibleProductionLine } from "../../data/labor-model.js";
import { workforceIssueMessage, workforceKey, workforceLockKey } from "../../data/workforce-plan.js";
import { buildResidentAllocationAddCommand, buildResidentAllocationRemovalCommand } from "../../data/workforce-socket.js";
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
import { buildWorkAllocationTargets, validateHoldingWorkAllocations, workAllocationTargetKey, workAllocationTotals, workFunctionMatches } from "../../data/work-allocations.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const BASE_ACTIONS = {
  "unique-building-tab": "_onUniqueBuildingTab",
  "unique-remove-worker": "_onRemoveUniqueBuildingWorker",
  "open-unique-workforce-planner": "_onOpenWorkforcePlanner",
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
    const prepared = building && manager ? manager._prepareBuildingRow(holding, building, buildingIndex, canEdit, null, { isGM: permissions.isGM }) : building;
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
    root.querySelectorAll("[data-building-labor-field]").forEach((field) => {
      field.addEventListener("change", (event) => this._onLaborFieldChange(event));
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
    }, { reason, scope: this.templateId ? "catalog" : "holdings" });
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
    }, { reason: `unique-building:field:${path}`, scope: this.templateId ? "catalog" : "holdings" });
    if (!updated) return;
    this.requestRender();
    requestSkyholdAppRender();
  }

  async _onLaborFieldChange(event) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    const field = event.currentTarget;
    if (field.dataset.buildingLaborField !== "capacityQd") return;
    try {
      const raw = field.value.trim();
      const value = raw === "" ? null : Number(raw);
      if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
        throw new Error("Предел QD должен быть целым неотрицательным числом; пустое поле означает отсутствие предела.");
      }
      await this._updateMutableBuilding(({ holding, building }) => {
        const applyZeroLaborGuards = (target) => {
          if (value !== 0) return;
          target.activation = { ...target.activation, minOperationalQd: 0, requiresMeaningfulResult: false };
          target.minOperationalQd = 0;
          const blockedLine = uncollectibleProductionLine(target);
          if (blockedLine) {
            throw new Error(`Нельзя задать 0 QD: линия «${blockedLine.resource || blockedLine.mode || "выпуск"}» требует сбора (${blockedLine.collectQd} QD) без сбора потребителем.`);
          }
        };
        if (holding) {
          const previewHolding = structuredClone(holding);
          const previewBuilding = previewHolding.buildings?.list?.find((item) => String(item?.id ?? "") === String(building.id));
          if (previewBuilding) {
            previewBuilding.labor = { version: 2, capacityQd: value };
            previewBuilding.workersMin = 0;
            if (previewBuilding.workerProfile) previewBuilding.workerProfile.workersMin = 0;
            if (previewBuilding.activation) previewBuilding.activation.minWorkers = 0;
            applyZeroLaborGuards(previewBuilding);
            const check = validateHoldingWorkAllocations(previewHolding, { previousHolding: holding });
            if (!check.ok) throw new Error(check.issues[0].message);
          }
        }
        building.labor = { version: 2, capacityQd: value };
        building.workersMin = 0;
        if (building.workerProfile) building.workerProfile.workersMin = 0;
        if (building.activation) building.activation.minWorkers = 0;
        applyZeroLaborGuards(building);
        return true;
      }, { reason: "unique-building:labor" });
      this.requestRender();
      requestSkyholdAppRender();
    } catch (error) {
      ui.notifications.warn(error?.message || "Не удалось изменить параметры труда.");
      this.requestRender();
    }
  }

  async _onRemoveUniqueBuildingWorker(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const personId = String(event.currentTarget?.dataset?.personId ?? "").trim();
    const manager = getSkyholdManager();
    if (!manager || !personId) return;
    const isGM = game.user?.isGM === true;
    const data = SkyholdData.get();
    const current = this._getMutableBuilding(data);
    const currentPerson = (current.holding?.people?.list ?? []).find((row) => String(row?.id ?? "") === personId);
    if (!current.holding || !current.building || !canReadResident(currentPerson)) return;
    const removedRows = (currentPerson.workAllocations ?? [])
      .filter((row) => String(row?.sourceId ?? "") === String(current.building.id));
    const expectedRows = new Map(removedRows.map((row) => [String(row.id), String(row.functionId ?? "")]));
    const nextAllocations = (currentPerson.workAllocations ?? [])
      .filter((row) => String(row?.sourceId ?? "") !== String(current.building.id));
    const dropped = droppedLocksForAllocationChange(current.holding, personId, nextAllocations, removedRows);
    const confirmedLockKeys = new Set(dropped.map(workforceLockKey));
    if (dropped.length) {
      if (!isGM && dropped.some((row) => row.visibility === "gm")) {
        ui.notifications?.warn?.("Назначение недоступно. Обновите окно или обратитесь к ГМу.");
        return;
      }
      if (!await manager._confirmAction?.("Снять закреплённое назначение",
        "Назначение закреплено в общем плане работ. Удалить его и снять закрепление?")) return;
    }
    if (!isGM) {
      try {
        await requestWorkforceOperation(buildResidentAllocationRemovalCommand({
          operationId: makeId("workforce-remove", 20),
          holdingId: current.holding.id,
          expectedRevision: data.meta.revision,
          personId,
          buildingId: current.building.id,
          functionId: ""
        }));
      } catch (error) {
        ui.notifications?.warn?.(error?.message || "Не удалось снять назначение.");
        return;
      }
      this.requestRender();
      requestSkyholdAppRender();
      return;
    }
    let failureMessage = "";
    try {
      const updated = await this._updateMutableBuilding(({ holding, building }) => {
        const person = (holding.people?.list ?? []).find((row) => String(row?.id ?? "") === personId);
        if (!canReadResident(person)) return SkyholdData.skipTransaction(false);
        const rows = person.workAllocations ?? [];
        const targetsBuilding = (row) => String(row?.sourceId ?? "") === String(building.id);
        const innerRemoved = rows.filter(targetsBuilding);
        if (innerRemoved.length !== expectedRows.size || innerRemoved.some((row) =>
          expectedRows.get(String(row.id)) !== String(row.functionId ?? ""))) {
          failureMessage = "Назначения изменились. Обновите окно и повторите снятие назначений.";
          return SkyholdData.skipTransaction(false);
        }
        const innerDropped = droppedLocksForAllocationChange(holding, personId,
          rows.filter((row) => !targetsBuilding(row)), innerRemoved);
        if (innerDropped.some((row) => !confirmedLockKeys.has(workforceLockKey(row)))) {
          failureMessage = "Закрепления изменились. Обновите окно и подтвердите снятие ещё раз.";
          return SkyholdData.skipTransaction(false);
        }
        const check = mutateResidentBuildingLabor(holding, {
          personId,
          buildingId: building.id,
          functionId: "",
          action: "remove",
          isGM: true
        });
        if (!check.ok) {
          failureMessage = check.orphanedOvertime
            ? check.message
            : (workforceIssueMessage(holding, check.issues?.[0], { isGM: true }) || check.message);
        }
        return check.ok || SkyholdData.skipTransaction(false);
      }, { reason: "unique-building:remove-worker", requireHolding: true, laborValidated: true });
      if (!updated) {
        if (failureMessage) ui.notifications?.warn?.(failureMessage);
        return;
      }
      this.requestRender();
      requestSkyholdAppRender();
    } catch (error) {
      ui.notifications?.warn?.(error?.message || "Не удалось снять назначение.");
    }
  }

  async _onOpenWorkforcePlanner(event) {
    event.preventDefault();
    const { openWorkforcePlanner } = await import("../lazy-apps.js");
    const { holding, building } = this._getMutableBuilding();
    const targetKey = holding && building
      ? buildWorkAllocationTargets(holding).find((row) => String(row.sourceId) === String(building.id))?.key
      : "";
    return openWorkforcePlanner({ holdingId: this.holdingId, targetKey });
  }

  async _onBuildingWorkerChange(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const field = event.currentTarget;
    const personId = String(field?.value ?? "").trim();
    if (!personId) return;
    const functionId = field.dataset.buildingWorkerField === "medical" ? "medical" : undefined;
    const manager = getSkyholdManager();
    if (!manager) return;
    const isGM = game.user?.isGM === true;
    const data = SkyholdData.get();
    const current = this._getMutableBuilding(data);
    const person = (current.holding?.people?.list ?? []).find((row) => String(row?.id ?? "") === personId);
    if (!current.holding || !current.building || !canReadResident(person)) return;
    const allTargets = buildWorkAllocationTargets(current.holding)
      .filter((row) => row.sourceId === String(current.building.id) && row.available);
    const target = functionId
      ? allTargets.find((row) => row.functionId === functionId || workFunctionMatches(row.functionId, functionId))
      : allTargets[0];
    if (!target) {
      ui.notifications?.warn?.("В здании нет доступной рабочей функции.");
      this.requestRender();
      return;
    }
    const targetKey = workAllocationTargetKey(current.building.id, target.functionId);
    const existingLock = (current.holding.workforcePlan?.locks ?? []).find((row) =>
      String(row?.personId ?? "") === personId && workforceKey(row) === targetKey);
    if (existingLock) {
      ui.notifications?.warn?.(!isGM && existingLock.visibility === "gm"
        ? "Назначение недоступно. Обновите окно или обратитесь к ГМу."
        : "Сначала снимите закрепление назначения.");
      this.requestRender();
      return;
    }
    const decision = await confirmBuildingWorkerAdmission({ manager, building: current.building, person });
    if (!decision.allowed) { this.requestRender(); return; }
    if (!isGM) {
      const freeNormal = Math.max(0, residentLaborCapacity(person, normalLaborQdPerTenday(current.holding)).normalQd
        - workAllocationTotals(person.workAllocations).normalQd);
      const cap = buildingLaborCapacityQd(current.building);
      const remaining = cap === null ? freeNormal : Math.max(0, cap - buildingReservedQd(current.holding, current.building.id));
      const normalQd = Math.min(freeNormal, remaining);
      if (normalQd <= 0) {
        ui.notifications?.warn?.("Нет свободных QD или вместимости здания.");
        this.requestRender();
        return;
      }
      try {
        await requestWorkforceOperation(buildResidentAllocationAddCommand({
          operationId: makeId("workforce-assign", 20),
          holdingId: current.holding.id,
          expectedRevision: data.meta.revision,
          personId,
          buildingId: current.building.id,
          functionId: target.functionId,
          normalQd,
          overtimeQd: 0
        }));
      } catch (error) {
        ui.notifications?.warn?.(error?.message || "Не удалось назначить жителя на работу.");
        this.requestRender();
        return;
      }
      this.requestRender();
      requestSkyholdAppRender();
      return;
    }
    const out = {};
    try {
      const updated = await this._updateMutableBuilding(({ holding, building }) => {
        const currentPerson = (holding.people?.list ?? []).find((row) => String(row?.id ?? "") === personId);
        if (!canReadResident(currentPerson)) return SkyholdData.skipTransaction(false);
        const lockKey = workAllocationTargetKey(building.id, target.functionId);
        if ((holding.workforcePlan?.locks ?? []).some((row) => String(row?.personId ?? "") === personId && workforceKey(row) === lockKey)) {
          out.reason = "Сначала снимите закрепление назначения.";
          return SkyholdData.skipTransaction(false);
        }
        return manager._assignPersonToBuilding(holding, personId, building.id, { ...decision, functionId: target.functionId, out })
          || SkyholdData.skipTransaction(false);
      }, { reason: "unique-building:worker-change", requireHolding: true });
      if (!updated) {
        if (out.reason) ui.notifications?.warn?.(out.reason);
        this.requestRender();
        return;
      }
      this.requestRender();
      requestSkyholdAppRender();
    } catch (error) {
      ui.notifications?.warn?.(error?.message || "Не удалось назначить жителя на работу.");
      this.requestRender();
    }
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
