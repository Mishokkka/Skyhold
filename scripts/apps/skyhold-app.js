import {
  canCurrentUserOpenSkyhold,
  getHoldingTypeLabel,
  HOLDING_TYPES,
  MODULE_ID
} from "../data/store.js";
import { HoldingService } from "../data/holding-service.js";
import {
  generateResidents,
  generatorOptionSets
} from "../generators/resident-generator.js";
import { traitBadges, traitMorale, traitOptions } from "../generators/trait-definitions.js";
import { CULTURE_NAMES } from "../generators/name-pools.js";
import { ageGroupFromAge, attributeSummary, normalizeBelief, workerTypeFromAttributes, workerTypeStyleFromAttributes } from "../generators/resident-rules.js";

import { SkyholdBuildingEditor, SkyholdCrewEditor, SkyholdBuildingTemplateBrowser, SkyholdMassCombatTagEditor } from "./editors.js";
import { registerSkyholdAppClass } from "./registry.js";
import { escapeHtml, joinList, rollD66, splitList, WORKER_TYPE_OPTIONS } from "../core/helpers.js";
import { HoldingDomain } from "./domains/holding-domain.js";
import { ResidentDomain } from "./domains/resident-domain.js";
import { BuildingDomain } from "./domains/building-domain.js";
import { AssignmentDomain } from "./domains/assignment-domain.js";
import { FinanceDomain } from "./domains/finance-domain.js";
import { UiDomain } from "./domains/ui-domain.js";
import { EventDomain } from "./domains/event-domain.js";
import { getCalendariaSnapshot, formatCalendariaDateTime, calendariaDateTimeToInput } from "../integrations/calendaria-bridge.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class SkyholdApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(options = {}) {
    super(options);
    this.activeTab = "overview";
    this.activeHoldingId = null;
    this.editingPersonId = null;
    this.expandedPersonId = null;
    this.expandedBuildingId = null;
    this.activeBuildingCategory = "all";
    this.activeStorageTab = "resources";
    this.activeStorageRoomId = "outdoors";
    this.activePeopleTab = "living";
    this.activeSpecialTab = "records";
    this.storageToolState = { adjust: false, move: false };
    this.crewEditor = null;
    this.residentFilters = {
      search: "",
      type: "all",
      work: "all",
      home: "all",
      morale: "all"
    };
    this.generatorConfig = {
      quantity: 3,
      culture: "current",
      arrival: "settlers",
      ageMode: "normal",
      traitMode: "normal"
    };
    this.generatorPreview = [];
    this.activeGeneratedPersonIndex = null;
  }

  static open() {
    if (!canCurrentUserOpenSkyhold()) {
      ui.notifications.warn("Окно владений сейчас доступно только ГМу.");
      return null;
    }

    if (!this.instance) this.instance = new this();
    return this.instance.render({ force: true, focus: true });
  }

  static rerenderOpen() {
    const app = this.instance;
    if (!app?.rendered) return;

    const active = document.activeElement;
    const activeEditor = active?.closest?.(
      ".fbls-person-editor.v2, .fbl-skyhold-building-editor, .fbl-skyhold-crew-editor, .fbl-skyhold-template-browser, .fbl-skyhold-mass-combat"
    );

    // Do not tear down controls while the user is actively typing/selecting inside
    // an editor. Merely having another Skyhold dialog open is no longer enough to
    // block the main app from refreshing.
    if (activeEditor) {
      app._pendingExternalRerender = true;
      return;
    }

    app._pendingExternalRerender = false;
    app.render({ force: true, focus: false });
  }

  render(options = {}) {
    const showOverlay = this.rendered && this.element && options?.skipLoadingOverlay !== true;
    const token = Symbol("fbl-skyhold-render");
    this._renderToken = token;

    if (showOverlay) {
      this._pendingScrollState = this._captureScrollState();
      this._showLoadingOverlay();
      const delay = Math.max(60, Number.isFinite(Number(options?.loadingDelay)) ? Number(options.loadingDelay) : 120);
      return new Promise((resolve, reject) => {
        window.setTimeout(() => {
          if (this._renderToken !== token) return resolve(this);
          try { resolve(super.render(options)); }
          catch (error) { reject(error); }
        }, delay);
      });
    }

    return super.render(options);
  }

  _showLoadingOverlay() {
    const shell = this.element?.querySelector?.(".fbls-shell") ?? this.element;
    if (shell) {
      shell.classList?.add?.("fbls-loading-active");
      const overlay = shell.querySelector?.("[data-loading-overlay]");
      if (overlay) overlay.setAttribute("aria-busy", "true");
    }

    const appShell = this.element?.closest?.(".application, .app, .window-app") ?? this.element?.parentElement?.closest?.(".application, .app, .window-app");
    const host = appShell?.querySelector?.(".window-content") ?? this.element?.parentElement ?? this.element;
    if (!host) return;
    host.classList?.add?.("fbls-loading-host");
    host.querySelector?.(".fbls-loading-window-overlay")?.remove?.();
    const overlay = document.createElement("div");
    overlay.className = "fbls-loading-overlay fbls-loading-window-overlay";
    const img = shell?.querySelector?.("[data-loading-overlay] img")?.getAttribute?.("src") || "";
    overlay.innerHTML = img ? `<img src="${img.replace(/"/g, "&quot;")}" alt="" />` : `<i class="fa-solid fa-spinner fa-spin"></i>`;
    host.appendChild(overlay);
    if (globalThis.requestAnimationFrame) requestAnimationFrame(() => overlay.classList.add("active")); else overlay.classList.add("active");
  }

  _clearLoadingOverlay() {
    const appShell = this.element?.closest?.(".application, .app, .window-app") ?? this.element?.parentElement?.closest?.(".application, .app, .window-app");
    const host = appShell?.querySelector?.(".window-content") ?? this.element?.parentElement ?? this.element;
    const overlay = host?.querySelector?.(".fbls-loading-window-overlay");
    if (!overlay) return;
    overlay.classList.remove("active");
    window.setTimeout(() => overlay.remove(), 90);
  }

  _captureScrollState() {
    const root = this.element;
    if (!root) return null;
    const appShell = root.closest?.(".application, .app, .window-app") ?? root.parentElement?.closest?.(".application, .app, .window-app");
    const windowContent = appShell?.querySelector?.(".window-content");
    const content = root.querySelector?.(".fbls-content");
    const peopleTable = root.querySelector?.(".fbls-people-table-wrap");
    return {
      rootTop: root.scrollTop ?? 0,
      contentTop: content?.scrollTop ?? 0,
      windowTop: windowContent?.scrollTop ?? 0,
      peopleTop: peopleTable?.scrollTop ?? 0,
      peopleLeft: peopleTable?.scrollLeft ?? 0
    };
  }

  _restoreScrollState(state = null) {
    if (!state || !this.element) return;
    const root = this.element;
    const appShell = root.closest?.(".application, .app, .window-app") ?? root.parentElement?.closest?.(".application, .app, .window-app");
    const windowContent = appShell?.querySelector?.(".window-content");
    const content = root.querySelector?.(".fbls-content");
    const peopleTable = root.querySelector?.(".fbls-people-table-wrap");
    if (windowContent) windowContent.scrollTop = state.windowTop ?? 0;
    if (content) content.scrollTop = state.contentTop ?? 0;
    if (peopleTable) {
      peopleTable.scrollTop = state.peopleTop ?? 0;
      peopleTable.scrollLeft = state.peopleLeft ?? 0;
    }
    root.scrollTop = state.rootTop ?? 0;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const data = HoldingService.getData();
    const canEdit = Boolean(game.user?.isGM);

    const visibleHoldings = this._getVisibleHoldings(data, canEdit);
    const activeHolding = this._resolveActiveHolding(data, visibleHoldings);
    const holdingIndex = activeHolding ? data.holdings.findIndex((holding) => holding.id === activeHolding.id) : -1;

    if (!canEdit && this.activeTab === "gm") this.activeTab = "overview";

    const canEditOverview = Boolean(canEdit || (activeHolding?.visibility !== "gm" && activeHolding?.gm?.playersCanEditOverview === true));
    const canEditBuildings = Boolean(canEdit || activeHolding?.gm?.playersCanEditBuildings === true);
    const canUseStorage = Boolean(canEdit || activeHolding?.gm?.playersCanUseStorage);
    const canManagePeople = Boolean(canEdit || activeHolding?.gm?.playersCanEditResidents === true);
    const canManageDefense = Boolean(canEdit || activeHolding?.gm?.playersCanEditDefense === true);
    const canEditBattle = Boolean(canEdit || activeHolding?.gm?.playersCanEditBattle === true);
    const canEditSpecial = Boolean(canEdit || activeHolding?.gm?.playersCanEditSpecial === true);
    const modeLabel = canEdit
      ? "Режим ГМа: редактирование включено."
      : (canEditBuildings && canUseStorage
        ? "Режим игрока: здания и хранилище доступны."
        : (canEditBuildings
          ? "Режим игрока: редактирование зданий доступно."
          : (canUseStorage
            ? "Режим игрока: хранилище доступно."
            : (canEditOverview ? "Режим игрока: редактирование обзора доступно." : "Режим игрока: только чтение."))));

    const tabs = this._prepareTabs(canEdit, activeHolding);
    for (const tab of tabs) tab.active = tab.id === this.activeTab;

    // Cache the currently prepared data for helper methods that need object paths.
    // Avoiding repeated HoldingService.getData() calls here matters: get() migrates and
    // normalizes the world setting, which is expensive on large settlements.
    this._contextData = data;
    this._contextHoldingId = activeHolding?.id ?? null;
    this._contextHoldingIndex = holdingIndex;

    if (this.activeStorageTab === "warehouses") this.activeStorageTab = "resources";
    if (this.activePeopleTab === "cemetery") this.activePeopleTab = "living";
    if (!this.activeSpecialTab) this.activeSpecialTab = "records";

    const active = {
      overview: this.activeTab === "overview",
      people: this.activeTab === "people",
      buildings: this.activeTab === "buildings",
      defense: this.activeTab === "defense",
      special: this.activeTab === "special",
      storage: this.activeTab === "storage",
      gm: this.activeTab === "gm"
    };
    const activeStorage = {
      resources: this.activeStorageTab === "resources",
      items: this.activeStorageTab === "items",
      warehouses: false,
      accounting: this.activeStorageTab === "accounting",
      log: this.activeStorageTab === "log"
    };

    const totals = this._prepareTotals(activeHolding);
    const moraleState = this._moraleState(this._calculateMorale(activeHolding));
    const finance = active.storage && activeStorage.accounting
      ? this._financeSummary(activeHolding)
      : { ...totals, moneyBuildings: [], productionPreview: [] };
    const defenseSummary = this._defenseSummary(activeHolding);
    const reputationSummary = this._reputationSummary(activeHolding);

    return {
      ...context,
      moduleId: MODULE_ID,
      loadingImage: String(activeHolding?.gm?.loadingImage ?? ""),
      data,
      canEdit,
      canEditBuildings,
      canUseStorage,
      canManagePeople,
      canManageDefense,
      canEditBattle,
      canEditSpecial,
      canEditOverview,
      modeLabel,
      isPlayer: !canEdit,
      holding: activeHolding,
      holdingIndex,
      hasHolding: Boolean(activeHolding),
      holdingOptions: visibleHoldings.map((holding) => ({
        id: holding.id,
        name: holding.name,
        selected: activeHolding?.id === holding.id,
        typeLabel: getHoldingTypeLabel(holding.type)
      })),
      typeOptions: Object.entries(HOLDING_TYPES).map(([value, label]) => ({
        value,
        label,
        selected: activeHolding?.type === value
      })),
      visibilityOptions: [
        { value: "public", label: "Игроки", selected: activeHolding?.visibility !== "gm" },
        { value: "gm", label: "Только ГМ", selected: activeHolding?.visibility === "gm" }
      ],
      holdingIsGmOnly: activeHolding?.visibility === "gm",
      holdingVisibilityTitle: activeHolding?.visibility === "gm" ? "Владение скрыто от игроков. Нажмите, чтобы показать игрокам." : "Владение видно игрокам. Нажмите, чтобы скрыть от игроков.",
      holdingTypeLabel: activeHolding ? getHoldingTypeLabel(activeHolding.type) : "Нет владений",
      contextLabels: this._contextLabels(activeHolding),
      tabs,
      active,
      rows: this._prepareRows(activeHolding, canManagePeople, this.activeTab, { canEditBuildings, activePeopleTab: this.activePeopleTab }),
      storageContext: active.storage ? this._storageContext(activeHolding, canUseStorage, this.activeStorageRoomId) : null,
      activeStorage,
      activeSpecial: {
        records: this.activeSpecialTab === "records" || !["records", "cemetery", "defense"].includes(this.activeSpecialTab),
        cemetery: this.activeSpecialTab === "cemetery",
        defense: false
      },
      specialTabs: active.special ? this._prepareSpecialTabs(activeHolding) : [],
      totals,
      finance,
      moraleState,
      beliefSummary: this._beliefSummary(activeHolding),
      calendarContext: this._calendarHeaderContext(activeHolding, holdingIndex, canEdit),
      development: this._developmentSummary(activeHolding),
      reputationSummary,
      defenseSummary,
      defenseContext: (active.defense || active.special) ? this._defenseContext(activeHolding) : null,
      residentTransfer: active.gm ? this._residentTransferContext(activeHolding, data) : null,
      constructionCrew: active.buildings ? this._constructionCrew(activeHolding) : null,
      buildingTabs: active.buildings ? this._prepareBuildingTabs(activeHolding) : [],
      buildingTemplates: (active.buildings || active.gm) ? this._buildingTemplateContext(activeHolding, data) : { rows: [], available: [], locked: [], hasRows: false, availableCount: 0, lockedCount: 0 },
      buildingCategoryOptions: active.buildings ? this._buildingCategoryOptions() : [],
      residentFilters: this.residentFilters,
      residentFilterOptions: active.people ? this._residentFilterOptions(activeHolding) : { types: [], work: [], home: [], morale: [] },
      peopleTabs: [],
      generator: active.gm ? this._prepareGeneratorContext(activeHolding) : null,
      resourceCatalog: active.gm ? this._resourceCatalogContext(data, canEdit) : { rows: [], builtins: "", builtinCount: 0, hasRows: false },
      peopleColspan: canManagePeople ? 10 : 9,
      cemeteryColspan: canManagePeople ? 6 : 5,
      cemeteryCount: (activeHolding?.people?.list ?? []).filter((person) => person?.dead).length
    };
  }


  _calendarHeaderContext(holding, holdingIndex = -1, canEdit = false) {
    const snapshot = getCalendariaSnapshot();
    const stored = holding?.gm?.calendaria ?? {};
    const lastDateTime = stored.lastDateTime && typeof stored.lastDateTime === "object" ? stored.lastDateTime : null;
    const lastText = lastDateTime
      ? formatCalendariaDateTime(lastDateTime)
      : (String(stored.lastDateText ?? stored.lastDateKey ?? "").trim() || "не задано");
    const lastInput = lastDateTime
      ? calendariaDateTimeToInput(lastDateTime)
      : String(stored.lastDateText ?? stored.lastDateKey ?? "").trim();
    const seasonText = this._calendarSeasonText(snapshot.season);
    const currentFullText = [snapshot.available ? snapshot.text : "Calendaria не найдена", seasonText].filter(Boolean).join(" · ");
    return {
      available: Boolean(snapshot.available),
      currentText: snapshot.available ? snapshot.text : "Calendaria не найдена",
      seasonText,
      currentTitle: snapshot.available ? `Текущая дата Calendaria: ${currentFullText}` : "Calendaria не активна или не обнаружена.",
      lastText,
      lastInput,
      lastTitle: lastDateTime ? `Последнее обновление поселения: ${lastText}` : "Дата последнего обновления поселения не задана.",
      canEdit,
      path: holdingIndex >= 0 ? `holdings.${holdingIndex}.gm.calendaria.lastDateText` : ""
    };
  }

  _calendarSeasonText(season = null) {
    if (!season) return "";
    if (typeof season === "string") return season.trim();
    if (typeof season !== "object") return String(season ?? "").trim();
    return String(season.label ?? season.name ?? season.title ?? season.id ?? "").trim();
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    try { this._closeBuildingContextMenu?.(); } catch (_error) {}

    const root = this.element;
    if (!root) return;
    this._pendingExternalRerender = false;

    this._bindInputGuards(root);
    this._bindGlobalInputGuard(root);
    this._bindFloatingTooltips(root);
    this._bindDelegatedEvents(root, context);
    this._syncResidentAppearanceTextareas(root);
    this._syncTitlebarRunbar({ canEdit: Boolean(context?.canEdit), hasHolding: Boolean(context?.hasHolding) });
    this._clearLoadingOverlay();

    const scrollState = this._pendingScrollState;
    this._pendingScrollState = null;
    if (scrollState) {
      const restore = () => this._restoreScrollState(scrollState);
      if (globalThis.requestAnimationFrame) requestAnimationFrame(() => { restore(); requestAnimationFrame(restore); });
      else setTimeout(restore, 0);
    }
  }

  _syncResidentAppearanceTextareas(root = this.element) {
    this._residentAppearanceResizeObserver?.disconnect?.();
    this._residentAppearanceResizeObserver = null;

    const fields = Array.from(root?.querySelectorAll?.(".fbls-person-editor.v2 .person-appearance textarea") ?? []);
    if (fields.length && typeof globalThis.ResizeObserver === "function") {
      this._residentAppearanceResizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) this._reserveResidentAppearanceSpace(entry.target);
      });
    }

    for (const field of fields) {
      this._syncResidentAppearanceTextarea(field, { autosize: true });
      this._residentAppearanceResizeObserver?.observe?.(field);
    }
  }

  _syncResidentAppearanceTextarea(field, { autosize = false } = {}) {
    if (!(field instanceof HTMLTextAreaElement)) return;
    if (autosize) {
      field.style.height = "auto";
      field.style.height = `${Math.max(44, field.scrollHeight)}px`;
    }
    this._reserveResidentAppearanceSpace(field);
  }

  _reserveResidentAppearanceSpace(field) {
    if (!(field instanceof HTMLTextAreaElement)) return;
    const label = field.closest?.(".person-appearance");
    const grid = field.closest?.(".fbls-resident-main-grid");
    if (!label || !grid) return;

    const labelText = label.querySelector?.(":scope > span");
    const labelRect = labelText?.getBoundingClientRect?.();
    const fieldRect = field.getBoundingClientRect();
    const labelStyle = labelText ? globalThis.getComputedStyle?.(labelText) : null;
    const labelMargin = Number.parseFloat(labelStyle?.marginBottom ?? "0") || 0;
    const reservedHeight = Math.ceil((labelRect?.height ?? 0) + labelMargin + fieldRect.height);
    const safeHeight = Math.max(64, reservedHeight);

    label.style.minHeight = `${safeHeight}px`;
    grid.style.setProperty("--fbls-appearance-block-h", `${safeHeight}px`);
  }

  _bindDelegatedEvents(root, context = {}) {
    this._delegatedAbortController?.abort?.();
    const controller = new AbortController();
    this._delegatedAbortController = controller;
    const listenerOptions = { signal: controller.signal };

    const canEdit = Boolean(context?.canEdit);
    const canEditBuildings = Boolean(context?.canEditBuildings);
    const canUseStorage = Boolean(context?.canUseStorage);
    const canManagePeople = Boolean(context?.canManagePeople);
    const canManageDefense = Boolean(context?.canManageDefense);
    const canEditSpecial = Boolean(context?.canEditSpecial);
    const canEditOverview = Boolean(context?.canEditOverview);
    const canWriteAny = canEdit || canEditBuildings || canUseStorage || canManagePeople || canManageDefense || canEditSpecial || canEditOverview;

    const clickActions = {
      tab: "_onTabClick",
      "toggle-person-details": "_onTogglePersonDetails",
      "open-building-editor": "_onOpenBuildingEditor",
      "open-mass-combat-tag-editor": "_onOpenMassCombatTagEditor",
      "building-category": "_onBuildingCategory",
      "people-subtab": "_onPeopleSubtab",
      "special-subtab": "_onSpecialSubtab",
      "roll-holding-stat": "_onRollHoldingStat",
      "show-morale-help": "_onShowMoraleHelp",
      "open-crew-editor": "_onOpenCrewEditor",
      "open-building-template-browser": "_onOpenBuildingTemplateBrowser",
      "auto-assign-building-workers": "_onAutoAssignBuildingWorkers",
      "storage-subtab": "_onStorageSubtab",
      "storage-room-tab": "_onStorageRoomTab",
      "remove-trait": "_onRemoveTrait",
      "remove-suitable-type": "_onRemoveSuitableType",
      "create-holding": "_onCreateHolding",
      "delete-holding": "_onDeleteHolding",
      "edit-holding-name": "_onEditHoldingName",
      "toggle-holding-visibility": "_onToggleHoldingVisibility",
      "transfer-resident": "_onTransferResident",
      "pick-file": "_onPickFile",
      "add-defense-squad": "_onAddDefenseSquad",
      "delete-defense-squad": "_onDeleteDefenseSquad",
      "fill-defense-squad-best": "_onFillDefenseSquadBest",
      "add-row": "_onAddRow",
      "create-building-from-template": "_onCreateBuildingFromTemplate",
      "delete-row": "_onDeleteRow",
      "edit-person": "_onEditPerson",
      "toggle-person-dead": "_onTogglePersonDead",
      "close-person-editor": "_onClosePersonEditor",
      "roll-gm": "_onGmRoll",
      "import-laputa": "_onImportLaputa",
      "reset-data": "_onResetData",
      "generate-residents": "_onGenerateResidents",
      "accept-generated-residents": "_onAcceptGeneratedResidents",
      "clear-generated-residents": "_onClearGeneratedResidents",
      "toggle-generated-person-editor": "_onToggleGeneratedPersonEditor",
      "roll-construction": "_onRollConstruction",
      "allocate-building-materials": "_onAllocateBuildingMaterials",
      "roll-construction-crew": "_onRollConstructionCrew",
      "run-ten-day-economy": "_onRunEconomyPeriod",
      "run-economy-period": "_onRunEconomyPeriod",
      "collect-building-production": "_onCollectBuildingProduction",
      "adjust-storage": "_onAdjustStorage",
      "move-storage-resource": "_onMoveStorageResource",
      "toggle-storage-tool": "_onToggleStorageTool",
      "adjust-storage-money": "_onAdjustStorageMoney",
      "clean-storage-zeros": "_onCleanStorageZeros",
      "clear-storage-log": "_onClearStorageLog",
      "withdraw-storage-resource": "_onWithdrawStorageResource",
      "give-storage-item": "_onGiveStorageItem",
      "open-storage-item": "_onOpenStorageItem"
    };

    const publicActions = new Set([
      "tab", "select-holding", "toggle-person-details", "open-building-editor", "building-category",
      "people-subtab", "special-subtab", "roll-holding-stat", "show-morale-help", "open-crew-editor",
      "open-building-template-browser", "auto-assign-building-workers", "storage-subtab", "storage-room-tab",
      "open-storage-item"
    ]);

    const dispatch = (event, element, handlerName) => {
      const handler = this?.[handlerName];
      if (typeof handler !== "function") return false;
      return handler.call(this, this._delegatedEvent(event, element));
    };

    root.addEventListener("click", (event) => {
      const element = event.target?.closest?.("[data-action]");
      if (!element || !root.contains(element)) return;
      const action = String(element.dataset.action ?? "");
      if (action === "run-economy-period" && element.closest?.(".fbls-titlebar-runbar")) return;
      if (!publicActions.has(action) && !canWriteAny) return;
      const handlerName = clickActions[action];
      if (handlerName) dispatch(event, element, handlerName);
    }, listenerOptions);

    root.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;

      if (target.matches?.("[data-action='select-holding']")) return dispatch(event, target, "_onSelectHolding");
      if (target.matches?.("[data-resident-filter]")) return dispatch(event, target, "_onResidentFilterChange");
      if (!canWriteAny) return;
      if (target.matches?.("[data-field]")) {
        if (target.closest?.(".fbls-person-editor.v2")) return;
        return dispatch(event, target, "_onFieldChange");
      }
      if (target.matches?.("[data-traits-field]")) return dispatch(event, target, "_onTraitSelectChange");
      if (target.matches?.("[data-trait-add-field]")) return dispatch(event, target, "_onTraitAddChange");
      if (target.matches?.("[data-work-assignment-field]")) {
        if (target.closest?.(".fbls-person-editor.v2")) return dispatch(event, target, "_onPersonEditorWorkAssignmentChange");
        return dispatch(event, target, "_onWorkAssignmentChange");
      }
      if (target.matches?.("[data-suitable-type-add-field]")) return dispatch(event, target, "_onSuitableTypeAddChange");
      if (target.matches?.("[data-building-construction-crew]")) return dispatch(event, target, "_onBuildingConstructionCrewChange");
      if (target.matches?.("[data-generator-field]")) return dispatch(event, target, "_onGeneratorFieldChange");
      if (target.matches?.("[data-generator-person-field]")) return dispatch(event, target, "_onGeneratedPersonFieldChange");
      if (target.matches?.("[data-building-worker-field]")) return dispatch(event, target, "_onBuildingWorkerChange");
      if (target.matches?.("[data-storage-money-field]")) return dispatch(event, target, "_onStorageMoneyChange");
      if (target.matches?.("[data-calendaria-last-field]")) return dispatch(event, target, "_onCalendariaLastDateChange");
    }, listenerOptions);

    root.addEventListener("input", (event) => {
      const target = event.target;
      if (target instanceof HTMLTextAreaElement && target.matches?.(".fbls-person-editor.v2 .person-appearance textarea")) {
        this._syncResidentAppearanceTextarea(target, { autosize: true });
      }
    }, listenerOptions);

    root.addEventListener("contextmenu", (event) => {
      if (!canEditBuildings) return;
      const element = event.target?.closest?.("[data-action='open-building-editor']");
      if (element && root.contains(element)) dispatch(event, element, "_onBuildingContextMenu");
    }, listenerOptions);

    root.addEventListener("dragstart", (event) => {
      const element = event.target?.closest?.("[data-action='open-building-editor']");
      if (element && root.contains(element)) dispatch(event, element, "_onBuildingDragStart");
    }, listenerOptions);

    root.addEventListener("dragend", (event) => {
      const element = event.target?.closest?.("[data-action='open-building-editor']");
      if (element && root.contains(element)) dispatch(event, element, "_onBuildingDragEnd");
    }, listenerOptions);

    root.addEventListener("dragover", (event) => {
      const storageZone = event.target?.closest?.("[data-storage-drop-zone]");
      if (storageZone && root.contains(storageZone)) {
        event.preventDefault();
        storageZone.classList.add("dragover");
        return;
      }
      const residentZone = event.target?.closest?.("[data-resident-drop-zone]");
      if (residentZone && root.contains(residentZone)) {
        event.preventDefault();
        residentZone.classList.add("dragover");
        return;
      }
      const buildingCard = event.target?.closest?.("[data-action='open-building-editor']");
      if (buildingCard && root.contains(buildingCard)) dispatch(event, buildingCard, "_onBuildingDragOver");
    }, listenerOptions);

    root.addEventListener("dragleave", (event) => {
      const storageZone = event.target?.closest?.("[data-storage-drop-zone]");
      if (storageZone && root.contains(storageZone)) storageZone.classList.remove("dragover");
      const residentZone = event.target?.closest?.("[data-resident-drop-zone]");
      if (residentZone && root.contains(residentZone)) residentZone.classList.remove("dragover");
    }, listenerOptions);

    root.addEventListener("drop", (event) => {
      const storageZone = event.target?.closest?.("[data-storage-drop-zone]");
      if (storageZone && root.contains(storageZone)) return dispatch(event, storageZone, "_onStorageDrop");
      const residentZone = event.target?.closest?.("[data-resident-drop-zone]");
      if (residentZone && root.contains(residentZone)) return dispatch(event, residentZone, "_onResidentActorDrop");
      const buildingCard = event.target?.closest?.("[data-action='open-building-editor']");
      if (buildingCard && root.contains(buildingCard)) return dispatch(event, buildingCard, "_onBuildingDrop");
    }, listenerOptions);
  }

  _delegatedEvent(event, currentTarget) {
    return new Proxy(event, {
      get(target, prop) {
        if (prop === "currentTarget" || prop === "delegateTarget") return currentTarget;
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  }

  _onOpenBuildingTemplateBrowser(event) {
    event.preventDefault();
    event.stopPropagation();
    const holdingId = String(this.activeHoldingId ?? "") || String(HoldingService.getData()?.holdings?.[0]?.id ?? "");
    if (!holdingId) return;
    new SkyholdBuildingTemplateBrowser({ holdingId }).render({ force: true, focus: true });
  }

  _onOpenMassCombatTagEditor(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    new SkyholdMassCombatTagEditor().render({ force: true, focus: true });
  }

  async _onClose(options) {
    await super._onClose(options);
    this._hideTooltip();
    this._unbindGlobalInputGuard();
    this._delegatedAbortController?.abort?.();
    this._delegatedAbortController = null;
    this._removeTitlebarRunbar?.();
    if (SkyholdApp.instance === this) SkyholdApp.instance = null;
  }


}

Object.assign(
  SkyholdApp.prototype,
  HoldingDomain,
  ResidentDomain,
  BuildingDomain,
  AssignmentDomain,
  FinanceDomain,
  UiDomain,
  EventDomain
);

SkyholdApp.instance = null;
SkyholdApp.DEFAULT_OPTIONS = {
  id: "fbl-skyhold-app",
  classes: ["fbl-skyhold", "fbl-skyhold-app"],
  tag: "section",
  window: {
    title: "Владения",
    icon: "fa-solid fa-cloud",
    resizable: true
  },
  position: {
    width: 1120,
    height: 760
  }
};
SkyholdApp.PARTS = {
  body: {
    template: `modules/${MODULE_ID}/templates/skyhold-app.hbs`
  }
};
registerSkyholdAppClass(SkyholdApp);
