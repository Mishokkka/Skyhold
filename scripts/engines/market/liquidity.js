const LIQUIDITY_SCHEMA_VERSION = 1;

function text(value) {
  return String(value ?? "").trim();
}

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function whole(value) {
  return Math.max(0, Math.floor(finite(value)));
}

function positiveCopper(value) {
  return Math.max(1, Math.round(finite(value, 1)));
}

function nonNegativeCopper(value) {
  return Math.max(0, Math.round(finite(value)));
}

function sideValue(value) {
  return value === "bid" ? "bid" : value === "ask" ? "ask" : "";
}

function plainModifier(source = {}) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  return {
    askPriceFactor: finite(source.askPriceFactor, 1),
    askPriceAddCopper: finite(source.askPriceAddCopper),
    askStockFactor: finite(source.askStockFactor, 1),
    askStockAdd: finite(source.askStockAdd),
    bidPriceFactor: finite(source.bidPriceFactor, 1),
    bidPriceAddCopper: finite(source.bidPriceAddCopper),
    bidDemandFactor: finite(source.bidDemandFactor, 1),
    bidDemandAdd: finite(source.bidDemandAdd)
  };
}

function modifierList(...sources) {
  const result = [];
  for (const source of sources) {
    const rows = Array.isArray(source) ? source : source ? [source] : [];
    for (const row of rows) {
      const normalized = plainModifier(row);
      if (normalized) result.push(normalized);
    }
  }
  return result;
}

function applyQuoteModifiers(values, modifiers) {
  const result = { ...values };
  for (const modifier of modifiers) {
    result.askUnitCopper = (result.askUnitCopper * modifier.askPriceFactor) + modifier.askPriceAddCopper;
    result.askStock = (result.askStock * modifier.askStockFactor) + modifier.askStockAdd;
    result.baseAskStock = (result.baseAskStock * modifier.askStockFactor) + modifier.askStockAdd;
    result.bidUnitCopper = (result.bidUnitCopper * modifier.bidPriceFactor) + modifier.bidPriceAddCopper;
    result.bidDemand = (result.bidDemand * modifier.bidDemandFactor) + modifier.bidDemandAdd;
    result.baseBidDemand = (result.baseBidDemand * modifier.bidDemandFactor) + modifier.bidDemandAdd;
  }
  return result;
}

export function marketLiquidityKey(marketId = "", quoteKey = "", offerId = "") {
  return JSON.stringify([text(marketId), text(quoteKey), text(offerId)]);
}

export function normalizeMarketLiquidityQuote({ market = {}, offer = {}, marketId = "", quoteKey = "", offerId = "", modifiers = [] } = {}) {
  const normalizedMarketId = text(marketId || market.id || offer.marketId);
  const normalizedQuoteKey = text(quoteKey || market.quoteKey || offer.quoteKey);
  const normalizedOfferId = text(offerId || offer.id || offer.offerId);

  const rawBaseAskStock = finite(
    offer.baseAskStock
      ?? offer.baseStock
      ?? offer.askStock
      ?? offer.stock
      ?? market.baseAskStock
      ?? market.baseStock
  );
  const rawAskStock = finite(offer.askStock ?? offer.stock ?? rawBaseAskStock);
  const rawBaseBidDemand = finite(
    offer.baseBidDemand
      ?? offer.bidDemand
      ?? market.baseBidDemand
      ?? market.bidDemand
  );
  const rawBidDemand = finite(offer.bidDemand ?? rawBaseBidDemand);
  const modified = applyQuoteModifiers({
    askUnitCopper: finite(
      offer.askUnitCopper
        ?? offer.unitPriceCopper
        ?? offer.basePriceCopper
        ?? market.askUnitCopper
        ?? market.unitPriceCopper
        ?? market.basePriceCopper,
      1
    ),
    askStock: rawAskStock,
    baseAskStock: rawBaseAskStock,
    bidUnitCopper: finite(offer.bidUnitCopper ?? market.bidUnitCopper),
    bidDemand: rawBidDemand,
    baseBidDemand: rawBaseBidDemand
  }, modifierList(market.liquidityModifiers, offer.liquidityModifiers, modifiers));

  const askUnitCopper = positiveCopper(modified.askUnitCopper);
  const bidUnitCopper = Math.min(nonNegativeCopper(modified.bidUnitCopper), askUnitCopper - 1);
  return {
    key: marketLiquidityKey(normalizedMarketId, normalizedQuoteKey, normalizedOfferId),
    marketId: normalizedMarketId,
    quoteKey: normalizedQuoteKey,
    offerId: normalizedOfferId,
    askUnitCopper,
    askStock: whole(modified.askStock),
    baseAskStock: whole(modified.baseAskStock),
    bidUnitCopper,
    bidDemand: whole(modified.bidDemand),
    baseBidDemand: whole(modified.baseBidDemand)
  };
}

