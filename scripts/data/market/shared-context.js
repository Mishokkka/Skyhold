import { economyDayIndex } from "../../core/economy-calendar.js";

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
  const days = economyDayIndex(holding);
  const dated = days === null ? local : Math.floor(days / 10);
  return Math.max(Number(state.clockTenday) || 0, dated + Math.max(0, requested - local));
}
/** Convert an actual transport receipt date without moving it to another holding's later clock. */
export function sharedMarketEventTenday(holding, qd) {
  const localQd = Math.max(0, Number(holding?.gm?.calendaria?.lastQd) || 0);
  const days = owners.has(holding) ? economyDayIndex(holding) : null;
  return Math.max(0, Math.floor((days === null ? qd : days * 4 + qd - localQd) / 40));
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
export function advanceSharedMarketClock(holding) {
  const state = owners.get(holding);
  if (state) state.clockTenday = sharedMarketTenday(holding);
}
