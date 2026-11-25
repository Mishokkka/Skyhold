import assert from "node:assert/strict";
import { AssignmentDomain } from "../apps/domains/assignment-domain.js";
import { BuildingProductionDomain } from "../apps/domains/building/production-domain.js";
import { BuildingWorkerDomain } from "../apps/domains/building/worker-domain.js";
import { buildWorkforceModel, createWorkforceDraft, workforceDraftError } from "../apps/domains/workforce-planner.js";
import { defenseGarrisonProfile } from "../apps/mass-combat/sources.js";
import { defenderCasualtyCandidates } from "../apps/mass-combat/casualties.js";
import { canReadResident } from "../data/access-guard.js";
import { SETTING_CATALOG, SETTING_DATA, SETTING_HOLDINGS, SETTING_META } from "../data/constants.js";
import { DEFAULT_SKYHOLD_DATA } from "../data/defaults/default-skyhold-data.js";
import { DEFAULT_BUILDING_TEMPLATES } from "../data/building-templates.js";
import { mergeHoldingDefaults, normalizeSkyholdData } from "../data/normalizers.js";
import { createSkyholdSplitStorage } from "../data/split-storage.js";
import { buildWorkAllocationTargets, validateHoldingWorkAllocations } from "../data/work-allocations.js";
import { productionPreparationGoal } from "../data/labor-model.js";
import { stableDataHash } from "../data/storage-commit.js";
import { prepareSkyholdCommit } from "../data/commit-preparation.js";
import { planBuildingCatalogMigration, planLaborMigration } from "../workflows/buildings/catalog-migration.js";
import { applyConstructionProjectCancellation } from "../workflows/economy/construction-cancellation.js";
import { createEconomyHarness } from "./economy-characterization-check.mjs";

const resident = (id, overrides = {}) => ({
  id, name: id, age: 30, ageGroup: "Вз", attributes: { strength: 4, agility: 4, wits: 4, empathy: 4 },
  workAllocations: [], ...overrides
});
const building = (id, overrides = {}) => ({
  id, name: id, lifecycle: "built", constructionStatus: "built", labor: { version: 2, capacityQd: 20 },
  wageDailyCopper: 12, functions: { culture: true }, ...overrides
});
const allocation = (sourceId, functionId, normalQd) => ({
  id: `${sourceId}-${functionId}`, sourceId, functionId, normalQd, overtimeQd: 0
});
const holding = (buildings, people, overrides = {}) => mergeHoldingDefaults({
  id: "test-holding", buildings: { list: buildings }, people: { list: people }, ...overrides
});
const line = (id, resourceId = "wood") => ({ id, resourceId, active: true, source: "workers", workQd: 1, outputQty: 1 });
const safeNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function checkAssignmentPaths() {
  const initial = holding([building("workshop", {
    functions: { production: true }, productionLines: [{ ...line("logs"), active: false }]
  })], [resident("worker")]);
  const changed = structuredClone(initial);
  changed.people.list[0].workAllocations = [allocation("workshop", "production:logs", 4)];
  const cases = [
    [initial, changed, "work-target-unavailable"],
    ...[["dead", true], ["injuredDays", 2], ["shipAssignment", { shipId: "ship", away: true }]].map(([key, value]) => {
      const unavailable = structuredClone(initial);
      unavailable.buildings.list[0].productionLines[0].active = true;
      unavailable.people.list[0][key] = value;
      const proposed = structuredClone(unavailable);
      proposed.people.list[0].workAllocations = changed.people.list[0].workAllocations;
      return [unavailable, proposed, "resident-unavailable"];
    })
  ];
  const manager = { ...AssignmentDomain, _safeNumber: safeNumber };
  for (const [before, after, code] of cases) {
    assert.equal(validateHoldingWorkAllocations(after, { previousHolding: before }).issues[0]?.code, code);
    const draft = createWorkforceDraft(after);
    draft.edited = ["worker"];
    assert.ok(workforceDraftError(before, draft, { isGM: true }));
    assert.equal(manager._assignPersonToBuilding(before, "worker", "workshop", { functionId: "production:logs", qd: 4 }), false);
    assert.deepEqual(before.people.list[0].workAllocations, []);
  }
  const recovered = structuredClone(changed);
  recovered.people.list[0].workAllocations = [];
  assert.equal(validateHoldingWorkAllocations(recovered, { previousHolding: changed }).ok, true);

  const current = structuredClone(changed);
  current.people.list[0].shipAssignment = { shipId: "ship", away: true };
  const model = buildWorkforceModel(changed, createWorkforceDraft(changed), createEconomyHarness(), { presenceHolding: current });
  assert.equal(model.people.length, 0);
  assert.equal(model.reservedQdByBuilding.get("workshop") ?? 0, 0);
  assert.equal(canReadResident({ visibility: "gm" }, { isGM: false }), false);
  assert.equal(canReadResident({ visibility: "gm" }, { isGM: true }), true);
}

