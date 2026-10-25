import assert from "node:assert/strict";
import { BUILDING_EDITOR_TABS } from "../apps/domains/building-editor-tabs.js";

// ApplicationV2 inserts an intrinsic frame, runs _onRender, then applies the
// same mutable position object. Measuring the frame too early corrupts it.
class OpeningApplication {
  constructor(options = {}) {
    this.position = { left: null, top: null, ...this.constructor.DEFAULT_OPTIONS.position, ...options.position };
    this.bounds = { left: 0, top: 0, width: 620, height: 460 };
    this.element = {
      querySelectorAll: () => [], querySelector: () => null,
      addEventListener() {}, removeEventListener() {},
      getBoundingClientRect: () => ({ ...this.bounds })
    };
  }
  async _onRender() {}
  async _onClose() {}
  setPosition(position) {
    Object.assign(this.position, position);
    this.bounds = {
      ...this.position,
      left: this.position.left ?? (1360 - this.position.width) / 2,
      top: this.position.top ?? (900 - this.position.height) / 2
    };
    return this.position;
  }
  async render(options = {}) {
    options.isFirstRender = !this.rendered;
    if (options.isFirstRender) options.position = Object.assign(this.position, options.position);
    this.rendered = true;
    await this._onRender({}, options);
    if (options.position) this.setPosition(options.position);
    return this;
  }
}

const previous = Object.fromEntries(["foundry", "game", "window", "requestAnimationFrame"].map(key => [key, globalThis[key]]));
const frames = [];
try {
  globalThis.requestAnimationFrame = callback => { frames.push(callback); };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.game = { user: { isGM: true }, settings: {
    get() { assert.fail("opening an editor must not read world data in this fixture"); },
    set() { assert.fail("opening an editor must not write world data"); }
  } };
  globalThis.foundry = { applications: { api: {
    ApplicationV2: OpeningApplication, HandlebarsApplicationMixin: Base => Base
  } } };
  const { SkyholdBuildingEditor } = await import("../apps/editors/building-editor.js");
  const { SkyholdBuildingTemplateEditor } = await import("../apps/editors/template-browser.js");
  const { SkyholdApp } = await import("../apps/skyhold-app.js");
  for (const isGM of [true, false]) {
    game.user.isGM = isGM;
    for (const Editor of [SkyholdBuildingEditor, SkyholdBuildingTemplateEditor]) {
      for (const opening of [{}, { position: { width: 1080, height: 700 } }, { options: { position: { width: 1020, height: 640 } } }]) {
        const app = new Editor({ holdingId: "demo", buildingId: "demo", templateId: "demo" }, opening.options);
        const initial = opening.position ?? opening.options?.position ?? Editor.DEFAULT_OPTIONS.position;
        await app.render({ force: true, position: opening.position });
        assert.equal(app.bounds.width, initial.width, "intrinsic width must not replace configured opening width");
        assert.equal(app.bounds.height, initial.height, "intrinsic height must not replace configured opening height");
        assert.equal(app.bounds.left, (1360 - initial.width) / 2, "opening must retain V2 centering");
        assert.equal(app.bounds.top, (900 - initial.height) / 2);
        assert.equal(app._lastWindowFrame.width, initial.width);
        app.setPosition({ width: 800, height: 600 });
        frames.splice(0).forEach(callback => callback());
        app.setPosition({ left: 180, top: 140 });
        await app.render({ force: true });
        assert.deepEqual(app.bounds, { left: 180, top: 140, width: 800, height: 600 }, "rerendering and moving must preserve the user's size");
        app._onEditorTab({ preventDefault() {}, stopPropagation() {}, currentTarget: { dataset: { editorTab: "workers" } } });
        const pending = app._queuedRenderPromise;
        frames.splice(0).forEach(callback => callback());
        await pending;
        assert.equal(app.activeTab, "workers");
        assert.deepEqual(app.bounds, { left: 180, top: 140, width: 800, height: 600 }, "switching editor tabs must also preserve the frame");
        assert.ok(app._windowFrameSyncHandler, "frame observation must remain bound after rendering");
        await app._onClose({});
        assert.equal(app._windowFrameSyncHandler, null, "closing must remove frame listeners");
        frames.splice(0).forEach(callback => callback());
      }
    }
  }
  // Exercise the real manager lifecycle too: its first _onRender used to
  // capture the intrinsic frame and overwrite the same mutable position.
  for (const isGM of [true, false]) {
    game.user.isGM = isGM;
    for (const opening of [{}, { position: { width: 1180, height: 680 } }]) {
      const app = new SkyholdApp(opening);
      for (const method of ["_bindInputGuards", "_bindGlobalInputGuard", "_bindFloatingTooltips", "_bindDelegatedEvents", "_syncResidentAppearanceTextareas", "_syncResidentTraitChips", "_applyResidentSearchFilter", "_applyStorageSearchFilter", "_syncTitlebarRunbar", "_clearLoadingOverlay", "_flashStorageSearchTarget"]) app[method] = () => {};
      const expected = opening.position ?? SkyholdApp.DEFAULT_OPTIONS.position;
      await app.render({ force: true });
      assert.equal(app.bounds.width, expected.width, "manager opening must retain its configured width after _onRender");
      assert.equal(app.bounds.height, expected.height);
      assert.equal(app._lastWindowFrame.width, expected.width, "only the positioned manager frame may be remembered");
      assert.ok(app._windowFrameSyncHandler);
      app.setPosition({ width: 1040, height: 650 });
      frames.splice(0).forEach(callback => callback());
      app.setPosition({ left: 80, top: 90 });
      app.activeTab = "people";
      await app.render({ force: true, skipLoadingOverlay: true });
      assert.deepEqual(app.bounds, { width: 1040, height: 650, left: 80, top: 90 }, "tab rerenders and moving must preserve the manager's chosen frame");
      app._unbindWindowFrameSync();
      app._gmDisclosures?.close();
      frames.splice(0).forEach(callback => callback());
    }
  }
  assert.equal(new Set(BUILDING_EDITOR_TABS.map(tab => tab.id)).size, 12);
  for (const tab of BUILDING_EDITOR_TABS) {
    assert.ok(tab.label && tab.shortLabel && tab.icon, "every abbreviated tab needs its full accessible label and icon");
  }
  console.log("Building editor and manager windows: GM/player, default/custom opening dimensions, positioned-frame capture, centering and resized rerenders passed.");
} finally {
  Object.assign(globalThis, previous);
}
