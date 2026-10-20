import assert from "node:assert/strict";
import { checkProductionCapacityCatalog } from "./production-capacity-catalog-check.mjs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { productionFixture as fixture, productionDependencies as dependencies, advanceProduction as advance,
  productionQuantity as quantity, productionStorage as storage } from "./production-time-check.mjs";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { productionOccupiedQty } from "../engines/economy/production-capacity.js";
import { cancelProductionBatch } from "../engines/economy/production-cancellation.js";
import { productionLineEconomics } from "../engines/economy/production-economics.js";
import { executeProductionOperation } from "../apps/production-operation-executor.js";
import { migrationCycleFixture } from "./building-catalog-cycle-migration-check.mjs";
import { planBuildingCatalogMigration } from "../workflows/buildings/catalog-migration.js";
import { createProductionTiming } from "../engines/economy/production-timing.js";

const lineOf = (h) => h.buildings.list[0].productionLines[0];
const addRaw = (h, qty) => storage._storageAdd(h, { resourceId: "wood", name: "Древесина", roomId: "outdoors" }, qty);
const adapters = { addMoney: (h, n) => storage._addMoney(h, n), addResource: (h, row, n) => storage._restoreProductionResource(h, row, n) };
const config = { source: "time", period: "qd", workQd: 8, outputQty: 10, expenses: "wood 1", expenseMode: "unit", batchCapacity: 10, batchStartQty: 3 };

export async function checkProductionCapacity() {
  let h = fixture(config, { resourceId: "wood", qty: 2 });
  await advance(h, 4);
  assert.equal(quantity(h, "wood"), 2);
  assert.equal(lineOf(h).waitingBatches?.length ?? 0, 0, "Below threshold: no inputs, labor or places are consumed");
  addRaw(h, 3);
  await advance(h, 1);
  assert.equal(lineOf(h).waitingBatches.length, 1);
  assert.equal(lineOf(h).waitingBatches[0].workReservedOutputQty, 5, "Load available volume above minimum, not just the threshold");
  assert.equal(quantity(h, "wood"), 0);
  addRaw(h, 3);
  await advance(h, 1);
  assert.deepEqual(lineOf(h).waitingBatches.map((b) => b.workReservedInputs.timing.elapsedQd), [2, 1]);
  assert.equal(productionOccupiedQty(lineOf(h)), 8);
  addRaw(h, 100);
  await advance(h, 1);
  assert.equal(lineOf(h).waitingBatches.length, 2, "Two free places cannot start a three-unit minimum batch");
  const firstId = lineOf(h).waitingBatches[0].id;
  h = mergeHoldingDefaults(JSON.parse(JSON.stringify(h)));
  assert.equal(lineOf(h).waitingBatches[0].id, firstId, "Queue and IDs survive reload");
  lineOf(h).repeat = false;
  await advance(h, 5);
  assert.equal(quantity(h, "stone"), 5, "Oldest batch releases first, not the whole queue together");
  assert.equal(lineOf(h).waitingBatches.length, 1);
  assert.equal(lineOf(h).active, true, "One-shot drain must not freeze later batches");
  await advance(h, 1);
  assert.equal(quantity(h, "stone"), 8);
  assert.equal(lineOf(h).active, false);
  assert.equal(quantity(h, "wood"), 100, "Repeat disabled prevents new reservations during drain");

  const labor = fixture({ ...config, source: "workers", workQd: 10, waitDays: 2, batchCapacity: 30 }, { resourceId: "wood", qty: 5 });
  const work = dependencies();
  await advance(labor, 2, work);
  assert.equal(lineOf(labor).workReservedOutputQty, 5);
  assert.equal(lineOf(labor).workReservedInputs.timing.workTargetUnits, 50_000, "Half load takes half of the recipe labor");
  assert.equal(lineOf(labor).workProgressUnits, 20_000);
  await advance(labor, 3, work);
  assert.equal(lineOf(labor).waitingBatches[0].workReservedInputs.timing.elapsedQd, 0);
  assert.equal(work.budget.spent, 5);
  addRaw(labor, 3);
  await advance(labor, 3, work);
  assert.equal(lineOf(labor).waitingBatches.length, 2, "Second batch can be prepared while the first matures");
  assert.equal(work.budget.spent, 8);
  assert.equal(lineOf(labor).waitingBatches[0].workReservedInputs.timing.waitQd, 8, "Partial load does not shorten maturation");
  labor.people.list = [];
  lineOf(labor).repeat = false;
  await advance(labor, 5, work);
  assert.equal(quantity(labor, "stone"), 5);
  await advance(labor, 3, work);
  assert.equal(quantity(labor, "stone"), 8);
  assert.equal(work.budget.spent, 8, "Maturation does not spend worker QD");

  const fixed = fixture({ ...config, expenses: "wood 10", expenseMode: "cycle", fixedExpenses: "wood 2", repeat: false }, { resourceId: "wood", qty: 7 });
  await advance(fixed, 1);
  assert.equal(lineOf(fixed).waitingBatches[0].workReservedOutputQty, 5, "Availability quote combines proportional and fixed costs sharing a stock");
  assert.equal(quantity(fixed, "wood"), 0);
  const cancelId = lineOf(fixed).waitingBatches[0].id;
  await advance(fixed, 2);
  const cancelled = cancelProductionBatch(fixed, lineOf(fixed), { ...adapters, batchId: cancelId });
  assert.equal(cancelled.ok, true);
  assert.equal(quantity(fixed, "wood"), 7);
  assert.ok(fixed.storage.resources.filter((row) => row.resourceId === "wood").flatMap((row) => row.batches).every((batch) => batch.ageQd === 3), "Queued raw receipts age before cancellation");
  assert.equal(cancelProductionBatch(fixed, lineOf(fixed), { ...adapters, batchId: cancelId }).ok, false, "A removed ID cannot refund again");

  const economics = productionLineEconomics({ source: "workers", outputQty: 10, workQd: 10, batchCapacity: 20,
    expenses: "wood 10", fixedExpenses: "wood 2", resourceId: "stone" }, { wageDailyCopper: 18 }, { batchQty: 5 });
  assert.equal(economics.qty, 5);
  assert.equal(economics.labor, 45);
  assert.equal(economics.inputMin, productionLineEconomics({ outputQty: 1, resourceId: "stone", expenses: "wood 7" }).inputMin);

  const pending = fixture({ ...config, workQd: 2, requiresCollection: true, batchStartQty: 1 }, { resourceId: "wood", qty: 100 });
  await advance(pending, 5);
  assert.equal(lineOf(pending).pendingQty, 10);
  assert.equal(quantity(pending, "wood"), 90, "Uncollected output still occupies production capacity");
  assert.equal(productionOccupiedQty(lineOf(pending)), 10);

  const resized = fixture(config, { resourceId: "wood", qty: 5 });
  await advance(resized, 1);
  Object.assign(lineOf(resized), { batchCapacity: 2, batchStartQty: 1, workQd: 999, outputQty: 999 });
  addRaw(resized, 100);
  await advance(resized, 7);
  assert.equal(quantity(resized, "stone"), 5, "Shrinking capacity or changing recipe preserves already funded batches");
  assert.equal(quantity(resized, "wood"), 100);

  const paused = fixture(config, { resourceId: "wood", qty: 5 });
  await advance(paused, 1);
  lineOf(paused).active = false;
  await advance(paused, 4);
  assert.equal(lineOf(paused).waitingBatches[0].workReservedInputs.timing.elapsedQd, 1);
  lineOf(paused).active = true;
  await advance(paused, 1, { ...dependencies(), lineFinanceAllowed: () => false });
  assert.equal(lineOf(paused).waitingBatches[0].workReservedInputs.timing.elapsedQd, 1);

  checkProductionCapacityCatalog();
  await checkQueueBoundaries();
  await checkQueueAuthority();
}

