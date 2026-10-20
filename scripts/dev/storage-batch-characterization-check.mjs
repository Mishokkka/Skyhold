import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyStorageBatchMove, planStorageBatchMove } from "../engines/storage/batch-move.js";
import { itemQuantity } from "../engines/storage/item-quantity.js";
import { createStorageOperationExecutor } from "../apps/storage-operation-executor.js";
import {
  addResourceBatches,
  splitResourceBatchParts,
  takeResourceBatches
} from "../core/resource-batches.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fixture() {
  return {
    id: "holding-1",
    visibility: "public",
    gm: { playersCanUseStorage: true },
    buildings: { list: [] },
    storage: {
      resources: [
        { id: "res-a", resourceId: "wood", name: "Древесина", qty: 5, roomId: "source", weight: 1 },
        { id: "res-b", resourceId: "stone", name: "Камень", qty: 4, roomId: "source", weight: 1 }
      ],
      items: [
        { id: "item-a", name: "Канат", roomId: "source", weight: 2, system: { quantity: 2 } }
      ],
      log: []
    }
  };
}

function dependencies() {
  const normalizeStorageRoomId = (value) => String(value || "outdoors");
  const storageRowLoad = (row) => Math.max(0, Number(row?.weight ?? row?.load ?? 0) || 0) * Math.max(1, itemQuantity(row));
  const storageRooms = (holding) => {
    const used = { source: 0, target: 0, outdoors: 0 };
    for (const row of [...(holding?.storage?.resources ?? []), ...(holding?.storage?.items ?? [])]) {
      used[normalizeStorageRoomId(row.roomId)] = (used[normalizeStorageRoomId(row.roomId)] ?? 0) + storageRowLoad(row);
    }
    return [
      { id: "source", label: "Исходный", available: true, unlimited: false, free: Math.max(0, 30 - used.source) },
      { id: "target", label: "Целевой", available: true, unlimited: false, free: Math.max(0, 2 - used.target) },
      { id: "outdoors", label: "Снаружи", available: true, unlimited: true, free: Infinity }
    ];
  };
  const findResource = (holding, resource, roomId) => (holding.storage.resources ?? []).find((row) => row.resourceId === resource.resourceId && normalizeStorageRoomId(row.roomId) === roomId);
  return {
    safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    normalizeStorageRoomId,
    itemQuantity,
    storageRooms,
    storageRowLoad,
    storageRoomLabel: (holding, roomId) => storageRooms(holding).find((room) => room.id === roomId)?.label ?? roomId,
    clone,
    makeId: (prefix = "row") => `${prefix}-split`,
    setItemQuantity: (row, qty) => {
      row.qty = qty;
      if (row.itemData?.system) row.itemData.system.quantity = qty;
      if (row.system) row.system.quantity = qty;
      return row;
    },
    takeResourceRow: (_holding, row, qty) => takeResourceBatches(row, qty),
    addResourceWithOverflow: (holding, resource, qty) => {
      const requested = normalizeStorageRoomId(resource.roomId);
      const requestedRoom = storageRooms(holding).find((room) => room.id === requested);
      const unitLoad = Math.max(0.0001, Number(resource.weight ?? 1) || 1);
      const fit = requestedRoom?.unlimited ? qty : Math.min(qty, Math.floor(Math.max(0, requestedRoom?.free ?? 0) / unitLoad));
      const placements = [];
      let remainingBatches = Array.isArray(resource.batches) ? resource.batches : [];
      const addPart = (row, part) => {
        const split = splitResourceBatchParts(remainingBatches, part);
        remainingBatches = split.remainingBatches;
        addResourceBatches(row, { batches: split.batches });
      };
      if (fit > 0) {
        const row = findResource(holding, resource, requested) ?? { ...resource, id: `${resource.id}-${requested}`, qty: 0, batches: [], roomId: requested };
        if (!holding.storage.resources.includes(row)) holding.storage.resources.push(row);
        addPart(row, fit);
        placements.push({ roomId: requested, qty: fit });
      }
      const rest = qty - fit;
      if (rest > 0) {
        const row = findResource(holding, resource, "outdoors") ?? { ...resource, id: `${resource.id}-outdoors`, qty: 0, batches: [], roomId: "outdoors" };
        if (!holding.storage.resources.includes(row)) holding.storage.resources.push(row);
        addPart(row, rest);
        placements.push({ roomId: "outdoors", qty: rest, overflowFrom: requested });
      }
      return placements;
    },
    appendStorageLog: (holding, entries) => holding.storage.log.push(...entries),
    formatNumber: (value) => String(value)
  };
}

