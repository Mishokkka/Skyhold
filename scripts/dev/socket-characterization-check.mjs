import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createSkyholdSocketApi } from "../data/socket.js";
import { createStorageOperationExecutor } from "../apps/storage-operation-executor.js";
import { DEFAULT_SKYHOLD_DATA } from "../data/defaults/default-skyhold-data.js";
import { migrateData } from "../data/normalizers.js";
import { buildPlayerPatch, validatePlayerPatch } from "../data/player-write-guard.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}


/** Checks authenticated GM/player commands, replay, pending-ID conflicts and transport failure cleanup using a fake socket. */
export async function checkSocketCharacterization() {
  const previousGame = globalThis.game;
  const previousUi = globalThis.ui;

  try {
    let current = migrateData(clone(DEFAULT_SKYHOLD_DATA));
    current.holdings[0].visibility = "public";
    current.holdings[0].gm.playersCanEditOverview = true;
    current.holdings[0].gm.playersCanEditBuildings = true;
    current.holdings[0].buildings.list = [{
      id: "socket-project",
      name: "Socket Project",
      lifecycle: "building",
      constructionStatus: "building",
      buildProgress: 1,
      buildTarget: 4,
      constructionCrewId: "crew",
      materialCosts: []
    }];

    const guardCurrent = clone(current);
    const guardHolding = guardCurrent.holdings[0];
    guardHolding.gm.playersCanUseStorage = true;
    guardHolding.gm.playersCanEditResidents = true;
    Object.assign(guardHolding.buildings.list[0], {
      effect: "",
      notes: "",
      workersMax: 1,
      assignedWorkerIds: [""],
      constructionCrewId: "",
      baseUpkeepMonthlyCopper: 3,
      operatingUpkeepMonthlyCopper: 3,
      bonuses: { food: 0, technology: 0, culture: 0, war: 0 },
      storage: { capacity: 1 },
      income: { base: 0 },
      productionLines: [{ id: "line", active: true, source: "workers", resourceId: "wood", outputQty: 1, workQd: 1 }]
    });
    guardHolding.people.list = [{
      id: "resident",
      name: "Resident",
      dead: false,
      injuredDays: 0,
      salary: 0,
      wageDailyOverrideCopper: null,
      volunteerLabor: false,
      volunteerReason: "",
      maintenancePointsPerTenday: 0
    }];
    guardHolding.constructionCrews = [
      { id: "crew-a", name: "Crew A", memberIds: [], leaderId: "" },
      { id: "crew-b", name: "Crew B", memberIds: [], leaderId: "" }
    ];
    guardHolding.storage.moneyCopper = 10;
    guardHolding.storage.resources = [{ id: "wood", resourceId: "wood", name: "Wood", qty: 2 }];
    guardHolding.storage.items = [{ id: "sword", name: "Sword", qty: 1 }];
    const forbiddenGenericMutations = [
      ["treasury money", (draft) => { draft.holdings[0].storage.moneyCopper = 999; }],
      ["stored resources", (draft) => { draft.holdings[0].storage.resources[0].qty = 999; }],
      ["stored items", (draft) => { draft.holdings[0].storage.items[0].qty = 999; }],
      ["building effects", (draft) => { draft.holdings[0].buildings.list[0].effect = "+999"; }],
      ["building notes used by legacy heuristics", (draft) => { draft.holdings[0].buildings.list[0].notes = "salary 0"; }],
      ["building income", (draft) => { draft.holdings[0].buildings.list[0].income.base = 999; }],
      ["building output", (draft) => { draft.holdings[0].buildings.list[0].productionLines[0].outputQty = 999; }],
      ["building costs", (draft) => { draft.holdings[0].buildings.list[0].materialCosts = [{ resourceId: "wood", qty: 0 }]; }],
      ["building bonuses", (draft) => { draft.holdings[0].buildings.list[0].bonuses.food = 999; }],
      ["building base upkeep", (draft) => { draft.holdings[0].buildings.list[0].baseUpkeepMonthlyCopper = 0; }],
      ["building operating upkeep", (draft) => { draft.holdings[0].buildings.list[0].operatingUpkeepMonthlyCopper = 0; }],
      ["building capacity", (draft) => { draft.holdings[0].buildings.list[0].storage.capacity = 999; }],
      ["resident death", (draft) => { draft.holdings[0].people.list[0].dead = true; }],
      ["resident injury", (draft) => { draft.holdings[0].people.list[0].injuredDays = 5; }],
      ["resident legacy work assignment", (draft) => { draft.holdings[0].people.list[0].workAssignment = "socket-project"; }],
      ["resident generated salary", (draft) => { draft.holdings[0].people.list[0].salary = 999; }],
      ["resident wage override", (draft) => { draft.holdings[0].people.list[0].wageDailyOverrideCopper = 0; }],
      ["resident volunteer flag", (draft) => { draft.holdings[0].people.list[0].volunteerLabor = true; }],
      ["resident volunteer reason", (draft) => { draft.holdings[0].people.list[0].volunteerReason = "free"; }],
      ["resident maintenance calibration", (draft) => { draft.holdings[0].people.list[0].maintenancePointsPerTenday = 999; }],
      ["construction crew membership", (draft) => { draft.holdings[0].constructionCrews[0].memberIds = ["resident"]; }],
      ["construction crew leadership", (draft) => {
        draft.holdings[0].constructionCrews[0].memberIds = ["resident"];
        draft.holdings[0].constructionCrews[0].leaderId = "resident";
      }]
    ];
    for (const [label, mutate] of forbiddenGenericMutations) {
      const forged = clone(guardCurrent);
      mutate(forged);
      assert.equal(validatePlayerPatch(guardCurrent, buildPlayerPatch(guardCurrent, forged), "player-1").ok, false, `generic player patches must reject ${label}`);
    }
    const duplicatedCrewMember = clone(guardCurrent);
    duplicatedCrewMember.holdings[0].people.list[0].workAssignment = "construction:crew-a";
    duplicatedCrewMember.holdings[0].people.list[0].role = "Crew A";
    duplicatedCrewMember.holdings[0].constructionCrews[0].memberIds = ["resident"];
    duplicatedCrewMember.holdings[0].constructionCrews[1].memberIds = ["resident"];
    assert.equal(
      validatePlayerPatch(guardCurrent, buildPlayerPatch(guardCurrent, duplicatedCrewMember), "player-1").ok,
      false,
      "one resident must not occupy two construction crews through a bidirectionally forged generic patch"
    );

    const assignmentWithoutSlot = clone(guardCurrent);
    assignmentWithoutSlot.holdings[0].people.list[0].workAssignment = "socket-project";
    assignmentWithoutSlot.holdings[0].people.list[0].role = "Socket Project";
    assert.equal(
      validatePlayerPatch(guardCurrent, buildPlayerPatch(guardCurrent, assignmentWithoutSlot), "player-1").ok,
      false,
      "a legacy resident assignment without the exact building slot must not bypass workersMax"
    );

    const exactWorkerAssignment = clone(guardCurrent);
    exactWorkerAssignment.holdings[0].people.list[0].workAssignment = "socket-project";
    exactWorkerAssignment.holdings[0].people.list[0].role = "Socket Project";
    exactWorkerAssignment.holdings[0].buildings.list[0].assignedWorkerIds = ["resident"];
    const exactWorkerValidation = validatePlayerPatch(guardCurrent, buildPlayerPatch(guardCurrent, exactWorkerAssignment), "player-1");
    assert.equal(
      exactWorkerValidation.ok,
      true,
      `an exact bidirectional worker assignment within workersMax must preserve the player planner workflow: ${exactWorkerValidation.error ?? "unknown"}`
    );

    const hardAdmissionCurrent = clone(guardCurrent);
    hardAdmissionCurrent.holdings[0].people.list[0].attributes = { strength: 2, agility: 3, wits: 3, empathy: 3 };
    hardAdmissionCurrent.holdings[0].buildings.list[0].workerProfile = {
      version: 1,
      templateId: "",
      admission: {
        text: "СИЛ≥4",
        hard: true,
        clauses: [[{ attribute: "strength", minimum: 4 }]]
      }
    };
    const forgedHardAssignment = clone(hardAdmissionCurrent);
    forgedHardAssignment.holdings[0].people.list[0].workAssignment = "socket-project";
    forgedHardAssignment.holdings[0].people.list[0].role = "Socket Project";
    forgedHardAssignment.holdings[0].buildings.list[0].assignedWorkerIds = ["resident"];
    assert.equal(
      validatePlayerPatch(hardAdmissionCurrent, buildPlayerPatch(hardAdmissionCurrent, forgedHardAssignment), "player-1").ok,
      false,
      "the authority guard must reject a player-forged hard-admission assignment even when the bidirectional slots match"
    );
    hardAdmissionCurrent.holdings[0].buildings.list[0].workerAdmissionOverrideIds = ["resident"];
    const grandfatheredHardAssignment = clone(hardAdmissionCurrent);
    grandfatheredHardAssignment.holdings[0].people.list[0].workAssignment = "socket-project";
    grandfatheredHardAssignment.holdings[0].people.list[0].role = "Socket Project";
    grandfatheredHardAssignment.holdings[0].buildings.list[0].assignedWorkerIds = ["resident"];
    assert.equal(
      validatePlayerPatch(hardAdmissionCurrent, buildPlayerPatch(hardAdmissionCurrent, grandfatheredHardAssignment), "player-1").ok,
      true,
      "an unchanged GM-created admission override must keep a legacy assignment usable through the player planner"
    );

    const explicitHardCurrent = clone(hardAdmissionCurrent);
    explicitHardCurrent.holdings[0].buildings.list[0].workerAdmissionOverrideIds = [];
    Object.assign(explicitHardCurrent.holdings[0].buildings.list[0], {
      lifecycle: "active",
      constructionStatus: "built",
      status: "Построено",
      functions: { production: true }
    });
    const forgedExplicitAdmission = clone(explicitHardCurrent);
    forgedExplicitAdmission.holdings[0].people.list[0].workAllocationMode = "explicit";
    forgedExplicitAdmission.holdings[0].people.list[0].workAssignment = "";
    forgedExplicitAdmission.holdings[0].people.list[0].workAllocations = [{
      schemaVersion: 1,
      id: "hard-plan",
      sourceId: "socket-project",
      functionId: "production:line",
      normalQd: 1,
      overtimeQd: 0
    }];
    assert.equal(
      validatePlayerPatch(explicitHardCurrent, buildPlayerPatch(explicitHardCurrent, forgedExplicitAdmission), "player-1").ok,
      false,
      "an explicit-QD plan must not let a player bypass a hard building admission rule"
    );
    const explicitOverrideCurrent = clone(explicitHardCurrent);
    explicitOverrideCurrent.holdings[0].buildings.list[0].workerAdmissionOverrideIds = ["resident"];
    const grandfatheredExplicitAdmission = clone(forgedExplicitAdmission);
    grandfatheredExplicitAdmission.holdings[0].buildings.list[0].workerAdmissionOverrideIds = ["resident"];
    assert.equal(
      validatePlayerPatch(explicitOverrideCurrent, buildPlayerPatch(explicitOverrideCurrent, grandfatheredExplicitAdmission), "player-1").ok,
      true,
      "an existing GM admission override must keep an explicit-QD plan usable without granting the player override rights"
    );

    const exactCrewAssignment = clone(guardCurrent);
    exactCrewAssignment.holdings[0].people.list[0].workAssignment = "construction:crew-a";
    exactCrewAssignment.holdings[0].people.list[0].role = "Crew A";
    exactCrewAssignment.holdings[0].constructionCrews[0].memberIds = ["resident"];
    const exactCrewValidation = validatePlayerPatch(guardCurrent, buildPlayerPatch(guardCurrent, exactCrewAssignment), "player-1");
    assert.equal(
      exactCrewValidation.ok,
      true,
      `an exact bidirectional, exclusive crew assignment must preserve the player crew editor workflow: ${exactCrewValidation.error ?? "unknown"}`
    );

    const explicitInLegacySlot = clone(guardCurrent);
    explicitInLegacySlot.holdings[0].people.list[0].workAllocationMode = "explicit";
    explicitInLegacySlot.holdings[0].people.list[0].workAllocations = [];
    explicitInLegacySlot.holdings[0].buildings.list[0].assignedWorkerIds = ["resident"];
    assert.equal(
      validatePlayerPatch(guardCurrent, buildPlayerPatch(guardCurrent, explicitInLegacySlot), "player-1").ok,
      false,
      "an explicit-QD resident must not also occupy a legacy building slot"
    );

    const emitted = [];
    let persisted = null;
    let notifications = 0;
    let storageOperations = 0;
    let constructionOperations = 0;
    const constructionContexts = [];
    globalThis.ui = { notifications: { warn() {} } };
    globalThis.game = {
      user: { id: "player-1", isGM: false },
      users: { contents: [{ id: "gm-1", active: true, isGM: true }, { id: "player-1", active: true, isGM: false }, { id: "attacker", active: true, isGM: false }] },
      socket: {
        emit(_channel, payload) {
          emitted.push(payload);
        }
      }
    };

    const api = createSkyholdSocketApi({
      getData: () => current,
      enqueueWrite: async (operation) => operation(),
      persistData: async (data) => {
        persisted = clone(data);
        current = clone(data);
      },
      notifyChanged: () => {
        notifications += 1;
      },
      executeStorageOperation: async (operation, context) => {
        storageOperations += 1;
        return {
          ok: true,
          operationId: operation.operationId,
          message: `handled for ${context.userId}`
        };
      },
      executeConstructionOperation: async (operation, context) => {
        constructionOperations += 1;
        constructionContexts.push({ ...context });
        return {
          ok: true,
          operationId: operation.operationId,
          buildingId: operation.buildingId,
          rolls: [6],
          successes: 1
        };
      }
    });

    const proposed = clone(current);
    proposed.holdings[0].overview.description = "Игрок обновил описание";
    const pending = api.requestGmDataPatch(proposed);
    const request = emitted.at(-1);

    assert.equal(request.type, "playerDataPatchRequest", "player writes must use the patch socket protocol");
    assert.ok(request.patch?.changes?.length, "player patch request must contain changed paths");
    assert.equal("data" in request, false, "player patch request must not send a full world snapshot");
    assert.equal(request.targetGmId, "gm-1", "player writes must target one active GM");
    assert.equal(request.operationId, request.requestId, "player patch requests must use one stable operation id across transport layers");
    assert.equal(request.expectedRevision, request.patch.baseRevision, "player patch requests must declare their expected base revision");

    await api.handleSkyholdSocketPayload({
      type: "playerDataPatchResponse",
      requestId: request.requestId,
      operationId: request.operationId,
      gmId: "gm-1",
      userId: "player-1",
      ok: true,
      revision: proposed.meta.revision + 1
    }, "gm-1");
    assert.equal((await pending).holdings[0].overview.description, proposed.holdings[0].overview.description, "the player request must resolve from the matching GM response");

    emitted.length = 0;
    const storagePending = api.requestStorageOperation({
      type: "withdrawResource",
      operationId: "storage-operation-1",
      holdingId: current.holdings[0].id,
      actorId: "actor-1",
      resourceId: "wood",
      qty: 1
    });
    const storageRequest = emitted.at(-1);
    assert.equal(storageRequest.type, "playerStorageOperationRequest", "Actor/storage transfers must use the dedicated operation protocol");
    assert.equal(storageRequest.targetGmId, "gm-1", "storage operations must target one active GM");

    globalThis.game.user = { id: "gm-2", isGM: true };
    await api.handleSkyholdSocketPayload(storageRequest, storageRequest.type.endsWith("Response") ? storageRequest.gmId : storageRequest.userId);
    assert.equal(storageOperations, 0, "a non-target GM must ignore a storage operation request");

    globalThis.game.user = { id: "gm-1", isGM: true };
    await api.handleSkyholdSocketPayload(storageRequest, storageRequest.type.endsWith("Response") ? storageRequest.gmId : storageRequest.userId);
    const storageResponse = emitted.at(-1);
    assert.equal(storageResponse.type, "playerStorageOperationResponse", "the GM must acknowledge a storage operation");
    assert.equal("data" in storageResponse, false, "storage operation responses must not broadcast a full Skyhold snapshot");

    globalThis.game.user = { id: "player-1", isGM: false };
    await api.handleSkyholdSocketPayload(storageResponse, storageResponse.type.endsWith("Response") ? storageResponse.gmId : storageResponse.userId);
    assert.equal((await storagePending).operationId, "storage-operation-1", "the player request must resolve from the matching operation acknowledgement");
    assert.equal(storageOperations, 1, "one storage request must execute once on its target GM");

    globalThis.game.user = { id: "gm-1", isGM: true };
    const emittedBeforeDirectStorage = emitted.length;
    const directStorage = await api.requestStorageOperation({
      type: "withdrawResource",
      operationId: "storage-operation-direct-gm",
      holdingId: current.holdings[0].id,
      actorId: "actor-1",
      resourceId: "wood",
      qty: 1
    });
    assert.equal(directStorage.ok, true, "a GM storage operation must use the same configured executor");
    assert.equal(storageOperations, 2, "the direct GM path must execute exactly once");
    assert.equal(emitted.length, emittedBeforeDirectStorage, "the direct GM path must not round-trip through the socket");

    let forgedVictimWrites = 0;
    let forgedVictimActorMutations = 0;
    const victimUser = { id: "victim-player", isGM: false };
    const secureStorageExecutor = createStorageOperationExecutor({
      logic: {
        async _storageReceiveFoundryItem() {
          forgedVictimActorMutations += 1;
          return { ok: true };
        }
      },
      getUser: (userId) => userId === victimUser.id ? victimUser : null,
      updateHolding: async () => {
        forgedVictimWrites += 1;
        throw new Error("forged remote Actor operation reached holding persistence");
      }
    });
    const attackerSocketApi = createSkyholdSocketApi({
      getData: () => current,
      enqueueWrite: async (operation) => operation(),
      persistData: async () => {},
      notifyChanged: () => {},
      executeStorageOperation: secureStorageExecutor
    });
    globalThis.game.user = { id: "gm-1", isGM: true };
    emitted.length = 0;
    const previousConsoleErrorForVictimSpoof = console.error;
    try {
      console.error = () => {};
      await attackerSocketApi.handleSkyholdSocketPayload({
        type: "playerStorageOperationRequest",
        requestId: "attacker-victim-spoof",
        userId: victimUser.id,
        targetGmId: "gm-1",
        operation: {
          type: "depositItem",
          operationId: "attacker-victim-spoof",
          holdingId: current.holdings[0].id,
          actorId: "victim-actor",
          itemId: "victim-item"
        }
      }, "attacker");
    } finally {
      console.error = previousConsoleErrorForVictimSpoof;
    }
    assert.equal(emitted.length, 0, "a forged sender must be ignored before executor access or acknowledgement");
    assert.equal(forgedVictimWrites, 0, "a forged remote Actor operation must be rejected before any holding write");
    assert.equal(forgedVictimActorMutations, 0, "a forged remote Actor operation must be rejected before touching the victim Item");

    globalThis.game.user = { id: "player-1", isGM: false };
    emitted.length = 0;
    const constructionOperation = {
      type: "rollConstruction",
      operationId: "construction-operation-1",
      expectedRevision: current.meta.revision,
      holdingId: current.holdings[0].id,
      buildingId: "socket-project",
      crewId: "crew"
    };
    const constructionPending = api.requestConstructionOperation(constructionOperation);
    const constructionRequest = emitted.at(-1);
    assert.equal(constructionRequest.type, "playerConstructionOperationRequest", "player construction rolls must use the dedicated authority-GM protocol");
    assert.equal(constructionRequest.requestId, constructionOperation.operationId, "construction transport must retain the operation id");
    assert.equal(constructionRequest.expectedRevision, constructionOperation.expectedRevision, "construction transport must retain the expected revision");
    assert.equal(constructionRequest.targetGmId, "gm-1", "construction rolls must target one active authority GM");
    assert.equal("patch" in constructionRequest, false, "construction commands must not tunnel a client-computed patch");

    globalThis.game.user = { id: "player-2", isGM: false };
    await api.handleSkyholdSocketPayload(constructionRequest, constructionRequest.type.endsWith("Response") ? constructionRequest.gmId : constructionRequest.userId);
    assert.equal(constructionOperations, 0, "a non-GM client must never execute a remote construction request");

    globalThis.game.user = { id: "gm-2", isGM: true };
    await api.handleSkyholdSocketPayload(constructionRequest, constructionRequest.type.endsWith("Response") ? constructionRequest.gmId : constructionRequest.userId);
    assert.equal(constructionOperations, 0, "a non-target GM must ignore a construction request");

    globalThis.game.user = { id: "gm-1", isGM: true };
    await api.handleSkyholdSocketPayload(constructionRequest, constructionRequest.type.endsWith("Response") ? constructionRequest.gmId : constructionRequest.userId);
    const constructionResponse = emitted.at(-1);
    assert.equal(constructionResponse.type, "playerConstructionOperationResponse", "the authority GM must acknowledge a construction operation");
    assert.equal(constructionResponse.ok, true);
    assert.equal(constructionOperations, 1, "the target authority GM must execute the construction command exactly once");
    assert.deepEqual(constructionContexts[0], { userId: "player-1", remote: true }, "the executor must receive the remote player identity and remote marker");

    globalThis.game.user = { id: "player-1", isGM: false };
    await api.handleSkyholdSocketPayload(constructionResponse, constructionResponse.type.endsWith("Response") ? constructionResponse.gmId : constructionResponse.userId);
    assert.equal((await constructionPending).operationId, constructionOperation.operationId, "the requesting player must resolve from the matching construction acknowledgement");

    globalThis.game.user = { id: "gm-1", isGM: true };
    const emittedBeforeDirectConstruction = emitted.length;
    await api.requestConstructionOperation({ ...constructionOperation, operationId: "construction-operation-direct-gm" });
    assert.equal(constructionOperations, 2, "a direct GM construction command must use the same executor exactly once");
    assert.deepEqual(constructionContexts[1], { userId: "gm-1" }, "the direct GM path must not claim a remote origin");
    assert.equal(emitted.length, emittedBeforeDirectConstruction, "the direct GM construction path must not round-trip through the socket");

    const beforeUntargeted = constructionOperations;
    await api.handleSkyholdSocketPayload({
      ...constructionRequest,
      requestId: "construction-untargeted",
      operationId: "construction-untargeted",
      targetGmId: "",
      operation: { ...constructionOperation, operationId: "construction-untargeted" }
    }, "player-1");
    assert.equal(constructionOperations, beforeUntargeted, "an untargeted construction payload must not be executed by every active GM");

    const beforeForgedMetadata = constructionOperations;
    const previousConsoleErrorForConstruction = console.error;
    try {
      console.error = () => {};
      await api.handleSkyholdSocketPayload({
        ...constructionRequest,
        requestId: "construction-forged-metadata",
        operationId: "construction-forged-metadata",
        expectedRevision: constructionOperation.expectedRevision + 1,
        operation: { ...constructionOperation, operationId: "construction-forged-metadata" }
      }, "player-1");
    } finally {
      console.error = previousConsoleErrorForConstruction;
    }
    assert.equal(constructionOperations, beforeForgedMetadata, "forged construction transport metadata must be rejected before executor or dice access");
    assert.equal(emitted.at(-1)?.type, "playerConstructionOperationResponse");
    assert.equal(emitted.at(-1)?.ok, false);
    assert.equal(emitted.at(-1)?.command?.code, "invalid");

    globalThis.game.user = { id: "player-1", isGM: false };
    globalThis.game.users = { contents: [] };
    await assert.rejects(
      api.requestConstructionOperation({ ...constructionOperation, operationId: "construction-no-gm" }),
      (error) => error?.code === "authority-offline" && error?.retryable === true,
      "a construction request must fail without an active authority GM"
    );
    globalThis.game.users = { contents: [{ id: "gm-1", active: true, isGM: true }] };

    globalThis.game.user = { id: "player-1", isGM: false };
    const retryEmitted = [];
    const retryApi = createSkyholdSocketApi({
      getData: () => current,
      enqueueWrite: async (operation) => operation(),
      persistData: async () => {},
      notifyChanged: () => {},
      executeStorageOperation: async () => ({ ok: true }),
      writeTimeoutMs: 5
    });
    globalThis.game.socket = {
      emit(_channel, payload) {
        retryEmitted.push(payload);
      }
    };
    for (const [method, type] of [
      ["requestStorageOperation", "Storage"],
      ["requestMarketOperation", "Market"],
      ["requestConstructionOperation", "Construction"]
    ]) {
      retryEmitted.length = 0;
      const operation = { operationId: `duplicate-${type.toLowerCase()}`, expectedRevision: current.meta.revision };
      const original = retryApi[method](operation);
      original.catch(() => {});
      await assert.rejects(retryApi[method](operation), (error) => error?.code === "conflict",
        `${type} must reject a duplicate pending ID without replacing its original caller`);
      assert.equal(retryEmitted.length, 1, `${type} must emit the pending request only once`);
      await retryApi.handleSkyholdSocketPayload({
        type: `player${type}OperationResponse`, requestId: operation.operationId,
        operationId: operation.operationId, gmId: "gm-1", userId: "player-1",
        ok: true, result: { ok: true, operationId: operation.operationId }
      }, "gm-1");
      assert.equal((await original).operationId, operation.operationId,
        `${type} must still resolve the original caller after a rejected duplicate`);
      const transportOperation = { ...operation, operationId: `transport-${type.toLowerCase()}` };
      globalThis.game.socket = { emit() { throw new Error("disconnected transport"); } };
      await assert.rejects(retryApi[method](transportOperation),
        (error) => error?.code === "socket-unavailable" && error?.retryable === true,
        `${type} must report synchronous transport failures through its caller`);
      globalThis.game.socket = { emit(_channel, payload) { retryEmitted.push(payload); } };
      const afterFailure = retryApi[method](transportOperation);
      afterFailure.catch(() => {});
      await retryApi.handleSkyholdSocketPayload({
        type: `player${type}OperationResponse`, requestId: transportOperation.operationId,
        operationId: transportOperation.operationId, gmId: "gm-1", userId: "player-1",
        ok: true, result: { ok: true }
      }, "gm-1");
      assert.equal((await afterFailure).ok, true, `${type} must release its pending ID after a transport failure`);
      let attempts = 0;
      globalThis.game.socket = { emit() { if (++attempts === 2) throw new Error("disconnected during retry"); } };
      await assert.rejects(retryApi[method]({ ...operation, operationId: `retry-failure-${type.toLowerCase()}` }),
        (error) => error?.code === "socket-unavailable",
        `${type} must reject its promise when a timed retry loses the socket`);
      globalThis.game.socket = { emit(_channel, payload) { retryEmitted.push(payload); } };
    }
    for (const failAttempt of [1, 2]) {
      let attempts = 0;
      globalThis.game.socket = { emit() { if (++attempts === failAttempt) throw new Error("patch transport disconnected"); } };
      await assert.rejects(retryApi.requestGmDataPatch(proposed),
        (error) => error?.code === "socket-unavailable" && error?.retryable === true,
        "player patches must reject the caller if the initial send or timed retry loses its transport");
      assert.equal(attempts, failAttempt);
    }
    globalThis.game.socket = { emit(_channel, payload) { retryEmitted.push(payload); } };
    retryEmitted.length = 0;
    await assert.rejects(
      retryApi.requestStorageOperation({
        type: "withdrawResource",
        operationId: "storage-operation-retry",
        holdingId: current.holdings[0].id,
        actorId: "actor-1",
        resourceId: "wood",
        qty: 1
      }),
      /timed out/
    );
    assert.equal(retryEmitted.length, 2, "a timed-out storage operation must be retried once");
    assert.equal(retryEmitted[0].operation.operationId, retryEmitted[1].operation.operationId, "a retry must preserve the original operation id");

    const patchRetryEmitted = [];
    globalThis.game.users = { contents: [
      { id: "gm-1", active: true, isGM: true },
      { id: "gm-2", active: false, isGM: true }
    ] };
    const patchRetryApi = createSkyholdSocketApi({
      getData: () => current,
      enqueueWrite: async (operation) => operation(),
      persistData: async () => {},
      notifyChanged: () => {},
      writeTimeoutMs: 5
    });
    globalThis.game.socket = {
      emit(_channel, payload) {
        patchRetryEmitted.push(payload);
        if (patchRetryEmitted.length === 1) {
          globalThis.game.users.contents[0].active = false;
          globalThis.game.users.contents[1].active = true;
        }
      }
    };
    await assert.rejects(
      patchRetryApi.requestGmDataPatch(proposed),
      (error) => error?.code === "timeout" && error?.retryable === true,
      "a timed-out player patch must expose the common retryable command error"
    );
    assert.equal(patchRetryEmitted.length, 2, "a timed-out player patch must be retried once");
    assert.equal(patchRetryEmitted[0].operationId, patchRetryEmitted[1].operationId, "a player patch retry must preserve the operation id");
    assert.deepEqual(patchRetryEmitted.map((payload) => payload.targetGmId), ["gm-1", "gm-2"], "a player patch retry must follow an authority GM switch");

    globalThis.game.socket = {
      emit(_channel, payload) {
        emitted.push(payload);
      }
    };
    globalThis.game.user = { id: "gm-1", isGM: true };
    emitted.length = 0;
    game.users = { contents: [{ id: "gm-1", active: true, isGM: true }, { id: "player-1", active: true, isGM: false }] };
    const handled = await api.handleSkyholdSocketPayload({
      type: "playerDataPatchRequest",
      requestId: "patch-1",
      targetGmId: "gm-1",
      expectedRevision: request.patch.baseRevision,
      userId: "player-1",
      patch: request.patch
    }, "player-1");

    assert.equal(handled, true, "the GM client must handle player patch requests");
    assert.equal(persisted.holdings[0].overview.description, proposed.holdings[0].overview.description, "the GM client must apply the patch to canonical data");
    assert.equal(notifications, 1, "an accepted player patch must notify data listeners once");
    assert.equal(emitted.at(-1)?.type, "playerDataPatchResponse", "the GM client must acknowledge an accepted patch");
    assert.equal(emitted.at(-1)?.ok, true, "the GM acknowledgement must report success");
    assert.equal(emitted.at(-1)?.command?.operationId, "patch-1", "the GM acknowledgement must expose the common command result");
    assert.equal(emitted.at(-1)?.command?.revision, persisted.meta.revision, "the command result must expose the committed revision");
    assert.equal("data" in emitted.at(-1), false, "patch acknowledgements must not broadcast a full Skyhold snapshot");

    const revisionAfterFirstPatch = persisted.meta.revision;
    await api.handleSkyholdSocketPayload({
      type: "playerDataPatchRequest",
      requestId: "patch-1",
      operationId: "patch-1",
      expectedRevision: request.patch.baseRevision,
      userId: "player-1",
      targetGmId: "gm-1",
      patch: request.patch
    }, "player-1");
    assert.equal(persisted.meta.revision, revisionAfterFirstPatch, "a repeated player operation id must not apply its patch twice");
    assert.equal(notifications, 1, "a repeated player operation id must not notify listeners twice");
    assert.equal(emitted.at(-1)?.requestId, "patch-1", "a retry retains the transport ID and receives its acknowledgement");
    assert.equal(emitted.at(-1)?.ok, true, "a duplicate delivery must return a successful receipt");
    assert.equal(emitted.at(-1)?.command?.operationId, "patch-1", "a duplicate delivery must reuse the original command result");

    const cancellationProposal = clone(current);
    cancellationProposal.holdings[0].buildings.list = [];
    const cancellationPatch = buildPlayerPatch(current, cancellationProposal);
    const beforeCancellationRequest = clone(persisted);
    const notificationsBeforeCancellation = notifications;
    const previousConsoleError = console.error;
    try {
      console.error = () => {};
      await api.handleSkyholdSocketPayload({
        type: "playerDataPatchRequest",
        requestId: "cancel-project-player",
        operationId: "cancel-project-player",
        expectedRevision: cancellationPatch.baseRevision,
        userId: "player-1",
        targetGmId: "gm-1",
        patch: cancellationPatch
      }, "player-1");
    } finally {
      console.error = previousConsoleError;
    }
    assert.equal(emitted.at(-1)?.type, "playerDataPatchResponse");
    assert.equal(emitted.at(-1)?.ok, false, "the authority GM socket must reject player attempts to cancel unfinished projects");
    assert.equal(emitted.at(-1)?.command?.code, "forbidden");
    assert.deepEqual(persisted, beforeCancellationRequest, "a rejected player cancellation must not delete the project or persist a refund");
    assert.equal(notifications, notificationsBeforeCancellation, "a rejected player cancellation must not notify data listeners");

    const persistedBeforeLegacy = clone(persisted);
    const emittedBeforeLegacy = emitted.length;
    const legacyHandled = await api.handleSkyholdSocketPayload({
      type: "playerSetDataRequest",
      requestId: "legacy-1",
      userId: "player-1",
      data: proposed
    }, "player-1");

    assert.equal(legacyHandled, false, "obsolete full-data player requests must not be handled");
    assert.deepEqual(persisted, persistedBeforeLegacy, "obsolete full-data requests must not mutate canonical data");
    assert.equal(emitted.length, emittedBeforeLegacy, "obsolete full-data requests must not receive a misleading success response");
  } finally {
    if (previousGame === undefined) delete globalThis.game;
    else globalThis.game = previousGame;
    if (previousUi === undefined) delete globalThis.ui;
    else globalThis.ui = previousUi;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkSocketCharacterization();
  console.log("FBL Skyhold sockets: player patches, operations, authentication, retries and transport failures passed.");
}
