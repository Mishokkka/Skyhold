import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hybridRuntimeFixture } from "./hybrid-labor-runtime-check.mjs";
import { DEFAULT_BUILDING_TEMPLATES } from "../data/building-templates.js";
import { SkyholdData } from "../data/store.js";
import { SkyholdWorkflowService } from "../workflows/skyhold-workflow-service.js";
import { createWorkforceDraft, buildWorkforceModel, proposeWorkforceAssignments, workforceCandidate } from "../apps/domains/workforce-planner.js";
import { SETTING_NORMAL_LABOR_QD } from "../data/constants.js";
import { setPoliticsRuntimeEffects } from "../engines/politics/runtime-effects.js";
import { normalizeLivestockBuilding } from "../data/livestock.js";

const quantity = (holding, id) => (holding.storage.resources ?? []).filter((row) => row.resourceId === id).reduce((sum, row) => sum + row.qty, 0);
function fixture(mode = "qd") {
  const f = hybridRuntimeFixture({ goal: null });
  f.harness = new SkyholdWorkflowService();
  f.harness._runFoodConsumptionForQd = () => {}; // These contracts measure production inventory before meals.
  f.harness._agricultureCalendarContext = () => ({ year: "1", seasonId: "spring", seasonKey: "1:spring" });
  f.building.labor.mode = mode;
  f.building.wageDailyCopper = 12;
  f.building.productionLines.splice(1);
  f.building.productionLines[0].wageDailyCopper = 12;
  f.person.attributes = { strength: 3, agility: 3, wits: 3, empathy: 3 };
  delete f.person.wageDailyOverrideCopper;
  if (mode === "qd") {
    f.building.assignedWorkerIds = [];
    delete f.person.staffAppointment;
    f.person.workAssignment = "";
    f.person.workAllocationMode = "explicit";
    f.person.workAllocations = [{ sourceId: f.building.id, functionId: "production:main", normalQd: 20, overtimeQd: 0 }];
  } else f.person.staffAppointment.reserveFunctionId = "";
  return f;
}
async function run(f, id) {
  SkyholdData.view = () => ({ holdings: [f.holding], catalog: {} });
  return f.harness._runEconomyForQd(f.holding, 40, { operationId: id });
}
function fieldFixture() {
  const f = fixture();
  f.building.functions = { production: true, culture: true };
  f.building.productionLines = [];
  f.building.agriculture = structuredClone(DEFAULT_BUILDING_TEMPLATES.find((row) => row.id === "grain-field").agriculture);
  f.building.agriculture.crops = [{ id: "grain", label: "Зерно", resourceId: "grain", outputQty: 8,
    sowingSeasons: ["spring"], sowingWorkQd: 1, growingQd: 8, harvestWorkQd: 1,
    expiryRule: "qd", readyExpiryQd: 120, annualHarvestLimit: 1, perennial: false }];
  f.person.workAllocations = [
    { sourceId: f.building.id, functionId: "culture", normalQd: 18, overtimeQd: 0 },
    { sourceId: f.building.id, functionId: "agriculture", normalQd: 2, overtimeQd: 0 }
  ];
  return f;
}

export async function checkScheduledAgriculture() {
  const f = fieldFixture();
  const report = await run(f, "late-sowing");
  assert.equal(quantity(f.holding, "grain"), 0, "QD on the last day cannot sow and harvest at the beginning of the tenday");
  assert.equal(f.building.agriculture.state.phase, "growing");
  assert.equal(f.building.agriculture.state.growingElapsedQd, 4, "Growth starts at the actual sowing slot (step 36)");
  assert.equal(report.agriculture.workQdUsed, 1);
  assert.equal(f.holding.storage.moneyCopper, 9880, "Scheduled QD keep the existing planned-wage contract");
  const expired = fieldFixture();
  expired.building.agriculture.crops[0].readyExpiryQd = 8;
  expired.building.agriculture.state = { phase: "ready", cropId: "grain", harvestYear: "1", harvestsThisYear: 1,
    readyQty: 8, harvestTotalQty: 8, harvestWorkQdTotal: 1, harvestedQty: 0, readyAgeQd: 0, readySeasonKey: "1:spring" };
  const loss = await run(expired, "late-harvest");
  assert.equal(quantity(expired.holding, "grain"), 0, "A future harvesting slot cannot save an already expired crop");
  assert.equal(loss.agriculture.expiredQty, 8);
  const season = fieldFixture();
  season.harness._agricultureCalendarContext = (_holding, step) => ({ year: "1", seasonId: step < 20 ? "spring" : "summer", seasonKey: step < 20 ? "1:spring" : "1:summer" });
  await run(season, "late-season");
  assert.equal(season.building.agriculture.state.phase, "empty", "Sowing must use the season of the scheduled labor");
  assert.equal(quantity(season.holding, "grain"), 0);
}

