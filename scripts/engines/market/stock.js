import {
  commitMarketAskStock,
  marketLiquidityAvailable,
  marketLiquidityKey,
  normalizeMarketLiquidityQuote,
  normalizeMarketLiquidityState,
  replenishMarketLiquidity,
  reserveMarketAskStock
} from "./liquidity.js";

const DEFAULT_PERIOD_REFILL_RATE = 0.35;

function quantity(value) {
  const parsed = Number(value);
  return Math.max(0, Math.floor(Number.isFinite(parsed) ? parsed : 0));
}

function text(value) {
  return String(value ?? "").trim();
}

function marketState(holding = {}, { create = false } = {}) {
  if (!holding || typeof holding !== "object") return null;
  if (!holding.special || typeof holding.special !== "object") {
    if (!create) return null;
    holding.special = { notes: "", list: [] };
  }
  if (!holding.special.market || typeof holding.special.market !== "object") {
    if (!create) return null;
    holding.special.market = { orders: [], stockReservations: [] };
  }
  if (create && !Array.isArray(holding.special.market.stockReservations)) {
    holding.special.market.stockReservations = [];
  }
  return holding.special.market;
}

function readLiquidityState(holding = {}) {
  return normalizeMarketLiquidityState(marketState(holding)?.liquidity);
}

function writeLiquidityState(holding, state) {
  const market = marketState(holding, { create: true });
  market.liquidity = normalizeMarketLiquidityState(state);
  return market.liquidity;
}

function stockLine(line = {}) {
  const offerId = text(line.id ?? line.offerId);
  if (!offerId) return null;
  return {
    offerId,
    sourceOfferId: text(line.sourceOfferId ?? offerId) || offerId,
    providerId: text(line.providerId),
    qty: quantity(line.qty)
  };
}

function aggregateLines(lines = []) {
  const rows = new Map();
  for (const source of Array.isArray(lines) ? lines : []) {
    const line = stockLine(source);
    if (!line?.qty) continue;
    const key = `${line.offerId}\u001f${line.sourceOfferId}`;
    const current = rows.get(key);
    if (current) current.qty += line.qty;
    else rows.set(key, line);
  }
  return [...rows.values()].sort((left, right) => (
    left.offerId.localeCompare(right.offerId) || left.sourceOfferId.localeCompare(right.sourceOfferId)
  ));
}

function legacyReservationUsage(holding = {}, marketId = "", quoteKey = "") {
  const market = marketState(holding);
  const reserved = new Map();
  const released = new Map();
  for (const reservation of market?.stockReservations ?? []) {
    if (text(reservation?.marketId) !== text(marketId)) continue;
    if (text(reservation?.quoteKey) !== text(quoteKey)) continue;
    for (const line of aggregateLines(reservation?.lines)) {
      const key = `${line.offerId}\u001f${line.sourceOfferId}`;
      const current = reserved.get(key);
      if (current) current.qty += line.qty;
      else reserved.set(key, { ...line });
    }
    for (const release of reservation?.releases ?? []) {
      for (const line of aggregateLines(release?.lines)) {
        const key = `${line.offerId}\u001f${line.sourceOfferId}`;
        const current = released.get(key);
        if (current) current.qty += line.qty;
        else released.set(key, { ...line });
      }
    }
  }
  const usage = [];
  for (const [key, line] of reserved) {
    const qty = Math.max(0, line.qty - quantity(released.get(key)?.qty));
    if (qty > 0) usage.push({ ...line, qty });
  }
  return usage;
}

