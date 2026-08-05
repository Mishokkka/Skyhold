import { planMarketPurchase } from "./pricing-adapter.js";

const EXPORT_PLAN_VERSION = 1;

function text(value = "") {
  return String(value ?? "").trim();
}

function cloneJson(value, fallback = null) {
  if (value === undefined) return fallback;
  return JSON.parse(JSON.stringify(value));
}

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function immutableJson(value, fallback = null) {
  return freezeDeep(cloneJson(value, fallback));
}

function whole(value, minimum = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : null;
}

function nonNegativeCopper(value) {
  return Math.max(0, Math.ceil(Number(value) || 0));
}

function invalid(code, message, extra = {}) {
  return { ok: false, valid: false, ready: false, code, message, ...extra };
}

function quantityEntries(quantities = {}) {
  if (quantities instanceof Map) return [...quantities.entries()];
  if (!quantities || typeof quantities !== "object" || Array.isArray(quantities)) return null;
  return Object.entries(quantities);
}

function activeReservedByStorageRow(exportBook = {}) {
  const reserved = new Map();
  for (const order of Array.isArray(exportBook?.orders) ? exportBook.orders : []) {
    if (text(order?.status) !== "reserved") continue;
    for (const source of Array.isArray(order?.sources) ? order.sources : []) {
      const rowId = text(source?.storageRowId);
      const rowIndex = whole(source?.storageRowIndex, 0);
      const key = rowId || (rowIndex === null ? "" : `@${rowIndex}`);
      const qty = whole(source?.qty, 0);
      if (!key || qty === null) continue;
      reserved.set(key, (reserved.get(key) ?? 0) + qty);
    }
  }
  return reserved;
}

function selectedCargo({ holding, exportBook, quantities, resourceId }) {
  const entries = quantityEntries(quantities);
  if (!entries) return invalid("invalid-export-quantities", "Export quantities must be keyed by storage row id.");
  const resources = Array.isArray(holding?.storage?.resources) ? holding.storage.resources : [];
  const rowsById = new Map();
  for (const [index, row] of resources.entries()) {
    const id = text(row?.id);
    if (!id) continue;
    const matches = rowsById.get(id) ?? [];
    matches.push({ row, index });
    rowsById.set(id, matches);
  }
  const reserved = activeReservedByStorageRow(exportBook);
  const cargo = [];
  const availability = [];
  for (const [rawRowId, rawQty] of entries) {
    const rowId = text(rawRowId);
    const qty = whole(rawQty, 0);
    if (qty === null) {
      return invalid("fractional-export-quantity", "Market export accepts only non-negative whole storage quantities.", { storageRowId: rowId });
    }
    if (!qty) continue;
    const matches = rowsById.get(rowId) ?? [];
    if (matches.length !== 1) {
      return invalid(
        matches.length ? "ambiguous-storage-row" : "missing-storage-row",
        matches.length ? "A selected storage row id is not unique." : "A selected storage row no longer exists.",
        { storageRowId: rowId }
      );
    }
    const { row, index } = matches[0];
    if (text(row?.resourceId) !== resourceId) {
      return invalid("mixed-resource-export", "One export contract may contain only the selected offer resource.", {
        storageRowId: rowId,
        expectedResourceId: resourceId,
        actualResourceId: text(row?.resourceId)
      });
    }
    const storedQty = whole(row?.qty, 0);
    if (storedQty === null) {
      return invalid("fractional-storage-stock", "A selected storage row must contain a whole Economy V2 quantity.", { storageRowId: rowId });
    }
    const reservedQty = reserved.get(rowId) ?? reserved.get(`@${index}`) ?? 0;
    const availableQty = Math.max(0, storedQty - reservedQty);
    availability.push({ storageRowId: rowId, storageRowIndex: index, storedQty, reservedQty, availableQty, selectedQty: qty });
    if (qty > availableQty) {
      return invalid("insufficient-storage-stock", "Selected settlement goods exceed unreserved storage stock.", {
        storageRowId: rowId,
        requestedQty: qty,
        availableQty
      });
    }
    cargo.push({ storageRowId: rowId, storageRowIndex: index, qty });
  }
  cargo.sort((left, right) => left.storageRowIndex - right.storageRowIndex || left.storageRowId.localeCompare(right.storageRowId, "en"));
  if (!cargo.length) return invalid("empty-export-cargo", "Select at least one whole unit for export.");
  return {
    ok: true,
    cargo,
    availability,
    totalQty: cargo.reduce((sum, row) => sum + row.qty, 0)
  };
}

