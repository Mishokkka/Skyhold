import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hybridRuntimeFixture } from "./hybrid-labor-runtime-check.mjs";
import { SETTING_NORMAL_LABOR_QD } from "../data/constants.js";
import { SkyholdData } from "../data/store.js";
import { productionBatchStates, productionOccupiedQty } from "../engines/economy/production-capacity.js";
import { productionTiming, validProductionTiming } from "../engines/economy/production-timing.js";
import { workforceProductionGoalState } from "../apps/domains/workforce-task-state.js";
import { DEFAULT_BUILDING_TEMPLATES } from "../data/building-templates.js";
import { allResourceDefs } from "../core/resources.js";

const quantity = (holding, resourceId) => (holding.storage.resources ?? [])
  .filter((row) => row.resourceId === resourceId).reduce((sum, row) => sum + row.qty, 0);

function fixture(mode, { goal = null, count = 1, normalQd = 20, reverse = false } = {}) {
  const f = hybridRuntimeFixture({ goal, count, reverse });
  f.building.labor.mode = mode;
  if (mode === "qd") {
    f.building.assignedWorkerIds = [];
    for (const person of f.holding.people.list) {
      delete person.staffAppointment;
      delete person.wageDailyOverrideCopper;
      person.workAssignment = "";
      person.workAllocationMode = "explicit";
      person.workAllocations = [{ sourceId: f.building.id, functionId: "production:main", normalQd, overtimeQd: 0 }];
    }
  } else if (!reverse) f.person.staffAppointment.reserveFunctionId = "";
  for (const line of f.building.productionLines) line.wageDailyCopper = 12;
  return f;
}

async function withRuntime(check) {
  const previous = { game: globalThis.game, view: SkyholdData.view };
  globalThis.game = { settings: { get: (_module, key) => key === SETTING_NORMAL_LABOR_QD ? 20 : undefined } };
  try { return await check(); }
  finally { globalThis.game = previous.game; SkyholdData.view = previous.view; }
}

async function run(f, operationId) {
  SkyholdData.view = () => ({ holdings: [f.holding], catalog: {} });
  return f.harness._runEconomyForQd(f.holding, 40, { operationId });
}

export async function checkHybridProductionCollection() {
  return withRuntime(async () => {
    for (const mode of ["staff", "qd"]) for (const autoCollect of ["none", "building", "worker"]) {
      const f = fixture(mode);
      f.building.productionLines.splice(1);
      Object.assign(f.building.productionLines[0], { requiresCollection: true, collectQd: 2, autoCollect });
      const report = await run(f, `collection-${mode}-${autoCollect}`);
      assert.equal(quantity(f.holding, "wood"), 5, `${mode}/${autoCollect}: five alternating preparation/collection days must reach storage`);
      assert.equal(f.building.productionLines[0].pendingQty, 0);
      assert.equal(f.building.serviceState.workedQd, mode === "staff" ? 15 : 20,
        "Staff reports actual work; explicit QD retains the planned-service contract");
      assert.equal(f.holding.storage.moneyCopper, 9880, "The original staff/planned wage is charged once");
      assert.deepEqual(report.skipped, [], "Completed collection must not leave a false shortage warning");
    }
  });
}

function addSupplier(f, { resourceId = "stone", resource = "", pendingQty = 2, collectQd = 1 } = {}) {
  const line = { id: "stock", source: "workers", active: false, resourceId, resource,
    requiresCollection: true, pendingQty, collectQd, autoCollect: "worker" };
  f.holding.buildings.list.push({ id: `supplier-${f.holding.buildings.list.length}`, constructionStatus: "built",
    functions: { production: true }, productionLines: [line] });
  return line;
}

