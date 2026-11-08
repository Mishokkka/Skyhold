import assert from "node:assert/strict";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { transportFixture, transportRequest, transportHarness } from "./fixtures/transport-v2.mjs";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { prepareTransportContext } from "../apps/domains/transport-context.js";
import { createShipOperationExecutor } from "../apps/ship-operation-executor.js";
import { buildShipWorldContext, generateWorldShipOffers, repriceWorldShipOffer, quoteWorldShipBundle, quoteWorldShipReturn, worldShipTransportTerms } from "../engines/ships/world-market.js";
import { departWorldShip, departWorldShipBundle, advanceWorldShips, resolveWorldShipBundleStop, continueWorldShipBundle, adjustWorldShipFunds } from "../engines/ships/world-voyage.js";
import { resolveContractOutcome } from "../engines/ships/contracts.js";
import { customerTransportFare } from "../engines/ships/customer-fares.js";
import { transportServicesFromRoutes, validateTransportConfiguration } from "../engines/transport/services.js";
import { configuredTransportCharges, transportServiceCharge } from "../engines/transport/economics.js";
import { planTransportChain } from "../engines/transport/planner.js";

const neverRoll = () => { throw new Error("A saved result was rerolled"); };
function shipHarness(f) {
  let data = structuredClone(f.data);
  const skipToken = Symbol("skip");
  const execute = createShipOperationExecutor({
    getUser: id => ({ id, isGM: id === "gm" }), random: () => 0.4,
    skip: value => ({ [skipToken]: true, value }),
    updateHolding: async (_id, updater) => {
      const draft = structuredClone(data), result = await updater(draft.holdings[0], draft);
      if (result?.[skipToken]) return result.value;
      draft.meta.revision++; data = draft; return result;
    }
  });
  return { execute, get data() { return data; }, get holding() { return data.holdings[0]; } };
}
const eventDraws = severity => {
  const values = severity == null ? [0.99, 0.99] : [(severity - 0.5) / 12, 0];
  return () => values.shift() ?? 0.5;
};

