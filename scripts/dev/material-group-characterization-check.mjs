import assert from "node:assert/strict";
import { checkProductionExpenses } from "./production-expenses-check.mjs";
checkProductionExpenses();
import { FinanceDomain } from "../apps/domains/finance-domain.js";
import { materialGroup, resourceMatchesMaterialGroup } from "../core/material-groups.js";
import { parseCurrencyCopper } from "../core/currency.js";
import {
  normalizeResourceCatalogRow,
  parseResourceCosts,
  resourceBasePriceCopper,
  resourceCategoryTag,
  resourceLoadPoints,
  resourceUnitLoad
} from "../core/resources.js";
import { planStorageCosts } from "../engines/storage/group-payment.js";

const parsed = parseResourceCosts("Кладочные материалы 2; Белковое сырьё 1");
assert.deepEqual(parsed.map(({ resourceGroup, qty }) => ({ resourceGroup, qty })), [
  { resourceGroup: "masonry", qty: 2 },
  { resourceGroup: "ingredient.protein", qty: 1 }
]);
assert.equal(parseResourceCosts("Wood 1.2")[0]?.qty, 2, "positive recipe costs must round up to a whole unit");
assert.equal(parseResourceCosts("Wood 0.1")[0]?.qty, 1, "a positive fractional recipe cost must never become free");
assert.deepEqual(parseResourceCosts("Wood -1.8"), [], "non-positive recipe costs must be discarded");
assert.equal(materialGroup("Топливо")?.id, "fuel");
assert.equal(resourceMatchesMaterialGroup({ resourceId: "fuel-solid", name: "Твёрдое топливо" }, "fuel"), true, "legacy rows without a category tag may use the canonical resource ID fallback");
assert.equal(resourceMatchesMaterialGroup({ resourceId: "wood", name: "Wood" }, "fuel"), false, "broad market traits must not make Wood substitutable for industrial fuel");
assert.equal(resourceMatchesMaterialGroup({ resourceId: "custom", name: "Старая ткань", materialGroups: ["textile"] }, "textile"), true, "legacy rows without a category tag may use explicit materialGroups");
assert.equal(resourceMatchesMaterialGroup({ resourceId: "copper", name: "Медь" }, "ingredient.protein"), false, "resource names must not trigger keyword group matching");
assert.equal(resourceMatchesMaterialGroup({ resourceId: "custom", name: "Metal Honey" }, "nonferrous"), false, "custom resource names must not trigger keyword group matching");
assert.equal(resourceMatchesMaterialGroup({ resourceId: "stone", name: "Stone" }, "ingredient.protein"), false);
assert.equal(resourceMatchesMaterialGroup(
  { resourceId: "copper", categoryTag: " nonferrous ", materialGroups: ["ingredient.protein"] },
  "nonferrous"
), true, "a canonical category tag must match its exact normalized group ID");
assert.equal(resourceMatchesMaterialGroup(
  { resourceId: "copper", categoryTag: " nonferrous ", materialGroups: ["ingredient.protein"] },
  "ingredient.protein"
), false, "a non-empty canonical category tag must disable legacy group and resource-ID fallbacks");
assert.equal(resourceMatchesMaterialGroup(
  { resourceId: "honey" },
  "nonferrous",
  { id: "honey", label: "Metal Honey", categoryTag: "ingredient.sweet", materialGroups: ["nonferrous"] }
), false, "canonical substitution tags must not fall back to misleading labels or legacy groups");
assert.equal(FinanceDomain._storageResourceMatchesGroup({ resourceId: "fuel-solid", noAutoConsume: true }, "fuel"), false, "row-level noAutoConsume must exclude stock from group auto-selection");

{
  const previousGame = globalThis.game;
  globalThis.game = {
    settings: {
      get(_moduleId, key) {
        if (key === "skyholdMeta") return { revision: 1, storageCommit: { catalogHash: "protected-group-resource", writeComplete: true } };
        if (key === "skyholdCatalog") return {
          resources: [{ id: "protected-fuel", label: "Protected Fuel", categoryTag: "fuel", noAutoConsume: true }]
        };
        return {};
      }
    }
  };
  try {
    assert.equal(
      FinanceDomain._storageResourceMatchesGroup({ resourceId: "protected-fuel", name: "Protected Fuel" }, "fuel"),
      false,
      "definition-level noAutoConsume must exclude stock from group auto-selection"
    );
  } finally {
    if (previousGame === undefined) delete globalThis.game;
    else globalThis.game = previousGame;
  }
}