export async function checkHybridProductionInputs() {
  return withRuntime(async () => {
    // Quotes must reserve one shared budget, in the recipe's collection order.
    for (const [expenses, budget, suppliers, stored, expected] of [
      ["wood 1; stone 1", 1, [["wood", 1], ["stone", 1]], [], false],
      ["wood 1; stone 1", 2, [["wood", 1], ["stone", 1]], [], true],
      ["wood 1; stone 1", 2, [["stone", 2], ["wood", 1], ["stone", 1]], [], true],
      ["wood 1 ИЛИ stone 1; iron 1", 2, [["stone", 2], ["wood", 1], ["iron", 1]], [], true],
      ["wood 1; stone 1", 1, [["wood", 1], ["stone", 1]], [{ resourceId: "wood", qty: 1 }], true],
      ["wood 1 ИЛИ stone 1; wood 1", 2, [["wood", 1]], [], false],
      ["money 1; wood 1", 1, [["money", 1], ["wood", 1]], [], false],
      ["money 1; wood 1", 2, [["money", 1], ["wood", 1]], [], true]
    ]) {
      const f = fixture("staff");
      f.holding.storage.resources = stored;
      f.holding.storage.moneyCopper = 0;
      for (const [resourceId, collectQd] of suppliers) addSupplier(f, { resourceId, collectQd, pendingQty: 1 });
      f.harness._staffDailyCollectionBudget = () => budget;
      const before = structuredClone(f.holding);
      const costs = f.harness._parseResourceCosts(expenses);
      assert.equal(f.harness._canCollectStaffProductionInputs(f.holding, f.building, costs,
        { financeContext: { staffCollectionProbe: true } }, f.building.productionLines[0]), expected,
      `${expenses}, ${budget} QD: collection quote respects the shared budget and actual ingredient order`);
      assert.deepEqual(f.holding, before, "quoting collection must not consume stock, pending output or money");
    }
    {
      const f = fixture("staff", { reverse: true });
      Object.assign(f.building.productionLines.find((line) => line.id === "main"),
        { resourceId: "cloth", expenses: "stone 1; iron 1" });
      f.building.productionLines.find((line) => line.id === "reserve").resourceId = "wood";
      const stone = addSupplier(f, { resourceId: "stone", collectQd: 2, pendingQty: 1 });
      const iron = addSupplier(f, { resourceId: "iron", collectQd: 2, pendingQty: 1 });
      await run(f, "inputs-shared-collection-budget");
      assert.equal(quantity(f.holding, "wood"), 20, "uncollectible primary inputs must leave staff available for the reserve job");
      assert.equal(quantity(f.holding, "cloth"), 0);
      assert.equal(stone.pendingQty, 1);
      assert.equal(iron.pendingQty, 1);
    }
    for (const mode of ["staff", "qd"]) for (const [expenses, pendingQty, expected] of [
      ["wood 1 ИЛИ stone 1", 2, 2], ["masonry 1", 2, 2], ["wood 1 ИЛИ stone 1; stone 1", 2, 1]
    ]) {
      const f = fixture(mode);
      f.building.productionLines.splice(1);
      Object.assign(f.building.productionLines[0], { resourceId: "iron", expenses });
      const supplier = addSupplier(f, { pendingQty });
      await run(f, `inputs-${mode}-${expenses}`);
      assert.equal(quantity(f.holding, "iron"), expected, `${mode}/${expenses}: eligible pending input must make the complete recipe executable`);
      assert.equal(supplier.pendingQty, 0);
      assert.equal(quantity(f.holding, "stone"), 0);
    }
    for (const mode of ["staff", "qd"]) {
      const f = fixture(mode);
      f.building.productionLines.splice(1);
      Object.assign(f.building.productionLines[0], { resourceId: "iron", expenses: "Special ore 1" });
      const wrong = addSupplier(f, { resourceId: "custom", resource: "Other ore" });
      const right = addSupplier(f, { resourceId: "custom", resource: "Special ore" });
      await run(f, `custom-input-${mode}`);
      assert.equal(quantity(f.holding, "iron"), 2, "Custom ingredients keep their name during collection");
      assert.equal(wrong.pendingQty, 2, "Collecting one custom ingredient must not spend QD on a different resource");
      assert.equal(right.pendingQty, 0);
    }
  });
}

export async function checkHybridProductionGoalEstimates() {
  return withRuntime(async () => {
    const f = fixture("qd", { goal: 5, normalQd: 20 });
    f.building.productionLines.splice(1);
    const line = f.building.productionLines[0];
    Object.assign(line, { outputQty: 10, workQd: 10, batchCapacity: 3, batchStartQty: 3 });
    const estimate = workforceProductionGoalState(f.building, "production:main", 5);
    assert.equal(estimate.effectiveNeed, 3, "A capacity of three cannot start the last two units below a three-unit threshold");
    assert.match(estimate.warning, /2 ЕД.*3 ЕД/);
    await run(f, "capacity-goal-estimate");
    assert.equal(quantity(f.holding, "wood"), 3);

    Object.assign(line, { active: true, outputQty: 3, workQd: 2, batchCapacity: 2, batchStartQty: 1 });
    const rounded = workforceProductionGoalState(f.building, "production:main", 3);
    assert.equal(rounded.effectiveNeed, 2.0001, "Each partial batch rounds its work target up to a whole work unit");
    line.batchStartQty = 3;
    const impossible = workforceProductionGoalState(f.building, "production:main", 3);
    assert.equal(impossible.effectiveNeed, 0);
    assert.match(impossible.warning, /Максимальная загрузка 2 ЕД.*порога запуска 3 ЕД/);
  });
}

