import assert from "node:assert/strict";
import { fixture, book, harness } from "./fixtures/transport-tenday.mjs";
import { transportFixture } from "./fixtures/transport-v2.mjs";
import { advanceTransportOrders, bookTransportOrder, canCancelTransportOrder, resolveTransportIncident } from "../engines/transport/runtime.js";
import { planTransportChain } from "../engines/transport/planner.js";
import { remainingCargoArrivals, unreservedCargoArrivals } from "../engines/transport/cargo-flow.js";
import { startTransportShip } from "../workflows/transport/orders.js";
import { transportSourceToken } from "../apps/domains/transport-context.js";

const orders = holding => holding.special.transportV2.orders;
const quantity = cargo => cargo.reduce((sum, lot) => sum + lot.qty, 0);
const accounting = data => data.holdings.map(holding => ({
  storage: holding.storage, clock: holding.gm.calendaria, ships: holding.special.ships,
  orders: orders(holding).map(order => ({ money: order.money, dispatched: order.dispatched, received: order.received,
    lostQty: order.lostQty, spoiledQty: order.spoiledQty, insurancePaidCopper: order.insurancePaidCopper,
    receipts: order.stages.map(stage => ({ receipts: stage.receipts, received: stage.received })) }))
}));
function conserved(order) {
  assert.equal(quantity(order.received) + order.lostQty + order.spoiledQty, quantity(order.cargo));
  const money = order.money;
  assert.equal(money.treasuryCopper + money.boardCopper,
    money.commercialSpentCopper + money.spentCopper + money.escrowCopper + money.refundedCopper);
}
async function ready(h, id, qd = 40, resolution = { outcome: "success" }, options = {}) {
  for (let pass = 0; pass < 60; pass++) {
    const prepared = await h.prepare(id, qd, options);
    if (prepared.ok) return prepared;
    assert.equal(prepared.transportProjection, undefined, "ordinary UI preparations do not retain the internal draft");
    const next = prepared.transportReview?.find(row => row.canResolve);
    assert.ok(next, prepared.message);
    const frozen = h.data.meta.transportV2.runs.filter(run => run.incident?.status === "resolved" || run.status === "arrived")
      .map(run => structuredClone(run));
    const before = structuredClone(accounting(h.data));
    await h.decide(prepared, next.carrier ? { outcome: "carrier" } : resolution);
    assert.deepEqual(accounting(h.data), before, "GM decisions cannot conduct either household's inventory, cash, crew or clock");
    h.reload();
    for (const previous of frozen) {
      const live = h.data.meta.transportV2.runs.find(run => run.id === previous.id);
      assert.ok(live, "confirmed physical runs survive another booking adoption");
      assert.deepEqual(live.incident, previous.incident, "a saved outcome cannot become pending again");
      assert.equal(live.arrivalQd, previous.arrivalQd);
      assert.equal(live.releaseQd, previous.releaseQd);
      if (previous.status === "arrived") assert.equal(live.status, "arrived");
    }
  }
  assert.fail("The review must terminate without requesting the same resolved incident again");
}

// Reserving a later committed departure must leave the earlier stock usable.
{
  const arrivals = [{ arrivalQd: 4, cargo: [{ lotId: "lot", qty: 5 }] },
    { arrivalQd: 36, cargo: [{ lotId: "lot", qty: 5 }] }, { arrivalQd: 68, cargo: [{ lotId: "lot", qty: 5 }] }];
  const source = structuredClone(arrivals);
  const remaining = unreservedCargoArrivals(arrivals, [
    { startQd: 70, cargo: [{ lotId: "lot", qty: 5 }] }, { startQd: 38, cargo: [{ lotId: "lot", qty: 5 }] }
  ]);
  assert.deepEqual(remaining, [arrivals[0]]);
  assert.deepEqual(arrivals, source, "reservation calculation is detached");
  assert.deepEqual(unreservedCargoArrivals(remainingCargoArrivals(arrivals, [{ lotId: "lot", qty: 5 }]),
    [{ startQd: 70, cargo: [{ lotId: "lot", qty: 5 }] }]), [arrivals[1]], "recorded receipts and future reservations each consume once");
  assert.throws(() => unreservedCargoArrivals(arrivals, [{ startQd: 3, cargo: [{ lotId: "lot", qty: 1 }] }]), /входящий груз/);
}

