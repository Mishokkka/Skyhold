import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { clone } from "../data/utils.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { FinanceDomain } from "../apps/domains/finance-domain.js";
import { runProductionCycle } from "../engines/economy/production-cycle.js";
import { refundProductionInputs } from "../engines/economy/production-inputs.js";
import { politicsProductionOutcome, setPoliticsRuntimeEffects } from "../engines/politics/runtime-effects.js";
import { addResourceBatches, beginResourceBatchPeriod, finishResourceBatchPeriod } from "../core/resource-batches.js";
import { applyPreparedTenday } from "../apps/domains/events/tenday-preview.js";
import { stableDataHash } from "../data/storage-commit.js";
import { cancelProductionBatch } from "../engines/economy/production-cancellation.js";
import { createConstructionOperationExecutor } from "../apps/construction-operation-executor.js";

const storage = { ...FinanceDomain, _safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback };
const quantity = (holding, resourceId) => holding.storage.resources.filter((row) => row.resourceId === resourceId).reduce((sum, row) => sum + row.qty, 0);
const report = () => ({ produced: [], consumed: [], skipped: [], formulas: [], work: [], ledger: [] });

function fixture({ source = "time", qty = 1, workQd = 1 } = {}) {
  return mergeHoldingDefaults({ id: "production-politics", storage: { moneyCopper: 100, resources: [
    { id: "raw", resourceId: "wood", name: "Дерево", roomId: "outdoors", qty: 100,
      notes: "original metadata", batches: [{ id: "old-wood", qty: 100, ageQd: 10 }] }
  ] }, people: { list: [{ id: "worker" }] }, buildings: { list: [{ id: "mill", name: "Мастерская",
    lifecycle: "active", functions: { production: true }, productionLines: [{ id: "line", source, period: "qd", active: true,
      resourceId: "stone", outputQty: qty, workQd, expenseMode: "unit", expenses: "wood", requiresCollection: false }] }] } });
}

function dependencies(rolls = []) {
  let randomCalls = 0;
  const noop = () => {};
  const result = {
    safeNumber: storage._safeNumber, resetWorkerBudgets: noop, accrueWorkerBudgets: noop,
    getSeasonSnapshot: () => null, buildingStatus: () => ({ value: "built" }), buildingFunctions: () => ({ production: true }),
    lineSeasonAllowed: () => true, periodDueOnStep: () => true, normalizeResourceId: (id) => id, resourceLabel: (id) => id,
    lineContentQuantity: () => 1, buildingEffectiveWorkers: () => ({ total: 1, assigned: 1 }),
    lineOutputForCycle: async (line) => ({ qty: line.outputQty, formula: "" }),
    parseResourceCosts: (text) => [{ resourceId: text === "changed" ? "iron" : "wood", name: "Сырьё", qty: 2 }, { resourceId: "money", name: "Деньги", qty: 1 }],
    costsForUnits: (costs, units) => costs.map((cost) => ({ ...cost, qty: cost.qty * units })),
    scaledCosts: (costs, cycles) => costs.map((cost) => ({ ...cost, qty: cost.qty * cycles })),
    storageCanPay: (holding, costs) => storage._storageCanPay(holding, costs),
    storagePay: (holding, costs) => storage._storagePay(holding, costs, { captureReceipt: true }),
    refundProductionInputs: (holding, receipt, lost, qty) => refundProductionInputs(holding, receipt, lost, qty, {
      addMoney: (draft, amount) => storage._addMoney(draft, amount),
      addResource: (draft, resource, amount) => storage._restoreProductionResource(draft, resource, amount)
    }),
    normalizeStorageRoomId: (id) => id || "outdoors",
    storageAddWithOverflow: (holding, resource, amount) => { storage._storageAdd(holding, resource, amount); return [{ qty: amount }]; },
    pushProductionPlacement: (r, h, building, resource, placements) => r.produced.push(`${building}: ${placements.reduce((sum, row) => sum + row.qty, 0)}`),
    autoCollectBuilding: noop, assignedBuildingPeople: (holding) => holding.people.list,
    workerBudgetEntry: () => ({ available: 1, spent: 0 }), personBuildingEfficiency: () => 1,
    buildingCompositionStatus: () => ({ met: true }), storageQuantity: (holding, cost) => storage._storageQuantity(holding, cost),
    tryCollectResourceForConsumer: noop, formatNumber: String,
    appendLedger: (r, rows) => r.ledger.push(...(Array.isArray(rows) ? rows : [rows])),
    random: () => { randomCalls += 1; assert.ok(rolls.length, "unexpected completion roll"); return rolls.shift(); },
    randomCalls: () => randomCalls
  };
  return result;
}

