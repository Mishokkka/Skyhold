import assert from "node:assert/strict";
import { fixture, book, harness } from "./fixtures/transport-tenday.mjs";
import { advanceTransportOrders, canCancelTransportOrder, resolveTransportIncident } from "../engines/transport/runtime.js";
import { transportSourceToken } from "../apps/domains/transport-context.js";

const withoutCommandLog = holdings => holdings.map(({ log: _log, ...holding }) => holding);

// A later booking sails first. Food and raw materials arrive before their household phases.
for (const resourceId of ["bread", "wood"]) for (const reverse of [false, true]) {
  const f = fixture(), feeder = { ...f.carrier, id: "slow-feeder", from: "a", to: "b", travelQd: 12 };
  book(f, f.holding, "slow", [feeder, f.carrier], { resourceId });
  book(f, f.holding, "direct", [f.carrier], { resourceId: "test-freight" });
  if (reverse) f.holding.special.transportV2.orders.reverse();
  const h = harness(f.data), production = h.workflow._runProductionAndLivestockForQd;
  let wood = 0;
  h.workflow._runProductionAndLivestockForQd = function(holding, ...args) {
    wood = holding.storage.resources.filter(row => row.resourceId === "wood").reduce((sum, row) => sum + row.qty, 0);
    return production.call(this, holding, ...args);
  };
  const prepared = await h.prepare();
  assert.equal(prepared.ok, true);
  assert.ok(prepared.preparedHolding.special.transportV2.orders.every(order => order.status === "delivered"));
  const slow = prepared.preparedHolding.special.transportV2.orders.find(order => order.id === "slow");
  assert.equal(slow.stages[1].receipts[0].arrivalQd, 21);
  if (resourceId === "bread") { assert.equal(prepared.report.food.hungryResidentDays, 0); assert.equal(prepared.report.food.eaten, 10); }
  else assert.equal(wood, 10, "raw materials are present when production starts");
  await h.apply(prepared); h.reload();
  assert.ok(h.holding().special.transportV2.orders.every(order => order.received.length === 1));
}

// A known delay that frees the vehicle later inside the same pass must not rebook at the period's end.
for (const reverse of [false, true]) {
  const f = fixture(), feeder = { ...f.carrier, id: "delayed-connection", from: "a", to: "b", travelQd: 12 };
  book(f, f.holding, "delayed-food", [feeder, f.carrier]);
  book(f, f.holding, "earlier-risk", [{ ...f.carrier, riskBps: 10000 }], { resourceId: "test-freight" });
  if (reverse) f.holding.special.transportV2.orders.reverse();
  const h = harness(f.data); await h.decide(await h.prepare(), { outcome: "delay", delayQd: 12 });
  const prepared = await h.prepare();
  assert.equal(prepared.ok, true); assert.equal(prepared.report.food.hungryResidentDays, 0);
  assert.equal(prepared.preparedHolding.special.transportV2.orders.find(order => order.id === "delayed-food").stages[1].receipts[0].arrivalQd, 29);
  await h.apply(prepared);
}

// Sales in two connecting chains make money available to the same period's finance phase.
{
  const f = fixture(), carrier = { ...f.carrier, to: "a" };
  const slow = { ...carrier, id: "slow-outbound", from: "home", to: "b", travelQd: 12 };
  const fast = { ...slow, id: "fast-outbound", travelQd: 1 };
  book(f, f.holding, "slow-sale", [slow, carrier], { resourceId: "wood", direction: "outbound" });
  book(f, f.holding, "fast-sale", [fast, carrier], { resourceId: "test-freight", direction: "outbound" });
  const h = harness(f.data), initialCash = h.holding().storage.moneyCopper, finance = h.workflow._prepareFinanceForQd;
  let financeCash;
  h.workflow._prepareFinanceForQd = function(holding, ...args) { financeCash = holding.storage.moneyCopper; return finance.call(this, holding, ...args); };
  const prepared = await h.prepare();
  assert.equal(prepared.ok, true); assert.equal(financeCash, initialCash + 100);
  assert.ok(prepared.preparedHolding.special.transportV2.orders.every(order => order.status === "delivered"));
  await h.apply(prepared);
}

