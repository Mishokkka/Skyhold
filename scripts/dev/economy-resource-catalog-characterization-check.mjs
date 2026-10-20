import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_BUILDING_TEMPLATES } from "../data/building-templates.js";
import {
  ECONOMY_RESOURCE_CATALOG_SIZE,
  ECONOMY_RESOURCE_CATALOG_VERSION,
  ECONOMY_RESOURCE_PRICE_COPPER,
  RESOURCE_BASE_DEFINITIONS
} from "../data/resources/resource-base-definitions.js";
import {
  LEGACY_LIVESTOCK_RESOURCE_IDS,
  LEGACY_RESOURCE_ID_MAP,
  isCanonicalResourceId,
  resourceMigrationTarget
} from "../data/resources/resource-id-migration.js";
import { normalizeResourceCatalogRow, parseResourceCosts } from "../core/resources.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACK_PATHS = [
  "examples/content-packs/air-islands-materials-and-country-markets.json",
  "examples/content-packs/air-islands-trade-network-template.json"
];

function collectResourceIds(value, result = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) collectResourceIds(entry, result);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "resourceId" || key.endsWith("ResourceId")) && typeof entry === "string" && entry.trim()) {
      result.add(entry.trim());
    }
    collectResourceIds(entry, result);
  }
  return result;
}

