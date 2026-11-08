import assert from "node:assert/strict";
import { transportFixture } from "./fixtures/transport-v2.mjs";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { generateWorldShipOffers, repriceWorldShipOffer, quoteWorldShipBundle } from "../engines/ships/world-market.js";
import { departWorldShip, advanceWorldShips, resolveWorldShip, departWorldShipBundle, resolveWorldShipBundleStop, continueWorldShipBundle } from "../engines/ships/world-voyage.js";
import { createShipOperationExecutor } from "../apps/ship-operation-executor.js";
import { prepareShipWindowContext } from "../apps/ships-context.js";

const neverRoll = () => { throw new Error("A saved outcome was rerolled"); };
function fixture({ home = false, lifetime = 16, distance = 300, approach = 150 } = {}) {
  const f = transportFixture();
  f.data.catalog.resources = [{ id: "meat", label: "Мясо", basePriceCopper: 100, loadPoints: 4, shelfLifeQd: lifetime, foodRaw: true }];
  f.data.catalog.marketEconomy.baseOffers = [{ id: "meat", resourceId: "meat", name: "Мясо", kind: "resource",
    ubiquity: "essential", baseStock: 2000, baseDemand: 2000, priceOverrideCopper: 100, active: true }];
  f.data.catalog.eventRegions.find(row => row.value === "home").marketLinks[0].distanceKm = approach;
  f.data.catalog.eventRegions.find(row => row.value === "a").marketLinks[0].distanceKm = distance;
  f.data.catalog.transportV2.riskBps = 300;
  if (!home) {
    f.ship.status = "away"; f.ship.location = { kind: "market", id: "a", regionId: "a", label: "a" };
    f.ship.onboardCopper = 100000;
  }
  return f;
}
const offers = f => generateWorldShipOffers(f.data, f.holding, f.ship, { period: 0, random: () => 0.4 });
const arrive = f => {
  const target = f.ship.activeVoyage.arrivalQd;
  f.holding.gm.calendaria.lastQd = target;
  const report = advanceWorldShips(f.holding, target);
  assert.equal(report.blocked.length, 0);
  return target;
};
function draws(values) { return () => values.shift() ?? 0.5; }