// A foreign household is never applied implicitly. An unprocessed finite fleet blocks Apply, not food supply.
for (const kind of ["regular", "charter"]) for (const vehicles of [1, 2]) for (const reverse of [false, true]) {
  const f = fixture({ two: true, kind, vehicles });
  for (const holding of f.data.holdings) book(f, holding, `order-${holding.id}`, [f.carrier]);
  const h = harness(f.data);
  if (reverse && kind === "charter" && vehicles === 1) {
    const before = structuredClone(h.data), blocked = await h.prepare("second");
    assert.equal(blocked.ok, false); assert.equal(blocked.transportReview[0].carrier, true);
    assert.equal(blocked.transportReview[0].canResolve, true, "known physical trips can be confirmed without the other household's Apply");
    assert.equal(blocked.transportReview[0].blockers[0].holdingId, "first");
    assert.equal(blocked.transportReview[0].blockers[0].qd, 40);
    assert.equal((await h.workflow._applyPreparedTendayOperation(blocked)).ok, false);
    const op = { type: "transport-incident", operationId: "carrier-not-incident", holdingId: "second", reviewQd: 40,
      expectedRevision: h.data.meta.revision, sourceToken: transportSourceToken(h.data, h.holding("second")),
      runId: blocked.transportReview[0].runId, resolution: { outcome: "success" } };
    await assert.rejects(h.execute(op, { userId: "gm" }), /больше не ожидает решения/);
    await assert.rejects(h.execute(op, { userId: "player", remote: true }), /доступна ГМ/);
    await assert.rejects(h.execute({ ...op, resolution: { outcome: "carrier" }, expectedRevision: h.data.meta.revision + 1 }, { userId: "gm" }), /Данные изменились/);
    assert.deepEqual(h.data, before, "a blocked preview, Apply or invalid decision cannot change the world");
    await h.decide(blocked, { outcome: "carrier" });
    assert.deepEqual(withoutCommandLog(h.data.holdings), withoutCommandLog(before.holdings), "confirmation only adds its command receipt; local cargo, stores, money and clocks stay unchanged");
    assert.equal(canCancelTransportOrder(h.data.meta.transportV2, h.holding().special.transportV2.orders[0]), false,
      "a confirmed physical departure cannot be cancelled through a lagging local booking");
    h.reload();
  }
  const sequence = reverse ? ["second", "first"] : ["first", "second"];
  for (const id of sequence) {
    const otherId = id === "first" ? "second" : "first", otherBefore = structuredClone(h.holding(otherId));
    const prepared = await h.prepare(id);
    assert.equal(prepared.ok, true); assert.equal(prepared.report.food.hungryResidentDays, 0);
    assert.equal(prepared.report.food.eaten, 10); await h.apply(prepared);
    assert.deepEqual(h.holding(otherId), otherBefore, "processing one holding never applies the other household");
  }
}

// Different local economy ages still use the same vehicle date and preserve each holding's own clock.
{
  const f = fixture({ two: true });
  f.data.meta.transportV2.clockQd = 360; f.carrier.firstQd = 361;
  f.data.holdings[0].gm.calendaria.lastQd = 360;
  f.data.holdings[1].special.transportV2.clockOffsetQd = 360;
  for (const holding of f.data.holdings) book(f, holding, `offset-${holding.id}`, [f.carrier]);
  const h = harness(f.data), review = await h.prepare("second");
  assert.equal(review.transportReview[0].localQd, 7); assert.equal(review.transportReview[0].blockers[0].qd, 40);
  await h.decide(review, { outcome: "carrier" }); h.reload();
  for (const id of ["second", "first"]) {
    const prepared = await h.prepare(id);
    assert.equal(prepared.report.food.hungryResidentDays, 0); await h.apply(prepared);
  }
  assert.equal(h.holding().gm.calendaria.lastQd, 400); assert.equal(h.holding("second").gm.calendaria.lastQd, 40);
}

// A trip already travelling can still acquire an incident before its vehicle is free.
{
  const f = fixture({ two: true, travelQd: 44, riskBps: 10000 });
  for (const holding of f.data.holdings) book(f, holding, `long-${holding.id}`, [f.carrier]);
  const h = harness(f.data); await h.apply(await h.prepare());
  assert.equal(h.data.meta.transportV2.runs[0].status, "travelling");
  const blocked = await h.prepare("second", 120);
  assert.equal(blocked.ok, false); assert.ok(blocked.transportReview.some(row => row.carrier));
  assert.equal(blocked.transportReview.find(row => row.carrier).blockers[0].qd, 40);
  const original = structuredClone(h.holding());
  await h.decide(blocked, { outcome: "delay", delayQd: 12 }); h.reload();
  let prepared = await h.prepare("second", 120);
  while (prepared.transportReview) {
    await h.decide(prepared, { outcome: prepared.transportReview.find(row => row.canResolve)?.carrier ? "carrier" : "success" });
    prepared = await h.prepare("second", 120);
  }
  const order = prepared.preparedHolding.special.transportV2.orders[0];
  assert.equal(order.stages[0].receipts[0].departureQd, 64, "later departure includes the previous trip's actual delay and return");
  await h.apply(prepared);
  assert.equal(h.holding().gm.calendaria.lastQd, 40);
  assert.deepEqual(h.holding().storage, original.storage, "foreign delay and physical confirmation do not spend its escrow or deliver its cargo");
  assert.equal(h.holding().special.transportV2.orders[0].stages[0].receipts[0].status, "travelling");
  await h.apply(await h.prepare());
}

