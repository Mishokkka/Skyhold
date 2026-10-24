import assert from "node:assert/strict";
import { normalizeMarketEconomy } from "../data/market/economy.js";
import { normalizeMarketDemandState, marketDemandKey } from "../data/market/demand-state.js";
import { normalizeMarketStockState, marketStockKey } from "../data/market/stock-state.js";
import { authorityMarketQuote, authorityMarketOutboundContext, authorityOwnShipOutboundRoute } from "../apps/market/authority-context.js";
import { composeMarketLocation } from "../engines/market/composition.js";
import { resolveMarketLogistics, shortestMarketRoute } from "../engines/market/logistics.js";
import { marketTransportRoutes } from "../engines/market/route-candidates.js";
import { planMarketPurchase, prepareMarketQuote, resolveMarketOfferEconomics } from "../engines/market/pricing.js";
import { summarizeTradeReport } from "../engines/economy/report.js";
import { planInternalDemand, applyInternalDemandPlan } from "../engines/economy/internal-demand.js";
import { settleMarketDemandReservations } from "../engines/market/demand.js";
import { overlayMarketQuoteStock, reserveMarketStock } from "../engines/market/stock.js";
import { itemQuantity } from "../engines/storage/item-quantity.js";
import { FinanceTradeDomain } from "../apps/domains/finance/trade-domain.js";
import { FinanceInternalDemandDomain } from "../apps/domains/finance/internal-demand-domain.js";
import { normalizeStorageItemRow } from "../data/normalizers/storage.js";
import { planMarketOutboundSale, createMarketOutboundOrder } from "../engines/market/outbound.js";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { generateWorldShipOffers, quoteWorldShipBundle } from "../engines/ships/world-market.js";

const resource = { id: "wood", label: "Wood", basePriceCopper: 100, loadPoints: 4, categoryTag: "construction.simple" };
for (const invalid of [
  { id: "capacity", unitPriceCopper: 1, load: 2, capacityLoad: 1, capacityExceeded: true, amountExceeded: false },
  { id: "amount", unitPriceCopper: 100_000, load: 1, capacityLoad: 5, capacityExceeded: false, amountExceeded: true }
]) {
  const plan = planMarketPurchase({ holding: { storage: { moneyCopper: 1_000_000_000 } },
    quote: { deliveryMode: "scheduled", deliveryQd: 4, logistics: { ok: true, capacityLoad: invalid.capacityLoad },
      offers: [{ id: invalid.id, stock: 1_000_000, unitPriceCopper: invalid.unitPriceCopper, load: invalid.load }] },
    quantities: { [invalid.id]: 1_000_000 } });
  assert.equal(plan.ok, false);
  assert.equal(plan.capacityExceeded, invalid.capacityExceeded);
  assert.equal(plan.amountExceeded, invalid.amountExceeded);
  assert.equal(plan.lines[0].qty, 1_000_000, "invalid quote must preserve the requested cargo for its explanation");
  assert.equal(plan.totalLoad, invalid.load * 1_000_000);
  assert.deepEqual(plan.shipmentBatches, [], "a quote already known to be impossible must not allocate a million shipment batches");
}
const itemHolding = { gm: { calendaria: { lastQd: 40 } }, storage: { moneyCopper: 0, resources: [],
  items: [{ id: "item-1", name: "Tools", qty: 1, forSale: true, itemData: { system: { quantity: 1 } } }] } };
const itemContext = { ...FinanceTradeDomain, ...FinanceInternalDemandDomain, _itemQuantity: itemQuantity,
  _itemPriceCopper: () => 100, _safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback };
for (let period = 0; period < 2; period++) {
  const candidates = itemContext._internalDemandCandidates(itemHolding);
  const plan = planInternalDemand({ pools: [{ id: "population", budgetCopper: 1000 }],
    channels: [{ id: "shop", sourceIds: ["population"], throughputUnits: 10, sellerEfficiency: 2 }], candidates });
  const applied = applyInternalDemandPlan({ plan, candidates, dependencies: {
    candidateQuantity: (candidate) => itemQuantity(candidate.snapshot),
    takeCandidate: (candidate, qty) => itemContext._reduceTradeCandidate({ kind: "item", row: candidate.snapshot }, qty),
    addMoney: (amount) => { itemHolding.storage.moneyCopper += amount; }, appendLedger: () => {} } });
  assert.equal(applied.ok, true);
  assert.equal(applied.soldUnits, period === 0 ? 1 : 0, "an exhausted Item cannot reappear in the next demand period");
  itemHolding.storage.items = JSON.parse(JSON.stringify(itemHolding.storage.items)).map(normalizeStorageItemRow);
}
assert.equal(itemHolding.storage.moneyCopper, 100);
assert.equal(itemHolding.storage.items[0].itemData.system.quantity, 0);
assert.equal(itemQuantity({ quantity: 0, itemData: { system: { quantity: 1 } } }), 0, "the legacy storage alias must also preserve an explicit zero");
assert.equal(itemQuantity({ system: { quantity: 0 } }), 1, "the system document default remains separate from an explicit storage zero");

