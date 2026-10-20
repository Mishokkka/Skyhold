import assert from "node:assert/strict";
import { DEFAULT_BUILDING_TEMPLATES, TEMPLATE_CATALOG_VERSION } from "../data/building-templates.js";
import { buildingCatalogV18Templates } from "../data/building-template-revision-v18.js";
import { parseResourceCosts } from "../core/resources.js";
import { normalizeSkyholdData } from "../data/normalizers.js";
import { productionLineEconomics } from "../engines/economy/production-economics.js";
import { planBuildingCatalogMigration, applyBuildingCatalogMigration } from "../workflows/buildings/catalog-migration.js";

export function checkProductionCapacityCatalog() {
  assert.equal(TEMPLATE_CATALOG_VERSION, 19);
  const previous = buildingCatalogV18Templates();
  const expected = [
    ["cheesery", "aged-cheese", 80, 30, 240, 8, 30],
    ["brewery", "alcohol-brewed-cheap-weak", 32, 12, 160, 8, 10],
    ["brewery", "alcohol-brewed-fine-weak", 32, 28, 128, 8, 20],
    ["winery", "alcohol-wine-cheap-weak", 20, 20, 160, 1, 30],
    ["winery", "alcohol-wine-fine-weak", 20, 40, 200, 1, 90],
    ["tannery", "leather", 30, 15, 150, 1, 30],
    ["smokehouse", "dried-fruit", 24, 6, 48, 12, 1],
    ["brickworks", "bricks", 40, 20, 120, 4, 5]
  ];
  for (const [id, resource, qty, labor, capacity, minimum, days] of expected) {
    const building = DEFAULT_BUILDING_TEMPLATES.find((b) => b.id === id);
    const line = building.productionLines.find((l) => l.resourceId === resource);
    const oldBuilding = previous.find((b) => b.id === id);
    const old = oldBuilding.productionLines.find((l) => l.id === line.id);
    assert.deepEqual([line.outputQty, line.workQd, line.batchCapacity, line.batchStartQty, line.waitDays], [qty, labor, capacity, minimum, days]);
    const perUnitCosts = (l) => parseResourceCosts(l.expenses).map((cost) => [cost.resourceId, cost.qty / l.outputQty]);
    assert.deepEqual(perUnitCosts(line), perUnitCosts(old), `${id}/${resource}: bulk loading preserves ingredient ratios`);
    assert.equal(labor / qty, old.workQd / old.outputQty, `${id}/${resource}: labor per unit is unchanged`);
    const before = productionLineEconomics(old, oldBuilding), after = productionLineEconomics(line, building);
    assert.ok(Math.abs(before.marginMin / old.outputQty - after.marginMin / qty) < 1e-9, "Full-batch unit margin is unchanged");
    const daily = qty / labor * building.workersMin * 2;
    assert.ok(capacity + 1e-9 >= daily * days + qty, "Capacity holds minimum normal crew's waiting output and one full preparation batch");
    const small = productionLineEconomics(line, building, { batchQty: minimum });
    assert.ok(small.marginMin > 0, `${id}/${resource}: minimum load remains viable at catalog value before common overhead`);
  }
  for (const building of previous) {
    const current = DEFAULT_BUILDING_TEMPLATES.find((b) => b.id === building.id);
    for (const line of building.productionLines ?? []) {
      if (expected.some(([id, resource]) => building.id === id && line.resourceId === resource)) continue;
      assert.deepEqual(current.productionLines.find((l) => l.id === line.id), line, `${building.id}/${line.id}: unrelated recipe stays unchanged (including B07 and B10)`);
    }
  }
  const data = normalizeSkyholdData({ meta: { templateCatalogVersion: 18, revision: 7 }, catalog: { buildings: previous },
    holdings: [{ id: "capacity-migration", buildings: { list: previous.filter((b) => expected.some(([id]) => b.id === id))
      .map((b) => ({ ...structuredClone(b), id: `built-${b.id}`, templateId: b.id })) } }] });
  const before = structuredClone(data);
  const args = { currentData: data, operationId: "capacity-v19-preview", replaceCatalog: true };
  const plan = planBuildingCatalogMigration(args);
  assert.deepEqual(plan.blockingIssues, []);
  assert.equal(plan.canApply, true);
  assert.deepEqual(data, before, "v19 preview never changes a world draft");
  const applied = applyBuildingCatalogMigration({ currentData: data, plan });
  assert.equal(applied.data.meta.templateCatalogVersion, 19);
  assert.equal(planBuildingCatalogMigration({ ...args, currentData: applied.data }).hasChanges, false);
  const working = data.holdings[0].buildings.list[0].productionLines[0];
  Object.assign(working, { workInputsReserved: true, workReservedOutputQty: working.outputQty, workProgressUnits: 100,
    workReservedInputs: { version: 1, entries: [] } });
  assert.equal(planBuildingCatalogMigration(args).canApply, false, "Changed old recipes must finish or cancel their old batches first");
}
