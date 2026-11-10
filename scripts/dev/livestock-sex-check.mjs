import assert from "node:assert/strict";
import { livestockProfileForSpecies } from "../data/livestock.js";
import { planLivestockTenday } from "../engines/economy/livestock.js";

const poultry = livestockProfileForSpecies("poultry");
for (const males of [0, 1, 12, 24]) {
  const state = { speciesId: "poultry", capacity: 24, adults: 24, breedingMales: males };
  const first = planLivestockTenday({ state, profile: poultry, elapsedQd: 40, seasonId: "winter",
    availableFeedUnits: 12, availableWorkQd: 10, operations: { eggs: true } });
  const second = planLivestockTenday({ state: first.stateAfter, profile: poultry, elapsedQd: 40, seasonId: "winter",
    availableFeedUnits: 12, availableWorkQd: 10, operations: { eggs: true } });
  assert.equal(first.eggs.adultDays, (24 - males) * 10, "only fed females contribute egg-producing days");
  assert.equal(first.eggs.outputQty + second.eggs.outputQty, (24 - males) * 5, "fractional eggs carry across periods without producing male output");
}
const cattle = livestockProfileForSpecies("cattle");
for (let adults = 2; adults <= 12; adults++) for (let males = 1; males <= adults; males++) {
  for (const selected of [0, 1, males]) {
    const plan = planLivestockTenday({ state: { speciesId: "cattle", capacity: 12, adults, breedingMales: males },
      profile: cattle, elapsedQd: 40, seasonId: "spring", availableWorkQd: 11,
      operations: { slaughterQty: 1, slaughterBreedingMales: selected } });
    const expectedMales = Math.min(selected, 1);
    assert.equal(plan.slaughter.breedingMales, expectedMales, "explicit male selection survives a one-head labor limit");
    assert.equal(plan.stateAfter.breedingMales, males - expectedMales);
    assert.equal(plan.slaughter.appliedQty, selected || adults > males ? 1 : 0, "unselected males remain protected");
    assert.equal(plan.stateAfter.adults + plan.slaughter.appliedQty, adults, "slaughter conserves headcount");
  }
}
console.log("Livestock sex: egg production/remainders and 231 slaughter selections with explicit males and labor limits passed.");
