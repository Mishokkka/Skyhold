import { residentShipAssignment } from "../../data/resident-presence.js";
import { shipMoneySummary } from "./summary.js";

/** Shared by the card and the authority transaction; never deletes residents or Actors. */
export function shipRemovalBlocker(holding, ship) {
  if ((holding.special?.market?.outbound?.orders ?? []).some((order) => order.ownShipId === ship.id
    && !["delivered", "lost", "cancelled"].includes(order.status))) return "Дождитесь исхода продажи собственного товара.";
  if (ship.activeVoyage || ship.orderBundle || ship.currentOuting) return "Сначала завершите путешествие и верните корабль домой.";
  if (ship.status !== "docked" || (ship.navigationMode === "world" && ship.location?.kind !== "home")) {
    return "Удаление доступно только для корабля в поселении.";
  }
  if (Number(ship.onboardCopper ?? 0) !== 0) return "Сначала верните бортовую казну в поселение.";
  const money = shipMoneySummary(holding, ship, { clockQd: Number(holding.gm?.calendaria?.lastQd ?? 0) });
  if (money.obligationsCopper > 0) return "Сначала погасите расходы на содержание корабля.";
  if ((holding.people?.list ?? []).some((person) => {
    const assignment = residentShipAssignment(person);
    return String(assignment?.shipId ?? "") === String(ship.id) && assignment?.away === true;
  })) return "Сначала верните экипаж в поселение.";
  return "";
}

export function removeSettlementShip(holding, ship) {
  const blocker = shipRemovalBlocker(holding, ship);
  if (blocker) throw Object.assign(new Error(blocker), { code: "conflict" });
  const ships = holding.special.ships;
  ships.list = ships.list.filter((row) => row.id !== ship.id);
  ships.offers = (ships.offers ?? []).filter((row) => row.shipId !== ship.id);
  if (ships.worldOfferLocks) {
    ships.worldOfferLocks = Object.fromEntries(Object.entries(ships.worldOfferLocks).filter(([, row]) => row?.shipId !== ship.id));
  }
  let releasedResidents = 0;
  for (const person of holding.people?.list ?? []) {
    if (String(residentShipAssignment(person)?.shipId ?? "") !== String(ship.id)) continue;
    delete person.shipAssignment;
    releasedResidents++;
  }
  // Completed voyages remain in settlement history; jobs and resident identities stay intact.
  return { shipId: ship.id, deleted: true, releasedResidents };
}
