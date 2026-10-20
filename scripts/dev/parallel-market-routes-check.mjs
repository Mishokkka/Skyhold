import assert from "node:assert/strict";
import { normalizeEventRegionOptions, MAX_MARKET_LINKS_PER_REGION } from "../data/random-events.js";
import {
  removeRouteEdge,
  routeEdgeKey,
  upsertRouteEdge
} from "../apps/editors/route-graph-model.js";
import {
  marketRegionAccessCostMap,
  shortestMarketRoute
} from "../engines/market/logistics.js";

const normalized = normalizeEventRegionOptions([{
  value: "alpha",
  label: "Alpha",
  marketLinks: [
    { regionId: "beta", distanceKm: 120, ursCost: 7, modes: ["airship"] },
    { regionId: "beta", distanceKm: 999, ursCost: 99, modes: ["rail"] },
    { regionId: "beta", routeId: "air-fast", distanceKm: 80, ursCost: 5, modes: ["airship"] },
    { regionId: "beta", routeId: "air-cheap", distanceKm: 160, ursCost: 2, modes: ["airship"] },
    { regionId: "beta", routeId: "rail-main", distanceKm: 200, ursCost: 1, modes: ["rail"] },
    { regionId: "beta", routeId: "air-fast", distanceKm: 2, ursCost: 1, modes: ["rail"] }
  ]
}, {
  value: "beta",
  label: "Beta",
  marketLinks: []
}], { fallback: false });

assert.equal(normalized[0].marketLinks.length, 4, "normalization must retain one legacy route and each distinct routeId");
assert.equal(normalized[0].marketLinks[0].distanceKm, 120, "the first legacy route must retain historical first-entry semantics");
assert.deepEqual(
  normalized[0].marketLinks.map((link) => link.routeId ?? ""),
  ["", "air-fast", "air-cheap", "rail-main"],
  "normalization must preserve optional route identities without assigning one to legacy data"
);
const normalizedAgain = normalizeEventRegionOptions(normalized, { fallback: false });
assert.deepEqual(normalizedAgain, normalized, "parallel route normalization must be stable on round-trip");
const cappedRouteId = normalizeEventRegionOptions([{
  value: "cap",
  marketLinks: [{ regionId: "beta", routeId: "x".repeat(160) }]
}], { fallback: false })[0].marketLinks[0].routeId;
assert.equal(cappedRouteId.length, 128, "routeId must respect the approved storage limit");

assert.equal(routeEdgeKey("beta", "alpha"), "alpha::beta", "legacy route keys must remain unchanged");
assert.equal(routeEdgeKey("beta", "alpha", "air-fast"), "alpha::beta::air-fast", "parallel route keys must include routeId");

const editable = structuredClone(normalized);
assert.equal(upsertRouteEdge(editable, "alpha", "beta", {
  routeId: "air-cheap",
  distanceKm: 150,
  ursCost: 3,
  modes: ["airship"]
}), true);
assert.equal(editable[0].marketLinks.find((link) => link.routeId === "air-cheap")?.distanceKm, 150, "upsert must update the selected parallel route");
assert.equal(editable[0].marketLinks.find((link) => link.routeId === "air-fast")?.distanceKm, 80, "upsert must leave sibling routes unchanged");
assert.equal(editable[0].marketLinks.find((link) => link.routeId === "rail-main")?.distanceKm, 200, "upsert must not mix rail and air route properties");
removeRouteEdge(editable, "alpha", "beta", "air-fast");
assert.equal(editable[0].marketLinks.some((link) => link.routeId === "air-fast"), false, "delete must remove only the selected routeId");
assert.equal(editable[0].marketLinks.length, 3, "delete must preserve legacy and sibling parallel routes");

const reverseEditable = [
  { value: "alpha", marketLinks: [] },
  { value: "beta", marketLinks: [{ regionId: "alpha", routeId: "reverse", pathPoints: [{ x: 9, y: 8 }, { x: 5, y: 4 }], modes: ["rail"], distanceKm: 40, ursCost: 1 }] }
];
upsertRouteEdge(reverseEditable, "alpha", "beta", { routeId: "reverse", ursCost: 2 });
assert.deepEqual(reverseEditable[0].marketLinks[0].pathPoints, [{ x: 5, y: 4 }, { x: 9, y: 8 }], "moving a reverse record to the selected orientation must reverse its path geometry");
assert.equal(reverseEditable[1].marketLinks.length, 0, "upsert must collapse the reverse record for only the selected route");

const logisticsRegions = [
  {
    value: "alpha",
    marketLinks: [
      { regionId: "beta", distanceKm: 200, ursCost: 8, modes: ["airship"] },
      { regionId: "beta", routeId: "air-fast", distanceKm: 80, ursCost: 5, modes: ["airship"] },
      { regionId: "beta", routeId: "air-cheap", distanceKm: 160, ursCost: 2, modes: ["airship"] },
      { regionId: "beta", routeId: "rail-main", distanceKm: 220, ursCost: 1, modes: ["rail"] }
    ]
  },
  {
    value: "beta",
    marketLinks: [
      { regionId: "alpha", routeId: "air-fast", distanceKm: 1, ursCost: 1, modes: ["rail"] }
    ]
  }
];
const fastestAir = shortestMarketRoute("alpha", "beta", logisticsRegions, { mode: "airship", metric: "distance" });
assert.equal(fastestAir.distanceKm, 80, "air routing must choose the shortest matching parallel route");
assert.equal(fastestAir.edges[0].routeId, "air-fast", "shortest route results must retain the chosen route identity");
const cheapestAir = shortestMarketRoute("alpha", "beta", logisticsRegions, { mode: "airship", metric: "access" });
assert.equal(cheapestAir.accessCost, 2, "URS routing must independently choose the cheapest air route");
assert.equal(cheapestAir.edges[0].routeId, "air-cheap", "URS and distance must come from the same route record");
const rail = shortestMarketRoute("alpha", "beta", logisticsRegions, { mode: "rail", metric: "access" });
assert.equal(rail.distanceKm, 220, "rail routing must retain its own distance instead of borrowing from air routes");
assert.equal(rail.accessCost, 1, "rail routing must retain its own URS");
assert.equal(rail.edges[0].routeId, "rail-main", "a reverse duplicate of another route must not replace the canonical route");
const access = marketRegionAccessCostMap({ holding: { overview: { region: "alpha" } }, regions: logisticsRegions });
assert.equal(access.get("beta"), 1, "general market access must consider every parallel route");

const crowded = [{ value: "hub", marketLinks: Array.from({ length: MAX_MARKET_LINKS_PER_REGION }, (_, index) => ({
  regionId: "target", routeId: `route-${index}`, distanceKm: index + 1, modes: ["airship"]
})) }, { value: "target", marketLinks: [] }];
assert.equal(normalizeEventRegionOptions(crowded, { fallback: false })[0].marketLinks.length, MAX_MARKET_LINKS_PER_REGION);
const crowdedBefore = JSON.stringify(crowded);
assert.equal(upsertRouteEdge(crowded, "hub", "target", { routeId: "excess" }), false, "creation must not report success then silently truncate the new route");
assert.equal(JSON.stringify(crowded), crowdedBefore);
assert.equal(upsertRouteEdge(crowded, "hub", "target", { routeId: "route-5", distanceKm: 999 }), true, "existing routes remain editable at capacity");
console.log("FBL Skyhold parallel market routes: normalization, editing and logistics passed.");