function legacyAdjustedOffers({ holding = {}, quote = {} } = {}) {
  const offers = (quote.offers ?? []).map((offer) => ({
    ...offer,
    quotedStock: quantity(offer.quotedStock ?? offer.stock ?? offer.askStock ?? offer.baseAskStock),
    stock: quantity(offer.quotedStock ?? offer.stock ?? offer.askStock ?? offer.baseAskStock),
    reservedStock: 0
  }));
  const usage = legacyReservationUsage(holding, quote.marketId, quote.quoteKey);
  const offerById = new Map(offers.map((offer) => [text(offer.id ?? offer.offerId), offer]));
  const offersBySource = new Map();
  for (const offer of offers) {
    const sourceOfferId = text(offer.sourceOfferId ?? offer.id ?? offer.offerId);
    if (!offersBySource.has(sourceOfferId)) offersBySource.set(sourceOfferId, []);
    offersBySource.get(sourceOfferId).push(offer);
  }

  const overflowBySource = new Map();
  for (const line of usage) {
    const exact = offerById.get(line.offerId);
    const exactSource = text(exact?.sourceOfferId ?? exact?.id ?? exact?.offerId);
    const matchingExact = exact && exactSource === line.sourceOfferId;
    const applied = matchingExact ? Math.min(exact.stock, line.qty) : 0;
    if (matchingExact) {
      exact.stock -= applied;
      exact.reservedStock += applied;
    }
    const overflow = line.qty - applied;
    if (overflow > 0) overflowBySource.set(line.sourceOfferId, quantity(overflowBySource.get(line.sourceOfferId)) + overflow);
  }

  for (const [sourceOfferId, rawQty] of overflowBySource) {
    let remaining = quantity(rawQty);
    for (const offer of offersBySource.get(sourceOfferId) ?? []) {
      if (remaining <= 0) break;
      const applied = Math.min(offer.stock, remaining);
      offer.stock -= applied;
      offer.reservedStock += applied;
      remaining -= applied;
    }
  }
  return offers;
}

function liquiditySideOffer(offer = {}, side = "both") {
  if (side === "ask") {
    return { ...offer, bidDemand: 0, baseBidDemand: 0 };
  }
  if (side === "bid") {
    return {
      ...offer,
      askStock: 0,
      baseAskStock: 0,
      stock: 0,
      quotedStock: 0
    };
  }
  return offer;
}

function importReservationPrefix(operationId) {
  return `market-import:${JSON.stringify(text(operationId))}:`;
}

function importReleasePrefix(operationId) {
  return `market-import-release:${JSON.stringify(text(operationId))}:`;
}

function importReserveOperationId(operationId, index) {
  return `${importReservationPrefix(operationId)}${index + 1}:reserve`;
}

function importCommitOperationId(operationId, index) {
  return `${importReservationPrefix(operationId)}${index + 1}:commit`;
}

function importReservationId(operationId, index) {
  return `${importReservationPrefix(operationId)}${index + 1}`;
}

function importReleaseOperationId(parentOperationId, order = {}) {
  const orderId = text(order.operationId ?? order.id ?? order.cancellationOperationId) || "order";
  return `${importReleasePrefix(parentOperationId)}${JSON.stringify(orderId)}`;
}

function liquidityLineForKey(state, key) {
  return state.lines.find((line) => line.key === key) ?? null;
}

function quotePeriodParts(value = "") {
  const match = /^(tenday|utc):(-?\d+)$/.exec(text(value));
  if (!match) return null;
  return { family: match[1], index: Number(match[2]) };
}

function previousLiquidityLine(state, { marketId = "", quoteKey = "", offerId = "" } = {}) {
  const current = quotePeriodParts(quoteKey);
  const candidates = state.lines.filter((line) => (
    line.marketId === text(marketId)
      && line.offerId === text(offerId)
      && line.quoteKey !== text(quoteKey)
  ));
  if (!candidates.length) return null;
  if (current) {
    return candidates
      .map((line) => ({ line, period: quotePeriodParts(line.quoteKey) }))
      .filter((entry) => entry.period?.family === current.family && entry.period.index < current.index)
      .sort((left, right) => right.period.index - left.period.index)[0]?.line ?? null;
  }
  return candidates
    .filter((line) => line.quoteKey.localeCompare(text(quoteKey), "en") < 0)
    .sort((left, right) => right.quoteKey.localeCompare(left.quoteKey, "en"))[0] ?? null;
}

function partiallyRefilledBalance(previousAvailable, nextBase, refillRate = DEFAULT_PERIOD_REFILL_RATE) {
  const base = quantity(nextBase);
  const remaining = Math.min(base, quantity(previousAvailable));
  const rate = Math.max(0, Math.min(1, Number(refillRate) || 0));
  return Math.min(base, remaining + Math.ceil((base - remaining) * rate));
}

