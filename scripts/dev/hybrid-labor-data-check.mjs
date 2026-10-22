import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyStaffAppointment, buildingLaborMode, buildingLaborCapacityQd, normalizeBuildingLabor, normalizeStaffAppointment,
  staffAppointmentWorkFunctions, validateHybridLaborHolding, productionPreparationGoal } from "../data/hybrid-labor.js";
import { buildWorkAllocationTargets, validateHoldingWorkAllocations } from "../data/work-allocations.js";
import { workforceChangeError } from "../data/workforce-plan.js";
import { normalizePerson } from "../data/normalizers/resident.js";
import { normalizeBuilding } from "../data/normalizers/building.js";
import { clearPersonFromAssignments } from "../data/resident-assignments.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { buildPlayerPatch, validatePlayerPatch } from "../data/player-write-guard.js";
import { planHybridLaborMigration, applyHybridLaborMigration, planHybridLaborCatalogMigration } from "../workflows/buildings/hybrid-labor-migration.js";
import { executeHybridLaborMigration } from "../apps/hybrid-labor-migration-executor.js";
import { planBuildingCatalogMigration } from "../workflows/buildings/catalog-migration.js";
import { BUILDING_TEMPLATES_BEFORE_LABOR_TRANSITION, TEMPLATE_CATALOG_VERSION } from "../data/building-templates.js";
import { stableDataHash } from "../data/storage-commit.js";
import { AssignmentDomain } from "../apps/domains/assignment-domain.js";

const clone = (value) => structuredClone(value);
const person = (id) => ({ id, name: id, age: 30, ageGroup: "Вз", workAssignment: "", workAllocationMode: "legacy",
  workAllocations: [], volunteerLabor: false, wageDailyOverrideCopper: null, attributes: { strength: 3, agility: 3, wits: 3, empathy: 3 } });
const building = (id, mode) => ({ id, name: id, lifecycle: "built", condition: "normal",
  labor: { version: 1, mode, capacityQd: null }, workersMax: 1, workersMin: 0, wageDailyCopper: 12,
  assignedWorkerIds: [], functions: { production: true },
  productionLines: [{ id: "logs", active: true, source: "workers", workQd: 2, resourceId: "wood", formula: "2", overtime: true }] });
const fixture = () => ({ id: "h", name: "h", buildings: { list: [building("staff", "staff"), building("qd", "qd"), building("well", "passive")] },
  people: { list: [person("a"), person("b")] }, workforcePlan: { version: 1, goals: [], locks: [] } });
const appointment = () => ({ version: 1, buildingId: "staff", primaryFunctionId: "production:logs", reserveFunctionId: "",
  wageDailyCopper: 12, overtimeQd: 0, volunteer: false, volunteerReason: "" });
const allocation = (id, qd, sourceId = "qd") => ({ id, sourceId, functionId: "production:logs", normalQd: qd, overtimeQd: 0 });
const check = (holding) => validateHybridLaborHolding(holding, { targets: buildWorkAllocationTargets(holding) });

