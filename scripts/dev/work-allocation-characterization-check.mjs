import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AssignmentDomain } from "../apps/domains/assignment-domain.js";
import { FinanceEconomyDomain } from "../apps/domains/finance/economy-domain.js";
import { FinanceInternalDemandDomain } from "../apps/domains/finance/internal-demand-domain.js";
import { FinanceMaintenanceDomain } from "../apps/domains/finance/maintenance-domain.js";
import { calculatePlannedWorkerWage } from "../engines/economy/finance-obligations.js";
import { buildPlayerPatch, validatePlayerPatch } from "../data/player-write-guard.js";
import {
  buildingStaffingWorkerIds,
  buildPlannedWorkSlots,
  explicitWorkerIdsForBuilding,
  explicitWorkAllocationsForBuilding,
  MAINTENANCE_WORK_FUNCTION_ID,
  MAINTENANCE_WORK_SOURCE_ID,
  normalizePersonWorkAllocations,
  plannedAssignmentQd,
  validateHoldingWorkAllocations,
  validateWorkAllocationPlan,
  WORK_ALLOCATION_MODE_EXPLICIT,
  WORK_ALLOCATION_MODE_LEGACY
} from "../data/work-allocations.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function allocation(id, sourceId, functionId, normalQd, overtimeQd = 0) {
  return { id, sourceId, functionId, normalQd, overtimeQd };
}

function holdingFixture() {
  return {
    id: "holding-1",
    visibility: "public",
    gm: { playersCanEditBuildings: true },
    buildings: {
      list: [{
        id: "workshop",
        name: "Workshop",
        status: "built",
        workersMax: 2,
        assignedWorkerIds: ["legacy", "split"],
        wageDailyCopper: 3,
        productionLines: [
          { id: "forge", active: true, source: "workers", mode: "Forge", overtime: true, wageDailyCopper: 3 },
          { id: "carve", active: true, source: "workers", mode: "Carve", overtime: false, wageDailyCopper: 5 }
        ]
      }]
    },
    constructionCrews: [],
    constructionCrewIds: [],
    people: {
      list: [
        { id: "legacy", name: "Legacy", workAssignment: "workshop" },
        {
          id: "split",
          name: "Split",
          workAssignment: "",
          workAllocationMode: WORK_ALLOCATION_MODE_EXPLICIT,
          workAllocations: [
            allocation("forge-work", "workshop", "production:forge", 12, 4),
            allocation("carve-work", "workshop", "production:carve", 8, 0)
          ]
        }
      ]
    },
    storage: { resources: [], items: [], log: [], moneyCopper: 0 },
    special: { list: [] },
    log: []
  };
}

