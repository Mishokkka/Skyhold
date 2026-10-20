export function moveStorageResource({
  holding,
  resourceId = "custom",
  name = "",
  qty = 0,
  fromRoomId = "outdoors",
  toRoomId = "outdoors",
  note = "",
  dependencies
} = {}) {
  const deps = dependencies ?? {};
  const required = [
    "safeNumber",
    "normalizeStorageRoomId",
    "normalizeResourceId",
    "isMoneyResource",
    "resourceLabel",
    "resourceUnit",
    "storageFind",
    "storageUnitLoad",
    "storageTake",
    "storageAddWithOverflow",
    "storageRoomLabel",
    "appendStorageLog",
    "storagePlacementText",
    "formatNumber"
  ];
  for (const dependency of required) {
    if (typeof deps[dependency] !== "function") throw new TypeError(`storage move engine requires dependencies.${dependency}`);
  }

  const amount = Math.max(0, Math.floor(deps.safeNumber(qty, 0)));
  if (!amount) return { ok: false, message: "Укажи количество." };
  const fromRoom = deps.normalizeStorageRoomId(fromRoomId);
  const toRoom = deps.normalizeStorageRoomId(toRoomId);
  if (fromRoom === toRoom) return { ok: false, message: "Выбери разные склады." };
  const id = deps.normalizeResourceId(resourceId, name);
  if (deps.isMoneyResource(id, name)) {
    return { ok: false, message: "Деньги перемещаются через казну, не через склады." };
  }

  const label = id === "custom" ? (String(name).trim() || "Ресурс") : deps.resourceLabel(id);
  const fromRow = deps.storageFind(holding, { resourceId: id, name: label, roomId: fromRoom });
  const have = Math.max(0, Math.floor(deps.safeNumber(
    typeof deps.storageAvailableQuantity === "function" ? deps.storageAvailableQuantity(holding, fromRow) : fromRow?.qty,
    0
  )));
  if (have + 0.0001 < amount) {
    return {
      ok: false,
      message: `В складе '${deps.storageRoomLabel(holding, fromRoom)}' нет ${deps.formatNumber(amount)} ${label}. Есть ${deps.formatNumber(have)}.`
    };
  }

  const unit = fromRow?.unit || deps.resourceUnit(id);
  const weight = deps.storageUnitLoad(fromRow ?? {});
  const receipt = deps.storageTake(holding, {
    resourceId: id,
    name: label,
    roomId: fromRoom,
    storageRowId: fromRow?.id,
    unit,
    weight
  }, amount);
  if (receipt.takenQty !== amount) throw new RangeError("storage move could not take the planned batch quantity");
  const placements = deps.storageAddWithOverflow(
    holding,
    { resourceId: id, name: label, roomId: toRoom, unit, weight, batches: receipt.batches },
    amount
  );
  const entries = [{
    kind: "move-out",
    resourceId: id,
    name: label,
    qty: -amount,
    roomId: fromRoom,
    source: "Перемещение",
    note: [note, `в ${deps.storageRoomLabel(holding, toRoom)}`].filter(Boolean).join(" · ")
  }];
  for (const item of placements) {
    entries.push({
      kind: "move-in",
      resourceId: id,
      name: label,
      qty: item.qty,
      roomId: item.roomId,
      source: "Перемещение",
      note: [
        note,
        `из ${deps.storageRoomLabel(holding, fromRoom)}`,
        item.overflowFrom ? `переполнение: ${deps.storageRoomLabel(holding, item.overflowFrom)}` : ""
      ].filter(Boolean).join(" · ")
    });
  }
  deps.appendStorageLog(holding, entries);
  return {
    ok: true,
    message: `${label}: ${deps.formatNumber(amount)} из ${deps.storageRoomLabel(holding, fromRoom)}; ${deps.storagePlacementText(holding, placements)}.`
  };
}
