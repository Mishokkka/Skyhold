import assert from "node:assert/strict";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { getSkyholdWorkflowService } from "../workflows/skyhold-workflow-service.js";
import { registerMarketOperationExecutor } from "../data/store.js";
import { marketAuthoritySourceToken } from "../apps/market/authority-context.js";

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
