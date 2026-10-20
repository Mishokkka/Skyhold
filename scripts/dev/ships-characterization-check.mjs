import assert from "node:assert/strict";
import { planShipVoyage, projectShipVoyage } from "../engines/ships/voyage.js";
import { createShipFunds, applyShipFundsOperation } from "../engines/ships/funds.js";
import { createDefaultShipsState, createShipRecord, normalizeShipsState } from "../data/ships.js";
import { isPlayerWritablePath } from "../data/player-write-guard.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { formatShipGold, parseShipGoldInput, shipGoldInput } from "../core/ship-gold.js";

const flight = (distanceMeters) => ({ type: "flight", distanceMeters });
const port = (durationQd) => ({ type: "port", durationQd });

const emptyShips = createDefaultShipsState();
assert.deepEqual(normalizeShipsState(undefined), emptyShips);
const customShips = { list: [{ id: "custom", onboardCopper: 731, status: "away", activeVoyage: { id: "v1", ledger: [{ id: "paid" }] }, customTrait: "preserve" }], history: [{ id: "old" }], extension: { enabled: true } };
const customBefore = JSON.stringify(customShips);
const normalizedShips = normalizeShipsState(customShips);
assert.equal(JSON.stringify(customShips), customBefore);
assert.equal(normalizedShips.list[0].onboardCopper, 731);
assert.deepEqual(normalizedShips.list, customShips.list);
assert.deepEqual(normalizedShips.history, customShips.history);
assert.deepEqual(normalizedShips.extension, customShips.extension);
assert.deepEqual(normalizeShipsState(normalizedShips), normalizedShips);
const newShip = createShipRecord("new-ship");
assert.equal(newShip.speedKmPerDay, 150);
assert.equal(newShip.onboardCopper, 0);
assert.equal(newShip.activeVoyage, null);
assert.deepEqual(newShip.crewRefs, []); // No implicit Magnifique/Actor import.
assert.throws(() => createShipRecord(""));
const legacyHolding = mergeHoldingDefaults({ id: "legacy", special: { notes: "keep", list: [{ id: "note" }] }, storage: { moneyCopper: 123 } });
assert.equal(legacyHolding.storage.moneyCopper, 123);
assert.equal(legacyHolding.special.notes, "keep");
assert.deepEqual(legacyHolding.special.ships, emptyShips);
const normalizedHolding = mergeHoldingDefaults({ ...legacyHolding, special: { ...legacyHolding.special, ships: customShips } });
assert.deepEqual(normalizedHolding.special.ships.list, customShips.list);
const guarded = { holdings: [{ ...legacyHolding, gm: { playersCanEditSpecial: true, playersCanUseStorage: true } }] };
assert.equal(isPlayerWritablePath("holdings.0.special.ships.list.0.onboardCopper", guarded, guarded), false);
assert.equal(isPlayerWritablePath("holdings.0.special.ships.list", guarded, guarded), false);
assert.equal(isPlayerWritablePath("holdings.0.special.ships.list.0.name", guarded, guarded), false);
assert.equal(isPlayerWritablePath("holdings.0.special.notes", guarded, guarded), true);

// Independent stepwise oracle. Departure phase must not change the duration.
function simulate(legs, startQd, speedKmPerDay) {
  let qd = startQd;
  for (const leg of legs) {
    if (leg.type === "port") { qd += leg.durationQd; continue; }
    let remaining = leg.distanceMeters;
    while (remaining > 0) {
      remaining -= speedKmPerDay * 1000 / 4;
      qd++;
    }
  }
  return qd;
}

for (let startQd = 0; startQd < 8; startQd++) {
  for (const distance of [0, 1, 49999, 50000, 50001, 150000, 150001, 450000]) {
    for (const wait of [0, 1, 3, 4, 9]) {
      const legs = [flight(distance), port(wait), flight(distance)];
      const args = { legs, startQd, speedKmPerDay: 150 };
      const plan = planShipVoyage(args);
      assert.equal(plan.endQd, simulate(legs, startQd, 150));
      assert.equal(plan.durationQd, plan.totalFlightQd + plan.totalPortQd);
      let previous = 0;
      for (let atQd = startQd; atQd <= plan.endQd + 2; atQd++) {
        const projection = projectShipVoyage({ ...args, atQd });
        assert.ok(projection.distanceTravelledMeters >= previous);
        assert.equal(projection.distanceTravelledMeters + projection.remainingDistanceMeters, distance * 2);
        previous = projection.distanceTravelledMeters;
        assert.equal(projection.completed, atQd >= plan.endQd);
      }
      assert.equal(previous, distance * 2);
    }
  }
}
assert.equal(planShipVoyage({ legs: [flight(150000)], startQd: 0 }).durationQd, 4);
assert.equal(planShipVoyage({ legs: [flight(200000)], startQd: 0 }).durationQd, 6);
assert.equal(planShipVoyage({ legs: [flight(50000)], startQd: 3 }).durationQd, 2);
const overnightPort = planShipVoyage({ legs: [flight(150000), port(1), flight(50000)], startQd: 0 });
assert.equal(overnightPort.durationQd, 7);
assert.equal(planShipVoyage({ legs: [flight(150000)], startQd: 3 }).durationQd, 4);
assert.equal(planShipVoyage({ legs: [flight(300000)], startQd: 0 }).durationQd, 8);
for (const bad of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  assert.throws(() => planShipVoyage({ legs: [flight(bad)], startQd: 0 }));
  assert.throws(() => createShipFunds(bad));
}
assert.throws(() => planShipVoyage({ legs: [flight(1)], startQd: 0, speedKmPerDay: 0 }));
assert.throws(() => projectShipVoyage({ legs: [flight(1)], startQd: 4, atQd: 3 }));

