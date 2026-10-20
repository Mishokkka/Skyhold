import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { advanceBuildingProject, buildingOperationalState } from "../core/building-state.js";
import { addResourceBatches, takeResourceBatches } from "../core/resource-batches.js";
import { createConstructionOperationExecutor } from "../apps/construction-operation-executor.js";
import { AssignmentDomain } from "../apps/domains/assignment-domain.js";
import { buildPlayerPatch, validatePlayerPatch } from "../data/player-write-guard.js";
import { runConstruction } from "../engines/economy/construction.js";
import {
  applyConstructionCancellation,
  constructionAttemptGate,
  constructionPeriodForHolding,
  constructionStageCosts,
  planConstructionCancellation,
  resolveConstructionAttempt
} from "../engines/economy/construction-stages.js";
import { planStorageCosts } from "../engines/storage/group-payment.js";
import { payStorageCosts } from "../engines/storage/payment.js";
import { applyConstructionProjectCancellation } from "../workflows/economy/construction-cancellation.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function resourceId(row = {}) {
  return String(row.resourceId ?? row.id ?? row.name ?? "");
}

function storageQuantity(holding, cost = {}) {
  if (resourceId(cost) === "money") return Math.max(0, Math.floor(Number(holding?.storage?.moneyCopper) || 0));
  const room = cost.roomId === undefined ? null : String(cost.roomId || "outdoors");
  return (holding?.storage?.resources ?? [])
    .filter((row) => resourceId(row) === resourceId(cost))
    .filter((row) => room === null || String(row.roomId || "outdoors") === room)
    .reduce((sum, row) => sum + Math.max(0, Math.floor(Number(row.qty) || 0)), 0);
}

function storageAdd(holding, cost = {}, qty = 0) {
  const amount = Math.trunc(Number(qty) || 0);
  if (resourceId(cost) === "money") {
    holding.storage.moneyCopper = Math.max(0, Math.floor(Number(holding.storage.moneyCopper) || 0) + amount);
    return null;
  }
  const roomId = String(cost.roomId || "outdoors");
  let row = holding.storage.resources.find((candidate) => (
    resourceId(candidate) === resourceId(cost)
      && String(candidate.roomId || "outdoors") === roomId
  ));
  if (!row) {
    row = {
      id: `stored-${holding.storage.resources.length + 1}`,
      resourceId: resourceId(cost),
      name: String(cost.name || resourceId(cost)),
      roomId,
      qty: 0,
      batches: [],
      categoryTag: String(cost.categoryTag || "")
    };
    holding.storage.resources.push(row);
  }
  if (amount > 0) addResourceBatches(row, { qty: amount });
  else takeResourceBatches(row, Math.abs(amount));
  return row;
}

function paymentPlan(holding, costs) {
  return planStorageCosts({
    holding,
    costs,
    dependencies: {
      safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
      isMoneyResource: (...values) => values.some((value) => String(value ?? "") === "money"),
      storageResourceMatches: (row, cost) => resourceId(row) === resourceId(cost),
      resourceMatchesGroup: (row, groupId) => String(row.categoryTag ?? "") === String(groupId ?? ""),
      normalizeRoomId: (value) => String(value || "outdoors")
    }
  });
}

function paymentApply(holding, costs) {
  return payStorageCosts({
    holding,
    costs,
    dependencies: {
      safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
      isMoneyResource: (...values) => values.some((value) => String(value ?? "") === "money"),
      storageQuantity,
      addMoney: (draft, amount) => storageAdd(draft, { resourceId: "money" }, amount),
      storageAdd,
      storageResourceMatches: (row, cost) => resourceId(row) === resourceId(cost)
    }
  });
}

function dependencies(log = []) {
  return {
    buildingOperationalState,
    advanceBuildingProject,
    planStorageCosts: paymentPlan,
    payStorageCosts: paymentApply,
    addStorageWithOverflow: (holding, row, qty) => {
      storageAdd(holding, row, qty);
      return [{ roomId: String(row.roomId || "outdoors"), qty: Math.floor(Number(qty) || 0), overflowFrom: "" }];
    },
    appendStorageLog: (_holding, entries) => log.push(...entries)
  };
}

function holding(resources = []) {
  return {
    gm: { calendaria: { lastQd: 0 } },
    constructionCrews: [{ id: "crew", name: "Бригада", memberIds: ["worker", "worker-2"], leaderId: "foreman" }],
    people: { list: [
      { id: "worker", role: "Бригада", workAssignment: "construction:crew", attributes: { strength: 4, agility: 4, wits: 3, empathy: 3 } },
      { id: "worker-2", role: "Бригада", workAssignment: "construction:crew", attributes: { strength: 4, agility: 3, wits: 4, empathy: 3 } },
      { id: "foreman", role: "Руководитель: Бригада", workAssignment: "construction-leader:crew", attributes: { strength: 3, agility: 3, wits: 4, empathy: 4 }, traitsText: "Лидер" }
    ] },
    buildings: { list: [] },
    storage: {
      moneyCopper: 0,
      resources: resources.map((row, index) => ({
        id: row.id || `resource-${index + 1}`,
        roomId: "outdoors",
        ...row,
        qty: Math.max(0, Math.floor(Number(row.qty) || 0))
      })),
      log: []
    }
  };
}

