import assert from "node:assert/strict";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { getSkyholdWorkflowService } from "../workflows/skyhold-workflow-service.js";
import { prepareMarketAuthorityContext } from "../apps/market/authority-context.js";
import { transportOfferAccessFixture } from "./fixtures/transport-offer-access.mjs";
import { SkyholdData } from "../data/store.js";

globalThis.foundry = { applications: { api: {
  ApplicationV2: class { get state() { return 0; } async _prepareContext() { return {}; } async _onRender() {} }, HandlebarsApplicationMixin: (Base) => Base
} } };
const { SkyholdMarketApp } = await import("../apps/market-app.js");
for (const isGM of [true, false]) {
  const { data, holding } = transportOfferAccessFixture();
  const gm = { id: "gm", isGM: true, active: true }, player = { id: "player", isGM: false, active: true };
  globalThis.game = { user: isGM ? gm : player, users: [gm, player], modules: new Map(), settings: { get() {} }, socket: { emit() {} } };
  let view = data;
  SkyholdData.view = () => view;
  const args = { data, holding, marketId: "a", isGM, outboundQuantities: { "test-freight": 2 } };
  const automatic = prepareMarketAuthorityContext(args);
  const carrierId = automatic.quote.carriers.find((row) => row.logistics?.routeAccessCost === 2).id;
  const pinned = prepareMarketAuthorityContext({ ...args, carrierId });
  assert.equal(pinned.outbound.plan?.ok, true, "a restrictive inbound chain cannot remove outbound goods");
  assert.deepEqual(pinned.outbound.offers, automatic.outbound.offers);
  assert.equal(pinned.outbound.plan.planToken, automatic.outbound.plan.planToken);

  const app = new SkyholdMarketApp({ holdingId: holding.id });
  app.marketId = "a";
  app.outboundQuantities = args.outboundQuantities;
  const initial = app._marketSnapshot();
  assert.deepEqual(initial.outbound.offers, pinned.outbound.offers, "the normal goods window shows the same demand and stock");
  assert.equal(initial.outbound.plan.revenueCopper, pinned.outbound.plan.revenueCopper);
  assert.ok(initial.markets.every(market => market.offers.length === 0), "the market selector does not build every catalog");
  const quote = initial.quote;
  const offer = quote.offers.find(row => row.resourceId === "test-freight");
  app.requestRender = () => {};
  app._setMarketQuantity(offer.id, 2, offer.stock);
  app._setOutboundQuantity("test-freight", 3, 20);
  app.merchantSelections[offer.sourceOfferId] = offer.providerId;
  assert.equal(app._marketSnapshot().quote, quote, "seller and quantity edits use the same live-data quote");
  app.marketId = "home";
  assert.notEqual(app._marketSnapshot().quote, quote);
  app.marketId = "a";
  assert.equal(app._marketSnapshot().quote, quote, "visiting another market preserves the cached quote for this snapshot");

  view = structuredClone(view);
  view.catalog.marketEconomy.baseOffers[0].priceOverrideCopper *= 2;
  const repriced = app._marketSnapshot().quote;
  assert.notEqual(repriced, quote, "changed world data invalidates quotes");
  assert.equal(repriced.offers.find(row => row.id === offer.id).unitPriceCopper, offer.unitPriceCopper * 2);
  game.user = isGM ? player : gm;
  assert.notEqual(app._marketSnapshot().quote, repriced, "a role change invalidates the visibility-sensitive quote");
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

{
  const { data, holding } = worldMarketFixture();
  let input = 0, prompts = 0, writes = 0, concurrentAmount = null;
  const warnings = [];
  globalThis.ui = { notifications: { warn: message => warnings.push(message) } };
  globalThis.game.user = { id: "gm", isGM: true, active: true };
  SkyholdData.view = () => data;
  SkyholdData.skipTransaction = value => ({ skipped: value });
  SkyholdData.updateHolding = async (id, updater, options) => {
    assert.equal(id, holding.id); assert.equal(options.fallback, false);
    const draft = structuredClone(holding);
    const result = updater(draft);
    if (result.skipped) return result.skipped;
    writes += 1;
    Object.assign(holding, draft);
    return result;
  };
  foundry.applications.api.DialogV2 = { prompt: async config => {
    prompts += 1;
    if (concurrentAmount !== null) holding.storage.moneyCopper = concurrentAmount;
    return input === null ? null : config.ok.callback(null, { form: { elements: { treasury: { valueAsNumber: input } } } });
  } };
  const app = new SkyholdMarketApp({ holdingId: holding.id });
  app.requestRender = () => {};
  const control = { dataset: { action: "market-edit-treasury" } };
  const click = () => app._onClick({ target: { closest: () => control }, preventDefault() {} }, { contains: () => true });
  await click();
  assert.equal(holding.storage.moneyCopper, 0, "the exact total can be set to zero from the normal market action");
  assert.equal(holding.storage.log.at(-1).qty, -500000);
  assert.equal(writes, 1);
  await click();
  assert.equal(writes, 1, "saving the same total appends no accounting entry");
  input = null;
  await click();
  assert.equal(writes, 1, "cancelling the form leaves the treasury intact");
  input = 6; concurrentAmount = 9;
  await click();
  assert.equal(holding.storage.moneyCopper, 9);
  assert.equal(writes, 1, "an older exact total may not overwrite a concurrent change");
  assert.match(warnings.at(-1), /изменилась/);
  game.user.isGM = false;
  await click();
  assert.equal(prompts, 4, "players never open the edit dialog");
}
{
  const previousDocument = globalThis.document;
  const searchInput = { matches: selector => selector.includes("input") };
  const otherSelect = { matches: selector => selector.includes("select") };
  const outsideButton = { matches: () => false };
  const listeners = new Map();
  const root = {
    contains: node => node === searchInput || node === otherSelect,
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: (type, fn) => listeners.set(type, fn)
  };
  const app = new SkyholdMarketApp({ holdingId: "deferred-focus" });
  let renders = 0;
  app.element = root;
  app.requestRender = () => { renders += 1; };
  await app._onRender({}, {});
  SkyholdMarketApp.instances.set(app.holdingId, app);
  globalThis.document = { activeElement: searchInput };
  try {
    SkyholdMarketApp.rerenderOpen({ skipFocused: true });
    assert.equal(renders, 0, "rerender waits while focus remains inside an input");
    listeners.get("focusout")({ relatedTarget: otherSelect });
    assert.equal(renders, 0, "moving focus directly to another input/select keeps the render deferred");
    listeners.get("focusout")({ relatedTarget: outsideButton });
    assert.equal(renders, 1, "leaving inputs/selects flushes the skipped market rerender");
    listeners.get("focusout")({ relatedTarget: outsideButton });
    assert.equal(renders, 1, "subsequent focusout does not trigger redundant rerenders");
  } finally {
    SkyholdMarketApp.instances.delete(app.holdingId);
    globalThis.document = previousDocument;
  }
}
console.log("Transport UI: goods availability, cached market quotes, unified checkout and GM-only treasury editing passed.");
