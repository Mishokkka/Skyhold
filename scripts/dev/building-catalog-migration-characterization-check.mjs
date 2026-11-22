import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkMigrationProductionCarry } from "./building-catalog-cycle-migration-check.mjs";
import { checkMigrationPreviewRefresh } from "./building-catalog-preview-check.mjs";
import { checkCatalogLoadBoundary } from "./building-catalog-load-boundary-check.mjs";
import { checkBuildingCatalogFullTransition } from "./building-catalog-full-transition-check.mjs";

checkCatalogLoadBoundary();
checkBuildingCatalogFullTransition();

import { BUILDING_TEMPLATES_BEFORE_LABOR_TRANSITION, DEFAULT_BUILDING_TEMPLATES, TEMPLATE_CATALOG_VERSION } from "../data/building-templates.js";
import { clone } from "../data/utils.js";
import {
  BUILDING_CATALOG_MIGRATION_NAMESPACE,
  applyBuildingCatalogMigration,
  planBuildingCatalogMigration,
  technicalMaintenanceMigrationIssues
} from "../workflows/buildings/catalog-migration.js";

{
  const school = { id: "school", effect: "Оплаченный учитель открывает ролевые образовательные решения",
    notes: "Механика работает при годовом старении: шанс небольшой, но может дать +1 к характеристике и положительную черту." };
  const bank = { id: "bank-exchange", effect: "Явные займы, вклады, гарантии и крупные договоры без пассивной эмиссии денег" };
  const newSchool = DEFAULT_BUILDING_TEMPLATES.find(row => row.id === "school");
  const newBank = DEFAULT_BUILDING_TEMPLATES.find(row => row.id === "bank-exchange");
  const version = TEMPLATE_CATALOG_VERSION;
  const source = { meta: { revision: 7, templateCatalogVersion: version },
    catalog: { buildings: [{ ...school, templateVersion: version, notes: "Записки ГМа" },
      { ...bank, templateVersion: version, description: "Семейный банк", visibility: "gm" }] },
    holdings: [{ id: "a", name: "A", buildings: { list: [
      { ...school, id: "school-a", templateId: "school", templateVersion: version, effect: "Наши занятия" },
      { id: "custom", name: "Школа", notes: school.notes }
    ] } }] };
  const before = clone(source);
  const args = { currentData: source, operationId: `standard-text-${version}`, textOnly: true };
  const plan = planBuildingCatalogMigration(args);
  assert.deepEqual(source, before, "the preview must not write the world");
  assert.equal(plan.canApply, true, "known old standard text must have a reviewable update even on the current catalog version");
  assert.deepEqual(plan.textUpdates.map(row => row.field), ["effect", "effect", "notes"]);
  const result = applyBuildingCatalogMigration({ currentData: source, plan });
  const expected = clone(source);
  expected.catalog.buildings[0].effect = newSchool.effect;
  expected.catalog.buildings[1].effect = newBank.effect;
  expected.holdings[0].buildings.list[0].notes = newSchool.notes;
  assert.deepEqual(result.data.catalog, expected.catalog);
  assert.deepEqual(result.data.holdings, expected.holdings);
  assert.equal(result.data.meta.templateCatalogVersion, version, "a text update must not advance the installed catalog version");
  assert.equal(applyBuildingCatalogMigration({ currentData: result.data, plan }).commitRequired, false);
  assert.equal(planBuildingCatalogMigration({ ...args, currentData: result.data, operationId: "repeat-text" }).hasChanges, false);
  const changed = clone(source);
  changed.catalog.buildings[0].effect = "Новая авторская правка";
  assert.throws(() => applyBuildingCatalogMigration({ currentData: changed, plan }), { code: "target-catalog-hash" });
}

{
  const before = { id: "holding", buildings: { list: [{ id: "mill", maintenance: { schemaVersion: 1 } }] },
    people: { list: [{ id: "worker", workAllocationMode: "explicit", workAllocations: [
      { sourceId: "maintenance", functionId: "maintenance", normalQd: 2 }
    ] }] } };
  const after = clone(before);
  after.buildings.list[0].maintenance.schemaVersion = 2;
  const snapshot = clone(before);
  assert.equal(technicalMaintenanceMigrationIssues(before, after)[0].code, "legacy-maintenance-assignment");
  assert.deepEqual(before, snapshot, "Preview must not redistribute legacy assignments automatically");
  assert.deepEqual(technicalMaintenanceMigrationIssues(before, before), [], "Existing version 1 migration remains compatible");
  before.people.list[0].workAllocations = [{ sourceId: "mill", functionId: "production", normalQd: 18 }];
  assert.deepEqual(technicalMaintenanceMigrationIssues(before, after), []);
}

