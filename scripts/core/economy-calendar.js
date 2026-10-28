export const ECONOMY_DAYS_PER_YEAR = 240;
export const ECONOMY_DAYS_PER_MONTH = 30;
export const ECONOMY_MONTHS_PER_YEAR = 8;
export const ECONOMY_QD_PER_DAY = 4;

/** A dated coordinate, including partial days, without the local-age fallback. */
export function economyCalendarQd(holding, hoursPerDay = 24) {
  const calendar = holding?.gm?.calendaria ?? {};
  const day = economyDayIndex({ gm: { calendaria: { lastDateTime: calendar.lastDateTime, lastDateKey: calendar.lastDateKey } } });
  const date = calendar.lastDateTime;
  const hour = Number(date?.hour ?? 0) + Number(date?.minute ?? 0) / 60 + Number(date?.second ?? 0) / 3600;
  return day === null ? null : day * ECONOMY_QD_PER_DAY + Math.floor(hour * ECONOMY_QD_PER_DAY / hoursPerDay);
}

/** Stored Calendaria dates are one-based; this pure helper never reads a real clock. */
export function economyDayIndex(holding = {}) {
  const calendar = holding.gm?.calendaria ?? {};
  const key = String(calendar.lastDateKey ?? "").match(/^(-?\d+)-(\d+)-(\d+)/);
  const date = calendar.lastDateTime ?? (key ? { year: key[1], month: key[2], day: key[3] } : null);
  if (date) {
    const { year, month, day } = Object.fromEntries(["year", "month", "day"].map((part) => [part, Number(date[part])]));
    if (Number.isInteger(year) && month >= 1 && month <= 8 && day >= 1 && day <= 30) {
      return year * ECONOMY_DAYS_PER_YEAR + (month - 1) * ECONOMY_DAYS_PER_MONTH + day - 1;
    }
  }
  if (calendar.lastQd !== undefined && Number.isFinite(Number(calendar.lastQd))) return Math.floor(Math.max(0, Number(calendar.lastQd)) / ECONOMY_QD_PER_DAY);
  return null;
}