function normalizeLine(source = {}) {
  const marketId = text(source.marketId);
  const quoteKey = text(source.quoteKey);
  const offerId = text(source.offerId);
  const askUnitCopper = positiveCopper(source.askUnitCopper);
  return {
    key: marketLiquidityKey(marketId, quoteKey, offerId),
    marketId,
    quoteKey,
    offerId,
    askUnitCopper,
    askStock: whole(source.askStock),
    baseAskStock: whole(source.baseAskStock ?? source.askStock),
    bidUnitCopper: Math.min(nonNegativeCopper(source.bidUnitCopper), askUnitCopper - 1),
    bidDemand: whole(source.bidDemand),
    baseBidDemand: whole(source.baseBidDemand ?? source.bidDemand)
  };
}

function normalizeReservation(source = {}) {
  const id = text(source.id ?? source.reservationId);
  const key = text(source.key);
  const side = sideValue(source.side);
  const quantity = whole(source.quantity);
  if (!id || !key || !side || !quantity) return null;
  const committedQuantity = Math.min(quantity, whole(source.committedQuantity));
  const cancelledQuantity = Math.min(quantity - committedQuantity, whole(source.cancelledQuantity));
  const remainingQuantity = quantity - committedQuantity - cancelledQuantity;
  return {
    id,
    operationId: text(source.operationId),
    key,
    side,
    quantity,
    committedQuantity,
    cancelledQuantity,
    status: remainingQuantity > 0 ? "reserved" : committedQuantity === quantity ? "committed" : cancelledQuantity === quantity ? "cancelled" : "closed"
  };
}

function receiptFields(source = {}) {
  const receipt = {
    operationId: text(source.operationId),
    action: text(source.action),
    fingerprint: text(source.fingerprint),
    ok: source.ok === true
  };
  for (const key of ["reason", "key", "side", "reservationId"]) {
    const value = text(source[key]);
    if (value) receipt[key] = value;
  }
  for (const key of ["requestedQuantity", "acceptedQuantity", "executedQuantity", "cancelledQuantity", "askAdded", "bidAdded", "lineCount"]) {
    if (source[key] !== undefined) receipt[key] = whole(source[key]);
  }
  if (source.partial === true) receipt.partial = true;
  if (Array.isArray(source.lines)) {
    receipt.lines = source.lines.map((line) => ({
      key: text(line?.key),
      askAdded: whole(line?.askAdded),
      bidAdded: whole(line?.bidAdded)
    })).filter((line) => line.key);
  }
  return receipt;
}

export function normalizeMarketLiquidityState(source = {}) {
  const linesByKey = new Map();
  for (const row of Array.isArray(source?.lines) ? source.lines : []) {
    const line = normalizeLine(row);
    if (!line.marketId || !line.quoteKey || !line.offerId) continue;
    linesByKey.set(line.key, line);
  }
  const reservationIds = new Set();
  const reservations = [];
  for (const row of Array.isArray(source?.reservations) ? source.reservations : []) {
    const reservation = normalizeReservation(row);
    if (!reservation || reservationIds.has(reservation.id)) continue;
    reservationIds.add(reservation.id);
    reservations.push(reservation);
  }
  const receiptOperations = new Set();
  const receipts = [];
  for (const row of Array.isArray(source?.receipts) ? source.receipts : []) {
    const receipt = receiptFields(row);
    if (!receipt.operationId || !receipt.action || !receipt.fingerprint || receiptOperations.has(receipt.operationId)) continue;
    receiptOperations.add(receipt.operationId);
    receipts.push(receipt);
  }
  return {
    schemaVersion: LIQUIDITY_SCHEMA_VERSION,
    lines: [...linesByKey.values()].sort((left, right) => left.key.localeCompare(right.key)),
    reservations,
    receipts
  };
}

