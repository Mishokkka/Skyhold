import assert from "node:assert/strict";
import { SkyholdData } from "../data/store.js";
import { getSkyholdAppClass, registerSkyholdAppClass } from "../apps/registry.js";

function restoreGlobal(name, value, existed) {
  if (existed) globalThis[name] = value;
  else delete globalThis[name];
}

function countCalls(target, counts, name, result) {
  target[name] = (..._args) => {
    counts[name] = (counts[name] ?? 0) + 1;
    return typeof result === "function" ? result(..._args) : result;
  };
}

export async function checkSkyholdContextCharacterization() {
  const previousDataView = SkyholdData.view;
  const previousAppClass = getSkyholdAppClass();
  const hadFoundry = Object.hasOwn(globalThis, "foundry");
  const hadGame = Object.hasOwn(globalThis, "game");
  const hadUi = Object.hasOwn(globalThis, "ui");
  const previousFoundry = globalThis.foundry;
  const previousGame = globalThis.game;
  const previousUi = globalThis.ui;

  class ApplicationV2 {
    constructor(options = {}) {
      this.options = options;
    }

    async _prepareContext() {
      return { baseContext: true };
    }
  }

  globalThis.foundry = {
    applications: {
      api: {
        ApplicationV2,
        HandlebarsApplicationMixin: (Base) => class extends Base {}
      }
    },
    utils: {
      deepClone: (value) => structuredClone(value),
      getProperty() {},
      setProperty() {}
    }
  };
  globalThis.game = {
    user: { id: "gm", isGM: true },
    settings: { get() { return null; } }
  };
  globalThis.ui = {
    notifications: { warn() {}, info() {}, error() {} }
  };

  const [{ SkyholdApp }, { HoldingService }] = await Promise.all([
    import("../apps/skyhold-app.js"),
    import("../data/holding-service.js")
  ]);
  const originalGetData = HoldingService.getData;
  const originalGetDataView = HoldingService.getDataView;
  const holding = {
    id: "context-holding",
    name: "Context Holding",
    type: "skyhold",
    visibility: "public",
    gm: {
      playersCanEditOverview: false,
      playersCanEditBuildings: false,
      playersCanUseStorage: false,
      playersCanEditResidents: false,
      playersCanEditDefense: false,
      playersCanEditBattle: false,
      playersCanEditSpecial: false,
      loadingImage: ""
    },
    people: { list: [{ id: "alive", dead: false }, { id: "dead", dead: true }] },
    buildings: { list: [] },
    special: { list: [] },
    storage: { resources: [] }
  };
  const data = { holdings: [holding], catalog: { buildings: [], resources: [] } };
  SkyholdData.view = () => data;
  registerSkyholdAppClass(SkyholdApp);
  HoldingService.getData = () => data;
  HoldingService.getDataView = () => data;

  const scenarios = [
    { label: "overview", tab: "overview", storageTab: "resources", expected: { _economyWorkerContext: 1 } },
    { label: "people", tab: "people", storageTab: "resources", expected: { _residentFilterOptions: 1 } },
    {
      label: "buildings",
      tab: "buildings",
      storageTab: "resources",
      expected: {
        _economyWorkerContext: 1,
        _constructionCrew: 1,
        _prepareBuildingTabs: 1,
        _buildingTemplateContext: 1,
        _buildingCategoryOptions: 1
      }
    },
    {
      label: "defense",
      tab: "defense",
      storageTab: "resources",
      expected: { _economyWorkerContext: 1, _defenseSummary: 1, _defenseContext: 1 }
    },
    { label: "special", tab: "special", storageTab: "resources", expected: { _prepareSpecialTabs: 1 } },
    { label: "storage/resources", tab: "storage", storageTab: "resources", expected: { _storageContext: 1 } },
    {
      label: "storage/accounting",
      tab: "storage",
      storageTab: "accounting",
      expected: { _economyWorkerContext: 1, _prepareTotals: 1, _financeSummary: 1, _storageContext: 1 }
    },
    {
      label: "gm",
      tab: "gm",
      storageTab: "resources",
      expected: {
        _residentTransferContext: 1,
        _buildingTemplateContext: 1,
        _prepareGeneratorContext: 1,
        _resourceCatalogContext: 1
      }
    }
  ];
  const measured = [
    "_economyWorkerContext",
    "_prepareTotals",
    "_financeSummary",
    "_defenseSummary",
    "_defenseContext",
    "_storageContext",
    "_prepareSpecialTabs",
    "_residentTransferContext",
    "_constructionCrew",
    "_prepareBuildingTabs",
    "_buildingTemplateContext",
    "_buildingCategoryOptions",
    "_residentFilterOptions",
    "_prepareGeneratorContext",
    "_resourceCatalogContext"
  ];

  try {
    for (const scenario of scenarios) {
      const app = new SkyholdApp();
      app.activeTab = scenario.tab;
      app.activeStorageTab = scenario.storageTab;
      const counts = {};
      app._getVisibleHoldings = () => data.holdings;
      app._resolveActiveHolding = () => holding;
      app._contextLabels = () => ({});
      app._prepareTabs = () => ["overview", "people", "buildings", "defense", "special", "storage", "gm"]
        .map((id) => ({ id, label: id, icon: "" }));
      app._calculateMorale = () => 0;
      app._moraleState = () => ({ value: 0, css: "", label: "", range: "", notes: "", icon: "" });
      app._developmentSummary = () => ({ labels: [], totals: { food: 0, technology: 0, culture: 0, war: 0 } });
      app._beliefSummary = () => ({ label: "", tooltip: "" });
      app._calendarHeaderContext = () => ({ available: false });
      app._reputationSummary = () => ({ total: 0, tooltip: "" });
      app._prepareRows = () => ({ people: [], buildings: [], special: [], cemetery: [], storage: [] });

      countCalls(app, counts, "_economyWorkerContext", {});
      countCalls(app, counts, "_prepareTotals", {
        salary: 1,
        salaryTenDay: 10,
        salaryMonth: 30,
        upkeepMonth: 2,
        incomeTenDay: 3,
        projectedBalanceMonth: -23,
        population: 1,
        peopleRows: 2,
        buildingsRows: 0,
        specialRows: 0,
        storageRows: 0
      });
      countCalls(app, counts, "_financeSummary", { population: 1, treasuryText: "0" });
      countCalls(app, counts, "_defenseSummary", { total: 0 });
      countCalls(app, counts, "_defenseContext", {});
      countCalls(app, counts, "_storageContext", {});
      countCalls(app, counts, "_prepareSpecialTabs", []);
      countCalls(app, counts, "_residentTransferContext", {});
      countCalls(app, counts, "_constructionCrew", null);
      countCalls(app, counts, "_prepareBuildingTabs", []);
      countCalls(app, counts, "_buildingTemplateContext", { rows: [] });
      countCalls(app, counts, "_buildingCategoryOptions", []);
      countCalls(app, counts, "_residentFilterOptions", { types: [], work: [], home: [], morale: [] });
      countCalls(app, counts, "_prepareGeneratorContext", {});
      countCalls(app, counts, "_resourceCatalogContext", { rows: [] });

      const context = await app._prepareContext({});
      assert.equal(context.baseContext, true, `${scenario.label} must preserve the parent application context`);
      assert.equal(app._contextData, data, `${scenario.label} must preserve the prepared data cache`);
      assert.equal(app._contextHoldingIndex, 0, `${scenario.label} must preserve the holding index cache`);
      assert.equal(app._contextDevelopment, context.development, `${scenario.label} must preserve the development cache`);
      assert.equal(context.totals.population, 1, `${scenario.label} must preserve the header population`);
      for (const name of measured) {
        assert.equal(counts[name] ?? 0, scenario.expected[name] ?? 0, `${scenario.label} has an unexpected ${name} call count`);
      }
    }
  } finally {
    SkyholdData.view = previousDataView;
    registerSkyholdAppClass(previousAppClass);
    HoldingService.getData = originalGetData;
    HoldingService.getDataView = originalGetDataView;
    restoreGlobal("foundry", previousFoundry, hadFoundry);
    restoreGlobal("game", previousGame, hadGame);
    restoreGlobal("ui", previousUi, hadUi);
  }
}
