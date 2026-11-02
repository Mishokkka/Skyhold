import assert from "node:assert/strict";
import { transportServicesFromRoutes, validateTransportConfiguration } from "../engines/transport/services.js";
import { referenceTransportCosts, transportRiskBps, transportInsuranceCopper, transportServiceCharge,
  localMarketDistanceKm } from "../engines/transport/economics.js";
import { calculateShipCosts, SHIP_PROFILES } from "../engines/ships/profiles.js";
import { transportOperatingCharge, transportPeriodCosts } from "../engines/transport/quantities.js";
import { planTransportChain } from "../engines/transport/planner.js";
import { buildShipWorldContext, generateWorldShipOffers, quoteWorldShipBundle, worldShipTransportTerms } from "../engines/ships/world-market.js";
import { contractGuidance, resolveContractOutcome } from "../engines/ships/contracts.js";
import { resolveBundlePassages } from "../engines/ships/bundle-incidents.js";
import { productionLineEconomics } from "../engines/economy/production-economics.js";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { shipTradingYearReport } from "./ship-balance-report.mjs";

const config = validateTransportConfiguration();
const cargo = (load = 100, value = 1000) => [{ lotId: "goods", qty: 1, unitLoad: load * 4000, unitCopper: value }];
const leg = (mode, capacityLoad, distanceKm) => ({ fromRegionId: "a", toRegionId: "b", fromCountryId: "c", toCountryId: "c",
  carrierId: "carrier", mode, capacityLoad, distanceKm, routeId: "road", movementQd: distanceKm / 40 * ({ caravan: 4, rail: 1, airship: 1.5 }[mode]),
  riskFactor: 1, operatingFactor: 1, dispatchCopper: mode === "caravan" ? 6 : mode === "rail" ? 12 : 20,
  hireCopper: mode === "airship" ? 120 : 0, distanceCopper: 0, loadCopperPerUnit: 0 });
const servicesFor = (mode, capacity, distance, configuration = {}) => transportServicesFromRoutes([
  { transportPlan: { direction: "outbound", legs: [leg(mode, capacity, distance)] } }
], configuration);
const quote = (service, load = 100, value = 1000) => planTransportChain({ cargo: cargo(load, value), services: [service] });

