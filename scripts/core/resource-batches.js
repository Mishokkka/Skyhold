import { transportCargoReservations, expireTransportReservation } from "../data/transport/state.js";

export const MAX_RESOURCE_BATCHES = 8;
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

function whole(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

function hasOwn(value, key) {
  return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key));
}

function fallbackBatchId(index = 0) {
  return `batch-${index + 1}`;
}

function safeIdPart(value = "") {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9а-яё_-]+/gi, "-").replace(/^-+|-+$/g, "") || "custom";
}

function rowBatchPrefix(row = {}) {
  const resource = safeIdPart(row.resourceId ?? row.name ?? row.label);
  const room = safeIdPart(row.roomId ?? row.storageRoomId ?? "outdoors");
  return `batch-${resource}-${room}`;
}

function batchId(rawId, index, makeId) {
  const id = String(rawId ?? "").trim();
  if (id) return id;
  const generated = typeof makeId === "function" ? String(makeId("batch", 12, index) ?? "").trim() : "";
  return generated || fallbackBatchId(index);
}

function canonicalBatch(raw = {}, index = 0, makeId = null) {
  const qty = whole(raw?.qty ?? raw?.quantity ?? raw?.count, 0);
  if (!qty) return null;
  const internalDemandAvailableFromQd = whole(raw?.internalDemandAvailableFromQd, 0);
  return {
    id: batchId(raw?.id, index, makeId),
    qty,
    ageQd: whole(raw?.ageQd, 0),
    ...(internalDemandAvailableFromQd > 0 ? { internalDemandAvailableFromQd } : {})
  };
}

function fifoSort(left, right) {
  return right.ageQd - left.ageQd || String(left.id).localeCompare(String(right.id));
}

function mergeDuplicateIds(batches = []) {
  const merged = new Map();
  for (const batch of batches) {
    const existing = merged.get(batch.id);
    if (!existing) {
      merged.set(batch.id, { ...batch });
      continue;
    }
    existing.qty += batch.qty;
    existing.ageQd = Math.max(existing.ageQd, batch.ageQd);
    const internalDemandAvailableFromQd = Math.max(
      whole(existing.internalDemandAvailableFromQd, 0),
      whole(batch.internalDemandAvailableFromQd, 0)
    );
    if (internalDemandAvailableFromQd > 0) existing.internalDemandAvailableFromQd = internalDemandAvailableFromQd;
    else delete existing.internalDemandAvailableFromQd;
  }
  return [...merged.values()];
}

function closestPair(batches = [], protectedBatchIds = new Set()) {
  let best = null;
  for (let left = 0; left < batches.length - 1; left += 1) {
    for (let right = left + 1; right < batches.length; right += 1) {
      const a = batches[left];
      const b = batches[right];
      if (protectedBatchIds.has(a.id) && protectedBatchIds.has(b.id)) continue;
      const candidate = {
        left,
        right,
        distance: Math.abs(a.ageQd - b.ageQd),
        olderAge: Math.max(a.ageQd, b.ageQd),
        idKey: [String(a.id), String(b.id)].sort().join("\u0000")
      };
      if (!best
        || candidate.distance < best.distance
        || (candidate.distance === best.distance && candidate.olderAge > best.olderAge)
        || (candidate.distance === best.distance && candidate.olderAge === best.olderAge && candidate.idKey < best.idKey)) {
        best = candidate;
      }
    }
  }
  return best;
}

export function compactResourceBatches(rawBatches = [], {
  maxBatches = MAX_RESOURCE_BATCHES,
  protectedBatchIds = new Set()
} = {}) {
  const limit = Math.max(1, whole(maxBatches, MAX_RESOURCE_BATCHES));
  const batches = mergeDuplicateIds(rawBatches.map((batch, index) => canonicalBatch(batch, index)).filter(Boolean));
  while (batches.length > limit) {
    const pair = closestPair(batches, protectedBatchIds);
    const fallbackPair = pair ?? closestPair(batches, new Set());
    if (!fallbackPair) break;
    const left = batches[fallbackPair.left];
    const right = batches[fallbackPair.right];
    const protectedBatch = protectedBatchIds.has(left.id) ? left : (protectedBatchIds.has(right.id) ? right : null);
    const older = protectedBatch ?? (left.ageQd > right.ageQd
      ? left
      : (right.ageQd > left.ageQd ? right : (String(left.id) <= String(right.id) ? left : right)));
    const merged = {
      id: older.id,
      qty: left.qty + right.qty,
      ageQd: Math.max(left.ageQd, right.ageQd),
      ...(
        Math.max(
          whole(left.internalDemandAvailableFromQd, 0),
          whole(right.internalDemandAvailableFromQd, 0)
        ) > 0
          ? {
            internalDemandAvailableFromQd: Math.max(
              whole(left.internalDemandAvailableFromQd, 0),
              whole(right.internalDemandAvailableFromQd, 0)
            )
          }
          : {}
      )
    };
    batches.splice(fallbackPair.right, 1);
    batches.splice(fallbackPair.left, 1, merged);
  }
  return batches.sort(fifoSort);
}

