import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FinanceDomain } from "../apps/domains/finance-domain.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { normalizeBuilding } from "../data/normalizers/building.js";
import { runProductionCycle } from "../engines/economy/production-cycle.js";
import { cancelProductionBatch } from "../engines/economy/production-cancellation.js";
import { createProductionTiming, productionTimingText, assertProductionIdentityUnchanged } from "../engines/economy/production-timing.js";
import { beginPerishableStoragePeriod, expireProductionIngredients, finishPerishableStoragePeriod } from "../engines/economy/perishable-storage.js";
import { setResourceBatchPeriodStep } from "../core/resource-batches.js";
import { parseResourceCosts, resourceLabel } from "../core/resources.js";
import { migrationCycleFixture } from "./building-catalog-cycle-migration-check.mjs";
import { planBuildingCatalogMigration } from "../workflows/buildings/catalog-migration.js";

const storage = { ...FinanceDomain, _safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback };
const report = () => ({ produced: [], consumed: [], skipped: [], formulas: [], work: [], ledger: [] });
const quantity = (holding, id) => holding.storage.resources.filter((row) => row.resourceId === id).reduce((sum, row) => sum + row.qty, 0);
const lineOf = (holding) => holding.buildings.list[0].productionLines[0];

function fixture(changes = {}, raw = { resourceId: "wood", qty: 100 }) {
  return mergeHoldingDefaults({ id: "timing", gm: { calendaria: { lastQd: 0 } },
    people: { list: [{ id: "worker" }] }, storage: { moneyCopper: 100, resources: [{ id: "raw", roomId: "outdoors", ...raw,
      batches: [{ id: "raw-batch", qty: raw.qty, ageQd: 0 }] }] },
    buildings: { list: [{ id: "workshop", functions: { production: true }, productionLines: [{ id: "line", source: "time", period: "day",
      workQd: 20, resourceId: "stone", outputQty: 3, expenses: "wood 2", ...changes }] }] } });
}

function dependencies() {
  const noop = () => {};
  const budget = { available: 0, spent: 0 };
  const deps = {
    safeNumber: storage._safeNumber, resetWorkerBudgets: noop, accrueWorkerBudgets: () => { budget.available = 1; },
    getSeasonSnapshot: () => null, buildingStatus: () => ({ value: "built" }), buildingFunctions: () => ({ production: true }),
    lineSeasonAllowed: () => true, periodDueOnStep: (period, step, cycles) => (step + 1) % ((period === "qd" ? 1 : period === "day" ? 4 : 40) * cycles) === 0,
    normalizeResourceId: (id) => id, resourceLabel, lineContentQuantity: () => 1,
    buildingEffectiveWorkers: () => ({ total: 1, assigned: 0 }),
    lineOutputForCycle: async (line) => ({ qty: line.outputQty, formula: "" }), parseResourceCosts,
    costsForUnits: (costs, n) => costs.map((cost) => ({ ...cost, qty: cost.qty * n })),
    scaledCosts: (costs, n) => costs.map((cost) => ({ ...cost, qty: cost.qty * n })),
    storageCanPay: (h, costs) => storage._storageCanPay(h, costs), storagePay: (h, costs) => storage._storagePay(h, costs, { captureReceipt: true }),
    normalizeStorageRoomId: (id) => id || "outdoors",
    storageAddWithOverflow: (h, resource, n) => { storage._storageAdd(h, resource, n); return [{ qty: n }]; },
    pushProductionPlacement: (r, h, building, name, placements) => r.produced.push({ name, placements }),
    autoCollectBuilding: noop, assignedBuildingPeople: (h) => h.people.list, workerBudgetEntry: () => budget,
    personBuildingEfficiency: () => 1, buildingCompositionStatus: () => ({ met: true }),
    storageQuantity: (h, cost) => storage._storageQuantity(h, cost), tryCollectResourceForConsumer: noop,
    affordableUnitsForCosts: () => 0, formatNumber: String,
    beforeStep: (h, step, r) => { setResourceBatchPeriodStep(h, step); expireProductionIngredients(h, r); },
    afterPeriod: (h) => setResourceBatchPeriodStep(h, null), budget
  };
  return deps;
}

async function advance(holding, qd, deps = dependencies()) {
  const result = report();
  beginPerishableStoragePeriod(holding);
  await runProductionCycle({ holding, qd, report: result, dependencies: deps });
  finishPerishableStoragePeriod({ holding, elapsedQd: qd });
  holding.gm.calendaria.lastQd += qd;
  return result;
}

