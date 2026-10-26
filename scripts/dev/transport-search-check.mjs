import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeEventRegionOptions } from "../data/random-events.js";
import { normalizeMarketOrganization } from "../data/market/economy.js";
import { marketTransportRoutes } from "../engines/market/route-candidates.js";
import { planMarketTransport } from "../engines/market/transport-planner.js";

function irrelevantBranchesCannotConsumeBudget() {
  const rows = Array.from({ length: 7 }, (_, index) => ({ value: `chain-${index}`, countryId: "A",
    marketTransportModes: ["caravan"], marketLinks: index < 6 ? [{ regionId: `chain-${index + 1}`, modes: ["caravan"], distanceKm: 40, ursCost: 1 }] : [] }));
  const branches = Array.from({ length: 13 }, (_, index) => `branch-${index}`);
  rows[0].marketLinks.push(...branches.map((regionId) => ({ regionId, modes: ["caravan"], distanceKm: 40, ursCost: 1 })));
  branches.forEach((value, index) => rows.push({ value, countryId: "A", marketTransportModes: ["caravan"],
    marketLinks: branches.slice(index + 1).map((regionId) => ({ regionId, modes: ["caravan"], distanceKm: 40, ursCost: 1 })) }));
  const company = normalizeMarketOrganization({ id: "one", active: true, visibility: "public", carrier: {
    enabled: true, modes: ["caravan"], countryShares: [{ countryId: "A", sharePct: 100 }] } });
  const result = planMarketTransport({
    holding: { id: "h", type: "village", overview: { region: "chain-0" } },
    market: { id: "m", regionId: "chain-6", countryId: "A", transportModes: ["caravan"] },
    regions: normalizeEventRegionOptions(rows, { fallback: false }), organizations: [company], isGM: true, accessLevel: 6
  });
  assert.equal(result.logistics.ok, true, "an irrelevant clique cannot exhaust the budget before a feasible six-link shipment is returned");
  assert.equal(result.logistics.routeCandidates.length, 1);
  assert.deepEqual(result.logistics.transportPlan.legs.map((leg) => leg.toRegionId),
    ["chain-5", "chain-4", "chain-3", "chain-2", "chain-1", "chain-0"]);
  assert.equal(result.logistics.transportPlan.distanceKm, 240);
}

const edge = (to, ursCost = 1) => ({ to, ursCost, distanceKm: 40 });
const tail = { carrier: { id: "tail", independent: false, capacity: 400, fare: 1 } };
function simpleSearch(graph, options = {}) {
  return marketTransportRoutes({ graph, from: "s", to: "t", maxAccess: 3,
    modesForEdge: () => ["caravan"], servicesForEdge: () => [tail],
    termsForEdge: (_edge, _mode, service) => ({ flat: 1, load: 0, operating: 0, time: 1, risk: 1,
      capacity: service.carrier.capacity, curves: { [service.carrier.capacity]: service.carrier.fare }, valueCost: 0 }),
    ...options });
}

function accessBoundIsOptimisticAndDirected() {
  const graph = new Map([["s", [edge("a", 0), edge("unavailable", 0)]], ["a", [edge("t", 2)]],
    ["unavailable", [edge("t", 0)]], ["t", []]]);
  const result = simpleSearch(graph, { maxAccess: 2,
    servicesForEdge: (from, route) => from === "unavailable" || route.to === "unavailable" ? [] : [tail] });
  assert.equal(result.limited, false);
  assert.deepEqual(result.routes.map((route) => route.path), [["s", "a", "t"]],
    "unavailable zero-access links can lower a bound, but cannot eliminate the valid directed route");
  assert.equal(simpleSearch(graph, { maxAccess: 1, servicesForEdge: (from, route) => from === "unavailable" || route.to === "unavailable" ? [] : [tail] }).routes.length, 0);
}

function heterogeneousBillingCurves() {
  const graph = new Map([["s", [edge("x")]], ["x", [edge("j")]], ["j", [edge("t")]], ["t", []]]);
  const wide = { carrier: { id: "wide", independent: false, capacity: 8000, fare: 100 } };
  for (const capacity of [1, 50, 400]) {
    const small = { carrier: { id: "small", independent: false, capacity: 400, fare: 110 } };
    const final = { carrier: { id: "tail", independent: false, capacity, fare: 1 } };
    const result = simpleSearch(graph, { servicesForEdge: (from) => from === "s" ? [wide, small] : from === "j" ? [final] : [tail] });
    assert.equal(result.routes.length, 1, "a pointwise cheaper curve can dominate despite using a different vehicle capacity");
    assert.equal(result.routes[0].edges[0].service.carrier.id, "wide");
    assert.equal(result.routes[0].capacity, capacity, "the proof remains valid after a smaller future bottleneck");
  }
  const crossing = { carrier: { id: "small", independent: false, capacity: 400, fare: 50 } };
  const result = simpleSearch(graph, { servicesForEdge: (from) => from === "s" ? [wide, crossing] : [tail] });
  assert.equal(result.routes.length, 2, "crossing booking-floor curves and charter choices must both survive");
  const fare = (route, load, charter = false) => route.edges.reduce((sum, part) => {
    const { capacity, fare: full } = part.service.carrier;
    return sum + full * (charter ? 1 : Math.max(load / capacity, 0.02));
  }, 0);
  const cheapest = (load, charter = false) => [...result.routes].sort((a, b) => fare(a, load, charter) - fare(b, load, charter))[0].edges[0].service.carrier.id;
  assert.equal(cheapest(1), "small");
  assert.equal(cheapest(400), "wide");
  assert.equal(cheapest(400, true), "small", "charter compares whole fares separately from occupied shares");
}

function distancePreservesFutureWeightedFreight() {
  const graph = new Map([["s", [{ ...edge("x"), routeId: "short", distanceKm: 40 },
    { ...edge("x"), routeId: "long", distanceKm: 80 }]], ["x", [edge("t")]], ["t", []]]);
  const result = simpleSearch(graph, { termsForEdge: (part) => ({ flat: 1, load: 0, operating: 0, time: 1, risk: 1,
    capacity: 400, curves: { 400: 1 }, valueCost: part.to === "x" ? part.distanceKm : 80 }) });
  assert.equal(result.routes.length, 2, "equal-cost prefixes of different lengths cannot be merged before a later freight factor is known");
  const factors = result.routes.map((route) => route.valueCost / route.distanceKm).sort((a, b) => a - b);
  assert.equal(factors[0], 4 / 3);
  assert.equal(factors[1], 1.5, "the longer prefix dilutes an expensive later leg differently");
}

export function checkTransportSearch() {
  irrelevantBranchesCannotConsumeBudget(); accessBoundIsOptimisticAndDirected(); heterogeneousBillingCurves(); distancePreservesFutureWeightedFreight();
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkTransportSearch();
  console.log("Transport search: feasible route beyond irrelevant branches, directed access bounds, heterogeneous billing curves, booking floors and charter alternatives passed.");
}
