import { appendHoldingOperation, findHoldingOperation } from "../../data/operations.js";
import {
  financeObligationOutstandingCopper,
  resolveFinanceObligationOrphan,
  setFinanceBuildingMothball
} from "../../engines/economy/finance-obligations.js";

function text(value) {
  return String(value ?? "").trim();
}

function replayPayload(operation = {}) {
  return operation?.payload && typeof operation.payload === "object" ? operation.payload : {};
}

function sameText(left, right) {
  return text(left) === text(right);
}

function historicFinanceControl(holding, operationId) {
  const op = text(operationId);
  for (const obligation of holding?.finance?.obligations ?? []) {
    if (text(obligation?.orphanResolutionOperationId) !== op) continue;
    const history = Array.isArray(obligation?.orphanHistory) ? obligation.orphanHistory : [];
    const resolution = [...history].reverse()
      .map((entry) => entry?.resolution)
      .find((entry) => text(entry?.operationId) === op) ?? {};
    return {
      control: "orphan-resolution",
      obligationId: text(obligation.id),
      action: text(obligation.orphanResolutionAction),
      recipientKind: text(resolution.recipientKind),
      recipientId: text(resolution.recipientId),
      reason: text(resolution.reason)
    };
  }
  for (const [buildingId, state] of Object.entries(holding?.finance?.buildingStates ?? {})) {
    const entry = (Array.isArray(state?.history) ? state.history : []).find((row) => text(row?.operationId) === op);
    if (!entry) continue;
    return {
      control: "building-mothball",
      buildingId: text(buildingId),
      mothballed: Boolean(entry.mothballed),
      reason: text(entry.reason)
    };
  }
  return null;
}

function financeControlReplay(holding, operationId, expected = {}) {
  const operation = findHoldingOperation(holding, operationId);
  const payload = operation ? replayPayload(operation) : historicFinanceControl(holding, operationId);
  if (!payload) return null;
  const matches = Object.entries(expected).every(([key, value]) => {
    if (typeof value === "boolean") return Boolean(payload[key]) === value;
    return sameText(payload[key], value);
  });
  if (!matches || text(payload.control) !== text(expected.control)) {
    return {
      ok: false,
      replay: false,
      code: "operation-conflict",
      operationId: text(operationId),
      operation: operation ?? null
    };
  }
  return {
    ok: true,
    replay: true,
    operationId: text(operationId),
    operation: operation ?? null
  };
}

function recipientExists(holding, recipientKind, recipientId) {
  const kind = text(recipientKind);
  const id = text(recipientId);
  if (!id) return false;
  if (kind === "resident") {
    return (holding?.people?.list ?? []).some((person) => text(person?.id) === id);
  }
  if (kind === "building") {
    return (holding?.buildings?.list ?? []).some((building) => text(building?.id) === id);
  }
  return false;
}

function recipientName(holding, recipientKind, recipientId) {
  const kind = text(recipientKind);
  const id = text(recipientId);
  const rows = kind === "resident" ? holding?.people?.list : kind === "building" ? holding?.buildings?.list : [];
  return text((rows ?? []).find((row) => text(row?.id) === id)?.name) || id;
}

/**
 * Resolve one exact orphaned finance row and append an immutable holding audit
 * operation. The caller owns persistence and authority checks.
 */