// A later physical trip can be known first. Its local receipt must not consume
// the early feeder's stock when that earlier outcome becomes known afterwards.
{
  const f = fixture();
  f.holding.people.list = [];
  const feeder = { ...f.carrier, id: "dated-feeder", kind: "regular", from: "a", to: "c", capacity: 20000,
    firstQd: 1, intervalQd: 32, loadingQd: 0, unloadingQd: 0, travelQd: 3, riskBps: 10000 };
  const carrier = { ...f.carrier, id: "dated-forward", from: "c", to: "home", capacity: 20000, vehicles: 2,
    travelQd: 2, returnQd: 50, riskBps: 10000 };
  const order = book(f, f.holding, "out-of-order-receipts", [feeder, carrier], { resourceId: "wood" });
  const deliveries = [];
  const advance = () => advanceTransportOrders({ state: f.data.meta.transportV2, holding: f.holding, targetQd: 40,
    dependencies: { receiveCargo(_order, cargo, atQd) { deliveries.push({ qty: quantity(cargo), atQd }); } } });
  const succeed = runId => resolveTransportIncident(f.data.meta.transportV2, runId, { outcome: "success",
    atQd: f.data.meta.transportV2.runs.find(run => run.id === runId).incident.atQd });
  const early = order.stages.map(stage => stage.runs[0].id), late = order.stages.map(stage => stage.runs[1].id);
  advance(); succeed(late[0]); advance(); succeed(late[1]); advance();
  assert.deepEqual(order.stages[1].receipts.map(receipt => receipt.runId), [late[1]]);
  assert.equal(order.stages[1].receipts[0].status, "arrived");
  succeed(early[0]); advance(); succeed(early[1]); advance();
  assert.deepEqual(order.stages[1].runs.map(run => run.id), [early[1], late[1]], "known receipt dates cannot move either physical trip");
  assert.deepEqual(order.stages[1].receipts.map(receipt => receipt.arrivalQd).sort((a, b) => a - b), [8, 40]);
  assert.deepEqual(deliveries.sort((a, b) => a.atQd - b.atQd), [{ qty: 5, atQd: 8 }, { qty: 5, atQd: 40 }]);
  conserved(order);
}

// Multiple routes share finite vehicles. A delayed physical trip has one lasting outcome.
{
  const f = fixture({ two: true });
  for (const holding of f.data.holdings) holding.people.list = [];
  const x = { ...f.carrier, id: "multi-x", from: "a", to: "b", kind: "regular", capacity: 8000,
    loadingQd: 1, unloadingQd: 1, travelQd: 2, returnQd: 4, intervalQd: 5, dispatchCopper: 2, riskBps: 10000 };
  const z = { ...x, id: "multi-z", from: "b", to: "c", kind: "charter", capacity: 16000, returnQd: 2, intervalQd: 3 };
  const y = { ...z, id: "multi-y", from: "c", to: "d", vehicles: 2, capacity: 12000, returnQd: 5, intervalQd: 6 };
  const w = { ...x, id: "multi-w", from: "d", to: "a", vehicles: 2, returnQd: 3, intervalQd: 4 };
  book(f, f.data.holdings[0], "chain-xyz", [x, z, y], { resourceId: "wood", qty: 2 });
  book(f, f.data.holdings[0], "direct-y", [y], { resourceId: "wood", qty: 3 });
  book(f, f.data.holdings[0], "chain-ywx", [y, w, x], { resourceId: "wood", qty: 3 });
  book(f, f.data.holdings[1], "chain-zy", [z, y], { resourceId: "wood", qty: 4 });
  const h = harness(f.data), delay = { outcome: "delay", delayQd: 4 };
  await h.apply(await ready(h, "second", 40, delay));
  for (const id of ["first", "second"]) while (h.holding(id).gm.calendaria.lastQd < 120) {
    await h.apply(await ready(h, id, 40, delay));
  }
  for (const holding of h.data.holdings) for (const order of orders(holding)) {
    assert.equal(order.status, "delivered"); conserved(order);
  }
}

