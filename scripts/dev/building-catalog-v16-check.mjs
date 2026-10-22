import assert from "node:assert/strict";
import { BUILDING_TEMPLATES_BEFORE_LABOR_TRANSITION, TEMPLATE_CATALOG_VERSION } from "../data/building-templates.js";
import { buildingCatalogV15Templates } from "../data/building-template-revision-v15.js";
import { normalizeCatalogPartition } from "../data/normalizers.js";
import { normalizeResourceId } from "../core/resources.js";

export function checkBuildingCatalogV16() {
  // Saved catalogs retain these contracts until the separate, explicit labor
  // transition. New hybrid templates are covered by building-labor-catalog-check.
  const rows = BUILDING_TEMPLATES_BEFORE_LABOR_TRANSITION;
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(TEMPLATE_CATALOG_VERSION, 19);
  assert.equal(rows.length, 126);
  assert.equal(byId.size, 126);
  assert.ok(rows.every((row) => row.templateVersion === 19));
  const baseline = buildingCatalogV15Templates();
  assert.ok(baseline.every((row) => byId.has(row.id)), "Every old template remains addressable for migration");
  const expected = { "festival-square": [10, 1, 2], alehouse: [12, 1, 5 / 3],
    "game-house": [20, 2, 2], "performance-house": [30, 3, 2], "promenade-garden": [20, 1, 1],
    "city-theatre": [60, 6, 2], museum: [40, 4, 2] };
  for (const [id, [capacity, workers, qdPerCapacity]] of Object.entries(expected)) {
    const row = byId.get(id);
    assert.ok(row, id);
    assert.equal(row.service.leisure.capacity, capacity, id);
    assert.equal(row.service.leisure.minWorkers, workers, id);
    assert.equal(row.service.leisure.qdPerCapacity, qdPerCapacity, id);
    assert.equal(row.moraleDelta, capacity, "Initial display nominal matches the new service");
    assert.equal(row.repeatSettlementEffects, false, "Leisure never grants repeat development or reputation");
    assert.ok(row.workersMax >= workers);
    assert.ok(capacity * qdPerCapacity <= row.workersMax * 20, "Full capacity fits normal worker time");
    assert.ok(row.baseUpkeepMonthlyCopper > 0 && row.operatingUpkeepMonthlyCopper > 0 && row.wageDailyCopper > 0);
    for (const material of row.materialCosts) {
      assert.ok(material.qty > 0);
      assert.notEqual(normalizeResourceId(material.resourceId, material.name), "custom");
    }
  }
  // P21 replaces population-limited inn leisure with the approved fixed service.
  assert.equal(byId.get("inn").moraleDelta, 15);
  assert.equal(byId.get("inn").service, undefined);
  assert.equal(byId.get("inn").activation.anyWorkingFunction, true);
  assert.equal(byId.get("inn").workersMax, 10, "Cooking keeps the original shared staffing limit");
  for (const id of ["stables", "lazaret", "hospital", "industrial-icehouse"]) assert.equal(byId.get(id).workerMoraleDelta, -1);
  assert.equal(byId.get("soapworks").moraleDelta, -1);
  assert.deepEqual([byId.get("high-tech-components-plant").moraleDelta, byId.get("high-tech-components-plant").workerMoraleDelta], [0, 0]);
  assert.deepEqual([byId.get("gasworks").moraleDelta, byId.get("gasworks").workerMoraleDelta], [1, -2]);
  for (const row of rows.filter((b) => b.moraleDelta > 0 || b.reputation > 0)) assert.ok(row.workersMax > 0, `${row.id}: assignable social staff`);
  assert.equal(byId.get("well").activation.minOperationalQd, 2);
  assert.equal(byId.get("gallows").activation.harmWhileOperational, true);
  const loaded = normalizeCatalogPartition({ buildings: rows });
  assert.deepEqual(normalizeCatalogPartition(loaded), loaded, "current catalog preserves v16 leisure rules across loading");
  for (const row of loaded.buildings) {
    assert.equal(row.workerProfile?.workersMax ?? row.workersMax, row.workersMax);
    assert.equal(row.workerProfile?.workersMin ?? row.workersMin, row.workersMin);
  }
  return { templates: rows.length, leisure: Object.keys(expected).length };
}