export function applyFinanceOrphanControl({
  holding,
  obligationId = "",
  action = "",
  recipientKind = "",
  recipientId = "",
  reason = "",
  operationId = "",
  resolvedAt = ""
} = {}) {
  const id = text(obligationId);
  const normalizedAction = text(action).toLowerCase();
  const op = text(operationId);
  const explanation = text(reason);
  const targetKind = normalizedAction === "transfer" ? text(recipientKind) : "";
  const targetId = normalizedAction === "transfer" ? text(recipientId) : "";
  if (!holding || typeof holding !== "object") return { ok: false, replay: false, code: "holding" };
  if (!id || !op) return { ok: false, replay: false, code: "invalid" };
  if (!new Set(["transfer", "waive"]).has(normalizedAction)) return { ok: false, replay: false, code: "action" };
  if (!explanation) return { ok: false, replay: false, code: "reason" };

  const replay = financeControlReplay(holding, op, {
    control: "orphan-resolution",
    obligationId: id,
    action: normalizedAction,
    recipientKind: targetKind,
    recipientId: targetId,
    reason: explanation
  });
  if (replay) return replay;

  const obligation = (holding?.finance?.obligations ?? []).find((row) => text(row?.id) === id);
  if (!obligation) return { ok: false, replay: false, code: "not-found" };
  if (normalizedAction === "transfer") {
    if (targetKind !== text(obligation.recipientKind)) {
      return { ok: false, replay: false, code: "recipient-kind" };
    }
    if (!recipientExists(holding, targetKind, targetId)) {
      return { ok: false, replay: false, code: "recipient-not-found" };
    }
  }

  const resolved = resolveFinanceObligationOrphan({
    finance: holding.finance,
    obligationId: id,
    action: normalizedAction,
    recipientKind: targetKind,
    recipientId: targetId,
    reason: explanation,
    operationId: op,
    resolvedAt: text(resolvedAt)
  });
  if (!resolved.ok) return { ...resolved, replay: false, operationId: op };
  holding.finance = resolved.finance;

  const outstandingCopper = financeObligationOutstandingCopper(obligation);
  const targetName = normalizedAction === "transfer" ? recipientName(holding, targetKind, targetId) : "";
  const summary = normalizedAction === "transfer"
    ? `Долг ${id} перенесён на «${targetName}». Причина: ${explanation}`
    : `Долг ${id} списан (${outstandingCopper} ММ). Причина: ${explanation}`;
  const operation = appendHoldingOperation(holding, {
    operationId: op,
    type: "system",
    createdAt: text(resolvedAt),
    title: normalizedAction === "transfer" ? "Перенос денежного обязательства" : "Списание денежного обязательства",
    summary,
    payload: {
      control: "orphan-resolution",
      obligationId: id,
      action: normalizedAction,
      recipientKind: targetKind,
      recipientId: targetId,
      reason: explanation,
      outstandingCopper
    }
  });
  return {
    ok: true,
    replay: false,
    operationId: op,
    operation,
    obligation: resolved.obligation,
    action: normalizedAction
  };
}

/**
 * Toggle conservation for one exact existing building and append an immutable
 * holding audit operation. Old obligations remain untouched by the pure engine.
 */
export function applyFinanceBuildingMothballControl({
  holding,
  buildingId = "",
  mothballed = true,
  reason = "",
  operationId = "",
  changedAt = ""
} = {}) {
  const id = text(buildingId);
  const op = text(operationId);
  const explanation = text(reason);
  const desired = Boolean(mothballed);
  if (!holding || typeof holding !== "object") return { ok: false, replay: false, code: "holding" };
  if (!id || !op) return { ok: false, replay: false, code: "invalid" };
  if (!explanation) return { ok: false, replay: false, code: "reason" };

  const replay = financeControlReplay(holding, op, {
    control: "building-mothball",
    buildingId: id,
    mothballed: desired,
    reason: explanation
  });
  if (replay) return replay;

  const building = (holding?.buildings?.list ?? []).find((row) => text(row?.id) === id);
  if (!building) return { ok: false, replay: false, code: "building-not-found" };
  const current = Boolean(holding?.finance?.buildingStates?.[id]?.mothballed);
  if (current === desired) return { ok: false, replay: false, code: "unchanged" };

  const changed = setFinanceBuildingMothball({
    finance: holding.finance,
    buildingId: id,
    mothballed: desired,
    changedAt: text(changedAt),
    operationId: op,
    reason: explanation
  });
  holding.finance = changed.finance;
  const operation = appendHoldingOperation(holding, {
    operationId: op,
    type: "system",
    createdAt: text(changedAt),
    title: desired ? "Здание законсервировано" : "Консервация здания снята",
    summary: `${text(building.name) || id}: ${explanation}`,
    payload: {
      control: "building-mothball",
      buildingId: id,
      mothballed: desired,
      reason: explanation
    }
  });
  return {
    ok: true,
    replay: false,
    operationId: op,
    operation,
    buildingId: id,
    mothballed: desired,
    state: changed.state
  };
}