export async function checkStorageBatchCharacterization() {
  const deps = dependencies();
  const holding = fixture();
  const plan = planStorageBatchMove({
    holding,
    rowType: "resources",
    rowIds: ["res-a"],
    fromRoomId: "source",
    toRoomId: "target",
    dependencies: deps
  });
  assert.equal(plan.ok, true, "selected resource batch must produce a preview");
  assert.deepEqual(plan.rows.map((row) => row.id), ["res-a"], "preview must include only explicitly selected rows");

  const applied = applyStorageBatchMove({
    holding,
    rowType: "resources",
    rowIds: ["res-a"],
    fromRoomId: "source",
    toRoomId: "target",
    operationId: "batch-resource-1",
    dependencies: deps
  });
  assert.equal(applied.ok, true, "selected resource batch must apply");
  assert.equal(holding.storage.resources.find((row) => row.id === "res-a")?.qty, 0, "selected source row must be emptied");
  assert.equal(holding.storage.resources.find((row) => row.id === "res-b")?.qty, 4, "unselected source row must remain unchanged");
  assert.ok(holding.storage.log.some((row) => row.operationId === "batch-resource-1"), "batch apply must leave an idempotency audit marker");

  const partialResourceHolding = fixture();
  const partialResource = applyStorageBatchMove({
    holding: partialResourceHolding,
    rowType: "resources",
    rowIds: ["res-a"],
    rowQuantities: { "res-a": 2 },
    fromRoomId: "source",
    toRoomId: "target",
    operationId: "batch-resource-partial",
    dependencies: deps
  });
  assert.equal(partialResource.ok, true, "a resource stack must support a partial move");
  assert.equal(partialResourceHolding.storage.resources.find((row) => row.id === "res-a")?.qty, 3, "a partial resource move must preserve the source remainder");
  assert.equal(partialResourceHolding.storage.resources.find((row) => row.resourceId === "wood" && row.roomId === "target")?.qty, 2, "a partial resource move must add only the requested quantity to the target");

  const rejectedQuantity = planStorageBatchMove({
    holding: fixture(),
    rowType: "resources",
    rowIds: ["res-a"],
    rowQuantities: { "res-a": 6 },
    fromRoomId: "source",
    toRoomId: "target",
    dependencies: deps
  });
  assert.equal(rejectedQuantity.ok, false, "a move quantity above the available stack must be rejected");

  const itemHolding = fixture();
  const itemApplied = applyStorageBatchMove({
    holding: itemHolding,
    rowType: "items",
    rowIds: ["item-a"],
    fromRoomId: "source",
    toRoomId: "target",
    operationId: "batch-item-1",
    dependencies: deps
  });
  assert.equal(itemApplied.ok, true, "selected item batch must apply");
  assert.equal(itemHolding.storage.items[0].roomId, "outdoors", "an indivisible item stack must use an overflow room when the target cannot fit it");
  assert.equal(itemQuantity(itemHolding.storage.items[0]), 2, "item batch must preserve the system quantity adapter value");

  const partialItemHolding = fixture();
  const partialItem = applyStorageBatchMove({
    holding: partialItemHolding,
    rowType: "items",
    rowIds: ["item-a"],
    rowQuantities: { "item-a": 1 },
    fromRoomId: "source",
    toRoomId: "target",
    operationId: "batch-item-partial",
    dependencies: deps
  });
  assert.equal(partialItem.ok, true, "an item stack must support a partial move");
  assert.equal(itemQuantity(partialItemHolding.storage.items.find((row) => row.id === "item-a")), 1, "a partial item move must preserve the source remainder");
  assert.equal(itemQuantity(partialItemHolding.storage.items.find((row) => row.id === "sitem-split")), 1, "a partial item move must create a target stack with the requested quantity");
  assert.equal(partialItemHolding.storage.items.find((row) => row.id === "sitem-split")?.roomId, "target", "the split item stack must move to the requested room when it fits");

  const world = { meta: { revision: 7 }, holdings: [fixture()] };
  const logic = {
    _applyStorageBatchMove(target, options) {
      return applyStorageBatchMove({ holding: target, ...options, dependencies: deps });
    },
    _applyManualStorageChange(target, options) {
      const row = { id: `added-${options.resourceId}`, resourceId: options.resourceId, name: options.name, qty: options.qty, roomId: options.roomId };
      target.storage.resources.push(row);
      target.storage.log.push({ operationId: options.operationId, kind: options.kind, qty: options.qty });
      return { ok: true, message: `${options.name}: +${options.qty}.` };
    }
  };
  const executor = createStorageOperationExecutor({
    logic,
    updateHolding: async (holdingId, updater) => updater(world.holdings.find((row) => row.id === holdingId), world),
    skipTransaction: (value) => value,
    getUser: (id) => ({ id, isGM: id === "gm-1" }),
    getActor: () => null,
    resolveUuid: async () => null
  });
  const stale = await executor({
    type: "batchMove",
    operationId: "batch-stale",
    holdingId: "holding-1",
    expectedRevision: 6,
    rowType: "resources",
    rowIds: ["res-a"],
    fromRoomId: "source",
    toRoomId: "target"
  }, { userId: "player-1", remote: true });
  assert.equal(stale.stale, true, "authority executor must reject a batch built against an old revision");

  const command = {
    type: "batchMove",
    operationId: "batch-authority-1",
    holdingId: "holding-1",
    expectedRevision: 7,
    rowType: "resources",
    rowIds: ["res-a"],
    fromRoomId: "source",
    toRoomId: "target"
  };
  const first = await executor(command, { userId: "player-1", remote: true });
  const second = await executor(clone(command), { userId: "player-1", remote: true });
  assert.equal(first.ok, true, "authority executor must apply a permitted current batch");
  assert.deepEqual(second, first, "operation id must make repeated batch commands idempotent");

  const addition = {
    type: "addResourceRow",
    operationId: "add-resource-authority-1",
    holdingId: "holding-1",
    resourceId: "stone",
    name: "Камень",
    roomId: "target",
    qty: 1
  };
  // Storage use grants movement of existing goods, never minting catalog goods or money.
  await assert.rejects(executor(addition, { userId: "player-1", remote: true }), /Только ГМ/);
  assert.equal(world.holdings[0].storage.resources.some((row) => row.id === "added-stone"), false);
  const added = await executor(addition, { userId: "gm-1" });
  const addedAgain = await executor(addition, { userId: "gm-1" });
  assert.equal(added.ok, true, "a GM must retain manual catalog resource addition");
  assert.deepEqual(addedAgain, added, "catalog resource addition must remain idempotent");
  assert.equal(world.holdings[0].storage.resources.filter((row) => row.id === "added-stone").length, 1, "an operation retry must not add the selected resource twice");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkStorageBatchCharacterization();
  console.log("FBL Skyhold storage batch: catalog add, partial moves, stale guard, item quantity and idempotency passed.");
}
