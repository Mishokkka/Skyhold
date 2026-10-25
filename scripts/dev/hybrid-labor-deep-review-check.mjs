import assert from "node:assert/strict";
import { hybridRuntimeFixture } from "./hybrid-labor-runtime-check.mjs";
import { SkyholdData } from "../data/store.js";
import { createWorkforceDraft, workforceDraftError } from "../apps/domains/workforce-planner.js";
import { removeWorkforceStaff } from "../apps/domains/workforce-staff.js";
import { executeWorkforcePlan } from "../apps/workforce-plan-executor.js";
import { getSkyholdWorkflowService } from "../workflows/skyhold-workflow-service.js";
import { returnCrewResidentToShip, embarkShipCrew, disembarkShipCrew } from "../engines/ships/crew.js";
import { isResidentInPopulation, isResidentRestingOnShip } from "../data/resident-presence.js";
import { FinanceStaffDomain } from "../apps/domains/finance/staff-domain.js";
import { DEFAULT_BUILDING_TEMPLATES } from "../data/building-templates.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { validateHoldingWorkAllocations } from "../data/work-allocations.js";
import { financePeriodIdentity } from "../engines/economy/finance-period.js";
import { makeFinanceObligation } from "../engines/economy/finance-obligations.js";

const quantity = (holding, id) => (holding.storage.resources ?? []).filter((row) => row.resourceId === id).reduce((sum, row) => sum + row.qty, 0);
async function run(f, operationId) {
  SkyholdData.view = () => ({ holdings: [f.holding], catalog: {} });
  return f.harness._runEconomyForQd(f.holding, 40, { operationId });
}

