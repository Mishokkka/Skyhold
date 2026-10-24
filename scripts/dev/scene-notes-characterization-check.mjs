import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { HoldingService } from "../data/holding-service.js";
import { foundryDoubleClickThresholds } from "../integrations/foundry-runtime.js";

const hooks = new Map();
const warnings = [];
const errors = [];
let removedTooltips = 0;
globalThis.Hooks = { on(name, callback) { hooks.set(name, [...(hooks.get(name) ?? []), callback]); } };
globalThis.game = { user: { id: "gm", isGM: true } };
globalThis.canvas = { activeLayer: {}, notes: {} };
globalThis.document = { querySelector: () => ({ remove() { removedTooltips += 1; } }) };
globalThis.window = { clearTimeout, setTimeout };
globalThis.ui = { notifications: { warn: text => warnings.push(text), error: text => errors.push(text) } };
globalThis.foundry = {
  applications: {
    api: { ApplicationV2: class {}, HandlebarsApplicationMixin: cls => cls },
    handlebars: { loadTemplates: async () => [] }
  }
};
const holding = { id: "h", name: "Holding", visibility: "all", buildings: { list: [{ id: "b", name: "Building" }] } };
HoldingService.getData = () => ({ holdings: [holding], catalog: { buildings: [] } });
const { installSceneNotesIntegration } = await import("../integrations/scene-notes.js");
const { SkyholdBuildingEditor } = await import("../apps/editors/building-editor.js");
let renderCount = 0;
let failRender = false;
SkyholdBuildingEditor.prototype.render = async function () {
  renderCount += 1;
  assert.equal(this.holdingId, "h");
  assert.equal(this.buildingId, "b");
  if (failRender) throw new Error("Injected render failure");
  return this;
};
installSceneNotesIntegration();
installSceneNotesIntegration();
assert.ok([...hooks.values()].every(callbacks => callbacks.length === 1), "installation must be idempotent");
const callHook = (name, ...args) => hooks.get(name)?.[0](...args);
const flush = () => new Promise(resolve => setImmediate(resolve));
let pointerTime = 1000;
function tap(target, { delay = 500, detail = 1, button = 0, x = 100, y = 100 } = {}) {
  pointerTime += delay;
  target.emit("pointertap", { button, detail, timeStamp: pointerTime, clientX: x, clientY: y });
}
function doubleClick(target, interval = 100) {
  tap(target);
  tap(target, { delay: interval, detail: interval < 200 ? 2 : 1 });
}
function note(flags = null, entry = null) {
  return Object.assign(new EventEmitter(), { document: { entry, flags: { "fbl-skyhold": flags } } });
}
const ordinary = note(null, { id: "journal" });
assert.equal(callHook("activateNote", ordinary), undefined, "ordinary Journal notes must retain Foundry activation");
callHook("drawNote", ordinary);
assert.equal(ordinary.listenerCount("pointertap"), 0);

