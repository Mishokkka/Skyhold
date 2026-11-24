import assert from "node:assert/strict";
import { DEFAULT_BUILDING_TEMPLATES, TEMPLATE_CATALOG_VERSION } from "../data/building-templates.js";
import { normalizeCatalogPartition } from "../data/normalizers.js";
import { buildingServiceBlockReasons } from "../engines/economy/building-service.js";
import { settlementControlSummary } from "../engines/settlement/control.js";

export function checkBuildingCatalogTechnical() {
  const before = structuredClone(DEFAULT_BUILDING_TEMPLATES);
  const rows = structuredClone(DEFAULT_BUILDING_TEMPLATES);
  assert.ok(rows.every((row) => row.templateVersion === TEMPLATE_CATALOG_VERSION));
  assert.equal(rows.filter((row) => row.prerequisiteModes).length, 14);
  for (const id of ["lazaret", "lighthouse"]) assert.equal(rows.find((row) => row.id === id).bonuses.food, 0);
  const normalized = normalizeCatalogPartition({ buildings: rows }).buildings;
  for (const row of rows) {
    const loaded = normalized.find((item) => item.id === row.id);
    assert.equal(Object.hasOwn(loaded, "maintenance"), false, `${row.id}: maintenance removed in v2`);
    assert.deepEqual(loaded.prerequisiteModes, row.prerequisiteModes);
  }
  const house = structuredClone(normalized.find((row) => row.id === "meeting-house"));
  assert.equal(house.control.ceiling, null);
  assert.equal(house.control.capacity || 0, 0);
  assert.deepEqual(house.materialCosts.map((row) => [row.resourceId, row.qty]), [["wood", 180], ["stone", 120], ["cloth", 20], ["parchment", 10]]);
  assert.equal(house.wageDailyCopper * 10 + (house.baseUpkeepMonthlyCopper + house.operatingUpkeepMonthlyCopper) / 3, 198);
  Object.assign(house, { constructionStatus: "built", lifecycle: "active", condition: "intact" });
  const person = { id: "clerk", workAllocations: [{ sourceId: house.id, functionId: "culture", normalQd: 20 }] };
  const holding = { buildings: { list: [house] }, people: { list: [person] } };
  assert.equal(buildingServiceBlockReasons(holding, house).active, true);
  assert.equal(settlementControlSummary(holding).generalControl, 1);
  assert.equal(settlementControlSummary(holding).institutionalCeiling, null);
  person.workAllocations[0].normalQd = 19;
  assert.equal(buildingServiceBlockReasons(holding, house).active, false);
  assert.equal(settlementControlSummary(holding).generalControl, 0);
  assert.deepEqual(DEFAULT_BUILDING_TEMPLATES, before, "Candidate generation and normalization cannot update the active catalog");
  normalized[0].name = "changed";
  assert.notEqual(rows[0].name, "changed", "A normalized draft is independent of the built-in templates");
}
