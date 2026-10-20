import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { createShipRecord } from "../data/ships.js";
import { buildShipWorldContext, configureWorldShipEconomy, generateWorldShipOffers } from "../engines/ships/world-market.js";
import { initializeWorldShip } from "../engines/ships/world-voyage.js";

function bundledFixture() {
  const packPath = path.resolve("examples/content-packs/air-islands-trade-network-template.json");
  const content = JSON.parse(fs.readFileSync(packPath, "utf8")).content;
  const homeRegion = content.regions.find((row) => row.marketEnabled !== false && row.marketTransportModes?.includes("airship"));
  // The bundled template has no configured inter-port routes. Connect this in-memory
  // fixture so the benchmark exercises four actual destinations, not just the home market.
  homeRegion.marketLinks = content.regions.filter((row) => row.value !== homeRegion.value
    && row.marketEnabled !== false && row.marketTransportModes?.includes("airship"))
    .map((row, index) => ({ regionId: row.value, distanceKm: 150 + index * 25, modes: ["airship"] }));
  const holding = mergeHoldingDefaults({
    id: "ship-offer-performance",
    name: "Порт",
    overview: { region: homeRegion.value },
    gm: { calendaria: { lastQd: 0 } },
    special: { ships: { list: [] } }
  });
  const ship = createShipRecord("world-performance");
  initializeWorldShip(holding, ship, { profileId: "merchant-barque", clockQd: 0 });
  holding.special.ships.list.push(ship);
  const data = {
    holdings: [holding],
    catalog: {
      resources: content.resources,
      eventRegions: content.regions,
      marketEconomy: content.marketEconomy
    }
  };
  return { data, holding, ship };
}

function deterministicRandom(seed = 0x51f15e) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function timed(run) {
  const started = performance.now();
  const value = run();
  return { value, milliseconds: performance.now() - started };
}

export function checkShipOfferGenerationPerformance() {
  const fullFixture = bundledFixture();
  let fullContext;
  const fullGeneration = timed(() => {
    fullContext = buildShipWorldContext(fullFixture.data, fullFixture.holding);
    return generateWorldShipOffers(fullFixture.data, fullFixture.holding, fullFixture.ship, {
    period: 22,
    random: deterministicRandom(),
    context: fullContext
    });
  });

  const optimizedFixture = bundledFixture();
  const optimizedGeneration = timed(() => generateWorldShipOffers(optimizedFixture.data, optimizedFixture.holding, optimizedFixture.ship, {
    period: 22,
    random: deterministicRandom()
  }));
  assert.deepEqual(optimizedGeneration.value, fullGeneration.value, "lazy market composition must preserve the generated contracts exactly");

  const sharedFixture = bundledFixture();
  const sharedGeneration = timed(() => {
    const sharedContext = buildShipWorldContext(sharedFixture.data, sharedFixture.holding, {
      offerLocationIds: new Set([sharedFixture.ship.location.id, sharedFixture.ship.location.regionId])
    });
    configureWorldShipEconomy(sharedFixture.data, sharedFixture.holding, sharedFixture.ship, { context: sharedContext });
    return generateWorldShipOffers(sharedFixture.data, sharedFixture.holding, sharedFixture.ship, {
      period: 22,
      random: deterministicRandom(),
      context: sharedContext
    });
  });
  assert.deepEqual(sharedGeneration.value, fullGeneration.value, "one command-scoped context must preserve generated contracts exactly");
  const foreignPort = fullContext.ports.find((port) => port.regionId !== fullContext.home.regionId
    && fullGeneration.value.some((offer) => offer.to.id === port.id));
  assert.ok(foreignPort, "the fixture must include an accessible foreign destination");
  for (const seed of [13, 91]) {
    const foreignShip = { ...fullFixture.ship, hiddenCapacityLoadPoints: 200, location: {
      kind: "market", id: foreignPort.id, regionId: foreignPort.regionId, label: foreignPort.label
    } };
    const expected = generateWorldShipOffers(fullFixture.data, fullFixture.holding, foreignShip, {
      period: 23, random: deterministicRandom(seed), context: fullContext
    });
    const actual = generateWorldShipOffers(fullFixture.data, fullFixture.holding, foreignShip, {
      period: 23, random: deterministicRandom(seed)
    });
    assert.deepEqual(actual, expected, "foreign-port supply, demand, costs and random draws must also remain unchanged");
  }
  assert.ok(
    optimizedGeneration.milliseconds < fullGeneration.milliseconds * 0.6,
    `lazy generation should be materially faster (${optimizedGeneration.milliseconds.toFixed(1)}ms vs ${fullGeneration.milliseconds.toFixed(1)}ms)`
  );
  assert.ok(
    sharedGeneration.milliseconds < fullGeneration.milliseconds * 0.6,
    `shared command generation should be materially faster (${sharedGeneration.milliseconds.toFixed(1)}ms vs ${fullGeneration.milliseconds.toFixed(1)}ms)`
  );

  return {
    fullGenerationMs: Number(fullGeneration.milliseconds.toFixed(1)),
    optimizedGenerationMs: Number(optimizedGeneration.milliseconds.toFixed(1)),
    sharedConfigureAndGenerationMs: Number(sharedGeneration.milliseconds.toFixed(1)),
    ports: fullContext.ports.length,
    resources: fullFixture.data.catalog.resources.length
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = checkShipOfferGenerationPerformance();
  console.log(`FBL Skyhold ship-offer generation performance passed: ${JSON.stringify(result)}`);
}
