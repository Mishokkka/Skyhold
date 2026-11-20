import assert from "node:assert/strict";
import fs from "node:fs";
import { transportFixture, transportHarness, transportRequest } from "./fixtures/transport-v2.mjs";
import { prepareMarketAuthorityContext } from "../apps/market/authority-context.js";
import { prepareTransportContext, transportSourceToken } from "../apps/domains/transport-context.js";
import { normalizeSkyholdData } from "../data/normalizers.js";
import { SkyholdData } from "../data/store.js";

const gm = { id: "gm", isGM: true, active: true }, player = { id: "player", isGM: false, active: true };
globalThis.game = { user: gm, users: [gm, player], settings: { get() {} }, socket: { emit() {} }, modules: new Map() };
globalThis.foundry = { applications: { api: {
  ApplicationV2: class {
    constructor(options = {}) { this.id = options.id; }
    async _prepareContext() { return {}; }
    async _onRender() {}
    render() {}
    async close() {}
  },
  HandlebarsApplicationMixin: Base => Base
} } };
const { SkyholdMarketApp } = await import("../apps/market-app.js");
const { SkyholdTransportApp } = await import("../apps/transport-app.js");

function accessFixture() {
  const f = transportFixture();
  f.holding.gm.modifiers.marketConnectionsLevel = 3;
  f.data.catalog.resources[0].marketAccessDifficulty = 1;
  f.data.catalog.eventRegions = [
    { value: "home", marketTransportModes: ["airship"], marketLinks: [
      { regionId: "a", distanceKm: 10, ursCost: 3, modes: ["airship"] },
      { regionId: "via", distanceKm: 40, ursCost: 1, modes: ["airship"] }] },
    { value: "via", marketTransportModes: ["caravan"], marketLinks: [
      { regionId: "a", distanceKm: 40, ursCost: 1, modes: ["airship"] }] },
    { value: "a", marketTransportModes: ["airship"], marketLinks: [] }
  ].map(row => ({ ...row, label: row.value, countryId: "public" }));
  return f;
}
for (const user of [gm, player]) for (const direction of ["inbound", "outbound"]) {
  game.user = user;
  const f = accessFixture();
  const legacy = prepareMarketAuthorityContext({ ...f, marketId: "a", isGM: user.isGM });
  assert.equal(legacy.quote.logistics.routeAccessCost, 3);
  const app = new SkyholdMarketApp({ holdingId: f.holding.id });
  SkyholdData.view = () => f.data;
  app.marketId = legacy.market.id;
  const { quote } = app._marketSnapshot();
  const offer = quote.offers.find(row => row.resourceId === "test-freight");
  assert.ok(offer, "the ordinary market window shows cargo available on the own vessel's legal route");
  assert.equal(offer.requiredUrs, 3);
  const request = { marketId: "a", direction, quantities: { [direction === "inbound" ? offer.id : "test-freight"]: 2 },
    ownShipId: f.ship.id, returnHome: true, insurance: false };
  const preview = prepareTransportContext({ ...f, request, isGM: user.isGM });
  assert.equal(preview.plan.stages.reduce((sum, stage) => sum + stage.service.accessCost, 0), 2);
  assert.throws(() => prepareTransportContext({ ...f, request: { ...request, ownShipId: "" }, isGM: user.isGM }),
    /нет доступной перевозки/, "discovering cargo never authorizes the over-limit hired route");
  assert.throws(() => prepareTransportContext({ ...f,
    request: { ...request, quantities: { [direction === "inbound" ? offer.id : "test-freight"]: 1000000 } }, isGM: user.isGM }),
  /больше доступного/, "stock and FIFO limits still apply");
  const h = transportHarness(f);
  const { operation } = await h.book(request, `access-${direction}-${user.id}`, user.isGM);
  const after = structuredClone(h.data);
  assert.equal((await h.execute(operation, { userId: user.id, remote: !user.isGM })).replay, true);
  assert.deepEqual(h.data, after);
  const reloaded = normalizeSkyholdData(h.data);
  assert.deepEqual(reloaded.holdings[0].special.transportV2, h.holding.special.transportV2);
  h.advance(preview.plan.shipReleaseQd);
  assert.equal(h.holding.special.transportV2.orders.at(-1).status, "delivered");
  f.holding.gm.modifiers.marketConnectionsLevel = 2;
  assert.throws(() => prepareTransportContext({ ...f, request, isGM: user.isGM }), /больше доступного/);
}

// The unified 3-choice checkout switches cleanly between regular, charter and own ship for GM and player.
const template = fs.readFileSync(new URL("../../templates/transport-app.hbs", import.meta.url), "utf8");
assert.match(template, /data-action="transport-select-mode"/, "transport checkout exposes the 3-mode choice cards");
assert.doesNotMatch(template, /data-transport-pin=/, "manual per-leg pin clutter is removed");
assert.doesNotMatch(template, /data-transport-exclude=/, "manual carrier exclusion clutter is removed");

for (const user of [gm, player]) {
  game.user = user;
  const f = transportFixture();
  const request = transportRequest(f, "a", { mode: "regular" }, user.isGM);
  const h = transportHarness(f);
  SkyholdData.view = () => h.data;
  const app = new SkyholdTransportApp({ holdingId: f.holding.id });
  app.request = request;
  app.requestRender = () => {};
  let context = await app._prepareContext({});
  assert.equal(context.choices.length, 3, "shows regular, charter and own-ship choice cards");
  assert.equal(context.choices.find(row => row.mode === "regular").selected, true);
  assert.equal(context.canConfirm, true);
  await app._action(null, { dataset: { action: "transport-select-mode", mode: "charter" } });
  context = await app._prepareContext({});
  assert.equal(context.choices.find(row => row.mode === "charter").selected, true);
  assert.equal(app.request.mode, "charter");
  await app._action(null, { dataset: { action: "transport-select-mode", mode: "owned" } });
  context = await app._prepareContext({});
  assert.equal(context.choices.find(row => row.mode === "owned").selected, true);
  assert.equal(context.isOwnedMode, true);
  let outcome, submitted;
  app._submit = async () => {
    submitted = structuredClone(app._pending);
    SkyholdTransportApp.sessions.delete(app.holdingId);
    app._pending = null;
    outcome = await h.execute(submitted, { userId: user.id, remote: !user.isGM });
  };
  await app._action(null, { dataset: { action: "transport-confirm" } });
  assert.equal(outcome?.ok, true, app._error);
  assert.equal(submitted.sourceToken, transportSourceToken(f.data, f.holding));
  const order = h.holding.special.transportV2.orders.at(-1);
  h.advance(Math.max(order.plan.arrivalQd, order.plan.shipReleaseQd ?? 0));
  assert.equal(order.status, "delivered");
}
console.log("PR comments: GM/player market discovery, legal own import/export, stock/access refusal, replay/reload and 3-choice UI booking passed.");
