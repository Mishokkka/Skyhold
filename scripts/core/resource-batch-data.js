export const MAX_RESOURCE_BATCHES = 8;

export function whole(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

export function hasOwn(value, key) {
  return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key));
}

function fallbackBatchId(index = 0) {
  return `batch-${index + 1}`;
}

function safeIdPart(value = "") {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9а-яё_-]+/gi, "-").replace(/^-+|-+$/g, "") || "custom";
}

export function rowBatchPrefix(row = {}) {
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

export function fifoSort(left, right) {
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

function closestPair(batches = []) {
  let best = null;
  for (let left = 0; left < batches.length - 1; left += 1) {
    for (let right = left + 1; right < batches.length; right += 1) {
      const a = batches[left];
      const b = batches[right];
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
  const protectedBatches = [];
  const batches = [];
  for (const batch of mergeDuplicateIds(rawBatches.map((batch, index) => canonicalBatch(batch, index)).filter(Boolean))) {
    (protectedBatchIds.has(batch.id) ? protectedBatches : batches).push(batch);
  }
  // Active contracts keep their quantity, freshness and identity. The soft limit leaves
  // at least one slot for unreserved stock even if old contracts use every normal slot.
  const unreservedLimit = Math.max(1, limit - protectedBatches.length);
  while (batches.length > unreservedLimit) {
    const pair = closestPair(batches);
    const left = batches[pair.left];
    const right = batches[pair.right];
    const older = left.ageQd > right.ageQd
      ? left
      : (right.ageQd > left.ageQd ? right : (String(left.id) <= String(right.id) ? left : right));
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
    batches.splice(pair.right, 1);
    batches.splice(pair.left, 1, merged);
  }
  return [...batches, ...protectedBatches].sort(fifoSort);
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

export function normalizedRowBatches(row, {
  compact = true,
  maxBatches = MAX_RESOURCE_BATCHES,
  protectedBatchIds = new Set()
} = {}) {
  const authoritative = hasOwn(row, "batches");
  const prefix = rowBatchPrefix(row);
  return normalizeResourceBatches(authoritative ? row.batches : null, {
    fallbackQty: authoritative ? 0 : (row.qty ?? row.quantity ?? row.count),
    makeId: (_kind, _length, index = 0) => `${prefix}-${index + 1}`,
    compact,
    maxBatches,
    protectedBatchIds
  });
}

export function syncResourceRowBatches(row = {}, options = {}) {
  if (!row || typeof row !== "object") return row;
  row.batches = normalizedRowBatches(row, options);
  row.qty = resourceBatchTotal(row.batches);
  return row;
}
