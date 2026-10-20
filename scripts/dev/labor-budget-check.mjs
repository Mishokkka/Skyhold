import assert from "node:assert/strict";
import { MODULE_ID, SETTING_NORMAL_LABOR_QD } from "../data/constants.js";
import { normalLaborQdPerTenday, residentLaborCapacity } from "../data/labor-budget.js";
import { registerSettings } from "../data/settings.js";
import { workforceCapacity, workforceUnavailable, workforceChangeError } from "../data/workforce-plan.js";
import { buildPlannedWorkSlots, validateHoldingWorkAllocations } from "../data/work-allocations.js";
import { plannedWorkerQd, financePeriodIdentity } from "../engines/economy/finance-period.js";
import { calculatePlannedWorkerWage } from "../engines/economy/finance-obligations.js";
import { buildingActiveWorkerSummary } from "../engines/economy/building-service.js";
import { tendayDependencySnapshot } from "../apps/domains/events/tenday-preview.js";
import { createWorkforceDraft, buildWorkforceModel, proposeWorkforceAssignments, workforceDraftError } from "../apps/domains/workforce-planner.js";
import { getSkyholdWorkflowService } from "../workflows/skyhold-workflow-service.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { buildPlayerPatch, validatePlayerPatch } from "../data/player-write-guard.js";

const priorGame = globalThis.game;
let configured = 20;
const registered = new Map();
globalThis.game = { settings: {
  get(module, key) { return module === MODULE_ID && key === SETTING_NORMAL_LABOR_QD ? configured : undefined; },
  register(module, key, value) { registered.set(`${module}.${key}`, value); }
} };
const adult = { id: "adult", name: "Работник", age: 30, ageGroup: "Вз", race: "Человек", visibility: "public",
  attributes: { strength: 4, agility: 4, wits: 4, empathy: 4 }, workAssignment: "", workAllocationMode: "legacy" };
const child = { ...adult, age: 12, ageGroup: "Ре" };
const service = getSkyholdWorkflowService();
const holding = mergeHoldingDefaults({ id: "budget", name: "Бюджет", visibility: "public", gm: { playersCanEditBuildings: true },
  people: { list: [adult, { ...adult, id: "second" }] }, buildings: { list: [{ id: "wood", name: "Лесоповал", workersMin: 1,
    workersMax: 2, assignedWorkerIds: [], status: "built", constructionStatus: "built", condition: "normal", wageDailyCopper: 12,
    functions: { production: true }, productionLines: [{ id: "logs", active: true, source: "workers", workQd: 1,
      resourceId: "wood", outputQty: 1, overtime: true }] }] } });