export async function checkHybridLaborData() {
assert.equal(buildingLaborMode({}), "legacy");
assert.equal(normalizeBuildingLabor(undefined), null);
assert.equal(normalizeStaffAppointment(undefined), null);
assert.equal(buildingLaborMode({ labor: { version: 2, mode: "staff" } }), "invalid");
assert.deepEqual(normalizeBuildingLabor({ version: 2, mode: "future", preserved: 8 }), { version: 2, mode: "future", preserved: 8, capacityQd: null });
const blankLegacy = { id: "old", name: "old", workersMax: 3, workersMin: 1 };
normalizeBuilding(blankLegacy, { mode: "load", preserveTemplateMechanics: true });
assert.equal(Object.hasOwn(blankLegacy, "labor"), false, "normal loading never opts a legacy building into new behavior");
const oldPerson = person("old"); normalizePerson(oldPerson);
assert.equal(Object.hasOwn(oldPerson, "staffAppointment"), false);

const h = fixture();
applyStaffAppointment(h, "a", appointment());
assert.equal(h.people.list[0].workAssignment, "staff");
assert.deepEqual(h.buildings.list[0].assignedWorkerIds, ["a"]);
assert.deepEqual(staffAppointmentWorkFunctions(h.people.list[0]), ["production:logs"]);
assert.equal(check(h).ok, true);
assert.throws(() => applyStaffAppointment(h, "b", appointment()), /места/);
const altered = clone(h);
altered.people.list[0].workAllocationMode = "explicit";
altered.people.list[0].workAllocations = [allocation("external", 1)];
assert.ok(check(altered).issues.some((issue) => issue.code === "staff-incompatible"), "even one outside QD conflicts with full-period appointment");
const restored = clone(h);
normalizePerson(restored.people.list[0]);
assert.deepEqual(restored.people.list[0].staffAppointment, appointment(), "save/load normalization retains the complete appointment");
applyStaffAppointment(restored, "a", null);
assert.equal(restored.people.list[0].staffAppointment, undefined);
assert.equal(restored.people.list[0].workAssignment, "");
assert.deepEqual(restored.buildings.list[0].assignedWorkerIds, [""]);
clearPersonFromAssignments(h, "a");
assert.equal(h.people.list[0].staffAppointment, undefined, "job changes cannot leave a hidden old contract");

const qd = fixture();
for (const resident of qd.people.list) {
  resident.workAllocationMode = "explicit";
  resident.workAllocations = [allocation(resident.id, 10)];
}
qd.buildings.list[1].labor.capacityQd = 20;
assert.equal(validateHoldingWorkAllocations(qd).ok, true, "two names are allowed with one historical workplace if their QD fit");
qd.people.list[1].workAllocations[0].normalQd = 11;
assert.ok(check(qd).issues.some((issue) => issue.code === "labor-qd-capacity"));
qd.buildings.list[1].labor.capacityQd = 0;
assert.equal(buildingLaborCapacityQd(qd.buildings.list[1]), 0);
assert.ok(check(qd).issues.some((issue) => issue.code === "labor-qd-capacity"), "zero is a closed capacity, not unlimited");
qd.buildings.list[1].labor.capacityQd = null;
assert.equal(check(qd).ok, true);
qd.people.list[0].workAllocations[0].sourceId = "well";
assert.ok(check(qd).issues.some((issue) => issue.code === "labor-qd-mode"));
qd.people.list[0].workAllocations[0].functionId = "maintenance";
assert.equal(check(qd).ok, true, "separate technical maintenance is allowed for a passive object");
const maintenanceCap = fixture();
maintenanceCap.buildings.list[1].labor.capacityQd = 10;
maintenanceCap.people.list[0].workAllocationMode = "explicit";
maintenanceCap.people.list[0].workAllocations = [allocation("production", 10), { ...allocation("maintenance", 8), functionId: "maintenance" }];
assert.equal(check(maintenanceCap).ok, true, "external maintenance does not consume the building production QD cap");
assert.equal(check(maintenanceCap).qdTotals.get("qd"), 10);
maintenanceCap.buildings.list[1].labor.capacityQd = 0;
maintenanceCap.people.list[0].workAllocations.shift();
assert.equal(check(maintenanceCap).ok, true, "a production cap of zero still allows technical maintenance");

for (const isGM of [true, false]) {
  const before = fixture(), after = clone(before);
  applyStaffAppointment(after, "a", appointment());
  assert.equal(workforceChangeError(before, after, { isGM }), "", "both GM and permitted player can accept the configured contract");
  after.people.list[0].staffAppointment.wageDailyCopper = 1;
  assert.equal(Boolean(workforceChangeError(before, after, { isGM })), !isGM, "players cannot write their own wage");
}
const hidden = fixture(), hiddenAfter = clone(hidden);
hidden.buildings.list[0].visibility = "gm";
hiddenAfter.buildings.list[0].visibility = "gm";
applyStaffAppointment(hiddenAfter, "a", appointment());
assert.match(workforceChangeError(hidden, hiddenAfter, { isGM: false }), /скрытое/);
const volunteerBefore = fixture(), volunteerAfter = clone(volunteerBefore);
applyStaffAppointment(volunteerAfter, "a", { ...appointment(), wageDailyCopper: 0, volunteer: true, volunteerReason: "test" });
assert.ok(workforceChangeError(volunteerBefore, volunteerAfter, { isGM: false }));
assert.equal(workforceChangeError(volunteerBefore, volunteerAfter, { isGM: true }), "");

const goals = fixture();
goals.buildings.list[0].productionLines[0].formula = "";
goals.buildings.list[0].productionLines[0].outputQty = 2;
goals.workforcePlan = { version: 2, goals: [], locks: [], productionGoals: [{ sourceId: "staff", functionId: "production:logs", preparedUnits: 20 }] };
assert.equal(check(goals).ok, true);
assert.equal(productionPreparationGoal(goals, "staff", "production:logs"), 20);
for (const [source, outputQty, formula] of [["time", 2, ""], ["content", 2, ""], ["workers", 0, ""], ["workers", 1.5, ""], ["workers", 2, "1d6"]]) {
  const invalidGoal = clone(goals);
  Object.assign(invalidGoal.buildings.list[0].productionLines[0], { source, outputQty, formula, requiresCollection: true, collectQd: 1 });
  assert.equal(check(invalidGoal).ok, false, `${source}/${outputQty}/${formula}: unsupported output cannot accept a preparation goal`);
}
const literalGoal = clone(goals);
literalGoal.buildings.list[0].productionLines[0].formula = "2";
assert.equal(check(literalGoal).ok, true, "a positive integer formula is deterministic output");
const hugeGoal = clone(goals);
hugeGoal.workforcePlan.productionGoals[0].preparedUnits = 1000001;
assert.equal(check(hugeGoal).ok, false, "server validation enforces the same upper bound as the input");
assert.equal(productionPreparationGoal(hugeGoal, "staff", "production:logs"), null);
goals.workforcePlan.productionGoals.push(clone(goals.workforcePlan.productionGoals[0]));
assert.ok(check(goals).issues.some((issue) => issue.code === "production-goal-duplicate"));
const timed = fixture();
timed.buildings.list[0].productionLines[0] = { id: "time", active: true, source: "time", requiresCollection: true, collectQd: 1 };
assert.ok(buildWorkAllocationTargets(timed).some((row) => row.key === "staff::production:time"), "time-only production can still require assigned collection labor");
const beforeData = { meta: { revision: 1 }, holdings: [mergeHoldingDefaults({ ...fixture(), gm: { playersCanEditBuildings: true } })] };
const afterData = clone(beforeData);
applyStaffAppointment(afterData.holdings[0], "a", appointment());
const staffPatch = validatePlayerPatch(beforeData, buildPlayerPatch(beforeData, afterData));
assert.equal(staffPatch.ok, true, staffPatch.error);
const forgedRate = clone(afterData);
forgedRate.holdings[0].people.list[0].staffAppointment.wageDailyCopper = 1;
assert.equal(validatePlayerPatch(beforeData, buildPlayerPatch(beforeData, forgedRate)).ok, false);
const forgedExternal = clone(afterData);
forgedExternal.holdings[0].people.list[0].workAllocationMode = "explicit";
forgedExternal.holdings[0].people.list[0].workAllocations = [allocation("forged", 1)];
assert.equal(validatePlayerPatch(beforeData, buildPlayerPatch(beforeData, forgedExternal)).ok, false);
const forbiddenMode = clone(beforeData);
forbiddenMode.holdings[0].buildings.list[0].labor.mode = "qd";
assert.equal(validatePlayerPatch(beforeData, buildPlayerPatch(beforeData, forbiddenMode)).ok, false, "player cannot change a building's employment model");
const paused = clone(afterData);
paused.holdings[0].buildings.list[0].productionLines[0].active = false;
let pausedTarget = buildWorkAllocationTargets(paused.holdings[0]).find((row) => row.sourceId === "staff");
assert.equal(pausedTarget.paused, true);
assert.equal(pausedTarget.available, false);
assert.equal(check(paused.holdings[0]).ok, true, "pausing a line preserves its existing employment contract");
assert.equal(validatePlayerPatch(afterData, buildPlayerPatch(afterData, paused)).ok, true, "permitted player pause has the same structural contract behavior as the GM editor");
Object.assign(paused.holdings[0].buildings.list[0].productionLines[0], { pendingQty: 2, requiresCollection: true, collectQd: 1 });
pausedTarget = buildWorkAllocationTargets(paused.holdings[0]).find((row) => row.sourceId === "staff");
assert.equal(pausedTarget.available, true, "paused production still offers collection of paid finished output");
assert.equal(pausedTarget.collectionAvailable, true);
paused.holdings[0].buildings.list[0].repair = { active: true };
pausedTarget = buildWorkAllocationTargets(paused.holdings[0]).find((row) => row.sourceId === "staff");
assert.equal(pausedTarget.available, false);
assert.match(pausedTarget.blockedReason, /Ремонт/);
assert.equal(check(paused.holdings[0]).ok, true, "temporary damage/repair must not invalidate or erase employment");
const blockedHireBefore = fixture(), blockedHireAfter = clone(blockedHireBefore);
blockedHireBefore.buildings.list[0].productionLines[0].active = false;
blockedHireAfter.buildings.list[0].productionLines[0].active = false;
applyStaffAppointment(blockedHireAfter, "a", appointment());
assert.match(workforceChangeError(blockedHireBefore, blockedHireAfter, { isGM: true }), /недоступна/);
const deletedLine = clone(afterData.holdings[0]);
deletedLine.buildings.list[0].productionLines = [];
assert.equal(check(deletedLine).ok, false, "deleting a contracted function still requires an explicit resolution");
const legacySelector = { ...AssignmentDomain, _safeNumber: (value, fallback = 0) => Number(value) || fallback };
const selectorHolding = fixture();
selectorHolding.people.list[0].workAllocationMode = "explicit";
selectorHolding.people.list[0].workAllocations = [allocation("prior-qd", 4)];
selectorHolding.buildings.list[0].productionLines[0].active = false;
const selectorSnapshot = clone(selectorHolding);
assert.equal(legacySelector._assignPersonToBuilding(selectorHolding, "a", "staff"), false, "old resident/building selectors also reject a new paused job");
assert.deepEqual(selectorHolding, selectorSnapshot, "a rejected selection must not clear the previous work plan");
selectorHolding.buildings.list[0].productionLines[0].active = true;
selectorHolding.buildings.list[0].wageDailyCopper = 0;
assert.equal(legacySelector._assignPersonToBuilding(selectorHolding, "a", "staff"), false, "old selectors cannot silently create an unpaid staff agreement");
assert.equal(selectorHolding.people.list[0].workAllocations.length, 1);
selectorHolding.buildings.list[0].wageDailyCopper = 12;
assert.equal(legacySelector._assignPersonToBuilding(selectorHolding, "a", "staff"), true);
assert.deepEqual(selectorHolding.people.list[0].staffAppointment, appointment());
for (const isGM of [true, false]) {
  const injuredBefore = clone(afterData.holdings[0]);
  injuredBefore.people.list[0].injuredDays = 3;
  const released = clone(injuredBefore);
  applyStaffAppointment(released, "a", null);
  released.people.list[0].workAllocationMode = "explicit";
  assert.equal(workforceChangeError(injuredBefore, released, { isGM }), "", "an injured resident can be explicitly released from staff");
  const transferred = clone(released);
  transferred.people.list[0].workAllocations = [allocation("new-job", 2)];
  assert.match(workforceChangeError(injuredBefore, transferred, { isGM }), /Ранен/, "release must not authorize a new job while injured");
  const qdBefore = fixture();
  qdBefore.people.list[0].injuredDays = 2;
  qdBefore.people.list[0].workAllocationMode = "explicit";
  qdBefore.people.list[0].workAllocations = [allocation("old-job", 10)];
  const reduced = clone(qdBefore); reduced.people.list[0].workAllocations[0].normalQd = 4;
  assert.equal(workforceChangeError(qdBefore, reduced, { isGM }), "", "unavailable residents can reduce a saved QD plan");
  const increased = clone(qdBefore); increased.people.list[0].workAllocations[0].normalQd = 12;
  assert.match(workforceChangeError(qdBefore, increased, { isGM }), /Ранен/);
  reduced.people.list[0].workAllocations = [];
  assert.equal(workforceChangeError(qdBefore, reduced, { isGM }), "", "unavailable residents can clear all saved QD assignments");
}
}

