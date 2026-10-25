import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { prepareMarketOutboundContext } from "../apps/market/outbound-context.js";
import { DisclosureState } from "../apps/common/disclosure-state.js";
import { focusMarketOutboundOrder } from "../apps/market/outbound-focus.js";

globalThis.foundry = { applications: { api: { ApplicationV2: class {
  async _prepareContext() { return {}; }
  async _onRender() {}
  render() { return this; }
}, HandlebarsApplicationMixin: (Base) => Base } } };
globalThis.game = { user: { id: "gm", isGM: true }, settings: { get: () => undefined }, modules: new Map() };
const { SkyholdMarketApp } = await import("../apps/market-app.js");
const quote = { marketId: "port", marketLabel: "Порт", outboundOffers: [
  { id: "wood", resourceId: "wood", name: "Древесина", demand: 12, unitPriceCopper: 10 }
] };

async function contextFor({ rows = [], orders = [], gm = true, quantities = {}, demand = quote } = {}) {
  globalThis.game.user = { id: gm ? "gm" : "player", isGM: gm };
  const holding = mergeHoldingDefaults({ id: "village", name: "Поселение", visibility: "public",
    gm: { playersCanUseStorage: true }, storage: { moneyCopper: 1000, resources: rows },
    special: { market: { outbound: { orders } } } });
  const outbound = prepareMarketOutboundContext({ holding, quote: demand, quantities,
    routes: [{ id: "courier", ok: true, freightCopper: 1, deliveryQd: 2 }] });
  const app = new SkyholdMarketApp({ holdingId: holding.id });
  app.outboundQuantities = { ...quantities };
  app.requestRender = () => {};
  app._marketSnapshot = () => ({ data: { catalog: {} }, holding, markets: [], market: demand ? { label: "Порт" } : null, quote: null, outbound });
  const before = JSON.stringify(holding);
  const context = await app._prepareContext({});
  assert.equal(JSON.stringify(holding), before, "Opening or folding a market cannot change world data");
  return { context, app };
}

for (const gm of [true, false]) {
  for (const rows of [[], [{ resourceId: "wood", qty: 8, forSale: false }], [{ resourceId: "wood", qty: 0, forSale: true }]]) {
    const { context } = await contextFor({ rows, gm });
    assert.equal(context.outboundHasForSaleStock, false);
    assert.equal(context.outboundShowSection, false, "No marked positive stock and no orders means no sale footer");
  }
  const rows = [{ id: "wood-a", resourceId: "wood", qty: 8, forSale: true }, { id: "wood-b", resourceId: "wood", roomId: "other", qty: 6, forSale: true }];
  const { context, app } = await contextFor({ rows, gm, quantities: { wood: 100 } });
  assert.equal(context.outboundHasForSaleStock, true);
  assert.equal(context.outboundShowSection, true);
  assert.equal(context.outboundStockCount, 1, "Multiple storage rows count as one kind of goods");
  assert.equal(context.outboundSelectedUnits, 12, "The draft remains capped by shared demand");
  assert.equal(context.outboundOffers[0].canSelect, gm, "Player storage permissions cannot enable GM-only market controls");
  assert.equal(context.outboundCanBook, gm, "Only the GM can confirm a valid sale");
  const max = { dataset: { action: "market-outbound-quantity-step", resourceId: "wood", step: "12", available: "12" } };
  if (context.outboundOffers[0].canSelect) {
    app.outboundQuantities.wood = 1;
    await app._onClick({ target: { closest: () => max }, preventDefault() {} }, { contains: () => true });
    assert.equal(app.outboundQuantities.wood, 12, "Visible Max uses the existing capped quantity action");
  }

  const noDemand = await contextFor({ rows, gm, demand: { ...quote, outboundOffers: [] } });
  assert.equal(noDemand.context.outboundHasForSaleStock, true);
  assert.equal(noDemand.context.outboundHasOffers, false);
  assert.equal(noDemand.context.outboundUnavailableForSaleCount, 1);
  assert.equal(noDemand.context.outboundCanBook, false);

  const reserved = await contextFor({ gm, quantities: { wood: 2 },
    rows: [{ id: "reserved-row", resourceId: "wood", qty: 2, forSale: true, batches: [{ id: "batch", qty: 2 }] }],
    orders: [{ id: "reserved-sale", status: "booked", dispatchStatus: "booked",
      cargoReservations: [{ rowId: "reserved-row", resourceId: "wood", batchId: "batch", qty: 2 }] }] });
  assert.equal(reserved.context.outboundHasForSaleStock, true, "Reserved stock remains marked for sale until dispatch");
  assert.equal(reserved.context.outboundOffers[0].available, 0);
  assert.equal(reserved.context.outboundOffers[0].canSelect, false, "Reserved stock cannot be selected twice");
  assert.equal(reserved.context.outboundHasSelection, false);
  assert.equal(reserved.context.hasOutboundOrders, true);

  for (const status of ["booked", "needsResolution", "delivered"]) {
    const { context: tracking } = await contextFor({ gm, orders: [{ id: "sale", status, riskStatus: status, marketLabel: "Порт", revenueCopper: 100 }] });
    assert.equal(tracking.outboundHasForSaleStock, false, "Existing orders do not expose an empty sale composer");
    assert.equal(tracking.outboundShowSection, true, "Orders and archive remain reachable after the last stock leaves storage");
    assert.equal(tracking.hasOutboundArchive, status === "delivered");
    assert.equal(tracking.hasOutboundOrders, status !== "delivered");
    assert.equal(tracking.outboundNeedsAttention, gm && status === "needsResolution");
  }
}

