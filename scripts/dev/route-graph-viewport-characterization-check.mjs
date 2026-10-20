import assert from "node:assert/strict";
import { MODULE_ID, SETTING_ROUTE_GRAPH_VIEW } from "../data/constants.js";
import {
  normalizeRouteGraphViewport,
  readRouteGraphViewport,
  routeGraphViewportsEqual,
  writeRouteGraphViewport
} from "../apps/editors/route-graph-viewport.js";

const map = { worldWidth: 1200, worldHeight: 700, centerX: 600, centerY: 350, zoom: 1 };
const writes = [];
const settings = {
  get(moduleId, key) {
    assert.equal(moduleId, MODULE_ID);
    assert.equal(key, SETTING_ROUTE_GRAPH_VIEW);
    return { centerX: 5000, centerY: -20, zoom: 10 };
  },
  async set(moduleId, key, value) {
    writes.push({ moduleId, key, value });
  }
};

assert.deepEqual(readRouteGraphViewport(map, settings), { centerX: 1200, centerY: 0, zoom: 4 }, "stored viewport must be clamped to the current map");
assert.deepEqual(normalizeRouteGraphViewport({}, map), { centerX: 600, centerY: 350, zoom: 1 }, "an empty client setting must inherit the semantic map default");
assert.equal(routeGraphViewportsEqual({ centerX: 1, centerY: 2, zoom: 3 }, { centerX: 1, centerY: 2, zoom: 3 }), true, "equal viewport snapshots must be recognized as no-ops");
assert.equal(routeGraphViewportsEqual({ centerX: 1, centerY: 2, zoom: 3 }, { centerX: 2, centerY: 2, zoom: 3 }), false, "changed viewport snapshots must remain observable");
assert.equal(await writeRouteGraphViewport({ centerX: 10, centerY: 20, zoom: 2 }, map, settings), true, "client viewport write must report success");
assert.deepEqual(writes, [{ moduleId: MODULE_ID, key: SETTING_ROUTE_GRAPH_VIEW, value: { centerX: 10, centerY: 20, zoom: 2 } }], "viewport writes must target only the dedicated client setting");

console.log("FBL Skyhold route graph viewport: client scope, clamping and no-op equality passed.");