const rawStock = {};
const rawDemand = {};
for (let index = 0; index < 2001; index++) {
  const marketId = `market-${index}`;
  rawStock[index] = { marketId, offerId: "wood", baseStock: 100, availableStock: 0 };
  rawDemand[index] = { marketId, demandId: "wood", baseDemand: 100, consumedOutstanding: index === 2000 ? 0 : 50,
    reservations: index === 2000 ? { active: { operationId: "active", qty: 1 } } : {} };
}
const balances = JSON.parse(JSON.stringify({ stock: normalizeMarketStockState(rawStock), demand: normalizeMarketDemandState(rawDemand) }));
assert.equal(Object.keys(balances.stock).length, 2001);
assert.equal(Object.keys(balances.demand).length, 2001);
assert.equal(balances.stock[marketStockKey("market-2000", "wood")].availableStock, 0);
for (const outcome of ["consumed", "released"]) {
  const holding = { special: { market: structuredClone(balances) } };
  const args = { holding, reservations: [{ marketId: "market-2000", demandId: "wood", qty: 1,
    reservationOperationId: "active", baseDemand: 100 }], operationId: `settle-${outcome}`, outcome };
  assert.equal(settleMarketDemandReservations(args).ok, true, "the last active reservation must survive persistence");
  assert.equal(settleMarketDemandReservations(args).replay, true);
  assert.equal(holding.special.market.demand[marketDemandKey("market-2000", "wood")].reservedDemand, 0);
  assert.equal(overlayMarketQuoteStock({ holding, quote: { marketId: "market-2000", offers: [{ id: "wood", stock: 100 }] } }).offers[0].stock, 0);
}

function fixture(regions, merchantFactor = 1) {
  const holding = { id: "settlement", type: "village", overview: { region: regions[0].value },
    gm: { modifiers: { marketConnectionsLevel: 10 }, calendaria: { lastQd: 40 } },
    storage: { moneyCopper: 100000, resources: [{ id: "wood-row", resourceId: "wood", forSale: true, qty: 100,
      batches: [{ id: "wood-batch", qty: 100, ageQd: 0 }] }] },
    special: { market: { orders: [], stock: {}, demand: {}, outbound: { orders: [] } } } };
  const economy = normalizeMarketEconomy({ settings: { deliveryMode: "scheduled", handlingFlatCopper: 0,
    handlingLoadCopper: 0, handlingSubtotalRate: 0, caravanCapacityLoad: 1000 },
    baseOffers: [{ id: "wood-offer", resourceId: "wood", baseStock: 100, baseDemand: 100, priceOverrideCopper: 100, volatility: 0 }],
    countries: [{ id: "country", label: "Country", priceFactor: 1, stockFactor: 1, taxRate: 0 }],
    organizations: [{ id: "merchant", merchant: { enabled: true, priceFactor: merchantFactor, priceVolatility: 0,
      countryShares: [{ countryId: "country", sharePct: 100 }] } }] }, { locations: regions });
  const market = composeMarketLocation({ location: regions.at(-1), economy, resources: [resource], locations: regions, normalizedEconomy: true });
  const data = { catalog: { eventRegions: regions, marketEconomy: economy, resources: [resource] } };
  return { holding, economy, market, data };
}
const local = fixture([{ value: "home", countryId: "country", marketSizeId: "town", marketEnabled: true,
  marketTransportModes: ["caravan"], marketImportFactor: 1.4 }], 0.5);
for (const isGM of [true, false]) {
  const quote = authorityMarketQuote({ ...local, resources: [resource], isGM });
  const offer = quote.offers.find((row) => row.resourceId === "wood");
  const purchase = planMarketPurchase({ holding: local.holding, quote, quantities: { [offer.id]: 10 } });
  const sale = authorityMarketOutboundContext({ ...local, quote, resources: [resource], quantities: { wood: 10 }, isGM });
  assert(purchase.ok && sale.plan.ok);
  assert(sale.plan.revenueCopper <= purchase.subtotalCopper, "the authority quote must cap against the actual discounted merchant for both GM and player");
}
const originalQuote = authorityMarketQuote({ ...local, resources: [resource], isGM: true });
const bought = originalQuote.offers.find((row) => row.resourceId === "wood");
assert.equal(reserveMarketStock({ holding: local.holding, marketId: local.market.id, lines: [{ ...bought, qty: bought.stock }], operationId: "empty-market" }).ok, true);
const depleted = authorityMarketQuote({ ...local, resources: [resource], isGM: true });
assert(depleted.offers.every((offer) => offer.stock === 0));
assert.equal(depleted.outboundOffers[0].unitPriceCopper, originalQuote.outboundOffers[0].unitPriceCopper,
  "buying the last cheap unit must not lift the same-period resale cap");

