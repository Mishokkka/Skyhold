import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { BuildingWorkerDomain } from "../apps/domains/building/worker-domain.js";
import { AssignmentDomain } from "../apps/domains/assignment-domain.js";
import { DEFAULT_BUILDING_TEMPLATES } from "../data/building-templates.js";
import { APPROVED_BUILDING_WORKER_PROFILES } from "../data/building-worker-profile-data.js";
import { normalizeBuilding } from "../data/normalizers/building.js";
import { buildingServiceEffectFactor, buildingWonderworkingActive } from "../engines/economy/building-service.js";
import {
  buildingCompositionStatus,
  holdingWorkerAdmissionIssues,
  workerAdmission,
  workerBackgroundMatches,
  workerMatchesSelector,
  workerProductionQualification,
  WORK_UNITS_PER_QD
} from "../engines/workers/building-qualification.js";
import {
  constructionLeaderCoordinationBonus,
  constructionLeaderQualification,
  CONSTRUCTION_LEADER_WAGE_DAILY_COPPER,
  CONSTRUCTION_MIN_WORKERS,
  CONSTRUCTION_WORKER_WAGE_DAILY_COPPER
} from "../engines/workers/construction-leadership.js";
import { generateResidents } from "../generators/resident-generator.js";
import { workerTypeFromAttributes } from "../generators/resident-rules.js";
import {
  BUILDING_LIVESTOCK_PROFILES,
  BUILDING_PRODUCTION_ECONOMY,
  BUILDING_SEASONAL_PROFILES
} from "./building-production-line-proposal-data.mjs";

const residentGeneratorSource = readFileSync(new URL("../generators/resident-generator.js", import.meta.url), "utf8");
const ATTRIBUTES = new Set(["СИЛ", "ЛОВ", "РАЗ", "ЭМП"]);
const STAFFING_CLASSES = new Set(["A", "B", "C"]);
const COMPOSITION_GROUPS = new Set(["СТРОИТЕЛЬСТВО", "ТОРГОВЛЯ", "ГРАМОТА", "МЕДИЦИНА", "КУЛЬТ", "ОХРАНА", "МОРЕ", "ТЕХНИКА", "ЧУДОТВОРЕЦ"]);
const PRODUCTION_BUILDINGS = new Set([
  ...Object.keys(BUILDING_PRODUCTION_ECONOMY),
  ...BUILDING_SEASONAL_PROFILES.map((profile) => profile.building),
  ...BUILDING_LIVESTOCK_PROFILES
    .filter((profile) => Object.keys(profile.slaughterOutputs ?? {}).length > 0)
    .map((profile) => profile.building)
]);
assert.equal(PRODUCTION_BUILDINGS.size, 41, "the qualification contract must follow the 41 economically audited producing buildings");

const runtimeScriptorium = DEFAULT_BUILDING_TEMPLATES.find((building) => String(building?.id ?? "") === "scriptorium");
assert.ok(runtimeScriptorium, "the Wonderworker Scriptorium must remain in the runtime building catalog");
assert.match(String(runtimeScriptorium.description ?? ""), /Скрипторий чудотворцев/i);
assert.match(String(runtimeScriptorium.effect ?? ""), /изучению чудотворства и чудес/i);
assert.match(String(runtimeScriptorium.workerRole ?? ""), /Чудотворец/i);

function validateSelectors(selectors, name, label) {
  assert.ok(Array.isArray(selectors) && selectors.length > 0, `${name}: ${label} must contain at least one selector`);
  assert.equal(new Set(selectors).size, selectors.length, `${name}: ${label} must not repeat selectors`);
  for (const selector of selectors) {
    if (selector === "РР*" || ATTRIBUTES.has(selector)) continue;
    const pair = selector.split("&");
    assert.equal(pair.length, 2, `${name}: unknown ${label} selector ${selector}`);
    assert.ok(pair.every((attribute) => ATTRIBUTES.has(attribute)), `${name}: unknown ${label} selector ${selector}`);
    assert.notEqual(pair[0], pair[1], `${name}: pair selector ${selector} must use two different attributes`);
  }
}

