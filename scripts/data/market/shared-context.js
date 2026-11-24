import { economyCalendarQd } from "../../core/economy-calendar.js";
import { getCalendariaHoursPerDay } from "../../integrations/calendaria-bridge.js";
import { normalizeMarketStockState } from "./stock-state.js";
import { normalizeMarketDemandState } from "./demand-state.js";

const owners = new WeakMap();
function whole(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}
function mergeOperationIds(rows, key) {
  return [...new Set(rows.flatMap((row) => (Array.isArray(row?.[key]) ? row[key] : [])))].slice(-80);
}
function seedSharedStock(holdings = [], clockTenday = 0) {
  const groups = new Map();
  for (const holding of holdings ?? []) {
    const local = holding?.special?.market?.stock;
    if (!isPlainObject(local) || !Object.keys(local).length) continue;
    for (const [key, row] of Object.entries(normalizeMarketStockState(local))) {
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
  }
  const stock = {};
  for (const [key, rows] of groups) {
    if (rows.length === 1) {
      stock[key] = rows[0];
      continue;
    }
    const baseStock = Math.max(...rows.map((row) => row.baseStock));
    const spent = rows.reduce((sum, row) => sum + Math.max(0, row.baseStock - row.availableStock), 0);
    const availableStock = Math.max(0, baseStock - spent);
    stock[key] = {
      ...rows[0],
      baseStock,
      availableStock,
      recoveryStartedTenday: clockTenday,
      recoveryStartStock: availableStock,
      lastRecoveryTenday: clockTenday,
      recoveryDurationTendays: Math.max(...rows.map((row) => row.recoveryDurationTendays)),
      revision: Math.max(...rows.map((row) => row.revision)) + 1,
      reservationOperationIds: mergeOperationIds(rows, "reservationOperationIds"),
      restorationOperationIds: mergeOperationIds(rows, "restorationOperationIds")
    };
  }
  return stock;
}
function seedSharedDemand(holdings = [], clockTenday = 0) {
  const groups = new Map();
  for (const holding of holdings ?? []) {
    const local = holding?.special?.market?.demand;
    if (!isPlainObject(local) || !Object.keys(local).length) continue;
    for (const [key, row] of Object.entries(normalizeMarketDemandState(local))) {
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
  }
  const demand = {};
  for (const [key, rows] of groups) {
    if (rows.length === 1) {
      demand[key] = rows[0];
      continue;
    }
    const baseDemand = Math.max(...rows.map((row) => row.baseDemand));
    const reservations = {};
    for (const row of rows) {
      for (const [id, reservation] of Object.entries(row.reservations ?? {})) {
        const prior = reservations[id];
        if (prior) {
          reservations[id] = {
            ...prior,
            qty: Math.min(1_000_000_000, whole(prior.qty) + whole(reservation.qty)),
            createdTenday: Math.min(whole(prior.createdTenday), whole(reservation.createdTenday)),
            createdAt: prior.createdAt || String(reservation.createdAt ?? "")
          };
        } else {
          reservations[id] = { ...reservation };
        }
      }
    }
    const reservedTotal = Object.values(reservations).reduce((sum, row) => sum + whole(row.qty), 0);
    const reservedDemand = Math.min(baseDemand, reservedTotal);
    const consumedOutstanding = Math.min(
      Math.max(0, baseDemand - reservedDemand),
      rows.reduce((sum, row) => sum + row.consumedOutstanding, 0)
    );
    const recoveryDurationTendays = Math.max(...rows.map((row) => row.recoveryDurationTendays));
    demand[key] = {
      ...rows[0],
      baseDemand,
      availableDemand: Math.max(0, baseDemand - reservedDemand - consumedOutstanding),
      reservedDemand,
      consumedOutstanding,
      recoveryLots: consumedOutstanding ? [{ qty: consumedOutstanding, startedTenday: clockTenday, durationTendays: recoveryDurationTendays }] : [],
      reservations,
      recoveryStartedTenday: clockTenday,
      recoveryStartConsumed: consumedOutstanding,
      recoveryDurationTendays,
      lastRecoveryTenday: clockTenday,
      revision: Math.max(...rows.map((row) => row.revision)) + 1,
      reservationOperationIds: mergeOperationIds(rows, "reservationOperationIds"),
      consumptionOperationIds: mergeOperationIds(rows, "consumptionOperationIds"),
      restorationOperationIds: mergeOperationIds(rows, "restorationOperationIds")
    };
  }
  return demand;
}
function initialSharedClockTenday(data) {
  const hoursPerDay = getCalendariaHoursPerDay();
  let maxTenday = 0;
  for (const holding of data?.holdings ?? []) {
    const local = Math.max(0, Math.floor((Number(holding?.gm?.calendaria?.lastQd) || 0) / 40));
    const calendarQd = economyCalendarQd(holding, hoursPerDay);
    const dated = calendarQd === null ? local : Math.floor(calendarQd / 40);
    maxTenday = Math.max(maxTenday, dated);
  }
  return maxTenday;
}
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function ensureSharedMarketsState(data, storedSharedMarkets = data?.meta?.sharedMarkets) {
  if (!data || typeof data !== "object" || Object.isFrozen(data)) return data;
  if (!isPlainObject(data.meta)) data.meta = {};
  if (Object.isFrozen(data.meta)) return data;
  const existing = isPlainObject(storedSharedMarkets) ? storedSharedMarkets : null;
  const isAlreadyEnabled = existing?.enabled === true;
  const current = isAlreadyEnabled
    ? (isPlainObject(data.meta.sharedMarkets) ? data.meta.sharedMarkets : existing)
    : (existing ?? {});
  const rawClock = existing?.clockTenday;
  const hasStoredClock = rawClock !== undefined && rawClock !== null && rawClock !== "" && Number.isFinite(Number(rawClock));
  const storedClock = hasStoredClock ? Math.max(0, Math.floor(Number(rawClock))) : null;
  if (
    isAlreadyEnabled
    && hasStoredClock
    && current.enabled === true
    && Number.isInteger(current.version) && current.version >= 1
    && current.clockTenday === storedClock
    && isPlainObject(current.demand)
    && isPlainObject(current.stock)
  ) {
    return data;
  }
  const initialClock = initialSharedClockTenday(data);
  const clockTenday = isAlreadyEnabled
    ? (storedClock ?? initialClock)
    : Math.max(storedClock ?? 0, initialClock);
  const seededStock = isAlreadyEnabled ? null : seedSharedStock(data.holdings, clockTenday);
  const seededDemand = isAlreadyEnabled ? null : seedSharedDemand(data.holdings, clockTenday);
  const stock = isAlreadyEnabled
    ? (isPlainObject(current.stock) ? current.stock : {})
    : (Object.keys(seededStock).length ? seededStock : normalizeMarketStockState(existing?.stock));
  const demand = isAlreadyEnabled
    ? (isPlainObject(current.demand) ? current.demand : {})
    : (Object.keys(seededDemand).length ? seededDemand : normalizeMarketDemandState(existing?.demand));
  data.meta.sharedMarkets = {
    ...current,
    enabled: true,
    version: Math.max(1, Math.floor(Number(current.version) || 1)),
    clockTenday,
    demand,
    stock
  };
  return data;
}
export function bindSharedMarketHolding(holding, state) {
  if (holding && typeof holding === "object") {
    if (state?.enabled === true) owners.set(holding, state);
    else owners.delete(holding);
  }
  return holding;
}
export function bindSharedMarkets(data) {
  ensureSharedMarketsState(data);
  for (const holding of data?.holdings ?? []) bindSharedMarketHolding(holding, data?.meta?.sharedMarkets);
  return data;
}
export function marketStateFor(holding, key) {
  return owners.get(holding)?.[key] ?? holding?.special?.market?.[key];
}
export function sharedMarketTenday(holding, localPeriod = null) {
  const local = Math.max(0, Math.floor((Number(holding?.gm?.calendaria?.lastQd) || 0) / 40));
  const requested = localPeriod === null || localPeriod === undefined ? local : Math.max(0, Math.floor(Number(localPeriod) || 0));
  const state = owners.get(holding);
  if (!state) return requested;
  const calendarQd = economyCalendarQd(holding, getCalendariaHoursPerDay());
  const dated = calendarQd === null ? local : Math.floor(calendarQd / 40);
  return Math.max(Number(state.clockTenday) || 0, dated + Math.max(0, requested - local));
}
/** An anchored transport date remains valid when the stored calendar stops while local economy advances. */
export function sharedMarketEventTenday(holding, qd, absoluteEventQd = null) {
  const localQd = Math.max(0, Number(holding?.gm?.calendaria?.lastQd) || 0);
  if (owners.has(holding) && Number.isSafeInteger(absoluteEventQd)) return Math.max(0, Math.floor(absoluteEventQd / 40));
  const calendarQd = owners.has(holding) ? economyCalendarQd(holding, getCalendariaHoursPerDay()) : null;
  return Math.max(0, Math.floor((calendarQd === null ? qd : calendarQd + qd - localQd) / 40));
}
export function writeMarketState(holding, key, value, tenday = null) {
  const state = owners.get(holding);
  if (state) {
    state[key] = value;
    state.clockTenday = Math.max(Number(state.clockTenday) || 0, tenday === null ? sharedMarketTenday(holding) : Math.max(0, Number(tenday) || 0));
  } else {
    holding.special ??= {}; holding.special.market ??= {};
    holding.special.market[key] = value;
  }
}
export function advanceSharedMarketClock(holding, targetQd = null, absoluteEventQd = null) {
  const state = owners.get(holding);
  if (state) state.clockTenday = Math.max(sharedMarketTenday(holding), targetQd === null ? 0 : sharedMarketEventTenday(holding, targetQd, absoluteEventQd));
}
