import { bindSharedMarketHolding } from "../../data/market/shared-context.js";
import { activeTransportOrder, transportOrders } from "../../data/transport/state.js";
import { transportClockOffsetQd, transportHoldingQd } from "../../data/transport/clock.js";
import { advanceTransportShipments } from "./orders.js";
import { adoptProjectedTransportBookings, resolveTransportIncident, transportVehicleDependencies } from "../../engines/transport/runtime.js";

const clone = value => structuredClone(value);
const pending = run => run?.incident?.status === "pending";
const orderFor = (data, claim) => transportOrders(data.holdings.find(row => row.id === claim.holdingId)).find(row => row.id === claim.orderId);

function carrierReviewRows(data, holding, commonTarget) {
  const state = data.meta.transportV2, dependencies = new Map();
  for (const order of transportOrders(holding).filter(activeTransportOrder)) {
    for (const run of transportVehicleDependencies(state, order, commonTarget)) dependencies.set(run.id, run);
  }
  return [...dependencies.values()].flatMap(run => {
    const owners = [...new Set(run.claims.map(claim => claim.holdingId))].filter(id => id !== holding.id);
    if (!owners.length) return [];
    const blockers = owners.map(id => {
      const related = data.holdings.find(row => row.id === id);
      const remaining = run.releaseQd - transportClockOffsetQd(data, related) - Number(related.gm?.calendaria?.lastQd ?? 0);
      const qd = Math.max(0, Math.ceil(remaining / 40) * 40);
      return { holdingId: id, name: related?.name || id, qd, currentDate: qd === 0,
        reason: "Общий транспорт ещё не завершил предыдущий рейс этого поселения. Сначала обработайте его перевозки." };
    });
    const claim = run.claims[0], service = orderFor(data, claim)?.stages[claim.stage]?.service;
    return [{ runId: `carrier:${run.id}`, sourceRunId: run.id, sourceClaims: clone(run.claims), carrier: true, name: run.serviceLabel || service?.label || run.serviceId,
      from: service?.fromLabel || run.from, to: service?.toLabel || run.to,
      atQd: run.arrivalQd, localQd: run.arrivalQd - transportClockOffsetQd(data, holding),
      canResolve: false, canLose: false, blockers }];
  });
}

function carrierPrerequisites(data, row, { includeUnreadyInputs = false } = {}) {
  // Incident discovery must include a delayed feeder beyond an obsolete booking.
  // Confirmation still freezes only the actual dated physical prerequisites.
  const state = data.meta.transportV2, roots = state.runs.filter(run => run.id === row.sourceRunId);
  if (!roots.length) for (const claim of row.sourceClaims) {
    const order = orderFor(data, claim);
    const plannedRuns = order?.stages.slice(0, claim.stage + 1).flatMap(stage => stage.runs) ?? [];
    for (const planned of plannedRuns) {
      const run = state.runs.find(run => run.id === planned.id);
      if (run) roots.push(run);
    }
  }
  const required = new Map(roots.map(run => [run.id, run]));
  for (const run of required.values()) {
    for (const claim of run.claims) for (const stage of orderFor(data, claim)?.stages.slice(0, claim.stage + 1) ?? []) {
      for (const planned of stage.runs) {
        const prior = state.runs.find(row => row.id === planned.id);
        if (prior && (stage.index < claim.stage ? includeUnreadyInputs || prior.arrivalQd <= run.startQd : prior.startQd < run.startQd)) required.set(prior.id, prior);
      }
    }
    if (run.kind !== "regular") for (const prior of state.runs) {
      if (prior.status !== "cancelled" && prior.startQd < run.startQd
        && (run.shipId ? prior.shipId === run.shipId : prior.serviceId === run.serviceId && prior.vehicle === run.vehicle)) required.set(prior.id, prior);
    }
  }
  return [...required.values()].sort((a, b) => a.startQd - b.startQd || a.id.localeCompare(b.id));
}

