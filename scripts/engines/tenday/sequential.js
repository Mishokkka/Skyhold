import { clone } from "../../data/utils.js";
import { economyLedgerTotals } from "../economy/ledger.js";
import { summarizeEconomyReport } from "../economy/report.js";

const ARRAYS = ["produced", "consumed", "skipped", "income", "formulas", "work", "ledger"];
const SUMS = { food: ["needed", "eaten", "hungryResidentDays", "expiredQty"], construction: ["attempts", "completed"],
  trade: ["buyers", "sold", "revenue"], treasury: ["spent"],
  politics: ["influenceGained"], marketStockRecovery: ["recoveredQty"], marketDemandRecovery: ["recoveredQty"],
  finance: ["planned", "paidCopper", "personnelOfficeCashbackCopper", "personnelOfficeCashbackBaseCopper", "personnelOfficeCostCopper", "personnelOfficeNetSavingCopper"],
  agriculture: ["producedQty", "expiredQty", "workQdUsed"],
  maintenance: ["availablePoints", "allocatedPoints", "unusedPoints", "allocatedTechnicalQd"],
  livestock: ["born", "matured", "feedConsumed", "eggs", "milk", "wool", "meat", "tallow", "workQdUsed"] };

/** Flow totals accumulate; final snapshots remain those of the final period. */
export function combineTendayReports(periods, dependencies = {}) {
  const reports = periods.map((period) => period.report);
  const combined = clone(reports.at(-1));
  for (const key of ARRAYS) combined[key] = reports.flatMap((report) => report[key] ?? []);
  combined.work = reports.flatMap((report, index) => (report.work ?? []).map((row) => `Десятник ${index + 1}: ${row}`));
  for (const [domain, keys] of Object.entries(SUMS)) {
    if (!reports.some((report) => report[domain])) continue;
    combined[domain] ??= {};
    for (const key of keys) combined[domain][key] = reports.reduce((sum, report) => sum + (Number(report[domain]?.[key]) || 0), 0);
    for (const key of ["lines", "purchases", "charges", "unpaidDirectiveIds", "expiredDecreeIds", "payments", "planningSkipped", "upkeepSkipped", "issues", "buildings", "warnings", "recovered"]) {
      if (reports.some((report) => Array.isArray(report[domain]?.[key]))) combined[domain][key] = reports.flatMap((report) => report[domain]?.[key] ?? []);
    }
  }
  // Deliveries and losses are flows; transit/decision queues describe the final boundary.
  for (const domain of ["market", "marketOutbound"]) {
    if (!reports.some((report) => report[domain])) continue;
    combined[domain] ??= {};
    combined[domain].advancedQd = periods.length * 40;
    for (const key of ["dispatched", "delivered", "delayed", "lost"]) {
      if (reports.some((report) => Array.isArray(report[domain]?.[key]))) {
        combined[domain][key] = reports.flatMap((report) => report[domain]?.[key] ?? []);
      }
    }
  }
  if (combined.politics) combined.politics.periods = periods.map((period) => ({ periodIndex: period.clock.beforePeriod + 1,
    effects: clone(period.report.politics?.effects), charges: clone(period.report.politics?.charges ?? []),
    influenceGained: period.report.politics?.influenceGained ?? 0, expiredDecreeIds: clone(period.report.politics?.expiredDecreeIds ?? []) }));
  combined.periodQd = periods.length * 40;
  combined.periodLabel = `${periods.length} десятника (${combined.periodQd} QD)`;
  combined.ledgerTotals = economyLedgerTotals([]);
  for (const report of reports) {
    const totals = report.ledgerTotals ?? economyLedgerTotals(report.ledger ?? []);
    for (const key of Object.keys(combined.ledgerTotals)) combined.ledgerTotals[key] += Number(totals[key]) || 0;
  }
  combined.ledgerCount = reports.reduce((sum, report) => sum + (report.ledgerCount ?? report.ledger?.length ?? 0), 0);
  combined.ledgerTruncated = combined.ledgerCount > combined.ledger.length;
  return { ...summarizeEconomyReport(combined, dependencies), ledgerTotals: combined.ledgerTotals };
}

/** Preparation only: every phase runs on a draft; the final Apply stays atomic. */
export async function prepareSequentialTendays(app, { holdingId, qd, data, rationUnitsPerResident, operationId, preparedAt }) {
  const count = qd / 40;
  const periods = [];
  let draftData = data;
  for (let index = 0; index < count; index++) {
    const prepared = await app._prepareTendayOperation({ holdingId, qd: 40, dataView: draftData,
      rationUnitsPerResident, operationId: `${operationId}-p${index + 1}`, preparedAt, pendingEventsCollected: true });
    if (!prepared.ok) return { ...prepared, message: `Десятник ${index + 1}/${count}: ${prepared.message}` };
    periods.push(prepared);
    draftData = { ...draftData, meta: { ...draftData.meta,
      ...(prepared.preparedSharedMarkets ? { sharedMarkets: prepared.preparedSharedMarkets } : {}) },
      holdings: draftData.holdings.map((holding) => String(holding.id) === String(holdingId) ? prepared.preparedHolding : holding) };
  }
  const first = periods[0];
  const last = periods.at(-1);
  const events = periods.flatMap((period, index) => (period.events?.events ?? []).map((event) => ({ ...event, period: index + 1 })));
  if (events.length > 40) return { ok: false, blocked: true,
    message: "В пакете больше 40 событий: разделите проведение на меньшие пакеты, чтобы сохранить все доступные решения. Подготовленные изменения не записаны." };
  const entries = periods.flatMap((period, index) => (period.events?.entries ?? []).map((entry) => ({ ...entry, index: index + 1 })));
  const effects = events.flatMap((event) => event.effects ?? []);
  const hasEffects = effects.some((effect) => Number(effect.amount) !== 0);
  if (last.preparedHolding.gm?.lastRoll?.kind === "tenday") Object.assign(last.preparedHolding.gm.lastRoll, {
    eventId: `tenday:${operationId}`, title: `События ${count} десятников`, events, effects,
    hasEffects, effectStatus: hasEffects ? "pending" : "none", eventCount: events.length,
    entry: events.map((event) => event.title).filter(Boolean).join("; "),
    result: periods.map((period, index) => `#${index + 1}: ${period.events?.lastRoll?.result ?? ""}`).join(" | ")
  });
  return { ...last, operationId, qd, preparedAt, sourceHash: first.sourceHash, dependencyHash: first.dependencyHash,
    report: combineTendayReports(periods, app._economyReportDependencies?.() ?? {}), recovery: { recovered: periods.reduce((sum, period) => sum + (period.recovery?.recovered || 0), 0) },
    periodLabel: `${count} десятника (${qd} QD)`, readiness: first.readiness,
    clock: { ...last.clock, before: first.clock.before, beforePeriod: first.clock.beforePeriod, delta: qd },
    events: { ...last.events, periods: count, events, entries, effects, hasEffects,
      title: `События ${count} десятников`, warnings: periods.flatMap((period) => period.events?.warnings ?? []) },
    warnings: periods.flatMap((period, index) => (period.warnings ?? []).map((warning) => ({ ...warning, text: `Десятник ${index + 1}: ${warning.text}` }))) };
}
