import assert from "node:assert/strict";
import { mixedMarketRouteFixture } from "./fixtures/mixed-market-route.mjs";
import { DEFAULT_EXTERNAL_MARKET } from "../data/market/default-market.js";
import { effectiveMarketCatalog, marketCatalogSummary, normalizeMarketCatalog } from "../data/market/market-catalog.js";
import { marketLocationForHolding, marketRegionFactors, marketRegionForValue } from "../data/market/region-market.js";
import { normalizeEventRegionOptions } from "../data/random-events.js";
import { marketRouteDistanceKm, marketRoutePolylineLength, normalizeMarketRouteMap } from "../data/market/route-map.js";
import { MARKET_CHARTER_ETA_FACTOR, MARKET_DELIVERY_SERVICES, MARKET_EXPRESS_ETA_FACTOR, MARKET_EXPRESS_SURCHARGE_RATE, MARKET_FREIGHT_MAX_RATE, MARKET_FREIGHT_MIN_RATE, MARKET_STANDARD_ETA_FACTOR, marketHistoricalFreightRate, marketHistoricalInsuranceRate, marketLocationText, marketQuotePeriodKey, marketShipmentRiskProfile, planMarketPurchase, prepareMarketQuote, resolveMarketLocation, splitMarketShipmentLines } from "../engines/market/pricing.js";
import { applyMarketDelivery } from "../engines/market/delivery.js";
import { advanceMarketShipments, cancelMarketShipment, createMarketShipment, deliverMarketShipmentNow, marketShipmentCancellationQuote, resolveMarketShipmentRisk, retainMarketShipmentOrders } from "../engines/market/shipment.js";
import { holdingMarketAccessLevel, marketRegionAccessCostMap, MARKET_TRANSPORT_TARIFFS, resolveMarketLogistics, shortestMarketRoute, shortestMarketRouteDistanceKm } from "../engines/market/logistics.js";
import { allResourceDefs, normalizeResourceCatalogRow } from "../core/resources.js";
import { copperCurrencyParts, formatCopperCurrency, formatCopperCurrencyCompact } from "../core/currency.js";
import { normalizeStorageLogRow } from "../data/normalizers/storage.js";
import { buildHoldingOperationTimeline } from "../data/operation-timeline.js";
import { mergeHoldingDefaults, normalizeSkyholdData } from "../data/normalizers.js";

function holding({ region = "Центральный городской порт", period = "Неделя 1", moneyCopper = 100000, reputation = 0, urs = 3 } = {}) {
  return {
    id: "market-test",
    overview: { region, period, altitude: "", drift: "", reputation },
    storage: { moneyCopper },
    gm: { modifiers: { reputation: 0, marketConnectionsLevel: urs }, calendaria: { lastDateKey: "" } }
  };
}

const resources = allResourceDefs({ catalogRows: [] });
const quotedCatalogResource = normalizeResourceCatalogRow({ id: "quoted-catalog-resource", label: "Каталожный груз", basePriceCopper: 37, loadPoints: 5 });
const canonicalEconomicsQuote = prepareMarketQuote({
  holding: holding(),
  market: {
    id: "canonical-economics",
    label: "Canonical economics",
    deliveryMode: "instant",
    quotePeriodDays: 10,
    offers: [
      { id: "canonical-inherited", sourceType: "resource", resourceId: quotedCatalogResource.id, kind: "resource", priceFactor: 2, baseStock: 10, volatility: 0 },
      { id: "canonical-override", sourceType: "resource", resourceId: quotedCatalogResource.id, kind: "resource", priceOverrideCopper: 50, loadOverridePoints: 3, priceFactor: 0.5, baseStock: 10, volatility: 0 },
      { id: "canonical-item", sourceType: "item", itemUuid: "Compendium.world.goods.Item.quote-test", kind: "consumable", basePriceCopper: 40, load: 2, baseStock: 10, volatility: 0 }
    ]
  },
  resources: [...resources, quotedCatalogResource],
  location: { id: "flat", label: "Flat", priceFactor: 1, availabilityFactor: 1, deliveryQdFactor: 1, categoryFactors: {} },
  logistics: { priceFactor: 1, stockFactor: 1 }
});
assert.deepEqual(
  canonicalEconomicsQuote.offers.map((offer) => [offer.id, offer.basePriceCopper, offer.unitPriceCopper, offer.loadPoints, offer.load]),
  [
    ["canonical-inherited", 74, 74, 5, 1.25],
    ["canonical-override", 25, 25, 5, 1.25],
    ["canonical-item", 40, 40, 8, 2]
  ],
  "resource prices may be overridden, but all resource cargo uses canonical load; Items retain their own economics"
);
assert.equal(formatCopperCurrencyCompact(112), "1 З 1 С 2 М", "compact market currency must use one-letter denominations");
assert.deepEqual(copperCurrencyParts(112).map(({ value, label, tone }) => [value, label, tone]), [[1, "З", "gold"], [1, "С", "silver"], [2, "М", "copper"]], "market currency must expose denomination tones to the template");
const fallbackCatalog = effectiveMarketCatalog([]);
assert.equal(fallbackCatalog.length, 1, "empty world catalog must retain the built-in market fallback");
assert.equal(fallbackCatalog[0].offers.length, DEFAULT_EXTERNAL_MARKET.offers.length);
const worldCatalog = normalizeMarketCatalog([
  {
    id: "external-market",
    label: "Настроенный внешний рынок",
    offers: [
      { id: "market-wood", resourceId: "wood", kind: "material", basePriceCopper: 99, baseStock: 7, volatility: 0.1, load: 1 },
      { id: "market-stone", resourceId: "stone", active: false, kind: "material", basePriceCopper: 5, baseStock: 1 }
    ]
  },
  {
    id: "guild-market",
    label: "Гильдейская ярмарка",
    origin: "Гильдия перевозчиков",
    quotePeriodDays: 4,
    deliveryMode: "scheduled",
    baseDeliveryQd: 12,
    offers: [{ id: "guild-item", sourceType: "item", itemUuid: "Compendium.world.goods.Item.example", name: "Набор инструментов", kind: "consumable", basePriceCopper: 40, baseStock: 5, load: 2, tags: "gear, tools" }]
  }
]);
const effectiveWorldCatalog = effectiveMarketCatalog(worldCatalog);
assert.equal(effectiveWorldCatalog.length, 2, "world catalog must add providers without removing the fallback provider");
assert.equal(effectiveWorldCatalog[0].offers.find((offer) => offer.id === "market-wood").basePriceCopper, 99, "stable offer id must override the built-in offer");
assert.equal(effectiveWorldCatalog[0].offers.find((offer) => offer.id === "market-stone").active, false, "disabled built-in offers must remain disabled after merge");
assert.equal(effectiveWorldCatalog[1].offers[0].sourceType, "item");
assert.equal(effectiveWorldCatalog[1].offers[0].itemUuid, "Compendium.world.goods.Item.example");
assert.equal(effectiveWorldCatalog[1].deliveryMode, "scheduled");
assert.equal(effectiveWorldCatalog[1].baseDeliveryQd, 12);
assert.deepEqual(effectiveWorldCatalog[1].offers[0].tags, ["gear", "tools"]);
assert.deepEqual(marketCatalogSummary(worldCatalog), { marketCount: 2, activeMarketCount: 2, offerCount: DEFAULT_EXTERNAL_MARKET.offers.length, hasOverride: true });
const connected = holding();
const quoteA = prepareMarketQuote({ holding: connected, market: DEFAULT_EXTERNAL_MARKET, resources });
const quoteARepeat = prepareMarketQuote({ holding: connected, market: DEFAULT_EXTERNAL_MARKET, resources });
assert.deepEqual(quoteA, quoteARepeat, "same holding period must produce a stable quote");
assert.equal(quoteA.location.id, "connected", "region text must resolve the connected route");
assert.equal(quoteA.deliveryMode, "scheduled");
assert.equal(quoteA.deliveryQd, 2, "built-in preparation time must remain separate from route travel time");
assert.ok(quoteA.offers.every((offer) => offer.unitPriceCopper > 0 && offer.stock >= 0), "offers must have positive prices and non-negative stock");
const basisRegionHolding = holding();
basisRegionHolding.overview.altitude = "Небесный остров";
basisRegionHolding.overview.drift = "Отдалённый маршрут";
assert.equal(marketLocationText(basisRegionHolding), basisRegionHolding.overview.region, "market location text must use only the region selected in Basis");
assert.equal(resolveMarketLocation(basisRegionHolding, DEFAULT_EXTERNAL_MARKET.locationProfiles).id, "connected", "altitude and drift must not override the Basis region");

const nextPeriod = prepareMarketQuote({ holding: holding({ period: "Неделя 2" }), market: DEFAULT_EXTERNAL_MARKET, resources });
assert.notDeepEqual(
  quoteA.offers.map((offer) => offer.unitPriceCopper),
  nextPeriod.offers.map((offer) => offer.unitPriceCopper),
  "prices must change between quote periods"
);
const elapsedTendayHolding = holding({ period: "Неделя 1" });
elapsedTendayHolding.gm.calendaria.lastQd = 40;
assert.equal(marketQuotePeriodKey(elapsedTendayHolding), "game:1:10", "internal tenday time must rotate quotes when Calendaria is unavailable");
const elapsedTendayQuote = prepareMarketQuote({ holding: elapsedTendayHolding, market: DEFAULT_EXTERNAL_MARKET, resources });
assert.notDeepEqual(
  quoteA.offers.map((offer) => offer.unitPriceCopper),
  elapsedTendayQuote.offers.map((offer) => offer.unitPriceCopper),
  "conducting a tenday must rotate market quotes even when overview.period is unchanged"
);