// Part of a feeder is usable now; its other booked vehicle has a genuinely late return.
// Preserve that unknown remainder while forwarding the surviving early part this tenday.
{
  const f = fixture({ two: true });
  for (const holding of f.data.holdings) holding.people.list = [];
  const feeder = { ...f.carrier, id: "uncertain-feeder", from: "a", to: "c", capacity: 20000, vehicles: 2,
    loadingQd: 0, unloadingQd: 0, travelQd: 3, returnQd: 4, riskBps: 10000 };
  const next = { ...f.carrier, id: "forward-known", from: "c", to: "home", capacity: 20000,
    travelQd: 2, returnQd: 2, riskBps: 0 };
  book(f, f.data.holdings[0], "foreign-delay", [feeder], { resourceId: "wood", qty: 5 });
  book(f, f.data.holdings[1], "partial-incoming", [feeder, next], { resourceId: "wood" });
  const h = harness(f.data);
  await h.decide(await h.prepare("first"), { outcome: "delay", delayQd: 80 });
  await h.apply(await ready(h, "first"));
  const prepared = await ready(h, "second", 40, { outcome: "loss", lossBps: 5000 });
  const early = orders(prepared.preparedHolding)[0], stage = early.stages[1];
  assert.equal(quantity(early.received), 3, "unknown later cargo cannot hold the known surviving part");
  assert.equal(stage.receipts[0].arrivalQd, 8);
  assert.equal(quantity(stage.runs.filter(run => !stage.receipts.some(receipt => receipt.runId === run.id)).flatMap(run => run.cargo)), 5,
    "the unknown remainder keeps its transport reservation");
  await h.apply(prepared);
  await h.apply(await ready(h, "first", 80));
  await h.apply(await ready(h, "second", 80));
  for (const holding of h.data.holdings) { assert.equal(orders(holding)[0].status, "delivered"); conserved(orders(holding)[0]); }
  assert.equal(quantity(orders(h.holding("second"))[0].received), 8);
}

// Process the second household's three tendays before the first household's first.
// Successful risk decisions must have the same deliveries and meals as the risk-free control.
for (const rationUnitsPerResident of [5, 10, 15]) {
  const results = [];
  for (const riskBps of [0, 10000]) {
    const f = fixture({ two: true });
    f.data.holdings[1].storage.resources = [{ id: "batch-food", resourceId: "custom", name: "Dry rations", qty: 60,
      foodEdible: true, foodType: "grain", shelfLifeQd: 240,
      batches: [{ id: "batch-food-stock", qty: 60, ageQd: 0 }] }];
    const shared = { ...f.carrier, id: "shared-slow-return", from: "c", to: "home",
      capacity: 20000, travelQd: 2, returnQd: 22, riskBps };
    const a = { ...shared, id: "feeder-a", kind: "regular", from: "a", to: "c", firstQd: 1,
      intervalQd: 32, loadingQd: 0, unloadingQd: 0, travelQd: 3 };
    const b = { ...a, id: "feeder-b", from: "b", firstQd: 5, intervalQd: 40 };
    book(f, f.data.holdings[0], "first-food", [a, shared]);
    book(f, f.data.holdings[1], "second-food", [b, shared]);
    const h = harness(f.data);
    const second = await ready(h, "second", 120, { outcome: "success" }, { rationUnitsPerResident });
    assert.equal(second.rationUnitsPerResident, rationUnitsPerResident);
    assert.equal(second.report.food.eaten, 3 * rationUnitsPerResident);
    await h.apply(second);
    const physical = h.data.meta.transportV2.runs.filter(run => run.claims.some(claim => claim.orderId === "first-food"));
    assert.ok(physical.some(run => run.status === "arrived"), "the carrier was physically confirmed without local receipts");
    assert.ok(orders(h.holding())[0].stages.every(stage => !stage.receipts.length));
    assert.equal(canCancelTransportOrder(h.data.meta.transportV2, orders(h.holding())[0]), false);
    const first = await ready(h, "first", 40);
    const order = first.preparedHolding.special.transportV2.orders[0];
    assert.deepEqual(order.stages.map(stage => stage.receipts.map(receipt => receipt.arrivalQd)), [[4, 36], [8, 40]]);
    assert.equal(first.report.food.eaten, 10);
    assert.equal(first.report.food.hungryResidentDays, 0);
    conserved(order);
    await h.apply(first);
    results.push({ food: first.report.food, dates: order.stages.map(stage => stage.receipts.map(receipt => receipt.arrivalQd)) });
  }
  assert.deepEqual(results[1], results[0], "success cannot move an already completed delivery or change household food");
}

