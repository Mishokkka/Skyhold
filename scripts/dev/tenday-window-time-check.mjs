import assert from "node:assert/strict";
import { SkyholdData } from "../data/store.js";

globalThis.foundry = { applications: { api: {
  ApplicationV2: class { async _onClose() {} },
  HandlebarsApplicationMixin: (Base) => Base
} } };
const hooks = new Map();
let hookId = 0;
globalThis.Hooks = {
  on(name, callback) { const id = ++hookId; hooks.set(id, { name, callback }); return id; },
  off(name, id) { assert.equal(hooks.get(id)?.name, name); hooks.delete(id); }
};
const emit = (name) => { for (const hook of hooks.values()) if (hook.name === name) hook.callback(); };
const { SkyholdTendayApp } = await import("../apps/tenday-app.js");
const data = { holdings: [{ id: "village", gm: { food: { rationUnitsPerResident: 10 } } }] };
SkyholdData.view = () => data;
let current = true, calculations = 0, renders = 0;
const workflow = {
  _tendayDependencyHash: () => "unchanged-data",
  _isPreparedTendayCurrent: () => current,
  async _prepareTendayOperation() {
    calculations++;
    return current ? { ok: true, operationId: `period-${calculations}`, dependencyHash: "unchanged-data" }
      : { ok: false, message: "Calendar is behind the target" };
  }
};
const app = new SkyholdTendayApp({ workflow, holdingId: "village" });
app.rendered = true;
app.requestRender = () => { renders++; };
await app.prepare();
const prepared = app.prepared;
assert.equal(calculations, 1);
await app.prepare();
assert.equal(calculations, 1, "an unchanged preview reuses its fixed random outcomes");
assert.equal(app.prepared, prepared);

current = false;
const beforeRewind = renders;
emit("fblSkyholdCalendariaChanged");
assert.equal(renders, beforeRewind + 1);
assert.equal(app._isStale(data), true);
current = true;
emit("fblSkyholdCalendariaChanged");
assert.equal(renders, beforeRewind + 2, "restoring the calendar refreshes the formerly stale window too");
assert.equal(app._isStale(data), false);

current = false;
await app.prepare();
assert.equal(calculations, 2, "calendar invalidation is checked even when data hashes match");
assert.equal(app.phase, "error", "a cached preview cannot mask the current calendar block");
assert.equal(app.prepared, null);
current = true;
await app.prepare();
assert.equal(app.prepared, prepared, "restoring time can reuse the same legitimate pending outcomes");
assert.equal(calculations, 2);
await app._onClose({});
assert.equal(hooks.size, 0, "closing removes both data and calendar subscriptions");
console.log("Tenday window time: rewind/restore, stale cache, fixed outcomes and hook cleanup passed.");
