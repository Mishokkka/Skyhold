import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_BUILDING_TEMPLATES } from "../data/building-templates.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { getSkyholdWorkflowService } from "../workflows/skyhold-workflow-service.js";
import { createWorkforceDraft, buildWorkforceModel, setWorkforceAllocation, reviseWorkforceAssignment, workforceDraftError, proposeWorkforceAssignments, applyWorkforceDraft, proposeWorkforceIdleReview } from "../apps/domains/workforce-planner.js";
import { workforceTaskGroups, workforceBuildingRequirement } from "../apps/domains/workforce-planner-view.js";
import { workforceChangeError } from "../data/workforce-plan.js";
import { buildPlayerPatch, validatePlayerPatch } from "../data/player-write-guard.js";
import { executeWorkforcePlan } from "../apps/workforce-plan-executor.js";
import { buildingCompositionStatus } from "../engines/workers/building-qualification.js";

const clone = (value) => structuredClone(value);
const template = (id) => clone(DEFAULT_BUILDING_TEMPLATES.find((row) => row.id === id));
const resident = (id) => ({ id, name: id, age: 30, ageGroup: "Вз", race: "Человек", workAssignment: "", workAllocationMode: "legacy", workAllocations: [],
  attributes: { strength: 4, agility: 4, wits: 4, empathy: 4 }, visibility: "public" });
