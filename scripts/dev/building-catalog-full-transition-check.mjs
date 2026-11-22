import assert from "node:assert/strict";
import { BUILDING_TEMPLATES_BEFORE_LABOR_TRANSITION, TEMPLATE_CATALOG_VERSION } from "../data/building-templates.js";
import { normalizeSkyholdData } from "../data/normalizers.js";
import { clone } from "../data/utils.js";
import { applyBuildingCatalogMigration, planBuildingCatalogMigration } from "../workflows/buildings/catalog-migration.js";

export function checkBuildingCatalogFullTransition() {
  const savedTemplates = BUILDING_TEMPLATES_BEFORE_LABOR_TRANSITION.filter(row => row.id !== "meeting-house");
  const source = normalizeSkyholdData({
    meta: { templateCatalogVersion: TEMPLATE_CATALOG_VERSION, revision: 4 },
    catalog: { buildings: clone(savedTemplates) },
    holdings: [{ id: "transition", name: "Проверка полного перехода",
      people: { list: [{ id: "resident", name: "Раненый житель", injuredDays: 3,
        attributes: { strength: 3, agility: 3, wits: 3, empathy: 3 }, traits: [] }] },
      storage: { moneyCopper: 12345, resources: [{ id: "bread-row", resourceId: "bread", name: "Хлеб",
        roomId: "outdoors", qty: 7, batches: [{ id: "bread-batch", qty: 7, ageQd: 12 }] }] },
      finance: { obligations: [{ id: "old-debt", kind: "other", periodKey: "previous", periodIndex: 2,
        dueCopper: 71, paidCopper: 0, status: "unpaid" }] },
      buildings: {
      list: savedTemplates.map((row) => ({ ...clone(row),
        id: `instance-${row.id}`, templateId: row.id, constructionStatus: "built", buildProgress: row.buildTarget
      }))
    } }]
  });
  const snapshot = clone(source);
  assert.equal(source.holdings[0].storage.moneyCopper, 12345);
  assert.equal(source.holdings[0].storage.resources[0].batches[0].ageQd, 12);
  assert.equal(source.holdings[0].finance.obligations[0].dueCopper, 71);
  assert.equal(source.holdings[0].people.list[0].injuredDays, 3);
  const plan = planBuildingCatalogMigration({ currentData: source, operationId: "restore-missing-template" });
  assert.deepEqual(plan.blockingIssues, [], "Restoring an absent template has no migration conflicts");
  assert.equal(plan.canApply, true);
  assert.deepEqual(source, snapshot, "Full preview must not mutate its source");
  const legacyLabor = clone(source);
  legacyLabor.holdings[0].buildings.list.find(row => row.templateId === "lumbermill").maintenance.schemaVersion = 1;
  legacyLabor.holdings[0].people.list[0].workAllocationMode = "explicit";
  legacyLabor.holdings[0].people.list[0].workAllocations = [
    { sourceId: "maintenance", functionId: "maintenance", normalQd: 2 },
    { sourceId: "instance-lumbermill", functionId: "production", normalQd: 4 }
  ];
  const laborSnapshot = clone(legacyLabor);
  const laborPlan = planBuildingCatalogMigration({ currentData: legacyLabor, operationId: "force-legacy-labor", replaceCatalog: true });
  assert.deepEqual(laborPlan.blockingIssues, []);
  assert.deepEqual(laborPlan.targetData.holdings[0].people.list[0].workAllocations, [laborSnapshot.holdings[0].people.list[0].workAllocations[1]], "Only obsolete general maintenance is released");
  assert.deepEqual(legacyLabor, laborSnapshot, "Forced preview still never writes the source");
  const applied = applyBuildingCatalogMigration({ currentData: source, plan, operationId: plan.operationId });
  const loaded = normalizeSkyholdData(applied.data);
  assert.equal(loaded.catalog.buildings.length, 126, "The current catalog is complete");
  assert.equal(loaded.holdings[0].buildings.list.length, savedTemplates.length, "New templates do not construct free buildings");
  assert.deepEqual(loaded.holdings[0].buildings.list.map((row) => row.id), source.holdings[0].buildings.list.map((row) => row.id));
  const withoutBuildings = (holding) => Object.fromEntries(Object.entries(holding).filter(([key]) => key !== "buildings"));
  assert.deepEqual(withoutBuildings(loaded.holdings[0]), withoutBuildings(source.holdings[0]), "World state outside buildings must survive load after Apply");
  assert.deepEqual(loaded.catalog, plan.targetData.catalog, "Preview predicts the stored normalized catalog");
  assert.deepEqual(loaded.holdings, plan.targetData.holdings, "Preview predicts the stored normalized instances");
  const replay = applyBuildingCatalogMigration({ currentData: loaded, plan, operationId: plan.operationId });
  assert.equal(replay.commitRequired, false);
  const repeat = planBuildingCatalogMigration({ currentData: loaded, operationId: "fresh-after-load" });
  assert.deepEqual(repeat.blockingIssues, []);
  assert.equal(repeat.hasChanges, false, "A fresh preview after loading the migrated world is a no-op");
  // A subsequent migration preview must not become an implicit repair tool.
  loaded.catalog.buildings[0].reputation = 99;
  loaded.holdings[0].buildings.list[0].reputation = 97;
  const customized = planBuildingCatalogMigration({ currentData: loaded, operationId: "custom-current" });
  assert.deepEqual(customized.blockingIssues, []);
  assert.equal(customized.targetData.catalog.buildings[0].reputation, 99);
  assert.equal(customized.targetData.holdings[0].buildings.list[0].reputation, 97);
  assert.equal(customized.hasChanges, false);
  loaded.catalog.buildings.push({ id: "unused-old-template", name: "Старый шаблон" });
  const forced = planBuildingCatalogMigration({ currentData: loaded, operationId: "replace-all", replaceCatalog: true });
  assert.deepEqual(forced.blockingIssues, [], "Forced replacement restores approved mechanics");
  assert.equal(forced.canApply, true);
  assert.equal(forced.targetData.catalog.buildings.length, 126, "Forced replacement explicitly removes unused custom templates");
  assert.notEqual(forced.targetData.catalog.buildings[0].reputation, 99);
  assert.notEqual(forced.targetData.holdings[0].buildings.list[0].reputation, 97);
  assert.deepEqual(withoutBuildings(forced.targetData.holdings[0]), withoutBuildings(loaded.holdings[0]));
  const forcedApplied = applyBuildingCatalogMigration({ currentData: loaded, plan: forced });
  const forcedLoaded = normalizeSkyholdData(forcedApplied.data);
  assert.equal(planBuildingCatalogMigration({ currentData: forcedLoaded, operationId: "repeat-force", replaceCatalog: true }).hasChanges, false);
  const unsafe = clone(loaded);
  unsafe.holdings[0].buildings.list.push({ id: "custom-instance", templateId: "unused-old-template", name: "Неизвестная постройка" });
  assert.equal(planBuildingCatalogMigration({ currentData: unsafe, operationId: "unsafe-force", replaceCatalog: true }).blockingIssues.some((row) => row.code === "custom-instance-unmapped"), true);
  const reserved = clone(source);
  reserved.holdings[0].buildings.list.find((row) => row.templateId === "lumbermill").productionLines[0].workProgressUnits = 5000;
  const reservedPlan = planBuildingCatalogMigration({ currentData: reserved, operationId: "force-reserved", replaceCatalog: true });
  assert.equal(reservedPlan.canApply, false);
  assert.equal(reservedPlan.blockingIssues.some((row) => row.code === "production-in-progress"), true);
  loaded.meta.templateCatalogVersion = TEMPLATE_CATALOG_VERSION - 1;
  assert.throws(() => planBuildingCatalogMigration({ currentData: loaded, operationId: "retired-transition" }), { code: "source-version-older" });
  loaded.meta.templateCatalogVersion = TEMPLATE_CATALOG_VERSION + 1;
  assert.throws(() => planBuildingCatalogMigration({ currentData: loaded, operationId: "no-downgrade" }),
    (error) => error.code === "source-version-newer", "An older module must not downgrade a newer world catalog");
}
