import { isPlainObject, toBoolean, toNumber } from "../utils.js";

export const DEFAULT_BUILDING_MAINTENANCE = Object.freeze({
  schemaVersion: 1,
  requiredPoints: 0,
  priority: 0,
  backlogTendays: 0,
  needsResolution: false,
  lastOperationId: ""
});

export const DEFAULT_MAINTENANCE_POINTS_PER_TENDAY = 0;

function whole(value, fallback = 0) {
  return Math.max(0, Math.floor(toNumber(value, fallback)));
}

function integer(value, fallback = 0) {
  return Math.trunc(toNumber(value, fallback));
}

export function normalizeBuildingMaintenance(value = {}) {
  const source = isPlainObject(value) ? value : {};
  return {
    // Explicit migration selects direct QD; version 1 retains point semantics.
    schemaVersion: Number(source.schemaVersion) === 2 ? 2 : 1,
    requiredPoints: Math.min(3, whole(source.requiredPoints, DEFAULT_BUILDING_MAINTENANCE.requiredPoints)),
    priority: integer(source.priority, DEFAULT_BUILDING_MAINTENANCE.priority),
    backlogTendays: whole(source.backlogTendays, DEFAULT_BUILDING_MAINTENANCE.backlogTendays),
    needsResolution: toBoolean(source.needsResolution, DEFAULT_BUILDING_MAINTENANCE.needsResolution),
    lastOperationId: String(source.lastOperationId ?? DEFAULT_BUILDING_MAINTENANCE.lastOperationId)
  };
}

export function normalizeMaintenancePointsPerTenday(value) {
  return whole(value, DEFAULT_MAINTENANCE_POINTS_PER_TENDAY);
}

export function maintenanceEfficiencyFactor(value = {}) {
  const state = normalizeBuildingMaintenance(value);
  if (state.schemaVersion === 2 && state.requiredPoints === 0) return 1;
  return state.backlogTendays >= 2 ? 0.5 : 1;
}

export function usesTechnicalMaintenance(building = {}) {
  return Number(building?.maintenance?.schemaVersion) === 2;
}
