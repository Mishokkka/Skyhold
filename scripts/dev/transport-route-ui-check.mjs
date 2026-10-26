import assert from "node:assert/strict";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { getSkyholdWorkflowService } from "../workflows/skyhold-workflow-service.js";
import { registerMarketOperationExecutor } from "../data/store.js";
import { marketAuthoritySourceToken } from "../apps/market/authority-context.js";
import { marketTransportPicker } from "../apps/market/transport-picker.js";

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

const workflow = getSkyholdWorkflowService(), previousRooms = workflow._storageRooms, previousGame = globalThis.game, previousUi = globalThis.ui;
try {
  globalThis.ui = { notifications: { warn() {}, info() {} } };
  workflow._storageRooms = () => [{ id: "outdoors", label: "Снаружи" }];
  for (const isGM of [true, false]) {
    const { data, holding } = worldMarketFixture();
    data.catalog.marketEconomy.organizations = [{ id: "legacy-private", visibility: "gm" }];
    holding.special.market.orders = [{ id: "accepted-in", status: "in-transit", dispatchStatus: "departed", marketLabel: "Рынок",
      deliveryQd: 5, remainingQd: 4, carrierLabel: "SECRET COMPANY", transportPlan, routePath: ["secret-region"], cargo: [] },
    { id: "legacy-in", status: "in-transit", dispatchStatus: "departed", deliveryQd: 99, remainingQd: 99,
      carrierId: "legacy-private", carrierLabel: "SECRET LEGACY COMPANY", cargo: [] }];
    holding.special.market.outbound.orders = [{ id: "accepted-out", status: "in-transit", dispatchStatus: "departed", marketLabel: "Рынок",
      deliveryQd: 5, remainingQd: 4, carrierLabel: "SECRET COMPANY", transportPlan, cargo: [] }];
    const gm = { id: "gm", isGM: true, active: true }, player = { id: "player", isGM: false, active: true };
    globalThis.game = { user: isGM ? gm : player, users: { contents: [gm, player] }, modules: new Map(), settings: { get() {} } };
    const quote = { marketId: "a", marketLabel: "Рынок", selectedCarrierId: "auto-carriers", deliveryMode: "scheduled", deliveryQd: 5,
      location: {}, offers: [{ id: "goods", resourceId: "test-freight", name: "Ткань", stock: 10, unitPriceCopper: 20, load: 1 }],
      logistics: { ok: true, transportMode: "multimodal", transportLabel: "SECRET MODE", travelQd: 4, distanceFlatCopper: 100,
        capacityLoad: 400, baseCapacityLoad: 400, transportPlan, routePath: ["secret-region"], riskFactor: 1 },
      carriers: [{ id: "auto-carriers", automatic: true, label: "Авто" },
        { id: "transport:chain-one", chain: true, label: "SECRET CHOICE", capacityLoad: 200, travelQd: 3.25, transportPlan }] };
    const app = new SkyholdMarketApp({ holdingId: holding.id }); app.quantities = { goods: 2 };
    app._marketSnapshot = () => ({ data, holding, markets: [], market: { id: "a", label: "Рынок" }, quote,
      outbound: { transportChoices: quote.carriers, selectedTransportId: "auto-carriers", offers: [], plan: null } });
    app._enrichMarketQuoteItems = async (value) => value;
    const context = await app._prepareContext({});
    assert.equal(context.carrierOptions[0].selected, true, "automatic selection remains explicit in the control");
    assert.match(context.carrierOptions[0].label, /Автоматически/);
    assert.match(context.carrierOptions[1].label, /до 200 ед\./, "each alternative shows its own bottleneck capacity");
    assert.equal(context.routeLegs.length, 2);
    assert.equal(context.shipments.find((row) => row.id === "accepted-in").routeLegs.length, 2); assert.equal(context.outboundOrders[0].routeLegs.length, 2);
    assert.equal(context.outboundTransportOptions[0].selected, true);
    assert.equal(context.transportPicker.automatic.disabled, !isGM);
    assert.equal(context.transportPicker.rows[0].disabled, !isGM);
    assert.ok(context.carrierOptions[1].label.length < 100, "a route control never embeds all company names in its title");
    quote.logistics.ok = false;
    const staleContext = await app._prepareContext({});
    assert.equal(staleContext.transportPicker.rows[0].disabled, !isGM, "a GM can recover from a stale/blocked plan by choosing another chain");
    quote.logistics.ok = true;
    if (!isGM) {
      const shown = { options: context.carrierOptions, label: context.carrierLabel, transport: context.transportLabel,
        path: context.routePathText, legs: context.routeLegs, shipments: context.shipments, outbound: context.outboundOrders };
      assert.doesNotMatch(JSON.stringify(shown), /SECRET|secret-region|secret-company|secret-leg-id/, "ordinary player views cannot disclose frozen GM-only legs");
    }
    assert.equal(context.canOrder, isGM, "new route controls retain existing read-only permission rules");
    let requested = 0; app.requestRender = () => requested++;
    const field = { value: "transport:chain-one", closest: (selector) => selector === "[data-market-carrier]" ? field : null };
    app._onChange({ target: field }, { contains: () => true });
    assert.equal(app.carrierId, "transport:chain-one"); assert.equal(requested, 1);
    assert.equal(app.outboundCarrierId, "auto-carriers", "incoming choice does not change the reverse-direction chain");
    const outboundField = { value: "transport:reverse-chain", closest: (selector) => selector === "[data-market-outbound-carrier]" ? outboundField : null };
    app._onChange({ target: outboundField }, { contains: () => true });
    assert.equal(app.outboundCarrierId, "transport:reverse-chain"); assert.equal(app.carrierId, "transport:chain-one");
    const click = (action, direction, extra = {}) => {
      const button = { dataset: { action, direction, ...extra }, disabled: false };
      app._onClick({ preventDefault() {}, target: { closest: () => button } }, { contains: () => true });
    };
    const previousIncoming = app.carrierId, previousOutgoing = app.outboundCarrierId;
    click("market-select-transport", "inbound", { carrierId: "transport:new-in" });
    assert.equal(app.carrierId, isGM ? "transport:new-in" : previousIncoming);
    assert.equal(app.outboundCarrierId, previousOutgoing);
    click("market-select-transport", "outbound", { carrierId: "transport:new-out" });
    assert.equal(app.outboundCarrierId, isGM ? "transport:new-out" : previousOutgoing);
    click("market-transport-page", "outbound", { step: "1" });
    assert.equal(app.transportBrowsing.outbound.page, 1); assert.equal(app.transportBrowsing.inbound.page, 0);
    const searchField = { dataset: { marketTransportSearch: "outbound" }, value: "Гавань компания", closest: () => searchField };
    app._onInput({ target: searchField }, { contains: () => true });
    clearTimeout(app._transportSearchTimer);
    assert.deepEqual(app.transportBrowsing.outbound, { page: 0, query: "Гавань компания" });
    assert.equal(app.transportBrowsing.inbound.query, "");
    const previousInput = { isConnected: false }, body = {}, focusEvents = [];
    const newInput = { focus: () => focusEvents.push("focus"), setSelectionRange: (start, end) => focusEvents.push([start, end]) };
    app._transportSearchFocus = { previous: previousInput, direction: "outbound", start: 3, end: 7 };
    const focusRoot = { ownerDocument: { body, activeElement: body }, querySelector: () => newInput };
    app._restoreTransportFocus(focusRoot);
    assert.deepEqual(focusEvents, ["focus", [3, 7]], "search retains focus/caret after replacement of the whole window body");
    app._transportSearchFocus = { previous: previousInput, direction: "outbound", start: 0, end: 0 };
    focusRoot.ownerDocument.activeElement = { isConnected: true };
    app._restoreTransportFocus(focusRoot);
    assert.equal(focusEvents.length, 2, "a later focus in another control is never stolen");
    app.outboundCarrierId = "transport:reverse-chain";
    if (isGM) {
      const outboundPlan = { ok: true, marketId: "a", marketLabel: "Рынок", planToken: "outbound-token", lines: [{ qty: 2 }], buyerAllocations: [], upfrontCopper: 10, revenueCopper: 30 };
      app._marketSnapshot = () => ({ data, holding, sourceHash: "incoming-source", outbound: { plan: outboundPlan, selectedUnits: 2 } });
      foundry.applications.api.DialogV2 = { confirm: async () => true };
      let submitted;
      registerMarketOperationExecutor(async (operation) => { submitted = operation; return { ok: false }; });
      await app._onBookOutbound();
      assert.equal(submitted.carrierId, "transport:reverse-chain");
      assert.equal(submitted.sourceToken, marketAuthoritySourceToken({ data, holding, marketId: "a", carrierId: "transport:reverse-chain" }));
      assert.notEqual(submitted.sourceToken, marketAuthoritySourceToken({ data, holding, marketId: "a", carrierId: app.carrierId }));
    }
  }
} finally { workflow._storageRooms = previousRooms; globalThis.game = previousGame; globalThis.ui = previousUi; }
console.log("Transport route UI: auto/concrete choices, per-leg terms, saved inbound/outbound details, legacy absence and GM/player redaction passed.");