function cloneState(source) {
  return normalizeMarketLiquidityState(source);
}

function operationReplay(state, operationId, fingerprint) {
  const existing = state.receipts.find((receipt) => receipt.operationId === operationId);
  if (!existing) return null;
  if (existing.fingerprint !== fingerprint) {
    return {
      ok: false,
      replay: false,
      conflict: true,
      state,
      receipt: existing,
      message: "Operation id was already used for a different market-liquidity request."
    };
  }
  return {
    ok: existing.ok,
    replay: true,
    conflict: false,
    state,
    receipt: existing,
    reservation: state.reservations.find((row) => row.id === existing.reservationId) ?? null
  };
}

function appendReceipt(state, fields) {
  const receipt = receiptFields(fields);
  state.receipts.push(receipt);
  return receipt;
}

function resultFor(state, receipt, extra = {}) {
  return {
    ok: receipt.ok,
    replay: false,
    conflict: false,
    state,
    receipt,
    ...extra
  };
}

function ensureQuoteLine(state, rawQuote) {
  const quote = normalizeMarketLiquidityQuote({
    marketId: rawQuote?.marketId,
    quoteKey: rawQuote?.quoteKey,
    offerId: rawQuote?.offerId ?? rawQuote?.id,
    offer: rawQuote
  });
  if (!quote.marketId || !quote.quoteKey || !quote.offerId) return { quote, line: null };
  let line = state.lines.find((row) => row.key === quote.key);
  if (!line) {
    line = normalizeLine(quote);
    state.lines.push(line);
    state.lines.sort((left, right) => left.key.localeCompare(right.key));
  } else {
    line.askUnitCopper = quote.askUnitCopper;
    line.bidUnitCopper = quote.bidUnitCopper;
    line.baseAskStock = quote.baseAskStock;
    line.baseBidDemand = quote.baseBidDemand;
  }
  return { quote, line };
}

function reservationRemaining(reservation) {
  return Math.max(0, whole(reservation?.quantity) - whole(reservation?.committedQuantity) - whole(reservation?.cancelledQuantity));
}

function lineBalance(line, side) {
  return side === "ask" ? whole(line?.askStock) : whole(line?.bidDemand);
}

function lineReserved(state, key, side) {
  return state.reservations.reduce((sum, reservation) => (
    reservation.key === key && reservation.side === side ? sum + reservationRemaining(reservation) : sum
  ), 0);
}

export function marketLiquidityAvailable({ state = {}, key = "", side = "" } = {}) {
  const normalized = normalizeMarketLiquidityState(state);
  const normalizedSide = sideValue(side);
  const line = normalized.lines.find((row) => row.key === text(key));
  if (!line || !normalizedSide) return 0;
  return Math.max(0, lineBalance(line, normalizedSide) - lineReserved(normalized, line.key, normalizedSide));
}