function checkBundle(firstSeverity, lastSeverity = null) {
  let { data, holding, ship } = worldMarketFixture();
  data.catalog.eventRegions.push({ ...structuredClone(data.catalog.eventRegions[0]), value: "base", label: "base",
    marketEnabled: false, marketLinks: [{ regionId: "home", distanceKm: 40, modes: ["airship"] }] });
  holding.overview.region = "base"; holding.storage.moneyCopper = 450000;
  ship.onboardCopper = 50000; ship.status = "away";
  ship.location = { kind: "market", id: "home", regionId: "home", label: "Origin" };
  const source = generateWorldShipOffers(data, holding, ship, { period: 0, random: () => 0.4 })[0];
  const offers = [["a", "a", 1200, null], ["b", "b", 1200, null], ["pickup", "b", 600, "a"]].map(([id, to, load, pickup]) => {
    const offer = structuredClone(source);
    offer.id = id; offer.to = { kind: "market", id: to, regionId: to, label: to };
    offer.contract.destination = to; offer.contract.directionKey = `port:${to}`;
    Object.assign(offer.contract.cargo, { quantity: load / 4, loadPoints: load, valueCopper: load * 8 });
    if (pickup) offer.contract.pickup = { kind: "market", id: pickup, regionId: pickup, label: pickup };
    else delete offer.contract.pickup;
    return repriceWorldShipOffer(data, holding, ship, offer);
  });
  const plan = quoteWorldShipBundle(data, holding, ship, offers);
  assert.deepEqual(plan.stops.map(stop => stop.point.id), ["a", "b"]);
  departWorldShipBundle(holding, ship, { operationId: "bundle", plan, style: "bold", clockQd: 0 });
  const arrive = () => {
    holding.gm.calendaria.lastQd = ship.activeVoyage.arrivalQd;
    advanceWorldShips(holding, ship.activeVoyage.arrivalQd);
  };
  arrive();
  if (firstSeverity != null) ship.onboardCopper = 0;
  let result = resolveWorldShipBundleStop(holding, ship, { operationId: "resolve-a", bundleId: "bundle", random: eventDraws(firstSeverity) });
  const physical = structuredClone(ship.orderBundle.stops[0].physicalResolution);
  if (firstSeverity != null) {
    assert.equal(result.pending, true);
    const saved = structuredClone(ship.orderBundle.orders[0].outcome);
    holding = mergeHoldingDefaults(JSON.parse(JSON.stringify(holding)));
    data.holdings[0] = holding; ship = holding.special.ships.list[0];
    assert.deepEqual(ship.orderBundle.orders[0].outcome, saved, "normal loading preserves an unpaid outcome");
    assert.equal(resolveWorldShipBundleStop(holding, ship, { operationId: "retry-unpaid", bundleId: "bundle", random: neverRoll }).pending, true);
    adjustWorldShipFunds(holding, ship, { operationId: "topup", voyageId: "bundle", kind: "income", amountCopper: saved.expenseCopper + 10000, reason: "Test funding" });
    const before = ship.onboardCopper;
    result = resolveWorldShipBundleStop(holding, ship, { operationId: "retry-funded", bundleId: "bundle", random: neverRoll });
    assert.equal(ship.onboardCopper, before - saved.expenseCopper + saved.rewardCopper, "the shared repair and delay are charged once");
    assert.deepEqual(ship.orderBundle.stops[0].physicalResolution, physical);
  }
  assert.equal(result.pending, false);
  const unloaded = structuredClone(holding.special.ships.history.find(row => row.id === "bundle:a"));
  const afterFirst = ship.onboardCopper;
  assert.throws(() => resolveWorldShipBundleStop(holding, ship, { operationId: "repeat-a", bundleId: "bundle", random: neverRoll }));
  assert.equal(ship.onboardCopper, afterFirst);
  const leave = ship.orderBundle.delayUntilQd ?? holding.gm.calendaria.lastQd;
  holding.gm.calendaria.lastQd = leave;
  advanceWorldShips(holding, leave);
  assert.equal(ship.onboardCopper, afterFirst, "already paid event delay is not billed as idle time");
  holding = mergeHoldingDefaults(JSON.parse(JSON.stringify(holding)));
  data.holdings[0] = holding; ship = holding.special.ships.list[0];
  continueWorldShipBundle(holding, ship, { operationId: "continue", bundleId: "bundle", clockQd: leave });
  arrive();
  resolveWorldShipBundleStop(holding, ship, { operationId: "resolve-b", bundleId: "bundle", random: eventDraws(lastSeverity) });
  assert.deepEqual(holding.special.ships.history.find(row => row.id === "bundle:a"), unloaded, "later events cannot affect discharged cargo");
  for (const id of ["b", "pickup"]) {
    const row = holding.special.ships.history.find(entry => entry.id === `bundle:${id}`);
    const earlierDamage = id === "b" && firstSeverity === 1 ? 0.75 : 1;
    const laterDamage = lastSeverity === 1 ? 0.75 : 1;
    const allowedBonus = lastSeverity == null && (id === "pickup" || firstSeverity == null);
    const expected = Math.ceil(row.contract.rewardCopper * earlierDamage * laterDamage)
      + (allowedBonus ? Math.ceil(row.contract.rewardCopper * 0.02) : 0);
    assert.equal(row.outcome.rewardCopper, expected, `${id}: only this order's loaded passages determine the bonus`);
  }
  const afterLast = ship.onboardCopper;
  assert.throws(() => resolveWorldShipBundleStop(holding, ship, { operationId: "repeat-b", bundleId: "bundle", random: neverRoll }));
  assert.equal(ship.onboardCopper, afterLast);
}

function quotePrices(settings = {}) {
  const f = transportFixture();
  f.data.catalog.marketEconomy.settings = { ...f.data.catalog.marketEconomy.settings, ...settings };
  const request = transportRequest(f);
  request.quantities = Object.fromEntries(Object.keys(request.quantities).map(id => [id, 100]));
  const preview = prepareTransportContext({ ...f, request, isGM: true });
  const offers = generateWorldShipOffers(f.data, f.holding, f.ship, { period: 0, random: () => 0.4 });
  return { f, request, preview, offers };
}

