import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { getSkyholdWorkflowService } from "../workflows/skyhold-workflow-service.js";
import { createWorkforceDraft, buildWorkforceModel, proposeWorkforceAssignments, applyWorkforceDraft,
  workforceDraftError } from "../apps/domains/workforce-planner.js";
import { setWorkforceStaff } from "../apps/domains/workforce-staff.js";

const service = getSkyholdWorkflowService();
function fixture({ composition = [{ count: 1, group: "МЕДИЦИНА" }], places = 1, people = [
  { id: "cheap", wageDailyOverrideCopper: 6 },
  { id: "medic", background: "Лекарь", wageDailyOverrideCopper: 24 }
] } = {}) {
  return mergeHoldingDefaults({ id: "holding", name: "Тест", visibility: "public", gm: { playersCanEditBuildings: true },
    buildings: { list: [{ id: "workshop", name: "Мастерская", status: "built", lifecycle: "built", constructionStatus: "built",
      condition: "normal", visibility: "public", labor: { version: 1, mode: "staff", capacityQd: null },
      workersMin: 0, workersMax: places, wageDailyCopper: 12, assignedWorkerIds: [], workerProfile: { composition },
      functions: { production: true }, productionLines: [
        { id: "first", active: true, source: "workers", workQd: 1, outputQty: 1, resourceId: "wood" },
        { id: "second", active: true, source: "workers", workQd: 1, outputQty: 1, resourceId: "stone" }
      ] }] },
    people: { list: people.map((person) => ({ name: person.id, age: 30, ageGroup: "Вз", race: "Человек",
      visibility: "public", workAssignment: "", workAllocationMode: "explicit", workAllocations: [],
      attributes: { strength: 4, agility: 4, wits: 4, empathy: 4 }, ...person })) } });
}

function propose(holding, amount = 20) {
  const draft = createWorkforceDraft(holding, service);
  draft.plan.goals = [{ sourceId: "workshop", functionId: "production:first", normalQd: amount }];
  return proposeWorkforceAssignments(holding, draft, service, { isGM: true });
}

export function checkHybridStaffSelection() {
  const holding = fixture(), before = JSON.stringify(holding);
  const result = propose(holding);
  assert.deepEqual(result.changes.map((row) => row.personId), ["medic"], "One seat must go to the required specialist before cheaper generic labor");
  assert.equal(result.model.normalQd, 20);
  assert.equal(workforceDraftError(holding, result.draft, { isGM: true }), "");
  assert.equal(result.model.taskMap.get("workshop::production:first").warnings.length, 0);
  assert.equal(JSON.stringify(holding), before, "Suggestions never write to the settlement");

  const missing = fixture({ people: [{ id: "cheap" }] });
  assert.equal(propose(missing).changes.length, 0, "Do not pay for a team that cannot meet its mandatory composition");
  const overlapping = { composition: [{ count: 1, backgrounds: ["А", "Б"] }, { count: 1, backgrounds: ["А"] }],
    places: 3, people: [{ id: "cheap" }, { id: "a", background: "А" }, { id: "b", background: "Б" }] };
  const team = propose(fixture(overlapping), 1);
  assert.deepEqual(new Set(team.changes.map((row) => row.personId)), new Set(["a", "b"]),
    "Finish the distinct-person core even when the first employee already covers the QD goal");
  assert.equal(team.model.normalQd, 40);
  assert.ok(!team.model.taskMap.get("workshop::production:first").warnings.some((text) => text.includes("состав")));
  assert.equal(propose(fixture({ ...overlapping, people: [{ id: "a", background: "А" }] }), 1).changes.length, 0,
    "One versatile employee cannot fill two required positions");
  assert.equal(propose(fixture({ ...overlapping, places: 1 }), 1).changes.length, 0,
    "An incomplete core cannot be proposed when there are too few seats");

  const shared = fixture({ places: 2 }), sharedDraft = createWorkforceDraft(shared, service);
  const second = buildWorkforceModel(shared, sharedDraft, service, { isGM: true }).taskMap.get("workshop::production:second");
  setWorkforceStaff(sharedDraft, shared.people.list[1], second);
  const staffed = applyWorkforceDraft(structuredClone(shared), sharedDraft);
  assert.deepEqual(propose(staffed).changes.map((row) => row.personId), ["cheap"],
    "A specialist on another production line belongs to the same simultaneous building shift");
  staffed.people.list[1].injuredDays = 1;
  assert.equal(propose(staffed).changes.length, 0, "An injured employee cannot fulfill the shift's mandatory composition");

  const ordinary = fixture({ composition: [], places: 3 });
  assert.equal(propose(ordinary, 1).changes.length, 1, "Absent a composition requirement, hire only the chosen goal's necessary staff");
  return { qualifiedCore: true, distinctPeople: true, sharedShift: true, capacity: true, unavailable: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(checkHybridStaffSelection()));
}
