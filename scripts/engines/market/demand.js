import { marketStateFor, writeMarketState, sharedMarketTenday } from "../../data/market/shared-context.js";
import { marketDemandKey, marketDemandRecoveryDuration, normalizeMarketDemandState } from "../../data/market/demand-state.js";

function integer(value, fallback = 0, min = 0, max = 1_000_000_000) {
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
  return Math.min(max, Math.max(min, normalized));
}

function text(value = "") {
  return String(value ?? "").trim();
}

function demandIdForLine(line = {}) {
  return text(line.demandId ?? line.resourceId ?? line.offerId ?? line.id);
}

function ensureMarketDemand(holding, demand, tenday) {
  writeMarketState(holding, "demand", demand, tenday);
}

function demandGroups(lines = [], marketId = "") {
  const groups = new Map();
  for (const line of lines ?? []) {
    const demandId = demandIdForLine(line);
    const qty = integer(line?.qty);
    if (!demandId || !qty) continue;
    const key = marketDemandKey(marketId, demandId);
    const baseDemand = integer(line.demandBaseDemand ?? line.demandStateBaseDemand ?? line.demand);
    const revision = integer(line.demandStateRevision, 0, 0, Number.MAX_SAFE_INTEGER);
    const previous = groups.get(key);
    if (previous) {
      previous.qty += qty;
      previous.baseDemand = Math.max(previous.baseDemand, baseDemand);
      previous.revisions.add(revision);
    } else groups.set(key, { key, marketId, demandId, qty, baseDemand, revisions: new Set([revision]) });
  }
  return [...groups.values()];
}

function withDerived(row = {}) {
  const reservations = row.reservations && typeof row.reservations === "object" ? row.reservations : {};
  const reservedDemand = Object.values(reservations).reduce((sum, item) => sum + integer(item?.qty), 0);
  const baseDemand = integer(row.baseDemand);
  const consumedOutstanding = Math.min(Math.max(0, baseDemand - reservedDemand), integer(row.consumedOutstanding));
  return {
    ...row,
    baseDemand,
    reservations,
    reservedDemand: Math.min(baseDemand, reservedDemand),
    consumedOutstanding,
    availableDemand: Math.max(0, baseDemand - reservedDemand - consumedOutstanding)
  };
}

function appendOperationId(rows = [], id = "") {
  return [...new Set([...(Array.isArray(rows) ? rows : []), text(id)].filter(Boolean))].slice(-80);
}

export function marketDemandTendayIndex(holding = {}) {
  return sharedMarketTenday(holding);
}

export function marketDemandPlanToken(lines = []) {
  const rows = new Map();
  for (const line of lines ?? []) {
    const key = text(line?.demandKey);
    if (!key) continue;
    rows.set(key, {
      key,
      revision: integer(line.demandStateRevision, 0, 0, Number.MAX_SAFE_INTEGER),
      baseDemand: integer(line.demandBaseDemand)
    });
  }
  return JSON.stringify([...rows.values()].sort((left, right) => left.key.localeCompare(right.key)));
}

export function overlayMarketQuoteDemand({ holding = {}, quote = {} } = {}) {
  const demand = normalizeMarketDemandState(marketStateFor(holding, "demand"));
  const marketId = text(quote.marketId || "external-market");
  const offers = (quote.offers ?? []).map((offer) => {
    const demandId = demandIdForLine(offer);
    const key = marketDemandKey(marketId, demandId);
    const baseDemand = integer(offer.demand);
    const state = demand[key] ? withDerived(demand[key]) : null;
    const availableDemand = state ? Math.min(baseDemand, state.availableDemand) : baseDemand;
    return {
      ...offer,
      demand: availableDemand,
      demandId,
      demandKey: key,
      demandBaseDemand: baseDemand,
      demandStateBaseDemand: state?.baseDemand ?? baseDemand,
      demandStateAvailable: availableDemand,
      demandStateReserved: state?.reservedDemand ?? 0,
      demandStateConsumed: state?.consumedOutstanding ?? 0,
      demandStateRevision: state?.revision ?? 0,
      demandStateInitialized: Boolean(state)
    };
  });
  return { ...quote, offers };
}