export function checkEconomyResourceCatalogCharacterization() {
  assert.equal(ECONOMY_RESOURCE_CATALOG_VERSION, 5, "the approved labor-calibrated economy catalog must own an explicit version");
  assert.equal(RESOURCE_BASE_DEFINITIONS.length, ECONOMY_RESOURCE_CATALOG_SIZE);
  assert.equal(ECONOMY_RESOURCE_CATALOG_SIZE, 100, "v18 keeps cooked vegetables in the same dietary group as canned vegetables");
  assert.equal(Object.keys(ECONOMY_RESOURCE_PRICE_COPPER).length, ECONOMY_RESOURCE_CATALOG_SIZE);

  const ids = RESOURCE_BASE_DEFINITIONS.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, "canonical resource ids must be unique");
  const rows = RESOURCE_BASE_DEFINITIONS.map((row) => normalizeResourceCatalogRow(row));
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.ok(rows.every((row) => row.basePriceCopper === ECONOMY_RESOURCE_PRICE_COPPER[row.id]), "built-in rows must use the single approved wholesale price list");
  assert.equal(byId.get("wood").basePriceCopper, 4);
  assert.equal(byId.get("stone").basePriceCopper, 4);
  assert.equal(byId.get("copper").basePriceCopper, 60);
  assert.equal(byId.get("armament-simple").basePriceCopper, 1200);
  assert.equal(byId.get("crystal-core").basePriceCopper, 100000);
  assert.ok(rows.every((row) => Number.isInteger(row.basePriceCopper) && row.basePriceCopper >= 0));
  assert.ok(rows.every((row) => Number.isInteger(row.loadPoints) && row.loadPoints >= 0));
  assert.ok(rows.every((row) => Number.isInteger(row.shelfLifeQd) && row.shelfLifeQd >= 0));
  assert.ok(rows.every((row) => Array.isArray(row.marketTags)), "broad market taxonomy must use marketTags");
  assert.ok(rows.every((row) => typeof row.categoryTag === "string"), "each resource owns at most one substitution tag");

  assert.equal(byId.get("stone").categoryTag, "masonry");
  assert.equal(byId.get("bricks").categoryTag, "masonry");
  for (const id of ["wood", "glass", "straw", "rope", "marble", "rare-wood"]) {
    assert.equal(byId.get(id).categoryTag, "", `${id} must not substitute for masonry or another construction stock`);
  }

  const prepared = rows.filter((row) => row.foodEdible);
  assert.equal(prepared.length, 12, "the catalog includes cooked vegetables and three distinct canned foods");
  assert.deepEqual(new Set(prepared.map((row) => row.foodType)), new Set(["grain", "protein", "dairy", "fruit", "vegetable"]));
  assert.equal(byId.get("eggs").foodEdible, false, "raw eggs cannot feed residents directly");
  assert.equal(byId.get("eggs").categoryTag, "ingredient.protein", "eggs share the protein input contract with meat and fish");
  assert.equal(byId.get("food-protein").foodType, "protein");

  const alcohol = rows.filter((row) => row.categoryTag === "alcohol");
  assert.equal(alcohol.length, 12, "brewed, wine and general alcohol require four quality/strength combinations each");
  for (const family of ["brewed", "wine", "general"]) {
    assert.equal(alcohol.filter((row) => row.marketTags.includes(family)).length, 4, `${family} must have four alcohol variants`);
  }

  const crystals = ["crystal-dust", "crystal-inert", "crystal-active", "crystal-core"].map((id) => byId.get(id));
  assert.ok(crystals.every((row) => row && row.categoryTag === ""), "crystal grades are not mutually substitutable");
  assert.ok(crystals.every((row) => row.noAutoConsume), "strategic crystals require an explicit action");

  for (const [tag, expected] of [["component", 3], ["tool", 2], ["chemical", 2]]) {
    assert.equal(rows.filter((row) => row.categoryTag === tag).length, expected, `${tag} tier count must remain intentional`);
  }
  assert.equal(rows.filter((row) => row.categoryTag === "armament").length, 3);
  assert.ok(rows.filter((row) => row.categoryTag === "armament").every((row) => /пяти человек/u.test(row.notes)), "one armament unit equips five people");

  for (const [sourceId, targetId] of Object.entries(LEGACY_RESOURCE_ID_MAP)) {
    assert.ok(sourceId && targetId, "legacy resource mappings must be explicit non-empty ids");
    assert.ok(byId.has(targetId), `legacy resource ${sourceId} must map to a canonical target`);
    assert.equal(resourceMigrationTarget(sourceId).kind, "resource");
  }
  assert.deepEqual(new Set(Object.values(LEGACY_LIVESTOCK_RESOURCE_IDS)), new Set(["cattle", "pigs", "sheep", "goats", "horses", "poultry", "rabbits", "pigeons"]));

  const buildingIds = collectResourceIds(DEFAULT_BUILDING_TEMPLATES);
  for (const resourceId of buildingIds) {
    assert.ok(isCanonicalResourceId(resourceId), `building templates must use canonical resource ${resourceId} directly`);
  }
  const inn = DEFAULT_BUILDING_TEMPLATES.find((row) => row.id === "inn");
  const proteinLines = inn.productionLines.filter((row) => row.resourceId === "food-protein");
  const flourGrainLine = inn.productionLines.find((row) => row.id === "line-4");
  const grainLine = inn.productionLines.find((row) => row.id === "line-grain-porridge");
  assert.deepEqual(
    proteinLines.map((line) => parseResourceCosts(line.expenses).map(({ resourceId, qty }) => ({ resourceId, qty }))),
    [
      [{ resourceId: "meat", qty: 12 }, { resourceId: "fuel-solid", qty: 1 }],
      [{ resourceId: "fish", qty: 12 }, { resourceId: "fuel-solid", qty: 1 }],
      [{ resourceId: "eggs", qty: 12 }, { resourceId: "fuel-solid", qty: 1 }]
    ],
    "the Inn must expose three explicit and mutually exclusive protein recipes rather than silently substituting a resource group"
  );
  // P08 explicitly replaces egg-and-flour meals with two simpler alternatives.
  assert.deepEqual(parseResourceCosts(flourGrainLine.expenses).map(({ resourceId, qty }) => ({ resourceId, qty })), [{ resourceId: "flour", qty: 8 }, { resourceId: "fuel-solid", qty: 1 }]);
  assert.deepEqual(parseResourceCosts(grainLine.expenses).map(({ resourceId, qty }) => ({ resourceId, qty })), [{ resourceId: "grain", qty: 12 }, { resourceId: "fuel-solid", qty: 1 }]);
  for (const line of [flourGrainLine, grainLine]) assert.deepEqual([line.resourceId, line.outputQty, line.workQd], ["food-grain", 10, 2]);

  for (const relativePath of PACK_PATHS) {
    const raw = JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
    const packResourceIds = new Set((raw.content?.resources ?? []).map((row) => String(row.id ?? "").trim()).filter(Boolean));
    const referencedIds = collectResourceIds(raw);
    for (const resourceId of new Set([...packResourceIds, ...referencedIds])) {
      assert.ok(isCanonicalResourceId(resourceId), `${relativePath} must use canonical resource ${resourceId} directly`);
    }
  }

  assert.ok(ids.every((id) => isCanonicalResourceId(id)));
  return {
    resources: rows.length,
    preparedFood: prepared.length,
    alcohol: alcohol.length,
    legacyMappings: Object.keys(LEGACY_RESOURCE_ID_MAP).length,
    livestockAliases: Object.keys(LEGACY_LIVESTOCK_RESOURCE_IDS).length
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log("FBL Skyhold economy resource catalog characterization passed.", checkEconomyResourceCatalogCharacterization());
}
