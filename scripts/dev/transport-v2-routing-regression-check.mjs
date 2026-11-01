import assert from "node:assert/strict";
import { transportFixture, transportRequest, transportHarness } from "./fixtures/transport-v2.mjs";
import { prepareTransportContext } from "../apps/domains/transport-context.js";
import { shortestMarketRoute } from "../engines/market/logistics.js";
import { buildShipWorldContext, worldShipTransportTerms } from "../engines/ships/world-market.js";
import { planTransportChain } from "../engines/transport/planner.js";
import { bookTransportOrder, advanceTransportOrders } from "../engines/transport/runtime.js";
import { validateTransportConfiguration } from "../engines/transport/services.js";
import { TRANSPORT_LIMITS } from "../engines/transport/quantities.js";
import { pruneCompletedTransportRuns } from "../data/transport/state.js";
import { deleteHoldingFromData } from "../data/holding-operations.js";

// Local ownership must cover pickup, indivisible loads, empty shuttles, staying
// at the local market and an explicit final return, for both authority callers.
for (const isGM of [true, false]) for (const direction of ["inbound", "outbound"]) for (const returnHome of [false, true]) {
  const f = transportFixture(); f.holding.type = "sky-island"; f.ship.capacityLoadPoints = 20;
  const request = transportRequest(f, "home", { direction, ownShipId: f.ship.id, returnHome }, isGM);
  const harness = transportHarness(f);
  const { preview, operation, order } = await harness.book(request, `local-${isGM}-${direction}-${returnHome}`, isGM);
  const stages = preview.plan.stages;
  assert.equal(stages.length, 1); assert.equal(stages[0].service.kind, "owned");
  assert.equal(stages[0].runs.length, 2, "two loads require two physical trips");
  assert.ok(stages[0].service.returnQd > 0, "empty local shuttles are neither instantaneous nor free");
  assert.ok(stages[0].service.handlingFlatCopper > 0, "the local market charges its handling table");
  assert.equal(stages[0].service.approachQd > 0, direction === "inbound");
  const before = structuredClone(harness.data);
  assert.ok((await harness.execute(operation, { userId: isGM ? "gm" : "player", remote: !isGM })).replay);
  assert.deepEqual(harness.data, before);
  harness.advance(preview.plan.shipReleaseQd);
  assert.equal(order.status, "delivered"); assert.equal(order.received.reduce((sum, lot) => sum + lot.qty, 0), 10);
  assert.equal(harness.ship.location.kind, direction === "outbound" && !returnHome ? "market" : "home");
  assert.equal(harness.ship.location.regionId, "home"); assert.equal(harness.ship.transportOrderId, undefined);
  assert.equal(order.ownedActualCopper, preview.plan.ownExpensesCopper);
}

// Keeping only a shortest prefix loses the valid lower-access alternative at
// an intermediate junction, not just on two parallel direct edges.
{
  const regions = [
    { value: "start", marketLinks: [{ regionId: "join", distanceKm: 10, ursCost: 3 }, { regionId: "via", distanceKm: 20, ursCost: 1 }] },
    { value: "via", marketLinks: [{ regionId: "join", distanceKm: 20, ursCost: 1 }] },
    { value: "join", marketLinks: [{ regionId: "end", distanceKm: 10, ursCost: 1 }] }, { value: "end", marketLinks: [] }
  ].map(region => ({ ...region, marketTransportModes: ["airship"], marketLinks: region.marketLinks.map(link => ({ ...link, modes: ["airship"] })) }));
  assert.equal(shortestMarketRoute("start", "end", regions, { mode: "airship" }).distanceKm, 20);
  const constrained = shortestMarketRoute("start", "end", regions, { mode: "airship", maxAccess: 3 });
  assert.equal(constrained.distanceKm, 50); assert.equal(constrained.accessCost, 3);
  assert.equal(shortestMarketRoute("start", "end", regions, { mode: "airship", maxAccess: 2 }), null);
}
// Independent exhaustive oracle on small graphs, including paths whose
// shorter prefix consumes too much access for the remaining journey.
for (let seed = 1; seed <= 12; seed++) {
  let value = seed;
  const random = () => ((value = (Math.imul(value, 1664525) + 1013904223) >>> 0) / 4294967296);
  const regions = Array.from({ length: 6 }, (_, i) => ({ value: String(i), marketTransportModes: ["airship"], marketLinks: [] }));
  const edges = regions.map(() => []);
  for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) {
    if (j !== i + 1 && random() > 0.4) continue;
    const edge = { distanceKm: 10 + Math.floor(random() * 80), ursCost: 1 + Math.floor(random() * 3), modes: ["airship"] };
    regions[i].marketLinks.push({ ...edge, regionId: String(j) });
    edges[i].push({ ...edge, to: j }); edges[j].push({ ...edge, to: i });
  }
  for (let budget = 1; budget <= 6; budget++) {
    let best = Infinity;
    const visit = (node, access, distance, seen) => {
      if (access > budget) return;
      if (node === 5) { best = Math.min(best, distance); return; }
      for (const edge of edges[node]) if (!seen.has(edge.to)) visit(edge.to, access + edge.ursCost,
        distance + edge.distanceKm, new Set([...seen, edge.to]));
    };
    visit(0, 0, 0, new Set([0]));
    const route = shortestMarketRoute("0", "5", regions, { mode: "airship", maxAccess: budget });
    assert.equal(route?.distanceKm ?? Infinity, best, `constrained shortest path: seed ${seed}, access ${budget}`);
  }
}
for (const isGM of [true, false]) {
  const f = transportFixture(); f.holding.gm.modifiers.marketConnectionsLevel = 2;
  f.data.catalog.eventRegions = [
    { value: "home", marketTransportModes: ["airship"], marketLinks: [
      { regionId: "a", routeId: "short", distanceKm: 10, ursCost: 3, modes: ["airship"] },
      { regionId: "via", routeId: "detour-1", distanceKm: 40, ursCost: 1, modes: ["airship"] }] },
    { value: "via", marketTransportModes: ["caravan"], marketLinks: [
      { regionId: "a", routeId: "detour-2", distanceKm: 40, ursCost: 1, modes: ["airship"] }] },
    { value: "a", marketTransportModes: ["airship"], marketLinks: [] }
  ].map(region => ({ label: region.value, countryId: "public", ...region }));
  const request = transportRequest(f, "a", { ownShipId: f.ship.id }, isGM);
  const { preview } = await transportHarness(f).book(request, `access-${isGM}`, isGM);
  const service = preview.plan.stages[0].service;
  assert.equal(service.accessCost, 2); assert.equal(service.approachAccessCost, 2);
  assert.equal(service.returnAccessCost, 2); assert.equal(service.endReturnAccessCost, 0);
}