assert.equal(APPROVED_BUILDING_WORKER_PROFILES.length, 120, "the checked-in runtime manifest must contain 118 base profiles and two story profiles");
assert.equal(new Set(APPROVED_BUILDING_WORKER_PROFILES.map((profile) => profile.templateId)).size, 120);

const STORY_TEMPLATE_IDS = new Set(["fasti-shop", "laputa-excavated-crypt"]);
const usedStaffingClasses = new Set();
const mappedProductionBuildings = new Set();
let staffedCount = 0;
let unstaffedCount = 0;
let storyCount = 0;

for (const profile of APPROVED_BUILDING_WORKER_PROFILES) {
  const { templateId, name, workersMax, suitableSelectors, optimalSelectors, staffingClass, composition, production, reason } = profile;
  assert.ok(reason, `${name}: affinity rationale must not be empty`);
  if (STORY_TEMPLATE_IDS.has(templateId)) {
    storyCount += 1;
    assert.equal(workersMax, 0, `${name}: story-only template must keep an explicit zero-staff profile`);
    continue;
  }
  if (workersMax <= 0) {
    unstaffedCount += 1;
    assert.deepEqual(suitableSelectors, [], `${name}: unstaffed building must not advertise worker qualification rules`);
    assert.deepEqual(optimalSelectors, [], `${name}: unstaffed building must not advertise worker qualification rules`);
    continue;
  }
  staffedCount += 1;
  if (PRODUCTION_BUILDINGS.has(name)) {
    validateSelectors(suitableSelectors, name, "+25%");
    validateSelectors(optimalSelectors, name, "+50%");
    assert.ok(production?.backgroundGroups?.length > 0, `${name}: production profile must declare background groups`);
    assert.ok(production?.positiveTraits?.length > 0, `${name}: production profile must declare positive traits`);
    assert.ok(production?.negativeTraits?.length > 0, `${name}: production profile must declare negative traits`);
    mappedProductionBuildings.add(name);
  } else {
    assert.deepEqual(suitableSelectors, [], `${name}: non-production building must not multiply static effects through worker type`);
    assert.deepEqual(optimalSelectors, [], `${name}: non-production building must not multiply static effects through worker type`);
  }
  assert.ok(STAFFING_CLASSES.has(staffingClass), `${name}: unknown staffing class ${staffingClass}`);
  usedStaffingClasses.add(staffingClass);
  let requiredHeads = 0;
  for (const part of composition ?? []) {
    assert.ok(COMPOSITION_GROUPS.has(part.group), `${name}: unknown composition group ${part.group}`);
    requiredHeads += Number(part.count ?? 0);
  }
  assert.ok(requiredHeads <= workersMax, `${name}: composition requirements must fit into maximum staff`);
}

assert.deepEqual({ staffedCount, unstaffedCount, storyCount }, { staffedCount: 95, unstaffedCount: 23, storyCount: 2 });
assert.deepEqual(usedStaffingClasses, STAFFING_CLASSES, "the mapping must exercise all three staffing classes");
assert.deepEqual(mappedProductionBuildings, PRODUCTION_BUILDINGS, "worker-type bonuses must cover exactly the audited production buildings");
assert.doesNotMatch(residentGeneratorSource, /\bskill\s*:/, "the resident generator must not recreate the removed profession field");
const scriptoriumProfile = APPROVED_BUILDING_WORKER_PROFILES.find((profile) => profile.templateId === "scriptorium");
assert.ok(
  scriptoriumProfile?.composition?.some((part) => part.group === "ЧУДОТВОРЕЦ" && part.count === 1),
  "the Scriptorium's mystical function must require the rare Wonderworker trait"
);

