import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyLivestockPlan, livestockHeadcount, normalizeLivestockState, planLivestockTenday } from "../engines/economy/livestock.js";
import { LIVESTOCK_MARKET_PRICES_COPPER, livestockProfileForSpecies, normalizeLivestockBuilding } from "../data/livestock.js";

const cattle = {
  speciesId: "cattle",
  capacity: 12,
  grazingSeasons: ["spring", "summer", "autumn"],
  breedingSeasonId: "spring",
  maturityQd: 80,
  offspringNumerator: 1,
  offspringDenominator: 2,
  producesMilk: true,
  milkPerHeadDay: 1,
  milkWorkQdPerHeadDay: 1,
  milkBatchWorkQdPerDay: 1,
  feedUnitsPerHead: 2,
  meatPerAdult: 6,
  peltResourceId: "pelt",
  peltPerAdult: 1,
  slaughterWorkQdPerHead: 1
};

export function checkLivestockCharacterization() {
  const persistedPasture = normalizeLivestockBuilding({
    speciesId: "cattle",
    profile: { capacity: 99 },
    state: { adults: 15, breedingMales: 2, young: [{ id: "calves", qty: 3, ageQd: 40 }] },
    operations: { milk: true, slaughterQty: 1 }
  }, { building: { templateId: "pasture" } });
  assert.equal(persistedPasture.profile.capacity, 12, "a specialist livestock building may never exceed its species-specific twelve-head cap");
  assert.equal(persistedPasture.state.adults, 12, "hard capacity must also hold during persistence normalization");
  assert.deepEqual(persistedPasture.state.young, [], "young cohorts above hard capacity must not survive normalization");
  assert.equal(livestockProfileForSpecies("pigs").feedResourceId, "animal-feed");
  assert.deepEqual(LIVESTOCK_MARKET_PRICES_COPPER, {
    cattle: 1200,
    pigs: 360,
    sheep: 240,
    goats: 180,
    horses: 3600,
    poultry: 24,
    rabbits: 12,
    pigeons: 6
  });
  assert.equal(livestockProfileForSpecies("cattle").marketPriceCopper, 1200);
  assert.equal(livestockProfileForSpecies("horses").marketPriceCopper, 3600);
  const animalPen = normalizeLivestockBuilding({
    speciesId: "poultry",
    profile: { capacity: 99 },
    state: { adults: 30 }
  }, { building: { templateId: "animal-pen" } });
  assert.equal(animalPen.profile.capacity, 24, "the mixed animal pen keeps the approved twenty-four-bird capacity");
  assert.equal(animalPen.state.adults, 24);

  const source = normalizeLivestockState({ speciesId: "cattle", capacity: 12, adults: 6, breedingMales: 1 }, cattle);
  assert.equal(livestockHeadcount(source), 6);
  const spring = planLivestockTenday({
    state: source,
    profile: cattle,
    elapsedQd: 40,
    seasonId: "spring",
    seasonKey: "spring-100",
    availableFeedUnits: 0,
    availableWorkQd: 20,
    operations: { milk: true },
    operationId: "spring"
  });
  assert.equal(spring.feeding.grazing, true);
  assert.equal(spring.feeding.feedConsumed, 0);
  assert.equal(spring.born, 2);
  assert.equal(spring.milk.outputQty, 50, "one daily batch QD must milk every eligible cow in the building without accumulating missed days");
  assert.equal(livestockHeadcount(spring.stateAfter), 8);

  const repeatedBirth = planLivestockTenday({
    state: spring.stateAfter,
    profile: cattle,
    seasonId: "spring",
    seasonKey: "spring-100",
    elapsedQd: 40,
    availableWorkQd: 0
  });
  assert.equal(repeatedBirth.born, 0, "birth must occur only once in the configured season key");

  const winter = planLivestockTenday({
    state: source,
    profile: cattle,
    seasonId: "winter",
    seasonKey: "winter-100",
    elapsedQd: 40,
    availableFeedUnits: 4,
    availableWorkQd: 40,
    operations: { milk: true }
  });
  assert.equal(winter.feeding.feedConsumed, 4);
  assert.equal(winter.feeding.fedAdults, 2);
  assert.equal(winter.milk.outputQty, 10, "only fed adult females may produce milk");
  assert.equal(winter.warnings.some((row) => row.includes("Не накормлено")), true);
  assert.equal(winter.stateAfter.adults, source.adults, "unfed animals stop producing but never die automatically");

  const capacity = planLivestockTenday({
    state: { speciesId: "cattle", capacity: 12, adults: 11, breedingMales: 1 },
    profile: cattle,
    seasonId: "spring",
    seasonKey: "spring-101",
    elapsedQd: 40,
    availableWorkQd: 10
  });
  assert.equal(capacity.born, 1, "offspring must be capped by hard building capacity");
  assert.equal(livestockHeadcount(capacity.stateAfter), 12);

  const matured = planLivestockTenday({
    state: { speciesId: "cattle", capacity: 12, adults: 2, breedingMales: 1, young: [{ id: "calves", qty: 2, ageQd: 60 }] },
    profile: cattle,
    seasonId: "winter",
    availableFeedUnits: 100, // The maturation case assumes fed young; starvation is covered separately.
    elapsedQd: 20
  });
  assert.equal(matured.matured, 2);
  assert.equal(matured.stateAfter.adults, 4);

  const sheepProfile = {
    speciesId: "sheep",
    capacity: 12,
    grazingSeasons: ["spring"],
    shearingSeasonId: "spring",
    maturityQd: 40,
    producesWool: true,
    woolPerHead: 1,
    shearWorkQdPerHead: 1
  };
  const sheepReady = planLivestockTenday({
    state: { speciesId: "sheep", capacity: 12, adults: 4, breedingMales: 1, woolReady: 0 },
    profile: sheepProfile,
    seasonId: "spring",
    seasonKey: "100:spring",
    elapsedQd: 40,
    availableWorkQd: 11,
    operations: { shearQty: 2 }
  });
  assert.equal(sheepReady.wool.outputQty, 2);
  assert.equal(sheepReady.stateAfter.woolReady, 2);
  const sheepSameSeason = planLivestockTenday({
    state: sheepReady.stateAfter,
    profile: sheepProfile,
    seasonId: "spring",
    seasonKey: "100:spring",
    elapsedQd: 40,
    availableWorkQd: 0,
    operations: { shearQty: 0 }
  });
  assert.equal(sheepSameSeason.stateAfter.woolReady, 2, "wool readiness must not refill every tenday in one shearing season");
  const sheepNextYear = planLivestockTenday({
    state: sheepSameSeason.stateAfter,
    profile: sheepProfile,
    seasonId: "spring",
    seasonKey: "101:spring",
    elapsedQd: 40,
    availableWorkQd: 10,
    operations: { shearQty: 0 }
  });
  assert.equal(sheepNextYear.stateAfter.woolReady, 4, "a new seasonal key makes the surviving adult flock ready once without stacking above headcount");

  const slaughterBlocked = planLivestockTenday({
    state: { speciesId: "cattle", capacity: 12, adults: 3, breedingMales: 1 },
    profile: cattle,
    seasonId: "winter",
    availableWorkQd: 13,
    operations: { slaughterQty: 3, slaughterBreedingMales: 0 }
  });
  assert.equal(slaughterBlocked.slaughter.appliedQty, 2, "breeding males require an explicit slaughter choice");
  assert.equal(slaughterBlocked.warnings.some((row) => row.includes("явно")), true);
  const slaughterMale = planLivestockTenday({
    state: { speciesId: "cattle", capacity: 12, adults: 3, breedingMales: 1 },
    profile: cattle,
    seasonId: "winter",
    availableWorkQd: 13,
    operations: { slaughterQty: 3, slaughterBreedingMales: 1 }
  });
  assert.equal(slaughterMale.slaughter.appliedQty, 3);
  assert.equal(slaughterMale.slaughter.outputQty, 18);
  assert.equal(slaughterMale.resourceChanges.find((row) => row.resourceId === "pelt")?.qty, 3);
  assert.equal(slaughterMale.slaughter.workQd, 3, "slaughter must consume explicit work QD per head");
  assert.equal(slaughterMale.warnings.some((row) => row.includes("последнего")), false, "warning is unnecessary when no herd remains to breed");

  const laborLimitedSlaughter = planLivestockTenday({
    state: { speciesId: "pigs", capacity: 12, adults: 5, breedingMales: 1 },
    profile: { speciesId: "pigs", capacity: 12, meatPerAdult: 4, slaughterWorkQdPerHead: 2 },
    seasonId: "summer",
    availableFeedUnits: 5,
    availableWorkQd: 12,
    operations: { slaughterQty: 3 }
  });
  assert.equal(laborLimitedSlaughter.slaughter.appliedQty, 1, "slaughter must be capped by whole available work cycles");
  assert.equal(laborLimitedSlaughter.slaughter.workQd, 2);
  assert.match(laborLimitedSlaughter.slaughter.warnings[0], /1 из 3/);

  const applyState = { speciesId: "cattle", capacity: 12, adults: 2, breedingMales: 1 };
  const applyPlan = planLivestockTenday({
    state: applyState,
    profile: cattle,
    seasonId: "winter",
    availableFeedUnits: 4,
    availableWorkQd: 10,
    operations: { milk: true }
  });
  const resources = { "animal-feed": 4, milk: 0 };
  let storedState = null;
  const applied = applyLivestockPlan({
    currentState: applyState,
    profile: cattle,
    plan: applyPlan,
    dependencies: {
      resourceQuantity: (id) => resources[id] ?? 0,
      consumeResource: (id, qty) => { resources[id] -= qty; },
      addResource: (id, qty) => { resources[id] = (resources[id] ?? 0) + qty; },
      setState: (state) => { storedState = state; }
    }
  });
  assert.equal(applied.ok, true);
  assert.equal(resources["animal-feed"], 0);
  assert.equal(resources.milk, 10);
  assert.equal(storedState.adults, 2);

  const poultry = livestockProfileForSpecies("poultry");
  const eggs = planLivestockTenday({
    state: { speciesId: "poultry", capacity: 24, adults: 24, breedingMales: 0 },
    profile: poultry,
    seasonId: "winter",
    elapsedQd: 40,
    availableFeedUnits: 12,
    availableWorkQd: 10,
    operations: { eggs: true }
  });
  assert.equal(eggs.eggs.outputQty, 60, "a fully fed and tended twenty-four-bird pen produces sixty eggs per tenday");

  const canonicalCattle = livestockProfileForSpecies("cattle");
  const tallow = planLivestockTenday({
    state: { speciesId: "cattle", capacity: 12, adults: 3, breedingMales: 1 },
    profile: canonicalCattle,
    seasonId: "spring",
    elapsedQd: 40,
    availableWorkQd: 11,
    operations: { slaughterQty: 1 }
  });
  assert.equal(tallow.resourceChanges.find((row) => row.resourceId === "tallow")?.qty, 12, "cattle slaughter yields the approved tallow by-product");

  const stale = applyLivestockPlan({
    currentState: { ...applyState, adults: 3 },
    profile: cattle,
    plan: applyPlan,
    dependencies: {
      resourceQuantity: () => 999,
      consumeResource: () => { throw new Error("stale plan must not spend"); },
      addResource: () => { throw new Error("stale plan must not produce"); },
      setState: () => { throw new Error("stale plan must not write state"); }
    }
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);

  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkLivestockCharacterization();
  console.log("FBL Skyhold livestock: species capacities, daily care, eggs, milk, wool, tallow, explicit slaughter and atomic apply passed.");
}
