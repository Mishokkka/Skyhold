import assert from "node:assert/strict";
import fs from "node:fs";
import { transportFixture, transportRequest, transportHarness } from "./fixtures/transport-v2.mjs";
import { prepareTransportContext } from "../apps/domains/transport-context.js";
import { discoverTransportPorts } from "../apps/domains/transport-discovery.js";
import { buildShipWorldContext } from "../engines/ships/world-market.js";
import { normalizeSkyholdData } from "../data/normalizers.js";
import { SkyholdData } from "../data/store.js";

const region = (value, modes, marketLinks = []) => ({ value, label: value, countryId: "public", marketTransportModes: modes, marketLinks });
const link = (regionId, modes, ursCost = 1) => ({ regionId, modes, ursCost, distanceKm: 40 });
function fixture(extraFirst = false, connected = false) {
  const f = transportFixture();
  f.holding.gm.modifiers.marketConnectionsLevel = 3;
  const extra = Array.from({ length: 23 }, (_, i) => region(`other-${String(i).padStart(2, "0")}`, ["airship", "caravan"],
    connected ? [link("home", ["caravan"]), link("b", ["caravan"])] : []));
  const home = region("home", ["airship", "caravan"], [link("a", ["airship"], 3), link("via", ["airship"])]);
  const via = region("via", ["caravan"], [link("a", ["airship"])]);
  const a = region("a", ["airship", "caravan"], [link("b", ["caravan"])]);
  const b = region("b", ["caravan"]);
  f.data.catalog.eventRegions = extraFirst ? [home, ...extra, via, a, b] : [home, via, a, b, ...extra];
  return f;
}
for (const isGM of [true, false]) for (const direction of ["inbound", "outbound"]) {
  const first = fixture(), reordered = fixture(true);
  const request = transportRequest(first, "b", { direction, ownShipId: first.ship.id, returnHome: true }, isGM);
  const a = prepareTransportContext({ ...first, request, isGM });
  const b = prepareTransportContext({ ...reordered, request, isGM });
  assert.deepEqual(b.plan, a.plan, "unrelated ports and catalog order cannot change the route, cost or schedule");
  assert.equal(b.search.limited, false);
  assert.ok(b.plan.stages.some(stage => stage.service.kind === "owned"));
  assert.ok(b.plan.stages.some(stage => stage.service.kind !== "owned"));
  assert.ok(!b.discovery.points.some(id => id.startsWith("other-")));
  const h = transportHarness(reordered);
  const { operation } = await h.book(request, `ports-${isGM}-${direction}`, isGM);
  const after = structuredClone(h.data);
  assert.equal((await h.execute(operation, { userId: isGM ? "gm" : "player", remote: !isGM })).replay, true);
  assert.deepEqual(h.data, after);
  assert.deepEqual(normalizeSkyholdData(h.data).holdings[0].special.transportV2, h.holding.special.transportV2);
  h.advance(Math.max(b.plan.arrivalQd, b.plan.shipReleaseQd));
  const order = h.holding.special.transportV2.orders.at(-1);
  assert.equal(order.status, "delivered");
  assert.equal(order.received.reduce((sum, lot) => sum + lot.qty, 0), 10);
  assert.equal(order.money.escrowCopper, 0);
  assert.ok(!h.ship.transportOrderId);
}

