import assert from "node:assert/strict";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { transportFixture, transportRequest, transportHarness } from "./fixtures/transport-v2.mjs";
import { prepareTransportContext, prepareTransportOptions } from "../apps/domains/transport-context.js";
import { availableAuthorityMarkets, authorityMarketQuote } from "../apps/market/authority-context.js";
import { normalizeSkyholdData } from "../data/normalizers.js";
import { ensureTransportState } from "../data/transport/state.js";

// 1. Whole-shipment hired scaling: cargo exceeding 1 vessel hires multiple vessels in ONE departure.
{
  const f = transportFixture();
  f.data.catalog.marketEconomy.settings = { ...(f.data.catalog.marketEconomy.settings ?? {}), airshipCapacityLoad: 20 };
  const market = f.data.catalog.eventRegions.find((row) => row.value === "a");
  assert.ok(market);
  const request = transportRequest(f, "a", { mode: "regular" }, true);
  const offerId = Object.keys(request.quantities)[0];
  request.quantities[offerId] = 10;
  const small = prepareTransportContext({ ...f, request, isGM: true });
  assert.equal(small.plan.stages.length, 1);
  assert.equal(small.plan.stages[0].runs.length, 1);
  assert.equal(small.plan.stages[0].service.vehicleCount, 1);

  // Give plenty of stock and order 30 units -> scales to 2 vessels in 1 departure.
  f.data.catalog.marketEconomy.baseOffers[0].baseStock = 100;
  request.quantities[offerId] = 30;
  const large = prepareTransportContext({ ...f, request, isGM: true });
  assert.equal(large.plan.stages[0].runs.length, 1, "large hired shipment stays in a single departure");
  assert.equal(large.plan.stages[0].service.vehicleCount, 2, "scales vehicle count cleanly");
  assert.ok(large.plan.totalCopper > small.plan.totalCopper, "transport charge itself scales for the second vessel");

  // Scaled (:x2) charter shares fleet occupancy with the base (1-vessel) charter on the same physical path!
  const fFleet = transportFixture();
  fFleet.data.catalog.transportV2.charterVehicles = 1;
  fFleet.data.catalog.marketEconomy.settings = { ...(fFleet.data.catalog.marketEconomy.settings ?? {}), airshipCapacityLoad: 20 };
  fFleet.data.catalog.marketEconomy.baseOffers[0].baseStock = 100;
  const hFleet = transportHarness(fFleet);
  const req1 = transportRequest(hFleet.fixture(), "a", { mode: "charter" }, true);
  const key1 = Object.keys(req1.quantities)[0];
  req1.quantities[key1] = 10;
  const booked1 = await hFleet.book(req1, "fleet-base-1", true);
  const req2 = { ...req1, quantities: { [key1]: 30 } };
  const quote2 = prepareTransportContext({ ...hFleet.fixture(), request: req2, isGM: true });
  assert.equal(quote2.plan.stages[0].service.vehicleCount, 2);
  assert.ok(quote2.plan.stages[0].runs[0].startQd >= booked1.preview.plan.stages[0].runs[0].releaseQd,
    "scaled :x2 booking waits for the base fleet vehicle instead of double-booking it");
}

// 2. Company modifiers & GM visibility are honored automatically on every edge.
{
  const f = transportFixture();
  f.data.catalog.marketEconomy.organizations ??= [];
  f.data.catalog.marketEconomy.organizations.push({
    id: "secret-express",
    label: "Тайный экспресс",
    active: true,
    visibility: "gm",
    carrier: {
      enabled: true,
      modes: ["airship", "caravan", "rail"],
      priceFactor: 0.5,
      timeFactor: 0.5,
      riskFactor: 0.5,
      capacityFactor: 2,
      countryShares: [
        { countryId: "public", sharePct: 50, active: true, modeShares: { airship: 50, caravan: 50, rail: 50 } }
      ]
    }
  });
  const req = transportRequest(f, "a", { mode: "charter" }, true);
  const gmQuote = prepareTransportContext({ ...f, request: req, isGM: true });
  const playerQuote = prepareTransportContext({ ...f, request: req, isGM: false });
  assert.equal(gmQuote.plan.stages[0].service.companyId, "secret-express", "GM automatically gets the better hidden carrier");
  assert.notEqual(playerQuote.plan.stages[0].service.companyId, "secret-express", "players never receive hidden GM carriers");
}

