import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { worldMarketFixture as homeMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { createShipOperationExecutor } from "../apps/ship-operation-executor.js";
import { shipOperationIntent } from "../apps/domains/events/ship-events.js";
import { buildShipWorldContext, generateWorldShipOffers, quoteWorldShipBundle, quoteWorldShipReturn, repriceWorldShipOffer } from "../engines/ships/world-market.js";
import { adjustWorldShipFunds, advanceWorldShips, continueWorldShipBundle, departWorldShip, departWorldShipBundle, resolveWorldShipBundleStop } from "../engines/ships/world-voyage.js";

// At-origin customer cargo now belongs to a foreign port, never to the home settlement.
function worldMarketFixture() {
  const result = homeMarketFixture();
  const { data, holding, ship } = result;
  data.catalog.eventRegions.push({ ...structuredClone(data.catalog.eventRegions[0]), value: "base", label: "base",
    marketEnabled: false, marketLinks: [{ regionId: "home", distanceKm: 40, modes: ["airship"] }] });
  holding.overview.region = "base";
  holding.storage.moneyCopper = 450000;
  ship.onboardCopper = 50000;
  ship.status = "away";
  ship.location = { kind: "market", id: "home", regionId: "home", label: "Порт отправителя" };
  return result;
}

function smallOffer(source, id, destination, loadPoints, pickup = null) {
  const offer = structuredClone(source);
  offer.id = id;
  offer.title = `Партия ${id}`;
  offer.to = { kind: "market", id: destination, regionId: destination, label: destination };
  offer.contract.destination = destination;
  offer.contract.directionKey = `port:${destination}`;
  offer.contract.cargo.quantity = loadPoints / 4;
  offer.contract.cargo.loadPoints = loadPoints;
  offer.contract.cargo.valueCopper = loadPoints * 8;
  if (pickup) offer.contract.pickup = { kind: "market", id: pickup, regionId: pickup, label: pickup };
  else delete offer.contract.pickup;
  return offer;
}

export function checkShipMultiorder() {
  const { data, holding, ship } = worldMarketFixture();
  const source = generateWorldShipOffers(data, holding, ship, { period: 0, random: () => 0.4 })[0];
  const board = generateWorldShipOffers(data, holding, ship, { period: 0, random: () => 0.4 });
  const paired = quoteWorldShipBundle(data, holding, ship, [board[0], board[1]]);
  assert.equal(paired.offers.length, 2, "the existing board can offer a usable freight and small-charter pair");
  const world = buildShipWorldContext(data, holding);
  const first = repriceWorldShipOffer(data, holding, ship, smallOffer(source, "job-a", "a", 1200), { context: world });
  const second = repriceWorldShipOffer(data, holding, ship, smallOffer(source, "job-b", "b", 1200), { context: world });
  const third = repriceWorldShipOffer(data, holding, ship, smallOffer(source, "job-pickup", "b", 600, "a"), { context: world });
  const before = JSON.stringify(data);
  const plan = quoteWorldShipBundle(data, holding, ship, [first, second, third], { context: world });
  assert.equal(JSON.stringify(data), before, "planning does not change the market or holding");
  assert.deepEqual(plan.stops.map((stop) => stop.point.id), ["a", "b"]);
  assert.deepEqual(plan.stops[0].deliveryOfferIds, ["job-a"]);
  assert.deepEqual(plan.stops[0].pickupOfferIds, ["job-pickup"]);
  assert.equal(plan.initialLoadPoints, 2400);
  assert.deepEqual(plan.stops.map((stop) => [stop.loadOnLegPoints, stop.loadAfterPoints]), [[2400, 1800], [1800, 0]]);
  assert.equal(plan.stops[0].legOffer.quote.durationQd, 11, "first leg combines 4 QD flight, 3 QD loading and a 4 QD port rest");
  assert.equal(plan.stops[1].legOffer.quote.durationQd, 12, "second leg combines 8 QD flight with a 4 QD rest/handling stop");
  assert.ok(plan.totalOperatingCopper < first.quote.operatingCopper + second.quote.operatingCopper + third.quote.operatingCopper,
    "shared travel and crew costs must not be billed as three independent voyages");
  const overfull = repriceWorldShipOffer(data, holding, ship, smallOffer(source, "job-overfull", "b", 3000), { context: world });
  assert.throws(() => quoteWorldShipBundle(data, holding, ship, [first, overfull], { context: world }), /не помещаются/);

  const departure = departWorldShipBundle(holding, ship, { operationId: "bundle-1", plan, clockQd: 0 });
  assert.equal(departure.ok, true);
  assert.equal(ship.orderBundle.orders.length, 3);
  assert.equal(ship.currentOuting.plannedRewardCopper, first.contract.rewardCopper + second.contract.rewardCopper + third.contract.rewardCopper);
  assert.equal(ship.activeVoyage.quote.contract, null);
  const firstArrival = ship.activeVoyage.arrivalQd;
  const landed = advanceWorldShips(holding, firstArrival);
  assert.equal(landed.arrived.length, 1);
  assert.equal(ship.location.id, "a");
  assert.equal(ship.orderBundle.status, "awaiting-outcome");
  assert.equal(ship.orderBundle.orders.find((order) => order.offerId === "job-pickup").state, "loaded");
  const firstResult = resolveWorldShipBundleStop(holding, ship, { operationId: "resolve-a", bundleId: "bundle-1", random: () => 0.99 });
  assert.equal(firstResult.pending, false);
  assert.deepEqual(firstResult.completedOrders, ["job-a"]);
  assert.equal(ship.orderBundle.status, "at-port");
  const afterFirst = ship.onboardCopper;
  assert.throws(() => resolveWorldShipBundleStop(holding, ship, { operationId: "repeat-a", bundleId: "bundle-1" }), /нет заказов/);
  assert.equal(ship.onboardCopper, afterFirst);
  const next = continueWorldShipBundle(holding, ship, { operationId: "bundle-leg-2", bundleId: "bundle-1", clockQd: firstArrival });
  assert.equal(next.ok, true);
  assert.equal(ship.orderBundle.status, "travelling");
  const secondArrival = ship.activeVoyage.arrivalQd;
  holding.gm.calendaria.lastQd = secondArrival;
  advanceWorldShips(holding, secondArrival);
  let finalDraws = 0;
  const final = resolveWorldShipBundleStop(holding, ship, { operationId: "resolve-b", bundleId: "bundle-1", random: () => { finalDraws++; return 0.99; } });
  assert.equal(final.pending, false);
  assert.equal(final.completedOrders.length, 2);
  assert.equal(finalDraws, 5, "two commercial outcomes share one road-incident roll at the same port");
  assert.equal(ship.orderBundle, null);
  assert.equal(ship.location.id, "b");
  const afterFinal = ship.onboardCopper;
  advanceWorldShips(holding, secondArrival);
  assert.equal(ship.onboardCopper, afterFinal, "repeated tenday processing cannot pay twice");
  const orderRows = holding.special.ships.history.filter((row) => row.contract && row.id.startsWith("bundle-1:"));
  assert.equal(orderRows.length, 3);
  assert.equal(new Set(orderRows.map((row) => row.id)).size, 3);
  const homeward = departWorldShip(holding, ship, {
    operationId: "bundle-return", offer: quoteWorldShipReturn(data, holding, ship), clockQd: secondArrival
  });
  assert.equal(homeward.ok, true);
  const returned = advanceWorldShips(holding, ship.activeVoyage.arrivalQd);
  assert.equal(returned.returned.length, 1);
  assert.equal(ship.location.kind, "home");
  assert.equal(ship.onboardCopper, 0);
  assert.equal(ship.currentOuting, undefined);
  assert.ok(ship.lastOuting?.incomeCopper > 0, "the complete outing contains all delivered fees");
  assert.equal(holding.storage.moneyCopper, 500000 + ship.lastOuting.incomeCopper - ship.lastOuting.expenseCopper,
    "the outing result reconciles with the settlement treasury after the whole bundle returns");

  const blockedFixture = worldMarketFixture();
  const blockedWorld = buildShipWorldContext(blockedFixture.data, blockedFixture.holding);
  const blockedSource = generateWorldShipOffers(blockedFixture.data, blockedFixture.holding, blockedFixture.ship, { period: 0, random: () => 0.4 })[0];
  const blockedOffers = [smallOffer(blockedSource, "blocked-a", "a", 1200), smallOffer(blockedSource, "blocked-b", "b", 1200)]
    .map((offer) => repriceWorldShipOffer(blockedFixture.data, blockedFixture.holding, blockedFixture.ship, offer, { context: blockedWorld }));
  const blockedPlan = quoteWorldShipBundle(blockedFixture.data, blockedFixture.holding, blockedFixture.ship, blockedOffers, { context: blockedWorld });
  departWorldShipBundle(blockedFixture.holding, blockedFixture.ship, { operationId: "blocked-bundle", plan: blockedPlan, clockQd: 0 });
  const blockedArrival = blockedFixture.ship.activeVoyage.arrivalQd;
  blockedFixture.holding.gm.calendaria.lastQd = blockedArrival;
  advanceWorldShips(blockedFixture.holding, blockedArrival);
  blockedFixture.ship.onboardCopper = 0;
  const unpaid = resolveWorldShipBundleStop(blockedFixture.holding, blockedFixture.ship, {
    operationId: "unpaid-outcome", bundleId: "blocked-bundle", random: () => 0.01
  });
  assert.equal(unpaid.pending, true);
  const saved = structuredClone(blockedFixture.ship.orderBundle.orders[0].outcome);
  assert.ok(saved.expenseCopper > 0);
  adjustWorldShipFunds(blockedFixture.holding, blockedFixture.ship, {
    operationId: "gm-topup", voyageId: "blocked-bundle", kind: "income",
    amountCopper: saved.expenseCopper + 10000, reason: "Помощь в порту"
  });
  const settled = resolveWorldShipBundleStop(blockedFixture.holding, blockedFixture.ship, {
    operationId: "settle-saved", bundleId: "blocked-bundle", random: () => { throw new Error("Outcome rerolled"); }
  });
  assert.equal(settled.pending, false);
  assert.deepEqual(blockedFixture.ship.orderBundle.orders[0].outcome, saved, "funding a saved result never rerolls it");
  assert.ok(settled.delayQd > 0);
  assert.throws(() => continueWorldShipBundle(blockedFixture.holding, blockedFixture.ship, {
    operationId: "too-early", bundleId: "blocked-bundle", clockQd: blockedArrival
  }), /задержан/);
  const copperBeforeDelay = blockedFixture.ship.onboardCopper;
  advanceWorldShips(blockedFixture.holding, settled.delayUntilQd);
  assert.equal(blockedFixture.ship.onboardCopper, copperBeforeDelay, "event delay upkeep is not charged twice as port idle time");

  const waiting = worldMarketFixture();
  const waitingSource = generateWorldShipOffers(waiting.data, waiting.holding, waiting.ship, { period: 0, random: () => 0.4 })[0];
  const waitingWorld = buildShipWorldContext(waiting.data, waiting.holding);
  const waitingOffers = [smallOffer(waitingSource, "waiting-a", "a", 1200), smallOffer(waitingSource, "waiting-b", "b", 1200)]
    .map((offer) => repriceWorldShipOffer(waiting.data, waiting.holding, waiting.ship, offer, { context: waitingWorld }));
  const waitingPlan = quoteWorldShipBundle(waiting.data, waiting.holding, waiting.ship, waitingOffers, { context: waitingWorld });
  departWorldShipBundle(waiting.holding, waiting.ship, { operationId: "waiting-bundle", plan: waitingPlan, clockQd: 0 });
  advanceWorldShips(waiting.holding, 40);
  waiting.holding.gm.calendaria.lastQd = 40;
  resolveWorldShipBundleStop(waiting.holding, waiting.ship, { operationId: "waiting-stop", bundleId: "waiting-bundle", random: () => 0.99 });
  assert.equal(waiting.ship.orderBundle.status, "at-port");
  const firstStopQd = waiting.ship.timelineQd;
  advanceWorldShips(waiting.holding, 40);
  assert.equal(waiting.ship.timelineQd, firstStopQd, "same-tenday replay preserves the bundle decision window");
  const laterStop = advanceWorldShips(waiting.holding, 80);
  assert.equal(waiting.ship.timelineQd, 80, "uncontinued bundle cannot wait across tendays for free");
  assert.ok(laterStop.expenses.length || laterStop.blocked.length);
}

export async function checkShipMultiorderAuthority() {
  let { data, holding, ship } = worldMarketFixture();
  ship.name = "Тестовый барк"; // Ordinary ships may use the abstract part of their crew.
  holding.visibility = "public";
  holding.gm.playersCanManageShips = true;
  const source = generateWorldShipOffers(data, holding, ship, { period: 0, random: () => 0.4 })[0];
  holding.special.ships.offers = [smallOffer(source, "authority-a", "a", 1200), smallOffer(source, "authority-b", "b", 1200)];
  assert.deepEqual(shipOperationIntent({ type: "depart-bundle", holding, ship,
    card: {
      querySelectorAll: () => [{ value: "authority-a" }, { value: "authority-b" }],
      querySelector: (selector) => selector === "[data-ship-bundle-style]" ? { value: "bold" } : { value: "" }
    }, button: { closest: () => null }
  }), {
    type: "depart-bundle", holdingId: holding.id, shipId: ship.id,
    offerIds: ["authority-a", "authority-b"], style: "bold", budgetCopper: null,
    locationKind: "market", locationId: "home"
  }, "the window sends selected IDs and captain style through the GM command path");
  const gm = { id: "gm", isGM: true };
  const player = { id: "player", isGM: false };
  const skipToken = Symbol("skip");
  let commits = 0;
  const execute = createShipOperationExecutor({
    random: () => 0.99,
    getUser: (id) => id === gm.id ? gm : id === player.id ? player : null,
    skip: (value) => ({ [skipToken]: true, value }),
    updateHolding: async (id, updater) => {
      const draft = structuredClone(data);
      const target = draft.holdings.find((row) => row.id === id);
      const result = await updater(target, draft);
      if (result?.[skipToken]) return result.value;
      draft.meta.revision++;
      data = draft;
      commits++;
      return result;
    }
  });
  const depart = {
    type: "depart-bundle", operationId: "player-bundle", holdingId: holding.id, shipId: ship.id,
    expectedRevision: 1, offerIds: ["authority-a", "authority-b"], style: "normal",
    locationKind: "market", locationId: "home", budgetCopper: null
  };
  await assert.rejects(execute({ ...depart, offerIds: ["authority-a", "authority-a"] }, { userId: player.id, remote: true }), /разных заказ/);
  assert.equal(commits, 0);
  const started = await execute(depart, { userId: player.id, remote: true });
  assert.equal(started.ok, true);
  assert.equal(commits, 1);
  assert.equal((await execute(depart, { userId: player.id, remote: true })).replay, true);
  assert.equal(commits, 1, "socket retries must not accept or pay a bundle twice");
  assert.equal(data.holdings[0].special.ships.offers.filter((offer) => offer.consumedBy === started.bundleId).length, 2);
  await assert.rejects(execute({ type: "adjust", operationId: "player-cash", holdingId: holding.id, shipId: ship.id,
    expectedRevision: 2, voyageId: started.bundleId, locationKind: "transit", locationId: data.holdings[0].special.ships.list[0].location.id,
    kind: "income", amountCopper: 100, reason: "Пополнение" }, { userId: player.id, remote: true }), /Нет права/);
  assert.equal(commits, 1);
  const active = data.holdings[0].special.ships.list[0];
  const arrival = active.activeVoyage.arrivalQd;
  data.holdings[0].gm.calendaria.lastQd = arrival;
  advanceWorldShips(data.holdings[0], arrival);
  data.meta.revision++;
  await assert.rejects(execute({ type: "return-home", operationId: "leave-unfinished", holdingId: holding.id,
    shipId: ship.id, expectedRevision: data.meta.revision, locationKind: "market", locationId: "a"
  }, { userId: player.id, remote: true }), /после исполнения заказов/);
  const resolve = { type: "resolve-bundle", operationId: "player-resolve-a", holdingId: holding.id,
    shipId: ship.id, expectedRevision: data.meta.revision, voyageId: started.bundleId,
    locationKind: "market", locationId: "a" };
  const result = await execute(resolve, { userId: player.id, remote: true });
  assert.equal(result.pending, false);
  assert.equal((await execute(resolve, { userId: player.id, remote: true })).replay, true);
  const onward = await execute({ type: "continue-bundle", operationId: "player-onward", holdingId: holding.id,
    shipId: ship.id, expectedRevision: data.meta.revision, voyageId: started.bundleId,
    locationKind: "market", locationId: "a" }, { userId: player.id, remote: true });
  assert.equal(onward.ok, true);
  assert.equal(data.holdings[0].special.ships.list[0].orderBundle.status, "travelling");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkShipMultiorder();
  await checkShipMultiorderAuthority();
  console.log("Ship multiorder checks passed.");
}
