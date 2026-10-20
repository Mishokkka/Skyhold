import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { normalizeMarketEconomy } from "../data/market/economy.js";
import { normalizeMarketOffer } from "../data/market/market-catalog.js";
import { normalizeEventRegionOptions } from "../data/random-events.js";
import { normalizeSkyholdData } from "../data/normalizers.js";
import { composeMarketLocation, effectiveMarketLocations, marketLocationFactors } from "../engines/market/composition.js";
import { allocateQuoteToMerchantProviders, applyCarrierToLogistics, carrierProvidersForRoute, merchantProvidersForCountry } from "../engines/market/providers.js";
import { normalizeResourceCatalogRow } from "../core/resources.js";
import { groupMarketOffers, marketOfferGroupTotals, merchantAbbreviation, merchantTone } from "../apps/market/offer-groups.js";
import { planMarketPurchase, prepareMarketOutboundQuote, prepareMarketQuote, resolveMarketOfferEconomics } from "../engines/market/pricing.js";

assert.equal(normalizeResourceCatalogRow({ id: "bulk-test", label: "Партия", unit: "20 кг" }).unit, "ед.", "resource catalogs must migrate physical units to abstract units");

const inheritedCatalogResource = normalizeResourceCatalogRow({ id: "catalog-good", label: "Каталожный товар", basePriceCopper: 24, loadPoints: 7 });
const overrideCatalogResource = normalizeResourceCatalogRow({ id: "catalog-override", label: "Товар с переопределением", basePriceCopper: 30, loadPoints: 5 });
const inheritedEconomics = resolveMarketOfferEconomics({ id: "inherit-direct", sourceType: "resource", resourceId: inheritedCatalogResource.id, priceFactor: 1.5 }, inheritedCatalogResource);
assert.deepEqual(
  [inheritedEconomics.basePriceCopper, inheritedEconomics.loadPoints, inheritedEconomics.load, inheritedEconomics.priceSource, inheritedEconomics.loadSource],
  [36, 7, 1.75, "resource", "resource"],
  "a new resource offer must inherit canonical catalog price and load before applying its own price factor"
);
const clearedLegacyAliases = normalizeMarketOffer({
  id: "cleared-legacy-aliases",
  resourceId: inheritedCatalogResource.id,
  priceOverrideCopper: null,
  loadOverridePoints: null,
  basePriceCopper: 99,
  load: 8
});
assert.equal(clearedLegacyAliases.priceOverrideCopper, null, "an explicit null price override must clear a migrated legacy alias");
assert.equal(clearedLegacyAliases.loadOverridePoints, null, "an explicit null load override must clear a migrated legacy alias");
assert.equal(Object.hasOwn(clearedLegacyAliases, "basePriceCopper"), false, "clearing a resource price override must stop persisting its legacy alias");
assert.equal(Object.hasOwn(clearedLegacyAliases, "load"), false, "clearing a resource load override must stop persisting its legacy alias");

const resources = [
  { id: "grain", label: "Зерно", category: "Продовольствие", materialGroups: ["edible", "organic"] },
  { id: "iron", label: "Железо", category: "Металлы", materialGroups: ["metal"] },
  { id: "fish", label: "Рыба", category: "Продовольствие", materialGroups: ["edible", "organic"] },
  { id: "salted-fish", label: "Солёная рыба", unit: "10 кг", cost: "15 ММ", category: "Продовольствие", materialGroups: ["edible", "organic"], marketTags: ["fish", "preserved-food"] },
  inheritedCatalogResource,
  overrideCatalogResource
];

const locations = normalizeEventRegionOptions([
  {
    value: "north-port",
    label: "Северный порт",
    countryId: "northland",
    marketSizeId: "local",
    marketSpecialtyIds: ["fishery"],
    marketConditionId: "reconstruction",
    marketTaxRate: 0.03,
    marketTransportModes: ["airship"]
  },
  {
    value: "north-capital",
    label: "Столица Севера",
    countryId: "northland",
    marketSizeId: "regional",
    marketSpecialtyIds: [],
    marketTransportModes: ["caravan", "airship"]
  }
], { fallback: false });

