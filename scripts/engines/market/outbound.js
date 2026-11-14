import { MAX_OUTBOUND_CARGO_ROWS } from "../../data/market/outbound-state.js";
import { marketMoneyInRange, MAX_MARKET_OPERATION_COPPER } from "../../data/market/money-limits.js";
import { marketOutboundBatchPlans } from "./outbound-batches.js";
import { allocateMarketTransportCharges, marketTransportPlanForOrder } from "../../data/market/transport-plan.js";
import { reservedResourceBatchQuantities } from "../../core/resource-batches.js";
import { conflictingStorageLotKeys, indexStorageLots, indexStorageRows, matchingStorageLots, storageLotKey as batchKey } from "../storage/row-identity.js";

function whole(value, fallback = 0, max = 1_000_000_000) {
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
  return Math.min(max, Math.max(0, normalized));
}

function decimal(value, fallback = 0, min = 0, max = 1_000_000_000) {
  const parsed = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
}

function text(value = "") {
  return String(value ?? "").trim();
}

function loweredTags(value = []) {
  return [...new Set((Array.isArray(value) ? value : []).map((tag) => text(tag).toLocaleLowerCase("ru")).filter(Boolean))];
}

function tagMatches(tag = "", selector = "") {
  const candidate = text(tag).normalize("NFKC").toLocaleLowerCase("ru");
  const target = text(selector).normalize("NFKC").toLocaleLowerCase("ru");
  if (!candidate || !target) return false;
  if (target === "all") return true;
  return candidate === target || candidate.startsWith(`${target}.`) || candidate.startsWith(`${target}-`);
}

function inventoryBatches(resources = [], outboundState = {}, { excludeOperationId = "" } = {}) {
  const excluded = text(excludeOperationId);
  const holding = { storage: { resources }, special: { market: { outbound: outboundState } } };
  const uniqueRows = indexStorageRows(resources);
  const rows = [];
  for (const [rowIndex, row] of (Array.isArray(resources) ? resources : []).entries()) {
    const rowId = text(row?.id);
    const resourceId = text(row?.resourceId ?? row?.id);
    if (!rowId || !resourceId || uniqueRows.get(String(row.id ?? "")) !== row) continue;
    const reserved = outboundState?.orders?.length ? reservedResourceBatchQuantities(holding, row, { excludeOperationId: excluded }) : null;
    const batches = Array.isArray(row?.batches) && row.batches.length
      ? row.batches
      : (whole(row?.qty) ? [{ id: `legacy-${rowIndex + 1}`, qty: whole(row.qty), ageQd: whole(row.ageQd) }] : []);
    for (const [batchIndex, batch] of batches.entries()) {
      const id = text(batch?.id) || `batch-${batchIndex + 1}`;
      const qty = whole(batch?.qty);
      const reservedQty = reserved?.get(id) ?? 0;
      const availableQty = Math.max(0, qty - reservedQty);
      if (!availableQty) continue;
      rows.push({
        rowId,
        resourceId,
        batchId: id,
        qty,
        reservedQty,
        availableQty,
        ageQd: whole(batch?.ageQd, 0, Number.MAX_SAFE_INTEGER),
        rowIndex,
        batchIndex,
        name: text(row?.name ?? row?.label ?? resourceId)
      });
    }
  }
  return rows.sort((left, right) => right.ageQd - left.ageQd
    || left.rowIndex - right.rowIndex
    || left.batchIndex - right.batchIndex
    || left.batchId.localeCompare(right.batchId));
}

export function marketOutboundAvailableQuantity({ resources = [], outboundState = {}, resourceId = "", excludeOperationId = "" } = {}) {
  const id = text(resourceId);
  return inventoryBatches(resources, outboundState, { excludeOperationId })
    .filter((batch) => batch.resourceId === id)
    .reduce((sum, batch) => sum + batch.availableQty, 0);
}

