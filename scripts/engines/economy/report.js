function defaultSafeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function defaultFormatNumber(value = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  if (Number.isInteger(numeric)) return String(numeric);
  return String(Number(numeric.toFixed(2)));
}

function defaultFormatCopperCurrency(value = 0) {
  const total = Math.max(0, Math.floor(defaultSafeNumber(value, 0)));
  const gold = Math.floor(total / 100);
  const silver = Math.floor((total % 100) / 10);
  const copper = total % 10;
  const parts = [];
  if (gold) parts.push(`${gold} ЗМ`);
  if (silver) parts.push(`${silver} СМ`);
  if (copper || !parts.length) parts.push(`${copper} ММ`);
  return parts.join(" ");
}

function defaultNormalizeLedger(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row === "object")
    .slice(0, 600)
    .map((row) => ({ ...row, meta: row.meta && typeof row.meta === "object" ? { ...row.meta } : {} }));
}

function defaultLedgerTotals(rows = []) {
  const totals = { resourcesIn: 0, resourcesOut: 0, itemsIn: 0, itemsOut: 0, moneyIn: 0, moneyOut: 0, decisions: 0 };
  for (const row of rows) {
    const qty = defaultSafeNumber(row?.qty, 0);
    if (row?.kind === "money") qty >= 0 ? totals.moneyIn += qty : totals.moneyOut += Math.abs(qty);
    else if (row?.kind === "resource") qty >= 0 ? totals.resourcesIn += qty : totals.resourcesOut += Math.abs(qty);
    else if (row?.kind === "item") qty >= 0 ? totals.itemsIn += qty : totals.itemsOut += Math.abs(qty);
    if (row?.kind === "notice" && row?.status === "pending") totals.decisions += 1;
  }
  return totals;
}

function reportDependencies(options = {}) {
  return {
    safeNumber: typeof options.safeNumber === "function" ? options.safeNumber : defaultSafeNumber,
    formatNumber: typeof options.formatNumber === "function" ? options.formatNumber : defaultFormatNumber,
    formatCopperCurrency: typeof options.formatCopperCurrency === "function" ? options.formatCopperCurrency : defaultFormatCopperCurrency,
    normalizeLedger: typeof options.normalizeLedger === "function" ? options.normalizeLedger : defaultNormalizeLedger,
    ledgerTotals: typeof options.ledgerTotals === "function" ? options.ledgerTotals : defaultLedgerTotals
  };
}

export function summarizeSkippedLines(items = []) {
  const counts = new Map();
  for (const item of items) {
    const key = String(item ?? "");
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([text, count]) => count > 1 ? `${text} ×${count}` : text);
}

export function summarizeSignedLines(items = [], sign = "+", options = {}) {
  const { formatNumber } = reportDependencies(options);
  const map = new Map();
  const passthrough = [];
  const signPattern = sign === "+" ? "\\+" : "-";
  const rx = new RegExp(`^(.+?):\\s*(.+?)\\s*${signPattern}\\s*([0-9]+(?:[.,][0-9]+)?)(.*)$`);
  for (const item of items) {
    const text = String(item ?? "");
    const match = text.match(rx);
    if (!match) {
      passthrough.push(text);
      continue;
    }
    const building = match[1].trim();
    const resource = match[2].trim();
    const qty = Number(String(match[3]).replace(",", ".")) || 0;
    const suffix = String(match[4] ?? "").trim();
    const qdMatch = suffix.match(/\(([-+]?\d+(?:[.,]\d+)?)\s*QD(?:;\s*эфф\.\s*([-+]?\d+(?:[.,]\d+)?))?\)/i);
    const cleanSuffix = qdMatch ? suffix.replace(qdMatch[0], "").replace(/[.\s]+$/g, "").trim() : suffix.replace(/[.\s]+$/g, "").trim();
    const key = `${building}|${resource}|${cleanSuffix}`;
    const row = map.get(key) ?? { building, resource, qty: 0, qd: 0, effectiveQd: 0, hasEffectiveQd: false, suffix: cleanSuffix };
    row.qty += qty;
    if (qdMatch) row.qd += Number(String(qdMatch[1]).replace(",", ".")) || 0;
    if (qdMatch?.[2] !== undefined) {
      row.effectiveQd += Number(String(qdMatch[2]).replace(",", ".")) || 0;
      row.hasEffectiveQd = true;
    }
    map.set(key, row);
  }
  const result = [...map.values()].map((row) => {
    const qty = formatNumber(row.qty);
    let qd = "";
    if (row.qd) {
      const real = formatNumber(row.qd);
      const eff = row.hasEffectiveQd ? `; эфф. ${formatNumber(row.effectiveQd)}` : "";
      qd = ` (${real} QD${eff})`;
    }
    const suffix = row.suffix ? ` ${row.suffix}` : "";
    return `${row.building}: ${row.resource} ${sign}${qty}${qd}${suffix}.`;
  });
  return [...result, ...passthrough];
}

