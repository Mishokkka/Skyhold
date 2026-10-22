import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { getSkyholdWorkflowService } from "../workflows/skyhold-workflow-service.js";
import { createWorkforceDraft, buildWorkforceModel, applyWorkforceDraft, workforceDraftError, setWorkforceAllocation,
  workforceCandidate, proposeWorkforceAssignments, proposeWorkforceIdleReview } from "../apps/domains/workforce-planner.js";
import { setWorkforceStaff, removeWorkforceStaff } from "../apps/domains/workforce-staff.js";
import { buildPlayerPatch, validatePlayerPatch } from "../data/player-write-guard.js";
import { executeWorkforcePlan } from "../apps/workforce-plan-executor.js";
import { workforceTaskGroups } from "../apps/domains/workforce-planner-view.js";
import { SETTING_NORMAL_LABOR_QD } from "../data/constants.js";

const copy = (value) => structuredClone(value);
const service = getSkyholdWorkflowService();
function fixture(count = 4, mode = "staff") {
  return mergeHoldingDefaults({ id: "holding", visibility: "public", name: "Тест", gm: { playersCanEditBuildings: true },
    buildings: { list: [{ id: "workshop", name: "Мастерская", visibility: "public",
      status: "built", lifecycle: "built", constructionStatus: "built", condition: "normal",
      labor: { version: 1, mode, capacityQd: mode === "qd" ? 10 : null },
      workersMax: mode === "qd" ? 1 : 4, workersMin: 0, wageDailyCopper: 12, assignedWorkerIds: [],
      functions: { production: true },
      productionLines: [
        { id: "first", mode: "Основная", active: true, source: "workers", outputQty: 2, workQd: 2, wageDailyCopper: 12, resourceId: "wood", overtime: true },
        { id: "second", mode: "Резерв", active: true, source: "workers", outputQty: 1, workQd: 1, wageDailyCopper: 18, resourceId: "stone", overtime: true }
      ] }] },
    people: { list: Array.from({ length: count }, (_, index) => ({
      id: `p${index}`, name: `Житель ${index}`, age: 30, ageGroup: "Вз", race: "Человек", visibility: "public",
      workAssignment: "", workAllocationMode: "explicit", workAllocations: [],
      attributes: { strength: 4, agility: 4, wits: 4, empathy: 4 }
    })) } });
}

