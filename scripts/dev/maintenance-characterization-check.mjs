import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkTechnicalMaintenance } from "./technical-maintenance-characterization-check.mjs";

checkTechnicalMaintenance();
import { FinanceMaintenanceDomain } from "../apps/domains/finance/maintenance-domain.js";
import {
  maintenanceEfficiencyFactor,
  normalizeBuildingMaintenance,
  normalizeMaintenancePointsPerTenday
} from "../data/economy/maintenance.js";
import {
  applyMaintenancePeriodPlan,
  planMaintenancePeriod
} from "../engines/economy/maintenance-period.js";
import { runProductionCycle } from "../engines/economy/production-cycle.js";
import { buildPlayerPatch, validatePlayerPatch } from "../data/player-write-guard.js";
import { normalizeBuilding } from "../data/normalizers/building.js";
import { normalizePerson } from "../data/normalizers/resident.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function building(id, {
  requiredPoints = 1,
  priority = 0,
  backlogTendays = 0,
  needsResolution = false
} = {}) {
  return {
    id,
    name: id,
    lifecycle: "active",
    condition: "intact",
    constructionStatus: "built",
    maintenance: { requiredPoints, priority, backlogTendays, needsResolution, lastOperationId: "" }
  };
}

function worker(id, points = 0, overrides = {}) {
  return {
    id,
    name: id,
    workAssignment: "maintenance",
    maintenancePointsPerTenday: points,
    ...overrides
  };
}

function dependencies() {
  return {
    isBuildingEligible: (row) => row.lifecycle === "active" && row.condition === "intact",
    isWorkerAvailable: (row) => !row.dead && Number(row.injuredDays || 0) === 0 && Boolean(row.workAssignment)
  };
}

function apply(plan, buildings, workers) {
  const deps = dependencies();
  return applyMaintenancePeriodPlan({
    plan,
    dependencies: {
      ...deps,
      getBuildings: () => buildings,
      getWorkers: () => workers,
      setMaintenance: (row, state) => { row.maintenance = normalizeBuildingMaintenance(state); }
    }
  });
}