export function preflightMarketOutboundBooking({ resources = [], outboundState = {}, cargoReservations = [], excludeOperationId = "" } = {}) {
  if (cargoReservations.length > MAX_OUTBOUND_CARGO_ROWS) return { ok: false, capacityExceeded: true,
    message: `В поставке больше ${MAX_OUTBOUND_CARGO_ROWS} грузовых партий. Разделите продажу на несколько поставок.` };
  const available = new Map(inventoryBatches(resources, outboundState, { excludeOperationId })
    .map((batch) => [batchKey(batch.rowId, batch.batchId), batch]));
  const requested = new Map();
  for (const cargo of cargoReservations ?? []) {
    const rowId = text(cargo?.rowId);
    const id = text(cargo?.batchId);
    const qty = whole(cargo?.qty);
    if (!rowId || !id || !qty) continue;
    const key = batchKey(rowId, id);
    const previous = requested.get(key);
    if (previous) previous.qty += qty;
    else requested.set(key, { rowId, batchId: id, qty });
  }
  for (const [key, requirement] of requested) {
    const batch = available.get(key);
    if (!batch || batch.availableQty < requirement.qty) {
      return {
        ok: false,
        stale: true,
        rowId: requirement.rowId,
        batchId: requirement.batchId,
        requested: requirement.qty,
        available: batch?.availableQty ?? 0,
        message: "Reserved outbound cargo changed after preview."
      };
    }
  }
  return { ok: true, reservedQty: [...requested.values()].reduce((sum, row) => sum + row.qty, 0) };
}

function buyerPresence(organization = {}, countryId = "") {
  const buyer = organization?.buyer && typeof organization.buyer === "object" ? organization.buyer : null;
  if (!buyer || buyer.enabled === false) return 0;
  const shares = Array.isArray(buyer.countryShares)
    ? buyer.countryShares
    : (Array.isArray(organization.buyerCountryShares) ? organization.buyerCountryShares : []);
  return shares
    .filter((row) => row?.active !== false && text(row?.countryId) === text(countryId))
    .reduce((sum, row) => sum + decimal(row?.sharePct ?? row?.share, 0, 0, 100), 0);
}

function buyerAcceptsLine(organization = {}, line = {}) {
  const buyer = organization?.buyer ?? {};
  const tags = new Set(loweredTags(line.tags));
  tags.add(text(line.resourceId).toLocaleLowerCase("ru"));
  const includes = loweredTags(buyer.includeTags);
  const excludes = loweredTags(buyer.excludeTags);
  if (excludes.some((selector) => [...tags].some((tag) => tagMatches(tag, selector)))) return false;
  return !includes.length || includes.some((selector) => [...tags].some((tag) => tagMatches(tag, selector)));
}

function largestRemainder(qty, weightedRows = []) {
  const totalWeight = weightedRows.reduce((sum, row) => sum + row.weight, 0);
  if (!(qty > 0) || !(totalWeight > 0)) return [];
  const rows = weightedRows.map((row) => {
    const exact = (qty * row.weight) / totalWeight;
    const allocated = Math.floor(exact);
    return { ...row, exact, allocated, fraction: exact - allocated };
  });
  let remainder = qty - rows.reduce((sum, row) => sum + row.allocated, 0);
  const priority = [...rows].sort((left, right) => right.fraction - left.fraction || left.id.localeCompare(right.id));
  for (let index = 0; index < priority.length && remainder > 0; index += 1, remainder -= 1) priority[index].allocated += 1;
  return rows.filter((row) => row.allocated > 0);
}

export function allocateMarketOutboundBuyers({ lines = [], organizations = [], countryId = "", independentLabel = "Независимые покупатели" } = {}) {
  const allocations = [];
  for (const [lineIndex, line] of (Array.isArray(lines) ? lines : []).entries()) {
    const qty = whole(line?.qty);
    if (!qty) continue;
    const lineId = text(line?.id ?? line?.lineId ?? `line-${lineIndex + 1}`);
    const buyers = (Array.isArray(organizations) ? organizations : [])
      .filter((organization) => organization?.active !== false && buyerAcceptsLine(organization, line))
      .map((organization) => ({
        id: text(organization.id),
        label: text(organization.label ?? organization.id ?? "Покупатель"),
        weight: buyerPresence(organization, countryId),
        independent: false
      }))
      .filter((row) => row.id && row.weight > 0)
      .sort((left, right) => left.id.localeCompare(right.id));
    const buyerWeight = buyers.reduce((sum, row) => sum + row.weight, 0);
    const weighted = buyerWeight >= 100
      ? buyers
      : [...buyers, { id: "independent", label: text(independentLabel) || "Независимые покупатели", weight: 100 - buyerWeight, independent: true }];
    const fallback = weighted.length ? weighted : [{ id: "independent", label: text(independentLabel) || "Независимые покупатели", weight: 100, independent: true }];
    for (const row of largestRemainder(qty, fallback)) {
      allocations.push({
        lineId,
        resourceId: text(line.resourceId),
        demandId: text(line.demandId ?? line.resourceId ?? line.id),
        buyerId: row.id,
        buyerLabel: row.label,
        independent: row.independent,
        shareWeight: row.weight,
        qty: row.allocated
      });
    }
  }
  return allocations;
}

