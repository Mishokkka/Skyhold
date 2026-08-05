const LEDGER_DOMAINS = new Set([
  "production",
  "food",
  "income",
  "trade",
  "payroll",
  "treasury",
  "construction",
  "market",
  "residents",
  "events",
  "system"
]);

const LEDGER_KINDS = new Set(["resource", "item", "money", "progress", "shipment", "ration-buffer", "notice"]);

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function shortText(value, limit = 500) {
  return String(value ?? "").trim().slice(0, limit);
}

function serializableMeta(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function normalizeEconomyLedgerEntry(row = {}, index = 0) {
  const domain = LEDGER_DOMAINS.has(String(row?.domain ?? "")) ? String(row.domain) : "system";
  let kind = LEDGER_KINDS.has(String(row?.kind ?? "")) ? String(row.kind) : "resource";
  const resourceId = shortText(row?.resourceId, 160);
  if (resourceId === "money") kind = "money";
  const qty = finiteNumber(row?.qty, 0);
  return {
    id: shortText(row?.id, 200) || `ledger-${index + 1}`,
    domain,
    kind,
    resourceId: kind === "money" ? "money" : resourceId,
    itemId: shortText(row?.itemId ?? row?.itemUuid, 240),
    name: shortText(row?.name, 300) || (kind === "money" ? "Деньги" : kind === "shipment" ? "Поставка" : "Операция"),
    qty,
    unit: shortText(row?.unit, 80) || (kind === "money" ? "ММ" : "ед."),
    roomId: shortText(row?.roomId ?? row?.storageRoomId, 160),
    sourceId: shortText(row?.sourceId, 200),
    source: shortText(row?.source, 300),
    targetId: shortText(row?.targetId, 200),
    target: shortText(row?.target, 300),
    status: shortText(row?.status, 120),
    note: shortText(row?.note, 1000),
    operationId: shortText(row?.operationId, 240),
    meta: serializableMeta(row?.meta)
  };
}

export function normalizeEconomyLedger(rows = [], { limit = 600 } = {}) {
  const safeLimit = Math.max(0, Math.floor(finiteNumber(limit, 600)));
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row === "object")
    .slice(0, safeLimit)
    .map((row, index) => normalizeEconomyLedgerEntry(row, index));
}

export function appendEconomyLedger(report, rows = []) {
  if (!report || typeof report !== "object") return [];
  if (!Array.isArray(report.ledger)) report.ledger = [];
  const source = Array.isArray(rows) ? rows : [rows];
  const appended = [];
  for (const row of source) {
    if (!row || typeof row !== "object") continue;
    const normalized = normalizeEconomyLedgerEntry(row, report.ledger.length);
    if (["resource", "item", "money", "ration-buffer"].includes(normalized.kind) && Math.abs(normalized.qty) < 0.0001) continue;
    report.ledger.push(normalized);
    appended.push(normalized);
  }
  if (report.ledger.length > 600) report.ledger = report.ledger.slice(-600);
  return appended;
}

function storageKind(entry) {
  if (entry?.meta?.storageKind) return shortText(entry.meta.storageKind, 120);
  if (entry.domain === "production") return entry.qty >= 0 ? "production" : "expense";
  if (entry.domain === "food") return "food";
  if (entry.domain === "income") return "income";
  if (entry.domain === "trade") return entry.kind === "money" ? "income" : "trade-sale";
  if (entry.domain === "payroll") return "expense";
  if (entry.domain === "treasury") return "expense";
  if (entry.domain === "market") return entry.qty >= 0 ? "market-arrival" : "market-purchase";
  return entry.qty >= 0 ? "income" : "expense";
}

export function economyLedgerStorageRows(rows = [], { operationId = "", period = "" } = {}) {
  return normalizeEconomyLedger(rows)
    .filter((entry) => ["resource", "item", "money"].includes(entry.kind))
    .filter((entry) => Math.abs(entry.qty) >= 0.0001)
    .filter((entry) => !entry.meta?.alreadyLogged)
    .map((entry) => ({
      kind: storageKind(entry),
      resourceId: entry.kind === "item" ? "custom" : entry.resourceId,
      name: entry.name,
      qty: entry.qty,
      roomId: entry.roomId,
      source: entry.source || entry.domain,
      note: entry.note,
      period: String(period ?? ""),
      operationId: entry.operationId || String(operationId ?? "")
    }));
}

export function economyLedgerTotals(rows = []) {
  const totals = { resourcesIn: 0, resourcesOut: 0, itemsIn: 0, itemsOut: 0, moneyIn: 0, moneyOut: 0, decisions: 0 };
  for (const entry of normalizeEconomyLedger(rows)) {
    if (entry.kind === "money") entry.qty >= 0 ? totals.moneyIn += entry.qty : totals.moneyOut += Math.abs(entry.qty);
    else if (entry.kind === "resource") entry.qty >= 0 ? totals.resourcesIn += entry.qty : totals.resourcesOut += Math.abs(entry.qty);
    else if (entry.kind === "item") entry.qty >= 0 ? totals.itemsIn += entry.qty : totals.itemsOut += Math.abs(entry.qty);
    if (entry.kind === "notice" && entry.status === "pending") totals.decisions += 1;
  }
  return totals;
}
