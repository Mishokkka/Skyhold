import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FinanceDomain } from "../apps/domains/finance-domain.js";
import {
  productionFixture,
  productionDependencies,
  advanceProduction,
  productionQuantity,
  productionStorage
} from "./production-time-check.mjs";

function collectionHost(entries) {
  return {
    ...FinanceDomain,
    _safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    _assignedBuildingPeople: () => entries.map((_entry, index) => ({ id: `worker-${index}`, index })),
    _workerBudgetEntriesForBuilding: (person) => [entries[person.index]],
    _buildingStatus: () => ({ value: "built" }),
    _financeFunctionAllowed: () => true,
    _normalizeStorageRoomId: () => "outdoors",
    _storageAddWithOverflow: (holding, resource, qty) => {
      productionStorage._storageAdd(holding, resource, qty);
      return [{ qty }];
    },
    _pushProductionPlacement: () => {}
  };
}

function consumerFixture({ rawQty = 0, collectQd = 1, efficiency = 1 } = {}) {
  const holding = productionFixture(
    { source: "workers", workQd: 1, outputQty: 3, expenses: "wood 2" },
    { resourceId: "wood", qty: rawQty }
  );
  const sourceLine = {
    id: "wood-pending", active: false, resourceId: "wood", pendingQty: 2,
    requiresCollection: true, collectQd, autoCollect: "worker"
  };
  holding.buildings.list.push({ id: "supplier", productionLines: [sourceLine] });
  const dependencies = productionDependencies();
  dependencies.personBuildingEfficiency = () => efficiency;
  const host = collectionHost([dependencies.budget]);
  dependencies.tryCollectResourceForConsumer = (...args) => host._tryCollectResourceForConsumer(...args);
  return { holding, dependencies, sourceLine };
}

export async function checkProductionWorkerBudgets() {
  const entries = [{ available: 1, spent: 0 }, { available: 0.5, spent: 0 }];
  const host = collectionHost(entries);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.deepEqual(host._spendBuildingWorkerQd({}, {}, new Map(), 2), { ok: false, spent: 0 });
    assert.deepEqual(entries, [{ available: 1, spent: 0 }, { available: 0.5, spent: 0 }],
      "Repeated incomplete collection must leave every worker's QD untouched");
  }
  entries[1].available = 1;
  assert.deepEqual(host._spendBuildingWorkerQd({}, {}, new Map(), 2), { ok: true, spent: 2 });
  assert.deepEqual(entries, [{ available: 0, spent: 1 }, { available: 0, spent: 1 }],
    "A complete collection can use several allowed workers exactly once");
  assert.deepEqual(host._spendBuildingWorkerQd({}, {}, new Map(), 0), { ok: true, spent: 0 });

  const collectionHolding = productionFixture();
  const collectionLine = {
    id: "pending", resourceId: "stone", pendingQty: 2, collectQd: 2
  };
  const collectionBuilding = { id: "collection", productionLines: [collectionLine] };
  const budget = { available: 1, spent: 0 };
  const collector = collectionHost([budget]);
  const report = { skipped: [] };
  assert.equal(await collector._collectLineToStorage(
    collectionHolding, collectionBuilding, collectionLine, new Map(), report
  ), 0);
  assert.equal(collectionLine.pendingQty, 2);
  assert.deepEqual(budget, { available: 1, spent: 0 });
  budget.available += 1;
  assert.equal(await collector._collectLineToStorage(
    collectionHolding, collectionBuilding, collectionLine, new Map(), report
  ), 2);
  assert.equal(collectionLine.pendingQty, 0);
  assert.equal(productionQuantity(collectionHolding, "stone"), 2);
  assert.deepEqual(budget, { available: 0, spent: 2 });
  assert.equal(await collector._collectLineToStorage(
    collectionHolding, collectionBuilding, collectionLine, new Map(), report
  ), 0);
  assert.deepEqual(budget, { available: 0, spent: 2 }, "Repeated collection cannot charge again");

  const fetched = consumerFixture();
  await advanceProduction(fetched.holding, 1, fetched.dependencies);
  assert.equal(productionQuantity(fetched.holding, "stone"), 0,
    "The QD spent fetching ingredients cannot also produce the goods");
  assert.equal(fetched.sourceLine.pendingQty, 0);
  assert.deepEqual(fetched.dependencies.budget, { available: 0, spent: 1 });
  const funded = fetched.holding.buildings.list[0].productionLines[0];
  assert.equal(funded.workInputsReserved, true);
  assert.equal(funded.workProgressUnits, 0, "A funded batch waits for its own production QD");
  const batchId = funded.workReservedInputs.batchId;
  assert.ok(batchId);
  await advanceProduction(fetched.holding, 1, fetched.dependencies);
  assert.equal(productionQuantity(fetched.holding, "stone"), 3);
  assert.equal(productionQuantity(fetched.holding, "wood"), 0, "Reserved ingredients are not paid twice");
  assert.deepEqual(fetched.dependencies.budget, { available: 0, spent: 2 });

  const efficient = consumerFixture({ rawQty: 2, efficiency: 2 });
  await advanceProduction(efficient.holding, 1, efficient.dependencies);
  assert.equal(productionQuantity(efficient.holding, "stone"), 3,
    "Efficiency may accelerate work but cannot fund ingredient collection with the QD already spent");
  assert.equal(efficient.sourceLine.pendingQty, 2);
  assert.deepEqual(efficient.dependencies.budget, { available: 0, spent: 1 });
  await advanceProduction(efficient.holding, 1, efficient.dependencies);
  assert.equal(productionQuantity(efficient.holding, "stone"), 3);
  assert.equal(efficient.sourceLine.pendingQty, 0);
  assert.deepEqual(efficient.dependencies.budget, { available: 0, spent: 2 });
  await advanceProduction(efficient.holding, 1, efficient.dependencies);
  assert.equal(productionQuantity(efficient.holding, "stone"), 6);
  assert.deepEqual(efficient.dependencies.budget, { available: 0, spent: 3 });

  const freeCollection = consumerFixture({ collectQd: 0 });
  await advanceProduction(freeCollection.holding, 1, freeCollection.dependencies);
  assert.equal(productionQuantity(freeCollection.holding, "stone"), 3,
    "Collection with no labor cost still supplies production in the same QD");
  assert.deepEqual(freeCollection.dependencies.budget, { available: 0, spent: 1 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkProductionWorkerBudgets();
  console.log("Production worker budgets: atomic collection, retries, shared collection and no repeated QD spending passed.");
}
