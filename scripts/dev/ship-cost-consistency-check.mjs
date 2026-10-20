import assert from "node:assert/strict";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { configureWorldShipEconomy, generateWorldShipOffers, quoteWorldShipReturn, quoteWorldShipSale } from "../engines/ships/world-market.js";
import { advanceWorldShipEconomy, refreshWorldShipHomeEconomy } from "../engines/ships/world-economy.js";
import { advanceWorldShips, departWorldShip, resolveWorldShip } from "../engines/ships/world-voyage.js";
import { shipCrewReadiness } from "../engines/ships/crew-readiness.js";
import { calculatePlannedWorkerWage } from "../engines/economy/finance-obligations.js";
import { appendEconomyLedger, economyLedgerStorageRows } from "../engines/economy/ledger.js";
import { marketHistoricalInsuranceRate } from "../engines/market/pricing.js";
import { buildShipWorldContext } from "../engines/ships/world-market.js";
import { createShipOperationExecutor } from "../apps/ship-operation-executor.js";

// Raising the insurance minimum must never raise uninsured own-vessel handling.
{
  const { data, holding, ship } = worldMarketFixture();
  const offers = generateWorldShipOffers(data, holding, ship, { period: 0, random: () => 0.4 });
  const accepted = structuredClone(offers[0]);
  const saleBefore = quoteWorldShipSale(data, holding, ship, "a", { loadPoints: 400, valueCopper: 10000 });
  data.catalog.marketEconomy.settings = { handlingSubtotalRate: 0.1 };
  const saleAfter = quoteWorldShipSale(data, holding, ship, "a", { loadPoints: 400, valueCopper: 10000 });
  assert.equal(saleAfter.quote.costs.handlingCopper, saleBefore.quote.costs.handlingCopper);
  const context = buildShipWorldContext(data, holding);
  const port = context.ports.find((row) => row.id === "a");
  assert.equal(saleAfter.quote.costs.handlingCopper, Math.ceil(port.locationProfile.deliveryFlatCopper + 100 * port.locationProfile.deliveryLoadCopper));
  assert.ok(marketHistoricalInsuranceRate({ location: port.locationProfile }) >= 0.1);
  const snapshot = JSON.stringify(accepted.quote);
  departWorldShip(holding, ship, { operationId: "accepted-price", offer: accepted, clockQd: 0 });
  assert.equal(JSON.stringify(ship.activeVoyage.quote.costs), JSON.stringify(accepted.quote.costs), "already accepted prices are frozen");
  assert.equal(JSON.stringify(accepted.quote), snapshot);
}

