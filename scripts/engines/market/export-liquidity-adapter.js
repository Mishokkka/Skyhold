import {
  cancelMarketBidDemand,
  commitMarketBidDemand,
  marketLiquidityAvailable,
  marketLiquidityKey,
  normalizeMarketLiquidityState,
  reserveMarketBidDemand
} from "./liquidity.js";

function text(value) {
  return String(value ?? "").trim();
}

function positiveWhole(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function conflict(code, message, extra = {}) {
  return { ok: false, replay: false, conflict: true, code, message, ...extra };
}

function validateStateTarget(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new TypeError("Market export liquidity state must be a JSON object.");
  }
  const prototype = Object.getPrototypeOf(state);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Market export liquidity state must be a plain JSON object.");
  }
  if (!Object.isExtensible(state)) {
    throw new TypeError("Market export liquidity state must be mutable.");
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(state))) {
    if (descriptor.configurable !== true) {
      throw new TypeError("Market export liquidity state must contain only configurable JSON properties.");
    }
  }
}

function replaceState(target, source) {
  validateStateTarget(target);
  const next = normalizeMarketLiquidityState(source);
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
  return target;
}

function resolveLine(state, payload = {}) {
  const marketId = text(payload.marketId);
  const quoteKey = text(payload.quoteKey);
  const offerId = text(payload.offerId);
  if (!marketId || !quoteKey || !offerId) {
    return {
      ok: false,
      code: "invalid-liquidity-line-key",
      message: "External demand requires marketId, quoteKey and offerId."
    };
  }
  const normalized = normalizeMarketLiquidityState(state);
  const key = marketLiquidityKey(marketId, quoteKey, offerId);
  const line = normalized.lines.find((row) => row.key === key) ?? null;
  if (!line) {
    return {
      ok: false,
      stale: true,
      code: "missing-liquidity-line",
      key,
      message: "The authoritative market bid-liquidity line was not found."
    };
  }
  return { ok: true, normalized, key, line };
}

function reservationRemaining(reservation = {}) {
  return Math.max(
    0,
    Number(reservation.quantity ?? 0)
      - Number(reservation.committedQuantity ?? 0)
      - Number(reservation.cancelledQuantity ?? 0)
  );
}

function reservationForTransition(resolved, payload = {}) {
  const parentId = text(payload.reservationOperationId);
  if (!parentId) {
    return {
      ok: false,
      code: "missing-demand-reservation",
      message: "Demand settlement requires reservationOperationId."
    };
  }
  const candidates = resolved.normalized.reservations.filter((row) => (
    row.side === "bid" && text(row.operationId) === parentId
  ));
  const reservation = candidates.find((row) => row.key === resolved.key) ?? null;
  if (!reservation && candidates.length) {
    return conflict(
      "demand-line-conflict",
      "The demand reservation belongs to another market quote line."
    );
  }
  if (!reservation) {
    return {
      ok: false,
      code: "missing-demand-reservation",
      message: "The external bid-demand reservation was not found."
    };
  }
  const quantity = positiveWhole(payload.qty);
  if (quantity === null || quantity !== Number(reservation.quantity)) {
    return conflict(
      "demand-quantity-conflict",
      "Demand settlement quantity differs from its reservation."
    );
  }
  return { ok: true, reservation, quantity };
}

function translatedResult(result, state) {
  if (result?.state) replaceState(state, result.state);
  const receipt = result?.receipt ?? {};
  if (result?.ok === true) return { ...result, state };
  if (result?.conflict === true) {
    return {
      ...result,
      state,
      code: "demand-operation-conflict",
      message: result.message || "This operationId already belongs to another demand transition."
    };
  }
  if (receipt.reason === "insufficient-liquidity") {
    return {
      ...result,
      state,
      stale: true,
      code: "insufficient-bid-demand",
      requestedQty: Number(receipt.requestedQuantity ?? 0),
      availableQty: marketLiquidityAvailable({ state, key: receipt.key, side: "bid" }),
      message: "Finite external bid demand is exhausted."
    };
  }
  if (receipt.reason === "reservation-closed") {
    return {
      ...result,
      state,
      conflict: true,
      code: "demand-already-settled",
      message: "External bid demand was already consumed or released."
    };
  }
  return {
    ...result,
    state,
    code: text(receipt.reason) || "market-liquidity-transition-failed"
  };
}

/**
 * Bridges the market-export demand interface to one authoritative JSON liquidity
 * ledger. The supplied state object keeps its identity and is replaced in place
 * after every liquidity transition.
 */
export function createMarketExportLiquidityDemandAdapter(state = {}) {
  validateStateTarget(state);

  function available(payload = {}) {
    const resolved = resolveLine(state, payload);
    if (!resolved.ok) return { ...resolved, availableQty: 0 };
    return {
      ok: true,
      key: resolved.key,
      availableQty: marketLiquidityAvailable({
        state: resolved.normalized,
        key: resolved.key,
        side: "bid"
      })
    };
  }

  function reserve(payload = {}) {
    const resolved = resolveLine(state, payload);
    if (!resolved.ok) return resolved;
    const operationId = text(payload.operationId);
    const quantity = positiveWhole(payload.qty);
    if (!operationId || quantity === null) {
      return {
        ok: false,
        code: "invalid-demand-reservation",
        message: "Demand reservation requires operationId and a positive whole quantity."
      };
    }
    const result = reserveMarketBidDemand({
      state: resolved.normalized,
      // Passing the existing authoritative line preserves its prices and bases;
      // reserveMarketBidDemand therefore cannot materialize a synthetic quote.
      quote: resolved.line,
      quantity,
      operationId,
      reservationId: `export-demand:${operationId}`,
      allowPartial: false
    });
    return translatedResult(result, state);
  }

  function settle(payload, action) {
    const resolved = resolveLine(state, payload);
    if (!resolved.ok) return resolved;
    const operationId = text(payload.operationId);
    if (!operationId) {
      return {
        ok: false,
        code: action === "cancel" ? "invalid-demand-release" : "invalid-demand-consumption",
        message: `Demand ${action} requires operationId.`
      };
    }
    const selected = reservationForTransition(resolved, payload);
    if (!selected.ok) return selected;
    const priorOperation = resolved.normalized.receipts.some((receipt) => (
      text(receipt.operationId) === operationId
    ));
    if (!priorOperation && reservationRemaining(selected.reservation) !== Number(selected.reservation.quantity)) {
      return conflict(
        "demand-already-settled",
        "External bid demand was already consumed or released."
      );
    }
    const transition = action === "cancel" ? cancelMarketBidDemand : commitMarketBidDemand;
    const result = transition({
      state: resolved.normalized,
      reservationId: selected.reservation.id,
      quantity: selected.quantity,
      operationId
    });
    if (result?.ok === true && result?.receipt?.partial === true) {
      return conflict(
        "demand-partial-settlement-conflict",
        "An export demand reservation must be consumed or released as one whole settlement."
      );
    }
    return translatedResult(result, state);
  }

  return {
    state,
    available,
    reserve,
    release(payload = {}) {
      return settle(payload, "cancel");
    },
    consume(payload = {}) {
      return settle(payload, "commit");
    }
  };
}