const regions = [
  { value: "a", countryId: "country", marketSizeId: "town", marketEnabled: true, marketLandmassId: "island-a",
    marketTransportModes: ["caravan", "airship"], marketLinks: [{ routeId: "mixed", regionId: "b", distanceKm: 40, ursCost: 1, modes: ["caravan", "airship"] }] },
  { value: "b", countryId: "country", marketSizeId: "town", marketEnabled: true, marketLandmassId: "island-b", marketTransportModes: ["caravan", "airship"] }
];
const routed = fixture(regions);
const air = resolveMarketLogistics({ ...routed, regions });
assert(shortestMarketRoute("a", "b", regions, { mode: "airship" }));
assert.equal(air.ok, true);
assert.deepEqual(air.routeModes, ["airship"], "mandatory air transport is filtered before route selection");
const alternatives = structuredClone(regions);
for (const region of alternatives) region.marketLandmassId = "land";
alternatives[0].marketLinks = [
  { routeId: "long", regionId: "b", distanceKm: 1000, ursCost: 1, modes: ["caravan"] },
  { routeId: "short", regionId: "b", distanceKm: 40, ursCost: 2, modes: ["caravan"] }
];
const cheapest = fixture(alternatives);
for (const isGM of [true, false]) {
  const quote = authorityMarketQuote({ ...cheapest, resources: [resource], isGM });
  const offer = quote.offers.find((row) => row.resourceId === "wood");
  const purchase = planMarketPurchase({ holding: cheapest.holding, quote, quantities: { [offer.id]: 10 } });
  const sale = authorityMarketOutboundContext({ ...cheapest, quote, resources: [resource], quantities: { wood: 10 }, isGM });
  assert.equal(purchase.logistics.distanceKm, 40, "money, rather than minimum access cost, chooses the actual inbound path");
  assert.equal(sale.plan.route.routePath.length, 2);
  assert.equal(sale.plan.route.distanceKm, 40, "outbound comparison must also consider the shorter higher-URS path");
  assert.equal(sale.plan.deliveryQd, purchase.deliveryQd);
  assert.equal(sale.plan.route.routeModes[0], "caravan");
}
const limited = fixture(alternatives);
limited.holding.gm.modifiers.marketConnectionsLevel = 1;
const lowQuote = authorityMarketQuote({ ...limited, resources: [resource], isGM: true });
const lowOffer = lowQuote.offers.find((row) => row.resourceId === "wood");
assert.equal(planMarketPurchase({ holding: limited.holding, quote: lowQuote, quantities: { [lowOffer.id]: 1 } }).logistics.distanceKm, 1000);

const seasonal = structuredClone(alternatives);
seasonal[0].marketLinks = [
  { routeId: "safer", regionId: "b", distanceKm: 50, ursCost: 1, modes: ["caravan"] },
  { routeId: "riskier", regionId: "b", distanceKm: 40, ursCost: 1, modes: ["caravan"],
    seasonalModifiers: { winter: { enabled: true, costFactor: 1, timeFactor: 1, riskFactor: 4 } } }
];
const seasonalLogistics = resolveMarketLogistics({ holding: routed.holding, market: { regionId: "b", transportModes: ["caravan"] }, regions: seasonal, seasonId: "winter" });
const seasonalQuote = { offers: [{ id: "valuable", unitPriceCopper: 1000000, stock: 1, load: 1 }],
  location: {}, logistics: seasonalLogistics, deliveryMode: "scheduled", deliveryBaseQd: 1 };
assert.equal(planMarketPurchase({ holding: { storage: { moneyCopper: 2000000 } }, quote: seasonalQuote, quantities: { valuable: 1 } }).logistics.distanceKm,
  50, "the full quote must retain a longer route when its seasonal insurance is cheaper");