const economy = normalizeMarketEconomy({
  settings: { quotePeriodDays: 10, deliveryMode: "scheduled", baseDeliveryQd: 2, handlingFlatCopper: 8, handlingSubtotalRate: 0.02, handlingLoadCopper: 1, airshipHireCopper: 120 },
  baseOffers: [
    { id: "base-grain", resourceId: "grain", name: "Зерно", kind: "resource", ubiquity: "essential", basePriceCopper: 10, baseStock: 100, volatility: 0.2, load: 1, tags: ["food", "grain"] },
    { id: "base-iron", resourceId: "iron", name: "Железо", kind: "material", ubiquity: "specialized", basePriceCopper: 30, baseStock: 40, volatility: 0.2, load: 2, tags: ["metal", "ore"] },
    { id: "catalog-inherited", resourceId: inheritedCatalogResource.id, name: "Наследуемый товар", kind: "resource", ubiquity: "essential", priceFactor: 1.5, baseStock: 10, volatility: 0 },
    { id: "catalog-overridden", resourceId: overrideCatalogResource.id, name: "Переопределённый товар", kind: "resource", ubiquity: "essential", priceOverrideCopper: 40, loadOverridePoints: 9, priceFactor: 0.5, baseStock: 10, volatility: 0 },
    { id: "catalog-item", sourceType: "item", itemUuid: "Compendium.world.goods.Item.market-test", name: "Предмет", kind: "consumable", ubiquity: "essential", basePriceCopper: 50, load: 1.5, baseStock: 10, volatility: 0 }
  ],
  sizeProfiles: [
    { id: "local", label: "Местный", maxUbiquity: "ordinary", stockFactor: 0.5, priceFactor: 1.1, handlingFactor: 1.1 },
    { id: "regional", label: "Региональный", maxUbiquity: "specialized", stockFactor: 2, priceFactor: 0.95, handlingFactor: 0.9 }
  ],
  conditions: [
    { id: "stable", label: "Стабильно", priceFactor: 1, stockFactor: 1, deliveryFactor: 1, timeFactor: 1, riskFactor: 1, volatilityFactor: 1 },
    { id: "ruined", label: "Разрушен", priceFactor: 1.5, stockFactor: 0.25, deliveryFactor: 1.8, timeFactor: 2, riskFactor: 2.2, volatilityFactor: 1.5 },
    { id: "reconstruction", label: "Восстановление", priceFactor: 1.1, stockFactor: 0.8, deliveryFactor: 1.2, timeFactor: 1.15, riskFactor: 1.2, volatilityFactor: 1.2 }
  ],
  specialties: [{
    id: "fishery",
    label: "Рыболовный порт",
    category: "Промыслы",
    active: true,
    rules: [{ id: "fishery-food", label: "Местный улов", mode: "produce", targetTags: ["fish"], stockFactor: 2, priceFactor: 0.8, volatilityFactor: 1 }],
    offers: [{ id: "fresh-fish", resourceId: "fish", name: "Свежая рыба", kind: "consumable", ubiquity: "specialized", forceAvailable: true, basePriceCopper: 8, baseStock: 60, volatility: 0.3, load: 1, tags: ["fish", "food"] }]
  }],
  countries: [{
    id: "northland",
    label: "Северная держава",
    active: true,
    conditionId: "ruined",
    taxRate: 0.05,
    priceFactor: 1.1,
    stockFactor: 0.8,
    deliveryFactor: 1.2,
    timeFactor: 1.1,
    riskFactor: 1.3,
    rules: [{ id: "north-grain", label: "Зерновой дефицит", mode: "consume", targetTags: ["grain"], stockFactor: 0.5, priceFactor: 1.25, volatilityFactor: 1.1 }],
    offers: [],
    tags: []
  }],
  organizations: [
    {
      id: "merchant-house",
      label: "Северный торговый дом",
      active: true,
      merchant: { enabled: true, countryShares: [{ countryId: "northland", sharePct: 30 }], includeTags: [], excludeTags: [], priceFactor: 0.95, priceVolatility: 0, stockStability: 1 },
      buyer: { enabled: true, countryShares: [{ countryId: "northland", sharePct: 25 }], includeTags: ["grain"], excludeTags: ["restricted"] },
      carrier: { enabled: false, countryShares: [], modes: [], priceFactor: 1, timeFactor: 1, riskFactor: 1, capacityFactor: 1 }
    },
    {
      id: "iron-guild",
      label: "Железная гильдия",
      active: true,
      merchant: { enabled: true, countryShares: [{ countryId: "northland", sharePct: 20 }], includeTags: ["metal"], excludeTags: [], priceFactor: 1.05, priceVolatility: 0, stockStability: 1 },
      carrier: { enabled: false, countryShares: [], modes: [], priceFactor: 1, timeFactor: 1, riskFactor: 1, capacityFactor: 1 }
    },
    {
      id: "swift-air",
      label: "Быстрые воздушные линии",
      active: true,
      merchant: { enabled: false, countryShares: [], includeTags: [], excludeTags: [], priceFactor: 1, priceVolatility: 0, stockStability: 1 },
      carrier: { enabled: true, countryShares: [{ countryId: "northland", sharePct: 40, modeShares: { airship: 55 } }], modes: ["airship"], priceFactor: 1.2, timeFactor: 0.7, riskFactor: 0.8, capacityFactor: 0.75 }
    }
  ]
}, { locations });