const originalRandom = Math.random;
const generatedTypeAudit = new Map();
let randomSeed = 17_331;
try {
  Math.random = () => {
    randomSeed = (Math.imul(randomSeed, 1_664_525) + 1_013_904_223) >>> 0;
    return randomSeed / 4_294_967_296;
  };
  for (const arrival of ["settlers", "workers", "specialists", "crew", "refugees"]) {
    const counts = { total: 0, none: 0, single: 0, pairPlus: 0, balanced: 0 };
    for (let batch = 0; batch < 500; batch += 1) {
      for (const person of generateResidents({ quantity: 20, arrival, ageMode: "adults" })) {
        const values = Object.values(person.attributes ?? {}).map(Number);
        const outstanding = values.filter((value) => value >= 5).length;
        assert.equal(Object.hasOwn(person, "skill"), false, `${arrival}: generated residents must stay profession-free`);
        counts.total += 1;
        if (!outstanding) counts.none += 1;
        else if (outstanding === 1) counts.single += 1;
        else counts.pairPlus += 1;
        if (!outstanding && values.every((value) => value >= 3) && values.reduce((sum, value) => sum + value, 0) >= 13) counts.balanced += 1;
      }
    }
    generatedTypeAudit.set(arrival, Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, key === "total" ? value : value / counts.total])));
  }
} finally {
  Math.random = originalRandom;
}
for (const [arrival, rates] of generatedTypeAudit) {
  assert.ok(rates.single > 0.5, `${arrival}: single-attribute specialists must remain a recruitable majority`);
  assert.ok(rates.pairPlus > 0.02 && rates.pairPlus < 0.2, `${arrival}: optimal pair types must remain possible but uncommon`);
  assert.ok(rates.balanced > 0.05, `${arrival}: balanced generalists must remain recruitable`);
}

const owner = {
  ...AssignmentDomain,
  ...BuildingWorkerDomain,
  _safeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  },
  _workerType(person) {
    return workerTypeFromAttributes(person?.attributes ?? {});
  },
  _maintenanceEfficiencyFactor() {
    return 1;
  }
};

const runtimeProfileCount = DEFAULT_BUILDING_TEMPLATES.filter((building) => building.workerProfile).length;
assert.equal(runtimeProfileCount, DEFAULT_BUILDING_TEMPLATES.length, "every current runtime template, including additions after v14, must receive a worker profile");
for (const building of DEFAULT_BUILDING_TEMPLATES) {
  assert.equal(Object.hasOwn(building, "workerPrimaryAttribute"), false, `${building.name}: the hidden primary attribute must be removed`);
  assert.equal(Object.hasOwn(building, "suitableWorkerTypes"), false, `${building.name}: legacy free-form worker types must be removed`);
  assert.equal(Object.hasOwn(building, "workerTypeEffects"), false, `${building.name}: legacy float type effects must be removed`);
}

const strong = { id: "strong", name: "Сильный", attributes: { strength: 5, agility: 3, wits: 3, empathy: 3 } };
const agile = { id: "agile", name: "Ловкий", attributes: { strength: 2, agility: 5, wits: 3, empathy: 3 } };
const mechanic = { id: "mechanic", name: "Механик", attributes: { strength: 5, agility: 3, wits: 5, empathy: 3 }, background: "шахтер", traitsText: "Крепкий" };
const mine = structuredClone(DEFAULT_BUILDING_TEMPLATES.find((building) => building.id === "mine"));
mine.assignedWorkerIds = [mechanic.id];
const qualification = workerProductionQualification(mine, mechanic);
assert.equal(qualification.workUnits, 17_000, "optimal type, one background and one positive trait must yield exactly 17,000 units");
const workerSummary = owner._buildingEffectiveWorkers({ people: { list: [mechanic] } }, mine);
assert.equal(workerSummary.total, 1, "qualification must not replace one required head with multiple effective workers");
assert.equal(workerSummary.productionWorkUnitsPerQd, 17_000, "the worker summary must expose integer production work separately");
assert.equal(workerAdmission(mine, agile).eligible, false, "a weak miner must fail the mine's physical admission");
assert.equal(workerAdmission(mine, agile).hard, true, "the mine admission must be enforced rather than advisory");
assert.equal(workerMatchesSelector({ attributes: { strength: 4, agility: 4, wits: 3, empathy: 3 } }, "РР*"), true, "a balanced generalist must satisfy RR*");
assert.equal(workerMatchesSelector({ attributes: { strength: 3, agility: 3, wits: 3, empathy: 3 } }, "РР*"), false, "RR* must reject a low-sum unspecialized resident");
assert.equal(workerBackgroundMatches({ background: "бывший корабельный плотник" }, ["ДЕРЕВО"]), true, "a descriptive background may contain a complete approved occupation");
assert.equal(workerBackgroundMatches({ background: "мастер" }, ["ТЕХНИКА"]), false, "a vague short background must not match a longer approved occupation by reverse substring");

