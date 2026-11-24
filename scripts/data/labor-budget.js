import { ageGroupFromAge, ageThresholdsFor, raceKeyFromResident } from "../generators/resident-rules.js";

export const DEFAULT_DAYS_OFF_PER_TENDAY = 0;
export const MAX_DAYS_OFF_PER_TENDAY = 5;
export const DEFAULT_NORMAL_LABOR_QD = 20;

function toDaysOff(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_DAYS_OFF_PER_TENDAY;
  return Math.max(DEFAULT_DAYS_OFF_PER_TENDAY, Math.min(MAX_DAYS_OFF_PER_TENDAY, Math.floor(num)));
}

export function holdingDaysOffPerTenday(holding = null) {
  return toDaysOff(holding?.gm?.labor?.daysOffPerTenday ?? DEFAULT_DAYS_OFF_PER_TENDAY);
}

/** A personal budget based on holding days off, not a change to the 2 QD/day wage unit. */
export function normalLaborQdPerTenday(holding = null) {
  const daysOff = holdingDaysOffPerTenday(holding);
  return (10 - daysOff) * 2;
}

export function residentLaborCapacity(person = {}, holdingOrNormalQd = null) {
  const normalQd = typeof holdingOrNormalQd === "number" && Number.isFinite(holdingOrNormalQd)
    ? Math.max(0, Math.min(DEFAULT_NORMAL_LABOR_QD, Math.floor(holdingOrNormalQd)))
    : normalLaborQdPerTenday(holdingOrNormalQd);
  const child = String(person.ageGroup ?? ageGroupFromAge(person.age, person.race, person.subrace)) === "Ре";
  const threshold = Math.min(Math.max(0, Number(ageThresholdsFor(raceKeyFromResident(person))?.young ?? 18) - 1), 12);
  return {
    normalQd: child ? (Number(person.age ?? 0) >= threshold ? Math.floor(normalQd / 2) : 0) : normalQd,
    overtimeQd: child ? 0 : Math.floor(normalQd / 2)
  };
}

export function daysOffConflictSummary(holding = {}, nextDaysOff = 0) {
  const daysOff = toDaysOff(nextDaysOff);
  const probeHolding = {
    ...holding,
    gm: { ...(holding?.gm ?? {}), labor: { ...(holding?.gm?.labor ?? {}), daysOffPerTenday: daysOff } }
  };
  const conflicts = [];
  for (const person of holding?.people?.list ?? []) {
    if (!person || person.dead || person?.shipAssignment?.away === true) continue;
    let normalQd = 0;
    let overtimeQd = 0;
    for (const row of Array.isArray(person.workAllocations) ? person.workAllocations : []) {
      normalQd += Math.max(0, Math.floor(Number(row?.normalQd ?? row?.qd ?? 0) || 0));
      overtimeQd += Math.max(0, Math.floor(Number(row?.overtimeQd ?? 0) || 0));
    }
    if (normalQd + overtimeQd <= 0) continue;
    const cap = residentLaborCapacity(person, probeHolding);
    if (normalQd > cap.normalQd || overtimeQd > cap.overtimeQd || overtimeQd > Math.floor(normalQd / 2)) {
      conflicts.push({
        personId: String(person.id ?? ""),
        name: String(person.name || person.id || "Житель"),
        normalQd,
        overtimeQd,
        maxNormalQd: cap.normalQd,
        maxOvertimeQd: cap.overtimeQd
      });
    }
  }
  return { daysOff, conflicts, hasConflicts: conflicts.length > 0 };
}