assert.equal(economy.countries.length, 1);
assert.equal(economy.specialties.length, 1);
assert.equal(economy.organizations.length, 3);
assert.equal(economy.schemaVersion, 3, "organization buyers must use the explicit market-economy schema");
assert.deepEqual(
  economy.organizations[0].buyer,
  { enabled: true, countryShares: [{ countryId: "northland", sharePct: 25, modeShares: { caravan: null, rail: null, airship: null }, active: true }], includeTags: ["grain"], excludeTags: ["restricted"] },
  "buyer presence and assortment filters must survive normalization independently from merchant shares"
);
assert.equal(economy.baseOffers.find((row) => row.id === "catalog-inherited").priceOverrideCopper, null, "a normalized resource offer without an override must retain inheritance");
assert.equal(Object.hasOwn(economy.baseOffers.find((row) => row.id === "catalog-inherited"), "basePriceCopper"), false, "resource inheritance must not be masked by a synthetic one-copper legacy field");
assert.deepEqual(
  [economy.baseOffers.find((row) => row.id === "base-grain").priceOverrideCopper, economy.baseOffers.find((row) => row.id === "base-grain").loadOverridePoints],
  [10, 4],
  "legacy resource offer price and load must migrate as explicit overrides"
);
assert.deepEqual(
  [economy.baseOffers.find((row) => row.id === "catalog-item").priceOverrideCopper, economy.baseOffers.find((row) => row.id === "catalog-item").loadOverridePoints],
  [50, 6],
  "item offers must retain their own required price and load overrides"
);
assert.deepEqual(
  [economy.settings.caravanCapacityLoad, economy.settings.railCapacityLoad, economy.settings.airshipCapacityLoad],
  [400, 8000, 4000],
  "transport capacity defaults must be normalized into editable market settings"
);

const migratedLegacyCapacities = normalizeMarketEconomy({
  schemaVersion: 1,
  settings: { caravanCapacityLoad: 80, railCapacityLoad: 480, airshipCapacityLoad: 200 }
});
assert.deepEqual(
  [migratedLegacyCapacities.settings.caravanCapacityLoad, migratedLegacyCapacities.settings.railCapacityLoad, migratedLegacyCapacities.settings.airshipCapacityLoad],
  [400, 8000, 4000],
  "legacy default capacities must migrate without requiring a content-pack reimport"
);

const preservedCustomCapacities = normalizeMarketEconomy({
  schemaVersion: 1,
  settings: { caravanCapacityLoad: 600, railCapacityLoad: 9000, airshipCapacityLoad: 5000 }
});
assert.deepEqual(
  [preservedCustomCapacities.settings.caravanCapacityLoad, preservedCustomCapacities.settings.railCapacityLoad, preservedCustomCapacities.settings.airshipCapacityLoad],
  [600, 9000, 5000],
  "custom capacities from older worlds must remain untouched"
);

