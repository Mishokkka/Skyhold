import assert from "node:assert/strict";
import { isResidentInPopulation, isResidentRestingOnShip } from "../data/resident-presence.js";
import { assignResidentsToFreeHousing } from "../engines/housing/assignment.js";
import { settlementControlSummary } from "../engines/settlement/control.js";
import { isCivilianWorkerCandidate } from "../engines/workers/assignment-planner.js";
import { configureWorldShipEconomy, generateWorldShipOffers, quoteWorldShipReturn } from "../engines/ships/world-market.js";
import { advanceWorldShipEconomy, refreshWorldShipHomeEconomy, worldShipPresenceDays } from "../engines/ships/world-economy.js";
import { advanceWorldShips, departWorldShip, resolveWorldShip } from "../engines/ships/world-voyage.js";
import { embarkShipCrew } from "../engines/ships/crew.js";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";

const plannerDependencies = {
  safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
  buildingOperationalState: () => ({ operational: true }),
  workerEfficiencyForPerson: () => ({ value: 1 }),
  isSoldierResident: () => false,
  isMilitaryResidentLike: () => false,
  setPersonFree: () => {},
  assignedWorkerSet: () => new Set(),
  applyPersonSalaryForAssignment: () => {}
};

function presenceAndSettlementAccounting() {
  const { holding, ship } = worldMarketFixture();
  const sailor = holding.people.list[0];
  const resident = { id: "resident", name: "Житель", salary: 7 };
  holding.people.list.push(resident);
  const building = { id: "workshop", name: "Мастерская", workersMax: 2 };

  assert.equal(isResidentRestingOnShip(sailor, holding), true);
  assert.equal(isResidentInPopulation(sailor, holding), false);
  assert.equal(isCivilianWorkerCandidate(sailor, building, plannerDependencies, holding), false, "automatic staffing must skip resting crew");
  assert.equal(isCivilianWorkerCandidate(resident, building, plannerDependencies, holding), true);

  holding.buildings.list = [{ id: "house", name: "Дом", housing: { capacity: 2, comfort: 0, quality: 0 } }];
  const housing = assignResidentsToFreeHousing(holding, { isResidentialBuilding: () => true });
  assert.equal(housing.assigned, 1, "resting crew must not take a housing slot");
  assert.equal(sailor.home ?? "", "");
  assert.equal(resident.home, "house");
  assert.equal(settlementControlSummary(holding).population, 1, "order requirements use settlement population only");

  sailor.shipAssignment = { shipId: ship.id, away: false, shoreDuty: true };
  assert.equal(isResidentInPopulation(sailor, holding), true);
  assert.equal(isCivilianWorkerCandidate(sailor, building, plannerDependencies, holding), true, "shore duty restores ordinary work eligibility");
  assert.equal(settlementControlSummary(holding).population, 2);
}

function homeRateAndFoodPresence() {
  const { data, holding, ship } = worldMarketFixture();
  const sailor = holding.people.list[0];
  sailor.wageDailyOverrideCopper = 120;
  sailor.shipAssignment = { shipId: ship.id, away: false };
  const resting = configureWorldShipEconomy(data, holding, ship);
  assert.equal(resting.restingCrewCount, 1);

  sailor.shipAssignment.shoreDuty = true;
  const working = configureWorldShipEconomy(data, holding, ship);
  assert.equal(working.restingCrewCount, 0);
  assert.ok(resting.homeUpkeepCopperPerDay > working.homeUpkeepCopperPerDay + 119, "home upkeep includes the resting named sailor's wage and ration");

  const regular = { id: "resident", name: "Житель" };
  holding.people.list.push(regular);
  const days = worldShipPresenceDays(holding, 0, 40);
  assert.equal(days.get(sailor.id), 10, "shore-duty crew uses settlement food");
  assert.equal(days.get(regular.id), 10);
  delete sailor.shipAssignment.shoreDuty;
  const restingDays = worldShipPresenceDays(holding, 0, 40);
  assert.equal(restingDays.get(sailor.id), 0, "resting crew food is charged through ship upkeep");
}

