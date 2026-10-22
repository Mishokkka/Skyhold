import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_BUILDING_TEMPLATES,
  BUILDING_TEMPLATES_BEFORE_LABOR_TRANSITION,
  TEMPLATE_CATALOG_VERSION
} from "../data/building-templates.js";
import {
  BUILDING_DEVELOPMENT_TREE_IDS_V1,
  buildingRequiresConstructionCenter,
  CONSTRUCTION_CENTER_TEMPLATE_ID
} from "../data/building-development-tree.js";
import { migrateData } from "../data/normalizers.js";
import { constructionCenterSuccessBonus } from "../engines/economy/construction-center.js";
import { planBuildingCatalogMigration } from "../workflows/buildings/catalog-migration.js";

const DEVELOPMENT_KEYS = ["food", "technology", "culture", "war"];
const STORY_TEMPLATE_IDS = new Set(["fasti-shop", "laputa-excavated-crypt"]);

function requirementsMet(template, totals) {
  return DEVELOPMENT_KEYS.every((key) => Number(totals[key] ?? 0) >= Number(template?.requirements?.[key] ?? 0));
}

function prerequisitesMet(template, built) {
  const all = [...(template.requiredBuildingIds ?? [])];
  if (buildingRequiresConstructionCenter(template) && !all.includes(CONSTRUCTION_CENTER_TEMPLATE_ID)) all.push(CONSTRUCTION_CENTER_TEMPLATE_ID);
  const any = template.requiredAnyBuildingIds ?? [];
  return all.every((id) => built.has(String(id))) && (any.length === 0 || any.some((id) => built.has(String(id))));
}

