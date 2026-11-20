import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { transportFixture, transportRequest } from "./fixtures/transport-v2.mjs";
import { prepareTransportContext } from "../apps/domains/transport-context.js";

const previous = globalThis.game;
globalThis.game = { user: { id: "gm", isGM: true }, settings: { get() {} }, modules: new Map() };
try {
  const f = transportFixture(), names = ["home", "a", "b", ...Array.from({ length: 5 }, (_, i) => `dense-${i}`)];
  f.data.catalog.eventRegions = names.map((value, i) => ({ value, label: value, countryId: "public", marketTransportModes: ["airship"],
    marketLinks: names.slice(i + 1).map((regionId, j) => ({ regionId, distanceKm: 10 + j, modes: ["airship"], ursCost: 1,
      seasonalModifiers: { winter: { enabled: true, timeFactor: 1 + (i + j) % 3, riskFactor: 1 } } })) }));
  const request = transportRequest(f, "a", { ownShipId: f.ship.id });
  for (const isGM of [true, false]) {
    const begin = performance.now();
    const result = prepareTransportContext({ ...f, request, isGM });
    const elapsedMs = performance.now() - begin;
    assert.ok(result.plan);
    assert.equal(result.search.limited, false, "constrained Dijkstra solves dense graphs without hitting a search limit");
    assert.equal(result.search.limits.routes, false);
    assert.equal(new Set(result.services.map(s => s.id)).size, result.services.length);
    const hiredResult = prepareTransportContext({ ...f, request: { ...request, ownShipId: "", mode: "regular" }, isGM });
    assert.ok(hiredResult.plan);
    assert.equal(hiredResult.search.limited, false);
    console.log(`Dense eight-port quote (${isGM ? "GM" : "player"}): ${Math.round(elapsedMs)} ms, zero search limits.`);
  }
  console.log("Transport dense-graph routing: fast exact own-ship and hired quotes with zero search limits passed.");
} finally { globalThis.game = previous; }
