import assert from "node:assert/strict";
import { mixedMarketRouteFixture } from "./fixtures/mixed-market-route.mjs";
import { exportRouteNetwork, parseRouteNetwork, mergeRouteNetwork } from "../apps/editors/route-network-transfer.js";
import { authorityMarketLogistics } from "../apps/market/authority-context.js";
import { checkCalendariaCharacterization } from "./calendaria-characterization-check.mjs";
import { normalizeEventRegionOptions } from "../data/random-events.js";
import { SkyholdData } from "../data/store.js";

globalThis.foundry = { applications: { api: {
  ApplicationV2: class {}, HandlebarsApplicationMixin: (Base) => Base
} } };
const { graphContext, SkyholdRouteGraphEditor, SkyholdRouteEdgeEditor } = await import("../apps/editors/route-graph-editor.js");
const { SkyholdMarketApp } = await import("../apps/market-app.js");
const winter = { enabled: true, costFactor: 1.4, timeFactor: 1.25, riskFactor: 1.2 };
const rows = [
  { value: "a", label: "A", marketMapX: 100, marketMapY: 100, marketLinks: [
    { regionId: "b", routeId: "road", modes: ["caravan"], distanceKm: 80, seasonalModifiers: { winter } },
    { regionId: "b", routeId: "rail", modes: ["rail"], distanceKm: 120 } ] },
  { value: "b", label: "B", marketMapX: 400, marketMapY: 100, marketLinks: [] }
];
const catalog = { eventRegions: rows, marketRouteMap: { worldWidth: 1000, worldHeight: 600, kmPerPixel: 2 } };
const organizedCatalog = structuredClone(catalog); organizedCatalog.eventRegions[0].catalogFolder = "Мои гавани";
assert.equal(mergeRouteNetwork(organizedCatalog, exportRouteNetwork(catalog)).eventRegions[0].catalogFolder, "Мои гавани", "merging an older route map must not erase local folders");
const normalizedRows = normalizeEventRegionOptions(rows, { fallback: false });
assert.deepEqual(graphContext(normalizedRows, "", catalog.marketRouteMap, "winter", { normalizedRegions: true }).edges,
  graphContext(rows, "", catalog.marketRouteMap, "winter").edges,
  "already normalized market rows must produce the same route view without a second normalization pass");
const pausedDistance = graphContext([{ value: "a", label: "A", marketMapX: 100, marketMapY: 100, marketLinks: [
  { regionId: "b", distanceMode: "scaled", distanceKm: 120, modes: ["airship"] }
] }, { value: "b", label: "B", marketMapX: 400, marketMapY: 100 }], "", { kmPerPixel: 0 }).edges[0];
assert.equal(pausedDistance.scaledDistanceSelected, true, "the editor must show the saved automatic mode after calibration is removed");
assert.equal(pausedDistance.scaledDistancePaused, true);
assert.equal(pausedDistance.automaticDistance, false, "manual distance remains editable while calibration is unavailable");
const network = exportRouteNetwork(catalog);
assert.deepEqual(parseRouteNetwork(JSON.parse(JSON.stringify(network))), network, "JSON round trip preserves markets, economics, geometry and parallel routes");
const original = structuredClone(network);
const source = structuredClone(network);
source.eventRegions[0].marketLinks[0].distanceKm = 200;
const merged = mergeRouteNetwork({ ...catalog, eventRegions: [...network.eventRegions, { value: "c", label: "C", marketLinks: [] }] }, source);
assert.equal(merged.eventRegions.length, 3);
assert.equal(merged.eventRegions[0].marketLinks.length, 2);
assert.equal(merged.eventRegions[0].marketLinks[0].distanceKm, 200);
assert.deepEqual(network, original, "transfer must not mutate its sources");
assert.throws(() => parseRouteNetwork({ ...network, version: 99 }));
assert.throws(() => parseRouteNetwork({ ...network, eventRegions: [network.eventRegions[0]] }), /отсутствующий/);
assert.throws(() => parseRouteNetwork({ ...network, eventRegions: [...network.eventRegions, network.eventRegions[0]] }), /ID рынка/);
const overflow = structuredClone(network);
overflow.eventRegions[0].marketLinks = Array.from({ length: 300 }, (_, i) => ({ ...network.eventRegions[0].marketLinks[0], routeId: "new-" + i }));
assert.throws(() => mergeRouteNetwork(catalog, overflow), /лимит 300/);
assert.deepEqual(network, original);

