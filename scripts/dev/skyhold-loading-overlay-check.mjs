import assert from "node:assert/strict";

// Run in its own Node process: the real application is imported against a
// minimal Foundry base, while DOM nodes and animation clocks are deterministic.
const timers = new Map();
const frames = [];
let timerId = 0;
globalThis.window = {
  setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
  clearTimeout: (id) => timers.delete(id)
};
globalThis.requestAnimationFrame = (callback) => frames.push(callback);

function node() {
  const classes = new Set();
  const attributes = new Map();
  return {
    children: [], parentElement: null, removed: false,
    classList: {
      add: (...values) => values.forEach((value) => classes.add(value)),
      remove: (...values) => values.forEach((value) => classes.delete(value)),
      contains: (value) => classes.has(value)
    },
    set className(value) { classes.clear(); String(value).split(/\s+/).forEach((item) => classes.add(item)); },
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: (name) => attributes.get(name),
    appendChild(child) { this.children.push(child); child.parentElement = this; },
    remove() {
      this.removed = true;
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null
  };
}

globalThis.document = { createElement: node };
globalThis.foundry = {
  applications: { api: {
    ApplicationV2: class { render(options) { return this.baseRender(options); } },
    HandlebarsApplicationMixin: (Base) => Base
  } },
  utils: { deepClone: (value) => structuredClone(value), getProperty() {}, setProperty() {} }
};
globalThis.game = { user: { id: "gm", isGM: true }, settings: { get: () => null } };

const { SkyholdApp } = await import("../apps/skyhold-app.js");

function fixture() {
  const root = node();
  const shell = node();
  const host = node();
  const inner = node();
  root.parentElement = host;
  root.querySelector = (selector) => selector === ".fbls-shell" ? shell : null;
  shell.querySelector = (selector) => selector === "[data-loading-overlay]" ? inner : null;
  host.querySelector = (selector) => selector === ".fbls-loading-window-overlay"
    ? host.children.find((child) => child.classList.contains("fbls-loading-window-overlay")) ?? null : null;
  const app = Object.create(SkyholdApp.prototype);
  Object.defineProperties(app, { rendered: { value: true }, element: { value: root } });
  app._syncWindowFrameState = () => {};
  app._captureScrollState = () => null;
  app._captureWindowFrame = () => null;
  return { app, shell, inner, host };
}

function flushTimers() {
  const pending = [...timers.values()];
  timers.clear();
  pending.forEach((callback) => callback());
}
function flushFrames() { frames.splice(0).forEach((callback) => callback()); }
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function assertClear({ shell, inner, host }) {
  assert.equal(shell.classList.contains("fbls-loading-active"), false, "the embedded spinner must stop intercepting input");
  assert.equal(inner.getAttribute("aria-busy"), "false");
  assert.equal(host.classList.contains("fbls-loading-host"), false);
  assert.ok(host.children.every((child) => !child.classList.contains("active")));
}

// A slow successful render and an asynchronous failure both release the UI.
for (const fail of [false, true]) {
  const f = fixture();
  const pending = deferred();
  f.app.baseRender = () => pending.promise;
  const rendering = f.app.render();
  flushTimers();
  flushFrames();
  assert.equal(f.shell.classList.contains("fbls-loading-active"), true);
  assert.equal(f.inner.getAttribute("aria-busy"), "true");
  if (fail) {
    pending.reject(new Error("context failed"));
    await assert.rejects(rendering, /context failed/);
  } else { pending.resolve(f.app); await rendering; }
  assertClear(f);
  flushTimers();
  assert.equal(f.host.children.length, 0);
}

// Clearing before the delayed animation frame must not reactivate the overlay.
const lateFrame = fixture();
lateFrame.app._showLoadingOverlay();
lateFrame.app._clearLoadingOverlay();
flushFrames();
assertClear(lateFrame);
lateFrame.app._clearLoadingOverlay();
flushTimers();
assert.equal(lateFrame.host.children.length, 0);

// An absent external overlay must not prevent cleanup of the embedded one.
const embedded = fixture();
embedded.shell.classList.add("fbls-loading-active");
embedded.inner.setAttribute("aria-busy", "true");
embedded.app._clearLoadingOverlay();
assertClear(embedded);

// Completion of an older render must not cancel the newer render's timer.
const overlap = fixture();
const first = deferred(), second = deferred();
overlap.app.baseRender = () => first.promise;
const renderingFirst = overlap.app.render();
overlap.app.baseRender = () => second.promise;
const renderingSecond = overlap.app.render();
first.resolve();
await renderingFirst;
assert.ok(overlap.app._loadingOverlayTimer);
flushTimers();
flushFrames();
assert.equal(overlap.shell.classList.contains("fbls-loading-active"), true);
second.resolve();
await renderingSecond;
assertClear(overlap);
flushTimers();

const fast = fixture();
fast.app.baseRender = () => Promise.resolve();
await fast.app.render();
flushTimers();
assertClear(fast);
assert.equal(fast.host.children.length, 0, "fast renders never create a delayed overlay");

const syncFailure = fixture();
syncFailure.app.baseRender = () => { throw new Error("render failed"); };
assert.throws(() => syncFailure.app.render(), /render failed/);
assertClear(syncFailure);
assert.equal(timers.size, 0);
console.log("Skyhold loading overlay passed: success, failures, embedded cleanup, late frames and overlapping renders.");