export function checkWorkAllocationCharacterization() {
  const legacy = normalizePersonWorkAllocations({ id: "legacy" });
  assert.equal(legacy.workAllocationMode, WORK_ALLOCATION_MODE_LEGACY, "old residents must stay on the legacy assignment path");
  assert.deepEqual(legacy.workAllocations, [], "normalization must add only empty allocation state to old residents");

  const manyRows = Array.from({ length: 25 }, (_, index) => allocation(`row-${index}`, "workshop", `fn-${index}`, 0));
  const preserved = normalizePersonWorkAllocations({ workAllocationMode: WORK_ALLOCATION_MODE_EXPLICIT, workAllocations: manyRows });
  assert.equal(preserved.workAllocations.length, 25, "safe normalization must not erase excess user rows; validation owns the limit");
  assert.equal(validateWorkAllocationPlan(preserved.workAllocations).issues.some((issue) => issue.code === "allocation-count"), true);

  const targets = new Map([
    ["workshop::production:forge", { key: "workshop::production:forge", overtimeAllowed: true }],
    ["workshop::production:carve", { key: "workshop::production:carve", overtimeAllowed: false }]
  ]);
  const valid = validateWorkAllocationPlan([
    allocation("forge-work", "workshop", "production:forge", 12, 4),
    allocation("carve-work", "workshop", "production:carve", 8)
  ], { targets });
  assert.equal(valid.ok, true, "one resident may split the 20 normal QD between functions and add eligible overtime");
  assert.deepEqual(valid.totals, { normalQd: 20, overtimeQd: 4, totalQd: 24 });

  const overbooked = validateWorkAllocationPlan([
    allocation("forge-work", "workshop", "production:forge", 13, 5),
    allocation("carve-work", "workshop", "production:carve", 8)
  ], { targets });
  assert.equal(overbooked.issues.some((issue) => issue.code === "allocation-normal-cap"), true, "normal work above 20 QD must be rejected");
  const invalidOvertime = validateWorkAllocationPlan([
    allocation("carve-work", "workshop", "production:carve", 20, 1)
  ], { targets });
  assert.equal(invalidOvertime.issues.some((issue) => issue.code === "allocation-overtime"), true, "overtime must be allowed by the selected function");

  const assignments = valid.rows;
  const slots = buildPlannedWorkSlots(assignments, 40);
  assert.equal(slots.size, 24, "every planned QD must occupy exactly one execution slot");
  assert.equal([...slots.values()].filter((row) => row.sourceId === "workshop" && row.functionId === "production:forge").length, 16);
  assert.equal([...slots.entries()].every(([step, row]) => row.overtime ? step % 4 === 2 : step % 4 < 2), true, "normal and overtime QD must use their own daily slots");

  const holding = holdingFixture();
  const checked = validateHoldingWorkAllocations(holding);
  assert.equal(checked.ok, true, "an explicit resident already present in assignedWorkerIds must count only once toward building capacity");
  assert.deepEqual(holding.buildings.list[0].assignedWorkerIds, ["legacy", "split"], "validation must not materialize explicit plans into legacy worker slots");
  assert.equal(explicitWorkAllocationsForBuilding(holding.people.list[1], "workshop").length, 2, "two functions in one building must remain visible in the resident plan");
  assert.deepEqual(explicitWorkerIdsForBuilding(holding, "workshop"), ["split"], "two functions in one building must still describe one planned worker");
  assert.deepEqual(buildingStaffingWorkerIds(holding, "workshop"), ["legacy", "split"], "one resident must occupy only one staffing place per building");

  const crossBuilding = holdingFixture();
  crossBuilding.buildings.list.push({
    id: "inn",
    name: "Inn",
    status: "built",
    workersMax: 1,
    assignedWorkerIds: [],
    wageDailyCopper: 4,
    functions: { income: true },
    income: { base: 1 }
  });
  crossBuilding.people.list[1].workAllocations = [
    allocation("forge-work", "workshop", "production:forge", 12, 4),
    allocation("inn-work", "inn", "income", 8, 0)
  ];
  const crossBuildingChecked = validateHoldingWorkAllocations(crossBuilding);
  assert.equal(crossBuildingChecked.ok, true, "one resident may be present in the valid staffing of two buildings when their QD are split");
  assert.equal(crossBuildingChecked.plans.get("split").totals.normalQd, 20);
  assert.equal(crossBuildingChecked.targetMap.has("workshop::production:forge"), true);
  assert.equal(crossBuildingChecked.targetMap.has("inn::income"), true);
  assert.deepEqual(buildingStaffingWorkerIds(crossBuilding, "workshop"), ["legacy", "split"]);
  assert.deepEqual(buildingStaffingWorkerIds(crossBuilding, "inn"), ["split"], "a split resident must occupy capacity in every building receiving positive QD");
  assert.match(crossBuildingChecked.targetMap.get("workshop::production:forge").label, /3 ММ\/день/, "the allocation picker must disclose the effective function wage");

  const overCapacity = clone(crossBuilding);
  overCapacity.people.list.push({ id: "inn-legacy", name: "Inn Legacy", workAssignment: "inn" });
  overCapacity.buildings.list.find((building) => building.id === "inn").assignedWorkerIds = ["inn-legacy"];
  const overCapacityChecked = validateHoldingWorkAllocations(overCapacity);
  assert.equal(overCapacityChecked.ok, false, "a legacy slot must not be able to hide on top of an explicit split worker");
  assert.equal(overCapacityChecked.issues.some((issue) => issue.code === "allocation-capacity" && issue.buildingId === "inn"), true, "combined legacy and explicit staffing must enforce workersMax");

  const assignmentHolding = clone(crossBuilding);
  assignmentHolding.people.list.push({ id: "slot-candidate", name: "Slot Candidate", workAssignment: "" });
  const assignmentHarness = {
    ...AssignmentDomain,
    _safeNumber(value, fallback = 0) {
      const number = Number(value);
      return Number.isFinite(number) ? number : fallback;
    }
  };
  assert.equal(assignmentHarness._setBuildingSlot(assignmentHolding, "inn", 0, "slot-candidate"), false, "a legacy selector must reject a hidden extra head when an explicit split already fills workersMax");
  assert.deepEqual(assignmentHolding.buildings.list.find((building) => building.id === "inn").assignedWorkerIds, [], "a rejected legacy assignment must not mutate the full building");

  const current = { meta: { revision: 4 }, holdings: [holding], catalog: { buildings: [] } };
  const proposed = clone(current);
  proposed.holdings[0].buildings.list[0].assignedWorkerIds = ["legacy", ""];
  proposed.holdings[0].people.list[1].workAllocationMode = WORK_ALLOCATION_MODE_EXPLICIT;
  proposed.holdings[0].people.list[1].workAllocations[0].normalQd = 10;
  proposed.holdings[0].people.list[1].workAllocations[1].normalQd = 10;
  const patch = buildPlayerPatch(current, proposed);
  assert.equal(patch.action, "buildings", "allocation edits and legacy-slot cleanup must share the building permission category");
  assert.equal(validatePlayerPatch(current, patch).ok, true, "the authority GM guard must accept a valid player allocation patch");
  const tampered = clone(proposed);
  tampered.holdings[0].people.list[1].workAllocations[0].normalQd = 20;
  const badPatch = buildPlayerPatch(proposed, tampered);
  assert.equal(validatePlayerPatch(proposed, badPatch).ok, false, "the authority GM guard must reject an overbooked player plan");

  const forgedFree = clone(proposed);
  forgedFree.holdings[0].people.list[1].workAllocations[0].volunteer = true;
  assert.equal(validatePlayerPatch(proposed, buildPlayerPatch(proposed, forgedFree)).ok, false, "players cannot grant themselves a free contract");
  const grantedFree = clone(proposed);
  Object.assign(grantedFree.holdings[0].people.list[1].workAllocations[0], { volunteer: true, volunteerReason: "Сюжетная договорённость" });
  const movedFree = clone(grantedFree);
  movedFree.holdings[0].people.list[1].workAllocations[0].functionId = "production:carve";
  assert.equal(validatePlayerPatch(grantedFree, buildPlayerPatch(grantedFree, movedFree)).ok, false, "a GM agreement cannot be transferred to another job");
  const adjustedFree = clone(grantedFree);
  adjustedFree.holdings[0].people.list[1].workAllocations[0].normalQd = 9;
  assert.equal(validatePlayerPatch(grantedFree, buildPlayerPatch(grantedFree, adjustedFree)).ok, true, "the player may adjust hours of the same approved assignment");

  const weighted = calculatePlannedWorkerWage({
    id: "split",
    maximumNormalQd: 20,
    maximumOvertimeQd: 10,
    assignments: [
      { sourceId: "workshop", functionId: "production:forge", normalQd: 12, overtimeQd: 4, dailyRateCopper: 3 },
      { sourceId: "workshop", functionId: "production:carve", normalQd: 8, overtimeQd: 0, dailyRateCopper: 5 }
    ]
  });
  assert.equal(weighted.ok, true);
  assert.equal(weighted.dueCopper, 50, "rates must be weighted per function, overtime paid at a full daily rate, then rounded once per resident");

  const financeContext = FinanceEconomyDomain._financeExecutionContext.call({
    _safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    _financeFunctionKey: (sourceId, functionId) => `${sourceId}::${functionId}`
  }, { blockers: { workers: {}, buildings: {} }, invalidWorkerIds: [] }, {
    plannedWorkers: [{ id: "split", assignments }],
    periodQd: 40
  });
  assert.equal(plannedAssignmentQd(financeContext.plannedAssignmentsByWorkerId.get("split"), "workshop", "production:forge"), 16);
  assert.equal(financeContext.plannedWorkSlotsByWorkerId.get("split").size, 24, "finance execution must preserve the one-QD-one-function schedule");

  const splitPerson = { id: "split", name: "Split" };
  const workshop = { id: "workshop", name: "Workshop" };
  const inn = { id: "inn", name: "Inn" };
  const crossFunctionAssignments = [
    { sourceId: "workshop", functionId: "production:forge", normalQd: 12, overtimeQd: 4 },
    { sourceId: "inn", functionId: "income", normalQd: 8, overtimeQd: 0 }
  ];
  const crossFunctionContext = FinanceEconomyDomain._financeExecutionContext.call({
    _safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    _financeFunctionKey: (sourceId, functionId) => `${sourceId}::${functionId}`
  }, { blockers: { workers: {}, buildings: {} }, invalidWorkerIds: [] }, {
    plannedWorkers: [{ id: "split", assignments: crossFunctionAssignments }],
    periodQd: 40
  });
  const workerContext = {
    financeContext: crossFunctionContext,
    buildingWorkers: new Map([
      [workshop, { economyAssignedPeople: [splitPerson] }],
      [inn, { economyAssignedPeople: [splitPerson] }]
    ])
  };
  const qdHarness = {
    ...FinanceEconomyDomain,
    _safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback
  };
  const budgets = new Map();
  for (let step = 0; step < 40; step += 1) qdHarness._accrueWorkerBudgets({}, budgets, workerContext, step);
  const forgeBudgetKey = qdHarness._workerBudgetKey("split", "workshop", "production:forge");
  const incomeBudgetKey = qdHarness._workerBudgetKey("split", "inn", "income");
  assert.equal(budgets.get(forgeBudgetKey)?.available, 16);
  assert.equal(budgets.get(incomeBudgetKey)?.available, 8);
  const overspendIncome = qdHarness._spendBuildingWorkerQd({}, inn, budgets, 9, workerContext, "income");
  assert.deepEqual(overspendIncome, { ok: false, spent: 0 }, "an incomplete collection must neither spend partial QD nor borrow another workplace's time");
  assert.equal(budgets.get(incomeBudgetKey)?.available, 8, "failed collection preserves the allowed assignment's QD for another attempt");
  assert.equal(budgets.get(forgeBudgetKey)?.available, 16, "failed income work must leave forge QD untouched");
  assert.deepEqual(qdHarness._spendBuildingWorkerQd({}, workshop, budgets, 16, workerContext, "production:forge"), { ok: true, spent: 16 });

  const incomeWorker = { id: "seller", name: "Seller" };
  const incomeBuilding = {
    id: "inn",
    name: "Inn",
    income: { trade: { enabled: true, throughputUnitsPerWorker: 10, demandBudgetPerWorkerCopper: 10 } }
  };
  const incomeWorkerContext = {
    financeContext: {
      plannedAssignmentsByWorkerId: new Map([[incomeWorker.id, [allocation("income-work", "inn", "income", 5)]]])
    }
  };
  const incomeHarness = {
    ...FinanceInternalDemandDomain,
    _buildingStatus: () => ({ value: "built" }),
    _buildingFunctions: () => ({ income: true }),
    _financeFunctionAllowed: () => true,
    _activeAssignedBuildingPeople: () => [incomeWorker],
    _plannedWorkerFunctionQd: FinanceEconomyDomain._plannedWorkerFunctionQd,
    _personBuildingEfficiency: () => 2,
    _maintenanceEfficiencyFactor: () => 1
  };
  const incomeChannels = incomeHarness._internalDemandChannels({ buildings: { list: [incomeBuilding] } }, incomeWorkerContext.financeContext, 1, incomeWorkerContext);
  assert.equal(incomeChannels.channels[0].throughputUnits, 5, "5 of 20 income QD must provide only one quarter of seller throughput");
  assert.equal(incomeChannels.channels[0].sellerEfficiency, 2, "allocation share must scale throughput without diluting seller skill");

  const maintenancePerson = {
    id: "maintainer",
    workAllocationMode: WORK_ALLOCATION_MODE_EXPLICIT,
    maintenancePointsPerTenday: 4
  };
  const maintenanceContext = {
    blockedWorkerIds: new Set(),
    plannedAssignmentsByWorkerId: new Map([[maintenancePerson.id, [
      allocation("maintenance-work", MAINTENANCE_WORK_SOURCE_ID, MAINTENANCE_WORK_FUNCTION_ID, 10)
    ]]])
  };
  const maintenanceDeps = FinanceMaintenanceDomain._maintenancePeriodDependencies.call({
    _buildingStatus: () => ({ value: "built" })
  }, maintenanceContext, 40);
  assert.equal(maintenanceDeps.isWorkerAvailable(maintenancePerson), true);
  assert.equal(maintenanceDeps.pointsForWorker(maintenancePerson), 2, "maintenance points must scale with the explicit share of normal work QD");
  assert.equal(maintenanceDeps.pointsForWorker({ ...maintenancePerson, workAllocationMode: WORK_ALLOCATION_MODE_LEGACY, workAssignment: "workshop" }), 4, "legacy workers keep their established maintenance behavior");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkWorkAllocationCharacterization();
  console.log("FBL Skyhold work allocations: normalization, caps, authority, wages, slots and maintenance passed.");
}