checkCalendariaCharacterization();
const mixed = mixedMarketRouteFixture();
for (const isGM of [false, true]) for (const direction of ["inbound", "outbound"]) {
  const input = { holding: mixed.holding, market: mixed.market, data: { catalog: { eventRegions: mixed.regions } }, isGM, direction };
  const authority = authorityMarketLogistics(input).logistics;
  assert.equal(authority.ok, true, "GM/player authority must accept a transfer from caravan to airship");
  assert.deepEqual(authority.routeModes, ["airship", "airship", "airship", "caravan"]);
  if (direction === "inbound") {
    const displayed = SkyholdMarketApp.prototype._marketLogistics.call({ carrierId: "" }, input.holding, input.data, input.market, { isGM }).logistics;
    assert.deepEqual(displayed, authority, "the window and authority must agree on mixed delivery");
  }
}
const holding = { overview: { region: "a" }, gm: { calendaria: { lastDateText: "18 Хладорост, 881" } } };
const market = { regionId: "b", transportModes: ["caravan"] };
for (const isGM of [false, true]) {
  const winterResult = authorityMarketLogistics({ holding, market, data: { catalog }, isGM }).logistics;
  const summerHolding = structuredClone(holding);
  summerHolding.gm.calendaria.lastDateText = "18 Зноеход, 881";
  const summerResult = authorityMarketLogistics({ holding: summerHolding, market, data: { catalog }, isGM }).logistics;
  const displayContext = { carrierId: "" };
  const displayed = SkyholdMarketApp.prototype._marketLogistics.call(displayContext, holding, { catalog }, market, { isGM }).logistics;
  const summerDisplayed = SkyholdMarketApp.prototype._marketLogistics.call(displayContext, summerHolding, { catalog }, market, { isGM }).logistics;
  assert.deepEqual(displayed, winterResult, "the GM/player window must use the complete authority calendar and route contract");
  assert.deepEqual(summerDisplayed, summerResult, "UI and authority must agree after changing the season");
  assert.equal(winterResult.seasonId, "winter");
  assert.equal(summerResult.seasonId, "summer");
  assert.ok(winterResult.travelQd > summerResult.travelQd, "calendar winter must increase travel time for GM and player quotes");
  assert.ok(winterResult.distanceFlatCopper > summerResult.distanceFlatCopper);
  assert.ok(winterResult.riskFactor > summerResult.riskFactor);
  const disabled = structuredClone(catalog);
  disabled.eventRegions[0].marketLinks[0].seasonalModifiers.winter.enabled = false;
  const disabledResult = authorityMarketLogistics({ holding, market, data: { catalog: disabled }, isGM }).logistics;
  assert.equal(disabledResult.travelQd, summerResult.travelQd, "prefilled disabled coefficients must have no effect");
}