export async function checkProductionSharedInputs() {
  for (const mode of ["staff", "qd"]) {
    const f = fixture(mode);
    f.holding.storage.resources = [{ id: "wood", resourceId: "wood", name: "Древесина", qty: 1 }];
    Object.assign(f.building.productionLines[0], { resourceId: "cloth", expenses: "wood 1", fixedExpenses: "wood 1", repeat: false });
    const source = { id: "supplier", name: "Поставщик", constructionStatus: "built", functions: { production: true },
      productionLines: [{ id: "supply", source: "workers", active: false, resourceId: "wood", pendingQty: 1,
        requiresCollection: true, collectQd: 1, autoCollect: "worker" }] };
    f.holding.buildings.list.push(source);
    const report = await run(f, `shared-input-${mode}`);
    assert.equal(quantity(f.holding, "cloth"), 1, `${mode}: fixed and variable inputs share stock; collect the missing second unit`);
    assert.equal(quantity(f.holding, "wood"), 0);
    assert.equal(source.productionLines[0].pendingQty, 0);
    assert.equal(report.ledger.filter((row) => row.domain === "production" && row.resourceId === "wood" && row.qty < 0)
      .reduce((sum, row) => sum - row.qty, 0), 2, "Reserve both units exactly once");
  }
  for (const reverse of [false, true]) {
    const f = fixture();
    f.holding.storage.resources = [{ id: "stone", resourceId: "stone", name: "Камень", qty: 1 }, { id: "brick", resourceId: "bricks", name: "Кирпич", qty: 1 }];
    const costs = f.harness._parseResourceCosts(reverse ? "stone 1; masonry 1" : "masonry 1; stone 1");
    const before = structuredClone(f.holding.storage);
    const plan = f.harness._storageCanPay(f.holding, costs);
    assert.equal(plan.ok, true, "An interchangeable group must leave the exact ingredient available, regardless of recipe order");
    assert.deepEqual(f.holding.storage, before);
    const paid = f.harness._storagePay(f.holding, costs, { captureReceipt: true });
    assert.equal(paid.ok, true);
    assert.equal(quantity(f.holding, "stone") + quantity(f.holding, "bricks"), 0);
    assert.equal(paid.receipt.reduce((sum, row) => sum + row.qty, 0), 2);
  }
}

export function checkPlannerWorkUnits() {
  const f = fixture();
  f.person.workAllocations = [];
  f.building.workerProfile = { modifiers: { types: [{ match: "type:Разнорабочий", percent: -43 }], backgrounds: [], traits: [] } };
  Object.assign(f.building.productionLines[0], { outputQty: 100, workQd: 1, batchCapacity: 100, batchStartQty: 1 });
  f.holding.workforcePlan.productionGoals = [{ sourceId: f.building.id, functionId: "production:main", preparedUnits: 57 }];
  const draft = createWorkforceDraft(f.holding, f.harness);
  const proposal = proposeWorkforceAssignments(f.holding, draft, f.harness, { isGM: true });
  assert.equal(proposal.changes[0].after, 1, "57% efficiency covers 5700 work units in one real QD; floating-point conversion must not request two");
  const task = buildWorkforceModel(f.holding, proposal.draft, f.harness, { isGM: true }).tasks[0];
  assert.equal(task.effectiveQd, 0.57);
  assert.equal(task.effectiveRemaining, 0);
  const growing = fieldFixture();
  growing.person.workAllocations = [];
  Object.assign(growing.building.agriculture.crops[0], { growingQd: 40, sowingWorkQd: 8, harvestWorkQd: 30 });
  growing.building.agriculture.state = { phase: "growing", cropId: "grain", growingElapsedQd: 20,
    harvestYear: "1", lastSownSeasonKey: "1:spring" };
  const upcoming = buildWorkforceModel(growing.holding, createWorkforceDraft(growing.holding, growing.harness), growing.harness, { isGM: true })
    .taskMap.get("workshop::agriculture");
  assert.equal(upcoming.effectiveNeed, 30, "A ripening crop needs future harvest work, not the already completed sowing");
  assert.ok(upcoming.note.includes("Предстоящий сбор"));
}

