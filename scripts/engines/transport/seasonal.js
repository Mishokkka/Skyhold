import { addCalendariaQd, getCalendariaHoursPerDay, getCalendariaSeasonSnapshot } from "../../integrations/calendaria-bridge.js";
import { edgeSeasonalModifier } from "../market/logistics.js";
import { regularTransportRate, transportRiskBps } from "./economics.js";
import { TransportPlanningUnavailableError } from "./planning-error.js";

const EPSILON = 1e-8;
const roundedQd = value => Math.max(0, Math.ceil(value - EPSILON));

/** The common/local offset belongs to the quote, rather than to the viewer's later clock. */
export function transportSeasonalCalendar(holding, anchorQd = Number(holding?.gm?.calendaria?.lastQd ?? 0)) {
  const clock = holding?.gm?.calendaria ?? {};
  const snapshot = getCalendariaSeasonSnapshot(clock.lastDateTime, clock.lastDateText);
  return { anchorQd, dateTime: snapshot?.dateTime ? addCalendariaQd(snapshot.dateTime, 0) : null,
    fallbackSeasonId: snapshot?.season?.key ?? "" };
}

/** Integrate unrounded movement, including a season boundary inside one physical leg.
 * No extra dispatch, handling operation or stop is introduced at a calendar boundary.
 */
export function transportSeasonalMovement(profile, departureQd) {
  const calendar = profile.calendar ?? {};
  let cursor = departureQd, riskExposureQd = 0, operatingExposureQd = 0, riskFactor = 0.25;
  for (const leg of profile.legs) {
    let work = Number(leg.movementQd ?? 0);
    if (!Number.isFinite(work) || work < 0) throw new Error("Некорректная длительность участка сезонного маршрута.");
    const seasonal = Object.values(leg.seasonalModifiers ?? {}).some(row => row?.enabled);
    while (work > EPSILON) {
      const date = seasonal && calendar.dateTime ? addCalendariaQd(calendar.dateTime, cursor - calendar.anchorQd) : null;
      if (seasonal && calendar.dateTime && !date) throw new TransportPlanningUnavailableError("calendar-unavailable",
        "Для пересчёта сезонного рейса восстановите Calendaria и доступную дату календаря. Принятые брони сохранены.");
      const seasonId = date ? getCalendariaSeasonSnapshot(date)?.season?.key ?? calendar.fallbackSeasonId : calendar.fallbackSeasonId;
      const modifier = edgeSeasonalModifier(leg, seasonId);
      const hoursPerDay = getCalendariaHoursPerDay();
      const hour = Number(date?.hour ?? 0) + Number(date?.minute ?? 0) / 60 + Number(date?.second ?? 0) / 3600;
      const untilMidnight = date ? (hoursPerDay - hour) * 4 / hoursPerDay : Infinity;
      if (!(untilMidnight > EPSILON)) throw new Error("Календарь вернул некорректное время границы суток.");
      const duration = Math.min(work * modifier.timeFactor, untilMidnight);
      const risk = Math.max(0.25, Number(leg.riskFactor ?? 1) * modifier.riskFactor);
      riskFactor = Math.max(riskFactor, risk);
      riskExposureQd += duration * risk;
      operatingExposureQd += duration * Number(leg.operatingFactor ?? 1) * (profile.costSeasonal === false ? 1 : modifier.costFactor);
      work = Math.max(0, work - duration / modifier.timeFactor);
      cursor += duration;
      if (cursor - departureQd > 100000) throw new Error("Маршрут слишком продолжительный.");
    }
  }
  const movementQd = cursor - departureQd;
  return { movementQd, durationQd: roundedQd(movementQd), riskExposureQd, riskFactor,
    operatingFactor: movementQd > EPSILON ? operatingExposureQd / movementQd : Number(profile.legs[0]?.operatingFactor ?? 1) };
}

/** Explicit GM overrides win over calendar-derived estimates. Accepted prices stay in order.plan. */
export function transportServiceAt(service, departureQd, { unloadingQd = service.unloadingQd ?? 0, returnKind = "return" } = {}) {
  const profile = service.seasonal;
  if (!profile) return service;
  const forward = transportSeasonalMovement(profile, departureQd), fixed = profile.fixed ?? {};
  const travelQd = fixed.travel ? service.travelQd : Math.max(service.distanceKm === 0 ? 0 : 1, forward.durationQd);
  const result = { ...service, travelQd,
    riskBps: fixed.risk ? service.riskBps : transportRiskBps(forward.riskExposureQd, profile.baseRiskBps) };
  const arrivalQd = departureQd + travelQd + unloadingQd;
  const reverse = service[`${returnKind}Seasonal`] ?? (service.kind === "owned" ? null : { ...profile, legs: [...profile.legs].reverse() });
  const back = reverse ? transportSeasonalMovement(reverse, arrivalQd + (service.kind === "regular" ? unloadingQd : 0)) : null;
  const scale = (costs, factor) => Object.fromEntries(Object.entries(costs).map(([key, value]) => [key, Math.ceil(value * factor - EPSILON)]));
  if (profile.dailyCosts && !fixed.daily) result.dailyCosts = scale(profile.dailyCosts, forward.operatingFactor);
  if (profile.returnDailyCosts && !fixed.backDaily) result.returnDailyCosts = scale(profile.returnDailyCosts, back?.operatingFactor ?? forward.operatingFactor);
  if (back && !fixed.backTravel) result[`${returnKind}Qd`] = back.durationQd;
  if (service.kind === "regular") {
    result.returnQd = 0;
    if (profile.fare && !fixed.rate) result.loadMilliCopper = regularTransportRate({ ...profile.fare,
      capacityLoad: service.capacity / 4000, travelQd, returnTravelQd: back?.durationQd ?? travelQd,
      loadingQd: service.loadingQd, unloadingQd, dailyCosts: result.dailyCosts,
      returnDailyCosts: result.returnDailyCosts });
    // The regular tariff includes operating costs; these are not separate customer charges.
    delete result.dailyCosts; delete result.returnDailyCosts;
  }
  return result;
}

/** Empty positioning starts when the vessel is actually free, including an aborted pickup. */
export function transportEmptyQd(service, kind, startQd) {
  const profile = service[`${kind}Seasonal`];
  return profile ? transportSeasonalMovement(profile, startQd).durationQd : service[`${kind}Qd`] ?? 0;
}
