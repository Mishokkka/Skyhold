import assert from "node:assert/strict";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { planTransportChain } from "../engines/transport/planner.js";
import { bookTransportOrder } from "../engines/transport/runtime.js";
import { advanceTransportShipments } from "../workflows/transport/orders.js";
import { beginResourceBatchPeriod, finishResourceBatchPeriod, takeResourceBatches, reservedResourceBatchQuantities } from "../core/resource-batches.js";
import { SkyholdWorkflowService } from "../workflows/skyhold-workflow-service.js";
import { SkyholdData } from "../data/store.js";

const state = { version: 2, enabled: true, clockQd: 0, runs: [] };
const services = [{ id: "slow", from: "A", to: "B", kind: "regular", capacity: 400000, travelQd: 4, firstQd: 80, intervalQd: 40, dispatchCopper: 10 }];
const holding = { id: "test", storage: { moneyCopper: 1000, resources: [{ id: "r1", resourceId: "food", qty: 20,
  batches: [{ id: "b1", qty: 20, ageQd: 0 }] }], log: [] }, special: {}, gm: { calendaria: { lastQd: 0 } } };
const cargo = [{ lotId: "food-lot", resourceId: "food", rowId: "r1", batchId: "b1", qty: 10, ageQd: 0, shelfLifeQd: 20, unitCopper: 5, unitLoad: 4000 }];
const plan = planTransportChain({ cargo, services });
const order = bookTransportOrder({ state, holding, services, plan, id: "spoiling", direction: "outbound" });
const taken = takeResourceBatches(holding.storage.resources[0], 20, { holding });
assert.equal(taken.takenQty ?? taken.qty, 10, "food/production can consume only the unreserved half");
beginResourceBatchPeriod(holding);
finishResourceBatchPeriod(holding, { elapsedQd: 40, shelfLifeQdForRow: () => 20 });
assert.equal(holding.storage.resources[0].qty, 0);
assert.equal(order.sourceSpoiledPending["food-lot"], 10);
assert.equal(reservedResourceBatchQuantities(holding, { id: "r1" }).size, 0);
order.demandReservations = [];
order.commercial.insuranceCoverageBps = 8400;
holding.gm.calendaria.lastQd = 40;
advanceTransportShipments({ meta: { transportV2: state } }, holding, 100, { _appendStorageLog() {} });
assert.equal(order.status, "lost");
assert.equal(order.spoiledQty, 10);
assert.equal(order.insurancePaidCopper, 0);

globalThis.game = { user: { id: "gm", isGM: true }, settings: { get: () => undefined }, modules: new Map(), users: [], time: { worldTime: 0 } };
const world = worldMarketFixture();
world.data.meta.transportV2 = { version: 2, enabled: true, clockQd: 0, runs: [] };
world.holding.special.ships.list = [];
world.holding.people.list = [];
const fast = [{ ...services[0], firstQd: 4 }];
const purchased = [{ ...cargo[0], resourceId: "wood", shelfLifeQd: 0, qty: 10, name: "Wood" }];
const purchasedPlan = planTransportChain({ cargo: purchased, services: fast });
bookTransportOrder({ state: world.data.meta.transportV2, holding: world.holding, services: fast, plan: purchasedPlan,
  id: "period-purchase", direction: "inbound", commercial: { targetRoomId: "outdoors" } });
const before = structuredClone(world.data);
const workflow = new SkyholdWorkflowService();
const prepared = await workflow._prepareTendayOperation({ holdingId: world.holding.id, dataView: world.data,
  operationId: "period-preview", preparedAt: "2026-10-26T00:00:00.000Z" });
assert.equal(prepared.ok, true, prepared.message);
assert.deepEqual(world.data, before, "preview must not mutate the original holdings or shared reservations");
assert.equal(prepared.preparedHolding.special.transportV2.orders[0].status, "delivered");
assert.equal(prepared.preparedHolding.storage.resources.find((row) => row.resourceId === "wood").batches[0].ageQd, 40,
  "arrival during a period includes subsequent warehouse age, exactly once");
assert.equal(prepared.preparedHolding.storage.log.filter((row) => row.kind === "transport-purchase").length, 1,
  "the period ledger must not duplicate the transport storage log");
assert.equal(prepared.preparedSharedTransport.clockQd, 40);
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };
let committed = structuredClone(before);
const skipped = Symbol("skip");
SkyholdData.view = () => committed;
SkyholdData.skipTransaction = (value) => ({ [skipped]: true, value });
SkyholdData.updateHolding = async (id, updater) => {
  const draft = structuredClone(committed), result = await updater(draft.holdings.find((row) => row.id === id), draft);
  if (result?.[skipped]) return result.value;
  draft.meta.revision++; committed = draft; return result;
};
workflow._postTendaySummaryChat = async () => {};
workflow.requestRender = () => {};
assert.equal((await workflow._applyPreparedTendayOperation(prepared)).ok, true);
assert.equal(committed.meta.transportV2.clockQd, 40);
assert.equal(committed.holdings[0].special.transportV2.orders[0].status, "delivered");
const after = structuredClone(committed);
assert.equal((await workflow._applyPreparedTendayOperation(prepared)).replay, true);
assert.deepEqual(committed, after);
const next = await workflow._prepareTendayOperation({ holdingId: world.holding.id, dataView: committed,
  operationId: "next-preview", pendingEventsCollected: true });
committed.meta.transportV2.clockQd++;
assert.equal((await workflow._applyPreparedTendayOperation(next)).stale, true, "a changed shared transport clock invalidates a prepared period");
const multiple = await workflow._prepareTendayOperation({ holdingId: world.holding.id, qd: 80, dataView: after,
  operationId: "multiple-preview", pendingEventsCollected: true });
assert.equal(multiple.ok, true, multiple.message);
assert.equal(multiple.preparedSharedTransport.clockQd, 120, "sequential periods propagate their shared draft");
console.log("transport-v2 period: reserved consumption, real warehouse expiry, no spoilage insurance and isolated actual tenday preview passed");
