export const FINANCE_OBLIGATIONS_SCHEMA_VERSION = 1;
export const FINANCE_OBLIGATION_KINDS = Object.freeze([
  "loan-payment",
  "wage",
  "building-base-upkeep",
  "building-operating-upkeep",
  "other"
]);
export const FINANCE_OBLIGATION_STATUSES = Object.freeze(["due", "unpaid", "partial", "paid", "waived", "orphaned"]);

const STATUSES = new Set(FINANCE_OBLIGATION_STATUSES);

function cloneValue(value) {
  if (Array.isArray(value)) return value.map((entry) => cloneValue(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]));
}

function text(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function whole(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

function optionalWhole(value) {
  if (value === undefined || value === null || value === "") return null;
  return whole(value);
}

function stringList(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((entry) => text(entry))
    .filter(Boolean))];
}

function normalizePayment(value = {}) {
  return {
    operationId: text(value.operationId),
    amountCopper: whole(value.amountCopper),
    paidAt: text(value.paidAt)
  };
}

function normalizeOrphanHistory(value = {}) {
  const resolution = value?.resolution && typeof value.resolution === "object"
    ? {
        action: ["transfer", "waive"].includes(value.resolution.action) ? value.resolution.action : "",
        resolvedAt: text(value.resolution.resolvedAt),
        operationId: text(value.resolution.operationId),
        reason: text(value.resolution.reason),
        recipientKind: text(value.resolution.recipientKind),
        recipientId: text(value.resolution.recipientId),
        amountCopper: whole(value.resolution.amountCopper)
      }
    : null;
  return {
    orphanedAt: text(value.orphanedAt),
    operationId: text(value.operationId),
    reason: text(value.reason, "recipient-missing"),
    previousStatus: STATUSES.has(value.previousStatus) ? value.previousStatus : "due",
    resolution
  };
}

function statusFor(obligation) {
  if (obligation.orphaned && !obligation.orphanResolvedAt && obligation.outstandingCopper > 0) return "orphaned";
  if (obligation.outstandingCopper <= 0) return obligation.waivedCopper > 0 ? "waived" : "paid";
  if (obligation.paidCopper > 0 || obligation.waivedCopper > 0) return "partial";
  return obligation.status === "unpaid" ? "unpaid" : "due";
}

export function createDefaultFinanceObligationsState() {
  return {
    schemaVersion: FINANCE_OBLIGATIONS_SCHEMA_VERSION,
    obligations: [],
    buildingStates: {},
    settlementRuns: []
  };
}

export function normalizeFinanceObligation(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const dueCopper = whole(source.dueCopper);
  const paidCopper = Math.min(dueCopper, whole(source.paidCopper));
  const waivedCopper = Math.min(dueCopper - paidCopper, whole(source.waivedCopper));
  const normalized = {
    ...cloneValue(source),
    id: text(source.id),
    kind: text(source.kind, "other"),
    recipientKind: text(source.recipientKind, "other"),
    recipientId: text(source.recipientId),
    sourceId: text(source.sourceId),
    functionId: text(source.functionId),
    periodKey: text(source.periodKey),
    periodIndex: whole(source.periodIndex),
    dueCopper,
    paidCopper,
    waivedCopper,
    outstandingCopper: Math.max(0, dueCopper - paidCopper - waivedCopper),
    status: STATUSES.has(source.status) ? source.status : "due",
    gmPriority: whole(source.gmPriority, 500),
    dependsOnObligationIds: stringList(source.dependsOnObligationIds),
    createdAt: text(source.createdAt),
    createdOperationId: text(source.createdOperationId),
    payments: (Array.isArray(source.payments) ? source.payments : []).map((row) => normalizePayment(row)),
    settledAt: text(source.settledAt),
    settledOperationId: text(source.settledOperationId),
    lastPaymentAttemptAt: text(source.lastPaymentAttemptAt),
    lastPaymentAttemptOperationId: text(source.lastPaymentAttemptOperationId),
    orphaned: Boolean(source.orphaned),
    orphanedAt: text(source.orphanedAt),
    orphanedOperationId: text(source.orphanedOperationId),
    orphanReason: text(source.orphanReason),
    orphanPreviousStatus: STATUSES.has(source.orphanPreviousStatus) ? source.orphanPreviousStatus : "",
    orphanResolvedAt: text(source.orphanResolvedAt),
    orphanResolutionAction: ["transfer", "waive"].includes(source.orphanResolutionAction) ? source.orphanResolutionAction : "",
    orphanResolutionOperationId: text(source.orphanResolutionOperationId),
    orphanHistory: (Array.isArray(source.orphanHistory) ? source.orphanHistory : []).map((row) => normalizeOrphanHistory(row)),
    previousRecipientKind: text(source.previousRecipientKind),
    previousRecipientId: text(source.previousRecipientId),
    transferredAt: text(source.transferredAt),
    transferOperationId: text(source.transferOperationId),
    waivedAt: text(source.waivedAt),
    waiverReason: text(source.waiverReason),
    waiverOperationId: text(source.waiverOperationId),
    meta: cloneValue(source.meta && typeof source.meta === "object" ? source.meta : {})
  };
  normalized.status = statusFor(normalized);
  return normalized;
}

