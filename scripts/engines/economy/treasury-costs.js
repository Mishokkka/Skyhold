function treasuryDependencies(dependencies = {}) {
  const required = ["safeNumber", "readMoney", "writeMoney", "formatCopperCurrency"];
  for (const name of required) {
    if (typeof dependencies[name] !== "function") {
      throw new TypeError(`FBL Skyhold | Treasury costs require dependency "${name}".`);
    }
  }
  return dependencies;
}

export function runTreasuryCosts({
  holding,
  qd = 0,
  totals = {},
  report = null,
  dependencies = {}
} = {}) {
  if (!holding || typeof holding !== "object") throw new TypeError("FBL Skyhold | Treasury costs require a holding draft.");
  const deps = treasuryDependencies(dependencies);
  const periods = Math.floor(Math.max(0, deps.safeNumber(qd, 0)) / 40);
  if (!periods) return { spent: 0, deficit: 0 };

  const salaryCost = Math.max(0, Math.floor(deps.safeNumber(totals.salaryTenDay, 0))) * periods;
  const upkeepCost = Math.max(0, Math.floor(deps.safeNumber(totals.upkeepMonth, 0) / 3)) * periods;
  const totalCost = salaryCost + upkeepCost;
  if (!totalCost) return { spent: 0, deficit: 0 };

  const before = Math.max(0, Math.floor(deps.safeNumber(deps.readMoney(holding), 0)));
  const spent = Math.min(before, totalCost);
  const deficit = Math.max(0, totalCost - before);
  deps.writeMoney(holding, before - spent);

  if (report?.treasury && typeof report.treasury === "object") {
    report.treasury.spent += spent;
    report.treasury.deficit += deficit;
    report.treasury.lines.push(`Расходы за десятник ×${periods}: зарплаты ${deps.formatCopperCurrency(salaryCost)}, содержание ${deps.formatCopperCurrency(upkeepCost)}.`);
  }
  if (spent > 0) deps.appendLedger?.(report, {
    domain: "treasury",
    kind: "money",
    resourceId: "money",
    name: "Расходы казны",
    qty: -spent,
    roomId: "treasury",
    source: "Казна",
    note: `Зарплаты ${deps.formatCopperCurrency(salaryCost)}; содержание ${deps.formatCopperCurrency(upkeepCost)}`
  });
  if (deficit > 0) deps.appendLedger?.(report, {
    domain: "treasury",
    kind: "notice",
    name: "Дефицит казны",
    qty: deficit,
    source: "Казна",
    status: "warning",
    note: `Не оплачено ${deps.formatCopperCurrency(deficit)}`
  });
  return { spent, deficit, salaryCost, upkeepCost };
}