function demandAvailability(dependencies = {}, payload = {}, quotedDemand = 0) {
  if (typeof dependencies?.demand?.available !== "function") return { ok: true, availableQty: quotedDemand, authoritative: false };
  const result = dependencies.demand.available(payload);
  if (typeof result === "number") return { ok: true, availableQty: Math.max(0, Math.floor(result)), authoritative: true };
  if (!result || result.ok === false) {
    return {
      ok: false,
      code: text(result?.code) || "export-demand-unavailable",
      message: text(result?.message) || "External bid demand is unavailable.",
      availableQty: 0,
      authoritative: true
    };
  }
  return { ok: true, availableQty: Math.max(0, Math.floor(Number(result.availableQty) || 0)), authoritative: true };
}

function exportRouteSnapshot(quote = {}, calculator = {}) {
  const logistics = cloneJson(quote?.logistics, {});
  const supplied = cloneJson(quote?.route, {});
  return {
    ...logistics,
    ...supplied,
    id: text(supplied?.id) || `${text(logistics?.destinationRegionId) || "settlement"}->${text(logistics?.originRegionId) || text(quote?.marketId) || "market"}`,
    fromId: text(supplied?.fromId) || text(logistics?.destinationRegionId),
    toId: text(supplied?.toId) || text(logistics?.originRegionId) || text(quote?.marketId),
    path: Array.isArray(supplied?.path) ? [...supplied.path] : [...(logistics?.routePath ?? [])],
    distanceKm: Math.max(0, Number(supplied?.distanceKm ?? logistics?.distanceKm) || 0),
    transportMode: text(supplied?.transportMode) || text(logistics?.transportMode),
    serviceLevel: text(calculator?.serviceLevel),
    serviceLabel: text(calculator?.serviceLabel),
    deliveryMode: text(calculator?.deliveryMode),
    etaQd: Math.max(0, whole(calculator?.deliveryQd, 0) ?? 0),
    batchCount: Math.max(0, whole(calculator?.batchCount, 0) ?? 0)
  };
}

/**
 * Build a side-effect-free external sale contract from one quoted bid and
 * concrete settlement storage rows. The returned exportQuote is deeply frozen
 * and can be passed directly to prepareMarketExport.
 */
