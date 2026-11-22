import assert from "node:assert/strict";
import { transportFixture, transportHarness, transportRequest } from "./fixtures/transport-v2.mjs";
import { prepareTransportContext, transportSourceToken } from "../apps/domains/transport-context.js";
import { planTransportChain } from "../engines/transport/planner.js";
import { bookTransportOrder, resolveTransportIncident } from "../engines/transport/runtime.js";
import { startTransportShip, advanceTransportShipments } from "../workflows/transport/orders.js";

for (const isGM of [true, false]) {
  const f = transportFixture();
  f.data.catalog.eventRegions[0].marketLinks = Array.from({ length: 140 }, (_, index) => ({
    regionId: "a", routeId: `path-${index}`, distanceKm: 150 + (index === 139 ? -50 : 0), modes: ["airship"]
  }));
  const request = transportRequest(f, "a", {}, isGM);
  const first = prepareTransportContext({ ...f, request, isGM });
  assert.equal(first.search.limited, false, "fast Dijkstra handles 140 parallel links with zero search limit");
  assert.equal(first.plan.stages[0].service.distanceKm, 100, "selects the shortest/cheapest parallel link directly");
  const harness = transportHarness(f);
  const { order } = await harness.book(request, `fast-route-${isGM}`, isGM);
  harness.advance(order.plan.arrivalQd);
  assert.equal(order.status, "delivered");

  // Even if the first 13 shortest parallel routes are disabled by overrides, the 14th open route is still found.
  const fMany = transportFixture();
  fMany.data.catalog.transportV2.overrides ??= {};
  fMany.data.catalog.eventRegions[0].marketLinks = Array.from({ length: 15 }, (_, index) => ({
    regionId: "a", routeId: `opt-${index}`, distanceKm: 100 + index * 5, modes: ["airship"]
  }));
  const reqMany = transportRequest(fMany, "a", { mode: "regular" }, isGM);
  for (let i = 0; i < 13; i++) {
    const pick = prepareTransportContext({ ...fMany, request: reqMany, isGM });
    fMany.data.catalog.transportV2.overrides[pick.plan.stages[0].service.id] = { enabled: false };
  }
  const fourteenth = prepareTransportContext({ ...fMany, request: reqMany, isGM });
  assert.equal(fourteenth.plan.stages[0].service.distanceKm, 165, "finds the 14th open route after 13 disabled candidates");
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