const tagged = normalizeResourceCatalogRow({ id: "peat", label: "Торф", materialGroups: "fuel, industrial" });
assert.deepEqual(tagged.materialGroups, ["fuel", "industrial"], "custom catalog resources must preserve legacy metadata without making it canonical taxonomy");
assert.equal(tagged.categoryTag, "fuel", "the first legacy material group must seed the single canonical category tag");

assert.equal(parseCurrencyCopper("3 C"), 3);
assert.equal(parseCurrencyCopper("2 S"), 20);
assert.equal(parseCurrencyCopper("1 G 2 S 3 C"), 123);
assert.equal(parseCurrencyCopper("1 ЗМ 2 СМ 3 ММ"), 123);
assert.equal(parseCurrencyCopper("20"), 0, "a denomination-free legacy number must not be guessed as copper");

const canonical = normalizeResourceCatalogRow({
  id: "preserved-rations",
  label: "Пайки",
  basePriceCopper: 17,
  cost: "9 G",
  loadPoints: 3,
  load: 9,
  categoryTag: "ingredient.protein",
  materialGroups: ["food.raw", "organic"],
  noAutoConsume: true,
  shelfLifeQd: 41,
  shelfLifeDays: 99,
  shelfLife: "12 months",
  foodEdible: true,
  foodType: "MEAT"
});
assert.equal(canonical.basePriceCopper, 17, "canonical price must override legacy cost text");
assert.equal(canonical.loadPoints, 3, "canonical integer load points must override legacy decimal load");
assert.equal(canonical.categoryTag, "ingredient.protein", "known canonical category tags must preserve their exact key");
assert.deepEqual(canonical.materialGroups, ["food.raw", "organic"], "legacy material groups must remain inert and lossless during safe normalization");
assert.equal(canonical.noAutoConsume, true);
assert.equal(canonical.shelfLifeQd, 41, "canonical shelf life must override legacy day and text fields");
assert.equal(canonical.foodType, "protein", "legacy meat food type must migrate to the approved protein type");
assert.equal(canonical.cost, "9 G");
assert.equal(canonical.shelfLife, "12 months");

assert.equal(normalizeResourceCatalogRow({ id: "legacy-price", cost: "4 СМ" }).basePriceCopper, 40);
assert.equal(normalizeResourceCatalogRow({ id: "legacy-load", load: 0.6 }).loadPoints, 2, "legacy decimal load must round once into quarter-load points");
assert.equal(normalizeResourceCatalogRow({ id: "default-load" }).loadPoints, 4);
assert.equal(normalizeResourceCatalogRow({ id: "money", isMoney: true }).loadPoints, 0);
assert.equal(normalizeResourceCatalogRow({ id: "days", shelfLifeDays: 2.5 }).shelfLifeQd, 10);
assert.equal(normalizeResourceCatalogRow({ id: "months", shelfLife: "2 months" }).shelfLifeQd, 240);
assert.equal(normalizeResourceCatalogRow({ id: "legacy-days", shelfLife: "10 дней" }).shelfLifeQd, 40);
assert.equal(normalizeResourceCatalogRow({ id: "legacy-tenday", shelfLife: "1 десятник" }).shelfLifeQd, 40);
assert.equal(normalizeResourceCatalogRow({ id: "legacy-year", shelfLife: "1 год" }).shelfLifeQd, 1440);
assert.equal(normalizeResourceCatalogRow({ id: "unbounded", shelfLife: "не ограничен" }).shelfLifeQd, 0, "free-form shelf-life prose must not be guessed");
assert.equal(normalizeResourceCatalogRow({ id: "raw-food", foodEdible: false, foodType: "grain" }).foodType, "", "non-edible resources must not retain a ready-food type");
assert.equal(normalizeResourceCatalogRow({ id: "invalid-food", foodEdible: true, foodType: "luxury" }).foodType, "", "unknown food types must be discarded");

