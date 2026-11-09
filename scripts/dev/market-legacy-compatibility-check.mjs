import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { appendHoldingOperation } from "../data/operations.js";
import { createMarketOperationExecutor } from "../apps/market-operation-executor.js";
import { transportFixture } from "./fixtures/transport-v2.mjs";
import { harness } from "./fixtures/transport-tenday.mjs";

// Historical data stays readable without retaining the retired execution engine.
const futureTerms = { version: 99, key: "future-contract", terms: { original: true } };
const item = { id: "saved-item", itemUuid: "Compendium.world.goods.Item.saved", name: "Saved item",
  itemData: { name: "Saved item", img: "icons/svg/item-bag.svg", type: "equipment", system: { quantity: 2 } } };
const holding = mergeHoldingDefaults({ id: "legacy", visibility: "public", gm: { playersCanUseStorage: true },
  storage: { moneyCopper: 1234, log: [{ id: "saved-log", kind: "market-purchase", resourceId: "money", qty: -90,
    source: "Original market", operationId: "saved-purchase" }] },
  special: { market: {
    orders: [{ id: "saved-purchase", operationId: "saved-purchase", status: "delivered", deliveryMode: "scheduled",
      marketId: "market-location:a", marketLabel: "Original market", totalCopper: 90, transportPlan: futureTerms,
      cargo: [{ sourceType: "item", resourceId: "custom", name: "Saved item", qty: 2, unitPriceCopper: 40, ageQd: 7, item }] }],
    outbound: { orders: [{ id: "saved-sale", status: "delivered", marketId: "market-location:a", marketLabel: "Original market",
      revenueCopper: 80, transportPlan: futureTerms,
      cargoReservations: [{ resourceId: "wood", rowId: "row", batchId: "batch", qty: 4, ageQd: 13 }] }] }
  } } });
const loaded = mergeHoldingDefaults(JSON.parse(JSON.stringify(holding)));
assert.deepEqual(loaded.special.market.orders[0].transportPlan, futureTerms);
assert.deepEqual(loaded.special.market.outbound.orders[0].transportPlan, futureTerms);
assert.equal(loaded.special.market.orders[0].cargo[0].item.itemUuid, item.itemUuid);
assert.deepEqual(loaded.special.market.orders[0].cargo[0].item.itemData, item.itemData);
assert.equal(loaded.special.market.orders[0].totalCopper, 90);
assert.equal(loaded.special.market.outbound.orders[0].revenueCopper, 80);
assert.equal(loaded.special.market.outbound.orders[0].cargoReservations[0].ageQd, 13);
assert.equal(loaded.storage.moneyCopper, 1234);
assert.equal(loaded.storage.log[0].operationId, "saved-purchase");
assert.equal(loaded.storage.log[0].source, "Original market");
assert.deepEqual(mergeHoldingDefaults(JSON.parse(JSON.stringify(loaded))), loaded, "reading historical data remains stable without migration or execution");

// Read the actual storage view, including parent, arrival and sale IDs used by the removed executor.
{
  const f = transportFixture(); f.data.holdings = [structuredClone(loaded)];
  f.data.catalog.eventRegions.find(row => row.value === "a").countryId = "hidden";
  const h = harness(f.data), historical = h.holding(loaded.id), purchase = historical.special.market.orders[0];
  Object.assign(purchase, { id: "saved-purchase:0", operationId: "saved-purchase:0", parentOperationId: "saved-purchase",
    deliveryOperationId: "saved-purchase:0:arrival" });
  historical.special.market.outbound.orders[0].revenueOperationId = "saved-sale:revenue";
  historical.storage.log.push(
    { id: "arrival", kind: "market-arrival", resourceId: "wood", qty: 2, source: "Original market", operationId: purchase.deliveryOperationId },
    { id: "revenue", kind: "market-outbound-revenue", resourceId: "money", qty: 80, source: "Original market", operationId: "saved-sale:revenue" },
    { id: "unknown", kind: "market-purchase", resourceId: "money", qty: -1, source: "Pruned historical market", operationId: "pruned-order" },
    { id: "manual", kind: "manual-add", resourceId: "wood", qty: 1, source: "Manual visible label" });
  const before = structuredClone(h.data);
  for (const isGM of [true, false]) {
    game.user = { id: isGM ? "gm" : "player", isGM };
    h.workflow._contextData = h.data; h.workflow.activeStorageTab = "log";
    const rows = h.workflow._storageContext(historical, false).logRows;
    assert.equal(rows.some(row => row.source === "Original market"), isGM,
      "ordinary player storage history must also mask saved legacy market labels");
    assert.equal(rows.find(row => row.id === "unknown").source, isGM ? "Pruned historical market" : "Внешний рынок");
    assert.equal(rows.find(row => row.id === "manual").source, "Manual visible label");
    assert.equal(rows.find(row => row.id === "revenue").qty, 80);
  }
  assert.deepEqual(h.data, before, "legacy visibility is a read-only projection");
  delete purchase.deliveryOperationId;
  delete historical.special.market.outbound.orders[0].revenueOperationId;
  game.user = { id: "player", isGM: false };
  assert.ok(h.workflow._storageContext(historical, false).logRows.filter(row => ["arrival", "revenue"].includes(row.id))
    .every(row => row.source === "Скрытый рынок"), "older derived event IDs also retain market privacy");
  h.data.catalog.eventRegions.find(row => row.value === "a").countryId = "public";
  const publicBefore = structuredClone(h.data);
  assert.ok(h.workflow._storageContext(historical, false).logRows.some(row => row.source === "Original market"),
    "a public historical market keeps its actual display name");
  assert.deepEqual(h.data, publicBefore);
  game.user = { id: "gm", isGM: true };
}

