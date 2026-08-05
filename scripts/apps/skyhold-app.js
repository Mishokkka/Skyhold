import { MODULE_ID } from "../data/constants.js";
import { canCurrentUserOpenSkyhold } from "../data/settings.js";
import { HOLDING_TYPES } from "../data/schema/base-holding.js";
import { getHoldingTypeLabel } from "../data/holding-factory.js";
import { HoldingService } from "../data/holding-service.js";
import { getSkyholdAuthorityState } from "../data/authority.js";
import { holdingPermissionContext } from "../data/holding-permissions.js";
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
import { hasActiveProtectedSkyholdWindow } from "./common/window-focus-keeper.js";
import { createDerivedContextCache, derivedContextKey } from "./common/derived-context-cache.js";
import { bindImageFallbacks, capturePersistentImages, restorePersistentImages } from "./common/image-fallback.js";
import { buildHoldingOperationTimeline } from "../data/operation-timeline.js";
import { economyV2RuntimeStatus } from "../data/economy-v2-activation.js";
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
    "open-building-template-browser": "_onOpenBuildingTemplateBrowser",
    "open-mass-combat-tag-editor": "_onOpenMassCombatTagEditor",
    "open-random-event-editor": "_onOpenRandomEventEditor",
    "open-region-catalog-editor": "_onOpenRegionCatalogEditor",
    "open-resource-catalog-editor": "_onOpenResourceCatalogEditor",
    "open-market-catalog-editor": "_onOpenMarketCatalogEditor",
    "open-content-pack-importer": "_onOpenContentPackImporter",
    "activate-economy-v2": "_onActivateEconomyV2"
  },
  publicClick: ["open-building-template-browser"]
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
      if (this._loadingOverlayTimer) window.clearTimeout(this._loadingOverlayTimer);
      this._loadingOverlayTimer = null;
      this._clearLoadingOverlay();
      throw error;
    }

    if (!result?.finally) {
      if (this._loadingOverlayTimer) window.clearTimeout(this._loadingOverlayTimer);
      this._loadingOverlayTimer = null;
      return result;
    }

    const guardedResult = typeof result.catch === "function"
      ? result.catch((error) => {
        if (this._renderToken === token) this._clearLoadingOverlay();
        throw error;
      })
      : result;

    return guardedResult.finally(() => {
      if (this._loadingOverlayTimer) window.clearTimeout(this._loadingOverlayTimer);
      this._loadingOverlayTimer = null;
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
    host.appendChild(overlay);
    if (globalThis.requestAnimationFrame) requestAnimationFrame(() => overlay.classList.add("active")); else overlay.classList.add("active");
  }

  _clearLoadingOverlay() {
    const shell = this.element?.querySelector?.(".fbls-shell") ?? this.element;
    shell?.classList?.remove?.("fbls-loading-active");
    const inlineOverlay = shell?.querySelector?.("[data-loading-overlay]");
    inlineOverlay?.removeAttribute?.("aria-busy");

    const appShell = this.element?.closest?.(".application, .app, .window-app") ?? this.element?.parentElement?.closest?.(".application, .app, .window-app");
    const host = appShell?.querySelector?.(".window-content") ?? this.element?.parentElement ?? this.element;
    host?.classList?.remove?.("fbls-loading-host");
    const overlay = host?.querySelector?.(".fbls-loading-window-overlay");
    if (!overlay) return;
    overlay.classList.remove("active");
    window.setTimeout(() => overlay.remove(), LOADING_OVERLAY_FADE_MS);
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
    const economyStatus = economyV2RuntimeStatus(data);
    const authority = getSkyholdAuthorityState();
    const isGM = authority.isGM;
    const canEdit = isGM && authority.writeAvailable;

    const visibleHoldings = this._getVisibleHoldings(data, isGM);
    const activeHolding = this._resolveActiveHolding(data, visibleHoldings);
    const holdingIndex = activeHolding ? data.holdings.findIndex((holding) => holding.id === activeHolding.id) : -1;

    const permissions = holdingPermissionContext(activeHolding, { authority });
    if (!isGM && this.activeTab === "gm") this.activeTab = "overview";

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
      permissions.mayEditSpecial && "особое"
    ].filter(Boolean);
    const modeLabel = canEdit
      ? "Режим ГМа: редактирование включено."
      : isGM
        ? `Режим ГМа: только чтение; изменения сохраняет ${authority.activeGmName || "другая authority-сессия"}.`
      : !permissions.hasGrantedPlayerWrites
        ? "Режим игрока: только чтение."
        : permissions.writeAvailable
          ? `Режим игрока: доступны ${grantedLabels.join(", ")}.`
          : "Режим игрока: права выданы, но запись недоступна без активного GM.";

    const contextLabels = this._contextLabels(activeHolding);
    const tabs = this._prepareTabs(isGM, activeHolding, contextLabels);
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
      market: this.activeStorageTab === "market",
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
      isPlayer: !isGM,
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
      economyActivation: {
        active: economyStatus.active,
        ready: economyStatus.ready,
        needsActivation: !economyStatus.ready,
        issueCount: economyStatus.issues.length,
        version: economyStatus.version,
        operationId: String(data?.meta?.economyActivation?.operationId ?? ""),
        activatedAt: String(data?.meta?.economyActivation?.activatedAt ?? "")
      },
      holdingIsGmOnly: activeHolding?.visibility === "gm",
      holdingVisibilityTitle: activeHolding?.visibility === "gm" ? "Владение скрыто от игроков. Нажмите, чтобы показать игрокам." : "Владение видно игрокам. Нажмите, чтобы скрыть от игроков.",
      holdingTypeLabel: activeHolding ? getHoldingTypeLabel(activeHolding.type) : "Нет владений",
      contextLabels,
      tabs,
      active,
      activeStorage,
      storageRoomRailCollapsed: Boolean(this.storageRoomRailCollapsed),
      activeSpecial: {
        records: this.activeSpecialTab === "records" || !["records", "fleet", "cemetery", "defense"].includes(this.activeSpecialTab),
        fleet: this.activeSpecialTab === "fleet",
        cemetery: this.activeSpecialTab === "cemetery",
        defense: false
      },
      residentFilters: this.residentFilters,
      peopleTabs: [],
      peopleColspan: 9,
      cemeteryColspan: canManagePeople ? 6 : 5,
      cemeteryCount: (activeHolding?.people?.list ?? []).filter((person) => person?.dead).length,
      ...headerContext,
      ...activeTabContext
    };
    });
  }

  _prepareHeaderContext(holding, holdingIndex = -1, canEdit = false) {
    const moraleSnapshot = this._moraleSnapshot(holding);
    const moraleState = this._moraleState(moraleSnapshot);
    const development = this._developmentSummary(holding);
    this._contextDevelopment = development;
    return {
      totals: this._prepareHeaderTotals(holding),
      moraleSnapshot,
      moraleState,
      beliefSummary: this._beliefSummary(holding),
      calendarContext: this._calendarHeaderContext(holding, holdingIndex, canEdit),
      development,
      reputationSummary: this._reputationSummary(holding, moraleState)
    };
  }

  _prepareHeaderTotals(holding) {
    const people = (holding?.people?.list ?? []).filter((person) => !person?.dead);
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
    const gmContextErrors = [];
    const prepareGmSection = (section, fallback, prepare) => {
      if (!active?.gm) return fallback;
      try {
        return prepare();
      } catch (error) {
        console.error(`FBL Skyhold | Failed to prepare GM section: ${section}`, error);
        gmContextErrors.push({
          section,
          message: String(error?.message ?? error ?? "Неизвестная ошибка")
        });
        return fallback;
      }
    };
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

    const emptyBuildingTemplates = { rows: [], available: [], locked: [], hasRows: false, availableCount: 0, lockedCount: 0 };
    const buildingTemplates = active?.buildings
      ? this._buildingTemplateContext(activeHolding, data, { developmentSummary: development })
      : prepareGmSection("Шаблоны зданий", emptyBuildingTemplates, () => this._buildingTemplateContext(activeHolding, data, { developmentSummary: development }));

    return {
      rows: this._prepareRows(activeHolding, canManagePeople, this.activeTab, {
        canEditBuildings,
        activePeopleTab: this.activePeopleTab,
        workerContext
      }),
      storageContext: active?.storage ? this._storageContext(activeHolding, canUseStorage, this.activeStorageRoomId) : null,
      specialTabs: active?.special ? this._prepareSpecialTabs(activeHolding) : [],
      fleetCards: active?.special ? this._prepareFleetCards(activeHolding) : [],
      totals,
      finance,
      tendayReadiness: active?.overview ? await this._tendayReadinessContext(activeHolding, { catalogRows: data?.catalog?.resources, workerContext }) : null,
      defenseSummary,
      defenseContext: active?.defense ? this._defenseContext(activeHolding) : null,
      residentTransfer: prepareGmSection("Пересылка жителей", null, () => this._residentTransferContext(activeHolding, data)),
      operationsTimeline: prepareGmSection("Журнал операций", [], () => buildHoldingOperationTimeline(activeHolding)),
      constructionCrew: active?.buildings ? this._constructionCrew(activeHolding) : null,
      buildingTabs: active?.buildings ? this._prepareBuildingTabs(activeHolding) : [],
      buildingTemplates,
      buildingCategoryOptions: active?.buildings ? this._buildingCategoryOptions() : [],
      residentFilterOptions: active?.people
        ? this._residentFilterOptions(activeHolding)
        : { types: [], work: [], home: [], morale: [] },
      generator: prepareGmSection("Генератор жителей", null, () => this._prepareGeneratorContext(activeHolding)),
      resourceCatalog: prepareGmSection(
        "Каталог ресурсов",
        { rows: [], builtins: "", builtinCount: 0, overrideCount: 0, customCount: 0, hasRows: false },
        () => this._resourceCatalogContext(data, canEdit)
      ),
      marketCatalog: prepareGmSection(
        "Каталог рынка",
        { countryCount: 0, locationCount: 0, specialtyCount: 0, organizationCount: 0, marketCount: 0, activeMarketCount: 0, offerCount: 0, hasOverride: false },
        () => this._marketCatalogContext(data)
      ),
      gmContextErrors,
      hasGmContextErrors: gmContextErrors.length > 0
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
    const currentSeasonText = this._calendarSeasonText(snapshot?.season);
    const settlementSeasonTextValue = this._calendarSeasonText(settlementSnapshot?.season);
    const currentFullText = snapshot.available ? snapshot.text : "Calendaria не найдена";
    const settlementSeasonText = settlementSeasonTextValue
      ? `Последний рассчитанный сезон на ${lastText}: ${settlementSeasonTextValue}.`
      : "Сезон поселения не вычислен: дата последнего обновления не задана.";
    return {
      available: Boolean(snapshot.available),
      currentText: snapshot.available ? snapshot.text : "Calendaria не найдена",
      seasonText: currentSeasonText,
      currentTitle: snapshot.available ? `Текущая дата Calendaria: ${currentFullText}. ${settlementSeasonText}` : "Calendaria не активна или не обнаружена.",
      lastText,
      lastInput,
      lastTitle: lastDateTime
        ? `Последний проведённый расчёт завершён на дате ${lastText}. Следующий десятник начнётся от этой даты; поле можно исправить вручную у GM.`
        : "Дата последнего расчёта не задана. Первый десятник возьмёт живую дату Calendaria.",
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
    this._pendingExternalRerender = false;
    const windowFrame = this._pendingWindowFrame;
    this._pendingWindowFrame = null;

    this._bindWindowFrameSync(root);
    this._bindInputGuards(root);
    this._bindGlobalInputGuard(root);
    this._bindFloatingTooltips(root);
    restorePersistentImages(root, this._pendingPersistentImages);
    this._pendingPersistentImages = null;
    bindImageFallbacks(root);
    this._bindDelegatedEvents(root, context);
    this._syncResidentAppearanceTextareas(root);
    this._syncResidentTraitChips(root);
    this._applyResidentSearchFilter?.(root, this.residentFilters?.search ?? "");
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
    const cells = Array.from(root?.querySelectorAll?.(".fbls-traits-cell") ?? []);
    if (!cells.length) return;

    const apply = () => {
      for (const cell of cells) {
        const badges = Array.from(cell.querySelectorAll?.(".fbls-trait-badge") ?? []);
        if (!badges.length || cell.clientWidth <= 0) continue;
        for (const badge of badges) {
          const full = String(badge.dataset.fullLabel ?? badge.title ?? badge.textContent ?? "").trim();
          badge.classList.remove("compact-trait");
          badge.textContent = full;
        }
        if (cell.scrollWidth <= cell.clientWidth + 1) continue;
        for (const badge of badges) {
          const short = String(badge.dataset.shortLabel ?? badge.dataset.fullLabel ?? badge.textContent ?? "?").trim();
          badge.classList.add("compact-trait");
          badge.textContent = short.slice(0, 1).toUpperCase() || "?";
        }
      }
    };

    apply();
    if (globalThis.requestAnimationFrame) requestAnimationFrame(apply);
    if (typeof globalThis.ResizeObserver === "function") {
      this._residentTraitResizeObserver = new ResizeObserver(apply);
      for (const cell of cells) this._residentTraitResizeObserver.observe(cell);
    }
  }

  _bindDelegatedEvents(root, context = {}) {
    this._delegatedAbortController?.abort?.();
    const controller = new AbortController();
    this._delegatedAbortController = controller;
    const listenerOptions = { signal: controller.signal };

    root.addEventListener("pointerdown", (event) => {
      if (!this._pendingExternalRerender) return;
      const interactive = event.target?.closest?.("button, input, textarea, select, [contenteditable='true'], [data-action]");
      if (interactive) return;
      this._pendingExternalRerender = false;
      globalThis.setTimeout?.(() => {
        if (this.rendered && !this._pendingExternalRerender) this.requestRender({ focus: false });
      }, 0);
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
      if (target.matches?.("[data-suitable-type-add-field]")) return dispatch(event, target, "_onSuitableTypeAddChange");
      if (target.matches?.("[data-building-construction-crew]")) return dispatch(event, target, "_onBuildingConstructionCrewChange");
      if (target.matches?.("[data-generator-field]")) return dispatch(event, target, "_onGeneratorFieldChange");
      if (target.matches?.("[data-generator-person-field]")) return dispatch(event, target, "_onGeneratedPersonFieldChange");
      if (target.matches?.("[data-building-worker-field]")) return dispatch(event, target, "_onBuildingWorkerChange");
      if (target.matches?.("[data-storage-money-field]")) return dispatch(event, target, "_onStorageMoneyChange");
      if (target.matches?.("[data-storage-batch-select]")) return dispatch(event, target, "_onStorageBatchSelectionChange");
      if (target.matches?.("[data-calendaria-last-field]")) return dispatch(event, target, "_onCalendariaLastDateChange");
      if (target.matches?.("[data-economy-v2-backup-file]")) return dispatch(event, target, "_onEconomyV2BackupFileChange");
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
        this._syncResidentAppearanceTextarea(target, { autosize: true });
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
    await super._onClose(options);
    this._hideTooltip();
    this._unbindGlobalInputGuard();
    this._delegatedAbortController?.abort?.();
    this._delegatedAbortController = null;
    this._residentTraitResizeObserver?.disconnect?.();
    this._residentTraitResizeObserver = null;
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
    width: 1232,
    height: 760
  }
};
SkyholdApp.PARTS = {
  body: {
    template: `modules/${MODULE_ID}/templates/skyhold-app.hbs`
  }
};
registerSkyholdAppClass(SkyholdApp);
