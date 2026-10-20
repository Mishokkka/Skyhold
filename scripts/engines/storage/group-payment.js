function requiredDependencies(dependencies = {}) {
  for (const name of ["safeNumber", "isMoneyResource", "storageResourceMatches", "resourceMatchesGroup", "normalizeRoomId"]) {
    if (typeof dependencies[name] !== "function") throw new TypeError(`group payment requires dependencies.${name}`);
  }
  return dependencies;
}

function costRoomMatches(row, cost, normalizeRoomId) {
  if (cost.roomId === undefined && cost.storageRoomId === undefined) return true;
  return normalizeRoomId(row?.roomId ?? row?.storageRoomId) === normalizeRoomId(cost.roomId ?? cost.storageRoomId);
}

export function planStorageCosts({ holding = {}, costs = [], dependencies = {} } = {}) {
  const deps = requiredDependencies(dependencies);
  // Select one complete alternative per OR group against the entire recipe.
  // Planning never changes the stock; payment receives only concrete costs.
  if (costs.some((cost) => Array.isArray(cost.alternatives))) {
    const fixed = costs.filter((cost) => !Array.isArray(cost.alternatives));
    const groups = costs.filter((cost) => Array.isArray(cost.alternatives));
    let failure;
    const choose = (index, selected) => {
      if (index === groups.length) {
        const ordered = [...fixed, ...selected].sort((a, b) => Number(Boolean(a.resourceGroup)) - Number(Boolean(b.resourceGroup)));
        const plan = planStorageCosts({ holding, costs: ordered, dependencies: deps });
        failure ??= plan;
        return plan.ok ? plan : null;
      }
      for (const option of groups[index].alternatives) {
        const plan = choose(index + 1, [...selected, option]);
        if (plan) return plan;
      }
      return null;
    };
    return choose(0, []) ?? failure ?? { ok: false, costs: [], missing: groups.map((cost) => ({ ...cost, have: 0 })) };
  }
  const batchesForRow = (row) => {
    if (typeof deps.resourceBatches === "function") return deps.resourceBatches(row, holding);
    if (Array.isArray(row?.batches)) return row.batches;
    return [{ qty: row?.qty, ageQd: 0 }];
  };
  const inventory = (holding?.storage?.resources ?? []).flatMap((row, index) => batchesForRow(row).map((batch, batchIndex) => ({
    row,
    index,
    batchIndex,
    ageQd: Math.max(0, Math.floor(deps.safeNumber(batch?.ageQd, 0))),
    remaining: Math.max(0, Math.floor(deps.safeNumber(batch?.qty, 0)))
  })));
  let moneyRemaining = Math.max(0, Math.floor(deps.safeNumber(holding?.storage?.moneyCopper, 0)));
  const concreteCosts = [];
  const missing = [];

  for (const rawCost of costs ?? []) {
    const amount = Math.max(0, Math.ceil(deps.safeNumber(rawCost?.qty, 0)));
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
    candidates.sort((left, right) => right.ageQd - left.ageQd || left.index - right.index || left.batchIndex - right.batchIndex);

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
        qty: take
      });
    }
    if (rest > 0.0001) missing.push({ ...rawCost, qty: amount, have });
  }

  return { ok: missing.length === 0, costs: concreteCosts, missing };
}
