import assert from "node:assert/strict";
import { createShipRecord, normalizeShipsState } from "../data/ships.js";
import { initializeWorldShip, departWorldShip, advanceWorldShips, resolveWorldShip, adjustWorldShipFunds } from "../engines/ships/world-voyage.js";
import { shipOutingSummary } from "../engines/ships/summary.js";

function fixture() {
  const ship = { ...createShipRecord("barque"), name: "Ласточка" };
  const holding = { id: "home", name: "Дом", storage: { moneyCopper: 1000000 }, gm: { calendaria: { lastQd: 0 } }, special: { ships: { list: [ship], history: [] } } };
  initializeWorldShip(holding, ship, { profileId: "merchant-barque", clockQd: 0 });
  return { holding, ship };
}

function offer(ship, index, { home = false, contract = false, preparationCopper = 0 } = {}) {
  const to = home ? { kind: "home", id: "home", label: "Дом" } : { kind: "market", id: `port-${index}`, label: `Порт ${index}` };
  const operatingCopper = 100;
  const terms = contract ? {
    kind: "freight", rewardCopper: 300, directionKey: `port:${to.id}`, destination: to.label,
    attention: { level: 0 }, guidance: { operatingCopper, preparationCopper }, routePlan: { upkeepPerDayCopper: 4 }
  } : null;
  return {
    mode: "world", id: `offer-${index}`, shipId: ship.id, from: { ...ship.location }, to, contract: terms,
    quote: { durationQd: 4, distanceKm: 150, speedKmPerDay: 150, operatingCopper, preparationCopper,
      rewardCopper: contract ? 300 : 0, recommendedBudgetCopper: 200000, costs: { totalCopper: 100 }, idleUpkeepCopperPerDay: 4 }
  };
}

const { holding, ship } = fixture();
const initialMoney = holding.storage.moneyCopper;
departWorldShip(holding, ship, { operationId: "start", offer: offer(ship, 1, { contract: true, preparationCopper: 10 }), clockQd: 0 });
assert.equal(ship.currentOuting.fundingCopper, 200010);
assert.equal(ship.currentOuting.expenseCopper, 110);
assert.equal(ship.currentOuting.plannedPreparationCopper, 10);

// Advancing a detached preview does not touch the authoritative source.
const beforePreview = JSON.stringify(holding);
const preview = structuredClone(holding);
advanceWorldShips(preview, 8);
assert.equal(JSON.stringify(holding), beforePreview);
holding.gm.calendaria.lastQd = 8;
advanceWorldShips(holding, 8);
assert.equal(ship.currentOuting.portExpenseCopper, 0, "arrival leaves the remaining days available for another order");
resolveWorldShip(holding, ship, { operationId: "outcome", random: () => 0.4 });
if (ship.activeVoyage) {
  holding.gm.calendaria.lastQd = ship.activeVoyage.arrivalQd;
  advanceWorldShips(holding, holding.gm.calendaria.lastQd);
}
let clock = holding.gm.calendaria.lastQd;
assert.equal(ship.currentOuting.completedLegs, 1);
assert.equal(ship.currentOuting.plannedRewardCopper, 300);

// A long outing exceeds both old retention limits: aggregate totals must survive.
for (let index = 2; index <= 106; index++) {
  clock += 4;
  holding.gm.calendaria.lastQd = clock;
  advanceWorldShips(holding, clock);
  const before = structuredClone(ship.currentOuting);
  advanceWorldShips(holding, clock);
  assert.deepEqual(ship.currentOuting, before, "same time boundary cannot double-charge port totals");
  departWorldShip(holding, ship, { operationId: `leg-${index}`, offer: offer(ship, index), clockQd: clock });
  clock += 4;
  holding.gm.calendaria.lastQd = clock;
  advanceWorldShips(holding, clock);
  const adjustment = { operationId: `extra-${index}`, kind: "income", amountCopper: 3, reason: "Попутная услуга" };
  adjustWorldShipFunds(holding, ship, adjustment);
  const after = structuredClone(ship.currentOuting);
  adjustWorldShipFunds(holding, ship, adjustment);
  assert.deepEqual(ship.currentOuting, after, "replayed funds receipt cannot double-count a report");
}
assert.equal(holding.special.ships.history.length, 100);
assert.ok(ship.worldLedger.length <= 201);
assert.equal(ship.currentOuting.details.length, 40);
assert.ok(ship.currentOuting.omittedDetails > 200);
assert.equal(ship.currentOuting.startedLegs, 106);
assert.equal(ship.currentOuting.plannedOperatingCopper, 10600);
assert.equal(ship.currentOuting.fundingCopper + ship.currentOuting.incomeCopper - ship.currentOuting.expenseCopper, ship.onboardCopper);
assert.deepEqual(normalizeShipsState(holding.special.ships).list[0].currentOuting, ship.currentOuting, "safe normalization preserves the optional report");

departWorldShip(holding, ship, { operationId: "return", offer: offer(ship, 107, { home: true }), clockQd: clock });
clock += 4;
holding.gm.calendaria.lastQd = clock;
advanceWorldShips(holding, clock);
assert.equal(ship.currentOuting, undefined);
const report = ship.lastOuting;
assert.equal(report.completedLegs, 107);
assert.equal(report.fundingCopper + report.incomeCopper - report.expenseCopper, report.returnedCopper);
assert.equal(holding.storage.moneyCopper - initialMoney, report.incomeCopper - report.expenseCopper, "return is a transfer, not fresh revenue");
assert.equal(report.partial, false);
assert.equal(shipOutingSummary(ship).netCopper, holding.storage.moneyCopper - initialMoney);
const closedSnapshot = JSON.stringify(report);
advanceWorldShips(holding, clock);
advanceWorldShips(holding, clock + 40);
assert.equal(JSON.stringify(ship.lastOuting), closedSnapshot, "home upkeep must not rewrite the completed outing");

// Old saves begin honest partial reports, both at a port and mid-flight.
for (const inFlight of [false, true]) {
  const legacy = fixture();
  departWorldShip(legacy.holding, legacy.ship, { operationId: "old-start", offer: offer(legacy.ship, 1), clockQd: 0 });
  if (!inFlight) advanceWorldShips(legacy.holding, 4);
  delete legacy.ship.currentOuting;
  if (inFlight) advanceWorldShips(legacy.holding, 4);
  else adjustWorldShipFunds(legacy.holding, legacy.ship, { operationId: "old-income", kind: "income", amountCopper: 5, reason: "Новая услуга" });
  assert.equal(legacy.ship.currentOuting.partial, true);
  departWorldShip(legacy.holding, legacy.ship, { operationId: "old-home", offer: offer(legacy.ship, 2, { home: true }), clockQd: 4 });
  advanceWorldShips(legacy.holding, 8);
  assert.equal(legacy.ship.lastOuting.partial, true);
}
console.log("FBL Skyhold outing integration passed: 107 legs, bounded ledgers, preview, repeats, idle, return and old saves.");
