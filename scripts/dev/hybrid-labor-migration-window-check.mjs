import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SkyholdData } from "../data/store.js";

export async function checkHybridLaborMigrationWindow() {
  const prior = Object.fromEntries(["foundry", "game", "Hooks", "ui", "document"].map((key) => [key, globalThis[key]]));
  const oldGet = SkyholdData.get, oldTransaction = SkyholdData.transaction;
  const hooks = new Map();
  let closed = 0;
  let nextElement;
  let nextActiveElement;
  let data = { meta: { revision: 4 }, catalog: { buildings: [] }, holdings: [{ id: "h", name: "Preview",
    people: { list: [{ id: "p", name: "Worker", age: 30, ageGroup: "Вз", attributes: { strength: 5, agility: 3, wits: 3, empathy: 3 }, workAssignment: "mill", workAllocationMode: "legacy", workAllocations: [] }] },
    buildings: { list: [{ id: "mill", name: "Mill", templateId: "lumbermill", workersMax: 2, workersMin: 1,
      wageDailyCopper: 12, assignedWorkerIds: ["p"], functions: { production: true },
      productionLines: [{ id: "logs", source: "workers", active: true, workQd: 2, outputQty: 2, resourceId: "wood" }] }] } }] };
  const initial = structuredClone(data);
  class ApplicationStub {
    async _prepareContext() { return {}; }
    async render() { this.element = nextElement; if (nextActiveElement) globalThis.document.activeElement = nextActiveElement; return this; }
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
    assert.equal(context.buildings[0].previous, "Прежние правила");
    assert.equal(context.buildings[0].selectionLabel, "Рекомендация");
    assert.equal(context.buildings[0].modeOptions.find((row) => row.selected).value, app.plan.targetHolding.buildings.list[0].labor.mode,
      "the displayed recommendation must be the actual preview target");
    assert.match(context.applyHint, /решите вопросы/);
    assert.equal(context.changedPeople, 0);
    assert.ok(context.people[0].choices.some((row) => row.value === "staff:mill"));
    assert.deepEqual(data, initial, "opening and preparing the real window is read-only");
    app._change({ target: { dataset: { hybridField: "decision", personId: "p" }, value: "staff:mill" } });
    assert.equal((await app._prepareContext({})).canApply, false, "selecting a building never silently chooses its first line");
    app._change({ target: { dataset: { hybridField: "primary", personId: "p" }, value: "production:logs" } });
    context = await app._prepareContext({});
    assert.equal(context.canApply, true);
    assert.match(context.applyHint, /План готов/);
    assert.equal(context.changedPeople, 1, "the summary includes changed resident assignments, not only buildings");
    assert.match(context.people[0].previous, /Mill/, "existing employment is described with the building name");
    assert.match(context.people[0].decisionHint, /штатное назначение/);
    const selectedField = { dataset: { hybridField: "primary", personId: "p" } };
    let restoredFocus = false;
    globalThis.document = { activeElement: selectedField };
    app.element = { contains: (element) => element === selectedField };
    nextElement = { querySelectorAll: () => [
      { dataset: { hybridField: "primary", personId: "other" }, focus() { assert.fail("another resident must not receive focus"); } },
      { dataset: { ...selectedField.dataset }, focus(options) { restoredFocus = options.preventScroll; } }
    ] };
    app.rendered = true;
    await app.render({ focus: false });
    assert.equal(restoredFocus, true, "rerender restores the same control without scrolling the preview");
    app.element = { contains: (element) => element === selectedField };
    nextActiveElement = {};
    restoredFocus = false;
    await app.render({ focus: false });
    assert.equal(restoredFocus, false, "an asynchronous rerender must not steal focus back from another window");
    assert.deepEqual(data, initial);
    hooks.get("fblSkyholdDataChanged")();
    assert.equal((await app._prepareContext({})).canApply, false, "an external revision invalidates the visible preview");
    app._refresh();
    assert.equal((await app._prepareContext({})).canApply, true, "refresh keeps explicit local choices and recomputes them");
    game.user.isGM = false;
    assert.equal((await app._prepareContext({})).canApply, false, "a player cannot apply the preview");
    assert.equal((await app._prepareContext({})).readOnly, true);
    assert.match((await app._prepareContext({})).applyHint, /только ГМ/);
    const choices = structuredClone(app.decisions);
    app._change({ target: { dataset: { hybridField: "decision", personId: "p" }, value: "free" } });
    assert.deepEqual(app.decisions, choices, "player edits cannot enter the migration decision path");
    game.user.isGM = true;
    data.holdings[0] = structuredClone(app.plan.targetHolding);
    app.decisions = {}; app.profiles = {}; app._refresh();
    assert.equal((await app._prepareContext({})).canApply, false, "an already migrated state is a no-op");
    assert.match((await app._prepareContext({})).applyHint, /Изменений.*нет/);
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