/** Observe actual budget debits across day resets, independently of service projections. */
function observeSpent(f) {
  let spent = 0;
  const tally = (budgets) => [...budgets.values()].reduce((sum, row) => sum + (row.spent || 0), 0);
  const reset = f.harness._resetWorkerBudgets;
  f.harness._resetWorkerBudgets = function (holding, budgets, ...args) {
    spent += tally(budgets);
    return reset.call(this, holding, budgets, ...args);
  };
  const execute = f.harness._runProductionAndLivestockForQd;
  f.harness._runProductionAndLivestockForQd = async function (holding, qd, report, options) {
    if (f.politics !== undefined) setPoliticsRuntimeEffects(holding, { productionPercent: f.politics });
    const result = await execute.call(this, holding, qd, report, options);
    spent += tally(options.budgets);
    return result;
  };
  return () => spent;
}

export async function checkPhysicalAndEffectiveQd() {
  let cases = 0;
  for (const mode of ["staff", "qd"]) for (const normal of [7, 20]) for (const overtime of [0, 3])
    for (const percent of [-50, 0, 100]) for (const hunger of [0, 8])
      for (const gmBonus of [-0.2, 0.5]) for (const backlog of [0, 2]) {
        const f = fixture(mode);
        globalThis.game.settings.get = (_module, key) => key === SETTING_NORMAL_LABOR_QD ? normal : undefined;
        f.building.workerProfile = { modifiers: { types: [{ match: "type:Разнорабочий", percent }], backgrounds: [], traits: [] } };
        f.holding.gm.food.hungerLevel = hunger;
        f.holding.gm.efficiencyModifiers = { all: gmBonus / 2, production: gmBonus / 2 };
        f.building.maintenance = { schemaVersion: 1, requiredPoints: 1, backlogTendays: backlog };
        Object.assign(f.building.productionLines[0], { resourceId: "cloth", outputQty: 6, workQd: 3,
          overtime: true, expenses: "wood 2", fixedExpenses: "money 1" });
        if (mode === "staff") f.person.staffAppointment.overtimeQd = overtime;
        else Object.assign(f.person.workAllocations[0], { normalQd: normal, overtimeQd: overtime });
        f.holding.storage.resources = [{ id: "raw", resourceId: "wood", qty: 1000 }];
        const rawPlan = structuredClone(f.person);
        const spent = observeSpent(f);
        const label = JSON.stringify({ mode, normal, overtime, percent, hunger, gmBonus, backlog });
        const report = await run(f, `efficiency-${cases++}`);
        // Independent arithmetic: percentages are basis points, hours remain integers.
        const qualified = 10000 + percent * 100;
        const hungry = Math.floor(qualified * (10000 - hunger * 500) / 10000);
        const modified = Math.floor(hungry * Math.round((1 + gmBonus) * 10000) / 10000);
        const perQd = Math.floor(modified * (backlog ? 5000 : 10000) / 10000);
        const totalUnits = perQd * (normal + overtime);
        const completed = Math.floor(totalUnits / 30000), started = Math.ceil(totalUnits / 30000);
        assert.equal(spent(), normal + overtime, `${label}: modifiers never mint or remove physical QD`);
        assert.equal(f.building.productionLines[0].workProgressUnits, totalUnits % 30000, label);
        assert.equal(quantity(f.holding, "cloth"), completed * 6, label);
        assert.equal(quantity(f.holding, "wood"), 1000 - started * 2, `${label}: inputs follow started batches, not efficiency or allocated QD`);
        assert.equal(f.holding.storage.moneyCopper, 10000 - normal * 6 - overtime * 12 - started, `${label}: wages depend on physical QD`);
        assert.equal(report.finance.paidCopper, normal * 6 + overtime * 12);
        assert.deepEqual(f.person, rawPlan, `${label}: productivity never rewrites the resident's allocation`);
      }
  globalThis.game.settings.get = () => undefined;
  for (const mode of ["staff", "qd"]) for (const percent of [-100, -75, 0, 150]) {
    const f = fixture(mode), spent = observeSpent(f);
    f.building.workerProfile = { modifiers: { types: [{ match: "type:Разнорабочий", percent }], backgrounds: [], traits: [] } };
    Object.assign(f.building.productionLines[0], { active: false, requiresCollection: true, pendingQty: 8, collectQd: 2, autoCollect: "none" });
    await run(f, `collection-efficiency-${mode}-${percent}`);
    assert.equal(spent(), 2, "Collection always costs two physical QD, even at zero productive efficiency");
    assert.equal(quantity(f.holding, "wood"), 8);
  }
  for (const mode of ["staff", "qd"]) for (const percent of [-50, 0, 100]) for (const politics of [-50, 0, 50]) {
    const f = fixture(mode), spent = observeSpent(f);
    f.politics = politics;
    f.building.workerProfile = { modifiers: { types: [{ match: "type:Разнорабочий", percent }], backgrounds: [], traits: [] } };
    Object.assign(f.building.productionLines[0], { resourceId: "cloth", outputQty: 10, workQd: 1, expenses: "wood 10" });
    f.holding.storage.resources = [{ id: "raw", resourceId: "wood", qty: 1000 }];
    await run(f, `political-output-${mode}-${percent}-${politics}`);
    const prepared = 20 * (100 + percent) / 100 * 10;
    const output = prepared * (100 + politics) / 100;
    assert.equal(spent(), 20, "Political output effects do not change physical work or qualification work units");
    assert.equal(quantity(f.holding, "cloth"), output);
    assert.equal(quantity(f.holding, "wood"), 1000 - (politics < 0 ? output : prepared),
      "A political penalty refunds proportional ingredients; bonus output does not spend a second recipe");
    assert.equal(f.holding.storage.moneyCopper, 9880);
  }
  return { modifierCombinations: cases, collectionCombinations: 8, politicalOutputCombinations: 18 };
}