// A calendar reconnect during asynchronous batch preparation invalidates the decision atomically.
{
  const f = fixture({ riskBps: 10000 });
  book(f, f.holding, "calendar-change", [f.carrier]);
  const h = harness(f.data), prepared = await h.prepare("first", 80), before = structuredClone(h.data);
  const originalPrepare = h.workflow._prepareTendayOperation, originalGate = h.workflow._checkCalendariaEconomyAdvance;
  let changed = false;
  h.workflow._prepareTendayOperation = async function(options) {
    const result = await originalPrepare.call(this, options);
    if (options.includeTransportProjection && options.qd > 40) changed = true;
    return result;
  };
  h.workflow._checkCalendariaEconomyAdvance = function(...args) {
    const gate = originalGate.apply(this, args);
    return changed ? { ...gate, snapshot: { ...gate.snapshot, available: true } } : gate;
  };
  const next = prepared.transportReview.find(row => row.canResolve);
  await assert.rejects(() => h.execute({ type: "transport-incident", operationId: "changed-calendar-decision", holdingId: "first",
    expectedRevision: h.data.meta.revision, sourceToken: transportSourceToken(h.data, h.holding()), reviewQd: 80,
    runId: next.runId, resolution: { outcome: "success" } }, { userId: "gm" }),
  error => error.code === "conflict" && /Calendaria/.test(error.message));
  assert.deepEqual(h.data, before, "invalidated async preparations cannot partly save bookings or outcomes");
}

// A globally arrived long voyage stays arrived when the lagging household records only departure.
{
  const f = fixture({ two: true, travelQd: 50, riskBps: 10000 });
  for (const holding of f.data.holdings) holding.people.list = [];
  const first = book(f, f.data.holdings[0], "long-first", [f.carrier], { resourceId: "wood" });
  book(f, f.data.holdings[1], "long-second", [f.carrier], { resourceId: "wood" });
  const h = harness(f.data);
  await h.apply(await ready(h, "second", 120));
  const runId = first.stages[0].runs[0].id;
  assert.equal(h.data.meta.transportV2.runs.find(run => run.id === runId).status, "arrived");
  await h.apply(await ready(h, "first", 40));
  assert.equal(orders(h.holding())[0].stages[0].receipts[0].status, "travelling");
  const run = h.data.meta.transportV2.runs.find(run => run.id === runId);
  assert.equal(run.status, "arrived", "local accounting cannot reverse the shared physical state");
  assert.equal(run.incident.status, "resolved");
  await h.apply(await ready(h, "first", 40));
  conserved(orders(h.holding())[0]);
}

// Outbound stock is conducted locally once, even if another holding confirmed its physical voyage.
for (const lossBps of [0, 5000, 10000]) {
  const f = fixture({ two: true, riskBps: 10000 });
  for (const holding of f.data.holdings) holding.people.list = [];
  const first = book(f, f.data.holdings[0], "first-sale", [f.carrier], { resourceId: "wood", direction: "outbound" });
  first.commercial.insuranceCoverageBps = 5000;
  book(f, f.data.holdings[1], "following-sale", [f.carrier], { resourceId: "wood" });
  const h = harness(f.data), resolution = lossBps ? { outcome: "loss", lossBps } : { outcome: "success" };
  await h.apply(await ready(h, "second", 40, resolution));
  const before = orders(h.holding())[0];
  assert.equal(h.holding().storage.resources[0].qty, 10, "physical confirmation does not remove unrecorded local stock");
  assert.deepEqual(before.dispatched, {});
  await h.apply(await ready(h, "first", 40, resolution));
  const order = orders(h.holding())[0];
  assert.equal(order.dispatched["first-sale"], 10);
  assert.equal(h.holding().storage.resources.find(row => row.id === "stock-first-sale")?.qty ?? 0, 0);
  assert.equal(order.lostQty, lossBps / 1000);
  assert.equal(quantity(order.received), 10 - lossBps / 1000);
  assert.equal(order.insurancePaidCopper, Math.floor(lossBps / 1000 * 5 / 2));
  conserved(order);
}

