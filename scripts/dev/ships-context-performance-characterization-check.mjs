import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { prepareShipsContext, prepareShipWindowContext } from "../apps/ships-context.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { createShipRecord } from "../data/ships.js";
import { buildShipWorldContext, generateWorldShipOffers, quoteWorldShipReturn, repriceWorldShipOffer } from "../engines/ships/world-market.js";
import { initializeWorldShip } from "../engines/ships/world-voyage.js";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";

function comparablePort(port) {
  const { offers: _offers, outboundOffers: _outboundOffers, ...rest } = port;
  return rest;
}

function displayedCosts(costs) {
  return Object.fromEntries(["foodCopper", "crewCopper", "upkeepCopper", "handlingCopper", "taxCopper", "totalCopper"].map((key) => [key, costs[key]]));
}

function timed(run) {
  const started = performance.now();
  const value = run();
  return { value, milliseconds: performance.now() - started };
}

function bundledFixture() {
  const packPath = path.resolve("examples/content-packs/air-islands-trade-network-template.json");
  const content = JSON.parse(fs.readFileSync(packPath, "utf8")).content;
  const homeRegion = content.regions.find((row) => row.marketEnabled !== false && row.marketTransportModes?.includes("airship"));
  const holding = mergeHoldingDefaults({
    id: "ships-performance",
    name: "Порт",
    overview: { region: homeRegion.value },
    gm: { calendaria: { lastQd: 0 } },
    special: { ships: { list: [] } }
  });
  const data = { holdings: [holding], catalog: { resources: content.resources, eventRegions: content.regions, marketEconomy: content.marketEconomy } };
  return { data, holding };
}

