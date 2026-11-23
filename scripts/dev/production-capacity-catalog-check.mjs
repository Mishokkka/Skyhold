import assert from "node:assert/strict";
import { DEFAULT_BUILDING_TEMPLATES, TEMPLATE_CATALOG_VERSION } from "../data/building-templates.js";
import { parseResourceCosts } from "../core/resources.js";
import { normalizeSkyholdData, SKYHOLD_SCHEMA_VERSION } from "../data/normalizers.js";
import { productionLineEconomics } from "../engines/economy/production-economics.js";
import { planBuildingCatalogMigration, applyBuildingCatalogMigration } from "../workflows/buildings/catalog-migration.js";

export function checkProductionCapacityCatalog() {
  assert.equal(TEMPLATE_CATALOG_VERSION, 19);
  const expected = [
    ["cheesery", "aged-cheese", 80, 30, 240, 8, 30, [["milk", 2], ["fuel-solid", 1 / 8]], 1.375],
    ["brewery", "alcohol-brewed-cheap-weak", 32, 12, 160, 8, 10, [["grain", 3], ["hops", 1], ["fuel-solid", 1 / 8]], 3.375],
    ["brewery", "alcohol-brewed-fine-weak", 32, 28, 128, 8, 20,
      [["grain", 4], ["hops", 2], ["sugar", 1], ["spices", 1 / 2], ["fuel-solid", 1 / 8]], 2.875],
    ["winery", "alcohol-wine-cheap-weak", 20, 20, 160, 1, 30, [["grapes", 6]], 3],
    ["winery", "alcohol-wine-fine-weak", 20, 40, 200, 1, 90, [["grapes", 16]], 6],
    ["tannery", "leather", 30, 15, 150, 1, 30, [["pelt", 1]], 1.5],
    ["smokehouse", "dried-fruit", 24, 6, 48, 12, 1, [["fruits", 4 / 3], ["fuel-solid", 1 / 12]], 19 / 12],
    ["brickworks", "bricks", 40, 20, 120, 4, 5, [["fuel-solid", 1 / 4]], 1]
  ];
  for (const [id, resource, qty, labor, capacity, minimum, days, costs, margin] of expected) {
    const building = DEFAULT_BUILDING_TEMPLATES.find((b) => b.id === id);
    const line = building.productionLines.find((l) => l.resourceId === resource);
    assert.deepEqual([line.outputQty, line.workQd, line.batchCapacity, line.batchStartQty, line.waitDays], [qty, labor, capacity, minimum, days]);
    assert.deepEqual(parseResourceCosts(line.expenses).map(cost => [cost.resourceId, cost.qty / qty]), costs,
      `${id}/${resource}: approved bulk ingredient ratios`);
    assert.ok(Math.abs(productionLineEconomics(line, building).marginMin / qty - margin) < 1e-9, "Approved full-batch unit margin");
    const daily = qty / labor * building.workersMin * 2;
    assert.ok(capacity + 1e-9 >= daily * days + qty, "Capacity holds minimum normal crew's waiting output and one full preparation batch");
    const small = productionLineEconomics(line, building, { batchQty: minimum });
    assert.ok(small.marginMin > 0, `${id}/${resource}: minimum load remains viable at catalog value before common overhead`);
  }
  const templates = structuredClone(DEFAULT_BUILDING_TEMPLATES);
  const data = normalizeSkyholdData({ meta: { schemaVersion: SKYHOLD_SCHEMA_VERSION, templateCatalogVersion: TEMPLATE_CATALOG_VERSION, revision: 7 }, catalog: { buildings: templates },
    holdings: [{ id: "capacity-refresh", buildings: { list: templates.filter((b) => expected.some(([id]) => b.id === id))
      .map((b) => ({ ...structuredClone(b), id: `built-${b.id}`, templateId: b.id })) } }] });
  const working = data.holdings[0].buildings.list.flatMap(building => building.productionLines).find(line => line.resourceId === "aged-cheese");
  working.workQd += 1;
  const before = structuredClone(data);
  const args = { currentData: data, operationId: "capacity-v19-preview", replaceCatalog: true };
  const plan = planBuildingCatalogMigration(args);
  assert.deepEqual(plan.blockingIssues, []);
  assert.equal(plan.canApply, true);
  assert.deepEqual(data, before, "v19 preview never changes a world draft");
  const applied = applyBuildingCatalogMigration({ currentData: data, plan });
  assert.equal(applied.data.meta.templateCatalogVersion, 19);
  assert.equal(planBuildingCatalogMigration({ ...args, currentData: applied.data }).hasChanges, false);
  Object.assign(working, { workInputsReserved: true, workReservedOutputQty: working.outputQty, workProgressUnits: 100,
    workReservedInputs: { version: 1, entries: [] } });
  assert.equal(planBuildingCatalogMigration(args).canApply, false, "Changed recipes must finish or cancel their batches before updating");
}
