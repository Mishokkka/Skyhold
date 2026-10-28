import { economyDayIndex } from "../../core/economy-calendar.js";
import { getCalendariaHoursPerDay } from "../../integrations/calendaria-bridge.js";

/** Calendar coordinate, independent of a holding's age. Stored dates use public month/day numbers. */
export function transportCalendarQd(holding) {
  const calendar = holding?.gm?.calendaria ?? {};
  const day = economyDayIndex({ gm: { calendaria: { lastDateTime: calendar.lastDateTime, lastDateKey: calendar.lastDateKey } } });
  const date = calendar.lastDateTime;
  const hour = Number(date?.hour ?? 0) + Number(date?.minute ?? 0) / 60 + Number(date?.second ?? 0) / 3600;
  return day === null ? null : day * 4 + Math.floor(hour * 4 / getCalendariaHoursPerDay());
}

/** Anchor existing schedules once; never replace local economy counters or rewrite accepted runs. */
export function transportEpochQd(data) {
  if (Number.isSafeInteger(data.meta?.transportV2?.calendarEpochQd)) return data.meta.transportV2.calendarEpochQd;
  const dated = (data.holdings ?? []).filter(holding => transportCalendarQd(holding) !== null)
    .sort((a, b) => Number(b.gm?.calendaria?.lastQd ?? 0) - Number(a.gm?.calendaria?.lastQd ?? 0));
  const anchor = dated[0];
  return anchor ? transportCalendarQd(anchor) - Number(anchor.gm?.calendaria?.lastQd ?? 0)
    - Number(anchor.special?.transportV2?.clockOffsetQd ?? 0) : null;
}

export function transportClockOffsetQd(data, holding) {
  const calendar = transportCalendarQd(holding), epoch = transportEpochQd(data);
  const saved = holding.special?.transportV2;
  // Economy may continue while Calendaria is unavailable. An unchanged stored date
  // must not cancel newly elapsed local time or move already accepted schedules back.
  if (calendar !== null && saved?.calendarAnchorQd === calendar && Number.isSafeInteger(saved.clockOffsetQd)) return saved.clockOffsetQd;
  return calendar !== null && epoch !== null ? calendar - epoch - Number(holding.gm?.calendaria?.lastQd ?? 0)
    : Number(saved?.clockOffsetQd ?? 0);
}

/** Record a conversion only on an explicit execution draft, before its local clock advances. */
export function recordTransportClock(data, holding) {
  const clockOffsetQd = transportClockOffsetQd(data, holding), calendar = transportCalendarQd(holding);
  holding.special ??= {};
  holding.special.transportV2 ??= { version: 2, orders: [] };
  holding.special.transportV2.clockOffsetQd = clockOffsetQd;
  if (calendar !== null) holding.special.transportV2.calendarAnchorQd = calendar;
}

export function transportHoldingQd(data, holding, localQd = Number(holding.gm?.calendaria?.lastQd ?? 0)) {
  return localQd + transportClockOffsetQd(data, holding);
}

export const transportLocalQd = (order, commonQd) => commonQd - (order.clockOffsetQd ?? 0);