function pricedRoute(candidate = {}, cargoValueCopper = 0, insuranceEnabled = true) {
  const freightCopper = whole(candidate.freightCopper ?? candidate.deliveryCopper ?? candidate.routeCopper, 0, Number.MAX_SAFE_INTEGER);
  const tariffCopper = whole(candidate.tariffCopper ?? candidate.taxCopper, 0, Number.MAX_SAFE_INTEGER);
  const insuredValueCopper = cargoValueCopper + freightCopper + tariffCopper;
  const insuranceCoverageRate = insuranceEnabled ? decimal(candidate.insuranceCoverageRate, 1, 0, 1) : 0;
  const insuranceCopper = insuranceEnabled
    ? whole(candidate.insuranceCopper ?? Math.ceil(insuredValueCopper * decimal(candidate.insurancePremiumRate, 0, 0, 1)), 0, Number.MAX_SAFE_INTEGER)
    : 0;
  const calculatedPayout = Math.floor(insuredValueCopper * insuranceCoverageRate);
  const maximumInsurancePayoutCopper = insuranceEnabled
    ? Math.min(calculatedPayout, whole(candidate.maximumInsurancePayoutCopper, calculatedPayout, Number.MAX_SAFE_INTEGER))
    : 0;
  return {
    ...candidate,
    id: text(candidate.id ?? candidate.routeId ?? candidate.quoteKey),
    freightCopper,
    tariffCopper,
    insuranceCopper,
    insuredValueCopper,
    insuranceCoverageRate,
    maximumInsurancePayoutCopper,
    upfrontCopper: freightCopper + tariffCopper + insuranceCopper,
    deliveryQd: Math.max(1, whole(candidate.deliveryQd ?? candidate.travelQd, 1, 100_000)),
    riskFactor: decimal(candidate.riskFactor, 1, 0.25, 4),
    riskLossChance: decimal(candidate.riskLossChance ?? candidate.lossChance, 0, 0, 0.08),
    riskDelayChance: decimal(candidate.riskDelayChance ?? candidate.delayChance, 0, 0, 0.45),
    riskMaxDelayQd: Math.max(1, whole(candidate.riskMaxDelayQd ?? candidate.maxDelayQd, 1, 20))
  };
}

export function selectCheapestMarketOutboundRoute({ routes = [], cargoValueCopper = 0, insuranceEnabled = true } = {}) {
  const candidates = (Array.isArray(routes) ? routes : [])
    .filter((route) => route?.ok !== false)
    .map((route) => pricedRoute(route, whole(cargoValueCopper, 0, Number.MAX_SAFE_INTEGER), insuranceEnabled))
    .sort((left, right) => left.upfrontCopper - right.upfrontCopper
      || left.deliveryQd - right.deliveryQd
      || left.id.localeCompare(right.id));
  return candidates[0] ?? null;
}

function normalizedLines(lines = []) {
  return (Array.isArray(lines) ? lines : []).map((line, index) => ({
    ...line,
    id: text(line?.id ?? line?.lineId ?? `line-${index + 1}`),
    resourceId: text(line?.resourceId ?? line?.id),
    demandId: text(line?.demandId ?? line?.resourceId ?? line?.id),
    name: text(line?.name ?? line?.resourceId ?? line?.id),
    qty: whole(line?.qty),
    unitPriceCopper: whole(line?.unitPriceCopper),
    demandBaseDemand: whole(line?.demandBaseDemand ?? line?.demandStateBaseDemand ?? line?.demand),
    demandStateRevision: whole(line?.demandStateRevision, 0, Number.MAX_SAFE_INTEGER),
    tags: loweredTags(line?.tags)
  })).filter((line) => line.resourceId && line.demandId && line.qty > 0 && line.unitPriceCopper > 0);
}