function project(overrides = {}) {
  return {
    id: "project",
    name: "Проект",
    lifecycle: "building",
    condition: "intact",
    constructionStatus: "building",
    constructionCrewId: "crew",
    buildProgress: 0,
    buildTarget: 4,
    materialCosts: [{ resourceId: "wood", name: "Древесина", qty: 7 }],
    ...overrides
  };
}

function quantity(draft, id) {
  return storageQuantity(draft, { resourceId: id });
}

export async function checkConstructionStageCharacterization() {
  {
    const context = {
      ...AssignmentDomain,
      _safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
      _canResidentWork: (person) => !person.away,
      _workerType: (person) => person.workerType || "Рабочий",
      _attributeSummary: () => "",
      _traitBadges: (text = "") => text.split(",").map((name) => ({ name: name.trim() })),
      _workerTypeMatchesCriterion: (type, criterion) => type.toLowerCase() === criterion,
      _calculateMorale: () => 0,
      _moraleState: () => ({ label: "Апатия" })
    };
    const leader = { id: "leader", workerType: "Умелец", attributes: { wits: 5, empathy: 4 }, traitsText: "Лидер" };
    const holding = { people: { list: [leader, { id: "one" }, { id: "two" }] } };
    const crew = { id: "crew", memberIds: ["one", "two", "leader"], leaderId: "leader", suitableWorkerTypes: "Умелец" };
    const prepare = () => context._prepareConstructionCrew(holding, crew);
    const result = prepare();
    assert.equal(result.leader.contribution, 2, "leader labor includes base and suitable type dice");
    assert.match(result.leader.contributionReasons, /подходящий тип/);
    assert.equal(result.count, 2, "leader remains separate from required worker slots");
    assert.equal(result.leaderBonus, 1, "coordination is added separately from leader labor");
    assert.equal(result.rawDice, 5, "leader labor is counted once even if duplicated in memberIds");
    assert.equal(result.dice, 3, "morale applies to the complete pool including leader labor");
    leader.traitsText = "Лидер, Больная спина";
    assert.equal(prepare().leader.contribution, 1, "worker penalties also affect leader labor");
    leader.traitsText = "";
    assert.equal(prepare().leader.contribution, 2, "qualified manager contributes labor without Leader trait");
    assert.equal(prepare().leaderBonus, 0);
    leader.attributes = { wits: 2, empathy: 2 };
    assert.equal(prepare().leader.contribution, 0, "unqualified leader cannot contribute");
    leader.attributes = { wits: 5, empathy: 4 };
    for (const unavailable of [{ dead: true }, { injuredDays: 1 }, { away: true }]) {
      Object.assign(leader, unavailable);
      assert.equal(prepare().leader, null, "unavailable leader supplies neither labor nor coordination");
      assert.equal(prepare().rawDice, 2);
      for (const key of Object.keys(unavailable)) delete leader[key];
    }
    crew.leaderId = "";
    crew.memberIds = ["one", "two"];
    assert.equal(prepare().rawDice, 2, "missing leader adds no dice");
  }
  {
    const draft = holding([{ resourceId: "wood", name: "Древесина", qty: 10 }]);
    const building = project({ constructionCrewId: "" });
    draft.buildings.list.push(building);
    const before = clone(draft);
    const result = resolveConstructionAttempt({
      holding: draft,
      building,
      crewId: "crew",
      successes: 2,
      period: 1,
      operationId: "unbound",
      dependencies: dependencies()
    });
    assert.equal(result.attempted, false);
    assert.equal(result.code, "crew-binding", "construction must use the crew explicitly assigned to the project");
    assert.deepEqual(draft, before, "an unbound crew must spend neither its attempt nor materials");
  }

  {
    const draft = holding([{ resourceId: "wood", name: "Древесина", qty: 10 }]);
    draft.constructionCrews[0].memberIds = ["foreman"];
    const building = project();
    draft.buildings.list.push(building);
    const before = clone(draft);
    const result = resolveConstructionAttempt({
      holding: draft,
      building,
      crewId: "crew",
      successes: 2,
      period: 1,
      operationId: "short-crew",
      dependencies: dependencies()
    });
    assert.equal(result.attempted, false, "one available worker must not be a valid construction crew");
    assert.equal(result.code, "minimum-crew");
    assert.deepEqual(draft, before, "an undersized crew must spend neither its attempt nor materials");

    draft.constructionCrews[0].memberIds = ["worker"];
    draft.constructionCrews[0].leaderId = "foreman";
    const leaderDoesNotCount = constructionAttemptGate({ holding: draft, crewId: "crew", minimumCrew: 2, period: 1 });
    assert.equal(leaderDoesNotCount.ok, false, "the separate construction leader must not replace a required worker");
    assert.equal(leaderDoesNotCount.count, 1);
    draft.constructionCrews[0].memberIds = ["worker", "worker-2"];
    const completeCrew = constructionAttemptGate({ holding: draft, crewId: "crew", minimumCrew: 2, period: 1 });
    assert.equal(completeCrew.ok, true, "two workers plus a qualified separate leader must be eligible");
    assert.equal(completeCrew.count, 2);

    draft.constructionCrews[0].memberIds = ["worker", "worker-2"];
    draft.constructionCrews[0].leaderId = "";
    const noLeaderBefore = clone(draft);
    const noLeader = resolveConstructionAttempt({
      holding: draft,
      building,
      crewId: "crew",
      successes: 2,
      period: 1,
      operationId: "no-foreman",
      dependencies: dependencies()
    });
    assert.equal(noLeader.attempted, false, "a crew without an assigned foreman must not roll construction");
    assert.equal(noLeader.code, "foreman");
    assert.deepEqual(draft, noLeaderBefore, "missing foreman must spend neither its attempt nor materials");
  }

  {
    const draft = holding([{ resourceId: "wood", name: "Древесина", qty: 10 }]);
    const building = project();
    draft.buildings.list.push(building);
    const before = clone(draft.storage);
    const result = resolveConstructionAttempt({
      holding: draft,
      building,
      crewId: "crew",
      successes: 0,
      period: 1,
      operationId: "zero",
      dependencies: dependencies()
    });
    assert.equal(result.attempted, true);
    assert.equal(result.appliedStages, 0, "zero successes must complete no stages");
    assert.equal(building.buildProgress, 0);
    assert.deepEqual(draft.storage, before, "zero successes must spend no materials");

    const replayBefore = clone(draft);
    const replay = resolveConstructionAttempt({
      holding: draft,
      building,
      crewId: "crew",
      successes: 3,
      period: 1,
      operationId: "zero-replay",
      dependencies: dependencies()
    });
    assert.equal(replay.replay, true, "the same crew cannot build twice in one tenday");
    assert.deepEqual(draft, replayBefore, "a replay must not mutate progress or inventory");
  }

  {
    const draft = holding([{ resourceId: "wood", name: "Древесина", qty: 10 }]);
    const building = project();
    draft.buildings.list.push(building);
    const result = resolveConstructionAttempt({
      holding: draft,
      building,
      crewId: "crew",
      successes: 2,
      period: 1,
      operationId: "partial",
      dependencies: dependencies()
    });
    assert.equal(result.appliedStages, 2);
    assert.equal(building.buildProgress, 2);
    assert.equal(quantity(draft, "wood"), 8, "the first two 7/4 stage shares must cost 1 + 1 whole units");
    assert.deepEqual(result.charged.map((row) => row.qty), [2]);
  }

  {
    const draft = holding([{ resourceId: "wood", name: "Древесина", qty: 1 }]);
    const building = project();
    draft.buildings.list.push(building);
    const result = resolveConstructionAttempt({
      holding: draft,
      building,
      crewId: "crew",
      successes: 2,
      period: 1,
      operationId: "limited",
      dependencies: dependencies()
    });
    assert.equal(result.appliedStages, 1, "inventory must cap accepted successes at payable stages");
    assert.equal(building.buildProgress, 1);
    assert.equal(quantity(draft, "wood"), 0, "an unaffordable next stage must not be partially spent");
    assert.equal(result.missing.length, 1);
  }

  {
    const draft = holding([
      { resourceId: "wood", name: "Древесина", qty: 2, categoryTag: "construction" },
      { resourceId: "stone", name: "Камень", qty: 1, categoryTag: "construction" }
    ]);
    const building = project({
      buildTarget: 2,
      materialCosts: [{ resourceGroup: "construction", name: "Стройматериалы", qty: 3 }]
    });
    draft.buildings.list.push(building);
    const first = resolveConstructionAttempt({
      holding: draft,
      building,
      crewId: "crew",
      successes: 1,
      period: 1,
      operationId: "group-1",
      dependencies: dependencies()
    });
    assert.equal(first.appliedStages, 1);
    assert.deepEqual(first.charged.map((row) => [row.resourceId, row.qty]), [["wood", 1]], "group payment must record concrete resources");
    const second = resolveConstructionAttempt({
      holding: draft,
      building,
      crewId: "crew",
      successes: 1,
      period: 2,
      operationId: "group-2",
      dependencies: dependencies()
    });
    assert.equal(second.completed, true);
    assert.equal(building.constructionStatus, "built");
    assert.equal(quantity(draft, "wood") + quantity(draft, "stone"), 0, "completion must consume the exact total group cost");
    const completedCancellation = planConstructionCancellation({ holding: draft, building, operationId: "cancel-completed" });
    assert.equal(completedCancellation.blocked, true, "a completed building must not enter project cancellation/refund lifecycle");
  }

  {
    const draft = holding([{ resourceId: "wood", name: "Древесина", qty: 10 }]);
    const building = project({ materialCosts: [{ resourceId: "wood", name: "Древесина", qty: 10 }] });
    draft.buildings.list.push(building);
    resolveConstructionAttempt({
      holding: draft,
      building,
      crewId: "crew",
      successes: 2,
      period: 1,
      operationId: "before-cancel",
      dependencies: dependencies()
    });
    assert.equal(quantity(draft, "wood"), 6, "two 10/4 stages must spend 2 + 2 units");
    const plan = planConstructionCancellation({ holding: draft, building, operationId: "cancel" });
    assert.deepEqual(plan.refund.map((row) => row.qty), [3], "cancellation refunds floor(90% of actually spent materials)");
    const wrongProject = project({ id: "wrong-project", buildProgress: building.buildProgress });
    const wrongProjectBefore = clone(draft.storage);
    const wrongProjectResult = applyConstructionCancellation({ holding: draft, building: wrongProject, plan, dependencies: dependencies() });
    assert.equal(wrongProjectResult.stale, true, "a cancellation plan must be bound to its project id");
    assert.deepEqual(draft.storage, wrongProjectBefore, "a cross-project cancellation plan must not refund anything");
    building.lifecycle = "active";
    const staleLifecycle = applyConstructionCancellation({ holding: draft, building, plan, dependencies: dependencies() });
    assert.equal(staleLifecycle.stale, true, "a cancellation plan must reject a project whose lifecycle changed before apply");
    building.lifecycle = "building";
    const applied = applyConstructionCancellation({ holding: draft, building, plan, dependencies: dependencies() });
    assert.equal(applied.ok, true);
    assert.equal(quantity(draft, "wood"), 9);
    const replayBefore = clone(draft.storage);
    const replay = applyConstructionCancellation({ holding: draft, building, plan, dependencies: dependencies() });
    assert.equal(replay.replay, true);
    assert.deepEqual(draft.storage, replayBefore, "cancellation replay must not refund twice");
    const conflictingPlan = { ...plan, operationId: "different-cancel" };
    const conflict = applyConstructionCancellation({ holding: draft, building, plan: conflictingPlan, dependencies: dependencies() });
    assert.equal(conflict.conflict, true, "a different operationId must not masquerade as a cancellation replay");
    assert.deepEqual(draft.storage, replayBefore, "a conflicting cancellation must not refund twice");

    const crewBeforeCancelledAttempt = clone(draft.constructionCrews[0]);
    const cancelledAttempt = resolveConstructionAttempt({
      holding: draft,
      building,
      crewId: "crew",
      successes: 2,
      period: 2,
      operationId: "cancelled-attempt",
      dependencies: dependencies()
    });
    assert.equal(cancelledAttempt.cancelled, true);
    assert.equal(cancelledAttempt.attempted, false);
    assert.deepEqual(draft.constructionCrews[0], crewBeforeCancelledAttempt, "a cancelled project must not consume the crew's tenday attempt");
  }

  {
    const draft = holding([{ resourceId: "wood", name: "Древесина", qty: 10 }]);
    draft.people = { list: [
      { id: "worker", role: "Строитель", workAssignment: "construction:crew", salary: 12 },
      { id: "worker-2", role: "Строитель", workAssignment: "construction:crew", salary: 12 },
      { id: "foreman", role: "Руководитель: Бригада", workAssignment: "construction-leader:crew", salary: 18, attributes: { strength: 3, agility: 3, wits: 4, empathy: 4 }, traitsText: "Лидер" },
      { id: "project-worker", role: "Плотник", workAssignment: "project", salary: 7 }
    ] };
    const building = project({
      assignedWorkerIds: ["project-worker"],
      materialCosts: [{ resourceId: "wood", name: "Древесина", qty: 10 }]
    });
    draft.buildings.list.push(building);
    resolveConstructionAttempt({
      holding: draft,
      building,
      crewId: "crew",
      successes: 2,
      period: 1,
      operationId: "construction-before-removal",
      dependencies: dependencies()
    });
    const crewAttemptBeforeCancel = clone(draft.constructionCrews[0]);
    const cancellationDependencies = dependencies();
    cancellationDependencies.appendStorageLog = (target, entries) => target.storage.log.push(...entries);
    cancellationDependencies.setPersonFree = (target, personId) => {
      const person = target.people.list.find((row) => row.id === personId);
      person.workAssignment = "";
      person.role = "Свободен";
      person.salary = 0;
    };
    const cancelled = applyConstructionProjectCancellation({
      holding: draft,
      buildingId: building.id,
      operationId: "cancel-project-1",
      createdAt: "2026-08-11T10:00:00.000Z",
      dependencies: cancellationDependencies
    });
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.replay, false);
    assert.deepEqual(cancelled.refund.map((row) => row.qty), [3], "workflow must return exactly floor(90% of completed-stage spend)");
    assert.equal(quantity(draft, "wood"), 9, "the staged project refund must be added exactly once");
    assert.equal(draft.buildings.list.some((row) => row.id === building.id), false, "a cancelled construction project must leave the active building list");
    assert.equal(draft.people.list[3].workAssignment, "", "workers assigned to the removed project must be released");
    assert.equal(draft.people.list[3].salary, 0, "released project workers must not retain the old assignment salary");
    assert.deepEqual(draft.constructionCrews[0], crewAttemptBeforeCancel, "cancelling a project must free its binding without resetting the crew's tenday marker or membership");
    assert.equal(draft.log.length, 1);
    assert.equal(draft.log[0].type, "construction-cancellation");
    assert.deepEqual(draft.log[0].payload.refund.map((row) => row.qty), [3], "the immutable operation audit must retain the exact refund");

    const beforeReplay = clone(draft);
    const replay = applyConstructionProjectCancellation({
      holding: draft,
      buildingId: building.id,
      operationId: "cancel-project-1",
      dependencies: cancellationDependencies
    });
    assert.equal(replay.ok, true);
    assert.equal(replay.replay, true, "the operation audit must make a removed-project retry idempotent");
    assert.deepEqual(draft, beforeReplay, "a replay must not restore materials or append history twice");
  }

  {
    const draft = holding([]);
    const building = project({
      buildProgress: 1,
      buildTarget: 3,
      constructionMaterials: {
        version: 1,
        mode: "staged",
        target: 3,
        totalCosts: [{ resourceId: "wood", name: "Древесина", qty: 6 }],
        spent: [{ resourceId: "wood", name: "Древесина", qty: 2 }],
        prepaidRemaining: [],
        cancelled: false,
        cancelOperationId: "",
        refund: []
      }
    });
    draft.buildings.list.push(building);
    const preview = planConstructionCancellation({ holding: draft, building, operationId: "cancel-stale-preview" });
    building.buildProgress = 2;
    building.constructionMaterials.spent[0].qty = 4;
    const stale = applyConstructionProjectCancellation({
      holding: draft,
      buildingId: building.id,
      operationId: "cancel-stale-preview",
      plan: preview,
      dependencies: dependencies()
    });
    assert.equal(stale.stale, true, "the confirmed cancellation must apply the exact Preview instead of silently recomputing a larger refund");
    assert.equal(draft.buildings.list.length, 1, "a stale cancellation Preview must not remove the project");
  }

  {
    const draft = holding([]);
    const building = project({
      buildProgress: 2,
      buildTarget: 3,
      materialsAllocated: true,
      materialCosts: [{ resourceId: "wood", name: "Древесина", qty: 5 }]
    });
    draft.buildings.list.push(building);
    const cancellationDependencies = dependencies();
    cancellationDependencies.appendStorageLog = (target, entries) => target.storage.log.push(...entries);
    const cancelled = applyConstructionProjectCancellation({
      holding: draft,
      buildingId: building.id,
      operationId: "cancel-legacy-prepaid",
      dependencies: cancellationDependencies
    });
    assert.equal(cancelled.ok, true);
    assert.equal(quantity(draft, "wood"), 4, "legacy prepayment must refund 90% of completed stages plus all unspent prepaid stages");
    assert.deepEqual(cancelled.refund.map((row) => row.qty), [4]);
  }

  {
    const draft = holding([{ resourceId: "wood", name: "Древесина", qty: 3 }]);
    const building = project({
      buildProgress: 2,
      constructionMaterials: {
        version: 1,
        mode: "staged",
        target: 4,
        totalCosts: [{ resourceId: "wood", name: "Древесина", qty: 10 }],
        spent: [{ resourceId: "wood", name: "Древесина", qty: 4 }],
        prepaidRemaining: [],
        cancelled: true,
        cancelOperationId: "resume-cancel",
        refund: [{ resourceId: "wood", name: "Древесина", qty: 3 }]
      }
    });
    draft.buildings.list.push(building);
    const cancellationDependencies = dependencies();
    cancellationDependencies.appendStorageLog = (target, entries) => target.storage.log.push(...entries);
    const finalized = applyConstructionProjectCancellation({
      holding: draft,
      buildingId: building.id,
      operationId: "resume-cancel",
      dependencies: cancellationDependencies
    });
    assert.equal(finalized.ok, true);
    assert.equal(finalized.materialReplay, true, "a retry after the material refund must finish lifecycle cleanup without refunding again");
    assert.equal(quantity(draft, "wood"), 3);
    assert.equal(draft.buildings.list.length, 0);
  }

  {
    const draft = holding([]);
    const built = project({ lifecycle: "active", constructionStatus: "built", buildProgress: 4, buildTarget: 4 });
    draft.buildings.list.push(built);
    const blocked = applyConstructionProjectCancellation({
      holding: draft,
      buildingId: built.id,
      operationId: "cancel-built",
      dependencies: dependencies()
    });
    assert.equal(blocked.blocked, true, "built-building deletion must stay separate from refundable construction cancellation");
    assert.equal(draft.buildings.list.length, 1, "a blocked refundable cancellation must not delete a built building");
  }

  {
    const draft = holding([]);
    const building = project({
      buildProgress: 2,
      buildTarget: 3,
      materialsAllocated: true,
      materialCosts: [{ resourceId: "wood", name: "Древесина", qty: 5 }]
    });
    draft.buildings.list.push(building);
    const result = resolveConstructionAttempt({
      holding: draft,
      building,
      crewId: "crew",
      successes: 1,
      period: 1,
      operationId: "legacy-prepaid",
      dependencies: dependencies()
    });
    assert.equal(result.completed, true, "a legacy fully paid project must complete without a future material charge");
    assert.deepEqual(result.charged, []);
    assert.equal(building.constructionMaterials.prepaidRemaining.length, 0);
    assert.equal(building.constructionMaterials.spent[0].qty, 5);
  }

  {
    const parts = [1, 2].map((stage) => constructionStageCosts([
      { resourceId: "wood", name: "Древесина", qty: 2.2 }
    ], 2, stage)[0].qty);
    assert.deepEqual(parts, [1, 2], "fractional legacy costs must become exact whole stage shares whose remainder is carried into the last stage");
  }

  {
    const draft = holding([]);
    draft.constructionCrews[0].memberIds = ["worker", "foreman"];
    draft.buildings.list = [project({ id: "first", materialCosts: [] }), project({ id: "second", materialCosts: [] })];
    const report = { construction: { attempts: 0, completed: 0, lines: [] }, ledger: [] };
    const result = runConstruction({
      holding: draft,
      qd: 40,
      report,
      dependencies: {
        safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
        buildingOperationalState,
        advanceBuildingProject,
        constructionCrew: (_holding, id) => ({ id, count: 2, dice: 2, name: "Бригада" }),
        constructionAttemptGate,
        constructionPeriodForHolding,
        resolveConstructionAttempt,
        rollDice: () => [6, 6],
        planStorageCosts: paymentPlan,
        payStorageCosts: paymentApply,
        appendLedger: (target, row) => target.ledger.push(row)
      }
    });
    assert.equal(result.attempts, 1, "one crew must make at most one construction roll per tenday");
    assert.equal(draft.buildings.list[0].buildProgress, 2);
    assert.equal(draft.buildings.list[1].buildProgress, 0);
  }

  {
    const sourceHolding = holding([{ resourceId: "wood", name: "Древесина", qty: 10 }]);
    sourceHolding.id = "holding";
    sourceHolding.visibility = "public";
    sourceHolding.gm.playersCanEditBuildings = true;
    sourceHolding.gm.playersCanUseStorage = false;
    sourceHolding.special = { list: [] };
    sourceHolding.buildings.list = [project({ templateId: "template" })];
    const current = {
      meta: { revision: 1 },
      catalog: { buildings: [{ id: "template", requirements: {} }] },
      holdings: [sourceHolding]
    };
    const proposed = clone(current);
    const proposedHolding = proposed.holdings[0];
    const authorityDependencies = dependencies();
    authorityDependencies.appendStorageLog = (draft, entries) => draft.storage.log.push(...entries);
    const applied = resolveConstructionAttempt({
      holding: proposedHolding,
      building: proposedHolding.buildings.list[0],
      crewId: "crew",
      successes: 1,
      period: 1,
      operationId: "construction-player-1",
      dependencies: authorityDependencies
    });
    assert.equal(applied.appliedStages, 1);
    const patch = buildPlayerPatch(current, proposed);
    assert.equal(patch.action, "construction", "an atomic building plus storage spend must use the authority construction action");
    const validation = validatePlayerPatch(current, patch, "player");
    assert.equal(validation.ok, false, "generic player patches must never carry a paid construction result computed by the client");

    const forged = clone(proposed);
    forged.holdings[0].storage.resources[0].qty = 11;
    const forgedPatch = buildPlayerPatch(current, forged);
    assert.equal(forgedPatch.action, "construction");
    assert.equal(validatePlayerPatch(current, forgedPatch, "player").ok, false, "construction authority must reject inventory creation");

    const excessive = clone(proposed);
    excessive.holdings[0].buildings.list[0].buildProgress = 4;
    excessive.holdings[0].buildings.list[0].lifecycle = "active";
    excessive.holdings[0].buildings.list[0].constructionStatus = "built";
    const excessivePatch = buildPlayerPatch(current, excessive);
    assert.equal(validatePlayerPatch(current, excessivePatch, "player").ok, false, "one cheap material decrement must not buy several expensive stages");

    const disguisedPatch = { ...patch, action: "buildings" };
    assert.equal(validatePlayerPatch(current, disguisedPatch, "player").ok, false, "a client must not bypass construction semantics by relabeling the patch action");

    const playerCancellation = clone(current);
    playerCancellation.holdings[0].buildings.list = [];
    const cancellationPatch = buildPlayerPatch(current, playerCancellation);
    const cancellationValidation = validatePlayerPatch(current, cancellationPatch, "player");
    assert.equal(cancellationValidation.ok, false, "player building permissions must not authorize refundable project cancellation");
    assert.match(cancellationValidation.error, /Изменения|не имеет|запрещено/);

    const builtCurrent = clone(current);
    Object.assign(builtCurrent.holdings[0].buildings.list[0], {
      lifecycle: "active",
      constructionStatus: "built",
      status: "Построено",
      buildProgress: 4,
      buildTarget: 4
    });
    const builtDeleted = clone(builtCurrent);
    builtDeleted.holdings[0].buildings.list = [];
    const builtDeleteValidation = validatePlayerPatch(builtCurrent, buildPlayerPatch(builtCurrent, builtDeleted), "player");
    assert.equal(builtDeleteValidation.ok, false, "generic player patches must not delete even completed building rows");
  }

  {
    const sourceHolding = holding([{ resourceId: "wood", name: "Древесина", qty: 10 }]);
    sourceHolding.id = "holding-zero";
    sourceHolding.visibility = "public";
    sourceHolding.gm.playersCanEditBuildings = true;
    const building = project({ templateId: "template" });
    advanceBuildingProject(building, 0);
    building.constructionMaterials = {
      version: 1,
      mode: "staged",
      target: 4,
      totalCosts: [{ resourceId: "wood", resourceGroup: "", name: "Древесина", qty: 7 }],
      spent: [],
      prepaidRemaining: [],
      cancelled: false,
      cancelOperationId: "",
      refund: []
    };
    sourceHolding.buildings.list = [building];
    const current = { meta: { revision: 1 }, catalog: { buildings: [{ id: "template", requirements: {} }] }, holdings: [sourceHolding] };
    const proposed = clone(current);
    const result = resolveConstructionAttempt({
      holding: proposed.holdings[0],
      building: proposed.holdings[0].buildings.list[0],
      crewId: "crew",
      successes: 0,
      period: 1,
      operationId: "construction-zero-player",
      dependencies: dependencies()
    });
    assert.equal(result.appliedStages, 0);
    const patch = buildPlayerPatch(current, proposed);
    assert.equal(patch.action, "construction", "a zero-success attempt marker must not fall through to generic building edits");
    assert.equal(patch.changes.some((change) => change.path.includes("buildings.list")), false, "an already initialized zero-success project may change only its crew marker");
    const validation = validatePlayerPatch(current, patch, "player");
    assert.equal(validation.ok, false, "even a zero-success attempt marker must use the dedicated authority-GM command");
  }

  {
    const sourceHolding = holding([]);
    sourceHolding.id = "holding-free-stage";
    sourceHolding.visibility = "public";
    sourceHolding.gm.playersCanEditBuildings = true;
    sourceHolding.buildings.list = [project({ templateId: "template", materialCosts: [{ resourceId: "wood", name: "Древесина", qty: 1 }] })];
    const current = { meta: { revision: 1 }, catalog: { buildings: [{ id: "template", requirements: {} }] }, holdings: [sourceHolding] };
    const proposed = clone(current);
    const result = resolveConstructionAttempt({
      holding: proposed.holdings[0],
      building: proposed.holdings[0].buildings.list[0],
      crewId: "crew",
      successes: 1,
      period: 1,
      operationId: "construction-free-stage",
      dependencies: dependencies()
    });
    assert.equal(result.appliedStages, 1);
    assert.deepEqual(result.charged, []);
    const patch = buildPlayerPatch(current, proposed);
    assert.equal(patch.action, "construction", "a zero-cost completed stage must retain the construction authority action");
    const validation = validatePlayerPatch(current, patch, "player");
    assert.equal(validation.ok, false, "zero-cost construction stages must still be rolled by the authority GM");
  }

  {
    const sourceHolding = holding([{ resourceId: "wood", name: "Древесина", qty: 10 }]);
    sourceHolding.id = "holding-capped-log";
    sourceHolding.visibility = "public";
    sourceHolding.gm.playersCanEditBuildings = true;
    sourceHolding.buildings.list = [project({ templateId: "template" })];
    sourceHolding.storage.log = Array.from({ length: 250 }, (_, index) => ({
      id: `old-${index}`,
      kind: "manual",
      resourceId: "wood",
      name: "Древесина",
      qty: 1
    }));
    const current = { meta: { revision: 1 }, catalog: { buildings: [{ id: "template", requirements: {} }] }, holdings: [sourceHolding] };
    const proposed = clone(current);
    const authorityDependencies = dependencies();
    authorityDependencies.appendStorageLog = (draft, entries) => {
      draft.storage.log.push(...entries);
      draft.storage.log = draft.storage.log.slice(-250);
    };
    resolveConstructionAttempt({
      holding: proposed.holdings[0],
      building: proposed.holdings[0].buildings.list[0],
      crewId: "crew",
      successes: 1,
      period: 1,
      operationId: "construction-capped-log",
      dependencies: authorityDependencies
    });
    const patch = buildPlayerPatch(current, proposed);
    const validation = validatePlayerPatch(current, patch, "player");
    assert.equal(validation.ok, false, "a capped append-only log does not make a client-computed construction patch trustworthy");
  }

  {
    const sourceHolding = holding([{ resourceId: "wood", name: "Древесина", qty: 10 }]);
    sourceHolding.id = "authority-holding";
    sourceHolding.name = "Authority Holding";
    sourceHolding.visibility = "public";
    sourceHolding.gm.playersCanEditBuildings = true;
    sourceHolding.buildings.list = [project({ id: "authority-project" })];
    const data = { meta: { revision: 1 }, holdings: [sourceHolding] };
    let writes = 0;
    let rolls = 0;
    const skipTransaction = (value) => ({ __skip: true, value });
    const logic = {
      _safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
      _constructionCrew: (_holding, crewId) => ({
        id: crewId,
        name: "Бригада",
        names: "Работник, Бригадир",
        count: 2,
        dice: 4,
        rawDice: 4,
        moraleMod: 0,
        moraleReason: "Довольство: 0",
        members: []
      }),
      _traitBadges: () => [],
      _storageCanPay: paymentPlan,
      _storagePay: (draft, costs) => {
        const plan = paymentPlan(draft, costs);
        if (plan.ok) paymentApply(draft, plan.costs);
        return plan;
      },
      _appendStorageLog: (draft, entries) => {
        draft.storage.log.push(...entries.map((entry, index) => ({ id: `authority-log-${index}`, ...entry })));
      }
    };
    const getUser = (userId) => ({ id: userId, isGM: userId === "gm" });
    const updateHolding = async (holdingId, updater, options) => {
        assert.equal(options.fallback, false, "construction authority must never fall back to another holding");
        const target = data.holdings.find((row) => row.id === holdingId);
        if (!target) return null;
        const result = await updater(target, data);
        if (result?.__skip) return result.value;
        data.meta.revision += 1;
        writes += 1;
        return result;
      };
    const rollDice = (pool) => {
        rolls += 1;
        return Array.from({ length: pool }, () => 6);
      };
    const execute = createConstructionOperationExecutor({
      logic,
      getUser,
      skipTransaction,
      updateHolding,
      rollDice,
      now: () => new Date("2026-08-13T12:00:00.000Z")
    });
    const operation = {
      type: "rollConstruction",
      operationId: "authority-construction-1",
      expectedRevision: 1,
      holdingId: sourceHolding.id,
      buildingId: "authority-project",
      crewId: "crew",
      successes: 999,
      progress: 999
    };
    const result = await execute(operation, { userId: "player", remote: true });
    assert.equal(result.successes, 4, "the authority GM must derive successes only from its own dice");
    assert.equal(result.nextProgress, 4, "a legitimate authority roll may complete all rolled stages");
    assert.equal(data.holdings[0].storage.resources[0].qty, 3, "authority construction must charge every completed stage");
    assert.equal(data.holdings[0].log.at(-1)?.type, "construction-attempt", "construction replay data must be persisted in the holding operation log");
    assert.equal(writes, 1);
    assert.equal(rolls, 1);

    const replay = await execute(operation, { userId: "player", remote: true });
    assert.equal(replay.duplicate, true, "an in-memory replay must be reported consistently as a duplicate");
    assert.equal(writes, 1, "a replay must not persist twice");
    assert.equal(rolls, 1, "a replay must not roll twice");

    const executeAfterRestart = createConstructionOperationExecutor({
      logic,
      getUser,
      skipTransaction,
      updateHolding,
      rollDice,
      now: () => new Date("2026-08-13T12:01:00.000Z")
    });
    const persistedReplay = await executeAfterRestart(operation, { userId: "player", remote: true });
    assert.equal(persistedReplay.duplicate, true, "a persisted operation marker must survive an executor restart");
    assert.equal(writes, 1, "a persisted replay must not write twice");
    assert.equal(rolls, 1, "a persisted replay must not roll dice twice");

    for (const executor of [execute, executeAfterRestart]) {
      await assert.rejects(executor({ ...operation, expectedRevision: 99 }, { userId: "player", remote: true }),
        { code: "conflict" }, "replay must match the original revision");
      await assert.rejects(executor(operation, { userId: "gm", remote: false }),
        { code: "conflict" }, "replay must match the original requester");
    }
    assert.equal(writes, 1, "mismatched replay must not write");
    assert.equal(rolls, 1, "mismatched replay must not roll");

    await assert.rejects(
      executeAfterRestart({ ...operation, operationId: "authority-construction-stale", expectedRevision: 1 }, { userId: "player", remote: true }),
      (error) => error?.code === "conflict" && error?.retryable === true && error?.revision === data.meta.revision,
      "an authority construction command must reject a stale expected revision before rolling"
    );
    assert.equal(writes, 1, "a stale construction command must not write");
    assert.equal(rolls, 1, "a stale construction command must not roll");

    sourceHolding.gm.playersCanEditBuildings = false;
    await assert.rejects(
      executeAfterRestart({ ...operation, operationId: "authority-construction-forbidden", expectedRevision: data.meta.revision }, { userId: "player", remote: true }),
      (error) => error?.code === "forbidden",
      "the authority GM must enforce the holding building permission for a remote player"
    );
    sourceHolding.gm.playersCanEditBuildings = true;
    assert.equal(writes, 1, "a forbidden construction command must not write");
    assert.equal(rolls, 1, "a forbidden construction command must not roll");

    await assert.rejects(
      executeAfterRestart({ ...operation, operationId: "authority-construction-gm-spoof", expectedRevision: data.meta.revision }, { userId: "gm", remote: true }),
      (error) => error?.code === "forbidden",
      "a remote socket request must not claim a GM user identity"
    );
    assert.equal(writes, 1, "a remote GM spoof must not write");
    assert.equal(rolls, 1, "a remote GM spoof must not roll");

    await assert.rejects(
      execute({ ...operation, crewId: "forged-crew" }, { userId: "player", remote: true }),
      (error) => error?.code === "conflict",
      "reusing an operation id with a different target must be rejected"
    );
  }

  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkConstructionStageCharacterization();
  console.log("FBL Skyhold construction stage characterization checks passed.");
}