export async function checkMaintenanceCharacterization() {
  assert.deepEqual(normalizeBuildingMaintenance({ requiredPoints: 99, priority: "-4", backlogTendays: "2.9" }), {
    schemaVersion: 1,
    requiredPoints: 3,
    priority: -4,
    backlogTendays: 2,
    needsResolution: false,
    lastOperationId: ""
  });
  assert.equal(normalizeMaintenancePointsPerTenday(-7), 0);
  const defaultBuilding = { id: "default-building" };
  normalizeBuilding(defaultBuilding);
  assert.deepEqual(defaultBuilding.maintenance, normalizeBuildingMaintenance(), "normal load must seed canonical zero-cost maintenance state");
  const defaultWorker = { id: "default-worker" };
  normalizePerson(defaultWorker);
  assert.equal(defaultWorker.maintenancePointsPerTenday, 0, "workers must create no implicit maintenance points by default");
  assert.equal(maintenanceEfficiencyFactor({ backlogTendays: 1 }), 1, "the first missed tenday has no efficiency penalty");
  assert.equal(maintenanceEfficiencyFactor({ backlogTendays: 2 }), 0.5, "the second missed tenday halves efficiency");

  for (const technicalReadyAfter of [0, 2]) {
    const productionBuilding = building("mill", { backlogTendays: 2 });
    productionBuilding.functions = { production: true };
    productionBuilding.assignedWorkerIds = ["worker"];
    productionBuilding.productionLines = [{ id: "flour", active: true, source: "workers", workQd: 1, resourceId: "flour", resource: "Flour", outputQty: 4, expenses: "" }];
    const productionHolding = { people: { list: [{ id: "worker" }] }, storage: { resources: [] } };
    const report = { produced: [], consumed: [], skipped: [], formulas: [], ledger: [] };
    await runProductionCycle({
      holding: productionHolding,
      qd: 2 + technicalReadyAfter,
      report,
      buildings: [productionBuilding],
      budgets: new Map(),
      workerContext: {},
      dependencies: {
        safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
        resetWorkerBudgets: () => {},
        accrueWorkerBudgets: (_holding, budgets) => budgets.set("worker", { available: 1, spent: 0 }),
        getSeasonSnapshot: () => null,
        buildingStatus: () => ({ value: "built" }),
        buildingFunctions: () => ({ production: true }),
        lineFinanceAllowed: () => true,
        buildingTechnicalReady: (_building, step) => step >= technicalReadyAfter,
        lineSeasonAllowed: () => true,
        periodDueOnStep: () => false,
        normalizeResourceId: (value) => value,
        resourceLabel: (value) => value,
        lineContentQuantity: () => 0,
        buildingEffectiveWorkers: () => ({ total: 1 }),
        lineOutputForCycle: async () => ({ qty: 4, formula: "" }),
        parseResourceCosts: () => [],
        costsForUnits: () => [],
        scaledCosts: () => [],
        storageCanPay: () => ({ ok: true, costs: [] }),
        storagePay: () => ({ costs: [] }),
        normalizeStorageRoomId: () => "outdoors",
        storageAddWithOverflow: (holding, resource, qty) => {
          holding.storage.resources.push({ resourceId: resource.resourceId, qty });
          return [{ roomId: "outdoors", qty }];
        },
        pushProductionPlacement: () => {},
        appendLedger: () => {},
        autoCollectBuilding: async () => {},
        assignedBuildingPeople: () => [{ id: "worker" }],
        workerBudgetEntry: (_holding, _person, budgets) => budgets.get("worker"),
        personBuildingEfficiency: () => 1,
        buildingCompositionStatus: () => ({ met: true, text: "—" }),
        maintenanceEfficiencyFactor: () => 0.5,
        storageQuantity: () => 0,
        tryCollectResourceForConsumer: async () => 0,
        formatNumber: String
      }
    });
    assert.equal(productionHolding.storage.resources[0].qty, 4, "half maintenance must require two real QD for one whole production batch, not emit half a batch");
    assert.equal(productionBuilding.productionLines[0].workProgressUnits, 0, "the completed whole batch must consume its accumulated integer work");
  }

  const buildings = [
    building("low", { requiredPoints: 1, priority: 10 }),
    building("tie-b", { requiredPoints: 1, priority: 50 }),
    building("high", { requiredPoints: 2, priority: 100 }),
    building("tie-a", { requiredPoints: 1, priority: 50 })
  ];
  const workers = [
    worker("handyman", 3),
    worker("injured", 50, { injuredDays: 1 }),
    worker("explicit-zero", 0)
  ];
  const priorityPlan = planMaintenancePeriod({
    buildings,
    workers,
    elapsedQd: 40,
    operationId: "maintenance-priority",
    dependencies: dependencies()
  });
  assert.deepEqual(priorityPlan.cycles[0].allocations.map((row) => row.buildingId), ["high", "tie-a", "tie-b", "low"]);
  assert.deepEqual(priorityPlan.cycles[0].allocations.map((row) => row.allocatedPoints), [2, 1, 0, 0], "limited points must follow descending priority and stable id");
  assert.equal(priorityPlan.totals.availablePoints, 3, "only available workers with explicit whole points contribute");
  assert.equal(priorityPlan.totals.unusedPoints, 0, "points never carry beyond the tenday allocation");

  const backlogBuilding = building("forge", { requiredPoints: 1 });
  const noWorkers = [];
  for (let turn = 1; turn <= 3; turn += 1) {
    const plan = planMaintenancePeriod({
      buildings: [backlogBuilding],
      workers: noWorkers,
      elapsedQd: 40,
      operationId: `maintenance-miss-${turn}`,
      dependencies: dependencies()
    });
    const result = apply(plan, [backlogBuilding], noWorkers);
    assert.equal(result.ok, true);
    assert.equal(backlogBuilding.maintenance.backlogTendays, turn);
    assert.equal(maintenanceEfficiencyFactor(backlogBuilding.maintenance), turn === 1 ? 1 : 0.5);
    assert.equal(backlogBuilding.maintenance.needsResolution, turn >= 3);
    assert.equal(backlogBuilding.lifecycle, "active", "maintenance backlog must never destroy or disable a building automatically");
    assert.equal(backlogBuilding.condition, "intact");
  }

  const replayBuilding = building("mill", { requiredPoints: 1 });
  const replayWorkers = [worker("handyman", 1)];
  const replayPlan = planMaintenancePeriod({
    buildings: [replayBuilding],
    workers: replayWorkers,
    elapsedQd: 40,
    operationId: "maintenance-replay",
    dependencies: dependencies()
  });
  const first = apply(replayPlan, [replayBuilding], replayWorkers);
  assert.equal(first.ok, true);
  const afterFirst = clone(replayBuilding);
  const replay = apply(replayPlan, [replayBuilding], replayWorkers);
  assert.equal(replay.ok, true);
  assert.equal(replay.replay, true, "reusing an applied operationId must be an idempotent replay");
  assert.deepEqual(replayBuilding, afterFirst, "replay must not mutate maintenance twice");

  const staleBuilding = building("bakery", { requiredPoints: 2 });
  const staleWorkers = [worker("handyman", 2)];
  const stalePlan = planMaintenancePeriod({
    buildings: [staleBuilding],
    workers: staleWorkers,
    elapsedQd: 40,
    operationId: "maintenance-stale",
    dependencies: dependencies()
  });
  staleWorkers[0].maintenancePointsPerTenday = 1;
  const staleBefore = clone(staleBuilding);
  const stale = apply(stalePlan, [staleBuilding], staleWorkers);
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true, "changed worker points must reject the immutable Preview plan");
  assert.deepEqual(staleBuilding, staleBefore, "stale apply must be atomic");

  const holding = {
    id: "laputa",
    gm: { calendaria: { lastQd: 0 } },
    people: { list: [worker("handyman", 1), worker("unpaid", 20)] },
    buildings: { list: [building("workshop", { requiredPoints: 2 })] }
  };
  const report = { work: [], skipped: [] };
  const domain = {
    ...FinanceMaintenanceDomain,
    _buildingStatus: () => ({ value: "built" })
  };
  const runtime = domain._runMaintenanceForQd(holding, 40, report, {
    operationId: "laputa:tenday:1:maintenance",
    financeContext: { blockedWorkerIds: new Set(["unpaid"]) }
  });
  assert.equal(runtime.ok, true);
  assert.equal(holding.buildings.list[0].maintenance.backlogTendays, 1, "finance-blocked workers provide no maintenance points");
  assert.equal(report.maintenance.allocatedPoints, 1);
  assert.equal(report.maintenance.needsResolution.length, 0);

  const mainTemplate = fs.readFileSync(new URL("../../templates/parts/building-editor/main.hbs", import.meta.url), "utf8");
  const residentTemplate = fs.readFileSync(new URL("../../templates/parts/skyhold-resident-editor.hbs", import.meta.url), "utf8");
  const editorSource = fs.readFileSync(new URL("../apps/editors/building-editor.js", import.meta.url), "utf8");
  assert.match(mainTemplate, /building\.maintenance\.requiredPointsPath/);
  assert.match(mainTemplate, /building\.maintenance\.priorityPath/);
  assert.match(mainTemplate, /building\.maintenance\.needsResolutionPath/);
  assert.match(residentTemplate, /maintenancePointsPerTenday/);
  assert.match(editorSource, /isGM:\s*Boolean\(game\.user\?\.isGM\)/, "only the GM context may expose resolution editing");

  const current = {
    meta: { revision: 1 },
    holdings: [{
      id: "laputa",
      visibility: "public",
      gm: { playersCanEditBuildings: true },
      buildings: { list: [{ id: "forge", maintenance: normalizeBuildingMaintenance({ requiredPoints: 1 }) }] },
      people: { list: [] }
    }]
  };
  const playerPriority = clone(current);
  playerPriority.holdings[0].buildings.list[0].maintenance.priority = 90;
  const priorityPatch = buildPlayerPatch(current, playerPriority);
  assert.equal(priorityPatch.action, "buildings");
  assert.equal(validatePlayerPatch(current, priorityPatch, "player-1").ok, true, "players with building permission may set maintenance priority");
  const playerResolution = clone(current);
  playerResolution.holdings[0].buildings.list[0].maintenance.needsResolution = true;
  const resolutionPatch = buildPlayerPatch(current, playerResolution);
  assert.equal(validatePlayerPatch(current, resolutionPatch, "player-1").ok, false, "players must not forge GM-resolution or runtime backlog fields");

  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkMaintenanceCharacterization();
  console.log("FBL Skyhold maintenance: priority points, backlog thresholds, immutable apply, replay and editor contracts passed.");
}
