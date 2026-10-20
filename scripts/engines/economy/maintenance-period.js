import {
  maintenanceEfficiencyFactor,
  normalizeBuildingMaintenance,
  normalizeMaintenancePointsPerTenday
} from "../../data/economy/maintenance.js";

const TENDAY_QD = 40;

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

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function compareText(left, right) {
  const a = text(left);
  const b = text(right);
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function defaultBuildingEligibility(building = {}) {
  if (building.lifecycle !== undefined || building.condition !== undefined) {
    return String(building.lifecycle ?? "active") === "active"
      && String(building.condition ?? "intact") === "intact"
      && building?.repair?.active !== true;
  }
  return String(building.constructionStatus ?? "built") === "built";
}

function defaultWorkerAvailability(worker = {}) {
  return worker?.dead !== true && whole(worker?.injuredDays) === 0;
}

function planDependencies(dependencies = {}) {
  return {
    isBuildingEligible: typeof dependencies.isBuildingEligible === "function"
      ? dependencies.isBuildingEligible
      : defaultBuildingEligibility,
    isWorkerAvailable: typeof dependencies.isWorkerAvailable === "function"
      ? dependencies.isWorkerAvailable
      : defaultWorkerAvailability,
    isTechnicalActive: typeof dependencies.isTechnicalActive === "function" ? dependencies.isTechnicalActive : () => false,
    technicalQdForBuilding: typeof dependencies.technicalQdForBuilding === "function" ? dependencies.technicalQdForBuilding : () => 0,
    pointsForWorker: typeof dependencies.pointsForWorker === "function"
      ? dependencies.pointsForWorker
      : (worker) => worker?.maintenancePointsPerTenday
  };
}

function maintenanceBuildingRows(buildings = [], dependencies = {}) {
  const deps = planDependencies(dependencies);
  return (Array.isArray(buildings) ? buildings : [])
    .filter((building) => deps.isBuildingEligible(building))
    .map((building) => ({
      building,
      buildingId: text(building?.id),
      buildingName: text(building?.name || building?.id || "Здание"),
      maintenance: normalizeBuildingMaintenance(building?.maintenance)
    }))
    .filter((row) => row.buildingId)
    .filter((row) => row.maintenance.schemaVersion !== 2 || (row.maintenance.requiredPoints > 0 && deps.isTechnicalActive(row.building)))
    .filter((row) => row.maintenance.requiredPoints > 0 || row.maintenance.backlogTendays > 0 || row.maintenance.needsResolution)
    .sort((left, right) => (
      right.maintenance.priority - left.maintenance.priority
      || compareText(left.buildingId, right.buildingId)
    ));
}

function maintenanceWorkerRows(workers = [], dependencies = {}) {
  const deps = planDependencies(dependencies);
  return (Array.isArray(workers) ? workers : [])
    .map((worker) => ({
      worker,
      workerId: text(worker?.id),
      workerName: text(worker?.name || worker?.id || "Работник"),
      pointsPerTenday: normalizeMaintenancePointsPerTenday(deps.pointsForWorker(worker)),
      available: Boolean(deps.isWorkerAvailable(worker))
    }))
    .filter((row) => row.workerId)
    .sort((left, right) => compareText(left.workerId, right.workerId));
}

export function maintenanceStateSignature(value = {}) {
  return JSON.stringify(normalizeBuildingMaintenance(value));
}

export function maintenancePeriodInputSignature({
  buildings = [],
  workers = [],
  elapsedQd = TENDAY_QD,
  dependencies = {}
} = {}) {
  const buildingRows = maintenanceBuildingRows(buildings, dependencies).map((row) => ({
    buildingId: row.buildingId,
    maintenance: row.maintenance,
    ...(row.maintenance.schemaVersion === 2 ? { technicalQd: Array.from({ length: Math.floor(whole(elapsedQd) / TENDAY_QD) }, (_, index) => whole(planDependencies(dependencies).technicalQdForBuilding(row.building, index))) } : {})
  }));
  const workerRows = maintenanceWorkerRows(workers, dependencies).map((row) => ({
    workerId: row.workerId,
    pointsPerTenday: row.pointsPerTenday,
    available: row.available
  }));
  return JSON.stringify({ elapsedQd: whole(elapsedQd), buildingRows, workerRows });
}

function nextMaintenanceState(before, requiredPoints, allocatedPoints) {
  const requirement = Math.min(3, whole(requiredPoints));
  const fullyMaintained = requirement === 0 || whole(allocatedPoints) >= requirement;
  const backlogTendays = fullyMaintained ? 0 : before.backlogTendays + 1;
  return {
    ...before,
    backlogTendays,
    needsResolution: before.needsResolution || backlogTendays >= 3
  };
}

export function planMaintenancePeriod({
  buildings = [],
  workers = [],
  elapsedQd = TENDAY_QD,
  operationId = "",
  dependencies = {}
} = {}) {
  const op = text(operationId);
  if (!op) throw new TypeError("FBL Skyhold | Maintenance period requires operationId.");
  const periodQd = whole(elapsedQd);
  const tendayCount = Math.floor(periodQd / TENDAY_QD);
  const ignoredQd = periodQd - tendayCount * TENDAY_QD;
  const buildingRows = maintenanceBuildingRows(buildings, dependencies);
  const workerRows = maintenanceWorkerRows(workers, dependencies);
  const activeProviders = workerRows.filter((row) => row.available && row.pointsPerTenday > 0);
  const pointsPerTenday = activeProviders.reduce((sum, row) => sum + row.pointsPerTenday, 0);
  const states = new Map(buildingRows.map((row) => [row.buildingId, clone(row.maintenance)]));
  const deps = planDependencies(dependencies);
  const cycleRows = [];

  for (let cycleIndex = 0; cycleIndex < tendayCount; cycleIndex += 1) {
    let remainingPoints = pointsPerTenday;
    const allocations = [];
    for (const row of buildingRows) {
      const before = clone(states.get(row.buildingId));
      const requiredPoints = row.maintenance.requiredPoints;
      const technical = row.maintenance.schemaVersion === 2;
      const allocatedPoints = Math.min(requiredPoints, technical ? whole(deps.technicalQdForBuilding(row.building, cycleIndex)) : remainingPoints);
      if (!technical) remainingPoints -= allocatedPoints;
      const after = nextMaintenanceState(before, requiredPoints, allocatedPoints);
      states.set(row.buildingId, after);
      allocations.push({
        buildingId: row.buildingId,
        buildingName: row.buildingName,
        unit: technical ? "qd" : "points",
        priority: row.maintenance.priority,
        requiredPoints,
        allocatedPoints,
        fullyMaintained: requiredPoints === 0 || allocatedPoints >= requiredPoints,
        backlogBefore: before.backlogTendays,
        backlogAfter: after.backlogTendays,
        efficiencyFactor: maintenanceEfficiencyFactor(after),
        needsResolution: after.needsResolution,
        needsResolutionRaised: !before.needsResolution && after.needsResolution
      });
    }
    cycleRows.push({
      cycleIndex,
      availablePoints: pointsPerTenday,
      allocatedPoints: pointsPerTenday - remainingPoints,
      unusedPoints: remainingPoints,
      allocations
    });
  }

  const entries = buildingRows.map((row) => {
    const stateBefore = clone(row.maintenance);
    const stateAfter = clone(states.get(row.buildingId));
    if (tendayCount > 0) stateAfter.lastOperationId = op;
    return {
      buildingId: row.buildingId,
      buildingName: row.buildingName,
      unit: row.maintenance.schemaVersion === 2 ? "qd" : "points",
      requiredPoints: row.maintenance.requiredPoints,
      priority: row.maintenance.priority,
      stateBefore,
      stateBeforeSignature: maintenanceStateSignature(stateBefore),
      stateAfter,
      stateAfterSignature: maintenanceStateSignature(stateAfter),
      cycles: cycleRows.map((cycle) => clone(cycle.allocations.find((entry) => entry.buildingId === row.buildingId)))
    };
  });

  const allocations = cycleRows.flatMap((cycle) => cycle.allocations);
  return {
    version: 1,
    operationId: op,
    elapsedQd: periodQd,
    tendayCount,
    ignoredQd,
    inputSignature: maintenancePeriodInputSignature({ buildings, workers, elapsedQd: periodQd, dependencies }),
    providers: activeProviders.map((row) => ({
      workerId: row.workerId,
      workerName: row.workerName,
      pointsPerTenday: row.pointsPerTenday,
      totalPoints: row.pointsPerTenday * tendayCount
    })),
    entries,
    cycles: cycleRows,
    totals: {
      availablePoints: pointsPerTenday * tendayCount,
      allocatedPoints: cycleRows.reduce((sum, cycle) => sum + cycle.allocatedPoints, 0),
      unusedPoints: cycleRows.reduce((sum, cycle) => sum + cycle.unusedPoints, 0),
      allocatedTechnicalQd: allocations.filter((entry) => entry.unit === "qd").reduce((sum, entry) => sum + entry.allocatedPoints, 0),
      missedAllocations: allocations.filter((entry) => !entry.fullyMaintained).length,
      needsResolutionRaised: allocations.filter((entry) => entry.needsResolutionRaised).length
    }
  };
}

function applyDependencies(dependencies = {}) {
  for (const name of ["getBuildings", "getWorkers", "setMaintenance"]) {
    if (typeof dependencies[name] !== "function") throw new TypeError(`FBL Skyhold | Maintenance apply requires dependency "${name}".`);
  }
  return dependencies;
}

export function applyMaintenancePeriodPlan({ plan, dependencies = {} } = {}) {
  const deps = applyDependencies(dependencies);
  if (!plan || typeof plan !== "object") return { ok: false, message: "План обслуживания отсутствует." };
  const buildings = deps.getBuildings();
  const workers = deps.getWorkers();
  const buildingMap = new Map((Array.isArray(buildings) ? buildings : []).map((building) => [text(building?.id), building]));
  const operationId = text(plan.operationId);
  const entries = Array.isArray(plan.entries) ? plan.entries : [];

  if (plan.tendayCount > 0 && entries.length > 0 && operationId) {
    const replayed = entries.map((entry) => {
      const building = buildingMap.get(text(entry.buildingId));
      if (!building) return false;
      const current = normalizeBuildingMaintenance(building.maintenance);
      return current.lastOperationId === operationId
        && maintenanceStateSignature(current) === text(entry.stateAfterSignature);
    });
    if (replayed.every(Boolean)) {
      return { ok: true, replay: true, operationId, entries: clone(entries), totals: clone(plan.totals ?? {}) };
    }
    if (replayed.some(Boolean)) {
      return { ok: false, stale: true, message: "План обслуживания применён лишь частично; автоматическое продолжение запрещено." };
    }
  }

  const currentInputSignature = maintenancePeriodInputSignature({
    buildings,
    workers,
    elapsedQd: plan.elapsedQd,
    dependencies
  });
  if (currentInputSignature !== text(plan.inputSignature)) {
    return { ok: false, stale: true, message: "Здания или доступные работники изменились после Preview обслуживания." };
  }

  for (const entry of entries) {
    const building = buildingMap.get(text(entry.buildingId));
    if (!building) return { ok: false, stale: true, message: `Здание «${entry.buildingName || entry.buildingId}» больше не существует.` };
    if (maintenanceStateSignature(building.maintenance) !== text(entry.stateBeforeSignature)) {
      return { ok: false, stale: true, message: `Состояние обслуживания «${entry.buildingName || entry.buildingId}» изменилось после Preview.` };
    }
  }

  if (plan.tendayCount > 0) {
    for (const entry of entries) {
      const building = buildingMap.get(text(entry.buildingId));
      deps.setMaintenance(building, clone(entry.stateAfter));
    }
  }

  return {
    ok: true,
    replay: false,
    operationId,
    entries: clone(entries),
    totals: clone(plan.totals ?? {})
  };
}

export { TENDAY_QD };