const aerialHolding = holding({ region: "Небесный остров", period: "Неделя 1" });
const aerialQuote = prepareMarketQuote({ holding: aerialHolding, market: DEFAULT_EXTERNAL_MARKET, resources });
assert.equal(resolveMarketLocation(aerialHolding, DEFAULT_EXTERNAL_MARKET.locationProfiles).id, "aerial");
assert.notDeepEqual(
  quoteA.offers.map((offer) => offer.unitPriceCopper),
  aerialQuote.offers.map((offer) => offer.unitPriceCopper),
  "location must affect market prices"
);

const configuredRegions = normalizeEventRegionOptions([{
  value: "central-port",
  label: "Центральный городской порт",
  marketProfile: "remote",
  marketPriceFactor: 1.25,
  marketAvailabilityFactor: 0.8,
  marketDeliveryFactor: 1.5
}], { fallback: false });
assert.equal(marketRegionForValue("  Центральный городской порт  ", configuredRegions)?.value, "central-port", "catalog resolver must match the Basis region label robustly");
const migratedBlankRegion = normalizeSkyholdData({
  meta: { schemaVersion: 59 },
  holdings: [{ ...holding({ region: "" }), type: "settlement" }],
  catalog: { buildings: [], resources: [], markets: [], eventRegions: configuredRegions }
});
assert.equal(migratedBlankRegion.holdings[0].overview.region, "central-port", "legacy visually-selected first region must be persisted during migration");
const configuredLocation = marketLocationForHolding({
  holding: connected,
  regionOptions: configuredRegions,
  profiles: DEFAULT_EXTERNAL_MARKET.locationProfiles,
  fallbackLocation: resolveMarketLocation(connected, DEFAULT_EXTERNAL_MARKET.locationProfiles)
});
assert.equal(configuredLocation.id, "region:central-port:remote");
assert.equal(configuredLocation.priceFactor, 1.16 * 1.25);
assert.equal(configuredLocation.availabilityFactor, 0.72 * 0.8);
assert.equal(configuredLocation.deliveryFlatCopper, 14 * 1.5);
const configuredQuote = prepareMarketQuote({ holding: connected, market: DEFAULT_EXTERNAL_MARKET, resources, location: configuredLocation });
assert.equal(configuredQuote.location.id, "region:central-port:remote", "catalog region settings must override keyword route inference");
assert.notDeepEqual(
  configuredQuote.offers.map((offer) => offer.unitPriceCopper),
  quoteA.offers.map((offer) => offer.unitPriceCopper),
  "explicit regional profile and factors must affect the quote"
);