function ensureLiquidityQuoteLine({ state, marketId, quoteKey, offer = {}, initialAskStock, initialBidDemand } = {}) {
  const offerId = text(offer.id ?? offer.offerId);
  const quotedStock = quantity(offer.quotedStock ?? offer.stock ?? offer.askStock ?? offer.baseAskStock);
  const normalized = normalizeMarketLiquidityQuote({
    marketId,
    quoteKey,
    offerId,
    offer: {
      ...offer,
      askUnitCopper: offer.unitPriceCopper ?? offer.askUnitCopper ?? offer.basePriceCopper,
      askStock: initialAskStock ?? offer.askStock ?? offer.stock ?? quotedStock,
      baseAskStock: quotedStock
    }
  });
  let line = liquidityLineForKey(state, normalized.key);
  if (!line) {
    const previous = previousLiquidityLine(state, { marketId, quoteKey, offerId });
    const askStock = previous
      ? partiallyRefilledBalance(
        marketLiquidityAvailable({ state, key: previous.key, side: "ask" }),
        normalized.baseAskStock
      )
      : quantity(initialAskStock ?? normalized.askStock);
    const bidDemand = previous
      ? partiallyRefilledBalance(
        marketLiquidityAvailable({ state, key: previous.key, side: "bid" }),
        normalized.baseBidDemand
      )
      : quantity(initialBidDemand ?? normalized.bidDemand);
    line = {
      ...normalized,
      askStock: Math.min(askStock, quantity(initialAskStock ?? normalized.baseAskStock)),
      bidDemand: Math.min(bidDemand, quantity(initialBidDemand ?? normalized.baseBidDemand))
    };
    state.lines.push(line);
    state.lines.sort((left, right) => left.key.localeCompare(right.key));
  } else {
    line.askUnitCopper = normalized.askUnitCopper;
    line.bidUnitCopper = normalized.bidUnitCopper;
    line.baseAskStock = normalized.baseAskStock;
    line.baseBidDemand = normalized.baseBidDemand;
    line.askStock = Math.min(quantity(line.askStock), normalized.baseAskStock);
    line.bidDemand = Math.min(quantity(line.bidDemand), normalized.baseBidDemand);
  }
  return line;
}

function liquidityImportReservation(holding = {}, operationId = "") {
  const id = text(operationId);
  if (!id) return null;
  const state = readLiquidityState(holding);
  const prefix = importReservationPrefix(id);
  const reservations = state.reservations.filter((row) => row.side === "ask" && row.operationId.startsWith(prefix));
  if (!reservations.length) return null;
  reservations.sort((left, right) => left.operationId.localeCompare(right.operationId, undefined, { numeric: true }));
  const lines = reservations.map((row) => {
    const quoteLine = liquidityLineForKey(state, row.key);
    return {
      offerId: text(quoteLine?.offerId),
      sourceOfferId: text(quoteLine?.offerId),
      providerId: "",
      qty: quantity(row.quantity),
      committedQty: quantity(row.committedQuantity),
      reservationId: row.id,
      liquidityKey: row.key
    };
  }).filter((line) => line.offerId && line.qty > 0);
  const quoteLine = liquidityLineForKey(state, reservations[0].key);
  const releases = state.receipts.filter((receipt) => (
    receipt.action === "replenish" && receipt.operationId.startsWith(importReleasePrefix(id))
  )).map((receipt) => ({
    operationId: receipt.operationId,
    lines: (receipt.lines ?? []).map((line) => {
      const releasedLine = liquidityLineForKey(state, line.key);
      return {
        offerId: text(releasedLine?.offerId),
        sourceOfferId: text(releasedLine?.offerId),
        providerId: "",
        qty: quantity(line.askAdded),
        liquidityKey: line.key
      };
    }).filter((line) => line.offerId && line.qty > 0)
  }));
  return {
    operationId: id,
    marketId: text(quoteLine?.marketId),
    quoteKey: text(quoteLine?.quoteKey),
    lines,
    releases,
    ledger: "liquidity"
  };
}

export function marketStockReservationForOperation(holding = {}, operationId = "") {
  const id = text(operationId);
  if (!id) return null;
  const legacy = (marketState(holding)?.stockReservations ?? []).find((row) => text(row?.operationId) === id) ?? null;
  return legacy ?? liquidityImportReservation(holding, id);
}