function reserveFifoCargo(resources, outboundState, lines) {
  const batches = inventoryBatches(resources, outboundState);
  const remainingByBatch = new Map(batches.map((batch) => [batchKey(batch.rowId, batch.batchId), batch.availableQty]));
  const cargo = [];
  for (const line of lines) {
    let remaining = line.qty;
    for (const batch of batches) {
      if (!remaining || batch.resourceId !== line.resourceId) continue;
      const key = batchKey(batch.rowId, batch.batchId);
      const available = remainingByBatch.get(key) ?? 0;
      const amount = Math.min(remaining, available);
      if (!amount) continue;
      cargo.push({
        lineId: line.id,
        demandId: line.demandId,
        resourceId: line.resourceId,
        name: line.name || batch.name,
        rowId: batch.rowId,
        batchId: batch.batchId,
        qty: amount,
        reservedAgeQd: batch.ageQd,
        ageQd: batch.ageQd,
        unitPriceCopper: line.unitPriceCopper,
        cargoValueCopper: amount * line.unitPriceCopper
      });
      remainingByBatch.set(key, available - amount);
      remaining -= amount;
    }
    if (remaining) return { ok: false, resourceId: line.resourceId, requested: line.qty, available: line.qty - remaining, shortfall: remaining };
  }
  return { ok: true, cargo };
}

export function marketOutboundPlanToken(plan = {}) {
  return JSON.stringify({
    marketId: text(plan.marketId),
    routeId: text(plan.route?.id),
    transportPlan: plan.route?.transportPlan ?? null,
    cargo: (plan.cargoReservations ?? []).map((row) => [row.rowId, row.batchId, row.qty, row.reservedAgeQd]),
    demand: (plan.lines ?? []).map((line) => [line.demandId, line.qty, line.demandStateRevision]),
    upfrontCopper: whole(plan.upfrontCopper, 0, Number.MAX_SAFE_INTEGER),
    revenueCopper: whole(plan.revenueCopper, 0, Number.MAX_SAFE_INTEGER),
    batches: (plan.shipmentBatches ?? []).map((batch) => [batch.deliveryQd, batch.standardDeliveryQd, batch.serviceLevel,
      batch.cargoReservations.map((row) => [row.rowId, row.batchId, row.qty]), batch.upfrontCopper,
      batch.insuredValueCopper, batch.maximumInsurancePayoutCopper, batch.riskLossChance, batch.riskDelayChance, batch.riskMaxDelayQd])
  });
}