// Losing all feeder cargo can release the unused owned stages before local abort accounting.
// Both ordinary windows must remain readable and the later Apply must still return the ship.
{
  const f = fixture({ two: true }), ship = structuredClone(transportFixture().ship);
  ship.crewTarget = 0; ship.crewResidentIds = [];
  for (const holding of f.data.holdings) holding.people.list = [];
  f.holding.special.ships.list = [ship];
  const feeder = { ...f.carrier, id: "empty-feeder", kind: "regular", from: "a", to: "b", firstQd: 1,
    loadingQd: 0, unloadingQd: 0, travelQd: 3, riskBps: 10000 };
  const own = { ...f.carrier, id: "empty-own", kind: "owned", shipId: ship.id, from: "b", to: "c", travelQd: 3,
    approachQd: 4, approachCopper: 4, returnQd: 4, endReturnQd: 4, abortReturnQd: 4, endReturnLocation: "home",
    returnAtEnd: true, operatingCopperPerQd: 1 };
  const shared = { ...f.carrier, id: "empty-following", from: "c", to: "home", returnQd: 8 };
  const cargo = [{ lotId: "empty-food", resourceId: "bread", name: "Bread", qty: 10, unitLoad: 4000,
    unitCopper: 5, ageQd: 0, shelfLifeQd: 240 }];
  const order = bookTransportOrder({ state: f.data.meta.transportV2, holding: f.holding, ship,
    services: [feeder, own, shared], plan: planTransportChain({ cargo, services: [feeder, own, shared] }),
    id: "foreign-owned", direction: "inbound", commercial: { targetRoomId: "outdoors", reserveCopper: 1000 } });
  startTransportShip(f.data, f.holding, order);
  book(f, f.data.holdings[1], "following-empty", [shared]);
  const h = harness(f.data);
  await ready(h, "second", 40, { outcome: "loss", lossBps: 10000 });
  const current = orders(h.holding())[0];
  assert.equal(current.stages[1].runs.length, 0);
  assert.equal(current.shipAbort, undefined);
  assert.equal(h.holding().special.ships.list[0].transportOrderId, order.id, "a foreign preview cannot return the ship");
  globalThis.foundry = { ...foundry, applications: { api: {
    ApplicationV2: class { constructor(options) { this.id = options.id; } async _prepareContext() { return {}; } },
    HandlebarsApplicationMixin: Parent => Parent
  } } };
  const { SkyholdTransportApp } = await import("../apps/transport-app.js");
  const before = structuredClone(h.data);
  for (const isGM of [true, false]) {
    game.user = { id: isGM ? "gm" : "player", isGM }; game.socket = { emit() {} };
    const view = await new SkyholdTransportApp({ holdingId: "first" })._prepareContext({});
    assert.equal(view.orders.length, 1);
    assert.match(view.orders[0].shipTiming, /будет рассчитан при проведении поселения/);
  }
  assert.deepEqual(h.data, before, "rendering cannot invent a return or write world data");
  game.user = { id: "gm", isGM: true };
  await h.apply(await ready(h, "first"));
  const completed = orders(h.holding())[0], returned = h.holding().special.ships.list[0];
  assert.equal(completed.status, "lost");
  assert.equal(completed.shipAbort.releaseQd, 8);
  assert.equal(completed.shipAbort.location, "home");
  assert.equal(completed.shipReleased, true);
  assert.equal(returned.location.kind, "home");
  assert.equal(returned.transportOrderId, undefined);
  assert.equal(completed.ownedActualCopper, 8, "only approach and actual empty return are charged");
}

console.log("Confirmed transport: lasting outcomes, lagging receipts, dated reservations, sequential batch review/rations, outbound loss/insurance and empty owned GM/player windows passed.");
