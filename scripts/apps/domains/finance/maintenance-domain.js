import { normalizeBuildingMaintenance, maintenanceEfficiencyFactor } from "../../../data/economy/maintenance.js";
import { buildingLaborMode, staffAppointmentFor } from "../../../data/hybrid-labor.js";
import { buildingServiceFunctionId } from "../../../engines/economy/building-service.js";
import {
  applyMaintenancePeriodPlan,
  planMaintenancePeriod
} from "../../../engines/economy/maintenance-period.js";
import {
  MAINTENANCE_WORK_FUNCTION_ID,
  MAINTENANCE_WORK_SOURCE_ID,
  plannedAssignmentQd
} from "../../../data/work-allocations.js";

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function whole(value, fallback = 0) {
  return Math.max(0, Math.floor(finite(value, fallback)));
}

function text(value = "") {
  return String(value ?? "").trim();
}

function maintenanceOperationId(holding = {}, qd = 40, operationId = "") {
  const explicit = text(operationId);
  if (explicit) return explicit;
  const firstPeriod = Math.floor(whole(holding?.gm?.calendaria?.lastQd) / 40) + 1;
  const count = Math.max(1, Math.floor(Math.max(40, whole(qd, 40)) / 40));
  const lastPeriod = firstPeriod + count - 1;
  const period = firstPeriod === lastPeriod ? String(firstPeriod) : `${firstPeriod}-${lastPeriod}`;
  return `maintenance:${text(holding?.id) || "holding"}:tenday:${period}`;
}

