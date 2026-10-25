import { MODULE_ID } from "../data/constants.js";
import { debugSkyholdLog } from "../data/debug.js";

let installed = false;
let registered = false;
let lastSnapshot = null;

function calendariaApi() {
  return globalThis.CALENDARIA?.api ?? null;
}

function calendarHooks() {
  return calendariaApi()?.hooks ?? {};
}

function activeCalendar() {
  return safeCall(() => calendariaApi()?.getActiveCalendar?.(), null);
}

function calendarMonths(calendar = null) {
  const source = calendar ?? activeCalendar();
  if (Array.isArray(source?.monthsArray)) return source.monthsArray;
  if (Array.isArray(source?.months)) return source.months;
  if (source?.months && typeof source.months === "object" && !source.months.values) return Object.values(source.months);
  if (Array.isArray(source?.months?.values)) return source.months.values;
  if (source?.months?.values && typeof source.months.values === "object") return Object.values(source.months.values);
  return [];
}

function normalizedMonthName(month = null) {
  const raw = month?.name ?? month?.label ?? month?.title ?? "";
  return String(raw).trim().toLowerCase().replace(/ё/g, "е");
}

const SKYHOLD_SEASONS_BY_MONTH = Object.freeze({
  "хладоход": { key: "winter", label: "Ухудно (2 половина)", short: "У-II" },
  "теплорост": { key: "spring", label: "Зарость (1 половина)", short: "З-I" },
  "теплоход": { key: "spring", label: "Зарость (1 половина)", short: "З-I" },
  "зноерост": { key: "summer", label: "Зарость (2 половина)", short: "З-II" },
  "зноеход": { key: "summer", label: "Зарость (2 половина)", short: "З-II" },
  "дождерост": { key: "autumn", label: "Ухудно (1 половина)", short: "У-I" },
  "дождеход": { key: "autumn", label: "Ухудно (1 половина)", short: "У-I" },
  "хладорост": { key: "winter", label: "Ухудно (2 половина)", short: "У-II" }
});

export function resolveCalendariaSeasonText(text = "") {
  const normalized = String(text ?? "").trim().toLowerCase().replace(/ё/g, "е");
  if (!normalized) return null;
  for (const [monthName, season] of Object.entries(SKYHOLD_SEASONS_BY_MONTH)) {
    if (normalized.includes(monthName)) return { ...season, monthName };
  }
  return null;
}

function safeCall(fn, fallback = null) {
  try {
    return typeof fn === "function" ? fn() : fallback;
  } catch (_error) {
    return fallback;
  }
}

function clonePlain(value) {
  if (!value || typeof value !== "object") return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    return { ...value };
  }
}

export function normalizeCalendariaDateTime(dateTime = null, _calendar = null) {
  const value = clonePlain(dateTime);
  if (!value) return null;
  if (Object.hasOwn(value, "dayOfMonth")) {
    const internalMonth = Number(value.month);
    if (Number.isInteger(internalMonth)) value.month = internalMonth + 1;
    if (value.day === undefined || value.day === null) value.day = Number(value.dayOfMonth) + 1;
    delete value.dayOfMonth;
  }
  return value;
}

function calendariaMonthIndex(dateTime = null, calendar = null) {
  const monthNumber = Number(dateTime?.month);
  if (!Number.isInteger(monthNumber)) return -1;
  const index = monthNumber - 1;
  const months = calendarMonths(calendar);
  if (months.length && (index < 0 || index >= months.length)) return -1;
  return index >= 0 ? index : -1;
}

function calendariaDaysInMonth(dateTime = null, calendar = null) {
  const source = calendar ?? activeCalendar();
  const monthIndex = calendariaMonthIndex(dateTime, source);
  if (monthIndex < 0) return null;
  const yearZero = Number(source?.years?.yearZero ?? source?.yearZero ?? 0);
  const internalYear = Number.isFinite(Number(dateTime?.year)) ? Number(dateTime.year) - yearZero : 0;
  const fromMethod = safeCall(() => source?.getDaysInMonth?.(monthIndex, internalYear), null);
  if (Number.isFinite(Number(fromMethod)) && Number(fromMethod) > 0) return Number(fromMethod);
  const month = calendarMonths(source)[monthIndex];
  const raw = month?.days ?? month?.length ?? month?.numberOfDays;
  return Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : null;
}

/**
 * Validate normalized public date components against the active or supplied calendar without rollover.
 * Hours respect its day length (24 by default); minutes must be integers from zero through 59.
 * @param {object|null} [dateTime=null] Public components or internal dayOfMonth components to normalize.
 * @param {object|null} [calendar=null] Calendar override; missing month lengths leave the upper day bound open.
 * @returns {boolean} Whether month/day/hour/minute components fit the known calendar bounds.
 */