const logisticsRegions = normalizeEventRegionOptions([
  { value: "izauver", label: "Изуавер", marketProfile: "connected", marketLandmassId: "griston", marketStatus: "thriving", marketTransportModes: "caravan, rail, airship", marketLinks: ["novand:80km:airship", { regionId: "fletchenrand", distance: 1, distanceMode: "scaled", pathPoints: [{ x: 120, y: 80 }, { x: 240, y: 160 }], modes: ["caravan", "rail"], seasonalModifiers: { winter: { enabled: true, costFactor: 1.4, timeFactor: 1.5, riskFactor: 1.25 } } }] },
  { value: "fletchenrand", label: "Флеченранд", marketProfile: "connected", marketLandmassId: "griston", marketTaxRate: 0.05, marketTransportModes: ["caravan", "rail", "airship"], marketLinks: [{ regionId: "izauver", distance: 1, modes: ["caravan", "rail"] }] },
  { value: "novand", label: "Нованд", marketProfile: "aerial", marketLandmassId: "novand", marketStatus: "ruined", marketAirshipOnly: true, marketTransportModes: ["airship"], marketPriceFactor: 1.1, marketAvailabilityFactor: 0.8, marketTimeFactor: 1.2, marketTaxRate: 0.05 }
], { fallback: false });
assert.equal(logisticsRegions[2].marketStatus, "ruined");
assert.equal(logisticsRegions[2].marketAirshipOnly, true);
assert.equal(logisticsRegions[0].marketLinks[0].regionId, "novand");
assert.equal(logisticsRegions[0].marketLinks[0].distanceKm, 80, "explicit kilometer strings must not be remultiplied as legacy route units");
assert.equal(logisticsRegions[0].marketLinks[1].distanceKm, 40, "legacy string distances must migrate at 40 km per route unit");
assert.equal(logisticsRegions[0].marketLinks[1].distanceMode, "scaled", "automatic distance mode must survive region normalization");
assert.deepEqual(logisticsRegions[0].marketLinks[1].pathPoints, [{ x: 120, y: 80 }, { x: 240, y: 160 }], "route waypoints must survive region normalization");
assert.equal(logisticsRegions[0].marketLinks[1].seasonalModifiers.winter.costFactor, 1.4, "editable edge season factors must survive normalization");
assert.equal(shortestMarketRoute("fletchenrand", "novand", logisticsRegions).distance, 3, "editable region graph must determine route distance");
assert.equal(shortestMarketRouteDistanceKm("fletchenrand", "novand", logisticsRegions), 120, "route graph must expose canonical real-world distance in kilometers");
const novandRoute = shortestMarketRoute("fletchenrand", "novand", logisticsRegions, { metric: "hops" });
assert.deepEqual(novandRoute.path, ["fletchenrand", "izauver", "novand"], "route graph must expose the traversed locations");
assert.equal(novandRoute.hops, 2, "each traversed graph edge must count as one access step");
assert.equal(MARKET_TRANSPORT_TARIFFS.caravan.loadDistanceCopper, 1, "historical tariff contract must stay test-visible");
assert.equal(MARKET_TRANSPORT_TARIFFS.airship.loadDistanceCopper, 0.02, "sea-like airship mass freight must retain the corrected bulk-shipping calibration");
assert.equal(MARKET_TRANSPORT_TARIFFS.airship.operatingCopperPerQd, 20, "airship crew and upkeep must be funded separately from marginal cargo mass");
assert.ok(MARKET_TRANSPORT_TARIFFS.airship.loadDistanceCopper < MARKET_TRANSPORT_TARIFFS.rail.loadDistanceCopper, "bulk airship freight must not remain four times dearer than rail while claiming a maritime calibration");
const developedHolding = {
  ...holding({ region: "Флеченранд" }),
  type: "settlement",
  overview: { ...holding({ region: "Флеченранд" }).overview, development: { technology: 4, culture: 2 } },
  buildings: { list: [] },
  special: { market: {} }
};
assert.equal(holdingMarketAccessLevel(developedHolding).level, 3, "the GM-entered URS must be the market-access budget");
assert.equal(holdingMarketAccessLevel(holding({ urs: 7 })).level, 7, "URS must not collapse all values of four or more into global access");
assert.equal(marketRegionAccessCostMap({ holding: developedHolding, regions: logisticsRegions, dependencies: { regionResolver: marketRegionForValue } }).get("novand"), 2, "the reusable reachability map must sum URS costs from the settlement region");
const weightedRegions = normalizeEventRegionOptions([
  { value: "weighted-a", label: "Weighted A", marketLinks: [{ regionId: "weighted-b", distanceKm: 10, ursCost: 4 }, { regionId: "weighted-c", distanceKm: 20, ursCost: 1 }] },
  { value: "weighted-b", label: "Weighted B", marketLinks: [] },
  { value: "weighted-c", label: "Weighted C", marketLinks: [{ regionId: "weighted-b", distanceKm: 20, ursCost: 1 }] }
], { fallback: false });
const weightedRoute = shortestMarketRoute("weighted-a", "weighted-b", weightedRegions, { metric: "access" });
assert.deepEqual(weightedRoute.path, ["weighted-a", "weighted-c", "weighted-b"], "route access must prefer the lower total URS cost over fewer links");
assert.equal(weightedRoute.accessCost, 2, "route access must sum per-link URS costs");
assert.equal(marketRegionAccessCostMap({ holding: holding({ region: "Weighted A" }), regions: weightedRegions, dependencies: { regionResolver: marketRegionForValue } }).get("weighted-b"), 2, "market reachability must use weighted URS costs");
const novandMarket = normalizeMarketCatalog([{
  id: "novand-wine",
  label: "Новандские винные дома",
  regionId: "novand",
  accessLevelOverride: 0,
  transportModes: "caravan, rail, airship",
  deliveryDistanceCopper: 0,
  deliveryLoadDistanceCopper: 0,
  airshipHireCopper: 120,
  deliveryMode: "scheduled",
  baseDeliveryQd: 8,
  offers: [
    { id: "novand-wine-offer", resourceId: "water", name: "Вино", basePriceCopper: 10, baseStock: 500, load: 1, accessDifficulty: 0 },
    { id: "novand-licensed-offer", resourceId: "custom", name: "Лицензируемый узел", basePriceCopper: 100, baseStock: 5, load: 1, accessDifficulty: 2 }
  ]
}])[0];
const logisticsDependencies = { regionFactors: marketRegionFactors, regionResolver: marketRegionForValue };
const novandLogistics = resolveMarketLogistics({ holding: developedHolding, market: novandMarket, regions: logisticsRegions, dependencies: logisticsDependencies });
assert.equal(novandLogistics.ok, true);
assert.equal(novandLogistics.transportMode, "multimodal", "different landmasses may combine ground and air legs");
assert.equal(novandLogistics.distance, 3);
assert.equal(novandLogistics.distanceKm, 120);
assert.equal(novandLogistics.hops, 2);
assert.equal(novandLogistics.requiredAccessLevel, 2, "access difficulty must derive from the number of graph links");
assert.deepEqual(novandLogistics.routeModes, ["rail", "airship"]);
assert.equal(novandLogistics.baseCapacityLoad, 4000, "a multimodal route must use the capacity of its narrowest transport leg");
assert.ok(novandLogistics.distanceFlatCopper >= 120, "airship route must include the editable hire fee");
assert.ok(novandLogistics.priceFactor > 1 && novandLogistics.stockFactor < 1, "ruined origin status must affect export price and stock without lore hardcoding");
const movedHolding = { ...developedHolding, overview: { ...developedHolding.overview, region: "Изуавер" } };
const movedLogistics = resolveMarketLogistics({ holding: movedHolding, market: novandMarket, regions: logisticsRegions, dependencies: logisticsDependencies });
assert.equal(movedLogistics.requiredAccessLevel, 1, "moving a holding to a neighboring region must recalculate market access");
assert.equal(movedLogistics.hops, 1);
assert.equal(movedLogistics.distance, 2);
assert.equal(movedLogistics.distanceKm, 80);
assert.ok(novandLogistics.distanceFlatCopper > movedLogistics.distanceFlatCopper, "a longer route must cost more even when both routes require an airship");
assert.ok(marketHistoricalFreightRate(novandLogistics) > marketHistoricalFreightRate(movedLogistics), "a longer, higher-URS route must produce a visibly higher value-based freight rate");
assert.notDeepEqual(movedLogistics.routePath, novandLogistics.routePath, "moving the holding must replace the resolved route path");
const ursExampleLocalMarket = normalizeMarketCatalog([{
  id: "urs-example-local",
  label: "Local strategic goods",
  regionId: "fletchenrand",
  transportModes: "caravan, rail, airship",
  offers: [{ id: "urs-example-core", resourceId: "custom", name: "Crystal Core", basePriceCopper: 1000, baseStock: 1, load: 1, accessDifficulty: 4 }]
}])[0];
const ursExampleNeighborMarket = normalizeMarketCatalog([{
  id: "urs-example-neighbor",
  label: "Neighbor common goods",
  regionId: "izauver",
  transportModes: "caravan, rail, airship",
  offers: [{ id: "urs-example-pastry", resourceId: "custom", name: "Sweet Pastry", basePriceCopper: 5, baseStock: 20, load: 1, accessDifficulty: 1 }]
}])[0];
const ursExampleHolding1 = {
  ...developedHolding,
  gm: { ...developedHolding.gm, modifiers: { ...developedHolding.gm.modifiers, marketConnectionsLevel: 1 } }
};
const ursExampleLocalLogistics1 = resolveMarketLogistics({ holding: ursExampleHolding1, market: ursExampleLocalMarket, regions: logisticsRegions, dependencies: logisticsDependencies });
const ursExampleNeighborLogistics1 = resolveMarketLogistics({ holding: ursExampleHolding1, market: ursExampleNeighborMarket, regions: logisticsRegions, dependencies: logisticsDependencies });
const ursExampleLocalQuote1 = prepareMarketQuote({ holding: ursExampleHolding1, market: ursExampleLocalMarket, resources, logistics: ursExampleLocalLogistics1 });
const ursExampleNeighborQuote1 = prepareMarketQuote({ holding: ursExampleHolding1, market: ursExampleNeighborMarket, resources, logistics: ursExampleNeighborLogistics1 });
assert.equal(ursExampleLocalLogistics1.hops, 0, "a market in the settlement region must add zero route URS");
assert.equal(ursExampleNeighborLogistics1.hops, 1, "a neighboring market must add exactly one route URS");
assert.equal(ursExampleLocalQuote1.offers.length, 0, "URS 1 must not reveal a local item with difficulty 4");
assert.equal(ursExampleNeighborQuote1.offers.length, 0, "URS 1 must not reveal a neighboring item with difficulty 1 because the total is 2");
const ursExampleHolding2 = {
  ...ursExampleHolding1,
  gm: { ...ursExampleHolding1.gm, modifiers: { ...ursExampleHolding1.gm.modifiers, marketConnectionsLevel: 2 } }
};
const ursExampleLocalQuote2 = prepareMarketQuote({ holding: ursExampleHolding2, market: ursExampleLocalMarket, resources, logistics: { ...ursExampleLocalLogistics1, accessLevel: 2 } });
const ursExampleNeighborQuote2 = prepareMarketQuote({ holding: ursExampleHolding2, market: ursExampleNeighborMarket, resources, logistics: { ...ursExampleNeighborLogistics1, accessLevel: 2 } });
assert.equal(ursExampleLocalQuote2.offers.length, 0, "URS 2 must still hide a local item with difficulty 4");
assert.equal(ursExampleNeighborQuote2.offers[0]?.requiredUrs, 2, "one route hop plus item difficulty 1 must require URS 2");
const routeMap = normalizeMarketRouteMap({
  background: "worlds/demo/map.webp",
  backgroundOpacity: 0.55,
  worldWidth: 3200,
  worldHeight: 1800,
  centerX: 900,
  centerY: 650,
  zoom: 1.7,
  nodeMode: "compact",
  kmPerPixel: 0.5,
  calibration: { pointA: { x: 100, y: 100 }, pointB: { x: 300, y: 100 }, distanceKm: 100 }
});
assert.deepEqual(routeMap, {
  background: "worlds/demo/map.webp",
  backgroundOpacity: 0.55,
  worldWidth: 3200,
  worldHeight: 1800,
  centerX: 900,
  centerY: 650,
  zoom: 1.7,
  nodeMode: "compact",
  kmPerPixel: 0.5,
  calibration: { pointA: { x: 100, y: 100 }, pointB: { x: 300, y: 100 }, distanceKm: 100 },
  contentVersion: 1,
  contentSource: ""
}, "route-map background, viewport, node mode and scale calibration must survive normalization");
const bentRoutePoints = [{ x: 0, y: 0 }, { x: 30, y: 40 }, { x: 60, y: 40 }];
assert.equal(marketRoutePolylineLength(bentRoutePoints), 80, "route geometry must sum every straight segment");
assert.equal(marketRouteDistanceKm(bentRoutePoints, routeMap), 40, "calibrated route distance must follow the bent path instead of the direct chord");
const caravanLeg = resolveMarketLogistics({ holding: developedHolding, market: { ...novandMarket, regionId: "izauver", transportModes: ["caravan"] }, regions: logisticsRegions, dependencies: logisticsDependencies });
const railLeg = resolveMarketLogistics({ holding: developedHolding, market: { ...novandMarket, regionId: "izauver", transportModes: ["rail"] }, regions: logisticsRegions, dependencies: logisticsDependencies });
assert.ok(caravanLeg.distanceFlatCopper + 20 * caravanLeg.distanceLoadCopper > railLeg.distanceFlatCopper + 20 * railLeg.distanceLoadCopper, "rail must become cheaper than a caravan for a sufficiently heavy shipment");
const summerCaravanLeg = resolveMarketLogistics({ holding: developedHolding, market: { ...novandMarket, regionId: "izauver", transportModes: ["caravan"] }, regions: logisticsRegions, seasonId: "summer", dependencies: logisticsDependencies });
const winterCaravanLeg = resolveMarketLogistics({ holding: developedHolding, market: { ...novandMarket, regionId: "izauver", transportModes: ["caravan"] }, regions: logisticsRegions, seasonId: "winter", dependencies: logisticsDependencies });
assert.equal(winterCaravanLeg.seasonalEdgeCount, 1, "winter modifier must apply only to the configured edge");
assert.ok(winterCaravanLeg.distanceFlatCopper + 20 * winterCaravanLeg.distanceLoadCopper > summerCaravanLeg.distanceFlatCopper + 20 * summerCaravanLeg.distanceLoadCopper, "winter road premium must raise route cost without a global hardcode");
assert.ok(winterCaravanLeg.travelQd > summerCaravanLeg.travelQd, "seasonal edge time factor must affect ETA");
assert.ok(winterCaravanLeg.riskFactor > summerCaravanLeg.riskFactor, "seasonal edge risk factor must affect shipment risk");
const driftOnlyHolding = { ...developedHolding, overview: { ...developedHolding.overview, region: "", altitude: "Флеченранд", drift: "Флеченранд" } };
const driftOnlyLogistics = resolveMarketLogistics({ holding: driftOnlyHolding, market: novandMarket, regions: logisticsRegions, dependencies: logisticsDependencies });
assert.equal(driftOnlyLogistics.ok, false, "altitude and drift must never substitute for the Basis region");
assert.match(driftOnlyLogistics.reasons.join(" "), /Регион поселения не найден/i);
const skyIslandHolding = { ...developedHolding, type: "sky-island", overview: { ...developedHolding.overview, region: "Изуавер" } };
const localGroundMarket = { ...novandMarket, regionId: "fletchenrand", accessLevelOverride: 0, transportModes: ["caravan"] };
const skyIslandRoute = resolveMarketLogistics({ holding: skyIslandHolding, market: localGroundMarket, regions: logisticsRegions, dependencies: logisticsDependencies });
assert.equal(skyIslandRoute.ok, false);
assert.match(skyIslandRoute.reasons.join(" "), /воздушн/i, "sky-island delivery must be locked when the provider cannot hire an airship");
const { regions: transferRegions, holding: transferHolding, market: transferMarket } = mixedMarketRouteFixture();
const transferRoute = resolveMarketLogistics({ holding: transferHolding, market: transferMarket, regions: transferRegions });
assert.equal(transferRoute.ok, true, "a ground-only supplier can hand cargo to airship carriers at an intermediate transfer port");
assert.deepEqual(transferRoute.routeModes, ["airship", "airship", "airship", "caravan"]);
assert.equal(transferRoute.requiredAccessLevel, 4); assert.equal(transferRoute.transportMode, "multimodal");
const transferQuote = prepareMarketQuote({ holding: { ...developedHolding, ...transferHolding }, market: { ...novandMarket, ...transferMarket }, resources,
  location: resolveMarketLocation(developedHolding, DEFAULT_EXTERNAL_MARKET.locationProfiles), logistics: transferRoute });