export async function checkHybridLaborDeepReview() {
  const prior = { game: globalThis.game, view: SkyholdData.view };
  globalThis.game = { user: { isGM: true }, settings: { get: () => undefined } };
  try {
    const service = getSkyholdWorkflowService();
    for (const variant of ["mothball", "base", "operation", "staff", "production:main", "ingredients"]) {
      const f = hybridRuntimeFixture();
      f.holding.gm.calendaria.lastQd = 40;
      f.building.baseUpkeepMonthlyCopper = 30;
      f.building.operatingUpkeepMonthlyCopper = 60;
      const agreement = structuredClone(f.person.staffAppointment);
      if (variant === "mothball") f.holding.finance.buildingStates.workshop = { mothballed: true };
      else if (variant === "ingredients") {
        for (const line of f.building.productionLines) line.expenses = "ore 1";
      } else f.holding.finance.obligations.push(makeFinanceObligation({
        kind: variant === "base" ? "building-base-upkeep" : "building-operating-upkeep",
        recipientKind: "building", recipientId: "workshop", sourceId: "workshop",
        functionId: variant === "base" ? "" : variant, periodKey: "tenday:1", periodIndex: 1,
        dueCopper: 30, operationId: `old-${variant}`
      }));
      SkyholdData.view = () => ({ holdings: [f.holding], catalog: {} });
      const suspended = ["mothball", "base", "operation", "staff"].includes(variant);
      const inputs = f.harness._financePlanInputs(f.holding, 40, financePeriodIdentity(f.holding, 40));
      const worker = inputs.workers.find((row) => row.id === f.person.id);
      assert.deepEqual(worker.staffAppointment, agreement, "A finance suspension must retain the staff agreement");
      assert.equal(worker.assignments.length, suspended ? 0 : 1, `${variant}: only old building/staff blockers suspend planned paid QD`);
      const beforeProjection = structuredClone(f.holding);
      const projection = f.harness._canonicalFinanceProjection(f.holding);
      assert.deepEqual(f.holding, beforeProjection, "Finance preview must not alter the agreement or settle old debts");
      assert.equal(projection.salaryTenDayCopper, suspended ? 0 : 120, `${variant}: preview uses the same wage gate as settlement`);
      const report = await run(f, `staff-finance-${variant}`);
      const current = f.holding.finance.obligations.filter((row) => row.periodKey === "tenday:2");
      const wages = current.filter((row) => row.kind === "wage");
      assert.equal(wages.reduce((sum, row) => sum + row.dueCopper, 0), suspended ? 0 : 120);
      assert.equal(wages.reduce((sum, row) => sum + row.paidCopper, 0), suspended ? 0 : 120);
      assert.equal(quantity(f.holding, "wood"), 0);
      assert.equal(quantity(f.holding, "stone"), variant === "production:main" ? 20 : 0,
        "Function-specific primary debt allows the reserve; missing inputs and whole-contract suspension do no work");
      assert.equal(f.building.serviceState.workedQd, variant === "production:main" ? 20 : 0);
      assert.deepEqual(f.person.staffAppointment, agreement);
      assert.equal(f.person.workAssignment, "workshop");
      assert.ok(f.building.assignedWorkerIds.includes(f.person.id));
      const currentDue = variant === "mothball" ? 0 : suspended ? 10 : 150;
      assert.equal(current.reduce((sum, row) => sum + row.dueCopper, 0), currentDue,
        "Mothball stops all accrual; an un-mothballed building retains base upkeep while suspended work adds no operating cost");
      const oldDebt = ["mothball", "ingredients"].includes(variant) ? 0 : 30;
      assert.equal(f.holding.storage.moneyCopper, 10000 - currentDue - oldDebt);
      assert.equal(projection.projectedTreasuryCopper, f.holding.storage.moneyCopper);
      if (variant === "ingredients") assert.ok(report.work.some((line) => line.includes("оплачиваемый простой 20 QD")),
        "Ordinary ingredient shortage remains paid staff idle time");
      const draft = createWorkforceDraft(f.holding, f.harness);
      assert.deepEqual(draft.staffAppointments[f.person.id], agreement);
      draft.edited.push(f.person.id);
      draft.allocations[f.person.id] = [{ schemaVersion: 1, id: "external-during-suspension", sourceId: "elsewhere",
        functionId: "culture", normalQd: 1, overtimeQd: 0 }];
      assert.match(workforceDraftError(f.holding, draft, { isGM: true }), /Постоянная работа несовместима/,
        "Suspension never releases a permanent worker for external assignments");
      if (suspended) {
        const balance = f.holding.storage.moneyCopper;
        f.holding.gm.calendaria.lastQd = 80;
        if (variant === "mothball") f.holding.finance.buildingStates.workshop.mothballed = false;
        assert.equal(f.harness._canonicalFinanceProjection(f.holding).salaryTenDayCopper, 120,
          "The next plan resumes the retained contract after debt settlement or an explicit end to mothball");
        await run(f, `staff-finance-recovered-${variant}`);
        assert.equal(quantity(f.holding, "wood"), 5);
        assert.equal(quantity(f.holding, "stone"), 15);
        assert.equal(f.building.serviceState.workedQd, 20);
        assert.equal(f.holding.storage.moneyCopper, balance - 150);
        assert.deepEqual(f.person.staffAppointment, agreement);
      }
    }
    {
      const f = hybridRuntimeFixture({ goal: null });
      Object.assign(f.building.productionLines[0], { outputQty: 10, workQd: 30 });
      await run(f, "staff-funded-before-reload");
      assert.equal(f.building.productionLines[0].workProgressUnits, 200000);
      assert.equal(quantity(f.holding, "wood"), 0);
      assert.equal(f.holding.storage.moneyCopper, 9880);
      const reloaded = mergeHoldingDefaults(JSON.parse(JSON.stringify(f.holding)));
      assert.equal(validateHoldingWorkAllocations(reloaded).ok, true);
      assert.deepEqual(reloaded.people.list[0].staffAppointment, f.person.staffAppointment,
        "JSON reload and normal loading must preserve the complete staff agreement");
      assert.deepEqual(reloaded.buildings.list[0].productionLines[0].workReservedInputs,
        f.building.productionLines[0].workReservedInputs, "Reload must preserve the funded recipe and its timing");
      assert.equal(reloaded.buildings.list[0].productionLines[0].workProgressUnits, 200000);
      reloaded.gm.calendaria.lastQd = 40;
      await run({ ...f, holding: reloaded }, "staff-funded-after-reload");
      assert.equal(quantity(reloaded, "wood"), 10, "The next tenday completes the paid partial batch after reload");
      assert.equal(reloaded.storage.moneyCopper, 9760, "Each tenday charges the same agreement once across reload");
    }
    for (const isGM of [true, false]) {
      const f = hybridRuntimeFixture();
      f.holding.visibility = "public"; f.holding.gm.playersCanEditBuildings = true;
      f.person.visibility = "public"; f.holding.buildings.list = [];
      const draft = createWorkforceDraft(f.holding, service);
      const invalidChange = structuredClone(draft);
      invalidChange.staffAppointments[f.person.id].wageDailyCopper += 1;
      invalidChange.edited.push(f.person.id);
      assert.ok(workforceDraftError(f.holding, invalidChange, { isGM }), "A missing employer cannot receive an updated or newly created contract");
      removeWorkforceStaff(draft, f.person.id);
      const original = structuredClone(f.holding), token = Symbol("skip");
      let persisted = f.holding, writes = 0;
      const result = await executeWorkforcePlan({ holdingId: f.holding.id, operationId: `orphan-${isGM}`, expectedRevision: 1, draft }, {
        getUser: () => ({ isGM }), store: {
          skipTransaction: (value) => ({ [token]: true, value }),
          updateHolding: async (_id, update) => {
            const copy = structuredClone(persisted), value = update(copy, { meta: { revision: 1 } });
            if (value?.[token]) return value.value;
            persisted = copy; writes += 1; return value;
          }
        }
      });
      assert.equal(result.ok, isGM, "Only the GM may repair an orphaned or hidden contract through the ordinary save executor");
      assert.equal(writes, isGM ? 1 : 0);
      if (isGM) {
        assert.equal(persisted.people.list[0].staffAppointment, undefined);
        assert.equal(persisted.people.list[0].workAssignment, "");
      } else assert.deepEqual(persisted, original, "A denied player request cannot partially repair protected data");
    }

    for (const count of [2, 3]) for (const reverse of [false, true]) {
      const f = hybridRuntimeFixture({ count, goal: null, reverse });
      if (reverse) f.holding.people.list.reverse();
      if (count === 3) {
        const busy = f.holding.people.list.find((p) => p.id === "worker-2");
        f.building.functions.culture = true;
        Object.assign(busy.staffAppointment, { primaryFunctionId: "culture", reserveFunctionId: "production:main" });
      }
      for (const line of f.building.productionLines) Object.assign(line, {
        active: false, requiresCollection: true, pendingQty: 4, collectQd: line.id === "main" ? 5 : 3, autoCollect: "none"
      });
      const report = await run(f, `reserve-team-${count}-${reverse}`);
      assert.equal(quantity(f.holding, "wood"), 0, "A busy third worker cannot make an infeasible primary collection feasible");
      assert.equal(quantity(f.holding, "stone"), 4, "The two available employees must form a feasible reserve collection team");
      assert.equal(f.holding.storage.moneyCopper, 10000 - 120 * count);
      assert.equal(f.building.serviceState.workedQdByFunction["production:reserve"], 3, "The shared collection is charged exactly once");
      if (count === 3) assert.equal(f.building.serviceState.workedQdByFunction.culture, 20);
      assert.equal(report.skipped.length, 1, "Provisional priority offers must not emit false reserve shortages");
      assert.match(report.skipped[0], /сбор требует 5 QD.*не хватает 1 QD/);
    }
    {
      const f = hybridRuntimeFixture({ count: 2, goal: null });
      for (const line of f.building.productionLines) Object.assign(line, {
        active: false, requiresCollection: true, pendingQty: 4, collectQd: 3, autoCollect: "none"
      });
      Object.assign(f.holding.people.list[1].staffAppointment, { primaryFunctionId: "production:reserve", reserveFunctionId: "production:main" });
      const report = await run(f, "crossed-collection-priorities");
      assert.equal(quantity(f.holding, "wood"), 4); assert.equal(quantity(f.holding, "stone"), 4);
      assert.equal(f.building.serviceState.workedQd, 6);
      assert.deepEqual(report.skipped, [], "A collection completed after the team becomes free must not leave a period-level shortage warning");
    }
    {
      let payments = 0;
      const financeContext = { staffCollectionProbe: true }, workerContext = { financeContext };
      const building = { id: "hall", fuelAlternatives: [{ resourceId: "wood", qty: 2 }] };
      const host = { ...FinanceStaffDomain, _financeFunctionAllowed: () => true, _technicalMaintenanceReady: () => true,
        _storageCanPay: () => ({ ok: true }), _runInstitutionConsumables: () => { payments += 1; } };
      assert.equal(await host._staffFunctionNeedsWork({}, building, "culture", {}, workerContext, 0), true);
      assert.equal(payments, 0, "A tentative priority choice cannot consume service fuel");
      assert.equal(financeContext.staffConsumablesStarted, undefined);
      financeContext.staffCollectionProbe = false;
      await host._staffFunctionNeedsWork({}, building, "culture", {}, workerContext, 0);
      await host._staffFunctionNeedsWork({}, building, "culture", {}, workerContext, 1);
      assert.equal(payments, 1, "An executed service pays its period fuel once");
    }
    {
      const appointment = { buildingId: "plant", primaryFunctionId: "production:line", reserveFunctionId: "" };
      const financeContext = { staffStep: 0, staffAppointmentsByWorkerId: new Map([["worker", appointment]]),
        staffReservedStepsByWorkerId: new Map(), staffOvertimeFunctionsByWorkerId: new Map([["worker", new Set()]]),
        staffWorkByWorkerId: new Map(), staffWorkLedger: [], staffCollectionBudgetCache: new Map(),
        plannedWorkSlotsByWorkerId: new Map([["worker", new Map([0, 1].map((step) => [step, { sourceId: "plant", functionId: "staff" }]))]]) };
      const workerContext = { financeContext }, building = { id: "plant" }, host = { ...FinanceStaffDomain };
      assert.equal(host._staffDailyCollectionBudget(building, "production:line", workerContext), 2);
      const entry = { staff: true, workerId: "worker", sourceId: "plant", available: 2, spent: 0,
        tokens: [0, 1].map((step) => ({ step, overtime: false, qd: 1 })) };
      host._consumeStaffWorkerQd(workerContext, entry, "production:line", 1);
      assert.equal(host._staffDailyCollectionBudget(building, "production:line", workerContext), 1,
        "A cached collection quote cannot reuse a QD spent by an earlier worker selection");
    }

    for (const globalIssue of [false, true]) {
      const f = hybridRuntimeFixture({ count: 2 });
      if (globalIssue) f.building.workersMax = 1;
      else f.person.staffAppointment.wageDailyCopper = 0;
      const report = await run(f, `contract-issue-scope-${globalIssue}`);
      assert.equal(quantity(f.holding, "wood"), globalIssue ? 0 : 5);
      assert.equal(quantity(f.holding, "stone"), globalIssue ? 0 : 15);
      assert.equal(f.holding.storage.moneyCopper, globalIssue ? 10000 : 9880,
        "A resident's malformed contract blocks that resident; an employer's overcapacity still blocks the entire invalid roster");
      if (!globalIssue) assert.ok(!report.skipped.some((row) => row.startsWith("Worker 1: работа остановлена")));
    }

    for (const withMessage of [true, false]) {
      const f = hybridRuntimeFixture({ goal: null });
      f.building.agriculture = structuredClone(DEFAULT_BUILDING_TEMPLATES.find((row) => row.id === "grain-field").agriculture);
      Object.assign(f.building.agriculture, {
        crops: [{ id: "grain", resourceId: "grain", outputQty: 8, sowingSeasons: ["spring"], sowingWorkQd: 1,
          growingQd: 8, harvestWorkQd: 2, expiryRule: "qd", readyExpiryQd: 120, annualHarvestLimit: 1 }],
        activeCropId: "grain", operations: { sow: false, harvest: true },
        state: { phase: "ready", cropId: "grain", growingElapsedQd: 8, harvestYear: "1" }
      });
      Object.assign(f.person.staffAppointment, { primaryFunctionId: "agriculture", reserveFunctionId: "" });
      f.harness._agricultureCalendarContext = () => ({ year: "1", seasonId: "spring", seasonKey: "1:spring" });
      const apply = f.harness._applyAgriculturePeriodPlan;
      let rejections = 0, failureMessage = "", livestockSteps = 0, finalizations = 0;
      f.harness._applyAgriculturePeriodPlan = function (holding, plan) {
        if (!plan.entries.length) return apply.call(this, holding, plan);
        const stale = structuredClone(plan);
        stale.entries[0].stateBeforeSignature += ":stale";
        const result = apply.call(this, holding, stale);
        assert.equal(result.ok, false, "The real agriculture apply must reject the stale state signature");
        rejections += 1; failureMessage = result.message;
        return withMessage ? result : { ...result, message: "" };
      };
      f.harness._runLivestockForQd = () => { livestockSteps += 1; return { ok: true }; };
      f.harness._finishStaffExecution = () => { finalizations += 1; };
      await assert.rejects(() => run(f, `staff-agriculture-rejection-${withMessage}`), (error) => {
        assert.equal(error.message, withMessage ? failureMessage : "Не удалось рассчитать сельскохозяйственные работы по плану.");
        return true;
      }, "A rejected staff agriculture plan must abort the economy calculation");
      assert.equal(rejections, 1, "A failed step must not be silently retried on subsequent steps");
      assert.equal(livestockSteps, 0); assert.equal(finalizations, 0);
      assert.equal(f.building.agriculture.state.phase, "ready");
      assert.equal(quantity(f.holding, "grain"), 0);
    }

    for (const voyage of [false, true]) {
      const f = hybridRuntimeFixture();
      const ship = { id: "ship", crewResidentIds: [f.person.id], status: "docked", location: { kind: "home" } };
      f.holding.special.ships = { list: [ship] };
      assert.equal(isResidentInPopulation(f.person, f.holding), true, "A shore worker with a civilian contract remains in the settlement before recall");
      if (voyage) {
        embarkShipCrew(f.holding, ship, 0);
        assert.equal(f.person.staffAppointment, undefined);
        disembarkShipCrew(f.holding, ship, 4);
      } else returnCrewResidentToShip(f.holding, ship, f.person.id);
      assert.equal(f.person.staffAppointment, undefined, "Returning or embarking a crew member must release the civilian contract");
      assert.equal(isResidentRestingOnShip(f.person, f.holding), true);
      assert.equal(isResidentInPopulation(f.person, f.holding), false);
      await run(f, `crew-contract-${voyage}`);
      assert.equal(f.holding.storage.moneyCopper, 10000, "A resting crew member must not keep receiving a civilian staff wage");
      assert.equal(quantity(f.holding, "wood"), 0); assert.equal(quantity(f.holding, "stone"), 0);
      assert.ok(!f.building.assignedWorkerIds.includes(f.person.id));
    }
  } finally { globalThis.game = prior.game; SkyholdData.view = prior.view; }
}