async function checkConfiguredFares() {
  const original = quotePrices();
  for (const settings of [{ airshipHireCopper: 1200 }, { deliveryDistanceCopper: 100 }, { deliveryLoadDistanceCopper: 0.1 }]) {
    const changed = quotePrices(settings);
    assert.ok(changed.preview.plan.totalCopper > original.preview.plan.totalCopper);
    for (const kind of ["freight", "commission"]) {
      assert.ok(changed.offers.find(row => row.kind === kind).contract.economics.marketFeeCopper
        > original.offers.find(row => row.kind === kind).contract.economics.marketFeeCopper, `${kind} must use ${Object.keys(settings)[0]}`);
    }
    assert.ok(changed.offers.filter(row => row.kind === "freight").every(row => row.contract.rewardCopper <= row.contract.economics.customerBudgetCopper));
    const accepted = original.offers[0];
    assert.equal(repriceWorldShipOffer(changed.f.data, changed.f.holding, changed.f.ship, accepted).contract.rewardCopper,
      accepted.contract.rewardCopper, "an existing offer keeps its agreed fee");
    assert.notEqual(changed.preview.sourceToken, original.preview.sourceToken, "a settings edit invalidates the old transport preview");
  }
  const expensive = quotePrices({ airshipHireCopper: 1000000 });
  assert.ok(!expensive.offers.some(row => row.kind === "freight"), "unaffordable freight is filtered, not capped into an unprofitable offer");
  for (const isGM of [true, false]) {
    const h = transportHarness(original.f);
    const { order } = await h.book(original.request, `accepted-${isGM}`, isGM);
    const saved = structuredClone(order.plan);
    assert.ok(saved?.stages?.length, "the booked plan must exist before checking its immutability");
    h.data.catalog.marketEconomy.settings = { airshipHireCopper: 12000 };
    assert.deepEqual(order.plan, saved, "a booked shipment is independent of subsequent tariff edits");
  }
  const h = shipHarness(original.f);
  const command = { holdingId: original.f.holding.id, shipId: original.f.ship.id, locationKind: "home", locationId: original.f.holding.id };
  await h.execute({ ...command, type: "generate-world", operationId: "old-board", expectedRevision: 1 }, { userId: "gm" });
  const oldOffers = structuredClone(h.holding.special.ships.offers);
  h.data.catalog.marketEconomy.settings = { airshipHireCopper: 1200 };
  h.data.meta.revision++;
  const refresh = { ...command, type: "reroll-world", operationId: "updated-board", expectedRevision: h.data.meta.revision };
  await assert.rejects(h.execute(refresh, { userId: "player", remote: true }), /Нет права/);
  await h.execute(refresh, { userId: "gm" });
  assert.ok(h.holding.special.ships.offers[0].contract.rewardCopper > oldOffers[0].contract.rewardCopper,
    "the actual GM board refresh uses the changed market setting");
  const saved = JSON.stringify(h.data);
  assert.equal((await h.execute(refresh, { userId: "gm" })).replay, true);
  assert.equal(JSON.stringify(h.data), saved);
}

async function checkLocalExecution() {
  for (const isGM of [true, false]) for (const direction of ["inbound", "outbound"]) {
    const f = transportFixture(); f.holding.gm.modifiers.marketLocalDistanceKm = 0;
    const h = transportHarness(f);
    const request = transportRequest(f, "home", { direction, ownShipId: f.ship.id, returnHome: false }, isGM);
    const { order } = await h.book(request, `zero-${direction}-${isGM}`, isGM);
    h.advance(order.plan.shipReleaseQd);
    assert.equal(order.status, "delivered");
    assert.equal(h.ship.location.kind, direction === "outbound" ? "market" : "home");
    if (direction === "outbound") {
      const returning = shipHarness(h.fixture());
      const command = { type: "return-home", operationId: "zero-return", holdingId: f.holding.id, shipId: f.ship.id,
        locationKind: "market", locationId: "home", expectedRevision: returning.data.meta.revision };
      assert.equal((await returning.execute(command, { userId: isGM ? "gm" : "player", remote: !isGM })).ok, true);
      const ship = returning.holding.special.ships.list[0];
      assert.equal(ship.activeVoyage, null);
      assert.equal(ship.location.kind, "home", "authority completes a zero-distance return immediately");
      assert.equal((await returning.execute(command, { userId: isGM ? "gm" : "player", remote: !isGM })).replay, true);
    }
  }
}