const transferPlan = planMarketPurchase({ holding: developedHolding, quote: transferQuote, quantities: { "novand-wine-offer": 2 } });
assert.equal(transferPlan.inaccessible, false); assert.equal(transferPlan.ok, true, "mixed delivery must proceed beyond reachability to a valid purchase plan");
assert.ok(transferPlan.routeCopper > 0, "all mixed delivery legs remain paid");
for (const direction of ["inbound", "outbound"]) {
  assert.equal(resolveMarketLogistics({ holding: transferHolding, market: transferMarket, regions: transferRegions, direction }).ok, true);
}
assert.equal(resolveMarketLogistics({ holding: transferHolding, market: transferMarket, regions: transferRegions, accessLevel: 3 }).ok, false, "transfers still require the URS of the entire route");
const noTransfer = structuredClone(transferRegions); noTransfer[3].marketTransportModes = ["caravan"];
assert.equal(resolveMarketLogistics({ holding: transferHolding, market: transferMarket, regions: noTransfer }).ok, false, "a transfer port must support both adjacent transport modes");
assert.equal(resolveMarketLogistics({ holding: transferHolding, market: { ...transferMarket, transportModes: ["rail"] }, regions: transferRegions }).ok, false, "supplier restrictions still apply to its own terminal leg");
const buildingAccessHolding = { ...developedHolding, overview: { ...developedHolding.overview, development: { technology: 0, culture: 0 } }, buildings: { list: [{ name: "Большой воздушный порт", lifecycle: "active", condition: "intact", marketAccessLevel: 4 }] } };
assert.equal(holdingMarketAccessLevel(buildingAccessHolding).level, 3, "buildings must not silently replace the manually entered URS");
const logisticsQuote = prepareMarketQuote({ holding: developedHolding, market: novandMarket, resources, location: resolveMarketLocation(developedHolding, DEFAULT_EXTERNAL_MARKET.locationProfiles), logistics: novandLogistics });
assert.equal(logisticsQuote.offers.length, 1, "an item whose route hops plus difficulty exceed URS must stay hidden");
assert.equal(logisticsQuote.offers[0].requiredUrs, 2, "a common item must require only the route hops");
assert.equal(logisticsQuote.hiddenOfferCount, 1);
const connectedRareQuote = prepareMarketQuote({ holding: { ...developedHolding, gm: { ...developedHolding.gm, modifiers: { ...developedHolding.gm.modifiers, marketConnectionsLevel: 4 } } }, market: novandMarket, resources, location: resolveMarketLocation(developedHolding, DEFAULT_EXTERNAL_MARKET.locationProfiles), logistics: { ...novandLogistics, accessLevel: 4 } });
assert.equal(connectedRareQuote.offers.length, 2, "raising URS must reveal the difficult item without changing the market location");
assert.equal(connectedRareQuote.offers.find((offer) => offer.id === "novand-licensed-offer")?.requiredUrs, 4);
const logisticsPlan = planMarketPurchase({ holding: developedHolding, quote: logisticsQuote, quantities: { "novand-wine-offer": 2 } });
const expressLogisticsPlan = planMarketPurchase({ holding: developedHolding, quote: logisticsQuote, quantities: { "novand-wine-offer": 2 }, serviceLevel: "express" });
const overloadedLogisticsPlan = planMarketPurchase({ holding: developedHolding, quote: { ...logisticsQuote, logistics: { ...logisticsQuote.logistics, capacityLoad: 1 } }, quantities: { "novand-wine-offer": 2 } });
assert.equal(logisticsPlan.inaccessible, false);
assert.equal(logisticsPlan.capacityExceeded, false);
assert.equal(overloadedLogisticsPlan.capacityExceeded, true, "orders above carrier capacity must remain previewable but invalid");
assert.equal(overloadedLogisticsPlan.ok, false, "carrier overload must block purchase confirmation");
assert.ok(logisticsPlan.routeCopper > 0);
assert.equal(logisticsPlan.routeCopper, Math.max(logisticsPlan.deliveryBreakdown.valueFreightCopper, logisticsPlan.deliveryBreakdown.operationalFreightCopper), "route freight must use the greater of the ad-valorem quote and the prorated operating cost");
assert.ok(logisticsPlan.deliveryBreakdown.capacityShare > 0 && logisticsPlan.deliveryBreakdown.capacityShare < 1, "a partial cargo must pay only its occupied share of fixed voyage costs");
assert.ok(marketHistoricalFreightRate(logisticsQuote.logistics) >= MARKET_FREIGHT_MIN_RATE && marketHistoricalFreightRate(logisticsQuote.logistics) <= MARKET_FREIGHT_MAX_RATE, "historical freight rate must stay inside the calibrated peacetime band");
assert.ok(marketHistoricalInsuranceRate({ location: logisticsQuote.location, logistics: logisticsQuote.logistics }) >= 0.01, "connected trade routes must retain a historically plausible insurance floor");
assert.equal(logisticsPlan.deliveryCopper, logisticsPlan.routeCopper + logisticsPlan.handlingCopper + logisticsPlan.insuranceCopper + logisticsPlan.taxCopper + logisticsPlan.expressSurchargeCopper, "delivery preview must reconcile every displayed component exactly");
assert.equal(logisticsPlan.deliveryBreakdown.routeCopper, logisticsPlan.routeCopper, "expanded delivery calculation must expose the exact route total");
assert.equal(logisticsPlan.deliveryBreakdown.handlingCopper, logisticsPlan.handlingCopper, "expanded delivery calculation must expose the exact handling total");
assert.equal(logisticsPlan.deliveryBreakdown.insuranceCopper, logisticsPlan.insuranceCopper, "expanded delivery calculation must expose the exact insurance total");
assert.equal(logisticsPlan.deliveryBreakdown.taxCopper, logisticsPlan.taxCopper, "expanded delivery calculation must expose the exact tax total");
assert.equal(logisticsPlan.deliveryBreakdown.deliveryCopper, logisticsPlan.deliveryCopper, "expanded delivery calculation must reconcile to the displayed delivery price");
assert.ok(logisticsPlan.taxCopper > 0, "destination tax must be separated in the delivery preview");
assert.ok(logisticsPlan.handlingCopper > 0, "terminal handling must be shown separately from transport");
assert.ok(logisticsPlan.insuranceCopper > 0, "risk insurance must be shown separately from mass-based transport");
assert.equal(MARKET_EXPRESS_SURCHARGE_RATE, 0.2);
assert.equal(MARKET_EXPRESS_ETA_FACTOR, 0.7);
assert.equal(MARKET_STANDARD_ETA_FACTOR, 1.25);
assert.equal(MARKET_CHARTER_ETA_FACTOR, 0.85);
assert.deepEqual(Object.keys(MARKET_DELIVERY_SERVICES), ["standard", "express", "charter"], "the market must expose exactly the three player-facing delivery services");
assert.equal(expressLogisticsPlan.serviceLevel, "express");
assert.ok(expressLogisticsPlan.deliveryQd < logisticsPlan.deliveryQd, "express service must shorten a multi-QD route");
assert.ok(expressLogisticsPlan.expressSurchargeCopper > 0 && expressLogisticsPlan.totalCopper > logisticsPlan.totalCopper, "express service must expose its separate premium");