export async function checkHybridLaborMigration() {
const old = fixture();
delete old.buildings.list[0].labor;
old.people.list[0].workAssignment = "staff";
old.buildings.list[0].assignedWorkerIds = ["a"];
old.buildings.list[0].productionLines[0].waitingBatches = [{ sentinel: "paid batch remains untouched" }];
const oldSnapshot = clone(old);
const ambiguous = planHybridLaborMigration({ holding: old, profiles: { staff: { version: 1, mode: "staff", capacityQd: null } } });
assert.equal(ambiguous.ok, false);
assert.ok(ambiguous.issues.some((issue) => issue.code === "labor-assignment-choice"));
assert.deepEqual(old, oldSnapshot, "preview is read-only");
const approved = planHybridLaborMigration({ holding: old, profiles: { staff: { version: 1, mode: "staff", capacityQd: null } }, staffAppointments: { a: appointment() } });
assert.equal(approved.ok, true, approved.issues.map((issue) => issue.message).join("; "));
const migrated = applyHybridLaborMigration({ holding: old, plan: approved });
assert.deepEqual(migrated.buildings.list[0].productionLines, old.buildings.list[0].productionLines, "transition does not rewrite recipes or paid work");
assert.throws(() => applyHybridLaborMigration({ holding: { ...old, name: "changed" }, plan: approved }), /изменилось/);
const corrupted = clone(approved); corrupted.targetHolding.name = "tampered";
assert.throws(() => applyHybridLaborMigration({ holding: old, plan: corrupted }), /изменён/);
const restricted = fixture();
restricted.buildings.list[0].workerProfile = { admission: { hard: true, clauses: [[{ attribute: "strength", minimum: 5 }]] } };
const rejectedAdmission = planHybridLaborMigration({ holding: restricted, staffAppointments: { a: appointment() } });
assert.equal(rejectedAdmission.ok, false, "the migration uses the same mandatory qualification as the planner");
assert.ok(rejectedAdmission.issues.some((issue) => issue.code === "labor-staff-admission"));
const forgedAdmission = clone(rejectedAdmission); forgedAdmission.ok = true; forgedAdmission.issues = [];
assert.throws(() => applyHybridLaborMigration({ holding: restricted, plan: forgedAdmission }), /обязательный допуск/);
restricted.buildings.list[0].workerAdmissionOverrideIds = ["a"];
assert.equal(planHybridLaborMigration({ holding: restricted, staffAppointments: { a: appointment() } }).ok, true,
  "a previously explicit GM qualification override remains valid in the migration");
for (const kind of ["goals", "locks"]) {
  const withReferences = fixture();
  withReferences.buildings.list[1].productionLines.push({ ...clone(withReferences.buildings.list[1].productionLines[0]), id: "other" });
  const reference = { sourceId: "qd", functionId: "production:logs", ...(kind === "goals" ? { normalQd: 10 } : { personId: "a" }) };
  withReferences.workforcePlan[kind] = [reference, { ...reference, functionId: "production:other" }];
  const collision = planHybridLaborMigration({ holding: withReferences, lineMappings: { "qd::production:other": "production:logs" } });
  assert.equal(collision.ok, false, `mapping cannot merge two ${kind} implicitly`);
  assert.ok(collision.issues.some((issue) => issue.code === "labor-plan-reference-collision"));
  const forged = clone(collision); forged.ok = true; forged.issues = [];
  forged.targetHash = stableDataHash(forged.targetHolding);
  assert.throws(() => applyHybridLaborMigration({ holding: withReferences, plan: forged }), /несколько целей/, "Apply revalidates mapped reference uniqueness");
  assert.equal(withReferences.workforcePlan[kind][1].functionId, "production:other", "preview never rewrites source references");
}
const catalog = { buildings: [{ ...clone(old.buildings.list[0]), id: "lumbermill", templateId: "lumbermill", assignedWorkerIds: [] }] };
const catalogPlan = planHybridLaborCatalogMigration({ catalog });
assert.equal(catalogPlan.ok, true);
assert.deepEqual(catalogPlan.targetCatalog.buildings[0].productionLines, catalog.buildings[0].productionLines);
assert.equal(catalog.buildings[0].labor, undefined);
let stored = { meta: { revision: 1 }, holdings: [clone(old)], catalog: clone(catalog) }, writes = 0;
const store = {
  skipTransaction: (value) => ({ skipped: value }),
  async transaction(fn) {
    const candidate = clone(stored), result = await fn(candidate);
    if (result?.skipped) return result.skipped;
    stored = candidate; stored.meta.revision++; writes++;
    return result;
  }
};
const request = { holdingId: old.id, holdingPlan: approved, catalogPlan, expectedRevision: 1, operationId: "labor-transition-test" };
assert.equal((await executeHybridLaborMigration(request, { store, getUser: () => ({ isGM: false }) })).ok, false);
assert.equal(writes, 0);
assert.equal((await executeHybridLaborMigration(request, { store, getUser: () => ({ isGM: true }) })).ok, true);
assert.equal(writes, 1);
assert.equal((await executeHybridLaborMigration(request, { store, getUser: () => ({ isGM: true }) })).replay, true);
assert.equal(writes, 1, "replay never repeats migration or payment");
await assert.rejects(() => executeHybridLaborMigration({ ...request, operationId: "stale" }, { store, getUser: () => ({ isGM: true }) }), /изменились/);
assert.equal(writes, 1, "a stale preview never writes a partial holding/catalog result");
const unchanged = planHybridLaborMigration({ holding: stored.holdings[0] });
const noop = await executeHybridLaborMigration({ holdingId: old.id, holdingPlan: unchanged, expectedRevision: stored.meta.revision,
  operationId: "labor-transition-noop" }, { store, getUser: () => ({ isGM: true }) });
assert.equal(noop.unchanged, true);
assert.equal(writes, 1, "an already transitioned preview does not create redundant writes or operation records");
const priorTemplate = clone(BUILDING_TEMPLATES_BEFORE_LABOR_TRANSITION.find((row) => row.id === "lumbermill"));
priorTemplate.workersMax = 99;
priorTemplate.workerProfile.workersMax = 99;
const catalogSource = { meta: { revision: 1, templateCatalogVersion: TEMPLATE_CATALOG_VERSION },
  catalog: { buildings: [priorTemplate] }, holdings: [{ id: "legacy-catalog", buildings: { list: [
    { ...clone(priorTemplate), id: "old-mill", templateId: "lumbermill" }
  ] }, people: { list: [] } }] };
const normalCatalog = planBuildingCatalogMigration({ currentData: catalogSource, operationId: "normal-catalog" });
assert.equal(normalCatalog.targetData.catalog.buildings.find((row) => row.id === "lumbermill").workersMax, 99, "current customized catalog rules survive a normal catalog preview");
for (const replaceCatalog of [false, true]) {
  const catalogPreview = planBuildingCatalogMigration({ currentData: catalogSource, operationId: `old-catalog-${replaceCatalog}`, replaceCatalog });
  assert.equal(catalogPreview.targetData.catalog.buildings.find((row) => row.id === "lumbermill").labor, undefined,
    "recipe/catalog migration cannot opt an existing template into the new employment model");
  assert.equal(catalogPreview.targetData.holdings[0].buildings.list[0].labor, undefined,
    "recipe/catalog migration cannot opt a legacy instance into the new employment model");
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkHybridLaborData();
  await checkHybridLaborMigration();
  console.log("Hybrid labor data/migration: legacy preservation, contracts, capacity, goals, GM/player security, preview, exact apply and replay passed.");
}
