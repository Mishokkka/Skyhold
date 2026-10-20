import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { ECONOMY_RESOURCE_PRICE_COPPER as PRICE } from "../data/resources/resource-base-definitions.js";
import { LIVESTOCK_MARKET_PRICES_COPPER } from "../data/livestock.js";
import {
  BUILDING_LIVESTOCK_PROFILES,
  BUILDING_PRODUCTION_ECONOMY,
  BUILDING_PRODUCTION_RECIPES,
  BUILDING_SEASONAL_PROFILES
} from "./building-production-line-proposal-data.mjs";

const markdown = await fs.readFile(new URL("../../docs/building-development-tree-proposal.md", import.meta.url), "utf8");

function valueOf(entries = {}) {
  return Object.entries(entries).reduce((sum, [resourceId, qty]) => {
    assert.ok(Object.hasOwn(PRICE, resourceId), `Missing canonical price for ${resourceId}`);
    assert.ok(Number.isInteger(qty) && qty > 0, `Invalid input quantity for ${resourceId}`);
    return sum + PRICE[resourceId] * qty;
  }, 0);
}

const audit = BUILDING_PRODUCTION_RECIPES.map((recipe) => {
  const economy = BUILDING_PRODUCTION_ECONOMY[recipe.building];
  assert.ok(economy, `Missing production economy for ${recipe.building}`);
  assert.ok(Object.hasOwn(PRICE, recipe.outputId), `Missing canonical price for ${recipe.outputId}`);
  assert.ok(Number.isInteger(recipe.outputQty) && recipe.outputQty > 0, `Invalid output for ${recipe.building}: ${recipe.name}`);
  assert.ok(Number.isInteger(recipe.qd) && recipe.qd > 0, `Invalid QD for ${recipe.building}: ${recipe.name}`);
  assert.ok(!Object.hasOwn(recipe.inputs, recipe.outputId), `Recipe consumes its own output: ${recipe.building}: ${recipe.name}`);

  const inputCopper = valueOf(recipe.inputs);
  const outputCopper = PRICE[recipe.outputId] * recipe.outputQty;
  const wageDaily = recipe.wageDailyOverride ?? economy.wageDaily;
  const wageCopper = recipe.qd * wageDaily / 2;
  const marginCopper = outputCopper - inputCopper - wageCopper;
  const marginPerQd = marginCopper / recipe.qd;
  return { ...recipe, inputCopper, outputCopper, wageCopper, marginCopper, marginPerQd, economy };
});

assert.equal(audit.length, 78, "Expected every approved linear recipe and alternative profile");
assert.equal(new Set(audit.map((row) => `${row.building}\u0000${row.name}`)).size, audit.length, "Production recipe keys must be unique");

const ordinary = audit.filter((row) => !row.storyOnly && !row.strategic);
const story = audit.filter((row) => row.storyOnly);
const strategic = audit.filter((row) => row.strategic);
assert.equal(ordinary.length, 73, "Expected 73 ordinary linear recipes");
assert.equal(story.length, 2, "Expected two GM-confirmed story extraction lines");
assert.equal(strategic.length, 3, "Expected three subsidized greenhouse sections");

for (const row of ordinary) {
  assert.ok(row.marginCopper > 0, `Ordinary recipe must have positive direct margin: ${row.building}: ${row.name}`);
  assert.ok(row.marginPerQd <= 14, `Ordinary recipe exceeds the approved 14 MM/QD ceiling: ${row.building}: ${row.name}`);

  const qdCapacity = row.economy.minWorkers * 20;
  const cycles = Math.floor(qdCapacity / row.qd);
  const fixedTenday = (row.economy.baseMonthly + row.economy.operatingMonthly) / 3;
  assert.ok(cycles * row.marginCopper > fixedTenday, `Full minimum-staff throughput does not cover upkeep: ${row.building}: ${row.name}`);
}

assert.deepEqual(
  strategic.map((row) => row.marginCopper),
  [-100, -120, -110],
  "Greenhouse subsidy must remain explicit and option-specific"
);
assert.ok(story.every((row) => row.wageDailyOverride === 18), "Story extraction must use the skilled 18 MM/day wage");

const recipeByKey = new Map(audit.map((row) => [`${row.building}\u0000${row.name}`, row]));
const expectedCorrections = new Map([
  ["Аптекарская\u0000Лекарства", { qd: 4, marginCopper: 28 }],
  ["Винокурня\u0000Дешёвый зерновой крепкий", { qd: 1, marginCopper: 3 }],
  ["Винокурня\u0000Дорогой зерновой крепкий", { qd: 1, marginCopper: 3 }],
  ["Винокурня\u0000Дешёвый винный крепкий", { qd: 2, marginCopper: 6 }],
  ["Винокурня\u0000Дорогой винный крепкий", { qd: 3, marginCopper: 9 }],
  ["Винокурня\u0000Дешёвый общий крепкий", { qd: 2, marginCopper: 6 }],
  ["Винокурня\u0000Дорогой общий крепкий", { qd: 4, marginCopper: 6 }],
  ["Кузня\u0000Простые военные припасы", { qd: 2, marginCopper: 14 }]
]);
for (const [key, expected] of expectedCorrections) {
  const actual = recipeByKey.get(key);
  assert.ok(actual, `Missing corrected recipe ${key}`);
  assert.equal(actual.qd, expected.qd, `QD mismatch for ${key}`);
  assert.equal(actual.marginCopper, expected.marginCopper, `Margin mismatch for ${key}`);
}