async function checkQueueBoundaries() {
  const split = fixture({ ...config, outputQty: 3, batchCapacity: 15 }, { resourceId: "wood", qty: 60 });
  const whole = structuredClone(split);
  await advance(split, 5);
  const loaded = mergeHoldingDefaults(JSON.parse(JSON.stringify(split)));
  await advance(loaded, 17);
  await advance(whole, 22);
  for (const id of ["wood", "stone"]) assert.equal(quantity(loaded, id), quantity(whole, id), `Split-period ${id}`);
  const clocks = (h) => lineOf(h).waitingBatches.map((b) => [b.workReservedOutputQty, b.workReservedInputs.openedAtQd,
    b.workReservedInputs.timing.elapsedQd, b.workReservedInputs.entries.flatMap((e) => e.batches ?? []).map((raw) => raw.ageQd)]);
  assert.deepEqual(clocks(loaded), clocks(whole), "Queue age and progress are independent of period boundaries and reloads");

  const food = fixture({ ...config, resourceId: "aged-cheese", workQd: 160, expenses: "milk 1" }, { resourceId: "milk", qty: 3 });
  await advance(food, 1);
  storage._storageAdd(food, { resourceId: "milk", roomId: "outdoors" }, 3);
  await advance(food, 1);
  const [old, young] = lineOf(food).waitingBatches;
  old.workReservedInputs.processingShelfLifeQd = 3;
  lineOf(food).active = false;
  await advance(food, 3);
  assert.deepEqual(lineOf(food).waitingBatches.map((b) => b.id), [young.id], "Paused food batches expire individually");
  assert.equal(quantity(food, "aged-cheese"), 0);
  assert.equal(cancelProductionBatch(food, lineOf(food), { ...adapters, batchId: young.id }).ok, true);
  assert.equal(quantity(food, "milk"), 3, "Still-fresh aged ingredients can be returned");
  assert.ok(food.storage.resources.filter((r) => r.resourceId === "milk").flatMap((r) => r.batches).every((b) => b.ageQd === 4));

  const malformed = fixture({ ...config, outputQty: 3, batchCapacity: 15 }, { resourceId: "wood", qty: 9 });
  await advance(malformed, 2);
  delete lineOf(malformed).waitingBatches[1].workReservedInputs;
  const before = structuredClone(malformed);
  assert.equal(cancelProductionBatch(malformed, lineOf(malformed), adapters).ok, false);
  assert.deepEqual(malformed, before, "Cancel-all validates every receipt before refunding or removing any batch");

  const data = migrationCycleFixture();
  const line = lineOf(data.holdings[0]);
  const timing = createProductionTiming({ ...line, waitDays: 2 }, line.resourceId, line.resource);
  timing.phase = "waiting";
  const batch = { id: "queue-migration", workInputsReserved: true, workProgressUnits: timing.workTargetUnits,
    workReservedOutputQty: 1, workReservedInputs: { version: 1, entries: [], batchId: "queue-migration", timing } };
  line.waitingBatches = [batch];
  const args = { currentData: data, operationId: "queue-carry", replaceCatalog: true };
  const plan = planBuildingCatalogMigration(args);
  assert.equal(plan.canApply, true);
  assert.deepEqual(lineOf(plan.targetData.holdings[0]).waitingBatches, [batch]);
  line.waitingBatches.push(structuredClone(batch));
  assert.equal(planBuildingCatalogMigration(args).canApply, false, "Duplicate batch IDs cannot be carried or refunded ambiguously");
}

