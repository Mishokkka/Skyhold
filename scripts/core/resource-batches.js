import { effectiveShelfLifeQd } from "./perishable-food.js";
import { activeTransportOrder, expireTransportReservation, outboundStorageLotConflicts, remainingTransportCargo, transportOrders } from "../data/transport/state.js";
import { indexStorageLots, matchingStorageLots } from "../engines/storage/row-identity.js";

import {
  MAX_RESOURCE_BATCHES, compactResourceBatches, fifoSort, hasOwn, normalizeResourceBatches,
  normalizedRowBatches, resourceBatchTotal, rowBatchPrefix, syncResourceRowBatches, whole
} from "./resource-batch-data.js";

export { MAX_RESOURCE_BATCHES, compactResourceBatches, normalizeResourceBatches, resourceBatchTotal, syncResourceRowBatches };

export const INTERNAL_DEMAND_BATCH_COOLDOWN_QD = 40;

const activePeriods = new WeakMap();

function productionReservedBatches(holding, rowId = null) {
  return (holding?.buildings?.list ?? []).flatMap((building) => (building.productionLines ?? [])
    .flatMap((line) => [line, ...(line.waitingBatches ?? [])])
    .filter((batch) => batch.workInputsReserved && batch.workReservedInputs?.version === 1)
    .flatMap((batch) => (batch.workReservedInputs.entries ?? [])
      .filter((entry) => rowId === null || String(entry.resource?.storageRowId ?? entry.resource?.id ?? "") === rowId)
      .flatMap((entry) => entry.batches ?? [])));
}

export function internalDemandBatchClockQd(holding = {}) {
  return whole(holding?.gm?.calendaria?.lastQd, 0);
}

export function nextInternalDemandBatchAvailabilityQd(holding = {}, delayQd = INTERNAL_DEMAND_BATCH_COOLDOWN_QD) {
  return internalDemandBatchClockQd(holding) + Math.max(1, whole(delayQd, INTERNAL_DEMAND_BATCH_COOLDOWN_QD));
}

export function resourceBatchAvailableToInternalDemand(batch = {}, holding = {}) {
  return whole(batch?.internalDemandAvailableFromQd, 0) <= internalDemandBatchClockQd(holding);
}

function nextBatchId(row = {}, makeId = null, holding = null, excludedIds = []) {
  const ids = new Set([...excludedIds, ...(row.batches ?? []).map((batch) => String(batch.id))]);
  for (const batch of productionReservedBatches(holding)) ids.add(String(batch.id));
  for (const id of protectedResourceBatchIds(holding, row)) ids.add(id);
  const period = activePeriods.get(holding);
  for (const id of period?.oldBatchIds ?? []) ids.add(id);
  for (const id of period?.birthSteps.keys() ?? []) ids.add(id);
  if (typeof makeId === "function") {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = String(makeId("batch", 12) ?? "").trim();
      if (id && !ids.has(id)) return id;
    }
  }
  const prefix = rowBatchPrefix(row);
  let index = 1;
  while (ids.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}

export function isResourceBatchPeriodActive(holding) {
  return Boolean(holding && typeof holding === "object" && activePeriods.has(holding));
}

export function protectedResourceBatchIds(holding, row = {}) {
  return new Set([...reservedResourceBatchQuantities(holding, row).keys(),
    ...productionReservedBatches(holding, String(row?.id ?? "")).map((batch) => batch.id)]);
}