try {
  registerSettings();
  const setting = registered.get(`${MODULE_ID}.${SETTING_NORMAL_LABOR_QD}`);
  assert.equal(setting.scope, "world", "Foundry world-setting ownership restricts editing to the GM");
  assert.equal(setting.config, true);
  assert.equal(setting.default, 20);
  assert.deepEqual(setting.range, { min: 0, max: 20, step: 1 });
  for (const budget of [0, 1, 7, 16, 19, 20]) {
    configured = budget;
    assert.deepEqual(workforceCapacity(adult), { normalQd: budget, overtimeQd: Math.floor(budget / 2) });
    assert.deepEqual(residentLaborCapacity(child), { normalQd: Math.floor(budget / 2), overtimeQd: 0 });
    assert.deepEqual(residentLaborCapacity({ ...child, age: 11 }), { normalQd: 0, overtimeQd: 0 });
    assert.equal(workforceUnavailable(holding, adult), "", "zero budget must not lock the editor or mislabel an adult as a child");
    const cap = plannedWorkerQd(40, { overtime: true, normalQdPerTenday: budget });
    assert.equal(cap.normalQd, budget);
    assert.equal(cap.overtimeQd, Math.floor(budget / 2));
    const childCap = plannedWorkerQd(40, { overtime: true, normalQdPerDay: 1, overtimeQdPerDay: 0, normalQdPerTenday: budget });
    assert.equal(childCap.normalQd, Math.floor(budget / 2));
    assert.equal(childCap.overtimeQd, 0);
    const draft = createWorkforceDraft(holding, service);
    assert.equal(buildWorkforceModel(holding, draft, service, { isGM: true }).free, budget * 2);
    draft.plan.goals = [{ sourceId: "wood", functionId: "production:logs", normalQd: 32 }];
    for (const isGM of [true, false]) {
      for (const selection of [{}, { taskKeys: ["wood::production:logs"] }]) {
        const proposal = proposeWorkforceAssignments(holding, draft, service, { isGM, ...selection });
        assert.ok(proposal.model.people.every(person => person.normalQd <= budget));
        assert.equal(proposal.model.normalQd, Math.min(32, budget * 2));
        assert.equal(workforceDraftError(holding, proposal.draft, { isGM }), "");
      }
    }
  }
  configured = 16;
  const legacy = structuredClone(holding);
  legacy.people.list[0].workAssignment = "wood";
  legacy.buildings.list[0].assignedWorkerIds = ["adult"];
  assert.equal(buildingActiveWorkerSummary(legacy, legacy.buildings.list[0]).qd, 16, "the service preview must use the same legacy budget as finance");
  const inputs = service._financePlanInputs(legacy, 40, financePeriodIdentity(legacy));
  const worker = inputs.workers.find(row => row.id === "adult");
  assert.equal(worker.maximumNormalQd, 16);
  assert.equal(worker.assignments[0].normalQd, 16);
  assert.equal(worker.assignments[0].overtimeQd, 8);
  assert.equal(calculatePlannedWorkerWage(worker).dueCopper, 192, "12/day still means 6 per normal QD and 12 per overtime QD");
  const execution = service._financeExecutionContext({}, { plannedWorkers: inputs.workers, periodQd: 40 });
  assert.equal(execution.plannedWorkSlotsByWorkerId.get("adult").size, 24);
  const dailyCare = buildPlannedWorkSlots([{ sourceId: "herd", functionId: "livestock", normalQd: 10 }], 40);
  assert.equal(new Set([...dailyCare.keys()].map(step => Math.floor(step / 4))).size, 10, "a smaller budget must not close calendar days");

  const next = structuredClone(holding);
  next.people.list[0].workAllocationMode = "explicit";
  next.people.list[0].workAllocations = [{ id: "a", sourceId: "wood", functionId: "production:logs", normalQd: 17, overtimeQd: 0 }];
  assert.equal(validateHoldingWorkAllocations(next).ok, false);
  for (const isGM of [true, false]) assert.match(workforceChangeError(holding, next, { isGM }), /16 QD/);
  const beforeData = { holdings: [holding] }, afterData = { holdings: [next] };
  assert.equal(validatePlayerPatch(beforeData, buildPlayerPatch(beforeData, afterData)).ok, false, "GM authority must reject an over-budget player mutation");
  next.people.list[0].workAllocations[0].normalQd = 16;
  assert.equal(validateHoldingWorkAllocations(next).ok, true);
  assert.equal(validatePlayerPatch(beforeData, buildPlayerPatch(beforeData, { holdings: [next] })).ok, true, "the same authorized player action is valid within the configured cap");
  const savedBefore = JSON.stringify(next);
  configured = 0;
  assert.equal(buildingActiveWorkerSummary(legacy, legacy.buildings.list[0]).qd, 0);
  assert.equal(validateHoldingWorkAllocations(next).ok, false);
  assert.equal(JSON.stringify(next), savedBefore, "changing the world norm must not erase saved assignments");
  const cleared = structuredClone(next); cleared.people.list[0].workAllocations = [];
  assert.equal(workforceChangeError(next, cleared, { isGM: false }), "", "a plan can be cleared even at a zero norm");
  assert.equal(service._financePlanInputs(legacy, 40, financePeriodIdentity(legacy)).workers.length, 0);
  for (const post of ["other", "construction:crew", "construction-leader:crew"]) {
    const reserved = structuredClone(holding);
    reserved.people.list[0].workAssignment = post;
    reserved.people.list[0].salary = 12;
    reserved.constructionCrews = [{ id: "crew", memberIds: ["adult"], wageDailyCopper: 12 }];
    reserved.buildings.list.push({ id: "project", constructionStatus: "planned", lifecycle: "planned", status: "Планируется", constructionCrewId: "crew" });
    const reservedWorker = service._financePlanInputs(reserved, 40, financePeriodIdentity(reserved)).workers.find(row => row.id === "adult");
    assert.equal(reservedWorker.assignments[0].normalQd, 20, "protected roles retain their existing contract until their own QD adapter exists");
  }

  configured = 20;
  const oldSnapshot = JSON.stringify(tendayDependencySnapshot(beforeData, holding.id));
  const unchangedRevision = { ...beforeData, meta: { revision: 5 } };
  const prepared = { holdingId: holding.id, dataRevision: 5, dependencyHash: service._tendayDependencyHash(unchangedRevision, holding.id) };
  assert.equal(service._isPreparedTendayCurrent(prepared, unchangedRevision), true);
  configured = 16;
  assert.notEqual(JSON.stringify(tendayDependencySnapshot(beforeData, holding.id)), oldSnapshot, "changing the setting must invalidate a tenday preview even without a data revision");
  assert.equal(service._isPreparedTendayCurrent(prepared, unchangedRevision), false);
  for (const bad of [undefined, null, -1, 21, 1.5, "16", NaN]) {
    configured = bad; assert.equal(normalLaborQdPerTenday(), 20);
  }
  console.log("Labor budget: 0/1/7/16/19/20, child limits, GM/player validation, automatic assignment, legacy wages/slots, zero-norm recovery and preview invalidation passed.");
} finally {
  if (priorGame === undefined) delete globalThis.game;
  else globalThis.game = priorGame;
}