export function summarizeFoodReport(food = {}, options = {}) {
  const { safeNumber } = reportDependencies(options);
  const needed = Math.max(0, Math.floor(safeNumber(food.needed, 0)));
  const eaten = Math.max(0, Math.floor(safeNumber(food.eaten, 0)));
  const hungry = Math.max(0, Math.floor(safeNumber(food.hungryResidentDays, 0)));
  const lines = [];
  if (needed) lines.push(`Нужно пищи: ${needed}. Съедено: ${eaten}.`);
  for (const line of food.lines ?? []) if (line) lines.push(String(line));
  if (hungry && !lines.some((line) => /Голод/.test(line))) lines.push(`Голод: ${hungry} человеко-дней без пищи.`);
  return { needed, eaten, hungryResidentDays: hungry, lines, hasRows: lines.length > 0 };
}

export function summarizeConstructionReport(construction = {}) {
  const lines = summarizeSkippedLines(construction.lines ?? []);
  if (construction.completed) lines.push(`Завершено построек: ${construction.completed}.`);
  return { attempts: construction.attempts ?? 0, completed: construction.completed ?? 0, lines, hasRows: lines.length > 0 };
}

export function summarizeCapitalReport(capital = {}, options = {}) {
  const { safeNumber, formatCopperCurrency } = reportDependencies(options);
  const blocked = Math.max(0, Math.floor(safeNumber(capital.blocked, 0)));
  const shortfallCopper = Math.max(0, Math.floor(safeNumber(capital.shortfallCopper, 0)));
  const annualRenewalCopper = Math.max(0, Math.ceil(safeNumber(capital.annualRenewalCopper, 0)));
  const lines = (capital.lines ?? []).filter(Boolean).map(String);
  if (annualRenewalCopper > 0) lines.push(`Целевой резерв обновления оборудования: ${formatCopperCurrency(annualRenewalCopper)} за 240-дневный год; это ориентир, а не автоматическое списание.`);
  if (blocked > 0 && !lines.some((line) => /остановлена/.test(line))) lines.push(`Не обеспечено предприятий: ${blocked}; дефицит капитала ${formatCopperCurrency(shortfallCopper)}.`);
  return { blocked, shortfallCopper, annualRenewalCopper, lines, hasRows: lines.length > 0 };
}

export function summarizeTradeReport(trade = {}, options = {}) {
  const { safeNumber, formatNumber, formatCopperCurrency } = reportDependencies(options);
  const buyers = Math.max(0, Math.floor(safeNumber(trade.buyers, 0)));
  const revenue = Math.max(0, Math.floor(safeNumber(trade.revenue, 0)));
  const purchases = Array.isArray(trade.purchases) ? trade.purchases : [];
  const demand = Math.max(0, Math.floor(safeNumber(trade.demand, 0)));
  const capacity = Math.max(0, Math.floor(safeNumber(trade.capacity, 0)));
  const servedBuyers = Math.max(0, Math.floor(safeNumber(trade.servedBuyers, 0)));
  const unserved = Math.max(0, Math.floor(safeNumber(trade.unserved, 0)));
  const capacityShortfall = Math.max(0, Math.floor(safeNumber(trade.capacityShortfall, 0)));
  const stockShortfall = Math.max(0, Math.floor(safeNumber(trade.stockShortfall, 0)));
  const map = new Map();
  for (const row of purchases) {
    const name = String(row?.item ?? "Товар");
    const current = map.get(name) ?? { name, qty: 0, revenue: 0 };
    current.qty += Math.max(0, safeNumber(row?.qty, 0));
    current.revenue += Math.max(0, safeNumber(row?.revenue, 0));
    map.set(name, current);
  }
  const soldLines = [...map.values()]
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "ru"))
    .map((row) => `${row.name} ×${formatNumber(row.qty)} за ${formatCopperCurrency(row.revenue)}`);
  const lines = (trade.lines ?? []).filter(Boolean).map(String);
  if (buyers || revenue || soldLines.length) {
    if (demand) lines.push(`Спрос ${demand}, мощность ${capacity}, покупки совершили ${servedBuyers}, не обслужено ${unserved}.`);
    else lines.push(`Покупателей: ${buyers}.`);
    if (soldLines.length) lines.push(`Куплено: ${soldLines.join("; ")}.`);
    lines.push(`В казну: ${formatCopperCurrency(revenue)}.`);
  }
  return { buyers, revenue, demand, capacity, servedBuyers, unserved, capacityShortfall, stockShortfall, soldLines, lines, hasRows: lines.length > 0 };
}

