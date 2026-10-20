import assert from "node:assert/strict";
import { confirmSocialWork } from "./social-effects-fixtures.mjs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { MODULE_ID, SETTING_CATALOG, SETTING_META } from "../data/constants.js";
import { makeLargeSettlementFixture, PERFORMANCE_SCENARIOS } from "./performance-fixtures.mjs";
import { SkyholdData } from "../data/store.js";
import { getSkyholdAppClass, registerSkyholdAppClass } from "../apps/registry.js";

function restoreGlobal(name, value, existed) {
  if (existed) globalThis[name] = value;
  else delete globalThis[name];
}

function instrument(target, name, counts, durations) {
  const original = target[name];
  assert.equal(typeof original, "function", `${name} must remain callable`);
  target[name] = function instrumentedBuildingContextMethod(...args) {
    counts[name] = (counts[name] ?? 0) + 1;
    const started = performance.now();
    try {
      return original.apply(this, args);
    } finally {
      durations[name] = (durations[name] ?? 0) + performance.now() - started;
    }
  };
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function cardPresentation(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    categoryLabel: row.categoryLabel,
    categoryIcon: row.categoryIcon,
    icon: row.icon,
    img: row.img,
    statusLabel: row.statusLabel,
    statusClass: row.statusClass,
    statusIcon: row.statusIcon,
    unlocked: row.unlocked,
    workerCountLine: row.workerCountLine,
    hasWorkerCapacity: row.hasWorkerCapacity,
    storage: {
      usedText: row.storage?.usedText,
      freeText: row.storage?.freeText,
      capacityText: row.storage?.capacityText,
      fillClass: row.storage?.fillClass,
      fillPercent: row.storage?.fillPercent,
      security: row.storage?.security,
      quality: row.storage?.quality
    },
    housing: {
      usedText: row.housing?.usedText,
      freeText: row.housing?.freeText,
      capacityText: row.housing?.capacityText,
      fillClass: row.housing?.fillClass,
      fillPercent: row.housing?.fillPercent,
      comfort: row.housing?.comfort,
      quality: row.housing?.quality
    },
    cardStatParts: row.cardStatParts,
    cardProductionRows: (row.cardProductionRows ?? []).map((line) => ({
      id: line.id,
      resource: line.resource,
      resourceIcon: line.resourceIcon,
      resourceImg: line.resourceImg,
      outputText: line.outputText,
      expenseText: line.expenseText,
      expenseItems: line.expenseItems,
      seasonShort: line.seasonShort,
      seasonTooltip: line.seasonTooltip
    })),
    pendingProductionRows: row.pendingProductionRows,
    showBuildProgress: row.showBuildProgress,
    progressPercent: row.progressPercent,
    remainingBuildSuccesses: row.remainingBuildSuccesses,
    constructionCrewOptions: row.constructionCrewOptions,
    hasUpkeep: row.hasUpkeep,
    upkeepLine: row.upkeepLine
  };
}

