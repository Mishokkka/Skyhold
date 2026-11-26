import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalSignatureV1, sha256Hex } from "../data/sha256.js";
import { allocationNormalQd, allocationTotalQd, residentActiveQd } from "../data/labor-primitives.js";
import { syncResidentLaborRole } from "../data/labor-role.js";
import { DEFAULT_NORMAL_LABOR_QD, DEFAULT_NORMAL_LABOR_QD_V2, TENDAY_WORKING_DAYS_V2,
  holdingDaysOffPerTenday, holdingNormalLaborQd, daysOffConflictSummary, normalLaborQdPerTenday, residentLaborCapacity } from "../data/labor-budget.js";
import { buildingAcceptsWorkers, buildingAvailableCapacityQd, buildingCapacityQd, buildingMinOperationalQd,
  buildingWorkReservations, normalizeBuildingLabor, productionPreparationGoal, reservedOccupation } from "../data/labor-model.js";
import { buildWorkAllocationTargets, functionDailyRate, targetAllowsOvertime, remainingCollectionQd, validateHoldingWorkAllocations,
  allocationNormalQd as reexportNormal, allocationTotalQd as reexportTotal } from "../data/work-allocations.js";
import { clearResidentLaborAllocations } from "../data/resident-assignments.js";
import { mutateResidentBuildingLabor, applyResidentEditorAllocations, applyWorkforcePlanAllocations, clearResidentBuildingLabor,
  clearResidentAllBuildingLabor, trimExcessOvertimeForResidents, transferResidentBetweenHoldings } from "../data/labor-mutations.js";
import { militaryDailyWage } from "../engines/economy/military-wages.js";
import { MODULE_ID, SETTING_NORMAL_LABOR_QD } from "../data/constants.js";
import { SKYHOLD_SCHEMA_VERSION } from "../data/schema-version.js";
import { TEMPLATE_CATALOG_VERSION } from "../data/building-templates.js";

const options = { workingDays: TENDAY_WORKING_DAYS_V2, baseNormalQd: DEFAULT_NORMAL_LABOR_QD_V2, useDaysOffBudget: true };
const strict = { ...options, strictWageCheck: true };
const production = (id = "one", extra = {}) => ({ id, overtime: true, ...extra });
const building = (id = "mill", extra = {}) => ({ id, name: id, workersMax: 2, wageDailyCopper: 12,
  labor: { version: 2, capacityQd: 36 }, productionLines: [production(), production("two")], ...extra });
const allocation = (sourceId, normalQd, overtimeQd = 0, functionId = "production:one", id = `${sourceId}/${functionId}`) =>
  ({ id, sourceId, functionId, normalQd, overtimeQd });
const resident = (extra = {}) => ({ id: "resident", name: "Тихон", ageGroup: "Вз", age: 22, role: "Свободен", workAssignment: "",
  workAllocations: [], ...extra });
const holding = (person = resident(), buildings = [building()]) => ({ id: "home", buildings: { list: buildings }, people: { list: [person] } });
const add = (home, extra = {}) => mutateResidentBuildingLabor(home,
  { ...options, personId: "resident", buildingId: "mill", functionId: "production:one", action: "add", normalQd: 4, ...extra });
const personIn = (home) => home.people.list[0];
const rejected = (home, change, code) => {
  const before = structuredClone(home);
  const result = change();
  assert.equal(result.ok, false, JSON.stringify(result.issues));
  if (code) assert.ok(result.issues.some((issue) => issue.code === code), JSON.stringify(result.issues));
  assert.deepEqual(home, before);
  return result;
};

test("SHA-256 vectors, UTF-8, and canonical JSON", () => {
  const vectors = [
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"]
  ];
  for (const [input, expected] of vectors) assert.equal(sha256Hex(input), expected);
  for (const input of ["Теньдень 🌒", "x".repeat(64), "x".repeat(1000)]) {
    assert.equal(sha256Hex(input), createHash("sha256").update(input).digest("hex"));
  }
  assert.equal(canonicalSignatureV1(undefined), canonicalSignatureV1(null));
  const signature = canonicalSignatureV1({ 2: "two", 10: "ten", z: [{ b: true, a: null }, 3] });
  assert.equal(signature, `v1:${sha256Hex('{"10":"ten","2":"two","z":[{"a":null,"b":true},3]}')}`);
  assert.equal(signature, canonicalSignatureV1({ z: [{ a: null, b: true }, 3], 10: "ten", 2: "two" }));
  assert.notEqual(signature, canonicalSignatureV1({ 2: "two", 10: "ten", z: [3, { b: true, a: null }] }));
  assert.match(signature, /^v1:[a-f0-9]{64}$/);
});

