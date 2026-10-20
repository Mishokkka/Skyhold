import assert from "node:assert/strict";
import { bindTabNavigation, tabKeyTarget } from "../apps/common/tab-navigation.js";

function fixture(groups = ["manager", "storage", "tenday"], doc = { body: {}, activeElement: null }) {
  const listeners = [];
  const root = {
    ownerDocument: doc,
    contains: (element) => lists.includes(element),
    querySelectorAll: (selector) => selector === "[data-fbls-tablist]" ? lists : panels.filter((panel) => selector.includes(`"${panel.group}"`)),
    addEventListener: (type, callback, options) => { if (type === "keydown") listeners.push({ callback, signal: options.signal }); }
  };
  const panels = groups.map((group) => ({ group, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } }));
  const lists = groups.map((group) => {
    const list = { dataset: { fblsTablist: group }, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, querySelectorAll: () => list.tabs };
    list.tabs = ["resources", "items", "log"].map((value, index) => ({
      dataset: { fblsTabValue: value }, attributes: {}, isConnected: true, clicks: 0,
      classList: { contains: (name) => name === "active" && index === 0 },
      getAttribute(name) { return this.attributes[name] ?? null; },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
      closest: (selector) => selector === "[data-fbls-tablist]" ? list : null,
      focus() { doc.activeElement = this; },
      click() { this.clicks++; }
    }));
    return list;
  });
  return { root, doc, lists, panels, key(tab, key, modifiers = {}) {
    const event = { key, target: { closest: () => tab }, prevented: false, preventDefault() { this.prevented = true; }, ...modifiers };
    for (const { callback, signal } of listeners) if (!signal?.aborted) callback(event);
    return event;
  } };
}

export function checkTabNavigation() {
  assert.equal(tabKeyTarget("ArrowLeft", 0, 3), 2);
  assert.equal(tabKeyTarget("ArrowRight", 2, 3), 0);
  assert.equal(tabKeyTarget("Home", 2, 3), 0);
  assert.equal(tabKeyTarget("End", 0, 3), 2);
  assert.equal(tabKeyTarget("Enter", 0, 3), null);
  assert.equal(tabKeyTarget("ArrowRight", -1, 0), null);

  for (const user of ["gm", "player"]) {
    const app = { id: `${user}-skyhold` };
    const view = fixture();
    const controller = new AbortController();
    bindTabNavigation(app, view.root, { signal: controller.signal });
    for (const [index, list] of view.lists.entries()) {
      assert.equal(list.attributes.role, "tablist");
      assert.deepEqual(list.tabs.map((tab) => tab.tabIndex), [0, -1, -1]);
      assert.equal(view.panels[index].attributes["aria-labelledby"], list.tabs[0].id);
      assert.ok(list.tabs.every((tab) => tab.attributes["aria-controls"] === view.panels[index].id));
    }
    const [list, storage] = view.lists;
    view.key(list.tabs[0], "Home");
    assert.equal(list.tabs[0].clicks, 0, "The current tab keeps focus without an unnecessary render");
    assert.equal(app._tabNavigationFocus, null);
    list.tabs[1].disabled = true;
    assert.equal(view.key(list.tabs[0], "ArrowRight").prevented, true);
    assert.equal(list.tabs[2].clicks, 1, "Activation stays on the existing click/permission path");
    assert.ok(storage.tabs.every((tab) => tab.clicks === 0), "Nested storage is isolated from main navigation");
    assert.equal(view.key(list.tabs[2], "Home", { ctrlKey: true }).prevented, false);
    const oldTab = list.tabs[2];
    oldTab.isConnected = false;
    const next = fixture(["manager"], view.doc);
    bindTabNavigation(app, next.root);
    assert.equal(view.doc.activeElement, next.lists[0].tabs[2], "Keyboard focus returns after DOM replacement");
    assert.equal(app._tabNavigationFocus, null);

    view.key(list.tabs[0], "End");
    view.doc.activeElement = { isConnected: true, otherWindow: true };
    const external = view.doc.activeElement;
    bindTabNavigation(app, fixture(["manager"], view.doc).root);
    assert.equal(view.doc.activeElement, external, "A newly focused window must not lose focus");
    controller.abort();
    assert.equal(view.key(list.tabs[0], "ArrowRight").prevented, false, "Render/close removes the old listener");
  }
  console.log("Tab navigation: GM/player roles, nested groups, disabled tabs, wrapping, modifiers, render focus and abort passed.");
}

checkTabNavigation();