function checkFunctionAndCollection() {
  const arsenal = { ...structuredClone(DEFAULT_BUILDING_TEMPLATES.find((row) => row.id === "arsenal")),
    id: "arsenal-built", templateId: "arsenal", lifecycle: "built", constructionStatus: "built" };
  const settlement = holding([arsenal], [0, 1, 2, 3].map((index) => resident(`storekeeper-${index}`, {
    workAllocations: [allocation(arsenal.id, "storage", 20)]
  })));
  const service = {
    ...BuildingWorkerDomain, _safeNumber: safeNumber,
    _workerEfficiencyForPerson: () => ({ workUnits: 10_000, suitable: true, details: [] })
  };
  const managerGarrison = defenseGarrisonProfile(settlement, {
    buildingEffectiveWorkers: (draft, site, functionId) => service._buildingEffectiveWorkers(draft, site, null, functionId)
  });
  assert.equal(managerGarrison.dice, 0);
  assert.equal(defenseGarrisonProfile(settlement).dice, 0);
  assert.deepEqual(defenderCasualtyCandidates(settlement), []);

  const workshop = building("workshop", { functions: { production: true }, productionLines: [line("logs"), line("saw", "stone")] });
  const goals = holding([workshop], []);
  goals.workforcePlan = { version: 2, locks: [], productionGoals: { workshop: 12, "workshop::production:saw": 3 } };
  const draft = createWorkforceDraft(goals);
  assert.equal(workforceDraftError(goals, draft, { isGM: true }), "");
  const savedGoals = { workforcePlan: draft.plan };
  assert.equal(productionPreparationGoal(savedGoals, "workshop", "production:logs"), 12);
  assert.equal(productionPreparationGoal(savedGoals, "workshop", "production:saw"), 3);

  const economy = createEconomyHarness();
  const pending = { resourceId: "wood", pendingQty: 8, collectQd: 0, collectProgressQd: 2 };
  assert.equal(economy._collectProductionLine(goals, workshop, pending).ok, true);
  assert.deepEqual([pending.pendingQty, pending.collectProgressQd], [0, 0]);
  assert.equal(economy._collectProductionLine(goals, workshop, pending).ok, false);

  const lumbermill = structuredClone(DEFAULT_BUILDING_TEMPLATES.find((row) => row.productionLines?.length));
  Object.assign(lumbermill.productionLines[0], { requiresCollection: true, collectQd: 8, collectProgressQd: 5, pendingQty: 5 });
  const instance = { ...lumbermill, id: "mill-instance", templateId: lumbermill.id, lifecycle: "built", constructionStatus: "built" };
  const root = normalizeSkyholdData({ ...structuredClone(DEFAULT_SKYHOLD_DATA), holdings: [holding([instance], [])] });
  const migration = planBuildingCatalogMigration({ currentData: root, replaceCatalog: true, operationId: "collection-review" });
  assert.equal(migration.canApply, false);
  assert.ok(migration.blockingIssues.some((issue) => issue.code === "collection-in-progress"));
}

async function checkIncomeForecast() {
  const office = building("office", {
    labor: { version: 2, capacityQd: 40 }, functions: { income: true, storage: true },
    income: { base: 10, perWorker: 40 }, activation: { minOperationalQd: 10 }
  });
  const town = holding([office], [
    resident("earner", { workAllocations: [allocation(office.id, "income", 10)] }),
    resident("keeper", { workAllocations: [allocation(office.id, "storage", 10)] })
  ], { gm: { labor: { daysOffPerTenday: 5 } } });
  const economy = createEconomyHarness();
  const forecast = () => BuildingProductionDomain._buildingIncomeSummary.call(economy, office, town);
  assert.equal(forecast().effectiveWorkers, 0.5);
  assert.equal(forecast().total, 30, "income forecast uses paid-function QD against the same full-rate benchmark");
  const report = { income: [], skipped: [], formulas: [], ledger: [] };
  await economy._runBuildingIncomeForQd(town, 40, report, { buildings: [office] });
  assert.equal(report.ledger.find((entry) => entry.domain === "income")?.qty, 30);
  town.people.list[0].injuredDays = 1;
  assert.equal(forecast().total, 0, "a different function cannot replace an injured income worker");
}

