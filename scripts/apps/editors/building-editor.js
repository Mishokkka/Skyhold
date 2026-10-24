import { workerProfileEditorContext, editableWorkerProfile, changeWorkerProfile } from "./worker-profile-editor.js";
import { prepareProductionEconomics, bindProductionEconomics } from "./production-economics-preview.js";
import { assertProductionIdentityUnchanged } from "../../engines/economy/production-timing.js";
import { MODULE_ID } from "../../data/constants.js";
import { appendProductionExpense } from "../../core/production-expenses.js";
import { normalizeAgricultureBuilding } from "../../data/agriculture.js";
import { normalizeLivestockBuilding } from "../../data/livestock.js";
import { SkyholdData, requestConstructionOperation } from "../../data/store.js";
import { makeId } from "../../data/utils.js";
import { findReadableHoldingEntry } from "../../data/access-guard.js";
import { holdingPermissionContext } from "../../data/holding-permissions.js";
import { SaveStatus, syncSaveStatus } from "../common/save-status.js";
import { fieldValue } from "../../core/helpers.js";
import { allResourceDefs, resourceIcon, resourceLabel } from "../../core/resources.js";
import { DisclosureState } from "../common/disclosure-state.js";
import { prepareBuildingEditorLayout } from "../domains/building-editor-layout.js";
import { buildingEditorTab } from "../domains/building-editor-tabs.js";
import { BuildingEditorPickerState, buildingPickerValues, prepareTradePickers, projectParticipantPicker, tradeCategoryOptions } from "../domains/building-editor-pickers.js";
import { bindGlobalInputGuard, bindInputGuards, replaceTabs, unbindGlobalInputGuard } from "../../utils/input-guards.js";
import { getSkyholdManager, requestSkyholdAppRender } from "../registry.js";
import { confirmBuildingWorkerAdmission } from "../common/building-worker-admission.js";
import { bindDelegatedActions, unbindDelegatedActions } from "../common/delegated-events.js";
import { bindFloatingTooltips, hideFloatingTooltip } from "../common/floating-tooltip.js";
import { WindowFrameMixin } from "../common/window-frame.js";
import { focusApplicationContent, restoreApplicationFocus } from "../common/window-focus-keeper.js";
import { RenderSchedulerMixin } from "../common/render-scheduler.js";
import { PendingFieldSavesMixin } from "../common/pending-field-saves.js";
import {
  clearBuildingAudioTrack,
  pickBuildingAudioTrack,
  removeBuildingAudioTrackHeader,
  stopBuildingAudioTrack,
  syncBuildingAudioTrackHeader,
  syncBuildingAudioTrackPlayback
} from "../common/building-audio-track.js";
import { getMassCombatRelationTags } from "../mass-combat/tag-config.js";
import { livestockHeadcount } from "../../engines/economy/livestock.js";
import { renderFoundryFilePicker } from "../../integrations/foundry-runtime.js";
import { SkyholdResourceCatalogEditor } from "./resource-catalog-editor.js";
import { buildingLaborMode, validateHybridLaborHolding, newHybridLaborIssues } from "../../data/hybrid-labor.js";
import { buildWorkAllocationTargets } from "../../data/work-allocations.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const BUILDING_EDITOR_ACTIONS = {
  "worker-profile-pick": "_onWorkerProfileEdit",
  "worker-profile-up": "_onWorkerProfileEdit",
  "worker-profile-add": "_onWorkerProfileEdit",
  "worker-profile-remove": "_onWorkerProfileEdit",
  "building-editor-tab": "_onEditorTab",
  "toggle-dev-gain-editor": "_onToggleDevGainEditor",
  "roll-construction": "_onRollConstruction",
  "roll-construction-crew": "_onRollConstructionCrew",
  "add-building-material": "_onAddBuildingMaterial",
  "delete-building-material": "_onDeleteBuildingMaterial",
  "pick-building-material": "_onPickBuildingMaterial",
  "add-building-prerequisite": "_onAddBuildingPrerequisite",
  "delete-building-prerequisite": "_onDeleteBuildingPrerequisite",
  "add-production-line": "_onAddProductionLine",
  "delete-production-line": "_onDeleteProductionLine",
  "cancel-production-batch": "_onCancelProductionBatch",
  "pick-production-resource": "_onPickProductionResource",
  "pick-production-expense": "_onPickProductionExpense",
  "add-building-content": "_onAddBuildingContent",
  "delete-building-content": "_onDeleteBuildingContent",
  "collect-production-line": "_onCollectProductionLine",
  "add-agriculture-crop": "_onAddAgricultureCrop",
  "delete-agriculture-crop": "_onDeleteAgricultureCrop",
  "pick-agriculture-resource": "_onPickAgricultureResource",
  "toggle-agriculture-season": "_onToggleAgricultureSeason",
  "add-livestock-cohort": "_onAddLivestockCohort",
  "delete-livestock-cohort": "_onDeleteLivestockCohort",
  "add-service-project": "_onAddServiceProject",
  "delete-service-project": "_onDeleteServiceProject",
  "add-service-project-cost": "_onAddServiceProjectCost",
  "delete-service-project-cost": "_onDeleteServiceProjectCost",
  "pick-service-project-resource": "_onPickServiceProjectResource",
  "pick-building-image": "_onPickBuildingImage",
  "clear-building-image": "_onClearBuildingImage"
};

const SERVICE_PROJECT_TEMPLATE_KINDS = Object.freeze({
  university: "research",
  "military-academy": "training",
  "airship-yard": "design",
  "agronomic-institute": "agronomy"
});

const SERVICE_PROJECT_STATUS_OPTIONS = Object.freeze([
  ["planned", "Запланирован"],
  ["active", "В работе"],
  ["paused", "Приостановлен"],
  ["completed", "Завершён"],
  ["cancelled", "Отменён"]
]);

const SERVICE_PROJECT_DECISION_OPTIONS = Object.freeze([
  ["none", "Не требуется"],
  ["pending", "Ожидает решения"],
  ["approved", "Одобрен"],
  ["rejected", "Отклонён"]
]);

function uniqueStringList(value = []) {
  const source = Array.isArray(value) ? value : String(value ?? "").split(/[,;\n]/);
  return [...new Set(source.map((item) => String(item ?? "").trim()).filter(Boolean))];
}

