import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FinanceDomain } from "../apps/domains/finance-domain.js";
import { ResidentDomain } from "../apps/domains/resident-domain.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { createDefaultFinanceObligationsState } from "../data/finance/obligations.js";
import { BASE_HOLDING } from "../data/schema/base-holding.js";
import { clone } from "../data/utils.js";
import {
  accrueFinanceUpkeepPeriods,
  financePeriodIdentity,
  plannedWorkerQd,
  prepareFinancePeriod
} from "../engines/economy/finance-period.js";
import {
  buildTendayOperationPayload,
  hydrateTendayOperation
} from "../engines/tenday/operation-payload.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function builtMill({ wageDailyCopper = 3, baseUpkeepMonthlyCopper = 0, operatingUpkeepMonthlyCopper = 0, active = true } = {}) {
  return {
    id: "mill",
    name: "Mill",
    constructionStatus: "built",
    status: "Построено",
    functions: { production: true, income: false },
    assignedWorkerIds: ["worker"],
    wageDailyCopper,
    baseUpkeepMonthlyCopper,
    productionLines: [{
      id: "grind",
      active,
      source: "workers",
      period: "day",
      workQd: 1,
      resourceId: "flour",
      outputQty: 1,
      wageDailyCopper,
      operatingUpkeepMonthlyCopper
    }]
  };
}

function runtimeHolding({
  moneyCopper = 0,
  wageDailyCopper = 3,
  baseUpkeepMonthlyCopper = 0,
  operatingUpkeepMonthlyCopper = 0,
  volunteerLabor = false,
  active = true
} = {}) {
  const holding = clone(BASE_HOLDING);
  holding.id = "finance-runtime";
  holding.name = "Finance runtime";
  holding.gm.calendaria.lastQd = 0;
  holding.storage.moneyCopper = moneyCopper;
  holding.storage.resources = [];
  holding.storage.items = [];
  holding.people.list = [{
    id: "worker",
    name: "Worker",
    workAssignment: "mill",
    wageDailyOverrideCopper: null,
    volunteerLabor,
    volunteerReason: volunteerLabor ? "characterization fixture" : ""
  }];
  holding.buildings.list = [builtMill({
    wageDailyCopper,
    baseUpkeepMonthlyCopper,
    operatingUpkeepMonthlyCopper,
    active
  })];
  holding.finance = createDefaultFinanceObligationsState();
  return holding;
}

function runtimeHarness() {
  const calls = [];
  const originalPrepareFinance = FinanceDomain._prepareFinanceForQd;
  const harness = {
    ...FinanceDomain,
    _safeNumber(value, fallback = 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    },
    _buildingStatus(building = {}) {
      return { value: String(building.constructionStatus ?? "built") === "built" ? "built" : "building" };
    },
    _buildingFunctions(building = {}) {
      return {
        production: Boolean(building.functions?.production),
        income: Boolean(building.functions?.income),
        defense: Boolean(building.functions?.defense),
        housing: Boolean(building.functions?.housing),
        storage: Boolean(building.functions?.storage),
        culture: Boolean(building.functions?.culture)
      };
    },
    _buildingHasOvertimeProduction(building = {}) {
      return (building.productionLines ?? []).some((line) => line?.active !== false && line?.overtime === true);
    },
    _isResidentInjured: ResidentDomain._isResidentInjured,
    _isChildResident: ResidentDomain._isChildResident,
    _childWorkThreshold: ResidentDomain._childWorkThreshold,
    _canResidentWork: ResidentDomain._canResidentWork,
    _assignedWorkerSet(holding = {}) {
      return new Set((holding?.buildings?.list ?? []).flatMap((building) => building?.assignedWorkerIds ?? []).map(String));
    },
    _advanceMarketShipmentsForQd() {
      calls.push("shipments");
    },
    _advanceMarketOutboundForQd() {
      calls.push("outbound");
    },
    _prepareFinanceForQd(...args) {
      calls.push("finance");
      return originalPrepareFinance.call(this, ...args);
    },
    async _runProductionCycleForQd(holding, _qd, _report, { financeContext } = {}) {
      calls.push("production");
      const building = holding.buildings.list[0];
      const line = building.productionLines[0];
      const workerBlocked = financeContext?.blockedWorkerIds?.has("worker");
      if (!holding.forceIdle && !workerBlocked && this._financeFunctionAllowed(financeContext, building, this._financeLineFunctionId(line))) {
        holding.testOutput = (holding.testOutput ?? 0) + 1;
      }
    },
    _isFoodResource() {
      return false;
    },
    _runFoodConsumptionForQd() {
      calls.push("food");
    },
    _runConstructionCrewsForQd(_holding, _qd, _report, { blockedWorkerIds } = {}) {
      calls.push("construction");
      assert.ok(blockedWorkerIds instanceof Set, "construction must receive the finance worker gate");
    },
    _runInternalDemandForQd(_holding, _qd, _report, financeContext) {
      calls.push("internal-demand");
      assert.ok(financeContext, "internal demand must receive the same finance execution context");
    }
  };
  return { harness, calls };
}

