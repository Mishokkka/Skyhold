import assert from "node:assert/strict";
import fs from "node:fs";
import { performance } from "node:perf_hooks";

globalThis.foundry = { applications: { api: {
  ApplicationV2: class { async _prepareContext() { return {}; } },
  HandlebarsApplicationMixin: (Base) => Base
} } };
const { SkyholdRouteGraphEditor, compareRouteRows, graphContext } = await import("../apps/editors/route-graph-editor.js");
const rows = [
  { value: "a", label: "Alpha", marketMapX: 100, marketMapY: 100, marketLinks: [
    { regionId: "b", distanceKm: 150, modes: ["airship"] },
    { regionId: "b", routeId: "rail", distanceKm: 240, ursCost: 2, modes: ["rail"] },
    { regionId: "b", routeId: "air2", distanceKm: 190, modes: ["airship"] }
  ] },
  { value: "b", label: "Beta", marketMapX: 400, marketMapY: 100, marketLinks: [
    { regionId: "a", routeId: "rail", distanceKm: 999, modes: ["rail"] }
  ] }
];
const map = { worldWidth: 1000, worldHeight: 600 };
const graph = graphContext(rows, "", map);
assert.equal(graph.edges.length, 3);
assert.equal(new Set(graph.edges.map((edge) => edge.key)).size, 3);
assert.equal(new Set(graph.edges.map((edge) => edge.pointsText)).size, 3, "parallel straight lines must be independently selectable");
assert.deepEqual(graph.edges.map((edge) => edge.distanceKm), [150, 240, 190], "display separation never changes journey lengths");

const app = new SkyholdRouteGraphEditor();
const data = { meta: { revision: 1 }, catalog: { eventRegions: rows, marketRouteMap: map } };
const first = app._graphForView(data);
const cache = app._graphCache;
first.edges[0].distanceKm = 999;
app.selectedNodeId = "b";
assert.equal(app._graphForView(data).selectedNode.value, "b");
assert.equal(app._graphForView(data).edges[0].distanceKm, 150, "view changes must not contaminate cached geometry");
assert.equal(app._graphCache, cache);
data.meta.revision++;
rows[0].marketLinks[0].distanceKm = 160;
assert.equal(app._graphForView(data).edges[0].distanceKm, 160);
assert.notEqual(app._graphCache, cache, "saved catalog changes invalidate cache");
const oldSeasonCache = app._graphCache;
app._graphForView(data, "summer");
assert.notEqual(app._graphCache, oldSeasonCache);

let renders = 0;
app.requestRender = () => renders++;
const marker = { dataset: { regionId: "b" }, classList: { toggle: (_name, selected) => assert.equal(selected, true) } };
const hint = {};
const clear = {};
app.element = { querySelectorAll: () => [marker], querySelector: (selector) => selector.includes("instructions") ? hint : clear };
app._updateNodeSelection();
assert.equal(renders, 0);
assert.equal(clear.disabled, false);

const label = {};
app.view = { centerX: 700, centerY: 400, zoom: 2 };
app._canvas = { getBoundingClientRect: () => ({ width: 800, height: 600 }), scrollTop: 50, scrollLeft: 25 };
app._world = { style: {} };
app.element = { querySelector: () => label };
app._applyViewport();
assert.equal(app._world.style.transform, "translate3d(-1000px, -500px, 0) scale(2)");
assert.deepEqual(app.view, { centerX: 700, centerY: 400, zoom: 2 });
assert.equal(app._canvas.scrollTop, 0);
assert.equal(app._canvas.scrollLeft, 0);
let layoutReads = 0;
const wheelCanvas = { classList: { add() {}, remove() {} }, getBoundingClientRect: () => { layoutReads++; return { left: 0, top: 0, width: 800, height: 600 }; } };
app._canvas = wheelCanvas;
app._world = { dataset: { worldWidth: "1000", worldHeight: "600" } };
app._scheduleViewportFrame = () => {};
app._scheduleViewportPersist = () => {};
const wheel = { target: { closest: () => wheelCanvas }, clientX: 400, clientY: 300, deltaY: -50, preventDefault() {} };
const wheelRoot = { contains: () => true };
app._onWheel(wheel, wheelRoot);
app._onWheel(wheel, wheelRoot);
assert.equal(layoutReads, 1, "wheel bursts must measure the canvas once, not force layout every event");
clearTimeout(app._zoomEndTimer);

const line = (key, path = true) => ({ dataset: { routeKey: key }, style: {}, attrs: {},
  hasAttribute: () => path, setAttribute(name, value) { this.attrs[name] = value; } });
