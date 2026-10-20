import { marketPurchasePaymentEntry } from "./purchase-payment.js";

function requireDependencies(dependencies = {}) {
  for (const name of ["addMoney", "storageAddWithOverflow", "snapshotItemForStorage", "appendStorageLog", "formatCurrency", "internalDemandAvailableFromQd"]) {
    if (typeof dependencies[name] !== "function") throw new TypeError(`market delivery requires dependencies.${name}`);
  }
  return dependencies;
}

export function applyMarketDelivery({ holding, plan, itemDocuments = new Map(), operationId = "", dependencies = {} } = {}) {
  const deps = requireDependencies(dependencies);
  if (!holding || !plan?.ok) return { ok: false, message: "Market delivery requires an affordable confirmed plan." };
  for (const line of plan.lines ?? []) {
    if (line.sourceType === "item" && !itemDocuments.get(line.id)) {
      return { ok: false, missingItem: line.id, message: `Market Item is unavailable: ${line.itemUuid || line.id}.` };
    }
  }

  deps.addMoney(holding, -plan.totalCopper);
  const storageEntries = [];
  const delivered = [];
  for (const line of plan.lines ?? []) {
    const internalDemandAvailableFromQd = Math.max(0, Math.floor(Number(deps.internalDemandAvailableFromQd(holding)) || 0));
    if (line.sourceType === "item") {
      const item = itemDocuments.get(line.id);
      if (!holding.storage || typeof holding.storage !== "object") holding.storage = { resources: [], items: [], moneyCopper: 0, log: [] };
      if (!Array.isArray(holding.storage.items)) holding.storage.items = [];
      const snapshot = deps.snapshotItemForStorage(item, line.qty, plan.targetRoomId);
      snapshot.internalDemandAvailableFromQd = internalDemandAvailableFromQd;
      snapshot.itemUuid = String(line.itemUuid || item.uuid || snapshot.itemUuid || "");
      if (line.configuredName) snapshot.name = line.configuredName;
      if (line.configuredImg) snapshot.img = line.configuredImg;
      holding.storage.items.push(snapshot);
      storageEntries.push({
        kind: "market-purchase",
        resourceId: "custom",
        name: snapshot.name,
        qty: line.qty,
        roomId: plan.targetRoomId,
        source: plan.marketLabel,
        note: `Item UUID; заказ ${operationId}; доставка ${deps.formatCurrency(plan.deliveryCopper)}`,
        operationId
      });
      delivered.push({ offerId: line.id, sourceType: "item", name: snapshot.name, qty: line.qty, roomId: plan.targetRoomId });
      continue;
    }

    const placements = deps.storageAddWithOverflow(holding, {
      resourceId: line.resourceId,
      name: line.name,
      unit: line.unit,
      img: line.img,
      roomId: plan.targetRoomId,
      batches: [{ qty: line.qty, ageQd: 0, internalDemandAvailableFromQd }]
    }, line.qty);
    for (const placement of placements) {
      storageEntries.push({
        kind: "market-purchase",
        resourceId: line.resourceId,
        name: line.name,
        qty: placement.qty,
        roomId: placement.roomId,
        source: plan.marketLabel,
        note: `заказ ${operationId}; доставка ${deps.formatCurrency(plan.deliveryCopper)}`,
        operationId
      });
      delivered.push({ offerId: line.id, sourceType: "resource", name: line.name, qty: placement.qty, roomId: placement.roomId });
    }
  }
  storageEntries.push(marketPurchasePaymentEntry(plan, operationId));
  deps.appendStorageLog(holding, storageEntries);
  return { ok: true, delivered, storageEntries };
}