const flags = { type: "building-note", holdingId: "h", buildingId: "b" };
const building = note(flags);
for (const user of [{ id: "gm", isGM: true }, { id: "player", isGM: false }]) {
  game.user = user;
  callHook("drawNote", building);
  callHook("drawNote", building);
  assert.equal(building.listenerCount("pointertap"), 1, "redraw must replace its listener");
  const before = renderCount;
  tap(building);
  tap(building, { button: 2, detail: 2 });
  assert.equal(renderCount, before);
  doubleClick(building);
  doubleClick(building);
  await flush();
  assert.equal(renderCount, before + 1, "an unlinked building note opens once while a render is pending");
}
for (const interval of [225, 250]) {
  const before = renderCount;
  doubleClick(building, interval);
  await flush();
  assert.equal(renderCount, before + 1, `two taps ${interval}ms apart must open even when Pixi detail remains 1`);
}
const beforeSlowClick = renderCount;
doubleClick(building, 251);
await flush();
assert.equal(renderCount, beforeSlowClick, "a 251ms pair must not open");
tap(building, { delay: 100, detail: 2 });
await flush();
assert.equal(renderCount, beforeSlowClick + 1, "a slow second tap becomes the candidate for the next pair");
const beforeDistance = renderCount;
tap(building);
tap(building, { delay: 100, x: 105 });
await flush();
assert.equal(renderCount, beforeDistance + 1, "a 5px pair is within the Foundry distance threshold");
tap(building);
tap(building, { delay: 100, x: 106, detail: 2 });
await flush();
assert.equal(renderCount, beforeDistance + 1, "distance over 5px must not open even when detail is 2");
tap(building, { delay: 100, x: 106 });
await flush();
assert.equal(renderCount, beforeDistance + 2, "a far tap becomes a new candidate");
const beforeTriple = renderCount;
doubleClick(building);
await flush();
tap(building, { delay: 100 });
await flush();
assert.equal(renderCount, beforeTriple + 1, "the third tap starts a new pair after the pending render settles");
tap(building, { delay: 100 });
await flush();
assert.equal(renderCount, beforeTriple + 2);
const beforeRedraw = renderCount;
tap(building);
callHook("drawNote", building);
tap(building, { delay: 100, detail: 2 });
await flush();
assert.equal(renderCount, beforeRedraw, "redraw discards the previous tap candidate");
assert.deepEqual(foundryDoubleClickThresholds(), { timeMs: 250, distancePx: 5 }, "missing Foundry constants use the supported defaults");
foundry.canvas = { interaction: { MouseInteractionManager: { DOUBLE_CLICK_TIME_MS: 300, DOUBLE_CLICK_DISTANCE_PX: 8 } } };
assert.deepEqual(foundryDoubleClickThresholds(), { timeMs: 300, distancePx: 8 });
doubleClick(building, 275);
await flush();
assert.equal(renderCount, beforeRedraw + 1, "public Foundry constants take precedence over defaults");
foundry.canvas.interaction.MouseInteractionManager = { DOUBLE_CLICK_TIME_MS: NaN, DOUBLE_CLICK_DISTANCE_PX: -1 };
assert.deepEqual(foundryDoubleClickThresholds(), { timeMs: 250, distancePx: 5 }, "invalid optional constants use defaults");
delete foundry.canvas;
const beforeHidden = renderCount;
holding.visibility = "gm";
doubleClick(building);
await flush();
assert.equal(renderCount, beforeHidden, "player cannot open a hidden holding");
holding.visibility = "all";
holding.buildings.list[0].hidden = true;
doubleClick(building);
await flush();
assert.equal(renderCount, beforeHidden, "player cannot open a hidden building");
holding.buildings.list = [];
doubleClick(building);
await flush();
assert.equal(renderCount, beforeHidden, "deleted buildings do not open stale editors");
assert.equal(warnings.length, 3);
holding.buildings.list = [{ id: "b", name: "Building" }];

canvas.activeLayer = canvas.notes;
assert.equal(callHook("activateNote", building), undefined, "the Notes layer keeps its configuration interaction");
doubleClick(building);
await flush();
assert.equal(renderCount, beforeHidden);
canvas.activeLayer = {};
const linked = note(flags, { id: "journal" });
callHook("drawNote", linked);
doubleClick(linked);
assert.equal(callHook("activateNote", linked), false, "only linked Skyhold notes cancel default Journal activation");
await flush();
assert.equal(renderCount, beforeHidden + 1, "linked notes must not open through both routes");

const oldError = console.error;
const logged = [];
console.error = (...args) => logged.push(args);
try {
  failRender = true;
  doubleClick(building);
  await flush();
  assert.equal(errors.length, 1, "async opening failures must notify the user");
  assert.equal(logged.length, 1, "async failures must remain diagnosable");
  failRender = false;
  doubleClick(building);
  await flush();
  assert.equal(renderCount, beforeHidden + 3, "failure must release the pending-open guard");
} finally { console.error = oldError; }
callHook("destroyNote", building);
assert.equal(building.listenerCount("pointertap"), 0, "destroy must remove the note listener");
callHook("canvasTearDown");
assert.equal(removedTooltips, 2, "destroy and scene teardown must remove stale tooltips");
console.log("Scene notes: ordinary Journals, unlinked/linked buildings, GM/player visibility, redraw, repeat clicks, failures and teardown passed (mock Foundry).");