const legacyBuilding = { id: "mine", templateId: "mine", name: "Шахта", workerPrimaryAttribute: "strength", suitableWorkerTypes: "Все с СИЛ", workerTypeEffects: { "Все с СИЛ": 0.5 }, workersMin: 1, workersMax: 2, assignedWorkerIds: [strong.id] };
normalizeBuilding(legacyBuilding);
assert.equal(Object.hasOwn(legacyBuilding, "workerPrimaryAttribute"), false, "normalization must delete legacy primary attributes from saved buildings");
assert.equal(legacyBuilding.workerAdmissionOverrideIds.includes(strong.id), true, "the migration must preserve an existing dangerous-work assignment as an explicit grandfathered override");
const eligibleMigration = { id: "mine", templateId: "mine", name: "Шахта", workersMin: 1, workersMax: 1, assignedWorkerIds: [strong.id] };
normalizeBuilding(eligibleMigration, { people: [strong] });
assert.equal(eligibleMigration.workerAdmissionOverrideIds.includes(strong.id), false, "an existing worker who passes the new hard gate must not receive a hidden override");
const invalidMigration = { id: "mine", templateId: "mine", name: "Шахта", workersMin: 1, workersMax: 1, assignedWorkerIds: [agile.id] };
normalizeBuilding(invalidMigration, { people: [agile] });
assert.equal(invalidMigration.workerAdmissionOverrideIds.includes(agile.id), true, "only a failing existing worker must receive the explicit grandfathered override");
const admissionHolding = {
  people: { list: [agile] },
  buildings: { list: [legacyBuilding] },
  constructionCrews: [],
  gm: { defense: { squads: [], commanderId: "" } }
};
assert.equal(owner._setBuildingSlot(admissionHolding, legacyBuilding.id, 0, agile.id), false, "a hard-admission worker cannot enter through a direct assignment call without an explicit override");
assert.equal(owner._setBuildingSlot(admissionHolding, legacyBuilding.id, 0, agile.id, { allowAdmissionOverride: true }), true, "an explicit GM override must allow the dangerous assignment");
assert.equal(legacyBuilding.workerAdmissionOverrideIds.includes(agile.id), true, "the explicit GM override must be persisted on the building");
assert.equal(owner._setBuildingSlot(admissionHolding, legacyBuilding.id, 0, agile.id), true, "reselecting a grandfathered worker must keep the existing override");
assert.equal(legacyBuilding.workerAdmissionOverrideIds.includes(agile.id), true, "reselection must not silently erase a persisted admission override");

const explicitAdmissionBuilding = structuredClone(mine);
explicitAdmissionBuilding.id = "explicit-hard-mine";
explicitAdmissionBuilding.workerAdmissionOverrideIds = [];
const explicitAgile = {
  ...agile,
  workAllocationMode: "explicit",
  workAllocations: [{ sourceId: explicitAdmissionBuilding.id, functionId: "production:ore", normalQd: 1, overtimeQd: 0 }]
};
const explicitAdmissionHolding = { people: { list: [explicitAgile] }, buildings: { list: [explicitAdmissionBuilding] } };
assert.equal(holdingWorkerAdmissionIssues(explicitAdmissionHolding).length, 1, "an explicit-QD plan must not bypass a hard building admission rule");
explicitAdmissionBuilding.workerAdmissionOverrideIds.push(explicitAgile.id);
assert.equal(holdingWorkerAdmissionIssues(explicitAdmissionHolding).length, 0, "an explicit GM admission override must cover an explicit-QD assignment too");
explicitAdmissionBuilding.workerAdmissionOverrideIds = [];
explicitAgile.workAllocations[0].normalQd = 0;
assert.equal(holdingWorkerAdmissionIssues(explicitAdmissionHolding).length, 0, "a selected target with no allocated QD must not require an admission override");

