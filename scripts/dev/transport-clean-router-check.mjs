import assert from "node:assert/strict";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { transportFixture, transportRequest, transportHarness } from "./fixtures/transport-v2.mjs";
import { prepareTransportContext, prepareTransportOptions } from "../apps/domains/transport-context.js";
import { availableAuthorityMarkets, authorityMarketQuote } from "../apps/market/authority-context.js";
import { normalizeSkyholdData } from "../data/normalizers.js";
import { BASE_HOLDING } from "../data/schema/base-holding.js";
import { ensureTransportState } from "../data/transport/state.js";
import { transportServicesShareFleet } from "../engines/transport/service-identity.js";
import { diagnoseHiredRouteFailure } from "../engines/transport/router.js";
import { applyShipHomePlacement, shipHomeLocationContext } from "../apps/domains/ship-home-location.js";

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

  // Charter respects finite fleet size (charterVehicles): a 2-vessel load reserves BOTH real vessels,
  // so a subsequent order on the same 2-vessel line must wait instead of spawning a 3rd ghost vessel.
  const fFleet = transportFixture();
  fFleet.data.catalog.transportV2.charterVehicles = 2;
  fFleet.data.catalog.marketEconomy.settings = { ...(fFleet.data.catalog.marketEconomy.settings ?? {}), airshipCapacityLoad: 20 };
  fFleet.data.catalog.marketEconomy.baseOffers[0].baseStock = 100;
  const hFleet = transportHarness(fFleet);
  const req1 = transportRequest(hFleet.fixture(), "a", { mode: "charter" }, true);
  const key1 = Object.keys(req1.quantities)[0];
  req1.quantities[key1] = 30;
  const booked1 = await hFleet.book(req1, "fleet-two-vessels", true);
  assert.equal(booked1.preview.plan.stages[0].runs.length, 2, "30-unit charter uses both real vehicles in one order");
  assert.deepEqual(booked1.preview.plan.stages[0].runs.map((r) => r.vehicle).sort(), [0, 1]);
  assert.equal(booked1.preview.plan.stages[0].runs[0].startQd, booked1.preview.plan.stages[0].runs[1].startQd,
    "both free charter vehicles depart simultaneously");
  const req2 = { ...req1, quantities: { [key1]: 5 } };
  const quote2 = prepareTransportContext({ ...hFleet.fixture(), request: req2, isGM: true });
  const earliestFree = Math.min(...booked1.preview.plan.stages[0].runs.map((r) => r.releaseQd));
  assert.ok(quote2.plan.stages[0].runs[0].startQd >= earliestFree,
    "next charter on a full 2-vessel line waits for an actual returning vessel instead of overbooking");
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
    holdings: [structuredClone(BASE_HOLDING)],
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
    holdings: [structuredClone(BASE_HOLDING)],
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
  assert.ok(southMarket, "izuaver-south-ports must exist in bundled Air Islands pack");
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

  // 7. Fleet sharing across different scaled sizes (:x2 vs :x3) and canManageShips gate.
  assert.equal(transportServicesShareFleet("charter:abc:route:def:x2", "charter:abc:route:def:x3"), true);
  assert.equal(transportServicesShareFleet("charter:abc:route:def:x2", "charter:abc:route:def"), true);
  assert.equal(transportServicesShareFleet("charter:abc:route:def:x2", "charter:abc:route:xyz:x3"), false);
  assert.equal(transportServicesShareFleet("charter:abc:route:def:x2", "charter:abc"), true);
  const fShip = transportFixture();
  const shipReq = transportRequest(fShip, "a", { mode: "owned", ownShipId: fShip.holding.special.ships.list[0].id }, false);
  const noShipPerm = prepareTransportOptions({ ...fShip, request: shipReq, isGM: false, canManageShips: false });
  assert.equal(noShipPerm.options.owned, null, "players without ship permission do not evaluate own-ship options");
  assert.notEqual(noShipPerm.activeMode, "owned", "players without ship permission never land on hidden owned mode");

  // 8. Disabled intermediate node blocks carrier/country switch, reports true min URS, hides GM nodes in diagnostics,
  //    rejects truncated GM-overridden chains, and preserves longer-km/lower-URS land routes to transfer ports.
  {
    const fMin = transportFixture();
    fMin.data.catalog.eventRegions = [
      { value: "home", label: "Дом", countryId: "public", marketTransportModes: ["caravan", "airship"],
        marketLinks: [{ regionId: "mid-cheap", distanceKm: 10, ursCost: 4, modes: ["airship"] }, { regionId: "mid-urs", distanceKm: 300, ursCost: 2, modes: ["airship"] }] },
      { value: "mid-cheap", label: "Дешёвый хаб", countryId: "public", marketTransportModes: ["airship"],
        marketLinks: [{ regionId: "a", distanceKm: 10, ursCost: 1, modes: ["airship"] }] },
      { value: "mid-urs", label: "Дешёвый по УРС", countryId: "public", marketTransportModes: ["airship"],
        marketLinks: [{ regionId: "a", distanceKm: 300, ursCost: 1, modes: ["airship"] }] },
      { value: "a", label: "Рынок А", countryId: "public", marketTransportModes: ["airship"], marketLinks: [] }
    ];
    const minDiag = diagnoseHiredRouteFailure({
      holding: fMin.holding, market: { regionId: "a" }, regions: fMin.data.catalog.eventRegions,
      organizations: fMin.data.catalog.marketEconomy.organizations,
      countries: fMin.data.catalog.marketEconomy.countries,
      direction: "inbound", accessLimit: 2, isGM: true
    });
    assert.match(minDiag, /требуется УРС 3\b/, "diagnostic reports minimum URS (3), not cheapest route URS (5)");

    // Player diagnostic must not leak GM-hidden intermediate node names.
    const fHidden = transportFixture();
    fHidden.data.catalog.marketEconomy.countries.push({ id: "secret-land", name: "Тайная страна", visibility: "gm", factors: {} });
    fHidden.data.catalog.eventRegions = [
      { value: "home", label: "Дом", countryId: "public", marketTransportModes: ["airship"],
        marketLinks: [{ regionId: "secret-node", distanceKm: 40, ursCost: 1, modes: ["caravan"] }] },
      { value: "secret-node", label: "Тайный Форт", countryId: "secret-land", marketTransportModes: ["caravan"],
        marketLinks: [{ regionId: "a", distanceKm: 40, ursCost: 1, modes: ["caravan"] }] },
      { value: "a", label: "Рынок А", countryId: "public", marketTransportModes: ["caravan"], marketLinks: [] }
    ];
    fHidden.holding.gm.modifiers.marketConnectionsLevel = 10;
    const reqHidden = transportRequest(fHidden, "a", { direction: "inbound" }, true);
    const playerDiag = prepareTransportOptions({ ...fHidden, request: reqHidden, isGM: false });
    assert.equal(playerDiag.options.regular.ok, false);
    assert.doesNotMatch(playerDiag.options.regular.error, /Тайный Форт|secret-node/);

    // Disabled intermediate node cannot switch independent-carriers across countries, but allows same-service transit.
    const fDis = transportFixture();
    fDis.data.catalog.marketEconomy.countries.push(
      { id: "c1", name: "Страна 1", visibility: "public", factors: {} },
      { id: "c2", name: "Страна 2", visibility: "public", factors: {} }
    );
    fDis.data.catalog.eventRegions = [
      { value: "home", label: "Дом", countryId: "c1", marketTransportModes: ["caravan"],
        marketLinks: [{ regionId: "closed", distanceKm: 40, ursCost: 1, modes: ["caravan"] }] },
      { value: "closed", label: "Закрытый пост", countryId: "c2", marketEnabled: false, marketTransportModes: ["caravan"],
        marketLinks: [{ regionId: "a", distanceKm: 40, ursCost: 1, modes: ["caravan"] }] },
      { value: "a", label: "Рынок А", countryId: "c1", marketTransportModes: ["caravan"], marketLinks: [] }
    ];
    fDis.data.catalog.marketEconomy.organizations = [];
    fDis.holding.gm.modifiers.marketConnectionsLevel = 10;
    const reqDis = transportRequest(fDis, "a", { direction: "inbound" }, true);
    const disOpts = prepareTransportOptions({ ...fDis, request: reqDis, isGM: true });
    assert.equal(disOpts.options.regular.ok, false, "disabled intermediate node must not allow carrier/country switch");
    fDis.data.catalog.eventRegions[1].countryId = "c1";
    const transitOpts = prepareTransportOptions({ ...fDis, request: reqDis, isGM: true });
    assert.equal(transitOpts.options.regular.ok, true, "same-service transit through disabled intermediate node stays allowed");

    // Truncated chain when an override hides one stage from players must fail cleanly.
    const fTrunc = transportFixture();
    fTrunc.data.catalog.marketEconomy.countries.push({ id: "c2", name: "Страна 2", visibility: "public", factors: {} });
    fTrunc.data.catalog.eventRegions = [
      { value: "home", label: "Дом", countryId: "public", marketTransportModes: ["airship"],
        marketLinks: [{ regionId: "hub", distanceKm: 40, ursCost: 1, modes: ["airship"] }] },
      { value: "hub", label: "Порт", countryId: "c2", marketTransportModes: ["airship", "caravan"],
        marketLinks: [{ regionId: "a", distanceKm: 40, ursCost: 1, modes: ["caravan"] }] },
      { value: "a", label: "Рынок А", countryId: "c2", marketTransportModes: ["caravan"], marketLinks: [] }
    ];
    fTrunc.holding.gm.modifiers.marketConnectionsLevel = 10;
    const reqTrunc = transportRequest(fTrunc, "a", { direction: "inbound" }, false);
    const fullPublic = prepareTransportOptions({ ...fTrunc, request: reqTrunc, isGM: false });
    assert.equal(fullPublic.options.regular.ok, true);
    assert.equal(fullPublic.options.regular.plan.stages.length, 2);
    const firstStageId = fullPublic.options.regular.plan.stages[0].service.id;
    fTrunc.data.catalog.transportV2.overrides = { [firstStageId]: { visibility: "gm" } };
    const truncated = prepareTransportOptions({ ...fTrunc, request: reqTrunc, isGM: false });
    assert.equal(truncated.options.regular.ok, false, "player must never receive a truncated chain when a stage is GM-only");

    // Longer-km but lower-URS land path to an airship transfer port must NOT be pruned by a shorter/higher-URS detour.
    const fLand = transportFixture();
    fLand.holding.gm.modifiers.marketConnectionsLevel = 4;
    fLand.data.catalog.eventRegions = [
      { value: "home", label: "Дом", countryId: "public", marketTransportModes: ["airship"],
        marketLinks: [{ regionId: "port", distanceKm: 80, ursCost: 1, modes: ["airship"] }] },
      { value: "port", label: "Порт", countryId: "public", marketTransportModes: ["airship", "caravan"],
        marketLinks: [{ regionId: "k", distanceKm: 20, ursCost: 1, modes: ["caravan"] }] },
      { value: "k", label: "Узел К", countryId: "public", marketTransportModes: ["caravan"],
        marketLinks: [{ regionId: "a", distanceKm: 200, ursCost: 1, modes: ["caravan"] }, { regionId: "x", distanceKm: 10, ursCost: 2, modes: ["caravan"] }] },
      { value: "x", label: "Короткий путь", countryId: "public", marketTransportModes: ["caravan"],
        marketLinks: [{ regionId: "a", distanceKm: 10, ursCost: 1, modes: ["caravan"] }] },
      { value: "a", label: "Рынок А", countryId: "public", marketTransportModes: ["caravan"], marketLinks: [] }
    ];
    const reqLand = transportRequest(fLand, "a", { direction: "inbound", mode: "owned", ownShipId: fLand.holding.special.ships.list[0].id }, true);
    const landOwned = prepareTransportOptions({ ...fLand, request: reqLand, isGM: true });
    assert.equal(landOwned.options.owned.ok, true, "longer-km / lower-URS land path to airship transfer port must be found");
    assert.equal(landOwned.options.owned.transferPortId, "port");

    // 9. Multi-candidate schedule/override detours, unified enabled/visibility rules (incl. mixed own-ship),
    //    and dedicated ship-home placement (marketEnabled: false) keeping hired options available.
    const fDetour = transportFixture();
    fDetour.data.catalog.transportV2.charterVehicles = 1;
    fDetour.data.catalog.eventRegions = [
      { value: "home", label: "Дом", countryId: "public", marketTransportModes: ["airship"],
        marketLinks: [
          { regionId: "a", distanceKm: 40, ursCost: 1, modes: ["airship"], routeId: "direct" },
          { regionId: "mid", distanceKm: 30, ursCost: 1, modes: ["airship"], routeId: "via-mid-1" }
        ] },
      { value: "mid", label: "Обход", countryId: "public", marketTransportModes: ["airship"],
        marketLinks: [{ regionId: "a", distanceKm: 30, ursCost: 1, modes: ["airship"], routeId: "via-mid-2" }] },
      { value: "a", label: "Рынок А", countryId: "public", marketTransportModes: ["airship"], marketLinks: [] }
    ];
    fDetour.holding.gm.modifiers.marketConnectionsLevel = 10;
    const hDetour = transportHarness(fDetour);
    const reqDetour = transportRequest(hDetour.fixture(), "a", { mode: "charter" }, false);
    const firstBook = await hDetour.book(reqDetour, "detour-occupy-direct", false);
    assert.equal(firstBook.preview.plan.stages[0].service.distanceKm, 40, "first charter takes shortest direct route");
    const secondQuote = prepareTransportContext({ ...hDetour.fixture(), request: reqDetour, isGM: false });
    assert.equal(secondQuote.plan.stages[0].service.distanceKm, 60, "second charter takes free faster detour around busy direct vehicle");
    assert.ok(secondQuote.plan.arrivalQd < firstBook.preview.plan.stages[0].runs[0].releaseQd + firstBook.preview.plan.stages[0].service.travelQd,
      "free detour beats waiting for the busy direct charter");

    // Disabled or GM-hidden override on shortest route: quote never offers disabled service & finds open detour instead!
    const fOverride = transportFixture();
    fOverride.data.catalog.eventRegions = structuredClone(fDetour.data.catalog.eventRegions);
    fOverride.holding.gm.modifiers.marketConnectionsLevel = 10;
    const reqOv = transportRequest(fOverride, "a", { mode: "regular" }, false);
    const baseOv = prepareTransportContext({ ...fOverride, request: reqOv, isGM: false });
    const directId = baseOv.plan.stages[0].service.id;
    fOverride.data.catalog.transportV2.overrides = { [directId]: { enabled: false } };
    const detourEnabled = prepareTransportContext({ ...fOverride, request: reqOv, isGM: false });
    assert.equal(detourEnabled.plan.stages[0].service.distanceKm, 60, "disabled direct service routes cleanly via open detour");
    fOverride.data.catalog.transportV2.overrides = { [directId]: { visibility: "gm" } };
    const detourVisible = prepareTransportContext({ ...fOverride, request: reqOv, isGM: false });
    assert.equal(detourVisible.plan.stages[0].service.distanceKm, 60, "GM-hidden direct service routes player via open public detour");

    // When the ONLY service on the only route is disabled, quote itself rejects it (never fails only on confirm).
    const fOnly = transportFixture();
    const reqOnly = transportRequest(fOnly, "a", { mode: "regular" }, true);
    const onlyId = prepareTransportContext({ ...fOnly, request: reqOnly, isGM: true }).plan.stages[0].service.id;
    fOnly.data.catalog.transportV2.overrides = { [onlyId]: { enabled: false } };
    const onlyOpts = prepareTransportOptions({ ...fOnly, request: reqOnly, isGM: true });
    assert.equal(onlyOpts.options.regular.ok, false, "disabled sole service is rejected already at quote time");

    // Mixed own-ship + land feeder must NOT allow a player to quote/book a GM-hidden land feeder.
    const fMix = transportFixture();
    fMix.holding.gm.modifiers.marketConnectionsLevel = 10;
    fMix.data.catalog.eventRegions = [
      { value: "home", label: "Дом", countryId: "public", marketTransportModes: ["airship"],
        marketLinks: [{ regionId: "port", distanceKm: 80, ursCost: 1, modes: ["airship"] }] },
      { value: "port", label: "Порт", countryId: "public", marketTransportModes: ["airship", "caravan"],
        marketLinks: [{ regionId: "a", distanceKm: 40, ursCost: 1, modes: ["caravan"] }] },
      { value: "a", label: "Рынок А", countryId: "public", marketTransportModes: ["caravan"], marketLinks: [] }
    ];
    const reqMix = transportRequest(fMix, "a", { direction: "inbound", mode: "owned", ownShipId: fMix.holding.special.ships.list[0].id }, false);
    const gmMix = prepareTransportContext({ ...fMix, request: reqMix, isGM: true });
    const landFeederId = gmMix.plan.stages[0].service.id;
    fMix.data.catalog.transportV2.overrides = { [landFeederId]: { visibility: "gm" } };
    const playerMix = prepareTransportOptions({ ...fMix, request: reqMix, isGM: false });
    assert.equal(playerMix.options.owned.ok, false, "player cannot quote or book a mixed own-ship route through a GM-only land feeder");

    // Dedicated ship-home location (marketEnabled: false) keeps hired regular & charter AND own ship available!
    const fHome = transportFixture();
    fHome.holding.type = "ship";
    for (const [i, region] of fHome.data.catalog.eventRegions.entries()) {
      region.marketMapX = 100 + i * 100; region.marketMapY = 100;
    }
    const homeRoute = shipHomeLocationContext(fHome.data, fHome.holding).routes[0];
    assert.ok(homeRoute);
    applyShipHomePlacement(fHome.data, fHome.holding, homeRoute.key, 50);
    const reqHome = transportRequest(fHome, "a", { direction: "inbound" }, true);
    const homeOpts = prepareTransportOptions({ ...fHome, request: reqHome, isGM: true });
    assert.equal(homeOpts.options.regular.ok, true, "regular hired delivery works for dedicated ship-home (marketEnabled: false)");
    assert.equal(homeOpts.options.charter.ok, true, "charter hired delivery works for dedicated ship-home (marketEnabled: false)");
    assert.equal(homeOpts.options.owned.ok, true, "own ship works for dedicated ship-home");
  }
}

console.log("Clean transport router: whole-shipment scaling, company modifiers/visibility, inland 1-port transfer and real Air Islands map passed.");