export function planMarketOutboundSale({
  resources = [],
  outboundState = {},
  lines = [],
  routes = [],
  organizations = [],
  marketId = "external-market",
  marketLabel = "Внешний рынок",
  countryId = "",
  treasuryCopper = 0,
  insuranceEnabled = true
} = {}) {
  const preparedLines = normalizedLines(lines);
  const reasons = [];
  if (!preparedLines.length) reasons.push("Исходящая продажа не содержит целых товарных позиций с ценой.");
  const reserved = reserveFifoCargo(resources, outboundState, preparedLines);
  if (reserved.cargo?.length > MAX_OUTBOUND_CARGO_ROWS) reasons.push(
    `В поставке больше ${MAX_OUTBOUND_CARGO_ROWS} грузовых партий. Разделите продажу на несколько поставок.`);
  if (!reserved.ok) reasons.push(`Недостаточно доступного товара ${reserved.resourceId}: ${reserved.available} из ${reserved.requested}.`);
  const revenueCopper = preparedLines.reduce((sum, line) => sum + line.qty * line.unitPriceCopper, 0);
  const route = selectCheapestMarketOutboundRoute({ routes, cargoValueCopper: revenueCopper, insuranceEnabled });
  if (!route) reasons.push("Для исходящей продажи нет допустимого маршрута.");
  const upfrontCopper = route?.upfrontCopper ?? 0;
  if (![revenueCopper, upfrontCopper, route?.insuredValueCopper ?? 0, route?.maximumInsurancePayoutCopper ?? 0]
    .every(marketMoneyInRange)) reasons.push(`Сумма продажи или страхуемая стоимость превышает ${MAX_MARKET_OPERATION_COPPER} ММ. Разделите продажу на несколько заказов.`);
  if (whole(treasuryCopper) < upfrontCopper) reasons.push(`Недостаточно денег на фрахт, пошлину и страховку: нужно ${upfrontCopper}.`);
  const buyerAllocations = allocateMarketOutboundBuyers({ lines: preparedLines, organizations, countryId });
  const plan = {
    ok: reasons.length === 0,
    reasons,
    marketId: text(marketId) || "external-market",
    marketLabel: text(marketLabel) || "Внешний рынок",
    countryId: text(countryId),
    lines: preparedLines,
    demandLines: preparedLines.map((line) => ({
      id: line.id,
      demandId: line.demandId,
      resourceId: line.resourceId,
      qty: line.qty,
      demandBaseDemand: line.demandBaseDemand,
      demandStateBaseDemand: line.demandBaseDemand,
      demandStateRevision: line.demandStateRevision
    })),
    cargoReservations: reserved.ok ? reserved.cargo : [],
    buyerAllocations,
    route,
    revenueCopper,
    freightCopper: route?.freightCopper ?? 0,
    tariffCopper: route?.tariffCopper ?? 0,
    importTaxCopper: route?.importTaxCopper ?? 0,
    exportTaxCopper: route?.exportTaxCopper ?? 0,
    insuranceCopper: route?.insuranceCopper ?? 0,
    upfrontCopper,
    insuredValueCopper: route?.insuredValueCopper ?? 0,
    insuranceCoverageRate: route?.insuranceCoverageRate ?? 0,
    maximumInsurancePayoutCopper: route?.maximumInsurancePayoutCopper ?? 0,
    deliveryQd: route?.deliveryQd ?? 0,
    riskFactor: route?.riskFactor ?? 1,
    riskLossChance: route?.riskLossChance ?? 0,
    riskDelayChance: route?.riskDelayChance ?? 0,
    riskMaxDelayQd: route?.riskMaxDelayQd ?? 1
  };
  try {
    if (plan.route?.transportPlan) plan.route = { ...plan.route,
      transportPlan: outboundTransportSnapshot(plan, plan.route, Math.max(1, plan.route.shipmentBatches?.length ?? 1)) };
    plan.shipmentBatches = marketOutboundBatchPlans(plan);
    if (plan.shipmentBatches.length) plan.maximumInsurancePayoutCopper = plan.shipmentBatches
      .reduce((sum, batch) => sum + batch.maximumInsurancePayoutCopper, 0);
    if (plan.route?.transportPlan && plan.shipmentBatches.length) {
      const parts = plan.shipmentBatches.map((batch) => batch.route.transportPlan);
      const transportLegCosts = plan.route.transportPlan.legs.map((leg, index) => parts.reduce((sum, part) => {
        if (part.legs[index]?.id !== leg.id) throw new Error("Участки исходящих рейсов не совпадают.");
        return sum + part.legs[index].chargedCopper;
      }, 0));
      const sum = (field) => parts.reduce((value, part) => value + part.billing[field], 0);
      plan.route = { ...plan.route, transportPlan: marketTransportPlanForOrder(plan.route.transportPlan, {
        transportLegCosts, batchCount: parts.length, freightCopper: sum("freightCopper"),
        insuranceCopper: plan.insuranceCopper, taxCopper: plan.tariffCopper, handlingCopper: sum("handlingCopper"),
        expressSurchargeCopper: sum("expressSurchargeCopper"), deliveryCopper: plan.upfrontCopper,
        serviceLevel: plan.route.serviceLevel ?? "standard"
      }) };
    }
  } catch (error) {
    plan.shipmentBatches = [];
    plan.ok = false;
    plan.reasons.push(error.message);
  }
  plan.planToken = marketOutboundPlanToken(plan);
  return plan;
}