export { fixture as productionFixture, dependencies as productionDependencies, advance as advanceProduction, quantity as productionQuantity, storage as productionStorage };

export async function checkProductionTime() {
  let split = fixture();
  const whole = structuredClone(split);
  await advance(split, 40);
  assert.equal(quantity(split, "wood"), 98, "Inputs are paid on start, not completion");
  assert.equal(quantity(split, "stone"), 0);
  split = mergeHoldingDefaults(JSON.parse(JSON.stringify(split)));
  assert.equal(lineOf(split).workReservedInputs.timing.elapsedQd, 40, "Reload retains time progress");
  await advance(split, 40);
  await advance(whole, 80);
  assert.equal(quantity(split, "stone"), 3);
  assert.equal(quantity(split, "wood"), quantity(whole, "wood"));
  assert.equal(quantity(split, "stone"), quantity(whole, "stone"), "Splitting a period does not change output");
  assert.equal(lineOf(split).workInputsReserved, false, "No hidden next reservation at the boundary");
  for (const [period, workQd, total] of [["qd", 7, 7], ["day", 2, 8], ["tenday", 2, 80]]) {
    const h = fixture({ period, workQd, repeat: false });
    for (let step = 0; step < total; step++) await advance(h, 1);
    assert.equal(quantity(h, "stone"), 3, `${period}: one-QD steps retain exact duration`);
    assert.equal(lineOf(h).active, false);
    await advance(h, total);
    assert.equal(quantity(h, "stone"), 3, "One-shot does not open another batch");
  }

  const paused = fixture({ period: "qd", workQd: 4 });
  await advance(paused, 1);
  lineOf(paused).active = false;
  await advance(paused, 9);
  assert.equal(lineOf(paused).workReservedInputs.timing.elapsedQd, 1);
  assert.match(productionTimingText(lineOf(paused)), /пауза/);
  lineOf(paused).active = true;
  for (const key of ["lineSeasonAllowed", "lineFinanceAllowed", "buildingTechnicalReady"]) {
    await advance(paused, 2, { ...dependencies(), [key]: () => false });
    assert.equal(lineOf(paused).workReservedInputs.timing.elapsedQd, 1, key);
  }
  await advance(paused, 3);
  assert.equal(quantity(paused, "stone"), 3);

  const waiting = fixture({ source: "workers", workQd: 1, waitDays: 1, repeat: false });
  const labor = dependencies();
  await advance(waiting, 1, labor);
  assert.equal(labor.budget.spent, 1);
  assert.equal(lineOf(waiting).workReservedInputs.timing.phase, "waiting");
  assert.equal(lineOf(waiting).workReservedInputs.timing.elapsedQd, 0, "Labor QD cannot also count as a waiting QD");
  normalizeBuilding(waiting.buildings.list[0]);
  assert.equal(lineOf(waiting).workProgressUnits, 10_000, "Reload does not wrap completed labor back to zero");
  waiting.people.list = [];
  await advance(waiting, 3, labor);
  assert.equal(quantity(waiting, "stone"), 0);
  await advance(waiting, 1, labor);
  assert.equal(quantity(waiting, "stone"), 3, "Waiting completes without assigned workers");
  assert.equal(labor.budget.spent, 1, "Waiting has no labor cost");
  assert.equal(quantity(waiting, "wood"), 98);

  const edited = fixture({ source: "workers", workQd: 2, waitDays: 1, repeat: false });
  await advance(edited, 1);
  Object.assign(lineOf(edited), { workQd: 1, waitDays: 0, outputQty: 999, expenses: "iron 80" });
  normalizeBuilding(edited.buildings.list[0]);
  assert.equal(lineOf(edited).workProgressUnits, 10_000, "Changed recipe cannot reset reserved work");
  await advance(edited, 4);
  assert.equal(quantity(edited, "stone"), 0, "Original labor and wait duration remain frozen");
  await advance(edited, 1);
  assert.equal(quantity(edited, "stone"), 3, "Original batch output remains frozen");
  assert.equal(quantity(edited, "wood"), 98);

  const timedEdit = fixture({ period: "qd", workQd: 4, repeat: false });
  const formula = dependencies();
  let rolls = 0;
  formula.lineOutputForCycle = async () => { rolls++; return { qty: 5, formula: "1d6" }; };
  await advance(timedEdit, 1, formula);
  Object.assign(lineOf(timedEdit), { period: "day", workQd: 1, outputQty: 999, expenses: "iron 80" });
  normalizeBuilding(timedEdit.buildings.list[0]);
  await advance(timedEdit, 2, formula);
  assert.equal(quantity(timedEdit, "stone"), 0);
  await advance(timedEdit, 1, formula);
  assert.equal(quantity(timedEdit, "stone"), 5);
  assert.equal(rolls, 1, "A time batch rolls its output only once, before waiting");

  const repeated = fixture({ source: "workers", workQd: 1, waitDays: 0.5 });
  const repeatedLabor = dependencies();
  for (const qd of [1, 4, 2, 5]) await advance(repeated, qd, repeatedLabor);
  assert.equal(quantity(repeated, "stone"), 12, "Four sequential work + wait batches in 12 QD");
  assert.equal(quantity(repeated, "wood"), 92);
  assert.equal(repeatedLabor.budget.spent, 4);

  const empty = fixture({}, { resourceId: "wood", qty: 1 });
  await advance(empty, 90);
  assert.equal(lineOf(empty).workInputsReserved, false, "No free progress while inputs are missing");
  assert.equal(quantity(empty, "wood"), 1, "Missing full inputs cannot partially charge a batch");
  assert.equal(quantity(empty, "stone"), 0);

  const food = fixture({ resourceId: "aged-cheese", expenses: "milk 2", source: "workers", workQd: 1, waitDays: 60, repeat: false }, { resourceId: "milk", qty: 2 });
  await advance(food, 1);
  assert.equal(lineOf(food).workReservedInputs.processingShelfLifeQd, 360, "Planned maturation extends processing deadline");
  for (let i = 0; i < 6; i++) await advance(food, 40);
  assert.equal(quantity(food, "aged-cheese"), 3, "Maturation does not spoil at the old 30-day processing limit");
  const rotten = fixture({ resourceId: "aged-cheese", expenses: "milk 2", workQd: 1 }, { resourceId: "milk", qty: 2 });
  await advance(rotten, 1);
  lineOf(rotten).active = false;
  const expiry = await advance(rotten, 125);
  assert.equal(lineOf(rotten).workInputsReserved, false, "Pause does not stop food expiry");
  assert.ok(expiry.skipped.some((text) => text.includes("испортил")));

  const cancelled = fixture();
  await advance(cancelled, 40);
  const result = cancelProductionBatch(cancelled, lineOf(cancelled), {
    addMoney: (h, n) => storage._addMoney(h, n), addResource: (h, row, n) => storage._restoreProductionResource(h, row, n)
  });
  assert.equal(result.ok, true);
  assert.equal(quantity(cancelled, "wood"), 100);
  assert.ok(cancelled.storage.resources.find((row) => row.resourceId === "wood").batches.every((batch) => batch.ageQd === 40), "Cancellation returns aged inputs");
  assert.equal(cancelProductionBatch(cancelled, lineOf(cancelled)).noop, true, "No double refund");

  const collected = fixture({ period: "qd", workQd: 2, requiresCollection: true, repeat: false });
  await advance(collected, 2);
  assert.equal(lineOf(collected).pendingQty, 3);
  assert.equal(quantity(collected, "stone"), 0, "Waiting completion respects manual collection");
  assert.throws(() => assertProductionIdentityUnchanged([lineOf(collected)], [{ ...lineOf(collected), resourceId: "iron" }]));
  assert.doesNotThrow(() => assertProductionIdentityUnchanged([lineOf(collected)], [{ ...lineOf(collected), workQd: 20 }]));

  const migration = migrationCycleFixture();
  const migratedLine = migration.holdings[0].buildings.list[0].productionLines[0];
  migratedLine.workReservedInputs.timing = createProductionTiming({ ...migratedLine, waitDays: 2 }, migratedLine.resourceId, migratedLine.resource);
  migratedLine.workReservedInputs.timing.phase = "waiting";
  migratedLine.workReservedInputs.timing.elapsedQd = 3;
  migratedLine.workProgressUnits = migratedLine.workQd * 10_000;
  const plan = planBuildingCatalogMigration({ currentData: migration, operationId: "timing-preview", replaceCatalog: true });
  assert.equal(plan.canApply, true, "Unchanged mechanics carry an in-progress waiting batch in migration preview");
  assert.deepEqual(plan.targetData.holdings[0].buildings.list[0].productionLines[0].workReservedInputs, migratedLine.workReservedInputs);
  migratedLine.workReservedInputs.timing.elapsedQd = -1;
  assert.equal(planBuildingCatalogMigration({ currentData: migration, operationId: "invalid", replaceCatalog: true }).canApply, false);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkProductionTime();
  console.log("Production timing: saved progress, funded inputs, labor + waiting, pause, one-shot, expiry, cancellation and migration preview passed.");
}
