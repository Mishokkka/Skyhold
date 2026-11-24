import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { holdingDaysOffPerTenday, normalLaborQdPerTenday, residentLaborCapacity } from "../data/labor-budget.js";
import { LABOR_SCHEMA_VERSION } from "../data/labor-model.js";
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

export function checkLaborBudget() {
  const adult = { id: "adult", name: "Работник", age: 30, ageGroup: "Вз", race: "Человек", visibility: "public",
    attributes: { strength: 4, agility: 4, wits: 4, empathy: 4 }, workAssignment: "" };
  const child = { ...adult, id: "child", age: 12, ageGroup: "Ре" };
  const service = getSkyholdWorkflowService();
  const holding = mergeHoldingDefaults({
    id: "budget", name: "Бюджет", visibility: "public",
    gm: { playersCanEditBuildings: true, labor: { daysOffPerTenday: 0 } },
    people: { list: [adult, { ...adult, id: "second" }] },
    buildings: { list: [{
      id: "wood", name: "Лесоповал", workersMin: 0, workersMax: 2,
      labor: { version: LABOR_SCHEMA_VERSION, capacityQd: 40 },
      status: "built", constructionStatus: "built", condition: "normal", wageDailyCopper: 12,
      functions: { production: true },
      productionLines: [{ id: "logs", active: true, source: "workers", workQd: 1, resourceId: "wood", outputQty: 1, overtime: true }]
    }] }
  });

  for (const daysOff of [0, 1, 2, 3, 4, 5]) {
    const budget = (10 - daysOff) * 2;
    holding.gm.labor.daysOffPerTenday = daysOff;
    assert.equal(holdingDaysOffPerTenday(holding), daysOff);
    assert.equal(normalLaborQdPerTenday(holding), budget);
    assert.deepEqual(workforceCapacity(adult, holding), { normalQd: budget, overtimeQd: Math.floor(budget / 2) });
    assert.deepEqual(residentLaborCapacity(adult, holding), { normalQd: budget, overtimeQd: Math.floor(budget / 2) });
    assert.deepEqual(residentLaborCapacity(child, holding), { normalQd: Math.floor(budget / 2), overtimeQd: 0 });
    assert.deepEqual(residentLaborCapacity({ ...child, age: 11 }, holding), { normalQd: 0, overtimeQd: 0 });
    assert.equal(workforceUnavailable(holding, adult), "", "days-off budget must not lock the editor or mislabel an adult as a child");

    const cap = plannedWorkerQd(40, { overtime: true, normalQdPerTenday: budget });
    assert.equal(cap.normalQd, budget);
    assert.equal(cap.overtimeQd, Math.floor(budget / 2));

    const childCap = plannedWorkerQd(40, { overtime: true, normalQdPerDay: 1, overtimeQdPerDay: 0, normalQdPerTenday: budget });
    assert.equal(childCap.normalQd, Math.floor(budget / 2));
    assert.equal(childCap.overtimeQd, 0);

    const draft = createWorkforceDraft(holding, service);
    assert.equal(buildWorkforceModel(holding, draft, service, { isGM: true }).free, budget * 2);
    for (const isGM of [true, false]) {
      const proposal = proposeWorkforceAssignments(holding, draft, service, {
        isGM, taskKeys: ["wood::production:logs"], personIds: ["adult", "second"], qd: budget
      });
      assert.ok(proposal.model.people.every((person) => person.normalQd <= budget));
      assert.equal(proposal.model.normalQd, budget * 2);
      assert.equal(workforceDraftError(holding, proposal.draft, { isGM }), "");
    }
  }

  holding.gm.labor.daysOffPerTenday = 2;
  const active = structuredClone(holding);
  active.people.list[0].workAllocations = [
    { id: "w1", sourceId: "wood", functionId: "production:logs", normalQd: 16, overtimeQd: 8 }
  ];
  assert.equal(buildingActiveWorkerSummary(active, active.buildings.list[0]).qd, 24);
  const inputs = service._financePlanInputs(active, 40, financePeriodIdentity(active));
  const worker = inputs.workers.find((row) => row.id === "adult");
  assert.equal(worker.maximumNormalQd, 16);
  assert.equal(worker.assignments[0].normalQd, 16);
  assert.equal(worker.assignments[0].overtimeQd, 8);
  assert.equal(calculatePlannedWorkerWage(worker).dueCopper, 192, "12/day still means 6 per normal QD and 12 per overtime QD");
  const execution = service._financeExecutionContext({}, { plannedWorkers: inputs.workers, periodQd: 40 });
  assert.equal(execution.plannedWorkSlotsByWorkerId.get("adult").size, 24);
  const dailyCare = buildPlannedWorkSlots([{ sourceId: "herd", functionId: "livestock", normalQd: 10 }], 40);
  assert.equal(new Set([...dailyCare.keys()].map((step) => Math.floor(step / 4))).size, 10, "a smaller budget must not close calendar days");

  const next = structuredClone(holding);
  next.people.list[0].workAllocations = [{ id: "a", sourceId: "wood", functionId: "production:logs", normalQd: 17, overtimeQd: 0 }];
  assert.equal(validateHoldingWorkAllocations(next).ok, false);
  for (const isGM of [true, false]) assert.match(workforceChangeError(holding, next, { isGM }), /16 QD/);
  const beforeData = { holdings: [holding] };
  assert.equal(validatePlayerPatch(beforeData, buildPlayerPatch(beforeData, { holdings: [next] })).ok, false, "GM authority must reject an over-budget player mutation");
  next.people.list[0].workAllocations[0].normalQd = 16;
  assert.equal(validateHoldingWorkAllocations(next).ok, true);
  assert.equal(validatePlayerPatch(beforeData, buildPlayerPatch(beforeData, { holdings: [next] })).ok, true, "the same authorized player action is valid within the configured cap");

  const savedBefore = JSON.stringify(next.people.list[0].workAllocations);
  next.gm.labor.daysOffPerTenday = 5;
  assert.equal(validateHoldingWorkAllocations(next).ok, false);
  assert.equal(JSON.stringify(next.people.list[0].workAllocations), savedBefore, "changing daysOffPerTenday must not erase saved assignments");
  const cleared = structuredClone(next);
  cleared.people.list[0].workAllocations = [];
  assert.equal(workforceChangeError(next, cleared, { isGM: false }), "", "a plan can be cleared even at tighter days-off caps");

  holding.gm.labor.daysOffPerTenday = 0;
  for (const post of ["other", "construction:crew", "construction-leader:crew"]) {
    const reserved = structuredClone(holding);
    reserved.people.list[0].workAssignment = post;
    reserved.constructionCrews = [{ id: "crew", memberIds: ["adult"], wageDailyCopper: 12 }];
    reserved.buildings.list.push({ id: "project", constructionStatus: "planned", lifecycle: "planned", status: "Планируется", constructionCrewId: "crew" });
    const reservedWorker = service._financePlanInputs(reserved, 40, financePeriodIdentity(reserved)).workers.find((row) => row.id === "adult");
    assert.equal(reservedWorker.assignments[0].normalQd, 20, "protected roles retain their existing contract until their own QD adapter exists");
  }

  holding.gm.labor.daysOffPerTenday = 0;
  const oldSnapshot = JSON.stringify(tendayDependencySnapshot(beforeData, holding.id));
  const unchangedRevision = { ...beforeData, meta: { revision: 5 } };
  const prepared = { holdingId: holding.id, dataRevision: 5, dependencyHash: service._tendayDependencyHash(unchangedRevision, holding.id) };
  assert.equal(service._isPreparedTendayCurrent(prepared, unchangedRevision), true);
  holding.gm.labor.daysOffPerTenday = 2;
  assert.notEqual(JSON.stringify(tendayDependencySnapshot(beforeData, holding.id)), oldSnapshot, "changing daysOffPerTenday must invalidate a tenday preview even without a data revision");
  assert.equal(service._isPreparedTendayCurrent(prepared, unchangedRevision), false);
  for (const bad of [undefined, null, -1, NaN]) {
    assert.equal(normalLaborQdPerTenday({ gm: { labor: { daysOffPerTenday: bad } } }), 20);
  }
  assert.equal(normalLaborQdPerTenday({ gm: { labor: { daysOffPerTenday: 99 } } }), 10);
  console.log("Labor budget: daysOffPerTenday 0..5, child limits, GM/player validation, clearing and preview invalidation passed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkLaborBudget();
}