assert.equal(BUILDING_SEASONAL_PROFILES.length, 9, "Expected all field, garden, vineyard, hop and apiary profiles");
for (const profile of BUILDING_SEASONAL_PROFILES) {
  assert.ok(Object.hasOwn(PRICE, profile.outputId), `Missing seasonal output price for ${profile.outputId}`);
  assert.ok(Number.isInteger(profile.qd) && profile.qd > 0, `Missing seasonal QD for ${profile.building}: ${profile.name}`);
  assert.equal(profile.harvestsPerYear, 1, `Seasonal profile must have an explicit annual cap: ${profile.building}: ${profile.name}`);
}

assert.equal(BUILDING_LIVESTOCK_PROFILES.length, 7, "Expected all livestock profiles");
const livestockAudit = [];
for (const profile of BUILDING_LIVESTOCK_PROFILES) {
  assert.ok(Object.hasOwn(LIVESTOCK_MARKET_PRICES_COPPER, profile.speciesId), `Missing animal market price for ${profile.name}`);
  assert.ok(Number.isInteger(profile.capacity) && profile.capacity > 0, `Invalid livestock capacity for ${profile.name}`);
  assert.ok(Number.isInteger(profile.slaughterQd) && profile.slaughterQd >= 0, `Invalid slaughter QD for ${profile.name}`);
  const outputCopper = valueOf(profile.slaughterOutputs);
  const animalCopper = LIVESTOCK_MARKET_PRICES_COPPER[profile.speciesId];
  const wageCopper = profile.slaughterQd * 6;
  assert.ok(outputCopper <= animalCopper, `${profile.name}: slaughter outputs exceed the purchase price of one adult animal`);
  assert.ok(outputCopper - animalCopper - wageCopper <= 0, `${profile.name}: buying and slaughtering an adult animal creates arbitrage`);
  livestockAudit.push({ name: profile.name, outputCopper, animalCopper, wageCopper });
}
for (const token of ["7 Tallow", "12 Tallow", "2 Tallow", "6 Tallow"]) {
  assert.ok(BUILDING_LIVESTOCK_PROFILES.some((row) => row.slaughter.includes(token)), `Missing livestock chain output ${token}`);
}

const locallyProduced = new Set([
  ...audit.map((row) => row.outputId),
  ...BUILDING_SEASONAL_PROFILES.map((row) => row.outputId),
  "eggs", "meat", "milk", "pelt", "tallow", "wool"
]);
const externallySourcedInputs = [...new Set(audit.flatMap((row) => Object.keys(row.inputs)).filter((id) => !locallyProduced.has(id)))].sort();
assert.deepEqual(
  externallySourcedInputs,
  ["alcohol-general-cheap-weak", "alcohol-general-fine-weak", "rare-earth-metals", "silk", "spices", "sugar"],
  "Only explicit imported, luxury or rare bottlenecks may lack a local production source"
);

const resourceEdges = new Map();
for (const row of audit) {
  for (const inputId of Object.keys(row.inputs)) {
    if (!resourceEdges.has(inputId)) resourceEdges.set(inputId, new Set());
    resourceEdges.get(inputId).add(row.outputId);
  }
}
function hasCycle(resourceId, visiting = new Set(), visited = new Set()) {
  if (visiting.has(resourceId)) return true;
  if (visited.has(resourceId)) return false;
  visiting.add(resourceId);
  for (const next of resourceEdges.get(resourceId) ?? []) {
    if (hasCycle(next, visiting, visited)) return true;
  }
  visiting.delete(resourceId);
  visited.add(resourceId);
  return false;
}
assert.ok(![...resourceEdges.keys()].some((id) => hasCycle(id)), "Production dependency graph must remain acyclic");

for (const expectedText of [
  "годовой урожай Полевого хозяйства требует `8 QD` посева и `20 QD` сбора",
  "7 Tallow за голову",
  "12 Tallow за голову",
  "Herbs 4 + Сложные химические материалы 1 → Medicines 1 за 4 QD",
  "Wood 4 + Iron 2 + Простые химические материалы 1 → Военные припасы (простые) 2 за 2 QD",
  "В проекте определены `73` обычных линейных рецепта"
]) {
  assert.ok(markdown.includes(expectedText), `Proposal document is missing audited production rule: ${expectedText}`);
}

console.log(`Building production proposal economy check passed: ${audit.length} linear recipes, ${BUILDING_SEASONAL_PROFILES.length} seasonal profiles, ${BUILDING_LIVESTOCK_PROFILES.length} valued livestock profiles.`);

export const BUILDING_PRODUCTION_RECIPE_AUDIT = Object.freeze(audit.map((row) => Object.freeze({ ...row })));
export const BUILDING_LIVESTOCK_VALUE_AUDIT = Object.freeze(livestockAudit.map((row) => Object.freeze({ ...row })));
