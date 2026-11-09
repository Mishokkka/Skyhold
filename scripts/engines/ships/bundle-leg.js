import { transportSeasonalMovement } from "../transport/seasonal.js";
import { transportPeriodCosts, transportMoney } from "../transport/quantities.js";
import { transportRiskBps } from "../transport/economics.js";

/** Accepted physical inputs survive catalog edits; legacy numeric legs keep their terms. */
export function worldShipBundleLegAt(stop, clockQd) {
  const offer = structuredClone(stop.legOffer), quote = offer.quote, profile = quote.seasonal;
  if (!profile) return { offer, economics: structuredClone(stop.economics) };
  const movement = transportSeasonalMovement(profile, clockQd + profile.loadingQd);
  const durationQd = movement.durationQd + profile.handlingQd;
  const daily = transportPeriodCosts(durationQd, profile.dailyCosts);
  const costs = { ...quote.costs, foodCopper: daily.foodCopper, crewCopper: daily.crewCopper, upkeepCopper: daily.upkeepCopper };
  costs.operatingCopper = costs.totalCopper = transportMoney([daily.totalCopper, costs.handlingCopper, costs.taxCopper]);
  const difference = costs.totalCopper - quote.operatingCopper;
  Object.assign(quote, { durationQd, costs, operatingCopper: costs.totalCopper,
    recommendedBudgetCopper: Math.max(costs.totalCopper, quote.recommendedBudgetCopper + difference) });
  const economics = stop.economics ? { ...stop.economics,
    riskBps: transportRiskBps(movement.riskExposureQd * profile.illegalRisk, profile.baseRiskBps) } : undefined;
  return { offer, economics };
}
