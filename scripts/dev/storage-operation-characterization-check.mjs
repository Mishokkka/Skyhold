import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { createStorageOperationExecutor } from "../apps/storage-operation-executor.js";
import { clone } from "../data/utils.js";
import { createSkyholdSplitStorage } from "../data/split-storage.js";
import { prepareSkyholdCommit } from "../data/commit-preparation.js";
import { makeStorageCommitMeta } from "../data/storage-commit.js";
import { migrateData } from "../data/normalizers.js";
import { COMMAND_ERROR } from "../data/command-result.js";
import { MODULE_ID, SETTING_CATALOG, SETTING_DATA, SETTING_HOLDINGS, SETTING_META } from "../data/constants.js";

const SKIP = Symbol("skip");

function makeActor(id, ownerId) {
  const rows = new Map();
  const actor = {
    id,
    uuid: `Actor.${id}`,
    name: `Actor ${id}`,
    documentName: "Actor",
    ownership: { default: 0, [ownerId]: 3 },
    items: {
      get contents() { return [...rows.values()]; },
      get(itemId) {
        return rows.get(String(itemId)) ?? null;
      }
    },
    addItem(item) {
      const row = {
        id: String(item.id),
        get uuid() { return `${actor.uuid}.Item.${row.id}`; },
        name: item.name ?? item.id,
        type: item.type ?? "gear",
        parent: actor,
        system: { quantity: Number(item.qty ?? item.system?.quantity ?? 1) },
        flags: clone(item.flags ?? {}),
        getFlag(scope, key) {
          return row.flags[scope]?.[key];
        },
        async update(change = {}) {
          if (change["system.quantity"] !== undefined) row.system.quantity = Number(change["system.quantity"]);
          return row;
        },
        toObject() {
          return {
            _id: row.id,
            name: row.name,
            type: row.type,
            system: clone(row.system),
            flags: clone(row.flags)
          };
        }
      };
      rows.set(row.id, row);
      return row;
    },
    testUserPermission(user) {
      return Number(actor.ownership?.[user?.id] ?? 0) >= 3;
    },
    async createEmbeddedDocuments(_type, data = [], { keepId = false } = {}) {
      return data.map((source, index) => actor.addItem({
        id: keepId ? String(source?._id ?? source?.id ?? `created-${rows.size + index + 1}`) : `created-${rows.size + index + 1}`,
        name: source?.name,
        type: source?.type,
        system: source?.system,
        flags: source?.flags,
        qty: source?.system?.quantity
      }));
    },
    async deleteEmbeddedDocuments(_type, ids = []) {
      const removed = ids.map(id => rows.get(id)).filter(Boolean);
      for (const item of removed) actor.removeItem(item.id);
      return removed;
    },
    removeItem(itemId) {
      rows.delete(String(itemId));
    },
    itemIds() {
      return [...rows.keys()];
    }
  };
  return actor;
}

function makeHolding() {
  return {
    id: "holding-1",
    visibility: "public",
    gm: { playersCanUseStorage: true },
    storage: {
      resources: [{ id: "wood", resourceId: "wood", name: "Wood", qty: 5, roomId: "outdoors" }],
      items: [{ id: "stored-sword", name: "Sword", qty: 1, roomId: "outdoors", itemData: { name: "Sword", type: "gear", system: { quantity: 1 } } }],
      log: []
    }
  };
}

function createHarness({ failPersist = false, failCompensation = false, isGM = true } = {}) {
  const user = { id: isGM ? "gm-1" : "player-1", isGM };
  const actor = makeActor("actor-1", user.id);
  actor.addItem({ id: "deposit-item", name: "Deposit", type: "gear", qty: 1 });
  let holding = makeHolding();
  let createdNo = 0;

  const logic = {
    async _storageReceiveFoundryItem(draft, item, { operationId }) {
      const previousData = item.toObject();
      actor.removeItem(item.id);
      draft.storage.items.push({ id: `stored-${operationId}`, name: item.name, qty: 1 });
      draft.storage.log.push({ id: `log-${operationId}`, operationId, qty: 1 });
      return {
        ok: true,
        message: "deposited",
        actorMutation: {
          ok: true,
          kind: "deleted",
          actorId: actor.id,
          itemId: item.id,
          previousQuantity: 1,
          previousData
        }
      };
    },

    async _withdrawResourceToActor(draft, { operationId, qty }) {
      const row = draft.storage.resources[0];
      if (row.qty < qty) return { ok: false, message: "insufficient" };
      row.qty -= qty;
      const item = actor.addItem({ id: `created-${++createdNo}`, name: "Wood", type: "rawMaterial", qty });
      draft.storage.log.push({ id: `log-${operationId}`, operationId, qty: -qty });
      return {
        ok: true,
        message: "withdrawn",
        actorMutation: { kind: "created", actorId: actor.id, itemIds: [item.id] }
      };
    },

    async _giveStoredItemToActor(draft, { operationId, itemId, qty = 1 }) {
      const index = draft.storage.items.findIndex((item) => item.id === itemId);
      const row = draft.storage.items[index];
      if (!row) return { ok: false, message: "missing" };
      const amount = Math.max(1, Math.min(Number(row.qty) || 1, Number(qty) || 1));
      if (Number(row.qty) > amount) row.qty -= amount;
      else draft.storage.items.splice(index, 1);
      const item = actor.addItem({ id: `created-${++createdNo}`, name: row.name, type: "gear", qty: amount });
      draft.storage.log.push({ id: `log-${operationId}`, operationId, qty: -amount });
      return {
        ok: true,
        message: "given",
        actorMutation: { kind: "created", actorId: actor.id, itemIds: [item.id] }
      };
    },

    async _restoreActorItemRemoval(receipt) {
      if (failCompensation) return false;
      actor.addItem({
        id: receipt.itemId,
        name: receipt.previousData.name,
        type: receipt.previousData.type,
        qty: receipt.previousQuantity
      });
      return true;
    },

    async _removeCreatedActorItems(receipt) {
      if (failCompensation) return false;
      for (const itemId of receipt.itemIds ?? []) actor.removeItem(itemId);
      return true;
    }
  };

  const updateHolding = async (holdingId, updater) => {
    if (holdingId !== holding.id) return null;
    const draft = clone(holding);
    const result = await updater(draft);
    if (result?.[SKIP]) return result.value;
    if (failPersist) throw new Error("persist failed");
    holding = draft;
    return result;
  };

  const executor = createStorageOperationExecutor({
    logic,
    updateHolding,
    readCommittedData: () => ({ holdings: [holding], meta: { revision: 0 } }),
    skipTransaction: (value) => ({ [SKIP]: true, value }),
    getUser: (userId) => userId === user.id ? user : null,
    getActor: (actorId) => actorId === actor.id ? actor : null,
    resolveUuid: async () => null
  });

  return {
    actor,
    executor,
    getHolding: () => holding,
    user
  };
}