function returningCrewUsesFullHomeRate(enabled = true) {
  const { data, holding, ship } = worldMarketFixture();
  if (!enabled) ship.homeUpkeepEnabled = false;
  const sailor = holding.people.list[0];
  sailor.wageDailyOverrideCopper = 120;
  configureWorldShipEconomy(data, holding, ship);
  const outbound = generateWorldShipOffers(data, holding, ship, { period: 0, random: () => 0.4 })[0];
  departWorldShip(holding, ship, { operationId: "shore-economy-out", offer: outbound, clockQd: 0 });
  embarkShipCrew(holding, ship, 0);
  const foreignArrival = ship.activeVoyage.arrivalQd;
  assert.ok(ship.activeVoyage.quote.costs.totalCopper > 0, "home exemption never makes voyages free");
  advanceWorldShipEconomy(holding, foreignArrival, { work: [], skipped: [], ledger: [], treasury: { spent: 0 } }, () => {});
  resolveWorldShip(holding, ship, { operationId: "shore-economy-resolve", random: () => 0.99 });
  assert.ok(ship.portBilling.dailyCopper > 0, "foreign port upkeep remains payable");
  holding.gm.calendaria.lastQd = foreignArrival;
  const homeOffer = quoteWorldShipReturn(data, holding, ship);
  configureWorldShipEconomy(data, holding, ship);
  departWorldShip(holding, ship, { operationId: "shore-economy-home", offer: homeOffer, clockQd: foreignArrival });
  const homeArrival = ship.activeVoyage.arrivalQd;

  ship.homeUpkeepCopperPerDay = 1; // Simulate a stale rate saved by an older module version.
  const refreshed = refreshWorldShipHomeEconomy(data, holding);
  const fullHomeRate = ship.homeUpkeepCopperPerDay;
  assert.equal(refreshed.refreshed, 1);
  if (enabled) assert.ok(fullHomeRate > 120, "an in-flight return projects all linked crew as resting at home");
  else assert.equal(fullHomeRate, 0, "home exemption survives a round trip and rate refresh");
  assert.equal(worldShipPresenceDays(holding, foreignArrival, homeArrival + 4).get(sailor.id), 0, "returning crew does not consume settlement food before a shore-duty decision");

  const report = { work: [], skipped: [], ledger: [], treasury: { spent: 0 } };
  advanceWorldShipEconomy(holding, homeArrival + 4, report, (target, row) => target.ledger.push(row));
  assert.equal(report.treasury.spent, 0, "an early return pauses on its actual arrival date");
  advanceWorldShipEconomy(holding, homeArrival + 4, report, (target, row) => target.ledger.push(row));
  assert.equal(report.treasury.spent, fullHomeRate, "the first full day at home uses the refreshed crew-inclusive rate");
  assert.equal(sailor.shipAssignment.away, false);
  assert.equal(isResidentRestingOnShip(sailor, holding), true);
}

function toggleHomeUpkeep() {
  const { data, holding, ship } = worldMarketFixture();
  const rate = ship.homeUpkeepCopperPerDay;
  assert.ok(rate > 0);
  assert.equal(Object.hasOwn(ship, "homeUpkeepEnabled"), false, "old data keeps its default without a migration");
  const startingMoney = holding.storage.moneyCopper;
  holding.gm.calendaria.lastQd = 4;
  holding.storage.moneyCopper = 0;
  advanceWorldShips(holding, 4);
  ship.homeUpkeepEnabled = false;
  configureWorldShipEconomy(data, holding, ship);
  assert.equal(ship.portBilling.carriedCopper, rate, "disabling preserves the already accrued day");
  assert.equal(ship.portBilling.dailyCopper, 0);
  const advance = (qd) => {
    const report = { work: [], skipped: [], ledger: [], treasury: { spent: 0 } };
    advanceWorldShipEconomy(holding, qd, report, (target, row) => target.ledger.push(row));
    return report;
  };
  holding.storage.moneyCopper = 0;
  advance(12);
  assert.equal(ship.pendingPortBillCopper, rate, "insufficient funds do not erase earlier debt");
  holding.storage.moneyCopper = startingMoney;
  assert.equal(advance(12).treasury.spent, rate);
  assert.equal(advance(12).treasury.spent, 0, "repeating a calculation never charges twice");
  holding.gm.calendaria.lastQd = 12;
  holding.people.list[0].shipAssignment = { shipId: ship.id, shoreDuty: true, away: false };
  refreshWorldShipHomeEconomy(data, holding);
  assert.equal(ship.homeUpkeepCopperPerDay, 0, "crew changes do not restore a disabled rate");
  assert.equal(worldShipPresenceDays(holding, 12, 16).get("sailor"), 1, "working sailors still use settlement food");
  ship.homeUpkeepEnabled = true;
  configureWorldShipEconomy(data, holding, ship);
  const newRate = ship.homeUpkeepCopperPerDay;
  assert.ok(newRate > 0);
  assert.equal(advance(12).treasury.spent, 0, "enabling does not back-charge the free period");
  assert.equal(advance(16).treasury.spent, newRate);
  assert.equal(holding.storage.moneyCopper, startingMoney - rate - newRate);
}

presenceAndSettlementAccounting();
homeRateAndFoodPresence();
returningCrewUsesFullHomeRate();
returningCrewUsesFullHomeRate(false);
toggleHomeUpkeep();
console.log("FBL Skyhold ship shore economy check passed.");