// Crossed chains must not require both households to Apply first: each earlier trip releases the other's later leg.
for (const reverse of [false, true]) {
  const f = fixture({ two: true });
  const x = { ...f.carrier, id: "cross-x", from: "a", to: "b" }, y = { ...f.carrier, id: "cross-y", from: "c", to: "d" };
  const across = { ...f.carrier, id: "cross-connection-1", from: "b", to: "c", travelQd: 8 };
  const back = { ...across, id: "cross-connection-2", from: "d", to: "a" };
  book(f, f.data.holdings[0], "cross-first", [x, across, y]);
  book(f, f.data.holdings[1], "cross-second", [y, back, x]);
  const h = harness(f.data), ids = reverse ? ["second", "first"] : ["first", "second"];
  const before = structuredClone(h.data.holdings);
  const review = await h.prepare(ids[0]);
  assert.equal(review.ok, false); assert.equal(review.transportReview.find(row => row.canResolve)?.carrier, true);
  await h.decide(review, { outcome: "carrier" });
  assert.deepEqual(withoutCommandLog(h.data.holdings), withoutCommandLog(before), "crossed prerequisites freeze only common physical state and their command receipt");
  h.reload();
  for (const id of ids) {
    let prepared = await h.prepare(id);
    while (prepared.transportReview) { await h.decide(prepared, { outcome: "carrier" }); prepared = await h.prepare(id); }
    assert.equal(prepared.report.food.hungryResidentDays, 0);
    assert.equal(prepared.preparedHolding.special.transportV2.orders[0].stages[2].receipts[0].arrivalQd, 23);
    await h.apply(prepared);
  }
}

// Compare delayed and lossy crossed chains with an independent quarter-day invocation schedule.
for (const outcome of ["delay", "loss"]) for (const reverse of [false, true]) {
  const f = fixture({ two: true });
  const x = { ...f.carrier, id: "oracle-x", from: "a", to: "b", riskBps: 10000 };
  const y = { ...x, id: "oracle-y", from: "c", to: "d" };
  const connection = { ...f.carrier, id: "oracle-connection-1", from: "b", to: "c", travelQd: 8 };
  book(f, f.data.holdings[0], "oracle-first", [x, connection, y]);
  book(f, f.data.holdings[1], "oracle-second", [y, { ...connection, id: "oracle-connection-2", from: "d", to: "a" }, x]);
  const reference = structuredClone(f.data), resolution = outcome === "delay" ? { outcome, delayQd: 4 } : { outcome, lossBps: 5000 };
  for (let at = 0; at <= 80; at++) for (let pass = 0; pass < 40; pass++) {
    const before = JSON.stringify(reference);
    for (const holding of reference.holdings) advanceTransportOrders({ state: reference.meta.transportV2, holding, targetQd: at, dependencies: { receiveCargo() {} } });
    for (const run of reference.meta.transportV2.runs.filter(run => run.incident?.status === "pending" && run.incident.atQd <= at)) {
      resolveTransportIncident(reference.meta.transportV2, run.id, { ...resolution, atQd: run.incident.atQd });
    }
    if (before === JSON.stringify(reference)) break;
    assert.ok(pass < 39, "quarter-day reference converges");
  }
  const h = harness(f.data), ids = reverse ? ["second", "first"] : ["first", "second"];
  for (const id of ids) {
    let prepared;
    for (let pass = 0; pass < 40; pass++) {
      prepared = await h.prepare(id);
      if (prepared.ok) break;
      const row = prepared.transportReview.find(row => row.canResolve);
      assert.ok(row, "crossed physical dependencies always offer the next known step");
      await h.decide(prepared, row.carrier ? { outcome: "carrier" } : resolution); h.reload();
    }
    assert.equal(prepared.ok, true); await h.apply(prepared);
  }
  const summary = data => data.holdings.map(holding => holding.special.transportV2.orders.map(order => ({
    status: order.status, received: order.received.reduce((n, lot) => n + lot.qty, 0), lost: order.lostQty,
    stages: order.stages.map(stage => stage.receipts.map(receipt => ({ runId: receipt.runId, departure: receipt.departureQd, arrival: receipt.arrivalQd,
      qty: receipt.cargo.reduce((n, lot) => n + lot.qty, 0) })))
  })));
  assert.deepEqual(summary(h.data), summary(reference), "crossed tendays preserve the reference dates and losses regardless of household order");
}