export async function checkZeroEfficiencyReserve() {
  for (const primary of ["production:main", "agriculture", "livestock"]) {
    const f = primary === "agriculture" ? fieldFixture() : fixture("staff");
    if (primary === "agriculture") {
      f.building.labor.mode = "staff";
      f.building.assignedWorkerIds = [f.person.id];
      f.person.workAllocationMode = "legacy"; f.person.workAllocations = []; f.person.workAssignment = f.building.id;
      f.person.staffAppointment = { version: 1, buildingId: f.building.id, primaryFunctionId: primary,
        reserveFunctionId: "income", wageDailyCopper: 12, overtimeQd: 0, volunteer: false, volunteerReason: "" };
    } else Object.assign(f.person.staffAppointment, { primaryFunctionId: primary, reserveFunctionId: "income" });
    if (primary === "livestock") {
      f.building.livestock = normalizeLivestockBuilding(DEFAULT_BUILDING_TEMPLATES.find((row) => row.id === "pasture").livestock);
      f.building.livestock.state.adults = 2;
      f.holding.storage.resources = [{ id: "feed", resourceId: f.building.livestock.profile.feedResourceId, qty: 1000 }];
    }
    f.building.functions.income = true;
    f.building.income = { base: 100, wageDailyCopper: 12 };
    f.building.workerProfile = { modifiers: { types: [{ match: "type:Разнорабочий", percent: -100 }], backgrounds: [], traits: [] } };
    const report = await run(f, `zero-efficiency-reserve-${primary}`);
    assert.equal(f.building.serviceState.workedQdByFunction.income, 20,
      `${primary}: zero productivity cannot keep selecting an impossible primary while a productive reserve is available`);
    assert.equal(report.finance.paidCopper, 120, "A reserve never adds a second wage");
    assert.equal(quantity(f.holding, "wood"), 0);
  }
}