const splitLines = splitMarketShipmentLines([{ id: "wood", qty: 840, unitPriceCopper: 10, load: 1 }], 800);
assert.deepEqual(splitLines.map((batch) => batch.totalLoad), [800, 40], "21% of a 4,000-unit ship must become one full rideshare allotment and one remainder batch");
assert.equal(splitLines.reduce((sum, batch) => sum + batch.lines.reduce((lineSum, line) => lineSum + line.qty, 0), 0), 840, "batch splitting must conserve every ordered unit");
const palaceStoneBatches = splitMarketShipmentLines([{ id: "stone", qty: 50_000, unitPriceCopper: 1, load: 1 }], 800);
assert.equal(palaceStoneBatches.length, 63, "a palace-scale stone order must remain representable as many physical airship rideshare departures");
assert.equal(palaceStoneBatches.at(-1).totalLoad, 400);
const batchQuote = {
  ...logisticsQuote,
  offers: [{ ...logisticsQuote.offers[0], id: "batch-wood-offer", resourceId: "wood", name: "Wood", stock: 840, unitPriceCopper: 10, load: 1 }],
  logistics: { ...logisticsQuote.logistics, capacityLoad: 4000 }
};
const batchingHolding = { ...developedHolding, storage: { ...developedHolding.storage, moneyCopper: 1_000_000 } };
const standardBatchPlan = planMarketPurchase({ holding: batchingHolding, quote: batchQuote, quantities: { "batch-wood-offer": 840 }, serviceLevel: "standard" });
const expressBatchPlan = planMarketPurchase({ holding: batchingHolding, quote: batchQuote, quantities: { "batch-wood-offer": 840 }, serviceLevel: "express" });
const charterBatchPlan = planMarketPurchase({ holding: batchingHolding, quote: batchQuote, quantities: { "batch-wood-offer": 840 }, serviceLevel: "charter" });
assert.equal(standardBatchPlan.ok, true);
assert.equal(standardBatchPlan.bookingCapacityLoad, 800, "rideshare must book 20% of physical vessel capacity per departure");
assert.equal(standardBatchPlan.batchCount, 2);
assert.deepEqual(standardBatchPlan.shipmentBatches.map((batch) => batch.totalLoad), [800, 40]);
assert.equal(Number(standardBatchPlan.deliveryBreakdown.capacityShare.toFixed(4)), 0.22, "the 1% remainder must pay the documented 2% minimum fixed-cost share");
assert.equal(expressBatchPlan.bookingCapacityLoad, 400, "accelerated freight must use the smaller 10% fast-service allotment");
assert.equal(expressBatchPlan.batchCount, 3);
assert.deepEqual(expressBatchPlan.shipmentBatches.map((batch) => batch.totalLoad), [400, 400, 40]);
assert.equal(charterBatchPlan.bookingCapacityLoad, 4000, "charter must expose the entire physical vessel capacity");
assert.equal(charterBatchPlan.batchCount, 1);
assert.equal(charterBatchPlan.shipmentBatches[0].capacityShare, 1, "charter must pay the full fixed voyage regardless of partial loading");
assert.equal(charterBatchPlan.shipmentBatches[0].billableLoad, 4000, "charter must pay the operating mass of the whole reserved vessel even when actual cargo is smaller");
assert.equal(standardBatchPlan.shipmentBatches[1].billableLoad, 40, "rideshare audit data must preserve the actual remainder cargo even when the minimum slot share applies");
assert.ok(expressBatchPlan.firstDeliveryQd < charterBatchPlan.firstDeliveryQd && charterBatchPlan.firstDeliveryQd < standardBatchPlan.firstDeliveryQd, "service ETA ordering must be express, charter, then rideshare");
assert.ok(standardBatchPlan.deliveryQd > standardBatchPlan.firstDeliveryQd, "rideshare remainder must leave on a later independent departure");

const longAirshipRegions = normalizeEventRegionOptions([
  { value: "long-home", label: "Long Home", marketTransportModes: ["airship"], marketLinks: [{ regionId: "long-port", distanceKm: 1236, modes: ["airship"] }] },
  { value: "long-port", label: "Long Port", marketTransportModes: ["airship"], marketLinks: [] }
], { fallback: false });
const longAirshipHolding = holding({ region: "Long Home", moneyCopper: 10_000_000, urs: 3 });
const longAirshipMarket = normalizeMarketCatalog([{
  id: "long-airship-market",
  label: "Long Airship Market",
  regionId: "long-port",
  transportModes: ["airship"],
  deliveryMode: "scheduled",
  baseDeliveryQd: 2,
  airshipHireCopper: 120,
  airshipCapacityLoad: 4000,
  offers: [{ id: "long-bulk", resourceId: "wood", name: "Wood", basePriceCopper: 1, baseStock: 10_000, load: 1, volatility: 0 }]
}])[0];
const longAirshipLogistics = resolveMarketLogistics({ holding: longAirshipHolding, market: longAirshipMarket, regions: longAirshipRegions });
const longAirshipQuote = prepareMarketQuote({ holding: longAirshipHolding, market: longAirshipMarket, resources, logistics: longAirshipLogistics });
const longAirshipQuantities = { "long-bulk": 4000 };
const longRidesharePlan = planMarketPurchase({ holding: longAirshipHolding, quote: longAirshipQuote, quantities: longAirshipQuantities, serviceLevel: "standard" });
const longCharterPlan = planMarketPurchase({ holding: longAirshipHolding, quote: longAirshipQuote, quantities: longAirshipQuantities, serviceLevel: "charter" });
assert.equal(longAirshipLogistics.operatingTimeCopper, 927, "1,236 km must fund 46.35 QD of airship crew and upkeep at the calibrated rate");
assert.equal(longCharterPlan.deliveryBreakdown.fullOneWayOperatingCopper, 3694, "one-way full-vessel budget must reconcile setup, distance, time and mass");
assert.equal(longCharterPlan.deliveryBreakdown.operatingLegFactor, 2, "dedicated charter must pay delivery plus return/repositioning");
assert.equal(longCharterPlan.deliveryBreakdown.operationalFreightCopper, 7388, "1,236 km full charter must yield about 73.9 gold to the carrier before terminal services");
assert.ok(longCharterPlan.deliveryBreakdown.operationalFreightCopper >= 6300 && longCharterPlan.deliveryBreakdown.operationalFreightCopper <= 7500, "full charter carrier revenue must stay in the documented historical airship corridor");
assert.ok(Math.abs(longRidesharePlan.deliveryBreakdown.operationalFreightCopper * 2 - longCharterPlan.deliveryBreakdown.operationalFreightCopper) <= 2, "a fully sold rideshare direction should fund one leg while charter funds the complete round trip");
assert.ok(longCharterPlan.routeCopper > longRidesharePlan.routeCopper, "dedicated charter must no longer cost the same as a revenue-producing scheduled route");

const first = quoteA.offers[0];
const quantities = { [first.id]: 3 };
const connectedPlan = planMarketPurchase({ holding: connected, quote: quoteA, quantities, targetRoomId: "outdoors" });
const aerialPlan = planMarketPurchase({ holding: aerialHolding, quote: aerialQuote, quantities, targetRoomId: "outdoors" });
assert.equal(connectedPlan.lines[0].qty, 3);
assert.equal(connectedPlan.marketId, "external-market");
assert.ok(connectedPlan.deliveryCopper > 0, "delivery must never be free for a non-empty order");
assert.ok(aerialPlan.deliveryCopper > connectedPlan.deliveryCopper, "aerial route must cost more to deliver");
assert.equal(connectedPlan.totalCopper, connectedPlan.subtotalCopper + connectedPlan.deliveryCopper);
assert.equal(connectedPlan.ok, true);
const instantPlan = planMarketPurchase({
  holding: connected,
  quote: { ...quoteA, deliveryMode: "instant", deliveryQd: 0 },
  quantities,
  targetRoomId: "outdoors"
});
assert.equal(instantPlan.insuranceCopper, 0, "instant delivery must not charge insurance without an in-transit risk window");
assert.equal(instantPlan.insuranceCoverageRate, 0, "instant delivery must not advertise insurance coverage that can never pay out");
const connectedRisk = marketShipmentRiskProfile({ logistics: connectedPlan.logistics, deliveryQd: connectedPlan.deliveryQd, subtotalCopper: connectedPlan.subtotalCopper, insuranceCopper: connectedPlan.insuranceCopper });
assert.ok(connectedRisk.lossChance >= 0.001 && connectedRisk.lossChance <= 0.08, "historical shipment loss chance must remain low and bounded");
assert.ok(connectedRisk.delayChance > connectedRisk.lossChance && connectedRisk.delayChance <= 0.45, "delay must be more common than total cargo loss");
assert.equal(connectedRisk.insuranceCoverageRate, 0.84, "insured cargo must retain the documented 16% deductible");
assert.equal(connectedRisk.maximumInsurancePayoutCopper, Math.floor(connectedPlan.subtotalCopper * 0.84), "insurance must cover goods value, not transport or customs");

const poorPlan = planMarketPurchase({ holding: holding({ moneyCopper: 1 }), quote: quoteA, quantities });
assert.equal(poorPlan.ok, false);
assert.equal(poorPlan.insufficientFunds, true);

const cappedPlan = planMarketPurchase({ holding: connected, quote: quoteA, quantities: { [first.id]: first.stock + 999 } });
assert.equal(cappedPlan.lines[0].qty, first.stock, "purchase quantity must be capped by quoted stock");

