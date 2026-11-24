import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FinanceEconomyDomain } from "../apps/domains/finance/economy-domain.js";
import { FinanceInternalDemandDomain } from "../apps/domains/finance/internal-demand-domain.js";
import { calculatePlannedWorkerWage } from "../engines/economy/finance-obligations.js";
import { buildPlayerPatch, validatePlayerPatch } from "../data/player-write-guard.js";
import {
  buildPlannedWorkSlots,
  buildingWorkAllocationsForBuilding,
  buildingWorkerIds,
  normalizePersonWorkAllocations,
  plannedAssignmentQd,
  validateHoldingWorkAllocations,
  validateWorkAllocationPlan
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
    gm: { playersCanEditBuildings: true, labor: { daysOffPerTenday: 0 } },
    buildings: {
      list: [{
        id: "workshop",
        name: "Workshop",
        status: "built",
        constructionStatus: "built",
        workersMax: 2,
        labor: { version: 2, capacityQd: 40 },
        wageDailyCopper: 3,
        functions: { production: true },
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
        {
          id: "steady",
          name: "Steady",
          workAssignment: "",
          workAllocations: [allocation("steady-forge", "workshop", "production:forge", 12, 0)]
        },
        {
          id: "split",
          name: "Split",
          workAssignment: "",
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
  const fresh = normalizePersonWorkAllocations({ id: "fresh", workAllocationMode: "explicit" });
  assert.equal(Object.hasOwn(fresh, "workAllocationMode"), false, "normalization must strip deprecated workAllocationMode");
  assert.deepEqual(fresh.workAllocations, [], "normalization must add empty workAllocations to residents without plans");

  const manyRows = Array.from({ length: 25 }, (_, index) => allocation(`row-${index}`, "workshop", `fn-${index}`, 0));
  const preserved = normalizePersonWorkAllocations({ workAllocations: manyRows });
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
  assert.equal(checked.ok, true, "steady + split within 40 QD capacity must be valid");
  assert.equal(buildingWorkAllocationsForBuilding(holding.people.list[1], "workshop").length, 2, "two functions in one building must remain visible in the resident plan");
  assert.deepEqual(buildingWorkerIds(holding, "workshop"), ["steady", "split"], "two functions in one building must still describe one worker id");

  const crossBuilding = holdingFixture();
  crossBuilding.buildings.list.push({
    id: "inn",
    name: "Inn",
    status: "built",
    constructionStatus: "built",
    workersMax: 1,
    labor: { version: 2, capacityQd: 20 },
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
  assert.deepEqual(buildingWorkerIds(crossBuilding, "workshop"), ["steady", "split"]);
  assert.deepEqual(buildingWorkerIds(crossBuilding, "inn"), ["split"], "a split resident must occupy capacity in every building receiving positive QD");
  assert.match(crossBuildingChecked.targetMap.get("workshop::production:forge").label, /3 ММ\/день/, "the allocation picker must disclose the effective function wage");

  const overCapacity = clone(crossBuilding);
  overCapacity.people.list.push({
    id: "inn-extra",
    name: "Inn Extra",
    workAllocations: [allocation("inn-extra-work", "inn", "income", 16, 0)]
  });
  const overCapacityChecked = validateHoldingWorkAllocations(overCapacity);
  assert.equal(overCapacityChecked.ok, false, "combined QD allocations must enforce building capacityQd");
  assert.equal(overCapacityChecked.issues.some((issue) => issue.code === "building-capacity-exceeded" && issue.buildingId === "inn"), true);
  const renamedAtCapacity = clone(overCapacity);
  const crowdedInn = renamedAtCapacity.buildings.list.find((building) => building.id === "inn");
  crowdedInn.name = "New Inn Name";
  assert.equal(validateHoldingWorkAllocations(renamedAtCapacity, { previousHolding: overCapacity }).ok, true,
    "renaming a building preserves an existing capacity issue");
  crowdedInn.labor = { version: 2, capacityQd: 10 };
  assert.equal(validateHoldingWorkAllocations(renamedAtCapacity, { previousHolding: overCapacity }).ok, false,
    "lowering the QD limit of an already overbooked building worsens the issue");

  const current = { meta: { revision: 4 }, holdings: [holding], catalog: { buildings: [] } };
  const proposed = clone(current);
  proposed.holdings[0].people.list[1].workAllocations[0].normalQd = 10;
  proposed.holdings[0].people.list[1].workAllocations[1].normalQd = 10;
  const patch = buildPlayerPatch(current, proposed);
  assert.equal(patch.action, "buildings", "allocation edits must use the building permission category");
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
    _safeNumber: (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback),
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
    _safeNumber: (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback),
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
    _safeNumber: (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback)
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkWorkAllocationCharacterization();
  console.log("FBL Skyhold work allocations: v2 normalization, caps, authority, wages and slots passed.");
}
