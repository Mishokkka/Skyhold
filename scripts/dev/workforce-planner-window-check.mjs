import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

// V2 inserts an intrinsically narrow frame before its first positioning.
// The real frame mixin must not mistake that initial layout for a user resize.
class OpeningApplication {
  constructor(options = {}) {
    this.position = { left: null, top: null, ...this.constructor.DEFAULT_OPTIONS.position, ...options.position };
    this.bounds = { left: 0, top: 0, width: 200, height: 820 };
    this.handlers = new Map();
    this.element = {
      querySelectorAll: () => [], querySelector: () => null,
      addEventListener: (name, callback) => this.handlers.set(name, callback), removeEventListener() {},
      getBoundingClientRect: () => ({ ...this.bounds })
    };
  }
  async _onRender() {}
  async _onClose() {}
  setPosition(position) {
    Object.assign(this.position, position);
    this.bounds = { ...this.position,
      left: this.position.left ?? (1360 - this.position.width) / 2,
      top: this.position.top ?? (900 - this.position.height) / 2 };
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
  async close(options) { await this._onClose(options); this.rendered = false; return this; }
}

export async function checkWorkforcePlannerWindow() {
const previous = Object.fromEntries(["foundry", "game", "requestAnimationFrame"].map(key => [key, globalThis[key]]));
const frames = [];
try {
  globalThis.requestAnimationFrame = callback => { frames.push(callback); };
  globalThis.game = { user: { isGM: true }, settings: {
    get() { assert.fail("frame checks must not read world data"); },
    set() { assert.fail("frame checks must not write world data"); }
  } };
  globalThis.foundry = { applications: { api: { ApplicationV2: OpeningApplication, HandlebarsApplicationMixin: Base => Base } } };
  const { SkyholdWorkforcePlanner } = await import("../apps/workforce-planner-app.js");
  const { SkyholdData } = await import("../data/store.js");
  const { mergeHoldingDefaults } = await import("../data/normalizers.js");
  const { buildWorkforceModel } = await import("../apps/domains/workforce-planner.js");
  const { hybridRuntimeFixture } = await import("./hybrid-labor-runtime-check.mjs");
  for (const isGM of [true, false]) {
    game.user.isGM = isGM;
    for (const position of [undefined, { width: 960, height: 620 }]) {
      const app = new SkyholdWorkforcePlanner({ holdingId: "demo" }, { position });
      const expected = position ?? SkyholdWorkforcePlanner.DEFAULT_OPTIONS.position;
      await app.render({ force: true });
      assert.deepEqual(app.bounds, { ...expected, left: (1360 - expected.width) / 2, top: (900 - expected.height) / 2 },
        "first render must use the configured size and center, not the intrinsic 200px frame");
      assert.equal(app._lastWindowFrame.width, expected.width);
      app.setPosition({ width: 920, height: 600 });
      frames.splice(0).forEach(callback => callback());
      app.setPosition({ left: 180, top: 120 });
      await app.render({ force: true });
      assert.deepEqual(app.bounds, { left: 180, top: 120, width: 920, height: 600 }, "rerender must preserve a user's frame");
      SkyholdWorkforcePlanner.instances.set("demo", app);
      assert.equal(SkyholdWorkforcePlanner.open({ holdingId: "demo" }), app);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(app.bounds.width, 920, "opening an existing window must preserve its resized width");
      await app.close({});
      assert.equal(app._windowFrameSyncHandler, null, "close must release frame observation");
      assert.equal(SkyholdWorkforcePlanner.instances.has("demo"), false);
      frames.splice(0).forEach(callback => callback());
    }
  }
  const originalUpdateHolding = SkyholdData.updateHolding;
  let saves = 0;
  SkyholdData.updateHolding = async () => { saves += 1; return { ok: true }; };
  try {
    for (const isGM of [true, false]) {
      game.user.isGM = isGM;
      const holding = mergeHoldingDefaults({ id: "preview", visibility: "public", gm: { playersCanEditBuildings: true },
        people: { list: [{ id: "worker", name: "Работник", age: 30, ageGroup: "Вз", visibility: "public",
          attributes: { strength: 4, agility: 4, wits: 4, empathy: 4 } }] },
        buildings: { list: [{ id: "wood", name: "Лесоповал", status: "built", lifecycle: "built", constructionStatus: "built", condition: "normal",
          workersMax: 2, workersMin: 1, wageDailyCopper: 12, functions: { production: true },
          productionLines: [{ id: "logs", active: true, source: "workers", workQd: 2, resourceId: "wood", formula: "2" }] }] } });
      const app = new SkyholdWorkforcePlanner({ holdingId: holding.id });
      app.permissions = { isGM, canEditBuildings: true };
      app.planningOptions = { isGM };
      app.requestRender = () => {};
      app._reset(holding, 7);
      app.draft.plan.goals.push({ sourceId: "wood", functionId: "production:logs", normalQd: 4 });
      app._model = buildWorkforceModel(app.base, app.draft, app.service, app.planningOptions);
      const draftBefore = structuredClone(app.draft), holdingBefore = structuredClone(holding), savesBefore = saves;
      const action = (name) => app._action({ preventDefault() {} }, { dataset: { action: `workforce-${name}` } });
      await action("suggest");
      assert.ok(app.preview?.changes.length, "automatic assignment must first produce a reviewable proposal");
      assert.deepEqual(app.draft, draftBefore, "a proposal cannot silently change the editable draft");
      await assert.rejects(app._save(false), /проверку черновика/, "an unaccepted proposal must block saving even when the draft is already dirty");
      assert.equal(saves, savesBefore, "blocked preview saving must not reach persistence");
      await action("accept-preview");
      assert.equal(app.preview, null);
      assert.ok(app.draft.edited.includes("worker"), "acceptance must apply the proposed assignments to the draft");
      assert.equal(saves, savesBefore, "accepting into a draft must not save world data");
      assert.deepEqual(holding, holdingBefore, "proposal and acceptance must leave world data untouched");
      await app._save(false);
      assert.equal(saves, savesBefore + 1, "an accepted draft reaches persistence only after explicit save");
    }
    for (const isGM of [true, false]) {
      game.user.isGM = isGM;
      const { holding } = hybridRuntimeFixture();
      const app = new SkyholdWorkforcePlanner({ holdingId: holding.id });
      app.permissions = { isGM, canEditBuildings: true }; app.planningOptions = { isGM };
      app.requestRender = () => {}; app._reset(holding, 8); app.latest = { holding, revision: 8 };
      app._model = buildWorkforceModel(app.base, app.draft, app.service, app.planningOptions);
      await app._onRender({}, {});
      const field = { dataset: { workforceField: isGM ? "staff-rate" : "staff-ot", personId: "worker-0" },
        type: "number", value: isGM ? "24" : "2" };
      field.closest = () => field;
      app.handlers.get("change")({ target: field, type: "change" });
      assert.equal(app.dirty, true, "Unapplied GM/player form input must protect the draft from silent replacement or closing");
      assert.equal(app.draft.staffAppointments["worker-0"].wageDailyCopper, 12);
      await assert.rejects(app._save(false), /неприменённые значения/, "Global save must not silently persist the old displayed value");
      const action = (name) => app._action({ preventDefault() {} }, { dataset: { action: `workforce-${name}`, personId: "worker-0" } });
      await action("tenday");
      assert.match(app.message, /сохраните план/, "Calculation must explain that the on-screen draft has not been saved");
      await app.close({}); assert.equal(app.preview.closeAfterDiscard, true);
      await action("cancel-preview"); await action("staff-save");
      assert.equal(app.inputValues.size, 0, "Applying the row must remove its pending-input guard");
      assert.equal(app.draft.staffAppointments["worker-0"].wageDailyCopper, isGM ? 24 : 12);
      assert.equal(app.draft.staffAppointments["worker-0"].overtimeQd, isGM ? 0 : 2);
      assert.equal(app.dirty, true);
      await app.close({}); await action("accept-preview");
      assert.equal(app.rendered, false, "Accepting close-time discard must actually close the window");
      assert.equal(app.dirty, false);
    }
  } finally { SkyholdData.updateHolding = originalUpdateHolding; }
  console.log("Workforce window: GM/player frame lifecycle and proposal acceptance before explicit save passed.");
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkWorkforcePlannerWindow();
}