export async function checkEffectiveCarePlanning() {
  const f = fixture();
  f.person.workAllocations = [];
  f.building.productionLines = [];
  f.building.livestock = normalizeLivestockBuilding({
    ...DEFAULT_BUILDING_TEMPLATES.find((row) => row.id === "pasture").livestock,
    profile: { careWorkQdPerDay: 2 }
  });
  f.building.livestock.state.adults = 2;
  f.holding.storage.resources = [{ id: "feed", resourceId: f.building.livestock.profile.feedResourceId, qty: 1000 }];
  f.building.workerProfile = { modifiers: { types: [{ match: "type:Разнорабочий", percent: 100 }], backgrounds: [], traits: [] } };
  const proposed = proposeWorkforceAssignments(f.holding, createWorkforceDraft(f.holding, f.harness), f.harness, { isGM: true });
  assert.equal(proposed.changes[0].after, 10, "Two effective care QD per day need one physical QD at 200% productivity");
  const task = proposed.model.taskMap.get("workshop::livestock");
  assert.equal(task.careGap, 0);
  assert.equal(task.effectiveRemaining, 0);
  assert.equal(proposed.model.people[0].free, 10, "Care productivity must leave the unused physical time available for other tasks");
  f.person.workAllocations = proposed.draft.allocations[f.person.id];
  const report = await run(f, "effective-care");
  assert.equal(report.livestock.workQdUsed, 20, "The daily executor agrees with the effective workload");
  assert.equal(report.finance.paidCopper, 60, "Only the ten physical QD are assigned and paid");
}

export async function checkProductionSeasonBoundary() {
  const previous = globalThis.CALENDARIA;
  const months = ["Хладоход", "Теплорост", "Теплоход", "Зноерост", "Зноеход", "Дождерост", "Дождеход", "Хладорост"]
    .map((name, index) => ({ name, numericRepresentation: index + 1 }));
  globalThis.CALENDARIA = { api: {
    getActiveCalendar: () => ({ days: { hoursPerDay: 24 }, monthsArray: months }),
    addHours: (date, hours) => {
      const total = (date.month - 1) * 720 + (date.day - 1) * 24 + date.hour + hours;
      return { ...date, month: Math.floor(total / 720) + 1, day: Math.floor(total % 720 / 24) + 1, hour: total % 24 };
    }
  } };
  try {
    for (const mode of ["staff", "qd"]) for (const summer of [false, true]) {
      const f = fixture(mode);
      f.holding.gm.calendaria.lastDateTime = { year: 1, month: 3, day: 30, hour: 18, minute: 0 };
      f.building.productionLines[0].seasons = { spring: !summer, summer, autumn: false, winter: false };
      await run(f, `season-boundary-${mode}-${summer}`);
      assert.equal(quantity(f.holding, "wood"), summer ? 20 : 0, "The first elapsed QD belongs to the new season, not the already-settled boundary");
    }
  } finally { globalThis.CALENDARIA = previous; }
}