function template(id) {
  return clone(BUILDING_TEMPLATES_BEFORE_LABOR_TRANSITION.find((row) => row.id === id));
}

function fixture() {
  const oldLumbermill = {
    ...template("lumbermill"),
    id: "lumbermill-instance",
    templateId: "lumbermill",
    templateVersion: TEMPLATE_CATALOG_VERSION,
    name: "Лесоповал у обрыва",
    notes: "Пользовательская заметка",
    constructionStatus: "built",
    buildTarget: 9,
    buildProgress: 9,
    assignedWorkerIds: ["worker-1"],
    productionLines: [{
      id: "old-wood-line",
      resourceId: "wood",
      resource: "Древесина",
      outputQty: 999,
      workQd: 1,
      active: false,
      pendingQty: 7,
      storageRoomId: "warehouse-room",
      workProgressUnits: 0,
      workInputsReserved: false,
      workReservedOutputQty: 0
    }]
  };
  const oldTavern = {
    id: "old-tavern",
    templateId: "inn",
    name: "Старая таверна",
    notes: "Не переименовывать",
    constructionStatus: "built",
    buildTarget: 2,
    buildProgress: 2,
    assignedWorkerIds: []
  };
  const legacyHouse = {
    id: "laputa-building-house-1",
    templateId: "common-house",
    name: "Дом-1",
    constructionStatus: "building",
    buildTarget: 8,
    buildProgress: 4,
    materialsAllocated: true,
    residents: 5,
    contents: [{ id: "chest", name: "Сундук", qty: 1 }],
    assignedWorkerIds: []
  };
  const watchPost = {
    ...template("watch-post"),
    id: "watch-post-instance",
    templateId: "watch-post",
    templateVersion: TEMPLATE_CATALOG_VERSION,
    name: "Старый дозор",
    constructionStatus: "built",
    assignedWorkerIds: [""]
  };
  const custom = {
    id: "custom-instance",
    templateId: "custom-template",
    name: "Авторская мастерская",
    constructionStatus: "built",
    customRule: { untouched: true }
  };
  return {
    meta: { schemaVersion: 72, templateCatalogVersion: TEMPLATE_CATALOG_VERSION, revision: 7, storageCommit: null },
    catalog: {
      buildings: [
        { ...template("lumbermill"), templateVersion: TEMPLATE_CATALOG_VERSION, reputation: 99 },
        template("inn"),
        { id: "custom-template", name: "Авторский шаблон", customRule: true }
      ],
      deletedBuildingTemplateIds: ["well", "custom-deleted"],
      resources: []
    },
    holdings: [{
      id: "holding-1",
      name: "Тестовое поселение",
      people: {
        list: [{
          id: "worker-1",
          name: "Слабый лесоруб",
          dead: false,
          injuredDays: 0,
          attributes: { strength: 2, agility: 3, wits: 3, empathy: 3 },
          traits: [],
          traitsText: ""
        }]
      },
      buildings: { list: [oldLumbermill, oldTavern, legacyHouse, watchPost, custom] },
      gm: {}
    }]
  };
}