export function applyMarketStockReservationsToQuote({ holding = {}, quote = {}, side = "both" } = {}) {
  const marketId = text(quote.marketId ?? "external-market");
  const quoteKey = text(quote.quoteKey);
  const liquiditySide = side === "ask" || side === "bid" ? side : "both";
  const projectedOffers = (quote.offers ?? []).map((offer) => liquiditySideOffer(offer, liquiditySide));
  const legacyOffers = legacyAdjustedOffers({
    holding,
    quote: { ...quote, marketId, quoteKey, offers: projectedOffers }
  });
  const state = readLiquidityState(holding);
  const offers = legacyOffers.map((offer) => {
    const line = ensureLiquidityQuoteLine({
      state,
      marketId,
      quoteKey,
      offer,
      initialAskStock: offer.stock,
      initialBidDemand: offer.bidDemand
    });
    const stock = marketLiquidityAvailable({ state, key: line.key, side: "ask" });
    const quotedStock = quantity(offer.quotedStock ?? offer.stock);
    return {
      ...offer,
      askUnitCopper: line.askUnitCopper,
      askStock: stock,
      baseAskStock: quotedStock,
      quotedStock,
      stock,
      reservedStock: Math.max(0, quotedStock - stock),
      bidDemand: marketLiquidityAvailable({ state, key: line.key, side: "bid" })
    };
  });
  writeLiquidityState(holding, state);
  return { ...quote, offers };
}

export function retainMarketStockReservations(reservations = [], { quoteKey = "", archiveLimit = 500 } = {}) {
  const rows = Array.isArray(reservations) ? reservations : [];
  const currentQuoteKey = text(quoteKey);
  const current = rows.filter((row) => currentQuoteKey && text(row?.quoteKey) === currentQuoteKey);
  const archive = rows.filter((row) => !currentQuoteKey || text(row?.quoteKey) !== currentQuoteKey);
  const retainedArchive = Math.max(0, Math.floor(Number(archiveLimit) || 0)) > 0
    ? archive.slice(-Math.max(0, Math.floor(Number(archiveLimit) || 0)))
    : [];
  return [...retainedArchive, ...current];
}

function reservationMatchesLines(reservation, { marketId, quoteKey, lines }) {
  if (text(reservation?.marketId) !== text(marketId) || text(reservation?.quoteKey) !== text(quoteKey)) return false;
  const existing = aggregateLines(reservation?.lines).map((line) => [line.offerId, line.qty]);
  const requested = aggregateLines(lines).map((line) => [line.offerId, line.qty]);
  return JSON.stringify(existing) === JSON.stringify(requested);
}

function stockFailure(result, state, line) {
  const key = marketLiquidityKey(line.marketId, line.quoteKey, line.offerId);
  const availableQty = marketLiquidityAvailable({ state, key, side: "ask" });
  return {
    ok: false,
    stale: result?.receipt?.reason === "insufficient-liquidity",
    conflict: result?.conflict === true,
    offerId: line.offerId,
    requestedQty: line.qty,
    availableQty,
    message: result?.conflict
      ? "Market stock operation id was already used for different cargo."
      : "Market stock changed before the order was confirmed."
  };
}

