import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { FinanceDomain } from "../apps/domains/finance-domain.js";
import { normalizeResourceRow, resourceUnitLoad } from "../core/resources.js";
import { BASE_HOLDING } from "../data/schema/base-holding.js";
import { normalizeStorageItemRow, normalizeStorageLogRow } from "../data/normalizers/storage.js";
import { applyPlayerPatch, buildPlayerPatch, validatePlayerPatch } from "../data/player-write-guard.js";
import { clone } from "../data/utils.js";
import {
  buildStorageRooms,
  storageFillClass,
  storageRoomLabelFromRooms,
  storageRoomOptionsFromRooms,
  storageRoomsContext,
  storageRowLoad,
  storageUnitLoad
} from "../engines/storage/capacity.js";
import { moveStorageResource } from "../engines/storage/move.js";
import { payStorageCosts } from "../engines/storage/payment.js";
import { planStorageCosts } from "../engines/storage/group-payment.js";
import { addStorageWithOverflow } from "../engines/storage/placement.js";

function makeHolding() {
  const holding = clone(BASE_HOLDING);
  holding.id = "storage-characterization";
  holding.name = "Тестовый склад";
  holding.visibility = "public";
  holding.buildings.list = [];
  holding.storage.resources = [];
  holding.storage.items = [];
  holding.storage.moneyCopper = 0;
  holding.storage.log = [];
  holding.gm.playersCanUseStorage = true;
  holding.gm.calendaria.lastDateText = "Тестовая дата";
  return holding;
}

function storageBuilding(id, capacity, extra = {}) {
  return {
    id,
    name: extra.name ?? id,
    constructionStatus: extra.constructionStatus ?? "built",
    status: extra.status ?? "Построено",
    img: extra.img ?? "",
    icon: extra.icon ?? "fa-solid fa-warehouse",
    functions: { storage: true },
    storage: {
      capacity,
      security: extra.security ?? 0,
      quality: extra.quality ?? 0,
      notes: extra.notes ?? ""
    }
  };
}

function resource(id, resourceId, qty, roomId = "outdoors", extra = {}) {
  return {
    id,
    resourceId,
    name: extra.name ?? resourceId,
    qty,
    unit: extra.unit ?? "ед.",
    roomId,
    ...extra
  };
}

function createStorageHarness() {
  return {
    ...FinanceDomain,

    _safeNumber(value, fallback = 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    },

    _buildingStatus(building = {}) {
      const raw = String(building.constructionStatus ?? building.status ?? "built").toLowerCase();
      if (raw === "built" || raw === "построено") return { value: "built", label: "Построено", css: "built" };
      if (raw === "paused") return { value: "paused", label: "Приостановлено", css: "paused" };
      return { value: raw || "building", label: "Строится", css: "building" };
    },

    _buildingFunctions(building = {}) {
      return {
        production: Boolean(building.functions?.production),
        income: Boolean(building.functions?.income),
        defense: Boolean(building.functions?.defense),
        housing: Boolean(building.functions?.housing),
        storage: Boolean(building.functions?.storage),
        culture: Boolean(building.functions?.culture)
      };
    }
  };
}

function quantityInRoom(holding, resourceId, roomId) {
  return (holding.storage.resources ?? [])
    .filter((row) => row.resourceId === resourceId && row.roomId === roomId)
    .reduce((sum, row) => sum + Number(row.qty ?? 0), 0);
}

function storageResourceState(holding) {
  return (holding?.storage?.resources ?? []).map(({ id: _id, ...row }) => ({
    ...row,
    ...(Array.isArray(row.batches) ? { batches: row.batches.map(({ id: _batchId, ...batch }) => batch) } : {})
  }));
}

function storageLogState(holding) {
  return (holding?.storage?.log ?? []).map(({ id: _id, ts: _ts, ...row }) => row);
}