export function checkBuildingDevelopmentTreeCharacterization() {
  const ordinary = DEFAULT_BUILDING_TEMPLATES.filter((template) => !STORY_TEMPLATE_IDS.has(template.id));
  assert.equal(ordinary.length, 124, "v16 retains the existing tree and adds five leisure venues");
  assert.deepEqual(
    new Set(BUILDING_DEVELOPMENT_TREE_IDS_V1),
    new Set(ordinary.map((template) => template.id)),
    "the development tree must cover exactly the ordinary catalog"
  );

  const center = ordinary.find((template) => template.id === CONSTRUCTION_CENTER_TEMPLATE_ID);
  assert.equal(center?.buildDifficulty, -1, "Construction Center must remain a difficulty -1 project and avoid a self-cycle");
  assert.deepEqual(ordinary.find((template) => template.id === "gatehouse")?.requiredAnyBuildingIds, ["guard-tower", "ramparts"]);
  assert.deepEqual(ordinary.find((template) => template.id === "artillery-platform")?.requiredAnyBuildingIds, ["arsenal", "powder-magazine"]);
  assert.deepEqual(
    ["watch-post", "barricade-line", "signal-tower", "powder-magazine", "gatehouse", "field-fort", "artillery-platform"]
      .map((id) => {
        const template = ordinary.find((row) => row.id === id);
        return [id, template?.buildTarget, template?.buildDifficulty];
      }),
    [
      ["watch-post", 1, 0],
      ["barricade-line", 2, 0],
      ["signal-tower", 3, -1],
      ["powder-magazine", 5, -2],
      ["gatehouse", 8, -2],
      ["field-fort", 5, 0],
      ["artillery-platform", 7, -2]
    ],
    "the seven approved military construction profiles must remain exact"
  );
  const bathhouse = ordinary.find((template) => template.id === "bathhouse");
  assert.equal(bathhouse?.operatingUpkeepMonthlyCopper, 144, "Bathhouse must keep the approved reduced monthly operating cost");
  const oldBathhouse = BUILDING_TEMPLATES_BEFORE_LABOR_TRANSITION.find((template) => template.id === "bathhouse");
  assert.deepEqual([oldBathhouse?.workersMin, oldBathhouse?.workersMax], [2, 2], "Saved legacy Bathhouse retains its indivisible two-person staff until explicit transition");
  assert.deepEqual([bathhouse?.labor.mode, bathhouse?.workersMin, bathhouse?.workersMax], ["staff", 0, 2], "New Bathhouse keeps two staff places and scales service by actual labor");
  assert.equal((bathhouse?.productionLines ?? []).some((line) => /fuel|топлив/i.test(`${line.resourceId} ${line.expenses}`)), false, "Bathhouse must not add automatic fuel consumption");
  const dovecote = ordinary.find((template) => template.id === "dovecote");
  const oldDovecote = BUILDING_TEMPLATES_BEFORE_LABOR_TRANSITION.find((template) => template.id === "dovecote");
  assert.deepEqual([oldDovecote?.workersMin, oldDovecote?.workersMax], [1, 1], "Saved v16 Dovecote retains its historical caretaker until explicit transition");
  assert.deepEqual([dovecote?.labor.mode, dovecote?.workersMin, dovecote?.workersMax], ["passive", 0, 0], "New Dovecote has no invented permanent staff");
  assert.equal((dovecote?.productionLines ?? []).length, 0, "Dovecote must not simulate pigeon resources or production");
  const centerHolding = { buildings: { list: [{
    id: "center-1",
    templateId: "construction-center",
    lifecycle: "active",
    condition: "intact",
    constructionStatus: "built",
    constructionCrewId: "crew-1"
  }] } };
  assert.equal(constructionCenterSuccessBonus(centerHolding, "crew-1"), 1, "an operational Center must add exactly one success to its selected crew");
  centerHolding.buildings.list.push({ ...centerHolding.buildings.list[0], id: "center-2" });
  assert.equal(constructionCenterSuccessBonus(centerHolding, "crew-1"), 1, "repeated Centers must not stack their construction success bonus");
  centerHolding.buildings.list[0].lifecycle = "disabled";
  centerHolding.buildings.list[1].lifecycle = "disabled";
  assert.equal(constructionCenterSuccessBonus(centerHolding, "crew-1"), 0, "a disabled Center must not support construction");

  const built = new Set();
  const totals = { food: 0, technology: 0, culture: 0, war: 0 };
  const waves = [];
  while (built.size < ordinary.length) {
    const available = ordinary.filter((template) => !built.has(template.id)
      && requirementsMet(template, totals)
      && prerequisitesMet(template, built));
    assert.ok(available.length > 0, `development tree deadlocked after ${built.size} templates`);
    waves.push({ before: { ...totals }, ids: available.map((template) => template.id) });
    for (const template of available) {
      built.add(template.id);
      for (const key of DEVELOPMENT_KEYS) totals[key] += Number(template?.bonuses?.[key] ?? 0);
    }
  }

  assert.deepEqual(waves.map((wave) => wave.ids.length), [12, 26, 34, 16, 23, 9, 3, 1], "v16 retains complete reachability including five leisure venues and the Construction Center gate");
  assert.deepEqual(waves.map((wave) => wave.before), [
    { food: 0, technology: 0, culture: 0, war: 0 },
    { food: 8, technology: 5, culture: 4, war: 8 },
    { food: 36, technology: 22, culture: 21, war: 20 },
    { food: 65, technology: 58, culture: 54, war: 34 },
    { food: 65, technology: 77, culture: 83, war: 54 },
    { food: 88, technology: 127, culture: 123, war: 65 },
    { food: 96, technology: 157, culture: 143, war: 86 },
    { food: 102, technology: 163, culture: 148, war: 102 }
  ]);
  assert.deepEqual(totals, { food: 102, technology: 164, culture: 149, war: 113 });

  const stored = structuredClone(BUILDING_TEMPLATES_BEFORE_LABOR_TRANSITION);
  const storedGatehouse = stored.find((template) => template.id === "gatehouse");
  storedGatehouse.templateVersion = TEMPLATE_CATALOG_VERSION - 1;
  storedGatehouse.requirements = { food: 999, technology: 999, culture: 999, war: 999 };
  storedGatehouse.requiredAnyBuildingIds = [];
  storedGatehouse.wageDailyCopper = 777;
  const migrated = migrateData({
    meta: { templateCatalogVersion: TEMPLATE_CATALOG_VERSION - 1 },
    catalog: { buildings: stored },
    holdings: []
  });
  const migratedGatehouse = migrated.catalog.buildings.find((template) => template.id === "gatehouse");
  assert.deepEqual(migratedGatehouse.requirements, { food: 999, technology: 999, culture: 999, war: 999 }, "ordinary normalization must not silently rewrite an old catalog");
  assert.deepEqual(migratedGatehouse.requiredAnyBuildingIds, [], "ordinary normalization must preserve old prerequisites until explicit Preview/Apply");
  assert.equal(migratedGatehouse.wageDailyCopper, 777, "ordinary normalization must preserve old wage defaults until explicit Preview/Apply");
  const catalogPlan = planBuildingCatalogMigration({ currentData: migrated, operationId: "development-tree-catalog" });
  const plannedGatehouse = catalogPlan.targetData.catalog.buildings.find((template) => template.id === "gatehouse");
  assert.deepEqual(plannedGatehouse.requirements, { food: 0, technology: 22, culture: 0, war: 28 }, "explicit catalog migration installs the recalibrated Gatehouse threshold");
  assert.deepEqual(plannedGatehouse.requiredAnyBuildingIds, ["guard-tower", "ramparts"], "explicit catalog migration refreshes any-of prerequisites");
  assert.equal(plannedGatehouse.wageDailyCopper, 18, "explicit catalog migration installs the approved wage default");

  const legacyBuiltBath = {
    id: "laputa-bath",
    templateId: "bathhouse",
    name: "Старая баня",
    constructionStatus: "built",
    status: "Построено",
    wageDailyCopper: 1,
    baseUpkeepMonthlyCopper: 2,
    operatingUpkeepMonthlyCopper: 3,
    workersMin: 0,
    workersMax: 1,
    materialCosts: [{ id: "paid-stone", resourceId: "stone", name: "Stone", qty: 777 }]
  };
  const legacyProject = {
    id: "laputa-project",
    templateId: "artillery-platform",
    name: "Начатый проект",
    constructionStatus: "building",
    status: "Строится",
    wageDailyCopper: 777,
    requirements: { food: 99, technology: 99, culture: 99, war: 99 },
    requiredBuildingIds: ["old-prerequisite"]
  };
  const migratedLaputa = migrateData({
    meta: { templateCatalogVersion: TEMPLATE_CATALOG_VERSION - 1 },
    catalog: { buildings: stored },
    holdings: [{
      id: "laputa",
      name: "Лапута",
      type: "settlement",
      buildings: { list: [legacyBuiltBath, legacyProject] }
    }]
  });
  const migratedBath = migratedLaputa.holdings[0].buildings.list.find((building) => building.id === "laputa-bath");
  const migratedProject = migratedLaputa.holdings[0].buildings.list.find((building) => building.id === "laputa-project");
  assert.equal(migratedBath.operatingUpkeepMonthlyCopper, 3, "normal loading must preserve the old built instance before explicit migration");
  assert.equal(migratedBath.wageDailyCopper, 1, "normal loading must not silently rewrite an old instance wage");
  assert.equal(migratedBath.materialCosts[0].qty, 777, "normal loading must preserve old construction records");
  assert.equal(migratedProject.wageDailyCopper, 777, "D1-A must preserve the frozen economy snapshot of an already-started project");
  assert.deepEqual(migratedProject.requiredBuildingIds, ["old-prerequisite"], "D1-A must preserve an already-started project's prerequisites");
  const initialLaputaPlan = planBuildingCatalogMigration({ currentData: migratedLaputa, operationId: "development-tree-instances" });
  assert.ok(initialLaputaPlan.blockingIssues.length > 0, "Changing saved building mechanics requires explicit choices");
  const resolutions = Object.fromEntries(initialLaputaPlan.blockingIssues.filter((row) => row.canResolveMechanics).map((row) => [row.resolutionKey, "replace-mechanics"]));
  const laputaPlan = planBuildingCatalogMigration({ currentData: migratedLaputa, operationId: "development-tree-instances", resolutions });
  assert.equal(laputaPlan.canApply, true, "Resolved old buildings must produce an applicable Preview");
  const plannedBath = laputaPlan.targetData.holdings[0].buildings.list.find((building) => building.id === "laputa-bath");
  const plannedProject = laputaPlan.targetData.holdings[0].buildings.list.find((building) => building.id === "laputa-project");
  assert.equal(plannedBath.operatingUpkeepMonthlyCopper, 144, "explicit migration installs the approved Bathhouse operation cost");
  assert.equal(plannedBath.wageDailyCopper, 18, "explicit migration installs the approved Bathhouse wage");
  assert.equal(plannedBath.constructionStatus, "built", "a completed building remains completed without repaying materials");
  assert.equal(plannedProject.wageDailyCopper, 18, "an explicit migration converts a started project's mechanics without granting an upgrade");
  assert.deepEqual(plannedProject.requiredAnyBuildingIds, ["arsenal", "powder-magazine"]);
  assert.equal(plannedProject.materialsAllocated, false, "migration must not invent prepayment for an unfinished project");
  assert.deepEqual(plannedProject.constructionMaterials?.prepaidRemaining ?? [], [], "only recorded material credit may survive");

  const currentVersionLaputa = migrateData({
    meta: { templateCatalogVersion: TEMPLATE_CATALOG_VERSION },
    catalog: { buildings: structuredClone(BUILDING_TEMPLATES_BEFORE_LABOR_TRANSITION) },
    holdings: [{
      id: "laputa",
      name: "Лапута",
      type: "settlement",
      buildings: { list: [{
        id: "laputa-current-mine",
        templateId: "mine",
        name: "Настроенная шахта",
        constructionStatus: "built",
        status: "Построено",
        workersMin: 1,
        workersMax: 4,
        assignedWorkerIds: ["", "", "", ""]
      }] }
    }]
  });
  const currentVersionMine = currentVersionLaputa.holdings[0].buildings.list[0];
  assert.deepEqual(
    [currentVersionMine.workersMin, currentVersionMine.workersMax],
    [1, 4],
    "loading a current-version world must preserve a saved instance's staffing until explicit migration"
  );
  assert.equal(currentVersionMine.workerProfile?.templateId, "mine", "the staffing migration must attach the approved qualification profile to an existing building");

  return { waves, totals };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = checkBuildingDevelopmentTreeCharacterization();
  console.log(`FBL Skyhold development tree: ${result.waves.map((wave) => wave.ids.length).join(" -> ")}; final F${result.totals.food}/T${result.totals.technology}/C${result.totals.culture}/W${result.totals.war}.`);
}
