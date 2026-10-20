import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { isResidentAway, isResidentPresent } from "../data/resident-presence.js";
import { buildingStaffingWorkerIds, explicitWorkerIdsForBuilding, validateHoldingWorkAllocations } from "../data/work-allocations.js";
import { runFoodConsumption } from "../engines/economy/food-consumption.js";
import { normalizeFoodRationUnits, resolveFoodRation } from "../engines/economy/food-rations.js";
import { embarkShipCrew, disembarkShipCrew } from "../engines/ships/crew.js";
import { isCivilianWorkerCandidate } from "../engines/workers/assignment-planner.js";
import { ResidentDomain } from "../apps/domains/resident-domain.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fixture() {
  return {
    people: {
      list: [
        {
          id: "alice",
          name: "Алиса",
          profession: "Механик",
          status: "resident",
          role: "Мастерская",
          workAssignment: "workshop",
          workAllocationMode: "legacy",
          workAllocations: []
        },
        {
          id: "boris",
          name: "Борис",
          profession: "Плотник",
          status: "resident",
          role: "Плотник",
          workAssignment: "workshop",
          workAllocationMode: "explicit",
          workAllocations: [{ sourceId: "workshop", functionId: "production", normalQd: 20, overtimeQd: 0 }]
        },
        { id: "clara", name: "Клара", role: "Свободен", workAssignment: "", workAllocationMode: "legacy", workAllocations: [] }
      ]
    },
    buildings: {
      list: [{
        id: "workshop",
        name: "Мастерская",
        workersMax: 3,
        assignedWorkerIds: ["alice", "", ""],
        workerAdmissionOverrideIds: ["alice", "clara"]
      }]
    },
    constructionCrews: [{ id: "builders", memberIds: ["boris", "clara"], distributedIds: ["alice"], leaderId: "alice", distributedLeaderId: "" }],
    constructionCrewIds: ["boris", "clara"],
    gm: {
      defense: {
        commanderId: "",
        squads: [{ id: "watch", sergeantId: "boris", memberIds: ["alice", "", "", ""] }]
      }
    }
  };
}

const plannerDependencies = {
  safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
  buildingOperationalState: () => ({ operational: true }),
  workerEfficiencyForPerson: () => ({ value: 1 }),
  isSoldierResident: () => false,
  isMilitaryResidentLike: () => false,
  setPersonFree: () => {},
  assignedWorkerSet: () => new Set(),
  applyPersonSalaryForAssignment: () => {}
};

function foodDependencies() {
  return {
    safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    normalizeResourceId: (value) => String(value ?? ""),
    resourceDef: () => ({ foodEdible: true, foodType: "prepared" }),
    resourceLabel: (value) => String(value ?? "Пища"),
    formatNumber: String,
    normalizeFoodRationUnits,
    resolveFoodRation,
    foodRationTierLabel: (value) => value,
    isResourceBatchPeriodActive: () => false,
    syncResourceRowBatches: () => {},
    availableResourceRowQuantity: (row) => row.qty,
    availableResourceBatchInventory: (row) => row.batches,
    takeResourceBatchById: (row, batchId, qty) => {
      const batch = row.batches.find((candidate) => candidate.id === batchId);
      const take = Math.min(batch?.qty ?? 0, qty);
      if (!take) return null;
      batch.qty -= take;
      row.qty -= take;
      return { qty: take };
    },
    applySettlementHunger: () => ({ before: 0, after: 0, factor: 1 }),
    hungerPenaltyFactor: () => 1,
    normalizeHungerLevel: () => 0
  };
}

function foodHolding() {
  return {
    people: { list: [{ id: "home" }, { id: "voyager", shipAssignment: { shipId: "magnifique", away: true, sinceQd: 0 } }] },
    gm: { food: { rationUnitsPerResident: 10, hungerLevel: 0 } },
    special: {},
    storage: { resources: [{ id: "food", resourceId: "bread", name: "Хлеб", qty: 100, batches: [{ id: "batch", qty: 100, ageQd: 0 }] }] }
  };
}

