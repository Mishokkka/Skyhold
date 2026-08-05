import { deliverMarketExport, loseMarketExport } from "./export.js";

const EXPORT_ADVANCE_VERSION = 1;

function text(value = "") {
  return String(value ?? "").trim();
}

function cloneJson(value, fallback = null) {
  if (value === undefined) return fallback;
  return JSON.parse(JSON.stringify(value));
}

function bounded(value, fallback = 0, min = 0, max = 1) {
  const parsed = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
}

function whole(value, minimum = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : null;
}

function orderId(order = {}) {
  return text(order?.id ?? order?.operationId);
}

function resolutionOperationId(advanceOperationId, order, outcome) {
  return `${advanceOperationId}:${orderId(order)}:${outcome}`;
}

function runByOperationId(book = {}, operationId = "") {
  const id = text(operationId);
  return (Array.isArray(book?.advanceRuns) ? book.advanceRuns : []).find((run) => text(run?.operationId) === id) ?? null;
}

function initialRemainingQd(order = {}) {
  const current = whole(order?.remainingQd, 0);
  if (current !== null) return current;
  return whole(order?.quoteSnapshot?.route?.etaQd ?? order?.quoteSnapshot?.route?.deliveryQd, 0) ?? 0;
}

function reportFromRun(run = {}, replay = false) {
  const report = {
    ok: run.status === "complete",
    replay,
    operationId: text(run.operationId),
    advancedQd: whole(run.elapsedQd, 0) ?? 0,
    recognizedGrossCopper: 0,
    treasuryDeltaCopper: 0,
    delivered: [],
    lost: [],
    inTransit: [],
    ignored: Math.max(0, whole(run.ignored, 0) ?? 0)
  };
  for (const result of Array.isArray(run?.results) ? run.results : []) {
    const copy = cloneJson(result, {});
    if (result.outcome === "delivered") {
      report.delivered.push(copy);
      report.recognizedGrossCopper += Math.max(0, Number(result?.settlement?.grossCopper) || 0);
      report.treasuryDeltaCopper += Number(result?.settlement?.cashDeltaCopper ?? result?.settlement?.netCopper) || 0;
    } else if (result.outcome === "lost") {
      report.lost.push(copy);
      report.treasuryDeltaCopper += Number(result?.settlement?.cashDeltaCopper ?? result?.settlement?.netCopper) || 0;
    } else {
      report.inTransit.push(copy);
    }
  }
  return report;
}

function failRun(run, code, message, extra = {}) {
  run.lastError = { code, message, ...cloneJson(extra, {}) };
  return { ...reportFromRun(run, false), ok: false, code, message, ...extra };
}

/** Stable deterministic unit interval used to resolve a frozen export risk. */
export function deterministicMarketExportUnit(seed = "") {
  let value = 2166136261;
  for (const char of String(seed ?? "")) {
    value ^= char.codePointAt(0);
    value = Math.imul(value, 16777619);
  }
  value >>>= 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) / 4294967295;
}

/**
 * Advance only dispatched external exports. Each call is frozen by operationId;
 * replaying the same call returns its stored report and cannot subtract ETA,
 * consume demand, or recognize sale revenue twice.
 */