export function checkBuildingCatalogMigrationCharacterization() {
  const source = fixture();
  const snapshot = clone(source);
  const safe = planBuildingCatalogMigration({ currentData: source, operationId: "add-missing-templates" });
  assert.equal(safe.canApply, true);
  assert.equal(safe.preview.catalogTemplates, 126);
  assert.equal(safe.targetData.catalog.buildings.find(row => row.id === "lumbermill").reputation, 99);
  assert.equal(safe.targetData.catalog.buildings.some(row => row.id === "custom-template" && row.customRule), true);
  assert.deepEqual(safe.targetData.catalog.deletedBuildingTemplateIds, ["custom-deleted"]);
  assert.deepEqual(safe.targetData.holdings, source.holdings, "A non-replacing update preserves current instances and custom mechanics");
  assert.ok(safe.targetData.catalog.buildings.some(row => row.id === "meeting-house"));
  assert.ok(!safe.targetData.holdings[0].buildings.list.some(row => row.templateId === "meeting-house"));

  const forced = { currentData: source, replaceCatalog: true, operationId: "refresh-current-buildings" };
  const custom = planBuildingCatalogMigration(forced);
  assert.equal(custom.canApply, false);
  assert.ok(custom.blockingIssues.some(row => row.code === "custom-instance-unmapped"));
  assert.throws(() => applyBuildingCatalogMigration({ currentData: source, plan: { ...custom, canApply: true } }), { code: "plan-blocked" });
  assert.deepEqual(source, snapshot, "Preview must leave the source intact even when it cannot be applied");

  const editable = clone(source);
  editable.holdings[0].buildings.list = editable.holdings[0].buildings.list.filter(row => row.templateId !== "custom-template");
  const editableSnapshot = clone(editable);
  const plan = planBuildingCatalogMigration({ ...forced, currentData: editable });
  assert.equal(plan.canApply, true);
  assert.equal(plan.preview.targetTemplateCatalogVersion, TEMPLATE_CATALOG_VERSION);
  assert.equal(plan.preview.changedInstances, 4);
  assert.deepEqual(editable, editableSnapshot);

  const projected = plan.targetData.holdings[0];
  assert.deepEqual(projected.people, editable.holdings[0].people);
  assert.deepEqual(projected.storage, editable.holdings[0].storage);
  const lumbermill = projected.buildings.list.find(row => row.id === "lumbermill-instance");
  assert.equal(lumbermill.name, "Лесоповал у обрыва");
  assert.equal(lumbermill.notes, "Пользовательская заметка");
  const wood = lumbermill.productionLines.find(row => row.resourceId === "wood");
  assert.deepEqual([wood.outputQty, wood.pendingQty, wood.active], [2, 7, false], "Completed output and line selection survive restoration of the default recipe");
  assert.deepEqual(lumbermill.assignedWorkerIds.filter(Boolean), ["worker-1"]);
  const inn = projected.buildings.list.find(row => row.id === "old-tavern");
  assert.equal(inn.templateId, "inn");
  assert.equal(inn.name, "Старая таверна");
  const house = projected.buildings.list.find(row => row.templateId === "common-house");
  assert.deepEqual([house.buildProgress, house.buildTarget, house.materialsAllocated, house.residents], [4, 8, true, 5]);
  assert.deepEqual(house.contents, [{ id: "chest", name: "Сундук", qty: 1 }]);
  assert.equal(projected.buildings.list.find(row => row.id === "watch-post-instance").templateId, "watch-post",
    "An approved upgrade relationship never grants a free upgrade during refresh");

  const applied = applyBuildingCatalogMigration({ currentData: editable, plan });
  assert.equal(applied.commitRequired, true);
  assert.equal(applied.data.meta.templateCatalogVersion, TEMPLATE_CATALOG_VERSION);
  assert.equal(applied.marker.namespace, BUILDING_CATALOG_MIGRATION_NAMESPACE);
  assert.equal(applied.marker.operationId, plan.operationId);
  const replay = applyBuildingCatalogMigration({ currentData: applied.data, plan });
  assert.equal(replay.alreadyApplied, true);
  assert.equal(replay.commitRequired, false);

  const stale = clone(editable);
  stale.meta.revision += 1;
  assert.throws(() => applyBuildingCatalogMigration({ currentData: stale, plan }), { code: "target-revision" });
  stale.meta.revision -= 1;
  stale.meta.templateCatalogVersion -= 1;
  assert.throws(() => applyBuildingCatalogMigration({ currentData: stale, plan }), { code: "target-catalog-version" });

  const blockedSource = clone(editable);
  blockedSource.holdings[0].buildings.list.push({ id: "legacy-hut", templateId: "hut", name: "Старая хижина" });
  blockedSource.holdings[0].buildings.list[0].productionLines[0].workProgressUnits = 5_000;
  const blocked = planBuildingCatalogMigration({ ...forced, currentData: blockedSource });
  assert.equal(blocked.canApply, false);
  assert.ok(blocked.blockingIssues.some(row => row.code === "deprecated-template-unmapped"));
  assert.ok(blocked.blockingIssues.some(row => row.code === "production-in-progress"));
  assert.throws(() => applyBuildingCatalogMigration({ currentData: blockedSource, plan: blocked }), { code: "plan-blocked" });
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkBuildingCatalogMigrationCharacterization();
  await checkMigrationProductionCarry();
  await checkMigrationPreviewRefresh();
  console.log("FBL Skyhold building catalog refresh: saved state, incompatible recipes, revision checks and idempotent Apply passed.");
}