export async function checkPoliticsProduction() {
  let called = 0;
  assert.deepEqual(politicsProductionOutcome(20, -5, () => { called += 1; return 0; }), { total: 19, lost: 1, probabilistic: false });
  assert.equal(called, 0, "whole penalties do not use random completion loss");
  assert.equal(politicsProductionOutcome(1, -5, () => 0.05).total, 1);
  assert.equal(politicsProductionOutcome(1, -5, () => 0.049).total, 0);
  assert.throws(() => politicsProductionOutcome(1, -5, () => 1), RangeError);
  assert.equal(politicsProductionOutcome(20, 5).total, 21);

  for (const source of ["time", "content", "workers"]) {
    for (const failed of [true, false]) {
      const h = fixture({ source });
      const deps = dependencies([failed ? 0 : 0.99]);
      const r = report();
      setPoliticsRuntimeEffects(h, { productionPercent: -5 });
      await runProductionCycle({ holding: h, qd: 1, report: r, dependencies: deps });
      assert.equal(quantity(h, "stone"), failed ? 0 : 1, `${source}: the small penalty must not always erase one-unit output`);
      assert.equal(quantity(h, "wood"), failed ? 100 : 98, `${source}: failed output returns its exact raw materials`);
      assert.equal(h.storage.moneyCopper, failed ? 100 : 99);
      assert.equal(deps.randomCalls(), 1);
      if (source === "workers") assert.match(r.work.join(" "), /1 QD/, "a failed batch still consumes its work");
      assert.equal(clone(h).buildings.list[0].productionLines[0].workReservedInputs, undefined, "a completed receipt cannot refund twice");
    }
  }

  const partial = fixture({ qty: 3 });
  const sourceSnapshot = clone(partial);
  const partialDeps = dependencies([0, 0.99, 0.99]);
  setPoliticsRuntimeEffects(partial, { productionPercent: -5 });
  await runProductionCycle({ holding: partial, qd: 1, report: report(), dependencies: partialDeps });
  assert.equal(quantity(partial, "stone"), 2);
  assert.equal(quantity(partial, "wood"), 96);
  assert.equal(partial.storage.moneyCopper, 98, "partial refunds match the produced unit count");
  const target = clone(sourceSnapshot);
  const originalRandom = Math.random;
  try {
    Math.random = () => { throw new Error("Apply must not reroll production."); };
    const applied = applyPreparedTenday(target, clone(partial), stableDataHash(sourceSnapshot), { hash: stableDataHash, clone });
    assert.equal(applied.ok, true);
    assert.equal(quantity(target, "stone"), 2, "Apply preserves the prepared stochastic result");
    assert.equal(quantity(target, "wood"), 96);
  } finally { Math.random = originalRandom; }
  assert.equal(partialDeps.randomCalls(), 3, "one roll per completed unit, none on Apply");
  const deterministic = fixture({ qty: 20 });
  setPoliticsRuntimeEffects(deterministic, { productionPercent: -5 });
  await runProductionCycle({ holding: deterministic, qd: 1, report: report(), dependencies: dependencies() });
  assert.equal(quantity(deterministic, "stone"), 19);
  assert.equal(quantity(deterministic, "wood"), 62);

  let carried = fixture({ source: "workers", workQd: 2 });
  beginResourceBatchPeriod(carried);
  setPoliticsRuntimeEffects(carried, { productionPercent: -5 });
  const firstDeps = dependencies();
  await runProductionCycle({ holding: carried, qd: 1, report: report(), dependencies: firstDeps });
  assert.equal(firstDeps.randomCalls(), 0, "no political roll before the batch is complete");
  finishResourceBatchPeriod(carried, { elapsedQd: 40 });
  assert.equal(carried.buildings.list[0].productionLines[0].workReservedInputs.entries[0].batches[0].ageQd, 50);
  carried.gm.calendaria.lastQd = 40;
  carried = mergeHoldingDefaults(clone(carried));
  carried.buildings.list[0].productionLines[0].expenses = "changed";
  // An empty original row can be removed while the funded batch is in progress.
  carried.storage.resources = [];
  beginResourceBatchPeriod(carried);
  setPoliticsRuntimeEffects(carried, { productionPercent: -5 });
  await runProductionCycle({ holding: carried, qd: 1, report: report(), dependencies: dependencies([0]) });
  finishResourceBatchPeriod(carried, { elapsedQd: 40 });
  assert.equal(quantity(carried, "wood"), 2, "the edited recipe cannot manufacture a different refund");
  assert.equal(quantity(carried, "iron"), 0);
  assert.equal(carried.storage.resources[0].notes, "original metadata");
  assert.equal(carried.storage.resources[0].batches[0].ageQd, 90, "reserved raw materials age once per elapsed period");
  assert.equal(carried.storage.moneyCopper, 100);
  const protectedInput = fixture({ source: "workers", workQd: 2 });
  protectedInput.storage.resources[0].qty = 2;
  protectedInput.storage.resources[0].batches = [{ id: "batch-wood-outdoors-1", qty: 2, ageQd: 10 }];
  await runProductionCycle({ holding: protectedInput, qd: 1, report: report(), dependencies: dependencies() });
  addResourceBatches(protectedInput.storage.resources[0], { qty: 1 }, { holding: protectedInput });
  assert.notEqual(protectedInput.storage.resources[0].batches[0].id, "batch-wood-outdoors-1", "held receipt IDs cannot be reused for newly added inventory");
  assert.equal(storage._storageQuantity(protectedInput, { resourceId: "wood" }), 1, "held inputs are not subtracted from available stock a second time");

  const perishable = fixture({ source: "workers", workQd: 2 });
  const perishDeps = dependencies([0]);
  beginResourceBatchPeriod(perishable);
  setPoliticsRuntimeEffects(perishable, { productionPercent: -5 });
  await runProductionCycle({ holding: perishable, qd: 1, report: report(), dependencies: perishDeps });
  finishResourceBatchPeriod(perishable, { elapsedQd: 40, shelfLifeQdForRow: () => 60 });
  beginResourceBatchPeriod(perishable);
  await runProductionCycle({ holding: perishable, qd: 1, report: report(), dependencies: perishDeps });
  const expired = finishResourceBatchPeriod(perishable, { elapsedQd: 40, shelfLifeQdForRow: () => 60 });
  assert.equal(quantity(perishable, "wood"), 0);
  assert.equal(expired.expiredQty, 100, "refunds must not rejuvenate perishable input batches");

  const legacy = fixture({ source: "workers" });
  Object.assign(legacy.buildings.list[0].productionLines[0], { workInputsReserved: true, workReservedOutputQty: 1 });
  setPoliticsRuntimeEffects(legacy, { productionPercent: -5 });
  await runProductionCycle({ holding: legacy, qd: 1, report: report(), dependencies: dependencies() });
  assert.equal(quantity(legacy, "stone"), 0, "old funded batches retain the previous completion behavior");
  assert.equal(quantity(legacy, "wood"), 100, "legacy completion invents neither a refund nor a second payment");

  const future = fixture({ source: "workers" });
  Object.assign(future.buildings.list[0].productionLines[0], { workInputsReserved: true, workReservedOutputQty: 1, workReservedInputs: { version: 2, entries: [] } });
  await assert.rejects(runProductionCycle({ holding: future, qd: 1, report: report(), dependencies: dependencies() }), /Unsupported/);

  let positive = fixture();
  for (let index = 0; index < 20; index++) {
    setPoliticsRuntimeEffects(positive, { productionPercent: 5 });
    await runProductionCycle({ holding: positive, qd: 1, report: report(), dependencies: dependencies() });
    if (index === 9) positive = mergeHoldingDefaults(clone(positive));
  }
  assert.equal(quantity(positive, "stone"), 21, "twenty one-unit batches retain their earned +5% bonus across serialization");
  assert.equal(quantity(positive, "wood"), 60, "bonus carry does not reserve a second input batch");
  assert.equal(positive.buildings.list[0].productionLines[0].productionBonusRemainder.units, 0);
  const different = fixture();
  different.buildings.list[0].productionLines[0].productionBonusRemainder = { resourceId: "iron", units: 9500 };
  setPoliticsRuntimeEffects(different, { productionPercent: 5 });
  await runProductionCycle({ holding: different, qd: 1, report: report(), dependencies: dependencies() });
  assert.equal(quantity(different, "stone"), 1, "changing resources cannot convert an old bonus into new goods");
  different.buildings.list[0].productionLines[0].productionBonusRemainder = { resourceId: "iron", units: 9500 };
  setPoliticsRuntimeEffects(different, { productionPercent: 0 });
  await runProductionCycle({ holding: different, qd: 1, report: report(), dependencies: dependencies() });
  assert.equal(different.buildings.list[0].productionLines[0].productionBonusRemainder, undefined,
    "completing a different product clears the old remainder even without a current bonus");

  const cancellation = fixture({ source: "workers", workQd: 2 });
  beginResourceBatchPeriod(cancellation);
  await runProductionCycle({ holding: cancellation, qd: 1, report: report(), dependencies: dependencies() });
  finishResourceBatchPeriod(cancellation, { elapsedQd: 40 });
  const line = cancellation.buildings.list[0].productionLines[0];
  line.expenses = "changed";
  const adapters = { addMoney: (draft, amount) => storage._addMoney(draft, amount), addResource: (draft, resource, amount) => storage._restoreProductionResource(draft, resource, amount) };
  assert.equal(cancelProductionBatch(cancellation, line, adapters).ok, true);
  assert.equal(quantity(cancellation, "wood"), 100);
  assert.equal(quantity(cancellation, "iron"), 0);
  assert.equal(cancellation.storage.moneyCopper, 100);
  assert.equal(line.workProgressUnits, 0);
  assert.equal(line.active, false);
  assert.equal(cancellation.storage.resources[0].batches.every((batch) => batch.ageQd === 50), true, "cancellation keeps input age");
  assert.equal(cancelProductionBatch(cancellation, line, adapters).noop, true, "a consumed receipt cannot refund twice");
  const legacyCancel = { workInputsReserved: true, workProgressUnits: 10, workReservedOutputQty: 1 };
  assert.equal(cancelProductionBatch(cancellation, legacyCancel, adapters).ok, false, "legacy input quantities are never guessed");

  const oldGame = globalThis.game;
  try {
    const gm = { id: "gm", isGM: true };
    const player = { id: "player", isGM: false };
    globalThis.game = { user: gm };
    let data = { meta: { revision: 1 }, holdings: [fixture({ source: "workers", workQd: 2 })] };
    data.holdings[0].gm.playersCanEditBuildings = true;
    await runProductionCycle({ holding: data.holdings[0], qd: 1, report: report(), dependencies: dependencies() });
    const execute = createConstructionOperationExecutor({ logic: storage, getUser: (id) => id === player.id ? player : id === gm.id ? gm : null,
      skipTransaction: (value) => ({ skip: true, value }), async updateHolding(id, updater) {
        const draft = clone(data);
        const result = updater(draft.holdings[0], draft);
        if (result?.skip) return result.value;
        draft.meta.revision++;
        data = draft;
        return result;
      } });
    const command = { type: "deleteProductionLine", operationId: "production-delete", expectedRevision: 1, holdingId: data.holdings[0].id,
      buildingId: data.holdings[0].buildings.list[0].id, lineId: data.holdings[0].buildings.list[0].productionLines[0].id };
    assert.equal((await execute(command, { userId: player.id, remote: true })).ok, true);
    assert.equal(quantity(data.holdings[0], "wood"), 100);
    assert.equal(data.holdings[0].buildings.list[0].productionLines.length, 0);
    assert.equal((await execute(command, { userId: player.id, remote: true })).replay, true);
    assert.equal(data.meta.revision, 2, "authority replay does not refund a deleted line twice");
    await assert.rejects(execute(command, { userId: gm.id }), /ID/);
    data.holdings[0].gm.playersCanEditBuildings = false;
    await assert.rejects(execute({ ...command, operationId: "revoked" }, { userId: player.id, remote: true }), /прав/);
    game.user = player;
    await assert.rejects(execute({ ...command, operationId: "local-player" }, { userId: player.id }), /authority/);
  } finally { if (oldGame === undefined) delete globalThis.game; else globalThis.game = oldGame; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkPoliticsProduction();
  console.log("Politics production F02: completion chance, input receipts, partial refunds, carryover and legacy behavior passed.");
}