{
  const f = fixture({ distance: 2000 }), before = JSON.stringify(f.data);
  assert.ok(!offers(f).some(row => row.kind === "freight"), "the generator rejects meat that cannot arrive fresh");
  assert.equal(JSON.stringify(f.data), before, "the rejected candidate does not change stocks or world data");
}
{
  const f = fixture({ distance: 40, lifetime: 8 });
  assert.ok(!offers(f).some(row => row.kind === "freight"), "loading and unloading count toward lifetime even on a short flight");
}
{
  const f = fixture(), offer = offers(f).find(row => row.kind === "freight"), original = structuredClone(offer);
  assert.equal(offer.contract.cargo.shelfLifeQd, 16);
  f.ship.speedKmPerDay = 10;
  assert.throws(() => repriceWorldShipOffer(f.data, f.holding, f.ship, offer), /Срок годности/);
  assert.deepEqual(offer, original, "an invalid requote cannot overwrite the free offer");
}
{
  let f = fixture(), offer = offers(f).find(row => row.kind === "freight");
  departWorldShip(f.holding, f.ship, { operationId: "food-solo", offer, clockQd: 0 });
  arrive(f); f.ship.onboardCopper = 0;
  const pending = resolveWorldShip(f.holding, f.ship, { operationId: "food-outcome", random: draws([0.5, 0.5, 0, 0]) });
  assert.equal(pending.pending, true);
  assert.equal(pending.outcome.rewardCopper, 0, "a late damaged consignment is also assessed for expiry");
  const saved = structuredClone(pending.outcome);
  const holding = mergeHoldingDefaults(JSON.parse(JSON.stringify(f.holding)));
  f = { ...f, holding, ship: holding.special.ships.list[0] };
  f.ship.onboardCopper = 100000;
  const result = resolveWorldShip(f.holding, f.ship, { operationId: "food-paid-retry", random: neverRoll });
  assert.deepEqual(result.outcome, saved, "reload and funding keep the original saved result");
  assert.ok(result.outcome.expenseCopper > 0, "spoilage does not erase physical repair and delay expenses");
}
{
  const f = fixture({ home: true, lifetime: 10, distance: 40, approach: 3000 });
  const offer = offers(f).find(row => row.kind === "freight");
  assert.ok(offer && offer.quote.durationQd > offer.contract.cargo.shelfLifeQd,
    "an empty approach does not age a customer's cargo before handover");
  departWorldShip(f.holding, f.ship, { operationId: "approach-food", offer, clockQd: 0 });
  arrive(f);
  const result = resolveWorldShip(f.holding, f.ship, { operationId: "approach-event", random: draws([0.5, 0.5, 0, 0]) });
  assert.equal(result.outcome.rewardCopper, offer.contract.rewardCopper, "a pre-pickup delay cannot spoil fresh cargo");
}
{
  const f = fixture(), offer = offers(f).find(row => row.kind === "freight");
  delete offer.contract.cargo.shelfLifeQd; delete offer.contract.cargo.ageAtQd; delete offer.contract.cargo.ageQd;
  f.ship.speedKmPerDay = 10;
  const accepted = repriceWorldShipOffer(f.data, f.holding, f.ship, offer);
  departWorldShip(f.holding, f.ship, { operationId: "legacy-food", offer: accepted, clockQd: 0 });
  arrive(f);
  const result = resolveWorldShip(f.holding, f.ship, { operationId: "legacy-event", random: () => 0.99 });
  assert.equal(result.outcome.rewardCopper, accepted.contract.rewardCopper, "old agreements retain their existing conditions");
}
function resized(f, source, id, load, lifetime = null) {
  const row = structuredClone(source); row.id = id;
  Object.assign(row.contract.cargo, { quantity: load / 4, loadPoints: load, valueCopper: load * 25 });
  if (lifetime !== null) row.contract.cargo.shelfLifeQd = lifetime;
  return repriceWorldShipOffer(f.data, f.holding, f.ship, row);
}
{
  const f = fixture({ lifetime: 100 }), source = offers(f).find(row => row.kind === "freight");
  const one = resized(f, source, "single", 1200), pair = [resized(f, source, "left", 600), resized(f, source, "right", 600)];
  const unchanged = structuredClone(pair), plan = quoteWorldShipBundle(f.data, f.holding, f.ship, pair);
  assert.equal(plan.totalDurationQd, one.quote.durationQd);
  assert.equal(plan.totalOperatingCopper, one.quote.operatingCopper, "equal physical work has equal port time and costs");
  assert.deepEqual(pair, unchanged, "bundle quotation does not edit the source offers");
}
{
  const f = fixture(), source = offers(f).find(row => row.kind === "freight");
  const pair = [resized(f, source, "first", 600, 14), resized(f, source, "second", 600, 14)];
  const plan = quoteWorldShipBundle(f.data, f.holding, f.ship, pair);
  departWorldShipBundle(f.holding, f.ship, { operationId: "food-bundle", plan, clockQd: 0 });
  arrive(f);
  resolveWorldShipBundleStop(f.holding, f.ship, { operationId: "food-bundle-event", bundleId: "food-bundle",
    random: draws([0, 0, 0.5, 0.5, 0.5, 0.5]) });
  const history = f.holding.special.ships.history.filter(row => row.id.startsWith("food-bundle:") && row.contract);
  assert.equal(history.length, 2);
  assert.ok(history.every(row => row.outcome.rewardCopper === 0));
  assert.equal(history.filter(row => row.outcome.expenseCopper > 0).length, 1, "a common physical delay/repair is paid only once");
}
{
  const f = fixture({ lifetime: 100 }), source = offers(f).find(row => row.kind === "freight");
  const a = f.data.catalog.eventRegions.find(row => row.value === "a");
  a.marketLinks = [{ regionId: "b", distanceKm: 100, modes: ["airship"] }, { regionId: "c", distanceKm: 40, modes: ["airship"] }];
  f.data.catalog.eventRegions.push({ value: "c", label: "c", countryId: "public", marketTransportModes: ["airship"], marketLinks: [] });
  const first = resized(f, source, "urgent-food", 600, 7), other = structuredClone(source);
  other.id = "durable-second"; other.to = { kind: "market", id: "c", regionId: "c", label: "c" };
  other.contract.destination = "c"; other.contract.directionKey = "port:c";
  Object.assign(other.contract.cargo, { quantity: 150, loadPoints: 600, valueCopper: 15000 });
  const plan = quoteWorldShipBundle(f.data, f.holding, f.ship, [first, repriceWorldShipOffer(f.data, f.holding, f.ship, other)]);
  assert.deepEqual(plan.stops.map(stop => stop.point.id), ["b", "c"],
    "route search finds a feasible fresh delivery instead of rejecting the board after choosing a faster expired route");
}
{
  const f = fixture({ lifetime: 100 }), source = offers(f).find(row => row.kind === "freight");
  f.data.catalog.eventRegions.find(row => row.value === "b").marketLinks = [{ regionId: "c", distanceKm: 40, modes: ["airship"] }];
  f.data.catalog.eventRegions.push({ value: "c", label: "c", countryId: "public", marketTransportModes: ["airship"], marketLinks: [] });
  const first = resized(f, source, "before-pickup", 600);
  const later = structuredClone(source); later.id = "later-pickup";
  later.contract.pickup = { kind: "market", id: "b", regionId: "b", label: "b" };
  later.to = { kind: "market", id: "c", regionId: "c", label: "c" }; later.contract.destination = "c"; later.contract.directionKey = "port:c";
  Object.assign(later.contract.cargo, { quantity: 150, loadPoints: 600, valueCopper: 15000, shelfLifeQd: 5 });
  const priced = repriceWorldShipOffer(f.data, f.holding, f.ship, later);
  const plan = quoteWorldShipBundle(f.data, f.holding, f.ship, [first, priced]);
  departWorldShipBundle(f.holding, f.ship, { operationId: "pickup-bundle", plan, clockQd: 0 });
  arrive(f);
  resolveWorldShipBundleStop(f.holding, f.ship, { operationId: "pickup-first-event", bundleId: "pickup-bundle", random: draws([0.5, 0, 0.5, 0.5]) });
  const leave = f.ship.orderBundle.delayUntilQd;
  f.holding.gm.calendaria.lastQd = leave; advanceWorldShips(f.holding, leave);
  continueWorldShipBundle(f.holding, f.ship, { operationId: "pickup-continue", bundleId: "pickup-bundle", clockQd: leave });
  arrive(f);
  resolveWorldShipBundleStop(f.holding, f.ship, { operationId: "pickup-last-event", bundleId: "pickup-bundle", random: () => 0.99 });
  const delivered = f.holding.special.ships.history.find(row => row.id === "pickup-bundle:later-pickup");
  assert.equal(delivered.outcome.rewardCopper, priced.contract.rewardCopper, "earlier physical delays occur before this cargo's handover");
}
for (const isGM of [true, false]) {
  const f = fixture({ home: true }); f.holding.special.ships.offers = offers(f);
  const savedGame = globalThis.game;
  globalThis.game = { user: { id: isGM ? "gm" : "player", isGM } };
  try {
    const context = prepareShipWindowContext(f.holding, { data: f.data, shipId: f.ship.id });
    assert.ok(context.rows[0].offers.find(row => row.kind === "freight").cargoFreshnessHint.includes("4 дн."),
      "GM/player offer details explain the accepted lifetime");
  } finally { globalThis.game = savedGame; }
  let data = structuredClone(f.data), random = () => 0.99;
  const skipToken = Symbol("skip");
  const execute = createShipOperationExecutor({
    getUser: id => ({ id, isGM: id === "gm" }), random: () => random(),
    skip: value => ({ [skipToken]: true, value }),
    updateHolding: async (_id, updater) => {
      const draft = structuredClone(data), result = await updater(draft.holdings[0], draft);
      if (result?.[skipToken]) return result.value;
      draft.meta.revision++; data = draft; return result;
    }
  });
  const actor = { userId: isGM ? "gm" : "player", remote: !isGM };
  const depart = { type: "depart-world", operationId: "authority-food-depart", holdingId: f.holding.id, shipId: f.ship.id,
    expectedRevision: data.meta.revision, offerId: f.holding.special.ships.offers.find(row => row.kind === "freight").id,
    locationKind: "home", locationId: f.holding.id, style: "normal" };
  await execute(depart, actor);
  const holding = data.holdings[0], ship = holding.special.ships.list[0];
  const terms = ship.activeVoyage.quote.contract.economics;
  holding.gm.calendaria.lastQd = ship.activeVoyage.arrivalQd; advanceWorldShips(holding, holding.gm.calendaria.lastQd); data.meta.revision++;
  random = draws([0.5, 0.5, 0, (terms.approachRiskBps + 0.5) / 10000]);
  const resolve = { type: "resolve-world", operationId: "authority-food-resolve", holdingId: holding.id, shipId: ship.id,
    voyageId: ship.activeVoyage.id, expectedRevision: data.meta.revision };
  await execute(resolve, actor);
  assert.equal(data.holdings[0].special.ships.list[0].activeVoyage.outcome.rewardCopper, 0);
  const saved = JSON.stringify(data);
  random = neverRoll;
  assert.equal((await execute(resolve, actor)).replay, true);
  assert.equal(JSON.stringify(data), saved, "GM/player command replay does not repeat spoilage or payment");
}
console.log("Client cargo: frozen freshness, generation/requote, empty approach, solo/bundle delay, later pickup, legacy agreements, reload/unpaid retry, equal port costs and GM/player replay passed.");