export async function checkHybridProductionFormulaContext() {
  return withRuntime(async () => {
    for (const mode of ["staff", "qd"]) {
      const f = fixture(mode, { count: 2 });
      for (const person of f.holding.people.list) if (person.staffAppointment) person.staffAppointment.reserveFunctionId = "";
      f.building.productionLines.splice(1);
      Object.assign(f.building.productionLines[0], { outputQty: 3, workQd: 2, repeat: false,
        formula: "@base + @workers + @workqd + @eff + @cycles + @qd" });
      const contexts = [];
      f.harness._rollFormulaTotal = async function (formula, context) {
        contexts.push(context);
        const total = this._expectedFormulaTotal(formula, context);
        return { total, result: String(total) };
      };
      const report = await run(f, `formula-context-${mode}`);
      assert.equal(quantity(f.holding, "wood"), 10, "Formula context is shared by the whole funded batch");
      assert.equal(contexts.length, 1, "Probing staff readiness must reuse its quote when opening the batch");
      assert.deepEqual(contexts[0], { eff: 1, workers: 2, cycles: 1, qd: 1, workqd: 2, base: 3 });
      assert.equal(report.formulas.length, 1);
    }
  });
}

export async function checkHybridPeriodicProductionSources() {
  return withRuntime(async () => {
    let cases = 0;
    for (const mode of ["staff", "qd"]) for (const source of ["time", "content"]) {
      for (const period of ["qd", "day", "tenday"]) for (const workQd of [1, 2]) for (const repeat of [true, false]) {
        const f = fixture(mode);
        f.building.productionLines.splice(1);
        f.building.contents = [{ id: "herd", qty: 2 }];
        const line = f.building.productionLines[0];
        Object.assign(line, { source, period, workQd, repeat, contentId: "herd", outputQty: 3,
          requiresCollection: true, collectQd: 1, expenseMode: "unit", expenses: "iron 1" });
        f.holding.storage.resources = [{ id: "raw", resourceId: "iron", name: "Iron", roomId: "outdoors", qty: 1000 }];
        await run(f, `periodic-source-${cases++}`);
        const duration = workQd * (period === "qd" ? 1 : period === "day" ? 4 : 40);
        const cycles = repeat ? Math.floor(40 / duration) : Math.min(1, Math.floor(40 / duration));
        const output = cycles * 3 * (source === "content" ? 2 : 1);
        assert.equal(quantity(f.holding, "wood") + (line.pendingQty || 0), output, `${mode}/${source}/${period}/${workQd}/${repeat}: output follows the source clock`);
        const fundedOutput = productionBatchStates(line).reduce((sum, batch) => sum + batch.workReservedOutputQty, 0);
        assert.equal(1000 - quantity(f.holding, "iron"), output + fundedOutput, "Only emitted or started batches reserve raw inputs");
        if (source === "content") assert.equal(fundedOutput, 0, "Content harvesting has no invented work phase");
        if (!repeat && cycles) assert.equal(line.active, false);
      }
    }
    return { periodicCases: cases };
  });
}

export async function checkHybridCatalogRecipes() {
  return withRuntime(async () => {
    let cases = 0;
    for (const template of DEFAULT_BUILDING_TEMPLATES) for (const recipe of template.productionLines ?? []) {
      for (const mode of ["staff", "qd"]) {
        // Isolate the shipped recipe from building-specific services and staff
        // composition, covered by their own catalog/admission/maintenance suites.
        const f = fixture(mode);
        f.building.productionLines = [{ ...structuredClone(recipe), active: true }];
        f.building.wageDailyCopper = 12;
        const functionId = `production:${recipe.id}`;
        if (mode === "staff") f.person.staffAppointment.primaryFunctionId = functionId;
        else f.person.workAllocations[0].functionId = functionId;
        f.holding.storage.resources = allResourceDefs().filter((resource) => !resource.isMoney).map((resource, index) => ({
          id: `raw-${index}`, resourceId: resource.id, name: resource.label, roomId: "outdoors", qty: 10000
        }));
        f.holding.storage.moneyCopper = 1000000;
        f.harness._lineSeasonAllowed = () => true;
        let workQd = 0;
        const dependencies = f.harness._productionCycleDependencies;
        f.harness._productionCycleDependencies = function (options) {
          const deps = dependencies.call(this, options), record = deps.recordWorkerWork;
          deps.recordWorkerWork = (...args) => { workQd += args[4]; record(...args); };
          return deps;
        };
        await run(f, `catalog-recipe-${cases++}`);
        assert.ok(workQd > 0 && workQd <= 20, `${mode}/${template.id}/${recipe.id}: a funded shipped recipe must use its labor allocation`);
      }
    }
    return { catalogRecipeCases: cases };
  });
}