export async function checkHybridLaborPlanner() {
  const holding = fixture(), original = JSON.stringify(holding), draft = createWorkforceDraft(holding, service);
  let model = buildWorkforceModel(holding, draft, service, { isGM: true });
  const primary = model.taskMap.get("workshop::production:first");
  assert.equal(primary.isStaff, true);
  setWorkforceStaff(draft, holding.people.list[0], primary, { reserveFunctionId: "production:second" });
  assert.equal(workforceDraftError(holding, draft, { isGM: true }), "");
  assert.equal(workforceDraftError(holding, draft, { isGM: false }), "");
  const assigned = applyWorkforceDraft(copy(holding), draft);
  assert.equal(assigned.people.list[0].workAssignment, "workshop");
  assert.deepEqual(assigned.people.list[0].workAllocations, []);
  assert.equal(assigned.buildings.list[0].assignedWorkerIds.filter(id => id === "p0").length, 1);
  assert.deepEqual(mergeHoldingDefaults(assigned).people.list[0].staffAppointment, assigned.people.list[0].staffAppointment);
  model = buildWorkforceModel(holding, draft, service, { isGM: true });
  assert.equal(model.people[0].free, 0, "Reserve work does not release the employee for external assignments");
  assert.equal(model.people[0].wage, 120, "One agreed 12 MM/day contract costs 120 MM even with the 18 MM/day reserve line");
  assert.equal(model.normalQd, 20, "Two tasks reserve one normal budget");
  assert.throws(() => setWorkforceAllocation(draft, "p0", primary, 1), /постоянной/i);
  const updated = createWorkforceDraft(assigned, service);
  setWorkforceStaff(updated, assigned.people.list[0], primary, { reserveFunctionId: "", wageDailyCopper: 12 });
  assert.equal(applyWorkforceDraft(copy(assigned), updated).people.list[0].staffAppointment.buildingId, "workshop");
  const reversed = copy(assigned); reversed.buildings.list[0].productionLines.reverse();
  const reversedModel = buildWorkforceModel(reversed, createWorkforceDraft(reversed, service), service, { isGM: true });
  assert.equal(reversedModel.people[0].allocations[0].functionId, "production:first", "Line order cannot change the chosen primary task");
  const before = { holdings: [holding], meta: { revision: 1 } }, after = { holdings: [assigned], meta: { revision: 1 } };
  assert.equal(validatePlayerPatch(before, buildPlayerPatch(before, after)).ok, true);
  const forged = copy(draft); forged.staffAppointments.p0.wageDailyCopper = 1;
  assert.ok(workforceDraftError(holding, forged, { isGM: false }), "A player cannot invent a cheaper staff contract");
  assert.equal(workforceDraftError(holding, forged, { isGM: true }), "");

  const reserveHire = createWorkforceDraft(holding, service);
  setWorkforceStaff(reserveHire, holding.people.list[1], model.taskMap.get("workshop::production:second"));
  assert.equal(reserveHire.staffAppointments.p1.wageDailyCopper, 12, "Hiring on a different line keeps the building's agreed default wage");
  assert.equal(workforceDraftError(holding, reserveHire, { isGM: false }), "");
  const volunteerHolding = copy(holding);
  Object.assign(volunteerHolding.people.list[0], { volunteerLabor: true, volunteerReason: "Договорённость с ГМ", wageDailyOverrideCopper: 0 });
  const volunteerDraft = createWorkforceDraft(volunteerHolding, service);
  setWorkforceStaff(volunteerDraft, volunteerHolding.people.list[0], primary);
  assert.equal(volunteerDraft.staffAppointments.p0.volunteer, true);
  assert.equal(workforceDraftError(volunteerHolding, volunteerDraft, { isGM: false }), "", "Hiring preserves an existing GM-authorized volunteer agreement");

  const released = copy(draft);
  removeWorkforceStaff(released, "p0");
  const freed = applyWorkforceDraft(copy(assigned), released);
  assert.equal(freed.people.list[0].staffAppointment, undefined);
  assert.equal(freed.people.list[0].workAssignment, "");
  assert.equal(buildWorkforceModel(freed, createWorkforceDraft(freed, service), service, { isGM: true }).people[0].free, 20);

  const proposedDraft = createWorkforceDraft(holding, service);
  proposedDraft.plan.goals = [{ sourceId: "workshop", functionId: "production:first", normalQd: 25 }];
  const proposal = proposeWorkforceAssignments(holding, proposedDraft, service, { isGM: true });
  assert.equal(proposal.changes.length, 2, "A goal needing more than one person's budget hires two whole employees");
  assert.equal(proposal.model.normalQd, 40);
  assert.equal(proposal.model.free, 40);
  assert.equal(workforceDraftError(holding, proposal.draft, { isGM: true }), "");
  assert.equal(proposeWorkforceAssignments(holding, proposal.draft, service, { isGM: true }).changes.length, 0);

  const qdHolding = fixture(2, "qd"), qdDraft = createWorkforceDraft(qdHolding, service);
  const qdTask = buildWorkforceModel(qdHolding, qdDraft, service, { isGM: true }).taskMap.get(primary.key);
  setWorkforceAllocation(qdDraft, "p0", qdTask, 5);
  let qdModel = buildWorkforceModel(qdHolding, qdDraft, service, { isGM: true });
  assert.equal(workforceCandidate(qdModel, qdModel.people[1], qdModel.taskMap.get(primary.key), service).reason, "",
    "A second sequential contributor is not blocked by the historical one-person maximum");
  setWorkforceAllocation(qdDraft, "p1", qdTask, 5);
  assert.equal(workforceDraftError(qdHolding, qdDraft, { isGM: true }), "");
  qdModel = buildWorkforceModel(qdHolding, qdDraft, service, { isGM: true });
  const group = workforceTaskGroups(qdModel).find(row => row.id === "workshop");
  assert.equal(group.showSeats, false); assert.match(group.capacityText, /10 \/ 10 QD/);
  const overflow = copy(qdDraft); setWorkforceAllocation(overflow, "p1", qdTask, 6);
  assert.match(workforceDraftError(qdHolding, overflow, { isGM: true }), /предел|QD/i);

  const goalDraft = createWorkforceDraft(holding, service);
  goalDraft.plan = { version: 2, goals: [], locks: [], productionGoals: [{ sourceId: "workshop", functionId: "production:first", preparedUnits: 10 }] };
  assert.equal(workforceDraftError(holding, goalDraft, { isGM: true }), "");
  const goalModel = buildWorkforceModel(holding, goalDraft, service, { isGM: true });
  assert.equal(goalModel.taskMap.get(primary.key).effectiveNeed, 10);
  assert.equal(proposeWorkforceAssignments(holding, goalDraft, service, { isGM: true }).changes.length, 1);

  const inn = copy(assigned);
  Object.assign(inn.buildings.list[0], { templateId: "inn", activation: { minOperationalQd: 20, requiresMeaningfulResult: true, anyWorkingFunction: true } });
  inn.buildings.list[0].functions.culture = true;
  const innModel = buildWorkforceModel(inn, createWorkforceDraft(inn, service), service, { isGM: true });
  const innRequirement = workforceTaskGroups(innModel)[0].requirement;
  assert.equal(innRequirement.minQd, 20);
  assert.equal(innRequirement.qd, 0, "Kitchen assignments cannot cover the hall's displayed labor requirement");

  const paused = copy(assigned);
  paused.buildings.list[0].productionLines[0].active = false;
  const pausedDraft = createWorkforceDraft(paused, service);
  assert.equal(workforceDraftError(paused, pausedDraft, { isGM: true }), "", "Pausing does not invalidate the existing staff contract");
  const pausedModel = buildWorkforceModel(paused, pausedDraft, service, { isGM: true });
  assert.equal(pausedModel.taskMap.get(primary.key).assignable, false);
  assert.equal(pausedModel.people[0].free, 0);
  assert.equal(pausedModel.people[0].wage, 120, "Paused work keeps the agreed wage and permits reserve execution");

  const waiting = copy(assigned), waitingLine = waiting.buildings.list[0].productionLines[0];
  Object.assign(waitingLine, { batchCapacity: 2, batchStartQty: 1, waitingBatches: [{
    id: "waiting", workInputsReserved: true, workReservedOutputQty: 2, workProgressUnits: 20000,
    workReservedInputs: { batchId: "waiting", timing: { phase: "waiting", waitQd: 80, elapsedQd: 0, workTargetUnits: 20000 } }
  }] });
  const waitingDraft = createWorkforceDraft(waiting, service);
  const idle = proposeWorkforceIdleReview(waiting, waitingDraft, service, { isGM: true });
  assert.deepEqual(idle.draft.staffAppointments.p0, assigned.people.list[0].staffAppointment, "Idle review never fires a permanent employee");
  assert.equal(JSON.stringify(holding), original, "Reading, suggestions and validation leave the settlement untouched");

  const previousGame = globalThis.game;
  try {
    globalThis.game = { settings: { get: (_module, key) => key === SETTING_NORMAL_LABOR_QD ? 0 : undefined } };
    const zeroModel = buildWorkforceModel(assigned, createWorkforceDraft(assigned, service), service, { isGM: true });
    assert.equal(zeroModel.people[0].isStaff, true);
    assert.equal(zeroModel.people[0].free, 0);
    assert.equal(zeroModel.people[0].wage, 0);
    assert.equal(zeroModel.staffByBuilding.get("workshop").size, 1, "A zero-work period does not silently dismiss the staff");
    assert.match(workforceTaskGroups(zeroModel)[0].assignmentsText, /В штате: 1/);
  } finally { globalThis.game = previousGame; }

  let state = { meta: { revision: 1 }, holdings: [copy(holding)] };
  const store = {
    skipTransaction: result => ({ skip: true, result }),
    async updateHolding(_id, update) {
      const next = copy(state), result = update(next.holdings[0], next);
      if (result?.skip) return result.result;
      state = next; state.meta.revision += 1; return result;
    }
  };
  const request = { operationId: "staff-plan", holdingId: holding.id, expectedRevision: 1, draft };
  const getUser = () => ({ id: "gm", isGM: true });
  assert.equal((await executeWorkforcePlan(request, { store, getUser })).ok, true);
  assert.equal((await executeWorkforcePlan(request, { store, getUser })).replay, true);
  const changed = copy(request); changed.draft.staffAppointments.p0.reserveFunctionId = "";
  assert.equal((await executeWorkforcePlan(changed, { store, getUser })).ok, false, "Replay identity includes the internal staff task");

  for (const count of [20, 50, 100, 200]) {
    const settlement = fixture(count);
    settlement.buildings.list[0].workersMax = count;
    const bulk = createWorkforceDraft(settlement, service);
    bulk.plan.goals = [{ sourceId: "workshop", functionId: "production:first", normalQd: count * 10 }];
    const result = proposeWorkforceAssignments(settlement, bulk, service, { isGM: true });
    assert.equal(result.changes.length, count / 2, `${count} residents: hire only the staff required by the chosen goal`);
    assert.equal(result.model.people.length, count);
    assert.equal(result.model.normalQd, count * 10);
    assert.equal(result.model.free, count * 10);
    assert.equal(workforceDraftError(settlement, result.draft, { isGM: true }), "");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkHybridLaborPlanner();
  console.log("Hybrid labor planner: staff contracts, QD capacity, shared goals, permissions, zero budget and replay passed.");
}
