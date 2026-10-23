import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FinanceAgricultureDomain } from "../apps/domains/finance/agriculture-domain.js";
import { FinanceMaintenanceDomain } from "../apps/domains/finance/maintenance-domain.js";
import { DEFAULT_BUILDING_TEMPLATES } from "../data/building-templates.js";

function agriculturalFixture({ efficiency = 1, sow = 1, grow = 100, harvest = 2 } = {}) {
  const building = structuredClone(DEFAULT_BUILDING_TEMPLATES.find((row) => row.id === "grain-field"));
  building.id = "plot";
  building.templateId = "grain-field";
  building.labor.mode = "staff";
  building.agriculture.crops = [{
    id: "grain", label: "Зерно", resourceId: "grain", outputQty: 8,
    sowingSeasons: ["spring"], sowingWorkQd: sow, growingQd: grow, harvestWorkQd: harvest,
    expiryRule: "qd", readyExpiryQd: 120, annualHarvestLimit: 1, perennial: false
  }];
  const person = { id: "farmer" };
  const holding = { id: "holding", gm: { calendaria: { lastQd: 0 } }, buildings: { list: [building] }, people: { list: [person] } };
  const financeContext = { staffCurrentFunctionByWorkerId: new Map([["farmer", "agriculture"]]), spent: 0 };
  const workerContext = { financeContext };
  const entry = { staff: true, available: 0, spent: 0 };
  const host = {
    ...FinanceAgricultureDomain,
    _buildingStatus: () => ({ value: "built" }),
    _buildingFunctions: () => ({ production: true }),
    _financeFunctionAllowed: () => true,
    _technicalMaintenanceReady: () => true,
    _agricultureCalendarContext: () => ({ year: "1", seasonId: "spring", seasonKey: "1:spring" }),
    _activeAssignedBuildingPeople: () => [person],
    _buildingCompositionStatus: () => ({ met: true }),
    _personBuildingEfficiency: () => efficiency,
    _maintenanceEfficiencyFactor: () => 1,
    _workerBudgetEntry: () => entry,
    _consumeStaffWorkerQd: (_context, budget, _functionId, needed) => {
      if (budget.available < needed) return { ok: false, spent: 0 };
      budget.available -= needed;
      budget.spent += needed;
      financeContext.spent += needed;
      return { ok: true, spent: needed };
    },
    _normalizeStorageRoomId: (value) => value,
    _storageAddWithOverflow: (target, _destination, qty) => {
      target.received = (target.received ?? 0) + qty;
      return { added: qty };
    }
  };
  const report = { produced: [], work: [], skipped: [], ledger: [] };
  const step = (offset, work = 0) => {
    entry.available += work;
    return host._runStaffAgricultureStep(holding, offset, report, { operationId: "period", workerContext, financeContext });
  };
  return { host, holding, building, person, financeContext, workerContext, entry, report, step };
}

