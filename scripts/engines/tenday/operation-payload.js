import { economyLedgerTotals, normalizeEconomyLedger } from "../economy/ledger.js";

function copyValue(value) {
  if (value === undefined) return undefined;
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function compactTendayRows(rows = [], limit = 80) {
  const list = Array.isArray(rows) ? rows : [];
  const safeLimit = Math.max(0, Math.floor(Number(limit) || 0));
  return {
    rows: copyValue(list.slice(0, safeLimit)),
    total: list.length,
    truncated: list.length > safeLimit
  };
}

function compactRows(value = null) {
  if (Array.isArray(value)) return copyValue(value);
  return copyValue(Array.isArray(value?.rows) ? value.rows : []);
}

export function hydrateTendayOperation(operation = {}, { holdingId = "", holdingName = "" } = {}) {
  const payload = operation?.payload && typeof operation.payload === "object" ? operation.payload : null;
  if (!payload || !Number.isFinite(Number(payload.schema)) || Number(payload.schema) < 1) return null;
  const economy = payload.economy ?? {};
  const changes = payload.changes ?? {};
  const clock = copyValue(payload.clock ?? null);
  return {
    ok: true,
    historical: true,
    operationId: String(operation?.operationId ?? operation?.id ?? ""),
    holdingId: String(holdingId ?? ""),
    holdingName: String(payload.holdingName ?? holdingName ?? "Владение"),
    qd: Number(payload.qd) || 40,
    periodLabel: String(payload.periodLabel ?? economy.periodLabel ?? "десятник"),
    preparedAt: String(operation?.createdAt ?? ""),
    clock,
    warnings: copyValue(payload.warnings ?? []),
    readiness: { alerts: [] },
    report: {
      periodQd: Number(payload.qd) || 40,
      periodLabel: String(payload.periodLabel ?? economy.periodLabel ?? "десятник"),
      produced: compactRows(economy.produced),
      consumed: compactRows(economy.consumed),
      income: compactRows(economy.income),
      work: compactRows(economy.work),
      skipped: compactRows(economy.skipped),
      formulas: compactRows(economy.formulas),
      ledger: compactRows(economy.ledger),
      ledgerTotals: copyValue(economy.ledgerTotals ?? {}),
      ledgerCount: Number(economy.ledger?.total ?? economy.ledger?.rows?.length ?? 0),
      ledgerTruncated: Boolean(economy.ledger?.truncated),
      food: copyValue(economy.food ?? {}),
      construction: copyValue(economy.construction ?? {}),
      trade: copyValue(economy.trade ?? {}),
      treasury: copyValue(economy.treasury ?? {}),
      finance: copyValue(economy.finance ?? {}),
      morale: copyValue(economy.morale ?? null),
      market: copyValue(economy.market ?? null),
      politics: copyValue(economy.politics ?? null)
    },
    changeSet: {
      totals: copyValue(payload.metrics ?? {}),
      clock,
      money: copyValue(payload.money ?? null),
      food: copyValue(payload.food ?? null),
      date: copyValue(payload.date ?? null),
      resources: compactRows(changes.resources),
      items: compactRows(changes.items),
      buildings: compactRows(changes.buildings),
      residents: compactRows(changes.residents),
      development: compactRows(changes.development),
      modifiers: compactRows(changes.modifiers),
      shipments: compactRows(changes.shipments),
      ships: compactRows(changes.ships),
      politics: compactRows(changes.politics)
    },
    events: { periods: Math.max(1, Math.floor((Number(payload.qd) || 40) / 40)), entries: [], events: compactRows(payload.events) },
    dueEvents: compactRows(payload.dueEvents)
  };
}

export function buildTendayOperationPayload(prepared = {}) {
  const report = prepared?.report ?? {};
  const ledger = normalizeEconomyLedger(report?.ledger ?? [], { limit: 600 });
  const changeSet = prepared?.changeSet ?? {};
  const changes = {};
  for (const key of ["resources", "items", "buildings", "residents", "development", "modifiers", "shipments", "ships", "politics"]) {
    changes[key] = compactTendayRows(changeSet?.[key]);
  }
  return {
    schema: 3,
    holdingName: String(prepared?.holdingName ?? ""),
    periodLabel: String(prepared?.periodLabel ?? report?.periodLabel ?? "десятник"),
    qd: Number(prepared?.qd) || 40,
    clock: copyValue(prepared?.clock ?? {}),
    warnings: copyValue(prepared?.warnings ?? []),
    metrics: copyValue(changeSet?.totals ?? {}),
    money: copyValue(changeSet?.money ?? {}),
    food: copyValue(changeSet?.food ?? {}),
    date: copyValue(changeSet?.date ?? null),
    changes,
    economy: {
      periodLabel: String(report?.periodLabel ?? "десятник"),
      produced: compactTendayRows(report?.produced, 60),
      consumed: compactTendayRows(report?.consumed, 60),
      income: compactTendayRows(report?.income, 40),
      work: compactTendayRows(report?.work, 40),
      skipped: compactTendayRows(report?.skipped, 40),
      formulas: compactTendayRows(report?.formulas, 40),
      food: copyValue(report?.food ?? {}),
      construction: copyValue(report?.construction ?? {}),
      trade: copyValue(report?.trade ?? {}),
      treasury: copyValue(report?.treasury ?? {}),
      finance: copyValue(report?.finance ?? {}),
      morale: copyValue(report?.morale ?? null),
      market: copyValue(report?.market ?? null),
      politics: copyValue(report?.politics ?? null),
      ledger: { ...compactTendayRows(ledger, 300), total: report?.ledgerCount ?? ledger.length,
        truncated: Boolean(report?.ledgerTruncated || (report?.ledgerCount ?? ledger.length) > 300) },
      ledgerTotals: copyValue(report?.ledgerTotals ?? economyLedgerTotals(ledger))
    },
    events: compactTendayRows(prepared?.events?.events, 40),
    dueEvents: compactTendayRows(prepared?.dueEvents, 40)
  };
}
