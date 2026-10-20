import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { calculateShipCosts, getShipProfile, SHIP_PROFILES } from "../engines/ships/profiles.js";
import {
  adjustWorldShipFunds,
  advanceWorldShips,
  departWorldShip,
  initializeWorldShip,
  resolveWorldShip
} from "../engines/ships/world-voyage.js";

function fixture(moneyCopper = 10_000) {
  const ship = {
    id: "magnifique",
    name: "Магнифик",
    status: "docked",
    condition: "ready",
    onboardCopper: 0,
    activeVoyage: null,
    attentionByDirection: {}
  };
  const holding = {
    id: "skyhold",
    name: "Небесная гавань",
    overview: { region: "home-region" },
    storage: { moneyCopper },
    gm: { calendaria: { lastQd: 0 } },
    special: { ships: { list: [ship], history: [] } }
  };
  initializeWorldShip(holding, ship, { profileId: "merchant-barque", clockQd: 0 });
  return { holding, ship };
}

function point(kind, id, label) {
  return { kind, id, regionId: `${id}-region`, label };
}

function offer(ship, from, to, {
  id = `${from.id}:${to.id}`,
  durationQd = 4,
  operatingCopper = 100,
  rewardCopper = 300,
  recommendedBudgetCopper = 600,
  idleUpkeepCopperPerDay = 40,
  returnReserveCopper = 80,
  contract = true
} = {}) {
  const quote = {
    durationQd,
    distanceKm: 150,
    speedKmPerDay: 150,
    operatingCopper,
    preparationCopper: 0,
    rewardCopper: contract ? rewardCopper : 0,
    costs: { totalCopper: operatingCopper },
    idleUpkeepCopperPerDay,
    recommendedBudgetCopper,
    returnReserveCopper
  };
  const terms = contract ? {
    kind: "freight",
    rewardCopper,
    directionKey: `port:${to.id}`,
    destination: to.label,
    attention: { level: 0, label: "Незнакомый флаг" },
    guidance: { operatingCopper, preparationCopper: 0 },
    routePlan: { upkeepPerDayCopper: idleUpkeepCopperPerDay }
  } : null;
  return { mode: "world", id, shipId: ship.id, period: "882-1", from, to, quote, contract: terms };
}