export function normalizeResourceBatches(rawBatches, {
  fallbackQty = 0,
  makeId = null,
  maxBatches = MAX_RESOURCE_BATCHES,
  compact = true,
  protectedBatchIds = new Set()
} = {}) {
  const source = Array.isArray(rawBatches)
    ? rawBatches
    : (whole(fallbackQty, 0) ? [{ qty: whole(fallbackQty, 0), ageQd: 0 }] : []);
  const batches = mergeDuplicateIds(source.map((batch, index) => canonicalBatch(batch, index, makeId)).filter(Boolean));
  return compact ? compactResourceBatches(batches, { maxBatches, protectedBatchIds }) : batches.sort(fifoSort);
}

export function resourceBatchTotal(batches = []) {
  return batches.reduce((sum, batch) => sum + whole(batch?.qty, 0), 0);
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

export function syncResourceRowBatches(row = {}, {
  compact = true,
  maxBatches = MAX_RESOURCE_BATCHES,
  protectedBatchIds = new Set()
} = {}) {
  if (!row || typeof row !== "object") return row;
  const authoritative = hasOwn(row, "batches");
  const prefix = rowBatchPrefix(row);
  row.batches = normalizeResourceBatches(authoritative ? row.batches : null, {
    fallbackQty: authoritative ? 0 : (row.qty ?? row.quantity ?? row.count),
    makeId: (_kind, _length, index = 0) => `${prefix}-${index + 1}`,
    compact,
    maxBatches,
    protectedBatchIds
  });
  row.qty = resourceBatchTotal(row.batches);
  return row;
}

function nextBatchId(row = {}, makeId = null, holding = null) {
  const ids = new Set((row.batches ?? []).map((batch) => String(batch.id)));
  for (const batch of productionReservedBatches(holding)) ids.add(String(batch.id));
  for (const id of protectedResourceBatchIds(holding, row)) ids.add(id);
  for (const id of activePeriods.get(holding)?.oldBatchIds ?? []) ids.add(id);
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

export function reservedResourceBatchQuantities(holding, row = {}) {
  const rowId = String(row?.id ?? "").trim();
  if (!rowId) return new Map();
  const terminal = new Set(["delivered", "lost", "cancelled"]);
  const result = new Map();
  for (const order of [...(holding?.special?.market?.outbound?.orders ?? []),
    { status: "booked", dispatchStatus: "booked", cargoReservations: transportCargoReservations(holding) }]) {
    if (terminal.has(String(order?.status ?? "")) || String(order?.dispatchStatus ?? "booked") !== "booked") continue;
    for (const cargo of order?.cargoReservations ?? order?.cargo ?? []) {
      if (String(cargo?.rowId ?? cargo?.storageRowId ?? "") !== rowId) continue;
      const id = String(cargo?.batchId ?? "").trim();
      const qty = whole(cargo?.qty, 0);
      if (id && qty) result.set(id, (result.get(id) ?? 0) + qty);
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

function currentBatchAge(holding, batch) {
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
    const state = activePeriods.get(holding);
    if (state?.currentStep !== null && state?.currentStep !== undefined) state.birthSteps.set(incoming[0].id, state.currentStep + 1);
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
  const ordered = [...row.batches].sort((a, b) => currentBatchAge(holding, b) - currentBatchAge(holding, a) || fifoSort(a, b));
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
  return normalizeResourceBatches(hasOwn(row, "batches") ? row.batches : null, {
    fallbackQty: hasOwn(row, "batches") ? 0 : row.qty,
    compact,
    protectedBatchIds
  }).map((batch) => ({ ...batch }));
}

export function availableResourceBatchInventory(row = {}, holding = null, { compact = true } = {}) {
  const reserved = reservedResourceBatchQuantities(holding, row);
  return resourceBatchInventory(row, { compact: compact && !isResourceBatchPeriodActive(holding), protectedBatchIds: protectedResourceBatchIds(holding, row) }).map((batch) => ({
    ...batch,
    ageQd: currentBatchAge(holding, batch),
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
    const multiplierApplies = isPerishableFoodForRow(row);
    const multiplier = multiplierApplies ? Math.max(1, Number(roomMultiplierForRow(row)) || 1) : 1;
    const effectiveShelfLifeQd = shelfLifeQd > 0 ? Math.max(1, Math.floor(shelfLifeQd * multiplier)) : 0;
    if (effectiveShelfLifeQd > 0) {
      const kept = [];
      for (const batch of row.batches) {
        if (batch.ageQd >= effectiveShelfLifeQd) {
          expireTransportReservation(holding, String(row.id ?? ""), batch.id);
          expired.push({
            rowId: String(row.id ?? ""),
            resourceId: String(row.resourceId ?? row.id ?? "custom"),
            name: String(row.name ?? row.label ?? ""),
            roomId: String(row.roomId ?? row.storageRoomId ?? "outdoors"),
            batchId: batch.id,
            qty: batch.qty,
            ageQd: batch.ageQd,
            shelfLifeQd,
            effectiveShelfLifeQd
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