/** Exercises authoritative storage transfers, actor ownership and replay with isolated data and document fixtures. */
export async function checkStorageOperationCharacterization() {
  {
    const gm = { id: "gm-token", isGM: true };
    const worldActor = makeActor("base", gm.id);
    const tokenActor = makeActor(worldActor.id, gm.id);
    tokenActor.uuid = "Scene.test.Token.unlinked.Actor.base";
    const worldItem = worldActor.addItem({ id: "shared", name: "Оригинал", qty: 9 });
    worldActor.addItem({ id: "created-2", name: "Другой предмет", qty: 1 });
    const addTokenItem = () => tokenActor.addItem({ id: "shared", name: "Токен", qty: 2 });
    addTokenItem();
    let holding = makeHolding();
    holding.buildings = { list: [{ id: "full", name: "Малая кладовая", constructionStatus: "built",
      functions: { storage: true }, storage: { capacity: 1 } }] };
    let failPersist = false;
    const resolveUuid = async (uuid) => uuid === tokenActor.uuid ? tokenActor
      : tokenActor.itemIds().map((id) => tokenActor.items.get(id)).find((item) => item.uuid === uuid) ?? null;
    const previousGame = globalThis.game;
    const previousFoundry = globalThis.foundry;
    globalThis.game = { user: gm, actors: { get: () => worldActor }, settings: { get: () => null } };
    globalThis.foundry = { utils: { deepClone: clone, fromUuid: resolveUuid } };
    try {
      const executor = createStorageOperationExecutor({
        getUser: () => gm, getActor: () => worldActor, resolveUuid,
        readCommittedData: () => ({ holdings: [holding], meta: { revision: 0 } }),
        skipTransaction: (value) => ({ [SKIP]: true, value }),
        updateHolding: async (_id, updater) => {
          const draft = clone(holding);
          const result = await updater(draft);
          if (result?.[SKIP]) return result.value;
          if (failPersist) throw new Error("persist failed");
          holding = draft;
          return result;
        }
      });
      const transfer = (type, operationId, extra = {}) => executor({
        type, operationId, holdingId: holding.id, actorId: worldActor.id, actorUuid: tokenActor.uuid, ...extra
      }, { userId: gm.id });
      const deposit = () => ({ itemId: "shared", itemUuid: tokenActor.items.get("shared").uuid, roomId: "full" });
      assert.equal((await transfer("depositItem", "token-deposit", deposit())).roomId, "outdoors",
        "the stack cannot fit in the selected room and must be placed outdoors as one stack");
      assert.equal(tokenActor.items.get("shared"), null);
      assert.equal(worldActor.items.get("shared"), worldItem);
      assert.deepEqual(holding.storage.items.slice(-1).map(({ roomId, qty }) => ({ roomId, qty })), [{ roomId: "outdoors", qty: 2 }]);
      assert.equal(holding.storage.log.at(-1).roomId, "outdoors", "the receipt and journal describe the actual room");

      addTokenItem();
      failPersist = true;
      await assert.rejects(transfer("depositItem", "token-deposit-rollback", deposit()), /persist failed$/);
      assert.equal(tokenActor.items.get("shared").system.quantity, 2, "rollback restores the token's Item");
      const create = tokenActor.createEmbeddedDocuments;
      const afterDeposit = clone(holding);
      for (const mode of ["adjusted", "post-create-error"]) {
        tokenActor.createEmbeddedDocuments = async (...args) => {
          const restored = await create.call(tokenActor, ...args);
          restored[0].system.quantity = 1;
          if (mode === "post-create-error") throw new Error("hook failed after creation");
          return restored;
        };
        await assert.rejects(transfer("depositItem", `token-rollback-${mode}`, deposit()), /persist failed$/);
        assert.deepEqual(tokenActor.itemIds(), ["shared"], "a hook must not cause a second copy of the restored stack");
        assert.equal(tokenActor.items.get("shared").system.quantity, 2, "rollback must correct the quantity actually created");
        assert.deepEqual(holding, afterDeposit, "a failed deposit must never change the committed warehouse");
      }
      tokenActor.createEmbeddedDocuments = async (...args) => {
        const restored = await create.call(tokenActor, ...args);
        restored[0].system.quantity = 1;
        restored[0].update = async () => null;
        return restored;
      };
      const originalError = console.error;
      try {
        console.error = () => {};
        await assert.rejects(transfer("depositItem", "token-rollback-veto", deposit()), /после отката найдено 1 из 2.*Item\.shared/,
          "a second hook veto must identify the exact surviving stack and the quantity to recover");
        assert.deepEqual(tokenActor.itemIds(), ["shared"]);
        assert.equal(tokenActor.items.get("shared").system.quantity, 1);
        assert.deepEqual(holding, afterDeposit);
      } finally {
        console.error = originalError;
        tokenActor.createEmbeddedDocuments = create;
        addTokenItem();
      }
      assert.equal(worldItem.system.quantity, 9, "rollback must not change the world Actor's Item with the same ID");
      await assert.rejects(transfer("withdrawResource", "token-withdraw-rollback", { resourceId: "wood" }), /persist failed$/);
      assert.deepEqual(tokenActor.itemIds(), ["shared"]);
      assert.deepEqual(worldActor.itemIds(), ["shared", "created-2"], "rollback removes only the Item created on the token");
      assert.equal(holding.storage.resources[0].qty, 5);

      failPersist = false;
      assert.equal((await transfer("giveStoredItem", "token-give", { itemId: "stored-sword" })).ok, true);
      assert.equal(tokenActor.items.get("created-2").name, "Sword");
      assert.equal(worldActor.items.get("created-2").name, "Другой предмет");
      assert.equal((await transfer("withdrawResource", "deleted-token", { actorUuid: "Scene.test.Token.deleted.Actor.base", resourceId: "wood" })).ok, false,
        "a removed token does not fall back to its world Actor");
      assert.equal((await transfer("depositItem", "deleted-item", { ...deposit(), itemUuid: `${tokenActor.uuid}.Item.removed` })).ok, false,
        "a stale Item UUID cannot fall back to another short ID");
      assert.equal(tokenActor.items.get("shared").system.quantity, 2);
    } finally {
      globalThis.game = previousGame;
      globalThis.foundry = previousFoundry;
    }
  }

  for (const type of ["depositItem", "giveStoredItem"]) {
    const harness = createHarness({ failPersist: true, failCompensation: true });
    const originalError = console.error;
    try {
      console.error = () => {};
      await assert.rejects(harness.executor({ type, operationId: `compensation-${type}`, holdingId: "holding-1", actorId: "actor-1",
        itemId: type === "depositItem" ? "deposit-item" : "stored-sword", qty: 1 }, { userId: harness.user.id }),
      (error) => error.code === COMMAND_ERROR.OUTCOME_UNKNOWN && error.cause?.message === "persist failed",
      "a false compensation receipt must be reported as an incomplete rollback");
      assert.equal(harness.getHolding().storage.log.length, 0);
    } finally {
      console.error = originalError;
    }
  }
  {
    const harness = createHarness();
    const result = await harness.executor({
      type: "depositItem",
      operationId: "deposit-1",
      holdingId: "holding-1",
      actorId: "actor-1",
      itemId: "deposit-item"
    }, { userId: harness.user.id });
    assert.equal(result.ok, true, "a valid GM-authoritative deposit must succeed");
    assert.equal(harness.actor.items.get("deposit-item"), null, "a successful deposit must remove the source Actor item");
    assert.equal(harness.getHolding().storage.items.some((item) => item.id === "stored-deposit-1"), true, "a successful deposit must add the item to storage");
    assert.equal(harness.getHolding().storage.log.at(-1).operationId, "deposit-1", "a deposit journal entry must retain its operation id");
  }

  {
    const harness = createHarness();
    const result = await harness.executor({
      type: "giveStoredItem",
      operationId: "give-1",
      holdingId: "holding-1",
      actorId: "actor-1",
      itemId: "stored-sword",
      qty: 1
    }, { userId: harness.user.id });
    assert.equal(result.ok, true, "a valid stored-item delivery must succeed");
    assert.equal(harness.getHolding().storage.items.some((item) => item.id === "stored-sword"), false, "a full delivery must remove the stable stored-item row");
    assert.equal(harness.actor.itemIds().filter((id) => id.startsWith("created-")).length, 1, "a successful delivery must create one Actor item");
  }

  {
    const harness = createHarness();
    harness.getHolding().storage.items.find((item) => item.id === "stored-sword").qty = 3;
    const result = await harness.executor({
      type: "giveStoredItem",
      operationId: "give-partial",
      holdingId: "holding-1",
      actorId: "actor-1",
      itemId: "stored-sword",
      qty: 1
    }, { userId: harness.user.id });
    assert.equal(result.ok, true, "a partial stored-item delivery must succeed");
    assert.equal(harness.getHolding().storage.items.find((item) => item.id === "stored-sword").qty, 2, "a partial delivery must retain the row with the remaining quantity");
  }

  {
    const harness = createHarness();
    const result = await harness.executor({
      type: "giveStoredItem",
      operationId: "give-stale",
      holdingId: "holding-1",
      actorId: "actor-1",
      itemId: "missing-row",
      qty: 1
    }, { userId: harness.user.id });
    assert.equal(result.ok, false, "a stale stored-item row id must be rejected");
    assert.equal(harness.actor.itemIds().filter((id) => id.startsWith("created-")).length, 0, "a stale stored-item row must not create an Actor item");
  }

  {
    const harness = createHarness();
    const operation = {
      type: "withdrawResource",
      operationId: "withdraw-1",
      holdingId: "holding-1",
      actorId: "actor-1",
      resourceId: "wood",
      name: "Wood",
      roomId: "outdoors",
      qty: 2
    };
    const first = await harness.executor(operation, { userId: harness.user.id });
    const second = await harness.executor(operation, { userId: harness.user.id, remote: true });
    assert.equal(first.ok, true, "a valid GM-authoritative withdrawal must succeed");
    assert.deepEqual(second, first, "duplicate delivery in one GM session must reuse the first operation result");
    assert.equal(harness.getHolding().storage.resources[0].qty, 3, "duplicate delivery must deduct storage only once");
    assert.equal(harness.actor.itemIds().filter((id) => id.startsWith("created-")).length, 1, "duplicate delivery must create one Actor item");

    const replayExecutor = createStorageOperationExecutor({
      logic: {
        async _withdrawResourceToActor() {
          throw new Error("persistent idempotency failed");
        },
        async _restoreActorItemRemoval() {},
        async _removeCreatedActorItems() {}
      },
      updateHolding: async (_holdingId, updater) => {
        const draft = clone(harness.getHolding());
        const result = await updater(draft);
        return result?.[SKIP] ? result.value : result;
      },
      skipTransaction: (value) => ({ [SKIP]: true, value }),
      getUser: () => harness.user,
      getActor: () => harness.actor
    });
    const replay = await replayExecutor(operation, { userId: harness.user.id });
    assert.equal(replay.duplicate, true, "a persisted operation id must prevent replay after executor recreation");
  }

  {
    const harness = createHarness();
    const result = await harness.executor({
      type: "withdrawResource",
      operationId: "withdraw-insufficient",
      holdingId: "holding-1",
      actorId: "actor-1",
      resourceId: "wood",
      qty: 99
    }, { userId: harness.user.id });
    assert.equal(result.ok, false, "an insufficient withdrawal must be rejected by the GM");
    assert.equal(harness.getHolding().storage.resources[0].qty, 5, "an insufficient withdrawal must preserve storage");
    assert.equal(harness.actor.itemIds().filter((id) => id.startsWith("created-")).length, 0, "an insufficient withdrawal must not create an Actor item");
  }

  {
    const harness = createHarness({ failPersist: true });
    const before = harness.actor.itemIds();
    await assert.rejects(
      harness.executor({
        type: "depositItem",
        operationId: "deposit-fail",
        holdingId: "holding-1",
        actorId: "actor-1",
        itemId: "deposit-item"
      }, { userId: harness.user.id }),
      /persist failed/
    );
    assert.deepEqual(harness.actor.itemIds(), before, "failed storage persistence must restore an Actor item removed for deposit");
    assert.equal(harness.getHolding().storage.log.length, 0, "failed persistence must not publish the draft storage journal");
  }

  {
    const harness = createHarness({ failPersist: true });
    const before = harness.actor.itemIds();
    await assert.rejects(
      harness.executor({
        type: "giveStoredItem",
        operationId: "give-fail",
        holdingId: "holding-1",
        actorId: "actor-1",
        itemId: "stored-sword",
        qty: 1
      }, { userId: harness.user.id }),
      /persist failed/
    );
    assert.deepEqual(harness.actor.itemIds(), before, "failed storage persistence must remove an Actor item created for delivery");
    assert.equal(harness.getHolding().storage.items[0].qty, 1, "failed persistence must preserve the canonical stored item");
  }

  {
    const harness = createHarness({ isGM: false });
    harness.getHolding().gm.playersCanUseStorage = false;
    const result = await harness.executor({
      type: "batchMove",
      operationId: "denied-1",
      holdingId: "holding-1",
      rowIds: ["wood"],
      fromRoomId: "outdoors",
      toRoomId: "storage",
      expectedRevision: 0
    }, { userId: harness.user.id, remote: true });
    assert.equal(result.ok, false, "storage operations must respect the holding permission flag");
    assert.equal(harness.getHolding().storage.resources[0].qty, 5, "a denied operation must not mutate storage");
  }

  {
    const harness = createHarness({ isGM: false });
    const holding = harness.getHolding();
    holding.people = { list: [{ id: "wounded", workAssignment: "soldier", injuredDays: 4 }] };
    holding.gm.defense = { squads: [{ id: "existing", type: "line", sergeantId: "wounded", memberIds: ["", "", "", ""] }] };
    const existing = clone(holding.gm.defense.squads[0]);
    const request = { type: "addDefenseSquad", holdingId: holding.id, operationId: "squad-add-denied" };
    const player = { userId: harness.user.id, remote: true };
    holding.gm.playersCanUseStorage = false;
    assert.equal((await harness.executor(request, player)).ok, false, "creating a squad requires the defense permission");
    holding.gm.playersCanEditDefense = true;
    const add = { ...request, operationId: "squad-add" };
    assert.equal((await harness.executor(add, player)).ok, true, "a wounded soldier in another squad cannot block adding a squad");
    assert.equal((await harness.executor(add, player)).ok, true);
    const saved = harness.getHolding();
    assert.equal(saved.gm.defense.squads.length, 2, "replaying a request cannot add a second squad");
    assert.deepEqual(saved.gm.defense.squads[0], existing);
    assert.deepEqual(saved.gm.defense.squads[1].memberIds, ["", "", "", ""]);
    assert.equal(saved.people.list[0].injuredDays, 4);
  }

  {
    const previousGame = globalThis.game;
    const previousFoundry = globalThis.foundry;
    const previousConst = globalThis.CONST;
    const previousFromUuid = globalThis.fromUuid;
    try {
      const user = { id: "player-real", isGM: false };
      const gm = { id: "gm-real", isGM: true };
      const actor = makeActor("actor-real", user.id);
      actor.addItem({ id: "real-deposit", name: "Lantern", type: "gear", qty: 1 });
      let holding = makeHolding();
      const catalogGear = { id: "test-gear", label: "Складской комплект", itemType: "gear" };
      globalThis.game = {
        user: { id: "gm-real", isGM: true },
        actors: { get: (actorId) => actorId === actor.id ? actor : null },
        settings: { get: (_moduleId, key) => key === SETTING_CATALOG ? { resources: [catalogGear] } : null }
      };
      globalThis.foundry = { utils: { deepClone: clone } };
      globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 } };
      globalThis.fromUuid = async () => null;

      const executor = createStorageOperationExecutor({
        updateHolding: async (holdingId, updater) => {
          if (holdingId !== holding.id) return null;
          const draft = clone(holding);
          const result = await updater(draft);
          if (result?.[SKIP]) return result.value;
          holding = draft;
          return result;
        },
        skipTransaction: (value) => ({ [SKIP]: true, value }),
        getUser: (userId) => userId === user.id ? user : (userId === gm.id ? gm : null),
        getActor: (actorId) => actorId === actor.id ? actor : null,
        resolveUuid: async () => null
      });

      const beforeVeto = clone(holding);
      const beforeVetoItems = actor.itemIds();
      const create = actor.createEmbeddedDocuments;
      actor.createEmbeddedDocuments = async () => [];
      for (const type of ["withdrawResource", "giveStoredItem"]) {
        const result = await executor({ type, operationId: `veto-${type}`, holdingId: holding.id,
          actorId: actor.id, itemId: "stored-sword", resourceId: "wood", qty: 1 }, { userId: gm.id });
        assert.equal(result.ok, false, "a Foundry creation veto must not debit the warehouse");
        assert.deepEqual(holding, beforeVeto);
        assert.deepEqual(actor.itemIds(), beforeVetoItems);
      }
      actor.createEmbeddedDocuments = (type, data) => create.call(actor, type,
        data.map(item => ({ ...item, system: { ...item.system, quantity: 2 } })));
      const changed = await executor({ type: "withdrawResource", operationId: "foundry-adjusted-qty", holdingId: holding.id,
        actorId: actor.id, resourceId: "wood", qty: 1 }, { userId: gm.id });
      assert.equal(changed.ok, false, "the warehouse must not debit a quantity different from the created Item");
      assert.deepEqual(holding, beforeVeto);
      assert.deepEqual(actor.itemIds(), beforeVetoItems, "the unexpected stack must be removed");
      actor.createEmbeddedDocuments = create;

      const remove = actor.deleteEmbeddedDocuments;
      actor.deleteEmbeddedDocuments = async () => [];
      const vetoedDeposit = await executor({ type: "depositItem", operationId: "veto-deposit", holdingId: holding.id,
        actorId: actor.id, itemId: "real-deposit", roomId: "outdoors" }, { userId: gm.id });
      assert.equal(vetoedDeposit.ok, false, "a Foundry deletion veto must not duplicate the Item in the warehouse");
      assert.deepEqual(holding, beforeVeto);
      assert.deepEqual(actor.itemIds(), beforeVetoItems);
      actor.deleteEmbeddedDocuments = remove;

      // A document operation can mutate its collection before an error is reported.
      const withdraw = { type: "withdrawResource", holdingId: holding.id, actorId: actor.id, resourceId: "wood", qty: 1 };
      const takeIn = { type: "depositItem", holdingId: holding.id, actorId: actor.id, itemId: "real-deposit" };
      actor.createEmbeddedDocuments = async (...args) => {
        await create.apply(actor, args);
        throw new Error("creation reported failure after mutation");
      };
      await assert.rejects(executor({ ...withdraw, operationId: "post-create-failure" }, { userId: gm.id }), /creation reported failure/);
      assert.deepEqual(actor.itemIds(), beforeVetoItems, "only the uncommitted issuance is removed");
      actor.createEmbeddedDocuments = create;
      actor.deleteEmbeddedDocuments = async (...args) => {
        await remove.apply(actor, args);
        throw new Error("deletion reported failure after mutation");
      };
      await assert.rejects(executor({ ...takeIn, operationId: "post-delete-failure" }, { userId: gm.id }), /deletion reported failure/);
      assert.deepEqual(actor.itemIds(), beforeVetoItems, "the failed deposit restores the source Item");
      assert.deepEqual(holding, beforeVeto);
      actor.deleteEmbeddedDocuments = remove;

      let markCreated, failCommit, markCompensating, finishCompensating;
      const created = new Promise(resolve => { markCreated = resolve; });
      const commitFailure = new Promise(resolve => { failCommit = resolve; });
      const compensating = new Promise(resolve => { markCompensating = resolve; });
      const compensationGate = new Promise(resolve => { finishCompensating = resolve; });
      let attempted = 0;
      const serialized = createStorageOperationExecutor({
        getUser: () => gm, getActor: () => actor, skipTransaction: (value) => ({ [SKIP]: true, value }),
        readCommittedData: () => ({ holdings: [holding], meta: { revision: 0 } }),
        async updateHolding(_id, updater) {
          const attempt = ++attempted;
          const draft = clone(holding);
          const result = await updater(draft);
          if (attempt === 1) {
            markCreated();
            await commitFailure;
            throw new Error("commit failed");
          }
          if (result?.[SKIP]) return result.value;
          holding = draft;
          return result;
        }
      });
      const first = assert.rejects(serialized({ ...withdraw, operationId: "fail-then-redeposit" }, { userId: gm.id }), /commit failed/);
      await created;
      const itemId = actor.items.contents.find(row => row.getFlag(MODULE_ID, "storageOperationId") === "fail-then-redeposit").id;
      actor.deleteEmbeddedDocuments = async (...args) => {
        markCompensating();
        await compensationGate;
        return remove.apply(actor, args);
      };
      const second = serialized({ ...takeIn, itemId, operationId: "attempt-redeposit" }, { userId: gm.id });
      failCommit();
      await compensating;
      const attemptsDuringCompensation = attempted;
      finishCompensating();
      await first;
      assert.equal((await second).ok, false);
      assert.equal(attemptsDuringCompensation, 1, "the next command may not resolve a temporary Item");
      assert.deepEqual(holding, beforeVeto);
      assert.deepEqual(actor.itemIds(), beforeVetoItems);
      actor.deleteEmbeddedDocuments = remove;

      // The owner's native sheet can edit or remove the new stack before Skyhold's settings write rejects.
      for (const change of ["quantity", "moved"]) {
        const operationId = `sheet-${change}`;
        const command = { ...withdraw, operationId, qty: 2 };
        let writes = 0;
        const destination = makeActor("other", user.id);
        const failing = createStorageOperationExecutor({
          getUser: () => gm, getActor: () => actor,
          readCommittedData: () => ({ holdings: [holding], meta: { revision: 0 } }),
          async updateHolding(_id, updater) {
            writes++;
            await updater(clone(holding));
            const item = actor.items.contents.find(row => row.getFlag(MODULE_ID, "storageOperationId") === operationId);
            if (change === "quantity") await item.update({ "system.quantity": 4 });
            else {
              destination.addItem({ ...item.toObject(), id: item.id });
              actor.removeItem(item.id);
            }
            throw new Error("commit failed");
          }
        });
        const savedError = console.error;
        try {
          console.error = () => {};
          for (let retry = 0; retry < 2; retry++) {
            await assert.rejects(failing(command, { userId: gm.id }),
              (error) => error.code === COMMAND_ERROR.OUTCOME_UNKNOWN && error.operationId === operationId);
          }
        } finally { console.error = savedError; }
        const item = (change === "quantity" ? actor : destination).items.contents
          .find(row => row.getFlag(MODULE_ID, "storageOperationId") === operationId);
        assert.equal(item?.system.quantity, change === "quantity" ? 4 : 2, "rollback must leave the owner's edit intact");
        assert.equal(writes, 1, "retrying the same uncertain issuance must not create a second Item");
        assert.deepEqual(holding, beforeVeto);
        if (change === "quantity") actor.removeItem(item.id);
      }

      const beforeCompensation = clone(holding);
      const savedError = console.error;
      const previousHooks = globalThis.Hooks;
      const deleteHooks = new Map();
      let hookId = 0;
      let deleteCalls = 0;
      let allowRollback = false;
      globalThis.Hooks = {
        on(name, callback) { assert.equal(name, "preDeleteItem"); deleteHooks.set(++hookId, callback); return hookId; },
        off(name, id) { assert.equal(name, "preDeleteItem"); assert.ok(deleteHooks.delete(id)); }
      };
      actor.deleteEmbeddedDocuments = async (type, ids, options) => {
        deleteCalls++;
        // Another sheet edit occurs during Foundry's asynchronous preparation.
        const item = actor.items.get(ids[0]);
        if (!allowRollback) await item.update({ "system.quantity": 4 });
        const allowed = ids.filter((id) => [...deleteHooks.values()]
          .every((callback) => callback(actor.items.get(id), options) !== false));
        return remove.call(actor, type, allowed);
      };
      const lateFailure = createStorageOperationExecutor({
        getUser: () => gm, getActor: () => actor,
        readCommittedData: () => ({ holdings: [holding], meta: { revision: 0 } }),
        async updateHolding(_id, updater) {
          await updater(clone(holding), { meta: { revision: 0 } });
          throw new Error("persist failed");
        }
      });
      try {
        console.error = () => {};
        for (const active of ["owner", "other-gm", "observer"]) {
          deleteCalls = 0;
          const other = active === "owner" ? user : { id: active, isGM: active === "other-gm" };
          game.users = { contents: [gm, { ...other, active: true }] };
          const command = { ...withdraw, operationId: `rollback-${active}`, qty: 2 };
          for (let retry = 0; retry < 2; retry++) {
            await assert.rejects(lateFailure(command, { userId: gm.id }),
              error => error.code === COMMAND_ERROR.OUTCOME_UNKNOWN && error.message.includes(actor.uuid));
          }
          const item = actor.items.contents.find(row => row.getFlag(MODULE_ID, "storageOperationId") === command.operationId);
          assert.equal(deleteCalls, active === "observer" ? 1 : 0, "do not start destructive rollback while another writer is online");
          assert.equal(item?.system.quantity, active === "observer" ? 4 : 2, "the last check vetoes deletion after a late edit");
          assert.deepEqual(holding, beforeCompensation);
          actor.removeItem(item.id);
        }
        allowRollback = true;
        game.users = { contents: [gm, { ...user, active: false }] };
        await assert.rejects(lateFailure({ ...withdraw, operationId: "rollback-owner-offline" }, { userId: gm.id }), /persist failed$/);
        assert.deepEqual(actor.itemIds(), beforeVetoItems, "a confirmed rejection still rolls back in a single-writer inventory");
        assert.equal(deleteHooks.size, 0, "the hook is removed after both a veto and a successful rollback");
      } finally {
        console.error = savedError;
        globalThis.Hooks = previousHooks;
        delete game.users;
        actor.deleteEmbeddedDocuments = remove;
      }

      // A deletion that did reach Foundry must be acknowledged with the actual deleted Item.
      actor.deleteEmbeddedDocuments = async (type, ids) => {
        await actor.items.get(ids[0]).update({ "system.quantity": 4 });
        return remove.call(actor, type, ids);
      };
      const changedSource = await executor({ ...takeIn, operationId: "changed-deposit-source" }, { userId: gm.id });
      assert.equal(changedSource.ok, false);
      assert.equal(actor.items.get("real-deposit").system.quantity, 4, "restore the actual source version before allowing another deposit");
      assert.deepEqual(holding, beforeCompensation);
      actor.deleteEmbeddedDocuments = remove;

      const deposit = await executor({
        type: "depositItem",
        operationId: "real-deposit-op",
        holdingId: holding.id,
        actorId: actor.id,
        itemId: "real-deposit",
        roomId: "outdoors"
      }, { userId: gm.id });
      assert.equal(deposit.ok, true, "the real finance adapter must execute a deposit operation");
      assert.equal(actor.items.get("real-deposit"), null, "the real finance adapter must remove the deposited Actor item");
      assert.equal(holding.storage.log.at(-1).operationId, "real-deposit-op", "the real storage journal must retain the deposit operation id");

      const withdrawal = await executor({
        type: "withdrawResource",
        operationId: "real-withdraw-op",
        holdingId: holding.id,
        actorId: actor.id,
        resourceId: "wood",
        name: "Wood",
        roomId: "outdoors",
        qty: 2
      }, { userId: gm.id });
      assert.equal(withdrawal.ok, true, "the real finance adapter must execute a resource withdrawal");
      assert.equal(holding.storage.resources[0].qty, 3, "the real finance adapter must deduct the withdrawn resource");
      assert.equal(holding.storage.log.at(-1).operationId, "real-withdraw-op", "the real storage journal must retain the withdrawal operation id");

      const beforeMissing = clone(holding);
      const beforeMissingActorItems = actor.itemIds();
      for (const [operationId, resourceId, rowIds] of [
        ["missing-selected-row", "wood", ["removed-row"]], ["missing-legacy-resource", "stone", []]
      ]) {
        const missing = await executor({
          type: "withdrawResource", operationId, holdingId: holding.id,
          actorId: actor.id, resourceId, roomId: "outdoors", rowIds, qty: 1
        }, { userId: gm.id });
        assert.equal(missing.ok, false, "a missing row must produce a normal refusal");
      }
      assert.deepEqual(holding, beforeMissing);
      assert.deepEqual(actor.itemIds(), beforeMissingActorItems);

      holding.storage.resources.push({ id: "wood", resourceId: "stone", name: "Камень", qty: 2, roomId: "outdoors" });
      const beforeDuplicate = clone(holding);
      const duplicate = await executor({
        type: "withdrawResource", operationId: "duplicate-withdrawal", holdingId: holding.id,
        actorId: actor.id, resourceId: "wood", roomId: "outdoors", rowIds: ["wood"], qty: 1
      }, { userId: gm.id });
      assert.equal(duplicate.ok, false);
      assert.match(duplicate.message, /одинаковый ID/);
      assert.deepEqual(holding, beforeDuplicate);
      assert.deepEqual(actor.itemIds(), beforeMissingActorItems);
      holding.storage.resources.pop();

      const reservedRow = holding.storage.resources[0];
      holding.special = { transportV2: { orders: [{
        id: "wood-export", direction: "outbound", status: "booked", cargo: [{
          lotId: "wood-lot", rowId: reservedRow.id, batchId: reservedRow.batches[0].id, qty: 2
        }]
      }] } };
      const locked = {
        type: "withdrawResource", operationId: "reserved-withdrawal", holdingId: holding.id,
        actorId: actor.id, resourceId: "wood", roomId: "outdoors", qty: 2
      };
      const before = clone(holding);
      const actorItems = actor.itemIds();
      const refused = await executor(locked, { userId: gm.id });
      assert.equal(refused.ok, false, "2 of 3 units are reserved, so issuing 2 must fail before creating an Item");
      assert.deepEqual(actor.itemIds(), actorItems);
      assert.deepEqual(holding, before, "refusal preserves stock, the transport reservation and journals");
      holding.storage.resources.push({ id: "free-wood", resourceId: "wood", name: "Wood", qty: 2, roomId: "outdoors" });
      const exact = await executor({ ...locked, operationId: "free-withdrawal", rowIds: ["free-wood"] }, { userId: gm.id });
      assert.equal(exact.ok, true, "the selected free row is a valid source even when another row in the room is reserved");
      assert.equal(holding.storage.resources[0].qty, 3);
      assert.equal(holding.storage.resources[1].qty, 0);
      assert.equal(actor.items.get(actor.itemIds().at(-1)).system.quantity, 2);

      const storedSword = holding.storage.items.find((item) => item.id === "stored-sword");
      storedSword.qty = 2;
      storedSword.itemData.system.quantity = 2;

      const partialDelivery = await executor({
        type: "giveStoredItem",
        operationId: "real-give-partial-op",
        holdingId: holding.id,
        actorId: actor.id,
        itemId: "stored-sword",
        qty: 1
      }, { userId: gm.id });
      assert.equal(partialDelivery.ok, true, "the real finance adapter must execute partial stored-item delivery");
      assert.equal(holding.storage.items.find((item) => item.id === "stored-sword")?.qty, 1, "a partial delivery must update the canonical row quantity");
      assert.equal(holding.storage.items.find((item) => item.id === "stored-sword")?.itemData?.system?.quantity, 1, "a partial delivery must keep embedded item quantity in sync");

      const delivery = await executor({
        type: "giveStoredItem",
        operationId: "real-give-final-op",
        holdingId: holding.id,
        actorId: actor.id,
        itemId: "stored-sword",
        qty: 1
      }, { userId: gm.id });
      assert.equal(delivery.ok, true, "the real finance adapter must execute stored-item delivery");
      assert.equal(holding.storage.items.some((item) => item.id === "stored-sword"), false, "the real finance adapter must remove a row after its final stored item is delivered");
      assert.equal(holding.storage.log.at(-1).operationId, "real-give-final-op", "the real storage journal must retain the delivery operation id");

      holding.storage.moneyCopper = 20;
      holding.storage.resources.push({ id: "tokens", resourceId: "custom", name: "Деньги", roomId: "outdoors", qty: 3 });
      const issuedCustom = await executor({ ...locked, operationId: "issue-custom-tokens",
        resourceId: "custom", name: "Деньги", rowIds: ["tokens"], qty: 2 }, { userId: gm.id });
      assert.equal(issuedCustom.ok, true);
      const issuedItem = actor.items.get(actor.itemIds().at(-1));
      assert.equal(issuedItem.getFlag(MODULE_ID, "storageOperationId"), issuedCustom.operationId);
      const returnedCustom = await executor({ ...locked, type: "depositItem", operationId: "return-custom-tokens",
        itemId: issuedItem.id }, { userId: gm.id });
      assert.equal(returnedCustom.ok, true);
      assert.equal(actor.items.get(issuedItem.id), null);
      assert.equal(holding.storage.moneyCopper, 20, "returning tokens called money must not credit the treasury");
      assert.equal(holding.storage.resources.filter(row => row.resourceId === "custom" && row.name === "Деньги")
        .reduce((sum, row) => sum + row.qty, 0), 3, "the full transfer preserves the custom material and its quantity");
      const unmarked = actor.addItem({ id: "unmarked-material", type: "rawMaterial", name: "Wood", qty: 1 });
      const woodBefore = holding.storage.resources.filter(row => row.resourceId === "wood").reduce((sum, row) => sum + row.qty, 0);
      const receivedUnmarked = await executor({ ...locked, type: "depositItem", operationId: "legacy-resource-deposit",
        itemId: unmarked.id }, { userId: gm.id });
      assert.equal(receivedUnmarked.ok, true);
      assert.equal(holding.storage.resources.filter(row => row.resourceId === "wood").reduce((sum, row) => sum + row.qty, 0),
        woodBefore + 1, "unmarked items still use catalog aliases");

      const gearRow = { id: " gear-stock ", resourceId: catalogGear.id, name: catalogGear.label, roomId: "outdoors", qty: 3 };
      holding.storage.resources.push(gearRow, { ...gearRow, id: "gear-stock", qty: 1 });
      const gearStock = () => holding.storage.resources.filter(row => row.resourceId === catalogGear.id);
      const issuedGear = await executor({ ...locked, operationId: "issue-catalog-gear", resourceId: catalogGear.id,
        rowIds: [gearRow.id], qty: 2 }, { userId: gm.id });
      assert.equal(issuedGear.ok, true);
      assert.deepEqual(gearStock().map(({ id, qty }) => [id, qty]), [[gearRow.id, 1], ["gear-stock", 1]]);
      const flaggedGear = actor.items.get(actor.itemIds().at(-1));
      assert.equal(flaggedGear.type, "gear");
      assert.equal(flaggedGear.getFlag(MODULE_ID, "storageResourceId"), catalogGear.id);
      const gearReturn = { ...locked, type: "depositItem", operationId: "return-catalog-gear", itemId: flaggedGear.id };
      const receivedGear = await executor(gearReturn, { userId: gm.id });
      assert.equal(receivedGear.ok, true);
      assert.deepEqual(await executor(gearReturn, { userId: gm.id }), receivedGear);
      assert.equal(gearStock().reduce((sum, row) => sum + row.qty, 0), 4, "gear-backed resources must round-trip in the resource ledger");
      assert.equal(actor.items.get(flaggedGear.id), null);
      assert.equal(holding.storage.items.some(row => row.name === catalogGear.label), false);
      const normalGear = actor.addItem({ id: "plain-gear", type: "gear", name: catalogGear.label, qty: 1 });
      assert.equal((await executor({ ...gearReturn, operationId: "return-unmarked-gear", itemId: normalGear.id }, { userId: gm.id })).ok, true);
      const storedGear = holding.storage.items.find(row => row.name === catalogGear.label);
      assert.equal(storedGear?.qty, 1, "an ordinary unflagged Item with the same name must remain gear");
      storedGear.id = " gear-item ";
      holding.storage.items.push({ ...storedGear, id: "gear-item" });
      assert.equal((await executor({ ...locked, type: "giveStoredItem", operationId: "give-exact-gear", itemId: storedGear.id, qty: 1 },
        { userId: gm.id })).ok, true);
      assert.deepEqual(holding.storage.items.filter(row => row.name === catalogGear.label).map(row => row.id), ["gear-item"]);

      // The last marker write can fail after the holding partition, including
      // its receipt, has become recoverable. Compensation must follow that outcome.
      for (const [type, blocked] of [
        ...["withdrawResource", "depositItem"].flatMap(type =>
          ["holdings", "completion", "veto", "newer", "unreadable"].map(blocked => [type, blocked]))
      ]) {
        const root = migrateData({ meta: { revision: 8 }, holdings: [makeHolding()], catalog: {} });
        const settings = new Map([[SETTING_META, root.meta], [SETTING_HOLDINGS, root.holdings],
          [SETTING_CATALOG, root.catalog], [SETTING_DATA, root]]);
        let readable = true;
        const adapter = {
          get(_module, key) {
            if (!readable) throw new Error("settings are temporarily unreadable");
            return clone(settings.get(key));
          },
          async set(_module, key, value) {
            if (blocked === "holdings" && key === SETTING_HOLDINGS) throw new Error("injected write failure");
            if (["completion", "newer", "unreadable"].includes(blocked) && key === SETTING_META && value.storageCommit?.writeComplete) {
              if (blocked === "newer") {
                const fresh = clone(settings.get(SETTING_HOLDINGS));
                fresh[0].name = "Edited after the transfer by the new authority";
                settings.set(SETTING_HOLDINGS, fresh);
                settings.set(SETTING_META, makeStorageCommitMeta({ ...value, revision: 10 }, { writeId: "second-gm",
                  previousRevision: 9, holdings: fresh, catalog: settings.get(SETTING_CATALOG), complete: true }));
              }
              if (blocked === "unreadable") readable = false;
              throw new Error("injected write failure");
            }
            if (blocked === "veto" && key === SETTING_HOLDINGS) return clone(settings.get(key));
            settings.set(key, clone(value));
            return clone(value);
          }
        };
        const storage = createSkyholdSplitStorage({ settings: adapter });
        const options = {
          updateHolding: async (holdingId, updater) => {
            const draft = storage.getData();
            const applied = await updater(draft.holdings.find(row => row.id === holdingId), draft);
            if (applied?.[SKIP]) return applied.value;
            const prepared = prepareSkyholdCommit(draft, { scope: "holdings" });
            await storage.persistData(prepared.data, { normalized: true, scope: prepared.scope });
            return applied;
          },
          skipTransaction: (value) => ({ [SKIP]: true, value }),
          getUser: () => gm,
          getActor: () => actor,
          readCommittedData: () => storage.getDataView()
        };
        const deposit = type === "depositItem";
        const itemId = deposit ? `split-actor-item-${blocked}` : "";
        if (deposit) actor.addItem({ id: itemId, name: "Lantern", type: "gear", qty: 1 });
        const request = { ...locked, type, itemId, operationId: `split-${type}-${blocked}`, qty: 1 };
        const idsBefore = actor.itemIds();
        const run = createStorageOperationExecutor(options);
        const stale = await run({ ...request, operationId: `${request.operationId}-stale`, expectedRevision: 7 }, { userId: gm.id });
        assert.equal(stale.stale, true);
        assert.deepEqual(actor.itemIds(), idsBefore, "a stale transfer never touches the Actor");
        const attempt = run(request, { userId: gm.id });
        const committed = !["holdings", "veto"].includes(blocked);
        if (!committed) {
          await assert.rejects(attempt, /injected write failure|не подтвердил запись/);
          assert.deepEqual(actor.itemIds(), idsBefore, "a rolled-back holding write must restore the original Actor inventory");
        } else {
          if (blocked === "unreadable") {
            await assert.rejects(attempt, { code: "outcome-unknown" });
            await assert.rejects(run(request, { userId: gm.id }), { code: "outcome-unknown" });
            readable = true;
            assert.equal((await run(request, { userId: gm.id })).replay, true,
              "retrying the same transfer can acknowledge a late receipt without touching the Actor again");
          } else assert.equal((await attempt).ok, true, "a verified holding receipt makes the transfer successful");
          const expectedItemCount = idsBefore.length + (deposit ? -1 : 1);
          assert.equal(actor.itemIds().length, expectedItemCount, "never compensate a committed or still uncertain transfer");
          storage.resetMetrics();
          assert.equal(storage.getDataView().meta.revision, blocked === "newer" ? 10 : 9);
          if (blocked === "completion") assert.equal(storage.getMetrics().normalizations, 0,
            "a verified forward commit reuses the prepared view even while its marker remains pending");
          const replay = await createStorageOperationExecutor(options)(request, { userId: gm.id });
          assert.equal(replay.replay, true, "the recovered transfer receipt is usable after executor restart");
          assert.equal(actor.itemIds().length, expectedItemCount);
        }
        const reopened = createSkyholdSplitStorage({ settings: adapter }).getData();
        const saved = reopened.holdings[0].storage;
        assert.equal(saved.resources[0].qty, !deposit && committed ? 4 : 5);
        assert.equal(saved.items.length, deposit && committed ? 2 : 1);
      }
    } finally {
      if (previousGame === undefined) delete globalThis.game;
      else globalThis.game = previousGame;
      if (previousFoundry === undefined) delete globalThis.foundry;
      else globalThis.foundry = previousFoundry;
      if (previousConst === undefined) delete globalThis.CONST;
      else globalThis.CONST = previousConst;
      if (previousFromUuid === undefined) delete globalThis.fromUuid;
      else globalThis.fromUuid = previousFromUuid;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkStorageOperationCharacterization();
  console.log("FBL Skyhold storage-operation characterization passed.");
}
