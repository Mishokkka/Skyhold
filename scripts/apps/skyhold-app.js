import { MODULE_ID } from "../data/constants.js";
import { isResidentInPopulation } from "../data/resident-presence.js";
import { canCurrentUserOpenSkyhold } from "../data/settings.js";
import { HOLDING_TYPES } from "../data/schema/base-holding.js";
import { getHoldingTypeLabel } from "../data/holding-factory.js";
import { HoldingService } from "../data/holding-service.js";
import { getSkyholdAuthorityState } from "../data/authority.js";
import { holdingPermissionContext } from "../data/holding-permissions.js";
import { politicsAvailability } from "../data/politics-availability.js";
import { eventRegionOptionValue, normalizeEventRegionOptions } from "../data/random-events.js";

import { registerSkyholdAppClass } from "./registry.js";
import { HoldingDomain } from "./domains/holding-domain.js";
import { ResidentDomain } from "./domains/resident-domain.js";
import { BuildingDomain } from "./domains/building-domain.js";
import { AssignmentDomain } from "./domains/assignment-domain.js";
import { FinanceDomain } from "./domains/finance-domain.js";
import { UiDomain } from "./domains/ui-domain.js";
import { EventActionDefinitions, EventDomain } from "./domains/event-domain.js";
import { ChildWindowDomain } from "./domains/child-window-domain.js";
import { buildSkyholdActionRegistry, dispatchSkyholdAction } from "./events/action-router.js";
import { getCalendariaSeasonSnapshot, getCalendariaSnapshot, formatCalendariaDateTime, calendariaDateTimeToInput } from "../integrations/calendaria-bridge.js";
import { assignDomainGroup } from "./domains/compose-domain.js";
import { WindowFrameMixin } from "./common/window-frame.js";
import { requestApplicationRender } from "./common/render-scheduler.js";
import { bindTabNavigation } from "./common/tab-navigation.js";
import { DisclosureState } from "./common/disclosure-state.js";
import { fitResidentTraitChips } from "./common/resident-trait-chips.js";
import { hasActiveProtectedSkyholdWindow } from "./common/window-focus-keeper.js";
import { createDerivedContextCache, derivedContextKey } from "./common/derived-context-cache.js";
import { bindImageFallbacks, capturePersistentImages, restorePersistentImages } from "./common/image-fallback.js";
import { buildHoldingOperationTimeline } from "../data/operation-timeline.js";
import {
  countSkyholdPerformance,
  finishSkyholdPerformanceTimer,
  measureSkyholdPerformance,
  startSkyholdPerformanceTimer
} from "../data/performance-observer.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const LOADING_OVERLAY_DELAY_MS = 90;
const LOADING_OVERLAY_FADE_MS = 90;

function prepareRegionSelectOptions(regionOptions = [], currentValue = "", rawValue = "") {
  const selected = String(currentValue ?? "");
  const rows = normalizeEventRegionOptions(regionOptions, { fallback: false }).map((option) => ({
    value: option.value,
    label: option.label,
    selected: option.value === selected
  }));
  if (selected && !rows.some((option) => option.value === selected)) {
    rows.unshift({
      value: selected,
      label: String(rawValue || selected),
      selected: true
    });
  }
  if (!selected) rows.unshift({ value: "", label: "— Выберите регион —", selected: true });
  return rows;
}

const SkyholdAppActions = {
  click: {
    "open-workforce-planner": "_onOpenWorkforcePlanner",
    "open-building-template-browser": "_onOpenBuildingTemplateBrowser",
    "open-mass-combat-tag-editor": "_onOpenMassCombatTagEditor",
    "open-random-event-editor": "_onOpenRandomEventEditor",
    "open-region-catalog-editor": "_onOpenRegionCatalogEditor",
    "open-resource-catalog-editor": "_onOpenResourceCatalogEditor",
    "open-market-catalog-editor": "_onOpenMarketCatalogEditor",
    "open-content-pack-importer": "_onOpenContentPackImporter",
    "open-ui-review": "_onOpenUiReview",
    "open-laputa-migration-importer": "_onOpenLaputaMigrationImporter",
    "open-building-catalog-migration": "_onOpenBuildingCatalogMigration",
    "open-hybrid-labor-migration": "_onOpenHybridLaborMigration"
  },
  publicClick: ["open-building-template-browser", "open-workforce-planner"]
};

export class SkyholdApp extends WindowFrameMixin(HandlebarsApplicationMixin(ApplicationV2)) {
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
    this.storageRoomRailCollapsed = false;
    this.activePeopleTab = "living";
    this.activeSpecialTab = "records";
    this.storageBatchSelection = { resources: new Set(), items: new Set() };
    this.storageSearchQuery = "";
    this._pendingStorageSearchTarget = null;
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
    this._activeTabContextCache = createDerivedContextCache({ limit: 16 });
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

    const active = globalThis.document?.activeElement;
    const activeManager = active?.closest?.(".fbl-skyhold-app");
    const activeControl = activeManager && active?.matches?.("input, textarea, select, [contenteditable='true']");