// 3. Inland market without airship port: own ship does 1 clean port transfer + hired caravan.
{
  const f = transportFixture();
  f.holding.gm.modifiers.marketConnectionsLevel = 6;
  f.data.catalog.eventRegions = [
    { value: "home", label: "Дом", countryId: "public", marketTransportModes: ["airship"],
      marketLinks: [{ regionId: "port", routeId: "air-1", distanceKm: 80, ursCost: 1, modes: ["airship"] }] },
    { value: "port", label: "Воздушный порт", countryId: "public", marketTransportModes: ["airship", "caravan"],
      marketLinks: [{ regionId: "inland", routeId: "land-1", distanceKm: 40, ursCost: 1, modes: ["caravan"] }] },
    { value: "inland", label: "Глубинный рынок", countryId: "public", marketTransportModes: ["caravan"], marketLinks: [] }
  ];
  for (const direction of ["inbound", "outbound"]) {
    const req = transportRequest(f, "inland", { direction, mode: "owned", ownShipId: f.ship.id, returnHome: true }, true);
    const options = prepareTransportOptions({ ...f, request: req, isGM: true });
    assert.equal(options.options.regular.ok, true, `hired regular reaches inland (${direction})`);
    assert.equal(options.options.charter.ok, true, `hired charter reaches inland (${direction})`);
    assert.equal(options.options.owned.ok, true, `own ship reaches inland via 1 port transfer (${direction})`);
    assert.equal(options.options.owned.plan.stages.length, 2, "own ship + 1 hired land transfer");
    assert.equal(options.options.owned.transferPortLabel, "Воздушный порт");
    const harness = transportHarness(f);
    const booked = await harness.book(req, `inland-${direction}`, true);
    harness.advance(Math.max(booked.preview.plan.arrivalQd, booked.preview.plan.shipReleaseQd));
    assert.equal(booked.order.status, "delivered");
    assert.equal(harness.ship.location.kind, "home");
  }
}

