import assert from "node:assert/strict";
import { buildingCatalogV16Templates } from "../data/building-template-revision-v16.js";
import { normalizeSkyholdData } from "../data/normalizers.js";
import { clone } from "../data/utils.js";
import { PRODUCTION_STATE_FIELDS } from "../workflows/buildings/catalog-conflicts.js";
import { applyBuildingCatalogMigration, planBuildingCatalogMigration } from "../workflows/buildings/catalog-migration.js";
import { runProductionCycle } from "../engines/economy/production-cycle.js";

export function migrationCycleFixture() {
  const templates = buildingCatalogV16Templates();
  const data = normalizeSkyholdData({ meta: { templateCatalogVersion: 16, revision: 3 },
    catalog: { buildings: clone(templates) }, holdings: [{ id: "laputa", name: "Лапута", people: { list: [] },
      storage: { moneyCopper: 73 }, buildings: { list: templates.filter(row => ["lumbermill", "quarry"].includes(row.id))
        .map(row => ({ ...clone(row), id: `built-${row.id}`, templateId: row.id, constructionStatus: "built", buildProgress: row.buildTarget })) } }] });
  for (const building of data.holdings[0].buildings.list) Object.assign(building.productionLines[0], {
    pendingQty: 3, workProgressUnits: 5000, workInputsReserved: true, workReservedOutputQty: 2,
    workReservedFormula: "2", workReservedInputs: { version: 1, entries: [] },
    productionBonusRemainder: { resourceId: building.productionLines[0].resourceId, name: building.productionLines[0].resource, units: 2500 }
  });
  return data;
}

export async function checkMigrationProductionCarry() {
  const source = migrationCycleFixture();
  const snapshot = clone(source);
  const args = { currentData: source, operationId: "carry-v16", replaceCatalog: true };
  const plan = planBuildingCatalogMigration(args);
  assert.deepEqual(plan.blockingIssues, [], "Unchanged wood and stone batches may migrate while partly worked");
  assert.equal(plan.canApply, true);
  assert.deepEqual(source, snapshot, "Preview remains read only");
  const applied = applyBuildingCatalogMigration({ currentData: source, plan });
  const loaded = normalizeSkyholdData(applied.data);
  for (const [i, building] of loaded.holdings[0].buildings.list.entries()) {
    for (const key of PRODUCTION_STATE_FIELDS) assert.deepEqual(building.productionLines[0][key], source.holdings[0].buildings.list[i].productionLines[0][key], key);
  }
  assert.equal(loaded.holdings[0].storage.moneyCopper, 73);
  assert.equal(planBuildingCatalogMigration({ ...args, currentData: loaded }).hasChanges, false, "A carried batch does not cause repeated migrations");
  assert.equal(applyBuildingCatalogMigration({ currentData: loaded, plan }).commitRequired, false);

  // Legacy reservations have no receipt; unchanged recipes can still finish them.
  const legacy = clone(source);
  delete legacy.holdings[0].buildings.list[0].productionLines[0].workReservedInputs;
  assert.equal(planBuildingCatalogMigration({ ...args, currentData: legacy }).canApply, true);
  // A receipt is runtime state, not a per-field mechanics customization.
  const receipt = clone(source);
  receipt.holdings[0].buildings.list[0].productionLines[0].workReservedInputs.entries.push({ resourceId: "wood", qty: 1, roomId: "outdoors", batches: [{ id: "paid-batch", qty: 1, ageQd: 40 }] });
  const receiptPlan = planBuildingCatalogMigration({ ...args, currentData: receipt, replaceCatalog: false });
  assert.deepEqual(receiptPlan.blockingIssues, []);
  assert.deepEqual(receiptPlan.targetData.holdings[0].buildings.list[0].productionLines[0].workReservedInputs, receipt.holdings[0].buildings.list[0].productionLines[0].workReservedInputs);

  for (const changes of [{ workQd: 2 }, { expenses: "wood 1" }, { outputQty: 5 }, { resourceId: "iron" },
    { source: "time" }, { workInputsReserved: false }, { workReservedOutputQty: 0 }, { workProgressUnits: 10000 },
    { workReservedInputs: { version: 2, entries: [] } }]) {
    const unsafe = clone(source);
    Object.assign(unsafe.holdings[0].buildings.list[0].productionLines[0], changes);
    const blocked = planBuildingCatalogMigration({ ...args, currentData: unsafe });
    assert.equal(blocked.canApply, false, JSON.stringify(changes));
    assert.ok(blocked.blockingIssues.some(row => row.code === "production-in-progress" && row.holdingId === "laputa" && row.holdingName === "Лапута"));
    assert.throws(() => applyBuildingCatalogMigration({ currentData: unsafe, plan: { ...blocked, canApply: true } }), error => error.code === "plan-blocked");
  }
  const unmapped = clone(source);
  unmapped.holdings[0].buildings.list[0].productionLines.push({ id: "removed-line", resourceId: "iron", pendingQty: 4 });
  assert.ok(planBuildingCatalogMigration({ ...args, currentData: unmapped }).blockingIssues.some(row => row.code === "unmatched-pending-output"));
  const changedOutput = clone(source);
  changedOutput.holdings[0].buildings.list[0].productionLines[0] = { id: "line", resourceId: "iron", pendingQty: 4 };
  const changedOutputPlan = planBuildingCatalogMigration({ ...args, currentData: changedOutput });
  assert.ok(changedOutputPlan.blockingIssues.some(row => row.code === "unmatched-pending-output"), "A reused line ID cannot turn finished iron into wood");
  assert.equal(changedOutputPlan.targetData.holdings[0].buildings.list[0].productionLines[0].pendingQty, 0);

  const duplicates = clone(source);
  const other = clone(duplicates.holdings[0]);
  other.id = "other"; other.name = "Другой остров";
  other.buildings.list[0].productionLines[0].workQd = 2;
  duplicates.holdings.push(other);
  duplicates.holdings[0].buildings.list = [];
  const otherPlan = planBuildingCatalogMigration({ ...args, currentData: duplicates });
  assert.deepEqual(otherPlan.blockingIssues.map(row => row.holdingName), ["Другой остров"], "Removed Laputa buildings do not leak into a fresh preview; another holding is identified");

  await finishCarriedBatch(loaded.holdings[0]);
}