function oldWageDebt() {
  return {
    id: "old-wage",
    kind: "wage",
    recipientKind: "resident",
    recipientId: "worker",
    sourceId: "worker",
    functionId: "",
    periodKey: "tenday:0",
    periodIndex: 0,
    dueCopper: 1,
    paidCopper: 0,
    waivedCopper: 0,
    outstandingCopper: 1,
    status: "due",
    gmPriority: 200,
    dependsOnObligationIds: [],
    payments: [],
    orphaned: false,
    orphanHistory: [],
    meta: {}
  };
}

function carrySeries(monthlyCopper) {
  let finance = createDefaultFinanceObligationsState();
  const due = [];
  for (let periodIndex = 1; periodIndex <= 3; periodIndex += 1) {
    const result = accrueFinanceUpkeepPeriods({
      finance,
      buildings: [{ id: "shell", built: true, baseUpkeepMonthlyCopper: monthlyCopper, functions: [] }],
      periodKey: `tenday:${periodIndex}`,
      periodIndex,
      operationId: `carry:${periodIndex}`
    });
    finance = result.finance;
    due.push(result.buildings[0].baseUpkeepCopper);
  }
  return { due, finance };
}

export async function checkFinanceRuntimeCharacterization() {
  {
    const { harness } = runtimeHarness();
    const holding = runtimeHolding({ moneyCopper: 1000, wageDailyCopper: 18 });
    const building = holding.buildings.list[0];
    building.functions = { culture: true };
    building.activation = { minWorkers: 1, minOperationalQd: 20 };
    building.maintenance = { schemaVersion: 2, requiredPoints: 2 };
    const slot = (functionId) => ({ sourceId: building.id, functionId, overtime: false });
    const serviceSlots = new Map(Array.from({ length: 40 }, (_, step) => step).filter((step) => step % 4 < 2).map((step) => [step, slot("culture")]));
    const context = { periodQd: 40, periodIdentity: { periodKey: "restart-service" }, technicalRestartIds: new Set([building.id]),
      blockedWorkerIds: new Set(), plannedAssignmentsByWorkerId: new Map(), plannedWorkSlotsByWorkerId: new Map([
        ["service-worker", serviceSlots], ["technician", new Map([[0, slot("maintenance")], [1, slot("maintenance")]])]
      ]) };
    const report = { skipped: [], ledger: [] };
    harness._prepareTechnicalServiceRestarts(holding, context, report);
    assert.equal(building.serviceState.workedQd, 18, "The first two simultaneous service slots precede completed inspection and cannot count");
    assert.equal(building.serviceState.active, false);
    context.plannedWorkSlotsByWorkerId.set("helper", new Map([[4, slot("culture")], [5, slot("culture")]]));
    harness._prepareTechnicalServiceRestarts(holding, context, report);
    assert.equal(building.serviceState.active, true);
    harness._recordBuildingServiceActivity(holding, report, context);
    assert.equal(building.serviceState.workedQd, 20, "Final recording retains the post-inspection service workload");
    assert.ok(!building.serviceState.activeWorkerIds.includes("technician"));
    context.blockedWorkerIds.add("technician");
    harness._prepareTechnicalServiceRestarts(holding, context, report);
    assert.equal(building.serviceState.active, false, "An unpaid technician cannot restart a nonproduction service");
    assert.equal(building.serviceState.workedQd, 0);
  }
  {
    for (const moneyCopper of [1000, 0]) {
      const { harness } = runtimeHarness();
      const holding = runtimeHolding({ moneyCopper, wageDailyCopper: 3 });
      const building = holding.buildings.list[0];
      building.workersMax = 1;
      building.maintenance = { schemaVersion: 2, requiredPoints: 2, backlogTendays: 0 };
      Object.assign(holding.people.list[0], { workAssignment: "", workAllocationMode: "explicit", workAllocations: [
        { id: "production", sourceId: "mill", functionId: "production:grind", normalQd: 18, overtimeQd: 0 },
        { id: "technical", sourceId: "mill", functionId: "maintenance", normalQd: 2, overtimeQd: 0 }
      ] });
      const inputs = harness._financePlanInputs(holding, 40, financePeriodIdentity(holding, 40));
      const technical = inputs.buildings[0].functions.find((row) => row.id === "maintenance");
      assert.equal(technical.wageDailyCopper, 18);
      assert.equal(technical.operatingUpkeepMonthlyCopper, 0, "Technical labor must not add a second operating tariff");
      const report = { treasury: { spent: 0, deficit: 0, lines: [] }, skipped: [], ledger: [] };
      const context = harness._prepareFinanceForQd(holding, 40, report, { operationId: `technical-finance-${moneyCopper}` });
      const plan = harness._planMaintenanceForQd(holding, 40, { operationId: `technical-service-${moneyCopper}`, financeContext: context });
      if (moneyCopper > 0) {
        assert.equal(holding.storage.moneyCopper, 955, "18 production QD at 3/day plus 2 technical QD at 18/day cost 45");
        assert.equal(plan.totals.allocatedTechnicalQd, 2);
        assert.equal(plan.entries[0].stateAfter.backlogTendays, 0);
        assert.equal(harness._technicalMaintenanceReady(building, context, 0), false);
        assert.equal(harness._technicalMaintenanceReady(building, context, 1), false);
        assert.equal(harness._technicalMaintenanceReady(building, context, 2), true, "Restart follows two completed paid QD, never future work");
        harness._recordBuildingServiceActivity(holding, report, context);
        assert.equal(building.serviceState.workedQd, 18, "Recorded primary activity excludes technical QD");
        assert.equal(building.serviceState.workedQdByFunction.maintenance, undefined);
      } else {
        assert.equal(plan.totals.allocatedTechnicalQd, 0, "Unpaid assignments cannot service machinery");
      }
    }
  }
  assert.deepEqual(plannedWorkerQd(40), { normalQd: 20, overtimeQd: 0, totalQd: 20 });
  assert.deepEqual(plannedWorkerQd(40, { overtime: true }), { normalQd: 20, overtimeQd: 10, totalQd: 30 });
  assert.deepEqual(plannedWorkerQd(40, { overtime: true, normalQdPerDay: 1, overtimeQdPerDay: 0 }), { normalQd: 10, overtimeQd: 0, totalQd: 10 });

  {
    const { harness } = runtimeHarness();
    const holding = runtimeHolding({ moneyCopper: 100, wageDailyCopper: 3 });
    Object.assign(holding.people.list[0], { age: 12, race: "Человек", injuredDays: 0 });
    holding.buildings.list[0].productionLines[0].overtime = true;
    const inputs = harness._financePlanInputs(holding, 40, financePeriodIdentity(holding, 40));
    assert.equal(inputs.workers.length, 1, "an older working child must enter the immutable finance plan");
    assert.deepEqual({
      maximumNormalQd: inputs.workers[0].maximumNormalQd,
      maximumOvertimeQd: inputs.workers[0].maximumOvertimeQd,
      normalQd: inputs.workers[0].assignments[0].normalQd,
      overtimeQd: inputs.workers[0].assignments[0].overtimeQd
    }, { maximumNormalQd: 10, maximumOvertimeQd: 0, normalQd: 10, overtimeQd: 0 }, "child labor must stay at one QD per day and never acquire building overtime");

    holding.people.list[0].age = 11;
    const underageInputs = harness._financePlanInputs(holding, 40, financePeriodIdentity(holding, 40));
    assert.equal(underageInputs.workers.length, 0, "an underage child with a stale assignment must stay outside the finance plan");
  }

  {
    const { harness } = runtimeHarness();
    const holding = runtimeHolding({ moneyCopper: 1_000, wageDailyCopper: 12 });
    const quarry = builtMill({ wageDailyCopper: 18 });
    quarry.id = "quarry";
    quarry.name = "Quarry";
    quarry.assignedWorkerIds = [];
    quarry.productionLines[0].id = "cut";
    quarry.productionLines[0].resourceId = "stone";
    quarry.productionLines[0].wageDailyCopper = 0;
    quarry.workersMax = 1;
    holding.buildings.list[0].assignedWorkerIds = [];
    holding.buildings.list[0].workersMax = 1;
    Object.assign(holding.people.list[0], {
      attributes: { strength: 3, agility: 3, wits: 3, empathy: 3 },
      workAssignment: "",
      workAllocationMode: "explicit",
      workAllocations: [
        { id: "mill-half", sourceId: "mill", functionId: "production:grind", normalQd: 10, overtimeQd: 0 },
        { id: "quarry-half", sourceId: "quarry", functionId: "production:cut", normalQd: 10, overtimeQd: 0 }
      ],
      volunteerLabor: false,
      volunteerReason: ""
    });
    holding.buildings.list.push(quarry);
    const inputs = harness._financePlanInputs(holding, 40, financePeriodIdentity(holding, 40));
    assert.equal(inputs.workers.length, 1);
    assert.deepEqual(inputs.workers[0].assignments.map((assignment) => ({
      sourceId: assignment.sourceId,
      normalQd: assignment.normalQd,
      dailyRateCopper: assignment.dailyRateCopper
    })), [
      { sourceId: "mill", normalQd: 10, dailyRateCopper: 12 },
      { sourceId: "quarry", normalQd: 10, dailyRateCopper: 18 }
    ], "each split assignment must inherit its own line rate or the containing building rate");
    assert.deepEqual(inputs.workers[0].planIssues, [], "a paid 10+10 QD split must be a valid immutable finance plan");
  }

  const oneCopperMonthly = carrySeries(1);
  assert.deepEqual(oneCopperMonthly.due, [0, 0, 1], "one-copper monthly upkeep must survive three tenday carry steps");
  assert.equal(oneCopperMonthly.finance.buildingStates.shell.upkeepAccrual.base.remainderThirds, 0);
  assert.deepEqual(carrySeries(2).due, [0, 1, 1], "two-copper monthly upkeep must preserve its exact thirds without disappearing");

  assert.throws(() => prepareFinancePeriod({
    finance: {
      ...createDefaultFinanceObligationsState(),
      obligations: [{
        ...oldWageDebt(),
        id: "finance-obligation:wage:resident:worker:worker:none:tenday%3A1",
        periodKey: "tenday:1",
        periodIndex: 1,
        dueCopper: 1,
        outstandingCopper: 1
      }]
    },
    treasuryCopper: 100,
    workers: [{ id: "worker", assignments: [{ normalQd: 20, dailyRateCopper: 3 }] }],
    periodKey: "tenday:1",
    periodIndex: 1,
    operationId: "changed-terms"
  }), (error) => error?.code === "finance-obligation-conflict", "changing immutable obligation terms inside one period must stop before allocation");

  {
    const { harness, calls } = runtimeHarness();
    const holding = runtimeHolding({ moneyCopper: 0, wageDailyCopper: 3 });
    const report = await harness._runEconomyForQd(holding, 40, {
      operationId: "poor-tenday",
      createdAt: "2026-08-11T10:00:00.000Z"
    });
    assert.deepEqual(calls, ["shipments", "outbound", "finance", "production", "food", "construction", "internal-demand"], "allocation must run after inbound/outbound arrivals and before every economic result");
    assert.equal(holding.storage.moneyCopper, 0, "the treasury must never become negative");
    assert.equal(holding.testOutput ?? 0, 0, "an unpaid current worker must not create output");
    assert.equal(report.finance.currentOutstandingCopper, 30);
    assert.equal(holding.finance.obligations.find((row) => row.kind === "wage")?.dueCopper, 30, "twenty planned normal QD at 3 copper/day must cost 30 copper");
  }

  {
    const { harness } = runtimeHarness();
    const holding = runtimeHolding({ moneyCopper: 30, wageDailyCopper: 3 });
    holding.forceIdle = true;
    const report = await harness._runEconomyForQd(holding, 40, {
      operationId: "idle-tenday",
      createdAt: "2026-08-11T10:01:00.000Z"
    });
    assert.equal(holding.testOutput ?? 0, 0, "the fixture must remain idle even though its paid shift is available");
    assert.equal(report.finance.paidCopper, 30, "an immutable planned shift is payable even if no output is ultimately released");
    assert.equal(holding.storage.moneyCopper, 0);
  }

  {
    const { harness } = runtimeHarness();
    const holding = runtimeHolding({ moneyCopper: 1, wageDailyCopper: 3 });
    holding.finance.obligations.push(oldWageDebt());
    await harness._runEconomyForQd(holding, 40, {
      operationId: "old-debt-tenday",
      createdAt: "2026-08-11T10:02:00.000Z"
    });
    assert.equal(holding.finance.obligations.find((row) => row.id === "old-wage")?.outstandingCopper, 0, "old debt may be paid by the current allocation");
    assert.equal(holding.finance.obligations.some((row) => row.kind === "wage" && row.periodKey === "tenday:1"), false, "an old blocker must exclude the worker from the current immutable plan");
    assert.equal(holding.testOutput ?? 0, 0, "paying an old blocker during allocation must not retroactively add work to the current plan");
  }

  {
    const { harness } = runtimeHarness();
    const holding = runtimeHolding({
      moneyCopper: 0,
      volunteerLabor: true,
      operatingUpkeepMonthlyCopper: 3
    });
    const report = await harness._runEconomyForQd(holding, 40, {
      operationId: "operating-unpaid",
      createdAt: "2026-08-11T10:03:00.000Z"
    });
    assert.equal(report.finance.currentOutstandingCopper, 1);
    assert.equal(holding.testOutput ?? 0, 0, "unpaid current operating upkeep must block only that function's result");
    assert.equal(holding.finance.obligations.some((row) => row.kind === "wage"), false, "explicit volunteer labor must not create a hidden wage debt");
  }

  {
    const { harness } = runtimeHarness();
    const holding = runtimeHolding({ moneyCopper: 100, volunteerLabor: true });
    holding.finance.buildingStates.mill = {
      mothballed: true,
      changedAt: "2026-08-01T00:00:00.000Z",
      changedOperationId: "mothball-mill",
      reason: "seasonal closure",
      history: []
    };
    const report = await harness._runEconomyForQd(holding, 40, {
      operationId: "mothballed-tenday",
      createdAt: "2026-08-11T10:04:00.000Z"
    });
    assert.equal(holding.testOutput ?? 0, 0, "mothballing must disable the building's mechanical output");
    assert.equal(report.finance.currentOutstandingCopper, 0);
    assert.equal(holding.finance.obligations.some((row) => row.recipientId === "mill"), false, "mothballing must stop both base and operating accrual");
  }

  {
    const { harness } = runtimeHarness();
    const holding = runtimeHolding({ moneyCopper: 0, volunteerLabor: true });
    holding.finance.obligations.push({ ...oldWageDebt(), id: "missing-worker-debt", recipientId: "missing-worker", sourceId: "missing-worker" });
    const report = {
      treasury: { spent: 0, deficit: 0, lines: [] },
      skipped: [],
      ledger: []
    };
    harness._prepareFinanceForQd(holding, 40, report, {
      operationId: "orphan-reconcile",
      createdAt: "2026-08-11T10:05:00.000Z"
    });
    assert.equal(holding.finance.obligations.find((row) => row.id === "missing-worker-debt")?.status, "orphaned", "Preview must preserve and mark a debt whose recipient disappeared");
    assert.deepEqual(report.finance.orphanedObligationIds, ["missing-worker-debt"]);
    assert.equal(report.finance.obligations.find((row) => row.id === "missing-worker-debt")?.status, "orphaned", "the GM breakdown must include the exact orphan row that needs resolution");
  }

  {
    const { harness } = runtimeHarness();
    const holding = runtimeHolding({ moneyCopper: 100, volunteerLabor: true });
    const building = holding.buildings.list[0];
    building.functions.income = true;
    building.income = {
      wageDailyCopper: 3,
      operatingUpkeepMonthlyCopper: 0,
      trade: {
        enabled: true,
        kind: "all",
        sourceIds: ["market-flow"],
        allowedTags: ["all"],
        roomId: "all",
        throughputUnitsPerWorker: 10,
        demandBudgetBaseCopper: 10,
        demandBudgetPerWorkerCopper: 0,
        demandSource: "market-flow",
        service: { enabled: false }
      }
    };
    const report = { treasury: { spent: 0, deficit: 0, lines: [] }, skipped: [], ledger: [] };
    const financeContext = harness._prepareFinanceForQd(holding, 40, report, {
      operationId: "single-function-shift",
      createdAt: "2026-08-11T10:06:00.000Z"
    });
    const workerContext = harness._economyWorkerContext(holding, { financeContext });
    assert.equal(harness._activeAssignedBuildingPeople(holding, building, workerContext, "production:grind").length, 1, "the paid production shift must retain its worker");
    assert.equal(harness._activeAssignedBuildingPeople(holding, building, workerContext, "income").length, 0, "one paid shift must not also staff the income function");
    assert.equal(harness._internalDemandChannels(holding, financeContext, 1, workerContext).channels.length, 0, "an Inn worker planned for cooking must not simultaneously create trade and service throughput");
  }

  {
    const { harness } = runtimeHarness();
    const office = { id: "office", templateId: "personnel-office", constructionStatus: "built", workersMin: 1 };
    const holding = { buildings: { list: [office] }, finance: {} };
    const financeContext = {
      blockedWorkerIds: new Set(),
      mothballedBuildingIds: new Set(),
      baseBlockedBuildingIds: new Set(),
      operatingBlockedFunctionKeys: new Set()
    };
    const cashback = harness._personnelOfficeCashback(holding, {
      finance: { obligations: [
        { id: "outside-wage", kind: "wage", meta: { assignments: [{ sourceId: "mill", normalQd: 10, overtimeQd: 0, effectiveDailyRateCopper: 10 }] } },
        { id: "office-wage", kind: "wage", meta: { assignments: [{ sourceId: "office", normalQd: 10, overtimeQd: 0, effectiveDailyRateCopper: 10 }] } },
        { id: "outside-operating", kind: "building-operating-upkeep", recipientId: "mill" },
        { id: "outside-base", kind: "building-base-upkeep", recipientId: "mill" }
      ] },
      allocation: { payments: [
        { obligationId: "outside-wage", amountCopper: 100 },
        { obligationId: "office-wage", amountCopper: 100 },
        { obligationId: "outside-operating", amountCopper: 30 },
        { obligationId: "outside-base", amountCopper: 60 }
      ] }
    }, {
      workers: [{ id: "hr", assignments: [{ sourceId: "office", functionId: "income", normalQd: 20 }] }]
    }, financeContext);
    assert.deepEqual({ copper: cashback.copper, baseCopper: cashback.baseCopper }, { copper: 13, baseCopper: 130 }, "Personnel Office must return exactly 10% of paid outside wages and operating upkeep only");

    assert.equal(cashback.officePaidCopper, 100, "the office cost stays visible beside its 13-copper administrative reimbursement");
    assert.equal(cashback.copper - cashback.officePaidCopper, -87, "an uneconomic office must not appear profitable");

    const crypt = { id: "crypt-room", templateId: "laputa-excavated-crypt", baseUpkeepMonthlyCopper: 0 };
    assert.equal(harness._buildingBaseUpkeepMonthlyCopper({ storage: { resources: [], items: [] } }, crypt), 0);
    assert.equal(harness._buildingBaseUpkeepMonthlyCopper({ storage: { resources: [{ roomId: "crypt-room", qty: 1 }], items: [] } }, crypt), 18, "the Laputa crypt must accrue minimum upkeep only while used as storage");
  }

  {
    const { harness } = runtimeHarness();
    const lighthouse = {
      id: "lighthouse",
      name: "Маяк",
      constructionStatus: "built",
      workersMin: 1,
      fuelChoice: "wood",
      fuelAlternatives: [{ resourceId: "fuel-liquid", qty: 1, label: "1 Жидкое топливо" }, { resourceId: "wood", qty: 2, label: "2 Древесина" }]
    };
    const holding = { buildings: { list: [lighthouse] }, storage: { resources: [{ resourceId: "wood", qty: 0 }, { resourceId: "fuel-liquid", qty: 10 }] } };
    const report = { skipped: [], consumed: [], ledger: [] };
    const financeContext = { mothballedBuildingIds: new Set(), baseBlockedBuildingIds: new Set(), operatingBlockedFunctionKeys: new Set(), periodIdentity: { periodKey: "tenday:1" } };
    const fuelHarness = {
      ...harness,
      _activeAssignedBuildingPeople: () => [{}],
      _storageCanPay(target, costs) {
        const cost = costs[0];
        const row = target.storage.resources.find((item) => item.resourceId === cost.resourceId);
        return row && row.qty >= cost.qty ? { ok: true, costs: [{ ...cost, roomId: "outdoors" }] } : { ok: false, costs: [] };
      },
      _storagePay(target, costs) {
        for (const cost of costs) target.storage.resources.find((item) => item.resourceId === cost.resourceId).qty -= cost.qty;
        return { ok: true, costs };
      }
    };
    fuelHarness._runInstitutionConsumables(holding, 40, report, {}, financeContext);
    assert.equal(lighthouse.serviceState.active, false, "the Lighthouse must stop when the explicitly selected fuel is missing");
    assert.equal(holding.storage.resources.find((row) => row.resourceId === "fuel-liquid").qty, 10, "the Lighthouse must never substitute a more abundant fuel automatically");
    holding.storage.resources.find((row) => row.resourceId === "wood").qty = 2;
    financeContext.operatingBlockedFunctionKeys.clear();
    fuelHarness._runInstitutionConsumables(holding, 40, report, {}, financeContext);
    assert.equal(lighthouse.serviceState.active, true);
    assert.equal(holding.storage.resources.find((row) => row.resourceId === "wood").qty, 0, "the selected two Wood must be charged once per tenday");
  }

  {
    const { harness } = runtimeHarness();
    const holding = {
      people: { list: [] },
      buildings: { list: [{ id: "agency-1", templateId: "hiring-agency", name: "Агентство Найма", constructionStatus: "built", workersMin: 1 }] },
      finance: {},
      log: []
    };
    const resolutionHarness = { ...harness, _activeAssignedBuildingPeople: () => [{}] };
    const report = { work: [] };
    const financeContext = { mothballedBuildingIds: new Set(), baseBlockedBuildingIds: new Set(), operatingBlockedFunctionKeys: new Set(), periodIdentity: { periodIndex: 3, lastPeriodIndex: 3 } };
    resolutionHarness._runInstitutionResolutions(holding, report, {}, financeContext, { operationId: "agency-period", createdAt: "2026-08-11T10:07:00.000Z" });
    resolutionHarness._runInstitutionResolutions(holding, report, {}, financeContext, { operationId: "agency-period", createdAt: "2026-08-11T10:07:00.000Z" });
    assert.equal(holding.people.list.length, 0, "Hiring Agency must never create residents automatically");
    assert.equal(holding.log.length, 1, "the monthly Hiring Agency GM resolution must be idempotent");
    assert.equal(holding.log[0].payload?.resolutionKind, "hiring-agency");
  }

  {
    const raw = clone(BASE_HOLDING);
    raw.people.list = [{
      id: "canonical-worker",
      salary: 99,
      wageDailyOverrideCopper: "7",
      volunteerLabor: "true",
      volunteerReason: "family duty"
    }];
    raw.buildings.list = [
      {
        id: "canonical-building",
        constructionStatus: "built",
        functions: { production: true },
        upkeep: 99,
        wageDailyCopper: "5",
        baseUpkeepMonthlyCopper: "2",
        operatingUpkeepMonthlyCopper: "4",
        productionLines: [{
          id: "canonical-line",
          active: true,
          source: "workers",
          wageDailyCopper: "6",
          operatingUpkeepMonthlyCopper: "3"
        }],
        income: { wageDailyCopper: "8", operatingUpkeepMonthlyCopper: "9" }
      },
      {
        id: "legacy-upkeep-only",
        constructionStatus: "built",
        functions: {},
        upkeep: 99
      }
    ];
    raw.finance = {
      buildingStates: {
        "canonical-building": {
          upkeepAccrual: {
            base: { remainderThirds: 2, lastPeriodKey: "tenday:2" },
            operating: { "production:canonical-line": { remainderThirds: 1 } }
          }
        }
      }
    };
    const normalized = mergeHoldingDefaults(raw);
    const person = normalized.people.list[0];
    const building = normalized.buildings.list[0];
    assert.equal(person.wageDailyOverrideCopper, 7);
    assert.equal(person.volunteerLabor, true);
    assert.equal(person.volunteerReason, "family duty");
    assert.equal(building.wageDailyCopper, 5);
    assert.equal(building.baseUpkeepMonthlyCopper, 2);
    assert.equal(building.operatingUpkeepMonthlyCopper, 4);
    assert.equal(building.productionLines[0].wageDailyCopper, 6);
    assert.equal(building.productionLines[0].operatingUpkeepMonthlyCopper, 3);
    assert.equal(building.income.wageDailyCopper, 8);
    assert.equal(building.income.operatingUpkeepMonthlyCopper, 9);
    assert.equal(normalized.buildings.list.find((row) => row.id === "legacy-upkeep-only").baseUpkeepMonthlyCopper, 0, "legacy upkeep must not be reinterpreted as a monthly exact obligation");
    assert.equal(normalized.finance.buildingStates["canonical-building"].upkeepAccrual.base.remainderThirds, 2);
    assert.equal(normalized.finance.buildingStates["canonical-building"].upkeepAccrual.operating["production:canonical-line"].remainderThirds, 1);
  }

  {
    const payload = buildTendayOperationPayload({
      holdingName: "Finance runtime",
      qd: 40,
      report: { finance: { periodKey: "tenday:1", paidCopper: 30, outstandingCopper: 0 } },
      changeSet: {}
    });
    assert.deepEqual(payload.economy.finance, { periodKey: "tenday:1", paidCopper: 30, outstandingCopper: 0 });
    const historical = hydrateTendayOperation({ operationId: "history-finance", payload }, { holdingId: "finance-runtime" });
    assert.deepEqual(historical.report.finance, payload.economy.finance, "historical tenday reports must retain the exact finance breakdown");
  }

  const economySource = readFileSync(path.join(root, "scripts/apps/domains/finance/economy-domain.js"), "utf8");
  const runStart = economySource.indexOf("async _runEconomyForQd");
  const runEnd = economySource.indexOf("\n_marketShipmentDependencies", runStart);
  const runSource = economySource.slice(runStart, runEnd);
  assert.ok(runSource.indexOf("_advanceMarketShipmentsForQd") < runSource.indexOf("_prepareFinanceForQd"));
  assert.ok(runSource.indexOf("_advanceMarketOutboundForQd") < runSource.indexOf("_prepareFinanceForQd"));
  assert.ok(runSource.indexOf("_prepareFinanceForQd") < runSource.indexOf("_runProductionAndLivestockForQd"));
  assert.doesNotMatch(runSource, /_runTreasuryCostsForQd/, "the legacy treasury pass must stay disconnected from runtime to prevent double payment");

  const eventsSource = readFileSync(path.join(root, "scripts/apps/domains/events/economy-events.js"), "utf8");
  assert.match(eventsSource, /_runEconomyForQd\(previewHolding, periodQd, \{ operationId, createdAt: preparedAt, data: executionData \}\)/, "Preview binds finance to its operation id and supplies the catalog snapshot with isolated shared transport state");
  assert.match(eventsSource, /transportV2: sharedTransportDraft/, "Shared transport mutations stay in the preview draft until Apply");

  const tendayAppSource = readFileSync(path.join(root, "scripts/apps/tenday-app.js"), "utf8");
  assert.match(tendayAppSource, /title: "Денежные обязательства"/, "the GM Preview/History economy tab must expose the exact obligation rows");

  const productionSource = readFileSync(path.join(root, "scripts/engines/economy/production-cycle.js"), "utf8");
  assert.equal((productionSource.match(/lineFinanceAllowed\?\./g) ?? []).length, 4, "time/waiting, content, worker production and dynamic staff task selection must all obey the function payment gate");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkFinanceRuntimeCharacterization();
  console.log("FBL Skyhold finance runtime characterization checks passed.");
}
