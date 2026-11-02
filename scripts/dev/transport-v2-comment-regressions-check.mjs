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
  const quote = app._marketQuote(f.holding, f.data, legacy.market, { isGM: user.isGM });
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

// Check the enclosing template blocks, not just the presence of a selector.
const template = fs.readFileSync(new URL("../../templates/transport-app.hbs", import.meta.url), "utf8");
const stack = [];
for (const match of template.matchAll(/{{([#/])([^}]+)}}|data-transport-(pin|exclude)=/g)) {
  if (match[1] === "#") stack.push(match[2].trim());
  else if (match[1] === "/") stack.pop();
  else assert.ok(!stack.includes("if selected"), "refinement controls must render without a selected plan");
}
for (const user of [gm, player]) {
  game.user = user;
  const f = transportFixture();
  f.data.catalog.eventRegions[0].marketLinks = Array.from({ length: 140 }, (_, index) => ({
    regionId: "a", routeId: `path-${index}`, distanceKm: 150, modes: ["airship"]
  }));
  const request = transportRequest(f, "a", {}, user.isGM);
  const initial = prepareTransportContext({ ...f, request, isGM: user.isGM });
  const last = [...initial.services].sort((a, b) => a.id.localeCompare(b.id)).at(-1);
  f.data.catalog.transportV2.overrides = Object.fromEntries(initial.services.filter(row => row.id !== last.id)
    .map(row => [row.id, { capacity: 1 }]));
  const h = transportHarness(f);
  SkyholdData.view = () => h.data;
  const app = new SkyholdTransportApp({ holdingId: f.holding.id });
  app.request = request;
  app.requestRender = () => {};
  let context = await app._prepareContext({});
  assert.equal(context.selected, null);
  assert.equal(context.canConfirm, false);
  assert.match(context.quoteError, /Поиск достиг лимита/);
  const group = context.refinements.groups.find(row => row.from === "a");
  assert.ok(group.options.some(row => row.value === last.id));
  const handlers = new Map();
  app.element = { querySelectorAll: () => [], addEventListener: (type, callback) => handlers.set(type, callback) };
  await app._onRender(context, {});
  const change = (dataset, value) => handlers.get("change")({ target: { closest: () => ({ dataset, value }) } });
  change({ transportPin: group.from }, last.id);
  context = await app._prepareContext({});
  assert.equal(context.canConfirm, true, JSON.stringify({ error: context.quoteError, pins: app.request.pins, canUse: context.canUse }));
  assert.equal(app.request.pins.a, last.id);
  let outcome, submitted;
  app._submit = async () => {
    submitted = structuredClone(app._pending);
    outcome = await h.execute(submitted, { userId: user.id, remote: !user.isGM });
  };
  await app._action(null, { dataset: { action: "transport-confirm" } });
  assert.equal(outcome?.ok, true, app._error);
  assert.equal(submitted.sourceToken, transportSourceToken(f.data, f.holding));
  const order = h.holding.special.transportV2.orders.at(-1);
  h.advance(order.plan.arrivalQd);
  assert.equal(order.status, "delivered");
  app._pending = null;
  SkyholdTransportApp.sessions.delete(f.holding.id);
  change({ transportPin: group.from }, "");
  assert.equal(app.request.pins.a, undefined, "automatic choice removes a pin rather than storing an empty constraint");
  change({ transportExclude: "true" }, last.companyId);
  assert.ok(app.request.excluded.includes(last.companyId));
  await app._action(null, { dataset: { action: "transport-restore-companies" } });
  assert.deepEqual(app.request.excluded, []);
}
console.log("PR comments: GM/player market discovery, legal own import/export, stock/access refusal, replay/reload and UI recovery through actual handlers and authority booking passed.");