export function checkWorldShipCharacterization() {
  const barque = getShipProfile("merchant-barque");
  assert.equal(barque.speedKmPerDay, 150);
  assert.equal(barque.crewTarget, 36);
  assert.equal(barque.capacityLoadPoints, 4000);
  assert.equal(barque.cargoTonnes, 500);
  assert.ok(Object.isFrozen(SHIP_PROFILES) && Object.isFrozen(barque));
  assert.throws(() => getShipProfile("unknown"), /Неизвестный профиль/);

  const costs = calculateShipCosts({ profileId: "merchant-barque" }, {
    durationQd: 6,
    crewCount: 36,
    foodUnitCopper: 2,
    wageDailyCopper: 12,
    handlingLoadPoints: 1000,
    portFeeFactor: 150,
    cargoValueCopper: 1000,
    taxRate: 0.1
  });
  assert.deepEqual(costs, {
    foodCopper: 108,
    crewCopper: 648,
    upkeepCopper: 18,
    handlingCopper: 15,
    taxCopper: 100,
    operatingCopper: 889,
    totalCopper: 889
  });
  assert.equal(calculateShipCosts({ profileId: "cutter" }, { durationQd: 1, crewDailyCopper: 0 }).crewCopper, 0);
  assert.throws(() => calculateShipCosts({ profileId: "cutter" }, { durationQd: 4, handlingLoadPoints: 801 }), /погрузочный объём/);

  // Home upkeep uses the shared settlement treasury and never creates a hidden negative balance.
  const poor = fixture(10);
  const poorAdvance = advanceWorldShips(poor.holding, 4);
  assert.equal(poor.holding.storage.moneyCopper, 10);
  assert.equal(poor.ship.pendingPortBillCopper, 12);
  assert.equal(poorAdvance.blocked[0].pendingPortBillCopper, 12);
  const poorDeparture = departWorldShip(poor.holding, poor.ship, {
    operationId: "blocked-home",
    clockQd: 4,
    offer: offer(poor.ship, poor.ship.location, point("market", "a", "Порт А"), { operatingCopper: 0, recommendedBudgetCopper: 0, returnReserveCopper: 0, contract: false })
  });
  assert.equal(poorDeparture.ok, false);
  assert.equal(poor.ship.activeVoyage, null);
  assert.throws(() => initializeWorldShip(poor.holding, poor.ship, { profileId: "cutter", clockQd: 4 }), /уже подключён/);

  const homeWallet = fixture();
  adjustWorldShipFunds(homeWallet.holding, homeWallet.ship, { operationId: "wallet-fund", kind: "deposit", amountCopper: 100 });
  assert.equal(homeWallet.holding.storage.moneyCopper, 9900);
  assert.equal(homeWallet.ship.onboardCopper, 100);
  advanceWorldShips(homeWallet.holding, 4);
  assert.equal(homeWallet.ship.onboardCopper, 88, "home upkeep spends the ship wallet before settlement money");
  assert.equal(homeWallet.holding.storage.moneyCopper, 9900);
  adjustWorldShipFunds(homeWallet.holding, homeWallet.ship, { operationId: "wallet-withdraw", kind: "withdraw", amountCopper: 50 });
  assert.equal(homeWallet.ship.onboardCopper, 38);
  assert.equal(homeWallet.holding.storage.moneyCopper, 9950);
  advanceWorldShips(homeWallet.holding, 20);
  assert.equal(homeWallet.ship.onboardCopper, 0);
  assert.equal(homeWallet.holding.storage.moneyCopper, 9940, "the remainder of upkeep comes from shared treasury");

  const rounded = fixture();
  rounded.ship.portBilling.dailyCopper = 5;
  advanceWorldShips(rounded.holding, 1);
  assert.equal(rounded.holding.storage.moneyCopper, 9998);
  advanceWorldShips(rounded.holding, 2);
  assert.equal(rounded.holding.storage.moneyCopper, 9997, "idle rounding must be cumulative across partial days");

  const shortJob = fixture();
  departWorldShip(shortJob.holding, shortJob.ship, { operationId: "three-day-job", clockQd: 0,
    offer: offer(shortJob.ship, shortJob.ship.location, point("market", "short", "Ближний порт"), { durationQd: 12 }) });
  const shortPeriod = advanceWorldShips(shortJob.holding, 40);
  assert.equal(shortPeriod.awaiting[0].plannedArrivalQd, 12, "three-day job arrives inside the tenday");
  assert.equal(shortJob.ship.portBilling.chargedCopper, 0, "arrival pauses port billing until the next decision");
  assert.equal(shortJob.ship.timelineQd, 12, "the ship remains at its actual arrival date");
  assert.equal(shortJob.ship.activeVoyage.awaitingOutcome, true, "a later job never starts automatically within the same tenday");

  const sequence = fixture();
  sequence.holding.storage.moneyCopper = 100_000;
  let origin = { ...sequence.ship.location };
  departWorldShip(sequence.holding, sequence.ship, { operationId: "sequence-1", clockQd: 0,
    offer: offer(sequence.ship, origin, point("market", "seq-a", "Порт А"), { durationQd: 12 }) });
  advanceWorldShips(sequence.holding, 40);
  sequence.holding.gm.calendaria.lastQd = 40;
  for (const [index, arrivalQd] of [[1, 12], [2, 20], [3, 32]]) {
    assert.equal(sequence.ship.timelineQd, arrivalQd);
    assert.equal(sequence.ship.activeVoyage?.awaitingOutcome, true);
    resolveWorldShip(sequence.holding, sequence.ship, { operationId: `sequence-result-${index}`, random: () => 0.999 });
    assert.equal(sequence.ship.timelineQd, arrivalQd, "outcome keeps the actual day of arrival");
    if (index === 3) break;
    origin = { ...sequence.ship.location };
    departWorldShip(sequence.holding, sequence.ship, { operationId: `sequence-${index + 1}`, clockQd: arrivalQd,
      offer: offer(sequence.ship, origin, point("market", `seq-${index + 1}`, `Порт ${index + 1}`),
        { durationQd: index === 1 ? 8 : 12 }) });
    advanceWorldShips(sequence.holding, 40, { shipId: sequence.ship.id });
  }
  origin = { ...sequence.ship.location };
  departWorldShip(sequence.holding, sequence.ship, { operationId: "sequence-4", clockQd: 32,
    offer: offer(sequence.ship, origin, point("market", "seq-d", "Порт Г"), { durationQd: 40 }) });
  advanceWorldShips(sequence.holding, 40, { shipId: sequence.ship.id });
  assert.equal(sequence.ship.timelineQd, 40);
  assert.equal(sequence.ship.activeVoyage.arrivalQd, 72);
  assert.equal(sequence.ship.activeVoyage.remainingQd, 32);
  assert.equal(sequence.holding.special.ships.history.length, 3, "the next tenday's contract has no early outcome");
  advanceWorldShips(sequence.holding, 80);
  assert.equal(sequence.ship.timelineQd, 72);
  assert.equal(sequence.ship.activeVoyage.awaitingOutcome, true);

  const explicit = fixture();
  const explicitPort = point("market", "explicit", "Ближний порт");
  departWorldShip(explicit.holding, explicit.ship, {
    operationId: "explicit-budget",
    clockQd: 0,
    budgetCopper: 100,
    offer: offer(explicit.ship, explicit.ship.location, explicitPort, { id: "explicit-job" })
  });
  assert.equal(explicit.ship.onboardCopper, 0, "an explicit viable budget must not be raised to the recommendation");

  const chain = fixture();
  chain.ship.homeUpkeepCopperPerDay = 12;
  advanceWorldShips(chain.holding, 4);
  assert.equal(chain.holding.storage.moneyCopper, 9988);
  const home = { ...chain.ship.location };
  const portA = point("market", "a", "Порт А");
  const portB = point("market", "b", "Порт Б");
  const firstOffer = offer(chain.ship, home, portA, { id: "job-a" });
  firstOffer.quote.distanceKm = 150.5;
  const firstDeparture = departWorldShip(chain.holding, chain.ship, { operationId: "leg-a", clockQd: 4, offer: firstOffer });
  assert.equal(firstDeparture.ok, true);
  assert.equal(chain.holding.storage.moneyCopper, 9388);
  assert.equal(chain.ship.onboardCopper, 500);
  firstOffer.quote.rewardCopper = 999999;
  firstOffer.contract.rewardCopper = 999999;
  assert.equal(chain.ship.activeVoyage.quote.rewardCopper, 300);
  assert.equal(chain.ship.activeVoyage.quote.distanceKm, 150.5);
  assert.ok(Object.isFrozen(chain.ship.activeVoyage.quote));
  const firstArrival = advanceWorldShips(chain.holding, 12);
  assert.equal(firstArrival.awaiting.length, 1);
  assert.equal(firstArrival.expenses.length, 0, "an arrived ship does not spend future port days before the next decision");
  assert.equal(chain.ship.location.id, "a");
  assert.equal(chain.ship.onboardCopper, 500);
  assert.equal(chain.holding.storage.moneyCopper, 9388, "foreign expenses must not draw from home");
  chain.holding.gm.calendaria.lastQd = 12;
  const firstResult = resolveWorldShip(chain.holding, chain.ship, { operationId: "resolve-a", random: () => 0.999 });
  assert.ok(firstResult.arrived);
  assert.equal(firstResult.returned, null);
  assert.equal(chain.ship.activeVoyage, null);
  assert.equal(chain.ship.status, "away");
  assert.ok(chain.ship.onboardCopper > 500);
  assert.equal(chain.holding.storage.moneyCopper, 9388, "foreign contract income stays aboard");

  const beforeSecond = chain.ship.onboardCopper;
  const secondOffer = offer(chain.ship, portA, portB, { id: "job-b", operatingCopper: 120, rewardCopper: 260, recommendedBudgetCopper: 520 });
  departWorldShip(chain.holding, chain.ship, { operationId: "leg-b", clockQd: 12, offer: secondOffer });
  assert.equal(chain.ship.onboardCopper, beforeSecond - 160, "deliberate wait at port pays four QD of upkeep before departure");
  advanceWorldShips(chain.holding, 16);
  chain.holding.gm.calendaria.lastQd = 16;
  resolveWorldShip(chain.holding, chain.ship, { operationId: "resolve-b", random: () => 0.999 });
  assert.equal(chain.ship.location.id, "b");
  const beforeReturn = chain.ship.onboardCopper;
  const returnOffer = offer(chain.ship, portB, home, {
    id: "return-home",
    durationQd: 8,
    operatingCopper: 200,
    recommendedBudgetCopper: 200,
    idleUpkeepCopperPerDay: 12,
    returnReserveCopper: 0,
    contract: false
  });
  departWorldShip(chain.holding, chain.ship, { operationId: "leg-home", clockQd: 16, offer: returnOffer });
  assert.equal(chain.ship.onboardCopper, beforeReturn - 200);
  const settlementBeforeReturn = chain.holding.storage.moneyCopper;
  const returned = advanceWorldShips(chain.holding, 28);
  assert.equal(returned.returned.length, 1);
  assert.equal(returned.returned[0].arrivalQd, 24);
  assert.equal(chain.ship.status, "docked");
  assert.equal(chain.ship.location.kind, "home");
  assert.equal(chain.ship.onboardCopper, 0);
  assert.ok(chain.holding.storage.moneyCopper > settlementBeforeReturn);
  assert.equal(returned.expenses.length, 0, "early return pauses at the actual arrival date for a new decision");
  assert.equal(chain.holding.special.ships.history.length, 3);
  advanceWorldShips(chain.holding, 28);
  assert.equal(chain.ship.portBilling.chargedCopper, 12, "home upkeep accrues when the ship waits through the remainder");
  const settledBalance = chain.holding.storage.moneyCopper;
  advanceWorldShips(chain.holding, 28);
  assert.equal(chain.holding.storage.moneyCopper, settledBalance, "same clock must not bill twice");

  // The authority outcome is retained when an event cannot yet be paid.
  const frozen = fixture();
  const frozenHome = { ...frozen.ship.location };
  const frozenPort = point("market", "frozen", "Тихая гавань");
  departWorldShip(frozen.holding, frozen.ship, {
    operationId: "frozen-leg",
    clockQd: 0,
    offer: offer(frozen.ship, frozenHome, frozenPort, { id: "frozen-job" })
  });
  advanceWorldShips(frozen.holding, 4);
  adjustWorldShipFunds(frozen.holding, frozen.ship, {
    operationId: "drain",
    voyageId: "frozen-leg",
    kind: "expense",
    amountCopper: frozen.ship.onboardCopper,
    reason: "Экстренная закупка"
  });
  frozen.holding.gm.calendaria.lastQd = 4;
  let draws = 0;
  const pending = resolveWorldShip(frozen.holding, frozen.ship, { operationId: "frozen-roll", random: () => { draws++; return 0; } });
  assert.equal(draws, 3);
  assert.equal(pending.pending, true);
  const savedOutcome = structuredClone(frozen.ship.activeVoyage.outcome);
  adjustWorldShipFunds(frozen.holding, frozen.ship, {
    operationId: "rescue",
    voyageId: "frozen-leg",
    kind: "income",
    amountCopper: savedOutcome.expenseCopper,
    reason: "Кредит посредника"
  });
  const delayed = resolveWorldShip(frozen.holding, frozen.ship, {
    operationId: "frozen-retry",
    random: () => { throw new Error("outcome rerolled"); }
  });
  assert.deepEqual(delayed.outcome, savedOutcome);
  assert.equal(delayed.delayQd, 8);
  assert.equal(frozen.ship.activeVoyage.arrivalQd, 12);
  const delayedArrival = advanceWorldShips(frozen.holding, 12);
  assert.equal(delayedArrival.arrived.length, 1);
  assert.equal(frozen.ship.location.id, "frozen");

  const late = fixture();
  const latePort = point("market", "late", "Дальний порт");
  departWorldShip(late.holding, late.ship, {
    operationId: "late-leg",
    clockQd: 0,
    offer: offer(late.ship, late.ship.location, latePort, { id: "late-job", idleUpkeepCopperPerDay: 0 })
  });
  advanceWorldShips(late.holding, 40);
  adjustWorldShipFunds(late.holding, late.ship, {
    operationId: "late-drain",
    voyageId: "late-leg",
    kind: "expense",
    amountCopper: late.ship.onboardCopper,
    reason: "Долгое ожидание"
  });
  late.holding.gm.calendaria.lastQd = 40;
  const latePending = resolveWorldShip(late.holding, late.ship, { operationId: "late-roll", random: () => 0 });
  adjustWorldShipFunds(late.holding, late.ship, {
    operationId: "late-rescue",
    voyageId: "late-leg",
    kind: "income",
    amountCopper: latePending.outcome.expenseCopper,
    reason: "Заём"
  });
  resolveWorldShip(late.holding, late.ship, { operationId: "late-retry", random: () => { throw new Error("reroll"); } });
  assert.equal(late.ship.activeVoyage.arrivalQd, 12);
  const lateProgress = advanceWorldShips(late.holding, 42);
  assert.equal(lateProgress.arrived[0].arrivalQd, 12, "a saved outcome schedules its delay from the actual delivery time");

  // An unpaid foreign-port bill is explicit and blocks the next leg without touching home money.
  adjustWorldShipFunds(frozen.holding, frozen.ship, {
    operationId: "port-drain",
    kind: "expense",
    amountCopper: frozen.ship.onboardCopper,
    reason: "Ремонт оснастки"
  });
  const homeBeforeBill = frozen.holding.storage.moneyCopper;
  const portIdle = advanceWorldShips(frozen.holding, 16);
  assert.ok(portIdle.blocked[0].pendingPortBillCopper > 0);
  const blockedReturn = departWorldShip(frozen.holding, frozen.ship, {
    operationId: "blocked-return",
    clockQd: 16,
    offer: offer(frozen.ship, frozenPort, frozenHome, { id: "blocked-return-offer", operatingCopper: 0, recommendedBudgetCopper: 0, returnReserveCopper: 0, contract: false })
  });
  assert.equal(blockedReturn.ok, false);
  assert.equal(frozen.holding.storage.moneyCopper, homeBeforeBill);
  assert.equal(frozen.ship.location.id, "frozen");

  const awaiting = fixture();
  departWorldShip(awaiting.holding, awaiting.ship, {
    operationId: "awaiting-leg", clockQd: 0,
    offer: offer(awaiting.ship, awaiting.ship.location, point("market", "awaiting", "Порт ожидания"), { id: "awaiting-job" })
  });
  advanceWorldShips(awaiting.holding, 40);
  const arrivalQd = awaiting.ship.timelineQd;
  const balanceAtArrival = awaiting.ship.onboardCopper;
  awaiting.holding.gm.calendaria.lastQd = 40;
  advanceWorldShips(awaiting.holding, 40);
  assert.equal(awaiting.ship.timelineQd, arrivalQd, "replaying the confirmed tenday preserves the decision window");
  assert.equal(awaiting.ship.onboardCopper, balanceAtArrival);
  const laterWaiting = advanceWorldShips(awaiting.holding, 80);
  assert.equal(awaiting.ship.timelineQd, 80, "a later tenday closes the old decision window");
  assert.ok(laterWaiting.expenses.length || laterWaiting.blocked.length, "foreign-port waiting accrues upkeep");

  const bounded = fixture();
  bounded.ship.worldLedger = Array.from({ length: 205 }, (_, index) => ({ id: `old-${index}` }));
  advanceWorldShips(bounded.holding, 0);
  assert.equal(bounded.ship.worldLedger.length, 200);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkWorldShipCharacterization();
  console.log("World ships passed: profiles, automatic costs, chained ports, onboard treasury, frozen outcomes, delays and idle bills.");
}
