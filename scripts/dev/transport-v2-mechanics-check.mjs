import assert from "node:assert/strict";
import { transportFixture, transportHarness, transportRequest } from "./fixtures/transport-v2.mjs";
import { prepareTransportContext, transportSourceToken } from "../apps/domains/transport-context.js";
import { findTransportPlans, planTransportChain } from "../engines/transport/planner.js";
import { bookTransportOrder, resolveTransportIncident } from "../engines/transport/runtime.js";
import { startTransportShip, advanceTransportShipments } from "../workflows/transport/orders.js";

// A budget is not a proof of optimality or absence. The cheaper/only viable
// route can be beyond it; exhausting exactly the available paths is different.
{
  const cargo = [{ lotId: "test", qty: 1, unitLoad: 1, unitCopper: 1 }];
  const services = [1, 2].map(n => ({ id: `service-${n}`, kind: "regular", from: "a", to: "b",
    capacity: 10, intervalQd: 4, travelQd: 1, dispatchCopper: 3 - n }));
  const args = { from: "a", to: "b", cargo, services };
  const limited = findTransportPlans({ ...args, maxPaths: 1 });
  const complete = findTransportPlans({ ...args, maxPaths: 2 });
  assert.equal(limited.limited, true);
  assert.equal(complete.limited, false);
  assert.ok(complete.plans[0].totalCopper < limited.plans[0].totalCopper);
  services[0].capacity = 0;
  assert.equal(findTransportPlans({ ...args, maxPaths: 1 }).plans.length, 0);
  assert.equal(findTransportPlans({ ...args, maxPaths: 1 }).limited, true);
}

for (const isGM of [true, false]) {
  const f = transportFixture();
  f.data.catalog.eventRegions[0].marketLinks = Array.from({ length: 140 }, (_, index) => ({
    regionId: "a", routeId: `path-${index}`, distanceKm: 150, modes: ["airship"]
  }));
  const request = transportRequest(f, "a", {}, isGM);
  const first = prepareTransportContext({ ...f, request, isGM });
  assert.equal(first.services.length, 280);
  assert.equal(first.search.limited, true);
  const last = [...first.services].sort((a, b) => a.id.localeCompare(b.id)).at(-1);
  f.data.catalog.transportV2.overrides = Object.fromEntries(first.services.filter(service => service.id !== last.id)
    .map(service => [service.id, { capacity: 1 }]));
  assert.throws(() => prepareTransportContext({ ...f, request, isGM }), /Поиск достиг лимита/);
  const pinned = { ...request, pins: { a: last.id } };
  const harness = transportHarness(f);
  const { order } = await harness.book(pinned, `limited-route-${isGM}`, isGM);
  harness.advance(order.plan.arrivalQd);
  assert.equal(order.status, "delivered", "a route beyond the automatic budget remains bookable by pinning it");
}

// Explicit catch-up pays idle expenses once and exposes the real funding
// sources in the storage journal, including mixed treasury/onboard payment.
for (const scope of ["home", "market"]) for (const funded of [true, false]) {
  const f = transportFixture();
  f.holding.gm.calendaria.lastQd = 8;
  f.ship.portBilling = { scope, sinceQd: 0, lastCalculatedQd: 0, dailyCopper: 4, chargedCopper: 0, carriedCopper: 0 };
  f.ship.onboardCopper = funded ? scope === "home" ? 3 : 20 : 0;
  if (!funded) f.holding.storage.moneyCopper = 0;
  if (scope === "market") {
    f.ship.location = { kind: "market", id: "a", regionId: "a", label: "a" };
    f.ship.status = "away";
  }
  const h = transportHarness(f), before = structuredClone(h.data);
  const op = { type: "transport-ship-sync", operationId: `sync-${scope}-${funded}`, holdingId: h.holding.id,
    shipId: h.ship.id, expectedRevision: h.data.meta.revision, sourceToken: transportSourceToken(h.data, h.holding) };
  await assert.rejects(h.execute(op, { userId: "player", remote: true }), /ГМ/);
  assert.deepEqual(h.data, before);
  if (!funded) {
    await assert.rejects(h.execute(op, { userId: "gm" }), /Недостаточно средств/);
    assert.deepEqual(h.data, before, "failed catch-up keeps the old cursor, money and journals");
    continue;
  }
  await h.execute(op, { userId: "gm" });
  const entries = h.holding.storage.log.filter(entry => entry.operationId === op.operationId);
  assert.equal(entries.reduce((sum, entry) => sum - entry.qty, 0), 8);
  const byRoom = room => entries.filter(entry => entry.roomId === room).reduce((sum, entry) => sum - entry.qty, 0);
  assert.equal(byRoom("treasury"), f.holding.storage.moneyCopper - h.holding.storage.moneyCopper);
  assert.equal(byRoom(`ship:${h.ship.id}`), f.ship.onboardCopper - h.ship.onboardCopper);
  assert.equal(h.ship.timelineQd, 8);
  assert.equal(h.ship.fleetAccounting.expenseCopper, 8);
  const after = structuredClone(h.data);
  assert.ok((await h.execute(op, { userId: "gm" })).replay);
  assert.deepEqual(h.data, after, "replay cannot repeat either payment or journal entry");
}