export function reserveMarketLiquidity({ state = {}, quote = {}, side = "", quantity = 0, operationId = "", reservationId = "", allowPartial = true } = {}) {
  const next = cloneState(state);
  const id = text(operationId);
  const normalizedSide = sideValue(side);
  const requestedQuantity = whole(quantity);
  const normalizedQuote = normalizeMarketLiquidityQuote({
    marketId: quote?.marketId,
    quoteKey: quote?.quoteKey,
    offerId: quote?.offerId ?? quote?.id,
    offer: quote
  });
  const requestedReservationId = text(reservationId) || `reservation:${id}`;
  const fingerprint = JSON.stringify(["reserve", normalizedQuote.key, normalizedSide, requestedQuantity, requestedReservationId, allowPartial === true]);
  if (!id) return { ok: false, replay: false, conflict: false, state: next, message: "Market-liquidity reservation requires an operation id." };
  const replay = operationReplay(next, id, fingerprint);
  if (replay) return replay;

  const { quote: synchronizedQuote, line } = ensureQuoteLine(next, normalizedQuote);
  let reason = "";
  if (!line) reason = "invalid-quote-key";
  else if (!normalizedSide) reason = "invalid-side";
  else if (!requestedQuantity) reason = "invalid-quantity";
  else if (next.reservations.some((row) => row.id === requestedReservationId)) reason = "reservation-id-conflict";
  const availableQuantity = reason ? 0 : Math.max(0, lineBalance(line, normalizedSide) - lineReserved(next, line.key, normalizedSide));
  if (!reason && requestedQuantity > availableQuantity && allowPartial !== true) reason = "insufficient-liquidity";
  const acceptedQuantity = reason ? 0 : Math.min(requestedQuantity, availableQuantity);
  if (!reason && acceptedQuantity <= 0) reason = "insufficient-liquidity";

  let reservation = null;
  if (!reason) {
    reservation = normalizeReservation({
      id: requestedReservationId,
      operationId: id,
      key: synchronizedQuote.key,
      side: normalizedSide,
      quantity: acceptedQuantity
    });
    next.reservations.push(reservation);
  }
  const receipt = appendReceipt(next, {
    operationId: id,
    action: "reserve",
    fingerprint,
    ok: !reason,
    reason,
    key: synchronizedQuote.key,
    side: normalizedSide,
    reservationId: requestedReservationId,
    requestedQuantity,
    acceptedQuantity,
    partial: !reason && acceptedQuantity < requestedQuantity
  });
  return resultFor(next, receipt, { reservation });
}

function settleReservation({ state = {}, reservationId = "", side = "", quantity, operationId = "", action } = {}) {
  const next = cloneState(state);
  const id = text(operationId);
  const normalizedReservationId = text(reservationId);
  const expectedSide = sideValue(side);
  const allRemaining = quantity === undefined || quantity === null;
  const requestedQuantity = allRemaining ? null : whole(quantity);
  const fingerprint = JSON.stringify([action, normalizedReservationId, expectedSide, allRemaining ? "all" : requestedQuantity]);
  if (!id) return { ok: false, replay: false, conflict: false, state: next, message: `Market-liquidity ${action} requires an operation id.` };
  const replay = operationReplay(next, id, fingerprint);
  if (replay) return replay;

  const reservation = next.reservations.find((row) => row.id === normalizedReservationId) ?? null;
  const line = next.lines.find((row) => row.key === reservation?.key) ?? null;
  let reason = "";
  if (!reservation) reason = "reservation-not-found";
  else if (expectedSide && reservation.side !== expectedSide) reason = "reservation-side-conflict";
  else if (!line) reason = "quote-line-not-found";
  else if (!allRemaining && !requestedQuantity) reason = "invalid-quantity";
  const remainingQuantity = reason ? 0 : reservationRemaining(reservation);
  if (!reason && remainingQuantity <= 0) reason = "reservation-closed";
  const desiredQuantity = allRemaining ? remainingQuantity : requestedQuantity;
  let acceptedQuantity = reason ? 0 : Math.min(desiredQuantity, remainingQuantity);
  if (!reason && action === "commit") acceptedQuantity = Math.min(acceptedQuantity, lineBalance(line, reservation.side));
  if (!reason && acceptedQuantity <= 0) reason = "insufficient-liquidity";

  if (!reason && action === "commit") {
    reservation.committedQuantity += acceptedQuantity;
    if (reservation.side === "ask") line.askStock -= acceptedQuantity;
    else line.bidDemand -= acceptedQuantity;
  } else if (!reason) {
    reservation.cancelledQuantity += acceptedQuantity;
  }
  if (reservation) {
    const remaining = reservationRemaining(reservation);
    reservation.status = remaining > 0
      ? "reserved"
      : reservation.committedQuantity === reservation.quantity
        ? "committed"
        : reservation.cancelledQuantity === reservation.quantity
          ? "cancelled"
          : "closed";
  }

  const quantityField = action === "commit" ? "executedQuantity" : "cancelledQuantity";
  const receipt = appendReceipt(next, {
    operationId: id,
    action,
    fingerprint,
    ok: !reason,
    reason,
    key: reservation?.key,
    side: reservation?.side ?? expectedSide,
    reservationId: normalizedReservationId,
    requestedQuantity: allRemaining ? remainingQuantity : requestedQuantity,
    [quantityField]: acceptedQuantity,
    partial: !reason && acceptedQuantity < desiredQuantity
  });
  return resultFor(next, receipt, { reservation });
}