export function reserveMarketDemand({ holding = null, marketId = "", lines = [], operationId = "", currentTenday = null, updatedAt = "" } = {}) {
  const id = text(operationId);
  const resolvedMarketId = text(marketId);
  if (!holding || !resolvedMarketId || !id) return { ok: false, message: "Market demand reservation requires holding, market and operation ids." };
  const groups = demandGroups(lines, resolvedMarketId);
  if (!groups.length) return { ok: false, empty: true, message: "Market demand reservation is empty." };
  if (groups.some((row) => row.revisions.size !== 1)) return { ok: false, stale: true, message: "Market demand revisions disagree inside one resource." };
  const demand = normalizeMarketDemandState(marketStateFor(holding, "demand"));
  const replayRows = groups.filter((row) => demand[row.key]?.reservationOperationIds?.includes(id));
  if (replayRows.length) {
    if (replayRows.length !== groups.length) return { ok: false, stale: true, message: "Market demand reservation is only partially applied." };
    return { ok: true, replay: true, reservations: groups.map((row) => ({ marketId: row.marketId, demandId: row.demandId, qty: row.qty, baseDemand: demand[row.key].baseDemand, reservationOperationId: id })) };
  }

  const tenday = sharedMarketTenday(holding, currentTenday);
  const prepared = [];
  for (const group of groups) {
    const existing = demand[group.key] ? withDerived(demand[group.key]) : null;
    const expectedRevision = [...group.revisions][0];
    if ((existing?.revision ?? 0) !== expectedRevision) return { ok: false, stale: true, key: group.key, message: "Market demand changed after quote preview." };
    const baseDemand = group.baseDemand;
    const availableDemand = existing ? Math.min(baseDemand, existing.availableDemand) : baseDemand;
    if (group.qty > availableDemand) return { ok: false, insufficient: true, key: group.key, requested: group.qty, availableDemand, message: "Market demand is insufficient." };
    prepared.push({ group, existing, baseDemand });
  }

  const reservations = [];
  for (const row of prepared) {
    const previous = row.existing ?? {
      marketId: row.group.marketId,
      demandId: row.group.demandId,
      baseDemand: row.baseDemand,
      consumedOutstanding: 0,
      reservations: {},
      recoveryStartedTenday: tenday,
      recoveryStartConsumed: 0,
      recoveryDurationTendays: marketDemandRecoveryDuration(row.group.marketId, row.group.demandId),
      lastRecoveryTenday: tenday,
      revision: 0,
      reservationOperationIds: [],
      consumptionOperationIds: [],
      restorationOperationIds: []
    };
    const next = withDerived({
      ...previous,
      baseDemand: row.baseDemand,
      reservations: {
        ...previous.reservations,
        [id]: { operationId: id, qty: row.group.qty, createdTenday: tenday, createdAt: text(updatedAt) }
      },
      revision: integer(previous.revision, 0, 0, Number.MAX_SAFE_INTEGER - 1) + 1,
      updatedAt: text(updatedAt),
      reservationOperationIds: appendOperationId(previous.reservationOperationIds, id)
    });
    demand[row.group.key] = next;
    reservations.push({ marketId: row.group.marketId, demandId: row.group.demandId, qty: row.group.qty, baseDemand: row.baseDemand, reservationOperationId: id });
  }
  ensureMarketDemand(holding, demand, tenday);
  return { ok: true, replay: false, reservations };
}

