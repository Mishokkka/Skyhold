import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { transportFixture, transportRequest } from "./fixtures/transport-v2.mjs";
import { prepareTransportContext } from "../apps/domains/transport-context.js";
import { worldShipRouteSearchBudget } from "../engines/ships/world-market.js";
import { TRANSPORT_LIMITS } from "../engines/transport/quantities.js";

const previous = globalThis.game;
globalThis.game = { user: { id: "gm", isGM: true }, settings: { get() {} }, modules: new Map() };
try {
  const f = transportFixture(), names = ["home", "a", "b", ...Array.from({ length: 5 }, (_, i) => `dense-${i}`)];
  f.data.catalog.eventRegions = names.map((value, i) => ({ value, label: value, countryId: "public", marketTransportModes: ["airship"],
    marketLinks: names.slice(i + 1).map((regionId, j) => ({ regionId, distanceKm: 10 + j, modes: ["airship"], ursCost: 1,
      seasonalModifiers: { winter: { enabled: true, timeFactor: 1 + (i + j) % 3, riskFactor: 1 } } })) }));
  const request = transportRequest(f, "a", { ownShipId: f.ship.id });
  for (const isGM of [true, false]) {
    const budget = worldShipRouteSearchBudget(), initial = { ...budget }, begin = performance.now();
    const result = prepareTransportContext({ ...f, request, isGM, searchBudget: budget });
    assert.ok(result.plan);
    assert.equal(result.search.limited, true);
    assert.equal(result.search.limits.routes, true, "partial discovery remains explicit even if a plan was found");
    for (const key of ["labels", "routes", "hiredRoutes"]) {
      assert.ok(budget[key] >= 0 && budget[key] < initial[key], `all ${key} work shares one quote budget`);
    }
    const hired = result.services.filter(s => s.kind !== "owned");
    assert.ok(hired.length <= initial.hiredRoutes * 2 * TRANSPORT_LIMITS.stages);
    assert.equal(new Set(result.services.map(s => s.id)).size, result.services.length);
    console.log(`Dense eight-port quote (${isGM ? "GM" : "player"}): ${Math.round(performance.now() - begin)} ms; ${initial.labels - budget.labels} labels, ${initial.hiredRoutes - budget.hiredRoutes} hired paths.`);
    const baseline = prepareTransportContext({ ...f, request, isGM,
      searchBudget: { labels: 0, routes: 0, hiredRoutes: 0 } });
    assert.ok(baseline.plan, "the known shortest own-ship path survives an exhausted alternatives budget");
    assert.equal(baseline.search.limited, true);
    const exhausted = prepareTransportContext({ ...f, isGM, allowIncomplete: true,
      request: { ...request, pins: { a: "unavailable-service" } },
      searchBudget: { labels: 0, routes: 0, hiredRoutes: 0 } });
    assert.equal(exhausted.plan, null);
    assert.equal(exhausted.search.limited, true);
    assert.match(exhausted.error, /лимит/);
    assert.doesNotMatch(exhausted.error, /нет доступной перевозки/);
  }
  console.log("Transport quote search budget: shared hired/own discovery, bounded physical alternatives and truthful partial/no-plan results passed.");
} finally { globalThis.game = previous; }
