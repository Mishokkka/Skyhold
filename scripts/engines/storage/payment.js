function requireDependencies(dependencies = {}) {
  const required = [
    "safeNumber",
    "isMoneyResource",
    "storageQuantity",
    "addMoney",
    "storageAdd",
    "storageResourceMatches",
    "storageAvailableQuantity"
  ];
  for (const name of required) {
    if (typeof dependencies[name] !== "function") {
      throw new TypeError(`storage payment engine requires dependencies.${name}`);
    }
  }
  return dependencies;
}

export function canPayStorageCosts({ holding, costs = [], dependencies } = {}) {
  const deps = requireDependencies(dependencies);
  const missing = [];
  for (const cost of costs) {
    const have = deps.storageQuantity(holding, cost);
    if (have + 0.0001 < cost.qty) missing.push({ ...cost, have });
  }
  return { ok: missing.length === 0, missing };
}

export function payStorageCosts({ holding, costs = [], dependencies } = {}) {
  const deps = requireDependencies(dependencies);
  for (const cost of costs) {
    const amount = Math.max(0, deps.safeNumber(cost.qty, 0));
    if (!amount) continue;
    if (deps.isMoneyResource(cost.resourceId, cost.id, cost.name)) {
      deps.addMoney(holding, -amount);
      continue;
    }
    const hasRoom = cost.roomId !== undefined || cost.storageRoomId !== undefined;
    if (hasRoom) {
      deps.storageAdd(holding, cost, -amount);
      continue;
    }
    let rest = amount;
    for (const [storageRowIndex, row] of (holding?.storage?.resources ?? []).entries()) {
      if (rest <= 0.0001) break;
      if (!deps.storageResourceMatches(row, cost)) continue;
      const have = Math.max(0, deps.safeNumber(deps.storageAvailableQuantity(holding, row), 0));
      if (!have) continue;
      const take = Math.min(have, rest);
      deps.storageAdd(holding, {
        ...row,
        roomId: row.roomId ?? row.storageRoomId,
        storageRowId: String(row?.id ?? ""),
        storageRowIndex
      }, -take);
      rest -= take;
    }
  }
}