function getActiveSkyholdManager({ warn = false } = {}) {
  const manager = getSkyholdManager();
  if (!manager && warn) ui.notifications?.warn?.("FBL Skyhold manager is closed. Open it before using this editor action.");
  return manager;
}

export class SkyholdBuildingEditor extends WindowFrameMixin(PendingFieldSavesMixin(RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2)))) {
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
    this._editorDisclosures = new DisclosureState();
    this._editorPickers = new BuildingEditorPickerState();
    this._saveStatus = new SaveStatus({ onChange: () => syncSaveStatus(this.element, this._saveStatus) });
    SkyholdBuildingEditor.instances.add(this);
  }

  async render(...args) {
    const firstRender = !this.rendered;
    const result = await super.render(...args);
    // Capture the frame only after ApplicationV2 has applied its position.
    if (firstRender && this.element) this._bindWindowFrameSync(this.element);
    return result;
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
      this._prepareEditorTabs(row, { holding, data });
    }

    return {
      ...context,
      canEdit,
      saveStatus: this._saveStatus.context,
      isGM: Boolean(game.user?.isGM),
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

    if (context?.hasBuilding) prepareBuildingEditorLayout(root, { tab: this.activeTab });
    this._editorDisclosures.bind(root);
    this._editorPickers.bind(root);
    bindProductionEconomics(this, root);

    if (options?.isFirstRender) {
      // Size the intrinsic frame before the frame mixin handles V2's final
      // positioning. Do not capture its temporary size or coordinates.
      const { width, height } = options.position ?? this.position;
      this.setPosition({ width, height });
    } else this._bindWindowFrameSync(root);
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
    syncSaveStatus(root, this._saveStatus);
    root.querySelectorAll("[data-field], [data-building-string-list-field], [data-building-list-option], [data-agriculture-field], [data-worker-profile-field]").forEach((field) => {
      field.addEventListener("input", () => this._saveStatus.markDirty(this._saveFieldKey(field)));
    });
    this._autosizeTextareas(root);

    root.querySelectorAll("[data-field]").forEach((field) => {
      field.addEventListener("change", (event) => this._onFieldChange(event));
    });
    root.querySelectorAll("[data-worker-profile-field]").forEach((field) => field.addEventListener("change", (event) => this._onWorkerProfileEdit(event)));
    root.querySelectorAll("[data-building-labor-field]").forEach((field) => field.addEventListener("change", (event) => this._onLaborFieldChange(event)));
    root.querySelectorAll("[data-worker-choice-search]").forEach((field) => field.addEventListener("input", () => {
      const panel = field.closest(".fbls-worker-choice-panel");
      const query = field.value.toLowerCase().replaceAll("ё", "е").trim();
      let visible = 0;
      panel.querySelectorAll("[data-choice-search]").forEach((option) => {
        option.hidden = !option.dataset.choiceSearch.includes(query);
        if (!option.hidden) visible++;
      });
      panel.querySelector("[data-worker-choice-empty]").hidden = visible > 0;
    }));
    root.querySelectorAll(".fbls-worker-profile-choice > details").forEach((picker) => picker.addEventListener("toggle", () => {
      if (!picker.open) return;
      root.querySelectorAll(".fbls-worker-profile-choice > details[open]").forEach((other) => { if (other !== picker) other.open = false; });
      picker.querySelector("input[type='search']")?.focus({ preventScroll: true });
    }));

    if (this._profilePicker) {
      const state = this._profilePicker;
      const picker = root.querySelector(`[data-profile-picker="composition"][data-profile-index="${state.index}"]`);
      if (picker) {
        picker.open = true;
        const search = picker.querySelector("[data-worker-choice-search]");
        search.value = state.search;
        search.dispatchEvent(new Event("input", { bubbles: true }));
        picker.querySelector(".fbls-worker-choice-options").scrollTop = state.scroll;
      }
      this._profilePicker = null;
    }

    root.querySelectorAll("[data-building-worker-field]").forEach((field) => {
      field.addEventListener("change", (event) => this._onBuildingWorkerChange(event));
    });

    root.querySelectorAll("[data-building-housing-field]").forEach((field) => {
      field.addEventListener("change", (event) => this._onBuildingHousingChange(event));
    });

    root.querySelectorAll("[data-agriculture-field]").forEach((field) => {
      field.addEventListener("change", (event) => this._onAgricultureFieldChange(event));
    });

    root.querySelectorAll("[data-building-string-list-field], [data-building-list-option]").forEach((field) => {
      field.addEventListener("change", (event) => this._onBuildingStringListChange(event));
    });

    bindDelegatedActions(this, root, BUILDING_EDITOR_ACTIONS);

    focusApplicationContent(this, {
      root,
      options,
      preferredSelector: ".fbls-building-editor-tab.active, [data-action='building-editor-tab']"
    });
    if (this._profileFocus) {
      const key = this._profileFocus;
      [...root.querySelectorAll("[data-worker-profile-field]")].find((field) => field.dataset.profileSection === key.section
        && field.dataset.profileIndex === key.index && field.dataset.workerProfileField === key.field)?.focus({ preventScroll: true });
      this._profileFocus = null;
    }
    if (this._pickerRestore) {
      const state = this._pickerRestore;
      const picker = [...root.querySelectorAll("[data-building-list-picker]")].find(node => node.dataset.buildingListPicker === state.path);
      if (picker) {
        picker.open = true;
        const search = picker.querySelector("[data-building-list-search]");
        search.value = state.query;
        search.dispatchEvent(new Event("input", { bubbles: true }));
        picker.querySelector(".fbls-editor-list-options").scrollTop = state.scroll;
        [...picker.querySelectorAll("[data-building-list-option]")].find(node => node.value === state.value)?.focus({ preventScroll: true });
      }
      this._pickerRestore = null;
    }
  }

  _canEditBuilding() {
    const data = SkyholdData.get();
    const { holding } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
    return holdingPermissionContext(holding).canEditBuildings;
  }

  _prepareEditorTabs(building, { holding, data } = {}) {
    const laborMode = buildingLaborMode(building);
    building.laborLegacy = laborMode === "legacy";
    building.laborQd = laborMode === "qd";
    building.laborStaffSlots = ["legacy", "staff"].includes(laborMode);
    building.laborCapacityValue = building.labor?.capacityQd ?? "";
    building.laborModeOptions = [["legacy", "Прежние правила"], ["staff", "Постоянный штат"], ["qd", "Задания по QD"], ["passive", "Без работников"]]
      .map(([value, label]) => ({ value, label, selected: value === laborMode, disabled: value === "legacy" && laborMode !== "legacy" }));
    prepareProductionEconomics(this, building);
    building.workerProfileEditor = workerProfileEditorContext(building);
    this._workerProfileSignature = JSON.stringify(editableWorkerProfile(building));
    const isSpecial = Boolean(building?.isSpecialBuilding);
    this._prepareStructuredRules(building);
    for (const project of building.serviceProjectRows) project.participantPicker = projectParticipantPicker(project, holding, `${building.basePath}.serviceProjects.${project.projectIndex}.participantIds`);
    if (building.functions?.income) {
      const buildings = [...(data?.catalog?.buildings ?? []), ...(holding?.buildings?.list ?? [])];
      const trade = building.income?.trade;
      const selected = [trade?.service?.categoryTag, ...(String(trade?.allowedTagsText ?? "").split(","))].filter(Boolean);
      prepareTradePickers(building, tradeCategoryOptions(allResourceDefs(), buildings, selected));
    }
    const tabs = ["main", "workers", "construction"].map(buildingEditorTab);
    if (building.supportsServiceProjects) tabs.push(buildingEditorTab("projects"));
    if (building.showProductionBlock) tabs.push(buildingEditorTab("production"));
    if (building.hasAgriculture) tabs.push(buildingEditorTab("agriculture"));
    if (building.hasLivestock) tabs.push(buildingEditorTab("livestock"));
    if (building.showIncomeBlock) tabs.push(buildingEditorTab("income"));
    if (building.showDefenseBlock) tabs.push(buildingEditorTab("defense"));
    if (building.functions?.housing) tabs.push(buildingEditorTab("housing"));
    if (building.functions?.storage) tabs.push(buildingEditorTab("storage"));
    if (building.functions?.culture || building.hasConfiguredLeisure) {
      tabs.push(buildingEditorTab("culture"));
    }
    if (!tabs.some((tab) => tab.id === this.activeTab)) this.activeTab = tabs[0]?.id ?? "main";
    building.editorTabs = tabs.map((tab) => ({ ...tab, active: tab.id === this.activeTab }));
    if (isSpecial) {
      building.showEditorMain = false;
      building.showEditorWorkers = false;
      building.showEditorConstruction = !building.isBuilt;
      building.showEditorRules = false;
      building.showEditorProjects = false;
      building.showEditorProduction = false;
      building.showEditorAgriculture = false;
      building.showEditorLivestock = false;
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
    building.showEditorRules = false;
    building.showEditorProjects = this.activeTab === "projects";
    building.showEditorProduction = this.activeTab === "production";
    building.showEditorAgriculture = this.activeTab === "agriculture";
    building.showEditorLivestock = this.activeTab === "livestock";
    building.showEditorIncome = this.activeTab === "income";
    building.showEditorDefense = this.activeTab === "defense";
    building.showEditorHousing = this.activeTab === "housing";
    building.showEditorStorage = this.activeTab === "storage";
    building.showEditorCulture = this.activeTab === "culture";
    building.showEditorText = false;
  }

  _prepareStructuredRules(building) {
    const basePath = String(building?.basePath ?? "");
    const activation = building?.activation && typeof building.activation === "object" ? building.activation : {};
    const service = building?.service && typeof building.service === "object" ? building.service : null;
    const control = building?.control && typeof building.control === "object" ? building.control : null;
    const templateId = String(building?.templateId || building?.id || "");
    const projects = Array.isArray(building?.serviceProjects) ? building.serviceProjects : [];
    const supportsServiceProjects = Object.hasOwn(SERVICE_PROJECT_TEMPLATE_KINDS, templateId) || projects.length > 0;
    building.hasConfiguredLeisure = Boolean(service?.leisure && typeof service.leisure === "object");
    building.rulesView = {
      siteRequirementsText: String(building?.siteRequirementsText ?? ""),
      activationConditionText: String(building?.activationConditionText ?? ""),
      activation: {
        minWorkers: Math.max(0, Math.floor(Number(activation.minWorkers) || 0)),
        minOperationalQd: Math.max(0, Math.floor(Number(activation.minOperationalQd ?? building?.minOperationalQd) || 0)),
        requiresMeaningfulResult: activation.requiresMeaningfulResult === true
      },
      repeatSettlementEffects: building?.repeatSettlementEffects === true,
      leisure: {
        kind: String(service?.leisure?.kind ?? ""),
        capacity: Math.max(0, Math.floor(Number(service?.leisure?.capacity) || 0)),
        qdPerCapacity: Math.max(0.01, Number(service?.leisure?.qdPerCapacity) || 1),
        minWorkers: Math.max(1, Math.floor(Number(service?.leisure?.minWorkers ?? activation.minWorkers) || 0)),
        functionIdOptions: [["culture", "Культура и услуги"], ["income", "Доход"], ["production", "Производство"], ["defense", "Оборона"], ["storage", "Склад"]]
          .map(([value, label]) => ({ value, label, selected: value === String(service?.leisure?.functionId || "culture") }))
      },
      upgradesFromTemplateIdsText: uniqueStringList(building?.upgradesFromTemplateIds).join(", "),
      service: service ? {
        ...service,
        capacity: Math.max(0, Math.floor(Number(service.capacity) || 0)),
        capacityBase: Math.max(0, Math.floor(Number(service.capacityBase) || 0)),
        capacityPerWorker: Math.max(0, Math.floor(Number(service.capacityPerWorker) || 0)),
        capacityPerWorkerStep: Math.max(0, Math.floor(Number(service.capacityPerWorkerStep) || 0)),
        workerStep: Math.max(1, Math.floor(Number(service.workerStep) || 1)),
        maximumCapacity: Math.max(0, Math.floor(Number(service.maximumCapacity) || 0)),
        coveredBuildingIdsText: uniqueStringList(service.coveredBuildingIds).join(", "),
        coverageKindOptions: [
          ["population", "Жители"],
          ["buildings", "Здания"],
          ["target-buildings", "Выбранные здания"],
          ["patients", "Пациенты"]
        ].map(([value, label]) => ({ value, label, selected: value === String(service.coverageKind ?? "population") }))
      } : null,
      control: control ? {
        ...control,
        ceilingValue: Number.isFinite(Number(control.ceiling)) ? Number(control.ceiling) : ""
      } : null,
      basePath
    };
    building.supportsServiceProjects = supportsServiceProjects;
    building.serviceProjectRows = projects.map((project, projectIndex) => {
      const status = String(project?.status ?? "planned");
      const decision = String(project?.gmDecisionStatus ?? "none");
      return {
        ...project,
        projectIndex,
        participantIdsText: uniqueStringList(project?.participantIds).join(", "),
        targetIdsText: uniqueStringList(project?.targetIds).join(", "),
        statusOptions: SERVICE_PROJECT_STATUS_OPTIONS.map(([value, label]) => ({ value, label, selected: value === status })),
        decisionOptions: SERVICE_PROJECT_DECISION_OPTIONS.map(([value, label]) => ({ value, label, selected: value === decision })),
        resourceCosts: (Array.isArray(project?.resourceCosts) ? project.resourceCosts : []).map((cost, costIndex) => ({
          ...cost,
          projectIndex,
          costIndex,
          label: resourceLabel(cost?.resourceId),
          icon: resourceIcon(cost?.resourceId),
          qtyPath: `${basePath}.serviceProjects.${projectIndex}.resourceCosts.${costIndex}.qty`
        }))
      };
    });
  }

  _onEditorTab(event) {
    event.preventDefault();
    event.stopPropagation();
    const next = String(event.currentTarget?.dataset?.editorTab ?? "");
    if (!next || next === this.activeTab) return;
    this.activeTab = next;
    this.requestRender();
  }

  async _onWorkerProfileEdit(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    const control = event.currentTarget;
    this._profileFocus = control.dataset.workerProfileField ? { section: control.dataset.profileSection, index: control.dataset.profileIndex, field: control.dataset.workerProfileField } : null;
    const signature = this._workerProfileSignature;
    const change = {
      section: control.dataset.profileSection, index: Number(control.dataset.profileIndex),
      field: control.dataset.workerProfileField,
      operation: control.dataset.action === "worker-profile-add" ? "add" : (control.dataset.action === "worker-profile-remove" ? "remove" : (control.dataset.action === "worker-profile-up" ? "up" : "change")),
      value: control.type === "checkbox" ? control.checked : control.value
    };
    if (control.dataset.action === "worker-profile-pick") {
      change.field = change.section === "composition" ? "background" : "match";
      change.value = control.dataset.profileValue;
      const panel = control.closest(".fbls-worker-choice-panel");
      this._profilePicker = change.section === "composition" ? {
        index: change.index,
        search: panel?.querySelector("[data-worker-choice-search]")?.value ?? "",
        scroll: panel?.querySelector(".fbls-worker-choice-options")?.scrollTop ?? 0
      } : null;
    }
    const result = await this._saveTransaction((data) => {
      const { building } = this._getMutableBuilding(data);
      if (!building || JSON.stringify(editableWorkerProfile(building)) !== signature) return SkyholdData.skipTransaction(false);
      building.workerProfile = changeWorkerProfile(building, change);
      return true;
    }, { reason: "building-editor:worker-profile", scope: this.templateId ? "catalog" : "holdings" });
    if (!result) ui.notifications.warn("Профиль изменился. Окно обновлено; повторите правку.");
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
    this._editorDisclosures.close();
    this._editorPickers.close();
    stopBuildingAudioTrack(this);
    removeBuildingAudioTrackHeader(this);
    await super._onClose(options);
    SkyholdBuildingEditor.instances.delete(this);
    unbindDelegatedActions(this);
    hideFloatingTooltip(this);
    this._unbindGlobalInputGuard();
    this._unbindWindowFrameSync();
    const manager = getActiveSkyholdManager();
    const managerRender = manager?._pendingExternalRerender
      ? requestSkyholdAppRender({ deferForActiveWindow: false })
      : null;
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

  async _onLaborFieldChange(event) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    const field = event.currentTarget, key = field.dataset.buildingLaborField;
    try {
      await this._updateMutableBuilding(({ holding, building }) => {
        if (key === "mode") {
          if (!["staff", "qd", "passive"].includes(field.value)) return SkyholdData.skipTransaction(false);
          const staff = (holding?.people?.list ?? []).filter((person) => person.staffAppointment?.buildingId === building.id);
          if (field.value !== "staff" && staff.length) {
            throw new Error(`Смена режима затрагивает штат: ${staff.map((person) => person.name || person.id).join(", ")}. Сначала снимите этих сотрудников из штата в плане работ, затем смените режим.`);
          }
          building.labor = { version: 1, mode: field.value, capacityQd: building.labor?.capacityQd ?? null };
          building.workersMin = 0;
          if (building.workerProfile) building.workerProfile.workersMin = 0;
          if (building.activation) building.activation.minWorkers = 0;
          if (field.value === "passive") {
            building.activation = { ...building.activation, minOperationalQd: 0, requiresMeaningfulResult: false };
            building.minOperationalQd = 0;
          }
        } else if (key === "capacityQd" && buildingLaborMode(building) === "qd") {
          const value = field.value.trim() === "" ? null : Number(field.value);
          if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new Error("Предел QD должен быть целым неотрицательным числом; пустое поле означает отсутствие предела.");
          building.labor.capacityQd = value;
        } else return SkyholdData.skipTransaction(false);
        return true;
      }, { reason: "building-editor:labor" });
      this.requestRender(); requestSkyholdAppRender();
    } catch (error) {
      ui.notifications.warn(error.message || "Не удалось изменить способ работы.");
      this.requestRender();
    }
  }

  async _onFieldChange(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;

    const field = event.currentTarget;
    const path = field.dataset.field;
    if (!path) return;

    const value = fieldValue(field);

    try {
      const updated = await this._saveTransaction((data) => {
        const scopedPath = this._resolveBuildingScopedPath(data, path);
        if (!scopedPath) return SkyholdData.skipTransaction(false);
        if (/\.functions\.culture$/.test(scopedPath) && value === false) {
          foundry.utils.setProperty(data, scopedPath, false);
          foundry.utils.setProperty(data, scopedPath.replace(/\.functions\.culture$/, ".religion.religious"), false);
        } else {
          foundry.utils.setProperty(data, scopedPath, value);
        }
        const activeLineMatch = scopedPath.match(/^(.*\.productionLines)\.(\d+)\.active$/);
        if (activeLineMatch && value === true) {
          const buildingPath = activeLineMatch[1].replace(/\.productionLines$/, "");
          const building = foundry.utils.getProperty(data, buildingPath);
          if (building?.productionSelection?.exclusive === true) {
            const selectedIndex = Number(activeLineMatch[2]);
            for (let index = 0; index < (building.productionLines ?? []).length; index += 1) {
              building.productionLines[index].active = index === selectedIndex;
            }
          }
        }
        return true;
      }, { reason: `building-editor:field:${path}`, scope: this.templateId ? "catalog" : "holdings" });
      if (!updated) return;
      const shouldRefresh = /workersMax|workersMin|constructionStatus|lifecycle|condition|repair|requiredBuildingIds|materialCosts|contents|type$|functions|productionLines|expenseMode|autoCollect|income|livestock|defense|requirements|bonuses|religion|activation|service|control|repeatSettlementEffects|\.img$|\.image$|icon$/.test(path);
      if (shouldRefresh) this.requestRender();
    } catch (error) {
      console.error("FBL Skyhold | Failed to update building field", error);
      ui.notifications.error("Не удалось сохранить поле постройки. Подробности в консоли.");
    }
  }

  async _onBuildingStringListChange(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const field = event.currentTarget;
    const picker = field.closest?.("[data-building-list-picker]");
    const path = String(field.dataset?.buildingStringListField ?? picker?.dataset.buildingListPicker ?? "");
    if (!path) return;
    const values = buildingPickerValues(field);
    if (picker) this._pickerRestore = { path, value: field.value, query: picker.querySelector("[data-building-list-search]").value,
      scroll: picker.querySelector(".fbls-editor-list-options").scrollTop };
    try {
      const updated = await this._saveTransaction((data) => {
        const scopedPath = this._resolveBuildingScopedPath(data, path);
        if (!scopedPath) return SkyholdData.skipTransaction(false);
        foundry.utils.setProperty(data, scopedPath, values);
        return true;
      }, { reason: `building-editor:string-list:${path}`, scope: this.templateId ? "catalog" : "holdings" });
      if (!updated) return;
      this.requestRender();
      requestSkyholdAppRender();
    } catch (error) {
      console.error("FBL Skyhold | Failed to update building string list", error);
      ui.notifications.error("Не удалось сохранить список здания. Подробности в консоли.");
    }
  }

  _agricultureRelativePath(path = "") {
    const value = String(path ?? "").trim();
    const marker = ".agriculture.";
    const markerIndex = value.indexOf(marker);
    if (markerIndex >= 0) return value.slice(markerIndex + marker.length);
    if (value.startsWith("agriculture.")) return value.slice("agriculture.".length);
    return value;
  }

  async _onAgricultureFieldChange(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const field = event.currentTarget;
    const relativePath = this._agricultureRelativePath(field?.dataset?.agricultureField);
    if (!relativePath || /(?:^|\.)lastOperationId$/.test(relativePath)) return;
    const value = fieldValue(field);
    try {
      const updated = await this._updateMutableBuilding(({ building }) => {
        const agriculture = normalizeAgricultureBuilding(building?.agriculture, { building });
        if (!agriculture) return SkyholdData.skipTransaction(false);
        foundry.utils.setProperty(agriculture, relativePath, value);
        building.agriculture = normalizeAgricultureBuilding(agriculture, { building });
        return true;
      }, { reason: `building-editor:agriculture-field:${relativePath}` });
      if (!updated) return;
      this.requestRender();
      requestSkyholdAppRender();
    } catch (error) {
      console.error("FBL Skyhold | Failed to update agriculture field", error);
      ui.notifications.error("Не удалось сохранить настройку участка. Подробности в консоли.");
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
        const current = this._getMutableBuilding();
        const person = (current.holding?.people?.list ?? []).find((row) => String(row?.id ?? "") === String(field.value ?? ""));
        const decision = await confirmBuildingWorkerAdmission({ manager, building: current.building, person });
        if (!decision.allowed) { this.requestRender(); return; }
        const updated = await this._updateMutableBuilding(({ holding, building }) => {
          if (!holding || !building) return SkyholdData.skipTransaction(false);
          return manager._setBuildingSlot(holding, building.id, Number(parts[1]), field.value || "", decision)
            || SkyholdData.skipTransaction(false);
        }, { reason: "building-editor:worker-change", requireHolding: true });
        if (!updated) return;
      } else {
        const updated = await this._saveTransaction((data) => {
          const scopedPath = this._resolveBuildingScopedPath(data, path);
          if (!scopedPath) return SkyholdData.skipTransaction(false);
          foundry.utils.setProperty(data, scopedPath, field.value || "");
          return true;
        }, { reason: "building-editor:worker-change", scope: this.templateId ? "catalog" : "holdings" });
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
    const rowId = row.id;
    SkyholdResourceCatalogEditor.pick({
      selectedId: row.resourceId,
      onSelect: async (resource) => {
        const updated = await this._updateMutableBuilding(({ building }) => {
          const target = building?.materialCosts?.find((candidate) => candidate.id === rowId);
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
    const field = event.currentTarget?.dataset?.prerequisiteMode === "any" ? "requiredAnyBuildingIds" : "requiredBuildingIds";
    const updated = await this._updateMutableBuilding(({ building }) => {
      if (!Array.isArray(building[field])) building[field] = [];
      building[field].push("");
    }, { reason: "building-editor:add-prerequisite" });
    if (!updated) return;
    this.requestRender();
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
      building.productionLines.push({ id: makeId("prod", 12), active: true, mode: "Новая линия", source: "workers", period: "day", contentId: "", resourceId: "wood", resource: "Древесина", outputQty: 1, workQd: 1, formula: "", expenses: "", requiresCollection: false, collectQd: 0, pendingQty: 0, storageRoomId: "outdoors", seasons: { spring: true, summer: true, autumn: true, winter: true } });
    }, { reason: "building-editor:add-production-line" });
    if (!updated) return;
    this.requestRender();
  }

  async _onDeleteProductionLine(event) {
    return this._submitProductionLineOperation(event, "deleteProductionLine");
  }

  async _onCancelProductionBatch(event) {
    return this._submitProductionLineOperation(event, "cancelProductionBatch");
  }

  async _submitProductionLineOperation(event, type) {
    event.preventDefault();
    if (!this._canEditBuilding() || this._productionOperationBusy) return;
    const index = Number(event.currentTarget?.dataset?.index);
    const data = SkyholdData.view();
    const target = this._getMutableBuilding(data);
    const line = Number.isInteger(index) && index >= 0 ? target?.building?.productionLines?.[index] : null;
    if (!line?.id) return;
    const batchId = type === "cancelProductionBatch" ? String(event.currentTarget?.dataset?.batchId ?? "") : "";
    if (this.templateId) {
      if (type !== "deleteProductionLine" || !game.user?.isGM) return;
      await this._updateMutableBuilding(({ building }) => { building.productionLines.splice(index, 1); }, { reason: "building-editor:delete-production-line" });
      this.requestRender();
      return;
    }
    if (!globalThis.confirm?.(`${type === "deleteProductionLine" ? "Удалить линию и отменить все её партии" : batchId ? "Отменить выбранную партию" : "Отменить все партии и остановить линию"} «${line.mode || "Производство"}»? Пригодный резерв сырья будет возвращён по чеку. Просроченные партии и испорченное сырьё списываются; затраченный труд не возвращается.`)) return;
    const key = `${type}:${line.id}:${batchId}`;
    this._productionRetries ??= new Map();
    const command = this._productionRetries.get(key) ?? { type, operationId: makeId("production", 20),
      holdingId: this.holdingId, buildingId: target.building.id, lineId: line.id, ...(batchId ? { batchId } : {}), expectedRevision: data.meta.revision };
    this._productionRetries.set(key, command);
    this._productionOperationBusy = true;
    try {
      const result = await requestConstructionOperation(command);
      this._productionRetries.delete(key);
      if (!result?.ok) globalThis.ui?.notifications?.warn?.(result?.reason || "Операция не выполнена.");
      else globalThis.ui?.notifications?.info?.(result.summary || "Производственная партия обновлена.");
      this.requestRender();
      requestSkyholdAppRender();
    } catch (error) {
      if (!error.retryable) this._productionRetries.delete(key);
      globalThis.ui?.notifications?.warn?.(error.message || "Операция не выполнена.");
      if (error.code === "conflict") this.requestRender();
    } finally { this._productionOperationBusy = false; }
  }

  _onPickProductionResource(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const index = Number(event.currentTarget?.dataset?.index ?? -1);
    const line = this._getMutableBuilding()?.building?.productionLines?.[index];
    if (!Number.isInteger(index) || index < 0 || !line) return;
    const lineId = line.id;
    SkyholdResourceCatalogEditor.pick({
      selectedId: line.resourceId,
      onSelect: async (resource) => {
        const updated = await this._updateMutableBuilding(({ building }) => {
          const target = building?.productionLines?.find((candidate) => candidate.id === lineId);
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

  _onPickProductionExpense(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const index = Number(event.currentTarget?.dataset?.index ?? -1);
    const lineId = this._getMutableBuilding()?.building?.productionLines?.[index]?.id;
    if (!lineId) return;
    const controls = event.currentTarget.closest(".fbls-expense-picker");
    const qty = Math.max(1, Math.floor(Number(controls?.querySelector("[data-expense-qty]")?.value) || 1));
    const operator = controls?.querySelector("[data-expense-operator]")?.value === "or" ? "or" : "and";
    SkyholdResourceCatalogEditor.pick({ onSelect: async (resource) => {
      const updated = await this._updateMutableBuilding(({ building }) => {
        const target = building.productionLines?.find((line) => line.id === lineId);
        if (!target) return SkyholdData.skipTransaction(false);
        target.expenses = appendProductionExpense(target.expenses, resource.id, qty, operator);
        return true;
      }, { reason: "building-editor:pick-production-expense" });
      if (updated) {
        this.requestRender({ focus: false });
        requestSkyholdAppRender();
      }
    } });
  }

  async _onAddBuildingContent(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const updated = await this._updateMutableBuilding(({ building }) => {
      if (!Array.isArray(building.contents)) building.contents = [];
      building.contents.push({ id: makeId("content", 12), name: "Содержимое", qty: 0, capacity: 0, notes: "" });
    }, { reason: "building-editor:add-content" });
    if (!updated) return;
    this.requestRender();
  }

  async _onDeleteBuildingContent(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const index = Number(event.currentTarget?.dataset?.index);
    if (!Number.isFinite(index)) return;
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

  async _onAddAgricultureCrop(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const updated = await this._updateMutableBuilding(({ building }) => {
      const agriculture = normalizeAgricultureBuilding(building?.agriculture, { building });
      if (!agriculture) return SkyholdData.skipTransaction(false);
      const usedIds = new Set(agriculture.crops.map((crop) => String(crop?.id ?? "")));
      let id = makeId("crop", 12);
      while (usedIds.has(id)) id = makeId("crop", 12);
      agriculture.crops.push({
        id,
        label: "Новая культура",
        resourceId: "custom",
        outputQty: 1,
        sowingSeasons: ["spring"],
        sowingWorkQd: 1,
        growingQd: 40,
        harvestWorkQd: 1,
        expiryRule: "qd",
        readyExpiryQd: 40
      });
      if (!agriculture.activeCropId) agriculture.activeCropId = id;
      building.agriculture = normalizeAgricultureBuilding(agriculture, { building });
      return true;
    }, { reason: "building-editor:add-agriculture-crop" });
    if (!updated) return;
    this.requestRender();
    requestSkyholdAppRender();
  }

  async _onDeleteAgricultureCrop(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const index = Number(event.currentTarget?.dataset?.index);
    if (!Number.isInteger(index) || index < 0) return;
    const updated = await this._updateMutableBuilding(({ building }) => {
      const agriculture = normalizeAgricultureBuilding(building?.agriculture, { building });
      const removed = agriculture?.crops?.[index];
      if (!agriculture || !removed) return SkyholdData.skipTransaction(false);
      agriculture.crops.splice(index, 1);
      if (agriculture.activeCropId === removed.id) {
        agriculture.activeCropId = agriculture.crops[0]?.id ?? "";
        agriculture.state = {
          version: 1,
          phase: "empty",
          lastSownSeasonKey: agriculture.state.lastSownSeasonKey,
          lastMissedSowingSeasonKey: agriculture.state.lastMissedSowingSeasonKey,
          lastOperationId: agriculture.state.lastOperationId
        };
      }
      building.agriculture = normalizeAgricultureBuilding(agriculture, { building });
      return true;
    }, { reason: "building-editor:delete-agriculture-crop" });
    if (!updated) return;
    this.requestRender();
    requestSkyholdAppRender();
  }

  _onPickAgricultureResource(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const index = Number(event.currentTarget?.dataset?.index);
    const mutable = this._getMutableBuilding();
    const agriculture = normalizeAgricultureBuilding(mutable?.building?.agriculture, { building: mutable?.building });
    const crop = agriculture?.crops?.[index];
    if (!Number.isInteger(index) || index < 0 || !crop) return;
    const cropId = crop.id;
    SkyholdResourceCatalogEditor.pick({
      selectedId: crop.resourceId,
      onSelect: async (resource) => {
        const updated = await this._updateMutableBuilding(({ building }) => {
          const fresh = normalizeAgricultureBuilding(building?.agriculture, { building });
          const target = fresh?.crops?.find((candidate) => candidate.id === cropId);
          if (!fresh || !target) return SkyholdData.skipTransaction(false);
          target.resourceId = String(resource?.id ?? "custom");
          target.label = String(resource?.label ?? resource?.id ?? target.label ?? "Культура");
          building.agriculture = normalizeAgricultureBuilding(fresh, { building });
          return true;
        }, { reason: "building-editor:pick-agriculture-resource" });
        if (!updated) return;
        this.requestRender({ focus: false });
        requestSkyholdAppRender();
      }
    });
  }

  async _onToggleAgricultureSeason(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const index = Number(event.currentTarget?.dataset?.index);
    const seasonId = String(event.currentTarget?.dataset?.seasonId ?? "").trim();
    if (!Number.isInteger(index) || index < 0 || !["spring", "summer", "autumn", "winter"].includes(seasonId)) return;
    const updated = await this._updateMutableBuilding(({ building }) => {
      const agriculture = normalizeAgricultureBuilding(building?.agriculture, { building });
      const crop = agriculture?.crops?.[index];
      if (!agriculture || !crop) return SkyholdData.skipTransaction(false);
      const seasons = new Set(crop.sowingSeasons);
      if (seasons.has(seasonId)) seasons.delete(seasonId);
      else seasons.add(seasonId);
      crop.sowingSeasons = ["spring", "summer", "autumn", "winter"].filter((season) => seasons.has(season));
      building.agriculture = normalizeAgricultureBuilding(agriculture, { building });
      return true;
    }, { reason: "building-editor:toggle-agriculture-season" });
    if (!updated) return;
    this.requestRender();
    requestSkyholdAppRender();
  }

  async _onAddLivestockCohort(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    let full = false;
    const updated = await this._updateMutableBuilding(({ building }) => {
      const livestock = normalizeLivestockBuilding(building?.livestock, { building });
      if (!livestock) return SkyholdData.skipTransaction(false);
      if (livestockHeadcount(livestock.state) >= livestock.profile.capacity) {
        full = true;
        return SkyholdData.skipTransaction(false);
      }
      livestock.state.young.push({
        id: makeId("young", 12),
        qty: 1,
        ageQd: 0,
        bornSeasonKey: ""
      });
      building.livestock = livestock;
      return true;
    }, { reason: "building-editor:add-livestock-cohort" });
    if (!updated) {
      if (full) ui.notifications?.warn?.("В этом здании уже достигнут предел в 12 голов.");
      return;
    }
    this.requestRender();
    requestSkyholdAppRender();
  }

  async _onDeleteLivestockCohort(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const cohortId = String(event.currentTarget?.dataset?.livestockCohortId ?? "").trim();
    if (!cohortId) return;
    const updated = await this._updateMutableBuilding(({ building }) => {
      const livestock = normalizeLivestockBuilding(building?.livestock, { building });
      if (!livestock) return SkyholdData.skipTransaction(false);
      const index = livestock.state.young.findIndex((cohort) => String(cohort?.id ?? "") === cohortId);
      if (index < 0) return SkyholdData.skipTransaction(false);
      livestock.state.young.splice(index, 1);
      building.livestock = livestock;
      return true;
    }, { reason: "building-editor:delete-livestock-cohort" });
    if (!updated) return;
    this.requestRender();
    requestSkyholdAppRender();
  }

  async _onAddServiceProject(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const updated = await this._updateMutableBuilding(({ building }) => {
      if (!Array.isArray(building.serviceProjects)) building.serviceProjects = [];
      const templateId = String(building?.templateId || building?.id || "");
      building.serviceProjects.push({
        id: makeId("service-project", 16),
        kind: SERVICE_PROJECT_TEMPLATE_KINDS[templateId] ?? "project",
        title: "Новый проект",
        status: "planned",
        progressQd: 0,
        targetQd: 1,
        participantIds: [],
        targetIds: [],
        resourceCosts: [],
        notes: "",
        gmDecisionStatus: "none"
      });
      return true;
    }, { reason: "building-editor:add-service-project" });
    if (!updated) return;
    this.requestRender();
    requestSkyholdAppRender();
  }

  async _onDeleteServiceProject(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const projectIndex = Number(event.currentTarget?.dataset?.projectIndex);
    if (!Number.isInteger(projectIndex) || projectIndex < 0) return;
    const updated = await this._updateMutableBuilding(({ building }) => {
      if (!Array.isArray(building.serviceProjects?.[projectIndex]?.resourceCosts)) {
        if (!Array.isArray(building.serviceProjects) || !building.serviceProjects[projectIndex]) return SkyholdData.skipTransaction(false);
      }
      building.serviceProjects.splice(projectIndex, 1);
      return true;
    }, { reason: "building-editor:delete-service-project" });
    if (!updated) return;
    this.requestRender();
    requestSkyholdAppRender();
  }

  async _onAddServiceProjectCost(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const projectIndex = Number(event.currentTarget?.dataset?.projectIndex);
    if (!Number.isInteger(projectIndex) || projectIndex < 0) return;
    const updated = await this._updateMutableBuilding(({ building }) => {
      const project = building?.serviceProjects?.[projectIndex];
      if (!project) return SkyholdData.skipTransaction(false);
      if (!Array.isArray(project.resourceCosts)) project.resourceCosts = [];
      project.resourceCosts.push({ resourceId: "wood", qty: 1 });
      return true;
    }, { reason: "building-editor:add-service-project-cost" });
    if (!updated) return;
    this.requestRender();
  }

  async _onDeleteServiceProjectCost(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const projectIndex = Number(event.currentTarget?.dataset?.projectIndex);
    const costIndex = Number(event.currentTarget?.dataset?.costIndex);
    if (![projectIndex, costIndex].every((value) => Number.isInteger(value) && value >= 0)) return;
    const updated = await this._updateMutableBuilding(({ building }) => {
      const costs = building?.serviceProjects?.[projectIndex]?.resourceCosts;
      if (!Array.isArray(costs) || !costs[costIndex]) return SkyholdData.skipTransaction(false);
      costs.splice(costIndex, 1);
      return true;
    }, { reason: "building-editor:delete-service-project-cost" });
    if (!updated) return;
    this.requestRender();
  }

  _onPickServiceProjectResource(event) {
    event.preventDefault();
    if (!this._canEditBuilding()) return;
    const projectIndex = Number(event.currentTarget?.dataset?.projectIndex);
    const costIndex = Number(event.currentTarget?.dataset?.costIndex);
    const project = this._getMutableBuilding()?.building?.serviceProjects?.[projectIndex];
    const cost = project?.resourceCosts?.[costIndex];
    if (![projectIndex, costIndex].every((value) => Number.isInteger(value) && value >= 0) || !cost) return;
    const projectId = project.id;
    // Cost rows have no persistent IDs. Reject an obsolete picker instead of
    // interpreting its index against a reordered or edited list.
    const costsSnapshot = JSON.stringify(project.resourceCosts);
    SkyholdResourceCatalogEditor.pick({
      selectedId: cost.resourceId,
      onSelect: async (resource) => {
        const updated = await this._updateMutableBuilding(({ building }) => {
          const costs = building?.serviceProjects?.find((candidate) => candidate.id === projectId)?.resourceCosts;
          if (JSON.stringify(costs) !== costsSnapshot) throw new Error("Список затрат проекта изменился. Откройте выбор ресурса заново.");
          const target = costs?.[costIndex];
          if (!target) return SkyholdData.skipTransaction(false);
          target.resourceId = String(resource?.id ?? "wood");
          return true;
        }, { reason: "building-editor:pick-service-project-resource" });
        if (updated) this.requestRender({ focus: false });
      }
    });
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

  _getMutableBuilding(data = SkyholdData.get()) {
    const { holding, index: holdingIndex } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
    const buildingIndex = (holding?.buildings?.list ?? []).findIndex((item) => item.id === this.buildingId);
    const building = buildingIndex >= 0 ? holding.buildings.list[buildingIndex] : null;
    return { data, holding, holdingIndex, building, buildingIndex };
  }

  _saveFieldKey(field) {
    const dataset = field.dataset;
    if (dataset.field) return `building-editor:field:${dataset.field}`;
    if (dataset.buildingStringListField) return `building-editor:string-list:${dataset.buildingStringListField}`;
    const picker = field.closest?.("[data-building-list-picker]");
    if (picker) return `building-editor:string-list:${picker.dataset.buildingListPicker}`;
    if (dataset.agricultureField) return `building-editor:agriculture-field:${this._agricultureRelativePath(dataset.agricultureField)}`;
    return "building-editor:worker-profile";
  }

  _saveTransaction(updater, options) {
    return this._trackFieldSave(this._saveStatus.track(() => SkyholdData.transaction(async (data) => {
      const priorContext = this._getMutableBuilding(data);
      const before = (priorContext?.building?.productionLines ?? []).map((line) => ({ ...line }));
      const priorHolding = priorContext.holding ?? { buildings: { list: priorContext.building ? [priorContext.building] : [] }, people: { list: [] } };
      const priorIssues = validateHybridLaborHolding(priorHolding, { targets: buildWorkAllocationTargets(priorHolding) }).issues;
      const result = await updater(data);
      assertProductionIdentityUnchanged(before, this._getMutableBuilding(data)?.building?.productionLines ?? []);
      const context = this._getMutableBuilding(data);
      if (context.building) {
        const holding = context.holding ?? { buildings: { list: [context.building] }, people: { list: [] } };
        const validation = validateHybridLaborHolding(holding, { targets: buildWorkAllocationTargets(holding) });
        const added = newHybridLaborIssues(priorIssues, validation.issues);
        if (added.length) throw new Error(added[0].message);
      }
      return result;
    }, {
      ...options, scope: this.templateId ? "catalog" : "holdings"
    }), { key: options.reason }));
  }

  async _updateMutableBuilding(updater, { reason = "building-editor:update", requireHolding = false } = {}) {
    if (typeof updater !== "function") return null;
    return this._saveTransaction(async (data) => {
      const context = this._getMutableBuilding(data);
      if (!context.building || (requireHolding && !context.holding)) return SkyholdData.skipTransaction(null);
      const result = await updater(context);
      return result === undefined ? true : result;
    }, { reason, scope: this.templateId ? "catalog" : "holdings" });
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
    width: 940,
    height: 500
  }
};
SkyholdBuildingEditor.PARTS = {
  body: {
    template: `modules/${MODULE_ID}/templates/building-editor.hbs`
  }
};