export function reserveMarketQuoteStock({ holding, plan = {}, operationId = "", createdAt = new Date().toISOString() } = {}) {
  if (!holding || typeof holding !== "object") return { ok: false, message: "Market stock reservation requires a holding." };
  const id = text(operationId);
  if (!id) return { ok: false, message: "Market stock reservation requires an operation id." };

  const marketId = text(plan.marketId ?? "external-market");
  const quoteKey = text(plan.quoteKey);
  if (!quoteKey) return { ok: false, message: "Market stock reservation requires a quote key." };
  const lines = aggregateLines(plan.lines);
  if (!lines.length) return { ok: false, message: "Market stock reservation requires at least one line." };
  const replay = marketStockReservationForOperation(holding, id);
  if (replay) {
    if (!reservationMatchesLines(replay, { marketId, quoteKey, lines })) {
      return { ok: false, replay: false, conflict: true, reservation: replay, message: "Market stock operation id was already used for different cargo." };
    }
    return { ok: true, replay: true, reservation: replay };
  }

  let state = readLiquidityState(holding);
  const legacyOffers = legacyAdjustedOffers({ holding, quote: { marketId, quoteKey, offers: plan.lines ?? [] } });
  const offerById = new Map((plan.lines ?? []).map((line) => [text(line?.id ?? line?.offerId), line]));
  const legacyOfferById = new Map(legacyOffers.map((line) => [text(line?.id ?? line?.offerId), line]));
  const staged = [];
  for (const [index, line] of lines.entries()) {
    const offer = offerById.get(line.offerId) ?? line;
    const legacyOffer = legacyOfferById.get(line.offerId);
    const quoteLine = ensureLiquidityQuoteLine({
      state,
      marketId,
      quoteKey,
      offer,
      initialAskStock: legacyOffer?.stock ?? offer.stock
    });
    const reservationId = importReservationId(id, index);
    const reserved = reserveMarketAskStock({
      state,
      quote: quoteLine,
      quantity: line.qty,
      operationId: importReserveOperationId(id, index),
      reservationId,
      allowPartial: false
    });
    if (!reserved.ok) return stockFailure(reserved, state, { ...line, marketId, quoteKey });
    state = reserved.state;
    staged.push({ index, line, reservationId });
  }

  for (const entry of staged) {
    const committed = commitMarketAskStock({
      state,
      reservationId: entry.reservationId,
      quantity: entry.line.qty,
      operationId: importCommitOperationId(id, entry.index)
    });
    if (!committed.ok) return stockFailure(committed, state, { ...entry.line, marketId, quoteKey });
    state = committed.state;
  }

  writeLiquidityState(holding, state);
  const reservation = liquidityImportReservation(holding, id) ?? {
    operationId: id,
    marketId,
    quoteKey,
    createdAt: text(createdAt),
    lines,
    releases: [],
    ledger: "liquidity"
  };
  reservation.createdAt = text(createdAt);
  return { ok: true, replay: false, reservation };
}

function releasedByParent(state, parentOperationId) {
  const released = new Map();
  const prefix = importReleasePrefix(parentOperationId);
  for (const receipt of state.receipts) {
    if (receipt.action !== "replenish" || !receipt.operationId.startsWith(prefix)) continue;
    for (const line of receipt.lines ?? []) {
      released.set(line.key, quantity(released.get(line.key)) + quantity(line.askAdded));
    }
  }
  return released;
}

function liquidityReleaseSchedule({ state, reservation, order }) {
  const committedByKey = new Map();
  for (const line of reservation.lines ?? []) {
    const key = text(line.liquidityKey) || marketLiquidityKey(reservation.marketId, reservation.quoteKey, line.offerId);
    committedByKey.set(key, quantity(committedByKey.get(key)) + quantity(line.committedQty ?? line.qty));
  }
  const previouslyReleased = releasedByParent(state, reservation.operationId);
  const remainingByKey = new Map([...committedByKey].map(([key, qty]) => [key, Math.max(0, qty - quantity(previouslyReleased.get(key)))]));
  const schedule = [];
  for (const line of aggregateLines(order.lines)) {
    const key = marketLiquidityKey(reservation.marketId, reservation.quoteKey, line.offerId);
    const askReplenish = Math.min(line.qty, quantity(remainingByKey.get(key)));
    remainingByKey.set(key, Math.max(0, quantity(remainingByKey.get(key)) - askReplenish));
    if (askReplenish > 0) schedule.push({ key, askReplenish });
  }
  return schedule;
}

function liquidityReleaseFromReceipt(state, receipt, { requestedOperationId = "", releasedAt = "" } = {}) {
  const lines = (receipt?.lines ?? []).map((line) => {
    const quoteLine = liquidityLineForKey(state, line.key);
    return {
      offerId: text(quoteLine?.offerId),
      sourceOfferId: text(quoteLine?.offerId),
      providerId: "",
      qty: quantity(line.askAdded),
      liquidityKey: line.key
    };
  }).filter((line) => line.offerId && line.qty > 0);
  return {
    operationId: text(receipt?.operationId),
    requestedOperationId: text(requestedOperationId),
    releasedAt: text(releasedAt),
    lines
  };
}