function checkLocalDistance() {
  for (const km of [0, 0.001, 20, 200]) for (const outward of [true, false]) {
    const f = transportFixture();
    f.holding.gm.modifiers.marketLocalDistanceKm = km;
    const terms = worldShipTransportTerms(f.data, f.holding, f.ship, "home", "home", { loadPoints: 40, fromHome: outward, toHome: !outward });
    assert.equal(terms.distanceKm, km);
    assert.equal(terms.durationQd, Math.ceil(km * 4 / f.ship.speedKmPerDay));
    assert.ok(terms.loadingQd > 0 && terms.unloadingQd > 0, "zero flight still has cargo operations");
    if (km === 0) assert.equal(terms.riskExposureQd, 0);
    for (const ownShipId of ["", f.ship.id]) for (const isGM of [true, false]) {
      const request = transportRequest(f, "home", { direction: outward ? "outbound" : "inbound", ownShipId }, isGM);
      const { plan } = prepareTransportContext({ ...f, request, isGM });
      assert.equal(plan.stages.reduce((sum, stage) => sum + stage.service.distanceKm, 0), km);
      if (km === 0) for (const stage of plan.stages) {
        assert.equal(stage.service.travelQd, 0);
        assert.equal(stage.service.riskBps, 0);
        if (ownShipId) {
          assert.equal(stage.service.approachQd, 0);
          assert.equal(stage.service.returnQd, 0);
        }
        assert.ok(stage.runs.every(run => run.arrivalQd > run.startQd), "cargo processing still takes time");
      }
    }
    const remote = worldShipTransportTerms(f.data, f.holding, f.ship, "home", "a", { context: buildShipWorldContext(f.data, f.holding) });
    assert.equal(remote.distanceKm, 150, "local settings cannot replace a world link");
    f.ship.status = "away"; f.ship.onboardCopper = 10000;
    f.ship.location = { kind: "market", id: "home", regionId: "home", label: "Local port" };
    const home = quoteWorldShipReturn(f.data, f.holding, f.ship);
    assert.equal(home.quote.durationQd, terms.durationQd);
    assert.equal(departWorldShip(f.holding, f.ship, { operationId: "local-home", offer: home, clockQd: 0 }).ok, true);
    const arrived = advanceWorldShips(f.holding, home.quote.durationQd);
    assert.equal(arrived.blocked.length, 0);
    assert.equal(arrived.returned.length, 1, "an empty local return must execute, including at the same clock");
    assert.equal(f.ship.location.kind, "home");
    assert.equal(advanceWorldShips(f.holding, home.quote.durationQd).returned.length, 0, "arrival cannot repeat");
  }
}

function checkFreightFallback() {
  const f = worldMarketFixture();
  f.data.catalog.resources = [{ id: "wood", label: "Wood", basePriceCopper: 4, loadPoints: 4 },
    { id: "gemstones", label: "Gems", basePriceCopper: 1200, loadPoints: 1 }];
  const goods = [
    { id: "bulk", resourceId: "wood", name: "Wood", kind: "resource", ubiquity: "essential", baseStock: 2000, baseDemand: 2000, priceOverrideCopper: 4, active: true },
    { id: "rare", resourceId: "gemstones", name: "Gems", kind: "resource", ubiquity: "essential", baseStock: 3, baseDemand: 20, priceOverrideCopper: 1200, active: true }
  ];
  f.data.catalog.marketEconomy.baseOffers = [goods[1]];
  const rareOnly = generateWorldShipOffers(f.data, f.holding, f.ship, { period: 0, random: () => 0.4 }).filter(row => row.kind === "freight");
  assert.ok(rareOnly.length);
  f.data.catalog.marketEconomy.baseOffers = goods;
  const withBulk = generateWorldShipOffers(f.data, f.holding, f.ship, { period: 0, random: () => 0.4 }).filter(row => row.kind === "freight");
  assert.equal(withBulk.length, rareOnly.length, "unaffordable bulk cargo must not hide a viable smaller consignment");
  assert.ok(withBulk.every(row => row.contract.cargo.resourceId === "gemstones" && row.contract.cargo.quantity === 60
    && row.contract.rewardCopper <= row.contract.economics.customerBudgetCopper));
}

