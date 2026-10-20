import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeBuildingMaintenance, maintenanceEfficiencyFactor } from "../data/economy/maintenance.js";
import { planMaintenancePeriod, applyMaintenancePeriodPlan } from "../engines/economy/maintenance-period.js";
import { buildingStaffingWorkerIds, validateHoldingWorkAllocations } from "../data/work-allocations.js";

export function checkTechnicalMaintenance() {
  const building = { id: "machine", name: "Machine", constructionStatus: "built", workersMax: 1, functions: { production: true },
    productionLines: [{ id: "line", source: "workers", wageDailyCopper: 18 }], maintenance: { schemaVersion: 2, requiredPoints: 2 } };
  const holding = { buildings: { list: [building] }, people: { list: [
    { id: "operator", workAllocationMode: "explicit", workAllocations: [{ id: "produce", sourceId: "machine", functionId: "production:line", normalQd: 20 }] },
    { id: "technician", workAllocationMode: "explicit", workAllocations: [{ id: "service", sourceId: "machine", functionId: "maintenance", normalQd: 2 }] }
  ] } };
  const validation = validateHoldingWorkAllocations(holding);
  assert.equal(validation.ok, true);
  assert.deepEqual(buildingStaffingWorkerIds(holding, "machine"), ["operator"], "Technical work must not consume a production staffing slot");
  assert.equal(validation.targetMap.get("machine::maintenance").dailyRateCopper, 18);
  holding.people.list[1].workAllocations[0].normalQd = 21;
  assert.equal(validateHoldingWorkAllocations(holding).ok, false, "The shared resident labor limit still applies to technical work");
  holding.people.list[1].workAllocations[0].normalQd = 2;
  const idle = { ...structuredClone(building), id: "idle", maintenance: { schemaVersion: 2, requiredPoints: 2, backlogTendays: 2 } };
  const ordinary = { id: "home", constructionStatus: "built", maintenance: { schemaVersion: 2, requiredPoints: 0, backlogTendays: 5 } };
  const legacy = { id: "old", constructionStatus: "built", maintenance: { requiredPoints: 3 } };
  const buildings = [building, idle, ordinary, legacy];
  const workers = [{ id: "legacy-provider", maintenancePointsPerTenday: 3 }];
  let technicalQd = 1;
  const deps = { isTechnicalActive: (row) => row.id === "machine", technicalQdForBuilding: () => technicalQd };
  const args = { buildings, workers, elapsedQd: 40, operationId: "mixed-maintenance", dependencies: deps };
  const before = structuredClone(buildings);
  const plan = planMaintenancePeriod(args);
  assert.deepEqual(buildings, before);
  assert.equal(plan.entries.find((row) => row.buildingId === "machine").stateAfter.backlogTendays, 1);
  assert.equal(plan.entries.find((row) => row.buildingId === "old").stateAfter.backlogTendays, 0);
  assert.equal(plan.totals.allocatedPoints, 3, "Legacy points must remain in their own pool");
  assert.equal(plan.totals.allocatedTechnicalQd, 1, "Legacy spare points cannot satisfy a technical assignment");
  assert.ok(!plan.entries.some((row) => ["idle", "home"].includes(row.buildingId)));
  assert.equal(maintenanceEfficiencyFactor(ordinary.maintenance), 1);
  const applyDeps = { ...deps, getBuildings: () => buildings, getWorkers: () => workers, setMaintenance: (row, state) => { row.maintenance = normalizeBuildingMaintenance(state); } };
  technicalQd = 2;
  assert.equal(applyMaintenancePeriodPlan({ plan, dependencies: applyDeps }).stale, true, "Changed paid work invalidates Preview");
  technicalQd = 1;
  assert.equal(applyMaintenancePeriodPlan({ plan, dependencies: applyDeps }).ok, true);
  assert.equal(applyMaintenancePeriodPlan({ plan, dependencies: applyDeps }).replay, true);
  assert.equal(idle.maintenance.backlogTendays, 2);
  assert.equal(ordinary.maintenance.backlogTendays, 5, "Removing a recurring need must not silently delete old unresolved state");
  const batch = planMaintenancePeriod({ ...args, elapsedQd: 120, operationId: "three-misses", dependencies: { ...deps, technicalQdForBuilding: () => 0 } });
  const missed = batch.entries.find((row) => row.buildingId === "machine");
  assert.equal(missed.stateAfter.backlogTendays, 4);
  assert.equal(missed.stateAfter.needsResolution, true);
  assert.equal(building.constructionStatus, "built");
  assert.equal(normalizeBuildingMaintenance({ requiredPoints: 2 }).schemaVersion, 1);
  return { mixedUnits: true, laborCaps: true, staleAndReplay: true, idleBacklogPreserved: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(checkTechnicalMaintenance()));
