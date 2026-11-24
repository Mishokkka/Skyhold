import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ResidentDomain } from "../apps/domains/resident-domain.js";
import { AssignmentDomain } from "../apps/domains/assignment-domain.js";
import { BuildingRowsDomain } from "../apps/domains/building/rows-domain.js";
import { BuildingWorkerDomain } from "../apps/domains/building/worker-domain.js";
import { controlResidentAvailable } from "../apps/domains/control-context.js";
import {
  applyWorkforceDraft,
  buildWorkforceModel,
  createWorkforceDraft,
  proposeWorkforceAssignments,
  workforceCandidate,
  workforceDraftError
} from "../apps/domains/workforce-planner.js";
import { workforceTaskGroups } from "../apps/domains/workforce-planner-view.js";
import { workforceTaskState } from "../apps/domains/workforce-task-state.js";
import { applyBattleConditionToPerson } from "../apps/mass-combat/casualties.js";
import { defenseGarrisonProfile } from "../apps/mass-combat/sources.js";
import { BuildingMetaDomain } from "../apps/domains/building/meta-domain.js";
import { EconomyEventDomain } from "../apps/domains/events/economy-events.js";
import { createEconomyHarness, makeHolding } from "./economy-characterization-check.mjs";
import { DEFAULT_BUILDING_TEMPLATES } from "../data/building-templates.js";
import { SkyholdData } from "../data/store.js";
import {
  daysOffConflictSummary,
  holdingDaysOffPerTenday,
  normalLaborQdPerTenday,
  residentLaborCapacity
} from "../data/labor-budget.js";
import {
  LABOR_SCHEMA_VERSION,
  buildingLaborCapacityQd,
  newLaborIssues,
  normalizeBuildingLabor,
  reservedOccupation,
  validateBuildingLaborAndGoals
} from "../data/labor-model.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { normalizeBuilding } from "../data/normalizers/building.js";
import { normalizePerson } from "../data/normalizers/resident.js";
import {
  MAX_WORK_ALLOCATIONS_PER_PERSON,
  buildWorkAllocationTargets,
  buildingWorkAllocationsForBuilding,
  buildingWorkerIds,
  normalizeWorkAllocation
} from "../data/work-allocations.js";
import {
  buildingActiveWorkerSummary,
  buildingServiceBlockReasons,
  buildingServiceCapacity,
  buildingServiceEffectFactor
} from "../engines/economy/building-service.js";
import { calculatePlannedWorkerWage } from "../engines/economy/finance-obligations.js";
import { financePeriodIdentity } from "../engines/economy/finance-period.js";
import { militaryDailyWage } from "../engines/economy/military-wages.js";
import { gmMoveWorldShip } from "../engines/ships/gm-override.js";
import { storageProfileEffectFactor } from "../engines/storage/specialization.js";
import { getSkyholdWorkflowService } from "../workflows/skyhold-workflow-service.js";

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
    wageDailyCopper: 12,
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
  const barmaidHelper = {
    id: "barmaid-2",
    name: "Помощница",
    age: 25,
    attributes: { strength: 3, agility: 3, wits: 3, empathy: 3 },
    workAllocations: []
  };
  const serviceHolding = mergeHoldingDefaults({
    gm: { labor: { daysOffPerTenday: 2 } },
    buildings: { list: [tavern] },
    people: { list: [barmaid, barmaidHelper] }
  });
  assert.equal(buildingServiceEffectFactor(serviceHolding, serviceHolding.buildings.list[0]), 0, "16 QD < 20 minOperationalQd => 0% binary gate");
  serviceHolding.people.list[1].workAllocations = [{ sourceId: "tavern", functionId: "culture", normalQd: 4, overtimeQd: 0 }]; // 16 + 4 = 20 QD
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

  // 8. CodeRabbit review regression contracts
  // 8a. Preserve legacy military salaryModifier, staffAppointment, assignedWorkerIds, and row-level volunteer
  const legacyWorld = mergeHoldingDefaults({
    gm: {
      defense: {
        squads: [{ id: "sq1", type: "line", sergeantId: "", memberIds: ["soldier-legacy"] }]
      }
    },
    buildings: {
      list: [
        {
          id: "legacy-mill",
          name: "Старая мельница",
          constructionStatus: "built",
          labor: { version: 2, capacityQd: 40 },
          functions: { production: true },
          productionLines: [{ id: "flour", active: true, source: "workers", resourceId: "flour", outputQty: 1, workQd: 1 }],
          assignedWorkerIds: ["legacy-worker"]
        },
        {
          id: "legacy-inn",
          name: "Старый трактир",
          constructionStatus: "built",
          labor: { version: 2, capacityQd: 40 },
          functions: { income: true },
          income: { base: 40, perWorker: 0 }
        }
      ]
    },
    people: {
      list: [
        { id: "soldier-legacy", name: "Боец", age: 25, workAssignment: "soldier", salaryModifier: 3 },
        { id: "legacy-worker", name: "Мельник", age: 30, attributes: { strength: 4, agility: 3, wits: 3, empathy: 3 } },
        {
          id: "staff-worker",
          name: "Штатный",
          age: 29,
          attributes: { strength: 3, agility: 3, wits: 3, empathy: 4 },
          staffAppointment: { buildingId: "legacy-inn", functionId: "income", normalQd: 12, overtimeQd: 4, dailyRateCopper: 18 }
        },
        {
          id: "vol-worker",
          name: "Волонтёр",
          age: 27,
          volunteerLabor: false,
          workAllocations: [{ sourceId: "legacy-inn", functionId: "income", normalQd: 10, overtimeQd: 0, volunteer: true, volunteerReason: "Обет" }]
        }
      ]
    }
  });
  const migratedSoldier = legacyWorld.people.list.find((p) => p.id === "soldier-legacy");
  const migratedMiller = legacyWorld.people.list.find((p) => p.id === "legacy-worker");
  const migratedStaff = legacyWorld.people.list.find((p) => p.id === "staff-worker");
  const migratedVolunteer = legacyWorld.people.list.find((p) => p.id === "vol-worker");
  assert.equal(migratedSoldier.militarySalaryModifier, 3, "military salaryModifier (+3) preserves relative military offset");
  assert.equal(migratedSoldier.wageDailyOverrideCopper, null, "military salaryModifier must not freeze wageDailyOverrideCopper");
  assert.equal(militaryDailyWage(legacyWorld, migratedSoldier), 15, "relative military offset +3 over 12 MM line base produces 15 MM");
  assert.equal(Object.hasOwn(migratedStaff, "staffAppointment"), false);
  assert.equal(Object.hasOwn(legacyWorld.buildings.list[0], "assignedWorkerIds"), false);
  assert.deepEqual(migratedMiller.workAllocations.map((r) => ({ sourceId: r.sourceId, functionId: r.functionId, normalQd: r.normalQd })),
    [{ sourceId: "legacy-mill", functionId: "production:flour", normalQd: 20 }]);
  assert.deepEqual(migratedStaff.workAllocations.map((r) => ({ sourceId: r.sourceId, functionId: r.functionId, normalQd: r.normalQd, overtimeQd: r.overtimeQd })),
    [{ sourceId: "legacy-inn", functionId: "income", normalQd: 12, overtimeQd: 4 }]);
  assert.equal(migratedStaff.wageDailyOverrideCopper, 18);
  assert.equal(migratedVolunteer.workAllocations[0].volunteer, true);
  assert.equal(migratedVolunteer.workAllocations[0].volunteerReason, "Обет");
  assert.equal(normalizeWorkAllocation({ sourceId: "a", functionId: "b", normalQd: 2, volunteer: true, volunteerReason: "Долг" }).volunteer, true);

  // 8b. Normal cap vs total cap, away resident exclusion, shoreDuty, injury workAllocations retention
  const capProbe = mergeHoldingDefaults({
    buildings: { list: [clinic] },
    people: {
      list: [
        { id: "over-normal", name: "Сверхнормы", age: 30, attributes: { strength: 5, agility: 3, wits: 3, empathy: 3 }, workAllocations: [{ sourceId: "clinic", functionId: "production:herbs", normalQd: 21, overtimeQd: 0 }] },
        { id: "bad-ratio", name: "Отношение", age: 30, attributes: { strength: 5, agility: 3, wits: 3, empathy: 3 }, workAllocations: [{ sourceId: "clinic", functionId: "production:herbs", normalQd: 6, overtimeQd: 4 }] },
        { id: "away-stuck", name: "Уплывший", age: 30, attributes: { strength: 5, agility: 3, wits: 3, empathy: 3 }, shipAssignment: { shipId: "s1", away: true }, workAllocations: [{ sourceId: "clinic", functionId: "production:herbs", normalQd: 20, overtimeQd: 0 }] },
        { id: "shore-sailor", name: "Береговой", age: 30, shipAssignment: { shipId: "s1", away: false, shoreDuty: true }, workAssignment: "ship:s1" }
      ]
    },
    special: { ships: { list: [{ id: "s1", name: "Линкор", crewResidentIds: ["away-stuck", "shore-sailor"] }] } }
  });
  const capCheck = validateBuildingLaborAndGoals(capProbe, { targets: buildWorkAllocationTargets(capProbe) });
  assert.ok(capCheck.issues.some((i) => i.code === "resident-normal-cap" && i.personId === "over-normal"));
  assert.ok(capCheck.issues.some((i) => i.code === "resident-overtime-days" && i.personId === "bad-ratio"));
  assert.equal(capCheck.issues.some((i) => i.personId === "away-stuck"), false, "away residents must be excluded from building QD validation");
  assert.equal(reservedOccupation(capProbe, capProbe.people.list[3]), null, "sailor on shoreDuty is free for civilian QD jobs");

  const shipFallbackData = { catalog: { eventRegions: [{ value: "port-a", label: "Порт А" }] }, holdings: [structuredClone(capProbe)] };
  const hShip = shipFallbackData.holdings[0];
  hShip.special.ships.list[0] = { id: "s1", name: "Ладья", navigationMode: "world", status: "docked", location: { kind: "home", id: "home", label: "Дом" }, crewResidentIds: ["shore-sailor", "missing-id"] };
  hShip.people.list[3].workAllocations = [{ id: "sh1", sourceId: "clinic", functionId: "culture", normalQd: 10, overtimeQd: 0 }];
  delete hShip.people.list[3].shipAssignment;
  gmMoveWorldShip(shipFallbackData, hShip, hShip.special.ships.list[0], { destinationKind: "market", destinationId: "port-a", clockQd: 40 });
  assert.deepEqual(hShip.people.list[3].workAllocations, [], "emergency syncCrewForForeignPort must clear civilian workAllocations");

  const injuredPerson = { id: "guard-1", workAllocations: [{ id: "g1", sourceId: "clinic", functionId: "culture", normalQd: 10, overtimeQd: 0 }] };
  const injuredHolding = { people: { list: [injuredPerson] }, buildings: { list: [] } };
  applyBattleConditionToPerson(injuredHolding, injuredPerson, "injured", { days: 2 });
  assert.equal(injuredPerson.workAllocations.length, 0, "battle injury clears workAllocations to free building capacityQd");
  injuredPerson.workAllocations = [{ id: "g2", sourceId: "clinic", functionId: "culture", normalQd: 10, overtimeQd: 0 }];
  applyBattleConditionToPerson(injuredHolding, injuredPerson, "dead");
  assert.equal(injuredPerson.workAllocations.length, 0, "death clears workAllocations");

  // 8c. Binary minOperationalQd gating: fixed income base = 100%, trade, agriculture, livestock, time/content lines, storage profile
  const gateHarness = createEconomyHarness();
  gateHarness._runFoodConsumptionForQd = () => {};
  const gateHolding = mergeHoldingDefaults({
    buildings: {
      list: [
        { id: "fixed-inn", name: "Гостиница", constructionStatus: "built", labor: { version: 2, capacityQd: 40 }, activation: { minOperationalQd: 10 }, functions: { income: true }, income: { base: 100, perWorker: 0 } },
        { id: "shop-min", name: "Лавка", constructionStatus: "built", labor: { version: 2, capacityQd: 40 }, activation: { minOperationalQd: 20 }, functions: { income: true }, income: { trade: { enabled: true, throughputUnitsPerWorker: 10, demandBudgetBaseCopper: 100, demandBudgetPerWorkerCopper: 20 } } },
        { id: "field-min", name: "Поле", constructionStatus: "built", labor: { version: 2, capacityQd: 40 }, activation: { minOperationalQd: 20 }, functions: { production: true }, agriculture: { enabled: true, kind: "field", activeCropId: "barley", crops: [{ id: "barley", label: "Ячмень", seasons: ["spring", "summer", "autumn", "winter"], yieldQty: 5, harvestWorkQd: 4, sowingWorkQd: 4 }], state: { phase: "sowing", sowingProgressQd: 0 } } },
        { id: "pasture-min", name: "Пастбище", constructionStatus: "built", labor: { version: 2, capacityQd: 40 }, activation: { minOperationalQd: 20 }, functions: { production: true }, livestock: { enabled: true, speciesId: "chicken", state: { adults: 2, breedingMales: 1 } } },
        { id: "time-min", name: "Сушилка", constructionStatus: "built", labor: { version: 2, capacityQd: 40 }, activation: { minOperationalQd: 20 }, functions: { production: true }, productionLines: [{ id: "dry", active: true, source: "time", period: "day", workQd: 1, resourceId: "wood", outputQty: 2 }, { id: "cont", active: true, source: "content", period: "qd", workQd: 1, resourceId: "stone", outputQty: 1 }] },
        { id: "store-req", name: "Кладовая", constructionStatus: "built", labor: { version: 2, capacityQd: 40 }, activation: { minOperationalQd: 0 }, functions: { storage: true }, storage: { profileRequiresStaff: true, profileResourceIds: ["wood"] } }
      ]
    },
    people: {
      list: [
        {
          id: "u1", name: "Работник", age: 30, attributes: { strength: 4, agility: 4, wits: 4, empathy: 4 }, volunteerLabor: true,
          workAllocations: [
            { sourceId: "fixed-inn", functionId: "income", normalQd: 10 },
            { sourceId: "shop-min", functionId: "income", normalQd: 4 },
            { sourceId: "field-min", functionId: "agriculture", normalQd: 4 },
            { sourceId: "pasture-min", functionId: "livestock", normalQd: 2 }
          ]
        }
      ]
    }
  });
  gateHolding.buildings.list[4].contents = [{ id: "c1", name: "Руда", qty: 5 }];
  const gateReport = { produced: [], consumed: [], skipped: [], income: [], formulas: [], work: [], ledger: [] };
  const gateInputs = gateHarness._financePlanInputs(gateHolding, 40, { periodKey: "t1", periodIndex: 1 });
  const gateFinanceCtx = gateHarness._financeExecutionContext({}, {
    oldBlockers: gateInputs.oldBlockers,
    plannedWorkers: gateInputs.workers,
    periodQd: 40
  });
  const gateWorkerCtx = gateHarness._economyWorkerContext(gateHolding, { financeContext: gateFinanceCtx });
  await gateHarness._runBuildingIncomeForQd(gateHolding, 40, gateReport, { workerContext: gateWorkerCtx, financeContext: gateFinanceCtx });
  assert.equal(gateHolding.storage.moneyCopper, 100, "once minOperationalQd (10 QD) is met, fixed income base applies at 100%");
  assert.equal(gateHarness._internalDemandChannels(gateHolding, gateFinanceCtx, 1, gateWorkerCtx).channels.length, 0, "trade channel blocked below minOperationalQd");
  assert.equal(gateHarness._agricultureAvailableWorkQd(gateHolding, gateHolding.buildings.list[2], 40, gateWorkerCtx), 0, "agriculture blocked below minOperationalQd");
  assert.equal(gateHarness._livestockAvailableWorkQd(gateHolding, gateHolding.buildings.list[3], 40, gateWorkerCtx, 0), 0, "livestock blocked below minOperationalQd");
  await gateHarness._runProductionCycleForQd(gateHolding, 4, gateReport, { workerContext: gateWorkerCtx, financeContext: gateFinanceCtx });
  assert.equal(resourceQty(gateHolding, "wood"), 0, "time line does not start new batch below minOperationalQd");
  assert.equal(resourceQty(gateHolding, "stone"), 0, "content line does not fire below minOperationalQd");
  assert.equal(storageProfileEffectFactor(gateHolding, gateHolding.buildings.list[5]), 0, "profileRequiresStaff=true must return 0 without storage worker");

  // 8d. Consumer collection uses remainingCollectQd, resets collectProgressQd, and paused task reports remaining
  const consumer = { id: "cons", name: "Потребитель", constructionStatus: "built", labor: { version: 2, capacityQd: 40 }, functions: { production: true } };
  const sourceMill = {
    id: "src-mill", name: "Мельница", constructionStatus: "built", labor: { version: 2, capacityQd: 40 }, functions: { production: true },
    productionLines: [{ id: "pl", active: true, source: "workers", resourceId: "grain", outputQty: 2, requiresCollection: true, collectQd: 2, collectProgressQd: 1, pendingQty: 2, autoCollect: "worker", storageRoomId: "outdoors" }]
  };
  const collectHolding = mergeHoldingDefaults({
    buildings: { list: [sourceMill, consumer] },
    people: { list: [{ id: "c1", name: "Сборщик", age: 30, workAllocations: [{ sourceId: "cons", functionId: "production:use", normalQd: 2 }] }] }
  });
  const budgets = new Map([["c1", { available: 1, spent: 0 }]]);
  const collectedQty = await gateHarness._tryCollectResourceForConsumer(collectHolding, collectHolding.buildings.list[1], { resourceId: "grain" }, budgets, { produced: [], consumed: [], skipped: [], ledger: [] }, null, null, "production:use");
  assert.equal(collectedQty, 2, "1 remaining QD suffices when collectProgressQd=1 of collectQd=2");
  assert.equal(collectHolding.buildings.list[0].productionLines[0].collectProgressQd, 0, "consumer collection resets collectProgressQd");
  const pausedState = workforceTaskState(collectHolding, { kind: "production", functionId: "production:pl", paused: true, collectionAvailable: true }, { productionLines: [{ id: "pl", collectQd: 10, collectProgressQd: 8, pendingQty: 2 }] }, gateHarness, null);
  assert.equal(pausedState.need, 2, "paused collection task subtracts collectProgressQd");

  // 8e. Distinct-source Mixed label, Control partial QD + scoped remove + "План QD" reset + 24-row cap
  const sameBldgPerson = {
    id: "same-bldg", name: "ДвеФункции", age: 30, race: "Человек", role: "План QD",
    workAllocations: [
      { id: "r1", sourceId: "clinic", functionId: "culture", normalQd: 8, overtimeQd: 0 },
      { id: "r2", sourceId: "clinic", functionId: "production:herbs", normalQd: 4, overtimeQd: 0 }
    ]
  };
  const sameHolding = mergeHoldingDefaults({ buildings: { list: [clinic, tavern] }, people: { list: [sameBldgPerson] } });
  const sameRows = residentHarness._preparePersonRows(sameHolding, false, "residents", false, { canEditInlineWork: true });
  assert.equal(sameRows[0].workLabel, "Больница", "two functions inside the same building must NOT show Смешанная");
  assert.equal(sameRows[0].mixedWork, false);
  const pausedShopHolding = mergeHoldingDefaults({
    buildings: {
      list: [{
        id: "paused-shop",
        name: "Пауза",
        constructionStatus: "built",
        labor: { version: 2, capacityQd: 40 },
        functions: { production: true },
        productionLines: [{ id: "l1", active: false, source: "workers", resourceId: "wood", outputQty: 1, workQd: 1, pendingQty: 0 }]
      }]
    },
    people: { list: [] }
  });
  assert.equal(residentHarness._residentWorkOptionsContext(pausedShopHolding).availableBuildingIds.has("paused-shop"), false,
    "built workshop with only paused line and no collection must be excluded from availableBuildingIds");

  const ctrlBuilding = { id: "guard", name: "Охрана", constructionStatus: "built", labor: { version: 2, capacityQd: 40 }, functions: { defense: true, income: true }, income: { base: 10 }, control: { generalFlat: 2 } };
  const ctrlHolding = mergeHoldingDefaults({
    buildings: { list: [ctrlBuilding, tavern] },
    people: { list: [{ id: "p-partial", name: "Частичный", age: 30, role: "План QD", workAllocations: [{ sourceId: "tavern", functionId: "culture", normalQd: 8 }, { sourceId: "guard", functionId: "income", normalQd: 4 }] }] }
  });
  const ctrlMgr = { ...AssignmentDomain, _safeNumber: (v, f = 0) => Number.isFinite(Number(v)) ? Number(v) : f, _canResidentWork: () => true, _isChildResident: () => false };
  assert.equal(controlResidentAvailable(ctrlHolding, ctrlHolding.people.list[0], ctrlMgr), true, "resident with partial free QD is available for Control building");
  assert.equal(controlResidentAvailable(ctrlHolding, ctrlHolding.people.list[0], ctrlMgr, { sheriff: true }), false, "resident with existing QD is not eligible for Sheriff");
  assert.equal(ctrlMgr._assignPersonToBuilding(ctrlHolding, "p-partial", "guard", { functionId: "defense", qd: 4 }), true);
  assert.equal(ctrlMgr._removePersonFromBuilding(ctrlHolding, "guard", "p-partial", { functionId: "defense" }), true);
  assert.ok(ctrlHolding.people.list[0].workAllocations.some((r) => r.sourceId === "guard" && r.functionId === "income"), "removing Control function preserves income allocation");
  ctrlMgr._removePersonFromBuilding(ctrlHolding, "guard", "p-partial");
  ctrlMgr._removePersonFromBuilding(ctrlHolding, "tavern", "p-partial");
  assert.equal(ctrlHolding.people.list[0].role, "Свободен", "removing last active row resets План QD role");

  const cap24 = ctrlHolding.people.list[0];
  cap24.workAllocations = Array.from({ length: MAX_WORK_ALLOCATIONS_PER_PERSON }, (_, i) => ({ id: `x${i}`, sourceId: `other-${i}`, functionId: "culture", normalQd: 0 }));
  const outReason = {};
  assert.equal(ctrlMgr._assignPersonToBuilding(ctrlHolding, cap24.id, "guard", { functionId: "defense", out: outReason }), false, "cannot push 25th row past MAX_WORK_ALLOCATIONS_PER_PERSON");
  assert.match(outReason.reason, /лимит/i);

  // 8f. Planner unavailable reservation, object productionGoals, task-scoped composition
  const planHolding = mergeHoldingDefaults({
    buildings: {
      list: [{
        id: "w-comp", name: "Лазарет", constructionStatus: "built", labor: { version: 2, capacityQd: 20 },
        functions: { income: true, culture: true }, income: { base: 10 },
        workerProfile: { composition: [{ count: 1, group: "МЕДИЦИНА", backgrounds: ["Лекарь"] }] }
      }]
    },
    people: {
      list: [
        { id: "doc-income", name: "ДокторНаДоходе", age: 30, background: "Лекарь", volunteerLabor: true, workAllocations: [{ sourceId: "w-comp", functionId: "income", normalQd: 10 }] },
        { id: "helper-culture", name: "Санитар", age: 30, background: "Земледелец", volunteerLabor: true, workAllocations: [{ sourceId: "w-comp", functionId: "culture", normalQd: 4 }] },
        { id: "inj-worker", name: "Раненый", age: 30, injuredDays: 4, volunteerLabor: true, workAllocations: [{ sourceId: "w-comp", functionId: "culture", normalQd: 6 }] },
        { id: "free-worker", name: "Свободный", age: 30, volunteerLabor: true, workAllocations: [] }
      ]
    },
    workforcePlan: { version: 2, locks: [], productionGoals: { "w-comp::income": 3 } }
  });
  const planDraft = createWorkforceDraft(planHolding);
  assert.deepEqual(planDraft.plan.productionGoals, [{ sourceId: "w-comp", functionId: "income", preparedUnits: 3 }], "object productionGoals preserved as array");
  const planModel = buildWorkforceModel(planHolding, planDraft, gateHarness, { isGM: true });
  assert.equal(planModel.reservedQdByBuilding.get("w-comp"), 20, "reservedQdByBuilding includes injured/unavailable worker QD");
  assert.match(workforceTaskGroups(planModel)[0].capacityText, /20 \/ 20 QD/);
  const freePersonRow = planModel.people.find((p) => p.id === "free-worker");
  const cultureTask = planModel.tasks.find((t) => t.functionId === "culture");
  assert.match(workforceCandidate(planModel, freePersonRow, cultureTask, gateHarness).reason, /Предел труда здания исчерпан/);
  assert.ok(cultureTask.warnings.some((w) => /обязательный состав/i.test(w)), "income specialist does not satisfy culture composition");
  applyWorkforceDraft(planHolding, planDraft);
  assert.equal(planHolding.workforcePlan.productionGoals[0].preparedUnits, 3);

  // 8g. Fallback garrison efficiency QD scaling, stale workAssignment morale = 0, school recovery ordering
  const gHolding = mergeHoldingDefaults({
    buildings: { list: [{ id: "fort", name: "Форт", constructionStatus: "built", labor: { version: 2, capacityQd: 40 }, functions: { defense: true }, defense: { combatTag: "garrison", workerStep: 1 } }] },
    people: { list: [{ id: "gf", name: "Гарнизонщик", age: 30, attributes: { strength: 3, agility: 3, wits: 3, empathy: 3 }, workAllocations: [{ sourceId: "fort", functionId: "defense", normalQd: 10 }] }] }
  });
  const garrisonProfileHalf = defenseGarrisonProfile(gHolding);
  gHolding.people.list[0].workAllocations[0].normalQd = 20;
  const garrisonProfileFull = defenseGarrisonProfile(gHolding);
  assert.ok(garrisonProfileFull.effective > 0 && garrisonProfileHalf.effective < garrisonProfileFull.effective,
    "fallback garrison efficiency scales down proportionally at 10/20 QD");

  const staleMorale = BuildingMetaDomain._workMoraleForPeriod.call(gateHarness, { id: "st", workAssignment: "fixed-inn", workAllocations: [] }, gateHolding);
  assert.equal(staleMorale.totalQd, 0, "stale building ID in workAssignment with empty workAllocations counts 0 QD");

  const schoolHolding = mergeHoldingDefaults({
    buildings: { list: [{ id: "school-1", name: "Школа", constructionStatus: "built", wageDailyCopper: 18, labor: { version: 2, capacityQd: 40 }, functions: { culture: true }, workerProfile: { composition: [{ count: 1, group: "УЧЁНЫЙ", backgrounds: ["Учёный"] }] } }] },
    people: { list: [{ id: "t1", name: "Учитель", age: 30, injuredDays: 1, background: "Учёный", workAllocations: [{ sourceId: "school-1", functionId: "culture", normalQd: 20 }] }] }
  });
  const schoolHarness = {
    ...EconomyEventDomain,
    _safeNumber: (v, f = 0) => Number.isFinite(Number(v)) ? Number(v) : f
  };
  const preRecoverySchool = schoolHarness._schoolEducationContext(schoolHolding);
  schoolHarness._advanceResidentRecovery(schoolHolding, 10);
  assert.equal(preRecoverySchool.active, false, "injured teacher before recovery yields inactive period school");
  assert.equal(schoolHarness._schoolEducationContext(schoolHolding).active, true, "post-recovery school becomes active next period");

  // 9. Audit P1/P2 findings #1-#10 regression contracts
  // 9.1 Legacy staffAppointment (primaryFunctionId/reserveFunctionId/volunteer), away sailor & v1 capacityQd
  const v1Holding = mergeHoldingDefaults({
    buildings: {
      list: [
        {
          id: "shop-v1", name: "Цех v1", constructionStatus: "built", workersMax: 1, wageDailyCopper: 12,
          labor: { version: 1, mode: "staff", capacityQd: null }, functions: { production: true },
          productionLines: [
            { id: "lineA", active: true, source: "workers", resourceId: "wood", outputQty: 1, workQd: 1 },
            { id: "lineB", active: true, source: "workers", resourceId: "stone", outputQty: 1, workQd: 1 },
            { id: "lineC", active: true, source: "workers", resourceId: "grain", outputQty: 1, workQd: 1 }
          ]
        },
        { id: "shop-v2-null", name: "Безлимит v2", constructionStatus: "built", workersMax: 1, labor: { version: 2, capacityQd: null }, functions: { production: true } }
      ]
    },
    people: {
      list: [
        {
          id: "app-1", name: "ДоброволецШтата", age: 30, volunteerLabor: false, workAssignment: "shop-v1",
          staffAppointment: {
            version: 1, buildingId: "shop-v1", primaryFunctionId: "production:lineB", reserveFunctionId: "production:lineC",
            wageDailyCopper: 0, overtimeQd: 0, volunteer: true, volunteerReason: "Клятва"
          }
        },
        {
          id: "away-app", name: "УплывшийШтатный", age: 30, shipAssignment: { shipId: "s1", away: true },
          staffAppointment: {
            version: 1, buildingId: "shop-v1", primaryFunctionId: "production:lineC", reserveFunctionId: "",
            wageDailyCopper: 15, overtimeQd: 0, volunteer: false, volunteerReason: ""
          }
        }
      ]
    }
  });
  assert.equal(v1Holding.buildings.list[0].labor.capacityQd, 20, "v1 staff building with capacityQd: null normalizes from workersMax (20 QD)");
  assert.equal(v1Holding.buildings.list[1].labor.capacityQd, null, "v2 building with capacityQd: null remains unlimited");
  const migratedApp = v1Holding.people.list.find((p) => p.id === "app-1");
  const migratedAwayApp = v1Holding.people.list.find((p) => p.id === "away-app");
  assert.equal(migratedApp.workAllocations.length, 1);
  assert.equal(migratedApp.workAllocations[0].functionId, "production:lineB");
  assert.equal(migratedApp.workAllocations[0].volunteer, true);
  assert.equal(migratedApp.workAllocations[0].volunteerReason, "Клятва");
  assert.equal(migratedApp.wageDailyOverrideCopper, null);
  assert.equal(migratedAwayApp.workAllocations.length, 1, "away sailor legacy staffAppointment must migrate without silently deleting assignment");
  assert.equal(migratedAwayApp.workAllocations[0].functionId, "production:lineC");
  assert.equal(migratedAwayApp.wageDailyOverrideCopper, 15);
  assert.equal(Object.hasOwn(migratedAwayApp, "staffAppointment"), false);
  const v1Reloaded = mergeHoldingDefaults(structuredClone(v1Holding));
  assert.deepEqual(v1Reloaded.people.list[0].workAllocations, migratedApp.workAllocations, "repeated load stays idempotent");

  // 9.2 Incremental & bulk multi-specialist team assembly (Hospital requires 2 МЕДИЦИНА)
  const hospitalTpl = DEFAULT_BUILDING_TEMPLATES.find((b) => b.id === "hospital");
  const hospitalHolding = mergeHoldingDefaults({
    buildings: {
      list: [
        { ...structuredClone(hospitalTpl), id: "hosp-1", constructionStatus: "built", wageDailyCopper: hospitalTpl.wageDailyCopper || 18 },
        { id: "construction-center", templateId: "construction-center", name: "Центр строительства", constructionStatus: "built", labor: { version: 2, capacityQd: 0 } }
      ]
    },
    people: {
      list: [
        { id: "doc-a", name: "Лекарь А", age: 30, attributes: { strength: 3, agility: 3, wits: 4, empathy: 4 }, background: "Лекарь" },
        { id: "doc-b", name: "Лекарь Б", age: 30, attributes: { strength: 3, agility: 3, wits: 4, empathy: 4 }, background: "Лекарь" }
      ]
    }
  });
  const hospManualFirst = structuredClone(hospitalHolding);
  hospManualFirst.people.list[0].workAllocations = [{ sourceId: "hosp-1", functionId: "medical", normalQd: 10, overtimeQd: 0 }];
  const firstDocValidation = validateBuildingLaborAndGoals(hospManualFirst, { targets: buildWorkAllocationTargets(hospManualFirst) });
  assert.equal(firstDocValidation.ok, true, "assigning 1st of 2 mandatory specialists must not fail hard validation");
  assert.ok(firstDocValidation.warnings.some((w) => w.code === "composition-unmet"), "incomplete team emits composition warning");
  assert.equal(buildingServiceBlockReasons(hospManualFirst, hospManualFirst.buildings.list[0], "medical").active, false, "hospital effect stays off until 2nd specialist joins");
  const hospProposal = proposeWorkforceAssignments(hospitalHolding, createWorkforceDraft(hospitalHolding), gateHarness, {
    isGM: true, taskKeys: ["hosp-1::medical"], useBuildingMinimum: true
  });
  assert.equal(hospProposal.changes.length, 2, "auto-proposal must assign both required hospital specialists");
  assert.equal(workforceDraftError(hospitalHolding, hospProposal.draft, { isGM: true }), "");
  const hospAssembled = applyWorkforceDraft(structuredClone(hospitalHolding), hospProposal.draft);
  assert.equal(buildingServiceBlockReasons(hospAssembled, hospAssembled.buildings.list[0], "medical").active, true);

  // 9.3 Multi-function minOperationalQd enforcement (Market, Inn, and custom building)
  const marketTpl = DEFAULT_BUILDING_TEMPLATES.find((b) => b.id === "market");
  const innTpl = DEFAULT_BUILDING_TEMPLATES.find((b) => b.id === "inn");
  const runMultiMinCheck = async (bldg, fnId, qd, extras = {}) => {
    const h = mergeHoldingDefaults({
      buildings: { list: [{ ...structuredClone(bldg), id: "m-bldg", constructionStatus: "built", wageDailyCopper: 18, ...extras }] },
      people: { list: [
        { id: "m-w1", name: "П1", age: 30, volunteerLabor: true, workAllocations: qd > 0 ? [{ sourceId: "m-bldg", functionId: fnId, normalQd: Math.min(20, qd) }] : [] },
        ...(qd > 20 ? [{ id: "m-w2", name: "П2", age: 30, volunteerLabor: true, workAllocations: [{ sourceId: "m-bldg", functionId: fnId, normalQd: qd - 20 }] }] : [])
      ] }
    });
    const inputs = gateHarness._financePlanInputs(h, 40, financePeriodIdentity(h));
    const fc = gateHarness._financeExecutionContext({}, { oldBlockers: inputs.oldBlockers, plannedWorkers: inputs.workers, periodQd: 40 });
    const wc = gateHarness._economyWorkerContext(h, { financeContext: fc });
    const ch = gateHarness._internalDemandChannels(h, fc, 1, wc).channels.length;
    return { h, fc, wc, ch };
  };
  assert.equal((await runMultiMinCheck(marketTpl, "income", 9)).ch, 0, "Market at 9/10 QD must not open trade");
  assert.equal((await runMultiMinCheck(marketTpl, "income", 10)).ch, 1, "Market at 10/10 QD opens trade");
  assert.equal((await runMultiMinCheck(marketTpl, "income", 11)).ch, 1, "Market at 11/10 QD opens trade");
  assert.equal((await runMultiMinCheck(innTpl, "income", 39)).ch, 0, "Inn at 39/40 QD must not open trade");
  assert.equal((await runMultiMinCheck(innTpl, "income", 40)).ch, 1, "Inn at 40/40 QD opens trade");
  const customMulti = mergeHoldingDefaults({
    buildings: {
      list: [{
        id: "cm-1", name: "Универсал", constructionStatus: "built", labor: { version: 2, capacityQd: 40 },
        activation: { minOperationalQd: 10, anyWorkingFunction: false }, wageDailyCopper: 12,
        functions: { culture: true, production: true, income: true },
        income: { base: 100, perWorker: 0 },
        productionLines: [{ id: "w1", active: true, source: "workers", workQd: 1, resourceId: "wood", outputQty: 1 }]
      }]
    },
    people: {
      list: [{
        id: "cm-w", name: "Мастер", age: 30, volunteerLabor: true,
        workAllocations: [{ sourceId: "cm-1", functionId: "production:w1", normalQd: 1 }, { sourceId: "cm-1", functionId: "income", normalQd: 1 }]
      }]
    }
  });
  const cmInputs = gateHarness._financePlanInputs(customMulti, 40, financePeriodIdentity(customMulti));
  const cmFc = gateHarness._financeExecutionContext({}, { oldBlockers: cmInputs.oldBlockers, plannedWorkers: cmInputs.workers, periodQd: 40 });
  const cmWc = gateHarness._economyWorkerContext(customMulti, { financeContext: cmFc });
  const cmRep = { produced: [], consumed: [], skipped: [], income: [], formulas: [], work: [], ledger: [] };
  await gateHarness._runProductionCycleForQd(customMulti, 40, cmRep, { workerContext: cmWc, financeContext: cmFc });
  await gateHarness._runBuildingIncomeForQd(customMulti, 40, cmRep, { workerContext: cmWc, financeContext: cmFc });
  assert.equal(resourceQty(customMulti, "wood"), 0, "1/10 QD production blocked on custom multi-function building");
  assert.equal(customMulti.storage.moneyCopper, 0, "1/10 QD income blocked on custom multi-function building");

  // 9.4 Public medical window hides GM-hidden doctors/patients/overflow/options from players
  const workflowService = getSkyholdWorkflowService();
  const medVisHolding = mergeHoldingDefaults({
    buildings: {
      list: [
        {
          ...structuredClone(hospitalTpl), id: "pub-hosp", name: "Городской лазарет", visibility: "public",
          constructionStatus: "built", wageDailyCopper: 18, medical: { enabled: true, patientsPerEfficiency: 5, maxPatients: 1 }
        },
        { id: "construction-center", templateId: "construction-center", name: "Центр строительства", constructionStatus: "built", labor: { version: 2, capacityQd: 0 } }
      ]
    },
    people: {
      list: [
        { id: "vis-doc-gm", name: "ТайныйДок", age: 30, visibility: "gm", background: "Лекарь", attributes: { wits: 4, empathy: 4 }, workAllocations: [{ sourceId: "pub-hosp", functionId: "medical", normalQd: 20 }] },
        { id: "vis-doc-pub", name: "ПублДок", age: 30, visibility: "public", background: "Лекарь", attributes: { wits: 4, empathy: 4 }, workAllocations: [{ sourceId: "pub-hosp", functionId: "medical", normalQd: 20 }] },
        { id: "vis-free-gm", name: "ТайныйРезерв", age: 30, visibility: "gm", background: "Лекарь", attributes: { wits: 4, empathy: 4 } },
        { id: "vis-pat-pub", name: "ПублПац", age: 30, visibility: "public", injuredDays: 2 },
        { id: "vis-pat-gm", name: "ТайныйПац", age: 30, visibility: "gm", injuredDays: 3 }
      ]
    }
  });
  const medTplLookup = { byId: new Map([["hospital", hospitalTpl]]), byName: new Map() };
  const prepMed = (isGM, canEdit) => {
    const prevContextData = workflowService._contextData;
    workflowService._contextData = { catalog: { buildings: DEFAULT_BUILDING_TEMPLATES }, holdings: [medVisHolding] };
    try {
      return workflowService._prepareBuildingRow(medVisHolding, medVisHolding.buildings.list[0], 0, canEdit, [], {
        isGM,
        holdingIndex: 0,
        templateLookup: medTplLookup,
        development: { totals: { food: 10, technology: 10, culture: 10, war: 10 } }
      });
    } finally {
      workflowService._contextData = prevContextData;
    }
  };
  const gmMed = prepMed(true, true);
  assert.equal(gmMed.plannedWorkerRows.length, 2);
  assert.equal(gmMed.medicalSummary.overflowRows.length, 1);
  assert.ok(gmMed.medicalDoctorOptions.some((o) => o.id === "vis-free-gm"));
  for (const canEdit of [false, true]) {
    const playerMed = prepMed(false, canEdit);
    const serialized = JSON.stringify({
      plannedWorkerRows: playerMed.plannedWorkerRows,
      laborPlannedQd: playerMed.laborPlannedQd,
      medicalSummary: playerMed.medicalSummary,
      medicalDoctorOptions: playerMed.medicalDoctorOptions
    });
    for (const secretName of ["ТайныйДок", "ТайныйРезерв", "ТайныйПац"]) {
      assert.equal(serialized.includes(secretName), false, `player view (canEdit=${canEdit}) must not leak ${secretName}`);
    }
    assert.equal(playerMed.medicalSummary.doctors, 1);
    assert.equal(playerMed.laborPlannedQd, 20);
  }

  // 9.5 & 9.6 Service/medical validation parity (wage = 0, daysOff conflict, 1 QD doctor blocked below minOperationalQd)
  const medApp = { ...BuildingRowsDomain, ...BuildingWorkerDomain, _safeNumber: (v, f = 0) => Number.isFinite(Number(v)) ? Number(v) : f };
  const unpaidServiceHolding = mergeHoldingDefaults({
    buildings: { list: [{ id: "srv-1", name: "Служба", constructionStatus: "built", labor: { version: 2, capacityQd: 40 }, activation: { minOperationalQd: 10 }, functions: { culture: true }, service: { capacity: 10 }, wageDailyCopper: 0 }] },
    people: { list: [{ id: "u-w", name: "БезСтавки", age: 30, volunteerLabor: false, workAllocations: [{ sourceId: "srv-1", functionId: "culture", normalQd: 20 }] }] }
  });
  assert.equal(buildingServiceBlockReasons(unpaidServiceHolding, unpaidServiceHolding.buildings.list[0], "culture").active, false, "unpaid worker without volunteer cannot activate service");
  unpaidServiceHolding.buildings.list[0].wageDailyCopper = 12;
  assert.equal(buildingServiceBlockReasons(unpaidServiceHolding, unpaidServiceHolding.buildings.list[0], "culture").active, true);
  unpaidServiceHolding.gm.labor.daysOffPerTenday = 5;
  assert.equal(buildingServiceBlockReasons(unpaidServiceHolding, unpaidServiceHolding.buildings.list[0], "culture").active, false, "plan exceeding daysOffPerTenday budget cannot keep service active");
  assert.equal(daysOffConflictSummary(unpaidServiceHolding, 5).conflicts.length, 1, "daysOff conflict helper flags affected resident without deleting plan");

  const oneQdHosp = structuredClone(hospitalHolding);
  oneQdHosp.people.list[0].workAllocations = [{ sourceId: "hosp-1", functionId: "medical", normalQd: 1, overtimeQd: 0 }];
  assert.equal(medApp._medicalCapacityForBuilding(oneQdHosp, oneQdHosp.buildings.list[0]).capacity, 0, "1 QD doctor on hospital (minOperationalQd 20) grants 0 beds");
  assert.equal(medApp._medicalCapacityForBuilding(hospAssembled, hospAssembled.buildings.list[0]).capacity, 5, "2 doctors reaching 20 QD (1.0 equiv worker) grant 5 beds");

  // 9.7 Multi-day autoCollect: "worker" consumer collection accumulates collectProgressQd
  const consumerCollectHolding = mergeHoldingDefaults({
    buildings: {
      list: [
        {
          id: "src-grain", name: "Жатва", constructionStatus: "built", labor: { version: 2, capacityQd: 40 },
          functions: { production: true }, wageDailyCopper: 12,
          productionLines: [{ id: "gr", active: true, source: "workers", resourceId: "grain", outputQty: 10, workQd: 1, requiresCollection: true, collectQd: 3, collectProgressQd: 0, pendingQty: 10, autoCollect: "worker", storageRoomId: "outdoors" }]
        },
        {
          id: "cons-mill", name: "Пекарня", constructionStatus: "built", labor: { version: 2, capacityQd: 40 },
          functions: { production: true }, wageDailyCopper: 12,
          productionLines: [{ id: "mk", active: true, source: "workers", resourceId: "wood", outputQty: 1, workQd: 1, expenses: "10 Зерно" }]
        }
      ]
    },
    people: { list: [{ id: "baker", name: "Пекарь", age: 30, volunteerLabor: true, workAllocations: [{ sourceId: "cons-mill", functionId: "production:mk", normalQd: 20 }] }] }
  });
  const ccInputs = gateHarness._financePlanInputs(consumerCollectHolding, 40, financePeriodIdentity(consumerCollectHolding));
  const ccFc = gateHarness._financeExecutionContext({}, { oldBlockers: ccInputs.oldBlockers, plannedWorkers: ccInputs.workers, periodQd: 40 });
  const ccWc = gateHarness._economyWorkerContext(consumerCollectHolding, { financeContext: ccFc });
  await gateHarness._runProductionCycleForQd(consumerCollectHolding, 40, { produced: [], consumed: [], skipped: [], income: [], formulas: [], work: [], ledger: [] }, { workerContext: ccWc, financeContext: ccFc });
  assert.equal(consumerCollectHolding.buildings.list[0].productionLines[0].pendingQty, 0, "multi-day 3 QD consumer collection completes over tenday");
  assert.equal(consumerCollectHolding.buildings.list[0].productionLines[0].collectProgressQd, 0);
  assert.equal(resourceQty(consumerCollectHolding, "wood"), 1);

  // 9.8 Row-level volunteer keeps building function and shared operation active for finance
  const volUpkeepHolding = mergeHoldingDefaults({
    buildings: {
      list: [{
        id: "vol-srv", name: "Храм", constructionStatus: "built", labor: { version: 2, capacityQd: 40 },
        functions: { culture: true }, wageDailyCopper: 0, operatingUpkeepMonthlyCopper: 30
      }]
    },
    people: {
      list: [{
        id: "vol-p", name: "Служитель", age: 30, volunteerLabor: false,
        workAllocations: [{ sourceId: "vol-srv", functionId: "culture", normalQd: 20, overtimeQd: 0, volunteer: true, volunteerReason: "Обет" }]
      }]
    }
  });
  const volInputs = gateHarness._financePlanInputs(volUpkeepHolding, 40, financePeriodIdentity(volUpkeepHolding));
  const volBldgPlan = volInputs.buildings.find((b) => b.id === "vol-srv");
  assert.equal(volBldgPlan.functions.find((fn) => fn.id === "culture").active, true, "row-level volunteer activates function in finance plan");
  assert.equal(volBldgPlan.functions.find((fn) => fn.id === "operation").active, true, "row-level volunteer preserves shared building operation");
  assert.equal(calculatePlannedWorkerWage(volInputs.workers[0]).dueCopper, 0);

  // 9.9 & 9.10 Relative militarySalaryModifier scaling & legacy workforcePlan.goals retirement
  const commanderHolding = mergeHoldingDefaults({
    workforcePlan: {
      version: 1,
      goals: [{ sourceId: "x", targetQd: 20 }],
      locks: [{ personId: "cmd", sourceId: "x", functionId: "culture" }],
      productionGoals: [{ sourceId: "x", functionId: "production:y", preparedUnits: 2 }]
    },
    people: {
      list: [
        { id: "cmd", name: "Командир", age: 35, workAssignment: "defenseCommander", salaryModifier: 2 },
        { id: "s1", name: "Боец", age: 25, workAssignment: "soldier" }
      ]
    }
  });
  const cmd = commanderHolding.people.list.find((p) => p.id === "cmd");
  assert.equal(militaryDailyWage(commanderHolding, cmd), 28, "commander +2 offset with 1 soldier = 26 + 2 = 28");
  for (let idx = 2; idx <= 11; idx += 1) commanderHolding.people.list.push({ id: `s${idx}`, name: `Б${idx}`, age: 25, workAssignment: "soldier" });
  assert.equal(militaryDailyWage(commanderHolding, cmd), 32, "commander +2 offset scales to 30 + 2 = 32 at 11 soldiers");
  assert.equal(Object.hasOwn(commanderHolding.workforcePlan, "goals"), false, "retired workforcePlan.goals removed by normalizer");
  assert.equal(commanderHolding.workforcePlan.locks.length, 1);
  assert.equal(commanderHolding.workforcePlan.productionGoals[0].preparedUnits, 2);

  return { ok: true, templatesChecked: true, mixedWorkVerified: true, capacityQd: buildingLaborCapacityQd(strippedBuilding) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkUnifiedLabor();
  console.log("FBL Skyhold unified labor checks passed.");
}