async function checkMigrationAndCancellation() {
  const oldHolding = {
    id: "former",
    gm: { defense: { commanderId: "commander", squads: [{ id: "old-squad", memberIds: "invalid old value" }] } },
    buildings: { list: [building("workshop", {
      labor: { version: 1, mode: "staff", capacityQd: null }, workersMax: 1,
      assignedWorkerIds: ["commander", "worker"], functions: { production: true },
      productionLines: [line("other"), line("primary", "stone")]
    })] },
    people: { list: [
      resident("commander"),
      resident("worker", { workAssignment: "workshop", staffAppointment: {
        version: 1, buildingId: "workshop", primaryFunctionId: "production:primary", reserveFunctionId: "production:other",
        wageDailyCopper: 0, overtimeQd: 0, volunteer: true, volunteerReason: "Договор"
      } }),
      resident("old-rate", { salaryModifier: 2 })
    ] }
  };
  const base = { ...structuredClone(DEFAULT_SKYHOLD_DATA), holdings: [oldHolding] };
  const values = new Map([[SETTING_META, base.meta], [SETTING_HOLDINGS, base.holdings], [SETTING_CATALOG, base.catalog]]);
  const storage = createSkyholdSplitStorage({ settings: {
    get: (_module, key) => structuredClone(values.get(key)),
    set: (_module, key, value) => { values.set(key, structuredClone(value)); return value; }
  } });
  const raw = storage.readSettings();
  const review = planLaborMigration(raw);
  assert.equal(review.canApply, true);
  assert.ok(review.decisions.some((entry) => entry.detail.includes("резервная функция")));
  const projected = review.targetData.holdings[0];
  assert.deepEqual(projected.people.list[0].workAllocations, []);
  assert.equal(projected.people.list[1].workAllocations[0].functionId, "production:primary");
  assert.equal(projected.people.list[1].workAllocations[0].volunteer, true);
  assert.equal(projected.buildings.list[0].labor.capacityQd, 20);
  assert.equal(buildWorkAllocationTargets(projected).length, 2);

  const ordinaryWrite = storage.getData();
  ordinaryWrite.holdings[0].name = "Unrelated update";
  await assert.rejects(storage.persistData(ordinaryWrite), { code: "labor-migration-required" });
  assert.deepEqual(storage.readSettings(), raw);
  assert.equal(values.has(SETTING_DATA), false);

  const ready = prepareSkyholdCommit(review.targetData, { baseRevision: raw.meta.revision });
  await assert.rejects(storage.persistData(ready.data, { normalized: true, laborMigrationHash: "stale" }), { code: "target-holdings-hash" });
  assert.deepEqual(storage.readSettings(), raw);
  await storage.persistData(ready.data, { normalized: true, laborMigrationHash: review.sourceHash });
  assert.deepEqual(values.get(SETTING_DATA), raw);
  assert.equal(planLaborMigration(storage.readSettings()).hasChanges, false);
  assert.deepEqual(storage.getData().holdings[0].people.list[1].workAllocations, projected.people.list[1].workAllocations);
  const migrated = storage.readSettings();
  await assert.rejects(storage.restoreLegacyLaborSnapshot("outdated-backup"), { code: "hash-mismatch" });
  assert.deepEqual(storage.readSettings(), migrated);
  const restored = await storage.restoreLegacyLaborSnapshot(stableDataHash(raw));
  assert.deepEqual(storage.readSettings().holdings, raw.holdings, "rollback preserves the original staff and building records");
  assert.deepEqual(values.get(SETTING_DATA), migrated, "rollback retains the previous v2 revision for recovery");
  assert.equal(restored.meta.revision, migrated.meta.revision + 1);
  assert.deepEqual(restored.holdings[0].people.list[1].workAllocations, projected.people.list[1].workAllocations);
  await assert.rejects(storage.persistData(restored), { code: "labor-migration-required" });

  const project = building("cancel", { lifecycle: "building", constructionStatus: "building", buildTarget: 5 });
  const other = building("keep");
  const settlement = holding([project, other], [resident("worker", { workAssignment: project.id, workAllocations: [allocation(other.id, "culture", 4)] })]);
  const cancelled = applyConstructionProjectCancellation({ holding: settlement, buildingId: project.id, operationId: "cancel-one",
    dependencies: { addStorageWithOverflow: () => [], setPersonFree: AssignmentDomain._setPersonFree.bind(AssignmentDomain) } });
  assert.equal(cancelled.ok, true);
  assert.equal(settlement.people.list[0].workAssignment, "");
  assert.equal(settlement.people.list[0].workAllocations[0].sourceId, other.id);
}

export async function checkLaborIntegration() {
  checkAssignmentPaths();
  checkFunctionAndCollection();
  await checkIncomeForecast();
  await checkMigrationAndCancellation();
}