export function checkHybridLaborPeriodic() {
  {
    const f = agriculturalFixture({ efficiency: 0.5 });
    const initial = structuredClone(f.building.agriculture);
    const ordinary = f.host._runAgricultureForQd(f.holding, 40, f.report, {
      operationId: "legacy-period", workerContext: f.workerContext, financeContext: f.financeContext
    });
    assert.equal(ordinary.plan.entries.length, 0, "A staff field must not also receive the aggregate QD period");
    assert.deepEqual(f.building.agriculture, initial);
    assert.equal(f.host._staffAgricultureWorkAvailable(f.holding, f.building, f.workerContext, 0), true);
    assert.equal(f.step(0, 1).ok, true);
    assert.equal(f.building.agriculture.state.phase, "empty", "Half an effective QD must carry until the next actual work slot");
    assert.equal(f.step(1, 1).ok, true);
    assert.equal(f.building.agriculture.state.phase, "growing");
    assert.equal(f.financeContext.spent, 2);
    assert.equal(f.entry.available, 0, "Sowing cannot lend the same personal time to a production line");
    assert.equal(f.host._staffAgricultureWorkAvailable(f.holding, f.building, f.workerContext, 2), false);
    const age = f.building.agriculture.state.growingElapsedQd;
    f.step(2, 0);
    assert.equal(f.building.agriculture.state.growingElapsedQd, age + 1, "Calendar growth continues without workers");
    const after = structuredClone(f.building.agriculture);
    f.step(2, 0);
    assert.deepEqual(f.building.agriculture, after, "A replayed step cannot advance the crop twice");
    assert.equal(f.financeContext.spent, 2);
    f.host._flushStaffAgricultureReport(f.holding, f.report, f.financeContext);
    assert.equal(f.report.agriculture.buildings.length, 1, "A period yields one readable report row per field");
    assert.equal(f.report.agriculture.workQdUsed, 1);
    f.host._flushStaffAgricultureReport(f.holding, f.report, f.financeContext);
    assert.equal(f.report.agriculture.buildings.length, 1);
  }
  {
    const f = agriculturalFixture();
    f.financeContext.staffCurrentFunctionByWorkerId.set("farmer", "production:mill");
    f.step(0, 1);
    assert.equal(f.financeContext.spent, 0, "A reserve field cannot steal the selected primary task's QD");
    assert.equal(f.entry.available, 1);
    f.financeContext.staffCurrentFunctionByWorkerId.set("farmer", "agriculture");
    f.host._agricultureCalendarContext = () => ({ year: "1", seasonId: "winter", seasonKey: "1:winter" });
    assert.equal(f.host._staffAgricultureWorkAvailable(f.holding, f.building, f.workerContext, 1), false);
    f.step(1, 0);
    assert.equal(f.financeContext.spent, 0, "Work outside the actual sowing season is not consumed");
  }
  {
    const f = agriculturalFixture({ efficiency: 3, sow: 1 });
    f.step(0, 1);
    assert.equal(f.financeContext.spent, 1);
    assert.equal(f.financeContext.staffAgricultureRuntime.get("plot").units, 0, "Efficiency left after sowing cannot prepay future harvesting or another task");
    f.building.agriculture.state = {
      ...f.building.agriculture.state, phase: "ready", cropId: "grain",
      harvestWorkQdTotal: 2, harvestProgressQd: 0, harvestTotalQty: 8, harvestedQty: 0, readyQty: 8,
      readyAgeQd: 0, readySeasonKey: "1:spring"
    };
    f.step(1, 1);
    assert.equal(f.holding.received, 8);
    assert.equal(f.financeContext.spent, 2);
    assert.equal(f.building.agriculture.state.phase, "empty");
  }
  {
    const f = agriculturalFixture({ efficiency: 0.5, grow: 2, harvest: 2 });
    f.building.agriculture.state = { phase: "growing", cropId: "grain", growingElapsedQd: 1, harvestYear: "1" };
    f.step(0, 1);
    assert.equal(f.building.agriculture.state.phase, "ready");
    assert.equal(f.financeContext.staffAgricultureRuntime.get("plot").units, 5000, "Half a harvesting QD survives the growing-to-ready transition");
    f.step(1, 1);
    assert.equal(f.holding.received, 4);
    assert.equal(f.financeContext.spent, 2);
  }
  {
    const f = agriculturalFixture();
    f.host._financeFunctionAllowed = () => false;
    f.building.agriculture.state = { phase: "growing", cropId: "grain", growingElapsedQd: 4, harvestYear: "1" };
    f.step(0, 1);
    assert.equal(f.financeContext.spent, 0);
    assert.equal(f.building.agriculture.state.growingElapsedQd, 5, "Debt cannot freeze the biological calendar");
  }
  {
    const building = { id: "plant", name: "Завод", labor: { version: 1, mode: "staff", capacityQd: null },
      maintenance: { schemaVersion: 2, requiredPoints: 2, backlogTendays: 1 } };
    const person = { id: "technician", workAssignment: "plant", maintenancePointsPerTenday: 3,
      staffAppointment: { buildingId: "plant", primaryFunctionId: "production:line", reserveFunctionId: "maintenance" } };
    const holding = { id: "holding", buildings: { list: [building] }, people: { list: [person] }, gm: {} };
    const slots = new Map([[0, { sourceId: "plant", functionId: "staff", overtime: false }],
      [1, { sourceId: "plant", functionId: "staff", overtime: false }], [4, { sourceId: "plant", functionId: "staff", overtime: false }]]);
    const finance = { periodQd: 40, plannedWorkSlotsByWorkerId: new Map([["technician", slots]]),
      blockedWorkerIds: new Set(), technicalRestartIds: new Set(["plant"]), reserved: 0 };
    const host = {
      ...FinanceMaintenanceDomain,
      _buildingStatus: () => ({ value: "built" }),
      _financeFunctionAllowed: () => true,
      _reserveStaffWorkQd: (_holding, _building, functionId, needed, context, options) => {
        assert.equal(options.normalOnly, true);
        let spent = 0;
        for (const [step, slot] of slots) {
          if (step < options.startStep || step >= options.endStep || slot.functionId !== "staff" || slot.overtime) continue;
          slot.functionId = functionId;
          spent++;
          if (spent >= needed) break;
        }
        context.reserved += spent;
        return { spent, rows: [] };
      }
    };
    const result = host._runMaintenanceForQd(holding, 40, null, { operationId: "period", financeContext: finance });
    assert.equal(result.ok, true);
    assert.equal(finance.reserved, 2);
    assert.equal(slots.get(4).functionId, "staff", "Only required maintenance quarters are reserved");
    assert.equal(building.maintenance.backlogTendays, 0);
    assert.equal(result.plan.providers.length, 0, "A fixed employee cannot simultaneously contribute free legacy maintenance points");
    assert.equal(host._technicalMaintenanceReady(building, finance, 1), false);
    assert.equal(host._technicalMaintenanceReady(building, finance, 2), true, "Production may restart only after the reserved technical work");
    assert.equal(host._technicalMaintenanceReady(building, finance, 40), true, "The final report at the period boundary still describes the completed tenday");
    assert.equal(host._technicalMaintenanceReady(building, { ...finance, periodQd: 80 }, 40), false,
      "A new tenday inside a longer calculation cannot reuse the previous tenday's technical quarters");
    host._reserveStaffTechnicalMaintenance(holding, finance, 40, "period");
    assert.equal(finance.reserved, 2, "A repeated preparation cannot consume maintenance twice");
  }
  return { fractionalAgriculture: true, calendarAndReserve: true, sharedTime: true, maintenanceReservation: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(checkHybridLaborPeriodic()));
}
