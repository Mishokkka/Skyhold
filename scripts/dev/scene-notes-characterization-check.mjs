import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { HoldingService } from "../data/holding-service.js";

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
  building.emit("pointertap", { button: 0, detail: 1 });
  building.emit("pointertap", { button: 2, detail: 2 });
  assert.equal(renderCount, before);
  building.emit("pointertap", { button: 0, detail: 2 });
  building.emit("pointertap", { button: 0, detail: 2 });
  await flush();
  assert.equal(renderCount, before + 1, "an unlinked building note opens once while a render is pending");
}
const beforeHidden = renderCount;
holding.visibility = "gm";
building.emit("pointertap", { button: 0, detail: 2 });
await flush();
assert.equal(renderCount, beforeHidden, "player cannot open a hidden holding");
holding.visibility = "all";
holding.buildings.list[0].hidden = true;
building.emit("pointertap", { button: 0, detail: 2 });
await flush();
assert.equal(renderCount, beforeHidden, "player cannot open a hidden building");
holding.buildings.list = [];
building.emit("pointertap", { button: 0, detail: 2 });
await flush();
assert.equal(renderCount, beforeHidden, "deleted buildings do not open stale editors");
assert.equal(warnings.length, 3);
holding.buildings.list = [{ id: "b", name: "Building" }];

canvas.activeLayer = canvas.notes;
assert.equal(callHook("activateNote", building), undefined, "the Notes layer keeps its configuration interaction");
building.emit("pointertap", { button: 0, detail: 2 });
await flush();
assert.equal(renderCount, beforeHidden);
canvas.activeLayer = {};
const linked = note(flags, { id: "journal" });
callHook("drawNote", linked);
linked.emit("pointertap", { button: 0, detail: 2 });
assert.equal(callHook("activateNote", linked), false, "only linked Skyhold notes cancel default Journal activation");
await flush();
assert.equal(renderCount, beforeHidden + 1, "linked notes must not open through both routes");

const oldError = console.error;
const logged = [];
console.error = (...args) => logged.push(args);
try {
  failRender = true;
  building.emit("pointertap", { button: 0, detail: 2 });
  await flush();
  assert.equal(errors.length, 1, "async opening failures must notify the user");
  assert.equal(logged.length, 1, "async failures must remain diagnosable");
  failRender = false;
  building.emit("pointertap", { button: 0, detail: 2 });
  await flush();
  assert.equal(renderCount, beforeHidden + 3, "failure must release the pending-open guard");
} finally { console.error = oldError; }
callHook("destroyNote", building);
assert.equal(building.listenerCount("pointertap"), 0, "destroy must remove the note listener");
callHook("canvasTearDown");
assert.equal(removedTooltips, 2, "destroy and scene teardown must remove stale tooltips");
console.log("Scene notes: ordinary Journals, unlinked/linked buildings, GM/player visibility, redraw, repeat clicks, failures and teardown passed (mock Foundry).");