const users = [{ id: "gm", isGM: true }, { id: "player", isGM: false }, { id: "stranger", isGM: false }];
for (const user of users.slice(0, 2)) for (const type of ["purchase", "outbound"]) {
  const data = { meta: { revision: 100 }, holdings: [structuredClone(loaded)] }, current = data.holdings[0];
  const op = { type, operationId: `saved-${type}-${user.id}`, holdingId: current.id, expectedRevision: 3,
    sourceToken: "saved-source", planToken: "saved-plan", marketId: "market-location:a", carrierId: "", ownShipId: "",
    targetRoomId: "outdoors", serviceLevel: "standard", quantities: { wood: 2 }, insuranceEnabled: true };
  appendHoldingOperation(current, { type: type === "purchase" ? "market-purchase" : "market-outbound", operationId: op.operationId,
    payload: { signature: JSON.stringify(op), userId: user.id, orderId: "saved-order", totalCopper: 90 } });
  const execute = createMarketOperationExecutor({ getData: () => data, getUser: id => users.find(row => row.id === id) });
  const context = { userId: user.id, remote: !user.isGM }, before = structuredClone(data);
  const replay = await execute(op, context);
  assert.equal(replay.ok, true); assert.equal(replay.replay, true); assert.equal(replay.orderId, "saved-order");
  assert.deepEqual(data, before, "historical retries cannot spend money, restore stock or create a commit");
  assert.equal((await createMarketOperationExecutor({ getData: () => data, getUser: () => user })(op, context)).replay, true,
    "a restarted executor reads the same durable historical receipt");
  await assert.rejects(execute({ ...op, quantities: { wood: 3 } }, context), error => error.code === "conflict");
  await assert.rejects(execute(op, { userId: "stranger", remote: true }), error => error.code === "conflict");
  await assert.rejects(execute({ ...op, operationId: "new-retired-order" }, context), error => error.code === "conflict",
    "the retired command cannot create another shipment");
  if (!user.isGM) {
    current.gm.playersCanUseStorage = false;
    const revoked = structuredClone(data);
    await assert.rejects(execute(op, context), error => error.code === "forbidden");
    assert.deepEqual(data, revoked, "revoked access also protects historical receipts");
    current.gm.playersCanUseStorage = true;
  } else await assert.rejects(execute(op, { userId: user.id, remote: true }), error => error.code === "forbidden");
  assert.deepEqual(data, before, "invalid and obsolete commands leave the entire data snapshot unchanged");
}

for (const file of ["../engines/market/shipment.js", "../engines/market/shipment-schedule.js", "../engines/market/delivery.js",
  "../engines/market/purchase-payment.js", "../workflows/market/outbound-shipment.js", "../apps/market/shipment-list.js",
  "../apps/market/shipment-context.js", "../apps/market/purchase-cost-presentation.js", "../apps/market/transport-picker.js",
  "./fixtures/legacy-market-executor.mjs"]) assert.equal(existsSync(new URL(file, import.meta.url)), false,
  "retired transport implementation must not return as production code or a copied test executor: " + file);

console.log("Historical market compatibility: saved Item/cargo/billing/unknown metadata, stable normalization, actual GM/player replay, permission revocation, obsolete creation refusal and retired-code absence passed.");