for (const isGM of [true, false]) {
  const f = transportFixture();
  f.data.catalog.eventRegions[0].marketLinks = ["north", "south"].map(routeId => ({ regionId: "a", distanceKm: 150, modes: ["airship"], routeId }));
  const request = transportRequest(f, "a", {}, isGM);
  const initial = prepareTransportContext({ ...f, request, isGM });
  const regular = initial.services.filter(service => service.kind === "regular");
  assert.equal(regular.length, 2, "both physical routes must reach schedule-aware planning");
  const occupied = planTransportChain({ cargo: [{ lotId: "full", qty: 1, unitLoad: regular[0].capacity, unitCopper: 1 }], services: [regular[0]] });
  bookTransportOrder({ state: f.data.meta.transportV2, holding: { id: "other", storage: { moneyCopper: 1000000 }, special: {} },
    id: "occupied", direction: "inbound", services: [regular[0]], plan: occupied });
  const chosen = prepareTransportContext({ ...f, request, isGM });
  assert.equal(chosen.plan.arrivalQd, initial.plan.arrivalQd); assert.equal(chosen.plan.totalCopper, initial.plan.totalCopper);
  assert.equal(chosen.plan.stages[0].service.id, regular[1].id);
  const pinned = prepareTransportContext({ ...f, request: { ...request, serviceIds: [regular[0].id] }, isGM });
  assert.ok(pinned.plan.arrivalQd > chosen.plan.arrivalQd, "an explicitly selected occupied road still keeps its own timetable");
}

for (const isGM of [true, false]) for (const direction of ["inbound", "outbound"]) {
  const f = transportFixture(); f.holding.gm.modifiers.marketConnectionsLevel = 3;
  f.data.catalog.eventRegions = [
    { value: "home", marketTransportModes: ["airship"], marketLinks: [
      { regionId: "a", distanceKm: 10, ursCost: 3, modes: ["airship"] },
      { regionId: "via", distanceKm: 40, ursCost: 1, modes: ["airship"] }] },
    { value: "via", marketTransportModes: ["caravan"], marketLinks: [{ regionId: "a", distanceKm: 40, ursCost: 1, modes: ["airship"] }] },
    { value: "a", marketTransportModes: ["airship", "caravan"], marketLinks: [{ regionId: "b", distanceKm: 40, ursCost: 1, modes: ["caravan"] }] },
    { value: "b", marketTransportModes: ["caravan"], marketLinks: [] }
  ].map(region => ({ label: region.value, countryId: "public", ...region }));
  const request = transportRequest(f, "b", { direction, ownShipId: f.ship.id, returnHome: true }, isGM);
  const harness = transportHarness(f);
  const { preview: { plan }, order } = await harness.book(request, `mixed-access-${direction}-${isGM}`, isGM);
  assert.equal(plan.stages.find(stage => stage.service.kind === "owned").service.accessCost, 2);
  assert.equal(plan.stages.reduce((sum, stage) => sum + stage.service.accessCost, 0), 3,
    "the own leg must leave enough access for the connecting hired leg");
  harness.advance(Math.max(plan.shipReleaseQd, plan.arrivalQd));
  assert.equal(order.status, "delivered"); assert.equal(order.shipReleased, true);
}