/** Detached logistics only. Household clocks, cash, inventory and ship state never escape this projection. */
export function projectTendayTransport(data, holding, targetQd, workflow, { calendarStart = null } = {}) {
  if (!transportOrders(holding).some(activeTransportOrder)) return null;
  const draft = { ...data, meta: { ...data.meta, transportV2: clone(data.meta.transportV2),
    ...(data.meta.sharedMarkets ? { sharedMarkets: clone(data.meta.sharedMarkets) } : {}) }, holdings: data.holdings.map(clone) };
  const current = draft.holdings.find(row => row.id === holding.id);
  if (calendarStart) workflow._commitCalendariaEconomyAdvance(current, calendarStart);
  for (const row of draft.holdings) bindSharedMarketHolding(row, draft.meta.sharedMarkets);
  const commonTarget = transportHoldingQd(draft, current, targetQd), state = draft.meta.transportV2;
  const sourceClocks = new Map(draft.holdings.flatMap(row => transportOrders(row).map(order => [order, order.lastProcessedQd])));
  const advance = row => {
    try { return advanceTransportShipments(draft, row, commonTarget - transportClockOffsetQd(draft, row), workflow,
      { log: false, deferInternalDemand: true, retainRuns: true }); }
    finally { for (const order of transportOrders(row)) order.lastProcessedQd = sourceClocks.get(order); }
  };
  advance(current);
  const carrierRows = carrierReviewRows(draft, current, commonTarget);
  const owns = run => run.claims.some(claim => claim.holdingId === holding.id);
  if (!carrierRows.length && !state.runs.some(run => pending(run) && run.incident.atQd <= commonTarget && owns(run))) return null;

  // Related logistics are forecast only. Work to a stable physical schedule so crossed
  // vehicle dependencies do not require either household to Apply first.
  const selected = new Set([holding.id]), issues = new Map();
  const signature = () => JSON.stringify(state.runs.map(run => [run.id, run.status, run.arrivalQd, run.releaseQd,
    run.incident, run.claims.map(claim => [claim.holdingId, claim.orderId, claim.manifestReady])]));
  let changed;
  do {
    const before = signature(), count = selected.size;
    const needed = carrierRows.flatMap(row => carrierPrerequisites(draft, row, { includeUnreadyInputs: true }));
    for (const run of needed) for (const claim of run.claims) selected.add(claim.holdingId);
    for (const id of selected) {
      const related = draft.holdings.find(row => row.id === id);
      if (!related || transportOrders(related).some(order => activeTransportOrder(order) && order.lastProcessedQd > commonTarget)) continue;
      try { advance(related); }
      catch (error) { if (id === holding.id) throw error; issues.set(id, error.message); }
      for (const order of transportOrders(related).filter(activeTransportOrder)) {
        for (const run of transportVehicleDependencies(state, order, commonTarget)) for (const claim of run.claims) selected.add(claim.holdingId);
      }
    }
    const requiredIds = new Set(carrierRows.flatMap(row => carrierPrerequisites(draft, row, { includeUnreadyInputs: true })).map(run => run.id));
    for (const run of state.runs.filter(run => pending(run) && run.incident.atQd <= commonTarget && (owns(run) || requiredIds.has(run.id)))) {
      for (const claim of run.claims) if (!claim.manifestReady) selected.add(claim.holdingId);
    }
    changed = count !== selected.size || before !== signature();
  } while (changed);
  const requiredIds = new Set(carrierRows.flatMap(row => carrierPrerequisites(draft, row, { includeUnreadyInputs: true })).map(run => run.id));
  const incidents = state.runs.filter(run => pending(run) && run.incident.atQd <= commonTarget && (owns(run) || requiredIds.has(run.id)));
  for (const row of carrierRows) {
    const required = carrierPrerequisites(draft, row);
    row.prerequisiteRunIds = required.map(run => run.id);
    row.canConfirm = required.length > 0 && required.every(run => run.arrivalQd > commonTarget || run.status === "arrived" && !pending(run))
      && row.blockers.every(blocker => !issues.has(blocker.holdingId));
    for (const blocker of row.blockers) if (issues.has(blocker.holdingId)) blocker.reason = issues.get(blocker.holdingId);
  }
  const rows = incidents.map(original => {
    const run = state.runs.find(row => row.id === original.id);
    const blockers = run.claims.filter(claim => !claim.manifestReady).map(claim => {
      const related = data.holdings.find(row => row.id === claim.holdingId);
      const offset = transportClockOffsetQd(data, related);
      const qd = Math.max(40, Math.ceil((commonTarget - offset - Number(related.gm?.calendaria?.lastQd ?? 0)) / 40) * 40);
      return { holdingId: related.id, name: related.name || related.id, qd,
        reason: issues.get(related.id) || "Сначала разберите предыдущие участки связанных перевозок." };
    });
    const live = data.meta.transportV2.runs.find(row => row.id === run.id);
    const legacy = pending(live ?? {}) && live.claims.some(claim => orderFor(data, claim)?.stages[claim.stage]?.receipts.some(receipt => receipt.runId === live.id));
    const ownClaim = run.claims.find(claim => claim.holdingId === holding.id) ?? run.claims[0], service = orderFor(draft, ownClaim)?.stages[ownClaim.stage]?.service;
    const pointName = id => id.endsWith(":holding") ? holding.name : data.catalog?.eventRegions?.find(region => region.value === id)?.label || id;
    return { runId: run.id, name: run.serviceLabel || run.serviceId, from: service?.fromLabel || pointName(run.from), to: service?.toLabel || pointName(run.to),
      atQd: run.incident.atQd, localQd: run.incident.atQd - transportClockOffsetQd(draft, current),
      canLose: blockers.length === 0, legacy,
      blockers: [...new Map(blockers.map(row => [row.holdingId, row])).values()] };
  }).concat(carrierRows).sort((a, b) => a.atQd - b.atQd || a.runId.localeCompare(b.runId));
  const next = rows.findIndex(row => row.carrier ? row.canConfirm : row.blockers.length === 0);
  for (const [index, row] of rows.entries()) row.canResolve = index === next;
  return { data: draft, rows, commonTarget };
}

