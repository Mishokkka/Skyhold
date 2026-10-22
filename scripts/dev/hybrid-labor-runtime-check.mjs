import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createEconomyHarness, makeHolding } from "./economy-characterization-check.mjs";
import { SETTING_NORMAL_LABOR_QD } from "../data/constants.js";
import { SkyholdData } from "../data/store.js";
import { DEFAULT_BUILDING_TEMPLATES } from "../data/building-templates.js";
import { readFileSync } from "node:fs";

const quantity = (holding, resourceId) => (holding.storage.resources ?? [])
  .filter((row) => row.resourceId === resourceId).reduce((sum, row) => sum + row.qty, 0);

export function hybridRuntimeFixture({ count = 1, goal = 5, reverse = false } = {}) {
  const holding = makeHolding();
  holding.id = "hybrid-runtime";
  holding.storage.moneyCopper = 10000;
  holding.people.list = Array.from({ length: count }, (_, index) => ({
    id: `worker-${index}`, name: `Worker ${index}`, age: 30,
    workAssignment: "workshop", workAllocationMode: "legacy", workAllocations: [],
    wageDailyOverrideCopper: 999,
    staffAppointment: {
      version: 1, buildingId: "workshop", primaryFunctionId: "production:main",
      reserveFunctionId: "production:reserve", wageDailyCopper: 12,
      overtimeQd: 0, volunteer: false, volunteerReason: ""
    }
  }));
  const line = (id, resourceId, wageDailyCopper) => ({
    id, source: "workers", resourceId, outputQty: 1, workQd: 1,
    wageDailyCopper, active: true
  });
  holding.buildings.list = [{
    id: "workshop", name: "Workshop", constructionStatus: "built", status: "Построено",
    labor: { version: 1, mode: "staff", capacityQd: null },
    workersMin: 0, workersMax: count, assignedWorkerIds: holding.people.list.map((person) => person.id),
    functions: { production: true },
    productionLines: [line("main", "wood", 50), line("reserve", "stone", 90)]
  }];
  if (reverse) holding.buildings.list[0].productionLines.reverse();
  holding.workforcePlan = { version: 2, goals: [], locks: [], productionGoals: goal === null ? [] : [{
    sourceId: "workshop", functionId: "production:main", preparedUnits: goal
  }] };
  const harness = createEconomyHarness();
  harness._runFoodConsumptionForQd = () => {};
  return { holding, harness, building: holding.buildings.list[0], person: holding.people.list[0] };
}

async function run(fixture, id = "hybrid") {
  const previousView = SkyholdData.view;
  SkyholdData.view = () => ({ holdings: [fixture.holding], catalog: {} });
  try {
    return await fixture.harness._runEconomyForQd(fixture.holding, 40, { operationId: id });
  } finally {
    SkyholdData.view = previousView;
  }
}