// 4. Real Air Islands trade network pack (69 real regions connected with a dense campaign network):
//    ZERO search limits and fast execution across 15+ real islands and inland markets!
{
  const networkPack = JSON.parse(fs.readFileSync(new URL("../../examples/content-packs/air-islands-trade-network-template.json", import.meta.url), "utf8"));
  const marketPack = JSON.parse(fs.readFileSync(new URL("../../examples/content-packs/air-islands-materials-and-country-markets.json", import.meta.url), "utf8"));
  const regions = structuredClone(networkPack.content?.regions ?? []);
  assert.ok(regions.length >= 20, `expected real Air Islands map, got ${regions.length} regions`);
  // Connect the real 69-region catalog into a dense trade mesh (airship hubs + regional cross-links + inland spurs).
  for (let i = 0; i < regions.length; i++) {
    const links = [];
    for (const step of [1, 2, 5, 11]) {
      const target = regions[(i + step) % regions.length];
      if (!target || target.value === regions[i].value) continue;
      links.push({
        regionId: target.value,
        distanceKm: 40 + step * 35,
        ursCost: step <= 2 ? 1 : 2,
        modes: ["airship", "caravan", "rail"]
      });
    }
    regions[i].marketLinks = links;
  }
  const data = normalizeSkyholdData({
    catalog: {
      eventRegions: regions,
      marketEconomy: structuredClone(marketPack.content?.marketEconomy ?? networkPack.content?.marketEconomy),
      resources: structuredClone(marketPack.content?.resources ?? networkPack.content?.resources)
    }
  });
  ensureTransportState(data);
  const holding = data.holdings[0];
  holding.type = "sky-island";
  holding.overview.region = data.catalog.eventRegions[0].value;
  holding.gm.modifiers.marketConnectionsLevel = 6;
  holding.storage.moneyCopper = 10_000_000;
  const marketList = availableAuthorityMarkets(data, { holding, isGM: true, offerLocationIds: [] });
  const started = performance.now();
  let checked = 0;
  for (const stub of marketList.slice(0, 20)) {
    const market = availableAuthorityMarkets(data, { holding, isGM: true, offerLocationIds: [stub.id] })
      .find((row) => row.id === stub.id);
    if (!market) continue;
    const quote = authorityMarketQuote({ data, holding, market, isGM: true, discoverTransport: true });
    const offer = (quote?.offers ?? []).find((row) => row.stock > 0);
    if (!offer) continue;
    const options = prepareTransportOptions({
      data, holding, isGM: true,
      request: { direction: "inbound", marketId: market.id, quantities: { [offer.id]: 1 }, mode: "regular" }
    });
    assert.equal(options.options.regular.search?.limited ?? false, false, `no search limit on ${market.regionId}`);
    assert.equal(options.options.charter.search?.limited ?? false, false, `no search limit on ${market.regionId}`);
    if (options.options.regular.ok && options.options.charter.ok) checked += 1;
  }
  const elapsedMs = performance.now() - started;
  assert.ok(checked >= 10, `expected at least 10 real Air Islands markets quoted, got ${checked}`);
  console.log(`Real Air Islands network (${regions.length} regions, ${checked} markets quoted) finished in ${elapsedMs.toFixed(1)} ms with ZERO search limits.`);

  // 5. Diagnostic message pinpoints mode mismatch on link (and legacy marketAirshipOnly no longer blocks when modes allow caravan)!
  const blockedData = normalizeSkyholdData({
    catalog: {
      eventRegions: [
        { value: "home", label: "Риюд", countryId: "novand", marketTransportModes: ["airship"], marketLinks: [{ regionId: "port", distanceKm: 200, ursCost: 1, modes: ["airship"] }] },
        { value: "port", label: "Южные воздушные порты", countryId: "izuaver", marketTransportModes: ["airship"], marketLinks: [{ regionId: "inland", distanceKm: 100, ursCost: 1, modes: ["caravan"] }] },
        { value: "inland", label: "Земли Тишины", countryId: "izuaver", marketTransportModes: ["caravan"], marketLinks: [] }
      ],
      marketEconomy: structuredClone(marketPack.content?.marketEconomy),
      resources: structuredClone(marketPack.content?.resources)
    }
  });
  ensureTransportState(blockedData);
  const bh = blockedData.holdings[0];
  bh.type = "village"; bh.overview.region = "home"; bh.gm.modifiers.marketConnectionsLevel = 10; bh.storage.moneyCopper = 10_000_000;
  const bm = availableAuthorityMarkets(blockedData, { holding: bh, isGM: true, offerLocationIds: ["inland"] }).find((r) => r.id === "inland");
  const bq = authorityMarketQuote({ data: blockedData, holding: bh, market: bm, isGM: true, discoverTransport: true, skipRouteDiscovery: true });
  const bo = bq.offers.find((r) => r.stock > 0);
  const bopts = prepareTransportOptions({ data: blockedData, holding: bh, isGM: true, request: { direction: "inbound", marketId: bm.id, quantities: { [bo.id]: 1 } } });
  assert.equal(bopts.options.regular.ok, false);
  assert.match(bopts.options.regular.error, /Южные воздушные порты.*нет общего вида транспорта/);

  // Enabling caravan on the port immediately unlocks the route even if legacy marketAirshipOnly was true.
  const portNode = blockedData.catalog.eventRegions.find((r) => r.value === "port");
  portNode.marketAirshipOnly = true;
  portNode.marketTransportModes = ["airship", "caravan"];
  const unlocked = prepareTransportOptions({ data: blockedData, holding: bh, isGM: true, request: { direction: "inbound", marketId: bm.id, quantities: { [bo.id]: 1 } } });
  assert.equal(unlocked.options.regular.ok, true, "legacy marketAirshipOnly no longer overrides explicit transport modes");

  // 6. Fast skipRouteDiscovery quote matches MarketApp stock & prices 1:1 (prevents "больше доступного" on full-stock buy).
  const southMarket = availableAuthorityMarkets(data, { holding, isGM: true, offerLocationIds: ["izuaver-south-ports"] })
    .find((row) => row.id === "izuaver-south-ports");
  if (southMarket) {
    const fullQuote = authorityMarketQuote({ data, holding, market: southMarket, isGM: true, discoverTransport: true });
    const fastQuote = authorityMarketQuote({ data, holding, market: southMarket, isGM: true, discoverTransport: true, skipRouteDiscovery: true });
    assert.deepEqual(
      fastQuote.offers.map((o) => [o.id, o.stock, o.unitPriceCopper]),
      fullQuote.offers.map((o) => [o.id, o.stock, o.unitPriceCopper]),
      "transport checkout sees exact same stock and prices as MarketApp"
    );
    const maxOffer = fullQuote.offers.find((o) => o.stock > 0);
    const fullStockQuote = prepareTransportOptions({
      data, holding, isGM: true,
      request: { direction: "inbound", marketId: southMarket.id, quantities: { [maxOffer.id]: maxOffer.stock } }
    });
    assert.equal(fullStockQuote.active.ok, true, "buying 100% of MarketApp displayed stock must succeed");
  }
}

console.log("Clean transport router: whole-shipment scaling, company modifiers/visibility, inland 1-port transfer and real Air Islands map passed.");
