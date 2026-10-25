import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeEventRegionOptions } from "../data/random-events.js";
import { resolveMarketLogistics } from "../engines/market/logistics.js";
import { planMarketPurchase } from "../engines/market/pricing.js";
import { applyCarrierToLogistics } from "../engines/market/providers.js";

const MODES = ["caravan", "rail", "airship"];
function fixture() {
  const links = [
    ["h", "b", 75, ["caravan", "airship"], 1, ""], ["b", "c", 120, ["rail", "caravan"], 1, ""],
    ["c", "d", 45, ["rail", "airship"], 1, ""], ["d", "m", 160, ["caravan", "airship"], 1, ""],
    ["b", "d", 300, ["rail", "caravan"], 3, ""], ["h", "c", 200, ["airship"], 2, ""],
    ["c", "m", 250, ["rail", "caravan"], 2, "winter-line"], ["c", "m", 190, ["rail", "caravan"], 3, "direct-line"]
  ];
  const regions = normalizeEventRegionOptions(["h", "b", "c", "d", "m"].map((value) => ({ value, label: value,
    marketLandmassId: "land", marketTransportModes: MODES,
    marketLinks: links.filter((row) => row[0] === value).map(([, regionId, distanceKm, modes, ursCost, routeId]) => ({
      regionId, distanceKm, modes, ursCost, routeId,
      ...(routeId === "winter-line" ? { seasonalModifiers: { winter: { costFactor: 0.7, timeFactor: 1.5, riskFactor: 0.5 } } } : {})
    }))
  })), { fallback: false });
  return { regions, holding: { type: "village", overview: { region: "h" }, gm: { modifiers: { marketConnectionsLevel: 6 } },
    storage: { moneyCopper: 1_000_000_000 } }, market: { regionId: "m", transportModes: MODES } };
}

// Independent enumeration of every simple physical path and every edge-mode assignment.
// It retains parallel route IDs and deliberately does not use production graph/search helpers.
function allRoutes({ regions, holding }) {
  const graph = new Map(regions.map((row) => [row.value, []]));
  for (const row of regions) for (const link of row.marketLinks) {
    const edge = { ...link, to: link.regionId, distance: link.distanceKm / 40 };
    graph.get(row.value).push(edge); graph.get(link.regionId).push({ ...edge, to: row.value });
  }
  const result = [];
  const visit = (path, edges, distanceKm, accessCost) => {
    const from = path.at(-1);
    if (from === "m") {
      result.push({ path, edges, distanceKm, accessCost, distance: distanceKm / 40, hops: edges.length }); return;
    }
    for (const edge of graph.get(from)) {
      if (path.includes(edge.to) || accessCost + edge.ursCost > holding.gm.modifiers.marketConnectionsLevel) continue;
      for (const selectedMode of edge.modes) visit([...path, edge.to], [...edges, { from, ...edge, selectedMode }],
        distanceKm + edge.distanceKm, accessCost + edge.ursCost);
    }
  };
  visit(["h"], [], 0, 0); return result;
}

export function checkMarketMixedChoice() {
  const carriers = [null, { id: "ground", modes: ["rail", "caravan"], priceFactor: 0.8, capacityFactor: 0.6, timeFactor: 1.3 },
    { id: "all", modes: MODES, priceFactor: 1.2, capacityFactor: 1.5, timeFactor: 0.6 }, { id: "air", modes: ["airship"], priceFactor: 0.7 }];
  let checks = 0;
  for (const variant of ["base", "sky", "ship", "urs3", "restricted", "cross-landmass", "seasonal"]) {
    const input = fixture();
    if (["sky", "ship"].includes(variant)) input.holding.type = variant === "sky" ? "sky-island" : "ship";
    if (variant === "urs3") input.holding.gm.modifiers.marketConnectionsLevel = 3;
    if (variant === "restricted") input.regions.find((row) => row.value === "c").marketTransportModes = ["caravan", "airship"];
    if (variant === "cross-landmass") input.regions.find((row) => row.value === "d").marketLandmassId = "island";
    const args = { ...input, seasonId: variant === "seasonal" ? "winter" : "" };
    const exhaustive = allRoutes(input).map((selectedRoute) => resolveMarketLogistics({ ...args, selectedRoute, singleRoute: true })).filter((route) => route.ok);
    const searched = resolveMarketLogistics(args);
    for (const carrier of carriers) {
      const eligible = exhaustive.filter((route) => !carrier || route.capacityModes.every((mode) => carrier.modes.includes(mode)))
        .map((route) => applyCarrierToLogistics(route, carrier));
      const actualRoute = applyCarrierToLogistics(searched, carrier);
      for (const serviceLevel of ["standard", "express", "charter"]) for (const load of [1, 50, 500]) for (const unitPriceCopper of [30, 100_000]) {
        const plan = (route) => planMarketPurchase({ holding: input.holding, serviceLevel, quantities: { goods: 2 }, quote: {
          offers: [{ id: "goods", load, stock: 2, unitPriceCopper }], location: {}, logistics: route,
          deliveryMode: "scheduled", deliveryBaseQd: 1, deliveryQd: 1 + route.travelQd
        } });
        const best = eligible.map(plan).filter((row) => row.ok).sort((a, b) => a.totalCopper - b.totalCopper || a.deliveryQd - b.deliveryQd)[0];
        const actual = plan(actualRoute); checks++;
        assert.equal(actual.ok, Boolean(best), `${variant}/${carrier?.id}/${serviceLevel}/${load}/${unitPriceCopper}: reachability/capacity`);
        if (best) assert.deepEqual([actual.totalCopper, actual.deliveryQd], [best.totalCopper, best.deliveryQd],
          `${variant}/${carrier?.id}/${serviceLevel}/${load}/${unitPriceCopper}: full price and ETA equal exhaustive optimum`);
      }
    }
  }
  assert.equal(checks, 504);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkMarketMixedChoice();
  console.log("Mixed route choice: 504 exhaustive comparisons, forks, parallel links, transfers, seasonal risk, URS, carriers and shipment capacity passed.");
}