async function finishCarriedBatch(holding) {
  // Half a QD of effective labor completes exactly the half-finished wood batch.
  const building = holding.buildings.list[0], line = building.productionLines[0];
  const placements = [];
  const noop = () => {};
  const unexpected = () => { assert.fail("Carried input/output reservations must not be recomputed or charged again"); };
  const dependencies = {
    safeNumber: (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback,
    resetWorkerBudgets: noop, accrueWorkerBudgets: noop, getSeasonSnapshot: () => null,
    buildingStatus: () => ({ value: "built" }), buildingFunctions: () => ({ production: true }),
    lineSeasonAllowed: () => true, periodDueOnStep: () => true, normalizeResourceId: id => id, resourceLabel: id => id,
    lineContentQuantity: () => 1, buildingEffectiveWorkers: () => ({ total: 1, assigned: 1 }), lineOutputForCycle: unexpected,
    parseResourceCosts: unexpected, costsForUnits: unexpected, scaledCosts: unexpected, storageCanPay: unexpected, storagePay: unexpected,
    normalizeStorageRoomId: id => id, storageAddWithOverflow: (_h, resource, qty) => { placements.push({ resourceId: resource.resourceId, qty }); return []; },
    pushProductionPlacement: noop, autoCollectBuilding: noop, assignedBuildingPeople: () => [{ id: "worker" }],
    minimumStaffStatus: () => ({ met: true }), workerBudgetEntry: () => ({ available: 1, spent: 0 }),
    personBuildingEfficiency: () => 0.5, buildingCompositionStatus: () => ({ met: true }), storageQuantity: () => 0,
    tryCollectResourceForConsumer: noop, formatNumber: String
  };
  await runProductionCycle({ holding, buildings: [building], qd: 1, dependencies,
    report: { produced: [], consumed: [], skipped: [], formulas: [], work: [] } });
  assert.deepEqual(placements, [{ resourceId: "wood", qty: 2 }]);
  assert.equal(line.pendingQty, 3, "Previously collected-ready output is not duplicated");
  assert.equal(line.workProgressUnits, 0);
  assert.equal(line.workInputsReserved, false);
  assert.equal(line.workReservedInputs, undefined);
}
