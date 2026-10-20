import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_BUILDING_TEMPLATES } from "../data/building-templates.js";
import { buildingCatalogV17Templates } from "../data/building-template-revision-v17.js";
import { normalizeLivestockBuilding } from "../data/livestock.js";
import { normalizeLivestockState, planLivestockTenday } from "../engines/economy/livestock.js";
import { resourceBasePriceCopper } from "../core/resources.js";

/** 720 days; preserve the breeder kernel, sell only recurring output and surplus adults.
 * Values assume base prices and timely use/sale; exclude rations, transport and capital.
 */
function simulate(building, breeders) {
  const profile = normalizeLivestockBuilding(building.livestock, { building }).profile;
  let state = normalizeLivestockState({ capacity: profile.capacity, adults: breeders, breedingMales: 1 }, profile);
  const years = [];
  for (let year = 0; year < 3; year += 1) {
    const row = { born: 0, slaughter: 0, feed: 0, work: 0, output: {}, value: 0 };
    for (let day = 0; day < 240; day += 1) {
      const season = ["spring", "summer", "autumn", "winter"][Math.floor(day / 60)];
      const maturing = state.young.filter((cohort) => cohort.ageQd + 4 >= profile.maturityQd).reduce((sum, cohort) => sum + cohort.qty, 0);
      const plan = planLivestockTenday({ profile, state, elapsedQd: 4, seasonId: season, seasonKey: `${year}:${season}`,
        availableFeedUnits: 100_000, availableWorkQd: 2,
        operations: { milk: true, eggs: true, shearQty: profile.capacity, slaughterQty: Math.max(0, state.adults + maturing - breeders) } });
      state = plan.stateAfter;
      assert.ok(state.adults >= breeders, "Never sell the original breeder kernel");
      row.born += plan.born;
      row.slaughter += plan.slaughter.appliedQty;
      row.feed += plan.feeding.feedConsumed;
      row.work += plan.workQdUsed;
      for (const output of plan.resourceChanges.filter((change) => change.qty > 0)) {
        row.output[output.resourceId] = (row.output[output.resourceId] ?? 0) + output.qty;
        row.value += output.qty * resourceBasePriceCopper(output.resourceId);
      }
    }
    row.wages = row.work * building.wageDailyCopper / 2;
    row.overhead = (building.baseUpkeepMonthlyCopper + building.operatingUpkeepMonthlyCopper) * 8;
    row.balance = row.value - row.wages - row.feed * resourceBasePriceCopper(profile.feedResourceId) - row.overhead;
    row.adults = state.adults;
    years.push(row);
  }
  return { id: building.id, breeders, capacity: profile.capacity, years };
}

export function checkProductionHerdBalance() {
  const old = buildingCatalogV17Templates();
  const cases = [["pigsty", 3], ["sheepfold", 12], ["pasture", 8]];
  const current = cases.map(([id, breeders]) => simulate(DEFAULT_BUILDING_TEMPLATES.find((row) => row.id === id), breeders));
  const baseline = [["pigsty", 3], ["sheepfold", 6]].map(([id, breeders]) => simulate(old.find((row) => row.id === id), breeders));
  assert.equal(current[1].capacity, 24, "The actual normalized sheepfold has room for breeding lambs");
  for (const herd of current.slice(0, 2)) for (const year of herd.years) {
    assert.equal(year.born, year.slaughter, "Renewable output in every 240-day year");
    assert.equal(year.adults, herd.breeders);
    assert.ok(year.balance > 0, `${herd.id}: recurring output covers feed, actual care/culling work and upkeep`);
  }
  for (const herd of baseline) assert.ok(herd.years.reduce((sum, year) => sum + year.balance, 0) < 0,
    "Reproduce the old three-year loss; a profitable culling year alone does not establish sustainability");
  assert.ok(current[2].years.every((year, index) => year.balance > current[1].years[index].balance), "Milk retains its approved economic advantage");
  return { baseline, current };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(checkProductionHerdBalance(), null, 2));
}