test("labor dependencies stay acyclic and the v2 gateway stays opt-in", () => {
  const root = new URL("../data/", import.meta.url);
  const imports = (name) => [...readFileSync(new URL(`${name}.js`, root), "utf8")
    .matchAll(/(?:\bfrom\s*|\bimport\s*)["']([^"']+)["']/g)].map((match) => match[1]);
  for (const leaf of ["sha256", "labor-primitives"]) assert.deepEqual(imports(leaf), []);
  assert.deepEqual(imports("labor-role"), ["./labor-primitives.js"]);
  assert.ok(imports("labor-model").every((name) => !/engines\/|work-allocations|resident-assignments|labor-mutations/.test(name)));
  assert.ok(imports("work-allocations").every((name) => !/resident-assignments|labor-mutations/.test(name)));
  assert.ok(imports("resident-assignments").every((name) => !name.includes("labor-mutations")));
  assert.equal(reexportNormal, allocationNormalQd);
  assert.equal(reexportTotal, allocationTotalQd);
});

test("QD primitives prefer canonical values and roles use active QD, not row count", () => {
  assert.equal(allocationNormalQd({ normalQd: 0, plannedNormalQd: 3, qd: 4 }), 0);
  assert.equal(allocationNormalQd({ plannedNormalQd: "3.9", qd: 4 }), 3);
  assert.equal(allocationTotalQd({ qd: -2, plannedOvertimeQd: "1.9" }), 1);
  assert.equal(allocationTotalQd({ qd: Infinity, overtimeQd: -1 }), 0);
  const child = resident({ role: "План QD", workAllocations: [allocation("mill", 0)] });
  syncResidentLaborRole(child, { isChild: true });
  assert.equal(child.role, "Ребенок");
  child.role = "Солдат: Отряд";
  child.workAssignment = "soldier";
  child.workAllocations.push(allocation("mill", 3, 1));
  assert.equal(residentActiveQd(child), 4);
  syncResidentLaborRole(child);
  assert.equal(child.role, "Солдат: Отряд");
  syncResidentLaborRole(child, { clearServiceRole: true });
  assert.equal(child.role, "План QD");
});

test("ten- and nine-day budgets, children, and a pure days-off conflict preview", () => {
  assert.equal(DEFAULT_NORMAL_LABOR_QD, 20);
  assert.equal(DEFAULT_NORMAL_LABOR_QD_V2, 18);
  assert.equal(TENDAY_WORKING_DAYS_V2, 9);
  const workingChild = resident({ ageGroup: "Ре", age: 12 });
  const youngerChild = resident({ ageGroup: "Ре", age: 11 });
  for (const [config, normals, overtime] of [
    [{ workingDays: 10, baseNormalQd: 20 }, [20, 18, 16, 14, 12, 10], [10, 9, 8, 7, 6, 5]],
    [options, [18, 16, 14, 12, 10, 8], [9, 8, 7, 6, 5, 4]]
  ]) {
    for (const [index, normalQd] of normals.entries()) {
      const home = { gm: { labor: { daysOffPerTenday: index } } };
      assert.equal(holdingDaysOffPerTenday(home), index);
      assert.equal(holdingNormalLaborQd(home, config), normalQd);
      assert.deepEqual(residentLaborCapacity(resident(), normalQd), { normalQd, overtimeQd: overtime[index] });
      assert.deepEqual(residentLaborCapacity(workingChild, normalQd), { normalQd: Math.floor(normalQd / 2), overtimeQd: 0 });
      assert.deepEqual(residentLaborCapacity(youngerChild, normalQd), { normalQd: 0, overtimeQd: 0 });
    }
  }
  assert.equal(holdingNormalLaborQd(undefined, { workingDays: 9 }), 18);
  assert.equal(holdingNormalLaborQd({ daysOffPerTenday: 1 }, { baseNormalQd: 14 }), 12);
  assert.equal(holdingDaysOffPerTenday({ daysOffPerTenday: 80 }), 5);
  const home = holding(resident({ workAllocations: [allocation("mill", 18, 9)] }));
  home.people.list.push(resident({ id: "dead", dead: true, workAllocations: [allocation("mill", 20)] }));
  const before = structuredClone(home);
  assert.equal(daysOffConflictSummary(home, 1).hasConflicts, false);
  assert.deepEqual(daysOffConflictSummary(home, 1, options), { daysOff: 1, hasConflicts: true, conflicts: [
    { personId: "resident", name: "Тихон", normalQd: 18, overtimeQd: 9, maxNormalQd: 16, maxOvertimeQd: 8, budgetMaxOvertimeQd: 8 }
  ] });
  assert.deepEqual(home, before);
});

test("days-off preview reports the effective overtime cap when assigned normal QD is low", () => {
  const home = holding(resident({ workAllocations: [allocation("mill", 2, 2)] }));
  assert.deepEqual(daysOffConflictSummary(home, 1, options), { daysOff: 1, hasConflicts: true, conflicts: [
    { personId: "resident", name: "Тихон", normalQd: 2, overtimeQd: 2, maxNormalQd: 16, maxOvertimeQd: 1, budgetMaxOvertimeQd: 8 }
  ] });
});