const portMarket = composeMarketLocation({ location: locations[0], economy, resources, locations });
const capitalMarket = composeMarketLocation({ location: locations[1], economy, resources, locations });
assert.equal(portMarket.countryId, "northland", "market location must explicitly inherit one country character");
assert.equal(portMarket.sizeProfileId, "local");
assert.deepEqual(portMarket.specialtyIds, ["fishery"]);
assert.ok(portMarket.offers.some((row) => row.id === "fresh-fish"), "specialty must add its forced local product even to a smaller market");
assert.ok(portMarket.offers.some((row) => row.resourceId === "salted-fish"), "a production specialty must materialize matching catalog goods above the base assortment");
assert.ok(portMarket.offers.every((row) => row.unit === "ед."), "market composition must migrate physical package units to abstract units");
assert.equal(portMarket.offers.filter((row) => row.resourceId === "fish").length, 1, "explicit and generated offers for one resource must merge instead of duplicating the product");
assert.equal(portMarket.offers.some((row) => row.id === "base-iron"), false, "small market must hide goods above its ubiquity ceiling");
assert.equal(capitalMarket.offers.some((row) => row.id === "base-iron"), true, "larger market must unlock specialized goods without a hardcoded access level");
assert.equal(portMarket.offers.find((row) => row.id === "base-grain").baseStock, 25, "country demand and location size must compose multiplicatively");
assert.equal(portMarket.offers.find((row) => row.id === "base-grain").basePriceCopper, 14, "country demand and location size must compose into the base price");
assert.equal(portMarket.outboundOffers.find((row) => row.id === "base-grain").baseDemand, 100, "buy-side demand must be composed independently from the stock the market sells");
assert.notEqual(portMarket.outboundOffers.find((row) => row.id === "base-grain").baseDemand, portMarket.offers.find((row) => row.id === "base-grain").baseStock, "a depleted sell-side assortment must not silently become a depleted buy-side demand pool");
assert.deepEqual(
  [portMarket.offers.find((row) => row.id === "catalog-inherited").basePriceCopper, portMarket.offers.find((row) => row.id === "catalog-inherited").loadPoints, portMarket.offers.find((row) => row.id === "catalog-inherited").load],
  [40, 7, 1.75],
  "composition must expose inherited canonical economics after offer and market-size factors"
);
assert.deepEqual(
  [portMarket.offers.find((row) => row.id === "catalog-overridden").basePriceCopper, portMarket.offers.find((row) => row.id === "catalog-overridden").loadPoints],
  [22, 5],
  "resource price overrides retain the factor, but obsolete packaging load cannot change canonical cargo mass"
);
assert.deepEqual(
  [portMarket.offers.find((row) => row.id === "catalog-item").basePriceCopper, portMarket.offers.find((row) => row.id === "catalog-item").loadPoints, portMarket.offers.find((row) => row.id === "catalog-item").load],
  [55, 6, 1.5],
  "item offers must keep their own price and load through composition"
);

const factors = marketLocationFactors(locations[0], economy, locations);
assert.equal(Number(factors.taxRate.toFixed(2)), 0.08, "country and local customs rates must add instead of one silently replacing the other");
assert.ok(factors.price > 1.7, "ruin plus local reconstruction must affect a location through editable conditions");
assert.ok(factors.availability < 0.2, "country crisis must reduce availability without lore-specific engine branches");

const inboundDirectionalQuote = prepareMarketQuote({
  holding: { overview: { reputation: 0 } },
  market: { ...portMarket, offers: [portMarket.offers.find((row) => row.id === "base-grain")] },
  resources,
  location: { id: "direction-test", priceFactor: 1, availabilityFactor: 1, categoryFactors: {} },
  logistics: { priceFactor: 1, stockFactor: 1, sameRegion: true }
});
const outboundDirectionalQuote = prepareMarketOutboundQuote({
  holding: { overview: { reputation: 0 } },
  market: { ...portMarket, outboundOffers: [portMarket.outboundOffers.find((row) => row.id === "base-grain")] },
  resources,
  location: { id: "direction-test", priceFactor: 1, demandFactor: 1, categoryFactors: {} },
  logistics: { outboundPriceFactor: 1.4, demandFactor: 1, sameRegion: true },
  inboundOffers: inboundDirectionalQuote.offers
});
assert.ok(outboundDirectionalQuote.offers[0].demand > inboundDirectionalQuote.offers[0].stock, "outbound demand must have its own deterministic quantity movement instead of inheriting inbound stock");
assert.ok(outboundDirectionalQuote.offers[0].unitPriceCopper <= inboundDirectionalQuote.offers[0].unitPriceCopper, "same-region automatic pricing must not pay more than the same market charges for an immediate resale");