const layers = Array.from({ length: 5 }, (_, layer) => Array.from({ length: 10 }, (_, node) => `${layer}:${node}`));
const edgeTo = (to) => ({ to, distance: 1, distanceKm: 40, ursCost: 1, modes: ["caravan"] });
const complexGraph = new Map([["start", [edgeTo("end"), ...layers[0].map(edgeTo)]], ["end", []]]);
layers.forEach((layer, index) => layer.forEach((node) => complexGraph.set(node, (layers[index + 1] ?? ["end"]).map(edgeTo))));
const exhaustedSearch = marketTransportRoutes({ graph: complexGraph, from: "start", to: "end", maxAccess: 10,
  modesForEdge: () => ["caravan"], termsForEdge: () => ({ flat: 1, load: 1, time: 1, operating: 1, risk: 1 }) });
assert.equal(exhaustedSearch.limited, true);
assert.deepEqual(exhaustedSearch.routes, [], "a search budget cannot expose a partial answer as the cheapest route");

const taxed = resolveMarketLogistics({ ...routed, regions, dependencies: { regionFactors: (row) =>
  ({ taxRate: row.value === "a" ? 0.05 : 0.2, exportTaxRate: row.value === "a" ? 0.02 : 0.03 }) } });
const taxedOutbound = resolveMarketLogistics({ ...routed, regions, direction: "outbound", dependencies: { regionFactors: (row) =>
  ({ taxRate: row.value === "a" ? 0.05 : 0.2, exportTaxRate: row.value === "a" ? 0.02 : 0.03 }) } });
assert.equal(taxed.importTaxRate, 0.05);
assert.equal(taxed.exportTaxRate, 0.03);
assert.equal(taxedOutbound.importTaxRate, 0.2);
assert.equal(taxedOutbound.exportTaxRate, 0.02);
const taxQuote = prepareMarketQuote({ holding: routed.holding, market: { id: "tax", deliveryMode: "scheduled", baseDeliveryQd: 1,
  offers: [{ id: "wood", resourceId: "wood", baseStock: 100, volatility: 0 }] }, resources: [resource],
  location: { priceFactor: 1, availabilityFactor: 1 }, logistics: taxedOutbound });
const taxPlan = planMarketPurchase({ holding: routed.holding, quote: taxQuote, quantities: { wood: 10 } });
assert.equal(taxPlan.importTaxCopper, 200);
assert.equal(taxPlan.exportTaxCopper, 20);
assert.equal(taxPlan.taxCopper, 220);
assert.equal(resolveMarketOfferEconomics({ resourceId: "wood", loadOverridePoints: 0 }, resource).loadPoints, 4);
assert.equal(resolveMarketOfferEconomics({ sourceType: "item", loadOverridePoints: 0 }).loadPoints, 0);

const summary = summarizeTradeReport({ demandSources: 2, revenue: 230, purchases: [
  { name: "Wood", qty: 2, revenueCopper: 200 }, { name: "Ночлег", qty: 1, revenueCopper: 30 } ] });
assert.equal(summary.soldLines.length, 2);
assert(summary.soldLines.find((line) => line.startsWith("Wood")).includes("2 ЗМ"));
assert(summary.lines[0].startsWith("Источников спроса:"));
assert(summarizeTradeReport({ buyers: 2, revenue: 100, purchases: [{ item: "Legacy", qty: 1, revenue: 100 }] }).soldLines[0].includes("1 ЗМ"));

for (const revenue of [999999999, 1000000000, 1000000001, 2000000000]) {
  const first = Math.min(revenue, 1000000000);
  const lines = [{ resourceId: "a", qty: 1, unitPriceCopper: first }];
  if (revenue > first) lines.push({ resourceId: "b", qty: 1, unitPriceCopper: revenue - first });
  const plan = planMarketOutboundSale({ resources: [{ id: "a", resourceId: "a", qty: 1 }, { id: "b", resourceId: "b", qty: 1 }], lines,
    routes: [{ id: "route", freightCopper: 0, tariffCopper: 0, deliveryQd: 1 }], insuranceEnabled: false });
  assert.equal(plan.revenueCopper, revenue);
  assert.equal(plan.ok, revenue <= 1000000000);
  if (plan.ok) {
    const order = createMarketOutboundOrder({ plan, operationId: `money-${revenue}` });
    assert.equal(order.revenueCopper, revenue);
  } else assert.equal(createMarketOutboundOrder({ plan, operationId: `money-${revenue}` }), null);
}
const tooLarge = planMarketOutboundSale({ resources: [{ id: "a", resourceId: "a", qty: 1 }, { id: "b", resourceId: "b", qty: 1 }],
  lines: [{ resourceId: "a", qty: 1, unitPriceCopper: 1000000000 }, { resourceId: "b", qty: 1, unitPriceCopper: 1 }],
  routes: [{ id: "route", freightCopper: 0, tariffCopper: 0, deliveryQd: 1 }], insuranceEnabled: false });
