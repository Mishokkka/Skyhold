import assert from "node:assert/strict";
import { SkyholdData } from "../data/store.js";
import { clone } from "../data/utils.js";
import { migrationCycleFixture } from "./building-catalog-cycle-migration-check.mjs";

export async function checkMigrationPreviewRefresh() {
  const globals = Object.fromEntries(["foundry", "Hooks", "game", "ui"].map(key => [key, globalThis[key]]));
  const originalGet = SkyholdData.get, originalTransaction = SkyholdData.transaction, originalError = console.error;
  const listeners = new Map(), errors = [];
  let world = migrationCycleFixture(), commits = 0, transactions = 0, renders = 0, serial = 0, confirm;
  const event = { preventDefault() {}, stopPropagation() {} };
  try {
    class Base {
      async _prepareContext() { return {}; }
      async _onClose() {}
    }
    globalThis.foundry = { applications: { api: { ApplicationV2: Base, HandlebarsApplicationMixin: Parent => Parent,
      DialogV2: { confirm: () => new Promise(resolve => { confirm = resolve; }) } } } };
    globalThis.Hooks = { on(name, fn) { const id = ++serial; listeners.set(id, { name, fn }); return id; },
      off(name, id) { assert.equal(listeners.get(id)?.name, name); listeners.delete(id); } };
    const changed = () => { for (const row of listeners.values()) if (row.name === "fblSkyholdDataChanged") row.fn(); };
    globalThis.game = { user: { isGM: true } };
    globalThis.ui = { notifications: { error: message => errors.push(message), info() {} } };
    SkyholdData.get = () => clone(world);
    SkyholdData.transaction = async mutate => {
      transactions += 1;
      const draft = clone(world);
      const result = mutate(draft, { skip: value => value });
      commits += 1; world = draft;
      return result;
    };
    console.error = () => {};
    const { SkyholdBuildingCatalogMigration } = await import("../apps/editors/building-catalog-migration.js");
    world.holdings[0].buildings.list[0].productionLines[0].workQd = 2;
    const app = new SkyholdBuildingCatalogMigration();
    app.rendered = true;
    app.requestRender = () => { renders += 1; };
    let context = await app._prepareContext({});
    assert.equal(context.canApply, false);
    assert.equal(context.issueRows[0].holdingName, "Лапута");
    const before = clone(world);
    await app._prepareContext({});
    assert.deepEqual(world, before);
    assert.equal(transactions, 0, "Rendering does not execute a world migration");

    // Reproduce deleting a blocked building while the preview window stays open.
    world.holdings[0].buildings.list.shift(); world.meta.revision += 1;
    changed();
    assert.equal(renders, 1);
    context = await app._prepareContext({});
    assert.equal(context.hasIssues, false);
    assert.equal(context.canApply, true);
    assert.ok(context.changedRows.every(row => row.buildingId !== "built-lumbermill"));
    assert.equal(transactions, 0);
    globalThis.game.user.isGM = false;
    assert.equal((await app._prepareContext({})).canApply, false);
    await app._onApply(event);
    assert.equal(transactions, 0, "A player cannot invoke Apply");
    globalThis.game.user.isGM = true;

    // A read failure disables Apply instead of leaving the previous valid plan active.
    SkyholdData.get = () => { throw new Error("read failed"); };
    changed(); context = await app._prepareContext({});
    assert.equal(context.canApply, false);
    assert.equal(app.plan, null);
    assert.match(context.error, /read failed/);
    SkyholdData.get = () => clone(world);
    app._onRefresh(event);
    assert.equal((await app._prepareContext({})).canApply, true);

    // Refreshing in the background must not change the operation being confirmed.
    const confirmedPlan = app.plan;
    const pendingApply = app._onApply(event);
    assert.equal(typeof confirm, "function");
    world.meta.revision += 1; changed();
    await app._prepareContext({});
    assert.notEqual(app.plan.operationId, confirmedPlan.operationId);
    confirm(true); await pendingApply;
    assert.equal(transactions, 1);
    assert.equal(commits, 0, "A stale confirmation must not apply a new unseen preview");
    assert.match(errors.at(-1), /изменились/);
    await app._onClose({});
    assert.equal(listeners.size, 0, "Closed migration windows unsubscribe from data changes");
  } finally {
    SkyholdData.get = originalGet; SkyholdData.transaction = originalTransaction; console.error = originalError;
    for (const [key, value] of Object.entries(globals)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
}
