function whole(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

/** Refund only the original concrete inventory, never re-resolve an edited recipe. */
export function refundProductionInputs(holding, receipt, lost, outputQty, {
  addMoney, addResource
} = {}) {
  if (!receipt || receipt.version !== 1 || !Array.isArray(receipt.entries)) throw new Error("Unsupported production input receipt.");
  const base = whole(outputQty);
  const count = Math.min(base, whole(lost));
  if (!base || !count) return [];
  const groups = new Map();
  for (const entry of receipt.entries) {
    const resource = entry.resource ?? {};
    const key = entry.kind === "money" ? "money" : JSON.stringify([resource.resourceId, resource.name, resource.roomId, resource.storageRoomId]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const refunded = [];
  for (const entries of groups.values()) {
    // The retained output pays the rounded-up indivisible material cost.
    let remaining = Math.floor(entries.reduce((sum, entry) => sum + whole(entry.qty), 0) * count / base);
    for (const entry of entries) {
      const qty = Math.min(remaining, whole(entry.qty));
      if (!qty) continue;
      remaining -= qty;
      if (entry.kind === "money") {
        addMoney(holding, qty);
        refunded.push({ resourceId: "money", name: "Деньги", roomId: "treasury", qty });
      } else {
        let rest = qty;
        const batches = [];
        for (const batch of entry.batches ?? []) {
          const take = Math.min(rest, whole(batch.qty));
          if (take) batches.push({ ...batch, qty: take });
          rest -= take;
          if (!rest) break;
        }
        if (rest) throw new Error("Production input receipt is incomplete.");
        addResource(holding, { ...entry.resource, batches }, qty);
        refunded.push({ ...entry.resource, qty });
      }
    }
  }
  return refunded;
}