assert.equal(tooLarge.ok, false);
assert.equal(createMarketOutboundOrder({ plan: tooLarge, operationId: "oversized" }), null);
assert.throws(() => createMarketOutboundOrder({ plan: { ...tooLarge, ok: true }, operationId: "forged" }), RangeError);
const largePurchase = planMarketPurchase({ holding: { storage: { moneyCopper: Number.MAX_SAFE_INTEGER } },
  quote: { offers: [{ id: "rare", unitPriceCopper: 2000000, stock: 1000, load: 0 }], deliveryMode: "instant" }, quantities: { rare: 1000 } });
assert.equal(largePurchase.amountExceeded, true);
assert.equal(largePurchase.ok, false);
const largeSale = planMarketOutboundSale({ resources: [{ id: "rare", resourceId: "rare", qty: 1000 }],
  lines: [{ resourceId: "rare", qty: 1000, unitPriceCopper: 2000000 }],
  routes: [{ id: "route", freightCopper: 0, tariffCopper: 0, deliveryQd: 1 }], insuranceEnabled: false });
assert.equal(largeSale.revenueCopper, 2000000000);
assert.equal(largeSale.ok, false, "individually allowed prices and quantities cannot overflow the order money limit");

const { data: shipData } = worldMarketFixture();
const shipHolding = shipData.holdings[0];
const ship = shipHolding.special.ships.list[0];
for (let index = 1; index < 36; index++) {
  const id = `review-sailor-${index}`;
  shipHolding.people.list.push({ id, name: id, wageDailyOverrideCopper: 12 });
  ship.crewResidentIds.push(id);
}
const shipEconomy = normalizeMarketEconomy(shipData.catalog.marketEconomy, { locations: shipData.catalog.eventRegions });
const shipMarket = composeMarketLocation({ location: shipData.catalog.eventRegions.find((row) => row.value === "a"),
  economy: shipEconomy, resources: shipData.catalog.resources, locations: shipData.catalog.eventRegions, normalizedEconomy: true });
const shipArgs = { holding: shipHolding, data: shipData, market: shipMarket, ownShipId: ship.id,
  offers: [{ resourceId: "test-freight", qty: 10, load: 1, unitPriceCopper: 100 }] };
const own = authorityOwnShipOutboundRoute(shipArgs);
assert(own.route, own.reason);
const poisoned = authorityOwnShipOutboundRoute({ ...shipArgs, routes: [{ transportMode: "airship", tariffCopper: 999999,
  insurancePremiumRate: 1, riskLossChance: 0.08, riskDelayChance: 0.45 }] });
assert.deepEqual(poisoned.route, own.route, "an unrelated hired carrier cannot set own-ship taxes, insurance or risk");
assert(own.route.riskLossChance > 0 && own.route.insurancePremiumRate > 0);
const clientData = structuredClone(shipData);
clientData.catalog.marketEconomy.countries = clientData.catalog.eventRegions.map((region, index) => {
  region.countryId = `customs-${index}`;
  return { id: region.countryId, taxRate: 0.05, exportTaxRate: 0.01 * (index + 1) };
});
const clientHolding = clientData.holdings[0];
const clientShip = clientHolding.special.ships.list[0];
const clientOffers = generateWorldShipOffers(clientData, clientHolding, clientShip, { period: "review", random: () => 0.5 });
const freight = clientOffers.find((offer) => offer.kind === "freight");
assert(freight);
const pickupRegion = clientData.catalog.eventRegions.find((region) => region.value === freight.contract.pickup.regionId);
const pickupCountry = clientData.catalog.marketEconomy.countries.find((country) => country.id === pickupRegion.countryId);
const expectedExport = Math.ceil(freight.contract.cargo.valueCopper * pickupCountry.exportTaxRate);
assert.equal(freight.quote.costs.exportTaxCopper, expectedExport);
const mail = structuredClone(clientOffers.find((offer) => offer.kind === "commission"));
assert(mail);
mail.contract.cargo.loadPoints = 1;
const bundle = quoteWorldShipBundle(clientData, clientHolding, clientShip, [freight, mail]);
assert.equal(bundle.stops.reduce((sum, stop) => sum + (stop.legOffer.quote.costs.exportTaxCopper ?? 0), 0), expectedExport,
  "a bundle must charge export at its cargo pickup rather than at the delivery port");
console.log("Market review regressions passed: exhausted Items, >2000 balances, final merchant prices, constrained cheapest routes, directional taxes, canonical load, reports, money limits and independent own-ship policy.");