const effective = effectiveMarketLocations({ economy, locations, resources, isGM: true });
assert.deepEqual(effective.map((row) => row.id), ["north-port", "north-capital"]);

const providers = merchantProvidersForCountry({ organizations: economy.organizations, countryId: "northland", isGM: true });
assert.deepEqual(providers.map((row) => [row.id, Math.round(row.sharePct)]), [["merchant-house", 30], ["iron-guild", 20], ["independent-merchants", 50]], "unclaimed market share must remain with independent merchants");
const quotedOffers = [
  { id: "grain-quote", sourceOfferId: "base-grain", name: "Зерно", stock: 100, unitPriceCopper: 10, movementPercent: 0, tags: ["food", "grain"] },
  { id: "iron-quote", sourceOfferId: "base-iron", name: "Железо", stock: 40, unitPriceCopper: 30, movementPercent: 0, tags: ["metal", "ore"] }
];
const allocationA = allocateQuoteToMerchantProviders({ offers: quotedOffers, organizations: economy.organizations, countryId: "northland", quoteKey: "period-1", isGM: true });
const allocationB = allocateQuoteToMerchantProviders({ offers: quotedOffers, organizations: economy.organizations, countryId: "northland", quoteKey: "period-1", isGM: true });
assert.deepEqual(allocationA, allocationB, "provider allocation must remain deterministic within one quote period");
for (const sourceOffer of quotedOffers) {
  assert.equal(allocationA.offers.filter((row) => row.sourceOfferId === sourceOffer.sourceOfferId).reduce((sum, row) => sum + row.stock, 0), sourceOffer.stock, "merchant splitting must preserve total quoted stock exactly");
}
assert.equal(allocationA.offers.some((row) => row.sourceOfferId === "base-grain" && row.providerId === "iron-guild"), false, "company assortment tags must constrain only that provider's stock");
assert.ok(allocationA.offers.some((row) => row.sourceOfferId === "base-grain" && row.providerId === "independent-merchants"), "ineligible company share must fall back to independent merchants instead of deleting stock");
const groupedOffers = groupMarketOffers(allocationA.offers);
assert.equal(groupedOffers.length, quotedOffers.length, "merchant allocations must render as one product row per source offer");
const grainGroup = groupedOffers.find((row) => row.sourceOfferId === "base-grain");
assert.ok(grainGroup.offers.length > 1, "the compact product row must retain merchant choices");
assert.equal(grainGroup.selectedOffer.providerId, "independent-merchants", "independent merchants must remain the neutral default seller");
assert.equal(
  groupMarketOffers(allocationA.offers, { "base-grain": "merchant-house" }).find((row) => row.sourceOfferId === "base-grain").selectedOffer.providerId,
  "merchant-house",
  "choosing a trading company must select its concrete priced quote without restoring duplicate rows"
);
assert.equal(merchantAbbreviation("Независимые торговцы"), "НТ");
assert.equal(merchantAbbreviation("Свободная Торговая Лига"), "СТЛ");
assert.equal(merchantAbbreviation("Купцы"), "КУП");
assert.equal(merchantTone("merchant-house"), merchantTone("merchant-house"), "merchant chip colors must remain stable across renders");
const simultaneousQuantities = Object.fromEntries(grainGroup.offers.slice(0, 2).map((offer, index) => [offer.id, index + 2]));
const simultaneousTotals = marketOfferGroupTotals(grainGroup.offers, simultaneousQuantities);
assert.equal(simultaneousTotals.providerCount, 2, "one product row must retain quantities from several merchant offers at once");
assert.equal(simultaneousTotals.totalQty, 5, "grouped product quantity must sum independent and company orders instead of moving one into the other");
assert.equal(
  simultaneousTotals.totalCopper,
  grainGroup.offers.slice(0, 2).reduce((sum, offer, index) => sum + (offer.unitPriceCopper * (index + 2)), 0),
  "grouped product total must use each selected merchant's own price"
);
const simultaneousPlan = planMarketPurchase({
  holding: { storage: { moneyCopper: 1_000_000 } },
  quote: { offers: grainGroup.offers, logistics: { ok: true }, location: {} },
  quantities: simultaneousQuantities
});
assert.equal(simultaneousPlan.lines.length, 2, "purchase planning must retain two concrete providers for the same source product");
assert.equal(simultaneousPlan.merchantProviderIds.length, 2, "the committed order must record every selected merchant provider");