export async function checkHybridProductionFoodProjection() {
  return withRuntime(async () => {
    for (const mode of ["staff", "qd"]) for (const funded of [true, false]) {
      const f = fixture(mode, { goal: mode === "staff" ? 2 : null, reverse: mode === "staff", normalQd: 3 });
      Object.assign(f.building.productionLines.find((line) => line.id === "main"), { resourceId: "food-dairy" });
      if (!funded) f.holding.storage.moneyCopper = 0;
      SkyholdData.view = () => ({ holdings: [f.holding], catalog: {} });
      const before = structuredClone(f.holding);
      const projection = await f.harness._projectTendayFood(f.holding);
      assert.deepEqual(f.holding, before, "Readiness projection must leave the source and finance untouched");
      await run(f, `food-projection-${mode}-${funded}`);
      const expected = funded ? mode === "staff" ? 2 : 3 : 0;
      assert.equal(quantity(f.holding, "food-dairy"), expected);
      assert.equal(projection.available, expected, `${mode}/${funded}: forecast uses the same labor plan and funding gate as execution`);
    }
  });
}

export async function checkHybridProductionMatrix() {
  return withRuntime(async () => {
    let cases = 0;
    for (const mode of ["staff", "qd"]) for (const efficiency of [0.5, 1, 2.25]) {
      for (const capacity of [0, 5]) for (const waitDays of [0, 0.5, 20]) for (const goal of [null, 5]) {
        const f = fixture(mode, { goal, count: 2 });
        for (const person of f.holding.people.list) if (person.staffAppointment) person.staffAppointment.reserveFunctionId = "";
        f.building.productionLines.splice(1);
        const line = f.building.productionLines[0];
        Object.assign(line, { outputQty: 3, workQd: 2, batchCapacity: capacity, batchStartQty: 1,
          waitDays, expenseMode: "unit", expenses: "iron 1" });
        f.holding.storage.resources = [{ id: "raw", resourceId: "iron", name: "Iron", roomId: "outdoors", qty: 1000 }];
        f.harness._personBuildingEfficiency = () => efficiency;
        let actualProductionQd = 0;
        const dependencies = f.harness._productionCycleDependencies;
        f.harness._productionCycleDependencies = function (options) {
          const deps = dependencies.call(this, options), record = deps.recordWorkerWork;
          deps.recordWorkerWork = (...args) => { actualProductionQd += args[4]; record(...args); };
          return deps;
        };
        await run(f, `matrix-${cases++}`);
        const batches = productionBatchStates(line);
        const fundedOutput = batches.reduce((sum, batch) => sum + batch.workReservedOutputQty, 0);
        const committedOutput = quantity(f.holding, "wood") + (line.pendingQty || 0) + fundedOutput;
        assert.equal(1000 - quantity(f.holding, "iron"), committedOutput, "Every emitted or funded output has exactly one unit of reserved raw material");
        assert.ok(actualProductionQd >= 0 && actualProductionQd <= 40, "Two workers cannot spend more than their total funded QD");
        if (goal !== null) assert.ok(committedOutput <= goal, "A shared preparation goal must not multiply with workers or efficiency");
        if (capacity) assert.ok(productionOccupiedQty(line) <= capacity, "Working and waiting batches share equipment capacity");
        for (const batch of batches) assert.equal(validProductionTiming(productionTiming(batch)), true);
        if (productionTiming(line)?.phase === "work") assert.ok(line.workProgressUnits < productionTiming(line).workTargetUnits);
        if (!waitDays && goal === null && !capacity) assert.equal(quantity(f.holding, "wood"), Math.floor(40 * efficiency / 2) * 3,
          "Unconstrained labor throughput follows effective QD, not the count of assigned residents");
      }
    }
    return { matrixCases: cases };
  });
}

export async function checkHybridProductionLines() {
  await checkHybridProductionCollection();
  await checkHybridProductionInputs();
  await checkHybridProductionFoodProjection();
  await checkHybridProductionGoalEstimates();
  await checkHybridProductionFormulaContext();
  return { ...await checkHybridProductionMatrix(), ...await checkHybridPeriodicProductionSources(), ...await checkHybridCatalogRecipes() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await checkHybridProductionLines()));
}
