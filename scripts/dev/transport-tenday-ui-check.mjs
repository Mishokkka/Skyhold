import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SkyholdData } from "../data/store.js";
import { transportFixture } from "./fixtures/transport-v2.mjs";

globalThis.foundry = { applications: { api: { ApplicationV2: class { async _prepareContext() { return {}; } async _onClose() {} }, HandlebarsApplicationMixin: Parent => Parent } } };
globalThis.game = { user: { id: "gm", isGM: true } };
const hooks = new Map(); let hookId = 0;
globalThis.Hooks = { on(name, callback) { const id = ++hookId; hooks.set(id, { name, callback }); return id; }, off(_name, id) { hooks.delete(id); } };
const { SkyholdTendayApp } = await import("../apps/tenday-app.js");
const template = readFileSync(new URL("../../templates/tenday-app.hbs", import.meta.url), "utf8");
assert.ok(template.indexOf("{{#if isTransportReview}}") > template.indexOf("</header>"), "review is in the scrollable body, not the header");
assert.match(template, /data-action="tenday-transport-decision"/);
assert.match(template, /aria-label="Задержка рейса/);
const event = { preventDefault() {}, stopPropagation() {} };
const card = { querySelector: selector => ({ value: selector.includes("delay") ? "1.5" : "12.5" }) };

function setup() {
  const f = transportFixture(); let decided = false, calculations = 0;
  SkyholdData.view = () => f.data;
  const workflow = {
    _tendayDependencyHash: () => "source",
    _isPreparedTendayCurrent: prepared => prepared.dataRevision === f.data.meta.revision,
    async _prepareTendayOperation() {
      calculations++;
      return { ok: decided, holdingId: f.holding.id, holdingName: f.holding.name, qd: 40, dependencyHash: "source", dataRevision: f.data.meta.revision,
        ...(decided ? { operationId: "ready", report: {}, changeSet: {} } : { transportReview: [{ runId: "run", name: "Shared run", from: "A", to: "B",
          localQd: 4, canResolve: true, canLose: true, blockers: [] }], message: "Review" }) };
    }
  };
  const open = () => {
    const app = new SkyholdTendayApp({ workflow, holdingId: f.holding.id });
    app.rendered = true; app.requestRender = () => {}; SkyholdTendayApp.instances.set(app.instanceKey, app); return app;
  };
  return { f, workflow, open, done() { decided = true; f.data.meta.revision++; }, get calculations() { return calculations; } };
}
{
  const h = setup(), app = h.open();
  await app.prepare();
  assert.equal(app.phase, "transport");
  const view = await app._prepareContext({});
  assert.equal(view.isTransportReview, true); assert.equal(view.hasPrepared, false); assert.equal(view.canApply, false);
  assert.equal(view.transportReview[0].canResolve, true);
  assert.equal(view.transportReview[0].dateText, "Через 1 дн. от последней проведённой даты");
  let sent = 0, operation;
  app._requestTransportDecision = async op => {
    sent++; operation = structuredClone(op); h.done();
    throw Object.assign(new Error("Timeout after commit"), { code: "timeout", retryable: true });
  };
  await app._onTransportDecision(event, { dataset: { run: "run", outcome: "delay" }, closest: () => card });
  assert.equal(sent, 1); assert.equal(operation.reviewQd, 40); assert.equal(operation.resolution.delayQd, 6);
  assert.equal(operation.resolution.lossBps, 1250);
  const pending = await app._prepareContext({});
  assert.equal(pending.hasTransportRetry, true); assert.equal(pending.canApply, false); assert.equal(pending.transportReview[0].canResolve, false);
  await app._onClose({});
  const reopened = h.open(); await reopened.prepare();
  assert.equal(reopened.phase, "transport", "closing does not forget a command awaiting confirmation");
  reopened._requestTransportDecision = async op => { assert.deepEqual(op, operation); return { ok: true, replay: true }; };
  await reopened._submitTransportDecision();
  assert.equal(reopened.phase, "preview"); assert.equal(SkyholdTendayApp.transportSessions.size, 0);
  assert.equal((await reopened._prepareContext({})).canApply, true);
  await reopened._onClose({});
}
SkyholdTendayApp.preparedCache.clear();
{
  const h = setup(), app = h.open(); await app.prepare();
  app.prepared.transportReview = [{ runId: "carrier:previous", carrier: true, name: "Finite carrier", from: "A", to: "B",
    localQd: 7, canResolve: false, canLose: false, blockers: [{ holdingId: "other", qd: 0, currentDate: true }] }];
  const view = await app._prepareContext({});
  assert.equal(view.canApply, false); assert.equal(view.transportReview[0].canResolve, false);
  assert.equal(view.transportReview[0].blockers[0].currentDate, true);
  assert.match(template, /\{\{#unless carrier\}\}/, "a carrier dependency does not offer incident rolls");
  let opened, sent = 0;
  app._openTransport = holdingId => { opened = holdingId; };
  app._requestTransportDecision = () => { sent++; };
  await app._onTransportRelated({ dataset: { holding: "other", qd: "0" } });
  assert.equal(opened, "other", "an already elapsed dependency opens its current-date transport window");
  await app._onTransportDecision(event, { dataset: { run: "carrier:previous", outcome: "success" }, closest: () => card });
  assert.equal(sent, 0, "a dependency cannot be resolved as a successful incident");
  const originalOpen = SkyholdTendayApp.open;
  try {
    SkyholdTendayApp.open = options => { opened = options; };
    await app._onTransportRelated({ dataset: { holding: "other", qd: "80" } });
    assert.equal(opened.holdingId, "other"); assert.equal(opened.qd, 80);
  } finally { SkyholdTendayApp.open = originalOpen; }
  app.prepared.transportReview[0].canResolve = true;
  let confirmation;
  app._requestTransportDecision = async operation => {
    confirmation = structuredClone(operation); h.done();
    throw Object.assign(new Error("Carrier confirmation response lost"), { code: "timeout", retryable: true });
  };
  await app._onTransportDecision(event, { dataset: { run: "carrier:previous", outcome: "carrier" }, closest: () => card });
  assert.equal(confirmation.resolution.outcome, "carrier");
  assert.equal((await app._prepareContext({})).canApply, false, "lost confirmation replies do not enable household Apply");
  app._requestTransportDecision = async operation => { assert.deepEqual(operation, confirmation); return { ok: true, replay: true }; };
  await app._submitTransportDecision();
  assert.equal(app.phase, "preview"); assert.equal(SkyholdTendayApp.transportSessions.size, 0);
  await app._onClose({});
}
SkyholdTendayApp.preparedCache.clear();
{
  const h = setup(), app = h.open(); await app.prepare();
  let sent = 0; app._requestTransportDecision = async () => { sent++; return { ok: true }; };
  h.f.data.meta.revision++;
  await app._onTransportDecision(event, { dataset: { run: "run", outcome: "success" }, closest: () => card });
  assert.equal(sent, 0, "a stale review cannot publish a new decision");
  globalThis.game.user.isGM = false;
  h.f.data.meta.revision = app.prepared.dataRevision;
  assert.equal((await app._prepareContext({})).transportReview[0].canResolve, false);
  await app._onTransportDecision(event, { dataset: { run: "run", outcome: "success" }, closest: () => card });
  assert.equal(sent, 0, "player rendering and event handling cannot activate GM decisions");
  globalThis.game.user.isGM = true; await app._onClose({});
}
SkyholdTendayApp.preparedCache.clear();
{
  const h = setup(), app = h.open(); await app.prepare();
  let finish, sent = 0;
  app._requestTransportDecision = () => { sent++; return new Promise(resolve => { finish = resolve; }); };
  const submit = app._onTransportDecision(event, { dataset: { run: "run", outcome: "success" }, closest: () => card });
  for (let attempt = 0; !finish && attempt < 1000; attempt++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(typeof finish, "function", "the decision reaches the command adapter");
  await app._onClose({});
  const reopened = h.open(); await reopened.prepare();
  reopened._requestTransportDecision = async () => { sent++; return { ok: true }; };
  await reopened._submitTransportDecision(); assert.equal(sent, 1, "reopening cannot duplicate a still-running request");
  h.done(); finish({ ok: true }); await submit;
  assert.equal(reopened.phase, "preview", "a late response updates the current window and does not revive the closed one");
  await reopened._onClose({});
}
assert.equal(hooks.size, 0); assert.equal(SkyholdTendayApp.transportSessions.size, 0);
console.log("Transport tenday UI: dedicated review, GM/player controls, stale input, exact retry after timeout/reopen, late responses, atomic transitions and hook cleanup passed.");
