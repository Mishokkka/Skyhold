// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import {
  resourceDef,
  resourceTradeReady
} from "../../../core/resources.js";
import { formatCopperCurrency, parseCopperCurrency } from "../../../core/currency.js";
import { compensationTypeLabel, personBoardFoodDaily, personShareRate } from "../../../core/compensation.js";
import { buildingMaintenanceState } from "../../../core/building-maintenance.js";
import { WAGE_CATALOG, normalizeWageIndex, wageCopperPerTenday } from "../../../data/labor/wage-catalog.js";
import { normalizePayrollState } from "../../../data/labor/payroll-state.js";

export const FinanceTreasuryDomain = {
_prepareTotals(holding, _workerContext = null) {
  if (!holding) return { salary: 0, cashWageDaily: 0, cashWageTenDay: 0, sharePayoutTenDay: 0, salaryTenDay: 0, salaryMonth: 0, boardFoodDaily: 0, boardFoodTenDay: 0, upkeepFixedTenDay: 0, upkeepLegacyMonth: 0, upkeepTenDay: 0, upkeepOperatingMonth: 0, repairReserveMonth: 0, upkeepMonth: 0, incomeTenDay: 0, projectedBalanceMonth: 0, salaryArrearsCopper: 0, upkeepArrearsCopper: 0, totalArrearsCopper: 0, population: 0, peopleRows: 0, buildingsRows: 0, specialRows: 0, storageRows: 0, payrollForecastReady: true, payrollForecastBlockers: [], payrollForecastFixedPeopleCount: 0, payrollForecastShareExcluded: false };

  const people = (holding.people?.list ?? []).filter((person) => !person?.dead);
  const buildings = holding.buildings?.list ?? [];
  const payrollForecast = this._payrollForecast(holding, { qd: 40 });
  const cashWageTenDay = payrollForecast.fixedDueCopper;
  const cashWageDaily = cashWageTenDay / 10;
  const maintenanceTotals = buildings.reduce((sum, building) => {
    if (this._buildingStatus(building).value !== "built") return sum;
    const maintenance = buildingMaintenanceState(building, (value, fallback = 0) => this._safeNumber(value, fallback));
    sum.operating += maintenance.operatingCopperMonthly;
    sum.reserve += maintenance.repairReserveCopperMonthly;
    if (maintenance.billingMode === "fixed-tenday") sum.fixedTenDay += maintenance.copperPerTenday;
    else sum.legacyMonth += maintenance.totalCopperMonthly;
    return sum;
  }, { operating: 0, reserve: 0, fixedTenDay: 0, legacyMonth: 0 });
  const upkeepMonth = maintenanceTotals.fixedTenDay * 3 + maintenanceTotals.legacyMonth;
  const upkeepTenDay = maintenanceTotals.fixedTenDay + maintenanceTotals.legacyMonth / 3;
  // Income and enterprise shares are ledger outcomes. Counting configured
  // capacity here would create money before stock, demand and direct costs are known.
  const incomeTenDay = 0;
  const sharePayoutTenDay = payrollForecast.shareDueCopper;
  const salaryTenDay = cashWageTenDay + sharePayoutTenDay;
  const salaryMonth = salaryTenDay * 3;
  const boardFoodDaily = people.reduce((sum, person) => sum + personBoardFoodDaily(person), 0);
  const treasuryState = holding?.gm?.economy?.treasury ?? {};
  const payrollState = normalizePayrollState(holding?.gm?.economy?.labor?.payroll);
  const salaryArrearsCopper = Object.values(payrollState.accounts)
    .reduce((sum, account) => sum + Math.max(0, Math.floor(this._safeNumber(account?.arrearsCopper, 0))), 0);
  const upkeepArrearsCopper = Math.max(0, Math.floor(this._safeNumber(treasuryState.upkeepArrearsCopper, 0)));

  return {
    salary: cashWageDaily,
    cashWageDaily,
    cashWageTenDay,
    sharePayoutTenDay,
    salaryTenDay,
    salaryMonth,
    boardFoodDaily,
    boardFoodTenDay: boardFoodDaily * 10,
    upkeepFixedTenDay: maintenanceTotals.fixedTenDay,
    upkeepLegacyMonth: maintenanceTotals.legacyMonth,
    upkeepTenDay,
    upkeepOperatingMonth: maintenanceTotals.operating,
    repairReserveMonth: maintenanceTotals.reserve,
    upkeepMonth,
    incomeTenDay,
    projectedBalanceMonth: incomeTenDay * 3 - salaryMonth - upkeepMonth,
    salaryArrearsCopper,
    upkeepArrearsCopper,
    totalArrearsCopper: salaryArrearsCopper + upkeepArrearsCopper,
    payrollForecastReady: payrollForecast.ready,
    payrollForecastBlockers: payrollForecast.blockers,
    payrollForecastFixedPeopleCount: payrollForecast.fixedPeopleCount,
    payrollForecastShareExcluded: payrollForecast.shareForecastExcluded,
    population: people.length,
    peopleRows: people.length,
    buildingsRows: buildings.length,
    specialRows: holding.special?.list?.length ?? 0,
    storageRows: holding.storage?.resources?.length ?? 0
  };
},

_financeSummary(holding, totalsArg = null, workerContext = null) {
  const totals = totalsArg ?? this._prepareTotals(holding, workerContext);
  const moneyBuildings = (holding?.buildings?.list ?? [])
    .filter((building) => this._buildingStatus(building).value === "built" && this._buildingFunctions(building)?.income)
    .map((building) => ({ building, income: 0 }));

  const treasury = this._moneyContext(holding);
  const resources = Array.isArray(holding?.storage?.resources) ? holding.storage.resources : [];
  const items = Array.isArray(holding?.storage?.items) ? holding.storage.items : [];
  let saleStockCopper = 0;
  let saleResourceLots = 0;
  let saleItemLots = 0;
  for (const row of resources) {
    if (!row?.forSale) continue;
    if (!this._resourceTradeReady(row)) continue;
    const qty = Math.max(0, this._safeNumber(row.qty, row.quantity ?? 0));
    const price = Math.max(0, this._resourcePriceCopper(row));
    if (qty > 0 && price > 0) {
      saleResourceLots += 1;
      saleStockCopper += qty * price;
    }
  }
  for (const row of items) {
    if (!row?.forSale) continue;
    const qty = Math.max(0, this._safeNumber(row.qty, row.quantity ?? 1));
    const price = Math.max(0, this._itemPriceCopper(row));
    if (qty > 0 && price > 0) {
      saleItemLots += 1;
      saleStockCopper += qty * price;
    }
  }

  const salaryMonthCopper = totals.salaryMonth;
  const upkeepMonthCopper = totals.upkeepMonth;
  const incomeMonthCopper = totals.incomeTenDay * 3;
  const monthlyNetCopper = incomeMonthCopper - salaryMonthCopper - upkeepMonthCopper;
  const dailyBurn = (salaryMonthCopper + upkeepMonthCopper - incomeMonthCopper) / 30;
  const totalArrearsCopper = Math.max(0, this._safeNumber(totals.totalArrearsCopper, 0));
  const availableAfterDebt = Math.max(0, treasury.totalCopper - totalArrearsCopper);
  const runwayDays = dailyBurn > 0
    ? Math.floor(availableAfterDebt / dailyBurn)
    : (totalArrearsCopper > treasury.totalCopper ? 0 : Infinity);
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead);
  const laborState = holding?.gm?.economy?.labor ?? {};
  const wageIndex = normalizeWageIndex(laborState.wageIndex);
  const payrollState = normalizePayrollState(laborState.payroll);
  const peopleById = new Map((holding?.people?.list ?? []).map((person) => [String(person?.id ?? ""), person]));
  const payrollArrearsRows = Object.values(payrollState.accounts)
    .filter((account) => account.arrearsCopper > 0)
    .map((account) => ({
      personId: account.personId,
      name: peopleById.get(account.personId)?.name || `Житель ${account.personId}`,
      arrearsCopper: account.arrearsCopper,
      arrearsText: this._formatCopperCurrency(account.arrearsCopper),
      overdueTendays: account.overdueTendays
    }))
    .sort((left, right) => right.arrearsCopper - left.arrearsCopper || left.name.localeCompare(right.name, "ru"));
  const payrollArrearsCopper = payrollArrearsRows.reduce((sum, row) => sum + row.arrearsCopper, 0);
  const payrollDebtorCount = payrollArrearsRows.length;
  const paidPeopleCount = Math.max(0, Math.floor(this._safeNumber(totals.payrollForecastFixedPeopleCount, 0)));
  const sharePeopleCount = people.filter((person) => String(person?.compensationType ?? "") === "share" && personShareRate(person) > 0).length;
  const compensatedPeopleCount = Math.min(people.length, paidPeopleCount + sharePeopleCount);
  const unpaidPeopleCount = Math.max(0, people.length - compensatedPeopleCount);
  const boardPeopleCount = people.filter((person) => personBoardFoodDaily(person) > 0).length;
  const housingProvidedCount = people.filter((person) => person?.housingProvided).length;
  const compensationCounts = Object.entries(people.reduce((counts, person) => {
    const type = String(person?.compensationType ?? "dependent");
    counts[type] = (counts[type] ?? 0) + 1;
    return counts;
  }, {})).map(([type, count]) => ({ type, label: compensationTypeLabel(type), count }));
  const ledgerRows = [
    { label: "Фиксированные ставки Economy V2", amount: -Math.max(0, this._safeNumber(totals.cashWageTenDay, 0)) * 3, class: "expense" },
    { label: "Эксплуатация зданий", amount: -Math.max(0, this._safeNumber(totals.upkeepOperatingMonth, upkeepMonthCopper)), class: "expense" },
    { label: "Ремонтный резерв", amount: -Math.max(0, this._safeNumber(totals.repairReserveMonth, 0)), class: "expense" },
    { label: "Долг по зарплате", amount: -Math.max(0, this._safeNumber(totals.salaryArrearsCopper, 0)), class: "expense" },
    { label: "Долг по содержанию", amount: -Math.max(0, this._safeNumber(totals.upkeepArrearsCopper, 0)), class: "expense" },
    { label: "Прогноз обязательств", amount: monthlyNetCopper, class: monthlyNetCopper >= 0 ? "income" : "expense" }
  ].filter((row) => row.amount !== 0).map((row) => ({ ...row, text: `${row.amount > 0 ? "+" : row.amount < 0 ? "−" : ""}${this._formatCopperCurrency(Math.abs(row.amount))}` }));

  return {
    ...totals,
    salaryText: this._formatCopperCurrency(totals.salary),
    cashWageDailyText: this._formatCopperCurrency(totals.cashWageDaily),
    cashWageTenDayText: this._formatCopperCurrency(totals.cashWageTenDay),
    sharePayoutTenDayText: this._formatCopperCurrency(totals.sharePayoutTenDay),
    salaryTenDayText: this._formatCopperCurrency(totals.salaryTenDay),
    salaryMonthText: this._formatCopperCurrency(salaryMonthCopper),
    upkeepOperatingMonthText: this._formatCopperCurrency(totals.upkeepOperatingMonth),
    repairReserveMonthText: this._formatCopperCurrency(totals.repairReserveMonth),
    upkeepTenDayText: this._formatCopperCurrency(totals.upkeepTenDay),
    upkeepMonthText: this._formatCopperCurrency(upkeepMonthCopper),
    salaryArrearsText: this._formatCopperCurrency(totals.salaryArrearsCopper),
    upkeepArrearsText: this._formatCopperCurrency(totals.upkeepArrearsCopper),
    totalArrearsText: this._formatCopperCurrency(totalArrearsCopper),
    hasArrears: totalArrearsCopper > 0,
    incomeTenDayText: this._formatCopperCurrency(totals.incomeTenDay),
    incomeMonthText: this._formatCopperCurrency(incomeMonthCopper),
    monthlyNetCopper,
    monthlyNetText: `${monthlyNetCopper > 0 ? "+" : monthlyNetCopper < 0 ? "−" : ""}${this._formatCopperCurrency(Math.abs(monthlyNetCopper))}`,
    monthlyNetClass: monthlyNetCopper > 0 ? "positive" : (monthlyNetCopper < 0 ? "negative" : "neutral"),
    treasuryText: treasury.text,
    runwayDays: Number.isFinite(runwayDays) ? runwayDays : null,
    runwayText: Number.isFinite(runwayDays) ? `${runwayDays} дн.` : "∞",
    saleStockCopper,
    saleStockText: this._formatCopperCurrency(saleStockCopper),
    saleResourceLots,
    saleItemLots,
    paidPeopleCount,
    compensatedPeopleCount,
    unpaidPeopleCount,
    payrollDebtorCount,
    sharePeopleCount,
    boardPeopleCount,
    housingProvidedCount,
    wageIndex,
    wageIndexText: this._formatNumber?.(wageIndex) ?? String(wageIndex),
    hasPayrollForecastBlockers: !totals.payrollForecastReady && (totals.payrollForecastBlockers?.length ?? 0) > 0,
    wageTariffRows: WAGE_CATALOG.map((row) => ({
      id: row.id,
      label: row.label,
      copper: wageCopperPerTenday(row.id, { wageIndex }),
      text: this._formatCopperCurrency(wageCopperPerTenday(row.id, { wageIndex }))
    })),
    payrollArrearsCopper,
    payrollArrearsText: this._formatCopperCurrency(payrollArrearsCopper),
    payrollArrearsRows,
    hasPayrollArrearsRows: payrollArrearsRows.length > 0,
    boardFoodDailyText: this._formatNumber(totals.boardFoodDaily),
    boardFoodTenDayText: this._formatNumber(totals.boardFoodTenDay),
    compensationCounts,
    tradeBuildingCount: moneyBuildings.length,
    ledgerRows,
    hasLedgerRows: ledgerRows.length > 0,
    moneyBuildings: moneyBuildings.map(({ building, income }) => ({ name: building.name || "Без названия", income })),
    productionPreview: []
  };
},

