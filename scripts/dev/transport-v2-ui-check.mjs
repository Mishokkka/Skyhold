import assert from "node:assert/strict";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { SkyholdData, registerMarketOperationExecutor } from "../data/store.js";
import { prepareMarketAuthorityContext } from "../apps/market/authority-context.js";
import { prepareTransportContext } from "../apps/domains/transport-context.js";
import { bookTransportOrder } from "../engines/transport/runtime.js";
import { ensureTransportState } from "../data/transport/state.js";

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
ensureTransportState(data);
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
holding.special.market.orders = [{ id: "historical", status: "delivered", countryId: data.catalog.marketEconomy.countries[0].id,
  marketLabel: "PRIVATE MARKET", cargo: [{ name: "Cloth", qty: 2 }] }];
const hidden = await app._prepareContext({});
assert.equal(hidden.orders[0].market, "Скрытый рынок");
assert.ok(hidden.orders[0].stages.every((stage) => stage.path === "Скрытый участок"));
assert.equal(hidden.archive[0].market, "Скрытый рынок");
assert.deepEqual(Object.keys(hidden.archive[0]).sort(), ["cargo", "direction", "market", "status"], "legacy history is read-only");
game.user = gm;
assert.equal((await app._prepareContext({})).orders[0].market, order.commercial.marketLabel);
assert.equal((await app._prepareContext({})).archive[0].market, "PRIVATE MARKET");
data.catalog.marketEconomy.countries[0].visibility = "public";
const physical = data.meta.transportV2.runs[0];
physical.incident = { status: "pending" };
physical.claims.push({ holdingId: holding.id, orderId: "incoming", stage: 1, manifestReady: false, load: 1 });
assert.equal((await app._prepareContext({})).incidents[0].awaitingCargo, holding.name,
  "GM sees which holding must resolve its connecting cargo before a shared loss");
game.user = player;
assert.deepEqual((await app._prepareContext({})).incidents, [], "incident coordination remains GM-only");
game.user = gm;
physical.incident = null; physical.claims.pop();
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