let funds = createShipFunds(1000);
const original = JSON.stringify(funds);
const depart = { id: "voyage-1:depart", kind: "depart", amountCopper: 300 };
let result = applyShipFundsOperation(funds, depart);
assert.equal(JSON.stringify(funds), original);
funds = result.state;
assert.equal(funds.settlementCopper, 700);
assert.equal(funds.onboardCopper, 300);
assert.equal(result.receipt.externalDeltaCopper, 0);
assert.equal(applyShipFundsOperation(funds, depart).state, funds);
assert.throws(() => applyShipFundsOperation(funds, { ...depart, amountCopper: 301 }), /conflict/);
assert.throws(() => applyShipFundsOperation(funds, { ...depart, id: "second-depart" }), /already away/);
const beforeFailure = JSON.stringify(funds);
assert.throws(() => applyShipFundsOperation(funds, { id: "too-much", kind: "expense", amountCopper: 301 }), /Insufficient/);
assert.equal(JSON.stringify(funds), beforeFailure); // Cannot draw on the 700 still in the settlement.
funds = applyShipFundsOperation(funds, { id: "repair", kind: "expense", amountCopper: 80 }).state;
funds = applyShipFundsOperation(funds, { id: "sale", kind: "income", amountCopper: 150 }).state;
assert.equal(funds.onboardCopper, 370);
funds = applyShipFundsOperation(funds, { id: "home", kind: "return" }).state;
assert.equal(funds.settlementCopper, 1070);
assert.equal(funds.onboardCopper, 0);
assert.equal(funds.receipts.reduce((total, r) => total + r.externalDeltaCopper, 0), 70);
assert.equal(applyShipFundsOperation(funds, { id: "home", kind: "return" }).state, funds);
assert.equal(applyShipFundsOperation(funds, depart).state, funds); // Late network replay after return.
assert.throws(() => applyShipFundsOperation(funds, { id: "home-again", kind: "return" }), /not away/);
assert.throws(() => applyShipFundsOperation(funds, { id: "old-income", kind: "income", amountCopper: 1 }), /not away/);
const prepared = applyShipFundsOperation(createShipFunds(400), { id: "prep", kind: "depart", amountCopper: 300, preparationCopper: 100 });
assert.equal(prepared.state.settlementCopper, 0);
assert.equal(prepared.receipt.externalDeltaCopper, -100);
assert.throws(() => applyShipFundsOperation(createShipFunds(399), { id: "prep", kind: "depart", amountCopper: 300, preparationCopper: 100 }), /Insufficient/);
assert.throws(() => applyShipFundsOperation(prepared.state, { id: "overflow", kind: "income", amountCopper: Number.MAX_SAFE_INTEGER }));
assert.equal(formatShipGold(12345), "123,45");
assert.equal(shipGoldInput(12345), "123.45");
assert.equal(parseShipGoldInput("123,45"), 12345);
assert.equal(parseShipGoldInput("0.01"), 1);
assert.throws(() => parseShipGoldInput("1.001"), /точностью/);
let wallet = applyShipFundsOperation(createShipFunds(1000), { id: "fund", kind: "deposit", amountCopper: 300 }).state;
assert.equal(wallet.settlementCopper, 700);
assert.equal(wallet.onboardCopper, 300);
wallet = applyShipFundsOperation(wallet, { id: "spend-at-home", kind: "withdraw", amountCopper: 100 }).state;
assert.equal(wallet.settlementCopper, 800);
assert.equal(wallet.onboardCopper, 200);
const walletDeparture = applyShipFundsOperation(wallet, { id: "wallet-trip", kind: "depart", amountCopper: 500 });
assert.equal(walletDeparture.receipt.transferToShipCopper, 300, "departure tops up only the missing target balance");
assert.equal(walletDeparture.state.settlementCopper, 500);
assert.equal(walletDeparture.state.onboardCopper, 500);
assert.throws(() => applyShipFundsOperation(walletDeparture.state, { id: "away-transfer", kind: "withdraw", amountCopper: 1 }), /docked/);
console.log("Ship characterization passed: daily speed, port time, immutable funds, deficits and replay conflicts.");