async function checkQueueAuthority() {
  const previousGame = globalThis.game;
  globalThis.game = { user: { id: "gm", isGM: true } };
  try {
    const original = fixture(config, { resourceId: "wood", qty: 3 });
    await advance(original, 1);
    addRaw(original, 3);
    await advance(original, 1);
    original.gm.playersCanEditBuildings = true;
    let data = { meta: { revision: 5 }, holdings: [original] };
    const skipped = Symbol("skip");
    const deps = { getUser: (id) => ({ id, isGM: id === "gm" }), logic: storage, now: () => new Date("2026-10-13T00:00:00Z"),
      skipTransaction: (value) => ({ [skipped]: value }),
      updateHolding: async (id, change) => {
        const draft = structuredClone(data);
        const result = change(draft.holdings.find((holding) => holding.id === id), draft);
        if (result?.[skipped]) return result[skipped];
        draft.meta.revision++;
        data = draft;
        return result;
      } };
    const command = { type: "cancelProductionBatch", operationId: "cancel-one", expectedRevision: 5,
      holdingId: original.id, buildingId: original.buildings.list[0].id, lineId: lineOf(original).id,
      batchId: lineOf(original).waitingBatches[0].id };
    assert.equal((await executeProductionOperation(command, { userId: "player", remote: true }, deps)).ok, true);
    assert.equal(lineOf(data.holdings[0]).waitingBatches.length, 1);
    assert.equal(lineOf(data.holdings[0]).active, true, "Cancel one does not pause other batches");
    assert.equal(quantity(data.holdings[0], "wood"), 3);
    assert.equal((await executeProductionOperation(command, { userId: "player", remote: true }, deps)).replay, true);
    assert.equal(quantity(data.holdings[0], "wood"), 3);
    await assert.rejects(executeProductionOperation({ ...command, batchId: lineOf(data.holdings[0]).waitingBatches[0].id }, { userId: "player", remote: true }, deps), /ID операции/);
    await assert.rejects(executeProductionOperation({ ...command, operationId: "stale" }, { userId: "player", remote: true }, deps), /Данные изменились/);
    data.holdings[0].gm.playersCanEditBuildings = false;
    await assert.rejects(executeProductionOperation({ ...command, operationId: "forbidden", expectedRevision: 6 }, { userId: "player", remote: true }, deps), /Нет права/);
    const deleteCommand = { ...command, operationId: "delete-all", type: "deleteProductionLine", expectedRevision: 6 };
    delete deleteCommand.batchId;
    assert.equal((await executeProductionOperation(deleteCommand, { userId: "gm", remote: false }, deps)).ok, true);
    assert.equal(data.holdings[0].buildings.list[0].productionLines.length, 0);
    assert.equal(quantity(data.holdings[0], "wood"), 6, "Deletion returns all remaining receipts once");
    globalThis.game.user.isGM = false;
    await assert.rejects(executeProductionOperation(deleteCommand, { userId: "player", remote: false }, deps), /authority/);
  } finally { globalThis.game = previousGame; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkProductionCapacity();
  console.log("Production capacity: thresholds, proportional loads, separate clocks, occupancy, receipts, reload, cancellation and GM/player authority passed.");
}