const carriers = carrierProvidersForRoute({ organizations: economy.organizations, countryId: "northland", transportMode: "airship", routeModes: ["airship"], isGM: true });
assert.deepEqual(carriers.map((row) => [row.id, Math.round(row.sharePct)]), [["independent-carriers", 45], ["swift-air", 55]], "mode-specific transport share and independent residual must be calculated separately from merchants");
const adjustedLogistics = applyCarrierToLogistics({ baseCapacityLoad: 200, distanceFlatCopper: 100, distanceLoadCopper: 2, travelQd: 10, riskFactor: 1.5, transportLabel: "Воздушный корабль" }, carriers.find((row) => row.id === "swift-air"));
assert.equal(adjustedLogistics.distanceFlatCopper, 120);
assert.equal(adjustedLogistics.distanceLoadCopper, 2.4);
assert.equal(adjustedLogistics.travelQd, 7);
assert.equal(Number(adjustedLogistics.riskFactor.toFixed(2)), 1.2);
assert.equal(adjustedLogistics.capacityLoad, 150, "carrier capacity factor must multiply the route bottleneck capacity");
assert.equal(adjustedLogistics.carrierLabel, "Быстрые воздушные линии");

const normalizedLegacy = normalizeSkyholdData({
  meta: { schemaVersion: 65 },
  holdings: [{ id: "legacy-holding", name: "Старое поселение", type: "settlement", overview: { region: "legacy-region" }, storage: { moneyCopper: 123 } }],
  catalog: {
    buildings: [],
    resources: [{ id: "legacy-resource", label: "Сохранённый ресурс", unit: "ед." }],
    markets: [{ id: "obsolete-market", label: "Старый рынок", offers: [] }],
    eventRegions: [{ value: "legacy-region", label: "Старый регион", marketPriceFactor: 1.2 }]
  }
});
assert.deepEqual(normalizedLegacy.catalog.markets, [], "schema 66 must discard legacy provider markets instead of migrating them");
assert.equal(normalizedLegacy.catalog.resources[0].id, "legacy-resource", "discarding markets must not remove unrelated catalog content");
assert.equal(normalizedLegacy.holdings[0].storage.moneyCopper, 123, "discarding markets must not alter settlement storage");
assert.equal(normalizedLegacy.catalog.marketEconomy.countries[0].priceFactor, 1.2, "former region-wide factor must be promoted into its generated country character");
assert.equal(normalizedLegacy.catalog.eventRegions[0].marketPriceFactor, null, "promoted factor must be cleared from the location to prevent double multiplication");

const manyLocations = Array.from({ length: 300 }, (_, index) => ({ ...locations[index % locations.length], value: `location-${index}`, label: `Локация ${index}` }));
const startedAt = performance.now();
const composed = effectiveMarketLocations({ economy, locations: manyLocations, resources, isGM: true });
const elapsedMs = performance.now() - startedAt;
assert.equal(composed.length, 300);
assert.ok(elapsedMs < 250, `300 layered locations should compose within 250 ms, got ${elapsedMs.toFixed(2)} ms`);

console.log(`FBL Skyhold layered market economy: country character, location size/specialties, merchant shares, independent residual, carriers, legacy-market disposal and 300-location composition passed in ${elapsedMs.toFixed(2)} ms.`);