export function settleMarketDemandReservations({ holding = null, reservations = [], outcome = "consumed", operationId = "", currentTenday = null, updatedAt = "" } = {}) {
  const id = text(operationId);
  const selectedOutcome = outcome === "restored" ? "restored" : "consumed";
  if (!holding || !id) return { ok: false, message: "Market demand settlement requires holding and operation ids." };
  const grouped = new Map();
  for (const row of reservations ?? []) {
    const marketId = text(row?.marketId);
    const demandId = text(row?.demandId ?? row?.resourceId ?? row?.offerId);
    const reservationOperationId = text(row?.reservationOperationId);
    const qty = integer(row?.qty);
    if (!marketId || !demandId || !reservationOperationId || !qty) continue;
    const key = marketDemandKey(marketId, demandId);
    const groupKey = `${key}::${reservationOperationId}`;
    const previous = grouped.get(groupKey);
    const consumedQty = Math.min(qty, integer(row?.consumedQty ?? qty));
    if (previous) { previous.qty += qty; previous.consumedQty += consumedQty; }
    else grouped.set(groupKey, { key, marketId, demandId, reservationOperationId, qty, consumedQty, baseDemand: integer(row.baseDemand, qty) });
  }
  const rows = [...grouped.values()];
  if (!rows.length) return { ok: true, replay: true, outcome: selectedOutcome, qty: 0, rows: [] };
  const demand = normalizeMarketDemandState(marketStateFor(holding, "demand"));
  const historyField = selectedOutcome === "consumed" ? "consumptionOperationIds" : "restorationOperationIds";
  const replayRows = rows.filter((row) => demand[row.key]?.[historyField]?.includes(id));
  if (replayRows.length) {
    if (replayRows.length !== rows.length) return { ok: false, stale: true, message: "Market demand settlement is only partially applied." };
    return { ok: true, replay: true, outcome: selectedOutcome, qty: 0, rows: [] };
  }

  const prepared = [];
  for (const row of rows) {
    const state = demand[row.key] ? withDerived(demand[row.key]) : null;
    const reserved = integer(state?.reservations?.[row.reservationOperationId]?.qty);
    if (!state || reserved < row.qty) return { ok: false, stale: true, key: row.key, message: "Market demand reservation changed before settlement." };
    prepared.push(row);
  }

  const tenday = sharedMarketTenday(holding, currentTenday);
  const settled = [];
  for (const row of prepared) {
    // Several original orders may share this resource pool. Keep the changes
    // already made by earlier rows after validating the whole settlement above.
    const state = withDerived(demand[row.key]);
    const reserved = integer(state.reservations[row.reservationOperationId]?.qty);
    const reservationsNext = { ...state.reservations };
    if (reserved === row.qty) delete reservationsNext[row.reservationOperationId];
    else reservationsNext[row.reservationOperationId] = { ...reservationsNext[row.reservationOperationId], qty: reserved - row.qty };
    const consumedOutstanding = selectedOutcome === "consumed"
      ? Math.min(state.baseDemand, state.consumedOutstanding + row.consumedQty)
      : state.consumedOutstanding;
    demand[row.key] = withDerived({
      ...state,
      reservations: reservationsNext,
      consumedOutstanding,
      recoveryStartedTenday: selectedOutcome === "consumed" ? tenday : state.recoveryStartedTenday,
      recoveryStartConsumed: selectedOutcome === "consumed" ? consumedOutstanding : state.recoveryStartConsumed,
      recoveryDurationTendays: selectedOutcome === "consumed" ? marketDemandRecoveryDuration(row.marketId, row.demandId) : state.recoveryDurationTendays,
      lastRecoveryTenday: selectedOutcome === "consumed" ? tenday : state.lastRecoveryTenday,
      revision: integer(state.revision, 0, 0, Number.MAX_SAFE_INTEGER - 1) + 1,
      updatedAt: text(updatedAt),
      [historyField]: appendOperationId(state[historyField], id)
    });
    settled.push({ marketId: row.marketId, demandId: row.demandId, qty: selectedOutcome === "consumed" ? row.consumedQty : row.qty, releasedQty: row.qty - row.consumedQty, outcome: selectedOutcome });
  }
  ensureMarketDemand(holding, demand, tenday);
  return { ok: true, replay: false, outcome: selectedOutcome, qty: settled.reduce((sum, row) => sum + row.qty, 0), rows: settled };
}

export function recoverMarketDemand({ holding = null, currentTenday = null, baseDemandByKey = null, updatedAt = "" } = {}) {
  if (!holding) return { ok: false, message: "Market demand recovery requires a holding." };
  const tenday = sharedMarketTenday(holding, currentTenday);
  const demand = normalizeMarketDemandState(marketStateFor(holding, "demand"));
  const recovered = [];
  let changed = false;
  const capFor = (key, row) => {
    const supplied = baseDemandByKey instanceof Map ? baseDemandByKey.get(key) : baseDemandByKey?.[key];
    return supplied === undefined || supplied === null ? row.baseDemand : integer(supplied);
  };
  for (const [key, raw] of Object.entries(demand).sort(([left], [right]) => left.localeCompare(right))) {
    const row = withDerived(raw);
    const baseDemand = capFor(key, row);
    const duration = integer(row.recoveryDurationTendays, marketDemandRecoveryDuration(row.marketId, row.demandId), 2, 6);
    const startTenday = integer(row.recoveryStartedTenday, row.lastRecoveryTenday);
    const startConsumed = Math.min(baseDemand, integer(row.recoveryStartConsumed, row.consumedOutstanding));
    const elapsed = Math.max(0, tenday - startTenday);
    const progress = Math.min(1, elapsed / duration);
    const targetConsumed = Math.max(0, Math.ceil(startConsumed * (1 - progress)));
    const consumedOutstanding = Math.min(row.consumedOutstanding, targetConsumed);
    const recoveredQty = Math.max(0, row.consumedOutstanding - consumedOutstanding);
    if (!recoveredQty && baseDemand === row.baseDemand && duration === row.recoveryDurationTendays) continue;
    demand[key] = withDerived({
      ...row,
      baseDemand,
      consumedOutstanding,
      recoveryStartConsumed: startConsumed,
      recoveryDurationTendays: duration,
      lastRecoveryTenday: recoveredQty > 0 ? tenday : row.lastRecoveryTenday,
      revision: integer(row.revision, 0, 0, Number.MAX_SAFE_INTEGER - 1) + 1,
      updatedAt: text(updatedAt)
    });
    changed = true;
    if (recoveredQty) recovered.push({ key, marketId: row.marketId, demandId: row.demandId, qty: recoveredQty, availableDemand: demand[key].availableDemand, baseDemand });
  }
  if (changed) ensureMarketDemand(holding, demand, tenday);
  return { ok: true, changed, currentTenday: tenday, recoveredQty: recovered.reduce((sum, row) => sum + row.qty, 0), recovered };
}