export function advanceMarketExports({
  holding,
  exportBook = null,
  book = null,
  elapsedQd = 0,
  operationId = "",
  resolvedAt = new Date().toISOString(),
  dependencies = {}
} = {}) {
  const targetBook = exportBook ?? book;
  if (!holding || typeof holding !== "object") return { ok: false, code: "invalid-export-holding", message: "Market export advancement requires a settlement holding." };
  if (!targetBook || typeof targetBook !== "object" || !Array.isArray(targetBook.orders)) {
    return { ok: false, code: "invalid-export-book", message: "Market export advancement requires an export book with orders." };
  }
  const qd = whole(elapsedQd, 0);
  if (qd === null) return { ok: false, code: "fractional-export-time", message: "External export advancement accepts only non-negative whole QD." };
  const id = text(operationId);
  if (!id) return { ok: false, code: "missing-operation-id", message: "External export advancement requires operationId." };
  if (!dependencies?.demand || typeof dependencies.demand.consume !== "function" || typeof dependencies.demand.release !== "function") {
    return { ok: false, code: "missing-export-demand-adapter", message: "External export advancement requires the authoritative liquidity demand adapter." };
  }

  const existing = runByOperationId(targetBook, id);
  if (existing) {
    if ((whole(existing.elapsedQd, 0) ?? -1) !== qd) {
      return { ok: false, conflict: true, code: "operation-id-conflict", message: "This export advancement operationId was already used with another elapsed QD." };
    }
    if (existing.status === "complete") return reportFromRun(existing, true);
  }

  if (!Array.isArray(targetBook.advanceRuns)) targetBook.advanceRuns = [];
  const run = existing ?? {
    version: EXPORT_ADVANCE_VERSION,
    operationId: id,
    elapsedQd: qd,
    resolvedAt: text(resolvedAt),
    status: "running",
    orderIds: targetBook.orders.filter((order) => text(order?.status) === "in-transit").map(orderId),
    ignored: targetBook.orders.filter((order) => text(order?.status) !== "in-transit").length,
    results: [],
    lastError: null
  };
  if (!existing) {
    const uniqueIds = new Set(run.orderIds);
    if (uniqueIds.size !== run.orderIds.length || uniqueIds.has("")) {
      return { ok: false, code: "ambiguous-export-order", message: "Every in-transit export must have one unique id before advancement." };
    }
    targetBook.advanceRuns.push(run);
  }

  const completedIds = new Set((run.results ?? []).map((result) => text(result?.orderId)));
  const randomUnit = typeof dependencies.riskUnit === "function" ? dependencies.riskUnit : deterministicMarketExportUnit;
  for (const selectedOrderId of run.orderIds) {
    if (completedIds.has(selectedOrderId)) continue;
    const order = targetBook.orders.find((row) => orderId(row) === selectedOrderId);
    if (!order) return failRun(run, "missing-export-order", "An export selected by this advancement run no longer exists.", { orderId: selectedOrderId });
    if (text(order?.status) !== "in-transit") {
      return failRun(run, "export-order-state-conflict", "Only the in-transit order snapshot may be advanced by this operation.", {
        orderId: selectedOrderId,
        status: text(order?.status)
      });
    }
    const remainingBeforeQd = initialRemainingQd(order);
    const remainingQd = Math.max(0, remainingBeforeQd - qd);
    if (remainingQd > 0) {
      order.remainingQd = remainingQd;
      run.results.push({
        orderId: selectedOrderId,
        outcome: "in-transit",
        remainingBeforeQd,
        remainingQd,
        recognizedGrossCopper: 0
      });
      continue;
    }

    const frozenRisk = order?.quoteSnapshot?.risk ?? {};
    const lossChance = bounded(frozenRisk?.lossChance, 0, 0, 1);
    const riskResolutionId = text(frozenRisk?.resolutionId) || `${order?.operationId || selectedOrderId}:export-risk:v1`;
    const lossRoll = bounded(randomUnit(`${riskResolutionId}|loss`), 1, 0, 0.999999999);
    const lost = lossRoll < lossChance;
    const outcome = lost ? "lost" : "delivered";
    const stageOperationId = resolutionOperationId(id, order, outcome);
    let resolution;
    try {
      resolution = lost
        ? loseMarketExport({
          holding,
          book: targetBook,
          orderId: selectedOrderId,
          operationId: stageOperationId,
          lostAt: run.resolvedAt,
          dependencies: { demand: dependencies.demand }
        })
        : deliverMarketExport({
          holding,
          book: targetBook,
          orderId: selectedOrderId,
          operationId: stageOperationId,
          deliveredAt: run.resolvedAt,
          dependencies: { demand: dependencies.demand }
        });
    } catch (error) {
      return failRun(run, "export-resolution-failed", String(error?.message ?? error), { orderId: selectedOrderId, outcome });
    }
    if (!resolution?.ok) {
      return failRun(run, text(resolution?.code) || "export-resolution-failed", text(resolution?.message) || "External export resolution failed.", {
        orderId: selectedOrderId,
        outcome,
        resolution: cloneJson(resolution, {})
      });
    }
    const liveOrder = targetBook.orders.find((row) => orderId(row) === selectedOrderId) ?? order;
    liveOrder.remainingQd = 0;
    liveOrder.riskResolutionId = riskResolutionId;
    liveOrder.riskResolutionVersion = Math.max(1, whole(frozenRisk?.resolutionVersion, 1) ?? 1);
    liveOrder.riskLossChance = lossChance;
    liveOrder.riskLossRoll = lossRoll;
    liveOrder.riskOutcome = outcome;
    run.results.push({
      orderId: selectedOrderId,
      outcome,
      remainingBeforeQd,
      remainingQd: 0,
      riskResolutionId,
      lossChance,
      lossRoll,
      resolutionOperationId: stageOperationId,
      settlement: cloneJson(resolution?.settlement, {}),
      demandStatus: text(liveOrder?.demand?.status)
    });
  }

  run.status = "complete";
  run.completedAt = text(resolvedAt);
  run.lastError = null;
  run.report = reportFromRun(run, false);
  return cloneJson(run.report, {});
}
