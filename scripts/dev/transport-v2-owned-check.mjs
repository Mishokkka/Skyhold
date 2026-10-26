import assert from "node:assert/strict";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { planTransportChain } from "../engines/transport/planner.js";
import { bookTransportOrder, resolveTransportIncident } from "../engines/transport/runtime.js";
import { startTransportShip, advanceTransportShipments } from "../workflows/transport/orders.js";

const { data, holding, ship } = worldMarketFixture();
const state = data.meta.transportV2 = { version: 2, enabled: true, clockQd: 0, runs: [] };
const cargo = [{ lotId: "cloth", resourceId: "test-freight", qty: 10, unitLoad: 4000, unitCopper: 5, ageQd: 0 }];
const services = [
  { id: "first", from: "a", to: "b", kind: "regular", capacity: 400000, firstQd: 4, intervalQd: 4, travelQd: 4, dispatchCopper: 10, riskBps: 10000 },
  { id: "own", from: "b", to: "home", shipId: ship.id, kind: "owned", capacity: 400000, travelQd: 12, returnQd: 12,
    approachQd: 12, approachCopper: 12, abortReturnQd: 12, endReturnQd: 0, endReturnLocation: "home", returnAtEnd: true,
    operatingMilliCopperPerQd: 1000, returnOperatingMilliCopperPerQd: 1000, waitingMilliCopperPerQd: 1000, vehicles: 1 }
];
const plan = planTransportChain({ cargo, services });
const beforeCash = holding.storage.moneyCopper;
const order = bookTransportOrder({ state, holding, plan, services, id: "abort-own", direction: "inbound", commercial: { reserveCopper: 100 }, ship });
startTransportShip(data, holding, order);
const workflow = { _appendStorageLog() {}, _storageAddWithOverflow() { throw new Error("Lost cargo must not reach storage"); } };
advanceTransportShipments(data, holding, 8, workflow);
resolveTransportIncident(state, order.stages[0].runs[0].id, { outcome: "loss", lossBps: 10000 });
advanceTransportShipments(data, holding, 8, workflow);
assert.equal(order.status, "lost");
assert.ok(order.shipAbort);
assert.equal(order.shipAbort.releaseQd, 24, "empty approach and return still take physical time");
assert.equal(ship.transportOrderId, order.id);
advanceTransportShipments(data, holding, 24, workflow);
assert.equal(ship.transportOrderId, undefined, "a lost order must not strand its reserved ship");
assert.equal(ship.location.kind, "home");
assert.equal(order.money.escrowCopper, 0);
assert.equal(ship.lastOuting.expenseCopper, 24);
assert.equal(holding.storage.moneyCopper, beforeCash - 50 - 10 - 24);

const delayed = worldMarketFixture();
const delayState = delayed.data.meta.transportV2 = { version: 2, enabled: true, clockQd: 0, runs: [] };
const direct = [{ ...services[1], id: "direct", shipId: delayed.ship.id, from: "a", to: "home", riskBps: 10000,
  approachQd: 4, approachCopper: 4, abortReturnQd: 4, travelQd: 4 }];
const directPlan = planTransportChain({ cargo, services: direct });
const delayedOrder = bookTransportOrder({ state: delayState, holding: delayed.holding, plan: directPlan, services: direct,
  id: "delay-own", direction: "inbound", ship: delayed.ship });
startTransportShip(delayed.data, delayed.holding, delayedOrder);
const receiving = { _appendStorageLog() {}, _storageAddWithOverflow() {} };
advanceTransportShipments(delayed.data, delayed.holding, 8, receiving);
resolveTransportIncident(delayState, delayedOrder.stages[0].runs[0].id, { outcome: "delay", delayQd: 4 });
advanceTransportShipments(delayed.data, delayed.holding, 12, receiving);
assert.equal(delayedOrder.fundingNeededCopper, 4);
assert.ok(delayed.ship.transportOrderId, "unpaid additional costs remain visible and keep the ship assigned");
assert.equal(delayed.ship.location.kind, "home", "unpaid adjustment cannot defer physical arrival");
delayed.ship.portBilling.dailyCopper = 4;
const cashAtArrival = delayed.holding.storage.moneyCopper;
const idle = advanceTransportShipments(delayed.data, delayed.holding, 20, receiving);
assert.equal(delayed.holding.storage.moneyCopper, cashAtArrival - 8, "idle upkeep continues while the operating adjustment awaits payment");
assert.equal(idle.entries.filter((entry) => entry.kind === "expense" && entry.roomId === "treasury").reduce((sum, entry) => sum + entry.qty, 0), -8);
delayed.holding.storage.moneyCopper -= 4;
delayedOrder.money.escrowCopper += 4; delayedOrder.money.reserveCopper += 4; delayedOrder.money.treasuryCopper += 4;
advanceTransportShipments(delayed.data, delayed.holding, 20, receiving);
assert.equal(delayed.ship.transportOrderId, undefined);
assert.equal(delayed.ship.lastOuting.expenseCopper, 12);
assert.equal(delayedOrder.money.escrowCopper, 0);
assert.equal(delayed.holding.storage.moneyCopper, cashAtArrival - 12, "funding and idle expenses are each charged exactly once");
const funded = worldMarketFixture();
funded.ship.onboardCopper = 100;
const fundedState = funded.data.meta.transportV2 = { version: 2, enabled: true, clockQd: 0, runs: [] };
const fundedServices = direct.map((service) => ({ ...service, shipId: funded.ship.id }));
const fundedPlan = planTransportChain({ cargo, services: fundedServices });
const initialTreasury = funded.holding.storage.moneyCopper;
const fundedOrder = bookTransportOrder({ state: fundedState, holding: funded.holding, plan: fundedPlan,
  services: fundedServices, id: "free-board", direction: "inbound", ship: funded.ship });
startTransportShip(funded.data, funded.holding, fundedOrder);
advanceTransportShipments(funded.data, funded.holding, 8, receiving);
resolveTransportIncident(fundedState, fundedOrder.stages[0].runs[0].id, { outcome: "delay", delayQd: 4 });
advanceTransportShipments(funded.data, funded.holding, 12, receiving);
assert.equal(fundedOrder.fundingNeededCopper, undefined, "free board money pays an adjustment before asking the treasury");
assert.equal(funded.ship.lastOuting.expenseCopper, 12);
assert.equal(funded.holding.storage.moneyCopper, initialTreasury - 50 + 88);
console.log("transport-v2 owned incidents: lost upstream cargo returns an empty ship, exact cash conservation and explicit funding of delay expenses passed");
