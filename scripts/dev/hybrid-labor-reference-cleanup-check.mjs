import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { deleteCollectionRow } from "../data/collection-operations.js";
import { clearPersonFromAssignments, transferResidentBetweenHoldings } from "../data/resident-assignments.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { workforceChangeError } from "../data/workforce-plan.js";
import { planHybridLaborMigration, applyHybridLaborMigration } from "../workflows/buildings/hybrid-labor-migration.js";
import { executeHybridLaborMigration } from "../apps/hybrid-labor-migration-executor.js";

const copy = (value) => structuredClone(value);
function fixture() {
  return { id: "source", visibility: "public", gm: { playersCanEditBuildings: true },
    people: { list: ["worker", "other", "hidden"].map((id) => ({ id, name: id, age: 30, ageGroup: "Вз",
      visibility: id === "hidden" ? "gm" : "public", workAssignment: "", workAllocationMode: "explicit",
      workAllocations: [{ schemaVersion: 1, id: `work-${id}`, sourceId: "mill", functionId: "production:logs", normalQd: 4, overtimeQd: 0 }] })) },
    buildings: { list: [{ id: "mill", name: "Mill", templateId: "lumbermill", lifecycle: "built", status: "built",
      constructionStatus: "built", condition: "normal", workersMax: 1, workersMin: 0, assignedWorkerIds: [], wageDailyCopper: 12,
      labor: { version: 1, mode: "qd", capacityQd: null }, functions: { production: true },
      productionLines: [{ id: "logs", source: "workers", active: true, workQd: 1, outputQty: 1, resourceId: "wood" }] }] },
    workforcePlan: { version: 2, goals: [{ sourceId: "mill", functionId: "production:logs", normalQd: 5 }],
      productionGoals: [{ sourceId: "mill", functionId: "production:logs", preparedUnits: 3 }],
      locks: ["worker", "other", "hidden"].map((personId) => ({ personId, sourceId: "mill", functionId: "production:logs" })) } };
}

function assertRemainingPlan(holding, original) {
  assert.deepEqual(holding.workforcePlan.locks, original.workforcePlan.locks.filter((row) => row.personId !== "worker"),
    "remove only the departed resident's locks, including when another resident is hidden");
  assert.deepEqual(holding.workforcePlan.goals, original.workforcePlan.goals, "labor goals belong to the building");
  assert.deepEqual(holding.workforcePlan.productionGoals, original.workforcePlan.productionGoals, "preparation goals survive resident removal");
}

export async function checkHybridLaborReferenceCleanup() {
  const previousFoundry = globalThis.foundry;
  try {
    globalThis.foundry = { ...(previousFoundry ?? {}), utils: { ...(previousFoundry?.utils ?? {}),
      getProperty: (object, key) => key.split(".").reduce((value, field) => value?.[field], object),
      setProperty: (object, key, value) => {
        const fields = key.split("."), last = fields.pop();
        fields.reduce((current, field) => current[field], object)[last] = value;
      } } };
    const original = fixture(), data = { holdings: [copy(original)] };
    deleteCollectionRow(data, "holdings.0.people.list", "worker");
    assert.equal(data.holdings[0].people.list.some((person) => person.id === "worker"), false);
    assertRemainingPlan(data.holdings[0], original);
    assert.equal(planHybridLaborMigration({ holding: data.holdings[0] }).ok, true,
      "ordinary deletion must not leave a migration-blocking person reference");
  } finally {
    if (previousFoundry === undefined) delete globalThis.foundry;
    else globalThis.foundry = previousFoundry;
  }

  const original = fixture(), source = copy(original), target = { id: "target", people: { list: [] }, buildings: { list: [] } };
  assert.equal(transferResidentBetweenHoldings(source, target, "worker").ok, true);
  assertRemainingPlan(source, original);
  assert.equal(target.people.list[0].id, "worker");
  assert.equal(target.workforcePlan, undefined, "source locks must not follow a resident to another settlement");
  assert.equal(planHybridLaborMigration({ holding: source }).ok, true);
  const jobChange = fixture();
  clearPersonFromAssignments(jobChange, "worker");
  assert.deepEqual(jobChange.workforcePlan, original.workforcePlan, "ordinary assignment clearing is not resident removal");

  const damaged = fixture();
  damaged.people.list = damaged.people.list.filter((person) => person.id !== "worker");
  const damagedSnapshot = copy(damaged);
  assert.equal(planHybridLaborMigration({ holding: damaged }).ok, false, "old orphaned locks require an explicit repair decision");
  assert.deepEqual(mergeHoldingDefaults(copy(damaged)).workforcePlan.locks, damaged.workforcePlan.locks,
    "ordinary normalization must preserve existing references");
  const repaired = planHybridLaborMigration({ holding: damaged, clearUnavailablePlanReferences: true });
  assert.equal(repaired.ok, true, "explicit unavailable-reference cleanup also covers missing residents");
  assertRemainingPlan(repaired.targetHolding, damagedSnapshot);
  assert.deepEqual(damaged, damagedSnapshot, "migration preview never mutates its input");
  assert.deepEqual(applyHybridLaborMigration({ holding: damaged, plan: repaired }), repaired.targetHolding);
  assert.equal((await executeHybridLaborMigration({ holdingId: damaged.id, holdingPlan: repaired, operationId: "orphan-lock-cleanup", expectedRevision: 1 }, {
    getUser: () => ({ isGM: false }), store: { transaction: () => assert.fail("player migration repair must not enter persistence") }
  })).ok, false);

  const hidden = fixture(), hiddenRemoval = copy(hidden);
  hiddenRemoval.workforcePlan.locks = hiddenRemoval.workforcePlan.locks.filter((row) => row.personId !== "hidden");
  assert.match(workforceChangeError(hidden, hiddenRemoval, { isGM: false }), /скрыт/,
    "explicit GM migration repair must not authorize players to remove hidden residents' locks");
  const orphanRemoval = copy(damaged); orphanRemoval.workforcePlan.locks = [];
  assert.match(workforceChangeError(damaged, orphanRemoval, { isGM: false }), /скрыт/,
    "players cannot use the ordinary planner as an orphan-reference repair bypass");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkHybridLaborReferenceCleanup();
  console.log("Hybrid labor references: resident deletion/transfer, explicit orphan cleanup, retained goals/other locks and player guards passed.");
}