export function reservedResourceBatchQuantities(holding, row = {}, { excludeOperationId = "" } = {}) {
  const rowId = String(row?.id ?? "").trim();
  if (!rowId) return new Map();
  const terminal = new Set(["delivered", "lost", "cancelled"]);
  const result = new Map();
  let sources, conflicts, sourceRows;
  const transports = transportOrders(holding).filter((order) => activeTransportOrder(order) && order.direction === "outbound")
    .map((order) => ({ cargoReservations: remainingTransportCargo(order) }));
  for (const order of [...(holding?.special?.market?.outbound?.orders ?? []), ...transports]) {
    if (terminal.has(String(order?.status ?? "")) || String(order?.dispatchStatus || "booked") !== "booked"
      || (excludeOperationId && [order?.id, order?.operationId].some((id) => String(id ?? "").trim() === excludeOperationId))) continue;
    const reservations = order?.cargoReservations ?? order?.cargo ?? [];
    for (const cargo of reservations) {
      if (String(cargo?.rowId ?? cargo?.storageRowId ?? "").trim() !== rowId) continue;
      const id = String(cargo?.batchId ?? "").trim();
      const qty = whole(cargo?.qty, 0);
      if (!id || !qty) continue;
      if (!sources) {
        const storedRows = holding?.storage?.resources ?? [];
        const addressedRows = storedRows.filter((candidate) => String(candidate?.id ?? "").trim() === rowId);
        // Prefer physical rows from the holding. A copied row or an ID-only caller
        // must not introduce a second lot into the index.
        if (addressedRows.includes(row)) sourceRows = [row];
        else if (row.resourceId || row.batches) {
          sourceRows = addressedRows.filter((candidate) => candidate.resourceId === row.resourceId
            && (candidate.roomId ?? candidate.storageRoomId) === (row.roomId ?? row.storageRoomId)
            && (row.resourceId !== "custom" || candidate.name === row.name));
        } else sourceRows = addressedRows;
        if (!addressedRows.length && (row.resourceId || row.batches)) sourceRows = [row];
        sources = indexStorageLots(addressedRows.length ? addressedRows : sourceRows, rowId);
      }
      if (sources.size) {
        conflicts ??= outboundStorageLotConflicts(holding);
        const { matches, compatibleRows } = matchingStorageLots(sources, cargo, conflicts);
        // Keep compatible rows protected even when a booking no longer resolves a lot.
        const candidates = matches.length ? matches.map((match) => match.row) : compatibleRows;
        if (!candidates.some((candidate) => sourceRows.includes(candidate))) continue;
      }
      result.set(id, (result.get(id) ?? 0) + qty);
    }
  }
  return result;
}

export function beginResourceBatchPeriod(holding, { makeId = null } = {}) {
  if (!holding || typeof holding !== "object") return { oldBatchIds: new Set() };
  const oldBatchIds = new Set();
  for (const batch of productionReservedBatches(holding)) oldBatchIds.add(batch.id);
  for (const row of holding?.storage?.resources ?? []) {
    syncResourceRowBatches(row, { makeId, protectedBatchIds: protectedResourceBatchIds(holding, row) });
    for (const batch of row.batches) oldBatchIds.add(batch.id);
  }
  const state = { oldBatchIds, birthSteps: new Map(), currentStep: null };
  activePeriods.set(holding, state);
  return state;
}

export function cancelResourceBatchPeriod(holding) {
  if (holding && typeof holding === "object") activePeriods.delete(holding);
}

/** Transient simulation clock: no persisted batch or world schema changes. */
export function setResourceBatchPeriodStep(holding, step = null) {
  const state = activePeriods.get(holding);
  if (state) state.currentStep = step === null ? null : whole(step);
}

export function resourceBatchElapsedQd(holding, batch, elapsedQd = 0) {
  const state = activePeriods.get(holding);
  if (!state) return 0;
  if (state.oldBatchIds.has(batch.id)) return whole(elapsedQd);
  const birth = state.birthSteps.get(batch.id);
  return birth === undefined ? 0 : Math.max(0, whole(elapsedQd) - birth);
}

export function resourceBatchAgeQd(holding, batch) {
  const step = activePeriods.get(holding)?.currentStep;
  return whole(batch.ageQd) + (step === null || step === undefined ? 0 : resourceBatchElapsedQd(holding, batch, step));
}

