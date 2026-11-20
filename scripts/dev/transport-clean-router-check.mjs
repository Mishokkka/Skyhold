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
  assert.ok(large.totalCopper > small.totalCopper, "larger multi-vessel shipment costs more");
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
  assert.ok(elapsedMs < 8000, `real Air Islands quotes must stay fast, took ${elapsedMs.toFixed(1)} ms`);
  console.log(`Real Air Islands network (${regions.length} regions, ${checked} markets quoted) finished in ${elapsedMs.toFixed(1)} ms with ZERO search limits.`);
}

console.log("Clean transport router: whole-shipment scaling, company modifiers/visibility, inland 1-port transfer and real Air Islands map passed.");
