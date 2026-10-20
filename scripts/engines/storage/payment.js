function requireDependencies(dependencies = {}) {
  const required = [
    "safeNumber",
    "isMoneyResource",
    "storageQuantity",
    "addMoney",
    "storageResourceMatches"
  ];
  for (const name of required) {
    if (typeof dependencies[name] !== "function") {
      throw new TypeError(`storage payment engine requires dependencies.${name}`);
    }
  }
  if (typeof dependencies.storageTake !== "function" && typeof dependencies.storageAdd !== "function") {
    throw new TypeError("storage payment engine requires dependencies.storageTake or dependencies.storageAdd");
  }
  return dependencies;
}

function takeStorage(dependencies, holding, resource, qty) {
  if (typeof dependencies.storageTake === "function") return dependencies.storageTake(holding, resource, qty);
  dependencies.storageAdd(holding, resource, -qty);
  return { takenQty: qty, batches: [] };
}

export function canPayStorageCosts({ holding, costs = [], dependencies } = {}) {
  const deps = requireDependencies(dependencies);
  const missing = [];
  for (const cost of costs) {
    const amount = Math.max(0, Math.ceil(deps.safeNumber(cost?.qty, 0)));
    if (!amount) continue;
    const have = Math.max(0, Math.floor(deps.safeNumber(deps.storageQuantity(holding, cost), 0)));
    if (have < amount) missing.push({ ...cost, qty: amount, have });
  }
  return { ok: missing.length === 0, missing };
}

export function payStorageCosts({ holding, costs = [], dependencies, captureReceipt = false } = {}) {
  const deps = requireDependencies(dependencies);
  const receipts = [];
  const recordTake = (receipt, cost) => {
    if (!captureReceipt) return;
    const resource = { ...(receipt.row ?? cost) };
    delete resource.batches;
    delete resource.qty;
    resource.storageRowId = String(resource.id ?? cost.storageRowId ?? "");
    receipts.push({ kind: "resource", resource, qty: receipt.takenQty,
      batches: (receipt.batches ?? []).map((batch) => ({ ...batch })) });
  };
  for (const cost of costs) {
    const amount = Math.max(0, Math.ceil(deps.safeNumber(cost.qty, 0)));
    if (!amount) continue;
    if (deps.isMoneyResource(cost.resourceId, cost.id, cost.name)) {
      deps.addMoney(holding, -amount);
      if (captureReceipt) receipts.push({ kind: "money", qty: amount });
      continue;
    }
    const hasRoom = cost.roomId !== undefined || cost.storageRoomId !== undefined;
    if (hasRoom) {
      const receipt = takeStorage(deps, holding, cost, amount);
      if (receipt.takenQty !== amount) throw new RangeError("storage payment could not take the planned quantity");
      recordTake(receipt, cost);
      continue;
    }
    let rest = amount;
    for (const row of holding?.storage?.resources ?? []) {
      if (rest <= 0.0001) break;
      if (!deps.storageResourceMatches(row, cost)) continue;
      const have = Math.max(0, Math.floor(deps.safeNumber(row.qty, 0)));
      if (!have) continue;
      const take = Math.min(have, rest);
      const receipt = takeStorage(deps, holding, {
        ...cost,
        resourceId: row.resourceId,
        name: row.name,
        roomId: row.roomId ?? row.storageRoomId,
        storageRowId: row.id
      }, take);
      rest -= receipt.takenQty;
      recordTake(receipt, cost);
    }
  }
  return captureReceipt ? receipts : undefined;
}