const gm = { id: "gm", isGM: true, active: true }, player = { id: "player", isGM: false, active: true };
globalThis.game = { user: gm, users: [gm, player], settings: { get() {} }, socket: { emit() {} }, modules: new Map() };
globalThis.foundry = { applications: { api: {
  ApplicationV2: class {
    constructor(options = {}) { this.id = options.id; }
    async _prepareContext() { return {}; }
    async _onRender() {}
    render() {}
  },
  HandlebarsApplicationMixin: Base => Base
} } };
const { SkyholdTransportApp } = await import("../apps/transport-app.js");
for (const user of [gm, player]) for (const direction of ["inbound", "outbound"]) {
  game.user = user;
  const f = fixture(true, true);
  const request = transportRequest(f, "b", { direction, ownShipId: f.ship.id, returnHome: true }, user.isGM);
  const initial = prepareTransportContext({ ...f, request, isGM: user.isGM, allowIncomplete: true });
  assert.equal(initial.plan, null, "the automatic subset has no reachable own-ship transfer port");
  assert.equal(initial.search.limits.ports, true);
  assert.equal(initial.search.limited, true, "port truncation must never masquerade as proof of no route");
  assert.ok(initial.discovery.ports.some(port => port.regionId === "a"));
  assert.ok(!initial.discovery.points.includes("a"));
  assert.equal(initial.discovery.points.length, 24);
  const reverse = structuredClone(f);
  reverse.data.catalog.eventRegions.reverse();
  assert.deepEqual(prepareTransportContext({ ...reverse, request, isGM: user.isGM, allowIncomplete: true }).discovery.points, initial.discovery.points);
  const h = transportHarness(f);
  SkyholdData.view = () => h.data;
  const app = new SkyholdTransportApp({ holdingId: f.holding.id });
  app.request = request;
  app.requestRender = () => {};
  let context = await app._prepareContext({});
  assert.equal(context.canConfirm, false);
  assert.ok(context.transferPorts.some(port => port.value === "a"));
  assert.equal(context.portSearchLimited, true);
  const handlers = new Map();
  app.element = { querySelectorAll: () => [], addEventListener: (type, callback) => handlers.set(type, callback) };
  await app._onRender(context, {});
  const change = (dataset, value) => handlers.get("change")({ target: { closest: () => ({ dataset, value }) } });
  change({ transportField: "transferPortId" }, "a");
  context = await app._prepareContext({});
  assert.equal(context.canConfirm, true, context.quoteError);
  const preview = app._view.quote;
  assert.ok(preview.plan.stages.some(stage => stage.from === "a" || stage.to === "a"));
  assert.ok(preview.discovery.points.length <= 24);
  // Confirmation and existing pins must retain endpoints even without the hint.
  const own = preview.plan.stages.find(stage => stage.service.kind === "owned");
  for (const selection of [{ pins: { [own.from]: own.service.id } },
    { serviceIds: preview.plan.stages.map(stage => stage.service.id) }]) {
    const pinned = prepareTransportContext({ ...f, request: { ...request, transferPortId: "", ...selection }, isGM: user.isGM });
    assert.ok(pinned.discovery.points.includes("a"));
    assert.ok(pinned.plan.stages.some(stage => stage.service.id === own.service.id));
  }
  change({ transportField: "transferPortId" }, "missing");
  context = await app._prepareContext({});
  assert.equal(context.transferUnavailable, true, "a stale selection remains clearable without exposing an invalid port");
  assert.ok(!app._view.quote.discovery.points.includes("missing"));
  change({ transportField: "transferPortId" }, "a");
  await app._prepareContext({});
  let outcome;
  app._submit = async () => { outcome = await h.execute(structuredClone(app._pending), { userId: user.id, remote: !user.isGM }); };
  await app._action(null, { dataset: { action: "transport-confirm" } });
  assert.equal(outcome?.ok, true, app._error);
  h.advance(Math.max(preview.plan.arrivalQd, preview.plan.shipReleaseQd));
  const order = h.holding.special.transportV2.orders.at(-1);
  assert.equal(order.status, "delivered");
  assert.equal(order.received.reduce((sum, lot) => sum + lot.qty, 0), 10);
  assert.equal(order.money.escrowCopper, 0);
  SkyholdTransportApp.sessions.delete(f.holding.id);
}

// Ambiguous punctuation is resolved against known point IDs, including a lower-URS variant.
{
  const f = fixture(true, true), world = buildShipWorldContext(f.data, f.holding);
  world.ports.find(port => port.regionId === "a").regionId = "a:port";
  world.regions.find(row => row.value === "a").value = "a:port";
  for (const row of world.regions) for (const edge of row.marketLinks) if (edge.regionId === "a") edge.regionId = "a:port";
  const result = discoverTransportPorts({ world, holding: f.holding, marketRegionId: "b", endpoint: "home:holding",
    accessLimit: 3, services: [], request: { ownShipId: "ship:1", pins: { "home:holding": "owned:ship:1:home:holding:a:port:access:2" } } });
  assert.ok(result.points.includes("a:port"));
  assert.ok(result.points.length <= 24);
}
// The older physical-route search has its own budget before v2 sees services.
{
  const f = transportFixture(), request = transportRequest(f, "b", {}, false);
  f.data.catalog.eventRegions = [
    region("home", ["airship"], Array.from({ length: 150 }, (_, i) => ({ ...link("a", ["airship"]), routeId: `first-${i}` }))),
    region("a", ["airship"], Array.from({ length: 150 }, (_, i) => ({ ...link("b", ["airship"]), routeId: `last-${i}` }))),
    region("b", ["airship"])
  ];
  const quote = prepareTransportContext({ ...f, request, isGM: false, allowIncomplete: true });
  assert.equal(quote.plan, null);
  assert.equal(quote.search.limits.routes, true);
  assert.equal(quote.search.limits.plans, false);
  assert.equal(quote.search.limited, true);
  assert.match(quote.error, /Поиск достиг лимита/);
}
const template = fs.readFileSync(new URL("../../templates/transport-app.hbs", import.meta.url), "utf8");
const stack = [];
for (const match of template.matchAll(/{{([#/])([^}]+)}}|data-transport-field="transferPortId"/g)) {
  if (match[1] === "#") stack.push(match[2].trim());
  else if (match[1] === "/") stack.pop();
  else {
    assert.ok(!stack.includes("if selected"));
    assert.ok(!stack.includes("if refinements.groups"), "port selection must work even when no services have been generated");
  }
}
console.log("Transport ports: catalog permutations, disconnected ports, truthful limits, bounded search, pins, explicit confirmation and GM/player UI recovery with import/export delivery passed.");
