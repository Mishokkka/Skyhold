import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
// These existing-world recipe and service regressions keep their pre-transition labor contracts.
// Hybrid staff/QD behavior is exercised separately by the hybrid-labor suite.
import { BUILDING_TEMPLATES_BEFORE_LABOR_TRANSITION as DEFAULT_BUILDING_TEMPLATES } from "../data/building-templates.js";
import { DEFAULT_SKYHOLD_DATA } from "../data/defaults/default-skyhold-data.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { SkyholdData } from "../data/store.js";
import { SkyholdWorkflowService } from "../workflows/skyhold-workflow-service.js";
import { parseResourceCosts, resourceBasePriceCopper, resourceDef } from "../core/resources.js";
import { inferBuildingSpecialKind } from "../core/building-specials.js";
import { workerBackgroundGroupMembers } from "../engines/workers/building-qualification.js";
import { cancelProductionBatch } from "../engines/economy/production-cancellation.js";
import { productionBatchLife } from "../engines/economy/production-batch-life.js";
import { beginPerishableStoragePeriod, expireProductionIngredients, finishPerishableStoragePeriod } from "../engines/economy/perishable-storage.js";
import { addResourceBatches, setResourceBatchPeriodStep, takeResourceBatches } from "../core/resource-batches.js";
import { productionLineEconomics } from "../engines/economy/production-economics.js";
import { planBuildingCatalogMigration } from "../workflows/buildings/catalog-migration.js";
import { buildingCatalogV17Templates } from "../data/building-template-revision-v17.js";
import { checkProductionHerdBalance } from "./production-herd-balance-check.mjs";
import { prepareResourceCatalogEditor } from "../data/resources/resource-editor.js";

const quantity = (holding, id) => holding.storage.resources.filter((row) => row.resourceId === id).reduce((sum, row) => sum + row.qty, 0);
const report = () => ({ periodQd: 40, periodLabel: "проверка", produced: [], consumed: [], skipped: [], income: [], formulas: [], work: [], ledger: [], treasury: { spent: 0, deficit: 0, lines: [] } });

function fixture(id, lineId) {
  const building = structuredClone(DEFAULT_BUILDING_TEMPLATES.find((row) => row.id === id));
  assert.ok(building, id);
  Object.assign(building, { templateId: id, id: "building", constructionStatus: "built", buildProgress: building.buildTarget, assignedWorkerIds: [] });
  building.productionSelection = { ...building.productionSelection, gmConfirmed: true };
  for (const line of building.productionLines) line.active = line.id === lineId;
  const backgrounds = (building.workerProfile?.composition ?? []).flatMap((row) => Array.from({ length: row.count }, () => workerBackgroundGroupMembers(row.group)[0]));
  const people = Array.from({ length: Math.max(building.workersMin, backgrounds.length, 1) }, (_, index) => ({
    id: `worker-${index}`, name: `Работник ${index}`, age: 30, attributes: { strength: 5, agility: 5, wits: 5, empathy: 5 },
    background: backgrounds[index] ?? "", traits: ["Храбрец"], workAllocationMode: "explicit",
    workAllocations: [{ id: `work-${index}`, sourceId: "building", functionId: `production:${lineId}`, normalQd: 20, overtimeQd: 0 }]
  }));
  if (building.maintenance?.requiredPoints > 0) people.push({ id: "mechanic", name: "Механик", age: 30,
    attributes: { strength: 5, agility: 5, wits: 5, empathy: 5 }, background: workerBackgroundGroupMembers("ТЕХНИКА")[0], workAllocationMode: "explicit",
    workAllocations: [{ id: "maintenance", sourceId: "building", functionId: "maintenance", normalQd: building.maintenance.requiredPoints, overtimeQd: 0 }] });
  building.assignedWorkerIds = people.map((person) => person.id);
  const line = building.productionLines.find((row) => row.id === lineId);
  const holding = mergeHoldingDefaults({ id: "production-review", people: { list: people }, buildings: { list: [building] },
    storage: { moneyCopper: 10_000_000, resources: parseResourceCosts(line.expenses).map((cost) => ({
      id: cost.resourceId, resourceId: cost.resourceId, qty: 10_000, roomId: "outdoors", batches: [{ id: `raw-${cost.resourceId}`, qty: 10_000, ageQd: 0 }]
    })) } });
  SkyholdData.view = () => ({ ...DEFAULT_SKYHOLD_DATA, holdings: [holding] });
  return holding;
}