// A foreign feeder can lose cargo or move its charter to a new slot; neither may leave a phantom reservation.
for (const outcome of ["delay", "partial-loss", "total-loss"]) {
  const f = fixture({ two: true }), feeder = { ...f.carrier, id: "foreign-feeder", kind: "regular", from: "a", to: "b",
    travelQd: 3, loadingQd: 0, unloadingQd: 0, riskBps: 10000 };
  book(f, f.data.holdings[0], "foreign-fed", [feeder, f.carrier]);
  book(f, f.data.holdings[1], "after-foreign", [f.carrier]);
  const h = harness(f.data), original = h.data.holdings.map(holding => ({ storage: structuredClone(holding.storage), clock: holding.gm.calendaria.lastQd,
    money: structuredClone(holding.special.transportV2.orders[0].money) }));
  let prepared;
  for (let pass = 0; pass < 20; pass++) {
    prepared = await h.prepare("second");
    if (prepared.ok) break;
    const row = prepared.transportReview.find(row => row.canResolve);
    assert.ok(row, `foreign ${outcome} has an executable prerequisite`);
    await h.decide(prepared, row.carrier ? { outcome: "carrier" }
      : outcome === "delay" ? { outcome: "delay", delayQd: 8 } : { outcome: "loss", lossBps: outcome === "total-loss" ? 10000 : 5000 });
    h.reload();
  }
  assert.equal(prepared.ok, true, "dependency review terminates after changed or removed charter bookings");
  for (const [index, holding] of h.data.holdings.entries()) {
    assert.deepEqual(holding.storage, original[index].storage);
    assert.deepEqual(holding.special.transportV2.orders[0].money, original[index].money);
    assert.equal(holding.gm.calendaria.lastQd, original[index].clock);
    assert.ok(holding.special.transportV2.orders[0].stages.every(stage => stage.receipts.length === 0));
  }
  assert.equal(prepared.report.food.hungryResidentDays, 0); await h.apply(prepared);
  prepared = await h.prepare();
  assert.equal(prepared.ok, true);
  assert.equal(prepared.preparedHolding.special.transportV2.orders[0].received.reduce((n, lot) => n + lot.qty, 0),
    outcome === "total-loss" ? 0 : outcome === "partial-loss" ? 5 : 10);
  await h.apply(prepared);
}

// A known return beyond the period is a genuine wait, not an unprocessed dependency in this period.
{
  const f = fixture({ two: true, riskBps: 10000 });
  for (const holding of f.data.holdings) book(f, holding, `late-${holding.id}`, [f.carrier]);
  const h = harness(f.data); await h.decide(await h.prepare(), { outcome: "delay", delayQd: 80 });
  await h.apply(await h.prepare());
  const prepared = await h.prepare("second");
  assert.equal(prepared.ok, true); assert.equal(prepared.report.food.eaten, 0);
  assert.equal(prepared.preparedHolding.special.transportV2.orders[0].stages[0].receipts.length, 0);
  await h.apply(prepared);
}

// An earlier return already inside the other holding's processed time needs current-date processing, not another tenday.
{
  const f = fixture({ two: true });
  for (const holding of f.data.holdings) book(f, holding, `old-${holding.id}`, [f.carrier]);
  f.holding.gm.calendaria.lastQd = 40;
  const h = harness(f.data), blocked = await h.prepare("second");
  const owner = blocked.transportReview[0].blockers[0];
  assert.equal(owner.qd, 0); assert.equal(owner.currentDate, true);
  await h.execute({ type: "transport-advance", operationId: "carrier-current-date", holdingId: "first",
    expectedRevision: h.data.meta.revision, sourceToken: transportSourceToken(h.data, h.holding()) }, { userId: "gm" });
  const prepared = await h.prepare("second");
  assert.equal(prepared.ok, true); assert.equal(prepared.report.food.hungryResidentDays, 0);
}

// Worklist termination: a real future return must not cause an endless retry or repeated callbacks.
{
  const f = fixture(), first = book(f, f.holding, "long-first", [{ ...f.carrier, travelQd: 44 }]);
  const second = book(f, f.holding, "long-second", [{ ...f.carrier, travelQd: 44 }]);
  let received = 0;
  const dependencies = { receiveCargo() { received++; } };
  advanceTransportOrders({ state: f.data.meta.transportV2, holding: f.holding, targetQd: 40, dependencies });
  assert.equal(first.status, "travelling"); assert.equal(second.stages[0].receipts.length, 0); assert.equal(received, 0);
  advanceTransportOrders({ state: f.data.meta.transportV2, holding: f.holding, targetQd: 120, dependencies });
  assert.equal(received, 2);
  advanceTransportOrders({ state: f.data.meta.transportV2, holding: f.holding, targetQd: 120, dependencies });
  assert.equal(received, 2);
}
console.log("Carrier dependencies: order-independent local food/materials/sales, explicit foreign preflight, finite/regular fleets, travelling risk, real future waits, reload and replay passed.");
