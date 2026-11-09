import assert from "node:assert/strict";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { getSkyholdWorkflowService } from "../workflows/skyhold-workflow-service.js";
import { prepareMarketAuthorityContext } from "../apps/market/authority-context.js";
import { transportOfferAccessFixture } from "./fixtures/transport-offer-access.mjs";

globalThis.foundry = { applications: { api: {
  ApplicationV2: class { get state() { return 0; } async _prepareContext() { return {}; } }, HandlebarsApplicationMixin: (Base) => Base
} } };
const { SkyholdMarketApp } = await import("../apps/market-app.js");
for (const isGM of [true, false]) {
  const { data, holding } = transportOfferAccessFixture();
  const initial = prepareMarketAuthorityContext({ data, holding, marketId: "a", isGM });
  const app = new SkyholdMarketApp({ holdingId: holding.id });
  app.outboundQuantities = { "test-freight": 2 };
  const args = { data, holding, market: initial.market, economy: initial.economy, resources: initial.resources, isGM };
  const calculate = () => app._marketOutboundContext({ ...args, quote: app._marketQuote(holding, data, initial.market, args) });
  const automatic = calculate();
  app.carrierId = initial.quote.carriers.find((row) => row.logistics?.routeAccessCost === 2).id;
  const pinned = calculate();
  assert.equal(pinned.plan?.ok, true, "the actual window must retain outbound goods after choosing a restrictive inbound chain");
  assert.deepEqual(pinned.offers, automatic.offers);
  assert.equal(pinned.plan.planToken, automatic.plan.planToken);
}
// Inline legacy route selection has been replaced by the shared transport checkout.
// Goods browsing still honors permissions and preserves both directions independently.
const workflow = getSkyholdWorkflowService(), previousRooms = workflow._storageRooms, previousGame = globalThis.game;
try {
  workflow._storageRooms = () => [{ id: "outdoors", label: "Outside" }];
  for (const isGM of [true, false]) for (const allowed of [true, false]) {
    const { data, holding } = worldMarketFixture();
    holding.visibility = "public"; holding.gm.playersCanUseStorage = allowed;
    const gm = { id: "gm", isGM: true, active: true }, player = { id: "player", isGM: false, active: true };
    globalThis.game = { user: isGM ? gm : player, users: { contents: [gm, player] }, socket: { emit() {} }, modules: new Map(), settings: { get() {} } };
    const quote = { offers: [{ id: "goods", resourceId: "test-freight", name: "Cloth", stock: 10, unitPriceCopper: 20 }], logistics: { ok: true } };
    const app = new SkyholdMarketApp({ holdingId: holding.id });
    app.quantities = { goods: 20 }; app.outboundQuantities = { "test-freight": 3 }; app.ownShipId = "chosen-ship";
    app._marketSnapshot = () => ({ data, holding, markets: [], market: { id: "a", label: "Market" }, quote,
      outbound: { offers: [{ resourceId: "test-freight", qty: 3, available: 10, unitPriceCopper: 20 }] } });
    app._enrichMarketQuoteItems = async value => value;
    const context = await app._prepareContext({});
    assert.equal(context.selectedCount, 10, "shown and submitted purchase both respect the current stock");
    assert.equal(context.canConfirm, isGM || allowed);
    assert.equal(context.outboundCanBook, isGM || allowed);
    assert.equal(context.carrierOptions, undefined, "goods browser no longer presents the retired transport controls");
    const opened = [];
    app._showTransport = async options => opened.push(options);
    await app._onBuy(); await app._onBookOutbound();
    assert.equal(opened.length, isGM || allowed ? 2 : 0);
    if (opened.length) {
      assert.deepEqual(opened.map(row => row.request.direction), ["inbound", "outbound"]);
      assert.deepEqual(opened.map(row => row.request.quantities), [{ goods: 10 }, { "test-freight": 3 }]);
      assert.ok(opened.every(row => row.request.marketId === "a" && row.request.ownShipId === "chosen-ship"));
      opened[0].request.quantities.goods = 99;
      assert.equal(app.quantities.goods, 10, "checkout edits cannot silently change goods browser selection");
    }
  }
} finally { workflow._storageRooms = previousRooms; globalThis.game = previousGame; }
console.log("Transport UI: goods availability, storage permissions and unified GM/player buy/sell checkout passed.");
