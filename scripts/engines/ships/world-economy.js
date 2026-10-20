import { isResidentAway, isResidentInPopulation } from "../../data/resident-presence.js";
import { advanceWorldShips } from "./world-voyage.js";
import { disembarkShipCrew } from "./crew.js";
import { buildShipWorldContext, configureWorldShipEconomy } from "./world-market.js";

/** Refresh the derived home rate only inside an explicit period/ship mutation. */
export function refreshWorldShipHomeEconomy(data, holding, { report = null } = {}) {
  const ships = (holding?.special?.ships?.list ?? []).filter((ship) => ship.navigationMode === "world");
  if (!ships.length) return { refreshed: 0 };
  const context = buildShipWorldContext(data, holding, { offerLocationIds: [] });
  for (const ship of ships) {
    const quote = configureWorldShipEconomy(data, holding, ship, { context });
    if (quote.rateFrozen && Array.isArray(report?.skipped)) {
      const message = `${ship.name}: ${quote.wageIssues.map((issue) => issue.message).join(" ")} Домашняя ставка сохранена: ${quote.homeUpkeepCopperPerDay} ММ в день до исправления жалования.`;
      if (!report.skipped.includes(message)) report.skipped.push(message);
    }
  }
  return { refreshed: ships.length };
}

/** Returning crew rest aboard; only residents working ashore consume settlement food. */
export function worldShipPresenceDays(holding, startQd, endQd) {
  const ships = holding?.special?.ships?.list ?? [];
  if (!ships.some((ship) => ship.navigationMode === "world")) return null;
  for (const ship of ships.filter((row) => row.navigationMode === "world")) {
    for (const id of ship.crewResidentIds ?? []) {
      const person = holding.people?.list?.find((row) => String(row.id) === String(id));
      if (!person || person.dead) continue;
      const expectedAway = Boolean(ship.activeVoyage || ship.status === "away");
      if (expectedAway && (!isResidentAway(person) || person.shipAssignment.shipId !== ship.id)) {
        throw new Error(`${ship.name}: не совпадают связи экипажа и присутствие жителя ${person.name || id}. Исправьте связь перед расчётом периода.`);
      }
    }
  }
  const durationDays = Math.max(0, (endQd - startQd) / 4);
  const days = new Map((holding.people?.list ?? []).map((person) => [
    String(person.id),
    isResidentInPopulation(person, holding) ? durationDays : 0
  ]));
  return days;
}

export function advanceWorldShipEconomy(holding, targetQd, report, appendLedger, { shipId = null } = {}) {
  const result = advanceWorldShips(holding, targetQd, { shipId });
  for (const row of result.returned) {
    const ship = holding.special.ships.list.find((item) => item.id === row.shipId);
    const crew = disembarkShipCrew(holding, ship, row.arrivalQd);
    for (const issue of crew.issues) report.skipped.push(`${row.name}: ${issue.message}`);
    const returnedCopper = row.summary?.returnedCopper ?? 0;
    report.work.push(`${row.name}: вернулся домой; экипаж отдыхает на борту до отдельного направления на работу, в общую казну ${returnedCopper} ММ.`);
    appendLedger(report, { domain: "treasury", kind: "money", resourceId: "money", name: "Возврат бортовой казны", qty: returnedCopper, roomId: "treasury", source: row.name, operationId: `${row.summary?.id}:return`, note: "Остаток бортовой казны переведён домой.", meta: { internalTransfer: true, storageKind: "transfer" } });
  }
  for (const row of result.arrived.filter((item) => item.location?.kind !== "home")) report.work.push(`${row.name}: стоянка — ${row.location.label}; доступны новые заказы или возвращение.`);
  for (const row of result.awaiting) report.work.push(`${row.name}: ожидает подведения итогов заказа; бортовая казна остаётся у корабля.`);
  for (const row of result.blocked) report.skipped.push(`${row.name}: ${row.message}`);
  for (const row of result.expenses) {
    const sources = [];
    if (row.treasuryPaidCopper) sources.push(`общая казна: ${row.treasuryPaidCopper} ММ`);
    if (row.onboardPaidCopper) sources.push(`бортовая казна: ${row.onboardPaidCopper} ММ`);
    report.work.push(`${row.name}: содержание на стоянке — ${row.amountCopper} ММ (${sources.join("; ")}).`);
    if (row.treasuryPaidCopper) {
      if (report.treasury) report.treasury.spent += row.treasuryPaidCopper;
      appendLedger(report, { domain: "treasury", kind: "money", resourceId: "money", name: "Содержание корабля дома", qty: -row.treasuryPaidCopper, roomId: "treasury", sourceId: row.shipId, source: row.name, note: "Содержание корпуса, питание и жалование отдыхающего на борту экипажа." });
    }
    if (row.onboardPaidCopper) {
      appendLedger(report, { domain: "system", kind: "money", resourceId: "money", name: "Содержание корабля из бортовой казны", qty: -row.onboardPaidCopper, roomId: `ship:${row.shipId}`, sourceId: row.shipId, source: row.name, note: "Оплачено из бортового кошелька корабля.", meta: { storageKind: "expense", shipWallet: true } });
    }
  }
  return result;
}