function isCalendariaDateInRange(dateTime = null, calendar = null) {
  const value = normalizeCalendariaDateTime(dateTime, calendar);
  if (!value) return false;
  if (calendariaMonthIndex(value, calendar) < 0) return false;
  const day = Number(value.day);
  if (!Number.isInteger(day) || day < 1) return false;
  const daysInMonth = calendariaDaysInMonth(value, calendar);
  if (daysInMonth && day > daysInMonth) return false;
  const hour = Number(value.hour ?? 0);
  const minute = Number(value.minute ?? 0);
  const source = calendar ?? activeCalendar();
  const rawHoursPerDay = Number(source?.days?.hoursPerDay ?? source?.hoursPerDay ?? 24);
  const hoursPerDay = Number.isFinite(rawHoursPerDay) && rawHoursPerDay > 0 ? rawHoursPerDay : 24;
  if (!Number.isInteger(hour) || hour < 0 || hour >= hoursPerDay) return false;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return false;
  return true;
}

export function detectCalendaria() {
  const api = calendariaApi();
  const module = globalThis.game?.modules?.get?.("calendaria");
  return {
    available: Boolean(api),
    active: Boolean(module?.active),
    version: module?.version ?? module?.data?.version ?? "",
    hasHooks: Boolean(api?.hooks),
    hookNames: Object.keys(api?.hooks ?? {}),
    hasDateApi: Boolean(api?.getCurrentDateTime && api?.dateToTimestamp),
    hasElapsedApi: Boolean(api?.daysBetween && api?.hoursBetween)
  };
}

export function getCalendariaHoursPerDay() {
  const calendar = activeCalendar();
  const raw = calendar?.days?.hoursPerDay ?? calendar?.hoursPerDay ?? 24;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
}