export const FinanceMaintenanceDomain = {
_reserveStaffTechnicalMaintenance(holding, financeContext, periodQd = 40, operationId = "") {
  if (!financeContext || typeof this._reserveStaffWorkQd !== "function") return;
  const key = maintenanceOperationId(holding, periodQd, operationId);
  financeContext.staffMaintenanceReservationOps ??= new Set();
  if (financeContext.staffMaintenanceReservationOps.has(key)) return;
  for (const building of holding?.buildings?.list ?? []) {
    const maintenance = normalizeBuildingMaintenance(building.maintenance);
    if (buildingLaborMode(building) !== "staff" || maintenance.schemaVersion !== 2
      || maintenance.requiredPoints <= 0 || maintenance.lastOperationId === key
      || this._buildingStatus(building).value !== "built"
      || !this._financeFunctionAllowed(financeContext, building, MAINTENANCE_WORK_FUNCTION_ID)) continue;
    for (let cycle = 0; cycle < Math.floor(whole(periodQd) / 40); cycle++) {
      const startStep = cycle * 40, endStep = startStep + 40;
      let existing = 0;
      for (const [workerId, slots] of financeContext.plannedWorkSlotsByWorkerId ?? []) {
        if (financeContext.blockedWorkerIds?.has(workerId)) continue;
        for (const [step, slot] of slots) {
          if (step >= startStep && step < endStep && !slot.overtime
            && slot.sourceId === text(building.id) && slot.functionId === MAINTENANCE_WORK_FUNCTION_ID) existing++;
        }
      }
      const needed = Math.max(0, maintenance.requiredPoints - existing);
      if (needed > 0) this._reserveStaffWorkQd(holding, building, MAINTENANCE_WORK_FUNCTION_ID, needed, financeContext, {
        normalOnly: true, startStep, endStep
      });
    }
  }
  financeContext.staffMaintenanceReservationOps.add(key);
},

_prepareTechnicalServiceRestarts(holding, financeContext, report) {
  if (!financeContext?.technicalRestartIds?.size) return;
  financeContext.technicalServiceAssignments = new Map();
  const periodQd = whole(financeContext.periodQd, 40);
  for (const building of holding?.buildings?.list ?? []) {
    const id = text(building.id);
    if (!financeContext.technicalRestartIds.has(id) || this._buildingFunctions(building).production) continue;
    // Staff service is recorded from actual task execution. Unresolved "staff"
    // slots cannot be counted as an entire service shift before it happens.
    if (buildingLaborMode(building) === "staff") continue;
    const functionId = buildingServiceFunctionId(building);
    let readyStep = periodQd;
    for (let step = 0; step < periodQd; step += 1) {
      if (this._technicalMaintenanceReady(building, financeContext, step)) { readyStep = step; break; }
    }
    const assignments = [];
    for (const [workerId, slots] of financeContext.plannedWorkSlotsByWorkerId ?? []) {
      if (financeContext.blockedWorkerIds?.has(workerId)) continue;
      for (const [step, slot] of slots) {
        if (step < readyStep || slot.sourceId !== id || slot.functionId !== functionId
          || !this._financeFunctionAllowed(financeContext, building, slot.functionId)) continue;
        assignments.push({ workerId, sourceId: id, functionId, normalQd: slot.overtime ? 0 : 1, overtimeQd: slot.overtime ? 1 : 0 });
      }
    }
    financeContext.technicalServiceAssignments.set(id, assignments);
    const activeWorkerIds = [...new Set(assignments.map((row) => row.workerId))];
    const active = readyStep < periodQd && activeWorkerIds.length >= whole(building?.activation?.minWorkers)
      && assignments.length >= whole(building?.activation?.minOperationalQd);
    const reason = active ? "" : "После технической проверки не выполнен порог труда основной службы.";
    building.serviceState = { ...building.serviceState, functionId, active, reason,
      periodKey: text(financeContext.periodIdentity?.periodKey), workedQd: assignments.length,
      workedQdByFunction: { [functionId]: assignments.length }, activeWorkerIds };
    if (!active) report.skipped.push(`${building.name || id}: ${reason}`);
  }
},

_technicalMaintenanceReady(building, financeContext, step) {
  if (!financeContext?.technicalRestartIds?.has(text(building?.id))) return true;
  if (!this._financeFunctionAllowed(financeContext, building, MAINTENANCE_WORK_FUNCTION_ID)) return false;
  let completed = 0;
  const periodQd = whole(financeContext?.periodQd, 40);
  const cycleStep = step >= periodQd ? Math.max(0, whole(step) - 1) : whole(step);
  const cycleStart = Math.floor(cycleStep / 40) * 40;
  for (const [workerId, slots] of financeContext.plannedWorkSlotsByWorkerId ?? []) {
    if (financeContext.blockedWorkerIds?.has(workerId)) continue;
    for (const [slotStep, slot] of slots) {
      if (slotStep < cycleStart || slotStep >= step || slot.overtime || slot.sourceId !== text(building?.id)
        || slot.functionId !== MAINTENANCE_WORK_FUNCTION_ID) continue;
      completed += 1;
    }
  }
  return completed >= normalizeBuildingMaintenance(building?.maintenance).requiredPoints;
},

_maintenancePeriodDependencies(financeContext = null, periodQd = 40) {
  const tendayCount = Math.max(1, Math.floor(Math.max(40, whole(periodQd, 40)) / 40));
  const normalCapacity = 20 * tendayCount;
  const allocatedMaintenanceQd = (person) => plannedAssignmentQd(
    financeContext?.plannedAssignmentsByWorkerId?.get(text(person?.id)) ?? [],
    MAINTENANCE_WORK_SOURCE_ID,
    MAINTENANCE_WORK_FUNCTION_ID
  );
  const usesExplicitPlan = (person) => text(person?.workAllocationMode) === "explicit";
  const technicalSlots = (building, cycleIndex = null) => {
    const id = text(building?.id);
    if (!financeContext || !this._financeFunctionAllowed(financeContext, building, MAINTENANCE_WORK_FUNCTION_ID)) return [];
    const rows = [];
    for (const [workerId, slots] of financeContext.plannedWorkSlotsByWorkerId ?? []) {
      if (financeContext.blockedWorkerIds?.has(workerId)) continue;
      for (const [step, slot] of slots) {
        if (text(slot.sourceId) !== id) continue;
        if (cycleIndex !== null && Math.floor(step / 40) !== cycleIndex) continue;
        if (slot.functionId !== "staff" && !this._financeFunctionAllowed(financeContext, building, slot.functionId)) continue;
        rows.push(slot);
      }
    }
    return rows;
  };
  return {
    isBuildingEligible: (building) => this._buildingStatus(building).value === "built",
    isTechnicalActive: (building) => technicalSlots(building).length > 0,
    technicalQdForBuilding: (building, cycleIndex) => technicalSlots(building, cycleIndex)
      .filter((slot) => slot.functionId === MAINTENANCE_WORK_FUNCTION_ID && !slot.overtime).length,
    isWorkerAvailable: (person) => {
      const id = text(person?.id);
      const assignment = text(person?.workAssignment);
      if (!id) return false;
      if (!usesExplicitPlan(person) && (!assignment || ["Свободен", "Без работы", "Ребенок"].includes(assignment))) return false;
      if (person?.dead || whole(person?.injuredDays) > 0) return false;
      // A fixed employee cannot provide the settlement-wide legacy repair pool
      // in addition to their contracted building work.
      if (staffAppointmentFor(person)) return false;
      if (financeContext?.blockedWorkerIds?.has(id)) return false;
      return !usesExplicitPlan(person) || allocatedMaintenanceQd(person) > 0;
    },
    pointsForWorker: (person) => {
      const points = whole(person?.maintenancePointsPerTenday);
      if (!usesExplicitPlan(person)) return points;
      return Math.floor(points * allocatedMaintenanceQd(person) / normalCapacity);
    }
  };
},

_planMaintenanceForQd(holding, qd = 40, { operationId = "", financeContext = null } = {}) {
  return planMaintenancePeriod({
    buildings: holding?.buildings?.list ?? [],
    workers: holding?.people?.list ?? [],
    elapsedQd: qd,
    operationId: maintenanceOperationId(holding, qd, operationId),
    dependencies: this._maintenancePeriodDependencies(financeContext, qd)
  });
},

_applyMaintenancePeriodPlan(holding, plan, { financeContext = null } = {}) {
  const dependencies = this._maintenancePeriodDependencies(financeContext, plan?.elapsedQd);
  return applyMaintenancePeriodPlan({
    plan,
    dependencies: {
      ...dependencies,
      getBuildings: () => holding?.buildings?.list ?? [],
      getWorkers: () => holding?.people?.list ?? [],
      setMaintenance: (building, state) => {
        building.maintenance = normalizeBuildingMaintenance(state);
      }
    }
  });
},

_maintenanceEfficiencyFactor(building = {}) {
  return maintenanceEfficiencyFactor(building?.maintenance);
},

_appendMaintenanceReport(report, plan, applied) {
  if (!report) return;
  report.maintenance ??= {
    availablePoints: 0,
    allocatedPoints: 0,
    unusedPoints: 0,
    buildings: [],
    needsResolution: [],
    replay: false
  };
  const target = report.maintenance;
  target.availablePoints += whole(plan?.totals?.availablePoints);
  target.allocatedPoints += whole(plan?.totals?.allocatedPoints);
  target.unusedPoints += whole(plan?.totals?.unusedPoints);
  target.allocatedTechnicalQd = whole(target.allocatedTechnicalQd) + whole(plan?.totals?.allocatedTechnicalQd);
  target.replay = target.replay || applied?.replay === true;

  for (const entry of plan?.entries ?? []) {
    const finalCycle = entry.cycles?.at?.(-1) ?? null;
    const row = {
      buildingId: entry.buildingId,
      unit: entry.unit ?? "points",
      name: entry.buildingName,
      requiredPoints: entry.requiredPoints,
      priority: entry.priority,
      backlogBefore: entry.stateBefore?.backlogTendays ?? 0,
      backlogAfter: entry.stateAfter?.backlogTendays ?? 0,
      efficiencyFactor: maintenanceEfficiencyFactor(entry.stateAfter),
      needsResolution: entry.stateAfter?.needsResolution === true,
      allocatedPoints: (entry.cycles ?? []).reduce((sum, cycle) => sum + whole(cycle?.allocatedPoints), 0)
    };
    target.buildings.push(row);
    if (finalCycle && !finalCycle.fullyMaintained) {
      report.skipped?.push?.(`${row.name}: обслуживание ${finalCycle.allocatedPoints}/${finalCycle.requiredPoints} ${row.unit === "qd" ? "QD" : "очков"}; backlog ${row.backlogAfter}.`);
    }
    if (row.needsResolution) {
      target.needsResolution.push({ buildingId: row.buildingId, name: row.name, backlogTendays: row.backlogAfter });
      if (finalCycle?.needsResolutionRaised) report.skipped?.push?.(`${row.name}: третий пропуск обслуживания — требуется решение GM; автоматического разрушения нет.`);
    }
  }
},

_runMaintenanceForQd(holding, qd = 40, report = null, { operationId = "", financeContext = null } = {}) {
  this._reserveStaffTechnicalMaintenance(holding, financeContext, qd, operationId);
  const plan = this._planMaintenanceForQd(holding, qd, { operationId, financeContext });
  const applied = this._applyMaintenancePeriodPlan(holding, plan, { financeContext });
  if (!applied.ok) return { ...applied, plan };
  this._appendMaintenanceReport(report, plan, applied);
  return { ok: true, replay: applied.replay === true, plan, applied };
}
};

export { maintenanceOperationId };
