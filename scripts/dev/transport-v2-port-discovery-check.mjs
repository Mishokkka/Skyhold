import assert from "node:assert/strict";
import { transportFixture, transportRequest, transportHarness } from "./fixtures/transport-v2.mjs";
import { prepareTransportContext } from "../apps/domains/transport-context.js";
import { normalizeSkyholdData } from "../data/normalizers.js";

const region = (value, modes, marketLinks = []) => ({ value, label: value, countryId: "public", marketTransportModes: modes, marketLinks });
const link = (regionId, modes, ursCost = 1) => ({ regionId, modes, ursCost, distanceKm: 40 });
function fixture(extraFirst = false, connected = false) {
  const f = transportFixture();
  f.holding.gm.modifiers.marketConnectionsLevel = 3;
  const extra = Array.from({ length: 23 }, (_, i) => region(`other-${String(i).padStart(2, "0")}`, ["airship", "caravan"],
    connected ? [link("home", ["caravan"]), link("b", ["caravan"])] : []));
  const home = region("home", ["airship", "caravan"], [link("a", ["airship"], 3), link("via", ["airship"])]);
  const via = region("via", ["caravan"], [link("a", ["airship"])]);
  const a = region("a", ["airship", "caravan"], [link("b", ["caravan"])]);
  const b = region("b", ["caravan"]);
  f.data.catalog.eventRegions = extraFirst ? [home, ...extra, via, a, b] : [home, via, a, b, ...extra];
  return f;
}

// Even with 23 extra unrelated ports ahead of port "a", the fast router finds the single optimal transfer port automatically.
for (const connected of [false, true]) {
  for (const isGM of [true, false]) for (const direction of ["inbound", "outbound"]) {
    const first = fixture(false, connected), reordered = fixture(true, connected);
    const request = transportRequest(first, "b", { direction, mode: "owned", ownShipId: first.ship.id, returnHome: true }, isGM);
    const a = prepareTransportContext({ ...first, request, isGM });
    const b = prepareTransportContext({ ...reordered, request, isGM });
    assert.deepEqual(b.plan, a.plan, "unrelated ports and catalog order cannot change the route, cost or schedule");
    assert.equal(b.search.limited, false, "no port-subset truncation");
    assert.equal(b.plan.stages.length, 2, "at most one clean port transfer for inland market");
    assert.ok(b.plan.stages.some(stage => stage.service.kind === "owned"));
    assert.ok(b.plan.stages.some(stage => stage.service.kind !== "owned"));
    const h = transportHarness(reordered);
    const { operation } = await h.book(request, `ports-${connected}-${isGM}-${direction}`, isGM);
    const after = structuredClone(h.data);
    assert.equal((await h.execute(operation, { userId: isGM ? "gm" : "player", remote: !isGM })).replay, true);
    assert.deepEqual(h.data, after);
    assert.deepEqual(normalizeSkyholdData(h.data).holdings[0].special.transportV2, h.holding.special.transportV2);
    h.advance(Math.max(b.plan.arrivalQd, b.plan.shipReleaseQd));
    const order = h.holding.special.transportV2.orders.at(-1);
    assert.equal(order.status, "delivered");
    assert.equal(order.received.reduce((sum, lot) => sum + lot.qty, 0), 10);
    assert.equal(order.money.escrowCopper, 0);
    assert.ok(!h.ship.transportOrderId);
  }
}

// Even 150 parallel links per hop resolve cleanly without hitting a route-search cap.
{
  const f = transportFixture(), request = transportRequest(f, "b", { mode: "regular" }, false);
  f.data.catalog.eventRegions = [
    region("home", ["airship"], Array.from({ length: 150 }, (_, i) => ({ ...link("a", ["airship"]), routeId: `first-${i}` }))),
    region("a", ["airship"], Array.from({ length: 150 }, (_, i) => ({ ...link("b", ["airship"]), routeId: `last-${i}` }))),
    region("b", ["airship"])
  ];
  const quote = prepareTransportContext({ ...f, request, isGM: false, allowIncomplete: true });
  assert.ok(quote.plan, "fast Dijkstra resolves dense parallel graphs directly");
  assert.equal(quote.search.limited, false);
}

console.log("Transport ports: catalog permutations, 23 extra ports, single-transfer own ship and dense 150-edge graphs passed with zero search limits.");