// Every paid copper is attributed to the account actually debited, including debt retry.
for (const scope of ["home", "market"]) {
  for (const wallet of [0, 40, 100, 300]) {
    const { holding, ship } = worldMarketFixture();
    if (scope === "market") {
      ship.status = "away";
      ship.location = { kind: "market", id: "a", regionId: "a", label: "А" };
    }
    ship.portBilling = { scope, dailyCopper: 100, sinceQd: 0, lastCalculatedQd: 0, chargedCopper: 0, carriedCopper: 0 };
    ship.onboardCopper = wallet;
    const treasuryBefore = holding.storage.moneyCopper;
    const advance = () => {
      const report = { work: [], skipped: [], ledger: [], treasury: { spent: 0 } };
      const result = advanceWorldShipEconomy(holding, 4, report, appendEconomyLedger);
      return { report, result };
    };
    const paid = scope === "home" || wallet >= 100;
    const treasuryPaid = scope === "home" ? Math.max(0, 100 - wallet) : 0;
    const onboardPaid = paid ? 100 - treasuryPaid : 0;
    const { report, result } = advance();
    assert.equal(report.treasury.spent, treasuryPaid);
    assert.equal(holding.storage.moneyCopper, treasuryBefore - treasuryPaid);
    assert.equal(ship.onboardCopper, wallet - onboardPaid);
    assert.equal(report.ledger.filter((row) => row.roomId === "treasury").reduce((sum, row) => sum - row.qty, 0), treasuryPaid);
    assert.equal(report.ledger.filter((row) => row.meta.shipWallet).reduce((sum, row) => sum - row.qty, 0), onboardPaid);
    assert.ok(report.ledger.filter((row) => row.meta.shipWallet).every((row) => row.roomId === `ship:${ship.id}`));
    assert.equal(economyLedgerStorageRows(report.ledger).reduce((sum, row) => sum - row.qty, 0), paid ? 100 : 0);
    if (paid) {
      assert.equal(result.expenses[0].treasuryPaidCopper + result.expenses[0].onboardPaidCopper, 100);
      assert.ok(report.work[0].includes(treasuryPaid ? `общая казна: ${treasuryPaid}` : "бортовая казна: 100"));
    } else {
      assert.equal(ship.pendingPortBillCopper, 100);
      ship.onboardCopper = 100;
      assert.equal(advance().result.expenses[0].onboardPaidCopper, 100, "foreign debt is retried only against the ship wallet");
    }
    assert.equal(advance().report.ledger.length, 0, "repeating the same date cannot report or charge the bill twice");
  }
}
{
  const { holding, ship } = worldMarketFixture();
  holding.storage.moneyCopper = 40;
  ship.onboardCopper = 50;
  ship.portBilling = { scope: "home", dailyCopper: 100, sinceQd: 0, lastCalculatedQd: 0, chargedCopper: 0, carriedCopper: 0 };
  const report = { work: [], skipped: [], ledger: [], treasury: { spent: 0 } };
  advanceWorldShipEconomy(holding, 4, report, appendEconomyLedger);
  assert.equal(ship.pendingPortBillCopper, 100);
  assert.equal(report.ledger.length, 0);
  assert.deepEqual([holding.storage.moneyCopper, ship.onboardCopper], [40, 50]);
  holding.storage.moneyCopper = 60;
  advanceWorldShipEconomy(holding, 4, report, appendEconomyLedger);
  assert.deepEqual([report.treasury.spent, holding.storage.moneyCopper, ship.onboardCopper], [50, 10, 0]);
}

// Ship and shore use the same positive paid wage / explicit volunteer contract.
for (const [override, volunteer, valid] of [[null, false, true], [19, false, true], [0, false, false], [0, true, true]]) {
  const { data, holding, ship } = worldMarketFixture();
  ship.id = "generic-test-ship";
  for (let index = 1; index < 36; index++) {
    const id = `paid-sailor-${index}`;
    holding.people.list.push({ id, name: id, wageDailyOverrideCopper: 12 });
    ship.crewResidentIds.push(id);
  }
  configureWorldShipEconomy(data, holding, ship);
  const person = holding.people.list[0];
  person.wageDailyOverrideCopper = override;
  person.volunteerLabor = volunteer;
  const readiness = shipCrewReadiness(holding, ship);
  const shore = calculatePlannedWorkerWage({ id: person.id, volunteer, wageOverrideCopper: override, assignments: [{ dailyRateCopper: 12, normalQd: 4 }] });
  assert.equal(readiness.ready, valid);
  assert.equal(shore.ok, valid);
  const before = JSON.stringify(person);
  if (valid) {
    const offer = generateWorldShipOffers(data, holding, ship, { period: 0, random: () => 0.4 })[0];
    const daily = 35 * 12 + (volunteer ? 0 : override ?? 12);
    assert.equal(offer.quote.costs.crewCopper, Math.ceil(daily * offer.quote.durationQd / 4));
    configureWorldShipEconomy(data, holding, ship);
  } else {
    const oldRate = ship.homeUpkeepCopperPerDay;
    const quote = configureWorldShipEconomy(data, holding, ship);
    assert.equal(quote.rateFrozen, true);
    assert.equal(ship.homeUpkeepCopperPerDay, oldRate, "an invalid legacy wage never changes the accepted home rate silently");
    const report = { skipped: [] };
    refreshWorldShipHomeEconomy(data, holding, { report });
    refreshWorldShipHomeEconomy(data, holding, { report });
    assert.equal(report.skipped.length, 1);
    assert.match(report.skipped[0], /положительное дневное жалование.*Домашняя ставка сохранена/);
    const offer = generateWorldShipOffers(data, holding, ship, { period: 0, random: () => 0.4 })[0];
    holding.special.ships.offers = [offer];
    holding.gm.playersCanManageShips = true;
    holding.visibility = "public";
    for (const isGM of [true, false]) {
      let commits = 0;
      const user = { id: isGM ? "gm" : "player", isGM };
      const execute = createShipOperationExecutor({
        getUser: () => user,
        updateHolding: async (_id, updater) => {
          const draft = structuredClone(data);
          const result = await updater(draft.holdings[0], draft);
          commits++;
          return result;
        }
      });
      await assert.rejects(execute({ type: "depart-world", operationId: `wage-${user.id}`, holdingId: holding.id, shipId: ship.id,
        expectedRevision: data.meta.revision, offerId: offer.id, locationKind: "home", locationId: ship.location.id }, { userId: user.id, remote: !isGM }), /положительное дневное жалование/);
      assert.equal(commits, 0, "GM and player rejection must leave the draft uncommitted");
    }
  }
  assert.equal(JSON.stringify(person), before, "validation never edits a saved wage or enables volunteering");
}