const app = new SkyholdRouteGraphEditor();
const data = { meta: { revision: 1 }, catalog };
const previousView = SkyholdData.view;
const previousTransaction = SkyholdData.transaction;
SkyholdData.view = () => data;
try {
  const graph = graphContext(rows, "", catalog.marketRouteMap);
  const label = () => ({ dataset: {}, setAttribute() {}, classList: { toggle() {} } });
  const lines = graph.edges.map((edge) => ({ ...label(), dataset: { routeKey: edge.key } }));
  const labels = graph.edges.map((edge) => ({ ...label(), dataset: { routeKey: edge.key } }));
  app.element = { querySelectorAll: (selector) => selector === "[data-route-edge-path]" ? lines : selector === "[data-route-edge-label]" ? labels : [] };
  app._applyRouteFilters = () => {};
  app.requestRender = () => { throw new Error("saved field must not rebuild the map"); };
  app._refreshAll({ incremental: true });
  assert.match(labels[0].textContent, /80 км/);
  app._displayedEdges = new Map(graph.edges.map((edge) => [edge.key, edge]));
  app._displayedSeason = "winter";
  app._sortRouteRows = () => { throw new Error("seasonal state changes must not resort an unrelated name order"); };
  data.catalog.eventRegions[0].marketLinks[0].seasonalModifiers.winter.enabled = false;
  data.meta.revision++;
  app._syncGraph();
  data.catalog.eventRegions[0].marketLinks[0].seasonalModifiers.winter.enabled = true;
  data.meta.revision++;
  const syncGraph = app._syncGraph;
  app._syncGraph = () => { throw new Error("factor-only saves must leave the map DOM untouched"); };
  app._refreshAll({ incremental: true, skipGraph: true, syncEditor: false });
  app._syncGraph = syncGraph;
  const edgeEditor = new SkyholdRouteEdgeEditor({ owner: app, fromId: "a", toId: "b", routeId: "road" });
  const active = { dataset: { routeEdgeField: "ursCost" }, value: "42", type: "number" };
  const pending = { dataset: { routeEdgeField: "season-cost" }, value: "2.5", type: "number" };
  const distance = { dataset: { routeEdgeField: "distanceKm" }, value: "0", type: "number" };
  const summary = {};
  const seasonText = {};
  const seasonToggle = { dataset: {}, querySelector: () => seasonText };
  edgeEditor.element = { ownerDocument: { activeElement: active }, querySelectorAll: () => [active, pending, distance],
    querySelector: (selector) => selector === ".fbls-route-season-toggle" ? seasonToggle : summary };
  edgeEditor._pendingFields = new Map([[pending, {}]]);
  edgeEditor._syncFields();
  assert.equal(active.value, "42", "focused input must survive a completed save");
  assert.equal(pending.value, "2.5", "later queued edits must not be overwritten");
  assert.equal(distance.value, 80);
  edgeEditor._syncFields({ forceField: active });
  assert.equal(active.value, 1, "a rejected save must restore even the focused field");
  edgeEditor.seasonId = "summer";
  edgeEditor._syncFields({ seasonChanged: true });
  assert.match(seasonToggle.dataset.fblsTooltip, /Лето/);
  assert.match(seasonToggle.dataset.fblsTooltip, /цены, времени и риска/);
  const failedEditor = new SkyholdRouteEdgeEditor({ owner: { _onEdgeFieldChange: async () => false } });
  const reconciled = [];
  failedEditor._syncFields = ({ forceField }) => reconciled.push(forceField);
  await failedEditor._saveEdgeField(null, active);
  assert.equal(reconciled.at(-1), active, "a skipped write must restore the active control");
  failedEditor.owner._onEdgeFieldChange = async () => { throw new Error("save failed"); };
  await assert.rejects(failedEditor._saveEdgeField(null, active), /save failed/);
  assert.equal(reconciled.at(-1), active, "a failed write must restore the active control before reporting the error");
  const resolvers = [];
  failedEditor.owner._onEdgeFieldChange = () => new Promise((resolve) => resolvers.push(resolve));
  const earlierSave = failedEditor._saveEdgeField(null, active);
  const laterSave = failedEditor._saveEdgeField(null, active);
  resolvers[0](false);
  await earlierSave;
  assert.equal(reconciled.at(-1), null, "an older failure must not overwrite a newer edit of the same field");
  resolvers[1](false);
  await laterSave;
  assert.equal(reconciled.at(-1), active);
  globalThis.game = { user: { isGM: false } };
  await app._commitNodeSelection("b");
  assert.equal(app.selectedNodeId, "", "players cannot create routes");
  globalThis.game.user.isGM = true;
  SkyholdData.transaction = async (mutator) => mutator(data, { skip: (value) => value });
  app._refreshAll = () => {};
  app._openEdgeEditor = () => {};
  app.selectedNodeId = "a";
  await app._commitNodeSelection("b");
  const created = data.catalog.eventRegions[0].marketLinks.at(-1);
  assert.deepEqual(created.seasonalModifiers.winter, { enabled: false, costFactor: 1.4, timeFactor: 1.25, riskFactor: 1.2 });
  const neutralRows = structuredClone(rows);
  neutralRows[0].marketLinks[0].seasonalModifiers.winter = { enabled: false, costFactor: 1, timeFactor: 1, riskFactor: 1 };
  assert.equal(graphContext(neutralRows).edges[0].seasonalCostFactor, 1, "existing custom neutral values must remain untouched");
} finally { SkyholdData.view = previousView; SkyholdData.transaction = previousTransaction; }
console.log("Route network: JSON round trip, merge, invalid input, limits, calendar GM/player logistics and stable editor DOM passed.");