export function checkShipsContextPerformanceCharacterization() {
  const fixture = worldMarketFixture();
  const { data, holding, ship } = fixture;
  const before = JSON.stringify(data);
  const generated = generateWorldShipOffers(data, holding, ship, { period: 0, random: () => 0.4 });
  const offer = generated.find((row) => row.to?.id === "a") ?? generated[0];
  const full = buildShipWorldContext(data, holding);
  const limited = buildShipWorldContext(data, holding, { offerLocationIds: new Set([ship.location.id, offer.to.id]) });

  assert.deepEqual(limited.ports.map((row) => row.id), full.ports.map((row) => row.id), "limited composition must retain the complete public airship-port graph");
  assert.deepEqual(limited.issues, full.issues);
  for (const fullPort of full.ports) {
    const limitedPort = limited.ports.find((row) => row.id === fullPort.id);
    assert.deepEqual(comparablePort(limitedPort), comparablePort(fullPort), `lightweight port metadata changed for ${fullPort.id}`);
    if ([full.home.regionId, ship.location.id, offer.to.id].includes(fullPort.id)) {
      assert.deepEqual(limitedPort.offers, fullPort.offers, `required inventory changed for ${fullPort.id}`);
      assert.deepEqual(limitedPort.outboundOffers, fullPort.outboundOffers, `required demand changed for ${fullPort.id}`);
    } else {
      assert.deepEqual([limitedPort.offers, limitedPort.outboundOffers], [[], []], `unused port ${fullPort.id} should remain lightweight`);
    }
  }
  assert.deepEqual(repriceWorldShipOffer(data, holding, ship, offer, { context: limited }), repriceWorldShipOffer(data, holding, ship, offer, { context: full }), "limited view context must preserve a saved offer quote exactly");
  assert.equal(JSON.stringify(data), before, "full and limited ship views must not mutate their source data");

  ship.location = { kind: "market", id: offer.to.id, regionId: offer.to.regionId, label: offer.to.label };
  ship.status = "away";
  const returnLimited = buildShipWorldContext(data, holding, { offerLocationIds: new Set([offer.to.id]) });
  assert.deepEqual(
    quoteWorldShipReturn(data, holding, ship, { context: returnLimited }),
    quoteWorldShipReturn(data, holding, ship, { context: full }),
    "limited view context must preserve a return quote exactly"
  );

  const legacyHolding = mergeHoldingDefaults({ id: "legacy", name: "Старый порт", special: { ships: { list: [createShipRecord("legacy-ship")] } } });
  const unreadableData = {};
  let catalogReadCount = 0;
  Object.defineProperty(unreadableData, "catalog", { get() { catalogReadCount += 1; throw new Error("legacy view read the world market"); } });
  assert.doesNotThrow(() => prepareShipsContext(legacyHolding, { data: unreadableData }), "a legacy-only ship tab must skip world-market composition");
  const emptyHolding = mergeHoldingDefaults({ id: "empty", name: "Пустой порт" });
  assert.doesNotThrow(() => prepareShipsContext(emptyHolding, { data: unreadableData }), "an empty ship tab must skip world-market composition");
  assert.equal(catalogReadCount, 0, "legacy-only and empty ship views must not read the world catalog");

  const viewFixture = worldMarketFixture();
  const viewOffers = generateWorldShipOffers(viewFixture.data, viewFixture.holding, viewFixture.ship, { period: 0, random: () => 0.4 });
  viewFixture.holding.special.ships.offers = structuredClone(viewOffers);
  const preparedOffers = prepareShipWindowContext(viewFixture.holding, { data: viewFixture.data, shipId: viewFixture.ship.id }).rows[0].offers;
  const fullViewContext = buildShipWorldContext(viewFixture.data, viewFixture.holding);
  for (const savedOffer of viewOffers) {
    const expected = repriceWorldShipOffer(viewFixture.data, viewFixture.holding, viewFixture.ship, savedOffer, { context: fullViewContext });
    const actual = preparedOffers.find((row) => row.id === savedOffer.id);
    assert.deepEqual(actual.costs, displayedCosts(expected.quote.costs), `prepared costs changed for ${savedOffer.id}`);
    assert.equal(actual.recommendedBudgetCopper, expected.quote.recommendedBudgetCopper, `prepared budget changed for ${savedOffer.id}`);
    assert.equal(actual.costs.totalCopper + actual.returnReserveCopper + actual.idleReserveCopper + actual.outcomeReserveCopper,
      actual.recommendedBudgetCopper, `budget breakdown must add up for ${savedOffer.id}`);
    assert.equal(actual.pickupLabel, savedOffer.contract.pickup?.label || savedOffer.from.label,
      `loading port must be distinct from the ship departure for ${savedOffer.id}`);
  }
  const returnDestination = viewOffers[0].to;
  viewFixture.holding.special.ships.offers = [];
  viewFixture.ship.location = { ...returnDestination };
  viewFixture.ship.status = "away";
  const expectedReturn = quoteWorldShipReturn(viewFixture.data, viewFixture.holding, viewFixture.ship, { context: buildShipWorldContext(viewFixture.data, viewFixture.holding) });
  const preparedReturn = prepareShipWindowContext(viewFixture.holding, { data: viewFixture.data, shipId: viewFixture.ship.id }).rows[0].returnOffer;
  assert.deepEqual(preparedReturn.costs, displayedCosts(expectedReturn.quote.costs), "prepared return costs must match full world composition");
  assert.equal(preparedReturn.recommendedBudgetCopper, expectedReturn.quote.recommendedBudgetCopper, "prepared return budget must match full world composition");

  const fresh = worldMarketFixture();
  const firstContext = buildShipWorldContext(fresh.data, fresh.holding, { offerLocationIds: new Set(["home"]) });
  const firstPrice = firstContext.ports.find((row) => row.id === "home").offers.find((row) => row.resourceId === "test-freight").basePriceCopper;
  fresh.data.catalog.marketEconomy.baseOffers[0].priceOverrideCopper = firstPrice + 17;
  const secondContext = buildShipWorldContext(fresh.data, fresh.holding, { offerLocationIds: new Set(["home"]) });
  const secondPrice = secondContext.ports.find((row) => row.id === "home").offers.find((row) => row.resourceId === "test-freight").basePriceCopper;
  assert.equal(secondPrice, firstPrice + 17, "a later render must see market edits instead of a stale cached inventory");

  const bundled = bundledFixture();
  const legacy = createShipRecord("legacy-a");
  const legacyB = createShipRecord("legacy-b");
  bundled.holding.special.ships.list.push(legacy, legacyB);
  const legacyRender = timed(() => prepareShipsContext(bundled.holding, { data: bundled.data }));
  bundled.holding.special.ships.list.length = 0;
  const worldShip = createShipRecord("world-performance");
  initializeWorldShip(bundled.holding, worldShip, { profileId: "merchant-barque", clockQd: 0 });
  bundled.holding.special.ships.list.push(worldShip);
  const limitedRender = timed(() => prepareShipsContext(bundled.holding, { data: bundled.data }));
  const fullComposition = timed(() => buildShipWorldContext(bundled.data, bundled.holding));
  assert.equal(legacyRender.value.rows.length, 2);
  assert.equal(limitedRender.value.rows.length, 1);
  assert.ok(fullComposition.value.ports.length > 0);
  return {
    legacyRenderMs: Number(legacyRender.milliseconds.toFixed(1)),
    limitedWorldRenderMs: Number(limitedRender.milliseconds.toFixed(1)),
    fullWorldCompositionMs: Number(fullComposition.milliseconds.toFixed(1)),
    ports: fullComposition.value.ports.length,
    resources: bundled.data.catalog.resources.length
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = checkShipsContextPerformanceCharacterization();
  console.log(`FBL Skyhold ship-context performance characterization passed: ${JSON.stringify(result)}`);
}
