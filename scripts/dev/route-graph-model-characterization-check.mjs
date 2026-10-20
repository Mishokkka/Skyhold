import assert from "node:assert/strict";
import {
  normalizeRoutePathPoints,
  recalculateScaledRouteDistances,
  removeRouteEdge,
  routeEdgeKey,
  routePolylineMidpoint,
  upsertRouteEdge
} from "../apps/editors/route-graph-model.js";

assert.equal(routeEdgeKey("beta", "alpha"), "alpha::beta", "route keys must be direction-independent");
assert.deepEqual(
  normalizeRoutePathPoints([{ x: -10, y: 1200 }, { x: 40, y: 50 }], { worldWidth: 1000, worldHeight: 600 }),
  [{ x: 0, y: 600 }, { x: 40, y: 50 }],
  "route control points must be clamped to map bounds"
);
assert.deepEqual(routePolylineMidpoint([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]), { x: 10, y: 0 }, "polyline midpoint must follow path length");

const regions = [
  { value: "alpha", marketMapX: 100, marketMapY: 100, marketLinks: [] },
  { value: "beta", marketMapX: 400, marketMapY: 100, marketLinks: [] }
];
assert.equal(upsertRouteEdge(regions, "alpha", "beta", { distanceKm: 20, distanceMode: "scaled", modes: ["rail", "invalid"], ursCost: 3 }), true);
assert.deepEqual(regions[0].marketLinks[0].modes, ["rail"], "edge commands must discard unknown transport modes");
assert.equal(regions[0].marketLinks[0].ursCost, 3, "edge commands must preserve editable URS difficulty");
recalculateScaledRouteDistances(regions, { worldWidth: 1000, worldHeight: 600, kmPerPixel: 2 });
assert.equal(regions[0].marketLinks[0].distanceKm, 600, "scaled edge distance must follow map calibration");
removeRouteEdge(regions, "alpha", "beta");
assert.equal(regions[0].marketLinks.length, 0, "edge removal must remove the undirected connection");

console.log("FBL Skyhold route graph model: geometry, commands and scaled distance passed.");
