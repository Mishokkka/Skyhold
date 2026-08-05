import {
  DEFAULT_WAGE_INDEX,
  WAGE_CLASS_IDS,
  wageCopperPerTenday
} from "./wage-catalog.js";

export const EMPLOYMENT_MODE_IDS = Object.freeze(["permanent", "seasonal", "day-labor"]);
export const EMPLOYMENT_SEASON_IDS = Object.freeze(["spring", "summer", "autumn", "winter"]);
export const EMPLOYMENT_DAYS_PER_TENDAY = 10;

const WAGE_CLASSES = new Set(WAGE_CLASS_IDS);
const EMPLOYMENT_MODES = new Set(EMPLOYMENT_MODE_IDS);
const EMPLOYMENT_SEASONS = new Set(EMPLOYMENT_SEASON_IDS);

function text(value = "") {
  return String(value ?? "").trim();
}

function booleanValue(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = text(value).toLocaleLowerCase("en");
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  return fallback;
}

function optionalQd(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const qd = Math.max(0, Math.floor(numeric));
  return Number.isSafeInteger(qd) ? qd : null;
}

function seasonKey(value) {
  const key = text(value?.key ?? value?.id ?? value).toLocaleLowerCase("en");
  return EMPLOYMENT_SEASONS.has(key) ? key : "";
}

function normalizeSeasonMask(value) {
  // A missing mask grants no seasonal window. Permanent and day-labor modes
  // ignore the mask; switching either contract to seasonal therefore cannot
  // silently create an all-year seasonal contract.
  const fallback = false;
  if (Array.isArray(value)) {
    const selected = new Set(value.map(seasonKey).filter(Boolean));
    return Object.fromEntries(EMPLOYMENT_SEASON_IDS.map((key) => [key, selected.has(key)]));
  }
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(EMPLOYMENT_SEASON_IDS.map((key) => [
    key,
    Object.hasOwn(source, key) ? booleanValue(source[key], fallback) : fallback
  ]));
}

export function normalizeEmploymentMode(value = "permanent") {
  const mode = text(value).toLocaleLowerCase("en");
  return EMPLOYMENT_MODES.has(mode) ? mode : "permanent";
}

export function normalizeEmploymentTerms(source = {}) {
  const employmentMode = normalizeEmploymentMode(source?.employmentMode);
  const rawWageClassId = text(source?.wageClassId);
  return {
    employmentMode,
    wageClassId: WAGE_CLASSES.has(rawWageClassId) ? rawWageClassId : "",
    employmentSeasonMask: normalizeSeasonMask(source?.employmentSeasonMask),
    employmentContractStartQd: optionalQd(source?.employmentContractStartQd),
    employmentContractEndQd: optionalQd(source?.employmentContractEndQd)
  };
}

export function employmentContractState(source = {}, options = {}) {
  const terms = normalizeEmploymentTerms(source);
  const currentQd = optionalQd(options?.currentQd);
  const currentSeason = seasonKey(options?.season);
  let reason = "active";

  if (!terms.wageClassId) reason = "missing-wage-class";
  else if (
    terms.employmentContractStartQd !== null
    && terms.employmentContractEndQd !== null
    && terms.employmentContractEndQd < terms.employmentContractStartQd
  ) reason = "invalid-contract-term";
  else if (
    (terms.employmentContractStartQd !== null || terms.employmentContractEndQd !== null)
    && currentQd === null
  ) reason = "missing-current-qd";
  else if (terms.employmentContractStartQd !== null && currentQd < terms.employmentContractStartQd) reason = "before-contract";
  else if (terms.employmentContractEndQd !== null && currentQd > terms.employmentContractEndQd) reason = "after-contract";
  else if (terms.employmentMode === "seasonal" && !currentSeason) reason = "missing-season";
  else if (terms.employmentMode === "seasonal" && !terms.employmentSeasonMask[currentSeason]) reason = "inactive-season";

  const active = reason === "active";
  return {
    ...terms,
    active,
    laborEligible: active,
    reason,
    currentQd,
    season: currentSeason
  };
}

function workLogContext(options = {}) {
  const laborPool = options?.laborPool && typeof options.laborPool === "object" ? options.laborPool : null;
  const rows = Array.isArray(options?.workLog)
    ? options.workLog
    : (Array.isArray(laborPool?.workLog) ? laborPool.workLog : []);
  const explicitDayKeys = Array.isArray(options?.periodDayKeys)
    ? options.periodDayKeys
    : (Array.isArray(laborPool?.period?.dayKeys) ? laborPool.period.dayKeys : null);
  const allowedDayKeys = explicitDayKeys
    ? new Set(explicitDayKeys.map(text).filter(Boolean))
    : null;
  return { rows, allowedDayKeys };
}

export function uniqueWorkedDayKeys(source = {}, options = {}) {
  const residentId = text(options?.residentId ?? source?.id);
  if (!residentId) return [];
  const { rows, allowedDayKeys } = workLogContext(options);
  const keys = new Set();
  for (const row of rows) {
    if (text(row?.residentId) !== residentId) continue;
    const dayKey = text(row?.dayKey);
    if (!dayKey || (allowedDayKeys && !allowedDayKeys.has(dayKey))) continue;
    const laborQd = Number(row?.laborQd);
    if (!Number.isFinite(laborQd) || laborQd <= 0) continue;
    keys.add(dayKey);
  }
  return [...keys].sort((left, right) => left.localeCompare(right, "en"));
}

export function employmentTendayStatement(source = {}, options = {}) {
  const state = employmentContractState(source, options);
  const tendayTariffCopper = state.wageClassId
    ? wageCopperPerTenday(state.wageClassId, { wageIndex: options?.wageIndex ?? DEFAULT_WAGE_INDEX })
    : 0;
  const allWorkedDayKeys = state.employmentMode === "day-labor"
    ? uniqueWorkedDayKeys(source, options)
    : [];
  const workedDayKeys = allWorkedDayKeys.slice(0, EMPLOYMENT_DAYS_PER_TENDAY);
  const workedDays = workedDayKeys.length;
  let dueCopper = 0;

  if (state.active) {
    dueCopper = state.employmentMode === "day-labor"
      ? Math.round((tendayTariffCopper * workedDays) / EMPLOYMENT_DAYS_PER_TENDAY)
      : tendayTariffCopper;
  }
  if (!Number.isSafeInteger(dueCopper) || dueCopper < 0) {
    throw new RangeError("Employment liability exceeds the safe whole-copper range.");
  }

  return {
    ...state,
    tendayTariffCopper,
    dueCopper,
    workedDays,
    workedDayKeys,
    overflowWorkedDays: Math.max(0, allWorkedDayKeys.length - EMPLOYMENT_DAYS_PER_TENDAY)
  };
}

export function employmentLiabilityCopper(source = {}, options = {}) {
  return employmentTendayStatement(source, options).dueCopper;
}