const medicalProfile = structuredClone(DEFAULT_BUILDING_TEMPLATES.find((building) => building.id === "lazaret"));
medicalProfile.lifecycle = "active";
medicalProfile.condition = "intact";
medicalProfile.constructionStatus = "built";
medicalProfile.assignedWorkerIds = [strong.id];
medicalProfile.workersMin = 1;
assert.equal(buildingServiceEffectFactor({ people: { list: [strong] } }, medicalProfile), 0, "a closed medical function must stop without a medical specialist");
const medic = { id: "medic", name: "Лекарь", attributes: { strength: 3, agility: 3, wits: 4, empathy: 4 }, background: "лекарь" };
medicalProfile.assignedWorkerIds = [medic.id];
assert.equal(buildingServiceEffectFactor({ people: { list: [medic] } }, medicalProfile), 1, "a matching medical specialist must activate the closed service");
assert.equal(buildingCompositionStatus(medicalProfile, [medic]).met, true);

const scriptorium = structuredClone(runtimeScriptorium);
scriptorium.lifecycle = "active";
scriptorium.condition = "intact";
scriptorium.constructionStatus = "built";
scriptorium.assignedWorkerIds = [medic.id];
const libraryDependency = { id: "library-instance", templateId: "library", constructionStatus: "built", lifecycle: "active", condition: "intact" };
const scriptoriumHolding = (people) => ({ people: { list: people }, buildings: { list: [libraryDependency, scriptorium] } });
assert.equal(buildingServiceEffectFactor(scriptoriumHolding([medic]), scriptorium), 1, "ordinary Scriptorium research must work without a Wonderworker");
assert.equal(buildingWonderworkingActive(scriptoriumHolding([medic]), scriptorium), false, "mystical Scriptorium effects must stay inactive without the rare trait");
const wonderworker = { ...medic, id: "wonder", traitsText: "Чудотворец" };
scriptorium.assignedWorkerIds = [wonderworker.id];
assert.equal(buildingWonderworkingActive(scriptoriumHolding([wonderworker]), scriptorium), true, "an assigned Wonderworker must activate the mystical effect");
const explicitlyAllocatedWonderworker = {
  ...wonderworker,
  id: "wonder-plan",
  workAllocationMode: "explicit",
  workAllocations: [{ sourceId: scriptorium.id, functionId: "culture", normalQd: 4, overtimeQd: 0 }]
};
scriptorium.assignedWorkerIds = [];
assert.equal(buildingWonderworkingActive(scriptoriumHolding([explicitlyAllocatedWonderworker]), scriptorium), true, "an explicit Scriptorium QD must count without an impossible duplicate legacy slot");
const allocatedElsewhere = {
  ...wonderworker,
  workAllocationMode: "explicit",
  workAllocations: [{ sourceId: "other", functionId: "culture", normalQd: 1, overtimeQd: 0 }]
};
scriptorium.assignedWorkerIds = [medic.id];
assert.equal(buildingWonderworkingActive(scriptoriumHolding([medic, allocatedElsewhere]), scriptorium), false, "a Wonderworker allocated elsewhere must not activate the Scriptorium's mystical effect");

