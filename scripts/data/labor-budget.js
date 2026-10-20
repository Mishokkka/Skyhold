import { MODULE_ID, SETTING_NORMAL_LABOR_QD } from "./constants.js";
import { ageGroupFromAge, ageThresholdsFor, raceKeyFromResident } from "../generators/resident-rules.js";

export const DEFAULT_NORMAL_LABOR_QD = 20;

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
