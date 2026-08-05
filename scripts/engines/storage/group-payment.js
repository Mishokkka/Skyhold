function requiredDependencies(dependencies = {}) {
  for (const name of ["safeNumber", "isMoneyResource", "storageResourceMatches", "resourceMatchesGroup", "storageAvailableQuantity", "normalizeRoomId"]) {
    if (typeof dependencies[name] !== "function") throw new TypeError(`group payment requires dependencies.${name}`);
  }
  return dependencies;
}

function costRoomMatches(row, cost, normalizeRoomId) {
  if (cost.roomId === undefined && cost.storageRoomId === undefined) return true;
  return normalizeRoomId(row?.roomId ?? row?.storageRoomId) === normalizeRoomId(cost.roomId ?? cost.storageRoomId);
}

function oldestLotQd(row = {}) {
  const values = (Array.isArray(row?.lots) ? row.lots : [])
    .map((lot) => Number(lot?.receivedQd))
    .filter(Number.isFinite);
  return values.length ? Math.min(...values) : Number.POSITIVE_INFINITY;
}

export function planStorageCosts({ holding = {}, costs = [], dependencies = {} } = {}) {
  const deps = requiredDependencies(dependencies);
  const inventory = (holding?.storage?.resources ?? []).map((row, index) => ({
    row,
    index,
    remaining: Math.max(0, deps.safeNumber(deps.storageAvailableQuantity(holding, row), 0))
  }));
  let moneyRemaining = Math.max(0, deps.safeNumber(holding?.storage?.moneyCopper, 0));
  const concreteCosts = [];
  const missing = [];

  for (const rawCost of costs ?? []) {
    const amount = Math.max(0, deps.safeNumber(rawCost?.qty, 0));
    if (!amount) continue;
    if (deps.isMoneyResource(rawCost?.resourceId, rawCost?.id, rawCost?.name)) {
      const take = Math.min(moneyRemaining, amount);
      moneyRemaining -= take;
      if (take > 0) concreteCosts.push({ ...rawCost, qty: take });
      if (take + 0.0001 < amount) missing.push({ ...rawCost, qty: amount, have: take });
      continue;
    }

    const groupId = String(rawCost?.resourceGroup ?? "");
    const candidates = inventory
      .filter((entry) => entry.remaining > 0.0001)
      .filter((entry) => costRoomMatches(entry.row, rawCost, deps.normalizeRoomId))
      .filter((entry) => groupId ? deps.resourceMatchesGroup(entry.row, groupId) : deps.storageResourceMatches(entry.row, rawCost));
    candidates.sort((left, right) => (
      oldestLotQd(left.row) - oldestLotQd(right.row)
      || (groupId ? right.remaining - left.remaining : 0)
      || left.index - right.index
    ));

    let rest = amount;
    let have = 0;
    for (const entry of candidates) {
      if (rest <= 0.0001) break;
      const take = Math.min(entry.remaining, rest);
      if (take <= 0) continue;
      entry.remaining -= take;
      rest -= take;
      have += take;
      concreteCosts.push({
        ...rawCost,
        resourceGroup: "",
        resourceId: String(entry.row?.resourceId ?? entry.row?.id ?? "custom"),
        name: String(entry.row?.name ?? entry.row?.label ?? rawCost?.name ?? "Ресурс"),
        roomId: deps.normalizeRoomId(entry.row?.roomId ?? entry.row?.storageRoomId),
        storageRowId: String(entry.row?.id ?? ""),
        storageRowIndex: entry.index,
        qty: take
      });
    }
    if (rest > 0.0001) missing.push({ ...rawCost, qty: amount, have });
  }

  return { ok: missing.length === 0, costs: concreteCosts, missing };
}
