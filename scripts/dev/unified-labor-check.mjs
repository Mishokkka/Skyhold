import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ResidentDomain } from "../apps/domains/resident-domain.js";
import { AssignmentDomain } from "../apps/domains/assignment-domain.js";
import { createEconomyHarness, makeHolding } from "./economy-characterization-check.mjs";
import { SkyholdData } from "../data/store.js";
import {
  holdingDaysOffPerTenday,
  normalLaborQdPerTenday,
  residentLaborCapacity
} from "../data/labor-budget.js";
import {
  LABOR_SCHEMA_VERSION,
  buildingLaborCapacityQd,
  newLaborIssues,
  normalizeBuildingLabor,
  validateBuildingLaborAndGoals
} from "../data/labor-model.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { normalizeBuilding } from "../data/normalizers/building.js";
import { normalizePerson } from "../data/normalizers/resident.js";
import {
  buildWorkAllocationTargets,
  buildingWorkAllocationsForBuilding,
  buildingWorkerIds
} from "../data/work-allocations.js";
import {
  buildingActiveWorkerSummary,
  buildingServiceBlockReasons,
  buildingServiceCapacity,
  buildingServiceEffectFactor
} from "../engines/economy/building-service.js";
import { calculatePlannedWorkerWage } from "../engines/economy/finance-obligations.js";

const resourceQty = (holding, resourceId) => (holding.storage?.resources ?? [])
  .filter((row) => row.resourceId === resourceId)
  .reduce((sum, row) => sum + Number(row.qty ?? 0), 0);

export function unifiedRuntimeFixture({ count = 1, goal = 5, reverse = false } = {}) {
  const holding = makeHolding();
  holding.id = "unified-runtime";
  holding.storage.moneyCopper = 10000;
  holding.people.list = Array.from({ length: count }, (_, index) => ({
    id: `worker-${index}`,
    name: `Worker ${index}`,
    age: 30,
    ageGroup: "Вз",
    race: "Человек",
    attributes: { strength: 4, agility: 4, wits: 4, empathy: 4 },
    workAssignment: "",
    wageDailyOverrideCopper: null,
    workAllocations: [{
      id: `alloc-${index}`,
      sourceId: "workshop",
      functionId: "production:main",
      normalQd: 20,
      overtimeQd: 0
    }]
  }));
  const line = (id, resourceId, wageDailyCopper) => ({
    id,
    source: "workers",
    resourceId,
    outputQty: 1,
    workQd: 1,
    wageDailyCopper,
    autoCollect: "building",
    active: true
  });
  holding.buildings.list = [{
    id: "workshop",
    name: "Workshop",
    constructionStatus: "built",
    status: "Построено",
    labor: { version: LABOR_SCHEMA_VERSION, capacityQd: null },
    workersMin: 0,
    workersMax: count,
    wageDailyCopper: 12,
    functions: { production: true },
    productionLines: [line("main", "wood", 12), line("reserve", "stone", 12)]
  }];
  if (reverse) holding.buildings.list[0].productionLines.reverse();
  holding.workforcePlan = {
    version: 2,
    goals: [],
    locks: [],
    productionGoals: goal === null ? [] : [{ sourceId: "workshop", functionId: "production:main", preparedUnits: goal }]
  };
  const harness = createEconomyHarness();
  harness._runFoodConsumptionForQd = () => {};
  const normalized = mergeHoldingDefaults(holding);
  return { holding: normalized, harness, building: normalized.buildings.list[0], person: normalized.people.list[0] };
}

async function runTendayWithHarness(holding, harness, id = "unified-tenday") {
  const previousView = SkyholdData.view;
  SkyholdData.view = () => ({ holdings: [holding], catalog: {} });
  try {
    return await harness._runEconomyForQd(holding, 40, { operationId: id });
  } finally {
    SkyholdData.view = previousView;
  }
}

