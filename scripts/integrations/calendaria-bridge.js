import { MODULE_ID } from "../data/store.js";

let installed = false;
let registered = false;
let lastSnapshot = null;

function calendariaApi() {
  return globalThis.CALENDARIA?.api ?? null;
}

function calendarHooks() {
  return calendariaApi()?.hooks ?? {};
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
  const api = calendariaApi();
  const calendar = safeCall(() => api?.getActiveCalendar?.(), null);
  const raw = calendar?.days?.hoursPerDay ?? calendar?.hoursPerDay ?? 24;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
}

export function formatCalendariaDateTime(dateTime = null) {
  const api = calendariaApi();
  const value = dateTime ?? safeCall(() => api?.getCurrentDateTime?.(), null);
  if (!value) return "—";
  const formatted = safeCall(() => api?.formatDate?.(value), null);
  if (typeof formatted === "string" && formatted.trim()) return formatted.trim();
  const year = value.year ?? "?";
  const month = value.month ?? "?";
  const day = value.day ?? "?";
  const hour = String(value.hour ?? 0).padStart(2, "0");
  const minute = String(value.minute ?? 0).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

export function calendariaDateTimeToInput(dateTime = null) {
  const value = dateTime ?? safeCall(() => calendariaApi()?.getCurrentDateTime?.(), null);
  if (!value) return "";
  const year = String(value.year ?? "");
  const month = String(value.month ?? "").padStart(2, "0");
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
    if (date) return clonePlain(date);
  }

  const match = text.match(/^(-?\d+)\D+(\d{1,2})\D+(\d{1,2})(?:\D+(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (!match) return null;
  const base = clonePlain(fallbackDateTime) ?? clonePlain(safeCall(() => api?.getCurrentDateTime?.(), null)) ?? {};
  return {
    ...base,
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4] ?? base.hour ?? 0),
    minute: Number(match[5] ?? base.minute ?? 0),
    second: Number(base.second ?? 0)
  };
}

export function timestampForCalendariaDate(dateTime = null) {
  const api = calendariaApi();
  if (!api?.dateToTimestamp || !dateTime) return null;
  const value = safeCall(() => api.dateToTimestamp(dateTime), null);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function addCalendariaQd(dateTime = null, qd = 0) {
  const api = calendariaApi();
  const start = clonePlain(dateTime);
  if (!api || !start) return null;
  const hours = (Number(qd) || 0) * (getCalendariaHoursPerDay() / 4);
  const advanced = api.addHours
    ? safeCall(() => api.addHours(start, hours), null)
    : null;
  if (advanced) return clonePlain(advanced);
  const fallback = clonePlain(start);
  fallback.hour = Number(fallback.hour ?? 0) + hours;
  return fallback;
}

export function getCalendariaSnapshot() {
  const api = calendariaApi();
  if (!api?.getCurrentDateTime) {
    return { available: false, dateTime: null, timestamp: null, dateKey: "", text: "Calendaria не найдена", inputValue: "", season: null, weather: null, hoursPerDay: 24 };
  }
  const dateTime = clonePlain(safeCall(() => api.getCurrentDateTime(), null));
  const timestamp = timestampForCalendariaDate(dateTime);
  const dateKey = dateTime
    ? [dateTime.year, dateTime.month, dateTime.day].map((value) => String(value ?? "")).join("-")
    : "";
  return {
    available: true,
    dateTime,
    timestamp,
    dateKey,
    text: formatCalendariaDateTime(dateTime),
    inputValue: calendariaDateTimeToInput(dateTime),
    season: safeCall(() => api.getCurrentSeason?.(), null),
    weather: safeCall(() => api.getCurrentWeather?.(), null),
    hoursPerDay: getCalendariaHoursPerDay()
  };
}

export function getCalendariaElapsedDays(fromDateTime, toDateTime = null) {
  const api = calendariaApi();
  if (!api?.daysBetween || !fromDateTime) return 0;
  const target = toDateTime ?? safeCall(() => api.getCurrentDateTime(), null);
  const value = safeCall(() => api.daysBetween(fromDateTime, target), 0);
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export function getCalendariaElapsedHours(fromDateTime, toDateTime = null) {
  const api = calendariaApi();
  if (!api?.hoursBetween || !fromDateTime) return 0;
  const target = toDateTime ?? safeCall(() => api.getCurrentDateTime(), null);
  const value = safeCall(() => api.hoursBetween(fromDateTime, target), 0);
  return Number.isFinite(Number(value)) ? Number(value) : 0;
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
  console.log("FBL Skyhold Manager | Calendaria bridge ready", detectCalendaria(), lastSnapshot);
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
