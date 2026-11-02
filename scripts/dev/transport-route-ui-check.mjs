import assert from "node:assert/strict";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { getSkyholdWorkflowService } from "../workflows/skyhold-workflow-service.js";
import { prepareMarketAuthorityContext } from "../apps/market/authority-context.js";
import { marketTransportPicker } from "../apps/market/transport-picker.js";
import { transportOfferAccessFixture } from "./fixtures/transport-offer-access.mjs";

const manyOptions = [{ value: "auto-carriers", label: "Автоматически", automatic: true }, ...Array.from({ length: 80 }, (_, index) => ({
  value: `chain-${index}`, label: `Вариант ${index + 1}`, searchText: `общий префикс из 29 участков конечная компания-${index} гавань-${index}`
}))];
const lastPage = marketTransportPicker({ options: manyOptions, selectedId: "chain-79", page: 99, canSelect: true });
assert.equal(lastPage.rows.length, 2, "all eighty alternatives remain reachable with six per page");
assert.equal(lastPage.rows.at(-1).value, "chain-79"); assert.equal(lastPage.hasNext, false);
assert.equal(lastPage.rows.at(-1).selected, true);
assert.equal(lastPage.selectedText, "Вариант 80", "paging cannot change the selected agreement");
const searched = marketTransportPicker({ options: manyOptions, selectedId: "chain-79", query: "КОМПАНИЯ-37 гавань-37", page: 99, canSelect: true });
assert.deepEqual(searched.rows.map(row => row.value), ["chain-37"], "late legs remain searchable through a common long prefix");
assert.equal(searched.page, 0); assert.equal(searched.selectedText, "Вариант 80");
const empty = marketTransportPicker({ options: manyOptions, selectedId: "chain-79", query: "нет совпадений" });
assert.equal(empty.rows.length, 0); assert.equal(empty.automatic.value, "auto-carriers"); assert.equal(empty.automatic.disabled, true);
assert.equal(marketTransportPicker({ options: manyOptions, selectedId: "removed" }).selectedText.includes("недоступен"), true);

globalThis.foundry = { applications: { api: {
  ApplicationV2: class { get state() { return 0; } async _prepareContext() { return {}; } }, HandlebarsApplicationMixin: (Base) => Base
} } };
const { SkyholdMarketApp, marketTransportPlanView } = await import("../apps/market-app.js");
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
const transportPlan = { version: 1, key: "chain-one", direction: "inbound", legs: [
  { id: "leg-public", fromRegionId: "market", toRegionId: "relay", fromCountryId: "country-a", toCountryId: "country-b", fromLabel: "Рынок", toLabel: "Перевалка", mode: "caravan",
    carrierId: "company-a", carrierLabel: "Караванщики", visibility: "public", distanceKm: 80, travelQd: 2.25, capacityLoad: 400 },
  { id: "secret-leg-id", fromRegionId: "secret-region", toRegionId: "home", fromLabel: "SECRET PORT", toLabel: "SECRET HOME", mode: "airship",
    modeLabel: "SECRET MODE", carrierId: "secret-company", carrierLabel: "SECRET COMPANY", visibility: "gm", distanceKm: 40, travelQd: 1, capacityLoad: 200 }
] };
const before = JSON.stringify(transportPlan);
const gmView = marketTransportPlanView(transportPlan, { isGM: true });
const playerView = marketTransportPlanView(transportPlan, { isGM: false });
assert.equal(gmView.legs[0].timeText, "2,25 QD", "fractional leg times remain explicit instead of summing rounded legs");
assert.match(JSON.stringify(gmView), /SECRET COMPANY/);
assert.doesNotMatch(JSON.stringify(playerView), /SECRET|secret-company|secret-region|secret-leg-id/);
assert.equal(playerView.legs[1].hidden, true);
assert.equal(JSON.stringify(transportPlan), before, "presentation cannot mutate accepted conditions");
assert.deepEqual(marketTransportPlanView(undefined).legs, [], "legacy orders never acquire invented transport details");
assert.deepEqual(marketTransportPlanView({ version: 1, legs: [null] }).legs, [], "recoverable malformed metadata cannot break the market window");
assert.equal(marketTransportPlanView(transportPlan, { hiddenCarrierIds: new Set(["company-a"]) }).legs[0].hidden, true,
  "current company privacy can hide a previously public frozen leg without repricing it");
assert.equal(marketTransportPlanView(transportPlan, { hiddenCountryIds: new Set(["country-a"]) }).legs[0].hidden, true);
assert.equal(marketTransportPlanView(transportPlan, { hiddenRegionIds: new Set(["market"]) }).legs[0].hidden, true);

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
console.log("Transport UI: goods availability, historical terms/privacy and unified GM/player buy/sell checkout passed.");