// Independent conservation oracle. Vary capacities and incident sequences
// across hired -> owned -> hired and two consecutive owned stages. No test
// recomputes implementation tariffs: compare actual asset and quantity totals.
for (let seed = 1; seed <= 60; seed++) {
  const { data, holding, ship } = transportFixture();
  const state = data.meta.transportV2;
  const cargo = [{ lotId: "c1", resourceId: "test-freight", qty: 7, unitLoad: 4000, unitCopper: 5 },
    { lotId: "c2", resourceId: "test-freight", qty: 6, unitLoad: 4000, unitCopper: 6 }];
  const types = seed % 2 ? ["regular", "owned", "regular"] : ["owned", "owned"];
  const points = types.length === 3 ? ["a", "b", "home", "end"] : ["a", "b", "home"];
  const services = types.map((kind, index) => ({ id: `svc${index}`, kind, from: points[index], to: points[index + 1],
    capacity: 4000 * (2 + (seed + index) % 5), travelQd: 3, loadingQd: 1, unloadingQd: 1, returnQd: 3,
    intervalQd: 7, firstQd: 1, vehicles: 1, dispatchCopper: 2, operatingMilliCopperPerQd: 1000, riskBps: 10000,
    ...(kind === "owned" ? { shipId: ship.id, approachQd: 2, approachCopper: 2, abortReturnQd: 2,
      endReturnQd: 2, endReturnLocation: "home", returnAtEnd: true } : {}) }));
  const plan = planTransportChain({ cargo, services });
  const initial = holding.storage.moneyCopper;
  ship.onboardCopper = 0;
  const order = bookTransportOrder({ state, holding, plan, services, id: `order${seed}`, direction: "inbound", ship,
    commercial: { reserveCopper: 10000, insuranceCoverageBps: 8400 } });
  startTransportShip(data, holding, order);
  let delivered = 0, incidents = 0;
  const workflow = { _appendStorageLog() {}, _storageAddWithOverflow(_holding, _lot, qty) { delivered += qty; } };
  for (let qd = 0; qd < 400; qd++) {
    advanceTransportShipments(data, holding, qd, workflow);
    for (const run of state.runs.filter(row => row.incident?.status === "pending")) {
      incidents++;
      resolveTransportIncident(state, run.id, { outcome: (seed + incidents) % 3 === 0 ? "loss" : "delay",
        lossBps: seed % 4 * 2500, delayQd: seed % 4, atQd: qd });
    }
    if (order.shipReleased && ["delivered", "lost"].includes(order.status)) break;
  }
  assert.ok(order.shipReleased && ["delivered", "lost"].includes(order.status), `completion ${seed}`);
  assert.equal(delivered + order.lostQty + order.spoiledQty, 13, `cargo conservation ${seed}`);
  assert.equal(initial + order.insurancePaidCopper - holding.storage.moneyCopper - ship.onboardCopper - order.money.escrowCopper,
    order.money.commercialSpentCopper + order.money.spentCopper, `money conservation ${seed}`);
}

console.log("Transport mechanics: honest search limits, GM/player pinned fallback, idle-payment audit/replay and 60 split/delay/loss conservation scenarios passed.");