export function addResourceBatches(row = {}, input = {}, {
  holding = null,
  makeId = null,
  maxBatches = MAX_RESOURCE_BATCHES
} = {}) {
  if (!row || typeof row !== "object") return row;
  const protectedBatchIds = protectedResourceBatchIds(holding, row);
  syncResourceRowBatches(row, { makeId, compact: !isResourceBatchPeriodActive(holding), maxBatches, protectedBatchIds });
  const explicitBatches = hasOwn(input, "batches");
  const incoming = normalizeResourceBatches(explicitBatches ? input.batches : null, {
    fallbackQty: explicitBatches ? 0 : input.qty,
    makeId,
    compact: false
  });
  if (!explicitBatches && incoming.length === 1) {
    incoming[0].id = nextBatchId(row, makeId, holding);
    incoming[0].ageQd = whole(input.ageQd, 0);
    const availableFrom = whole(input.internalDemandAvailableFromQd, 0);
    if (availableFrom) incoming[0].internalDemandAvailableFromQd = availableFrom;
    const state = activePeriods.get(holding);
    if (state?.currentStep !== null && state?.currentStep !== undefined) state.birthSteps.set(incoming[0].id, state.currentStep + 1);
  }
  if (explicitBatches && incoming.length && row.batches.length) {
    const existingById = new Map(row.batches.map((batch) => [batch.id, batch]));
    const incomingIds = new Set(incoming.map((batch) => batch.id));
    const period = activePeriods.get(holding);
    for (const batch of incoming) {
      const existing = existingById.get(batch.id);
      if (!existing) continue;
      const sameCohort = batch.ageQd === existing.ageQd
        && batch.internalDemandAvailableFromQd === existing.internalDemandAvailableFromQd;
      if (sameCohort && !protectedBatchIds.has(batch.id)) continue;
      // A moved or refunded lot may have reused a legacy ID in another row.
      // Keep the destination's identity and freshness before any compaction.
      const sourceId = batch.id;
      batch.id = nextBatchId(row, makeId, holding, incomingIds);
      incomingIds.add(batch.id);
      if (period?.oldBatchIds.has(sourceId)) period.oldBatchIds.add(batch.id);
      else if (period?.birthSteps.has(sourceId)) period.birthSteps.set(batch.id, period.birthSteps.get(sourceId));
    }
  }
  row.batches.push(...incoming);
  const compact = !isResourceBatchPeriodActive(holding);
  row.batches = normalizeResourceBatches(row.batches, { makeId, compact, maxBatches, protectedBatchIds });
  row.qty = resourceBatchTotal(row.batches);
  return row;
}

export function takeResourceBatches(row = {}, qty = 0, {
  makeId = null,
  holding = null,
  reservedBatchQuantities = reservedResourceBatchQuantities(holding, row)
} = {}) {
  syncResourceRowBatches(row, {
    makeId,
    compact: !isResourceBatchPeriodActive(holding),
    protectedBatchIds: new Set([...protectedResourceBatchIds(holding, row), ...reservedBatchQuantities.keys()])
  });
  let remaining = whole(qty, 0);
  const taken = [];
  // New daily lots retain their stored age until period close. Use their
  // virtual age for FIFO without writing that age into a receipt twice.
  const ordered = [...row.batches].sort((a, b) => resourceBatchAgeQd(holding, b) - resourceBatchAgeQd(holding, a) || fifoSort(a, b));
  for (const batch of ordered) {
    if (!remaining) break;
    const available = Math.max(0, batch.qty - whole(reservedBatchQuantities.get(batch.id), 0));
    const amount = Math.min(available, remaining);
    if (!amount) continue;
    taken.push({ ...batch, qty: amount });
    batch.qty -= amount;
    remaining -= amount;
  }
  row.batches = row.batches.filter((batch) => batch.qty > 0).sort(fifoSort);
  row.qty = resourceBatchTotal(row.batches);
  return { requested: whole(qty, 0), takenQty: resourceBatchTotal(taken), batches: taken, shortfall: remaining };
}

export function takeResourceBatchById(row = {}, batchId = "", qty = 0, {
  makeId = null,
  holding = null,
  reservedBatchQuantities = reservedResourceBatchQuantities(holding, row)
} = {}) {
  syncResourceRowBatches(row, {
    makeId,
    compact: !isResourceBatchPeriodActive(holding),
    protectedBatchIds: new Set([...protectedResourceBatchIds(holding, row), ...reservedBatchQuantities.keys()])
  });
  const batch = row.batches.find((candidate) => candidate.id === String(batchId));
  const available = Math.max(0, (batch?.qty ?? 0) - whole(reservedBatchQuantities.get(String(batchId)), 0));
  const amount = Math.min(available, whole(qty, 0));
  if (!amount) return null;
  batch.qty -= amount;
  const taken = { ...batch, qty: amount };
  row.batches = row.batches.filter((candidate) => candidate.qty > 0).sort(fifoSort);
  row.qty = resourceBatchTotal(row.batches);
  return taken;
}