    // External writes must never raise the large manager above another Foundry
    // window, nor tear down a control in which the user is currently editing.
    if (hasActiveProtectedSkyholdWindow({ recentMs: 5000 }) || activeManager !== app.element || activeControl) {
      app._pendingExternalRerender = true;
      return;
    }

    app._pendingExternalRerender = false;
    app.requestRender({ focus: false });
  }

  requestRender(options = {}) {
    return requestApplicationRender(this, options);
  }

  render(options = {}) {
    const firstRender = !this.rendered;
    this._performanceRenderStartedAt = startSkyholdPerformanceTimer();
    countSkyholdPerformance("SkyholdApp.render.requests");
    const showOverlay = this.rendered && this.element && options?.skipLoadingOverlay !== true;
    const preserveWindowFrame = showOverlay && !options?.position;
    const token = Symbol("fbl-skyhold-render");
    this._renderToken = token;

    if (this.rendered && this.element) this._pendingPersistentImages = capturePersistentImages(this.element);

    if (showOverlay) {
      this._syncWindowFrameState();
      this._pendingScrollState = this._captureScrollState();
      this._pendingWindowFrame = preserveWindowFrame ? this._captureWindowFrame() : null;
      if (this._loadingOverlayTimer) window.clearTimeout(this._loadingOverlayTimer);
      const delay = Math.max(0, Number.isFinite(Number(options?.loadingDelay)) ? Number(options.loadingDelay) : LOADING_OVERLAY_DELAY_MS);
      this._loadingOverlayTimer = window.setTimeout(() => {
        this._loadingOverlayTimer = null;
        if (this._renderToken === token) this._showLoadingOverlay();
      }, delay);
    }

    let result;
    try {
      result = super.render(options);
    } catch (error) {
      if (this._renderToken === token) this._clearLoadingOverlay();
      throw error;
    }

    if (!result?.finally) {
      if (this._loadingOverlayTimer) window.clearTimeout(this._loadingOverlayTimer);
      this._loadingOverlayTimer = null;
      if (firstRender && this.element) this._bindWindowFrameSync(this.element);
      return result;
    }

    return result.then((value) => {
      // ApplicationV2 positions the frame after _onRender. Measuring earlier
      // replaces the configured opening width with the intrinsic DOM width.
      if (firstRender && this.element) this._bindWindowFrameSync(this.element);
      return value;
    }).finally(() => {
      // Render can reject before _onRender, or after another render has begun.
      if (this._renderToken === token) this._clearLoadingOverlay();
    });
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
    overlay.setAttribute("role", "status");
    overlay.setAttribute("aria-label", "Загрузка");
    const img = shell?.querySelector?.("[data-loading-overlay] img")?.getAttribute?.("src") || "";
    if (img) {
      const image = document.createElement("img");
      image.src = img;
      image.alt = "";
      overlay.appendChild(image);
    } else {
      const icon = document.createElement("i");
      icon.classList.add("fa-solid", "fa-spinner", "fa-spin");
      overlay.appendChild(icon);
    }
    const label = document.createElement("span");
    label.textContent = "Загрузка…";
    overlay.appendChild(label);
    host.appendChild(overlay);
    this._loadingWindowOverlay = overlay;
    const activate = () => {
      if (this._loadingWindowOverlay === overlay) overlay.classList.add("active");
    };
    if (globalThis.requestAnimationFrame) requestAnimationFrame(activate); else activate();
  }

  _clearLoadingOverlay() {
    if (this._loadingOverlayTimer) window.clearTimeout(this._loadingOverlayTimer);
    this._loadingOverlayTimer = null;
    const shell = this.element?.querySelector?.(".fbls-shell") ?? this.element;
    shell?.classList?.remove?.("fbls-loading-active");
    shell?.querySelector?.("[data-loading-overlay]")?.setAttribute?.("aria-busy", "false");
    const appShell = this.element?.closest?.(".application, .app, .window-app") ?? this.element?.parentElement?.closest?.(".application, .app, .window-app");
    const host = appShell?.querySelector?.(".window-content") ?? this.element?.parentElement ?? this.element;
    host?.classList?.remove?.("fbls-loading-host");
    const overlays = new Set([this._loadingWindowOverlay, host?.querySelector?.(".fbls-loading-window-overlay")].filter(Boolean));
    this._loadingWindowOverlay = null;
    for (const overlay of overlays) {
      overlay.classList.remove("active");
      window.setTimeout(() => overlay.remove(), LOADING_OVERLAY_FADE_MS);
    }
  }

  _captureScrollState() {
    const root = this.element;
    if (!root) return null;
    const appShell = root.closest?.(".application, .app, .window-app") ?? root.parentElement?.closest?.(".application, .app, .window-app");
    const windowContent = appShell?.querySelector?.(".window-content");
    const content = root.querySelector?.(".fbls-content");
    const peopleTable = root.querySelector?.(".fbls-people-table-wrap");
    const keyed = Array.from(root.querySelectorAll?.("[data-render-scroll-key]") ?? []).map((element) => ({
      key: String(element.dataset.renderScrollKey ?? ""),
      top: Number(element.scrollTop) || 0,
      left: Number(element.scrollLeft) || 0
    })).filter((row) => row.key);
    return {
      rootTop: root.scrollTop ?? 0,
      contentTop: content?.scrollTop ?? 0,
      windowTop: windowContent?.scrollTop ?? 0,
      peopleTop: peopleTable?.scrollTop ?? 0,
      peopleLeft: peopleTable?.scrollLeft ?? 0,
      keyed
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
    const keyed = new Map(Array.from(root.querySelectorAll?.("[data-render-scroll-key]") ?? []).map((element) => [String(element.dataset.renderScrollKey ?? ""), element]));
    for (const row of state.keyed ?? []) {
      const element = keyed.get(String(row.key ?? ""));
      if (!element) continue;
      element.scrollTop = Number(row.top) || 0;
      element.scrollLeft = Number(row.left) || 0;
    }
    root.scrollTop = state.rootTop ?? 0;
  }

  async _prepareContext(options) {
    return measureSkyholdPerformance("SkyholdApp.prepareContext", async () => {
    const context = await super._prepareContext(options);
    const data = HoldingService.getDataView();
    this._activeTabContextCache.setGeneration(data?.meta?.revision ?? 0);
    const authority = getSkyholdAuthorityState();
    const canEdit = authority.isGM;

    const visibleHoldings = this._getVisibleHoldings(data, canEdit);
    const activeHolding = this._resolveActiveHolding(data, visibleHoldings);
    const holdingIndex = activeHolding ? data.holdings.findIndex((holding) => holding.id === activeHolding.id) : -1;

    const permissions = holdingPermissionContext(activeHolding, { authority });
    if (!canEdit && this.activeTab === "gm") this.activeTab = "overview";

    const canEditOverview = permissions.canEditOverview;
    const canEditBuildings = permissions.canEditBuildings;
    const canUseStorage = permissions.canUseStorage;
    const canManagePeople = permissions.canEditResidents;
    const canManageDefense = permissions.canEditDefense;
    const canEditBattle = permissions.canEditBattleSetup;
    const canEditSpecial = permissions.canEditSpecial;
    const grantedLabels = [
      permissions.mayEditOverview && "обзор",
      permissions.mayEditBuildings && "здания",
      permissions.mayUseStorage && "хранилище",
      permissions.mayEditResidents && "жители",
      permissions.mayEditDefense && "оборона",
      permissions.mayEditBattleSetup && "подготовка боя",
      permissions.mayEditSpecial && "особое",
      permissions.mayManageShips && "корабли"
    ].filter(Boolean);
    const modeLabel = canEdit
      ? "Режим ГМа: редактирование включено."
      : !permissions.hasGrantedPlayerWrites
        ? "Режим игрока: только чтение."
        : permissions.writeAvailable
          ? `Режим игрока: доступны ${grantedLabels.join(", ")}.`
          : "Режим игрока: права выданы, но запись недоступна без активного GM.";

    const contextLabels = this._contextLabels(activeHolding);
    const tabs = this._prepareTabs(canEdit, activeHolding, contextLabels);
    for (const tab of tabs) tab.active = tab.id === this.activeTab;

    // Cache the currently prepared data for helper methods that need object paths.
    // Avoiding repeated HoldingService.getData() calls here matters: get() migrates and
    // normalizes the world setting, which is expensive on large settlements.
    this._contextData = data;
    this._contextHoldingId = activeHolding?.id ?? null;
    this._contextHoldingIndex = holdingIndex;

    if (this.activeStorageTab === "warehouses") this.activeStorageTab = "resources";
    if (this.activeStorageTab === "market") { this.activeStorageTab = "resources"; this.activeTab = "external-market"; }
    if (this.activeSpecialTab === "ships") { this.activeSpecialTab = "records"; this.activeTab = "external-market"; }
    if (this.activePeopleTab === "cemetery") this.activePeopleTab = "living";
    if (!this.activeSpecialTab) this.activeSpecialTab = "records";

    const active = {
      overview: this.activeTab === "overview",
      people: this.activeTab === "people",
      buildings: this.activeTab === "buildings",
      defense: this.activeTab === "defense",
      special: this.activeTab === "special",
      storage: this.activeTab === "storage",
      externalMarket: this.activeTab === "external-market",
      gm: this.activeTab === "gm"
    };
    const activeStorage = {
      resources: this.activeStorageTab === "resources",
      items: this.activeStorageTab === "items",
      warehouses: false,
      accounting: this.activeStorageTab === "accounting",
      log: this.activeStorageTab === "log"
    };

    const headerContext = this._prepareHeaderContext(activeHolding, holdingIndex, canEdit);
    const eventRegionCatalog = normalizeEventRegionOptions(data?.catalog?.eventRegions);
    const rawRegionValue = activeHolding?.overview?.region ?? "";
    const currentRegionValue = rawRegionValue ? eventRegionOptionValue(rawRegionValue, eventRegionCatalog) : "";
    const currentRegionLabel = eventRegionCatalog.find((option) => option.value === currentRegionValue)?.label ?? String(rawRegionValue || currentRegionValue || "—");
    const activeTabContextKey = derivedContextKey({
      revision: data?.meta?.revision ?? 0,
      holdingId: activeHolding?.id ?? "",
      activeTab: this.activeTab,
      storageTab: this.activeStorageTab,
      storageRoomId: this.activeStorageRoomId,
      peopleTab: this.activePeopleTab,
      specialTab: this.activeSpecialTab,
      buildingCategory: this.activeBuildingCategory,
      residentFilters: {
        type: this.residentFilters?.type ?? "all",
        work: this.residentFilters?.work ?? "all",
        home: this.residentFilters?.home ?? "all",
        morale: this.residentFilters?.morale ?? "all"
      },
      editingPersonId: this.editingPersonId,
      expandedPersonId: this.expandedPersonId,
      expandedBuildingId: this.expandedBuildingId,
      storageBatchSelection: active.storage ? this.storageBatchSelection : null,
      storageSearchQuery: active.storage ? this.storageSearchQuery : "",
      generatorConfig: active.gm ? this.generatorConfig : null,
      generatorPreview: active.gm ? this.generatorPreview : null,
      activeGeneratedPersonIndex: active.gm ? this.activeGeneratedPersonIndex : null,
      canEdit,
      canEditBuildings,
      canUseStorage,
      canManagePeople,
      authorityStatus: authority.status,
      activeGmId: authority.activeGmId
    });
    const activeTabContext = await this._activeTabContextCache.getOrCreate(activeTabContextKey, () => measureSkyholdPerformance("SkyholdApp.prepareActiveTabContext", () => this._prepareActiveTabContext({
      activeHolding,
      data,
      active,
      activeStorage,
      canEdit,
      canEditBuildings,
      canUseStorage,
      canManagePeople,
      development: headerContext.development,
      moraleState: headerContext.moraleState,
      headerTotals: headerContext.totals
    })));

    return {
      ...context,
      moduleId: MODULE_ID,
      loadingImage: String(activeHolding?.gm?.loadingImage ?? ""),
      data,
      canEdit,
      permissions,
      authorityStatus: permissions.authorityStatus,
      writeAvailable: permissions.writeAvailable,
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
      regionOptions: prepareRegionSelectOptions(eventRegionCatalog, currentRegionValue, rawRegionValue),
      currentRegionLabel,
      holdingIsGmOnly: activeHolding?.visibility === "gm",
      holdingVisibilityTitle: activeHolding?.visibility === "gm" ? "Владение скрыто от игроков. Нажмите, чтобы показать игрокам." : "Владение видно игрокам. Нажмите, чтобы скрыть от игроков.",
      holdingTypeLabel: activeHolding ? getHoldingTypeLabel(activeHolding.type) : "Нет владений",
      contextLabels,
      tabs,
      active,
      activeStorage,
      storageRoomRailCollapsed: Boolean(this.storageRoomRailCollapsed),
      activeSpecial: {
        records: this.activeSpecialTab === "records" || !["records", "cemetery", "defense"].includes(this.activeSpecialTab),
        cemetery: this.activeSpecialTab === "cemetery",
        defense: false
      },
      residentFilters: this.residentFilters,
      peopleTabs: active.people ? this._preparePeopleTabs(activeHolding) : [],
      peopleColspan: 9,
      cemeteryColspan: canManagePeople ? 6 : 5,
      cemeteryCount: (activeHolding?.people?.list ?? []).filter((person) => person?.dead).length,
      ...headerContext,
      ...activeTabContext
    };
    });
  }

  _prepareHeaderContext(holding, holdingIndex = -1, canEdit = false) {
    const rawMorale = this._calculateMorale(holding);
    const moraleState = this._moraleState(rawMorale);
    const development = this._developmentSummary(holding);
    const politics = politicsAvailability(holding, development.totals.culture);
    this._contextDevelopment = development;
    return {
      totals: this._prepareHeaderTotals(holding),
      moraleState,
      politicsEntry: {
        available: politics.available,
        label: politics.available ? "Политика" : "Контроль",
        title: politics.available ? "Открыть Политику и Контроль" : "Открыть Контроль поселения"
      },
      beliefSummary: this._beliefSummary(holding),
      calendarContext: this._calendarHeaderContext(holding, holdingIndex, canEdit),
      development,
      reputationSummary: this._reputationSummary(holding, moraleState)
    };
  }

  _prepareHeaderTotals(holding) {
    const people = (holding?.people?.list ?? []).filter((person) => isResidentInPopulation(person, holding));
    return {
      salary: 0,
      salaryTenDay: 0,
      salaryMonth: 0,
      upkeepMonth: 0,
      incomeTenDay: 0,
      projectedBalanceMonth: 0,
      population: people.length,
      peopleRows: people.length,
      buildingsRows: holding?.buildings?.list?.length ?? 0,
      specialRows: holding?.special?.list?.length ?? 0,
      storageRows: holding?.storage?.resources?.length ?? 0
    };
  }

  async _prepareActiveTabContext({
    activeHolding,
    data,
    active,
    activeStorage,
    canEdit,
    canEditBuildings,
    canUseStorage,
    canManagePeople,
    development,
    moraleState,
    headerTotals
  } = {}) {
    const accountingActive = Boolean(active?.storage && activeStorage?.accounting);
    const needsWorkerContext = Boolean(active?.buildings || active?.defense || accountingActive);
    const workerContext = needsWorkerContext ? (this._economyWorkerContext?.(activeHolding) ?? null) : null;
    const totals = accountingActive ? this._prepareTotals(activeHolding, workerContext) : headerTotals;
    const finance = accountingActive
      ? this._financeSummary(activeHolding, totals, workerContext)
      : { ...totals, moneyBuildings: [], productionPreview: [] };
    const defenseSummary = active?.defense
      ? this._defenseSummary(activeHolding, moraleState, workerContext)
      : { base: 0, bonus: 0, total: 0, rawTotal: 0, gmMod: 0, moraleMod: 0, buildings: [], tooltip: "" };

    return {
      rows: this._prepareRows(activeHolding, canManagePeople, this.activeTab, {
        canEditBuildings,
        activePeopleTab: this.activePeopleTab,
        workerContext
      }),
      storageContext: active?.storage ? this._storageContext(activeHolding, canUseStorage, this.activeStorageRoomId) : null,
      specialTabs: active?.special ? this._prepareSpecialTabs(activeHolding) : [],
      shipsContext: active?.externalMarket
        ? (await import("./ships-context.js")).prepareShipsContext(activeHolding, { revision: data.meta.revision, data }) : null,
      totals,
      finance,
      tendayReadiness: active?.overview ? await this._tendayReadinessContext(activeHolding) : null,
      defenseSummary,
      defenseContext: active?.defense ? this._defenseContext(activeHolding) : null,
      residentTransfer: active?.gm ? this._residentTransferContext(activeHolding, data) : null,
      operationsTimeline: active?.gm ? buildHoldingOperationTimeline(activeHolding) : [],
      constructionCrew: active?.buildings ? this._constructionCrew(activeHolding) : null,
      buildingTabs: active?.buildings ? this._prepareBuildingTabs(activeHolding) : [],
      buildingTemplates: (active?.buildings || active?.gm)
        ? this._buildingTemplateContext(activeHolding, data, { developmentSummary: development })
        : { rows: [], available: [], locked: [], hasRows: false, availableCount: 0, lockedCount: 0 },
      buildingCategoryOptions: active?.buildings ? this._buildingCategoryOptions() : [],
      residentFilterOptions: active?.people
        ? this._residentFilterOptions(activeHolding)
        : { types: [], work: [], home: [], morale: [] },
      generator: active?.gm ? this._prepareGeneratorContext(activeHolding) : null,
      resourceCatalog: active?.gm
        ? this._resourceCatalogContext(data, canEdit)
        : { rows: [], builtins: "", builtinCount: 0, hasRows: false },
      marketCatalog: active?.gm
        ? this._marketCatalogContext(data)
        : { marketCount: 0, activeMarketCount: 0, offerCount: 0, hasOverride: false },
      sharedMarketMigrationAvailable: canEdit && !data.meta?.sharedMarkets?.enabled
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
    const settlementSnapshot = getCalendariaSeasonSnapshot(lastDateTime, lastText);
    const seasonText = this._calendarSeasonText(settlementSnapshot?.season);
    const currentFullText = snapshot.available ? snapshot.text : "Calendaria не найдена";
    const settlementSeasonText = seasonText
      ? `Сезон поселения на ${lastText}: ${seasonText}.`
      : "Сезон поселения не вычислен: дата последнего обновления не задана.";
    return {
      available: Boolean(snapshot.available),
      currentText: snapshot.available ? snapshot.text : "Calendaria не найдена",
      seasonText,
      currentTitle: snapshot.available ? `Текущая дата Calendaria: ${currentFullText}. ${settlementSeasonText}` : "Calendaria не активна или не обнаружена.",
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
    try { this._closeResidentContextMenu?.(); } catch (_error) {}
    try { this._closeStorageContextMenu?.(); } catch (_error) {}

    const root = this.element;
    if (!root) {
      finishSkyholdPerformanceTimer("SkyholdApp.renderEndToEnd", this._performanceRenderStartedAt);
      this._performanceRenderStartedAt = null;
      return;
    }
    this._hydratedResidentWorkSelect = null;
    this._pendingExternalRerender = false;
    const windowFrame = this._pendingWindowFrame;
    this._pendingWindowFrame = null;

    if (options?.isFirstRender) {
      // Match the editor lifecycle: size the intrinsic frame before V2's
      // final positioning, without recording its temporary coordinates.
      const { width, height } = options.position ?? this.position;
      this.setPosition({ width, height });
    } else this._bindWindowFrameSync(root);
    this._bindInputGuards(root);
    this._bindGlobalInputGuard(root);
    this._bindFloatingTooltips(root);
    restorePersistentImages(root, this._pendingPersistentImages);
    this._pendingPersistentImages = null;
    bindImageFallbacks(root);
    if (this.activeTab === "external-market") {
      const { createShipViewState } = await import("./ships-view-state.js");
      this._shipViewState ??= createShipViewState();
      this._shipViewState.bind(root);
    }
    this._bindDelegatedEvents(root, context);
    this._gmDisclosures ??= new DisclosureState();
    this._gmDisclosures.bind(root);
    this._syncResidentAppearanceTextareas(root);
    this._syncResidentTraitChips(root);
    this._applyResidentSearchFilter?.(root, this.residentFilters?.search ?? "");
    this._storageSearchIndex = Array.isArray(context?.storageContext?.searchRows)
      ? context.storageContext.searchRows
      : [];
    this._applyStorageSearchFilter?.(root, this.storageSearchQuery ?? "");
    this._syncTitlebarRunbar({ canEdit: Boolean(context?.canEdit), hasHolding: Boolean(context?.hasHolding) });
    this._clearLoadingOverlay();

    if (windowFrame) {
      const restoreFrame = () => this._restoreWindowFrame(windowFrame);
      if (globalThis.requestAnimationFrame) requestAnimationFrame(() => { restoreFrame(); requestAnimationFrame(restoreFrame); });
      else setTimeout(restoreFrame, 0);
    }

    const scrollState = this._pendingScrollState;
    this._pendingScrollState = null;
    if (scrollState) {
      const restore = () => this._restoreScrollState(scrollState);
      if (globalThis.requestAnimationFrame) requestAnimationFrame(() => { restore(); requestAnimationFrame(restore); });
      else setTimeout(restore, 0);
    }
    this._flashStorageSearchTarget?.(root);
    finishSkyholdPerformanceTimer("SkyholdApp.renderEndToEnd", this._performanceRenderStartedAt);
    this._performanceRenderStartedAt = null;
    countSkyholdPerformance("SkyholdApp.render.completed");
  }

  _syncResidentAppearanceTextareas(root = this.element) {
    if (this._residentAppearanceInputFrame !== null && this._residentAppearanceInputFrame !== undefined) {
      globalThis.cancelAnimationFrame?.(this._residentAppearanceInputFrame);
    }
    this._residentAppearanceInputFrame = null;
    this._residentAppearanceInputFields?.clear?.();
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
      field.style.height = `${Math.max(32, field.scrollHeight)}px`;
    }
    this._reserveResidentAppearanceSpace(field);
  }

  _scheduleResidentAppearanceTextarea(field) {
    if (!(field instanceof HTMLTextAreaElement)) return;
    this._residentAppearanceInputFields ??= new Set();
    this._residentAppearanceInputFields.add(field);
    if (this._residentAppearanceInputFrame !== null && this._residentAppearanceInputFrame !== undefined) return;
    const apply = () => {
      this._residentAppearanceInputFrame = null;
      const fields = [...this._residentAppearanceInputFields];
      this._residentAppearanceInputFields.clear();
      for (const target of fields) {
        if (target?.isConnected) this._syncResidentAppearanceTextarea(target, { autosize: true });
      }
    };
    if (globalThis.requestAnimationFrame) this._residentAppearanceInputFrame = requestAnimationFrame(apply);
    else apply();
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
    const safeHeight = Math.max(32, reservedHeight);

    label.style.minHeight = `${safeHeight}px`;
    grid.style.setProperty("--fbls-appearance-block-h", `${safeHeight}px`);
  }

  _syncResidentTraitChips(root = this.element) {
    this._residentTraitResizeObserver?.disconnect?.();
    this._residentTraitResizeObserver = null;
    if (this._residentTraitResizeFrame !== null && this._residentTraitResizeFrame !== undefined) {
      globalThis.cancelAnimationFrame?.(this._residentTraitResizeFrame);
    }
    this._residentTraitResizeFrame = null;
    const cells = Array.from(root?.querySelectorAll?.(".fbls-traits-cell") ?? []);
    if (!cells.length) return;

    const applyCells = fitResidentTraitChips;

    const pendingCells = new Set();
    const scheduleCells = (targetCells) => {
      for (const cell of targetCells) if (cell?.isConnected) pendingCells.add(cell);
      if (!pendingCells.size || this._residentTraitResizeFrame !== null) return;
      if (!globalThis.requestAnimationFrame) {
        const batch = [...pendingCells];
        pendingCells.clear();
        applyCells(batch);
        return;
      }
      this._residentTraitResizeFrame = requestAnimationFrame(() => {
        this._residentTraitResizeFrame = null;
        const batch = [...pendingCells];
        pendingCells.clear();
        applyCells(batch);
      });
    };

    scheduleCells(cells);
    if (typeof globalThis.ResizeObserver === "function") {
      const observedWidths = new WeakMap();
      this._residentTraitResizeObserver = new ResizeObserver((entries) => {
        const changedCells = [];
        for (const entry of entries) {
          const width = Number(entry?.contentRect?.width);
          const previousWidth = observedWidths.get(entry.target);
          observedWidths.set(entry.target, width);
          if (previousWidth !== undefined && (!Number.isFinite(width) || Math.abs(width - previousWidth) > 0.5)) changedCells.push(entry.target);
        }
        scheduleCells(changedCells);
      });
      for (const cell of cells) this._residentTraitResizeObserver.observe(cell);
    }
  }

  _dehydrateResidentWorkSelect(select) {
    if (!(select instanceof HTMLSelectElement) || select.dataset.residentWorkHydrated !== "true") return;
    const selected = select.selectedOptions?.[0];
    const option = select.ownerDocument.createElement("option");
    option.value = select.value;
    option.textContent = selected?.textContent ?? select.title ?? select.value;
    option.selected = true;
    select.replaceChildren(option);
    delete select.dataset.residentWorkHydrated;
  }

  _hydrateResidentWorkSelect(select, root = this.element) {
    if (!(select instanceof HTMLSelectElement) || !select.matches?.("[data-resident-work-select-lazy]")) return;
    if (select.dataset.residentWorkHydrated === "true") return;

    const previous = this._hydratedResidentWorkSelect;
    if (previous && previous !== select) this._dehydrateResidentWorkSelect(previous);

    const template = root?.querySelector?.("template[data-resident-work-option-catalog]");
    const catalogOptions = Array.from(template?.content?.querySelectorAll?.("option") ?? []);
    const initialOption = select.selectedOptions?.[0] ?? select.querySelector?.("option");
    const currentValue = String(select.value ?? initialOption?.value ?? "");
    const currentLabel = String(initialOption?.textContent ?? select.title ?? currentValue);
    const canWork = select.dataset.residentCanWork === "true";
    const freeLabel = String(select.dataset.residentFreeLabel ?? "Свободен");
    const eligibleCatalogOptions = catalogOptions.filter((option) => {
      const kind = String(option.dataset.residentWorkOptionKind ?? "");
      const value = String(option.value ?? "");
      if (kind === "building" && option.dataset.residentWorkOptionAvailable !== "true" && value !== currentValue) return false;
      return canWork || (kind === "other" && currentValue === "other");
    });
    const catalogHasCurrent = eligibleCatalogOptions.some((option) => String(option.value ?? "") === currentValue);
    const document = select.ownerDocument;
    const options = [];
    const values = new Set();
    const addOption = (option) => {
      const value = String(option?.value ?? "");
      if (values.has(value)) return;
      option.selected = value === currentValue;
      values.add(value);
      options.push(option);
    };

    const freeOption = document.createElement("option");
    freeOption.value = "";
    freeOption.textContent = freeLabel;
    addOption(freeOption);

    let preservedCurrent = null;
    if (currentValue && !catalogHasCurrent) {
      preservedCurrent = document.createElement("option");
      preservedCurrent.value = currentValue;
      preservedCurrent.textContent = currentLabel;
    }
    const addPreservedCurrent = () => {
      if (preservedCurrent && !values.has(currentValue)) addOption(preservedCurrent);
      preservedCurrent = null;
    };

    for (const source of eligibleCatalogOptions) {
      const kind = String(source.dataset.residentWorkOptionKind ?? "");
      if ((kind === "soldier" || kind === "other") && preservedCurrent) addPreservedCurrent();
      addOption(source.cloneNode(true));
    }
    addPreservedCurrent();

    select.replaceChildren(...options);
    select.value = values.has(currentValue) ? currentValue : "";
    select.dataset.residentWorkHydrated = "true";
    this._hydratedResidentWorkSelect = select;
  }

  _bindDelegatedEvents(root, context = {}) {
    this._delegatedAbortController?.abort?.();
    const controller = new AbortController();
    this._delegatedAbortController = controller;
    const listenerOptions = { signal: controller.signal };
    bindTabNavigation(this, root, listenerOptions);

    // Populate the single active native select before its default popup action.
    // focusin covers Tab/programmatic focus so keyboard selection stays unchanged.
    root.addEventListener("pointerdown", (event) => {
      const residentWorkSelect = event.target?.closest?.("select[data-resident-work-select-lazy]");
      if (residentWorkSelect && root.contains(residentWorkSelect)) this._hydrateResidentWorkSelect(residentWorkSelect, root);
      if (!this._pendingExternalRerender) return;
      const interactive = event.target?.closest?.("button, input, textarea, select, [contenteditable='true'], [data-action]");
      if (interactive) return;
      this._pendingExternalRerender = false;
      globalThis.setTimeout?.(() => {
        if (this.rendered && !this._pendingExternalRerender) this.requestRender({ focus: false });
      }, 0);
    }, listenerOptions);

    root.addEventListener("focusin", (event) => {
      const residentWorkSelect = event.target?.closest?.("select[data-resident-work-select-lazy]");
      if (residentWorkSelect && root.contains(residentWorkSelect)) this._hydrateResidentWorkSelect(residentWorkSelect, root);
    }, listenerOptions);

    const canEdit = Boolean(context?.canEdit);
    const canEditBuildings = Boolean(context?.canEditBuildings);
    const canUseStorage = Boolean(context?.canUseStorage);
    const canManagePeople = Boolean(context?.canManagePeople);
    const canManageDefense = Boolean(context?.canManageDefense);
    const canEditSpecial = Boolean(context?.canEditSpecial);
    const canEditOverview = Boolean(context?.canEditOverview);
    const canWriteAny = canEdit || canEditBuildings || canUseStorage || canManagePeople || canManageDefense || canEditSpecial || canEditOverview;

    const actionRegistry = this._actionRegistry ??= buildSkyholdActionRegistry([
      ["SkyholdAppActions", SkyholdAppActions],
      ...EventActionDefinitions
    ]);

    const dispatch = (event, element, handlerName) => {
      return dispatchSkyholdAction(this, event, element, handlerName);
    };

    root.addEventListener("click", (event) => {
      const element = event.target?.closest?.("[data-action]");
      if (!element || !root.contains(element)) return;
      const action = String(element.dataset.action ?? "");
      if (action === "run-economy-period" && element.closest?.(".fbls-titlebar-runbar")) return;
      if (!actionRegistry.publicClick.has(action) && !canWriteAny) return;
      const handlerName = actionRegistry.click.get(action);
      if (handlerName) dispatch(event, element, handlerName);
    }, listenerOptions);

    root.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (event.target?.closest?.("button, input, textarea, select, a[href], [contenteditable='true']")) return;
      const element = event.target?.closest?.("[data-action][role='button']");
      if (!element || !root.contains(element)) return;
      event.preventDefault();
      element.click?.();
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
      if (target.matches?.("[data-building-construction-crew]")) return dispatch(event, target, "_onBuildingConstructionCrewChange");
      if (target.matches?.("[data-generator-field]")) return dispatch(event, target, "_onGeneratorFieldChange");
      if (target.matches?.("[data-generator-person-field]")) return dispatch(event, target, "_onGeneratedPersonFieldChange");
      if (target.matches?.("[data-building-worker-field]")) return dispatch(event, target, "_onBuildingWorkerChange");
      if (target.matches?.("[data-storage-money-field]")) return dispatch(event, target, "_onStorageMoneyChange");
      if (target.matches?.("[data-storage-batch-select]")) return dispatch(event, target, "_onStorageBatchSelectionChange");
      if (target.matches?.("[data-calendaria-last-field]")) return dispatch(event, target, "_onCalendariaLastDateChange");
    }, listenerOptions);

    root.addEventListener("input", (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.matches?.("[data-resident-filter='search']")) {
        return dispatch(event, target, "_onResidentSearchInput");
      }
      if (target instanceof HTMLInputElement && target.matches?.("[data-storage-search]")) {
        return dispatch(event, target, "_onStorageSearchInput");
      }
      if (target instanceof HTMLTextAreaElement && target.matches?.(".fbls-person-editor.v2 .person-appearance textarea")) {
        this._scheduleResidentAppearanceTextarea(target);
      }
    }, listenerOptions);

    root.addEventListener("contextmenu", (event) => {
      const storageRow = event.target?.closest?.("[data-storage-row-type][data-storage-row-id]");
      if (storageRow && root.contains(storageRow)) {
        if (!canUseStorage) return;
        return dispatch(event, storageRow, "_onStorageRowContextMenu");
      }
      const personRow = event.target?.closest?.(".fbls-person-row[data-id]");
      if (personRow && root.contains(personRow)) {
        if (!canManagePeople) return;
        return dispatch(event, personRow, "_onResidentContextMenu");
      }
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
      if (storageZone && root.contains(storageZone) && !storageZone.contains(event.relatedTarget)) storageZone.classList.remove("dragover");
      const residentZone = event.target?.closest?.("[data-resident-drop-zone]");
      if (residentZone && root.contains(residentZone) && !residentZone.contains(event.relatedTarget)) residentZone.classList.remove("dragover");
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

  async _onClose(options) {
    this._gmDisclosures?.close();
    this._renderToken = null;
    this._clearLoadingOverlay();
    await super._onClose(options);
    this._hideTooltip();
    this._unbindGlobalInputGuard();
    this._delegatedAbortController?.abort?.();
    this._delegatedAbortController = null;
    this._residentTraitResizeObserver?.disconnect?.();
    this._residentTraitResizeObserver = null;
    if (this._residentTraitResizeFrame !== null && this._residentTraitResizeFrame !== undefined) {
      globalThis.cancelAnimationFrame?.(this._residentTraitResizeFrame);
    }
    this._residentTraitResizeFrame = null;
    this._residentAppearanceResizeObserver?.disconnect?.();
    this._residentAppearanceResizeObserver = null;
    if (this._residentAppearanceInputFrame !== null && this._residentAppearanceInputFrame !== undefined) {
      globalThis.cancelAnimationFrame?.(this._residentAppearanceInputFrame);
    }
    this._residentAppearanceInputFrame = null;
    this._residentAppearanceInputFields?.clear?.();
    this._hydratedResidentWorkSelect = null;
    try { this._closeResidentContextMenu?.(); } catch (_error) {}
    try { this._closeBuildingContextMenu?.(); } catch (_error) {}
    try { this._closeStorageContextMenu?.(); } catch (_error) {}
    this._removeTitlebarRunbar?.();
    this._unbindWindowFrameSync();
    if (SkyholdApp.instance === this) SkyholdApp.instance = null;
  }


}

assignDomainGroup(SkyholdApp.prototype, "SkyholdApp", [
  ["HoldingDomain", HoldingDomain],
  ["ResidentDomain", ResidentDomain],
  ["BuildingDomain", BuildingDomain],
  ["AssignmentDomain", AssignmentDomain],
  ["FinanceDomain", FinanceDomain],
  ["UiDomain", UiDomain],
  ["ChildWindowDomain", ChildWindowDomain],
  ["EventDomain", EventDomain]
]);

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
    width: 1400,
    height: 760
  }
};
SkyholdApp.PARTS = {
  body: {
    template: `modules/${MODULE_ID}/templates/skyhold-app.hbs`
  }
};
registerSkyholdAppClass(SkyholdApp);