assert.equal(resourceBasePriceCopper({ id: "inline", cost: "5 S" }), 50);
assert.equal(resourceLoadPoints({ id: "inline", load: 0.5 }), 2);
assert.equal(resourceUnitLoad({ id: "inline", loadPoints: 1 }), 0.25);
assert.equal(resourceCategoryTag({ id: "inline", materialGroups: ["Топливо", "organic"] }), "fuel");
assert.equal(resourceBasePriceCopper("wood"), 4, "built-in definitions must expose the labor-calibrated canonical wholesale price");
assert.equal(resourceLoadPoints("wood"), 4, "built-in definitions must expose canonical default load points");
assert.equal(resourceUnitLoad({ resourceId: "stone", weight: 99 }), 1, "a storage-row weight must not override the catalog definition");

const dependencies = {
  safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
  isMoneyResource: (resourceId) => resourceId === "money",
  storageResourceMatches: (row, cost) => row.resourceId === cost.resourceId && (row.resourceId !== "custom" || row.name === cost.name),
  resourceMatchesGroup: (row, groupId) => FinanceDomain._storageResourceMatchesGroup(row, groupId),
  normalizeRoomId: (value) => String(value ?? "outdoors") || "outdoors"
};

const holding = {
  storage: {
    moneyCopper: 100,
    resources: [
      { resourceId: "wood", name: "Wood", roomId: "warehouse", qty: 1 },
      { resourceId: "fuel-solid", name: "Твёрдое топливо", roomId: "warehouse", qty: 3 },
      { resourceId: "fuel-liquid", name: "Жидкое топливо", roomId: "warehouse", qty: 1 },
      { resourceId: "wood", name: "Protected Wood", roomId: "warehouse", qty: 10, noAutoConsume: true },
      { resourceId: "milk", name: "Milk", roomId: "pantry", qty: 2 }
    ]
  }
};
const fuelPlan = planStorageCosts({
  holding,
  costs: [{ resourceGroup: "fuel", resourceId: "group:fuel", name: "Промышленное топливо", qty: 4 }],
  dependencies
});
assert.equal(fuelPlan.ok, true);
assert.deepEqual(fuelPlan.costs.map(({ resourceId, qty }) => ({ resourceId, qty })), [
  { resourceId: "fuel-solid", qty: 3 },
  { resourceId: "fuel-liquid", qty: 1 }
], "a worker must preserve FIFO row order for equally aged suitable stock and may split a group cost");

const overlapPlan = planStorageCosts({
  holding,
  costs: [
    { resourceGroup: "fuel", name: "Промышленное топливо", qty: 4 },
    { resourceGroup: "fuel", name: "Ещё топливо", qty: 1 }
  ],
  dependencies
});
assert.equal(overlapPlan.ok, false, "one inventory unit must not pay two overlapping group costs");
assert.equal(overlapPlan.missing[0].have, 0);

const foodPlan = planStorageCosts({
  holding,
  costs: [{ resourceGroup: "food.prepared", name: "Готовая пища", qty: 3 }],
  dependencies
});
assert.equal(foodPlan.ok, false);
assert.equal(foodPlan.missing[0].have, 0, "raw milk must not satisfy the prepared-food substitution group");

const explicitProtectedPlan = planStorageCosts({
  holding,
  costs: [{ resourceId: "wood", name: "Wood", qty: 10 }],
  dependencies
});
assert.equal(explicitProtectedPlan.ok, true, "noAutoConsume must not block an explicit resourceId expense");
assert.equal(explicitProtectedPlan.costs.reduce((sum, row) => sum + row.qty, 0), 10);

const fractionalCostPlan = planStorageCosts({
  holding: {
    storage: {
      moneyCopper: 0,
      resources: [{ resourceId: "wood", name: "Wood", roomId: "warehouse", qty: 2 }]
    }
  },
  costs: [{ resourceId: "wood", name: "Wood", qty: 1.2 }],
  dependencies
});
assert.equal(fractionalCostPlan.ok, true);
assert.equal(fractionalCostPlan.costs[0]?.qty, 2, "a positive fractional runtime cost must round up");

console.log("FBL Skyhold material groups: parsing, catalog tags, selection, splitting and overlap safety passed.");
