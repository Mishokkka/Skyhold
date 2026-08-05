function treasuryDependencies(dependencies = {}) {
  const required = ["safeNumber", "readMoney", "writeMoney", "formatCopperCurrency", "upkeepOperationalFactor"];
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
  salarySettlement = null,
  dependencies = {}
} = {}) {
  if (!holding || typeof holding !== "object") throw new TypeError("FBL Skyhold | Treasury costs require a holding draft.");
  const deps = treasuryDependencies(dependencies);
  const periods = Math.floor(Math.max(0, deps.safeNumber(qd, 0)) / 40);
  if (!periods) return { spent: 0, deficit: 0 };

  if (!holding.gm || typeof holding.gm !== "object") holding.gm = {};
  if (!holding.gm.economy || typeof holding.gm.economy !== "object") holding.gm.economy = {};
  if (!holding.gm.economy.treasury || typeof holding.gm.economy.treasury !== "object") holding.gm.economy.treasury = {};
  const state = holding.gm.economy.treasury;
  const externalSalary = salarySettlement && typeof salarySettlement === "object" ? salarySettlement : null;
  const externalCurrentDue = externalSalary
    ? Math.max(0, Math.floor(deps.safeNumber(externalSalary.currentDueCopper, 0)))
    : 0;
  const externalTotalDue = externalSalary
    ? Math.max(externalCurrentDue, Math.floor(deps.safeNumber(externalSalary.dueCopper, externalCurrentDue)))
    : 0;
  const previousSalaryArrears = externalSalary
    ? Math.max(0, Math.floor(deps.safeNumber(externalSalary.previousArrearsCopper, externalTotalDue - externalCurrentDue)))
    : Math.max(0, Math.floor(deps.safeNumber(state.salaryArrearsCopper, 0)));
  const previousUpkeepArrears = Math.max(0, Math.floor(deps.safeNumber(state.upkeepArrearsCopper, 0)));
  const previousRemainder = Math.max(0, Math.min(2, Math.floor(deps.safeNumber(state.upkeepThirdRemainder, 0))));
  const previousUpkeepOverdueTendays = Math.max(0, Math.floor(deps.safeNumber(state.upkeepOverdueTendays, 0)));
  const salaryCost = externalSalary
    ? externalCurrentDue
    : Math.max(0, Math.floor(deps.safeNumber(totals.salaryTenDay, 0))) * periods;
  const cashWageCost = externalSalary
    ? Math.min(salaryCost, Math.max(0, Math.floor(deps.safeNumber(externalSalary.fixedDueCopper, 0))))
    : Math.max(0, Math.floor(deps.safeNumber(totals.cashWageTenDay, totals.salaryTenDay))) * periods;
  const sharePayoutCost = externalSalary
    ? Math.min(Math.max(0, salaryCost - cashWageCost), Math.max(0, Math.floor(deps.safeNumber(externalSalary.shareDueCopper, salaryCost - cashWageCost))))
    : Math.max(0, salaryCost - cashWageCost);
  const splitMaintenanceBilling = totals.upkeepFixedTenDay !== undefined || totals.upkeepLegacyMonth !== undefined;
  const fixedUpkeepCost = splitMaintenanceBilling
    ? Math.max(0, Math.floor(deps.safeNumber(totals.upkeepFixedTenDay, 0))) * periods
    : 0;
  const legacyUpkeepMonth = splitMaintenanceBilling
    ? Math.max(0, Math.floor(deps.safeNumber(totals.upkeepLegacyMonth, 0)))
    : Math.max(0, Math.floor(deps.safeNumber(totals.upkeepMonth, 0)));
  const upkeepNumerator = previousRemainder + legacyUpkeepMonth * periods;
  const upkeepCost = fixedUpkeepCost + Math.floor(upkeepNumerator / 3);
  const upkeepThirdRemainder = upkeepNumerator % 3;
  const salaryDue = externalSalary ? externalTotalDue : previousSalaryArrears + salaryCost;
  const upkeepDue = previousUpkeepArrears + upkeepCost;

  const before = externalSalary
    ? Math.max(0, Math.floor(deps.safeNumber(externalSalary.treasuryBeforeCopper, deps.readMoney(holding))))
    : Math.max(0, Math.floor(deps.safeNumber(deps.readMoney(holding), 0)));
  const salaryPaid = externalSalary
    ? Math.min(before, salaryDue, Math.max(0, Math.floor(deps.safeNumber(externalSalary.paidCopper, 0))))
    : Math.min(before, salaryDue);
  const afterSalary = before - salaryPaid;
  const upkeepPaid = Math.min(afterSalary, upkeepDue);
  const spent = salaryPaid + upkeepPaid;
  const salaryArrears = Math.max(0, salaryDue - salaryPaid);
  const upkeepArrears = Math.max(0, upkeepDue - upkeepPaid);
  const upkeepOverdueTendays = upkeepArrears > 0 ? previousUpkeepOverdueTendays + periods : 0;
  const upkeepFactor = deps.upkeepOperationalFactor(upkeepOverdueTendays, deps.safeNumber);
  const deficit = salaryArrears + upkeepArrears;
  const hasTreasuryActivity = salaryCost > 0 || upkeepCost > 0 || previousSalaryArrears > 0 || previousUpkeepArrears > 0 || spent > 0 || deficit > 0;
  deps.writeMoney(holding, before - spent);
  state.upkeepThirdRemainder = upkeepThirdRemainder;
  state.salaryArrearsCopper = salaryArrears;
  state.upkeepArrearsCopper = upkeepArrears;
  state.upkeepOverdueTendays = upkeepOverdueTendays;

  if (report?.treasury && typeof report.treasury === "object") {
    report.treasury.spent += spent;
    report.treasury.deficit = deficit;
    report.treasury.salaryCost = salaryCost;
    report.treasury.cashWageCost = cashWageCost;
    report.treasury.sharePayoutCost = sharePayoutCost;
    report.treasury.upkeepCost = upkeepCost;
    report.treasury.salaryPaid = salaryPaid;
    report.treasury.upkeepPaid = upkeepPaid;
    report.treasury.salaryArrears = salaryArrears;
    report.treasury.upkeepArrears = upkeepArrears;
    report.treasury.upkeepThirdRemainder = upkeepThirdRemainder;
    report.treasury.upkeepOverdueTendays = upkeepOverdueTendays;
    report.treasury.upkeepOperationalFactor = upkeepFactor;
    if (hasTreasuryActivity) {
      const operatingMonth = Math.max(0, deps.safeNumber(totals.upkeepOperatingMonth, totals.upkeepMonth));
      const reserveMonth = Math.max(0, deps.safeNumber(totals.repairReserveMonth, 0));
      report.treasury.lines.push(`Начислено за десятник ×${periods}: денежные ставки ${deps.formatCopperCurrency(cashWageCost)}, доли результата ${deps.formatCopperCurrency(sharePayoutCost)}, содержание ${deps.formatCopperCurrency(upkeepCost)} (эксплуатация ${deps.formatCopperCurrency(operatingMonth)} и ремонтный резерв ${deps.formatCopperCurrency(reserveMonth)} за 30 дней).`);
      if (previousSalaryArrears || previousUpkeepArrears) {
        report.treasury.lines.push(`Долг до расчёта: зарплаты ${deps.formatCopperCurrency(previousSalaryArrears)}, содержание ${deps.formatCopperCurrency(previousUpkeepArrears)}.`);
      }
      if (spent) report.treasury.lines.push(`Погашено: зарплаты ${deps.formatCopperCurrency(salaryPaid)}, содержание ${deps.formatCopperCurrency(upkeepPaid)}.`);
      if (deficit) report.treasury.lines.push(`Осталось в долге: зарплаты ${deps.formatCopperCurrency(salaryArrears)}, содержание ${deps.formatCopperCurrency(upkeepArrears)}.`);
      if (upkeepArrears) report.treasury.lines.push(`Просрочка содержания: ${upkeepOverdueTendays} десятн.; доступная мощность зданий в следующем периоде ${Math.round(upkeepFactor * 100)}%.`);
    }
  }
  if (externalSalary) {
    if (salaryPaid > 0) deps.appendLedger?.(report, {
      domain: "payroll",
      kind: "money",
      resourceId: "money",
      name: "Выплаты жителям",
      qty: -salaryPaid,
      roomId: "treasury",
      source: "Расчёт оплаты труда",
      note: `Погашено обязательств по оплате труда: ${deps.formatCopperCurrency(salaryPaid)}`
    });
    if (upkeepPaid > 0) deps.appendLedger?.(report, {
      domain: "treasury",
      kind: "money",
      resourceId: "money",
      name: "Содержание владения",
      qty: -upkeepPaid,
      roomId: "treasury",
      source: "Казна",
      note: `Погашено содержание: ${deps.formatCopperCurrency(upkeepPaid)}`
    });
  } else if (spent > 0) deps.appendLedger?.(report, {
    domain: "treasury",
    kind: "money",
    resourceId: "money",
    name: "Расходы казны",
    qty: -spent,
    roomId: "treasury",
    source: "Казна",
    note: `Погашено: зарплаты ${deps.formatCopperCurrency(salaryPaid)}; содержание ${deps.formatCopperCurrency(upkeepPaid)}`
  });
  if (deficit > 0) deps.appendLedger?.(report, {
    domain: "treasury",
    kind: "notice",
    name: "Задолженность казны",
    qty: deficit,
    source: "Казна",
    status: "warning",
    note: `Зарплаты ${deps.formatCopperCurrency(salaryArrears)}; содержание ${deps.formatCopperCurrency(upkeepArrears)}`
  });
  const result = {
    spent,
    deficit,
    salaryCost,
    cashWageCost,
    sharePayoutCost,
    upkeepCost,
    salaryPaid,
    upkeepPaid,
    salaryArrears,
    upkeepArrears,
    upkeepThirdRemainder,
    upkeepOverdueTendays,
    upkeepOperationalFactor: upkeepFactor
  };
  if (externalSalary) result.externalSalarySettlement = true;
  return result;
}
