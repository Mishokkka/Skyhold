import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { createStorageOperationExecutor } from "../apps/storage-operation-executor.js";
import { clone } from "../data/utils.js";
import { createSkyholdSplitStorage } from "../data/split-storage.js";
import { prepareSkyholdCommit } from "../data/commit-preparation.js";
import { migrateData } from "../data/normalizers.js";
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
      for (const itemId of ids) actor.removeItem(itemId);
      return ids;
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
      /persist failed; compensation failed/, "a false compensation receipt must be reported as an incomplete rollback");
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
      globalThis.game = {
        user: { id: "gm-real", isGM: true },
        actors: { get: (actorId) => actorId === actor.id ? actor : null },
        settings: { get: () => null }
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

      // The last marker write can fail after the holding partition, including
      // its receipt, has become recoverable. Compensation must follow that outcome.
      for (const [type, blocked] of [
        ["withdrawResource", "holdings"], ["withdrawResource", "completion"],
        ["depositItem", "holdings"], ["depositItem", "completion"]
      ]) {
        const root = migrateData({ meta: { revision: 8 }, holdings: [makeHolding()], catalog: {} });
        const settings = new Map([[SETTING_META, root.meta], [SETTING_HOLDINGS, root.holdings],
          [SETTING_CATALOG, root.catalog], [SETTING_DATA, root]]);
        const adapter = {
          get: (_module, key) => clone(settings.get(key)),
          async set(_module, key, value) {
            if ((blocked === "holdings" && key === SETTING_HOLDINGS)
              || (blocked === "completion" && key === SETTING_META && value.storageCommit?.writeComplete)) {
              throw new Error("injected write failure");
            }
            settings.set(key, clone(value));
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
          getActor: () => actor
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
        if (blocked === "holdings") {
          await assert.rejects(attempt, /injected write failure/);
          assert.deepEqual(actor.itemIds(), idsBefore, "a rolled-back holding write must undo the Actor creation");
        } else {
          assert.equal((await attempt).ok, true, "a forward-recoverable holding write is a successful transfer");
          const expectedItemCount = idsBefore.length + (deposit ? -1 : 1);
          assert.equal(actor.itemIds().length, expectedItemCount);
          storage.resetMetrics();
          assert.equal(storage.getDataView().meta.revision, 9);
          assert.equal(storage.getMetrics().normalizations, 0, "a verified forward commit reuses the prepared view even while its marker remains pending");
          const replay = await createStorageOperationExecutor(options)(request, { userId: gm.id });
          assert.equal(replay.replay, true, "the recovered transfer receipt is usable after executor restart");
          assert.equal(actor.itemIds().length, expectedItemCount);
        }
        const reopened = createSkyholdSplitStorage({ settings: adapter }).getData();
        const saved = reopened.holdings[0].storage;
        assert.equal(saved.resources[0].qty, !deposit && blocked === "completion" ? 4 : 5);
        assert.equal(saved.items.length, deposit && blocked === "completion" ? 2 : 1);
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