const emptyPlan = planMarketPurchase({ holding: connected, quote: quoteA, quantities: {} });
assert.equal(emptyPlan.empty, true);
assert.equal(emptyPlan.deliveryCopper, 0);

const deliveryDependencies = {
  addMoney: (target, amount) => { target.storage.moneyCopper += amount; },
  storageAddWithOverflow: (target, row, qty) => {
    target.storage.resources.push({ ...row, qty });
    return [{ roomId: row.roomId, qty }];
  },
  snapshotItemForStorage: (item, qty, roomId) => ({ id: `stored-${item.id}`, name: item.name, img: item.img, type: item.type, qty, roomId, itemUuid: item.uuid, itemData: { name: item.name, type: item.type, img: item.img, system: { quantity: qty } } }),
  appendStorageLog: (target, rows) => { target.storage.log.push(...rows); },
  formatCurrency: formatCopperCurrency,
  internalDemandAvailableFromQd: (target) => Math.max(0, Number(target?.gm?.calendaria?.lastQd) || 0) + 40
};
const instantDeliveryDependencies = {
  ...deliveryDependencies,
  internalDemandAvailableFromQd: (target) => Math.max(0, Number(target?.gm?.calendaria?.lastQd) || 0)
};
const safeStandardBatchPlan = {
  ...standardBatchPlan,
  riskLossChance: 0,
  riskDelayChance: 0,
  shipmentBatches: standardBatchPlan.shipmentBatches.map((batch) => ({
    ...batch,
    riskProfile: { ...batch.riskProfile, lossChance: 0, delayChance: 0 }
  }))
};
const batchedShipmentHolding = { storage: { moneyCopper: safeStandardBatchPlan.totalCopper + 100, resources: [], items: [], log: [] }, special: { market: { orders: [] } } };
const batchedShipment = createMarketShipment({ holding: batchedShipmentHolding, plan: safeStandardBatchPlan, operationId: "shipment-batched", dependencies: deliveryDependencies });
assert.equal(batchedShipment.ok, true);
assert.equal(batchedShipment.batchCount, 2);
assert.equal(batchedShipmentHolding.storage.moneyCopper, 100, "a multi-departure purchase must still debit the treasury atomically once");
assert.deepEqual(batchedShipment.orders.map((order) => order.operationId), ["shipment-batched:batch:1", "shipment-batched:batch:2"]);
assert.deepEqual(batchedShipment.orders.map((order) => order.cargo[0].qty), [800, 40], "each shipment record must own only its physical cargo batch");
assert.deepEqual(batchedShipment.orders.map((order) => order.remainingQd), safeStandardBatchPlan.shipmentBatches.map((batch) => batch.deliveryQd), "each departure must retain its own ETA");
const replayBatchedShipment = createMarketShipment({ holding: batchedShipmentHolding, plan: safeStandardBatchPlan, operationId: "shipment-batched", dependencies: deliveryDependencies });
assert.equal(replayBatchedShipment.replay, true);
assert.equal(replayBatchedShipment.orders.length, 2, "replaying the parent transaction must recover every child shipment without another debit");
const firstBatchArrival = advanceMarketShipments({ holding: batchedShipmentHolding, elapsedQd: safeStandardBatchPlan.firstDeliveryQd, dependencies: deliveryDependencies });
assert.equal(firstBatchArrival.delivered.length, 1, "the first full rideshare allotment must arrive independently");
assert.equal(batchedShipmentHolding.storage.resources[0].batches[0].internalDemandAvailableFromQd, 40, "scheduled cargo arriving inside an Apply must be deferred to the next tenday boundary");
assert.equal(batchedShipmentHolding.special.market.orders[1].remainingQd, safeStandardBatchPlan.dispatchIntervalQd);
assert.equal(batchedShipmentHolding.storage.resources.reduce((sum, row) => sum + row.qty, 0), 800);
const finalBatchArrival = advanceMarketShipments({ holding: batchedShipmentHolding, elapsedQd: safeStandardBatchPlan.dispatchIntervalQd, dependencies: deliveryDependencies });
assert.equal(finalBatchArrival.delivered.length, 1);
assert.equal(batchedShipmentHolding.storage.resources.reduce((sum, row) => sum + row.qty, 0), 840, "staggered batch arrivals must conserve total cargo");

const independentlyCancelledHolding = { storage: { moneyCopper: safeStandardBatchPlan.totalCopper + 100, resources: [], items: [], log: [] }, special: { market: { orders: [] } } };
const independentlyCancelled = createMarketShipment({ holding: independentlyCancelledHolding, plan: safeStandardBatchPlan, operationId: "shipment-independent-cancel", dependencies: deliveryDependencies });
cancelMarketShipment({ holding: independentlyCancelledHolding, orderId: independentlyCancelled.orders[0].id, dependencies: deliveryDependencies });
advanceMarketShipments({ holding: independentlyCancelledHolding, elapsedQd: safeStandardBatchPlan.deliveryQd, dependencies: deliveryDependencies });
assert.equal(independentlyCancelledHolding.special.market.orders[0].status, "cancelled");
assert.equal(independentlyCancelledHolding.special.market.orders[1].status, "delivered", "cancelling one batch must not cancel a different departure from the same purchase");
assert.equal(independentlyCancelledHolding.storage.resources.reduce((sum, row) => sum + row.qty, 0), 40);
const retainedOrders = retainMarketShipmentOrders([
  ...Array.from({ length: 305 }, (_value, index) => ({ id: `archived-${index}`, status: "delivered" })),
  { id: "active-a", status: "in-transit" },
  { id: "active-b", status: "delayed" }
]);
assert.equal(retainedOrders.length, 302);
assert.deepEqual(retainedOrders.slice(-2).map((order) => order.id), ["active-a", "active-b"], "archive pruning must never discard active cargo batches");

const deliveryHolding = { storage: { moneyCopper: connectedPlan.totalCopper + 100, resources: [], items: [], log: [] } };
const resourceDelivery = applyMarketDelivery({ holding: deliveryHolding, plan: connectedPlan, operationId: "delivery-resource", dependencies: instantDeliveryDependencies });
assert.equal(resourceDelivery.ok, true);
assert.equal(deliveryHolding.storage.resources[0].resourceId, first.resourceId, "resource market lines must use storage overflow delivery");
assert.equal(deliveryHolding.storage.resources[0].batches[0].internalDemandAvailableFromQd, 0, "an instant receipt between periods must be eligible when internal demand first runs in the next Apply");
assert.equal(deliveryHolding.storage.moneyCopper, 100, "delivery engine must debit the confirmed total exactly once");

const guildMarket = effectiveWorldCatalog[1];
const guildQuote = prepareMarketQuote({ holding: connected, market: guildMarket, resources });
const guildPlan = planMarketPurchase({ holding: connected, quote: guildQuote, quantities: { "guild-item": 1 }, targetRoomId: "warehouse" });
const rejectedItemHolding = { storage: { moneyCopper: guildPlan.totalCopper + 100, resources: [], items: [], log: [] } };
const rejectedItemDelivery = applyMarketDelivery({ holding: rejectedItemHolding, plan: guildPlan, operationId: "missing-item", dependencies: instantDeliveryDependencies });
assert.equal(rejectedItemDelivery.ok, false, "missing Item document must reject delivery before mutations");
assert.equal(rejectedItemHolding.storage.moneyCopper, guildPlan.totalCopper + 100);
assert.equal(rejectedItemHolding.storage.items.length, 0);
const itemDocument = { id: "example", uuid: "Compendium.world.goods.Item.example", name: "Набор инструментов", img: "icons/svg/item-bag.svg", type: "gear" };
const itemDeliveryHolding = { storage: { moneyCopper: guildPlan.totalCopper + 100, resources: [], items: [], log: [] } };
const itemDelivery = applyMarketDelivery({ holding: itemDeliveryHolding, plan: guildPlan, itemDocuments: new Map([["guild-item", itemDocument]]), operationId: "delivery-item", dependencies: instantDeliveryDependencies });
assert.equal(itemDelivery.ok, true);
assert.equal(itemDeliveryHolding.storage.moneyCopper, 100);
assert.equal(itemDeliveryHolding.storage.items[0].itemUuid, itemDocument.uuid, "Item UUID offer must be snapshotted into stored items");
assert.equal(itemDeliveryHolding.storage.items[0].internalDemandAvailableFromQd, 0, "instant Item cargo must use the same between-period boundary as resources");
assert.equal(itemDeliveryHolding.storage.log[0].operationId, "delivery-item");