/** Freeze known physical prerequisites; local receipts, stores, money and clocks stay untouched. */
export function commitTendayCarrierDecision(data, projection, runId) {
  const row = projection?.rows.find(row => row.runId === runId);
  if (!row?.carrier || !row.canResolve || !row.canConfirm) throw new Error("Сначала разберите происшествия предыдущих рейсов. Обновите расчёт.");
  const state = data.meta.transportV2;
  // The original booking can disappear after a lost feeder. Adopt that now-empty
  // prefix as well, otherwise its phantom reservation would block the next review.
  adoptProjectedTransportBookings({ state, holdings: data.holdings, projectedData: projection.data,
    runId: row.sourceRunId, prefixClaims: row.sourceClaims, atQd: projection.commonTarget });
  for (const id of row.prerequisiteRunIds) adoptProjectedTransportBookings({ state, holdings: data.holdings, projectedData: projection.data, runId: id });
  for (const id of row.prerequisiteRunIds) {
    const forecast = projection.data.meta.transportV2.runs.find(run => run.id === id);
    const live = state.runs.find(run => run.id === id);
    if (forecast.status !== "arrived" || forecast.arrivalQd > projection.commonTarget) continue;
    live.status = "arrived"; live.riskChecked = forecast.riskChecked;
    live.arrivalQd = forecast.arrivalQd; live.releaseQd = forecast.releaseQd;
    live.incident = clone(forecast.incident);
    for (const claim of live.claims) {
      const manifest = forecast.claims.find(row => row.holdingId === claim.holdingId && row.orderId === claim.orderId && row.stage === claim.stage);
      if (manifest?.manifestReady) { claim.cargo = clone(manifest.cargo); claim.manifestReady = true; }
    }
  }
  return { runId, prerequisites: row.prerequisiteRunIds.length };
}

/** Commit an explicit GM decision and its booking prerequisites, never projected deliveries or payments. */
export function commitTendayTransportDecision(data, projection, runId, resolution) {
  const row = projection?.rows.find(entry => entry.runId === runId);
  const projected = projection?.data.meta.transportV2.runs.find(run => run.id === runId);
  if (!row || !pending(projected)) throw new Error("Этот рейс больше не ожидает решения в выбранном периоде. Обновите расчёт.");
  if (!row.canResolve) throw new Error("Сначала разберите более ранние происшествия и предыдущие участки связанных перевозок.");
  if (resolution?.outcome === "loss" && !row.canLose) throw new Error("Сначала разберите предыдущие участки связанных перевозок: состав общего груза ещё не определён.");
  const state = data.meta.transportV2;
  const atQd = row.legacy ? state.clockQd : projected.incident.atQd;
  // Validate and allocate on the draft first; even invalid commands cannot partly rebook live data.
  resolveTransportIncident(projection.data.meta.transportV2, runId, { ...resolution, atQd });
  adoptProjectedTransportBookings({ state, holdings: data.holdings, projectedData: projection.data, runId });
  const live = state.runs.find(run => run.id === runId);
  // The projection has verified the frozen cargo, including known feeder losses and expiry.
  for (const claim of live.claims) {
    const manifest = projected.claims.find(entry => entry.holdingId === claim.holdingId && entry.orderId === claim.orderId && entry.stage === claim.stage);
    if (manifest?.manifestReady) { claim.cargo = clone(manifest.cargo); claim.manifestReady = true; }
  }
  live.incident = clone(projected.incident);
  live.arrivalQd = projected.arrivalQd;
  live.releaseQd = projected.releaseQd;
  live.riskChecked = true;
  return { runId, atQd: live.incident.atQd, outcome: live.incident.outcome };
}

export function transportTendayWarnings(holding) {
  return transportOrders(holding).flatMap(order => {
    const title = order.commercial?.marketLabel || order.id;
    const warnings = [];
    if (order.status === "needsResolution") warnings.push({ key: `transport-incident:${order.id}`, severity: "warning", text: `Перевозка ${title}: требуется решение ГМа.` });
    if (order.fundingNeededCopper) warnings.push({ key: `transport-funding:${order.id}`, severity: "warning", text: `Перевозка ${title}: для расчёта корабля нужно ещё ${order.fundingNeededCopper} ММ.` });
    if (order.status === "waitingCarrier") warnings.push({ key: `transport-wait:${order.id}`, severity: "warning", text: `Перевозка ${title}: ожидает транспорта. ${order.replanFailure?.message || ""}`.trim() });
    return warnings;
  });
}
