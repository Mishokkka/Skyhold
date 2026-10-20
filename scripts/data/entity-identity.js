/** Validate a new identity before mutation; never repair legacy rows during load. */
export function assertAvailableEntityId(rows, id, { key = "id", current = null } = {}) {
  const identity = String(id ?? "").trim();
  if (!identity || (rows ?? []).some((row) => row !== current && String(row?.[key] ?? "").trim() === identity)) {
    const error = new Error("ID пуст или уже занят другой записью. Выберите уникальный ID.");
    error.code = "conflict";
    throw error;
  }
  return identity;
}

function identityCounts(rows, key) {
  const counts = new Map();
  for (const row of rows ?? []) {
    const id = String(row?.[key] ?? "").trim();
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** Existing duplicates remain diagnosable; new writes may not introduce or increase them. */
export function assertNoNewEntityCollisions(previous, next) {
  const collections = [[previous?.holdings, next?.holdings, "id"],
    [previous?.catalog?.resources, next?.catalog?.resources, "id"],
    [previous?.catalog?.eventRegions, next?.catalog?.eventRegions, "value"]];
  const previousHoldings = new Map();
  for (const holding of previous?.holdings ?? []) {
    const matches = previousHoldings.get(holding.id) ?? [];
    matches.push(holding);
    previousHoldings.set(holding.id, matches);
  }
  for (const holding of next?.holdings ?? []) {
    const before = previousHoldings.get(holding.id)?.shift();
    collections.push([before?.people?.list, holding?.people?.list, "id"],
      [before?.buildings?.list, holding?.buildings?.list, "id"]);
  }
  for (const [before, after, key] of collections) {
    const oldCounts = identityCounts(before, key);
    for (const [id, count] of identityCounts(after, key)) {
      if (count > Math.max(1, oldCounts.get(id) ?? 0)) assertAvailableEntityId(after, id, { key });
    }
  }
}
