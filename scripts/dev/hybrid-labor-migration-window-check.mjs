import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SkyholdData } from "../data/store.js";

export async function checkHybridLaborMigrationWindow() {
  const prior = Object.fromEntries(["foundry", "game", "Hooks", "ui"].map((key) => [key, globalThis[key]]));
  const oldGet = SkyholdData.get, oldTransaction = SkyholdData.transaction;
  const hooks = new Map();
  let closed = 0;
  let data = { meta: { revision: 4 }, catalog: { buildings: [] }, holdings: [{ id: "h", name: "Preview",
    people: { list: [{ id: "p", name: "Worker", age: 30, ageGroup: "Вз", attributes: { strength: 5, agility: 3, wits: 3, empathy: 3 }, workAssignment: "mill", workAllocationMode: "legacy", workAllocations: [] }] },
    buildings: { list: [{ id: "mill", name: "Mill", templateId: "lumbermill", workersMax: 2, workersMin: 1,
      wageDailyCopper: 12, assignedWorkerIds: ["p"], functions: { production: true },
      productionLines: [{ id: "logs", source: "workers", active: true, workQd: 2, outputQty: 2, resourceId: "wood" }] }] } }] };
  const initial = structuredClone(data);
  class ApplicationStub {
    async _prepareContext() { return {}; }
    async _onClose() { closed++; }
    async close(options) { await this._onClose(options); return this; }
  }
  try {
    globalThis.foundry = { applications: { api: { ApplicationV2: ApplicationStub, HandlebarsApplicationMixin: (Base) => Base } } };
    globalThis.game = { user: { isGM: true }, settings: { get: () => undefined, set: () => assert.fail("preview must not write world settings") } };
    globalThis.Hooks = { on: (name, callback) => { hooks.set(name, callback); return name; }, off: (name) => hooks.delete(name) };
    globalThis.ui = { notifications: { warn() {} } };
    SkyholdData.get = () => structuredClone(data);
    SkyholdData.transaction = () => assert.fail("preview and no-op Apply must not write world data");
    const { SkyholdHybridLaborMigration } = await import("../apps/editors/hybrid-labor-migration.js");
    const app = new SkyholdHybridLaborMigration({ holdingId: "h" });
    app.requestRender = () => {};
    let context = await app._prepareContext({});
    assert.equal(context.canApply, false, "a legacy worker needs an explicit migration decision");
    assert.equal(context.people.length, 1);
    assert.ok(context.people[0].choices.some((row) => row.value === "staff:mill"));
    assert.deepEqual(data, initial, "opening and preparing the real window is read-only");
    app._change({ target: { dataset: { hybridField: "decision", personId: "p" }, value: "staff:mill" } });
    assert.equal((await app._prepareContext({})).canApply, false, "selecting a building never silently chooses its first line");
    app._change({ target: { dataset: { hybridField: "primary", personId: "p" }, value: "production:logs" } });
    context = await app._prepareContext({});
    assert.equal(context.canApply, true);
    assert.deepEqual(data, initial);
    hooks.get("fblSkyholdDataChanged")();
    assert.equal((await app._prepareContext({})).canApply, false, "an external revision invalidates the visible preview");
    app._refresh();
    assert.equal((await app._prepareContext({})).canApply, true, "refresh keeps explicit local choices and recomputes them");
    game.user.isGM = false;
    assert.equal((await app._prepareContext({})).canApply, false, "a player cannot apply the preview");
    const choices = structuredClone(app.decisions);
    app._change({ target: { dataset: { hybridField: "decision", personId: "p" }, value: "free" } });
    assert.deepEqual(app.decisions, choices, "player edits cannot enter the migration decision path");
    game.user.isGM = true;
    data.holdings[0] = structuredClone(app.plan.targetHolding);
    app.decisions = {}; app.profiles = {}; app._refresh();
    assert.equal((await app._prepareContext({})).canApply, false, "an already migrated state is a no-op");
    await app._apply();
    app.busy = true;
    await app.close({});
    assert.equal(closed, 0, "an in-flight write keeps its window alive");
    app.busy = false;
    await app.close({});
    assert.equal(closed, 1);
    assert.equal(hooks.size, 0, "closing removes the data revision observer");
  } finally {
    SkyholdData.get = oldGet; SkyholdData.transaction = oldTransaction;
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkHybridLaborMigrationWindow();
  console.log("Hybrid labor migration window: explicit decisions, read-only preview, stale revision, GM permissions and no-op passed.");
}