const shipmentHolding = { storage: { moneyCopper: connectedPlan.totalCopper + 100, resources: [], items: [], log: [] }, special: { market: { orders: [] } } };
const safeShipmentPlan = { ...connectedPlan, riskLossChance: 0, riskDelayChance: 0 };
const shipment = createMarketShipment({
  holding: shipmentHolding,
  plan: safeShipmentPlan,
  operationId: "shipment-resource",
  createdAt: "2026-07-13T00:00:00.000Z",
  dependencies: deliveryDependencies
});
assert.equal(shipment.ok, true);
assert.equal(shipment.order.status, "in-transit");
assert.equal(shipment.order.remainingQd, safeShipmentPlan.deliveryQd);
assert.equal(shipmentHolding.storage.moneyCopper, 100, "shipment acceptance must debit the confirmed total once");
assert.equal(shipmentHolding.storage.log[0].operationId, "shipment-resource:payment");
assert.equal(shipmentHolding.storage.log[0].qty, -safeShipmentPlan.totalCopper, "acceptance must log the exact money debit before cargo arrives");
assert.equal(shipmentHolding.storage.resources.length, 0, "in-transit resources must not enter settlement storage early");
assert.equal(shipment.order.cargo[0].sourceType, "resource");
const replayShipment = createMarketShipment({ holding: shipmentHolding, plan: safeShipmentPlan, operationId: "shipment-resource", dependencies: deliveryDependencies });
assert.equal(replayShipment.replay, true, "replayed shipment operation must return the existing order");
assert.equal(shipmentHolding.storage.moneyCopper, 100, "replayed shipment operation must not debit treasury again");
const shipmentHalfway = advanceMarketShipments({ holding: shipmentHolding, elapsedQd: safeShipmentPlan.deliveryQd - 1, dependencies: deliveryDependencies });
assert.equal(shipmentHalfway.delivered.length, 0);
assert.equal(shipmentHolding.special.market.orders[0].remainingQd, 1);
assert.equal(shipmentHolding.storage.resources.length, 0);
const shipmentArrival = advanceMarketShipments({ holding: shipmentHolding, elapsedQd: 1, deliveredAt: "2026-07-14T00:00:00.000Z", dependencies: deliveryDependencies });
assert.equal(shipmentArrival.delivered.length, 1);
assert.equal(shipmentHolding.special.market.orders[0].status, "delivered");
assert.equal(shipmentHolding.storage.resources[0].resourceId, first.resourceId);
assert.equal(shipmentHolding.storage.log[1].operationId, "shipment-resource:arrival", "arrival retains its separate cargo receipt after the purchase payment");
const storedResourceCount = shipmentHolding.storage.resources.length;
const storedLogCount = shipmentHolding.storage.log.length;
advanceMarketShipments({ holding: shipmentHolding, elapsedQd: 40, dependencies: deliveryDependencies });
assert.equal(shipmentHolding.storage.resources.length, storedResourceCount, "delivered shipment must be replay-safe");
assert.equal(shipmentHolding.storage.log.length, storedLogCount, "replay must not duplicate arrival logs");

const cancellationHolding = { storage: { moneyCopper: connectedPlan.totalCopper + 100, resources: [], items: [], log: [] }, special: { market: { orders: [] } } };
const cancellableShipment = createMarketShipment({ holding: cancellationHolding, plan: connectedPlan, operationId: "shipment-cancel", dependencies: deliveryDependencies });
const cancellationQuote = marketShipmentCancellationQuote(cancellableShipment.order);
assert.equal(cancellationQuote.cancellable, true, "a booked shipment must remain cancellable before its first economy tick");
assert.equal(cancellationQuote.refundCopper, connectedPlan.totalCopper, "pre-dispatch cancellation must refund the full confirmed payment");
assert.equal(cancellationQuote.withheldCopper, 0, "pre-dispatch cancellation must not retain a fee");
const cancelledShipment = cancelMarketShipment({ holding: cancellationHolding, orderId: "shipment-cancel", cancelledAt: "2026-07-14T00:30:00.000Z", dependencies: deliveryDependencies });
assert.equal(cancelledShipment.ok, true);
assert.equal(cancellationHolding.special.market.orders[0].status, "cancelled");
assert.equal(cancellationHolding.storage.moneyCopper, 100 + cancellationQuote.refundCopper);
assert.equal(cancellationHolding.storage.log.at(-1).operationId, "shipment-cancel:cancel");
const cancelledMoney = cancellationHolding.storage.moneyCopper;
const cancelledLogCount = cancellationHolding.storage.log.length;
const cancellationReplay = cancelMarketShipment({ holding: cancellationHolding, orderId: "shipment-cancel", dependencies: deliveryDependencies });
assert.equal(cancellationReplay.replay, true, "repeated cancellation must resolve as an idempotent replay");
assert.equal(cancellationHolding.storage.moneyCopper, cancelledMoney, "repeated cancellation must not credit treasury twice");
assert.equal(cancellationHolding.storage.log.length, cancelledLogCount, "repeated cancellation must not duplicate the refund log");
advanceMarketShipments({ holding: cancellationHolding, elapsedQd: 40, dependencies: deliveryDependencies });
assert.equal(cancellationHolding.storage.resources.length, 0, "cancelled cargo must never arrive");

const departedHolding = { storage: { moneyCopper: connectedPlan.totalCopper + 100, resources: [], items: [], log: [] }, special: { market: { orders: [] } } };
const safeDeparturePlan = { ...connectedPlan, riskLossChance: 0, riskDelayChance: 0 };
createMarketShipment({ holding: departedHolding, plan: safeDeparturePlan, operationId: "shipment-departed", dependencies: deliveryDependencies });
advanceMarketShipments({ holding: departedHolding, elapsedQd: 1, dependencies: deliveryDependencies });
assert.equal(marketShipmentCancellationQuote(departedHolding.special.market.orders[0]).cancellable, false, "a shipment cannot be cancelled after it is handed to the carrier");

const delayedHolding = { storage: { moneyCopper: connectedPlan.totalCopper + 100, resources: [], items: [], log: [] }, special: { market: { orders: [] } } };
const delayedPlan = { ...connectedPlan, riskLossChance: 0.01, riskDelayChance: 0.4, riskMaxDelayQd: 4 };
createMarketShipment({ holding: delayedHolding, plan: delayedPlan, operationId: "shipment-delayed", dependencies: deliveryDependencies });
const delayDependencies = {
  ...deliveryDependencies,
  riskUnit: (seed) => seed.endsWith("|loss") ? 0.99 : (seed.endsWith("|delay") ? 0 : 0.49)
};
const delayedTick = advanceMarketShipments({ holding: delayedHolding, elapsedQd: 1, deliveredAt: "2026-07-14T01:00:00.000Z", dependencies: delayDependencies });
assert.equal(delayedTick.needsResolution.length, 1, "deterministic route risk must pause only the affected shipment for GM resolution");
assert.equal(delayedHolding.special.market.orders[0].status, "needsResolution");
assert.equal(delayedHolding.special.market.orders[0].remainingQd, delayedPlan.deliveryQd, "the incident tick must not advance the blocked shipment");
const delayedResolution = resolveMarketShipmentRisk({ holding: delayedHolding, orderId: "shipment-delayed", outcome: "proposal", operationId: "shipment-delayed:gm-resolution", resolvedAt: "2026-07-14T01:30:00.000Z", dependencies: delayDependencies });
assert.equal(delayedResolution.outcome, "delayed");
assert.equal(delayedResolution.delayQd, 2);
assert.equal(delayedHolding.special.market.orders[0].remainingQd, delayedPlan.deliveryQd + 2, "confirmed delay must extend ETA only after GM resolution");
const resumedTick = advanceMarketShipments({ holding: delayedHolding, elapsedQd: 2, dependencies: delayDependencies });
assert.equal(resumedTick.needsResolution.length, 0, "resolved risk must never reroll on later economy ticks");
assert.equal(delayedHolding.special.market.orders[0].status, "in-transit", "shipment must resume automatically after delay QD elapses");
const delayedArrival = advanceMarketShipments({ holding: delayedHolding, elapsedQd: delayedPlan.deliveryQd, dependencies: delayDependencies });
assert.equal(delayedArrival.delivered.length, 1, "delayed shipment must still arrive without a manual unpause");

const lostHolding = { storage: { moneyCopper: connectedPlan.totalCopper + 100, resources: [], items: [], log: [] }, special: { market: { orders: [] } } };
const lostPlan = { ...connectedPlan, riskLossChance: 0.08, riskDelayChance: 0.4 };
createMarketShipment({ holding: lostHolding, plan: lostPlan, operationId: "shipment-lost", dependencies: deliveryDependencies });
const lossDependencies = { ...deliveryDependencies, riskUnit: (seed) => seed.endsWith("|loss") ? 0 : 0.99 };
const lostTick = advanceMarketShipments({ holding: lostHolding, elapsedQd: 1, deliveredAt: "2026-07-14T02:00:00.000Z", dependencies: lossDependencies });
assert.equal(lostTick.needsResolution.length, 1, "a proposed loss must wait for GM instead of mutating cargo automatically");
assert.equal(lostHolding.special.market.orders[0].status, "needsResolution");
assert.equal(lostHolding.storage.resources.length, 0, "lost cargo must never enter storage");
assert.equal(lostHolding.storage.moneyCopper, 100, "insurance must not pay while the incident is unresolved");
const lossResolution = resolveMarketShipmentRisk({ holding: lostHolding, orderId: "shipment-lost", outcome: "proposal", operationId: "shipment-lost:gm-resolution", resolvedAt: "2026-07-14T02:30:00.000Z", dependencies: lossDependencies });
assert.equal(lossResolution.payoutCopper, connectedPlan.maximumInsurancePayoutCopper, "insurance payout must respect the stored coverage cap");
assert.equal(lostHolding.special.market.orders[0].status, "lost");
assert.equal(lostHolding.storage.moneyCopper, 100 + connectedPlan.maximumInsurancePayoutCopper, "insurance must credit treasury once after loss");
assert.equal(lostHolding.storage.log.at(-1).operationId, "shipment-lost:insurance", "insurance payout must have its own correlated operation id");
const lostMoneyAfterResolution = lostHolding.storage.moneyCopper;
const lostLogAfterResolution = lostHolding.storage.log.length;
resolveMarketShipmentRisk({ holding: lostHolding, orderId: "shipment-lost", outcome: "proposal", operationId: "shipment-lost:gm-resolution", dependencies: lossDependencies });
assert.equal(lostHolding.storage.moneyCopper, lostMoneyAfterResolution, "replayed loss processing must not pay insurance twice");
assert.equal(lostHolding.storage.log.length, lostLogAfterResolution, "replayed loss processing must not duplicate the insurance log");