export function planMarketExport({
  holding = {},
  exportBook = {},
  quote = {},
  offerId = "",
  quantities = {},
  serviceLevel = "charter",
  dependencies = {}
} = {}) {
  const selectedOfferId = text(offerId);
  if (!selectedOfferId) return invalid("missing-export-offer", "Choose exactly one external market bid.");
  const offers = (Array.isArray(quote?.offers) ? quote.offers : []).filter((row) => text(row?.id ?? row?.offerId) === selectedOfferId);
  if (offers.length !== 1) {
    return invalid(offers.length ? "ambiguous-export-offer" : "missing-export-offer", "The selected external market bid is unavailable.", { offerId: selectedOfferId });
  }
  const offer = offers[0];
  const marketId = text(quote?.marketId ?? offer?.marketId);
  const quoteKey = text(quote?.quoteKey ?? offer?.quoteKey);
  const resourceId = text(offer?.resourceId);
  if (!marketId || !quoteKey || !resourceId) {
    return invalid("incomplete-export-quote", "Export planning requires market, quote period and resource identifiers.");
  }
  const bidUnitCopper = whole(offer?.bidUnitCopper ?? offer?.unitBidCopper, 0);
  const quotedBidDemand = whole(offer?.bidDemand, 0);
  const unitCargoPoints = whole(offer?.cargoPoints ?? offer?.unitCargoPoints, 1);
  if (bidUnitCopper === null || bidUnitCopper <= 0) return invalid("inactive-export-bid", "The selected market bid has no positive whole copper price.");
  if (quotedBidDemand === null || quotedBidDemand <= 0) return invalid("exhausted-export-demand", "The selected market bid has no whole remaining demand.");
  if (unitCargoPoints === null) return invalid("invalid-export-cargo-points", "The selected resource requires positive whole cargo points.");

  const selection = selectedCargo({ holding, exportBook, quantities, resourceId });
  if (!selection.ok) return selection;
  const demandKey = text(offer?.liquidityKey ?? offer?.demandKey) || `${marketId}\u001f${selectedOfferId}\u001f${quoteKey}`;
  const demandPayload = { demandKey, marketId, quoteKey, offerId: selectedOfferId, quotedDemand: quotedBidDemand };
  const demand = demandAvailability(dependencies, demandPayload, quotedBidDemand);

  const calculatorHolding = {
    ...holding,
    storage: { ...(holding?.storage ?? {}), moneyCopper: Number.MAX_SAFE_INTEGER }
  };
  const pseudoOffer = {
    ...cloneJson(offer, {}),
    id: selectedOfferId,
    resourceId,
    unitPriceCopper: bidUnitCopper,
    // Demand readiness is checked separately. The purchase calculator must see
    // the full selected cargo so its freight/capacity quote is never clipped by
    // a stale or exhausted bid.
    stock: selection.totalQty,
    cargoPoints: unitCargoPoints
  };
  const calculator = planMarketPurchase({
    holding: calculatorHolding,
    quote: { ...cloneJson(quote, {}), offers: [pseudoOffer] },
    quantities: { [selectedOfferId]: selection.totalQty },
    targetRoomId: "export",
    serviceLevel
  });

  const grossCopper = selection.totalQty * bidUnitCopper;
  const freightCopper = nonNegativeCopper(calculator?.routeCopper);
  const handlingCopper = nonNegativeCopper(calculator?.handlingCopper);
  const expressSurchargeCopper = nonNegativeCopper(calculator?.expressSurchargeCopper);
  const taxCopper = nonNegativeCopper(calculator?.taxCopper);
  const insuranceCopper = nonNegativeCopper(calculator?.insuranceCopper);
  const insurancePayoutCopper = nonNegativeCopper(calculator?.maximumInsurancePayoutCopper);
  const otherCosts = [
    ...(handlingCopper > 0 ? [{ id: "handling", label: "Export handling", copper: handlingCopper }] : []),
    ...(expressSurchargeCopper > 0 ? [{ id: "express", label: "Express export surcharge", copper: expressSurchargeCopper }] : [])
  ];
  const otherCopper = handlingCopper + expressSurchargeCopper;
  const totalCostCopper = freightCopper + taxCopper + insuranceCopper + otherCopper;
  const projectedNetCopper = grossCopper - totalCostCopper;
  const treasuryCopper = Math.max(0, Math.floor(Number(holding?.storage?.moneyCopper) || 0));
  const upfrontCostsCopper = freightCopper + insuranceCopper + otherCopper;
  const dispatchCashDeltaCopper = -upfrontCostsCopper;
  const deliveryCashDeltaCopper = grossCopper - taxCopper;
  const lossCashDeltaCopper = insurancePayoutCopper;
  const economicLossExposureCopper = Math.max(0, upfrontCostsCopper - insurancePayoutCopper);
  const terminalReserveCopper = Math.max(0, -deliveryCashDeltaCopper);
  const dispatchCashReady = treasuryCopper >= upfrontCostsCopper;
  const terminalCashReady = Math.max(0, treasuryCopper - upfrontCostsCopper) >= terminalReserveCopper;
  const route = exportRouteSnapshot(quote, calculator);
  const lossChance = Math.min(1, Math.max(0, Number(calculator?.riskLossChance) || 0));
  const risk = {
    frozen: true,
    resolutionVersion: 1,
    resolutionMode: "binary-on-arrival",
    lossChance,
    riskFactor: Math.max(0, Number(calculator?.riskFactor) || 0),
    insurancePayoutCopper
  };
  const exportQuote = immutableJson({
    version: EXPORT_PLAN_VERSION,
    demandKey,
    market: {
      id: marketId,
      label: text(quote?.marketLabel) || marketId,
      quoteKey
    },
    offer: {
      ...cloneJson(offer, {}),
      id: selectedOfferId,
      resourceId,
      name: text(offer?.name) || resourceId,
      bidDemand: quotedBidDemand
    },
    route,
    cargoPoints: { unit: unitCargoPoints },
    bid: { unitCopper: bidUnitCopper },
    freight: {
      copper: freightCopper,
      serviceLevel: text(calculator?.serviceLevel),
      serviceLabel: text(calculator?.serviceLabel),
      fullFixedFare: ["charter", "owned"].includes(text(calculator?.serviceLevel)),
      batchCount: Math.max(0, whole(calculator?.batchCount, 0) ?? 0),
      breakdown: cloneJson(calculator?.deliveryBreakdown, {})
    },
    tax: { copper: taxCopper, rate: Math.max(0, Number(calculator?.deliveryBreakdown?.taxRate) || 0) },
    risk,
    insurance: {
      premiumCopper: insuranceCopper,
      payoutCopper: insurancePayoutCopper,
      coverageRate: Math.max(0, Number(calculator?.insuranceCoverageRate) || 0)
    },
    otherCosts
  }, {});

  const readiness = {
    storage: true,
    demand: demand.ok && selection.totalQty <= Math.min(quotedBidDemand, demand.availableQty),
    route: calculator?.inaccessible !== true && quote?.logistics?.ok !== false,
    capacity: calculator?.capacityExceeded !== true,
    dispatchCash: dispatchCashReady,
    terminalCash: terminalCashReady,
    // Compatibility alias for the pre-UI plan contract. Its basis is now the
    // cash actually due at dispatch, not a hypothetical terminal net loss.
    lossReserve: dispatchCashReady
  };
  const issues = [
    ...(!demand.ok ? [{ code: demand.code, message: demand.message }] : []),
    ...(demand.ok && !readiness.demand ? [{ code: "insufficient-bid-demand", message: "Selected cargo exceeds authoritative remaining bid demand." }] : []),
    ...(!readiness.route ? [{ code: "inaccessible-export-route", message: "The external export route is unavailable." }] : []),
    ...(!readiness.capacity ? [{ code: "export-capacity-exceeded", message: "The selected cargo does not fit the chosen carrier service." }] : []),
    ...(!readiness.dispatchCash ? [{ code: "insufficient-export-upfront-cash", message: "Treasury cannot pay freight, insurance and other voyage costs at dispatch." }] : []),
    ...(!readiness.terminalCash ? [{ code: "insufficient-export-terminal-reserve", message: "Treasury remaining after dispatch cannot cover a negative delivery cash settlement." }] : [])
  ];
  const ready = Object.values(readiness).every(Boolean);
  return {
    ok: ready,
    valid: true,
    ready,
    version: EXPORT_PLAN_VERSION,
    offerId: selectedOfferId,
    resourceId,
    totalQty: selection.totalQty,
    cargo: immutableJson(selection.cargo, []),
    availability: immutableJson(selection.availability, []),
    exportQuote,
    prepare: immutableJson({ quote: exportQuote, cargo: selection.cargo }, {}),
    financials: immutableJson({
      grossCopper,
      freightCopper,
      handlingCopper,
      expressSurchargeCopper,
      taxCopper,
      insuranceCopper,
      otherCopper,
      totalCostCopper,
      projectedNetCopper,
      upfrontCostsCopper,
      dispatchCashDeltaCopper,
      deliveryCashDeltaCopper,
      lossCashDeltaCopper,
      profitable: projectedNetCopper > 0
    }, {}),
    eta: immutableJson({ qd: route.etaQd, deliveryMode: route.deliveryMode, batchCount: route.batchCount }, {}),
    risk: immutableJson(risk, {}),
    capacity: immutableJson({
      ready: readiness.capacity,
      requiredCargoPoints: selection.totalQty * unitCargoPoints,
      bookingCapacityCargoPoints: Math.max(0, Number(calculator?.bookingCapacityCargoPoints) || 0),
      batchCount: Math.max(0, Number(calculator?.batchCount) || 0)
    }, {}),
    dispatchCash: immutableJson({
      ready: readiness.dispatchCash,
      availableCopper: treasuryCopper,
      requiredCopper: upfrontCostsCopper,
      cashDeltaCopper: dispatchCashDeltaCopper,
      terminalReserveCopper
    }, {}),
    lossReserve: immutableJson({
      ready: readiness.lossReserve,
      basis: "dispatch-upfront",
      availableCopper: treasuryCopper,
      requiredCopper: upfrontCostsCopper,
      voyageLossCopper: economicLossExposureCopper,
      economicLossExposureCopper
    }, {}),
    demand: immutableJson({
      ready: readiness.demand,
      quotedQty: quotedBidDemand,
      availableQty: demand.availableQty,
      authoritative: demand.authoritative
    }, {}),
    readiness: immutableJson(readiness, {}),
    issues: immutableJson(issues, [])
  };
}
