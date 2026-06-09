// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { escapeHtml, rollD6Pool } from "../../../core/helpers.js";
import {
  isMoneyResource,
  normalizeResourceId,
  resourceDef,
  resourceIcon,
  resourceImage,
  resourceItemUuid,
  resourceLabel,
  resourceOptions,
  resourceUnit
} from "../../../core/resources.js";

export const FinanceTreasuryDomain = {
_prepareTotals(holding) {
  if (!holding) return { salary: 0, salaryTenDay: 0, salaryMonth: 0, upkeepMonth: 0, incomeTenDay: 0, projectedBalanceMonth: 0, population: 0, peopleRows: 0, buildingsRows: 0, specialRows: 0, storageRows: 0 };

  const people = (holding.people?.list ?? []).filter((person) => !person?.dead);
  const buildings = holding.buildings?.list ?? [];
  const salary = people.reduce((sum, row) => sum + this._safeNumber(row.salary, 0), 0);
  const upkeepMonth = buildings.reduce((sum, building) => {
    if (this._buildingStatus(building).value !== "built") return sum;
    return sum + this._safeNumber(building.upkeep, 0);
  }, 0);
  const incomeTenDay = buildings.reduce((sum, building) => sum + this._buildingMoneyIncome(building), 0);

  return {
    salary,
    salaryTenDay: salary * 10,
    salaryMonth: salary * 30,
    upkeepMonth,
    incomeTenDay,
    projectedBalanceMonth: incomeTenDay * 3 - salary * 30 - upkeepMonth,
    population: people.length,
    peopleRows: people.length,
    buildingsRows: buildings.length,
    specialRows: holding.special?.list?.length ?? 0,
    storageRows: holding.storage?.resources?.length ?? 0
  };
},

_financeSummary(holding) {
  const totals = this._prepareTotals(holding);
  const moneyBuildings = (holding?.buildings?.list ?? [])
    .map((building) => ({ building, income: this._buildingMoneyIncome(building) }))
    .filter((item) => item.income);

  const treasury = this._moneyContext(holding);
  const resources = Array.isArray(holding?.storage?.resources) ? holding.storage.resources : [];
  const items = Array.isArray(holding?.storage?.items) ? holding.storage.items : [];
  let saleStockCopper = 0;
  let saleResourceLots = 0;
  let saleItemLots = 0;
  for (const row of resources) {
    if (!row?.forSale) continue;
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
  const runwayDays = dailyBurn > 0 ? Math.floor(treasury.totalCopper / dailyBurn) : Infinity;
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead);
  const paidPeopleCount = people.filter((person) => this._safeNumber(person?.salary, 0) > 0).length;
  const unpaidPeopleCount = Math.max(0, people.length - paidPeopleCount);
  const ledgerRows = [
    { label: "Зарплата", amount: -salaryMonthCopper, class: "expense" },
    { label: "Содержание зданий", amount: -upkeepMonthCopper, class: "expense" },
    { label: "Пассивный доход", amount: incomeMonthCopper, class: "income" },
    { label: "Итоговый прогноз", amount: monthlyNetCopper, class: monthlyNetCopper >= 0 ? "income" : "expense" }
  ].filter((row) => row.amount !== 0).map((row) => ({ ...row, text: `${row.amount > 0 ? "+" : row.amount < 0 ? "−" : ""}${this._formatCopperCurrency(Math.abs(row.amount))}` }));

  return {
    ...totals,
    salaryText: this._formatCopperCurrency(totals.salary),
    salaryTenDayText: this._formatCopperCurrency(totals.salaryTenDay),
    salaryMonthText: this._formatCopperCurrency(salaryMonthCopper),
    upkeepMonthText: this._formatCopperCurrency(upkeepMonthCopper),
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
    unpaidPeopleCount,
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
  const total = Math.max(0, Math.floor(this._safeNumber(value, 0)));
  const gold = Math.floor(total / 100);
  const silver = Math.floor((total % 100) / 10);
  const copper = total % 10;
  const parts = [];
  if (gold) parts.push(`${gold} ЗМ`);
  if (silver) parts.push(`${silver} СМ`);
  if (copper || !parts.length) parts.push(`${copper} ММ`);
  return parts.join(" ");
},

_parseCurrencyCost(value = "") {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  const text = String(value ?? "").trim();
  if (!text) return 0;
  let total = 0;
  let matched = false;
  const rx = /([-+]?\d+(?:[.,]\d+)?)\s*([a-zA-Zа-яА-Я]+)?/g;
  for (const match of text.matchAll(rx)) {
    const amount = Number(String(match[1]).replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const unit = String(match[2] ?? "C").trim().toLowerCase();
    let multiplier = 1;
    if (["g", "gp", "gold", "з", "зм"].includes(unit)) multiplier = 100;
    else if (["s", "sp", "silver", "с", "см"].includes(unit)) multiplier = 10;
    else if (["c", "cp", "copper", "м", "мм"].includes(unit)) multiplier = 1;
    total += amount * multiplier;
    matched = true;
  }
  if (!matched) {
    const fallback = Number(text.replace(",", ".").replace(/[^0-9.+-]/g, ""));
    return Number.isFinite(fallback) ? Math.max(0, Math.floor(fallback)) : 0;
  }
  return Math.max(0, Math.floor(total));
},

_resourcePriceCopper(row = {}) {
  const id = normalizeResourceId(row.resourceId, row.name);
  const def = id !== "custom" ? resourceDef(id) : null;
  return this._parseCurrencyCost(row.cost ?? def?.cost ?? row.itemData?.system?.cost ?? "");
},

_itemPriceCopper(row = {}) {
  return this._parseCurrencyCost(row.cost ?? row.itemData?.system?.cost ?? row.system?.cost ?? "");
},

_tradeStorageRoomOptions(holding, selected = "all") {
  const current = String(selected ?? "all").trim() || "all";
  const options = [{ value: "all", label: "Все склады", selected: current === "all" }];
  for (const room of this._storageRooms(holding, { includeUnavailable: true })) {
    if (!room.available && room.source !== "base") continue;
    options.push({ value: room.id, label: room.label, selected: room.id === current });
  }
  if (current !== "all" && !options.some((option) => option.value === current)) options.push({ value: current, label: `${current} (нет в списке)`, selected: true });
  return options;
},

_tradeKindOptions(selected = "all") {
  const current = ["all", "resources", "items"].includes(String(selected ?? "all")) ? String(selected ?? "all") : "all";
  return [
    { value: "all", label: "Все", selected: current === "all" },
    { value: "resources", label: "Ресурсы", selected: current === "resources" },
    { value: "items", label: "Предметы", selected: current === "items" }
  ];
}
};
