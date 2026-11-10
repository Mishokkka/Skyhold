import assert from "node:assert/strict";
import { planTransportChain } from "../engines/transport/planner.js";
import { bookTransportOrder, advanceTransportOrders, resolveTransportIncident } from "../engines/transport/runtime.js";
import { transportFixture, transportRequest, transportHarness } from "./fixtures/transport-v2.mjs";
import { prepareTransportContext } from "../apps/domains/transport-context.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { startTransportShip, advanceTransportShipments } from "../workflows/transport/orders.js";

const cargo = shelfLifeQd => [{ lotId: "food", resourceId: "grain", qty: 20, unitLoad: 1, unitCopper: 5, ageQd: 0, shelfLifeQd }];
const first = { id: "early-first", kind: "regular", from: "A", to: "B", capacity: 10, travelQd: 4,
  loadingQd: 1, unloadingQd: 1, intervalQd: 40, firstQd: 0, dispatchCopper: 1, riskBps: 0, storageIncluded: true };
const second = { ...first, id: "early-second", from: "B", to: "C", intervalQd: 10 };
function booked({ shelfLifeQd = 0, direction = "inbound", services = [first, second] } = {}) {
  const state = { version: 2, clockQd: 0, runs: [] }, holding = { id: "holding", storage: { moneyCopper: 10000 }, special: {} };
  const plan = planTransportChain({ cargo: cargo(shelfLifeQd), services });
  bookTransportOrder({ state, holding, plan, services, id: "early-order", direction });
  let stock = direction === "outbound" ? 20 : 0, sold = 0;
  const dependencies = {
    dispatchCargo(_order, lots) { stock -= lots.reduce((sum, lot) => sum + lot.qty, 0); assert.ok(stock >= 0); },
    receiveCargo(_order, lots) {
      const qty = lots.reduce((sum, lot) => sum + lot.qty, 0);
      if (direction === "outbound") { sold += qty; holding.storage.moneyCopper += qty * 5; } else stock += qty;
    }
  };
  return { state, holding, plan, get order() { return holding.special.transportV2.orders[0]; },
    advance: targetQd => advanceTransportOrders({ state, holding, targetQd, dependencies }),
    get stock() { return stock; }, get sold() { return sold; } };
}