{
  const f = transportFixture(); f.data.catalog.transportV2.riskBps = 300;
  const request = transportRequest(f, "a", { ownShipId: f.ship.id });
  const before = prepareTransportContext({ ...f, request, isGM: true });
  f.data.catalog.eventRegions.find(region => region.value === "a").marketRiskFactor = 4;
  const after = prepareTransportContext({ ...f, request, isGM: true });
  assert.equal(before.plan.stages[0].service.riskBps, 300);
  assert.equal(after.plan.stages[0].service.riskBps, 1200, "environment applies without the independent carrier's risk surcharge");
  f.data.catalog.eventRegions[0].marketLinks[0].seasonalModifiers = { winter: { enabled: true, riskFactor: 2, timeFactor: 1, costFactor: 1 } };
  const context = buildShipWorldContext(f.data, f.holding); context.seasonId = "winter";
  assert.equal(worldShipTransportTerms(f.data, f.holding, f.ship, "home", "a", { context }).riskFactor, 8);
}

{
  for (const vehicles of [1, 1001, TRANSPORT_LIMITS.vehicles]) {
    const config = validateTransportConfiguration({ charterVehicles: vehicles });
    const service = { id: "charter", kind: "charter", from: "a", to: "b", capacity: 10, travelQd: 4, vehicles: config.charterVehicles };
    assert.equal(planTransportChain({ cargo: [{ lotId: "cargo", qty: 1, unitLoad: 1, unitCopper: 1 }], services: [service] }).arrivalQd, 4);
  }
  assert.throws(() => validateTransportConfiguration({ charterVehicles: TRANSPORT_LIMITS.vehicles + 1 }), /число машин/);
  const service = { id: "regular", kind: "regular", from: "a", to: "b", firstQd: 4, intervalQd: 40, capacity: 10, travelQd: 4 };
  const full = planTransportChain({ cargo: [{ lotId: "full", qty: 1, unitLoad: 10, unitCopper: 1 }], services: [service] });
  const mixed = planTransportChain({ cargo: [
    { lotId: "heavy", qty: 1, unitLoad: 1, unitCopper: 1 }, { lotId: "zero", qty: 2, unitLoad: 0, unitCopper: 1 }
  ], services: [service], runs: full.stages[0].runs });
  assert.equal(mixed.stages[0].runs[0].arrivalQd, full.arrivalQd);
  assert.deepEqual(mixed.stages[0].runs[0].cargo.map(lot => lot.lotId), ["zero"]);
  assert.equal(mixed.stages[0].runs[1].arrivalQd, full.arrivalQd + service.intervalQd);
}

{
  const data = { meta: { transportV2: { version: 2, clockQd: 0, runs: [] } }, holdings: [] }, state = data.meta.transportV2;
  const service = { id: "shared", kind: "regular", from: "a", to: "b", capacity: 100, firstQd: 4, intervalQd: 40, travelQd: 4 };
  for (const id of ["a", "b"]) {
    const holding = { id, storage: { moneyCopper: 1000 }, special: {} }; data.holdings.push(holding);
    bookTransportOrder({ state, holding, services: [service], id, direction: "inbound",
      plan: planTransportChain({ cargo: [{ lotId: id, qty: 1, unitLoad: 1, unitCopper: 1 }], services: [service], runs: state.runs }) });
  }
  const advance = (holding, targetQd) => advanceTransportOrders({ state, holding, targetQd, dependencies: { receiveCargo() {} } });
  advance(data.holdings[0], 8);
  const lagging = structuredClone(data.holdings[1]);
  deleteHoldingFromData(data, "a");
  assert.deepEqual(data.holdings[0], lagging); assert.equal(state.runs.length, 1);
  assert.deepEqual(state.runs[0].claims.map(claim => claim.holdingId), ["b"]);
  advance(data.holdings[0], 80); pruneCompletedTransportRuns(data); assert.equal(state.runs.length, 0);
  state.runs.push({ id: "unknown", status: "arrived", releaseQd: 0, claims: [{ holdingId: "missing", orderId: "missing" }] });
  pruneCompletedTransportRuns(data); assert.equal(state.runs.length, 1, "unknown references keep their recovery protection");
}
console.log("Transport routing regressions: local GM/player lifecycle, constrained paths/empty legs, physical alternatives, environmental risk, vehicle limits, zero load and completed-owner deletion passed.");