function checkCommonRates() {
  const f = worldMarketFixture(), world = buildShipWorldContext(f.data, f.holding);
  const origin = world.ports.find(port => port.id === "a"), destination = world.ports.find(port => port.id === "b");
  Object.assign(origin, { airshipHireCopper: 1200, deliveryDistanceCopper: 1.5, deliveryLoadDistanceCopper: 0.2 });
  for (const loadPoints of [400, 1200, 3000]) for (const carrierProfitBps of [0, 2000, 5000]) {
    const configuration = validateTransportConfiguration({ riskBps: 0, carrierProfitBps });
    let profile, route;
    const fare = customerTransportFare({ cargo: { kind: "freight", loadPoints }, origin, destination, resources: world.resources, configuration,
      referenceRoute: value => {
        profile = value;
        route = worldShipTransportTerms(f.data, f.holding, { ...f.ship, ...profile }, "a", "b", { context: world });
        return route;
      } });
    const leg = { fromRegionId: "a", toRegionId: "b", fromCountryId: "public", toCountryId: "public",
      routeId: "equal-terms", carrierId: "carrier", mode: "airship", capacityLoad: profile.capacityLoadPoints / 4,
      movementQd: route.durationQd, distanceKm: route.distanceKm, riskFactor: 1, operatingFactor: 1,
      ...configuredTransportCharges({ mode: "airship", distanceKm: route.distanceKm, settings: origin, dispatchCopper: 20 }) };
    const service = transportServicesFromRoutes([{ transportPlan: { direction: "outbound", legs: [leg] } }], configuration, world.regions,
      { markets: world.ports, resources: world.resources })[0];
    assert.equal(fare.marketFeeCopper, transportServiceCharge(service, loadPoints * 1000, 0).totalCopper,
      "equal capacity, time, ports and settings give equal client and hired base fares");
  }
  const local = { id: "zero-charter", kind: "charter", from: "warehouse", to: "port", distanceKm: 0,
    capacity: 10, travelQd: 0, loadingQd: 1, unloadingQd: 1, loadingCapacity: 10, unloadingCapacity: 10,
    operatingCopperPerQd: 1, returnQd: 0 };
  const plan = planTransportChain({ cargo: [{ lotId: "lot", qty: 25, unitLoad: 1, unitCopper: 1 }], services: [local] });
  assert.equal(plan.stages[0].runs.length, 3);
  assert.ok(plan.stages[0].runs.every(run => run.releaseLocation === "warehouse" && run.releaseQd > run.startQd),
    "zero-distance charter still processes each load and returns to its base");
}

const contract = { kind: "freight", rewardCopper: 1000,
  economics: { version: 1, riskBps: 0, repairCopper: 10, delayDailyCopper: 10, precautionCopper: 1 } };
const quiet = { commercialDice: [3, 4], incidentRoll: 12, passageRoll: 10000 };
assert.equal(resolveContractOutcome(contract, "bold", { ...quiet, sharedPassageAllowsBonus: false }).rewardCopper, 1000);
assert.equal(resolveContractOutcome(contract, "bold", { ...quiet, sharedIncident: { delayQd: 0, damagePercent: 0, cargoRewardPercent: 75 } }).rewardCopper, 750);
for (const severity of [1, 6, null]) checkBundle(severity);
checkBundle(null, 1);
await checkConfiguredFares();
checkLocalDistance();
await checkLocalExecution();
checkFreightFallback();
checkCommonRates();
console.log("Transport economy regressions: cumulative bonuses, reload/retry, configured fares/budgets, board refresh, accepted terms, zero local execution, smaller freight and GM/player passed.");