for (const profile of Object.values(SHIP_PROFILES)) {
  const reference = referenceTransportCosts("airship", profile.capacityLoadPoints / 4, 9);
  const actual = calculateShipCosts({ profileId: profile.id }, { durationQd: 4, crewCount: profile.crewTarget, foodUnitCopper: 9 });
  assert.equal(reference.dailyCopper, actual.totalCopper, "identical reference and actual crews have identical daily costs");
  for (const durationQd of [1, 3, 11]) assert.equal(transportOperatingCharge({ returnDailyCosts: reference.dailyCosts,
    returnOperatingMilliCopperPerQd: reference.dailyCopper * 250 }, durationQd, true),
  calculateShipCosts({ profileId: profile.id }, { durationQd, crewCount: profile.crewTarget, foodUnitCopper: 9 }).totalCopper,
  "rounded food, wages and upkeep remain identical on short return legs");
}
const matrix = [];
for (const mode of ["caravan", "rail", "airship"]) {
  let previousRegular = 0, previousCharter = 0;
  for (const distance of [40, 400, 1000]) {
    const [regular, charter] = servicesFor(mode, 1000, distance);
    const shared = quote(regular), dedicated = quote(charter);
    assert.ok(shared.totalCopper > previousRegular && dedicated.totalCopper > previousCharter);
    previousRegular = shared.totalCopper; previousCharter = dedicated.totalCopper;
    const run = dedicated.stages[0].runs[0];
    const outward = run.arrivalQd - run.startQd;
    const expense = transportPeriodCosts(outward, charter.dailyCosts).totalCopper
      + transportPeriodCosts(charter.returnQd, charter.returnDailyCosts).totalCopper;
    assert.equal(run.charge.operatingCopper, expense);
    assert.equal(run.charge.profitCopper, Math.ceil((expense + charter.dispatchCopper) / 5));
    assert.equal(quote(regular, 100, 999999).totalCopper, shared.totalCopper, "cargo value is not a hidden freight markup");
    assert.ok(quote(regular, 1).totalCopper < shared.totalCopper);
    assert.ok(quote(regular, 1000).totalCopper > shared.totalCopper);
    assert.equal(shared.stages[0].storageCopper, 0);
    assert.ok(shared.stages[0].service.storageIncluded);
    matrix.push({ mode, km: distance, load: 100, regular: shared.totalCopper, charter: dedicated.totalCopper });
  }
}
for (const mode of ["caravan", "rail", "airship"]) {
  const costs = [200, 1000, 8000].map(capacity => quote(servicesFor(mode, capacity, 400)[1]).totalCopper);
  assert.ok(costs[0] < costs[1] && costs[1] < costs[2], "larger charter vehicles cannot retain a small vessel's daily bill");
}
{
  const [regular, charter] = servicesFor("airship", 1000, 400);
  const resized = servicesFor("airship", 1000, 400, { overrides: { [charter.id]: { capacity: 8000 * 4000 } } })[1];
  assert.ok(resized.dailyCosts.crewCopper > charter.dailyCosts.crewCopper);
  const custom = servicesFor("airship", 1000, 400, { overrides: { [charter.id]: { operatingCopperPerQd: 5, returnOperatingMilliCopperPerQd: 2000 } } })[1];
  assert.equal(transportOperatingCharge(custom, 4), 20);
  assert.equal(transportOperatingCharge(custom, 4, true), 8);
  const faster = servicesFor("airship", 1000, 400, { overrides: { [regular.id]: { loadingQd: 1, unloadingQd: 1 } } })[0];
  assert.ok(quote(faster).totalCopper < quote(regular).totalCopper, "less occupied handling time lowers the default regular fare");
  const fixed = servicesFor("airship", 1000, 400, { overrides: { [regular.id]: { loadCopper: 2 } } })[0];
  assert.equal(quote(fixed).stages[0].runs[0].charge.loadCopper, 200, "existing explicit tariffs remain authoritative");
}
{
  const [service, charter] = servicesFor("airship", 1000, 400);
  const cycleQd = 2 * (service.travelQd + service.loadingQd + service.unloadingQd);
  const cycleCosts = transportPeriodCosts(cycleQd, charter.dailyCosts).totalCopper + 280;
  const revenue = 2 * transportServiceCharge(service, 650 * 4000, 0).totalCopper;
  assert.ok(revenue >= cycleCosts * 1.2 && revenue < cycleCosts * 1.22, "65% paid load on both legs covers one cycle plus the stated margin");
  const cycles = Math.floor(240 * 4 / cycleQd);
  const annualCosts = referenceTransportCosts("airship", 1000).dailyCopper * 240 + cycles * 280;
  assert.ok(cycles * revenue > annualCosts, "a regularly occupied line can pay the full 240-day crew year");
  assert.ok(cycles * revenue / 2 < annualCosts, "an empty return is not silently subsidized by a second paying cargo");
}
{
  assert.equal(transportRiskBps(16), 300);
  const half = transportRiskBps(8) / 10000;
  assert.ok(Math.abs((1 - (1 - half) ** 2) * 10000 - transportRiskBps(16)) < 1);
  assert.ok(transportRiskBps(160) > transportRiskBps(16 * 3));
  const insuredCargo = [{ lotId: "goods", qty: 100, unitLoad: 4000, unitCopper: 100 }];
  const plan = risks => ({ cargo: insuredCargo, stages: risks.map(riskBps => ({ runs: [{ riskBps, cargo: insuredCargo }] })) });
  const simple = transportInsuranceCopper(plan([300]), config);
  const parallel = { cargo: insuredCargo, stages: [{ runs: [40, 60].map(qty => ({ riskBps: 300, cargo: [{ ...insuredCargo[0], qty }] })) }] };
  assert.equal(transportInsuranceCopper(parallel, config), simple, "two parallel consignments are not two exposures for each unit");
  assert.ok(transportInsuranceCopper(plan([300, 300]), config) > simple);
  assert.ok(transportInsuranceCopper(plan([1500]), config) > simple);
  assert.equal(transportInsuranceCopper(plan([300]), { ...config, insuranceBps: 300 }), 300, "an existing insurance minimum remains in force");
  assert.equal(transportInsuranceCopper({ cargo: cargo(1, 0), stages: [] }, config), 0);
}
{
  const f = worldMarketFixture();
  assert.equal(localMarketDistanceKm(f.holding), 20);
  f.holding.gm.modifiers.marketLocalDistanceKm = 200;
  const context = buildShipWorldContext(f.data, f.holding);
  const local = worldShipTransportTerms(f.data, f.holding, f.ship, "home", "home", { context, toHome: false });
  assert.equal(local.distanceKm, 200);
  assert.equal(local.durationQd, Math.ceil(200 * 4 / f.ship.speedKmPerDay));
}
{
  const f = worldMarketFixture();
  const first = generateWorldShipOffers(f.data, f.holding, f.ship, { period: 0, random: () => 0.4 });
  f.holding.people.list[0].wageDailyOverrideCopper = 120;
  const costly = generateWorldShipOffers(f.data, f.holding, f.ship, { period: 0, random: () => 0.4 });
  assert.deepEqual(costly.map(row => row.contract.rewardCopper), first.map(row => row.contract.rewardCopper));
  assert.ok(costly[0].quote.operatingCopper > first[0].quote.operatingCopper);
  assert.ok(first.filter(row => row.kind === "freight").every(row => row.contract.rewardCopper <= row.contract.economics.customerBudgetCopper));
  f.data.catalog.eventRegions.find(row => row.value === "a").marketRiskFactor = 3;
  const dangerous = generateWorldShipOffers(f.data, f.holding, f.ship, { period: 0, random: () => 0.4 });
  assert.ok(dangerous[0].contract.economics.riskBps > first[0].contract.economics.riskBps);
  const quiet = { commercialDice: [1, 1], incidentRoll: 1, passageRoll: 10000 };
  const cancellation = resolveContractOutcome(first[0].contract, "normal", quiet);
  assert.equal(cancellation.expenseCopper, 0, "a customer cancellation cannot invent a repair or a 120% operating bill");
  assert.equal(cancellation.rewardCopper, Math.ceil(first[0].contract.rewardCopper * 0.75));
  const lowCrew = first[0].contract;
  const highCrew = costly[0].contract;
  const damaged = contract => resolveContractOutcome(contract, "normal", { commercialDice: [3, 4], incidentRoll: 1, passageRoll: 1 });
  assert.equal(damaged(lowCrew).rewardCopper, lowCrew.rewardCopper, "an event on the empty approach cannot damage the customer's unloaded cargo");
  const loadedDamage = resolveContractOutcome(lowCrew, "normal", { commercialDice: [3, 4], incidentRoll: 1,
    passageRoll: lowCrew.economics.approachRiskBps + 1 });
  assert.equal(loadedDamage.rewardCopper, Math.ceil(lowCrew.rewardCopper * 0.75));
  assert.equal(damaged(highCrew).expenseCopper - damaged(lowCrew).expenseCopper,
    2 * (highCrew.economics.delayDailyCopper - lowCrew.economics.delayDailyCopper), "only actual delay upkeep changes with crew wages; repair stays tied to the hull");
  const legacy = structuredClone(first[0].contract); delete legacy.economics;
  assert.ok(resolveContractOutcome(legacy, "normal", quiet).expenseCopper > 0, "existing signed legacy terms retain the old resolver");
  assert.ok(contractGuidance(first[0].contract).suggestedBudgetCopper >= first[0].quote.operatingCopper);
  const plan = quoteWorldShipBundle(f.data, f.holding, f.ship, first.slice(0, 2));
  assert.ok(plan.stops.every(stop => stop.economics.version === 1));
}
{
  const terms = { version: 1, riskBps: 10000, repairCopper: 100, delayDailyCopper: 50, precautionCopper: 10 };
  const bundle = { nextStopIndex: 1, orders: ["a", "b"].map(offerId => ({ offerId, style: "normal" })),
    stops: [{ economics: terms, cargoOfferIds: ["a", "b"] }, { economics: terms, cargoOfferIds: ["b"] }] };
  const first = resolveBundlePassages(bundle, bundle.stops[0], () => 0);
  assert.equal(first.expenseCopper, 200);
  assert.deepEqual(bundle.orders.map(row => row.cargoRewardBps), [7500, 7500]);
  bundle.orders[0].outcomeApplied = true; bundle.nextStopIndex = 2;
  const second = resolveBundlePassages(bundle, bundle.stops[1], () => 0);
  assert.equal(second.expenseCopper, 200);
  assert.deepEqual(bundle.orders.map(row => row.cargoRewardBps), [7500, 5625], "a discharged cargo cannot suffer a later leg's loss");
  assert.deepEqual(resolveBundlePassages(bundle, bundle.stops[1], () => { throw new Error("reroll"); }), second);
}
{
  const line = { outputQty: 10, resourceId: "wood", source: "content" };
  const catalog = productionLineEconomics(line, {}, { channel: "contract", unitPrice: 10 });
  const delivered = productionLineEconomics(line, {}, { channel: "contract", unitPrice: 10, inputCostCopper: 120 });
  assert.equal(catalog.marginMin, 100); assert.equal(delivered.marginMin, -20);
  assert.equal(productionLineEconomics(line, {}, { inputCostCopper: "" }).hasLandedCost, false);
  assert.equal(productionLineEconomics(line, {}, { inputCostCopper: 0 }).hasLandedCost, true);
  assert.equal(productionLineEconomics(line, {}, { inputCostCopper: -1 }).available, false);
}
console.log(JSON.stringify({ transportEconomyMatrix: matrix }));
for (const profileId of ["cutter", "schooner", "merchant-barque"]) {
  const year = shipTradingYearReport({ profileId });
  assert.ok(year.jobs > 0 && year.netCopper > 0, "sustained port-to-port trade can pay a full crew year, including idle time and unpaid return");
  console.log(JSON.stringify({ tradingYear: year }));
}
console.log("Transport economy: common costs, load/size/distance, round trip/year, overrides, insurance, local distance, customer budgets, legacy terms, shared incidents and landed production costs passed.");