for (const direction of ["inbound", "outbound"]) {
  const h = booked({ shelfLifeQd: 90, direction });
  assert.deepEqual(h.plan.stages[0].runs.map(run => run.arrivalQd), [45, 85]);
  assert.deepEqual(h.plan.stages[1].runs.map(run => run.arrivalQd), [55, 95]);
  const accepted = JSON.stringify(h.order.plan);
  h.advance(55);
  assert.equal(h.order.stages[0].status, "booked", "the upstream stage is still awaiting its second part");
  assert.equal(h.order.received.reduce((sum, lot) => sum + lot.qty, 0), 10, "the ready part arrives before the last upstream part");
  assert.equal(direction === "inbound" ? h.stock : h.sold, 10);
  h.advance(200);
  assert.equal(h.order.status, "delivered");
  assert.equal(h.order.spoiledQty, 10);
  assert.equal(h.order.received.reduce((sum, lot) => sum + lot.qty, 0), 10);
  assert.equal(JSON.stringify(h.order.plan), accepted, "accepted prices and estimates remain frozen");
  const saved = JSON.stringify({ holding: h.holding, state: h.state });
  h.advance(200);
  assert.equal(JSON.stringify({ holding: h.holding, state: h.state }), saved, "replay cannot duplicate a receipt, sale, loss or refund");

  const once = booked({ shelfLifeQd: 90, direction });
  once.advance(200);
  assert.equal(once.holding.storage.moneyCopper, h.holding.storage.moneyCopper);
  assert.equal(once.order.spoiledQty, h.order.spoiledQty);
  assert.deepEqual(once.order.received, h.order.received, "one long step and incremental execution preserve the same cargo ages");
}
{
  const h = booked({ services: [first, { ...second, capacity: 20, intervalQd: 100 }] });
  assert.equal(h.plan.stages[1].runs.length, 1, "arrivals ready before loading share one physical departure");
  assert.equal(h.plan.stages[1].runs[0].cargo[0].qty, 20);
  h.advance(200);
  assert.equal(h.stock, 20);
}
for (const outcome of ["loss", "delay"]) {
  const h = booked({ services: [{ ...first, riskBps: 10000 }, second] });
  h.advance(85);
  const [early, late] = h.order.stages[0].runs.map(run => h.state.runs.find(row => row.id === run.id));
  assert.equal(early.incident.status, "pending");
  assert.equal(late.incident.status, "pending");
  resolveTransportIncident(h.state, late.id, { outcome: "success" });
  h.advance(95);
  assert.equal(h.stock, 10, "a ready later part moves while a different upstream part still awaits the GM");
  assert.equal(h.order.status, "needsResolution");
  resolveTransportIncident(h.state, early.id, { outcome, lossBps: 10000, delayQd: 4 });
  h.advance(200);
  assert.equal(h.stock, outcome === "loss" ? 10 : 20);
  assert.equal(h.order.lostQty, outcome === "loss" ? 10 : 0);
  assert.equal(h.order.status, "delivered");
}
{
  const third = { ...second, id: "early-third", from: "C", to: "D" };
  const h = booked({ services: [{ ...first, riskBps: 10000 }, second, third] });
  h.advance(200);
  for (const run of h.state.runs.filter(row => row.incident?.status === "pending")) resolveTransportIncident(h.state, run.id, { outcome: "success" });
  const blockerHolding = { id: "blocker", storage: { moneyCopper: 10000 }, special: {} };
  const blockerCargo = [{ lotId: "blocker", qty: 1430, unitLoad: 1, unitCopper: 1 }];
  bookTransportOrder({ state: h.state, holding: blockerHolding, services: [second],
    plan: planTransportChain({ cargo: blockerCargo, services: [second], startQd: 204, runs: h.state.runs }),
    id: "blocker", direction: "inbound" });
  const tailIds = h.order.stages[2].runs.map(run => run.id);
  h.advance(210);
  assert.equal(h.order.replanFailure.stage, 1);
  assert.ok(tailIds.every(id => h.state.runs.find(run => run.id === id)?.claims.some(claim => claim.orderId === h.order.id)),
    "failed upstream replanning cannot erase downstream promises");
  const waits = h.order.history.filter(row => row.kind === "rebooking-wait").length;
  h.advance(210);
  assert.equal(h.order.history.filter(row => row.kind === "rebooking-wait").length, waits,
    "another stage cannot clear the failure and duplicate its retry history");
}
{
  const service = { ...first, kind: "owned", shipId: "ship", vehicles: 1, intervalQd: undefined, returnQd: 4 };
  const plan = planTransportChain({ cargo: cargo(0), services: [service, { ...service, id: "owned-next", from: "B", to: "C" }] });
  assert.ok(plan.stages[1].runs[0].startQd >= Math.max(...plan.stages[0].runs.map(run => run.releaseQd)),
    "one owned vessel completes its shuttles before continuing to the next owned leg");
  const preceded = planTransportChain({ cargo: cargo(0), services: [{ ...first, from: "X", to: "A" },
    service, { ...service, id: "owned-next", from: "B", to: "C" }] });
  assert.ok(preceded.stages[1].runs[0].startQd >= preceded.stages[0].completedQd,
    "a continuous multi-leg owned block starts with its whole feeder consignment");
}
{
  const f = transportFixture(), state = f.data.meta.transportV2, initial = f.holding.storage.moneyCopper;
  const feeder = { ...first, from: "home", to: "a", riskBps: 10000 };
  const own = { ...second, id: "truncated-own", kind: "owned", shipId: f.ship.id, from: "a", to: "b",
    returnQd: 4, endReturnQd: 8, abortReturnQd: 6, endReturnLocation: "home", returnAtEnd: true,
    approachQd: 2, approachCopper: 2, operatingMilliCopperPerQd: 1000, returnOperatingMilliCopperPerQd: 1000,
    startIdleUpkeepCopperPerDay: 4, idleUpkeepCopperPerDay: 4, waitingMilliCopperPerQd: 1000 };
  const plan = planTransportChain({ cargo: cargo(0), services: [feeder, own] });
  const order = bookTransportOrder({ state, holding: f.holding, plan, services: [feeder, own], id: "truncated-return",
    direction: "inbound", ship: f.ship, commercial: { reserveCopper: 1000 } });
  startTransportShip(f.data, f.holding, order);
  const workflow = { _appendStorageLog() {}, _storageAddWithOverflow() {} };
  const advance = targetQd => advanceTransportShipments(f.data, f.holding, targetQd, workflow);
  advance(45);
  resolveTransportIncident(state, order.stages[0].runs[0].id, { outcome: "success" });
  advance(55); advance(85);
  resolveTransportIncident(state, order.stages[0].runs[1].id, { outcome: "loss", lossBps: 10000 });
  advance(85);
  assert.equal(order.shipAbort.location, "home");
  assert.equal(order.shipAbort.releaseQd, 91, "after a truncated shuttle the ship returns from its actual pickup port");
  advance(91);
  assert.equal(f.ship.location.kind, "home"); assert.equal(order.shipReleased, true);
  assert.equal(order.received.reduce((sum, lot) => sum + lot.qty, 0), 10); assert.equal(order.lostQty, 10);
  assert.equal(initial - f.holding.storage.moneyCopper - f.ship.onboardCopper - order.money.escrowCopper,
    order.money.commercialSpentCopper + order.money.spentCopper, "the extra physical return is paid exactly once");
}
{
  const f = transportFixture(), state = f.data.meta.transportV2;
  const feeder = { ...first, from: "home", to: "a", riskBps: 10000 };
  const own = { ...second, id: "waiting-own", kind: "owned", shipId: f.ship.id, from: "a", to: "b",
    returnQd: 4, endReturnQd: 8, abortReturnQd: 6, endReturnLocation: "home", returnAtEnd: true,
    approachQd: 2, approachCopper: 2 };
  const plan = planTransportChain({ cargo: cargo(0), services: [feeder, own] });
  const order = bookTransportOrder({ state, holding: f.holding, plan, services: [feeder, own], id: "waiting-return",
    direction: "inbound", ship: f.ship });
  const advance = targetQd => advanceTransportOrders({ state, holding: f.holding, targetQd,
    dependencies: { receiveCargo() {} } });
  advance(85);
  const [early, late] = order.stages[0].runs;
  resolveTransportIncident(state, late.id, { outcome: "success" });
  advance(100);
  assert.equal(order.stages[1].receipts.length, 0,
    "a later ready load cannot bypass this vessel's unresolved earlier shuttle and return home");
  assert.ok(order.stages[1].runs.every(run => state.runs.some(physical => physical.id === run.id)),
    "unknown feeder cargo retains the vessel's pickup and final-return reservations");
  resolveTransportIncident(state, early.id, { outcome: "success" });
  advance(200);
  assert.equal(order.received.reduce((sum, lot) => sum + lot.qty, 0), 20);
  const actual = order.stages[1].runs;
  assert.equal(actual[0].releaseLocation, "a", "the first loaded shuttle returns for the other load");
  assert.equal(actual.at(-1).releaseLocation, "home");
  assert.ok(actual[1].startQd >= actual[0].releaseQd);
}
{
  // A persisted pre-streaming agreement retains its later accepted departures.
  const h = booked();
  for (const [index, arrivalQd] of [95, 105].entries()) {
    const runtime = h.order.stages[1].runs[index], accepted = h.order.plan.stages[1].runs[index];
    const physical = h.state.runs.find(run => run.id === runtime.id);
    const timing = { id: `early-second:regular:${arrivalQd - 5}`, startQd: arrivalQd - 6,
      departureQd: arrivalQd - 5, arrivalQd, releaseQd: arrivalQd };
    Object.assign(runtime, timing); Object.assign(accepted, timing); Object.assign(physical, timing);
  }
  h.order.plan.stages[1].readyQd = 85; h.order.plan.stages[1].completedQd = 105;
  h.order.plan.firstArrivalQd = 95; h.order.plan.arrivalQd = 105;
  h.holding.special.transportV2.orders[0] = JSON.parse(JSON.stringify(h.order));
  const frozen = JSON.stringify(h.order.plan);
  h.advance(55); assert.equal(h.stock, 0);
  h.advance(110); assert.equal(h.stock, 20);
  assert.equal(JSON.stringify(h.order.plan), frozen);
  assert.ok(!h.order.history.some(row => row.kind === "rebooked"), "old on-time reservations are not accelerated on loading");
}
for (const isGM of [true, false]) for (const direction of ["inbound", "outbound"]) {
  const f = transportFixture();
  for (const region of f.data.catalog.eventRegions) region.marketTransportModes = ["airship", "caravan"];
  f.data.catalog.eventRegions.find(row => row.value === "a").marketLinks[0].modes = ["caravan"];
  const request = transportRequest(f, "b", { direction }, isGM);
  for (const id of Object.keys(request.quantities)) request.quantities[id] = 20;
  const initial = prepareTransportContext({ ...f, request, isGM });
  assert.equal(initial.plan.stages.length, 2);
  request.pins = {};
  f.data.catalog.transportV2.overrides = {};
  for (const [index, stage] of initial.plan.stages.entries()) {
    const service = initial.services.find(row => row.kind === "regular" && row.from === stage.from && row.to === stage.to);
    assert.ok(service);
    request.pins[service.from] = service.id;
    f.data.catalog.transportV2.overrides[service.id] = { capacity: 40000, loadingQd: 1, unloadingQd: 1,
      travelQd: 4, intervalQd: index ? 10 : 40, firstQd: 0 };
  }
  const h = transportHarness(f), id = `early-authority-${direction}-${isGM}`;
  const { operation } = await h.book(request, id, isGM);
  h.advance(55);
  let order = h.holding.special.transportV2.orders.find(row => row.id === id);
  assert.equal(order.received.reduce((sum, lot) => sum + lot.qty, 0), 10);
  h.data.holdings[0] = mergeHoldingDefaults(JSON.parse(JSON.stringify(h.holding)));
  const before = JSON.stringify(h.data);
  assert.equal((await h.execute(operation, { userId: isGM ? "gm" : "player", remote: !isGM })).replay, true);
  assert.equal(JSON.stringify(h.data), before);
  h.advance(110);
  order = h.holding.special.transportV2.orders.find(row => row.id === id);
  assert.equal(order.received.reduce((sum, lot) => sum + lot.qty, 0), 20);
  assert.equal(order.status, "delivered");
}
// Independent clock/stock oracle: arrivals occur before the loading work at the same quarter-day.
for (let seed = 1; seed <= 30; seed++) {
  const quantity = 1 + seed % 17;
  const services = Array.from({ length: 3 }, (_, index) => ({ ...first, id: `oracle-${index}`,
    from: String(index), to: String(index + 1), capacity: 1 + (seed + index) % 5,
    intervalQd: 2 + (seed * (index + 1)) % 6, firstQd: index + 1, travelQd: 1 + (seed + index) % 4 }));
  const plan = planTransportChain({ cargo: [{ lotId: "oracle", qty: quantity, unitLoad: 1, unitCopper: 1 }], services });
  const stock = [quantity, 0, 0, 0], events = [], expected = services.map(() => []);
  for (let clock = 0; clock <= plan.arrivalQd; clock++) {
    for (const event of events.filter(row => row.at === clock)) stock[event.node] += event.qty;
    for (const [index, service] of services.entries()) {
      const departure = clock + service.loadingQd;
      if (departure < service.firstQd || (departure - service.firstQd) % service.intervalQd || !stock[index]) continue;
      const qty = Math.min(service.capacity, stock[index]); stock[index] -= qty;
      const arrival = departure + service.travelQd + service.unloadingQd;
      events.push({ at: arrival, node: index + 1, qty }); expected[index].push({ departure, arrival, qty });
    }
  }
  assert.equal(stock[3], quantity);
  assert.deepEqual(plan.stages.map(stage => stage.runs.map(run => ({ departure: run.departureQd, arrival: run.arrivalQd,
    qty: run.cargo.reduce((sum, lot) => sum + lot.qty, 0) }))), expected, `independent pipeline timetable ${seed}`);
}
console.log("Early transport parts: physical arrivals, finite slots, independent incidents, age/spoilage, import/export, frozen terms, replay and time-step equivalence passed.");