async function run(app, holding, { livestock = false } = {}) {
  const result = report();
  const financeContext = app._prepareFinanceForQd(holding, 40, result, { operationId: "production-review", createdAt: "2026-10-11" });
  assert.equal(app._runMaintenanceForQd(holding, 40, result, { operationId: "production-review:maintenance", financeContext }).ok, true);
  app._prepareTechnicalServiceRestarts(holding, financeContext, result);
  const workerContext = app._economyWorkerContext(holding, { financeContext });
  const method = livestock ? "_runProductionAndLivestockForQd" : "_runProductionCycleForQd";
  await app[method](holding, 40, result, { workerContext, financeContext });
  return { report: result, financeContext, workerContext };
}

export async function checkProductionReview() {
  const previousGame = globalThis.game;
  const previousView = SkyholdData.view;
  globalThis.game = { user: { id: "test-gm", isGM: true }, settings: { get: () => undefined }, modules: new Map(), i18n: { localize: (key) => key } };
  try {
    const app = new SkyholdWorkflowService();
    assert.equal(inferBuildingSpecialKind({ id: "custom-craft", name: "Медицинская мастерская", notes: "Для лечения больных" }), "");
    assert.equal(inferBuildingSpecialKind({ special: { kind: "medical" } }), "medical");
    assert.equal(inferBuildingSpecialKind({ templateId: "hospital" }), "medical");
    for (const line of DEFAULT_BUILDING_TEMPLATES.find((row) => row.id === "apothecary").productionLines) {
      const holding = fixture("apothecary", line.id);
      await run(app, holding);
      assert.ok(quantity(holding, line.resourceId) > 0, `Pharmacy produces ${line.resourceId}`);
    }

    const expired = fixture("cheesery", "line-2-aged-cheese");
    const expiredLine = expired.buildings.list[0].productionLines.find((row) => row.active);
    expired.storage.resources = [];
    Object.assign(expiredLine, { workProgressUnits: 5000, workInputsReserved: true, workReservedOutputQty: 8,
      workReservedInputs: { version: 1, entries: [{ kind: "resource", qty: 16, resource: { resourceId: "milk" }, batches: [{ id: "old-milk", qty: 16, ageQd: 964 }] }] } });
    const expiredResult = await run(app, expired);
    assert.equal(quantity(expired, "aged-cheese"), 0);
    assert.equal(expiredLine.workInputsReserved, false);
    assert.ok(expiredResult.report.skipped.some((text) => text.includes("пищевая партия испортилась")));
    const cancelled = { ...structuredClone(expiredLine), workInputsReserved: true,
      workReservedInputs: { version: 1, openedAtQd: 0, processingShelfLifeQd: 120, entries: [] } };
    expired.gm.calendaria.lastQd = 960;
    assert.equal(cancelProductionBatch(expired, cancelled, {}).expired, true);
    assert.equal(productionBatchLife(expired, { ...cancelled, resourceId: "wood", workInputsReserved: true }).expired, false);

    const processing = { resourceId: "aged-cheese", active: true, workInputsReserved: true,
      workReservedInputs: { version: 1, openedAtQd: 0, processingShelfLifeQd: 120, entries: [
        { kind: "resource", qty: 2, resource: { resourceId: "milk" }, batches: [{ id: "raw", ageQd: 40, qty: 2 }] }
      ] } };
    const processingHolding = { gm: { calendaria: { lastQd: 40 } } };
    assert.equal(productionBatchLife(processingHolding, processing).expired, false, "Working cheese has its own deadline, not raw-milk shelf life");
    assert.equal(cancelProductionBatch(processingHolding, processing).discardedQty, 2, "Cancellation cannot restore spoiled raw milk");
    const freshRefunds = [];
    const fresh = { resourceId: "food-dairy", workInputsReserved: true, workReservedInputs: { version: 1, openedAtQd: 40, entries: [
      { kind: "resource", qty: 2, resource: { resourceId: "milk" }, batches: [{ id: "fresh", ageQd: 1, qty: 2 }] }
    ] } };
    assert.equal(cancelProductionBatch(processingHolding, fresh, { addResource: (_holding, row, qty) => freshRefunds.push({ row, qty }) }).ok, true);
    assert.equal(freshRefunds[0].row.batches[0].ageQd, 1, "Fresh cancellation preserves raw ingredient age");
    const malformed = { resourceId: "food-dairy", workInputsReserved: true, workReservedInputs: { version: 1, openedAtQd: 40, entries: [
      { kind: "resource", qty: 3, resource: { resourceId: "milk" }, batches: [{ id: "partial", ageQd: 1, qty: 1 }] }
    ] } };
    assert.throws(() => cancelProductionBatch(processingHolding, malformed), /receipt is incomplete/, "Spoilage handling cannot conceal an incomplete refund receipt");

    const stock = { storage: { resources: [{ id: "milk", resourceId: "milk", qty: 0, batches: [] }] } };
    const milk = stock.storage.resources[0];
    beginPerishableStoragePeriod(stock);
    setResourceBatchPeriodStep(stock, 3);
    addResourceBatches(milk, { qty: 2 }, { holding: stock });
    setResourceBatchPeriodStep(stock, 7);
    addResourceBatches(milk, { qty: 3 }, { holding: stock });
    expireProductionIngredients(stock, 12, report());
    assert.equal(milk.qty, 3, "Day-one milk expires before later shifts, day-two milk remains usable");
    finishPerishableStoragePeriod({ holding: stock, elapsedQd: 12 });
    assert.equal(milk.batches[0].ageQd, 4, "Daily output ages from its production day exactly once");
    milk.qty = 0;
    milk.batches = [];
    beginPerishableStoragePeriod(stock);
    setResourceBatchPeriodStep(stock, 3);
    addResourceBatches(milk, { qty: 1 }, { holding: stock, makeId: () => "z-older" });
    setResourceBatchPeriodStep(stock, 7);
    addResourceBatches(milk, { qty: 1 }, { holding: stock, makeId: () => "a-newer" });
    const taken = takeResourceBatches(milk, 1, { holding: stock });
    assert.equal(taken.batches[0].id, "z-older", "Daily FIFO follows production time, not equal stored ages or random IDs");
    assert.equal(taken.batches[0].ageQd, 0, "Virtual FIFO age must not be persisted early and then aged twice");
    finishPerishableStoragePeriod({ holding: stock, elapsedQd: 8 });

    const shortShift = fixture("cannery", "line-1-preserved-meat");
    // Isolate shift composition from the separate delayed-maintenance gate.
    shortShift.buildings.list[0].maintenance.requiredPoints = 0;
    const specialists = shortShift.people.list.filter((person) => person.id !== "mechanic" && person.background);
    assert.equal(specialists.length, 2);
    for (const person of specialists) person.workAllocations[0].normalQd = 1;
    const fullShift = structuredClone(shortShift);
    for (const person of fullShift.people.list.filter((person) => person.id !== "mechanic" && person.background)) person.workAllocations[0].normalQd = 20;
    await run(app, shortShift);
    SkyholdData.view = () => ({ ...DEFAULT_SKYHOLD_DATA, holdings: [fullShift] });
    await run(app, fullShift);
    assert.ok(quantity(shortShift, "canned-protein") > 0, "A complete first shift still produces");
    assert.ok(quantity(fullShift, "canned-protein") > quantity(shortShift, "canned-protein") * 5, "Specialists cannot authorize the rest of the period after leaving");

    const chain = fixture("cheesery", "line-1-food-dairy");
    chain.storage.resources = chain.storage.resources.filter((row) => row.resourceId !== "milk");
    const pasture = structuredClone(DEFAULT_BUILDING_TEMPLATES.find((row) => row.id === "pasture"));
    Object.assign(pasture, { id: "pasture", templateId: "pasture", constructionStatus: "built", buildProgress: pasture.buildTarget, assignedWorkerIds: ["herder"] });
    pasture.livestock.state = { ...pasture.livestock.state, adults: 12, breedingMales: 1 };
    pasture.livestock.operations.milk = true;
    chain.buildings.list.push(pasture);
    chain.people.list.push({ id: "herder", name: "Пастух", age: 30, attributes: { strength: 3, agility: 3, wits: 3, empathy: 3 },
      workAllocationMode: "explicit", workAllocations: [{ id: "care", sourceId: "pasture", functionId: "livestock", normalQd: 10, overtimeQd: 0 }] });
    const normalizedChain = mergeHoldingDefaults(chain);
    normalizedChain.buildings.list.find((row) => row.id === "pasture").lifecycle = "active";
    SkyholdData.view = () => ({ ...DEFAULT_SKYHOLD_DATA, holdings: [normalizedChain] });
    app._livestockSeasonContext = () => ({ seasonId: "summer", seasonKey: "1:summer" });
    beginPerishableStoragePeriod(normalizedChain);
    const chainedResult = await run(app, normalizedChain, { livestock: true });
    assert.equal(chainedResult.report.livestock.milk, 110, "Ten daily deliveries do not multiply herd output");
    assert.ok(quantity(normalizedChain, "food-dairy") > 0, "Current period milk reaches the cheesery");
    finishPerishableStoragePeriod({ holding: normalizedChain, elapsedQd: 40 });
    assert.ok(normalizedChain.storage.resources.filter((row) => row.resourceId === "milk").every((row) => row.batches.every((batch) => batch.ageQd < 8)));

    const inn = fixture("inn", "line-grain-porridge");
    const innResult = await run(app, inn);
    app._recordBuildingServiceActivity(inn, innResult.report, innResult.financeContext);
    inn.gm.calendaria.lastQd = 40;
    assert.equal(app._buildingMoraleSummary(inn).total, 15, "Kitchen work supplies inn morale without separate culture QD");
    inn.buildings.list[0].productionLines.forEach((line) => { line.active = false; });
    assert.equal(app._buildingMoraleSummary(inn).total, 0, "Disabled kitchen cannot retain its previous social activity");
    inn.buildings.list[0].productionLines.find((line) => line.id === "line-grain-porridge").active = true;
    const activity = inn.buildings.list[0].serviceState;
    const savedActivity = structuredClone(activity);
    activity.workedQdByFunction = { production: 20, "production:line-grain-porridge": 20 };
    delete activity.workedQdByWorkerAndFunction;
    assert.equal(app._buildingMoraleSummary(inn).total, 0, "Aggregate production and its line aliases must not double 20 QD into 40");
    inn.buildings.list[0].serviceState = savedActivity;
    inn.buildings.list[0].assignedWorkerIds = [];
    for (const person of inn.people.list) person.workAllocations = [];
    assert.equal(app._buildingMoraleSummary(inn).total, 0, "Closed inn does not retain morale");

    assert.equal(resourceDef("food-vegetables").foodType, resourceDef("canned-vegetables").foodType);
    const override = { ...resourceDef("grain"), notes: "My campaign note" };
    for (const canEdit of [true, false]) {
      const editorRow = prepareResourceCatalogEditor([override], { canEdit }).rows.find((row) => row.id === "grain");
      assert.equal(editorRow.notes, override.notes, "Unit explanations never overwrite the GM's notes");
      assert.match(editorRow.unitExplanation, /Смысл 1 ЕД/);
    }
    const mill = DEFAULT_BUILDING_TEMPLATES.find((row) => row.id === "mill");
    const feed = mill.productionLines.find((row) => row.resourceId === "animal-feed");
    const margin = feed.outputQty * resourceBasePriceCopper("animal-feed") - 6 * resourceBasePriceCopper("grain") - feed.workQd * mill.wageDailyCopper / 2;
    assert.ok(20 / feed.workQd * margin - (mill.baseUpkeepMonthlyCopper + mill.operatingUpkeepMonthlyCopper) / 3 - mill.maintenance.requiredPoints * 9 > 0,
      "One ordinary feed worker covers materials, wages, mill overhead and technical work");

    const bakery = DEFAULT_BUILDING_TEMPLATES.find((row) => row.id === "bakery");
    const bread = bakery.productionLines[0];
    const base = productionLineEconomics(bread, bakery);
    const sale = productionLineEconomics(bread, bakery, { channel: "ordinary" });
    assert.ok(base.marginMin > 0 && sale.marginMin < 0, "Preview distinguishes recipe margin from ordinary-seller losses");
    assert.equal(productionLineEconomics(bread, bakery, { channel: "seller", sellerEfficiency: 2 }).revenue, base.revenue);
    assert.equal(productionLineEconomics(bread, bakery, { channel: "contract", unitPrice: 7 }).revenue, bread.outputQty * 7);
    assert.equal(productionLineEconomics({ ...bread, formula: "1d6" }, bakery).available, false);
    const protein = productionLineEconomics({ ...bread, expenses: "Белковое сырьё 2" }, bakery);
    assert.ok(protein.available && protein.inputMax > protein.inputMin, "Material groups expose a real price range");

    const timed = fixture("bakery", "line");
    const timedLine = timed.buildings.list[0].productionLines[0];
    Object.assign(timedLine, { source: "time", period: "day", workQd: 20, expenses: "", outputQty: 1 });
    const continuous = structuredClone(timed);
    await app._runProductionCycleForQd(timed, 40, report());
    await app._runProductionCycleForQd(timed, 40, report());
    assert.equal(quantity(timed, "bread"), 1, "P05 fixed: time mode carries a long funded cycle between calls");
    await app._runProductionCycleForQd(continuous, 80, report());
    assert.equal(quantity(continuous, "bread"), 1, "P05: the same automatic cycle is due within one sufficiently long call");

    const previous = buildingCatalogV17Templates();
    for (const building of DEFAULT_BUILDING_TEMPLATES) for (const line of building.productionLines) {
      const result = productionLineEconomics(line, building);
      assert.ok(result.available, `${building.id}/${line.id}: all shipped recipes have priced inputs`);
      if (building.id !== "greenhouse-complex") assert.ok(result.marginMin >= 0, `${building.id}/${line.id}: covers raw inputs and ordinary production labor at base prices`);
    }
    for (const id of ["lumbermill", "quarry", "grain-field", "garden", "fishing-pier"]) {
      assert.deepEqual(DEFAULT_BUILDING_TEMPLATES.find((row) => row.id === id).productionLines, previous.find((row) => row.id === id).productionLines, `${id}: P06/P23 recipes are unchanged`);
    }
    const oldPharmacy = structuredClone(previous.find((row) => row.id === "apothecary"));
    Object.assign(oldPharmacy, { id: "old-pharmacy", templateId: "apothecary", medical: { enabled: true },
      special: { kind: "medical", data: {} }, constructionStatus: "built", buildProgress: oldPharmacy.buildTarget });
    const oldSheep = structuredClone(previous.find((row) => row.id === "sheepfold"));
    Object.assign(oldSheep, { id: "old-sheep", templateId: "sheepfold", constructionStatus: "built", buildProgress: oldSheep.buildTarget });
    oldSheep.livestock.state = { ...oldSheep.livestock.state, adults: 6, breedingMales: 1 };
    const migrationInput = { meta: { templateCatalogVersion: 17 }, catalog: { buildings: previous }, holdings: [
      { id: "migration", people: { list: [] }, buildings: { list: [oldPharmacy, oldSheep] }, gm: {} }
    ] };
    const snapshot = structuredClone(migrationInput);
    const planned = planBuildingCatalogMigration({ currentData: migrationInput, operationId: "v18-preview" });
    assert.deepEqual(migrationInput, snapshot, "Catalog preview must not mutate or apply world data");
    const migrated = planned.targetData.holdings[0].buildings.list;
    assert.notEqual(inferBuildingSpecialKind(migrated[0]), "medical", "Explicit catalog update clears the old falsely inferred pharmacy medical flag");
    assert.equal(migrated[1].livestock.profile.capacity, 24);
    assert.equal(migrated[1].livestock.state.adults, 6, "Migration changes capacity without inventing or deleting animals");
    checkProductionHerdBalance();
  } finally {
    globalThis.game = previousGame;
    SkyholdData.view = previousView;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkProductionReview();
  console.log("FBL Skyhold production review regression checks passed.");
}