export function summarizeServicesReport(services = {}, options = {}) {
  const { safeNumber, formatNumber, formatCopperCurrency } = reportDependencies(options);
  const demand = Math.max(0, Math.floor(safeNumber(services.demand, 0)));
  const capacity = Math.max(0, Math.floor(safeNumber(services.capacity, 0)));
  const served = Math.max(0, Math.floor(safeNumber(services.served, 0)));
  const unserved = Math.max(0, Math.floor(safeNumber(services.unserved, 0)));
  const foodPersonDays = Math.max(0, safeNumber(services.foodPersonDays, 0));
  const revenue = Math.max(0, Math.floor(safeNumber(services.revenue, 0)));
  const lines = (services.lines ?? []).filter(Boolean).map(String);
  if ((demand || capacity || served || revenue) && !lines.length) {
    lines.push(`Спрос ${demand}, мощность ${capacity}, обслужено ${served}, не обслужено ${unserved}.`);
    lines.push(`Пища ${formatNumber(foodPersonDays)} чел.-дн.; выручка ${formatCopperCurrency(revenue)}.`);
  }
  return { demand, capacity, served, unserved, foodPersonDays, revenue, lines, hasRows: lines.length > 0 };
}

export function summarizeTreasuryReport(treasury = {}, options = {}) {
  const { safeNumber, formatCopperCurrency } = reportDependencies(options);
  const spent = Math.max(0, Math.floor(safeNumber(treasury.spent, 0)));
  const deficit = Math.max(0, Math.floor(safeNumber(treasury.deficit, 0)));
  const lines = [];
  for (const line of treasury.lines ?? []) if (line) lines.push(String(line));
  if (spent || deficit) {
    lines.push(`Потрачено из казны: ${formatCopperCurrency(spent)}.`);
    if (deficit) lines.push(`Задолженность после расчёта: ${formatCopperCurrency(deficit)}.`);
  }
  return { spent, deficit, lines, hasRows: lines.length > 0 };
}

export function summarizeEconomyReport(report = {}, options = {}) {
  const dependencies = reportDependencies(options);
  const ledger = dependencies.normalizeLedger(report.ledger ?? []);
  return {
    ...report,
    ledger,
    ledgerTotals: dependencies.ledgerTotals(ledger),
    produced: summarizeSignedLines(report.produced ?? [], "+", options),
    consumed: summarizeSignedLines(report.consumed ?? [], "-", options),
    income: summarizeSignedLines(report.income ?? [], "+", options),
    foodSummary: summarizeFoodReport(report.food ?? {}, options),
    capitalSummary: summarizeCapitalReport(report.capital ?? {}, options),
    serviceSummary: summarizeServicesReport(report.services ?? {}, options),
    constructionSummary: summarizeConstructionReport(report.construction ?? {}),
    tradeSummary: summarizeTradeReport(report.trade ?? {}, options),
    treasurySummary: summarizeTreasuryReport(report.treasury ?? {}, options),
    skipped: summarizeSkippedLines(report.skipped ?? []),
    formulas: summarizeSkippedLines(report.formulas ?? [])
  };
}
