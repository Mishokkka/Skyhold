import assert from "node:assert/strict";

const hooks = new Map();
const errors = [];
const module = {};
globalThis.Hooks = {
  on(name, callback) { hooks.set(name, callback); },
  once(name, callback) { hooks.set(name, callback); }
};
globalThis.foundry = {
  applications: {
    api: { ApplicationV2: class {}, HandlebarsApplicationMixin: cls => cls },
    handlebars: { loadTemplates: async paths => paths }
  },
  utils: { deepClone: structuredClone }
};
globalThis.game = {
  user: { id: "gm", isGM: true },
  modules: { get: () => module },
  settings: { register() {}, get: () => false }
};
globalThis.ui = { notifications: { error: text => errors.push(text) } };
const { SkyholdApp } = await import("../apps/skyhold-app.js");
await import("../main.js");
await hooks.get("init")();
assert.equal(module.api, game.fblSkyhold, "both public API entrypoints share the same opener");

const originalOpen = SkyholdApp.open;
const originalError = console.error;
const logged = [];
console.error = (...args) => logged.push(args);
try {
  SkyholdApp.open = () => null;
  assert.equal(game.fblSkyhold.open(), null, "denied opening keeps its synchronous null result");
  const rendered = { rendered: true };
  SkyholdApp.open = () => Promise.resolve(rendered);
  assert.equal(await game.fblSkyhold.open(), rendered);
  SkyholdApp.open = () => { throw new Error("Synchronous opening failure"); };
  assert.equal(game.fblSkyhold.open(), null);
  SkyholdApp.open = () => Promise.reject(new Error("Rejected ApplicationV2 render"));
  assert.equal(await game.fblSkyhold.open(), null, "async render errors must reach the same notification path");
  const controls = { notes: { tools: {} } };
  hooks.get("getSceneControlButtons")(controls);
  hooks.get("getSceneControlButtons")(controls);
  assert.equal(Object.keys(controls.notes.tools).length, 1, "repeated hook calls must not duplicate the scene control");
  controls.notes.tools["fbl-skyhold-open"].onChange(null, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 3, "API and scene controls notify on synchronous and asynchronous failures");
  assert.equal(logged.length, 3);
} finally {
  SkyholdApp.open = originalOpen;
  console.error = originalError;
}
console.log("Bootstrap: init API, scene control deduplication, successful render, denied access and sync/async opening failures passed (mock Foundry).");