_normalizeStorageRoomId(value = "outdoors") {
  const id = String(value ?? "").trim();
  return id || "outdoors";
},

_moneyCopper(holding) {
  if (!holding?.storage) return 0;
  return Math.max(0, Math.floor(this._safeNumber(holding.storage.moneyCopper ?? 0, 0)));
},

_setMoneyCopper(holding, value = 0) {
  if (!holding.storage) holding.storage = { notes: "", resources: [], moneyCopper: 0, log: [] };
  holding.storage.moneyCopper = Math.max(0, Math.floor(this._safeNumber(value, 0)));
  return holding.storage.moneyCopper;
},

_addMoney(holding, amount = 0) {
  const delta = Math.floor(this._safeNumber(amount, 0));
  if (!delta) return this._moneyCopper(holding);
  return this._setMoneyCopper(holding, this._moneyCopper(holding) + delta);
},

_moneyContext(holding) {
  const totalCopper = this._moneyCopper(holding);
  const gold = Math.floor(totalCopper / 100);
  const silver = Math.floor((totalCopper % 100) / 10);
  const copper = totalCopper % 10;
  return {
    totalCopper,
    gold,
    silver,
    copper,
    text: `${gold} ЗМ · ${silver} СМ · ${copper} ММ`,
    compactText: `${gold}/${silver}/${copper}`
  };
},

_formatCopperCurrency(value = 0) {
  return formatCopperCurrency(this._safeNumber(value, 0));
},

_parseCurrencyCost(value = "") {
  return parseCopperCurrency(value);
},

_resourceDefinition(row = {}) {
  return resourceDef(row.resourceId, row.id, row.name, row.label);
},

_resourceTradeReady(row = {}) {
  return resourceTradeReady(this._resourceDefinition(row));
},

_resourcePriceCopper(row = {}) {
  const referencePrice = Number(this._resourceDefinition(row)?.referencePriceCopper);
  return Number.isFinite(referencePrice) && referencePrice > 0 ? Math.floor(referencePrice) : 0;
},

_itemPriceCopper(row = {}) {
  return this._parseCurrencyCost(row.cost ?? row.itemData?.system?.cost ?? row.system?.cost ?? "");
}
};
