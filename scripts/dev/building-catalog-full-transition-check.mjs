import assert from "node:assert/strict";
import { BUILDING_CATALOG_V14_TEMPLATES } from "../data/building-template-v14-catalog.js";
import { TEMPLATE_CATALOG_VERSION } from "../data/building-templates.js";
import { buildingCatalogV15Templates } from "../data/building-template-revision-v15.js";
import { normalizeSkyholdData } from "../data/normalizers.js";
import { clone } from "../data/utils.js";
import { applyBuildingCatalogMigration, planBuildingCatalogMigration } from "../workflows/buildings/catalog-migration.js";

export function checkBuildingCatalogFullTransition() {
  checkV15LeisureTransition();
  const source = normalizeSkyholdData({
    meta: { templateCatalogVersion: 14, revision: 4 },
    catalog: { buildings: clone(BUILDING_CATALOG_V14_TEMPLATES) },
    holdings: [{ id: "transition", name: "Проверка полного перехода",
      people: { list: [{ id: "resident", name: "Раненый житель", injuredDays: 3,
        attributes: { strength: 3, agility: 3, wits: 3, empathy: 3 }, traits: [] }] },
      storage: { moneyCopper: 12345, resources: [{ id: "bread-row", resourceId: "bread", name: "Хлеб",
        roomId: "outdoors", qty: 7, batches: [{ id: "bread-batch", qty: 7, ageQd: 12 }] }] },
      finance: { obligations: [{ id: "old-debt", kind: "other", periodKey: "previous", periodIndex: 2,
        dueCopper: 71, paidCopper: 0, status: "unpaid" }] },
      buildings: {
      list: BUILDING_CATALOG_V14_TEMPLATES.map((row) => ({ ...clone(row),
        id: `instance-${row.id}`, templateId: row.id, constructionStatus: "built", buildProgress: row.buildTarget
      }))
    } }]
  });
  const snapshot = clone(source);
  assert.equal(source.holdings[0].storage.moneyCopper, 12345);
  assert.equal(source.holdings[0].storage.resources[0].batches[0].ageQd, 12);
  assert.equal(source.holdings[0].finance.obligations[0].dueCopper, 71);
  assert.equal(source.holdings[0].people.list[0].injuredDays, 3);
  const plan = planBuildingCatalogMigration({ currentData: source, operationId: "full-v14-v15" });
  assert.deepEqual(plan.blockingIssues, [], "Normalized default v14 rules are not custom overrides");
  assert.equal(plan.canApply, true);
  assert.deepEqual(source, snapshot, "Full preview must not mutate its source");
  const legacyLabor = clone(source);
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
  assert.equal(loaded.catalog.buildings.length, 126, "v16 adds five leisure templates");
  assert.equal(loaded.holdings[0].buildings.list.length, 120, "New templates do not construct free buildings");
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
  const customized = planBuildingCatalogMigration({ currentData: loaded, operationId: "custom-v15" });
  assert.deepEqual(customized.blockingIssues, []);
  assert.equal(customized.targetData.catalog.buildings[0].reputation, 99);
  assert.equal(customized.targetData.holdings[0].buildings.list[0].reputation, 97);
  assert.equal(customized.hasChanges, false);
  loaded.catalog.buildings.push({ id: "unused-old-template", name: "Старый шаблон" });
  const forced = planBuildingCatalogMigration({ currentData: loaded, operationId: "replace-all", replaceCatalog: true });
  assert.deepEqual(forced.blockingIssues, [], "Forced replacement accepts old mechanics without per-field choices");
  assert.equal(forced.canApply, true);
  assert.equal(forced.targetData.catalog.buildings.length, 126, "Forced replacement removes old custom templates and includes five leisure templates");
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
  loaded.meta.templateCatalogVersion = TEMPLATE_CATALOG_VERSION + 1;
  assert.throws(() => planBuildingCatalogMigration({ currentData: loaded, operationId: "no-downgrade" }),
    (error) => error.code === "source-version-newer", "An older module must not downgrade a newer world catalog");
}

function checkV15LeisureTransition() {
  const templates = buildingCatalogV15Templates();
  const source = normalizeSkyholdData({
    meta: { templateCatalogVersion: 15, revision: 9 },
    catalog: { buildings: clone(templates) },
    holdings: [{ id: "laputa-test", name: "Лапута",
      people: { list: [{ id: "inn-worker", name: "Работник", attributes: { strength: 3, agility: 3, wits: 3, empathy: 3 },
        workAllocationMode: "explicit", workAllocations: [{ id: "kitchen", sourceId: "v15-inn", functionId: "production", normalQd: 20 }] }] },
      storage: { moneyCopper: 8765 },
      gm: { moraleSnapshot: { periodKey: "old-report", residents: { "inn-worker": { work: { value: -1 } } } } },
      buildings: { list: templates.map((row) => ({ ...clone(row), id: `v15-${row.id}`, templateId: row.id,
        name: row.id === "inn" ? "Наша таверна" : row.name,
        constructionStatus: "built", buildProgress: row.buildTarget,
        assignedWorkerIds: row.id === "inn" ? ["inn-worker"] : [],
        notes: "Сохранить заметку" })) }
    }]
  });
  const snapshot = clone(source);
  const plan = planBuildingCatalogMigration({ currentData: source, operationId: "v15-leisure" });
  assert.deepEqual(plan.blockingIssues, [], "Unmodified v15 must use its historical baseline, not the new v16 values");
  assert.deepEqual(source, snapshot, "v15 preview remains read-only");
  assert.equal(plan.targetData.catalog.buildings.length, 126);
  const result = applyBuildingCatalogMigration({ currentData: source, plan });
  const loaded = normalizeSkyholdData(result.data);
  const before = source.holdings[0], after = loaded.holdings[0];
  assert.equal(after.buildings.list.length, before.buildings.list.length, "New leisure types are templates, not free constructed buildings");
  assert.deepEqual(after.people, before.people, "Residents and split kitchen allocations survive migration");
  assert.deepEqual(after.storage, before.storage, "Treasury survives migration");
  assert.deepEqual(after.gm, before.gm, "Historical morale reports are not recalculated during catalog migration");
  for (const prior of before.buildings.list) {
    const next = after.buildings.list.find((row) => row.id === prior.id);
    assert.equal(next.name, prior.name);
    assert.equal(next.notes, prior.notes);
    assert.equal(next.constructionStatus, prior.constructionStatus);
    assert.deepEqual(next.assignedWorkerIds.filter(Boolean), prior.assignedWorkerIds.filter(Boolean));
  }
  const inn = after.buildings.list.find((row) => row.templateId === "inn");
  assert.equal(inn.moraleDelta, 15);
  assert.equal(inn.service?.leisure, undefined, "Approved inn morale uses its working functions instead of a separate leisure crew");
  assert.deepEqual(inn.activation, { minWorkers: 2, minOperationalQd: 40, requiresMeaningfulResult: false, anyWorkingFunction: true });
  assert.equal(after.buildings.list.find((row) => row.templateId === "well").activation.minWorkers, 1);
  assert.equal(planBuildingCatalogMigration({ currentData: loaded, operationId: "v16-repeat" }).hasChanges, false);
  assert.equal(applyBuildingCatalogMigration({ currentData: loaded, plan }).commitRequired, false, "Apply replay stays idempotent");
}
