import assert from "node:assert/strict";
import { ensureTransportState, pruneCompletedTransportRuns } from "../data/transport/state.js";
import { planTransportChain } from "../engines/transport/planner.js";
import { bookTransportOrder, advanceTransportOrders } from "../engines/transport/runtime.js";
import { advanceTransportShipments } from "../workflows/transport/orders.js";

const holding = id => ({ id, storage: { moneyCopper: 100000, resources: [], log: [] }, gm: { calendaria: { lastQd: 0 } }, special: {} });
const cargo = [{ lotId: "wood", resourceId: "wood", qty: 1, unitLoad: 4000, unitCopper: 1 }];
const service = { id: "shared", from: "a", to: "b", kind: "regular", capacity: 40000, firstQd: 0, intervalQd: 4, travelQd: 2 };
const workflow = { _storageAddWithOverflow() { return []; }, _appendStorageLog() {} };
function book(data, h, id, services = [service]) {
  const state = ensureTransportState(data);
  return bookTransportOrder({ state, holding: h, id, direction: "inbound", services,
    plan: planTransportChain({ cargo, services, runs: state.runs, startQd: state.clockQd }) });
}
{
  const a = holding("a"), b = holding("b"), data = { holdings: [a, b], meta: {} };
  const one = book(data, a, "one"), two = book(data, b, "two");
  advanceTransportShipments(data, a, 2, workflow);
  assert.equal(one.status, "delivered"); assert.equal(data.meta.transportV2.runs.length, 1, "lagging claim retains physical run");
  advanceTransportShipments(data, b, 2, workflow);
  assert.equal(two.status, "delivered"); assert.equal(data.meta.transportV2.runs.length, 0);
  assert.equal(two.stages[0].receipts[0].arrivalQd, 2, "order history survives cleanup");
  const before = structuredClone(data); advanceTransportShipments(data, b, 2, workflow); assert.deepEqual(data, before);
}
{
  const h = holding("history"), data = { holdings: [h], meta: {} };
  for (let i = 0; i < 100; i++) {
    const order = book(data, h, `order-${i}`);
    advanceTransportShipments(data, h, order.plan.arrivalQd, workflow);
    assert.equal(order.status, "delivered"); assert.equal(data.meta.transportV2.runs.length, 0);
  }
  assert.equal(h.special.transportV2.orders.length, 100);
}
{
  const a = holding("a"), b = holding("b"), data = { holdings: [a, b], meta: {} };
  const carrier = { ...service, kind: "charter", vehicles: 1, returnQd: 8 };
  const one = book(data, a, "one", [carrier]), two = book(data, b, "two", [carrier]);
  const state = data.meta.transportV2, physical = state.runs[0];
  advanceTransportOrders({ state, holding: a, targetQd: 2, dependencies: { receiveCargo() {} } });
  // An actual incident can extend return beyond a later order's original start.
  physical.releaseQd = 18; state.clockQd = 40; two.lastProcessedQd = 40;
  pruneCompletedTransportRuns(data); assert.ok(state.runs.includes(physical), "old return needed by finite vehicle rebooking");
  two.status = "delivered"; physical.releaseQd = 10;
  one.ownShipId = "ship"; one.shipReleased = true;
  pruneCompletedTransportRuns(data); assert.ok(state.runs.includes(physical), "unreconciled cost needs physical schedule");
  one.shipCostsReconciled = true; one.fundingNeededCopper = 1;
  pruneCompletedTransportRuns(data); assert.ok(state.runs.includes(physical), "unpaid obligation must remain");
  one.fundingNeededCopper = 0; one.shipReleased = false;
  pruneCompletedTransportRuns(data); assert.ok(state.runs.includes(physical), "owned ship not released");
  one.shipReleased = true;
  pruneCompletedTransportRuns(data); assert.ok(!state.runs.includes(physical));
  assert.equal(state.runs.length, 1, "a booked physical run is never pruned just by a claim's terminal status");
}
console.log("Transport retention: shared lagging claims, finite returns, owned reconciliation, replay and 100 completed orders passed.");
