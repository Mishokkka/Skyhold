const whole = (value) => Math.max(0, Math.floor(Number(value) || 0));
/** Cash flows only. Existing truncated voyage logs are never presented as complete history. */
export function recordFleetFunds(ship, receipt, { clockQd = 0, idle = "" } = {}) {
  const delta = Number(receipt?.externalDeltaCopper) || 0;
  if (!delta) return;
  ship.fleetAccounting ??= { sinceQd: whole(clockQd), incomeCopper: 0, expenseCopper: 0, homeIdleCopper: 0, portIdleCopper: 0 };
  const account = ship.fleetAccounting;
  if (delta > 0 && receipt.kind === "expense-refund") account.expenseCopper = Math.max(0, whole(account.expenseCopper) - delta);
  else if (delta > 0) account.incomeCopper = whole(account.incomeCopper) + delta;
  else account.expenseCopper = whole(account.expenseCopper) - delta;
  if (delta < 0 && idle === "home") account.homeIdleCopper = whole(account.homeIdleCopper) - delta;
  if (delta < 0 && idle === "port") account.portIdleCopper = whole(account.portIdleCopper) - delta;
  account.throughQd = Math.max(whole(account.throughQd), whole(clockQd));
}
export function fleetAccountingSummary(holding = {}) {
  const ships = holding.special?.ships?.list ?? [];
  const accounts = ships.map((ship) => ship.fleetAccounting).filter(Boolean);
  const sum = (key) => accounts.reduce((total, account) => total + whole(account[key]), 0);
  const incomeCopper = sum("incomeCopper"), expenseCopper = sum("expenseCopper");
  return { tracked: accounts.length > 0, ships: ships.length, trackedShips: accounts.length,
    sinceQd: accounts.length ? Math.min(...accounts.map((account) => whole(account.sinceQd))) : 0,
    incomeCopper, expenseCopper, netCopper: incomeCopper - expenseCopper,
    homeIdleCopper: sum("homeIdleCopper"), portIdleCopper: sum("portIdleCopper") };
}
export function shipIdleReserveCopper(dailyCopper, arrivalQd) {
  const arrival = whole(arrivalQd);
  return Math.ceil(whole(dailyCopper) * Math.max(8, Math.ceil(arrival / 40) * 40 - arrival) / 4);
}