export async function checkBuildingContextCharacterization() {
  const previousDataView = SkyholdData.view;
  const previousAppClass = getSkyholdAppClass();
  const data = makeLargeSettlementFixture(PERFORMANCE_SCENARIOS.find((row) => row.key === "large"));
  const testMeta = {
    ...data.meta,
    storageCommit: {
      ...data.meta?.storageCommit,
      catalogHash: "building-context-characterization",
      writeComplete: true
    }
  };
  const globals = ["foundry", "game", "ui"].map((name) => ({
    name,
    existed: Object.hasOwn(globalThis, name),
    value: globalThis[name]
  }));

  class ApplicationV2 {
    constructor(options = {}) {
      this.options = options;
    }

    async _prepareContext() {
      return {};
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
    settings: {
      get(moduleId, key) {
        if (moduleId !== MODULE_ID) return null;
        if (key === SETTING_META) return testMeta;
        if (key === SETTING_CATALOG) return data.catalog;
        return null;
      }
    }
  };
  globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };

  try {
    const [{ SkyholdApp }] = await Promise.all([
      import("../apps/skyhold-app.js")
    ]);
    // The registered politics resolver uses the same world fixture as the
    // application; a partial settings mock cannot back the split-data store.
    SkyholdData.view = () => data;
    registerSkyholdAppClass(SkyholdApp);
    const holding = data.holdings[0];
    const source = holding.buildings.list[0];
    source.housing = { capacity: 2, comfort: 1, quality: 1, notes: "" };
    source.assignedWorkerIds = [holding.people.list[0].id, "", "", ""];
    const app = new SkyholdApp();
    app._contextData = data;
    app._contextHoldingId = holding.id;
    app._contextDevelopment = app._developmentSummary(holding);
    app.activeBuildingCategory = "all";

    const counts = {};
    const durations = {};
    for (const name of [
      "_storageRooms",
      "_prepareBuildingRow",
      "_buildingWorkerSlots",
      "_buildingHousingSlots",
      "_prepareBuildingContents",
      "_buildingIncomeSummary",
      "_buildingDefenseSummary",
      "_prepareProductionLines",
      "_housingOccupants",
      "_developmentParts"
    ]) instrument(app, name, counts, durations);

    const workerContext = app._economyWorkerContext(holding);
    const started = performance.now();
    const rows = app._prepareBuildingRows(holding, true, { workerContext });
    const elapsedMs = performance.now() - started;
    const cardBytes = jsonBytes(rows);

    assert.equal(rows.length, holding.buildings.list.length, "all category must preserve every visible building card");
    assert.equal(counts._storageRooms, 1, "building cards must share one storage-room computation");
    assert.equal(counts._buildingWorkerSlots ?? 0, 0, "building cards must not materialize editor worker options");
    assert.equal(counts._buildingHousingSlots ?? 0, 0, "building cards must not materialize editor housing options");
    assert.equal(counts._prepareBuildingContents ?? 0, 0, "building cards must not materialize editor content rows");
    assert.equal(counts._buildingIncomeSummary ?? 0, 0, "building cards must not materialize the income editor context");
    assert.equal(counts._buildingDefenseSummary ?? 0, 0, "building cards must not materialize the defense editor context");
    assert.ok(cardBytes < 5 * 1024 * 1024, `large building card context must stay below 5 MiB, got ${(cardBytes / 1024 / 1024).toFixed(2)} MiB`);

    for (const row of rows) {
      assert.equal(Object.hasOwn(row, "workerSlots"), false, "card rows must omit workerSlots");
      assert.equal(Object.hasOwn(row, "categoryOptions"), false, "card rows must omit categoryOptions");
      assert.equal(Object.hasOwn(row, "functionOptions"), false, "card rows must omit functionOptions");
      assert.equal(Object.hasOwn(row, "productionLines"), false, "card rows must omit full productionLines");
      assert.equal(Object.hasOwn(row.housing ?? {}, "slotRows"), false, "card housing summaries must omit slotRows");
      for (const line of row.cardProductionRows ?? []) {
        assert.equal(Object.hasOwn(line, "resourceOptions"), false, "card production rows must omit resourceOptions");
        assert.equal(Object.hasOwn(line, "storageRoomOptions"), false, "card production rows must omit storageRoomOptions");
        assert.equal(Object.hasOwn(line, "contentOptions"), false, "card production rows must omit contentOptions");
      }
    }

    const storageCategory = app._buildingCategoryOptions().find((row) => row.id === "storage")?.id ?? "storage";
    app.activeBuildingCategory = storageCategory;
    counts._prepareBuildingRow = 0;
    const filteredStarted = performance.now();
    const filteredRows = app._prepareBuildingRows(holding, true, { workerContext });
    const filteredElapsedMs = performance.now() - filteredStarted;
    const expectedFiltered = holding.buildings.list.filter((row) => app._buildingCategory(row) === storageCategory);
    assert.deepEqual(filteredRows.map((row) => row.id), expectedFiltered.map((row) => row.id), "category filter must preserve the same visible card set and order");
    assert.equal(counts._prepareBuildingRow, expectedFiltered.length, "category filter must run before heavy card preparation");

    const storageCallsBeforeEmptyCategory = counts._storageRooms;
    app.activeBuildingCategory = "missing-category";
    assert.deepEqual(app._prepareBuildingRows(holding, true, { workerContext }), [], "empty categories must remain empty");
    assert.equal(counts._storageRooms, storageCallsBeforeEmptyCategory, "empty categories must not prepare unused storage summaries");

    const storageRoomCallsBeforeEditor = counts._storageRooms;
    const editor = app._prepareBuildingRow(holding, source, 0, true, null, { workerContext });
    assert.equal(counts._storageRooms, storageRoomCallsBeforeEditor + 1, "full editor context must reuse one internally prepared storage-room collection");
    assert.equal(editor.storage.usedText, "0", "the direct editor path must preserve its existing storage-summary fallback");
    const rooms = app._storageRooms(holding, { includeUnavailable: true });
    const storageRoomCallsBeforeSharedEditor = counts._storageRooms;
    const sharedEditor = app._prepareBuildingRow(holding, source, 0, true, rooms, { workerContext });
    assert.equal(counts._storageRooms, storageRoomCallsBeforeSharedEditor, "full editor context must reuse a supplied storage-room collection");
    assert.deepEqual(cardPresentation(rows[0]), cardPresentation(sharedEditor), "card-only preparation must preserve every rendered card value");
    assert.equal(editor.workerSlots.length, 2, "editable worker roster must contain occupied slots plus one next empty slot");
    assert.deepEqual(editor.workerSlots.map((slot) => slot.slot), [0, 1], "compact worker roster must preserve actual assignment indexes");
    assert.ok(editor.workerSlots.every((slot) => Array.isArray(slot.options)), "editor worker slots must retain options");
    const readOnlyEditor = app._prepareBuildingRow(holding, source, 0, false, rooms, { workerContext });
    assert.equal(readOnlyEditor.workerSlots.length, 1, "read-only worker roster must omit unused capacity slots");
    assert.ok(Array.isArray(editor.housing.slotRows) && editor.housing.slotRows.length >= source.housing.capacity, "editor must retain all housing slots");
    assert.ok(editor.housing.slotRows.every((slot) => Array.isArray(slot.options)), "editor housing slots must retain options");
    assert.ok(Array.isArray(editor.productionLines) && editor.productionLines.length > 0, "editor must retain production lines");
    assert.ok(Array.isArray(editor.productionLines[0].resourceOptions), "editor production lines must retain resource options");
    assert.ok(Array.isArray(editor.productionLines[0].storageRoomOptions), "editor production lines must retain storage-room options");
    assert.ok(Array.isArray(editor.categoryOptions), "editor must retain category options");
    assert.ok(Array.isArray(editor.functionOptions), "editor must retain function options");

    const playerHidden = holding.buildings.list[2];
    const playerLegacyTemplate = holding.buildings.list[3];
    playerHidden.visibility = "gm";
    playerHidden.templateId = "";
    playerLegacyTemplate.visibility = "gm";
    playerLegacyTemplate.templateId = "legacy-visible-template";
    globalThis.game.user.isGM = false;
    app.activeBuildingCategory = "all";
    const playerRows = app._prepareBuildingRows(holding, false, { workerContext });
    const expectedPlayerIds = holding.buildings.list
      .filter((row) => row.visibility !== "gm" || String(row.templateId ?? "").trim())
      .map((row) => row.id);
    assert.deepEqual(playerRows.map((row) => row.id), expectedPlayerIds, "early filtering must preserve the existing player visibility contract and row order");

    const { DEFAULT_BUILDING_TEMPLATES } = await import("../data/building-templates.js");
    const well = DEFAULT_BUILDING_TEMPLATES.find((row) => row.id === "well");
    const smallHolding = structuredClone(holding);
    smallHolding.people.list = ["a", "b"].map((id) => ({ id: `keeper-${id}`, volunteerLabor: true,
      attributes: { strength: 3, agility: 3, wits: 3, empathy: 3 } }));
    smallHolding.buildings.list = ["a", "b"].map((id) => ({ ...structuredClone(well), id, templateId: "well", name: `Колодец ${id}`, bonuses: { food: 0, technology: 1, culture: 0, war: 0 }, reputation: 2, moraleDelta: 1, constructionStatus: "built", lifecycle: "active", condition: "intact" }));
    for (const building of smallHolding.buildings.list) confirmSocialWork(smallHolding, building, [`keeper-${building.id}`], 2);
    app._contextHoldingId = null;
    app.activeBuildingCategory = "all";
    const parts = (row) => Object.fromEntries(row.cardStatParts.map((part) => [part.key, part.value]));
    const initialSnapshot = JSON.stringify(smallHolding);
    for (const isGM of [true, false]) {
      globalThis.game.user.isGM = isGM;
      const repeated = app._prepareBuildingRows(smallHolding, isGM);
      assert.deepEqual(parts(repeated[0]), { technology: 1, morale: 1, reputation: 2 });
      assert.deepEqual(parts(repeated[1]), {}, "uncredited repeated effects must be absent for GM and player");
    }
    assert.equal(JSON.stringify(smallHolding), initialSnapshot, "card presentation must not mutate stored bonuses");
    smallHolding.buildings.list[1].repeatSettlementEffects = true;
    assert.deepEqual(parts(app._prepareBuildingRows(smallHolding, false)[1]), { technology: 1, morale: 1, reputation: 2 }, "explicitly allowed repeats remain visible");
    smallHolding.buildings.list[1].repeatSettlementEffects = false;
    for (const building of smallHolding.buildings.list) building.moraleDelta = -2;
    assert.equal(parts(app._prepareBuildingRows(smallHolding, false)[1]).morale, -2, "negative morale repeats still contribute");
    smallHolding.buildings.list[0].lifecycle = "planned";
    smallHolding.buildings.list[0].constructionStatus = "building";
    const afterClosure = app._prepareBuildingRows(smallHolding, false);
    assert.deepEqual(parts(afterClosure[0]), {}, "inactive building has no current contribution");
    assert.deepEqual(parts(afterClosure[1]), { technology: 1, morale: -2, reputation: 2 }, "remaining active instance receives the contribution");
    const bath = DEFAULT_BUILDING_TEMPLATES.find((row) => row.id === "bathhouse");
    smallHolding.people.list = Array.from({ length: 150 }, (_, i) => ({ id: `person-${i}`, volunteerLabor: true, injuredDays: 0, attributes: { strength: 3, agility: 3, wits: 3, empathy: 3 } }));
    smallHolding.buildings.list = [
      { ...structuredClone(well), id: "well", templateId: "well", lifecycle: "active", constructionStatus: "built", condition: "intact" },
      ...["bath-a", "bath-b"].map((id, i) => ({ ...structuredClone(bath), id, templateId: "bathhouse", lifecycle: "active", constructionStatus: "built", condition: "intact", assignedWorkerIds: [`person-${2 * i}`, `person-${2 * i + 1}`] }))
    ];
    for (const building of smallHolding.buildings.list.slice(1)) confirmSocialWork(smallHolding, building, building.assignedWorkerIds);
    const pooled = app._prepareBuildingRows(smallHolding, false);
    assert.equal(parts(pooled[1]).morale, 3, "pooled service coverage is shown on the credited source");
    assert.equal(parts(pooled[2]).morale, undefined, "pooled repeats must not advertise another fixed morale bonus");
    assert.equal(pooled.reduce((sum, row) => sum + (parts(row).morale ?? 0), 0), app._buildingMoraleSummary(smallHolding).total, "visible card morale agrees with actual settlement contribution");

    return {
      rows: rows.length,
      cardBytes,
      elapsedMs,
      filteredRows: filteredRows.length,
      filteredElapsedMs,
      durations
    };
  } finally {
    SkyholdData.view = previousDataView;
    registerSkyholdAppClass(previousAppClass);
    for (const entry of globals) restoreGlobal(entry.name, entry.value, entry.existed);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await checkBuildingContextCharacterization();
  console.log(`FBL Skyhold building context characterization passed: ${result.rows} cards, ${(result.cardBytes / 1024 / 1024).toFixed(2)} MiB, ${result.elapsedMs.toFixed(2)} ms; filtered ${result.filteredRows} in ${result.filteredElapsedMs.toFixed(2)} ms.`);
  console.log(JSON.stringify(result.durations, null, 2));
}