// Fixing an invalid wage changes only the future rate and preserves an unpaid bill.
{
  const { data, holding, ship } = worldMarketFixture();
  const oldRate = ship.homeUpkeepCopperPerDay;
  const person = holding.people.list[0];
  person.wageDailyOverrideCopper = 0;
  holding.storage.moneyCopper = 0;
  configureWorldShipEconomy(data, holding, ship);
  const report = { work: [], skipped: [], ledger: [], treasury: { spent: 0 } };
  advanceWorldShipEconomy(holding, 4, report, appendEconomyLedger);
  assert.equal(ship.pendingPortBillCopper, oldRate);
  person.volunteerLabor = true;
  const corrected = configureWorldShipEconomy(data, holding, ship);
  assert.equal(corrected.rateFrozen, false);
  assert.equal(corrected.homeUpkeepCopperPerDay, oldRate - 12, "volunteering removes wages, not food or hull upkeep");
  assert.equal(ship.pendingPortBillCopper, oldRate, "correcting wages cannot erase already accrued debt");
  holding.storage.moneyCopper = 1000;
  advanceWorldShipEconomy(holding, 8, report, appendEconomyLedger);
  assert.equal(report.treasury.spent, oldRate + corrected.homeUpkeepCopperPerDay);
  assert.equal(ship.pendingPortBillCopper, 0);
}

// A changed legacy wage cannot invalidate a saved voyage or prevent recovery home.
{
  const { data, holding, ship } = worldMarketFixture();
  const offer = generateWorldShipOffers(data, holding, ship, { period: 0, random: () => 0.4 })[0];
  departWorldShip(holding, ship, { operationId: "legacy-wage", offer, clockQd: 0 });
  const acceptedCosts = structuredClone(ship.activeVoyage.quote.costs);
  holding.people.list[0].wageDailyOverrideCopper = 0;
  refreshWorldShipHomeEconomy(data, holding);
  assert.deepEqual(ship.activeVoyage.quote.costs, acceptedCosts);
  const arrival = ship.activeVoyage.arrivalQd;
  advanceWorldShips(holding, arrival);
  resolveWorldShip(holding, ship, { operationId: "legacy-wage-outcome", random: () => 0.99 });
  holding.gm.calendaria.lastQd = arrival;
  assert.doesNotThrow(() => configureWorldShipEconomy(data, holding, ship));
  const home = quoteWorldShipReturn(data, holding, ship);
  assert.equal(departWorldShip(holding, ship, { operationId: "legacy-wage-home", offer: home, clockQd: arrival }).ok, true);
  const homeArrival = ship.activeVoyage.arrivalQd;
  const report = { work: [], skipped: [], ledger: [], treasury: { spent: 0 } };
  advanceWorldShipEconomy(holding, homeArrival, report, appendEconomyLedger);
  assert.equal(ship.location.kind, "home");
  refreshWorldShipHomeEconomy(data, holding, { report });
  assert.ok(report.skipped.some((message) => message.includes("Домашняя ставка сохранена")), "final period refresh must not undo a legacy voyage's return");
}

console.log("Ship costs: insurance/handling separation, exact treasury/wallet attribution, debt retries, paid/volunteer wages, GM/player authority and saved-voyage recovery passed.");
