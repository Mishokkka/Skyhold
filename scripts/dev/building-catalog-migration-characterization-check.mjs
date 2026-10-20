import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkMigrationProductionCarry } from "./building-catalog-cycle-migration-check.mjs";
import { checkMigrationPreviewRefresh } from "./building-catalog-preview-check.mjs";
import { checkCatalogLoadBoundary } from "./building-catalog-load-boundary-check.mjs";
import { checkBuildingCatalogFullTransition } from "./building-catalog-full-transition-check.mjs";

checkCatalogLoadBoundary();
checkBuildingCatalogFullTransition();

import { TEMPLATE_CATALOG_VERSION } from "../data/building-templates.js";
import { BUILDING_CATALOG_V14_TEMPLATES } from "../data/building-template-v14-catalog.js";
import { clone } from "../data/utils.js";
import {
  BUILDING_CATALOG_MIGRATION_NAMESPACE,
  applyBuildingCatalogMigration,
  planBuildingCatalogMigration,
  technicalMaintenanceMigrationIssues
} from "../workflows/buildings/catalog-migration.js";

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
  return clone(BUILDING_CATALOG_V14_TEMPLATES.find((row) => row.id === id));
}

function fixture() {
  const oldLumbermill = {
    ...template("lumbermill"),
    id: "lumbermill-instance",
    templateId: "lumbermill",
    templateVersion: 12,
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
    templateId: "tavern",
    name: "Старая таверна",
    notes: "Не переименовывать",
    constructionStatus: "built",
    buildTarget: 2,
    buildProgress: 2,
    assignedWorkerIds: []
  };
  const legacyHouse = {
    id: "laputa-building-house-1",
    templateId: "",
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
    templateVersion: 12,
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
    meta: { schemaVersion: 71, templateCatalogVersion: 13, revision: 7, storageCommit: null },
    catalog: {
      buildings: [
        { ...template("lumbermill"), templateVersion: 12, reputation: 99 },
        { id: "tavern", name: "Таверна", templateVersion: 12 },
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
  const sourceSnapshot = clone(source);
  {
    const draft = fixture();
    const person = draft.holdings[0].people.list[0];
    person.workAllocationMode = "explicit";
    person.workAllocations = [{ sourceId: "maintenance", functionId: "maintenance", normalQd: 2 },
      { sourceId: "lumbermill-instance", functionId: "production", normalQd: 18 }];
    const args = { currentData: draft, operationId: "release-old-maintenance" };
    const blocked = planBuildingCatalogMigration(args);
    const issue = blocked.blockingIssues.find((row) => row.canReleaseMaintenance);
    assert.ok(issue);
    const resolutions = { [issue.resolutionKey]: "release-maintenance" };
    const resolved = planBuildingCatalogMigration({ ...args, resolutions });
    assert.equal(resolved.decisions.length, 1);
    assert.equal(resolved.targetData.holdings[0].people.list[0].workAllocations.length, 1);
    assert.equal(person.workAllocations.length, 2, "Resolution changes only the projected copy");
    assert.equal(resolved.canApply, false);
    assert.ok(planBuildingCatalogMigration(args).blockingIssues.some((row) => row.canReleaseMaintenance), "Removing the local decision restores the conflict");
    person.workAllocations[0].normalQd = 3;
    assert.ok(planBuildingCatalogMigration({ ...args, resolutions }).blockingIssues.some((row) => row.canReleaseMaintenance), "Changed allocations invalidate the prior decision");
  }
  const nextPlan = planBuildingCatalogMigration({ currentData: source, operationId: "next-catalog-preview", createdAt: "2026-09-06T00:00:00.000Z" });
  assert.equal(nextPlan.preview.catalogTemplates, 126);
  assert.equal(nextPlan.preview.targetTemplateCatalogVersion, TEMPLATE_CATALOG_VERSION);
  assert.equal(nextPlan.canApply, false, "Saved overrides block Apply until their choices are resolved");
  assert.throws(() => applyBuildingCatalogMigration({ currentData: source, plan: nextPlan }), (error) => error.code === "plan-blocked");
  assert.throws(() => applyBuildingCatalogMigration({ currentData: source, plan: { ...nextPlan, canApply: true } }), (error) => error.code === "plan-blocked", "Apply must reject unresolved choices independently of the UI flag");
  assert.ok(nextPlan.targetData.catalog.buildings.some((row) => row.id === "meeting-house"));
  assert.ok(!nextPlan.targetData.holdings[0].buildings.list.some((row) => row.templateId === "meeting-house"), "A new template never constructs itself");
  assert.deepEqual(nextPlan.targetData.holdings[0].people, source.holdings[0].people);
  assert.deepEqual(nextPlan.targetData.holdings[0].storage, source.holdings[0].storage);
  assert.deepEqual(source, sourceSnapshot);
  {
    const conflict = nextPlan.blockingIssues.find((row) => row.canResolveMechanics && row.buildingId === "lumbermill" && row.beforeText === "99");
    assert.ok(conflict, "A saved template override must not be silently replaced");
    const args = { currentData: source, operationId: "choose-mechanics" };
    const kept = planBuildingCatalogMigration({ ...args, resolutions: { [conflict.resolutionKey]: "keep-mechanics" } });
    assert.equal(kept.targetData.catalog.buildings.find((row) => row.id === "lumbermill").reputation, 99);
    const replaced = planBuildingCatalogMigration({ ...args, resolutions: { [conflict.resolutionKey]: "replace-mechanics" } });
    assert.equal(replaced.targetData.catalog.buildings.find((row) => row.id === "lumbermill").reputation, template("lumbermill").reputation);
    assert.deepEqual(source, sourceSnapshot);
    const changed = clone(source);
    changed.catalog.buildings.find((row) => row.id === "lumbermill").reputation = 98;
    const fresh = planBuildingCatalogMigration({ ...args, currentData: changed, resolutions: { [conflict.resolutionKey]: "keep-mechanics" } });
    assert.ok(fresh.blockingIssues.some((row) => row.canResolveMechanics && row.beforeText === "98"));
    const construction = clone(source);
    const project = construction.holdings[0].buildings.list.find((row) => row.id === "lumbermill-instance");
    project.constructionStatus = "building";
    project.buildTarget = template("lumbermill").buildTarget + 7;
    project.buildProgress = 2;
    const constructionPlan = planBuildingCatalogMigration({ ...args, currentData: construction });
    const sizeIssue = constructionPlan.blockingIssues.find((row) => row.buildingId === project.id && row.detail.startsWith("Этапы строительства"));
    assert.ok(sizeIssue);
    const keptProject = planBuildingCatalogMigration({ ...args, currentData: construction, resolutions: { [sizeIssue.resolutionKey]: "keep-mechanics" } })
      .targetData.holdings[0].buildings.list.find((row) => row.id === project.id);
    assert.equal(keptProject.buildTarget, project.buildTarget);
    assert.equal(keptProject.buildProgress, 2, "Resolve the construction norm before mapping progress, not afterwards");
  }
  const acceptedChoices = Object.fromEntries(nextPlan.blockingIssues.filter((row) => row.canResolveMechanics).map((row) => [row.resolutionKey, "replace-mechanics"]));
  const plan = planBuildingCatalogMigration({
    currentData: source,
    resolutions: acceptedChoices,
    operationId: "building-migration-test",
    createdAt: "2026-09-05T00:00:00.000Z"
  });
  assert.deepEqual(source, sourceSnapshot, "Preview must never mutate current world data");
  assert.equal(plan.canApply, true);
  assert.equal(plan.preview.targetTemplateCatalogVersion, TEMPLATE_CATALOG_VERSION);
  assert.equal(plan.preview.changedInstances, 4);
  assert.equal(plan.preview.customInstances, 1);
  assert.equal(plan.preview.aliasInstances, 1);
  assert.equal(plan.preview.knownLegacyInstances, 1);
  assert.equal(plan.preview.blockingIssues, 0);

  const migrated = plan.targetData.holdings[0].buildings.list;
  const lumbermill = migrated.find((row) => row.id === "lumbermill-instance");
  assert.equal(lumbermill.name, "Лесоповал у обрыва", "instance names survive catalog migration");
  assert.equal(lumbermill.notes, "Пользовательская заметка");
  assert.equal(lumbermill.productionLines.find((row) => row.resourceId === "wood").outputQty, 2, "approved production mechanics replace the legacy exploit");
  assert.equal(lumbermill.productionLines.find((row) => row.resourceId === "wood").pendingQty, 7, "already finished output survives on a matching line");
  assert.equal(lumbermill.productionLines.find((row) => row.resourceId === "wood").active, false, "the player's line selection survives");
  assert.deepEqual(lumbermill.assignedWorkerIds.filter(Boolean), ["worker-1"], "worker assignments survive when they fit the new capacity");

  const inn = migrated.find((row) => row.id === "old-tavern");
  assert.equal(inn.templateId, "inn", "a true deprecated identifier alias is converted directly");
  assert.equal(inn.name, "Старая таверна");
  const house = migrated.find((row) => row.id === "laputa-building-house-1");
  assert.equal(house.templateId, "common-house", "the known legacy Laputa instance map does not rely on fuzzy names");
  assert.equal(house.buildProgress, 4, "unfinished projects preserve the original paid material schedule and stage scale");
  assert.equal(house.buildTarget, 8);
  assert.equal(house.materialsAllocated, true, "a started legacy project is not charged its construction materials again");
  assert.equal(house.residents, 5);
  assert.deepEqual(house.contents, [{ id: "chest", name: "Сундук", qty: 1 }]);

  const watch = migrated.find((row) => row.id === "watch-post-instance");
  assert.equal(watch.templateId, "watch-post", "upgradesFromTemplateIds must not cause a free Sheriff Post upgrade");
  assert.equal(migrated.find((row) => row.id === "custom-instance").customRule.untouched, true, "custom instances remain untouched");
  assert.equal(plan.targetData.catalog.buildings.some((row) => row.id === "custom-template" && row.customRule === true), true, "custom catalog templates remain available");
  assert.deepEqual(plan.targetData.catalog.deletedBuildingTemplateIds, ["custom-deleted"], "the approved catalog is restored without erasing custom tombstones");

  const applied = applyBuildingCatalogMigration({ currentData: source, plan, operationId: plan.operationId });
  assert.equal(applied.commitRequired, true);
  assert.equal(applied.data.meta.templateCatalogVersion, TEMPLATE_CATALOG_VERSION);
  assert.equal(applied.marker.namespace, BUILDING_CATALOG_MIGRATION_NAMESPACE);
  assert.equal(applied.marker.operationId, plan.operationId);
  const replay = applyBuildingCatalogMigration({ currentData: applied.data, plan, operationId: plan.operationId });
  assert.equal(replay.alreadyApplied, true, "the same operationId is idempotent");
  assert.equal(replay.commitRequired, false);

  const stale = fixture();
  stale.meta.revision += 1;
  assert.throws(
    () => applyBuildingCatalogMigration({ currentData: stale, plan, operationId: plan.operationId }),
    (error) => error?.code === "target-revision",
    "Apply must refuse a world changed after Preview"
  );

  const blockedSource = fixture();
  blockedSource.holdings[0].buildings.list.push({
    id: "legacy-hut",
    templateId: "hut",
    name: "Старая хижина",
    constructionStatus: "built"
  });
  blockedSource.holdings[0].buildings.list[0].productionLines[0].workProgressUnits = 5_000;
  const blocked = planBuildingCatalogMigration({ currentData: blockedSource, operationId: "blocked-migration" });
  assert.equal(blocked.canApply, false);
  assert.equal(blocked.blockingIssues.some((row) => row.code === "deprecated-template-unmapped"), true, "ambiguous deprecated buildings require an explicit decision");
  assert.equal(blocked.blockingIssues.some((row) => row.code === "production-in-progress"), true, "incomplete production reservations must be resolved before migration");
  assert.throws(
    () => applyBuildingCatalogMigration({ currentData: blockedSource, plan: blocked, operationId: blocked.operationId }),
    (error) => error?.code === "plan-blocked"
  );
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkBuildingCatalogMigrationCharacterization();
  await checkMigrationProductionCarry();
  await checkMigrationPreviewRefresh();
  console.log("FBL Skyhold building catalog migration: exact aliases, state preservation, blockers, stale protection and idempotent Apply passed.");
}
