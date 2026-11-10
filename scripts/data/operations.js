import { makeId, toNumber } from "./utils.js";

const OPERATION_TYPES = new Set([
  "worker-assignment",
  "construction-attempt",
  "construction-cancellation",
  "event-effect",
  "event-schedule",
  "battle-aftermath",
  "tenday",
  "market-purchase",
  "market-outbound",
  "bank",
  "transport-v2",
  "ship-operation",
  "politics",
  "system",
  "content-import"
]);

export function normalizeHoldingOperation(row = {}) {
  const type = OPERATION_TYPES.has(String(row?.type ?? "")) ? String(row.type) : "system";
  const operationId = String(row?.operationId ?? row?.id ?? "").trim();
  const id = operationId || makeId("operation", 20);
  return {
    id,
    operationId: id,
    type,
    createdAt: String(row?.createdAt ?? row?.at ?? ""),
    title: String(row?.title ?? "").slice(0, 300),
    summary: String(row?.summary ?? row?.message ?? row?.text ?? "").slice(0, 2000),
    assigned: Math.max(0, Math.floor(toNumber(row?.assigned, 0))),
    cleared: Math.max(0, Math.floor(toNumber(row?.cleared, 0))),
    payload: row?.payload && typeof row.payload === "object" ? { ...row.payload } : {}
  };
}

export function normalizeHoldingOperationLog(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row === "object")
    .map((row) => normalizeHoldingOperation(row))
    .slice(-250);
}

export function findHoldingOperation(holding, operationId) {
  const id = String(operationId ?? "");
  return (holding?.log ?? []).find((row) => String(row?.operationId ?? row?.id ?? "") === id) ?? null;
}

export function appendHoldingOperation(holding, entry = {}) {
  if (!holding || typeof holding !== "object") return null;
  if (!Array.isArray(holding.log)) holding.log = [];
  const normalized = normalizeHoldingOperation(entry);
  const existing = findHoldingOperation(holding, normalized.operationId);
  if (existing) return existing;
  holding.log.push(normalized);
  holding.log = holding.log.slice(-250);
  return normalized;
}

export function isKnownHoldingOperationType(value) {
  return OPERATION_TYPES.has(String(value ?? ""));
}