export function splitResourceBatchParts(rawBatches = [], qty = 0) {
  let remaining = whole(qty, 0);
  const source = normalizeResourceBatches(rawBatches, { compact: false });
  const taken = [];
  const rest = [];
  for (const batch of source) {
    const amount = Math.min(batch.qty, remaining);
    if (amount) taken.push({ ...batch, qty: amount });
    if (batch.qty > amount) rest.push({ ...batch, qty: batch.qty - amount });
    remaining -= amount;
  }
  return { batches: taken, remainingBatches: rest, takenQty: resourceBatchTotal(taken), shortfall: remaining };
}

export function resourceBatchInventory(row = {}, { compact = true, protectedBatchIds = new Set() } = {}) {
  return normalizedRowBatches(row, { compact, protectedBatchIds });
}

export function availableResourceBatchInventory(row = {}, holding = null, { compact = true } = {}) {
  const reserved = reservedResourceBatchQuantities(holding, row);
  return resourceBatchInventory(row, { compact: compact && !isResourceBatchPeriodActive(holding), protectedBatchIds: protectedResourceBatchIds(holding, row) }).map((batch) => ({
    ...batch,
    ageQd: resourceBatchAgeQd(holding, batch),
    qty: Math.max(0, batch.qty - whole(reserved.get(batch.id), 0))
  })).filter((batch) => batch.qty > 0);
}

export function availableResourceRowQuantity(row = {}, holding = null) {
  return resourceBatchTotal(availableResourceBatchInventory(row, holding));
}

export function finishResourceBatchPeriod(holding, {
  elapsedQd = 0,
  makeId = null,
  shelfLifeQdForRow = () => 0,
  categoryTagForRow = () => "",
  isPerishableFoodForRow = (row) => ["food.raw", "food.prepared"].includes(categoryTagForRow(row)),
  roomMultiplierForRow = () => 1,
  effectiveShelfLifeQdForRow = (row, baseQd) => effectiveShelfLifeQd(baseQd, isPerishableFoodForRow(row) ? roomMultiplierForRow(row) : 1),
  maxBatches = MAX_RESOURCE_BATCHES
} = {}) {
  if (!holding || typeof holding !== "object") return { expiredQty: 0, expired: [] };
  if (!activePeriods.has(holding)) beginResourceBatchPeriod(holding, { makeId });
  const delta = whole(elapsedQd, 0);
  const expired = [];
  // Reserved inputs are already removed from storage, but must retain their
  // real age if a later unsuccessful completion returns them.
  for (const batch of productionReservedBatches(holding)) {
    batch.ageQd += resourceBatchElapsedQd(holding, batch, delta);
  }
  for (const row of holding?.storage?.resources ?? []) {
    syncResourceRowBatches(row, { makeId, compact: false });
    for (const batch of row.batches) {
      batch.ageQd += resourceBatchElapsedQd(holding, batch, delta);
    }
    const shelfLifeQd = whole(shelfLifeQdForRow(row), 0);
    const deadlineQd = effectiveShelfLifeQdForRow(row, shelfLifeQd);
    if (deadlineQd > 0) {
      const kept = [];
      for (const batch of row.batches) {
        if (batch.ageQd >= deadlineQd) {
          expireTransportReservation(holding, row, batch);
          expired.push({
            rowId: String(row.id ?? ""),
            resourceId: String(row.resourceId ?? row.id ?? "custom"),
            name: String(row.name ?? row.label ?? ""),
            roomId: String(row.roomId ?? row.storageRoomId ?? "outdoors"),
            batchId: batch.id,
            qty: batch.qty,
            ageQd: batch.ageQd,
            shelfLifeQd,
            effectiveShelfLifeQd: deadlineQd
          });
        } else kept.push(batch);
      }
      row.batches = kept;
    }
    row.batches = normalizeResourceBatches(row.batches, {
      makeId,
      compact: true,
      maxBatches,
      protectedBatchIds: protectedResourceBatchIds(holding, row)
    });
    row.qty = resourceBatchTotal(row.batches);
  }
  activePeriods.delete(holding);
  return { expiredQty: expired.reduce((sum, item) => sum + item.qty, 0), expired };
}
