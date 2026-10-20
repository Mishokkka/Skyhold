import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { applySettlementHunger } from "../engines/economy/hunger.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { planLivestockTenday } from "../engines/economy/livestock.js";
import { livestockProfileForSpecies, normalizeLivestockBuilding } from "../data/livestock.js";
import { addStorageWithOverflow } from "../engines/storage/placement.js";
import { splitResourceBatchParts } from "../core/resource-batches.js";
import { storageProfileLoadMultiplier } from "../engines/storage/specialization.js";
import { recordFleetFunds, fleetAccountingSummary, shipIdleReserveCopper } from "../engines/ships/fleet-accounting.js";
import { bundleOutcomeReserves, bundleOperatingShares } from "../engines/ships/bundle-accounting.js";
import { departShip, adjustShipFunds, advanceShipVoyages } from "../engines/ships/runtime.js";
import { contractGuidance } from "../engines/ships/contracts.js";

export function checkEconomyPeriodBoundaries() {
  const full = {}, daily = {};
  applySettlementHunger({ holding: full, hungryResidentDays: 120, livingCount: 12 });
  for (let i = 0; i < 10; i++) applySettlementHunger({ holding: daily, hungryResidentDays: 12, livingCount: 12, periodDays: 1 });
  assert.deepEqual(daily.gm.food, full.gm.food, "splitting starvation does not reset the penalty");
  applySettlementHunger({ holding: full, livingCount: 12 });
  for (let i = 0; i < 10; i++) applySettlementHunger({ holding: daily, livingCount: 12, periodDays: 1 });
  assert.deepEqual(daily.gm.food, full.gm.food, "recovery also follows elapsed days");
  const reloaded = mergeHoldingDefaults({ people: { list: [{ id: "p" }] }, gm: {
    food: { hungerLevel: 2, hungerAcuteDays: 1.5 },
    moraleSnapshot: { ration: { tier: "normal", modifier: -0.01, effectiveUnits: 9.95, diversityBonus: 2 },
      residents: { p: { ration: { value: 1.99, diversityBonus: 2 } } } }
  } });
  assert.equal(reloaded.gm.food.hungerAcuteDays, 1.5);
  assert.equal(reloaded.gm.moraleSnapshot.ration.modifier, -0.01);
  assert.equal(reloaded.gm.moraleSnapshot.residents.p.ration.value, 1.99);
  assert.equal(reloaded.gm.moraleSnapshot.residents.p.ration.diversityBonus, 2);

  const profile = livestockProfileForSpecies("poultry");
  const args = { profile, seasonId: "winter", seasonKey: "1:winter", state: { adults: 3 }, availableWorkQd: 10, availableFeedUnits: 100 };
  const tenDays = planLivestockTenday({ ...args, elapsedQd: 40 });
  let state = args.state, feed = 0;
  for (let i = 0; i < 10; i++) {
    const step = planLivestockTenday({ ...args, state, elapsedQd: 4 });
    feed += step.feeding.feedConsumed;
    state = normalizeLivestockBuilding({ speciesId: "poultry", state: step.stateAfter }).state;
  }
  assert.equal(feed, tenDays.feeding.feedConsumed, "winter feed must not be charged ten times for ten daily advances");
  assert.equal(state.feedCreditNumerator, tenDays.stateAfter.feedCreditNumerator);
  state = args.state;
  for (let i = 0; i < 20; i++) {
    const step = planLivestockTenday({ ...args, state, elapsedQd: 4, availableFeedUnits: 0, availableWorkQd: 0 });
    assert.equal(step.warnings.some((text) => text.startsWith("Повторный недостаток")), i === 19);
    state = normalizeLivestockBuilding({ speciesId: "poultry", state: step.stateAfter }).state;
  }
  assert.equal(state.shortageQd, 80);
  assert.equal(state.adults, 3, "neglect does not silently kill animals");

  const rooms = [
    { id: "general", available: true, autoReceive: true, capacity: 1, used: 0, profileEffectFactor: 1 },
    { id: "inactive", available: true, autoReceive: true, capacity: 100, used: 0, profileEffectFactor: 0, profileResourceIds: ["grain"] },
    { id: "barn", available: true, autoReceive: true, capacity: 2, used: 0, profileEffectFactor: 1, profileResourceIds: ["grain"] },
    { id: "outdoors", available: true, unlimited: true }
  ];
  const placed = [];
  const deps = {
    safeNumber: (v, f = 0) => Number.isFinite(Number(v)) ? Number(v) : f,
    normalizeResourceId: (v) => v, isMoneyResource: () => false,
    normalizeStorageRoomId: (v) => v || "outdoors", storageRooms: () => rooms,
    storageAdd: (_h, row, qty) => placed.push({ ...row, qty }),
    storageUnitLoad: () => 1, storageProfileLoadMultiplier, splitTransferBatches: splitResourceBatchParts
  };
  const cargo = { resourceId: "grain", roomId: "auto", batches: [{ id: "old", qty: 4, ageQd: 7 }] };
  const result = addStorageWithOverflow({ holding: {}, resource: cargo, qty: 4, dependencies: deps });
  assert.deepEqual(result.map((row) => [row.roomId, row.qty]), [["barn", 2], ["general", 1], ["outdoors", 1]]);
  assert.ok(placed.every((row) => row.batches[0].ageQd === 7));
  placed.length = 0;
  addStorageWithOverflow({ holding: {}, resource: { ...cargo, roomId: "general" }, qty: 4, dependencies: deps });
  assert.deepEqual(placed.map((row) => [row.roomId, row.qty]), [["general", 1], ["outdoors", 3]], "explicit rooms remain explicit");
  rooms.push({ id: "cellar", available: true, capacity: 2, used: 0, profileEffectFactor: 1, shelfLifeMultiplier: 2, profilePerishableFood: true });
  placed.length = 0;
  const arrival = addStorageWithOverflow({ holding: {}, resource: { resourceId: "food-fruit", roomId: "cellar",
    arrivalShelfLifeQd: 10, batches: [{ id: "arrival", qty: 4, ageQd: 15 }] }, qty: 4, dependencies: deps });
  assert.deepEqual(arrival.map((row) => [row.roomId, row.qty, row.spoiledQty ?? 0]), [["cellar", 2, 0], ["outdoors", 0, 2]],
    "actual room protection applies, while expired overflow cannot become edible stock");
  assert.equal(placed.length, 1);
  assert.equal(placed[0].arrivalShelfLifeQd, undefined, "placement control flags are not saved");

  const ship = { navigationMode: "world" };
  recordFleetFunds(ship, { externalDeltaCopper: 0, treasuryDeltaCopper: -1000, shipDeltaCopper: 1000 });
  assert.equal(ship.fleetAccounting, undefined, "internal wallet transfers create no fleet expense");
  recordFleetFunds(ship, { externalDeltaCopper: -100 }, { clockQd: 40, idle: "home" });
  recordFleetFunds(ship, { externalDeltaCopper: 500 }, { clockQd: 80 });
  recordFleetFunds(ship, { externalDeltaCopper: -50 }, { clockQd: 84, idle: "port" });
  const summary = fleetAccountingSummary({ special: { ships: { list: [ship] } } });
  assert.equal(summary.netCopper, 350); assert.equal(summary.homeIdleCopper, 100); assert.equal(summary.portIdleCopper, 50);
  assert.equal(shipIdleReserveCopper(12, 40), 24);
  assert.equal(shipIdleReserveCopper(12, 41), 117);
  const simpleShip = { id: "simple", name: "Судно", status: "docked", condition: "ready", onboardCopper: 0, speedKmPerDay: 10,
    routePlan: { destination: "Порт", distanceKm: 10, portDays: 0, upkeepPerDayCopper: 5, preparationCopper: 2, rewardCopper: 30 } };
  const shipHolding = { gm: { calendaria: { lastQd: 0 } }, storage: { moneyCopper: 100 }, special: { ships: { list: [simpleShip], history: [] } } };
  departShip(shipHolding, simpleShip, { operationId: "simple-voyage", budgetCopper: 20, clockQd: 0 });
  adjustShipFunds(shipHolding, simpleShip, { operationId: "manual-receipt", voyageId: "simple-voyage", kind: "income", amountCopper: 4, reason: "Доход" });
  adjustShipFunds(shipHolding, simpleShip, { operationId: "manual-receipt", voyageId: "simple-voyage", kind: "income", amountCopper: 4, reason: "Доход" });
  advanceShipVoyages(shipHolding, 8);
  assert.equal(simpleShip.fleetAccounting.incomeCopper, 34, "simple voyages are included once, including manual income and return reward");
  assert.equal(simpleShip.fleetAccounting.expenseCopper, 12, "departure transfer is excluded; preparation and operating expenses remain");
  assert.equal(fleetAccountingSummary(shipHolding).netCopper, 22);

  const offers = ["a", "b"].map((id) => ({ id, to: { kind: "port", id: "same" },
    contract: { kind: "commission", rewardCopper: 1000, cargo: { loadPoints: 100 }, guidance: { operatingCopper: 100, preparationCopper: 0 } } }));
  const shares = bundleOperatingShares(offers, 200), reserves = bundleOutcomeReserves(offers, 200);
  const expected = offers.map((offer, i) => Math.max(...["cautious", "normal", "bold"].map((style) =>
    contractGuidance({ ...offer.contract, guidance: { ...offer.contract.guidance, operatingCopper: shares[i] } }, style,
      { commercialOnly: i > 0 }).suggestedBudgetCopper - shares[i])));
  assert.deepEqual(reserves, expected, "one destination gets one shared incident reserve");
  assert.ok(reserves[0] > reserves[1]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkEconomyPeriodBoundaries();
  console.log("Economy boundaries: daily periods, reload, routing, arrival expiry, fleet cash and shared reserves passed.");
}
