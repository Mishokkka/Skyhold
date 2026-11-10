import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { cargoShelfLife, cargoDeliveryQuantity } from "../engines/market/cargo-aging.js";
import { planTransportChain } from "../engines/transport/planner.js";
import { advanceTransportOrders, bookTransportOrder, resolveTransportIncident } from "../engines/transport/runtime.js";

export function checkMarketCargoAging() {
  function voyage(shelfLifeQd = 20, riskBps = 0) {
    const holding = { id: "aging", storage: { moneyCopper: 5000 }, special: { transportV2: { version: 2, orders: [] } } };
    const state = { version: 2, clockQd: 0, runs: [] }, received = [];
    const cargo = [{ lotId: "food", resourceId: "custom-food", name: "Food", qty: 5, unitCopper: 10, unitLoad: 4000, ageQd: 3, shelfLifeQd }];
    const service = { id: "aging-flight", kind: "charter", from: "market", to: "home", vehicles: 1,
      capacity: 20000, loadingQd: 0, unloadingQd: 0, travelQd: 8, returnQd: 0, riskBps };
    const order = bookTransportOrder({ state, holding, id: "aging-order", direction: "inbound", services: [service],
      plan: planTransportChain({ cargo, services: [service] }), commercial: { insuranceCoverageBps: 10000 } });
    const advance = targetQd => advanceTransportOrders({ state, holding, targetQd,
      dependencies: { receiveCargo(_order, lots) { received.push(...lots); } } });
    return { state, holding, order, received, advance };
  }
  const one = voyage(), split = voyage();
  one.advance(12);
  for (let qd = 0; qd <= 12; qd++) split.advance(qd);
  assert.deepEqual(one.received, split.received, "physical arrival age does not depend on the processing interval");
  assert.equal(one.received[0].ageQd, 11, "cargo includes its existing age and actual time to arrival");
  assert.equal(one.received[0].qty, 5); assert.equal(one.order.status, "delivered");
  const once = structuredClone(one.received); one.advance(40);
  assert.deepEqual(one.received, once, "a finished order cannot deliver cargo a second time");
  const expired = voyage(10); expired.advance(40);
  assert.equal(expired.order.status, "lost"); assert.equal(expired.order.spoiledQty, 5);
  assert.equal(expired.order.lostQty, 0); assert.equal(expired.order.insurancePaidCopper, 0);
  assert.deepEqual(expired.received, [], "natural expiry cannot become cargo delivery or insured loss");
  const delayed = voyage(12, 10000); delayed.advance(8);
  const run = delayed.state.runs[0]; assert.equal(run.incident.status, "pending");
  resolveTransportIncident(delayed.state, run.id, { outcome: "delay", delayQd: 4, atQd: 8 });
  delayed.advance(12);
  assert.equal(delayed.order.spoiledQty, 5); assert.equal(delayed.order.insurancePaidCopper, 0);
  assert.deepEqual(delayed.received, [], "actual delay ages cargo rather than increasing its insured value");

  assert.equal(cargoShelfLife({ resourceId: "wood", shelfLifeQd: 12 }), 12);
  assert.equal(cargoDeliveryQuantity({ qty: 5, ageQd: 11, shelfLifeQd: 12 }), 5);
  assert.equal(cargoDeliveryQuantity({ qty: 5, ageQd: 12, shelfLifeQd: 12 }), 0);
  assert.equal(cargoDeliveryQuantity({ qty: 5, ageQd: 1000, shelfLifeQd: 0 }), 5);
  assert.equal(cargoDeliveryQuantity({ qty: 5, spoiledQty: 2, ageQd: 1, shelfLifeQd: 12 }), 3);
  assert.equal(cargoShelfLife({ sourceType: "item", shelfLifeQd: 12 }), 0, "Item snapshots retain their existing separate storage contract");
  console.log("Market cargo aging: current transport arrival/replay, single/split processing, expiry, actual incident delay, uninsured spoilage and shared shelf-life helpers passed.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) checkMarketCargoAging();