export async function checkAgricultureEfficiency() {
  let cases = 0;
  for (const mode of ["staff", "qd"]) for (const percent of [-75, 0, 150])
    for (const politics of [-50, 0, 50]) for (const hunger of [0, 6]) for (const backlog of [0, 2]) {
      const f = fixture(mode), spent = observeSpent(f);
      f.politics = politics;
      f.building.productionLines = [];
      f.building.agriculture = fieldFixture().building.agriculture;
      Object.assign(f.building.agriculture.crops[0], { outputQty: 1000, harvestWorkQd: 1000 });
      f.building.agriculture.state = { phase: "ready", cropId: "grain", harvestYear: "1", harvestsThisYear: 1,
        readyQty: 1000, harvestTotalQty: 1000, harvestWorkQdTotal: 1000, harvestedQty: 0, readyAgeQd: 0, readySeasonKey: "1:spring" };
      f.building.workerProfile = { modifiers: { types: [{ match: "type:Разнорабочий", percent }], backgrounds: [], traits: [] } };
      f.holding.gm.food.hungerLevel = hunger;
      f.holding.gm.efficiencyModifiers = { all: 0.1, production: 0.3 };
      f.building.maintenance = { schemaVersion: 1, requiredPoints: 1, backlogTendays: backlog };
      if (mode === "staff") f.person.staffAppointment.primaryFunctionId = "agriculture";
      else f.person.workAllocations[0].functionId = "agriculture";
      const label = JSON.stringify({ mode, percent, politics, hunger, backlog });
      const report = await run(f, `agriculture-efficiency-${cases++}`);
      const hungry = Math.floor((10000 + percent * 100) * (10000 - hunger * 500) / 10000);
      const modified = Math.floor(hungry * 14000 / 10000);
      const political = Math.round(modified * (100 + politics) / 100);
      const perQd = Math.floor(political * (backlog ? 5000 : 10000) / 10000);
      const effective = Math.floor(perQd * 20 / 10000);
      assert.equal(spent(), 20, `${label}: sowing/harvesting uses the same twenty physical QD`);
      assert.equal(report.agriculture.workQdUsed, effective, label);
      assert.equal(quantity(f.holding, "grain"), effective, label);
      assert.equal(f.holding.storage.moneyCopper, 9880, label);
      assert.ok(report.work.some((text) => text.includes(`${effective} эффективных QD`)), "The report labels productive work, not physical time");
    }
  return { agriculturalModifierCombinations: cases };
}

export async function checkCapacityAndQualificationSources() {
  for (const mode of ["staff", "qd"]) for (const normal of [0, 1, 7, 16, 20]) for (const child of [false, true]) {
    const f = fixture(mode), spent = observeSpent(f);
    globalThis.game.settings.get = (_module, key) => key === SETTING_NORMAL_LABOR_QD ? normal : undefined;
    Object.assign(f.person, { age: child ? 13 : 30, ageGroup: child ? "Ре" : "Вз", race: "Человек" });
    const budget = child ? Math.floor(normal / 2) : normal;
    if (mode === "qd") { f.person.workAllocations[0].normalQd = budget; f.building.labor.capacityQd = budget; }
    f.building.workerProfile = { modifiers: {
      types: [{ match: "type:Разнорабочий", percent: 50 }],
      backgrounds: [{ match: "Лекарь", percent: 10 }],
      traits: [{ match: "Грамотный", percent: 20 }, { match: "Ленивый", percent: -5 }]
    } };
    Object.assign(f.person, { background: "Лекарь", traits: ["Грамотный", "Ленивый"] });
    const report = await run(f, `personal-budget-${mode}-${normal}-${child}`);
    assert.equal(f.harness._workerEfficiencyForPerson(f.holding, f.building, f.person).workUnits, 17500,
      "Type, background, one positive trait and one negative trait add to productive units");
    assert.equal(spent(), budget);
    assert.equal(quantity(f.holding, "wood"), Math.floor(budget * 1.75));
    assert.equal(report.finance.paidCopper, budget * 6);
    assert.equal(f.building.productionLines[0].workProgressUnits ?? 0, budget * 17500 % 10000);
  }
  globalThis.game.settings.get = () => undefined;
  const f = fixture();
  f.building.workerProfile = { modifiers: { types: [{ match: "type:Разнорабочий", percent: 75 }], backgrounds: [], traits: [] } };
  f.holding.gm.food.hungerLevel = 8;
  f.holding.gm.efficiencyModifiers = { all: 0.1, production: 0.3 };
  f.building.maintenance = { schemaVersion: 1, requiredPoints: 1, backlogTendays: 2 };
  f.building.functions.culture = true;
  const model = buildWorkforceModel(f.holding, createWorkforceDraft(f.holding, f.harness), f.harness, { isGM: true });
  const candidate = workforceCandidate(model, model.people[0], model.taskMap.get("workshop::production:main"), f.harness);
  assert.equal(candidate.efficiencyText, "175%");
  assert.equal(candidate.effectiveLabor, 0.735, "Display distinguishes qualification from hunger, GM and equipment effects");
  assert.equal(candidate.effectiveLaborText, "0,735 эфф. QD / QD");
  assert.equal(candidate.capacity.normalQd, 20);
  const serviceCandidate = workforceCandidate(model, model.people[0], model.taskMap.get("workshop::culture"), f.harness);
  assert.equal(serviceCandidate.effectiveLabor, 1, "Production proficiency cannot manufacture institutional service hours");
}