export function preflightMarketOutboundDispatch({ resources = [], cargoReservations = [], orderCargo = cargoReservations,
  conflicts = conflictingStorageLotKeys(orderCargo) } = {}) {
  const lots = indexStorageLots(resources);
  const grouped = new Map();
  const sources = [];
  const stale = (rowId, batchId, qty, available = 0) => ({ ok: false, stale: true, rowId, batchId,
    requested: qty, available, message: "Reserved outbound cargo changed before dispatch." });
  for (const [index, cargo] of (cargoReservations ?? []).entries()) {
    const rowId = text(cargo?.rowId ?? cargo?.storageRowId);
    const id = text(cargo?.batchId);
    const qty = whole(cargo?.qty);
    if (!qty) continue;
    if (!rowId || !id) return stale(rowId, id, qty);
    const { matches } = matchingStorageLots(lots, cargo, conflicts);
    if (matches.length !== 1) return stale(rowId, id, qty);
    const source = matches[0];
    const { row, batch } = source;
    if (!grouped.has(source)) grouped.set(source, { rowId, batchId: id, qty: 0, row, batch,
      ageQd: whole(batch.ageQd, 0, Number.MAX_SAFE_INTEGER) });
    const requirement = grouped.get(source);
    requirement.qty += qty;
    sources[index] = requirement;
  }
  const prepared = [...grouped.values()];
  for (const requirement of prepared) {
    const available = whole(requirement.batch.qty);
    if (available < requirement.qty) return stale(requirement.rowId, requirement.batchId, requirement.qty, available);
  }
  return { ok: true, prepared, sources };
}

export function applyMarketOutboundDispatch({ resources = [], cargoReservations = [], orderCargo = cargoReservations,
  conflicts, canLoadSource = () => true } = {}) {
  const preflight = preflightMarketOutboundDispatch({ resources, cargoReservations, orderCargo, conflicts });
  if (!preflight.ok) return preflight;
  const unavailable = new Set(preflight.prepared.filter((source) => !canLoadSource(source)));
  for (const requirement of preflight.prepared) {
    if (!unavailable.has(requirement)) requirement.batch.qty = whole(requirement.batch.qty) - requirement.qty;
  }
  for (const row of new Set(preflight.prepared.map(({ row }) => row))) {
    row.batches = row.batches.filter((batch) => whole(batch?.qty) > 0);
    row.qty = row.batches.reduce((sum, batch) => sum + whole(batch?.qty), 0);
  }
  const cargo = (cargoReservations ?? []).map((row, index) => {
    const source = preflight.sources[index];
    return { ...row, qty: unavailable.has(source) ? 0 : row.qty,
      ageQd: source?.ageQd ?? whole(row?.reservedAgeQd ?? row?.ageQd),
      roomId: text(source?.row.roomId ?? source?.row.storageRoomId ?? row?.roomId) || "outdoors" };
  });
  return { ok: true, cargo, dispatchedQty: cargo.reduce((sum, row) => sum + whole(row?.qty), 0) };
}

function outboundTransportSnapshot(plan, route, batchCount = 1) {
  const sourceBatch = plan.batchCount > 1 ? route.shipmentBatches?.[plan.batchIndex]
    : route.shipmentBatches?.length === 1 ? route.shipmentBatches[0] : null;
  const billed = route.transportPlan?.billing;
  const freightParts = allocateMarketTransportCharges(plan.freightCopper, [
    sourceBatch?.routeCopper ?? billed?.freightCopper ?? plan.freightCopper,
    sourceBatch?.handlingCopper ?? billed?.handlingCopper ?? 0,
    sourceBatch?.expressSurchargeCopper ?? billed?.expressSurchargeCopper ?? 0
  ]);
  return marketTransportPlanForOrder(route.transportPlan, {
    transportLegCosts: plan.transportLegCosts ?? sourceBatch?.transportLegCosts, batchCount, freightCopper: freightParts[0],
    insuranceCopper: plan.insuranceCopper, taxCopper: plan.tariffCopper, handlingCopper: freightParts[1],
    expressSurchargeCopper: freightParts[2], deliveryCopper: plan.upfrontCopper,
    serviceLevel: plan.serviceLevel ?? route.serviceLevel ?? "standard", allowReallocation: true
  });
}