const air = line("a::b");
const rail = line("a::b::rail");
const railLabel = line("a::b::rail", false);
const status = {};
const undo = {};
app._pathEdit = { fromId: "a", toId: "b", routeId: "rail", points: [{ x: 230, y: 180 }] };
app.element = { querySelectorAll: () => [air, rail, railLabel], querySelector: (selector) => selector.includes("status") ? status : undo };
app._updatePathPreview();
assert.equal(rail.attrs.points, "100,100 230,180 400,100");
assert.deepEqual(air.attrs, {}, "editing a route must not move its sibling");
assert.equal(renders, 0, "adding draft points must not rebuild the whole window");
assert.match(status.textContent, /1/);

const listRows = graph.edges.map((edge) => ({ dataset: { routeKey: edge.key, routeModes: edge.modesText, routeEdgeSearchText: "Alpha Beta",
  routeFrom: edge.fromId, routeTo: edge.toId, routeDistance: String(edge.distanceKm), routeUrs: String(edge.ursCost), routeSeasonal: String(edge.seasonalEnabled) } }));
const root = { querySelectorAll: (selector) => selector === "[data-route-edge-row]" ? listRows : [air, rail, railLabel] };
app.routeSearch = "Beta";
app.routeModeFilter = "rail";
app._applyRouteFilters(root);
assert.equal(listRows.filter((row) => !row.hidden).length, 1);
assert.equal(rail.style.display, "");
assert.equal(air.style.display, "none");
assert.equal(railLabel.style.display, "");
app.routeDistanceFilter = "long";
app._applyRouteFilters(root);
assert.equal(listRows.filter((row) => !row.hidden).length, 0);
app.routeDistanceFilter = "medium";
app.routeRegionFilter = "a";
app._applyRouteFilters(root);
assert.equal(listRows.filter((row) => !row.hidden).length, 1);
app.routeRegionFilter = "other";
app._applyRouteFilters(root);
assert.equal(listRows.filter((row) => !row.hidden).length, 0);
app.routeRegionFilter = "";
app.routeModeFilter = "";
app.routeSeasonFilter = "enabled";
app._applyRouteFilters(root);
assert.equal(listRows.filter((row) => !row.hidden).length, 0);
app.routeSeasonFilter = "";
assert.deepEqual([...listRows].sort((a, b) => compareRouteRows(a, b, "distance-desc")).map((row) => row.dataset.routeDistance), ["240", "190", "150"]);

rail.dataset.routeFrom = "a";
rail.dataset.routeTo = "b";
app._dragState = { moved: true, regionId: "a", x: 120, y: 130, node: { style: { setProperty() {} } },
  incidentLines: [rail], incidentLabels: [{ label: railLabel, line: rail }],
  incidentGeometry: new Map([[rail, [{ x: 100, y: 100 }, { x: 400, y: 100 }]]]) };
rail.getAttribute = () => { throw new Error("pointer frames must not reparse SVG point strings"); };
app._applyNodeDragFrame();
assert.equal(rail.attrs.points, "120,130 400,100");
assert.equal(renders, 0);

for (const file of ["templates/route-graph-editor.hbs", "templates/route-edge-editor.hbs"]) {
  const source = fs.readFileSync(file, "utf8");
  for (const tag of source.match(/<[^>]*data-route-from[^>]*>/g) ?? []) {
    assert.match(tag, /data-route-id=/, "every route control must carry its identity");
  }
}
const template = fs.readFileSync("templates/route-graph-editor.hbs", "utf8");
assert.match(template, /transform: \{\{graph.viewportTransform\}\}/, "replacement markup must retain viewport before the next frame");
assert.match(template, /data-render-scroll-key="route-edge-list"/);
const largeRows = Array.from({ length: 69 }, (_, index) => ({ value: `region-${index}`, label: `Порт ${index}`,
  marketMapX: 100 + index * 10, marketMapY: 200,
  marketLinks: ["airship", "rail", "caravan"].map((mode) => ({ regionId: `region-${(index + 1) % 69}`,
    routeId: `${index}-${mode}`, modes: [mode], distanceKm: 150, pathPoints: [{ x: 200, y: 250 }] })) }));
const largeData = { meta: { revision: 1 }, catalog: { eventRegions: largeRows, marketRouteMap: map } };
const start = performance.now();
for (let index = 0; index < 20; index++) graphContext(largeRows, "", map);
const coldMs = performance.now() - start;
app._graphForView(largeData);
const warmStart = performance.now();
for (let index = 0; index < 20; index++) app._graphForView(largeData);
console.log(`Route editor passed: route identity, geometry, cached views, filters, draft editing, viewport and controls. 69 nodes / 207 routes, 20 preparations: rebuild ${coldMs.toFixed(1)}ms, cached ${(performance.now() - warmStart).toFixed(1)}ms.`);