const missingShipmentHolding = { storage: { moneyCopper: guildPlan.totalCopper + 100, resources: [], items: [], log: [] }, special: { market: { orders: [] } } };
const missingShipment = createMarketShipment({ holding: missingShipmentHolding, plan: guildPlan, operationId: "shipment-missing-item", dependencies: deliveryDependencies });
assert.equal(missingShipment.ok, false);
assert.equal(missingShipmentHolding.storage.moneyCopper, guildPlan.totalCopper + 100, "missing Item snapshot must reject before debit");
assert.equal(missingShipmentHolding.special.market.orders.length, 0);
const itemShipmentHolding = { storage: { moneyCopper: guildPlan.totalCopper + 100, resources: [], items: [], log: [] }, special: { market: { orders: [] } } };
const itemShipment = createMarketShipment({ holding: itemShipmentHolding, plan: guildPlan, itemDocuments: new Map([["guild-item", itemDocument]]), operationId: "shipment-item", dependencies: deliveryDependencies });
assert.equal(itemShipment.ok, true);
assert.equal(itemShipmentHolding.storage.items.length, 0, "Item snapshot must remain in cargo while shipment is in transit");
assert.equal(itemShipment.order.cargo[0].item.itemUuid, itemDocument.uuid);
const itemArrival = deliverMarketShipmentNow({ holding: itemShipmentHolding, orderId: "shipment-item", dependencies: deliveryDependencies });
assert.equal(itemArrival.delivered.length, 1);
assert.equal(itemShipmentHolding.storage.items[0].itemUuid, itemDocument.uuid);
assert.notEqual(itemShipmentHolding.storage.items[0], itemShipment.order.cargo[0].item, "arrival must clone the stored Item snapshot instead of sharing mutable state");

assert.equal(formatCopperCurrency(123), "1 ЗМ 2 СМ 3 ММ", "market and treasury must share the same currency formatter");
const logRow = normalizeStorageLogRow({
  id: "market-log",
  kind: "market-purchase",
  roomId: "warehouse",
  laputaDateText: "10 день",
  operationId: "market-order-1"
});
assert.equal(logRow.roomId, "warehouse");
assert.equal(logRow.laputaDateText, "10 день");
assert.equal(logRow.operationId, "market-order-1", "market/storage correlation id must survive normalization");
const timeline = buildHoldingOperationTimeline({
  log: [{ operationId: "market-order-1", type: "market-purchase", title: "Покупка", createdAt: "2026-07-13T00:00:00.000Z" }],
  storage: { log: [{ ...logRow, ts: "2026-07-13T00:00:00.000Z", qty: 3, name: "Древесина" }] }
});
assert.equal(timeline.length, 1, "correlated market storage rows must collapse into the summarized operation timeline entry");
assert.equal(timeline[0].icon, "fa-solid fa-store");
const normalizedOrderHolding = mergeHoldingDefaults({
  id: "market-order-normalization",
  special: { market: { orders: [{
    id: "order-1",
    marketId: "guild-market",
    marketLabel: "Гильдейская ярмарка",
    lines: [{ offerId: "guild-item", sourceType: "item", itemUuid: "Compendium.world.goods.Item.example", name: "Набор", qty: 1, unitPriceCopper: 40 }]
  }] } }
});
assert.equal(normalizedOrderHolding.special.market.orders[0].marketId, "guild-market");
assert.equal(normalizedOrderHolding.special.market.orders[0].lines[0].sourceType, "item");
assert.equal(normalizedOrderHolding.special.market.orders[0].lines[0].itemUuid, "Compendium.world.goods.Item.example");
const normalizedShipmentHolding = mergeHoldingDefaults(itemShipmentHolding);
assert.equal(normalizedShipmentHolding.special.market.orders[0].deliveryMode, "scheduled");
assert.equal(normalizedShipmentHolding.special.market.orders[0].status, "delivered");
assert.equal(normalizedShipmentHolding.special.market.orders[0].cargo[0].item.itemUuid, itemDocument.uuid, "serialized Item cargo snapshot must survive normalization");
const normalizedLostHolding = mergeHoldingDefaults(lostHolding);
assert.equal(normalizedLostHolding.special.market.orders[0].riskOutcome, "lost");
assert.equal(normalizedLostHolding.special.market.orders[0].insurancePayoutCopper, connectedPlan.maximumInsurancePayoutCopper, "loss and payout audit fields must survive normalization");
assert.equal(normalizedLostHolding.special.market.orders[0].remainingQd, 0);
const normalizedCancelledHolding = mergeHoldingDefaults(cancellationHolding);
assert.equal(normalizedCancelledHolding.special.market.orders[0].dispatchStatus, "cancelled");
assert.equal(normalizedCancelledHolding.special.market.orders[0].cancellationRefundCopper, cancellationQuote.refundCopper, "cancellation audit values must survive normalization");
assert.equal(normalizedCancelledHolding.special.market.orders[0].remainingQd, 0);
const expressHolding = { storage: { moneyCopper: expressLogisticsPlan.totalCopper + 100, resources: [], items: [], log: [] }, special: { market: { orders: [] } } };
createMarketShipment({ holding: expressHolding, plan: expressLogisticsPlan, operationId: "shipment-express", dependencies: deliveryDependencies });
const normalizedExpressHolding = mergeHoldingDefaults(expressHolding);
assert.equal(normalizedExpressHolding.special.market.orders[0].serviceLevel, "express");
assert.equal(normalizedExpressHolding.special.market.orders[0].expressSurchargeCopper, expressLogisticsPlan.expressSurchargeCopper);
const charterHolding = { storage: { moneyCopper: charterBatchPlan.totalCopper + 100, resources: [], items: [], log: [] }, special: { market: { orders: [] } } };
createMarketShipment({ holding: charterHolding, plan: charterBatchPlan, operationId: "shipment-charter", dependencies: deliveryDependencies });
const normalizedCharterHolding = mergeHoldingDefaults(charterHolding);
assert.equal(normalizedCharterHolding.special.market.orders[0].serviceLevel, "charter");
assert.equal(normalizedCharterHolding.special.market.orders[0].bookingCapacityLoad, 4000);
assert.equal(normalizedCharterHolding.special.market.orders[0].chargedCapacityShare, 1);
assert.equal(normalizedCharterHolding.special.market.orders[0].billableLoad, 4000);
const normalizedBatchedHolding = mergeHoldingDefaults(batchedShipmentHolding);
assert.equal(normalizedBatchedHolding.special.market.orders[0].parentOperationId, "shipment-batched");
assert.equal(normalizedBatchedHolding.special.market.orders[1].batchIndex, 1);
assert.equal(normalizedBatchedHolding.special.market.orders[1].batchCount, 2, "batch linkage must survive world-data normalization");
const legacyRiskHolding = mergeHoldingDefaults({ id: "legacy-market-risk", special: { market: { orders: [{ id: "legacy-transit", status: "in-transit", deliveryMode: "scheduled", deliveryQd: 4, remainingQd: 3 }] } } });
assert.equal(legacyRiskHolding.special.market.orders[0].riskStatus, "waived", "pre-risk in-transit orders must not receive a retroactive loss roll");
assert.equal(legacyRiskHolding.special.market.orders[0].dispatchStatus, "departed", "legacy in-transit orders must not become retroactively cancellable");

const providerQuotesStarted = performance.now();
const largeProvider = {
  ...DEFAULT_EXTERNAL_MARKET,
  id: "large-provider",
  offers: Array.from({ length: 240 }, (_value, index) => ({
    id: `bulk-${index}`,
    resourceId: index % 2 ? "wood" : "stone",
    kind: "material",
    basePriceCopper: 5 + (index % 20),
    volatility: 0.2,
    baseStock: 100,
    load: 1
  }))
};
const largeQuote = prepareMarketQuote({ holding: connected, market: largeProvider, resources });
const providerQuoteMs = performance.now() - providerQuotesStarted;
assert.equal(largeQuote.offers.length, 240, "large provider quote must retain every configured offer");
assert.ok(providerQuoteMs < 250, `240-offer quote should remain interactive, got ${providerQuoteMs.toFixed(2)} ms`);

console.log(`FBL Skyhold market characterization: three delivery services, conserved multi-departure batching, seasonal edges, replay-safe cancellation/refund, deterministic GM-resolved delay/loss and insurance passed; 240 offers ${providerQuoteMs.toFixed(2)} ms.`);
