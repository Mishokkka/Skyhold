import { embarkShipCrew, disembarkShipCrew } from "../../engines/ships/crew.js";
import { buildShipWorldContext } from "../../engines/ships/world-market.js";
import { beginShipOuting, ensurePartialShipOuting, planShipOutingLeg, recordShipOutingFunds, completeShipOutingLeg } from "../../engines/ships/outing-report.js";
import { recordFleetFunds } from "../../engines/ships/fleet-accounting.js";
import { advanceWorldShips, worldShipPortDebtCopper } from "../../engines/ships/world-voyage.js";
import { ownedTransportActualCosts, prepareOwnedTransportAbort } from "../../engines/transport/owned-costs.js";
import { transportLocalQd } from "../../data/transport/clock.js";

const shipFor = (holding, order) => {
  const ship = holding.special?.ships?.list?.find((row) => row.id === order.ownShipId);
  if (!ship) throw new Error("Корабль транспортного заказа не найден.");
  return ship;
};
function point(data, holding, regionId) {
  regionId = String(regionId).replace(/:holding$/, "");
  const home = buildShipWorldContext(data, holding, { offerLocationIds: [] }).home;
  return regionId === home.regionId ? home : { kind: "market", id: regionId, regionId,
    label: data.catalog.eventRegions.find((row) => row.value === regionId)?.label ?? regionId };
}

export function beginTransportShip(data, holding, order) {
  if (order.shipStarted) return;
  const ship = shipFor(holding, order), clock = transportLocalQd(order, order.plan.startQd);
  order.shipOrigin = structuredClone(ship.location);
  if (ship.location.kind === "home") beginShipOuting(ship, { voyageId: order.id, clockQd: clock,
    budgetCopper: order.plan.ownExpensesCopper + order.money.reserveCopper - order.money.boardCopper });
  else ensurePartialShipOuting(ship, { voyageId: order.id, clockQd: clock });
  planShipOutingLeg(ship, { id: order.id, startedAtQd: clock, quote: { from: ship.location,
    to: point(data, holding, order.plan.shipReleaseLocation), durationQd: Math.max(1, order.plan.shipReleaseQd - order.plan.startQd),
    operatingCopper: order.plan.ownExpensesCopper, rewardCopper: 0 } });
  embarkShipCrew(holding, ship, clock);
  ship.status = "away"; ship.timelineQd = clock; ship.portBilling = null;
  ship.location = { kind: "transit", id: order.id, label: "По транспортному плану", regionId: order.shipOrigin.regionId };
  order.shipStarted = true;
  order.shipExpenseRecordedCopper = 0;
}

export function recordTransportShipIncome(holding, order, amountCopper, atQd) {
  atQd = transportLocalQd(order, atQd);
  const ship = shipFor(holding, order);
  ship.onboardCopper += amountCopper;
  const receipt = { id: `${order.id}:sale:${atQd}`, kind: "income", externalDeltaCopper: amountCopper };
  recordFleetFunds(ship, receipt, { clockQd: atQd });
  if (ship.currentOuting) recordShipOutingFunds(ship, receipt, { clockQd: atQd, reason: "Выручка за доставленный собственный груз" });
}

