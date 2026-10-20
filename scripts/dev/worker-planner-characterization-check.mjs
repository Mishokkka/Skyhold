import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isBuiltAssignableBuilding, isCivilianWorkerCandidate, workerAssignmentScore } from "../engines/workers/assignment-planner.js";
import { BuildingEventDomain } from "../apps/domains/events/building-events.js";
import { clearPersonFromAssignments } from "../data/resident-assignments.js";
import { appendHoldingOperation } from "../data/operations.js";
import { buildPlayerPatch, validatePlayerPatch } from "../data/player-write-guard.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function holdingFixture() {
  return {
    id: "holding-1",
    visibility: "public",
    overview: { development: { food: 2, technology: 2, culture: 2, war: 2 } },
    gm: {
      playersCanEditBuildings: true,
      defense: { commanderId: "soldier", squads: [] }
    },
    buildings: {
      list: [
        { id: "workshop", name: "Мастерская", status: "built", workersMax: 2, assignedWorkerIds: ["", ""] },
        { id: "ruin", name: "Руины", status: "planned", workersMax: 5, assignedWorkerIds: [] }
      ]
    },
    constructionCrews: [],
    constructionCrewIds: [],
    people: {
      list: [
        { id: "alice", name: "Алиса", role: "Свободен", workAssignment: "", age: 30, ageGroup: "Вз", aptitude: 3 },
        { id: "boris", name: "Борис", role: "Свободен", workAssignment: "", age: 28, ageGroup: "Вз", aptitude: 2 },
        { id: "soldier", name: "Страж", role: "Солдат", workAssignment: "soldier", age: 32, ageGroup: "Вз", aptitude: 5 }
      ]
    },
    storage: { resources: [], items: [], log: [], moneyCopper: 0 },
    special: { list: [] },
    log: []
  };
}

function dependencies() {
  return {
    safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    buildingOperationalState: (building) => ({ operational: building?.status === "built" }),
    workerEfficiencyForPerson: (_holding, _building, person) => ({ value: Number(person?.aptitude ?? 1) }),
    isSoldierResident: (person) => String(person?.role ?? "") === "Солдат",
    isMilitaryResidentLike: (person) => String(person?.workAssignment ?? "") === "soldier"
  };
}

function manualAssignmentDraft(holding) {
  const deps = dependencies();
  const adapter = { ...BuildingEventDomain, _workerPlannerDependencies: () => deps, _safeNumber: deps.safeNumber,
    _clearPersonFromAssignments: clearPersonFromAssignments };
  return adapter._fillBuildingWorkers(holding, "workshop");
}

export function checkWorkerPlannerCharacterization() {
  const original = holdingFixture();
  const deps = dependencies(), workshop = original.buildings.list[0], alice = original.people.list[0], soldier = original.people.list[2];
  assert.equal(isBuiltAssignableBuilding(workshop, deps), true);
  assert.equal(isBuiltAssignableBuilding(original.buildings.list[1], deps), false, "planned buildings cannot accept workers");
  assert.equal(isBuiltAssignableBuilding({ ...workshop, workersMax: 0 }, deps), false, "buildings without slots cannot accept workers");
  assert.equal(isCivilianWorkerCandidate(soldier, workshop, deps, original), false, "military workers cannot fill civilian jobs");
  const barracks = { ...workshop, functions: { defense: true } };
  assert.equal(isCivilianWorkerCandidate(soldier, barracks, deps, original), true, "military workers remain eligible for defense jobs");
  for (const person of [{ ...alice, dead: true }, { ...alice, injuredDays: 1 }, { ...alice, age: 11, ageGroup: "Ре" },
    { ...alice, shipAssignment: { shipId: "away", away: true } }]) {
    assert.equal(isCivilianWorkerCandidate(person, workshop, deps, original), false, "dead, injured, young or absent residents cannot be suggested");
  }
  assert.equal(isCivilianWorkerCandidate({ ...alice, age: 12, ageGroup: "Ре" }, workshop, deps, original), true, "the existing twelve-year eligibility boundary must remain intact");
  assert.equal(workerAssignmentScore(original, workshop, alice, deps), 3);
  assert.equal(workerAssignmentScore(original, barracks, soldier, deps), 5.5, "defense work retains its military suitability bonus");
  assert.equal(workerAssignmentScore(original, workshop, { ...alice, aptitude: -2 }, deps), 0, "negative suitability cannot become a candidate score");
  const previewHolding = clone(original);
  const preview = manualAssignmentDraft(previewHolding);
  const assignedIds = previewHolding.buildings.list[0].assignedWorkerIds;
  assert.equal(preview.assigned, 2, "the live context-menu assignment must fill available slots");
  assert.deepEqual(assignedIds, ["alice", "boris"], "the live context menu must rank deterministic candidates by score");
  assert.equal(original.buildings.list[0].assignedWorkerIds[0], "", "preview on a clone must not mutate live holding data");
  assert.equal(new Set(assignedIds).size, preview.assigned, "the live context menu must not assign one resident twice");
  assert.deepEqual(previewHolding.buildings.list[1].assignedWorkerIds, [], "manual assignment must leave non-operational buildings untouched");
  assert.equal(previewHolding.gm.defense.commanderId, "soldier", "manual assignment must retain defense leadership");

  const operationId = "worker-plan-1";
  const firstLog = appendHoldingOperation(previewHolding, {
    operationId,
    type: "worker-assignment",
    createdAt: "2026-07-12T12:00:00.000Z",
    title: "План работников",
    summary: preview.message,
    assigned: preview.assigned,
    cleared: 0
  });
  const secondLog = appendHoldingOperation(previewHolding, { operationId, type: "worker-assignment" });
  assert.equal(firstLog, secondLog, "operation log must make planner audit entries idempotent");
  assert.equal(previewHolding.log.length, 1, "repeated operation id must not append a second audit row");

  const current = { meta: { revision: 4 }, holdings: [original], catalog: { buildings: [] } };
  const proposed = clone(current);
  const applied = manualAssignmentDraft(proposed.holdings[0]);
  appendHoldingOperation(proposed.holdings[0], {
    operationId: "worker-plan-player",
    type: "worker-assignment",
    createdAt: "2026-07-12T12:05:00.000Z",
    title: "План работников",
    summary: applied.message,
    assigned: applied.assigned,
    cleared: 0
  });
  const patch = buildPlayerPatch(current, proposed);
  assert.equal(patch.action, "buildings", "planner patch must remain in the building permission domain");
  assert.equal(validatePlayerPatch(current, patch).ok, true, "authority guard must accept an append-only planner audit with permitted building assignments");

  const tampered = clone(proposed);
  tampered.holdings[0].log[0].summary = "переписано";
  const tamperedPatch = buildPlayerPatch(proposed, tampered);
  assert.equal(validatePlayerPatch(proposed, tamperedPatch).ok, false, "authority guard must reject rewriting an existing operation audit row");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkWorkerPlannerCharacterization();
  console.log("FBL Skyhold worker assignment: live eligibility/scoring, context-menu draft, audit and authority guard passed.");
}
