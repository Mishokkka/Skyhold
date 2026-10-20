import assert from "node:assert/strict";
import { bindFloatingTooltips, FloatingTooltipsMixin, hideFloatingTooltip } from "../apps/common/floating-tooltip.js";

class Element extends globalThis.EventTarget {
  constructor(attributes = {}) {
    super();
    this.attributes = new Map(Object.entries(attributes));
    this.dataset = {};
    this.style = {};
    this.isConnected = true;
    this.offsetWidth = 220;
    this.offsetHeight = 60;
    this.removed = false;
    this.children = [];
  }
  hasAttribute(key) { return this.attributes.has(key); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  removeAttribute(key) { this.attributes.delete(key); }
  getBoundingClientRect() { return { left: 2, top: 3, width: 100, bottom: 35 }; }
  contains(element) { return element === this || this.children.includes(element); }
  matches() { return true; }
  remove() { this.removed = true; }
}
const previous = { document: globalThis.document, window: globalThis.window, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
const created = [];
const pending = new Map();
const delays = new Map();
let timerId = 0;
globalThis.window = { innerWidth: 320, innerHeight: 240 };
globalThis.document = { createElement: () => new Element(), body: { appendChild(element) { created.push(element); } } };
globalThis.setTimeout = (callback, delay) => { pending.set(++timerId, callback); delays.set(timerId, delay); return timerId; };
globalThis.clearTimeout = id => pending.delete(id);
function dispatch(element, type, extra = {}) {
  const event = new Event(type);
  Object.assign(event, extra);
  element.dispatchEvent(event);
}
try {
  const field = new Element({ title: "Полное описание", "aria-label": "Короткое имя" });
  const checkbox = new Element();
  field.children.push(checkbox);
  const root = { querySelectorAll: () => [field] };
  const owner = {};
  bindFloatingTooltips(owner, root);
  assert.equal(field.hasAttribute("title"), false, "native tooltip must not compete with the shared tooltip");
  assert.equal(field.dataset.fblsTooltip, "Полное описание");
  assert.equal(field.getAttribute("aria-label"), "Короткое имя", "explicit accessible names must survive binding");
  dispatch(field, "focusin");
  assert.equal(owner._activeTooltip.textContent, "Полное описание", "focus on a checkbox must reveal the complete explanation");
  assert.equal(owner._activeTooltip.getAttribute("role"), "tooltip");
  assert.equal(owner._activeTooltip.style.left, "10px", "tooltip must remain inside a narrow viewport");
  assert.equal(owner._activeTooltip.style.top, "45px", "tooltip must move below a control at the top edge");
  dispatch(field, "focusout", { relatedTarget: checkbox });
  assert.ok(owner._activeTooltip, "focus moving within the same control must retain its tooltip");
  dispatch(field, "keydown", { key: "Escape" });
  assert.equal(owner._activeTooltip, null, "Escape must dismiss the explanation");
  dispatch(field, "focusin");
  dispatch(field, "focusout", { relatedTarget: new Element() });
  assert.equal(owner._activeTooltip, null, "leaving the control must dismiss its tooltip");
  bindFloatingTooltips(owner, root);
  const before = created.length;
  dispatch(field, "focusin");
  assert.equal(created.length, before + 1, "rebinding a surviving render root must not duplicate listeners");
  hideFloatingTooltip(owner);

  dispatch(field, "mouseenter");
  assert.equal(delays.get(owner._tooltipTimer), 300, "ordinary pointer tooltips need the shared delay");
  const delayed = pending.get(owner._tooltipTimer);
  pending.delete(owner._tooltipTimer);
  delayed();
  assert.equal(owner._activeTooltip.textContent, "Полное описание");
  hideFloatingTooltip(owner);
  field.dataset.fblsTooltipDelay = "0";
  dispatch(field, "mouseenter");
  assert.ok(owner._activeTooltip, "explicit zero delay must remain immediate");
  hideFloatingTooltip(owner);
  delete field.dataset.fblsTooltipDelay;

  const dynamic = new Element({ title: "Обновлённый план" });
  let liveFields = [field];
  const dynamicRoot = { querySelectorAll: () => liveFields };
  const lifecycle = new AbortController();
  bindFloatingTooltips(owner, dynamicRoot, { signal: lifecycle.signal });
  liveFields = [field, dynamic];
  bindFloatingTooltips(owner, dynamicRoot, { signal: lifecycle.signal });
  dispatch(dynamic, "focusin");
  assert.equal(owner._activeTooltip.textContent, "Обновлённый план", "new preview nodes need the same floating tooltip");
  dispatch(dynamic, "mouseenter");
  lifecycle.abort();
  assert.equal(owner._activeTooltip, null);
  assert.equal(pending.size, 0, "window abort must cancel the preview delay");
  const afterAbort = created.length;
  dispatch(dynamic, "focusin");
  assert.equal(created.length, afterAbort, "aborted dynamic preview bindings must not show tooltips");

  class Base {
    constructor() { this.element = root; this.renderCalls = 0; }
    async _onRender() { this.renderCalls++; }
    async _onClose() { this.element = null; throw new Error("base-close"); }
  }
  const editor = new (FloatingTooltipsMixin(Base))();
  await editor._onRender({}, {});
  assert.equal(editor.renderCalls, 1, "tooltip lifecycle must preserve the base render hook");
  field.dataset.fblsTooltipDelay = "15";
  dispatch(field, "mouseenter");
  assert.equal(pending.size, 1);
  await assert.rejects(editor._onClose({}), /base-close/);
  assert.equal(pending.size, 0, "closing must cancel delayed tooltips even when the base hook rejects");
  const afterClose = created.length;
  dispatch(field, "focusin");
  assert.equal(created.length, afterClose, "closed editor roots must no longer open tooltips even after ApplicationV2 clears the element");
  console.log("Floating tooltips: keyboard focus, Escape, native fallback, viewport edges, rebind and close cleanup passed.");
} finally {
  Object.assign(globalThis, previous);
}
