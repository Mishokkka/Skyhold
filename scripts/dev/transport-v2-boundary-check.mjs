import assert from "node:assert/strict";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { planTransportChain } from "../engines/transport/planner.js";
import { bookTransportOrder, resolveTransportIncident } from "../engines/transport/runtime.js";
import { transportServicesFromRoutes } from "../engines/transport/services.js";
import { startTransportShip, advanceTransportShipments } from "../workflows/transport/orders.js";
import { buildShipWorldContext, worldShipTransportTerms } from "../engines/ships/world-market.js";
import { normalizeSkyholdData } from "../data/normalizers.js";
import { ensureTransportState } from "../data/transport/state.js";
import { appendHoldingOperation } from "../data/operations.js";
import { createMarketOperationExecutor } from "../apps/market-operation-executor.js";

const world = worldMarketFixture(), { data, holding, ship } = world;
const normalized = normalizeSkyholdData(data);
assert.equal(normalized.meta.transportV2.version, 2, "transport is available immediately after loading");
assert.equal(Object.hasOwn(normalized.meta.transportV2, "enabled"), false, "there is no activation or opt-out flag");
assert.equal(data.meta.transportV2, undefined, "normalization does not write back to the input or world");
const disabled = structuredClone(normalized);
disabled.meta.transportV2.enabled = false;
assert.equal(Object.hasOwn(normalizeSkyholdData(disabled).meta.transportV2, "enabled"), false,
  "a saved experimental switch cannot disable the sole transport runtime");
const archived = worldMarketFixture();
archived.holding.gm.playersCanUseStorage = true; archived.holding.visibility = "public";
const legacy = { type: "purchase", operationId: "legacy-receipt", holdingId: archived.holding.id,
  expectedRevision: 1, sourceToken: "old-source", planToken: "old-plan", marketId: "a", carrierId: "auto-carriers",
  ownShipId: "", targetRoomId: "outdoors", serviceLevel: "standard", quantities: { cloth: 1 }, insuranceEnabled: true };
const retired = createMarketOperationExecutor({ getData: () => archived.data,
  getUser: id => ({ id, isGM: id === "gm" }) });
const unchanged = structuredClone(archived.data);
for (const userId of ["gm", "player"]) {
  await assert.rejects(retired(legacy, { userId, remote: userId === "player" }), error => error.code === "conflict");
  assert.deepEqual(archived.data, unchanged, "retired checkout cannot spend money, reserve stock or write data");
}
appendHoldingOperation(archived.holding, { type: "market-purchase", operationId: legacy.operationId,
  payload: { signature: JSON.stringify(legacy), userId: "gm", orderId: "old-order" } });
assert.equal((await retired(legacy, { userId: "gm" })).replay, true, "a committed historical receipt remains replayable");
await assert.rejects(retired(legacy, { userId: "player", remote: true }), error => error.code === "conflict");
await assert.rejects(retired({ ...legacy, quantities: { cloth: 2 } }, { userId: "gm" }), error => error.code === "conflict");
archived.holding.gm.playersCanUseStorage = false;
await assert.rejects(retired(legacy, { userId: "player", remote: true }), error => error.code === "forbidden");
assert.equal(ensureTransportState(archived.data).version, 2);
const state = data.meta.transportV2 = { version: 2, clockQd: 0, runs: [] };
const cargo = [{ lotId: "cloth", qty: 20, unitLoad: 4000, unitCopper: 5, resourceId: "test-freight", ageQd: 0 }];
const services = [
  { id: "feeder", kind: "regular", from: "a", to: "b", capacity: 80000, travelQd: 4, firstQd: 4, intervalQd: 4, dispatchCopper: 10, riskBps: 10000 },
  { id: "own", kind: "owned", shipId: ship.id, from: "b", to: "home", capacity: 40000, travelQd: 4, returnQd: 4,
    vehicles: 1, operatingMilliCopperPerQd: 1000, waitingMilliCopperPerQd: 0 }
];
const plan = planTransportChain({ cargo, services });
assert.equal(plan.stages[1].runs.length, 2);
const before = holding.storage.moneyCopper;
const order = bookTransportOrder({ state, holding, cargo, plan, services, id: "partial-owned", direction: "inbound", ship });
startTransportShip(data, holding, order);
const received = [];
const workflow = { _appendStorageLog() {}, _storageAddWithOverflow(_holding, lot, qty) { received.push({ ...lot, qty }); } };
advanceTransportShipments(data, holding, 8, workflow);
resolveTransportIncident(state, order.stages[0].runs[0].id, { outcome: "loss", lossBps: 5000 });
advanceTransportShipments(data, holding, 12, workflow);
assert.equal(order.received.reduce((sum, lot) => sum + lot.qty, 0), 10);
assert.equal(order.stages[1].runs.length, 1, "partial loss repacks the downstream stage");
assert.equal(ship.lastOuting.expenseCopper, 4, "removed own shuttle is refunded rather than charged as if it sailed");
assert.equal(holding.storage.moneyCopper, before - 100 - 10 - 4);
assert.equal(order.money.escrowCopper, 0);