export function checkShipCrewPresenceCharacterization() {
  const holding = fixture();
  const ship = { id: "magnifique", crewResidentIds: ["alice", "boris"] };
  const result = embarkShipCrew(holding, ship, 40);
  assert.equal(result.ok, true);
  assert.equal(result.changed, 2);
  assert.equal(result.issues.length, 0);
  assert.equal(result.clearedAssignments > 0, true);

  const alice = holding.people.list[0];
  const boris = holding.people.list[1];
  assert.equal(isResidentAway(alice), true);
  assert.equal(isResidentPresent(alice), false);
  assert.equal(alice.shipAssignment.shipId, "magnifique");
  assert.equal(alice.shipAssignment.sinceQd, 40);
  assert.equal(alice.shipAssignment.previousSettlementPlan.workAssignment, "workshop");
  assert.deepEqual(alice.shipAssignment.previousSettlementPlan.buildings[0].workerSlots, [0]);
  assert.equal(alice.profession, "Механик", "embark must preserve intrinsic profession");
  assert.equal(alice.status, "resident", "embark must preserve intrinsic resident status");
  assert.equal(alice.role, "Мастерская", "embark must not overwrite descriptive resident role");
  assert.equal(alice.workAssignment, "");
  assert.deepEqual(boris.workAllocations, []);
  assert.deepEqual(holding.buildings.list[0].assignedWorkerIds, ["", "", ""]);
  assert.deepEqual(holding.buildings.list[0].workerAdmissionOverrideIds, ["clara"]);
  assert.deepEqual(holding.constructionCrews[0].memberIds, ["clara"]);
  assert.equal(holding.constructionCrews[0].leaderId, "");
  assert.deepEqual(holding.constructionCrews[0].distributedIds, []);
  assert.deepEqual(holding.constructionCrewIds, ["clara"]);
  assert.equal(holding.gm.defense.squads[0].sergeantId, "");
  assert.deepEqual(holding.gm.defense.squads[0].memberIds, ["", "", "", ""]);
  assert.deepEqual(buildingStaffingWorkerIds(holding, "workshop"), []);
  assert.deepEqual(explicitWorkerIdsForBuilding(holding, "workshop"), []);
  assert.equal(validateHoldingWorkAllocations(holding).ok, true);
  assert.equal(isCivilianWorkerCandidate(alice, holding.buildings.list[0], plannerDependencies), false);
  assert.equal(ResidentDomain._canResidentWork.call({
    _isResidentInjured: () => false,
    _isChildResident: () => false,
    _safeNumber: Number,
    _childWorkThreshold: () => 12
  }, alice), false, "the central resident availability helper must keep away crew out of assignment controls");

  const replay = embarkShipCrew(holding, ship, 44);
  assert.equal(replay.changed, 0, "repeated embark must not replace original departure metadata");
  assert.equal(alice.shipAssignment.sinceQd, 40);

  const returned = disembarkShipCrew(holding, ship, 52);
  assert.equal(returned.changed, 2);
  assert.equal(isResidentPresent(alice), true);
  assert.equal(alice.shipAssignment.returnedQd, 52);
  assert.equal(alice.workAssignment, "", "return must not restore a possibly occupied job slot");
  assert.deepEqual(holding.buildings.list[0].assignedWorkerIds, ["", "", ""]);

  const invalidHolding = fixture();
  const beforeInvalid = clone(invalidHolding);
  assert.throws(() => embarkShipCrew(invalidHolding, { id: "bad", crewResidentIds: ["alice", "alice"] }, 0), /duplicate/);
  assert.deepEqual(invalidHolding, beforeInvalid, "crew validation must finish before any draft mutation");
  invalidHolding.people.list[0].shipAssignment = { shipId: "other", away: true, sinceQd: 0 };
  const beforeConflict = clone(invalidHolding);
  assert.throws(() => embarkShipCrew(invalidHolding, { id: "bad", crewResidentIds: ["alice", "missing"] }, 0), /missing residents/);
  assert.deepEqual(invalidHolding, beforeConflict);
  assert.throws(() => embarkShipCrew(invalidHolding, { id: "bad", crewResidentIds: ["alice"] }, 0), /another ship/);

  const defaultFoodHolding = foodHolding();
  const defaultFood = runFoodConsumption({ holding: defaultFoodHolding, qd: 40, dependencies: foodDependencies() });
  assert.equal(defaultFood.residentDays, 10, "away residents must consume no settlement food by default");
  assert.equal(defaultFood.needed, 10);
  assert.equal(defaultFoodHolding.storage.resources[0].qty, 90);

  const proratedFoodHolding = foodHolding();
  const proratedFood = runFoodConsumption({
    holding: proratedFoodHolding,
    qd: 40,
    residentPresenceDaysById: new Map([["home", 10], ["voyager", 4.5]]),
    dependencies: foodDependencies()
  });
  assert.equal(proratedFood.residentDays, 14.5, "explicit home days must override the end-of-period away marker");
  assert.equal(proratedFood.needed, 15, "fractional resident-days must round only at the final resource quantity");
  assert.equal(proratedFoodHolding.storage.resources[0].qty, 85);

  assert.equal(resolveFoodRation({ residentDays: 14.5, available: 100, selectedUnits: 10 }).selectedTarget, 15);
  const restingHolding = foodHolding();
  restingHolding.people.list[1].shipAssignment.away = false;
  restingHolding.special.ships = { list: [{ id: "magnifique", status: "docked", location: { kind: "home" }, crewResidentIds: ["voyager"] }] };
  const restingFood = runFoodConsumption({ holding: restingHolding, qd: 40, dependencies: foodDependencies() });
  assert.equal(restingFood.needed, 10, "without a supplied voyage map, resting crew still eats aboard, not from settlement stock");
  assert.equal(restingFood.hungryResidentDays, 0);
  restingHolding.people.list[1].shipAssignment.shoreDuty = true;
  const shoreFood = runFoodConsumption({ holding: restingHolding, qd: 40, dependencies: foodDependencies() });
  assert.equal(shoreFood.needed, 20, "shore duty restores normal settlement rations");
  return { ok: true };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkShipCrewPresenceCharacterization();
  console.log("FBL Skyhold ship crew presence characterization check passed.");
}
