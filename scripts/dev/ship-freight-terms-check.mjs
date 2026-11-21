import assert from "node:assert/strict";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { customerTransportFare } from "../engines/ships/customer-fares.js";
import { contractGuidance, resolveContractOutcome } from "../engines/ships/contracts.js";
import { buildShipWorldContext, generateWorldShipOffers, quoteWorldShipBundle, repriceWorldShipOffer } from "../engines/ships/world-market.js";
import { referenceTransportCosts } from "../engines/transport/economics.js";
import { validateTransportConfiguration } from "../engines/transport/services.js";
import { getShipProfile } from "../engines/ships/profiles.js";

export function checkShipFreightTerms() {
  const { data, holding, ship } = worldMarketFixture();
  data.catalog.marketEconomy.baseOffers[0].priceOverrideCopper = 300;
  const home = data.catalog.eventRegions.find(row => row.value === "home");
  for (const [id, distanceKm] of [["c", 120], ["d", 800], ["e", 1500]]) {
    data.catalog.eventRegions.push({ ...home, value: id, label: id, marketLinks: [] });
    home.marketLinks.push({ regionId: id, distanceKm, modes: ["airship"] });
  }
  const context = buildShipWorldContext(data, holding);
  const board = random => generateWorldShipOffers(data, holding, ship, { context, period: 1, random });
  const distant = board(() => 0.96);
  assert.ok(distant.length && distant.some(row => row.to.id === "e"));
  assert.ok(distant.every(row => ["a", "b", "c"].includes(row.contract.pickup.id)), "a distant consignee does not force a distant pickup");
  const orders = board(() => 0.4), freight = orders[0], mail = orders.find(row => row.kind === "commission");
  assert.equal(freight.kind, "freight");
  assert.deepEqual(mail.contract.pickup, freight.contract.pickup);
  assert.deepEqual(mail.to, freight.to);
  assert.ok(mail.contract.cargo.loadPoints > 0 && mail.contract.cargo.loadPoints + freight.contract.cargo.loadPoints <= ship.capacityLoadPoints);
  assert.equal(quoteWorldShipBundle(data, holding, ship, [freight, mail], { context }).stops.length, 2);

  const unitCost = id => {
    const profile = getShipProfile(id), capacity = profile.capacityLoadPoints / 4;
    return referenceTransportCosts("airship", capacity).dailyCopper / (capacity * profile.speedKmPerDay);
  };
  assert.ok(unitCost("merchant-barque") < Math.min(unitCost("schooner"), unitCost("cutter")));
  ship.name = "Watch test";
  const quoteWatch = count => {
    ship.crewTarget = count;
    return repriceWorldShipOffer(data, holding, ship, freight, { context });
  };
  const single = quoteWatch(18), double = quoteWatch(36);
  assert.equal(double.contract.rewardCopper, single.contract.rewardCopper);
  assert.ok(double.quote.costs.crewCopper > single.quote.costs.crewCopper);
  assert.ok(double.contract.economics.riskBps < single.contract.economics.riskBps);
  assert.equal(quoteWatch(54).contract.economics.riskBps, double.contract.economics.riskBps);

  const origin = context.ports.find(row => row.id === "a"), destination = context.ports.find(row => row.id === "b");
  const price = (kind, loadPoints, valueCopper = 0, attention = 0, riskBps = 0) => customerTransportFare({
    cargo: { kind, loadPoints, valueCopper }, attention, origin, destination, resources: context.resources,
    referenceRoute: profile => ({ distanceKm: 1000, durationQd: Math.ceil(4000 / profile.speedKmPerDay), riskExposureQd: 16 }),
    configuration: validateTransportConfiguration({ riskBps }) });
  assert.equal(price("freight", 480).specialPremiumCopper, 0);
  assert.ok(price("freight", 600).specialPremiumCopper > 0);
  for (const boundary of [800, 2000]) assert.ok(price("freight", boundary + 1).rewardCopper >= price("freight", boundary).rewardCopper);
  const contraband = price("smuggling", 20, 10000, 0, 300);
  assert.equal(contraband.specialPremiumCopper, 3500);
  assert.equal(price("smuggling", 20, 20000).specialPremiumCopper, 7000);
  assert.equal(price("smuggling", 20, 10000, 10).specialPremiumCopper, 5500);
  assert.ok(contraband.riskPremiumCopper > price("smuggling", 20, 10000).riskPremiumCopper);

  const clean = { commercialDice: [3, 4], incidentRoll: 12, passageRoll: 10000 };
  const terms = { ...single.contract, rewardCopper: 1000, economics: { ...single.contract.economics, riskBps: 4000 } };
  const old = structuredClone(terms);
  delete old.economics.cleanPassageBonusPercent;
  delete old.economics.cautiousReductionPercent;
  assert.deepEqual([terms, old].map(row => contractGuidance(row, "cautious").riskBps), [1800, 3000]);
  for (const [row, expected] of [[terms, 1120], [old, 1020]]) {
    assert.equal(contractGuidance(row, "bold").rewardRangeCopper.max, expected);
    assert.equal(resolveContractOutcome(row, "bold", clean).rewardCopper, expected);
    assert.equal(resolveContractOutcome(row, "bold", { ...clean, passageRoll: 1 }).rewardCopper, 1000);
  }

  function bestStyle(riskBps) {
    const order = { ...terms, rewardCopper: 350, economics: { ...terms.economics, riskBps, approachRiskBps: 0,
      repairCopper: 1800, precautionCopper: 60, delayDailyCopper: 438 } };
    const styles = ["normal", "cautious", "bold"].map(style => {
      const chance = contractGuidance(order, style).riskBps / 10000;
      const net = roll => {
        const outcome = resolveContractOutcome(order, style, roll);
        return outcome.rewardCopper - outcome.expenseCopper;
      };
      const incidentNet = Array.from({ length: 12 }, (_, index) => net({ ...clean, passageRoll: 1, incidentRoll: index + 1 }));
      return { style, expected: (1 - chance) * net(clean) + chance * incidentNet.reduce((sum, value) => sum + value, 0) / 12 };
    });
    return styles.sort((left, right) => right.expected - left.expected)[0].style;
  }
  assert.deepEqual([200, 1000, 4500].map(bestStyle), ["bold", "normal", "cautious"]);
}
