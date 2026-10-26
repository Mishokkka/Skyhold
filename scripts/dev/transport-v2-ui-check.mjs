import assert from "node:assert/strict";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { SkyholdData, registerMarketOperationExecutor } from "../data/store.js";
import { prepareMarketAuthorityContext } from "../apps/market/authority-context.js";
import { prepareTransportContext } from "../apps/domains/transport-context.js";
import { bookTransportOrder } from "../engines/transport/runtime.js";

globalThis.foundry = { applications: { api: {
  ApplicationV2: class { render() {} async close() {} async _prepareContext() { return {}; } },
  HandlebarsApplicationMixin: (base) => base
} } };
const gm = { id: "gm", isGM: true, active: true }, player = { id: "player", isGM: false, active: true };
globalThis.game = { user: gm, users: [gm, player], socket: { emit() {} }, settings: { get() {} }, modules: new Map() };
const { SkyholdTransportApp } = await import("../apps/transport-app.js");
const { data, holding } = worldMarketFixture();
holding.type = "village"; holding.visibility = "public"; holding.gm.playersCanUseStorage = true;
holding.gm.modifiers.marketConnectionsLevel = 6;
data.meta.transportV2 = { version: 2, enabled: true, clockQd: 0, runs: [] };
SkyholdData.view = () => data;
const market = prepareMarketAuthorityContext({ data, holding, isGM: true }).markets.find((row) => row.regionId === "a");
const offer = prepareMarketAuthorityContext({ data, holding, marketId: market.id, isGM: true }).quote.offers.find((row) => row.resourceId === "test-freight");
const request = { marketId: market.id, quantities: { [offer.id]: 2 }, insurance: false };
let app = SkyholdTransportApp.open({ holdingId: holding.id, request });
assert.equal((await app._prepareContext({})).canConfirm, true);
game.user = player;
assert.equal((await app._prepareContext({})).canConfirm, true, "authorized players can request an authority-GM booking");
game.socket = null;
assert.equal((await app._prepareContext({})).canConfirm, false, "offline authority disables confirmation");
game.socket = { emit() {} };
const quote = prepareTransportContext({ data, holding, request, isGM: true });
const order = bookTransportOrder({ state: data.meta.transportV2, holding, plan: quote.plan, services: quote.services,
  id: "visibility-order", direction: "inbound", commercial: quote.commercial });
data.catalog.marketEconomy.countries[0].visibility = "gm";
const hidden = await app._prepareContext({});
assert.equal(hidden.orders[0].market, "Скрытый рынок");
assert.ok(hidden.orders[0].stages.every((stage) => stage.path === "Скрытый участок"));
game.user = gm;
assert.equal((await app._prepareContext({})).orders[0].market, order.commercial.marketLabel);
data.catalog.marketEconomy.countries[0].visibility = "public";
await app._prepareContext({});
let resolve, calls = 0;
registerMarketOperationExecutor(() => { calls++; return new Promise((done) => { resolve = done; }); });
app._pending = { type: "transport-book", operationId: "late-receipt", holdingId: holding.id };
SkyholdTransportApp.sessions.set(holding.id, app._pending);
const pending = app._submit();
await app.close();
app = SkyholdTransportApp.open({ holdingId: holding.id, request });
assert.equal((await app._prepareContext({})).pending, true);
await app._submit();
assert.equal(calls, 1, "reopening and retrying an in-flight request cannot dispatch another command");
resolve({ ok: true }); await pending;
const settled = await app._prepareContext({});
assert.equal(settled.pending, false); assert.equal(settled.busy, false);
assert.equal(app.request, null, "late success clears the reopened checkout");
await app.close();
console.log("transport-v2 UI: GM/player permissions, offline authority, ordinary hidden-route visibility and late receipt after reopening passed");
