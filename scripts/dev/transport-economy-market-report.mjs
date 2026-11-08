import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { buildShipWorldContext, generateWorldShipOffers, worldShipTransportTerms } from "../engines/ships/world-market.js";
import { customerTransportFare, ordinaryFreightBudget } from "../engines/ships/customer-fares.js";
import { validateTransportConfiguration } from "../engines/transport/services.js";

// The bundled map has no route lengths. Only this offline fixture supplies links;
// its goods, prices, market sizes, specialties, handling and country conditions come from the pack.
const { content } = JSON.parse(readFileSync(new URL("../../examples/content-packs/air-islands-trade-network-template.json", import.meta.url), "utf8"));
const pairs = [["lezhnizem-ispol", "sirosten-nikery"], ["sirosten-nikery", "izuaver-cradle"], ["izuaver-cradle", "lezhnizem-ispol"]];
const seeded = seed => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000;
};

function fixture(fromId, toId, km) {
  const f = worldMarketFixture();
  const from = structuredClone(content.regions.find(row => row.value === fromId));
  const to = structuredClone(content.regions.find(row => row.value === toId));
  const home = { value: "audit-home", label: "Offline home", countryId: from.countryId, marketEnabled: false,
    marketTransportModes: ["airship"], marketLinks: [{ regionId: fromId, distanceKm: 40, modes: ["airship"] }] };
  from.marketLinks = [{ regionId: toId, distanceKm: km, modes: ["airship"] }]; to.marketLinks = [];
  f.data.catalog.eventRegions = [home, from, to];
  f.data.catalog.resources = structuredClone(content.resources);
  f.data.catalog.marketEconomy = structuredClone(content.marketEconomy);
  f.holding.overview.region = home.value;
  f.ship.status = "away"; f.ship.name = "Audit barque";
  f.ship.location = { kind: "market", id: fromId, regionId: fromId, label: from.label };
  for (let index = 1; index < 36; index++) {
    const id = `crew-${index}`;
    f.holding.people.list.push({ id, name: id, wageDailyOverrideCopper: 12 });
    f.ship.crewResidentIds.push(id);
  }
  return { ...f, context: buildShipWorldContext(f.data, f.holding) };
}

const results = [];
for (const [from, to] of pairs) for (const km of [40, 400, 1000]) {
  const f = fixture(from, to, km);
  const counts = { boards: 0, emptyBoards: 0, freight: 0, commission: 0, smuggling: 0, positiveBeforeReturn: 0 };
  const freightGoods = new Set();
  for (const seed of [17, 8192, 42]) {
    const random = seeded(seed);
    for (let period = 0; period < 10; period++) {
      const offers = generateWorldShipOffers(f.data, f.holding, f.ship, { period, random, context: f.context });
      counts.boards++; counts.emptyBoards += Number(!offers.length);
      for (const offer of offers) {
        counts[offer.kind]++;
        counts.positiveBeforeReturn += Number(offer.contract.rewardCopper > offer.quote.operatingCopper);
        if (offer.kind === "freight") {
          assert.ok(offer.contract.rewardCopper <= offer.contract.economics.customerBudgetCopper);
          freightGoods.add(offer.contract.cargo.resourceId);
        }
      }
    }
  }
  const origin = f.context.ports.find(row => row.id === from), destination = f.context.ports.find(row => row.id === to);
  const examples = [];
  for (const id of ["grain", "bread", "wood", "iron", "gemstones"]) {
    const good = origin.offers.find(row => row.resourceId === id);
    const demand = destination.outboundOffers.find(row => row.resourceId === id);
    if (!good || !demand) { examples.push({ id, available: false }); continue; }
    const cargo = { kind: "freight", quantity: 100, loadPoints: 100 * good.loadPoints,
      valueCopper: Math.ceil(100 * good.basePriceCopper * origin.factors.price) };
    const taxCopper = Math.ceil(cargo.valueCopper * origin.factors.exportTaxRate) + Math.ceil(cargo.valueCopper * destination.factors.taxRate);
    const fare = customerTransportFare({ cargo, origin, destination, resources: f.context.resources,
      configuration: validateTransportConfiguration(), taxCopper,
      referenceRoute: profile => worldShipTransportTerms(f.data, f.holding, { ...f.ship, ...profile }, from, to,
        { context: f.context, fromHome: false, toHome: false }) });
    const budget = ordinaryFreightBudget(cargo, demand, destination);
    examples.push({ id, sourceValue: cargo.valueCopper, fee: fare.rewardCopper, budget, withinBudget: fare.rewardCopper <= budget });
  }
  results.push({ from, to, km, ...counts, freightGoods: [...freightGoods].sort(), examples });
}
console.log(JSON.stringify({ assumptions: { syntheticDistancesKm: [40, 400, 1000], seeds: [17, 8192, 42],
  boardsPerCase: 30, exampleQuantity: 100, crew: 36, wageDailyCopper: 12,
  handlingLoadCopper: content.marketEconomy.settings.handlingLoadCopper,
  note: "Positive before return excludes idle time, incidents and the final homeward leg; it is not annual profit." }, results }, null, 2));