export function commitMarketLiquidity(args = {}) {
  return settleReservation({ ...args, action: "commit" });
}

export function cancelMarketLiquidity(args = {}) {
  return settleReservation({ ...args, action: "cancel" });
}

function quoteKeyFromReplenishment(row = {}) {
  if (text(row.key)) return text(row.key);
  return marketLiquidityKey(row.marketId, row.quoteKey, row.offerId ?? row.id);
}

function replenishmentSchedule(state, { lines = [], marketId = "", quoteKey = "", askReplenish = 0, bidReplenish = 0 } = {}) {
  const explicit = Array.isArray(lines) ? lines : [];
  if (explicit.length) {
    const byKey = new Map();
    for (const row of explicit) {
      const key = quoteKeyFromReplenishment(row);
      if (!key) continue;
      const current = byKey.get(key) ?? { key, askReplenish: 0, bidReplenish: 0 };
      current.askReplenish += whole(row.askReplenish ?? row.askQuantity);
      current.bidReplenish += whole(row.bidReplenish ?? row.bidQuantity);
      byKey.set(key, current);
    }
    return [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key));
  }
  const normalizedMarketId = text(marketId);
  const normalizedQuoteKey = text(quoteKey);
  return state.lines.filter((line) => (
    (!normalizedMarketId || line.marketId === normalizedMarketId)
      && (!normalizedQuoteKey || line.quoteKey === normalizedQuoteKey)
  )).map((line) => ({
    key: line.key,
    askReplenish: whole(askReplenish),
    bidReplenish: whole(bidReplenish)
  }));
}

export function replenishMarketLiquidity({ state = {}, operationId = "", lines = [], marketId = "", quoteKey = "", askReplenish = 0, bidReplenish = 0 } = {}) {
  const next = cloneState(state);
  const id = text(operationId);
  const schedule = replenishmentSchedule(next, { lines, marketId, quoteKey, askReplenish, bidReplenish });
  const fingerprint = JSON.stringify(["replenish", schedule.map((row) => [row.key, row.askReplenish, row.bidReplenish])]);
  if (!id) return { ok: false, replay: false, conflict: false, state: next, message: "Market-liquidity replenishment requires an operation id." };
  const replay = operationReplay(next, id, fingerprint);
  if (replay) return replay;

  const changed = [];
  let askAdded = 0;
  let bidAdded = 0;
  for (const item of schedule) {
    const line = next.lines.find((row) => row.key === item.key);
    if (!line) continue;
    const lineAskAdded = Math.min(item.askReplenish, Math.max(0, line.baseAskStock - line.askStock));
    const lineBidAdded = Math.min(item.bidReplenish, Math.max(0, line.baseBidDemand - line.bidDemand));
    line.askStock += lineAskAdded;
    line.bidDemand += lineBidAdded;
    askAdded += lineAskAdded;
    bidAdded += lineBidAdded;
    changed.push({ key: line.key, askAdded: lineAskAdded, bidAdded: lineBidAdded });
  }
  const receipt = appendReceipt(next, {
    operationId: id,
    action: "replenish",
    fingerprint,
    ok: true,
    askAdded,
    bidAdded,
    lineCount: changed.length,
    lines: changed
  });
  return resultFor(next, receipt);
}

export function reserveMarketAskStock(args = {}) {
  return reserveMarketLiquidity({ ...args, side: "ask" });
}

export function reserveMarketBidDemand(args = {}) {
  return reserveMarketLiquidity({ ...args, side: "bid" });
}

export function commitMarketAskStock(args = {}) {
  return commitMarketLiquidity({ ...args, side: "ask" });
}

export function commitMarketBidDemand(args = {}) {
  return commitMarketLiquidity({ ...args, side: "bid" });
}

export function cancelMarketAskStock(args = {}) {
  return cancelMarketLiquidity({ ...args, side: "ask" });
}

export function cancelMarketBidDemand(args = {}) {
  return cancelMarketLiquidity({ ...args, side: "bid" });
}