class Detail extends globalThis.EventTarget {
  constructor(key) { super(); this.dataset = { fblsDisclosure: key }; this.tagName = "DETAILS"; this.open = false; }
  focus() { this.focused = true; }
}
const states = new DisclosureState();
let composer = new Detail("market-outbound-compose");
states.bind({ querySelectorAll: () => [composer] });
assert.equal(composer.open, false, "A fresh sale starts collapsed");
composer.open = true;
composer.dispatchEvent(new Event("toggle"));
composer = new Detail("market-outbound-compose");
states.bind({ querySelectorAll: () => [composer] });
assert.equal(composer.open, true, "Quantity/insurance/market rerenders preserve the expanded composer");
composer.open = false;
states.bind({ querySelectorAll: () => [] });
composer = new Detail("market-outbound-compose");
states.bind({ querySelectorAll: () => [composer] });
assert.equal(composer.open, false, "An empty stock transition does not forget the user's collapsed state");
const root = { contains: () => true, querySelector: () => composer };
assert.equal(focusMarketOutboundOrder(root, ""), true);
assert.equal(composer.open, true, "Navigation from a ship opens the composer itself before focusing it");
assert.equal(composer.focused, true);
const orders = new Detail("market-outbound-orders");
const order = { dataset: { marketOutboundOrder: 'sale:"[]' }, parentElement: orders, focus() { this.focused = true; } };
assert.equal(focusMarketOutboundOrder({ contains: () => true, querySelectorAll: () => [order] }, 'sale:"[]'), true);
assert.equal(orders.open, true);
assert.equal(order.focused, true);
states.close();

class MarketRoot extends globalThis.EventTarget {
  constructor({ composer = null, orders = [], archive = false } = {}) {
    super();
    this.composer = composer;
    this.orders = orders;
    this.section = composer || orders.length || archive ? { focus() { this.focused = true; } } : null;
  }
  contains() { return true; }
  querySelector(selector) {
    if (selector === "[data-market-outbound-compose]") return this.composer;
    if (selector === "[data-market-outbound-section]") return this.section;
    return null;
  }
  querySelectorAll(selector) {
    if (selector === "[data-market-outbound-order]") return this.orders;
    if (selector === "details[data-gm-section], details[data-fbls-disclosure]") return this.composer ? [this.composer] : [];
    return [];
  }
}

const warnings = [];
globalThis.ui = { notifications: { warn: (message) => warnings.push(message) } };
for (const gm of [true, false]) {
  for (const status of ["booked", "delivered"]) {
    const { context, app } = await contextFor({ gm, orders: [{ id: "existing-sale", status }] });
    app.element = new MarketRoot({ orders: status === "booked" ? [{ dataset: { marketOutboundOrder: "existing-sale" } }] : [], archive: status === "delivered" });
    app._focusOutbound = true;
    warnings.length = 0;
    await app._onRender(context, {});
    assert.equal(warnings.length, 1, "Existing sales/archive cannot stand in for a missing new-sale composer");
    assert.match(warnings[0], /Отметьте товары/);
    assert.equal(app.element.section.focused, undefined, "Do not focus unrelated tracking when new-sale navigation fails");
    await app._onRender(context, {});
    assert.equal(warnings.length, 1, "The navigation warning is consumed once");
  }
  const { context, app } = await contextFor({ gm, demand: null, rows: [{ resourceId: "wood", qty: 2, forSale: true }] });
  assert.equal(context.hasMarket, false);
  app.element = new MarketRoot();
  app._focusOutbound = true;
  warnings.length = 0;
  await app._onRender(context, {});
  assert.match(warnings[0], /Нет доступного рынка/, "An unreachable market must not be mistaken for unmarked stock");

  app._focusOutboundOrderId = "missing-sale";
  await app._onRender(context, {});
  assert.match(warnings[1], /Продажа уже недоступна/, "A missing referenced order keeps its distinct explanation");
}

const { app: renderedApp, context: renderedContext } = await contextFor({ rows: [{ resourceId: "wood", qty: 2, forSale: true }] });
renderedApp.element = new MarketRoot({ composer: new Detail("market-outbound-compose") });
renderedApp._focusOutbound = true;
warnings.length = 0;
await renderedApp._onRender(renderedContext, {});
assert.equal(renderedApp.element.composer.open, true);
assert.equal(warnings.length, 0);
renderedApp.element = new MarketRoot({ composer: new Detail("market-outbound-compose") });
await renderedApp._onRender(renderedContext, {});
assert.equal(renderedApp.element.composer.open, true, "The actual render hook restores the expanded composer");
renderedApp.element.composer.open = false;
renderedApp.element = new MarketRoot({ composer: new Detail("market-outbound-compose") });
await renderedApp._onRender(renderedContext, {});
assert.equal(renderedApp.element.composer.open, false, "The actual render hook also preserves an explicit collapse");

const template = readFileSync(new URL("../../templates/market-app.hbs", import.meta.url), "utf8");
assert.match(template, /\{\{#if outboundShowSection\}\}\s*<section[^>]+data-market-outbound-section/);
assert.match(template, /\{\{#if outboundHasForSaleStock\}\}\s*<details[^>]+data-market-outbound-compose/);
assert.match(template, /\{\{#if outboundHasSelection\}\}[\s\S]*data-market-outbound-ship/);
assert.match(template, /<\/details>\s*\{\{\/if\}\}\s*\{\{#if hasOutboundOrders\}\}/, "Tracking is outside the stock-gated composer");
assert.doesNotMatch(template.match(/<details[^>]+data-market-outbound-compose[^>]*>/)?.[0] ?? "", /\sopen(?:\s|>)/);
console.log("Market outbound UI: conditional stock, GM/player controls, capped Max, independent tracking, retained folds and ship navigation passed.");
