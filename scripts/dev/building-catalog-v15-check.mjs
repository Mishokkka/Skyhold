import assert from "node:assert/strict";
import { buildingCatalogV15Templates, BUILDING_CATALOG_V15_VERSION } from "../data/building-template-revision-v15.js";
import { DEFAULT_BUILDING_TEMPLATES, TEMPLATE_CATALOG_VERSION } from "../data/building-templates.js";
import { normalizeCatalogPartition } from "../data/normalizers.js";
import { buildingServiceBlockReasons } from "../engines/economy/building-service.js";
import { settlementControlSummary } from "../engines/settlement/control.js";

export function checkBuildingCatalogV15() {
  const before = structuredClone(DEFAULT_BUILDING_TEMPLATES);
  const rows = buildingCatalogV15Templates();
  assert.equal(rows.length, 121);
  assert.equal(new Set(rows.map((row) => row.id)).size, 121);
  assert.equal(BUILDING_CATALOG_V15_VERSION, 15, "v15 remains the immutable baseline for saved worlds");
  assert.equal(TEMPLATE_CATALOG_VERSION, 19, "Current approved economy is checked separately from historical v15");
  assert.equal(rows.filter((row) => row.maintenance.requiredPoints > 0).length, 19);
  assert.ok(rows.every((row) => row.maintenance.schemaVersion === 2 && row.templateVersion === 15));
  assert.equal(rows.filter((row) => row.prerequisiteModes).length, 14);
  const tree = rows.filter((row) => !["fasti-shop", "laputa-excavated-crypt"].includes(row.id));
  assert.deepEqual(["food", "technology", "culture", "war"].map((key) => tree.reduce((sum, row) => sum + row.bonuses[key], 0)), [104, 164, 149, 113]);
  for (const id of ["lazaret", "lighthouse"]) assert.equal(rows.find((row) => row.id === id).bonuses.food, 0);
  const normalized = normalizeCatalogPartition({ buildings: rows }).buildings;
  for (const row of rows) {
    const loaded = normalized.find((item) => item.id === row.id);
    assert.deepEqual(loaded.maintenance, row.maintenance);
    assert.deepEqual(loaded.prerequisiteModes, row.prerequisiteModes);
  }
  const house = structuredClone(normalized.find((row) => row.id === "meeting-house"));
  assert.equal(house.control.ceiling, null);
  assert.equal(house.control.capacity || 0, 0);
  assert.deepEqual(house.materialCosts.map((row) => [row.resourceId, row.qty]), [["wood", 180], ["stone", 120], ["cloth", 20], ["parchment", 10]]);
  assert.equal(house.wageDailyCopper * 10 + (house.baseUpkeepMonthlyCopper + house.operatingUpkeepMonthlyCopper) / 3, 198);
  Object.assign(house, { constructionStatus: "built", lifecycle: "active", condition: "intact" });
  const person = { id: "clerk", workAllocationMode: "explicit", workAllocations: [{ sourceId: house.id, functionId: "culture", normalQd: 20 }] };
  const holding = { buildings: { list: [house] }, people: { list: [person] } };
  assert.equal(buildingServiceBlockReasons(holding, house).active, true);
  assert.equal(settlementControlSummary(holding).generalControl, 1);
  assert.equal(settlementControlSummary(holding).institutionalCeiling, null);
  person.workAllocations[0].normalQd = 19;
  assert.equal(buildingServiceBlockReasons(holding, house).active, false);
  assert.equal(settlementControlSummary(holding).generalControl, 0);
  assert.deepEqual(DEFAULT_BUILDING_TEMPLATES, before, "Candidate generation and normalization cannot update the active catalog");
  rows[0].name = "changed";
  assert.notEqual(buildingCatalogV15Templates()[0].name, "changed", "Each Preview must get an isolated candidate");
  return { templates: 121, technical: 19, dependencies: 14, house: true, activeCatalogUnchanged: true };
}