function releaseLegacyReservation({ holding, reservation, order, operationId, releasedAt }) {
  if (!Array.isArray(reservation.releases)) reservation.releases = [];
  const replay = reservation.releases.find((row) => text(row?.operationId) === operationId);
  if (replay) return { ok: true, replay: true, released: false, reservation, release: replay };

  const remainingByKey = new Map(legacyReservationUsage(holding, reservation.marketId, reservation.quoteKey).map((line) => [`${line.offerId}\u001f${line.sourceOfferId}`, line.qty]));
  const lines = aggregateLines(order.lines).map((line) => {
    const key = `${line.offerId}\u001f${line.sourceOfferId}`;
    const qty = Math.min(line.qty, quantity(remainingByKey.get(key)));
    remainingByKey.set(key, Math.max(0, quantity(remainingByKey.get(key)) - qty));
    return { ...line, qty };
  }).filter((line) => line.qty > 0);
  if (!lines.length) return { ok: true, replay: false, released: false, reservation };

  const state = readLiquidityState(holding);
  const schedule = lines.map((line) => ({
    key: marketLiquidityKey(reservation.marketId, reservation.quoteKey, line.offerId),
    askReplenish: line.qty
  })).filter((line) => liquidityLineForKey(state, line.key));
  let nextState = state;
  if (schedule.length) {
    const replenished = replenishMarketLiquidity({
      state,
      operationId: importReleaseOperationId(reservation.operationId, order),
      lines: schedule
    });
    if (!replenished.ok) return { ok: false, released: false, message: replenished.message || "Legacy stock restoration failed." };
    nextState = replenished.state;
  }
  const release = { operationId, releasedAt: text(releasedAt), lines };
  reservation.releases.push(release);
  if (schedule.length) writeLiquidityState(holding, nextState);
  return { ok: true, replay: false, released: true, reservation, release };
}

export function releaseMarketQuoteStock({ holding, order = {}, operationId = "", releasedAt = new Date().toISOString() } = {}) {
  if (text(order?.status) !== "cancelled" || text(order?.dispatchedAt)) {
    return { ok: false, released: false, message: "Only a cancelled, undispatched order can restore market stock." };
  }
  const parentOperationId = text(order?.parentOperationId ?? order?.operationId ?? order?.id);
  const reservation = marketStockReservationForOperation(holding, parentOperationId);
  if (!reservation) return { ok: true, released: false, legacy: true };
  const id = text(operationId ?? order?.cancellationOperationId ?? `${order?.operationId || order?.id}:stock-release`);
  if (!id) return { ok: false, released: false, message: "Market stock release requires an operation id." };
  if (reservation.ledger !== "liquidity") {
    return releaseLegacyReservation({ holding, reservation, order, operationId: id, releasedAt });
  }

  const state = readLiquidityState(holding);
  const releaseOperationId = importReleaseOperationId(parentOperationId, order);
  const existingReceipt = state.receipts.find((receipt) => receipt.operationId === releaseOperationId && receipt.action === "replenish") ?? null;
  if (existingReceipt) {
    return {
      ok: true,
      replay: true,
      released: false,
      reservation,
      release: liquidityReleaseFromReceipt(state, existingReceipt, { requestedOperationId: id, releasedAt })
    };
  }
  const schedule = liquidityReleaseSchedule({ state, reservation, order });
  if (!schedule.length) return { ok: true, replay: false, released: false, reservation };
  const replenished = replenishMarketLiquidity({ state, operationId: releaseOperationId, lines: schedule });
  if (!replenished.ok) {
    return {
      ok: false,
      released: false,
      conflict: replenished.conflict === true,
      message: replenished.message || "Market stock restoration failed."
    };
  }
  if (!replenished.replay) writeLiquidityState(holding, replenished.state);
  const release = liquidityReleaseFromReceipt(replenished.state, replenished.receipt, { requestedOperationId: id, releasedAt });
  return {
    ok: true,
    replay: replenished.replay === true,
    released: replenished.replay !== true && release.lines.length > 0,
    reservation: liquidityImportReservation(holding, parentOperationId) ?? reservation,
    release
  };
}
