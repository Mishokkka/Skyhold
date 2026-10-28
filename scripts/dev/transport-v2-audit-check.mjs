import assert from "node:assert/strict";
import { planTransportChain } from "../engines/transport/planner.js";
import { bookTransportOrder, advanceTransportOrders, resolveTransportIncident } from "../engines/transport/runtime.js";
import { prepareOwnedTransportAbort } from "../engines/transport/owned-costs.js";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { prepareTransportContext } from "../apps/domains/transport-context.js";
import { prepareMarketAuthorityContext } from "../apps/market/authority-context.js";
import { startTransportShip, advanceTransportShipments } from "../workflows/transport/orders.js";
import { advanceWorldShips } from "../engines/ships/world-voyage.js";
import { ensureTransportState } from "../data/transport/state.js";

const failures = [];
function check(name, test) {
  try { test(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
const lot = (lotId, qty) => ({ lotId, resourceId: "wood", qty, unitLoad: 4000, unitCopper: 1, ageQd: 0 });
const service = (extra = {}) => ({ id: "first", from: "A", to: "B", kind: "regular", capacity: 40000,
  firstQd: 4, intervalQd: 40, travelQd: 4, dispatchCopper: 1, riskBps: 10000, ...extra });
function fixture(cargo, services, commercial = {}) {
  const state = { version: 2, clockQd: 0, runs: [] };
  const holding = { id: "home", storage: { moneyCopper: 100000 }, special: {} };
  const ship = { id: "ship", onboardCopper: 0 };
  const order = bookTransportOrder({ state, holding, services, ship, commercial,
    plan: planTransportChain({ cargo, services }), id: "audit-order", direction: "inbound" });
  const advance = targetQd => advanceTransportOrders({ state, holding, targetQd, dependencies: { receiveCargo() {} } });
  return { state, holding, order, advance };
}

check("I1 insurance rounds the total insured loss independently of FIFO fragments", () => {
  for (const cargo of [[lot("all", 2)], [lot("old", 1), lot("new", 1)]]) {
    const test = fixture(cargo, [service()], { insuranceCoverageBps: 8400 });
    test.advance(8);
    resolveTransportIncident(test.state, test.state.runs[0].id, { outcome: "loss", lossBps: 10000 });
    test.advance(8);
    assert.equal(test.order.insurancePaidCopper, 1, "84% of two lost copper rounds to one copper once per policy");
    const before = test.holding.storage.moneyCopper;
    test.advance(8);
    assert.equal(test.holding.storage.moneyCopper, before, "replay cannot repeat insurance");
  }
  const separated = fixture([lot("cargo", 2)], [service({ capacity: 4000 })], { insuranceCoverageBps: 8400 });
  for (const atQd of [8, 48]) {
    separated.advance(atQd);
    const pending = separated.state.runs.find(run => run.incident?.status === "pending");
    resolveTransportIncident(separated.state, pending.id, { outcome: "loss", lossBps: 10000 });
    separated.advance(atQd);
    const reloaded = JSON.parse(JSON.stringify(separated.order));
    Object.assign(separated.order, reloaded);
  }
  assert.equal(separated.order.insurancePaidCopper, 1, "fractional coverage survives reload between separate physical losses");
});

check("R7 repacking consecutive owned legs does not repeat the original empty approach", () => {
  const own = service({ kind: "owned", shipId: "ship", approachQd: 4, approachCopper: 4,
    approachAccessCost: 5, emptyAccessLimit: 6, accessCost: 4 });
  const next = service({ id: "next", from: "B", to: "D", kind: "owned", shipId: "ship", riskBps: 0,
    approachQd: 8, approachAccessCost: 9, emptyAccessLimit: 6, accessCost: 2 });
  const test = fixture([lot("cargo", 2)], [own, next]);
  test.advance(8);
  resolveTransportIncident(test.state, test.state.runs[0].id, { outcome: "loss", lossBps: 5000 });
  test.advance(12);
  assert.equal(test.order.status, "delivered");
  assert.equal(test.order.received[0].qty, 1);
  assert.equal(test.order.stages[1].runs[0].startQd, 8, "the ship is already at the intermediate port");
});

check("R5 shared loss waits for the actual cargo of connecting orders", () => {
  const state = { version: 2, clockQd: 0, runs: [] };
  const left = { id: "z-direct", storage: { moneyCopper: 100000 }, special: {} };
  const right = { id: "a-connection", storage: { moneyCopper: 100000 }, special: {} };
  const final = service({ id: "shared", firstQd: 12 });
  const feeder = service({ id: "feeder", from: "X", to: "A" });
  const book = (holding, services) => bookTransportOrder({ state, holding, services,
    plan: planTransportChain({ cargo: [lot("cargo", 1)], services, runs: state.runs }),
    id: holding.id, direction: "inbound" });
  const direct = book(left, [final]), connected = book(right, [feeder, final]);
  const advance = holding => advanceTransportOrders({ state, holding, targetQd: 16, dependencies: { receiveCargo() {} } });
  advance(left); advance(right);
  const shared = state.runs.find(run => run.serviceId === "shared");
  assert.equal(shared.claims.length, 2);
  assert.throws(() => resolveTransportIncident(state, shared.id, { outcome: "loss", lossBps: 5000 }), /предыдущие участки/,
    "a reserved connection whose incoming cargo is unresolved cannot enter the physical loss manifest");
  resolveTransportIncident(state, connected.stages[0].runs[0].id, { outcome: "loss", lossBps: 10000 });
  advance(right);
  assert.equal(shared.claims.length, 1, "cargo lost before the connection never boarded the shared vehicle");
  resolveTransportIncident(state, shared.id, { outcome: "loss", lossBps: 5000 });
  advance(left);
  assert.equal(direct.lostQty, 0, "the actual one-unit manifest loses floor(1 * 50%) units");
  assert.equal(direct.received[0].qty, 1);
});

check("R7 an early cargo loss cannot return an empty ship through an inaccessible path", () => {
  for (const abortReturnAvailable of [false, true]) {
    const services = [service(), service({ id: "owned", from: "B", to: "D", kind: "owned", shipId: "ship",
      approachQd: 4, returnAtEnd: true, endReturnLocation: "home", endReturnQd: 4,
      abortReturnQd: 12, abortReturnAvailable, abortReturnAccessCost: 10, emptyAccessLimit: 6,
      startIdleUpkeepCopperPerDay: 100, idleUpkeepCopperPerDay: 10 })];
    const test = fixture([lot("cargo", 2)], services);
    test.advance(8);
    resolveTransportIncident(test.state, test.state.runs[0].id, { outcome: "loss", lossBps: 10000 });
    test.advance(8);
    prepareOwnedTransportAbort(test.order, test.state);
    assert.equal(test.order.shipAbort.location, "B");
    assert.equal(test.order.shipAbort.returnBlocked, true);
    assert.equal(test.order.shipAbort.returnCopper, 0);
    assert.equal(test.order.shipAbort.idleUpkeepCopperPerDay, 100, "the actual pickup port defines subsequent upkeep");
  }
});

check("I2 an aborted own leg pays upkeep at its actual pickup port", () => {
  const world = worldMarketFixture(), { data, holding, ship } = world;
  holding.type = "village"; holding.gm.modifiers.marketConnectionsLevel = 6; ship.crewTarget = 1;
  data.catalog.marketEconomy.baseOffers.push({ id: "rations", resourceId: "bread", name: "Bread", kind: "consumable",
    ubiquity: "essential", baseStock: 2000, priceOverrideCopper: 4, active: true });
  data.catalog.eventRegions.find(row => row.value === "a").marketPriceFactor = 3;
  const state = ensureTransportState(data);
  const market = prepareMarketAuthorityContext({ ...world, marketId: "a", isGM: true });
  const offer = market.quote.offers.find(row => row.resourceId === "test-freight");
  const quote = prepareTransportContext({ ...world, isGM: true, request: { marketId: market.market.id,
    ownShipId: ship.id, quantities: { [offer.id]: 2 }, returnHome: false } });
  const owned = quote.services.find(row => row.kind === "owned" && row.from === "a" && row.to === "home");
  assert.ok(owned.startIdleUpkeepCopperPerDay > owned.idleUpkeepCopperPerDay, "fixture pickup food is dearer than home food");
  const services = [service({ from: "b", to: "a" }), { ...owned, riskBps: 0 }];
  const order = bookTransportOrder({ state, holding, services, ship, direction: "inbound", id: "aborted-port",
    plan: planTransportChain({ cargo: [lot("cargo", 2)], services }), commercial: { reserveCopper: 1000 } });
  startTransportShip(data, holding, order);
  const workflow = { _appendStorageLog() {}, _storageAddWithOverflow() { throw new Error("The feeder lost all cargo"); } };
  advanceTransportShipments(data, holding, 8, workflow);
  resolveTransportIncident(state, order.stages[0].runs[0].id, { outcome: "loss", lossBps: 10000 });
  advanceTransportShipments(data, holding, 8, workflow);
  assert.equal(ship.location.regionId, "a");
  assert.equal(ship.transportOrderId, undefined);
  assert.equal(ship.portBilling.dailyCopper, owned.startIdleUpkeepCopperPerDay);
  const before = ship.onboardCopper;
  advanceWorldShips(holding, 12, { shipId: ship.id });
  assert.equal(before - ship.onboardCopper, owned.startIdleUpkeepCopperPerDay,
    "the first actual day in the pickup port uses its accepted local rate once");
});

if (failures.length) process.exitCode = 1;
else console.log("Transport v2 independent audit regressions passed.");