export function formatCalendariaDateTime(dateTime = null) {
  const api = calendariaApi();
  const value = normalizeCalendariaDateTime(dateTime ?? safeCall(() => api?.getCurrentDateTime?.(), null), activeCalendar());
  if (!value) return "—";
  const formatted = safeCall(() => api?.formatDate?.(value), null);
  if (typeof formatted === "string" && formatted.trim()) return formatted.trim();
  const year = value.year ?? "?";
  const month = calendariaMonthNumber(value) || "?";
  const day = value.day ?? "?";
  const hour = String(value.hour ?? 0).padStart(2, "0");
  const minute = String(value.minute ?? 0).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

export function calendariaDateTimeToInput(dateTime = null) {
  const value = normalizeCalendariaDateTime(dateTime ?? safeCall(() => calendariaApi()?.getCurrentDateTime?.(), null), activeCalendar());
  if (!value) return "";
  const year = String(value.year ?? "");
  const monthNumber = calendariaMonthNumber(value);
  if (!monthNumber) return "";
  const month = String(monthNumber).padStart(2, "0");
  const day = String(value.day ?? "").padStart(2, "0");
  const hour = String(value.hour ?? 0).padStart(2, "0");
  const minute = String(value.minute ?? 0).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

export function parseCalendariaDateInput(input = "", fallbackDateTime = null) {
  const api = calendariaApi();
  const text = String(input ?? "").trim();
  if (!text) return null;

  if (/^-?\d+$/.test(text) && api?.timestampToDate) {
    const date = safeCall(() => api.timestampToDate(Number(text)), null);
    const value = normalizeCalendariaDateTime(date, activeCalendar());
    if (value && isCalendariaDateInRange(value)) return value;
  }

  const match = text.match(/^(-?\d+)\D+(\d{1,2})\D+(\d{1,2})(?:\D+(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (!match) return null;
  const base = normalizeCalendariaDateTime(fallbackDateTime ?? safeCall(() => api?.getCurrentDateTime?.(), null)) ?? {};
  const monthNumber = Number(match[2]);
  const months = calendarMonths();
  if (months.length && (monthNumber < 1 || monthNumber > months.length)) return null;
  if (!months.length && monthNumber < 1) return null;
  const parsed = {
    ...base,
    year: Number(match[1]),
    month: monthNumber,
    day: Number(match[3]),
    hour: Number(match[4] ?? base.hour ?? 0),
    minute: Number(match[5] ?? base.minute ?? 0),
    second: Number(base.second ?? 0)
  };
  return isCalendariaDateInRange(parsed) ? parsed : null;
}

export function calendariaMonthNumber(dateTime = null, calendar = null) {
  const monthNumber = Number(dateTime?.month);
  if (!Number.isInteger(monthNumber)) return "";
  if (calendarMonths(calendar).length && calendariaMonthIndex(dateTime, calendar) < 0) return "";
  return monthNumber;
}

export function calendariaDateKey(dateTime = null, calendar = null) {
  if (!dateTime) return "";
  const value = normalizeCalendariaDateTime(dateTime, calendar);
  return [value.year, calendariaMonthNumber(value, calendar), value.day]
    .map((value) => String(value ?? ""))
    .join("-");
}

export function resolveCalendariaSeason(dateTime = null, calendar = null) {
  if (!dateTime) return null;
  const months = calendarMonths(calendar);
  const value = normalizeCalendariaDateTime(dateTime, calendar);
  const monthIndex = calendariaMonthIndex(value, calendar);
  const month = months[monthIndex];
  const resolved = SKYHOLD_SEASONS_BY_MONTH[normalizedMonthName(month)];
  if (!resolved) return null;
  return {
    ...resolved,
    monthIndex,
    monthNumber: calendariaMonthNumber(value, calendar),
    monthName: String(month?.name ?? month?.label ?? "")
  };
}

export function getCalendariaSeasonSnapshot(dateTime = null, fallbackText = "") {
  const calendar = activeCalendar();
  const value = normalizeCalendariaDateTime(dateTime, calendar);
  const season = resolveCalendariaSeason(value, calendar) ?? resolveCalendariaSeasonText(fallbackText);
  if (!value && !season) return null;
  return {
    available: Boolean(calendar),
    dateTime: value,
    dateKey: value ? calendariaDateKey(value, calendar) : "",
    text: value ? formatCalendariaDateTime(value) : String(fallbackText ?? "").trim(),
    season
  };
}

export function timestampForCalendariaDate(dateTime = null) {
  const api = calendariaApi();
  if (!api?.dateToTimestamp || !dateTime) return null;
  const normalized = normalizeCalendariaDateTime(dateTime, activeCalendar());
  if (!isCalendariaDateInRange(normalized)) return null;
  const value = safeCall(() => api.dateToTimestamp(normalized), null);
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function addCalendariaQd(dateTime = null, qd = 0) {
  const api = calendariaApi();
  const calendar = activeCalendar();
  const start = normalizeCalendariaDateTime(dateTime, calendar);
  if (!api || !start || !isCalendariaDateInRange(start, calendar)) return null;
  const hours = (Number(qd) || 0) * (getCalendariaHoursPerDay() / 4);
  const advanced = api.addHours
    ? safeCall(() => api.addHours(start, hours), null)
    : null;
  if (advanced && isCalendariaDateInRange(advanced, calendar)) return normalizeCalendariaDateTime(advanced, calendar);
  const timestamp = timestampForCalendariaDate(start);
  if (timestamp !== null && Number.isFinite(timestamp) && api.timestampToDate) {
    const secondsPerHour = (calendar?.days?.secondsPerMinute ?? 60) * (calendar?.days?.minutesPerHour ?? 60);
    const fromTimestamp = safeCall(() => api.timestampToDate(Number(timestamp) + hours * secondsPerHour), null);
    if (fromTimestamp && isCalendariaDateInRange(fromTimestamp, calendar)) return normalizeCalendariaDateTime(fromTimestamp, calendar);
  }
  return null;
}

export function getCalendariaSnapshot() {
  const api = calendariaApi();
  if (!api?.getCurrentDateTime) {
    return { available: false, dateTime: null, timestamp: null, dateKey: "", text: "Calendaria не найдена", inputValue: "", season: null, weather: null, hoursPerDay: 24 };
  }
  const calendar = activeCalendar();
  const dateTime = normalizeCalendariaDateTime(safeCall(() => api.getCurrentDateTime(), null), calendar);
  const timestamp = timestampForCalendariaDate(dateTime);
  const dateKey = calendariaDateKey(dateTime, calendar);
  const nativeSeason = safeCall(() => api.getCurrentSeason?.(), null);
  return {
    available: true,
    dateTime,
    timestamp,
    dateKey,
    text: formatCalendariaDateTime(dateTime),
    inputValue: calendariaDateTimeToInput(dateTime),
    season: resolveCalendariaSeason(dateTime, calendar) ?? nativeSeason,
    nativeSeason,
    weather: safeCall(() => api.getCurrentWeather?.(), null),
    hoursPerDay: getCalendariaHoursPerDay()
  };
}

function emitCalendariaBridgeEvent(sourceHook, args = []) {
  lastSnapshot = getCalendariaSnapshot();
  globalThis.Hooks?.callAll?.("fblSkyholdCalendariaChanged", {
    moduleId: MODULE_ID,
    sourceHook,
    snapshot: lastSnapshot,
    args
  });
}

function registerCalendariaHooks() {
  if (registered || !globalThis.Hooks) return;
  const api = calendariaApi();
  if (!api) return;
  registered = true;
  const hookNames = calendarHooks();
  const watched = [
    hookNames.READY,
    hookNames.DAY_CHANGE,
    hookNames.DATE_TIME_CHANGE,
    hookNames.WORLD_TIME_UPDATED,
    hookNames.CALENDAR_SWITCHED,
    hookNames.MIDNIGHT
  ].filter(Boolean);
  for (const hookName of watched) {
    Hooks.on(hookName, (...args) => emitCalendariaBridgeEvent(hookName, args));
  }
  lastSnapshot = getCalendariaSnapshot();
  debugSkyholdLog("FBL Skyhold Manager | Calendaria bridge ready", detectCalendaria(), lastSnapshot);
}

export function installCalendariaBridge() {
  if (installed) return detectCalendaria();
  installed = true;
  if (calendariaApi()) registerCalendariaHooks();
  else if (globalThis.Hooks) Hooks.once("calendaria.ready", registerCalendariaHooks);
  return detectCalendaria();
}

export function getLastCalendariaSnapshot() {
  return lastSnapshot ?? getCalendariaSnapshot();
}
