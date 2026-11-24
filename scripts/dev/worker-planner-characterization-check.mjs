import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AssignmentDomain } from "../apps/domains/assignment-domain.js";
import { BuildingEventDomain } from "../apps/domains/events/building-events.js";
import { LABOR_SCHEMA_VERSION, buildingAcceptsWorkers } from "../data/labor-model.js";
import { buildingWorkerIds } from "../data/work-allocations.js";
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
        {
          id: "workshop", name: "Мастерская", status: "built", constructionStatus: "built",
          workersMax: 2, labor: { version: LABOR_SCHEMA_VERSION, capacityQd: 40 },
          functions: { production: true },
          productionLines: [{ id: "main", active: true, source: "workers", resourceId: "wood", outputQty: 1, workQd: 1 }]
        },
        {
          id: "ruin", name: "Руины", status: "planned", constructionStatus: "planned",
          workersMax: 5, labor: { version: LABOR_SCHEMA_VERSION, capacityQd: 100 },
          functions: { production: true },
          productionLines: [{ id: "main", active: true, source: "workers", resourceId: "wood", outputQty: 1, workQd: 1 }]
        }
      ]
    },
    constructionCrews: [],
    constructionCrewIds: [],
    workforcePlan: { locks: [], goals: [], productionGoals: [] },
    people: {
      list: [
        { id: "alice", name: "Алиса", role: "Свободен", workAssignment: "", workAllocations: [], age: 30, ageGroup: "Вз", attributes: { strength: 4, agility: 3, wits: 3, empathy: 3 } },
        { id: "boris", name: "Борис", role: "Свободен", workAssignment: "", workAllocations: [], age: 28, ageGroup: "Вз", attributes: { strength: 3, agility: 3, wits: 3, empathy: 3 } },
        { id: "soldier", name: "Страж", role: "Солдат", workAssignment: "soldier", workAllocations: [], age: 32, ageGroup: "Вз", attributes: { strength: 5, agility: 4, wits: 3, empathy: 3 } }
      ]
    },
    storage: { resources: [], items: [], log: [], moneyCopper: 0 },
    special: { list: [] },
    log: []
  };
}

function makeHarness() {
  return {
    ...AssignmentDomain,
    ...BuildingEventDomain,
    _safeNumber: (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback),
    _clearPersonFromAssignments: clearPersonFromAssignments,
    _constructionCrews: (holding) => holding?.constructionCrews ?? [],
    _isChildResident: (person) => person?.ageGroup === "Ре",
    _canResidentWork: (person) => !(person?.ageGroup === "Ре" && Number(person?.age ?? 0) < 12)
  };
}

export function checkWorkerPlannerCharacterization() {
  const original = holdingFixture();
  const harness = makeHarness();
  const workshop = original.buildings.list[0];
  assert.equal(buildingAcceptsWorkers(workshop), true);
  assert.equal(buildingAcceptsWorkers({ ...workshop, labor: { version: 2, capacityQd: 0 } }), false, "zero-capacity buildings cannot accept workers");

  const probe = clone(original);
  assert.equal(harness._assignPersonToBuilding(probe, "alice", "ruin"), false, "planned buildings cannot accept workers");
  assert.equal(harness._assignPersonToBuilding(probe, "soldier", "workshop"), false, "military workers cannot fill civilian jobs");
  probe.people.list.push(
    { id: "dead", age: 30, dead: true, workAllocations: [] },
    { id: "injured", age: 30, injuredDays: 1, workAllocations: [] },
    { id: "child11", age: 11, ageGroup: "Ре", workAllocations: [] },
    { id: "away", age: 30, shipAssignment: { shipId: "away", away: true }, workAllocations: [] },
    { id: "child12", age: 12, ageGroup: "Ре", workAllocations: [] }
  );
  for (const id of ["dead", "injured", "child11", "away"]) {
    assert.equal(harness._assignPersonToBuilding(probe, id, "workshop"), false, `${id} cannot be assigned`);
  }
  assert.equal(harness._assignPersonToBuilding(probe, "child12", "workshop"), true, "12-year-old child can accept up to half adult normal QD");
  assert.equal(probe.people.list.find((row) => row.id === "child12").workAllocations[0].normalQd, 10);

  const previewHolding = clone(original);
  const fillHint = harness._fillBuildingWorkers(previewHolding, "workshop");
  assert.equal(fillHint.assigned, 0);
  assert.match(fillHint.message, /План работ/);
  assert.equal(harness._assignPersonToBuilding(previewHolding, "alice", "workshop"), true);
  assert.equal(harness._assignPersonToBuilding(previewHolding, "boris", "workshop"), true);
  assert.deepEqual(buildingWorkerIds(previewHolding, "workshop"), ["alice", "boris"]);
  previewHolding.people.list.push({ id: "extra", name: "Extra", age: 30, workAllocations: [] });
  assert.equal(harness._assignPersonToBuilding(previewHolding, "extra", "workshop"), false, "assignments must respect building capacityQd (40 QD)");
  assert.equal(original.people.list[0].workAllocations.length, 0, "clone mutations must not mutate live holding data");
  assert.equal(previewHolding.gm.defense.commanderId, "soldier", "assignment must retain defense leadership");

  previewHolding.workforcePlan.locks = [{ personId: "boris", sourceId: "workshop", functionId: "production:main" }];
  const clearResult = harness._clearBuildingWorkers(previewHolding, "workshop");
  assert.equal(clearResult.cleared, 1);
  assert.deepEqual(buildingWorkerIds(previewHolding, "workshop"), ["boris"]);

  const operationId = "worker-plan-1";
  const firstLog = appendHoldingOperation(previewHolding, {
    operationId,
    type: "worker-assignment",
    createdAt: "2026-07-12T12:00:00.000Z",
    title: "План работников",
    summary: clearResult.message,
    assigned: 0,
    cleared: 1
  });
  const secondLog = appendHoldingOperation(previewHolding, { operationId, type: "worker-assignment" });
  assert.equal(firstLog, secondLog, "operation log must make planner audit entries idempotent");
  assert.equal(previewHolding.log.length, 1, "repeated operation id must not append a second audit row");

  const current = { meta: { revision: 4 }, holdings: [original], catalog: { buildings: [] } };
  const proposed = clone(current);
  assert.equal(harness._assignPersonToBuilding(proposed.holdings[0], "alice", "workshop"), true);
  appendHoldingOperation(proposed.holdings[0], {
    operationId: "worker-plan-player",
    type: "worker-assignment",
    createdAt: "2026-07-12T12:05:00.000Z",
    title: "План работников",
    summary: "Алиса: 20 QD",
    assigned: 1,
    cleared: 0
  });
  const patch = buildPlayerPatch(current, proposed);
  assert.equal(patch.action, "buildings", "planner patch must remain in the building permission domain");
  assert.equal(validatePlayerPatch(current, patch).ok, true, "authority guard must accept an append-only planner audit with permitted building allocations");

  const tampered = clone(proposed);
  tampered.holdings[0].log[0].summary = "переписано";
  const tamperedPatch = buildPlayerPatch(proposed, tampered);
  assert.equal(validatePlayerPatch(proposed, tamperedPatch).ok, false, "authority guard must reject rewriting an existing operation audit row");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkWorkerPlannerCharacterization();
  console.log("FBL Skyhold worker assignment: unified QD assignment, locks, audit and authority guard passed.");
}
