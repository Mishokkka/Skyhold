import { economicContractOutcome } from "./contract-economics.js";
import { transportInteger, transportMoney } from "../transport/quantities.js";

function die(random, sides) {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error("Некорректный источник случайных чисел.");
  return Math.floor(value * sides) + 1;
}

/** Roll each accepted physical leg once, including empty approach. All cargo aboard shares that leg's event. */
export function resolveBundlePassages(bundle, stop, random) {
  if (stop.physicalResolution) return stop.physicalResolution;
  const outcomes = [];
  for (const passage of bundle.stops.slice(0, bundle.nextStopIndex)) {
    if (passage.physicalOutcome || passage.economics?.version !== 1) continue;
    const outcome = economicContractOutcome({ kind: "freight", rewardCopper: 0, economics: passage.economics },
      bundle.orders[0].style, { commercialDice: [3, 4], incidentRoll: die(random, 12), passageRoll: die(random, 10000) });
    passage.physicalOutcome = outcome;
    for (const id of passage.cargoOfferIds) {
      const order = bundle.orders.find(row => row.offerId === id);
      if (!order || order.outcomeApplied) throw new Error("Груз участка не совпадает с принятым составным рейсом.");
      order.cargoRewardBps = Math.floor((order.cargoRewardBps ?? 10000) * outcome.physicalIncident.cargoRewardPercent / 100);
    }
    outcomes.push(outcome);
  }
  stop.physicalResolution = {
    expenseCopper: transportMoney(outcomes.map(row => row.expenseCopper)),
    delayQd: transportInteger(outcomes.reduce((sum, row) => sum + row.delayQd, 0), "задержка составного рейса"),
    passages: outcomes.map(row => ({ eventId: row.eventId, eventLabel: row.eventLabel, riskBps: row.riskBps,
      passageRoll: row.passageRoll, incidentRoll: row.incidentRoll, expenseCopper: row.expenseCopper, delayQd: row.delayQd }))
  };
  return stop.physicalResolution;
}