export function advanceTransportShip(data, holding, order, targetQd) {
  if (order.shipReleased) return;
  targetQd = transportLocalQd(order, targetQd);
  const ship = shipFor(holding, order);
  const stages = order.stages.filter((stage) => stage.service.kind === "owned");
  const ownRuns = stages.flatMap((stage) => stage.runs);
  prepareOwnedTransportAbort(order, data.meta.transportV2);
  const completed = Boolean(order.shipAbort || stages.every((stage) => stage.status === "arrived"));
  if (completed && !order.shipCostsReconciled) {
    const actual = ownedTransportActualCosts(order, data.meta.transportV2);
    const prepaid = order.shipAbort ? order.money.escrowCopper : order.money.reserveCopper;
    const freeBoard = Math.max(0, ship.onboardCopper - worldShipPortDebtCopper(ship, targetQd));
    const available = prepaid + freeBoard;
    if (actual.differenceCopper > available) {
      order.fundingNeededCopper = actual.differenceCopper - available;
    } else {
      delete order.fundingNeededCopper;
      if (actual.differenceCopper > 0) {
        const fromBoard = Math.max(0, actual.differenceCopper - prepaid);
        ship.onboardCopper -= fromBoard;
        order.money.boardCopper += fromBoard;
        order.money.escrowCopper += fromBoard;
        order.money.escrowCopper -= actual.differenceCopper;
        order.money.reserveCopper = order.shipAbort ? Math.min(order.money.reserveCopper, order.money.escrowCopper)
          : Math.max(0, order.money.reserveCopper - actual.differenceCopper);
      } else if (actual.differenceCopper < 0) {
        ship.onboardCopper -= actual.differenceCopper;
        order.money.refundedCopper -= actual.differenceCopper;
      }
      order.money.spentCopper += actual.differenceCopper;
      order.ownedActualCopper = actual.actualCopper;
      order.shipCostsReconciled = true;
    }
  }
  const spent = order.ownedActualCopper ?? stages.filter((stage) => stage.receipts.length).reduce((sum, stage) => sum + stage.totalCopper, 0)
    + (order.history.some((row) => row.kind === "departed") ? order.plan.approachCopper : 0);
  const delta = spent - order.shipExpenseRecordedCopper;
  if (delta !== 0) {
    const receipt = { id: `${order.id}:operating:${spent}`, kind: delta > 0 ? "expense" : "expense-refund", externalDeltaCopper: -delta };
    recordFleetFunds(ship, receipt, { clockQd: targetQd });
    recordShipOutingFunds(ship, receipt, { clockQd: targetQd, reason: "Расходы транспортного заказа" });
    order.shipExpenseRecordedCopper = spent;
  }
  const last = [...ownRuns].sort((a, b) => b.releaseQd - a.releaseQd)[0];
  const sharedLast = data.meta.transportV2.runs.find((run) => run.id === last?.id);
  const releaseQd = transportLocalQd(order, order.shipAbort?.releaseQd ?? Math.max(last.releaseQd, sharedLast?.releaseQd ?? 0));
  ship.timelineQd = Math.max(ship.timelineQd, Math.min(targetQd, releaseQd));
  if (targetQd < releaseQd || !completed) return;
  const destination = point(data, holding, order.shipAbort?.location ?? last.releaseLocation);
  if (!order.shipArrived) {
    ship.location = destination;
    ship.status = destination.kind === "home" ? "docked" : "away";
    if (destination.kind === "home") disembarkShipCrew(holding, ship, releaseQd);
    ship.idleUpkeepCopperPerDay = order.shipAbort?.idleUpkeepCopperPerDay ?? stages.at(-1)?.service.idleUpkeepCopperPerDay ?? ship.idleUpkeepCopperPerDay;
    const dailyCopper = destination.kind === "home" ? (ship.homeUpkeepEnabled === false ? 0 : ship.homeUpkeepCopperPerDay ?? 0) : ship.idleUpkeepCopperPerDay ?? 0;
    ship.portBilling = { scope: destination.kind, sinceQd: releaseQd, lastCalculatedQd: releaseQd, dailyCopper, carriedCopper: 0, chargedCopper: 0 };
    order.shipArrived = true;
  }
  // An unpaid adjustment keeps the assignment locked, but never suspends physical arrival or idle upkeep.
  if (order.fundingNeededCopper) return advanceWorldShips(holding, targetQd, { shipId: ship.id, transportOrderId: order.id });
  ship.onboardCopper += order.money.reserveCopper;
  order.money.escrowCopper -= order.money.reserveCopper;
  order.money.reserveCopper = 0;
  delete ship.transportOrderId;
  let returnedCopper = 0;
  if (destination.kind === "home") {
    returnedCopper = ship.onboardCopper;
    holding.storage.moneyCopper += returnedCopper;
    ship.onboardCopper = 0;
  }
  completeShipOutingLeg(ship, { id: order.id, from: order.shipOrigin, to: destination, arrivedAtQd: releaseQd, returnedCopper });
  order.shipReleased = true;
  // The ordinary idle ledger resumes exactly where the transport interval ends.
  return advanceWorldShips(holding, targetQd, { shipId: ship.id });
}