test("v72 schema, world setting, and military wage calculations remain compatible", () => {
  assert.equal(SKYHOLD_SCHEMA_VERSION, 72);
  assert.equal(TEMPLATE_CATALOG_VERSION, 19);
  const previous = globalThis.game;
  globalThis.game = { settings: { get: (module, key) => module === MODULE_ID && key === SETTING_NORMAL_LABOR_QD ? 14 : undefined } };
  try {
    assert.equal(normalLaborQdPerTenday(), 14);
    assert.deepEqual(residentLaborCapacity(resident()), { normalQd: 14, overtimeQd: 7 });
    const person = resident({ workAllocationMode: "explicit", workAllocations: [allocation("mill", 14, 7)] });
    const legacy = building();
    delete legacy.labor;
    const home = holding(person, [legacy]);
    home.gm = { labor: { daysOffPerTenday: 5 } };
    assert.equal(validateHoldingWorkAllocations(home).ok, true);
    person.workAllocations[0].normalQd = 15;
    assert.ok(validateHoldingWorkAllocations(home).issues.some((issue) => issue.code === "allocation-normal-cap" && issue.limit === 14));
  } finally {
    if (previous === undefined) delete globalThis.game;
    else globalThis.game = previous;
  }
  const soldier = resident({ workAssignment: "soldier", salary: 99, salaryModifier: 3 });
  const army = holding(soldier);
  army.gm = { defense: { squads: [{ type: "cavalry", sergeantId: soldier.id }] } };
  assert.equal(militaryDailyWage(army, soldier), 27);
  assert.equal(militaryDailyWage(army, { ...soldier, wageDailyOverrideCopper: 70 }), 27);
  const wageOptions = { useWageOverride: true };
  assert.equal(militaryDailyWage(army, { ...soldier, wageDailyOverrideCopper: 70 }, wageOptions), 70);
  for (const override of [0, -1, 1.5, "70", Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(militaryDailyWage(army, { ...soldier, wageDailyOverrideCopper: override }, wageOptions), 27);
  }
  assert.equal(militaryDailyWage(army, { ...soldier, militarySalaryModifier: -2 }), 25);
  assert.equal(militaryDailyWage(army, { ...soldier, militarySalaryModifier: 4, wageDailyOverrideCopper: 32 }, wageOptions), 32);
  assert.equal(militaryDailyWage(army, { ...soldier, workAssignment: "defenseCommander", militarySalaryModifier: 4 }), 33);
  assert.equal(soldier.salary, 99);
});

test("building capacity has explicit zero/unlimited forms; preparation goals resolve by function", () => {
  const workshop = building("mill", { workersMax: 2, activation: { minOperationalQd: 37 } });
  assert.equal(buildingMinOperationalQd(workshop), 37);
  assert.deepEqual(normalizeBuildingLabor({}, workshop, options), { version: 2, capacityQd: 37 });
  assert.deepEqual(normalizeBuildingLabor(undefined, workshop), { version: 2, capacityQd: 40 });
  assert.equal(buildingCapacityQd(workshop), 36);
  assert.equal(buildingAvailableCapacityQd(workshop, 35), 1);
  assert.equal(buildingAvailableCapacityQd(workshop, 50), 0);
  workshop.labor.capacityQd = 0;
  assert.equal(buildingAcceptsWorkers(workshop), false);
  workshop.labor.capacityQd = null;
  assert.equal(buildingAcceptsWorkers(workshop), true);
  assert.equal(buildingAvailableCapacityQd(workshop, 500), null);
  const home = { workforcePlan: { productionGoals: [
    { sourceId: "mill", preparedUnits: 8 }, { sourceId: "mill", functionId: "production:two", preparedUnits: 15 }
  ] } };
  assert.equal(productionPreparationGoal(home, "mill", "production:one"), 8);
  assert.equal(productionPreparationGoal(home, "mill", "production:two"), 15);
  assert.equal(productionPreparationGoal(home, "absent", "production:two"), 0);
});

test("passive v2 buildings expose no labor targets", () => {
  const home = holding(resident(), [building("mill", { labor: { version: 2, capacityQd: 0 } })]);
  assert.deepEqual(buildWorkAllocationTargets(home, { v2: true }), []);
  rejected(home, () => add(home), "allocation-unknown");
});

test("v2 building targets advertise QD mode rather than legacy worker counts", () => {
  const buildings = [
    building(),
    building("clinic", { medical: { enabled: true } }),
    building("field", { agriculture: { enabled: true, kind: "field" } }),
    building("ranch", { livestock: { enabled: true, speciesId: "sheep" }, productionLines: [] }),
    ...["income", "culture", "defense", "housing", "storage"].map((kind) =>
      building(kind, { functions: { [kind]: true }, productionLines: [] }))
  ];
  const targets = buildWorkAllocationTargets(holding(resident(), buildings), { v2: true });
  assert.deepEqual([...new Set(targets.map((target) => target.kind))].sort(),
    ["agriculture", "culture", "defense", "housing", "income", "livestock", "medical", "production", "storage"]);
  for (const { key, laborMode, workersMax } of targets) {
    assert.equal(laborMode, "qd", key);
    assert.equal(workersMax, 0, key);
  }
});

test("targeted add, set, and remove preserve other rows and synchronize roles", () => {
  const home = holding(resident(), [building(), building("furnace")]);
  assert.equal(add(home).ok, true);
  assert.equal(personIn(home).role, "План QD");
  const id = personIn(home).workAllocations[0].id;
  assert.equal(add(home, { normalQd: 2, overtimeQd: 2 }).ok, true);
  assert.equal(residentActiveQd(personIn(home)), 8);
  assert.equal(add(home, { action: "set", normalQd: 2, overtimeQd: 1 }).ok, true);
  assert.equal(personIn(home).workAllocations[0].id, id);
  assert.equal(add(home, { buildingId: "furnace" }).ok, true);
  assert.equal(add(home, { action: "remove" }).ok, true);
  assert.deepEqual(personIn(home).workAllocations.map((row) => row.sourceId), ["furnace"]);
  assert.equal(personIn(home).role, "План QD");
  assert.equal(add(home, { action: "remove", buildingId: "furnace", functionId: "" }).ok, true);
  assert.deepEqual(personIn(home).workAllocations, []);
  assert.equal(personIn(home).role, "Свободен");
});

test("wages reject unpaid work without volunteering and reject zero or non-integer overrides", () => {
  const unpaid = building("mill", { wageDailyCopper: 0 });
  const home = holding(resident(), [unpaid]);
  assert.equal(functionDailyRate(unpaid, "production:one"), 0);
  rejected(home, () => add(home), "work-target-unpaid");
  assert.equal(add(home, { volunteer: true }).ok, true);
  assert.equal(personIn(home).workAllocations[0].volunteer, true);
  const donated = holding(resident({ volunteerLabor: true }), [unpaid]);
  assert.equal(add(donated).ok, true);
  const zeroOverride = holding(resident({ wageDailyOverrideCopper: 0 }), [unpaid]);
  rejected(zeroOverride, () => add(zeroOverride), "invalid-wage-override");
  for (const wageDailyOverrideCopper of [0, -1, 2.5, "12", ""]) {
    const invalid = holding(resident({ wageDailyOverrideCopper, volunteerLabor: true }));
    rejected(invalid, () => add(invalid), "invalid-wage-override");
  }
  const overrideOnly = holding(resident({ wageDailyOverrideCopper: 6 }), [unpaid]);
  assert.equal(add(overrideOnly).ok, true);
  const payable = holding(resident({ wageDailyOverrideCopper: 6 }));
  assert.equal(add(payable).ok, true);
  assert.equal(functionDailyRate(building("mill", { productionLines: [production("one", { wageDailyCopper: 19 })] }), "production:one"), 19);
});

test("unavailable residents cannot add labor even with explicit replacement", () => {
  for (const facts of [{ dead: true }, { absent: true }, { injuredDays: 0.5 }, { ageGroup: "Ре", age: 11 },
    { shipAssignment: { shipId: "airship", away: true } }]) {
    const home = holding(resident({ ...facts, role: "Солдат: Отряд", workAssignment: "soldier" }));
    home.gm = { defense: { squads: [{ sergeantId: "resident", memberIds: [] }] } };
    home.special = { ships: { list: [{ id: "airship", crewResidentIds: ["resident"], status: "away" }] } };
    if (!facts.shipAssignment) delete home.special;
    rejected(home, () => add(home, { replaceOccupation: true }), "resident-unavailable");
  }
  const legacyCrew = holding();
  legacyCrew.special = { ships: { list: [{ id: "airship", commanderResidentId: "resident", activeVoyage: {} }] } };
  rejected(legacyCrew, () => add(legacyCrew, { replaceOccupation: true }), "resident-unavailable");
});

test("ship commander, co-commander, and crew reserve labor except on their shore-duty ship", () => {
  for (const ship of [{ commanderResidentId: "resident", commanderName: "Тихон" }, { coCommanderResidentIds: ["resident"] }, { crewResidentIds: ["resident"] }]) {
    const home = holding();
    home.special = { ships: { list: [{ ...ship, id: "airship", status: "docked" }] } };
    assert.equal(reservedOccupation(home, personIn(home)).kind, "ship");
    rejected(home, () => add(home), "reserved-occupation");
    rejected(home, () => add(home, { replaceOccupation: true }), "reserved-occupation");
    personIn(home).shipAssignment = { shoreDuty: true };
    assert.equal(reservedOccupation(home, personIn(home)).kind, "ship");
    rejected(home, () => add(home), "reserved-occupation");
    personIn(home).shipAssignment = { shipId: "different", shoreDuty: true };
    assert.equal(reservedOccupation(home, personIn(home)).kind, "ship");
    personIn(home).shipAssignment = { shipId: "airship", away: true, shoreDuty: true };
    assert.equal(reservedOccupation(home, personIn(home)), null);
    assert.equal(add(home, { replaceOccupation: true }).ok, true);
    assert.deepEqual(home.special.ships.list[0], { ...ship, id: "airship", status: "docked" });
  }
});

test("ship assignment fallback requires a non-empty matching shore-duty ship ID", () => {
  const home = holding(resident({ workAssignment: "ship:airship" }));
  for (const shipAssignment of [{ shoreDuty: true }, { shoreDuty: true, shipId: "  " }, { shoreDuty: true, shipId: "different" }]) {
    personIn(home).shipAssignment = shipAssignment;
    assert.equal(reservedOccupation(home, personIn(home)).kind, "ship");
    rejected(home, () => add(home), "reserved-occupation");
  }
  personIn(home).shipAssignment = { shoreDuty: true, shipId: " airship " };
  assert.equal(reservedOccupation(home, personIn(home)), null);
});

test("0-QD editor drafts preserve construction roles; active replacement must be explicit", () => {
  const home = holding(resident({ role: "Мастера", workAssignment: "construction-leader:crew" }));
  home.constructionCrews = [{ name: "Мастера", leaderId: "resident", memberIds: ["another"] }];
  assert.equal(applyResidentEditorAllocations(home, "resident", { ...options, nextAllocations: [allocation("mill", 0)], replaceOccupation: true }).ok, true);
  assert.equal(home.constructionCrews[0].leaderId, "resident");
  assert.equal(personIn(home).workAssignment, "construction-leader:crew");
  assert.equal(personIn(home).role, "Мастера");
  rejected(home, () => add(home), "reserved-occupation");
  assert.equal(add(home, { replaceOccupation: true }).ok, true);
  assert.deepEqual(home.constructionCrews[0], { name: "Мастера", leaderId: "", memberIds: ["another"] });
  assert.equal(personIn(home).workAssignment, "");
  assert.equal(personIn(home).role, "План QD");
});

test("defense and sheriff replacement release only the explicitly replaced occupation", () => {
  const home = holding(resident({ role: "Солдат: Отряд", workAssignment: "soldier" }));
  home.gm = { defense: { squads: [{ sergeantId: "resident", memberIds: ["resident", "other"] }] } };
  rejected(home, () => add(home), "reserved-occupation");
  assert.equal(add(home, { replaceOccupation: true }).ok, true);
  assert.deepEqual(home.gm.defense.squads, [{ sergeantId: "", memberIds: ["", "other"] }]);
  assert.equal(personIn(home).role, "План QD");
  const sheriff = holding(resident({ role: "Шериф" }));
  rejected(sheriff, () => add(sheriff), "reserved-occupation");
  assert.equal(add(sheriff, { replaceOccupation: true }).ok, true);
  assert.equal(personIn(sheriff).role, "План QD");
});

test("availability, admission, composition warnings, and capacity are separate checks", () => {
  const disabled = holding(resident(), [building("mill", { lifecycle: "disabled" })]);
  rejected(disabled, () => add(disabled), "work-target-unavailable");
  rejected(disabled, () => add(disabled, { functionId: "unknown" }), "allocation-unknown");
  const home = holding(resident(), [building("mill", { labor: { version: 2, capacityQd: 4 }, workerProfile: {
    admission: { hard: true, text: "Требуется сила", clauses: [[{ attribute: "strength", minimum: 5 }]] },
    composition: [{ count: 2, backgrounds: ["Кузнец"] }]
  } })]);
  rejected(home, () => add(home), "admission-denied");
  rejected(home, () => add(home, { normalQd: 5, allowAdmissionOverride: true }), "allocation-capacity");
  const check = add(home, { allowAdmissionOverride: true });
  assert.equal(check.ok, true);
  assert.deepEqual(check.warnings.map((issue) => issue.code), ["composition-unmet"]);
  assert.deepEqual(home.buildings.list[0].workerAdmissionOverrideIds, ["resident"]);
  assert.equal(add(home, { action: "remove" }).ok, true);
  assert.deepEqual(home.buildings.list[0].workerAdmissionOverrideIds, []);
});

test("v2 composition warnings exclude optional Wonderworker slots", () => {
  const home = holding(resident(), [building("mill", { workerProfile: { composition: [{ count: 1, group: "ЧУДОТВОРЕЦ" }] } })]);
  const check = add(home);
  assert.equal(check.ok, true);
  assert.deepEqual(check.warnings, []);
});

test("medical buildings allow overtime by default when enabled", () => {
  for (const templateId of ["lazaret", "hospital"]) {
    const home = holding(resident(), [building("clinic", { templateId, medical: { enabled: true } })]);
    const work = { buildingId: "clinic", functionId: "medical", overtimeQd: 2 };
    rejected(home, () => add(home, { ...work, allowMedicalOvertime: false }), "allocation-overtime");
    assert.equal(add(home, { ...work, allowMedicalOvertime: true }).ok, true);
  }
});

test("medical overtime and collection work honor their target rules", () => {
  const medical = building("clinic", { medical: { enabled: true, overtimeAllowed: true } });
  const home = holding(resident(), [medical]);
  assert.equal(targetAllowsOvertime(medical, "medical"), true);
  assert.equal(targetAllowsOvertime(medical, "medical", { allowMedicalOvertime: false }), false);
  assert.equal(add(home, { buildingId: "clinic", functionId: "medical", overtimeQd: 2 }).ok, true);
  assert.equal(validateHoldingWorkAllocations(home, strict).targetMap.get("clinic::medical").overtimeAllowed, true);
  assert.ok(validateHoldingWorkAllocations(home, { ...strict, allowMedicalOvertime: false }).issues.some((issue) => issue.code === "allocation-overtime"));
  assert.equal(remainingCollectionQd({ collectQd: 3.25, collectProgressQd: 2.9 }), 2);
  assert.equal(remainingCollectionQd({ collectQd: 4, collectProgressQd: 4 }), 0);
  assert.equal(remainingCollectionQd({ collectQd: 4, collectProgressQd: 6 }), 0);
  const collection = production("one", { source: "passive", requiresCollection: true, collectQd: 4, collectProgressQd: 4, pendingQty: 3 });
  const workshop = holding(resident(), [building("mill", { productionLines: [collection] })]);
  rejected(workshop, () => add(workshop), "allocation-unknown");
  collection.collectProgressQd = 3;
  assert.equal(add(workshop).ok, true);
});

test("days off and assigned normal QD cap overtime for adults and children", () => {
  const home = holding();
  home.gm = { labor: { daysOffPerTenday: 5 } };
  rejected(home, () => add(home, { normalQd: 9 }), "allocation-normal-cap");
  rejected(home, () => add(home, { normalQd: 6, overtimeQd: 4 }), "allocation-overtime-days");
  rejected(home, () => add(home, { normalQd: 8, overtimeQd: 5 }), "allocation-overtime-cap");
  assert.equal(add(home, { normalQd: 8, overtimeQd: 4 }).ok, true);
  const child = holding(resident({ ageGroup: "Ре", age: 12 }));
  child.gm = { labor: { daysOffPerTenday: 5 } };
  rejected(child, () => add(child, { normalQd: 5 }), "allocation-normal-cap");
  rejected(child, () => add(child, { normalQd: 4, overtimeQd: 1 }), "allocation-overtime-cap");
  assert.equal(add(child).ok, true);
});

test("setting a plan rejects an existing overtime-days violation even when reduced", () => {
  const home = holding(resident({ workAllocations: [allocation("mill", 2, 3)] }));
  rejected(home, () => add(home, { action: "set", normalQd: 2, overtimeQd: 2 }), "allocation-overtime-days");
  assert.equal(add(home, { action: "set", normalQd: 2, overtimeQd: 1 }).ok, true);
});

test("removal rejects orphaned overtime and explicit clearing remains available for demolition", () => {
  const home = holding(resident(), [building(), building("furnace")]);
  assert.equal(add(home).ok, true);
  assert.equal(add(home, { buildingId: "furnace", normalQd: 0, overtimeQd: 2 }).ok, true);
  home.buildings.list[0].workerAdmissionOverrideIds = ["resident", "keep"];
  const removal = rejected(home, () => add(home, { action: "remove" }), "allocation-overtime-days");
  assert.equal(removal.message, "Сначала уменьшите сверхурочные (OT) в оставшихся назначениях");
  clearResidentBuildingLabor(home, personIn(home), "mill");
  assert.deepEqual(home.buildings.list[0].workerAdmissionOverrideIds, ["keep"]);
  assert.equal(personIn(home).role, "План QD");
  assert.equal(trimExcessOvertimeForResidents(home, ["resident"], options).ok, true);
  assert.deepEqual(personIn(home).workAllocations, []);
  assert.equal(personIn(home).role, "Свободен");
});

test("conservation trims unlocked rows canonically, previews locked cuts, and removes obsolete locks", () => {
  const rows = [allocation("beta", 0, 1), allocation("alpha", 0, 1, "production:two"),
    allocation("alpha", 0, 1), allocation("locked", 0, 2), allocation("normal", 2)];
  const home = holding(resident({ workAllocations: rows, role: "План QD" }),
    [building("alpha"), building("beta"), building("locked"), building("normal")]);
  const lock = { personId: "resident", sourceId: "locked", functionId: "production:one" };
  home.workforcePlan = { locks: [lock] };
  home.buildings.list[0].workerAdmissionOverrideIds = ["resident"];
  const preview = rejected(home, () => trimExcessOvertimeForResidents(home, ["resident"], options));
  assert.equal(preview.requiresConfirmation, true);
  assert.deepEqual(preview.trims.map(({ sourceId, functionId, overtimeBefore, overtimeAfter, locked }) =>
    [sourceId, functionId, overtimeBefore, overtimeAfter, locked]), [
    ["alpha", "production:one", 1, 0, false], ["alpha", "production:two", 1, 0, false],
    ["beta", "production:one", 1, 0, false], ["locked", "production:one", 2, 1, true]
  ]);
  assert.deepEqual(preview.lockedTrims, [preview.trims[3]]);
  assert.equal(preview.lockedTrims[0].personName, "Тихон");
  const trimmed = trimExcessOvertimeForResidents(home, ["resident"], { ...options, confirmLocked: true });
  assert.equal(trimmed.ok, true);
  assert.deepEqual(trimmed.trims, preview.trims);
  assert.deepEqual(home.workforcePlan.locks, [lock]);
  assert.deepEqual(home.buildings.list[0].workerAdmissionOverrideIds, []);
  clearResidentBuildingLabor(home, personIn(home), "normal");
  const blocked = rejected(home, () => trimExcessOvertimeForResidents(home, ["resident"], { ...options, locks: [] }));
  assert.equal(blocked.requiresConfirmation, true);
  assert.deepEqual(blocked.lockedTrims.map(({ sourceId, overtimeAfter }) => [sourceId, overtimeAfter]), [["locked", 0]]);
  assert.deepEqual(home.workforcePlan.locks, [lock]);
  assert.equal(trimExcessOvertimeForResidents(home, ["resident"], { ...options, confirmLocked: true }).ok, true);
  assert.deepEqual(home.workforcePlan.locks, []);
  assert.equal(personIn(home).role, "Свободен");
});

test("reservations support scoped visibility and releases without overcounting a function transfer", () => {
  const mill = building("mill", { labor: { version: 2, capacityQd: 5 } });
  const home = holding(resident({ workAllocations: [allocation("mill", 2), allocation("mill", 1, 0, "production:two")] }), [mill]);
  home.people.list.push(resident({ id: "hidden", visibility: "gm", workAllocations: [allocation("mill", 2)] }));
  assert.deepEqual([...buildingWorkReservations(home)], [["mill", 5]]);
  assert.deepEqual([...buildingWorkReservations(home, { canRead: (row) => row.visibility !== "gm" })], [["mill", 3]]);
  assert.equal(buildingWorkReservations(home, { excludePersonId: "resident" }).get("mill"), 2);
  assert.equal(buildingWorkReservations(home, { presentIds: new Set(["resident"]) }).get("mill"), 3);
  const releasedQdByPersonOrBuilding = new Map([["resident", new Map([["mill", 2]])]]);
  const reserved = buildingWorkReservations(home, { releasedQdByPersonOrBuilding }).get("mill");
  assert.equal(buildingAvailableCapacityQd(mill, reserved), 2);
  assert.equal(buildingWorkReservations(home, { releasedQdByPersonOrBuilding: { mill: 2 } }).get("mill"), 3);
  rejected(home, () => add(home, { normalQd: 2, functionId: "production:two" }), "allocation-capacity");
  const check = applyResidentEditorAllocations(home, "resident", { ...options, nextAllocations: [allocation("mill", 3, 0, "production:two")] });
  assert.equal(check.ok, true);
  assert.equal(buildingWorkReservations(home).get("mill"), 5);
});

test("target-key-only work of an untouched resident reserves building capacity", () => {
  const home = holding(resident(), [building("mill", { labor: { version: 2, capacityQd: 4 } })]);
  home.people.list.push(resident({ id: "untouched", workAllocations: [{ targetKey: "mill::production:one", normalQd: 4 }] }));
  assert.equal(buildingWorkReservations(home).get("mill"), 4);
  assert.equal(validateHoldingWorkAllocations(home, strict).ok, true);
  const result = rejected(home, () => add(home), "allocation-capacity");
  const { buildingId, actual, limit } = result.issues.find((issue) => issue.code === "allocation-capacity");
  assert.deepEqual({ buildingId, actual, limit }, { buildingId: "mill", actual: 8, limit: 4 });
});

test("editor and workforce writes reject malformed raw QD before normalization", () => {
  const home = holding(resident({ workAllocations: [allocation("mill", 4)] }));
  home.people.list.push(resident({ id: "second" }));
  const invalidValues = ["bogus", -1, 1.5, NaN, Infinity, null, Number.MAX_SAFE_INTEGER + 1];
  const invalidRows = [null, 42, "not a row", [], new Date(0)];
  for (const field of ["normalQd", "overtimeQd", "plannedNormalQd", "plannedOvertimeQd", "qd"]) {
    invalidRows.push(...invalidValues.map((value) => ({ ...allocation("mill", 2), [field]: value })));
  }
  const expected = { ok: false, message: "QD должны быть целыми неотрицательными числами." };
  for (const row of invalidRows) {
    assert.deepEqual(rejected(home, () => applyResidentEditorAllocations(home, "resident", { ...options, nextAllocations: [row] })), expected);
    assert.deepEqual(rejected(home, () => applyWorkforcePlanAllocations(home, { ...options, updates: [
      { personId: "resident", nextAllocations: [] }, { personId: "second", workAllocations: [row] }
    ] })), expected);
  }
});

test("whole-workforce swaps validate final capacity atomically and failures leave both residents unchanged", () => {
  const person = resident({ workAllocations: [allocation("mill", 4)] });
  const capacity = { labor: { version: 2, capacityQd: 4 } };
  const home = holding(person, [building("mill", capacity), building("furnace", capacity)]);
  home.people.list.push(resident({ id: "second", workAllocations: [allocation("furnace", 4)] }));
  const update = (personId, sourceId) => ({ personId, nextAllocations: [allocation(sourceId, 4)] });
  rejected(home, () => applyWorkforcePlanAllocations(home, { ...options, updates: [update("resident", "furnace"), update("second", "furnace")] }), "allocation-capacity");
  assert.equal(applyWorkforcePlanAllocations(home, { ...options, updates: [update("resident", "furnace"), update("second", "mill")] }).ok, true);
  assert.deepEqual(home.people.list.map((row) => [row.role, row.workAllocations[0].sourceId]), [["План QD", "furnace"], ["План QD", "mill"]]);
});

test("scoped clear removes only matching assignments and override IDs", () => {
  const person = resident({ ageGroup: "Ре", age: 12, role: "План QD", workAllocations: [allocation("mill", 2), allocation("furnace", 1)] });
  const home = holding(person, [building("mill", { workerAdmissionOverrideIds: ["resident", "keep"] }),
    building("furnace", { workerAdmissionOverrideIds: ["resident"] })]);
  clearResidentLaborAllocations(home, person, { buildingId: "mill", isChild: true });
  assert.deepEqual(person.workAllocations, [allocation("furnace", 1)]);
  assert.deepEqual(home.buildings.list.map((row) => row.workerAdmissionOverrideIds), [["keep"], ["resident"]]);
  clearResidentAllBuildingLabor(home, person, { isChild: true });
  assert.equal(person.role, "Ребенок");
  assert.deepEqual(home.buildings.list.map((row) => row.workerAdmissionOverrideIds), [["keep"], []]);
});

test("clearing a child's last allocation restores the child role without an explicit flag", () => {
  for (const clear of [
    clearResidentLaborAllocations,
    clearResidentAllBuildingLabor,
    (home, person) => clearResidentBuildingLabor(home, person, "mill"),
    (home, person) => assert.equal(applyResidentEditorAllocations(home, person.id, { ...options, nextAllocations: [] }).ok, true)
  ]) {
    const home = holding(resident({ ageGroup: "Ре", age: 12, role: "План QD", workAllocations: [allocation("mill", 2)] }));
    clear(home, personIn(home));
    assert.deepEqual(personIn(home).workAllocations, []);
    assert.equal(personIn(home).role, "Ребенок");
  }
});

test("cross-holding transfer cleans labor, locks, and source links or changes neither side", () => {
  const source = holding(resident({ role: "План QD", workAllocations: [allocation("mill", 2)] }),
    [building("mill", { workerAdmissionOverrideIds: ["resident", "keep"] })]);
  source.workforcePlan = { locks: [{ personId: "resident", sourceId: "mill", functionId: "production:one" }] };
  source.special = { ships: { list: [{ id: "ship", status: "docked", commanderResidentId: "resident", commanderName: "Тихон" }] } };
  const destination = { id: "destination", people: { list: [resident()] } };
  const beforeDestination = structuredClone(destination);
  rejected(source, () => transferResidentBetweenHoldings(source, destination, "resident", options));
  assert.deepEqual(destination, beforeDestination);
  destination.people.list = [];
  assert.equal(transferResidentBetweenHoldings(source, destination, "resident", options).ok, true);
  assert.deepEqual(source.people.list, []);
  assert.deepEqual(source.workforcePlan.locks, []);
  assert.deepEqual(source.buildings.list[0].workerAdmissionOverrideIds, ["keep"]);
  assert.equal(source.special.ships.list[0].commanderResidentId, "");
  assert.deepEqual(personIn(destination).workAllocations, []);
  assert.equal(personIn(destination).role, "Свободен");
});
