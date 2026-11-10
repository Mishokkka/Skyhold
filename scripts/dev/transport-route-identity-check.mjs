import assert from "node:assert/strict";
import { transportFixture, transportRequest, transportHarness } from "./fixtures/transport-v2.mjs";
import { prepareTransportContext } from "../apps/domains/transport-context.js";
import { legacyTransportServiceId, transportServicesShareFleet } from "../engines/transport/service-identity.js";
import { planTransportChain } from "../engines/transport/planner.js";

const previous = globalThis.game;
globalThis.game = { user: { id: "gm", isGM: true }, settings: { get() {} }, modules: new Map() };
const region = (value, links = []) => ({ value, label: value, countryId: "public", marketTransportModes: ["airship"],
  marketLinks: links.map(([regionId, distanceKm]) => ({ regionId, distanceKm, modes: ["airship"] })) });
try {
  for (const isGM of [true, false]) for (const direction of ["inbound", "outbound"]) {
    const f = transportFixture();
    f.data.catalog.eventRegions = [region("home", [["short", 20], ["long", 80]]), region("short", [["a", 20]]), region("long", [["a", 80]]), region("a")];
    const request = transportRequest(f, "a", { direction }, isGM);
    const preview = prepareTransportContext({ ...f, request, isGM });
    assert.deepEqual(preview.services.map(s => s.distanceKm).sort((a, b) => a - b), [40, 40, 160, 160]);
    assert.equal(new Set(preview.services.map(s => s.id)).size, 4);
    assert.equal(preview.search.limited, false);
    assert.equal(preview.plan.stages[0].service.distanceKm, 40);
    const fixed = structuredClone(f.data);
    for (const from of fixed.catalog.eventRegions) for (const edge of from.marketLinks) edge.routeId = `${from.value}-${edge.regionId}`;
    const control = prepareTransportContext({ data: fixed, holding: fixed.holdings[0], request, isGM });
    assert.equal(preview.plan.totalCopper, control.plan.totalCopper);
    assert.equal(preview.plan.arrivalQd, control.plan.arrivalQd);
    for (const kind of ["regular", "charter"]) {
      const [short, long] = preview.services.filter(s => s.kind === kind).sort((a, b) => a.distanceKm - b.distanceKm);
      const oldId = legacyTransportServiceId(short.id);
      assert.equal(oldId, legacyTransportServiceId(long.id), "the previous ID collided on these real paths");
      assert.equal(transportServicesShareFleet(short.id, long.id), false);
      const cargo = preview.plan.stages[0].runs.flatMap(run => run.cargo);
      const first = planTransportChain({ cargo, services: [short], startQd: 0 });
      const oldRun = { ...first.stages[0].runs[0], serviceId: oldId };
      const held = planTransportChain({ cargo, services: [short], startQd: 0, runs: [oldRun] });
      assert.ok(held.stages[0].runs[0].departureQd > oldRun.departureQd, "accepted legacy bookings conservatively occupy the successor fleet");
      const independent = planTransportChain({ cargo, services: [long], startQd: 0, runs: first.stages[0].runs });
      assert.equal(independent.stages[0].runs[0].startQd, planTransportChain({ cargo, services: [long], startQd: 0 }).stages[0].runs[0].startQd);
      f.data.catalog.transportV2.overrides = { [oldId]: { riskBps: 700 }, [short.id]: { riskBps: 900 } };
      const inherited = prepareTransportContext({ ...f, request, isGM });
      assert.equal(inherited.services.find(s => s.id === short.id).riskBps, 900);
      assert.equal(inherited.services.find(s => s.id === long.id).riskBps, 700);
      assert.throws(() => prepareTransportContext({ ...f, request: { ...request, serviceIds: [oldId] }, isGM }), /нескольким физическим/);
      const excluded = prepareTransportContext({ ...f, request: { ...request, excluded: [oldId] }, isGM });
      assert.ok(excluded.plan.stages.every(stage => stage.service.kind !== kind));
      const unique = structuredClone(f.data);
      unique.catalog.eventRegions.find(r => r.value === "home").marketLinks = [{ regionId: "short", distanceKm: 20, modes: ["airship"] }];
      unique.catalog.eventRegions = unique.catalog.eventRegions.filter(r => r.value !== "long");
      const recovered = prepareTransportContext({ data: unique, holding: unique.holdings[0], request: { ...request, serviceIds: [oldId] }, isGM });
      assert.equal(recovered.plan.stages[0].service.id, short.id, "unambiguous legacy UI selections are recovered without changing the saved request");
    }
    f.data.catalog.transportV2.overrides = {};
    const h = transportHarness(f), { operation, order } = await h.book(request, `identity-${direction}-${isGM}`, isGM);
    const accepted = structuredClone(order.plan);
    h.advance(order.plan.arrivalQd);
    assert.equal(order.status, "delivered");
    assert.equal(order.plan.stages[0].service.distanceKm, 40);
    assert.deepEqual(order.plan, accepted, "execution preserves the accepted physical route");
    const saved = JSON.stringify(h.data);
    assert.equal((await h.execute(operation, { userId: isGM ? "gm" : "player", remote: !isGM })).replay, true);
    assert.equal(JSON.stringify(h.data), saved);
  }
  console.log("Transport route identity: unnamed physical alternatives, correct quote/execution, inherited overrides, old booking capacity, selection recovery, exclusions and GM/player replay passed.");
} finally { globalThis.game = previous; }