export async function checkUnifiedLabor() {
  // 1. Building labor v2 normalization and legacy stripping
  assert.deepEqual(normalizeBuildingLabor({ mode: "passive", capacityQd: 40 }), { version: 2, capacityQd: 0 });
  assert.deepEqual(normalizeBuildingLabor({ mode: "qd" }), { version: 2, capacityQd: null });
  assert.deepEqual(normalizeBuildingLabor({ version: 2, capacityQd: 35 }), { version: 2, capacityQd: 35 });
  assert.deepEqual(normalizeBuildingLabor(undefined, { workersMax: 3 }), { version: 2, capacityQd: 60 });

  const strippedBuilding = {
    id: "mill",
    name: "Мельница",
    constructionStatus: "built",
    labor: { version: 1, mode: "staff", capacityQd: 40 },
    assignedWorkerIds: ["p1"],
    maintenance: { requiredPoints: 5 },
    functions: { production: true },
    productionLines: [{ id: "flour", active: true, source: "workers", workQd: 2, resourceId: "grain", outputQty: 1 }]
  };
  normalizeBuilding(strippedBuilding);
  assert.deepEqual(strippedBuilding.labor, { version: 2, capacityQd: 40 });
  assert.equal(Object.hasOwn(strippedBuilding.labor, "mode"), false);
  assert.equal(Object.hasOwn(strippedBuilding, "assignedWorkerIds"), false);
  assert.equal(Object.hasOwn(strippedBuilding, "maintenance"), false);

  const strippedPerson = {
    id: "p1",
    name: "Мастер",
    age: 28,
    race: "Человек",
    salary: 14,
    salaryModifier: 2,
    maintenancePointsPerTenday: 4,
    workAllocationMode: "explicit",
    workAllocations: [{ sourceId: "mill", functionId: "production:flour", normalQd: 10 }]
  };
  normalizePerson(strippedPerson);
  assert.equal(Object.hasOwn(strippedPerson, "salary"), false);
  assert.equal(Object.hasOwn(strippedPerson, "salaryModifier"), false);
  assert.equal(Object.hasOwn(strippedPerson, "maintenancePointsPerTenday"), false);
  assert.equal(Object.hasOwn(strippedPerson, "workAllocationMode"), false);
  assert.equal(strippedPerson.wageDailyOverrideCopper, null);

  // 2. Holding daysOffPerTenday budget & age capacities
  assert.equal(holdingDaysOffPerTenday({ gm: { labor: { daysOffPerTenday: -2 } } }), 0);
  assert.equal(holdingDaysOffPerTenday({ gm: { labor: { daysOffPerTenday: 9 } } }), 5);
  assert.equal(normalLaborQdPerTenday({ gm: { labor: { daysOffPerTenday: 2 } } }), 16);
  assert.deepEqual(residentLaborCapacity({ age: 30, ageGroup: "Вз", race: "Человек" }, { gm: { labor: { daysOffPerTenday: 2 } } }), { normalQd: 16, overtimeQd: 8 });
  assert.deepEqual(residentLaborCapacity({ age: 65, ageGroup: "Ст", race: "Человек" }, { gm: { labor: { daysOffPerTenday: 2 } } }), { normalQd: 16, overtimeQd: 8 });
  assert.deepEqual(residentLaborCapacity({ age: 12, ageGroup: "Ре", race: "Человек" }, { gm: { labor: { daysOffPerTenday: 2 } } }), { normalQd: 8, overtimeQd: 0 });
  assert.deepEqual(residentLaborCapacity({ age: 10, ageGroup: "Ре", race: "Человек" }, { gm: { labor: { daysOffPerTenday: 2 } } }), { normalQd: 0, overtimeQd: 0 });

  // 3. Split QD validation, capacity cap, hard admission + GM override, composition & CHUDOTVORETS exclusion, newLaborIssues
  const clinic = {
    id: "clinic",
    name: "Больница",
    constructionStatus: "built",
    labor: { version: 2, capacityQd: 40 },
    activation: { minOperationalQd: 20 },
    functions: { culture: true, production: true },
    service: { capacityBase: 6, capacityPerWorker: 2 },
    workerProfile: {
      admission: { hard: true, text: "СИЛ 4+", clauses: [[{ attribute: "strength", minimum: 4 }]] },
      composition: [{ count: 1, group: "МЕДИЦИНА", backgrounds: ["Лекарь"] }, { count: 1, group: "ЧУДОТВОРЕЦ" }]
    },
    productionLines: [
      { id: "herbs", active: true, source: "workers", workQd: 2, resourceId: "grain", outputQty: 1, overtime: true },
      { id: "care", active: true, source: "workers", workQd: 2, resourceId: "wood", outputQty: 1, overtime: false }
    ]
  };
  const healer = {
    id: "healer",
    name: "Целитель",
    age: 30,
    attributes: { strength: 4, agility: 3, wits: 4, empathy: 4 },
    background: "Лекарь",
    workAllocations: [{ sourceId: "clinic", functionId: "culture", normalQd: 16 }]
  };
  const weak = {
    id: "weak",
    name: "Слабый",
    age: 30,
    attributes: { strength: 2, agility: 3, wits: 3, empathy: 3 },
    background: "Земледелец",
    workAllocations: [{ sourceId: "clinic", functionId: "production:herbs", normalQd: 4 }]
  };
  const checkHolding = mergeHoldingDefaults({
    gm: { labor: { daysOffPerTenday: 2 } },
    buildings: { list: [clinic] },
    people: { list: [healer, weak] }
  });
  const targets = buildWorkAllocationTargets(checkHolding);
  const denied = validateBuildingLaborAndGoals(checkHolding, { targets });
  assert.ok(denied.issues.some((i) => i.code === "admission-denied" && i.personId === "weak"));
  assert.equal(denied.issues.some((i) => i.code === "composition-unmet"), false, "CHUDOTVORETS must be excluded from labor validation");

  // Extending an existing ineligible assignment must trigger newLaborIssues (actual 4 -> 8)
  const worsenedHolding = structuredClone(checkHolding);
  worsenedHolding.people.list[1].workAllocations[0].normalQd = 8;
  assert.ok(newLaborIssues(denied.issues, validateBuildingLaborAndGoals(worsenedHolding, { targets }).issues).some((i) => i.code === "admission-denied"));

  // Adding GM override + testing split QD & building cap
  checkHolding.buildings.list[0].workerAdmissionOverrideIds = ["weak"];
  checkHolding.people.list[1].workAllocations = [
    { sourceId: "clinic", functionId: "production:herbs", normalQd: 12, overtimeQd: 0 },
    { sourceId: "clinic", functionId: "culture", normalQd: 4, overtimeQd: 0 }
  ];
  assert.equal(validateBuildingLaborAndGoals(checkHolding, { targets }).ok, true);
  assert.deepEqual(buildingWorkerIds(checkHolding, "clinic"), ["healer", "weak"]);
  assert.equal(buildingWorkAllocationsForBuilding(checkHolding.people.list[0], "clinic").length, 1);
  assert.equal(buildingWorkAllocationsForBuilding(checkHolding.people.list[1], "clinic").length, 2);

  const overNonOt = structuredClone(checkHolding);
  overNonOt.people.list[1].workAllocations = [{ sourceId: "clinic", functionId: "production:care", normalQd: 17, overtimeQd: 0 }];
  assert.ok(validateBuildingLaborAndGoals(overNonOt, { targets }).issues.some((i) => i.code === "overtime-disallowed"));

  const overBuildingCap = structuredClone(checkHolding);
  overBuildingCap.people.list[0].workAllocations = [{ sourceId: "clinic", functionId: "culture", normalQd: 16, overtimeQd: 8 }];
  overBuildingCap.people.list[1].workAllocations = [{ sourceId: "clinic", functionId: "production:herbs", normalQd: 16, overtimeQd: 4 }];
  assert.ok(validateBuildingLaborAndGoals(overBuildingCap, { targets }).issues.some((i) => i.code === "building-capacity-exceeded"));

  // 4. Binary minOperationalQd activation, daysOffPerTenday equivalentWorkers, fuelBlocked, no trace lag
  const tavern = {
    id: "tavern",
    name: "Трактир",
    constructionStatus: "built",
    labor: { version: 2, capacityQd: 40 },
    activation: { minOperationalQd: 20 },
    functions: { culture: true },
    service: { capacityBase: 10, capacityPerWorker: 4 },
    serviceState: { periodKey: "", workedQd: 0, active: false }
  };
  const barmaid = {
    id: "barmaid",
    name: "Трактирщица",
    age: 26,
    attributes: { strength: 3, agility: 3, wits: 3, empathy: 4 },
    workAllocations: [{ sourceId: "tavern", functionId: "culture", normalQd: 16, overtimeQd: 0 }]
  };
  const serviceHolding = mergeHoldingDefaults({
    gm: { labor: { daysOffPerTenday: 2 } },
    buildings: { list: [tavern] },
    people: { list: [barmaid] }
  });
  assert.equal(buildingServiceEffectFactor(serviceHolding, serviceHolding.buildings.list[0]), 0, "16 QD < 20 minOperationalQd => 0% binary gate");
  serviceHolding.people.list[0].workAllocations[0].overtimeQd = 4; // 16 + 4 = 20 QD
  const summary = buildingActiveWorkerSummary(serviceHolding, serviceHolding.buildings.list[0]);
  assert.equal(summary.qd, 20);
  assert.equal(summary.fullWorkerQd, 16);
  assert.equal(buildingServiceEffectFactor(serviceHolding, serviceHolding.buildings.list[0]), 1, "20 QD >= 20 minOperationalQd activates immediately at 100%");
  assert.ok(buildingServiceCapacity(serviceHolding, serviceHolding.buildings.list[0]) >= 14);
  serviceHolding.buildings.list[0].serviceState = { fuelBlocked: true, functionId: "culture", reason: "Нет дров" };
  assert.ok(buildingServiceBlockReasons(serviceHolding, serviceHolding.buildings.list[0]).reasons.some((r) => r.code === "service-stopped"));

  // 5. Resident tab "Смешанная" label & breakdown tooltip
  const residentHarness = {
    ...AssignmentDomain,
    ...ResidentDomain,
    _safeNumber: (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback),
    _constructionCrews: () => [],
    _calculatePersonMorale: () => ({ total: 0, breakdown: [] }),
    _residentHousingIndex: () => new Map(),
    _homeLabel: () => "Дом",
    _personNote: () => "",
    _traitBadges: () => [],
    _parseTraits: () => [],
    _personMatchesResidentFilters: () => true,
    _isChildResident: () => false,
    _canResidentWork: () => true,
    _workerType: () => "СИЛ",
    _workerTypeStyle: () => "",
    _attributeSummary: () => "",
    _ageGroup: () => "Вз",
    _ageLine: () => "30"
  };
  const mixedPerson = {
    id: "mix",
    name: "Универсал",
    age: 30,
    race: "Человек",
    workAllocations: [
      { id: "a1", sourceId: "clinic", functionId: "culture", normalQd: 8, overtimeQd: 0 },
      { id: "a2", sourceId: "tavern", functionId: "culture", normalQd: 8, overtimeQd: 2 }
    ]
  };
  const mixHolding = mergeHoldingDefaults({
    buildings: { list: [clinic, tavern] },
    people: { list: [mixedPerson] }
  });
  const rows = residentHarness._preparePersonRows(mixHolding, false, "residents", false, { canEditInlineWork: true });
  assert.equal(rows[0].workLabel, "Смешанная");
  assert.equal(rows[0].mixedWork, true);
  assert.match(rows[0].workTooltip, /Больница/);
  assert.match(rows[0].workTooltip, /Трактир/);

  // 6. Economy execution: multi-step collectProgressQd accumulation + wage override calculation
  const prod = unifiedRuntimeFixture({ count: 1, goal: null });
  prod.holding.buildings.list[0].productionLines = [{
    id: "timber",
    source: "workers",
    resourceId: "wood",
    outputQty: 2,
    workQd: 5,
    collectQd: 2,
    requiresCollection: true,
    autoCollect: "worker",
    wageDailyCopper: 10,
    active: true
  }];
  prod.holding.people.list[0].workAllocations = [{ id: "w1", sourceId: "workshop", functionId: "production:timber", normalQd: 20, overtimeQd: 0 }];
  prod.holding.people.list[0].wageDailyOverrideCopper = 20;
  await runTendayWithHarness(prod.holding, prod.harness, "collect-step");
  assert.equal(resourceQty(prod.holding, "wood"), 4, "multi-step collection + workProgressUnits finishes full cycles across 20 QD");
  assert.equal(prod.holding.storage.moneyCopper, 10000 - 200, "resident wageDailyOverrideCopper (20 MM/day * 10 days = 200 MM) overrides building wage");

  // 7. Wage math with proportional QD + 2x overtimeqd rate
  const wage = calculatePlannedWorkerWage({
    id: "w",
    wageOverrideCopper: 14,
    assignments: [{ sourceId: "workshop", functionId: "production:main", normalQd: 10, overtimeQd: 4, dailyRateCopper: 6 }]
  });
  // 10 * 14/2 + 4 * 14 = 70 + 56 = 126 MM
  assert.equal(wage.dueCopper, 126);

  return { ok: true, templatesChecked: true, mixedWorkVerified: true, capacityQd: buildingLaborCapacityQd(strippedBuilding) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkUnifiedLabor();
  console.log("FBL Skyhold unified labor checks passed.");
}
