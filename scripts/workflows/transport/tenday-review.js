import { bindSharedMarketHolding } from "../../data/market/shared-context.js";
import { activeTransportOrder, transportOrders } from "../../data/transport/state.js";
import { transportClockOffsetQd, transportHoldingQd } from "../../data/transport/clock.js";
import { advanceTransportShipments } from "./orders.js";
import { adoptProjectedTransportBookings, resolveTransportIncident } from "../../engines/transport/runtime.js";

const clone = value => structuredClone(value);
const pending = run => run.incident?.status === "pending";
const orderFor = (data, claim) => transportOrders(data.holdings.find(row => row.id === claim.holdingId)).find(row => row.id === claim.orderId);

/** Detached logistics only. Household clocks, cash, inventory and ship state never escape this projection. */
export function projectTendayTransport(data, holding, targetQd, workflow, { calendarStart = null } = {}) {
  if (!transportOrders(holding).some(activeTransportOrder)) return null;
  const draft = { ...data, meta: { ...data.meta, transportV2: clone(data.meta.transportV2),
    ...(data.meta.sharedMarkets ? { sharedMarkets: clone(data.meta.sharedMarkets) } : {}) }, holdings: data.holdings.map(clone) };
  const current = draft.holdings.find(row => row.id === holding.id);
  if (calendarStart) workflow._commitCalendariaEconomyAdvance(current, calendarStart);
  for (const row of draft.holdings) bindSharedMarketHolding(row, draft.meta.sharedMarkets);
  advanceTransportShipments(draft, current, targetQd, workflow, { log: false, deferInternalDemand: true });
  const commonTarget = transportHoldingQd(draft, current, targetQd), state = draft.meta.transportV2;
  const owns = run => run.claims.some(claim => claim.holdingId === holding.id);
  const incidents = state.runs.filter(run => pending(run) && run.incident.atQd <= commonTarget && owns(run));
  if (!incidents.length) return null;

  // Loss is shared by actual claimants. Forecast related departures without applying
  // another holding's economy, so two connecting holdings need not wait on each other's Apply.
  const attempted = new Set([holding.id]), issues = new Map();
  for (const run of incidents) for (const claim of run.claims) {
    if (claim.manifestReady || attempted.has(claim.holdingId)) continue;
    attempted.add(claim.holdingId);
    const related = draft.holdings.find(row => row.id === claim.holdingId);
    if (!related) continue;
    const relatedTarget = commonTarget - transportClockOffsetQd(draft, related);
    if (transportOrders(related).some(order => activeTransportOrder(order) && order.lastProcessedQd > commonTarget)) continue;
    try { advanceTransportShipments(draft, related, relatedTarget, workflow, { log: false, deferInternalDemand: true }); }
    catch (error) { issues.set(related.id, error.message); }
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
    const ownClaim = run.claims.find(claim => claim.holdingId === holding.id), service = orderFor(draft, ownClaim)?.stages[ownClaim.stage]?.service;
    const pointName = id => id.endsWith(":holding") ? holding.name : data.catalog?.eventRegions?.find(region => region.value === id)?.label || id;
    return { runId: run.id, name: run.serviceLabel || run.serviceId, from: service?.fromLabel || pointName(run.from), to: service?.toLabel || pointName(run.to),
      atQd: run.incident.atQd, localQd: run.incident.atQd - transportClockOffsetQd(draft, current),
      canLose: blockers.length === 0, legacy,
      blockers: [...new Map(blockers.map(row => [row.holdingId, row])).values()] };
  }).sort((a, b) => a.atQd - b.atQd || a.runId.localeCompare(b.runId));
  const next = rows.findIndex(row => row.blockers.length === 0);
  for (const [index, row] of rows.entries()) row.canResolve = index === next;
  return { data: draft, rows, commonTarget };
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