const itemWorld = worldMarketFixture();
itemWorld.data.meta.transportV2 = { version: 2, clockQd: 0, runs: [] };
const itemServices = [{ ...services[0], capacity: 8000, riskBps: 0 }];
const items = [{ ...cargo[0], qty: 3, sourceType: "item", item: { id: "snapshot", name: "Tool", itemData: { system: { quantity: 3 } } } }];
const itemPlan = planTransportChain({ cargo: items, services: itemServices });
bookTransportOrder({ state: itemWorld.data.meta.transportV2, holding: itemWorld.holding, plan: itemPlan,
  services: itemServices, id: "item-split", direction: "inbound", commercial: { targetRoomId: "outdoors" } });
advanceTransportShipments(itemWorld.data, itemWorld.holding, itemPlan.arrivalQd, { ...workflow,
  _setItemQuantityData(item, qty) { item.system.quantity = qty; return item; } });
assert.deepEqual(itemWorld.holding.storage.items.map((item) => item.qty), [2, 1]);
assert.deepEqual(itemWorld.holding.storage.items.map((item) => item.itemData.system.quantity), [2, 1]);
assert.equal(new Set(itemWorld.holding.storage.items.map((item) => item.id)).size, 2);

const leg = { fromRegionId: "a", toRegionId: "b", fromCountryId: "country", mode: "airship", carrierId: "carrier", routeId: "r",
  capacityLoad: 100, movementQd: 0.9, distanceKm: 90, distanceCopper: 90, operatingCopper: 9,
  loadCopperPerUnit: 0.9, dispatchCopper: 10, hireCopper: 10 };
const route = (legs) => ({ transportPlan: { direction: "inbound", legs } });
const direct = transportServicesFromRoutes([route([leg])]);
const halves = transportServicesFromRoutes([route([{ ...leg, toRegionId: "transit", movementQd: 0.45, distanceKm: 45,
  distanceCopper: 45, operatingCopper: 4.5, loadCopperPerUnit: 0.45 }, { ...leg, fromRegionId: "transit", movementQd: 0.45,
  distanceKm: 45, distanceCopper: 45, operatingCopper: 4.5, loadCopperPerUnit: 0.45 }])]);
for (const index of [0, 1]) {
  assert.equal(halves[index].travelQd, direct[index].travelQd, "transit node must not add another rounded travel interval");
  assert.equal(planTransportChain({ cargo, services: [halves[index]] }).totalCopper, planTransportChain({ cargo, services: [direct[index]] }).totalCopper);
}
const seasonal = worldMarketFixture();
seasonal.data.catalog.eventRegions[0].marketLinks[0].seasonalModifiers = { winter: { enabled: true, timeFactor: 2, costFactor: 1, riskFactor: 1 } };
const context = buildShipWorldContext(seasonal.data, seasonal.holding);
const normal = worldShipTransportTerms(seasonal.data, seasonal.holding, seasonal.ship, "home", "a", { context });
context.seasonId = "winter";
const winter = worldShipTransportTerms(seasonal.data, seasonal.holding, seasonal.ship, "home", "a", { context });
assert.equal(winter.durationQd, normal.durationQd * 2, "owned transport uses the route's actual seasonal time factor");
console.log("transport-v2 boundaries: automatic transport model, partial-loss repacking/refund, split Item snapshots, transit rounding and seasonal own travel passed");