const ordinaryLeader = { attributes: { strength: 3, agility: 3, wits: 4, empathy: 4 }, traitsText: "Лидер" };
assert.equal(constructionLeaderQualification(ordinaryLeader).eligible, true, "a capable manager must qualify for the separate construction-leader position");
assert.equal(constructionLeaderQualification({ attributes: { strength: 5, agility: 5, wits: 2, empathy: 2 } }).eligible, false, "physical worker talent alone must not qualify a construction leader");
assert.equal(constructionLeaderQualification({ attributes: { strength: 2, agility: 2, wits: 2, empathy: 2 }, traitsText: "Builder" }).eligible, true, "Builder must qualify as a professional construction leader regardless of ordinary attributes");
assert.equal(constructionLeaderCoordinationBonus(ordinaryLeader, CONSTRUCTION_MIN_WORKERS - 1), 0, "a leader must not add coordination before the minimum worker crew exists");
assert.equal(constructionLeaderCoordinationBonus(ordinaryLeader, CONSTRUCTION_MIN_WORKERS), 1, "the Leader trait must add exactly one coordination die to a complete worker crew");
assert.deepEqual([CONSTRUCTION_WORKER_WAGE_DAILY_COPPER, CONSTRUCTION_LEADER_WAGE_DAILY_COPPER], [12, 18], "construction workers and their separate leader must use the approved wage levels");

function workUnitsForQd(typeBonusBps = 0, conditionBps = 10_000, backgroundBonusBps = 0, traitBonusBps = 0) {
  return Math.floor((WORK_UNITS_PER_QD * (10_000 + typeBonusBps + backgroundBonusBps + traitBonusBps) * conditionBps) / 100_000_000);
}

function advanceLine(progress, work, recipeQd) {
  const total = progress + work;
  const target = recipeQd * WORK_UNITS_PER_QD;
  return { batches: Math.floor(total / target), progress: total % target };
}

function advanceFundedLine(progress, work, recipeQd, reservedBatches) {
  const target = recipeQd * WORK_UNITS_PER_QD;
  const availableFundedWork = Math.max(0, reservedBatches * target - progress);
  const applied = Math.min(work, availableFundedWork);
  return { ...advanceLine(progress, applied, recipeQd), idle: work - applied };
}

assert.equal(workUnitsForQd(0), 10_000, "ordinary QD must remain one whole unit of paid work");
assert.equal(workUnitsForQd(2_500), 12_500, "+25% qualification must use exact integer work units");
assert.equal(workUnitsForQd(5_000), 15_000, "+50% qualification must use exact integer work units");
assert.equal(workUnitsForQd(5_000, 10_000, 1_000, 1_000), 17_000, "optimal type, relevant background and one positive trait must cap ordinary qualification at 170 percent");
assert.equal(workUnitsForQd(2_500, 10_000, 1_000, -1_000), 12_500, "one positive background and one negative trait must compose additively without fractions");
assert.equal(workUnitsForQd(2_500, 9_500), 11_875, "percentage modifiers must compose without floating-point QD");
let line = { batches: 0, progress: 0 };
for (let qd = 0; qd < 3; qd += 1) line = advanceLine(line.progress, workUnitsForQd(2_500), 3);
assert.deepEqual(line, { batches: 1, progress: 7_500 }, "qualified work must release whole batches and preserve integer remainder");
assert.deepEqual(advanceLine(0, workUnitsForQd(5_000) * 2, 3), { batches: 1, progress: 0 }, "an optimal worker must complete a three-QD batch in two QD");
assert.deepEqual(advanceFundedLine(0, workUnitsForQd(5_000), 1, 1), { batches: 1, progress: 0, idle: 5_000 }, "unfunded excess work must not become free banked progress");
assert.deepEqual(advanceFundedLine(0, workUnitsForQd(5_000), 1, 2), { batches: 1, progress: 5_000, idle: 0 }, "excess work may continue only into another fully reserved batch");

console.log(`Building worker qualification passed: ${APPROVED_BUILDING_WORKER_PROFILES.length} profiles (${staffedCount + unstaffedCount} base + ${storyCount} story), ${runtimeProfileCount} current runtime templates, ${mappedProductionBuildings.size} production-only profiles.`);
