import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ResidentDomain } from "../apps/domains/resident-domain.js";
import { AssignmentDomain } from "../apps/domains/assignment-domain.js";
import { controlResidentAvailable } from "../apps/domains/control-context.js";
import { applyWorkforceDraft, buildWorkforceModel, createWorkforceDraft, workforceCandidate } from "../apps/domains/workforce-planner.js";
import { workforceTaskGroups } from "../apps/domains/workforce-planner-view.js";
import { workforceTaskState } from "../apps/domains/workforce-task-state.js";
import { applyBattleConditionToPerson } from "../apps/mass-combat/casualties.js";
import { defenseGarrisonProfile } from "../apps/mass-combat/sources.js";
import { BuildingMetaDomain } from "../apps/domains/building/meta-domain.js";
import { EconomyEventDomain } from "../apps/domains/events/economy-events.js";
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
import { gmMoveWorldShip } from "../engines/ships/gm-override.js";
import { storageProfileEffectFactor } from "../engines/storage/specialization.js";

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
  assert.equal(migratedSoldier.wageDailyOverrideCopper, 15, "military salaryModifier (+3 over 12 MM) must carry into wageDailyOverrideCopper");
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
    buildings: { list: [{ id: "school-1", name: "Школа", constructionStatus: "built", labor: { version: 2, capacityQd: 40 }, functions: { culture: true }, workerProfile: { composition: [{ count: 1, group: "УЧЁНЫЙ", backgrounds: ["Учёный"] }] } }] },
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

  return { ok: true, templatesChecked: true, mixedWorkVerified: true, capacityQd: buildingLaborCapacityQd(strippedBuilding) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkUnifiedLabor();
  console.log("FBL Skyhold unified labor checks passed.");
}