/** Verifies storage quantities, room allocation and append-only player patches through real storage-domain methods. */
export function checkStorageCharacterization() {
  const storage = createStorageHarness();
  const woodLoad = resourceUnitLoad("wood");
  const grainLoad = resourceUnitLoad("grain");
  const stoneLoad = resourceUnitLoad("stone");

  assert.equal(storageUnitLoad({ weight: "light" }), 0.5, "light storage rows must weigh half a load unit");
  assert.equal(storageUnitLoad({ itemData: { system: { weight: "heavy" } } }), 2, "nested Foundry item weight must be recognized");
  assert.equal(storageUnitLoad({ load: -3 }), 0, "negative explicit load must be clamped to zero");
  assert.equal(storageRowLoad({ qty: 3, weight: "heavy" }), 6, "row load must multiply non-negative quantity by unit load");
  assert.equal(storageRowLoad({ qty: -5, weight: 2 }), 0, "negative row quantities must not produce negative used capacity");
  assert.equal(storageRowLoad({ qty: 1.8, weight: "normal" }), 1, "capacity must ignore a fractional legacy remainder instead of creating load from it");
  assert.equal(normalizeResourceRow({ resourceId: "wood", qty: 1.8 }).qty, 1, "resource storage normalization must floor positive quantities");
  assert.equal(normalizeStorageItemRow({ id: "fractional-item", qty: 1.8 })?.qty, 1, "item storage normalization must floor positive quantities");
  assert.equal(normalizeStorageLogRow({ id: "fractional-log", qty: -1.8 })?.qty, -1, "signed storage logs must truncate toward zero");
  assert.equal(storage._storageUnitLoad({ resourceId: "wood", name: "Wood", load: 99, weight: 99 }), woodLoad, "known resources must ignore stale row load and weight");
  assert.equal(storage._storageRowLoad({ resourceId: "wood", qty: 1.8 }), woodLoad, "catalog-aware storage capacity must floor row quantities before applying unit load");
  assert.equal(storage._storageUnitLoad({ resourceId: "custom", name: "Неизвестный ресурс", load: 0, weight: 0 }), 1, "custom resources must use the one-load default");
  assert.equal(storage._storageUnitLoad({ itemData: { system: { weight: "heavy" } } }), 2, "stored items must retain the Foundry weight parser");
  assert.equal(storageFillClass({ capacity: 10, used: 7.5 }), "near-capacity", "75% room usage must enter near-capacity state");
  assert.equal(storageFillClass({ capacity: 10, used: 10 }), "full-capacity", "full rooms must enter full-capacity state");

  {
    const holding = makeHolding();
    storage._storageAdd(holding, { resourceId: "wood", roomId: "outdoors" }, 1.8);
    storage._appendStorageLog(holding, [{ kind: "manual-add", resourceId: "wood", qty: 1.8 }]);
    storage._appendStorageLog(holding, [{ kind: "manual-spend", resourceId: "wood", qty: -1.8 }]);
    assert.equal(quantityInRoom(holding, "wood", "outdoors"), 1, "runtime storage additions must floor positive fractional quantities");
    assert.deepEqual(holding.storage.log.map((row) => row.qty), [1, -1], "runtime storage logs must truncate signed quantities toward zero");
    assert.equal(holding.storage.resources.every((row) => Number.isInteger(row.qty)), true, "runtime resource storage must contain whole quantities only");
  }

  {
    const holding = makeHolding();
    const expectedUsed = (3 * woodLoad) + (2 * grainLoad) + 2;
    const capacity = expectedUsed + 1;
    holding.buildings.list = [storageBuilding("warehouse", capacity, { name: "Склад", img: "icons/warehouse.webp", icon: "fa-solid fa-boxes-stacked" })];
    holding.storage.resources = [
      resource("wood", "wood", 3, "warehouse", { load: 99, weight: 99 }),
      resource("grain", "grain", 2, "warehouse", { load: 99, weight: 99 })
    ];
    holding.storage.items = [{
      id: "item",
      name: "Тяжёлый предмет",
      qty: 1,
      roomId: "warehouse",
      itemData: { system: { weight: "heavy", quantity: 1 } }
    }];
    const directRooms = buildStorageRooms({
      holding: clone(holding),
      dependencies: storage._storageCapacityDependencies()
    });
    const wrappedRooms = storage._storageRooms(clone(holding));
    assert.deepEqual(wrappedRooms, directRooms, "storage room wrapper must preserve the pure capacity engine result");
    assert.deepEqual(
      storage._storageRoomOptionsFromRooms(wrappedRooms, "warehouse"),
      storageRoomOptionsFromRooms(directRooms, "warehouse"),
      "storage room options wrapper must preserve the pure capacity helper"
    );
    assert.equal(
      storage._storageRoomLabelFromRooms(wrappedRooms, "warehouse"),
      storageRoomLabelFromRooms(directRooms, "warehouse"),
      "storage room label wrapper must preserve the pure capacity helper"
    );
    assert.deepEqual(
      storage._storageRoomsContext(holding, wrappedRooms),
      storageRoomsContext(directRooms),
      "storage room context wrapper must preserve the pure capacity helper"
    );
    const room = wrappedRooms.find((row) => row.id === "warehouse");
    assert.equal(room.used, expectedUsed, "room capacity must combine canonical resource loads with stored item weights");
    assert.equal(room.free, 1, "room free capacity must be derived from total used load");
    assert.equal(room.fillPercent, Math.round((expectedUsed / capacity) * 100), "room fill percentage must be rounded from canonical used load");
    assert.equal(room.fillClass, "near-capacity", "a nearly full room must be marked near capacity");
    assert.equal(room.img, "icons/warehouse.webp", "storage room navigation must reuse its building image");
    assert.equal(room.icon, "fa-solid fa-boxes-stacked", "storage room navigation must retain the building icon as fallback");

    holding.finance.buildingStates.warehouse = { mothballed: true };
    const mothballedRoom = storage._storageRooms(holding).find((row) => row.id === "warehouse");
    assert.equal(mothballedRoom.available, true, "mothballing must preserve the building's physical storage capacity");
    assert.equal(mothballedRoom.profileEffectFactor, 0, "mothballing must disable specialized storage advantages");
    assert.equal(storage._storageRoomOptions(holding, "outdoors").some((option) => option.value === "warehouse"), true, "placement options must retain a mothballed physical store");
  }

  {
    const baseHolding = makeHolding();
    const capacity = (3 * stoneLoad) + (2 * woodLoad);
    baseHolding.buildings.list = [storageBuilding("warehouse", capacity, { name: "Склад" })];
    baseHolding.storage.resources = [resource("existing", "stone", 3, "warehouse", { load: 99, weight: 99 })];
    const directHolding = clone(baseHolding);
    const wrappedHolding = clone(baseHolding);
    const addition = {
      resourceId: "wood",
      name: "Wood",
      roomId: "warehouse",
      load: 99,
      weight: 99
    };
    const directPlacements = addStorageWithOverflow({
      holding: directHolding,
      resource: addition,
      qty: 4,
      dependencies: storage._storagePlacementDependencies()
    });
    const wrappedPlacements = storage._storageAddWithOverflow(wrappedHolding, addition, 4);
    assert.deepEqual(wrappedPlacements, directPlacements, "storage placement wrapper must preserve the pure add-with-overflow operation");
    assert.deepEqual(storageResourceState(wrappedHolding), storageResourceState(directHolding), "storage placement wrapper must preserve storage mutations");
    assert.deepEqual(wrappedPlacements, [
      { roomId: "warehouse", qty: 2, overflowFrom: "" },
      { roomId: "outdoors", qty: 2, overflowFrom: "warehouse" }
    ], "add-with-overflow must fill the target room before using outdoors");
    assert.equal(quantityInRoom(wrappedHolding, "wood", "warehouse"), 2, "fitting output must remain in the requested room");
    assert.equal(quantityInRoom(wrappedHolding, "wood", "outdoors"), 2, "overflow output must be moved outdoors");

    const unavailableHolding = makeHolding();
    unavailableHolding.buildings.list = [storageBuilding("warehouse", 5, { constructionStatus: "paused" })];
    const unavailablePlacements = storage._storageAddWithOverflow(unavailableHolding, addition, 2);
    assert.deepEqual(unavailablePlacements, [
      { roomId: "outdoors", qty: 2, overflowFrom: "warehouse" }
    ], "an unavailable target room must redirect the full addition outdoors");

    const staleLoadHolding = makeHolding();
    staleLoadHolding.buildings.list = [storageBuilding("warehouse", 2 * woodLoad)];
    const staleLoadPlacements = storage._storageAddWithOverflow(staleLoadHolding, { ...addition, load: 0, weight: 0 }, 20);
    assert.deepEqual(staleLoadPlacements, [
      { roomId: "warehouse", qty: 2, overflowFrom: "" },
      { roomId: "outdoors", qty: 18, overflowFrom: "warehouse" }
    ], "resource overflow must use canonical catalog load instead of stale origin weight");
    assert.equal(
      staleLoadHolding.storage.resources.some((row) => Object.hasOwn(row, "load") || Object.hasOwn(row, "weight")),
      false,
      "storage resource rows must not materialize origin load or weight"
    );
  }

  {
    const baseHolding = makeHolding();
    baseHolding.buildings.list = [storageBuilding("warehouse", (3 * woodLoad) + 1, { name: "Склад" })];
    baseHolding.storage.resources = [resource("wood", "wood", 5, "outdoors", { name: "Wood", weight: 1 })];
    const directHolding = clone(baseHolding);
    const wrappedHolding = clone(baseHolding);
    const move = {
      resourceId: "wood",
      name: "Wood",
      qty: 3,
      fromRoomId: "outdoors",
      toRoomId: "warehouse",
      note: "перенос"
    };
    const directResult = moveStorageResource({
      holding: directHolding,
      ...move,
      dependencies: storage._storageMoveDependencies()
    });
    const wrappedResult = storage._applyStorageMove(wrappedHolding, move);
    assert.deepEqual(wrappedResult, directResult, "storage move wrapper must preserve the pure move operation result");
    assert.deepEqual(storageResourceState(wrappedHolding), storageResourceState(directHolding), "storage move wrapper must preserve resource mutations");
    assert.deepEqual(storageLogState(wrappedHolding), storageLogState(directHolding), "storage move wrapper must preserve both journal sides");
    assert.equal(wrappedResult.ok, true, "a valid storage move must succeed");
    assert.equal(quantityInRoom(wrappedHolding, "wood", "outdoors"), 2, "a move must subtract quantity from the source room");
    assert.equal(quantityInRoom(wrappedHolding, "wood", "warehouse"), 3, "a move must add quantity to the target room");
    assert.deepEqual(wrappedHolding.storage.log.map((row) => row.kind), ["move-out", "move-in"], "a move must preserve both journal sides");

    const beforeRejected = clone(wrappedHolding.storage);
    const rejected = storage._applyStorageMove(wrappedHolding, {
      resourceId: "wood",
      name: "Wood",
      qty: 9,
      fromRoomId: "outdoors",
      toRoomId: "warehouse"
    });
    assert.equal(rejected.ok, false, "a move larger than the source quantity must be rejected");
    assert.deepEqual(wrappedHolding.storage, beforeRejected, "a rejected move must not mutate storage or append journal entries");

    const sameRoomHolding = clone(baseHolding);
    const sameRoom = storage._applyStorageMove(sameRoomHolding, { ...move, toRoomId: "outdoors" });
    assert.equal(sameRoom.ok, false, "a move must reject identical source and target rooms");
    assert.deepEqual(sameRoomHolding.storage, baseHolding.storage, "same-room rejection must be atomic");

    const moneyHolding = clone(baseHolding);
    const moneyMove = storage._applyStorageMove(moneyHolding, { ...move, resourceId: "money", name: "Деньги" });
    assert.equal(moneyMove.ok, false, "money must not use resource room movement");
    assert.deepEqual(moneyHolding.storage, baseHolding.storage, "money move rejection must be atomic");
  }

  {
    const holding = makeHolding();
    holding.storage.resources = [resource("wood", "wood", 5, "outdoors", { name: "Wood" })];
    const rejected = storage._applyManualStorageChange(holding, {
      resourceId: "wood",
      name: "Wood",
      qty: -6,
      kind: "manual-spend",
      roomId: "outdoors"
    });
    assert.equal(rejected.ok, false, "manual storage spending must reject an overdraft");
    assert.equal(quantityInRoom(holding, "wood", "outdoors"), 5, "rejected manual spending must preserve quantity");
    assert.equal(holding.storage.log.length, 0, "rejected manual spending must not append a journal entry");

    storage._storageAdd(holding, { resourceId: "wood", name: "Wood", roomId: "outdoors" }, -99);
    assert.equal(quantityInRoom(holding, "wood", "outdoors"), 0, "the shared storage mutation must clamp quantities at zero");
  }

  {
    const holding = makeHolding();
    const added = storage._applyManualStorageChange(holding, {
      resourceId: "money",
      name: "Деньги",
      qty: 150,
      kind: "income"
    });
    assert.equal(added.ok, true, "money may be added through the shared manual storage operation");
    assert.equal(holding.storage.moneyCopper, 150, "money additions must update moneyCopper");

    const spent = storage._applyManualStorageChange(holding, {
      resourceId: "money",
      name: "Деньги",
      qty: -40,
      kind: "expense"
    });
    assert.equal(spent.ok, true, "affordable money spending must succeed");
    assert.equal(holding.storage.moneyCopper, 110, "money spending must subtract copper without changing denominations");

    const overdraft = storage._applyManualStorageChange(holding, {
      resourceId: "money",
      name: "Деньги",
      qty: -200,
      kind: "expense"
    });
    assert.equal(overdraft.ok, false, "money spending must reject an overdraft");
    assert.equal(holding.storage.moneyCopper, 110, "rejected money spending must preserve the treasury");
    assert.deepEqual(holding.storage.log.map((row) => row.qty), [150, -40], "successful money adjustments must be journaled with signed quantities");
  }

  {
    const baseHolding = makeHolding();
    baseHolding.storage.moneyCopper = 120;
    baseHolding.storage.resources = [
      resource("wood-outdoors", "wood", 2, "outdoors", { name: "Wood" }),
      resource("wood-warehouse", "wood", 4, "warehouse", { name: "Wood" }),
      resource("stone-outdoors", "stone", 3, "outdoors", { name: "Stone" }),
      resource("stone-warehouse", "stone", 3, "warehouse", { name: "Stone" })
    ];
    const costs = [
      { resourceId: "wood", name: "Wood", qty: 5 },
      { resourceId: "stone", name: "Stone", qty: 2, roomId: "warehouse" },
      { resourceId: "money", name: "Деньги", qty: 50 }
    ];
    const directCanPay = planStorageCosts({
      holding: clone(baseHolding),
      costs,
      dependencies: storage._storageCostPlanningDependencies()
    });
    const wrappedCanPay = storage._storageCanPay(clone(baseHolding), costs);
    assert.deepEqual(wrappedCanPay, directCanPay, "storage can-pay wrapper must preserve the pure concrete payment plan");
    assert.equal(wrappedCanPay.ok, true, "combined room resources and treasury must satisfy affordable costs");
    assert.deepEqual(wrappedCanPay.missing, []);

    const directHolding = clone(baseHolding);
    const wrappedHolding = clone(baseHolding);
    const directResult = payStorageCosts({
      holding: directHolding,
      costs: directCanPay.costs,
      dependencies: storage._storagePaymentDependencies()
    });
    const wrappedResult = storage._storagePay(wrappedHolding, costs);
    assert.equal(directResult, undefined, "pure exact payment remains a mutating operation");
    assert.equal(wrappedResult.ok, true, "storage pay wrapper must return the applied concrete payment plan");
    assert.deepEqual(storageResourceState(wrappedHolding), storageResourceState(directHolding), "storage pay wrapper must preserve resource deductions");
    assert.equal(wrappedHolding.storage.moneyCopper, directHolding.storage.moneyCopper, "storage pay wrapper must preserve treasury deductions");
    assert.equal(quantityInRoom(wrappedHolding, "wood", "outdoors"), 0, "roomless payment must consume earlier matching rows first");
    assert.equal(quantityInRoom(wrappedHolding, "wood", "warehouse"), 1, "roomless payment must continue into later matching rooms");
    assert.equal(quantityInRoom(wrappedHolding, "stone", "outdoors"), 3, "room-specific payment must preserve other rooms");
    assert.equal(quantityInRoom(wrappedHolding, "stone", "warehouse"), 1, "room-specific payment must deduct only the selected room");
    assert.equal(wrappedHolding.storage.moneyCopper, 70, "money payment must deduct copper through the treasury adapter");

    const insufficient = storage._storageCanPay(baseHolding, [
      { resourceId: "wood", name: "Wood", qty: 7 },
      { resourceId: "money", name: "Деньги", qty: 121 }
    ]);
    assert.equal(insufficient.ok, false, "can-pay must reject insufficient combined resources or treasury");
    assert.deepEqual(insufficient.missing.map((cost) => cost.have), [6, 120], "can-pay must report the available amount for every missing cost");
    assert.deepEqual(baseHolding.storage.resources.map((row) => row.qty), [2, 4, 3, 3], "can-pay must remain read-only");
    assert.equal(baseHolding.storage.moneyCopper, 120, "can-pay must not mutate treasury");
  }

  {
    const holding = makeHolding();
    storage._appendStorageLog(holding, [
      { kind: "manual-add", resourceId: "wood", name: "Wood", qty: 2, roomId: "outdoors", source: "Тест", note: "запись" },
      { kind: "manual-add", resourceId: "wood", name: "Wood", qty: 0, roomId: "outdoors", source: "Тест" },
      { kind: "note", resourceId: "custom", name: "Проверка", qty: 0, source: "Тест", note: "служебная запись" }
    ]);
    assert.equal(holding.storage.log.length, 2, "storage journal must skip zero-quantity operations except explicit notes");
    assert.equal(holding.storage.log[0].laputaDateText, "Тестовая дата", "storage journal must preserve the holding calendar date");
    assert.equal(Number.isNaN(Date.parse(holding.storage.log[0].ts)), false, "storage journal entries must receive a serializable timestamp");

    for (let index = 0; index < 260; index += 1) {
      storage._appendStorageLog(holding, [{ kind: "manual-add", resourceId: "wood", name: "Wood", qty: 1, source: `Тест ${index}` }]);
    }
    assert.equal(holding.storage.log.length, 250, "storage journal must retain only the newest 250 entries");
    assert.equal(holding.storage.log.at(-1).source, "Тест 259", "storage journal truncation must preserve the newest entry");
  }

  {
    const current = {
      meta: { revision: 7 },
      holdings: [makeHolding()],
      catalog: { buildings: [], resources: [] }
    };
    current.holdings[0].storage.resources = [resource("wood", "wood", 5, "outdoors", { name: "Wood" })];
    current.holdings[0].storage.log = [{
      id: "log-before",
      kind: "manual-add",
      resourceId: "wood",
      name: "Wood",
      qty: 5,
      roomId: "outdoors",
      source: "Тест"
    }];

    const notesProposal = clone(current);
    notesProposal.holdings[0].storage.notes = "Игрок уточнил назначение склада";
    const notesPatch = buildPlayerPatch(current, notesProposal);
    assert.equal(notesPatch.action, "storage", "a player storage note must retain the narrow storage action");
    assert.equal(validatePlayerPatch(current, notesPatch, "player").ok, true, "the generic guard may accept storage notes when the holding permission allows them");

    const proposed = clone(current);
    proposed.holdings[0].storage.resources[0].qty = 3;
    proposed.holdings[0].storage.log.push({
      id: "log-after",
      kind: "manual-spend",
      resourceId: "wood",
      name: "Wood",
      qty: -2,
      roomId: "outdoors",
      source: "Игрок"
    });
    const patch = buildPlayerPatch(current, proposed);
    assert.equal(validatePlayerPatch(current, patch, "player").ok, false, "resource and journal mutations must use a dedicated authority-GM operation, never a generic player patch");
    const applied = applyPlayerPatch(current, patch);
    assert.equal(applied.holdings[0].storage.resources[0].qty, 3, "the low-level patch helper remains deterministic even though authorization rejects this patch");
    assert.equal(current.holdings[0].storage.resources[0].qty, 5, "the low-level patch helper must not mutate the canonical input object");

    const money = clone(current);
    money.holdings[0].storage.moneyCopper += 100;
    assert.equal(validatePlayerPatch(current, buildPlayerPatch(current, money), "player").ok, false, "generic player patches must not mint or spend treasury money");

    current.holdings[0].storage.items = [{ id: "stored-item", name: "Меч", qty: 1 }];
    const item = clone(current);
    item.holdings[0].storage.items[0].qty = 2;
    assert.equal(validatePlayerPatch(current, buildPlayerPatch(current, item), "player").ok, false, "generic player patches must not change stored item quantities");

    const forbiddenCurrent = clone(current);
    forbiddenCurrent.holdings[0].gm.playersCanUseStorage = false;
    assert.equal(validatePlayerPatch(forbiddenCurrent, patch, "player").ok, false, "storage writes must respect the holding permission flag");

    const negative = clone(current);
    negative.holdings[0].storage.resources[0].qty = -1;
    assert.equal(validatePlayerPatch(current, buildPlayerPatch(current, negative), "player").ok, false, "the player write guard must reject negative resource quantities");

    const rewritten = clone(current);
    rewritten.holdings[0].storage.log[0].note = "подмена";
    assert.equal(validatePlayerPatch(current, buildPlayerPatch(current, rewritten), "player").ok, false, "the player write guard must enforce append-only storage history");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkStorageCharacterization();
  console.log("FBL Skyhold storage characterization passed.");
}
