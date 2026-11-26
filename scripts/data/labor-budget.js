import { MODULE_ID, SETTING_NORMAL_LABOR_QD } from "./constants.js";
import { ageGroupFromAge, ageThresholdsFor, raceKeyFromResident } from "../generators/resident-rules.js";
import { allocationNormalQd, allocationTotalQd } from "./labor-primitives.js";

export const DEFAULT_NORMAL_LABOR_QD = 20;
export const DEFAULT_DAYS_OFF_PER_TENDAY = 0;
export const MAX_DAYS_OFF_PER_TENDAY = 5;
export const TENDAY_WORKING_DAYS_V2 = 9;
export const DEFAULT_NORMAL_LABOR_QD_V2 = TENDAY_WORKING_DAYS_V2 * 2;

/** A personal budget, not the length of a tenday or a change to the wage unit. */
export function normalLaborQdPerTenday() {
  let value;
  try { value = globalThis.game?.settings?.get(MODULE_ID, SETTING_NORMAL_LABOR_QD); } catch { /* Offline/unregistered: historical default. */ }
  return Number.isSafeInteger(value) && value >= 0 && value <= DEFAULT_NORMAL_LABOR_QD ? value : DEFAULT_NORMAL_LABOR_QD;
}

export function residentLaborCapacity(person = {}, normalQd = normalLaborQdPerTenday()) {
  const child = String(person.ageGroup ?? ageGroupFromAge(person.age, person.race, person.subrace)) === "Ре";
  const threshold = Math.min(Math.max(0, Number(ageThresholdsFor(raceKeyFromResident(person))?.young ?? 18) - 1), 12);
  return {
    normalQd: child ? (Number(person.age ?? 0) >= threshold ? Math.floor(normalQd / 2) : 0) : normalQd,
    overtimeQd: child ? 0 : Math.floor(normalQd / 2)
  };
}

function daysOff(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(MAX_DAYS_OFF_PER_TENDAY, Math.floor(number))) : DEFAULT_DAYS_OFF_PER_TENDAY;
}

export function holdingDaysOffPerTenday(holding) {
  return daysOff(holding?.gm?.labor?.daysOffPerTenday ?? holding?.daysOffPerTenday);
}

export function holdingNormalLaborQd(holding, { workingDays = 10, baseNormalQd = null } = {}) {
  const calendarQd = 2 * (Number.isSafeInteger(workingDays) && workingDays >= 0 ? workingDays : 10);
  const base = Number.isSafeInteger(baseNormalQd) && baseNormalQd >= 0 ? Math.min(baseNormalQd, calendarQd) : calendarQd;
  return Math.max(0, base - 2 * holdingDaysOffPerTenday(holding));
}

export function daysOffConflictSummary(holding = {}, nextDaysOff = 0, options = {}) {
  const next = daysOff(nextDaysOff);
  const budget = holdingNormalLaborQd({ daysOffPerTenday: next }, options);
  const conflicts = [];
  for (const person of holding?.people?.list ?? []) {
    if (!person || person.dead || person.absent === true
      || (person.shipAssignment?.away === true && person.shipAssignment?.shoreDuty !== true)) continue;
    let normalQd = 0, overtimeQd = 0;
    for (const row of Array.isArray(person.workAllocations) ? person.workAllocations : []) {
      const normal = allocationNormalQd(row);
      normalQd += normal;
      overtimeQd += allocationTotalQd(row) - normal;
    }
    const capacity = residentLaborCapacity(person, budget);
    if (normalQd > capacity.normalQd || overtimeQd > Math.min(capacity.overtimeQd, Math.floor(normalQd / 2))) {
      conflicts.push({ personId: String(person.id ?? ""), name: String(person.name || person.id || "Житель"),
        normalQd, overtimeQd, maxNormalQd: capacity.normalQd, maxOvertimeQd: capacity.overtimeQd });
    }
  }
  return { daysOff: next, conflicts, hasConflicts: conflicts.length > 0 };
}
