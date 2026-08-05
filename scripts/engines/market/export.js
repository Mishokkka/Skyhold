const EXPORT_VERSION = 1;
const EXPORT_CASH_TIMING_VERSION = 2;
const EPSILON = 0.000001;
const TERMINAL_STATUSES = new Set(["delivered", "lost", "cancelled"]);

function text(value = "") {
  return String(value ?? "").trim();
}

function cloneJson(value, fallback = null) {
  if (value === undefined) return fallback;
  return JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function whole(value, { minimum = 0, fallback = null } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= minimum ? numeric : null;
}

function finiteNonNegative(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : Math.max(0, Number(fallback) || 0);
}

function storageRowKey(rowId = "", rowIndex = -1) {
  return text(rowId) || `#${Math.max(0, Math.floor(Number(rowIndex) || 0))}`;
}

function sourceRowKey(source = {}) {
  return storageRowKey(source.storageRowId, source.storageRowIndex);
}

function requireBook(book) {
  if (!book || typeof book !== "object") throw new TypeError("Market export requires a JSON export book.");
  if (!Array.isArray(book.orders)) book.orders = [];
  if (!Number.isInteger(Number(book.version))) book.version = EXPORT_VERSION;
  return book;
}

function requireHolding(holding) {
  if (!holding || typeof holding !== "object") throw new TypeError("Market export requires a holding.");
  if (!holding.storage || typeof holding.storage !== "object") {
    holding.storage = { resources: [], items: [], moneyCopper: 0, log: [] };
  }
  if (!Array.isArray(holding.storage.resources)) holding.storage.resources = [];
  if (!Array.isArray(holding.storage.log)) holding.storage.log = [];
  return holding;
}

function requireDemandAdapter(dependencies = {}) {
  const demand = dependencies?.demand;
  for (const method of ["available", "reserve", "release", "consume"]) {
    if (typeof demand?.[method] !== "function") {
      throw new TypeError(`Market export requires dependencies.demand.${method}().`);
    }
  }
  return demand;
}

function operationUse(book, operationId = "") {
  const id = text(operationId);
  if (!id) return null;
  for (const order of book?.orders ?? []) {
    const stages = [
      ["prepare", order?.operationId],
      ["dispatch", order?.dispatchOperationId],
      ["cancel", order?.cancellationOperationId],
      ["deliver", order?.deliveryOperationId],
      ["loss", order?.lossOperationId]
    ];
    for (const [stage, value] of stages) {
      if (text(value) === id) return { order, stage };
    }
  }
  return null;
}

function conflict(code, message, extra = {}) {
  return { ok: false, conflict: true, code, message, ...extra };
}

function orderById(book, orderId = "") {
  const id = text(orderId);
  return (book?.orders ?? []).find((order) => [order?.id, order?.operationId].some((value) => text(value) === id)) ?? null;
}

function cargoRequests(cargo = []) {
  const grouped = new Map();
  for (const [index, raw] of (Array.isArray(cargo) ? cargo : []).entries()) {
    const qty = whole(raw?.qty ?? raw?.quantity, { minimum: 1 });
    if (qty === null) {
      return { ok: false, code: "fractional-cargo", message: "Market export accepts only positive whole cargo quantities." };
    }
    const storageRowId = text(raw?.storageRowId ?? raw?.rowId);
    const storageRowIndex = whole(raw?.storageRowIndex ?? raw?.rowIndex, { minimum: 0, fallback: -1 });
    if (!storageRowId && storageRowIndex < 0) {
      return { ok: false, code: "missing-storage-source", message: `Cargo line ${index + 1} must identify one concrete storage row.` };
    }
    const key = storageRowKey(storageRowId, storageRowIndex);
    const current = grouped.get(key) ?? { storageRowId, storageRowIndex, qty: 0 };
    current.qty += qty;
    grouped.set(key, current);
  }
  const rows = [...grouped.values()].sort((left, right) => (
    storageRowKey(left.storageRowId, left.storageRowIndex)
      .localeCompare(storageRowKey(right.storageRowId, right.storageRowIndex), "en")
  ));
  if (!rows.length) return { ok: false, code: "empty-cargo", message: "Market export requires cargo." };
  return { ok: true, rows, qty: rows.reduce((sum, row) => sum + row.qty, 0) };
}

function exactCopper(value, label, fallback = 0) {
  const parsed = whole(value, { minimum: 0, fallback });
  if (parsed === null) throw new TypeError(`${label} must be a non-negative whole copper amount.`);
  return parsed;
}

function quoteCosts(quote = {}, { customs = true } = {}) {
  const costs = {
    freightCopper: exactCopper(quote?.costs?.freightCopper, "Export freight", 0),
    taxCopper: customs ? exactCopper(quote?.costs?.taxCopper, "Export tax", 0) : 0,
    insuranceCopper: exactCopper(quote?.costs?.insuranceCopper, "Export insurance", 0),
    otherCopper: exactCopper(quote?.costs?.otherCopper, "Export other costs", 0)
  };
  costs.totalCopper = costs.freightCopper + costs.taxCopper + costs.insuranceCopper + costs.otherCopper;
  return costs;
}

function upfrontCostsFrom(costs = {}) {
  return exactCopper(costs?.freightCopper, "Export freight", 0)
    + exactCopper(costs?.insuranceCopper, "Export insurance", 0)
    + exactCopper(costs?.otherCopper, "Export other costs", 0);
}

function orderCashTiming(order = {}, quote = {}) {
  const costs = quoteCosts(quote);
  const upfrontCostsCopper = upfrontCostsFrom(costs);
  const version = whole(order?.accounting?.cashTimingVersion ?? order?.cashTimingVersion, { minimum: 1, fallback: 1 }) ?? 1;
  const recordedPaid = whole(
    order?.accounting?.upfrontCostsPaidCopper ?? order?.upfrontCostsPaidCopper,
    { minimum: 0, fallback: 0 }
  ) ?? 0;
  const upfrontCostsPaidCopper = version >= EXPORT_CASH_TIMING_VERSION
    ? Math.min(upfrontCostsCopper, recordedPaid)
    : 0;
  return {
    cashTimingVersion: version,
    upfrontCostsCopper,
    upfrontCostsPaidCopper,
    unpaidUpfrontCostsCopper: Math.max(0, upfrontCostsCopper - upfrontCostsPaidCopper)
  };
}

function normalizedOtherCosts(quote = {}) {
  const costs = (Array.isArray(quote?.otherCosts) ? quote.otherCosts : []).map((row, index) => ({
    id: text(row?.id) || `other-${index + 1}`,
    label: text(row?.label ?? row?.name) || `Other cost ${index + 1}`,
    copper: exactCopper(row?.copper ?? row?.amountCopper ?? row?.costCopper, "Other export cost")
  })).filter((row) => row.copper > 0);
  const scalar = exactCopper(quote?.otherCostsCopper, "Other export costs", 0);
  if (scalar > 0) costs.push({ id: "other-total", label: "Other costs", copper: scalar });
  return costs;
}

function normalizeQuote(quote = {}, totalQty = 0) {
  try {
    const marketRaw = quote?.market && typeof quote.market === "object" ? quote.market : {};
    const offerRaw = quote?.offer && typeof quote.offer === "object" ? quote.offer : {};
    const marketId = text(marketRaw?.id ?? quote?.marketId);
    const quoteKey = text(marketRaw?.quoteKey ?? quote?.quoteKey);
    const offerId = text(offerRaw?.id ?? quote?.offerId);
    const resourceId = text(offerRaw?.resourceId ?? quote?.resourceId);
    if (!marketId || !quoteKey || !offerId || !resourceId) {
      return { ok: false, code: "incomplete-quote", message: "Export quote requires marketId, quoteKey, offerId and resourceId." };
    }
    const bidDemand = whole(offerRaw?.bidDemand ?? quote?.bidDemand, { minimum: 1 });
    if (bidDemand === null) return { ok: false, code: "invalid-bid-demand", message: "Export bid demand must be a positive whole quantity." };
    const unitBidCopper = exactCopper(
      quote?.bid?.unitCopper ?? quote?.bidCopperPerUnit ?? quote?.unitBidCopper ?? offerRaw?.unitBidCopper,
      "Export unit bid"
    );
    const unitCargoPoints = whole(
      quote?.cargoPoints?.unit ?? quote?.unitCargoPoints ?? offerRaw?.unitCargoPoints ?? offerRaw?.cargoPoints,
      { minimum: 1 }
    );
    if (unitCargoPoints === null) return { ok: false, code: "invalid-cargo-points", message: "Export quote requires positive whole cargo points per unit." };

    const freightRaw = quote?.freight && typeof quote.freight === "object" ? cloneJson(quote.freight, {}) : {};
    const taxRaw = quote?.tax && typeof quote.tax === "object" ? cloneJson(quote.tax, {}) : {};
    const riskRaw = quote?.risk && typeof quote.risk === "object" ? cloneJson(quote.risk, {}) : {};
    const insuranceRaw = quote?.insurance && typeof quote.insurance === "object" ? cloneJson(quote.insurance, {}) : {};
    const freightCopper = exactCopper(freightRaw?.copper ?? quote?.freightCopper, "Export freight", 0);
    const taxCopper = exactCopper(taxRaw?.copper ?? quote?.taxCopper, "Export tax", 0);
    const insuranceCopper = exactCopper(
      insuranceRaw?.premiumCopper ?? riskRaw?.insurancePremiumCopper ?? quote?.insuranceCopper,
      "Export insurance premium",
      0
    );
    const explicitPayoutValue = insuranceRaw?.payoutCopper ?? riskRaw?.insurancePayoutCopper ?? quote?.insurancePayoutCopper;
    const explicitInsurancePayout = explicitPayoutValue !== undefined && explicitPayoutValue !== null && explicitPayoutValue !== "";
    const insurancePayoutCopper = explicitInsurancePayout
      ? exactCopper(explicitPayoutValue, "Export insurance payout")
      : 0;
    const otherCosts = normalizedOtherCosts(quote);
    const otherCopper = otherCosts.reduce((sum, row) => sum + row.copper, 0);
    const grossCopper = totalQty * unitBidCopper;
    const totalCostCopper = freightCopper + taxCopper + insuranceCopper + otherCopper;
    const demandKey = text(quote?.demandKey) || `${marketId}\u001f${offerId}\u001f${quoteKey}`;
    const route = cloneJson(quote?.route ?? {}, {});
    const snapshot = {
      version: EXPORT_VERSION,
      demandKey,
      market: {
        ...cloneJson(marketRaw, {}),
        id: marketId,
        label: text(marketRaw?.label ?? quote?.marketLabel),
        quoteKey
      },
      offer: {
        ...cloneJson(offerRaw, {}),
        id: offerId,
        resourceId,
        name: text(offerRaw?.name ?? quote?.offerName ?? resourceId),
        providerId: text(offerRaw?.providerId ?? quote?.providerId),
        providerLabel: text(offerRaw?.providerLabel ?? quote?.providerLabel),
        bidDemand
      },
      route,
      cargoPoints: { unit: unitCargoPoints, total: totalQty * unitCargoPoints },
      bid: { unitCopper: unitBidCopper, grossCopper, currency: "copper" },
      freight: { ...freightRaw, copper: freightCopper },
      tax: {
        ...taxRaw,
        copper: taxCopper,
        rate: finiteNonNegative(taxRaw?.rate ?? quote?.taxRate, 0)
      },
      risk: {
        ...riskRaw,
        insurancePayoutCopper,
        explicitInsurancePayout
      },
      insurance: {
        ...insuranceRaw,
        premiumCopper: insuranceCopper,
        payoutCopper: insurancePayoutCopper,
        explicitPayout: explicitInsurancePayout
      },
      otherCosts,
      costs: {
        freightCopper,
        taxCopper,
        insuranceCopper,
        otherCopper,
        totalCopper: totalCostCopper
      },
      projectedNetCopper: grossCopper - totalCostCopper
    };
    return { ok: true, snapshot };
  } catch (error) {
    return { ok: false, code: "invalid-quote", message: String(error?.message ?? error) };
  }
}

function rowFromRequest(resources = [], request = {}) {
  const requestedId = text(request?.storageRowId);
  const requestedIndex = Number(request?.storageRowIndex);
  if (requestedId) {
    const index = resources.findIndex((row) => text(row?.id) === requestedId);
    if (index < 0) return { row: null, index: -1 };
    if (Number.isInteger(requestedIndex) && requestedIndex >= 0 && resources[requestedIndex] && text(resources[requestedIndex]?.id) !== requestedId) {
      return { row: null, index: -1, staleSelector: true };
    }
    return { row: resources[index], index };
  }
  if (Number.isInteger(requestedIndex) && requestedIndex >= 0 && requestedIndex < resources.length) {
    return { row: resources[requestedIndex], index: requestedIndex };
  }
  return { row: null, index: -1 };
}

function activeStorageReservations(book, excludedOrderId = "") {
  const rows = new Map();
  for (const order of book?.orders ?? []) {
    if (text(order?.id) === text(excludedOrderId) || String(order?.status ?? "") !== "reserved") continue;
    for (const source of order?.sources ?? []) {
      const key = sourceRowKey(source);
      const current = rows.get(key) ?? { qty: 0, untrackedQty: 0, lots: new Map() };
      current.qty += finiteNonNegative(source?.qty, 0);
      current.untrackedQty += finiteNonNegative(source?.untrackedQty, 0);
      for (const lot of source?.lots ?? []) {
        const lotId = text(lot?.id);
        if (lotId) current.lots.set(lotId, finiteNonNegative(current.lots.get(lotId), 0) + finiteNonNegative(lot?.qty, 0));
      }
      rows.set(key, current);
    }
  }
  return rows;
}

function reserveConcreteSources({ holding, book, requests, resourceId }) {
  const usage = activeStorageReservations(book);
  const resources = holding.storage.resources;
  const sources = [];
  for (const request of requests) {
    const resolved = rowFromRequest(resources, request);
    if (!resolved.row) {
      return { ok: false, stale: true, code: "missing-storage-row", message: "A selected storage row no longer exists." };
    }
    const row = resolved.row;
    const rowResourceId = text(row?.resourceId ?? row?.id);
    if (rowResourceId !== resourceId) {
      return { ok: false, code: "wrong-resource", message: "A selected storage row does not match the quoted resource." };
    }
    const rowId = text(row?.id);
    const key = storageRowKey(rowId, resolved.index);
    const used = usage.get(key) ?? { qty: 0, untrackedQty: 0, lots: new Map() };
    const rowQty = finiteNonNegative(row?.qty, 0);
    const totalAvailable = rowQty - used.qty;
    if (totalAvailable + EPSILON < request.qty) {
      return {
        ok: false,
        stale: true,
        code: "insufficient-storage-stock",
        requestedQty: request.qty,
        availableQty: Math.max(0, Math.floor(totalAvailable + EPSILON)),
        storageRowId: rowId,
        message: "Reserved or current settlement stock is insufficient for this export."
      };
    }

    let remaining = request.qty;
    const selectedLots = [];
    const lots = (Array.isArray(row?.lots) ? row.lots : [])
      .map((lot, index) => ({ ...cloneJson(lot, {}), storageLotIndex: index }))
      .filter((lot) => text(lot?.id) && finiteNonNegative(lot?.qty, 0) > EPSILON)
      .sort((left, right) => (
        finiteNonNegative(left?.receivedQd, 0) - finiteNonNegative(right?.receivedQd, 0)
        || text(left?.id).localeCompare(text(right?.id), "en")
      ));
    for (const lot of lots) {
      if (remaining <= EPSILON) break;
      const available = Math.max(0, finiteNonNegative(lot?.qty, 0) - finiteNonNegative(used.lots.get(text(lot?.id)), 0));
      const take = Math.min(available, remaining);
      if (take > EPSILON) selectedLots.push({ ...lot, qty: take });
      remaining = Math.max(0, remaining - take);
    }
    const trackedQty = lots.reduce((sum, lot) => sum + finiteNonNegative(lot?.qty, 0), 0);
    const currentUntrackedQty = Math.max(0, rowQty - trackedQty);
    const availableUntrackedQty = Math.max(0, currentUntrackedQty - used.untrackedQty);
    const untrackedQty = Math.min(availableUntrackedQty, remaining);
    remaining = Math.max(0, remaining - untrackedQty);
    if (remaining > EPSILON) {
      return {
        ok: false,
        stale: true,
        code: "insufficient-concrete-lots",
        requestedQty: request.qty,
        availableQty: request.qty - remaining,
        storageRowId: rowId,
        message: "Concrete storage lots are no longer sufficient for this export."
      };
    }
    const source = {
      storageRowId: rowId,
      storageRowIndex: resolved.index,
      resourceId: rowResourceId,
      name: text(row?.name ?? row?.label ?? rowResourceId),
      roomId: text(row?.roomId ?? row?.storageRoomId) || "outdoors",
      unit: text(row?.unit) || "ед.",
      weight: row?.weight ?? "",
      qty: request.qty,
      lots: selectedLots,
      untrackedQty
    };
    sources.push(source);
    const next = usage.get(key) ?? { qty: 0, untrackedQty: 0, lots: new Map() };
    next.qty += request.qty;
    next.untrackedQty += untrackedQty;
    for (const lot of selectedLots) next.lots.set(text(lot.id), finiteNonNegative(next.lots.get(text(lot.id)), 0) + lot.qty);
    usage.set(key, next);
  }
  return { ok: true, sources };
}

function demandAvailability(demand, payload) {
  const result = demand.available(payload);
  if (typeof result === "number") return { ok: true, availableQty: Math.max(0, Math.floor(result)) };
  if (!result || result.ok === false) return { ok: false, ...(result ?? {}), message: result?.message || "External bid demand is unavailable." };
  return { ...result, ok: true, availableQty: Math.max(0, Math.floor(Number(result.availableQty) || 0)) };
}

function demandTransition(demand, method, payload) {
  const result = demand[method](payload);
  if (!result || result.ok !== true) {
    return { ok: false, ...(result ?? {}), message: result?.message || `External demand ${method} failed.` };
  }
  return result;
}

function prepareFingerprint(quoteSnapshot, requests) {
  return stableJson({
    quote: quoteSnapshot,
    cargo: requests.map((row) => ({
      storageRowId: text(row.storageRowId),
      storageRowIndex: Number(row.storageRowIndex),
      qty: row.qty
    }))
  });
}

export function marketExportOrder(book, orderId = "") {
  return orderById(book, orderId);
}

export function retainMarketExportOrders(orders = [], archiveLimit = 300) {
  const rows = Array.isArray(orders) ? orders : [];
  const limit = Math.max(0, Math.floor(Number(archiveLimit) || 0));
  const terminal = rows.filter((order) => TERMINAL_STATUSES.has(String(order?.status ?? "")));
  const keepTerminal = new Set(limit > 0 ? terminal.slice(-limit) : []);
  return rows.filter((order) => !TERMINAL_STATUSES.has(String(order?.status ?? "")) || keepTerminal.has(order));
}

export function prepareMarketExport({
  holding,
  book,
  quote = {},
  cargo = [],
  operationId = "",
  preparedAt = "",
  dependencies = {}
} = {}) {
  requireHolding(holding);
  requireBook(book);
  const demand = requireDemandAdapter(dependencies);
  const id = text(operationId);
  if (!id) return { ok: false, code: "missing-operation-id", message: "Market export preparation requires operationId." };
  const requests = cargoRequests(cargo);
  if (!requests.ok) return requests;
  const normalizedQuote = normalizeQuote(quote, requests.qty);
  if (!normalizedQuote.ok) return normalizedQuote;
  const fingerprint = prepareFingerprint(normalizedQuote.snapshot, requests.rows);
  const priorUse = operationUse(book, id);
  if (priorUse) {
    if (priorUse.stage === "prepare" && priorUse.order?.requestFingerprint === fingerprint) {
      return { ok: true, replay: true, order: cloneJson(priorUse.order) };
    }
    return conflict("operation-id-conflict", "This operationId already belongs to a different export operation.", {
      stage: priorUse.stage,
      orderId: priorUse.order?.id
    });
  }
  if (requests.qty > normalizedQuote.snapshot.offer.bidDemand) {
    return {
      ok: false,
      stale: true,
      code: "insufficient-bid-demand",
      requestedQty: requests.qty,
      availableQty: normalizedQuote.snapshot.offer.bidDemand,
      message: "Requested cargo exceeds the finite quoted bid demand."
    };
  }
  const availabilityPayload = {
    demandKey: normalizedQuote.snapshot.demandKey,
    marketId: normalizedQuote.snapshot.market.id,
    offerId: normalizedQuote.snapshot.offer.id,
    quoteKey: normalizedQuote.snapshot.market.quoteKey,
    quotedDemand: normalizedQuote.snapshot.offer.bidDemand,
    operationId: id
  };
  const availability = demandAvailability(demand, availabilityPayload);
  if (!availability.ok) return availability;
  if (availability.availableQty < requests.qty) {
    return {
      ok: false,
      stale: true,
      code: "insufficient-bid-demand",
      requestedQty: requests.qty,
      availableQty: availability.availableQty,
      message: "External bid demand changed before export preparation."
    };
  }
  const concrete = reserveConcreteSources({
    holding,
    book,
    requests: requests.rows,
    resourceId: normalizedQuote.snapshot.offer.resourceId
  });
  if (!concrete.ok) return concrete;

  const order = {
    version: EXPORT_VERSION,
    id,
    operationId: id,
    requestFingerprint: fingerprint,
    status: "reserved",
    preparedAt: text(preparedAt),
    dispatchedAt: "",
    deliveredAt: "",
    lostAt: "",
    cancelledAt: "",
    dispatchOperationId: "",
    deliveryOperationId: "",
    lossOperationId: "",
    cancellationOperationId: "",
    qty: requests.qty,
    demand: {
      key: normalizedQuote.snapshot.demandKey,
      quotedQty: normalizedQuote.snapshot.offer.bidDemand,
      reservedQty: requests.qty,
      status: "reserved"
    },
    quoteSnapshot: normalizedQuote.snapshot,
    sources: concrete.sources,
    cargoSnapshot: null,
    settlement: null,
    cashTimingVersion: EXPORT_CASH_TIMING_VERSION,
    upfrontCostsCopper: normalizedQuote.snapshot.costs.freightCopper
      + normalizedQuote.snapshot.costs.insuranceCopper
      + normalizedQuote.snapshot.costs.otherCopper,
    upfrontCostsPaidCopper: 0,
    accounting: {
      cashTimingVersion: EXPORT_CASH_TIMING_VERSION,
      upfrontCostsCopper: normalizedQuote.snapshot.costs.freightCopper
        + normalizedQuote.snapshot.costs.insuranceCopper
        + normalizedQuote.snapshot.costs.otherCopper,
      upfrontCostsPaidCopper: 0,
      dispatchCashDeltaCopper: 0,
      dispatchOperationId: "",
      dispatchedAt: ""
    }
  };
  const demandReservation = demandTransition(demand, "reserve", {
    ...availabilityPayload,
    qty: requests.qty,
    order: cloneJson(order)
  });
  if (!demandReservation.ok) return demandReservation;
  book.orders.push(order);
  return { ok: true, replay: false, order: cloneJson(order), demandReservation: cloneJson(demandReservation) };
}

function sourceOnDraft(resources = [], source = {}) {
  const resolved = rowFromRequest(resources, source);
  if (!resolved.row) return { ok: false, stale: true, code: "missing-storage-row", message: "A reserved storage row no longer exists." };
  const row = resolved.row;
  if (text(row?.resourceId ?? row?.id) !== text(source?.resourceId)) {
    return { ok: false, stale: true, code: "changed-storage-row", message: "A reserved storage row now contains another resource." };
  }
  const rowQty = finiteNonNegative(row?.qty, 0);
  if (rowQty + EPSILON < finiteNonNegative(source?.qty, 0)) {
    return { ok: false, stale: true, code: "insufficient-storage-stock", message: "Reserved settlement goods are no longer present." };
  }
  const lots = Array.isArray(row?.lots) ? row.lots.map((lot) => ({ ...cloneJson(lot, {}) })) : [];
  const trackedQty = lots.reduce((sum, lot) => sum + finiteNonNegative(lot?.qty, 0), 0);
  const untrackedQty = Math.max(0, rowQty - trackedQty);
  if (untrackedQty + EPSILON < finiteNonNegative(source?.untrackedQty, 0)) {
    return { ok: false, stale: true, code: "changed-storage-lots", message: "The untracked part of a reserved storage row changed." };
  }
  for (const reservedLot of source?.lots ?? []) {
    const lotId = text(reservedLot?.id);
    const index = lots.findIndex((lot) => text(lot?.id) === lotId);
    if (index < 0 || finiteNonNegative(lots[index]?.qty, 0) + EPSILON < finiteNonNegative(reservedLot?.qty, 0)) {
      return { ok: false, stale: true, code: "changed-storage-lots", lotId, message: "A concrete reserved storage lot changed before dispatch." };
    }
    lots[index].qty = Math.max(0, finiteNonNegative(lots[index].qty, 0) - finiteNonNegative(reservedLot.qty, 0));
  }
  row.qty = Math.max(0, rowQty - finiteNonNegative(source?.qty, 0));
  const remainingLots = lots.filter((lot) => finiteNonNegative(lot?.qty, 0) > EPSILON);
  if (remainingLots.length) row.lots = remainingLots;
  else delete row.lots;
  return { ok: true };
}

export function dispatchMarketExport({
  holding,
  book,
  orderId = "",
  operationId = "",
  dispatchedAt = ""
} = {}) {
  requireHolding(holding);
  requireBook(book);
  const order = orderById(book, orderId);
  if (!order) return { ok: false, code: "missing-order", message: "Market export order was not found." };
  const id = text(operationId);
  if (!id) return { ok: false, code: "missing-operation-id", message: "Market export dispatch requires operationId." };
  const priorUse = operationUse(book, id);
  if (priorUse) {
    if (priorUse.order === order && priorUse.stage === "dispatch") {
      return {
        ok: true,
        replay: true,
        order: cloneJson(order),
        cargoSnapshot: cloneJson(order?.cargoSnapshot),
        upfrontCostsCopper: whole(order?.upfrontCostsPaidCopper, { minimum: 0, fallback: 0 }) ?? 0,
        cashDeltaCopper: 0
      };
    }
    return conflict("operation-id-conflict", "This operationId already belongs to another export stage.", { stage: priorUse.stage, orderId: priorUse.order?.id });
  }
  if (String(order.status ?? "") !== "reserved" || text(order.dispatchedAt)) {
    return conflict("not-dispatchable", "Only a reserved, undispatched export can be dispatched.", { order: cloneJson(order) });
  }

  const draftResources = cloneJson(holding.storage.resources, []);
  for (const source of order.sources ?? []) {
    const applied = sourceOnDraft(draftResources, source);
    if (!applied.ok) return applied;
  }
  const quote = order.quoteSnapshot;
  const costs = quoteCosts(quote);
  const upfrontCostsCopper = upfrontCostsFrom(costs);
  const cashDeltaCopper = -upfrontCostsCopper;
  const money = moneyPreflight(holding, id, cashDeltaCopper, "market-export-dispatch", order?.id);
  if (!money.ok) return money;
  const cargoSnapshot = {
    version: EXPORT_VERSION,
    offerId: text(quote?.offer?.id),
    resourceId: text(quote?.offer?.resourceId),
    name: text(quote?.offer?.name),
    qty: whole(order?.qty, { minimum: 0, fallback: 0 }),
    cargoPoints: whole(quote?.cargoPoints?.total, { minimum: 0, fallback: 0 }),
    sources: cloneJson(order.sources, [])
  };
  // Every failure-prone cargo and treasury check is complete before either
  // balance is committed. The following writes form one synchronous dispatch.
  holding.storage.resources = draftResources;
  applyMoneyResolution(holding, money, {
    operationId: id,
    resolvedAt: dispatchedAt,
    kind: "market-export-dispatch",
    deltaCopper: cashDeltaCopper,
    order,
    note: `Export dispatched; freight, insurance and voyage costs paid ${upfrontCostsCopper}. Customs remains due only on delivery.`
  });
  order.status = "in-transit";
  order.dispatchedAt = text(dispatchedAt);
  order.dispatchOperationId = id;
  order.cargoSnapshot = cargoSnapshot;
  order.cashTimingVersion = EXPORT_CASH_TIMING_VERSION;
  order.upfrontCostsCopper = upfrontCostsCopper;
  order.upfrontCostsPaidCopper = upfrontCostsCopper;
  order.accounting = {
    ...(order.accounting && typeof order.accounting === "object" ? order.accounting : {}),
    cashTimingVersion: EXPORT_CASH_TIMING_VERSION,
    upfrontCostsCopper,
    upfrontCostsPaidCopper: upfrontCostsCopper,
    dispatchCashDeltaCopper: cashDeltaCopper,
    dispatchOperationId: id,
    dispatchedAt: text(dispatchedAt)
  };
  return {
    ok: true,
    replay: false,
    order: cloneJson(order),
    cargoSnapshot: cloneJson(cargoSnapshot),
    upfrontCostsCopper,
    cashDeltaCopper
  };
}

export function cancelMarketExport({
  book,
  orderId = "",
  operationId = "",
  cancelledAt = "",
  dependencies = {}
} = {}) {
  requireBook(book);
  const demand = requireDemandAdapter(dependencies);
  const order = orderById(book, orderId);
  if (!order) return { ok: false, code: "missing-order", message: "Market export order was not found." };
  const id = text(operationId);
  if (!id) return { ok: false, code: "missing-operation-id", message: "Market export cancellation requires operationId." };
  const priorUse = operationUse(book, id);
  if (priorUse) {
    if (priorUse.order === order && priorUse.stage === "cancel") return { ok: true, replay: true, order: cloneJson(order) };
    return conflict("operation-id-conflict", "This operationId already belongs to another export stage.", { stage: priorUse.stage, orderId: priorUse.order?.id });
  }
  if (String(order.status ?? "") !== "reserved" || text(order.dispatchedAt)) {
    return conflict("already-dispatched", "A dispatched export cannot be cancelled or returned to settlement storage.", { order: cloneJson(order) });
  }
  const release = demandTransition(demand, "release", {
    demandKey: text(order?.demand?.key),
    marketId: text(order?.quoteSnapshot?.market?.id),
    offerId: text(order?.quoteSnapshot?.offer?.id),
    quoteKey: text(order?.quoteSnapshot?.market?.quoteKey),
    quotedDemand: whole(order?.demand?.quotedQty, { minimum: 0, fallback: 0 }),
    qty: whole(order?.demand?.reservedQty, { minimum: 0, fallback: 0 }),
    reservationOperationId: text(order?.operationId),
    operationId: id
  });
  if (!release.ok) return release;
  order.status = "cancelled";
  order.cancelledAt = text(cancelledAt);
  order.cancellationOperationId = id;
  order.demand.status = "released";
  return {
    ok: true,
    replay: false,
    order: cloneJson(order),
    releasedGoods: cloneJson(order.sources, []),
    demandRelease: cloneJson(release)
  };
}

function moneyPreflight(holding, operationId, deltaCopper, kind, orderId = "") {
  const current = whole(holding?.storage?.moneyCopper, { minimum: 0, fallback: 0 });
  if (current === null) return { ok: false, code: "invalid-treasury", message: "Settlement treasury is not a whole copper amount." };
  const existing = (holding?.storage?.log ?? []).find((row) => text(row?.operationId) === text(operationId));
  if (existing) {
    if (
      Number(existing?.qty) === deltaCopper
      && String(existing?.kind ?? "") === kind
      && (!text(orderId) || text(existing?.orderId) === text(orderId))
    ) return { ok: true, replay: true, current, next: current };
    return conflict("money-operation-conflict", "Treasury already contains another entry with this operationId.");
  }
  const next = current + deltaCopper;
  if (!Number.isInteger(next) || next < 0) {
    return { ok: false, code: "insufficient-treasury", requiredCopper: Math.max(0, -deltaCopper), availableCopper: current, message: "Settlement treasury cannot cover this export cash requirement." };
  }
  return { ok: true, replay: false, current, next };
}

function applyMoneyResolution(holding, preflight, { operationId, resolvedAt, kind, deltaCopper, order, note }) {
  if (!preflight.replay) {
    holding.storage.moneyCopper = preflight.next;
    holding.storage.log.push({
      id: `market-export:${text(operationId)}`,
      ts: text(resolvedAt),
      kind,
      resourceId: "money",
      name: "Деньги",
      qty: deltaCopper,
      roomId: "",
      source: "market-export",
      note: text(note),
      operationId: text(operationId),
      orderId: text(order?.id)
    });
  }
}

function resolutionOperationCheck(book, order, operationId, expectedStage) {
  const id = text(operationId);
  if (!id) return { ok: false, code: "missing-operation-id", message: "Market export resolution requires operationId." };
  const priorUse = operationUse(book, id);
  if (priorUse) {
    if (priorUse.order === order && priorUse.stage === expectedStage) return { ok: true, replay: true, id };
    return conflict("operation-id-conflict", "This operationId already belongs to another export stage.", { stage: priorUse.stage, orderId: priorUse.order?.id });
  }
  if (String(order?.status ?? "") !== "in-transit" || !text(order?.dispatchedAt)) {
    return conflict("not-in-transit", "Only a dispatched export can be resolved.", { order: cloneJson(order) });
  }
  return { ok: true, replay: false, id };
}

export function deliverMarketExport({
  holding,
  book,
  orderId = "",
  operationId = "",
  deliveredAt = "",
  dependencies = {}
} = {}) {
  requireHolding(holding);
  requireBook(book);
  const demand = requireDemandAdapter(dependencies);
  const order = orderById(book, orderId);
  if (!order) return { ok: false, code: "missing-order", message: "Market export order was not found." };
  const check = resolutionOperationCheck(book, order, operationId, "deliver");
  if (!check.ok) return check;
  if (check.replay) return { ok: true, replay: true, order: cloneJson(order), settlement: cloneJson(order.settlement), cashDeltaCopper: 0 };

  const quote = order.quoteSnapshot ?? {};
  const grossCopper = exactCopper(quote?.bid?.grossCopper, "Export gross proceeds", 0);
  const costs = quoteCosts(quote);
  const timing = orderCashTiming(order, quote);
  const netCopper = grossCopper - costs.totalCopper;
  // Current orders paid freight, premium and other voyage costs at dispatch.
  // A legacy in-transit order without that marker safely pays the unpaid part
  // here so an upgrade can never mint gross proceeds without voyage costs.
  const cashDeltaCopper = grossCopper - costs.taxCopper - timing.unpaidUpfrontCostsCopper;
  const money = moneyPreflight(holding, check.id, cashDeltaCopper, "market-export-delivery", order?.id);
  if (!money.ok) return money;
  const consumption = demandTransition(demand, "consume", {
    demandKey: text(order?.demand?.key),
    marketId: text(quote?.market?.id),
    offerId: text(quote?.offer?.id),
    quoteKey: text(quote?.market?.quoteKey),
    quotedDemand: whole(order?.demand?.quotedQty, { minimum: 0, fallback: 0 }),
    qty: whole(order?.demand?.reservedQty, { minimum: 0, fallback: 0 }),
    reservationOperationId: text(order?.operationId),
    operationId: check.id
  });
  if (!consumption.ok) return consumption;

  const settlement = {
    outcome: "delivered",
    grossCopper,
    insurancePayoutCopper: 0,
    costs,
    netCopper,
    tripNetCopper: netCopper,
    cashDeltaCopper,
    upfrontCostsCopper: timing.upfrontCostsCopper,
    upfrontCostsPaidCopper: timing.upfrontCostsPaidCopper,
    cashTimingVersion: timing.cashTimingVersion
  };
  applyMoneyResolution(holding, money, {
    operationId: check.id,
    resolvedAt: deliveredAt,
    kind: "market-export-delivery",
    deltaCopper: cashDeltaCopper,
    order,
    note: `Gross ${grossCopper}; customs ${costs.taxCopper}; terminal cash ${cashDeltaCopper}; full-trip net ${netCopper}.`
  });
  order.status = "delivered";
  order.deliveredAt = text(deliveredAt);
  order.deliveryOperationId = check.id;
  order.demand.status = "consumed";
  order.settlement = settlement;
  return {
    ok: true,
    replay: false,
    order: cloneJson(order),
    settlement: cloneJson(settlement),
    cashDeltaCopper,
    demandConsumption: cloneJson(consumption)
  };
}

export function loseMarketExport({
  holding,
  book,
  orderId = "",
  operationId = "",
  lostAt = "",
  dependencies = {}
} = {}) {
  requireHolding(holding);
  requireBook(book);
  const demand = requireDemandAdapter(dependencies);
  const order = orderById(book, orderId);
  if (!order) return { ok: false, code: "missing-order", message: "Market export order was not found." };
  const check = resolutionOperationCheck(book, order, operationId, "loss");
  if (!check.ok) return check;
  if (check.replay) return { ok: true, replay: true, order: cloneJson(order), settlement: cloneJson(order.settlement), cashDeltaCopper: 0 };

  const quote = order.quoteSnapshot ?? {};
  const insurancePayoutCopper = quote?.risk?.explicitInsurancePayout === true
    ? exactCopper(quote?.risk?.insurancePayoutCopper, "Export insurance payout", 0)
    : 0;
  // Customs is sale-dependent; freight, premium and other voyage costs remain incurred on a loss.
  const costs = quoteCosts(quote, { customs: false });
  const timing = orderCashTiming(order, quote);
  const netCopper = insurancePayoutCopper - costs.totalCopper;
  const cashDeltaCopper = insurancePayoutCopper - timing.unpaidUpfrontCostsCopper;
  const money = moneyPreflight(holding, check.id, cashDeltaCopper, "market-export-loss", order?.id);
  if (!money.ok) return money;
  const release = demandTransition(demand, "release", {
    demandKey: text(order?.demand?.key),
    marketId: text(quote?.market?.id),
    offerId: text(quote?.offer?.id),
    quoteKey: text(quote?.market?.quoteKey),
    quotedDemand: whole(order?.demand?.quotedQty, { minimum: 0, fallback: 0 }),
    qty: whole(order?.demand?.reservedQty, { minimum: 0, fallback: 0 }),
    reservationOperationId: text(order?.operationId),
    operationId: check.id
  });
  if (!release.ok) return release;

  const settlement = {
    outcome: "lost",
    grossCopper: 0,
    insurancePayoutCopper,
    costs,
    netCopper,
    tripNetCopper: netCopper,
    cashDeltaCopper,
    upfrontCostsCopper: timing.upfrontCostsCopper,
    upfrontCostsPaidCopper: timing.upfrontCostsPaidCopper,
    cashTimingVersion: timing.cashTimingVersion
  };
  applyMoneyResolution(holding, money, {
    operationId: check.id,
    resolvedAt: lostAt,
    kind: "market-export-loss",
    deltaCopper: cashDeltaCopper,
    order,
    note: `No sale revenue; insurance cash ${insurancePayoutCopper}; terminal cash ${cashDeltaCopper}; full-trip net ${netCopper}.`
  });
  order.status = "lost";
  order.lostAt = text(lostAt);
  order.lossOperationId = check.id;
  order.demand.status = "released";
  order.settlement = settlement;
  return {
    ok: true,
    replay: false,
    order: cloneJson(order),
    settlement: cloneJson(settlement),
    cashDeltaCopper,
    demandRelease: cloneJson(release)
  };
}

function demandPosition(state, demandKey = "") {
  return (state?.positions ?? []).find((row) => text(row?.demandKey) === text(demandKey)) ?? null;
}

function demandOperation(state, operationId = "") {
  const id = text(operationId);
  for (const position of state?.positions ?? []) {
    for (const reservation of position?.reservations ?? []) {
      if (text(reservation?.operationId) === id) return { action: "reserve", position, reservation };
      if (text(reservation?.releaseOperationId) === id) return { action: "release", position, reservation };
      if (text(reservation?.consumeOperationId) === id) return { action: "consume", position, reservation };
    }
  }
  return null;
}

function ensureDemandPosition(state, payload = {}) {
  const key = text(payload?.demandKey);
  const quotedDemand = whole(payload?.quotedDemand, { minimum: 0, fallback: 0 });
  if (!key) return { ok: false, code: "missing-demand-key", message: "Demand transition requires demandKey." };
  let position = demandPosition(state, key);
  if (position && Number(position.quotedDemand) !== quotedDemand) {
    return conflict("quote-demand-conflict", "One demand key cannot have two quoted demand quantities.");
  }
  if (!position) {
    position = { demandKey: key, quotedDemand, reservations: [] };
    state.positions.push(position);
  }
  return { ok: true, position };
}

function jsonDemandAvailable(state, payload = {}) {
  const existing = demandPosition(state, payload?.demandKey);
  const quotedDemand = whole(payload?.quotedDemand, { minimum: 0, fallback: 0 });
  if (existing && Number(existing.quotedDemand) !== quotedDemand) {
    return conflict("quote-demand-conflict", "One demand key cannot have two quoted demand quantities.");
  }
  const unavailable = (existing?.reservations ?? [])
    .filter((row) => ["reserved", "consumed"].includes(String(row?.status ?? "")))
    .reduce((sum, row) => sum + finiteNonNegative(row?.qty, 0), 0);
  return { ok: true, availableQty: Math.max(0, Math.floor(quotedDemand - unavailable)) };
}

/**
 * Small reference adapter for JSON demand state. Integrations may provide the same
 * four-method interface backed by their own authoritative market-liquidity state.
 */
export function createJsonMarketExportDemandAdapter(state = {}) {
  if (!state || typeof state !== "object") throw new TypeError("Market export demand state must be a JSON object.");
  if (!Array.isArray(state.positions)) state.positions = [];
  for (const position of state.positions) {
    if (position && typeof position === "object" && !Array.isArray(position.reservations)) position.reservations = [];
  }
  return {
    state,
    available(payload = {}) {
      return jsonDemandAvailable(state, payload);
    },
    reserve(payload = {}) {
      const id = text(payload?.operationId);
      const qty = whole(payload?.qty, { minimum: 1 });
      if (!id || qty === null) return { ok: false, code: "invalid-demand-reservation", message: "Demand reservation requires operationId and a positive whole quantity." };
      const prior = demandOperation(state, id);
      if (prior) {
        if (prior.action === "reserve" && text(prior.position?.demandKey) === text(payload?.demandKey) && prior.reservation?.qty === qty) {
          return { ok: true, replay: true, reservation: cloneJson(prior.reservation) };
        }
        return conflict("demand-operation-conflict", "This operationId already belongs to another demand transition.");
      }
      const ensured = ensureDemandPosition(state, payload);
      if (!ensured.ok) return ensured;
      const availability = jsonDemandAvailable(state, payload);
      if (!availability.ok) return availability;
      if (availability.availableQty < qty) {
        return { ok: false, stale: true, code: "insufficient-bid-demand", requestedQty: qty, availableQty: availability.availableQty, message: "Finite external bid demand is exhausted." };
      }
      const reservation = { operationId: id, qty, status: "reserved", releaseOperationId: "", consumeOperationId: "" };
      ensured.position.reservations.push(reservation);
      return { ok: true, replay: false, reservation: cloneJson(reservation) };
    },
    release(payload = {}) {
      const id = text(payload?.operationId);
      const parentId = text(payload?.reservationOperationId);
      if (!id || !parentId) return { ok: false, code: "invalid-demand-release", message: "Demand release requires operationId and reservationOperationId." };
      const prior = demandOperation(state, id);
      if (prior) {
        if (prior.action === "release" && text(prior.reservation?.operationId) === parentId) return { ok: true, replay: true, reservation: cloneJson(prior.reservation) };
        return conflict("demand-operation-conflict", "This operationId already belongs to another demand transition.");
      }
      const position = demandPosition(state, payload?.demandKey);
      const reservation = (position?.reservations ?? []).find((row) => text(row?.operationId) === parentId);
      if (!reservation) return { ok: false, code: "missing-demand-reservation", message: "The external demand reservation was not found." };
      if (Number(reservation.qty) !== Number(payload?.qty)) return conflict("demand-quantity-conflict", "Demand release quantity differs from its reservation.");
      if (reservation.status !== "reserved") return conflict("demand-already-settled", "External demand was already consumed or released.");
      reservation.status = "released";
      reservation.releaseOperationId = id;
      return { ok: true, replay: false, reservation: cloneJson(reservation) };
    },
    consume(payload = {}) {
      const id = text(payload?.operationId);
      const parentId = text(payload?.reservationOperationId);
      if (!id || !parentId) return { ok: false, code: "invalid-demand-consumption", message: "Demand consumption requires operationId and reservationOperationId." };
      const prior = demandOperation(state, id);
      if (prior) {
        if (prior.action === "consume" && text(prior.reservation?.operationId) === parentId) return { ok: true, replay: true, reservation: cloneJson(prior.reservation) };
        return conflict("demand-operation-conflict", "This operationId already belongs to another demand transition.");
      }
      const position = demandPosition(state, payload?.demandKey);
      const reservation = (position?.reservations ?? []).find((row) => text(row?.operationId) === parentId);
      if (!reservation) return { ok: false, code: "missing-demand-reservation", message: "The external demand reservation was not found." };
      if (Number(reservation.qty) !== Number(payload?.qty)) return conflict("demand-quantity-conflict", "Demand consumption quantity differs from its reservation.");
      if (reservation.status !== "reserved") return conflict("demand-already-settled", "External demand was already consumed or released.");
      reservation.status = "consumed";
      reservation.consumeOperationId = id;
      return { ok: true, replay: false, reservation: cloneJson(reservation) };
    }
  };
}
