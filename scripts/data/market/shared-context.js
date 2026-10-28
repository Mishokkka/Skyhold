import { economyCalendarQd } from "../../core/economy-calendar.js";
import { getCalendariaHoursPerDay } from "../../integrations/calendaria-bridge.js";

const owners = new WeakMap();
export function bindSharedMarketHolding(holding, state) {
  if (holding && typeof holding === "object") {
    if (state?.enabled === true) owners.set(holding, state);
    else owners.delete(holding);
  }
  return holding;
}
export function bindSharedMarkets(data) {
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