function fixture(count = 3) {
  const building = { id: "wood", name: "Лесоповал", status: "built", lifecycle: "built", constructionStatus: "built", condition: "normal",
    workersMax: 12, workersMin: 1, wageDailyCopper: 12, assignedWorkerIds: [], functions: { production: true },
    productionLines: [{ id: "logs", active: true, source: "workers", mode: "Древесина", workQd: 2, resourceId: "wood", formula: "2", overtime: true }] };
  return mergeHoldingDefaults({ id: "test", name: "Тест", visibility: "public", buildings: { list: [building] }, people: { list: Array.from({ length: count }, (_, index) => resident(`p-${index}`)) }, gm: { playersCanEditBuildings: true } });
}
export async function checkWorkforcePlanner() {
const service = getSkyholdWorkflowService();
const holding = fixture(), original = JSON.stringify(holding), draft = createWorkforceDraft(holding, service);
let model = buildWorkforceModel(holding, draft, service, { isGM: true });
const task = model.taskMap.get("wood::production:logs");
assert.ok(task?.assignable);
assert.equal(model.free, 60);
assert.equal(task.need, 0, "12 seats must not become required work");
assert.equal(proposeWorkforceAssignments(holding, draft, service, { isGM: true }).changes.length, 0);
const optionalTaskProposal = proposeWorkforceAssignments(holding, draft, service, { isGM: true, taskKeys: [task.key] });
assert.equal(optionalTaskProposal.changes.length, 0, "selecting an optional task must not turn minimum staffing into demand");
assert.ok(optionalTaskProposal.skipped.some((reason) => reason.includes("цель труда")));
assert.equal(JSON.stringify(holding), original, "reading and preview must be pure");

// Explicit selection may close an operational minimum; the global helper never opens optional buildings.
for (const isGM of [true, false]) {
  const operating = fixture();
  operating.buildings.list[0].activation = { minOperationalQd: 12, minWorkers: 2, anyWorkingFunction: true };
  const operatingDraft = createWorkforceDraft(operating, service);
  assert.equal(proposeWorkforceAssignments(operating, operatingDraft, service, { isGM }).changes.length, 0);
  const filled = proposeWorkforceAssignments(operating, operatingDraft, service, { isGM, taskKeys: [task.key], useBuildingMinimum: true });
  assert.equal(filled.model.normalQd, 12);
  assert.equal(filled.model.staffByBuilding.get("wood").size, 2);
  assert.equal(filled.draft.plan.goals.length, 0, "temporary minimum selection must not invent a persistent production goal");
  assert.equal(workforceDraftError(operating, filled.draft, { isGM }), "");
  const covered = proposeWorkforceAssignments(operating, filled.draft, service, { isGM, taskKeys: [task.key], useBuildingMinimum: true });
  assert.equal(covered.changes.length, 0);
  assert.ok(covered.skipped.some(reason => reason.includes("уже обеспечены")));
  assert.equal(operatingDraft.edited.length, 0, "proposal leaves the user's draft untouched");
}
const staffed = fixture(); staffed.buildings.list[0].workersMin = 2;
const staffedDraft = createWorkforceDraft(staffed, service);
staffedDraft.plan.goals = [{ sourceId: "wood", functionId: "production:logs", normalQd: 20 }];
setWorkforceAllocation(staffedDraft, "p-0", task, 10);
const staffedProposal = proposeWorkforceAssignments(staffed, staffedDraft, service, { isGM: true });
assert.equal(staffedProposal.model.normalQd, 20);
assert.equal(staffedProposal.model.staffByBuilding.get("wood").size, 2, "fill the second seat before giving more work to the existing worker");
assert.ok(!staffedProposal.model.taskMap.get(task.key).warnings.some(reason => reason.includes("одновременного")));
const shortTeam = fixture(1); shortTeam.buildings.list[0].workersMin = 2;
const shortDraft = createWorkforceDraft(shortTeam, service); shortDraft.plan.goals = clone(staffedDraft.plan.goals);
const shortProposal = proposeWorkforceAssignments(shortTeam, shortDraft, service, { isGM: true });
assert.equal(shortProposal.changes.length, 0, "do not propose a known impossible minimum team");
assert.ok(shortProposal.skipped.some(reason => reason.includes("нужно 2 работников")));
const occupied = fixture(2); occupied.buildings.list.push({ ...clone(occupied.buildings.list[0]), id: "other" });
const occupiedDraft = createWorkforceDraft(occupied, service);
for (const p of occupied.people.list) setWorkforceAllocation(occupiedDraft, p.id, { ...task, sourceId: "other", key: "other::production:logs" }, 20);
occupiedDraft.plan.goals = clone(staffedDraft.plan.goals);
const occupiedProposal = proposeWorkforceAssignments(occupied, occupiedDraft, service, { isGM: true });
assert.equal(occupiedProposal.changes.length, 0);
assert.deepEqual(occupiedProposal.draft.allocations, occupiedDraft.allocations, "automatic fill cannot steal occupied time");
assert.ok(occupiedProposal.skipped.some(reason => reason.includes("свободные QD")));
draft.plan.goals.push({ sourceId: "wood", functionId: "production:logs", normalQd: 24 });
const proposal = proposeWorkforceAssignments(holding, draft, service, { isGM: true });
assert.equal(proposal.model.taskMap.get(task.key).normalQd, 24);
assert.equal(proposal.model.free, 36);
assert.equal(proposal.model.wage, 144, "quote uses 12 MM/day at two QD/day");
assert.equal(workforceDraftError(holding, proposal.draft, { isGM: true }), "");
const unpaid = fixture(); unpaid.buildings.list[0].wageDailyCopper = 0;
const unpaidDraft = createWorkforceDraft(unpaid, service); unpaidDraft.plan.goals = clone(draft.plan.goals);
assert.equal(proposeWorkforceAssignments(unpaid, unpaidDraft, service, { isGM: true }).changes.length, 0, "a zero rate is not implicit volunteering");
assert.ok(proposeWorkforceAssignments(unpaid, unpaidDraft, service, { isGM: true }).skipped.some(reason => reason.includes("Нужна ставка")), "explain missing pay, not only an unavailable minimum team");
unpaid.people.list[0].volunteerLabor = true; unpaid.people.list[0].volunteerReason = "Спасён поселением";
const volunteerProposal = proposeWorkforceAssignments(unpaid, createWorkforceDraft(unpaid, service), service, { isGM: true, taskKeys: [task.key], personIds: ["p-0"], qd: 10 });
assert.equal(volunteerProposal.changes.length, 1); assert.equal(volunteerProposal.model.wage, 0);
assert.equal(applyWorkforceDraft(clone(unpaid), volunteerProposal.draft).people.list[0].volunteerReason, "Спасён поселением");
const next = applyWorkforceDraft(clone(holding), proposal.draft);
assert.deepEqual(mergeHoldingDefaults(next).workforcePlan, proposal.draft.plan, "safe loading preserves new metadata");
const beforeData = { holdings: [holding], meta: { revision: 7 } }, nextData = { holdings: [next], meta: { revision: 7 } };
assert.equal(validatePlayerPatch(beforeData, buildPlayerPatch(beforeData, nextData)).ok, true, "player saves through buildings permission");
const over = clone(proposal.draft);
over.allocations["p-0"][0].normalQd = 21;
assert.ok(workforceDraftError(holding, over, { isGM: true }));
const locked = clone(proposal.draft);
locked.plan.locks.push({ personId: "p-0", sourceId: task.sourceId, functionId: task.functionId });
assert.throws(() => setWorkforceAllocation(locked, "p-0", task, 1), /закрепление/);
const clearedGoal = clone(proposal.draft); clearedGoal.plan.goals = [];
assert.deepEqual(clearedGoal.allocations, proposal.draft.allocations);
const hidden = clone(holding); hidden.people.list[0].visibility = "gm"; hidden.buildings.list[0].visibility = "gm";
const hiddenModel = buildWorkforceModel(hidden, createWorkforceDraft(hidden, service), service);
assert.equal(hiddenModel.people.length, 2); assert.ok(!hiddenModel.taskMap.has(task.key));
assert.ok(workforceChangeError(hidden, applyWorkforceDraft(clone(hidden), proposal.draft)));
const reserve = fixture(); reserve.people.list[0].workAssignment = "soldier"; reserve.people.list[1].injuredDays = 3;
model = buildWorkforceModel(reserve, createWorkforceDraft(reserve, service), service, { isGM: true });
assert.equal(model.free, 20, "unavailable people cannot create a free budget");
const ledCrew = fixture();
ledCrew.constructionCrews = [{ id: "crew", name: "Каменщики", memberIds: [], leaderId: "p-0" }];
ledCrew.people.list[0].workAssignment = "construction-leader:crew";
model = buildWorkforceModel(ledCrew, createWorkforceDraft(ledCrew, service), service, { isGM: true });
assert.equal(model.people.find(row => row.id === "p-0").free, 0, "construction leadership must reserve the worker in the planner");
assert.ok(model.people.find(row => row.id === "p-0").unavailable);
assert.equal(model.free, 40);
const moving = fixture();
moving.buildings.list.push({ ...clone(moving.buildings.list[0]), id: "quarry", name: "Каменоломня" });
moving.people.list[0].workAssignment = "wood";
moving.buildings.list[0].assignedWorkerIds = ["p-0"];
const movingDraft = createWorkforceDraft(moving, service), movingSnapshot = JSON.stringify(movingDraft);
const transfer = { personId: "p-0", fromKey: "wood::production:logs", targetKey: "quarry::production:logs", normalQd: 8, isGM: true };
const moved = reviseWorkforceAssignment(moving, movingDraft, service, transfer);
assert.equal(JSON.stringify(movingDraft), movingSnapshot, "a transfer is an isolated atomic draft change");
assert.deepEqual(moved.allocations["p-0"].map(row => row.normalQd), [12, 8]);
assert.equal(workforceDraftError(moving, moved, { isGM: true }), "");
const movedAll = reviseWorkforceAssignment(moving, movingDraft, service, { ...transfer, normalQd: 20, overtimeQd: movingDraft.allocations["p-0"][0].overtimeQd });
assert.equal(movedAll.allocations["p-0"].length, 1);
assert.equal(movedAll.allocations["p-0"][0].sourceId, "quarry", "a full legacy transfer must not retain a stale busy state");
const released = clone(movingDraft);
setWorkforceAllocation(released, "p-0", { sourceId: "wood", functionId: "production:logs", key: "wood::production:logs" }, 0);
const releasedPerson = buildWorkforceModel(moving, released, service, { isGM: true }).people.find(row => row.id === "p-0");
assert.equal(releasedPerson.unavailable, ""); assert.equal(releasedPerson.free, 20, "removing a legacy assignment frees time immediately");
const freshAssignment = reviseWorkforceAssignment(moving, released, service, { ...transfer, fromKey: "", add: true, normalQd: 6 });
assert.equal(freshAssignment.allocations["p-0"][0].normalQd, 6);
assert.throws(() => reviseWorkforceAssignment(moving, movingDraft, service, { ...transfer, normalQd: 21 }), /не хватает/);
assert.throws(() => reviseWorkforceAssignment(moving, movingDraft, service, { ...transfer, targetKey: transfer.fromKey }), /другую/);
const fixed = clone(movingDraft); fixed.plan.locks.push({ personId: "p-0", sourceId: "wood", functionId: "production:logs" });
assert.throws(() => reviseWorkforceAssignment(moving, fixed, service, transfer), /закрепление/);
const fixedTarget = clone(moved); fixedTarget.plan.locks.push({ personId: "p-0", sourceId: "quarry", functionId: "production:logs" });
assert.throws(() => reviseWorkforceAssignment(moving, fixedTarget, service, transfer), /закреплено/);
const noOvertimeDestination = clone(moving); noOvertimeDestination.buildings.list[1].productionLines[0].overtime = false;
assert.throws(() => reviseWorkforceAssignment(noOvertimeDestination, movingDraft, service, { ...transfer, normalQd: 0, overtimeQd: 1 }), /Эта функция не разрешает переработку/);
const departed = clone(moving); departed.people.list[0].shipAssignment = { shipId: "away", away: true };
assert.throws(() => reviseWorkforceAssignment(moving, movingDraft, service, { ...transfer, presenceHolding: departed }), /недоступен/);
const fullDestination = clone(moving); fullDestination.buildings.list[1].workersMax = 1;
fullDestination.people.list[1].workAssignment = "quarry"; fullDestination.buildings.list[1].assignedWorkerIds = ["p-1"];
assert.throws(() => reviseWorkforceAssignment(fullDestination, createWorkforceDraft(fullDestination, service), service, transfer), /места/);
const privateDestination = clone(moving); privateDestination.buildings.list[1].visibility = "gm";
assert.throws(() => reviseWorkforceAssignment(privateDestination, movingDraft, service, { ...transfer, isGM: false }), /недоступна/);
assert.equal(JSON.stringify(movingDraft), movingSnapshot, "rejected transfers must not remove the original assignment");
assert.equal(validatePlayerPatch({ holdings: [moving], meta: { revision: 1 } }, buildPlayerPatch(
  { holdings: [moving], meta: { revision: 1 } }, { holdings: [applyWorkforceDraft(clone(moving), moved)], meta: { revision: 1 } })).ok, true,
"a transfer remains one permitted player patch");

const minBuilding = { workersMin: 2, functions: { culture: true, production: true }, activation: { minOperationalQd: 40, anyWorkingFunction: true } };
const minTasks = [
  { kind: "culture", functionId: "culture", functionName: "Услуги", assignable: true, normalQd: 10, assignments: [{ personId: "a" }] },
  { kind: "production", functionId: "production:meal", functionName: "Кухня", assignable: true, normalQd: 25, overtimeQd: 5, assignments: [{ personId: "a" }, { personId: "b" }] },
  { kind: "maintenance", functionId: "maintenance", assignable: true, normalQd: 40, assignments: [{ personId: "c" }] }
];
assert.deepEqual([workforceBuildingRequirement(minBuilding, minTasks).qd, workforceBuildingRequirement(minBuilding, minTasks).workers], [40, 2],
  "building minimum counts each QD and worker once and excludes maintenance");
const scopedMinimum = workforceBuildingRequirement({ ...minBuilding, activation: { minOperationalQd: 40 } }, minTasks);
assert.equal(scopedMinimum.qd, 10, "another function cannot satisfy a function-specific minimum");
assert.equal(scopedMinimum.gap, 30);
assert.equal(workforceBuildingRequirement({ workersMin: 12, workersMax: 12 }, []).minQd, 0, "seats never invent a 240-QD obligation");
const multi = fixture(); multi.buildings.list[0].productionLines.push({ ...clone(multi.buildings.list[0].productionLines[0]), id: "planks", mode: "Доски" });
const multiModel = buildWorkforceModel(multi, createWorkforceDraft(multi, service), service, { isGM: true });
const groups = workforceTaskGroups(multiModel);
assert.equal(groups.filter(group => group.id === "wood").length, 1);
assert.equal(groups.find(group => group.id === "wood").taskCount, 2);
const filteredGroups = workforceTaskGroups(multiModel, multiModel.tasks.filter(row => row.functionId === "production:planks"));
assert.equal(filteredGroups.length, 1); assert.equal(filteredGroups[0].tasks.length, 1);
assert.equal(filteredGroups[0].taskCount, 2, "search narrows children without duplicating or splitting the building");
const crossLineDraft = createWorkforceDraft(multi, service);
crossLineDraft.plan.goals.push({ sourceId: "wood", functionId: "production:logs", normalQd: 4 });
setWorkforceAllocation(crossLineDraft, "p-0", { sourceId: "wood", functionId: "production:planks", key: "wood::production:planks" }, 4);
const crossLineGroup = workforceTaskGroups(buildWorkforceModel(multi, crossLineDraft, service, { isGM: true })).find(group => group.id === "wood");
assert.equal(crossLineGroup.normalQd, 4); assert.equal(crossLineGroup.goal, 4);
assert.equal(crossLineGroup.goalQd, 0, "work on another line must not fill a grouped goal progress bar");
const presence = fixture(6), presenceBaseline = clone(presence);
presence.people.list[0].dead = true;
presence.people.list[1].shipAssignment = { shipId: "voyager", away: true };
presence.people.list[2].injuredDays = 3;
presence.special.ships.list = [{ id: "docked", crewResidentIds: ["p-3", "p-4"], location: { kind: "home" } }];
presence.people.list[3].shipAssignment = { shipId: "docked", away: false };
presence.people.list[4].shipAssignment = { shipId: "docked", away: false, shoreDuty: true };
const presenceOriginal = JSON.stringify(presence), presenceDraft = createWorkforceDraft(presence, service);
for (const isGM of [true, false]) {
  const presenceModel = buildWorkforceModel(presence, presenceDraft, service, { isGM });
  assert.deepEqual(presenceModel.people.map((person) => person.id), ["p-2", "p-4", "p-5"], "only living settlement residents appear, including injured residents and crew on shore duty");
  assert.equal(presenceModel.free, 40);
  const staleDraft = createWorkforceDraft(presenceBaseline, service);
  staleDraft.plan.goals = [{ sourceId: "wood", functionId: "production:logs", normalQd: 20 }];
  const liveOptions = { isGM, presenceHolding: presence };
  assert.deepEqual(buildWorkforceModel(presenceBaseline, staleDraft, service, liveOptions).people.map((person) => person.id), ["p-2", "p-4", "p-5"], "a stale draft cannot restore dead or absent people");
  const staleProposal = proposeWorkforceAssignments(presenceBaseline, staleDraft, service, { ...liveOptions,
    taskKeys: [task.key], personIds: ["p-0", "p-1", "p-3", "p-5"], qd: 4 });
  assert.deepEqual(staleProposal.changes.map((change) => change.personId), ["p-5"], "even an old bulk selection cannot assign dead or absent residents");
}
assert.equal(JSON.stringify(presence), presenceOriginal, "excluding absent residents does not rewrite world data");
presence.people.list[1].shipAssignment.away = false;
assert.ok(buildWorkforceModel(presence, presenceDraft, service).people.some((person) => person.id === "p-1"), "a returned resident becomes available again");
const children = fixture(); children.people.list[0].ageGroup = "Ре"; children.people.list[0].age = 12;
const childDraft = createWorkforceDraft(children, service);
assert.equal(buildWorkforceModel(children, childDraft, service, { isGM: true }).free, 50);
setWorkforceAllocation(childDraft, "p-0", task, 11);
assert.ok(workforceDraftError(children, childDraft, { isGM: true }), "working child's normal cap is 10 QD");
const legacy = fixture(); legacy.people.list[0].workAssignment = "wood"; legacy.buildings.list[0].assignedWorkerIds = ["p-0"];
legacy.buildings.list[0].workerAdmissionOverrideIds = ["p-0"];
const legacyDraft = createWorkforceDraft(legacy, service);
assert.equal(legacyDraft.allocations["p-0"][0].normalQd, 20);
assert.equal(legacyDraft.allocations["p-0"][0].overtimeQd, 10);
setWorkforceAllocation(legacyDraft, "p-0", task, 12, 0);
const converted = applyWorkforceDraft(clone(legacy), legacyDraft);
assert.deepEqual(converted.buildings.list[0].workerAdmissionOverrideIds, ["p-0"], "conversion preserves GM exceptions");
assert.equal(converted.people.list[0].workAllocationMode, "explicit");
assert.deepEqual(converted.buildings.list[0].assignedWorkerIds, [""]);

const large = fixture(200); large.buildings.list[0].workersMax = 200;
const largeDraft = createWorkforceDraft(large, service), start = performance.now();
for (const person of large.people.list) setWorkforceAllocation(largeDraft, person.id, task, 10);
const largeModel = buildWorkforceModel(large, largeDraft, service, { isGM: true });
assert.equal(largeModel.free, 2000); assert.equal(largeModel.normalQd, 2000);
const largeBefore = { holdings: [large], meta: { revision: 1 } }, largeAfter = { holdings: [applyWorkforceDraft(clone(large), largeDraft)], meta: { revision: 1 } };
const largePatch = buildPlayerPatch(largeBefore, largeAfter);
assert.ok(largePatch.changes.length > 250);
assert.equal(validatePlayerPatch(largeBefore, largePatch).ok, true, "200-resident plan must remain one atomic patch");
console.log(`Workforce model + player patch for 200 residents: ${Math.round(performance.now() - start)} ms.`);
const bulkStart = performance.now();
const largeBulk = proposeWorkforceAssignments(large, createWorkforceDraft(large, service), service, {
  isGM: true, taskKeys: [task.key], personIds: large.people.list.map((row) => row.id), qd: 4
});
assert.equal(largeBulk.changes.length, 200); assert.equal(largeBulk.model.normalQd, 800);
console.log(`Bulk preview for 200 residents: ${Math.round(performance.now() - bulkStart)} ms.`);
const capHolding = fixture(20), capDraft = createWorkforceDraft(capHolding, service);
const capBulk = proposeWorkforceAssignments(capHolding, capDraft, service, { isGM: true, taskKeys: [task.key], personIds: capHolding.people.list.map((row) => row.id), qd: 1 });
assert.equal(capBulk.changes.length, 12); assert.equal(capBulk.skipped.length, 8, "bulk respects distinct building seats");
assert.throws(() => proposeWorkforceAssignments(holding, draft, service, { qd: -2 }), /от 1 до 20/);

const herd = fixture();
herd.buildings.list = [{ ...template("pasture"), id: "cows", templateId: "pasture", lifecycle: "built", constructionStatus: "built", status: "built", assignedWorkerIds: [] }];
const emptyHerdModel = buildWorkforceModel(herd, createWorkforceDraft(herd, service), service, { isGM: true });
assert.equal(emptyHerdModel.taskMap.get("cows::livestock").need, 0);
herd.buildings.list[0].livestock.state.adults = 2;
let herdDraft = createWorkforceDraft(herd, service);
let herdModel = buildWorkforceModel(herd, herdDraft, service, { isGM: true });
let herdTask = herdModel.taskMap.get("cows::livestock");
assert.equal(herdTask.need, 10);
const careProposal = proposeWorkforceAssignments(herd, herdDraft, service, { isGM: true });
assert.equal(careProposal.model.taskMap.get(herdTask.key).missedDays, 0);
assert.equal(careProposal.model.normalQd, 10, "care uses one QD each day, leaves half an adult's time free");
const inefficientService = Object.create(service);
inefficientService._personBuildingEfficiency = () => 0.5;
const soloCare = clone(herd); soloCare.people.list = [soloCare.people.list[0]]; soloCare.buildings.list[0].workersMax = 1;
const inefficientCare = proposeWorkforceAssignments(soloCare, createWorkforceDraft(soloCare, inefficientService), inefficientService, { isGM: true });
assert.equal(inefficientCare.model.taskMap.get(herdTask.key).missedDays, 0, "a half-effective carer needs two raw QD daily, not a hard-coded ten per tenday");
assert.equal(inefficientCare.model.normalQd, 20);
setWorkforceAllocation(herdDraft, "p-0", herdTask, 5); setWorkforceAllocation(herdDraft, "p-1", herdTask, 5);
herdModel = buildWorkforceModel(herd, herdDraft, service, { isGM: true });
assert.equal(herdModel.taskMap.get(herdTask.key).missedDays, 5, "two first-half schedules are not ten days of care");
assert.equal(proposeWorkforceAssignments(herd, herdDraft, service, { isGM: true }).model.taskMap.get(herdTask.key).missedDays, 0);

const waiting = fixture();
const line = waiting.buildings.list[0].productionLines[0];
Object.assign(line, { batchCapacity: 10, batchStartQty: 2, waitingBatches: [{ id: "batch-1", workInputsReserved: true, workReservedOutputQty: 9,
  workReservedInputs: { version: 1, entries: [], timing: { source: "workers", phase: "waiting", waitQd: 80, elapsedQd: 0, workTargetUnits: 10000 } } }] });
const waitingDraft = createWorkforceDraft(waiting, service); setWorkforceAllocation(waitingDraft, "p-0", task, 10);
const waitingModel = buildWorkforceModel(waiting, waitingDraft, service, { isGM: true });
assert.equal(waitingModel.taskMap.get(task.key).idle, true, "free room below batch start is insufficient");
const idleReview = proposeWorkforceIdleReview(waiting, waitingDraft, service, { isGM: true });
assert.equal(idleReview.model.normalQd, 0); assert.equal(waitingDraft.allocations["p-0"][0].normalQd, 10);
waitingDraft.plan.locks.push({ personId: "p-0", sourceId: task.sourceId, functionId: task.functionId });
assert.equal(proposeWorkforceIdleReview(waiting, waitingDraft, service, { isGM: true }).changes.length, 0);
line.waitingBatches[0].workReservedInputs.timing.waitQd = 20;
assert.equal(buildWorkforceModel(waiting, waitingDraft, service, { isGM: true }).taskMap.get(task.key).certainIdle, false, "a batch can free capacity within the tenday");
const preparing = fixture(); Object.assign(preparing.buildings.list[0].productionLines[0], { workInputsReserved: true, workProgressUnits: 20000,
  workReservedInputs: { version: 1, entries: [], timing: { source: "workers", phase: "work", workTargetUnits: 30000, waitQd: 120, elapsedQd: 0 } } });
assert.equal(buildWorkforceModel(preparing, createWorkforceDraft(preparing, service), service, { isGM: true }).taskMap.get(task.key).effectiveNeed, 1, "remaining preparation comes from the funded batch");
const farm = fixture(); farm.buildings.list = [{ ...template("grain-field"), id: "field", templateId: "grain-field", lifecycle: "built", status: "built", constructionStatus: "built", assignedWorkerIds: [] }];
farm.buildings.list[0].agriculture.state = { phase: "sowing", cropId: "grain", sowingProgressQd: 8, sowingSeasonKey: "2026:spring" };
const springService = Object.create(service); springService._agricultureCalendarContext = () => ({ seasonId: "spring", seasonKey: "2026:spring" });
const farmTask = buildWorkforceModel(farm, createWorkforceDraft(farm, springService), springService, { isGM: true }).taskMap.get("field::agriculture");
assert.equal(farmTask.effectiveNeed, 16, "24-QD sowing stage preserves 8 QD already done");

const noInputs = fixture(); noInputs.buildings.list[0].productionLines[0].expenses = "зерно 10";
const noInputDraft = createWorkforceDraft(noInputs, service); noInputDraft.plan.goals = clone(draft.plan.goals);
assert.equal(proposeWorkforceAssignments(noInputs, noInputDraft, service, { isGM: true }).changes.length, 0, "helper cannot presume absent inputs");
const minimum = fixture(); minimum.buildings.list[0].workersMin = 2;
const minDraft = createWorkforceDraft(minimum, service); minDraft.plan.goals = [{ sourceId: "wood", functionId: "production:logs", normalQd: 20 }];
const minProposal = proposeWorkforceAssignments(minimum, minDraft, service, { isGM: true });
assert.equal(minProposal.changes.length, 2, "a two-person task must split labor");
assert.ok(!minProposal.model.taskMap.get(task.key).warnings.some((value) => value.includes("одновременного")));
const specialist = fixture(); specialist.buildings.list[0].workerProfile = { composition: [{ count: 1, group: "МЕДИЦИНА" }] };
specialist.buildings.list[0].workersMin = 2;
specialist.people.list[2].background = "Лекарь";
const specialistDraft = createWorkforceDraft(specialist, service); specialistDraft.plan.goals = clone(minDraft.plan.goals);
const specialistProposal = proposeWorkforceAssignments(specialist, specialistDraft, service, { isGM: true });
assert.equal(specialistProposal.changes[0].personId, "p-2", "required specialists come before generic cheap labor");
assert.equal(specialistProposal.changes.length, 2);
specialist.people.list[2].background = "";
assert.equal(proposeWorkforceAssignments(specialist, specialistDraft, service, { isGM: true }).changes.length, 0, "helper explains missing team instead of funding unusable work");
const overlapping = { workerProfile: { composition: [{ count: 1, backgrounds: ["А", "Б"] }, { count: 1, backgrounds: ["А"] }] } };
assert.equal(buildingCompositionStatus(overlapping, [{ id: "a", background: "А" }, { id: "b", background: "Б" }]).met, true, "matching must reassign a versatile person when necessary");
assert.equal(buildingCompositionStatus(overlapping, [{ id: "a", background: "А" }]).met, false, "one person cannot fill two mandatory slots");
const missingSpecialist = { workerProfile: { composition: [{ count: 5, backgrounds: ["А"] }, { count: 1, backgrounds: ["Б"] }] } };
assert.equal(buildingCompositionStatus(missingSpecialist, Array.from({ length: 200 }, (_, index) => ({ id: String(index), background: "А" }))).met, false);

const disabled = fixture(); disabled.buildings.list[0].functions.production = false;
assert.ok(!buildWorkforceModel(disabled, createWorkforceDraft(disabled, service), service, { isGM: true }).taskMap.has(task.key));
for (const id of ["lazaret", "hospital"]) {
  const medical = fixture(); medical.buildings.list = [{ ...template(id), id, lifecycle: "built", status: "built", constructionStatus: "built", assignedWorkerIds: [] }];
  const medicalModel = buildWorkforceModel(medical, createWorkforceDraft(medical, service), service, { isGM: true });
  assert.ok(!medicalModel.taskMap.has(`${id}::culture`)); assert.ok(medicalModel.taskMap.has(`${id}::medical`));
}

// All templates must produce a model without making optional capacity mandatory.
for (const row of DEFAULT_BUILDING_TEMPLATES) {
  const catalogHolding = fixture();
  catalogHolding.buildings.list = [{ ...clone(row), id: row.id, templateId: row.id, lifecycle: "built", constructionStatus: "built", status: "built", assignedWorkerIds: [] }];
  const catalogModel = buildWorkforceModel(catalogHolding, createWorkforceDraft(catalogHolding, service), service, { isGM: true });
  for (const entry of catalogModel.tasks.filter((entry) => entry.kind === "production")) assert.equal(entry.need, 0, `${row.id}: empty production is optional`);
}
assert.ok(template("inn"));

let data = clone(beforeData), commits = 0;
const store = { skipTransaction: (result) => ({ skip: true, result }), updateHolding: async (_id, mutate) => {
  const proposed = clone(data), result = mutate(proposed.holdings[0], proposed);
  if (result?.skip) return result.result;
  data = proposed; data.meta.revision += 1; commits += 1; return result;
} };
const command = { operationId: "save-1", holdingId: "test", expectedRevision: 7, draft: proposal.draft };
const saved = await executeWorkforcePlan(command, { store, getUser: () => ({ isGM: true }) });
assert.equal(saved.ok, true);
assert.equal((await executeWorkforcePlan(command, { store, getUser: () => ({ isGM: true }) })).replay, true);
assert.equal(commits, 1);
assert.equal(validatePlayerPatch(beforeData, buildPlayerPatch(beforeData, data)).ok, true, "saved planner log is an allowed append-only player action");
const staleData = clone(beforeData); staleData.meta.revision = 8;
assert.equal(validatePlayerPatch(staleData, buildPlayerPatch(beforeData, data)).ok, false, "authority rejects stale workforce commands even with disjoint changes");
assert.equal((await executeWorkforcePlan({ ...command, operationId: "save-2" }, { store, getUser: () => ({ isGM: true }) })).conflict, true);
assert.equal((await executeWorkforcePlan({ ...command, operationId: "save-3", expectedRevision: 8 }, { store, getUser: () => ({ isGM: false }) })).ok, false, "player without authority cannot write locally");
console.log(`Workforce planner: optional capacity, shared budgets, wages, locks, hidden data, legacy conversion, ${DEFAULT_BUILDING_TEMPLATES.length} templates, 200-resident authority patch and replay passed.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkWorkforcePlanner();
}