export async function checkHybridLaborRuntime() {
  const previousGame = globalThis.game;
  let normalQd = 20;
  globalThis.game = { settings: { get: (_module, key) => key === SETTING_NORMAL_LABOR_QD ? normalQd : undefined } };
  try {
    for (const value of [0, 1, 7, 16, 19, 20]) {
      normalQd = value;
      for (const reverse of [false, true]) {
        const fixture = hybridRuntimeFixture({ goal: 2, reverse });
        await run(fixture, `norm-${value}-${reverse}`);
        assert.equal(quantity(fixture.holding, "wood"), Math.min(value, 2));
        assert.equal(quantity(fixture.holding, "stone"), Math.max(0, value - 2));
        assert.equal(fixture.holding.storage.moneyCopper, 10000 - value * 6,
          "The explicit staff contract has one price, including when line and former personal rates differ");
        assert.equal(fixture.building.serviceState.workedQd, value);
        if (!value) assert.equal(fixture.building.serviceState.active, false);
        assert.ok(fixture.person.staffAppointment, "A zero norm must not remove the permanent appointment");
      }
    }
    normalQd = 20;
    const team = hybridRuntimeFixture({ count: 2, goal: 5 });
    await run(team, "team-goal");
    assert.equal(quantity(team.holding, "wood"), 5, "A production goal belongs to the line, not to each worker");
    assert.equal(quantity(team.holding, "stone"), 35);
    assert.equal(team.holding.storage.moneyCopper, 9760);

    const efficient = hybridRuntimeFixture({ goal: 5 });
    efficient.harness._personBuildingEfficiency = () => 4;
    await run(efficient, "efficient-goal");
    assert.equal(quantity(efficient.holding, "wood"), 5,
      "Several batches inside one efficient QD still share the same exact goal");
    assert.equal(quantity(efficient.holding, "stone"), 72);
    assert.equal(efficient.building.serviceState.workedQdByFunction["production:main"], 2);

    const repeated = hybridRuntimeFixture({ goal: 5 });
    await run(repeated, "goal-period-one");
    repeated.holding.gm.calendaria.lastQd = 40;
    await run(repeated, "goal-period-two");
    assert.equal(quantity(repeated.holding, "wood"), 10, "The shared preparation goal starts afresh each tenday");
    assert.equal(quantity(repeated.holding, "stone"), 30);

    normalQd = 1;
    const ongoing = hybridRuntimeFixture({ goal: null });
    Object.assign(ongoing.building.productionLines[0], { outputQty: 10, workQd: 3 });
    await run(ongoing, "ongoing-start");
    assert.equal(ongoing.building.productionLines[0].workProgressUnits, 10000);
    normalQd = 20;
    ongoing.holding.gm.calendaria.lastQd = 40;
    ongoing.holding.workforcePlan.productionGoals = [{ sourceId: "workshop", functionId: "production:main", preparedUnits: 5 }];
    const ongoingReport = await run(ongoing, "ongoing-finish");
    assert.equal(quantity(ongoing.holding, "wood"), 10,
      "An already funded batch must finish whole when the next tenday's goal is smaller");
    assert.equal(quantity(ongoing.holding, "stone"), 18);
    assert.ok(ongoingReport.work.some((line) => line.includes("начатая партия завершена целиком")));

    const partial = hybridRuntimeFixture({ count: 2, goal: 5 });
    Object.assign(partial.building.productionLines[0], { outputQty: 30, workQd: 30, batchCapacity: 30, batchStartQty: 1 });
    await run(partial, "partial-goal");
    assert.equal(quantity(partial.holding, "wood"), 5);
    assert.equal(quantity(partial.holding, "stone"), 35);

    const incompatible = hybridRuntimeFixture({ goal: 5 });
    Object.assign(incompatible.building.productionLines[0], { outputQty: 3, workQd: 1 });
    const incompatibleReport = await run(incompatible, "indivisible-goal");
    assert.equal(quantity(incompatible.holding, "wood"), 3, "An indivisible next batch cannot silently overrun the goal");
    assert.equal(quantity(incompatible.holding, "stone"), 19);
    assert.ok(incompatibleReport.skipped.some((line) => line.includes("цель подготовки не выполнена")));

    const waiting = hybridRuntimeFixture({ goal: 2 });
    Object.assign(waiting.building.productionLines[0], {
      outputQty: 2, waitDays: 1, requiresCollection: true, collectQd: 2, autoCollect: "none"
    });
    const waitingReport = await run(waiting, "waiting-collection");
    assert.equal(quantity(waiting.holding, "wood"), 2);
    assert.equal(quantity(waiting.holding, "stone"), 17,
      "Preparation plus two collection QD leave seventeen QD for reserve work");
    assert.equal(waiting.building.productionLines[0].pendingQty, 0);
    assert.equal(waiting.building.serviceState.workedQdByFunction["production:main"], 3);
    assert.equal(waiting.holding.storage.moneyCopper, 9880);
    assert.equal(waitingReport.skipped.filter((line) => line.includes("не хватает рабочих QD для сбора")).length, 0,
      "Waiting for the rest of today's funded collection budget is not a failed collection");

    const returning = hybridRuntimeFixture({ goal: 2 });
    Object.assign(returning.building.productionLines[0], { waitDays: 1 });
    let trace = [];
    const finishStaff = returning.harness._finishStaffExecution;
    returning.harness._finishStaffExecution = function (holding, report, finance) {
      trace = [...finance.staffWorkLedger];
      return finishStaff.call(this, holding, report, finance);
    };
    await run(returning, "return-to-primary");
    const firstReserve = trace.findIndex((row) => row.functionId === "production:reserve");
    assert.ok(firstReserve >= 0);
    assert.ok(trace.slice(firstReserve + 1).some((row) => row.functionId === "production:main"),
      "The next available primary batch interrupts reserve work after waiting");
    assert.equal(quantity(returning.holding, "wood"), 2);

    const parallel = hybridRuntimeFixture({ goal: 3 });
    Object.assign(parallel.building.productionLines[0], { waitDays: 20, batchCapacity: 3 });
    await run(parallel, "parallel-wait");
    assert.equal(parallel.building.productionLines[0].waitingBatches.length, 3,
      "An old waiting batch does not prevent preparing the next one while equipment has room");
    assert.equal(quantity(parallel.holding, "stone"), 17);
    assert.equal(quantity(parallel.holding, "wood"), 0);
    parallel.holding.gm.calendaria.lastQd = 40;
    await run(parallel, "parallel-next-tenday");
    assert.equal(quantity(parallel.holding, "stone"), 37,
      "An occupied primary can use the reserve for the next full, fresh tenday");
    assert.equal(parallel.holding.storage.moneyCopper, 9760);

    const duty = hybridRuntimeFixture({ goal: null });
    duty.building.functions.culture = true;
    duty.building.wageDailyCopper = 12;
    duty.person.staffAppointment.primaryFunctionId = "culture";
    await run(duty, "continuous-duty");
    assert.equal(quantity(duty.holding, "stone"), 0, "No visitors does not release a staff member from duty");
    assert.equal(duty.building.serviceState.workedQdByFunction.culture, 20);
    assert.equal(duty.building.serviceState.workedQdByFunction["production:reserve"], undefined);

    const reserveDuty = hybridRuntimeFixture({ goal: 5 });
    reserveDuty.building.functions.culture = true;
    reserveDuty.building.wageDailyCopper = 12;
    reserveDuty.person.staffAppointment.reserveFunctionId = "culture";
    await run(reserveDuty, "reserve-duty");
    assert.equal(quantity(reserveDuty.holding, "wood"), 5);
    assert.equal(reserveDuty.building.serviceState.workedQdByFunction.culture, 15);
    assert.equal(reserveDuty.building.serviceState.workedQdByFunction["production:main"], 5);

    const income = hybridRuntimeFixture({ goal: 5 });
    income.building.functions.income = true;
    income.building.income = { base: 200, perWorker: 0 };
    income.person.staffAppointment.reserveFunctionId = "income";
    await run(income, "reserve-income");
    assert.equal(income.holding.storage.moneyCopper, 10030,
      "Fifteen actual income QD yield three quarters of fixed income, with the single salary still paid");

    const cashback = hybridRuntimeFixture({ goal: 5 });
    cashback.building.templateId = "personnel-office";
    cashback.building.functions.income = true;
    cashback.building.income = { base: 0, perWorker: 0 };
    cashback.person.staffAppointment.reserveFunctionId = "income";
    const outsidePerson = structuredClone(cashback.person);
    Object.assign(outsidePerson, { id: "outside", workAssignment: "external-service" });
    Object.assign(outsidePerson.staffAppointment, { buildingId: "external-service", primaryFunctionId: "culture", reserveFunctionId: "" });
    cashback.holding.people.list.push(outsidePerson);
    cashback.holding.buildings.list.push({
      id: "external-service", name: "Other", constructionStatus: "built", functions: { culture: true },
      labor: { version: 1, mode: "staff", capacityQd: null }, workersMin: 0, workersMax: 1,
      assignedWorkerIds: ["outside"], wageDailyCopper: 12
    });
    const cashbackReport = await run(cashback, "actual-office-cashback");
    assert.equal(cashbackReport.finance.personnelOfficeCashbackCopper, 9,
      "The personnel office reimburses 75% of its ten-percent allowance after actual reserve service");
    assert.equal(cashback.holding.storage.moneyCopper, 9769);

    const invalid = hybridRuntimeFixture();
    invalid.person.workAssignment = "soldier";
    const invalidReport = await run(invalid, "invalid-contract");
    assert.ok(invalidReport.finance.invalidWorkerIds.includes(invalid.person.id));
    assert.equal(quantity(invalid.holding, "wood"), 0);
    assert.equal(quantity(invalid.holding, "stone"), 0);
    assert.equal(invalid.holding.storage.moneyCopper, 10000,
      "An incompatible contract cannot silently lose its wage while still producing work");

    for (const child of [true, false]) {
      const excessiveOvertime = hybridRuntimeFixture();
      excessiveOvertime.person.staffAppointment.overtimeQd = 1;
      excessiveOvertime.building.productionLines[0].overtime = true;
      if (child) Object.assign(excessiveOvertime.person, { age: 13, ageGroup: "Ре" });
      else normalQd = 0;
      const report = await run(excessiveOvertime, `invalid-overtime-${child}`);
      assert.ok(report.finance.invalidWorkerIds.includes(excessiveOvertime.person.id),
        "Overtime above the personal cap must be reported, not silently rewritten into a different contract");
      assert.equal(excessiveOvertime.person.staffAppointment.overtimeQd, 1);
      assert.equal(excessiveOvertime.holding.storage.moneyCopper, 10000);
      assert.equal(quantity(excessiveOvertime.holding, "wood"), 0);
      assert.equal(quantity(excessiveOvertime.holding, "stone"), 0);
      normalQd = 20;
    }

    const paused = hybridRuntimeFixture({ goal: 5 });
    paused.building.productionLines[0].active = false;
    await run(paused, "paused-primary");
    assert.equal(quantity(paused.holding, "wood"), 0);
    assert.equal(quantity(paused.holding, "stone"), 20);
    assert.equal(paused.holding.storage.moneyCopper, 9880);
    assert.equal(paused.person.staffAppointment.primaryFunctionId, "production:main");

    const unavailableBuilding = hybridRuntimeFixture({ goal: null });
    unavailableBuilding.building.constructionStatus = "paused";
    await run(unavailableBuilding, "temporarily-unavailable-building");
    assert.equal(unavailableBuilding.holding.storage.moneyCopper, 9880, "A retained contract pays forced idle while its building is temporarily unavailable");
    assert.equal(quantity(unavailableBuilding.holding, "wood"), 0);
    assert.equal(quantity(unavailableBuilding.holding, "stone"), 0);
    assert.ok(unavailableBuilding.person.staffAppointment);

    const pausedCollection = hybridRuntimeFixture({ goal: null });
    Object.assign(pausedCollection.building.productionLines[0], {
      active: false, pendingQty: 3, requiresCollection: true, collectQd: 2, autoCollect: "none"
    });
    await run(pausedCollection, "paused-staff-collection");
    assert.equal(quantity(pausedCollection.holding, "wood"), 3);
    assert.equal(quantity(pausedCollection.holding, "stone"), 18);

    const qdCollection = hybridRuntimeFixture({ goal: null });
    qdCollection.building.labor.mode = "qd";
    qdCollection.building.assignedWorkerIds = [];
    Object.assign(qdCollection.building.productionLines[0], {
      active: false, pendingQty: 3, requiresCollection: true, collectQd: 2, autoCollect: "none", wageDailyCopper: 12
    });
    delete qdCollection.person.staffAppointment;
    delete qdCollection.person.wageDailyOverrideCopper;
    qdCollection.person.workAllocationMode = "explicit";
    qdCollection.person.workAllocations = [{ sourceId: "workshop", functionId: "production:main", normalQd: 2, overtimeQd: 0 }];
    const qdCollectionReport = await run(qdCollection, "paused-qd-collection");
    assert.equal(qdCollectionReport.skipped.filter((line) => line.includes("не хватает рабочих QD для сбора")).length, 0);
    assert.equal(qdCollectionReport.skipped.filter((line) => line.includes("сбор не завершён")).length, 0);
    assert.equal(quantity(qdCollection.holding, "wood"), 3);
    assert.equal(quantity(qdCollection.holding, "stone"), 0);
    assert.equal(qdCollection.holding.storage.moneyCopper, 9988);
    const insufficientCollection = { ...qdCollection, holding: structuredClone(qdCollection.holding) };
    insufficientCollection.building = insufficientCollection.holding.buildings.list[0];
    insufficientCollection.person = insufficientCollection.holding.people.list[0];
    Object.assign(insufficientCollection.building.productionLines[0], { pendingQty: 4, collectQd: 3 });
    insufficientCollection.holding.gm.calendaria.lastQd = 40;
    const insufficientReport = await run(insufficientCollection, "insufficient-qd-collection");
    assert.equal(insufficientCollection.building.productionLines[0].pendingQty, 4);
    assert.equal(insufficientReport.skipped.filter((line) => line.includes("сбор не завершён")).length, 1,
      "An actually unfinished collection still gets one warning at period end");

    const scopedFetch = hybridRuntimeFixture({ goal: null });
    scopedFetch.building.labor.mode = "qd";
    scopedFetch.building.assignedWorkerIds = [];
    Object.assign(scopedFetch.building.productionLines[0], { resourceId: "grain", expenses: "wood 2", wageDailyCopper: 12 });
    scopedFetch.building.productionLines[1].wageDailyCopper = 12;
    delete scopedFetch.person.staffAppointment;
    delete scopedFetch.person.wageDailyOverrideCopper;
    scopedFetch.person.workAllocationMode = "explicit";
    scopedFetch.person.workAllocations = ["main", "reserve"].map((id) => ({
      sourceId: "workshop", functionId: `production:${id}`, normalQd: 1, overtimeQd: 0
    }));
    const supply = { id: "supplier", constructionStatus: "built", functions: { production: true }, productionLines: [{
      id: "wood-stock", source: "workers", active: false, resourceId: "wood", pendingQty: 2,
      requiresCollection: true, collectQd: 2, autoCollect: "worker"
    }] };
    scopedFetch.holding.buildings.list.push(supply);
    await run(scopedFetch, "scoped-ingredient-collection");
    assert.equal(supply.productionLines[0].pendingQty, 2,
      "Fetching ingredients cannot borrow the separate QD assignment of another line");
    assert.equal(quantity(scopedFetch.holding, "grain"), 0);
    assert.equal(quantity(scopedFetch.holding, "stone"), 1);

    const idle = hybridRuntimeFixture({ goal: null });
    idle.person.staffAppointment.reserveFunctionId = "";
    idle.building.productionLines[0].expenses = "grain 2";
    const idleReport = await run(idle, "forced-idle");
    assert.equal(idle.holding.storage.moneyCopper, 9880, "Forced idle is paid at the single staff rate");
    assert.equal(idle.building.serviceState.workedQd, 0);
    assert.ok(idleReport.work.some((line) => line.includes("оплачиваемый простой 20 QD")));

    const overtime = hybridRuntimeFixture({ goal: 5 });
    overtime.person.staffAppointment.overtimeQd = 3;
    overtime.building.productionLines[1].overtime = true;
    await run(overtime, "staff-overtime");
    assert.equal(quantity(overtime.holding, "wood"), 5);
    assert.equal(quantity(overtime.holding, "stone"), 18);
    assert.equal(overtime.holding.storage.moneyCopper, 9844);

    const timed = hybridRuntimeFixture({ goal: null });
    Object.assign(timed.building.productionLines[0], {
      source: "time", period: "qd", workQd: 1, outputQty: 2, repeat: false,
      requiresCollection: true, collectQd: 1, autoCollect: "none"
    });
    await run(timed, "timed-collection");
    assert.equal(quantity(timed.holding, "wood"), 2, "A timed line can receive a collector without becoming a worker recipe");
    assert.equal(quantity(timed.holding, "stone"), 19);

    const oversizedCollection = hybridRuntimeFixture({ goal: 1 });
    Object.assign(oversizedCollection.building.productionLines[0], {
      requiresCollection: true, collectQd: 3, autoCollect: "none"
    });
    const oversizedReport = await run(oversizedCollection, "oversized-collection");
    assert.equal(quantity(oversizedCollection.holding, "wood"), 0);
    assert.equal(oversizedCollection.building.productionLines[0].pendingQty, 1);
    assert.equal(quantity(oversizedCollection.holding, "stone"), 19,
      "Impossible indivisible collection must not trap the worker away from the reserve forever");
    assert.equal(oversizedReport.skipped.filter((line) => line.includes("сбор требует 3 QD за один день")).length, 1);

    for (const mode of ["staff", "qd"]) {
      const manual = hybridRuntimeFixture();
      manual.building.labor.mode = mode;
      const line = manual.building.productionLines[0];
      Object.assign(line, { pendingQty: 3, collectQd: 1 });
      for (const isGM of [false, true]) {
        globalThis.game.user = { isGM };
        assert.equal(manual.harness._collectProductionLine(manual.holding, manual.building, line).ok, false,
          "Ordinary manual collection cannot bypass labor, including a GM click");
        assert.equal(line.pendingQty, 3);
      }
      globalThis.game.user = { isGM: false };
      assert.equal(manual.harness._collectProductionLine(manual.holding, manual.building, line, { ignoreWorkTime: true }).ok, false);
      globalThis.game.user = { isGM: true };
      assert.equal(manual.harness._collectProductionLine(manual.holding, manual.building, line, { ignoreWorkTime: true }).ok, true);
      assert.equal(quantity(manual.holding, "wood"), 3);
      Object.assign(line, { pendingQty: 2, collectQd: 0 });
      globalThis.game.user = { isGM: false };
      assert.equal(manual.harness._collectProductionLine(manual.holding, manual.building, line).ok, true);
      assert.equal(quantity(manual.holding, "wood"), 5);
    }
    assert.match(readFileSync(new URL("../apps/domains/events/building-events.js", import.meta.url), "utf8"),
      /ignoreWorkTime: buildingLaborMode\(building\) === "legacy"/,
      "The ordinary building button must not automatically request a hybrid GM override");

    const care = hybridRuntimeFixture({ goal: null });
    care.person.staffAppointment.primaryFunctionId = "livestock";
    care.building.livestock = {
      enabled: true, speciesId: "cattle", gmPriority: 500,
      state: { adults: 3, breedingMales: 0, young: [] },
      operations: { milk: false, shearQty: 0, slaughterQty: 0, feedPriority: "adults" }
    };
    care.harness._livestockSeasonContext = () => ({ seasonId: "summer", seasonKey: "1:summer" });
    const careReport = await run(care, "daily-care");
    assert.equal(care.building.serviceState.workedQdByFunction.livestock, 10);
    assert.equal(quantity(care.holding, "stone"), 10, "Daily care leaves one normal QD per day for the reserve");
    assert.equal(careReport.livestock.workQdUsed, 10);
    assert.deepEqual(careReport.livestock.warnings, []);

    const field = hybridRuntimeFixture({ goal: null });
    field.person.staffAppointment.primaryFunctionId = "agriculture";
    field.person.staffAppointment.reserveFunctionId = "culture";
    field.building.functions.culture = true;
    field.building.wageDailyCopper = 12;
    field.building.agriculture = structuredClone(DEFAULT_BUILDING_TEMPLATES.find((row) => row.id === "grain-field").agriculture);
    field.building.agriculture.crops = [{
      id: "grain", label: "Grain", resourceId: "grain", outputQty: 8,
      sowingSeasons: ["spring"], sowingWorkQd: 1, growingQd: 8, harvestWorkQd: 2,
      expiryRule: "qd", readyExpiryQd: 120, annualHarvestLimit: 1, perennial: false
    }];
    field.harness._agricultureCalendarContext = () => ({ year: "1", seasonId: "spring", seasonKey: "1:spring" });
    await run(field, "staff-field-reserve");
    assert.equal(quantity(field.holding, "grain"), 8);
    assert.equal(field.building.serviceState.workedQdByFunction.agriculture, 3);
    assert.equal(field.building.serviceState.workedQdByFunction.culture, 17,
      "Sowing and harvesting share actual personal time with reserve duty while crop growth is calendar time");

    for (const unsupportedPeriod of [4, 80]) {
      const fixture = hybridRuntimeFixture();
      const original = structuredClone(fixture.holding);
      await assert.rejects(() => fixture.harness._runEconomyForQd(fixture.holding, unsupportedPeriod), /по одному десятнику/);
      assert.deepEqual(fixture.holding, original, "Unsupported period length must be rejected before any money or world draft changes");
    }
  } finally {
    globalThis.game = previousGame;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkHybridLaborRuntime();
  console.log("Hybrid labor runtime: fixed wages, norms, shared goals, waiting, collection, duty, idle, overtime and independent line order passed.");
}