function normalizeBuildingState(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const rawAccrual = source.upkeepAccrual && typeof source.upkeepAccrual === "object" ? source.upkeepAccrual : {};
  const normalizeCarry = (row = {}) => ({
    remainderThirds: Math.min(2, whole(row?.remainderThirds)),
    lastPeriodKey: text(row?.lastPeriodKey),
    lastOperationId: text(row?.lastOperationId),
    lastDueCopper: whole(row?.lastDueCopper),
    monthlyCopper: whole(row?.monthlyCopper)
  });
  const operating = {};
  for (const [functionId, row] of Object.entries(rawAccrual.operating ?? {})) {
    const id = text(functionId);
    if (id) operating[id] = normalizeCarry(row);
  }
  return {
    ...cloneValue(source),
    mothballed: Boolean(source.mothballed),
    changedAt: text(source.changedAt),
    changedOperationId: text(source.changedOperationId),
    reason: text(source.reason),
    upkeepAccrual: {
      base: normalizeCarry(rawAccrual.base),
      operating
    },
    history: (Array.isArray(source.history) ? source.history : []).map((row) => ({
      operationId: text(row?.operationId),
      mothballed: Boolean(row?.mothballed),
      changedAt: text(row?.changedAt),
      reason: text(row?.reason)
    }))
  };
}

function normalizeSettlementRun(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    ...cloneValue(source),
    operationId: text(source.operationId),
    periodKey: text(source.periodKey),
    periodIndex: optionalWhole(source.periodIndex),
    paidAt: text(source.paidAt),
    treasuryBeforeCopper: whole(source.treasuryBeforeCopper),
    treasuryAfterCopper: whole(source.treasuryAfterCopper),
    paidCopper: whole(source.paidCopper),
    payments: (Array.isArray(source.payments) ? source.payments : []).map((row) => ({
      obligationId: text(row?.obligationId),
      amountCopper: whole(row?.amountCopper),
      partial: Boolean(row?.partial)
    })),
    skipped: cloneValue(Array.isArray(source.skipped) ? source.skipped : [])
  };
}

export function normalizeFinanceObligationsState(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const defaults = createDefaultFinanceObligationsState();
  const buildingStates = {};
  for (const [buildingId, state] of Object.entries(source.buildingStates ?? {})) {
    const id = text(buildingId);
    if (id) buildingStates[id] = normalizeBuildingState(state);
  }
  return {
    ...cloneValue(source),
    ...defaults,
    schemaVersion: FINANCE_OBLIGATIONS_SCHEMA_VERSION,
    obligations: (Array.isArray(source.obligations) ? source.obligations : []).map((row) => normalizeFinanceObligation(row)),
    buildingStates,
    settlementRuns: (Array.isArray(source.settlementRuns) ? source.settlementRuns : []).map((row) => normalizeSettlementRun(row))
  };
}
