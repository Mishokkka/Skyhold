import assert from "node:assert/strict";
import { shipMoneySummary, shipNextAction } from "../engines/ships/summary.js";
import { prepareShipWindowContext } from "../apps/ships-context.js";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { contractGuidance } from "../engines/ships/contracts.js";

const holding = { storage: { moneyCopper: 900 } };
const ship = {
  location: { kind: "market" }, onboardCopper: 500, condition: "ready", idleUpkeepCopperPerDay: 20,
  portBilling: { sinceQd: 0, lastCalculatedQd: 4, dailyCopper: 20, carriedCopper: 10, chargedCopper: 20 },
  pendingPortBillCopper: 10
};
const before = JSON.stringify({ holding, ship });
const summary = shipMoneySummary(holding, ship, { clockQd: 8, returnOffer: { quote: { operatingCopper: 100 } } });
assert.equal(summary.portDebtCopper, 30, "project accrued unpaid charges without paying them");
assert.equal(summary.reserveCopper, 140);
assert.equal(summary.freeCopper, 330);
assert.equal(summary.balanceCopper, 500, "remote home funds are unavailable");
assert.equal(JSON.stringify({ holding, ship }), before, "view must not pay or mutate a bill");

const poor = shipMoneySummary(holding, { ...ship, onboardCopper: 100 }, { clockQd: 8, returnOffer: { costs: { totalCopper: 100 } } });
assert.equal(poor.shortageCopper, 70);
assert.equal(poor.freeCopper, 0);
const unknown = shipMoneySummary(holding, ship, { clockQd: 8 });
assert.equal(unknown.reserveKnown, false);
assert.equal(unknown.freeCopper, null, "no return route means no claim of freely spendable cash");

const flight = {
  ...ship, portBilling: null, pendingPortBillCopper: 0,
  activeVoyage: { quote: { contract: {}, operatingCopper: 200, recommendedBudgetCopper: 400, returnReserveCopper: 100, idleReserveCopper: 40 } }
};
assert.equal(shipMoneySummary(holding, flight).incidentReserveCopper, 60);
const styled = structuredClone(flight);
styled.activeVoyage.style = "bold";
styled.activeVoyage.quote.contract = { kind: "smuggling", rewardCopper: 500, guidance: { operatingCopper: 200 }, attention: { level: 8 } };
assert.equal(shipMoneySummary(holding, styled).incidentReserveCopper, Math.max(60, contractGuidance(styled.activeVoyage.quote.contract, "bold").suggestedBudgetCopper - 200), "selected risky approach must not disappear from the recommended reserve");
flight.activeVoyage.outcome = { expenseCopper: 80 };
const knownOutcome = shipMoneySummary(holding, flight);
assert.equal(knownOutcome.obligationsCopper, 80);
assert.equal(knownOutcome.incidentReserveCopper, 0, "known event expense replaces speculative reserve");
flight.activeVoyage.outcomeApplied = true;
assert.equal(shipMoneySummary(holding, flight).obligationsCopper, 0, "paid outcome is no longer a debt");
flight.activeVoyage.quote.to = { kind: "home" };
assert.equal(shipMoneySummary(holding, flight).reserveCopper, 0, "prepaid return must not require a second return reserve");

const home = shipMoneySummary(holding, { ...ship, location: { kind: "home" }, onboardCopper: 0 });
assert.equal(home.balanceCopper, 900);
assert.equal(home.reserveCopper, 0);
assert.equal(shipNextAction(ship, { readiness: { ready: false } }), "Уточнить готовность команды");
assert.equal(shipNextAction({ ...ship, activeVoyage: { awaitingOutcome: true } }), "Подвести итог заказа");

const fixture = worldMarketFixture();
const viewBefore = JSON.stringify(fixture.data);
const view = prepareShipWindowContext(fixture.holding, { data: fixture.data, shipId: fixture.ship.id }).rows[0];
assert.equal(view.readiness.ready, false, "a one-person named crew cannot quietly fill to 36");
assert.equal(view.abstractCrewCount, 0);
assert.equal(view.canDepartOffer, false);
assert.equal(view.moneySummary.balanceCopper, fixture.holding.storage.moneyCopper);
assert.equal(JSON.stringify(fixture.data), viewBefore);
console.log("FBL Skyhold ship summary check passed.");