export async function checkLivestockEfficiency() {
  let cases = 0;
  for (const mode of ["staff", "qd"]) for (const percent of [-50, 0, 100])
    for (const politics of [0, 50]) for (const hunger of [0, 8]) for (const backlog of [0, 2]) {
      const f = fixture(mode), spent = observeSpent(f);
      f.building.productionLines = [];
      f.building.livestock = normalizeLivestockBuilding({
        ...DEFAULT_BUILDING_TEMPLATES.find((row) => row.id === "pasture").livestock,
        profile: { careWorkQdPerDay: 2, producesMilk: true, milkPerHeadDay: 1,
          grazingSeasons: [], headsPerFeedUnit: 1, feedUnitsPerHead: 1 },
        operations: { milk: true }
      });
      f.building.livestock.state.adults = 2;
      if (mode === "staff") f.person.staffAppointment.primaryFunctionId = "livestock";
      else f.person.workAllocations[0].functionId = "livestock";
      f.building.workerProfile = { modifiers: { types: [{ match: "type:Разнорабочий", percent }], backgrounds: [], traits: [] } };
      f.holding.gm.food.hungerLevel = hunger;
      f.holding.gm.efficiencyModifiers = { all: 0.1, production: 0.3 };
      f.building.maintenance = { schemaVersion: 1, requiredPoints: 1, backlogTendays: backlog };
      f.politics = politics;
      f.holding.storage.resources = [{ id: "feed", resourceId: "animal-feed", qty: 1000 }];
      const planned = structuredClone(f.person);
      const report = await run(f, `livestock-efficiency-${cases++}`);
      const hungry = Math.floor((10000 + percent * 100) * (10000 - hunger * 500) / 10000);
      const modified = Math.floor(hungry * 14000 / 10000);
      const political = Math.round(modified * (100 + politics) / 100);
      const perQd = Math.floor(political * (backlog ? 5000 : 10000) / 10000);
      const cared = perQd * 2 >= 20000;
      assert.equal(report.livestock.workQdUsed, cared ? 20 : 0, "Care must be covered on each day, using effective work");
      assert.equal(quantity(f.holding, "milk"), cared ? 20 : 0);
      assert.equal(quantity(f.holding, "animal-feed"), 998, "Productivity never multiplies the number of mouths or feed consumed");
      assert.equal(report.finance.paidCopper, 120, "Twenty assigned physical QD have the same wage at every productivity");
      if (mode === "staff") assert.equal(spent(), Math.min(2, Math.ceil(20000 / perQd)) * 10,
        "Staff stop care when the daily effective need is met; extra productivity is not a new time slot");
      assert.deepEqual(f.person, planned);
    }
  return { livestockModifierCombinations: cases };
}

export async function checkResidentWorkcycle(only = "") {
  const previous = { game: globalThis.game, view: SkyholdData.view };
  globalThis.game = { user: { isGM: true }, settings: { get: () => undefined } };
  try {
    if (!only || only === "agriculture") await checkScheduledAgriculture();
    if (!only || only === "inputs") await checkProductionSharedInputs();
    if (!only || only === "planner") checkPlannerWorkUnits();
    if (!only || only === "efficiency") await checkPhysicalAndEffectiveQd();
    if (!only || only === "zero") await checkZeroEfficiencyReserve();
    if (!only || only === "care") await checkEffectiveCarePlanning();
    if (!only || only === "season") await checkProductionSeasonBoundary();
    if (!only || only === "agriculture-efficiency") await checkAgricultureEfficiency();
    if (!only || only === "capacity") await checkCapacityAndQualificationSources();
    if (!only || only === "livestock-efficiency") await checkLivestockEfficiency();
  } finally { globalThis.game = previous.game; SkyholdData.view = previous.view; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkResidentWorkcycle(process.argv[2]);
  console.log("Resident workcycle checks passed.");
}
