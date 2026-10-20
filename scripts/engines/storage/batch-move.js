function requireDependencies(dependencies = {}) {
  const required = [
    "safeNumber",
    "normalizeStorageRoomId",
    "itemQuantity",
    "storageRooms",
    "storageRowLoad",
    "storageRoomLabel",
    "addResourceWithOverflow",
    "clone",
    "makeId",
    "setItemQuantity",
    "appendStorageLog",
    "formatNumber"
  ];
  for (const name of required) {
    if (typeof dependencies[name] !== "function") throw new TypeError(`storage batch move engine requires dependencies.${name}`);
  }
  return dependencies;
}

function normalizedRowType(value) {
  return String(value ?? "") === "items" ? "items" : "resources";
}

function selectedRows(holding, { rowType, rowIds, fromRoomId }, dependencies) {
  const type = normalizedRowType(rowType);
  const ids = new Set((Array.isArray(rowIds) ? rowIds : []).map((id) => String(id ?? "").trim()).filter(Boolean));
  const roomId = dependencies.normalizeStorageRoomId(fromRoomId);
  const collection = type === "items" ? holding?.storage?.items : holding?.storage?.resources;
  return (Array.isArray(collection) ? collection : []).filter((row) => {
    if (!ids.has(String(row?.id ?? ""))) return false;
    if (dependencies.normalizeStorageRoomId(row?.roomId ?? row?.storageRoomId) !== roomId) return false;
    const qty = type === "items"
      ? dependencies.itemQuantity(row)
      : (typeof dependencies.resourceAvailableQuantity === "function"
        ? dependencies.resourceAvailableQuantity(holding, row)
        : Math.max(0, Math.floor(dependencies.safeNumber(row?.qty, 0))));
    return qty > 0.0001;
  });
}

function rowLabel(row = {}, rowType = "resources") {
  return String(row?.name ?? row?.label ?? (rowType === "items" ? "Предмет" : "Ресурс"));
}

function roomCanFit(room = {}, load = 0) {
  return Boolean(room?.available) && (room?.unlimited || Number(room?.free ?? 0) + 0.0001 >= load);
}

function itemTargetRoom(holding, row, targetRoomId, sourceRoomId, dependencies) {
  const load = Math.max(0, dependencies.storageRowLoad(row));
  const rooms = dependencies.storageRooms(holding, { includeUnavailable: true });
  const candidates = [
    rooms.find((room) => room.id === targetRoomId),
    ...rooms.filter((room) => room.id !== targetRoomId && room.id !== sourceRoomId)
  ].filter(Boolean);
  return candidates.find((room) => roomCanFit(room, load))?.id ?? "outdoors";
}

function requestedRowQuantity(row, rowType, rowQuantities, dependencies, holding) {
  const id = String(row?.id ?? "");
  const available = rowType === "items"
    ? dependencies.itemQuantity(row)
    : (typeof dependencies.resourceAvailableQuantity === "function"
      ? dependencies.resourceAvailableQuantity(holding, row)
      : Math.max(0, Math.floor(dependencies.safeNumber(row?.qty, 0))));
  if (!Object.hasOwn(rowQuantities ?? {}, id)) return { available, requested: available };
  return {
    available,
    requested: Math.max(0, Math.floor(dependencies.safeNumber(rowQuantities[id], 0)))
  };
}

export function planStorageBatchMove({
  holding,
  rowType = "resources",
  rowIds = [],
  rowQuantities = {},
  fromRoomId = "outdoors",
  toRoomId = "outdoors",
  dependencies
} = {}) {
  const deps = requireDependencies(dependencies);
  const type = normalizedRowType(rowType);
  const fromRoom = deps.normalizeStorageRoomId(fromRoomId);
  const toRoom = deps.normalizeStorageRoomId(toRoomId);
  if (fromRoom === toRoom) return { ok: false, message: "Выбери другое помещение.", rowType: type, rows: [] };

  const rows = selectedRows(holding, { rowType: type, rowIds, fromRoomId: fromRoom }, deps);
  if (!rows.length) return { ok: false, message: "Выбери хотя бы одну позицию в текущем помещении.", rowType: type, rows: [] };

  const plannedRows = rows.map((row) => {
    const { available, requested } = requestedRowQuantity(row, type, rowQuantities, deps, holding);
    const fullLoad = Math.max(0, deps.storageRowLoad(row));
    return {
      id: String(row.id ?? ""),
      label: rowLabel(row, type),
      qty: requested,
      availableQty: available,
      load: available > 0 ? fullLoad * (requested / available) : 0
    };
  });
  const invalid = plannedRows.find((row) => row.qty < 1 || row.qty > row.availableQty);
  if (invalid) {
    return {
      ok: false,
      message: invalid.qty < 1
        ? `Укажи количество для «${invalid.label}».`
        : `Для «${invalid.label}» доступно только ${deps.formatNumber(invalid.availableQty)} ед.`,
      rowType: type,
      rows: []
    };
  }

  return {
    ok: true,
    rowType: type,
    fromRoomId: fromRoom,
    toRoomId: toRoom,
    fromLabel: deps.storageRoomLabel(holding, fromRoom),
    toLabel: deps.storageRoomLabel(holding, toRoom),
    rows: plannedRows
  };
}

export function applyStorageBatchMove({
  holding,
  rowType = "resources",
  rowIds = [],
  rowQuantities = {},
  fromRoomId = "outdoors",
  toRoomId = "outdoors",
  operationId = "",
  dependencies
} = {}) {
  const deps = requireDependencies(dependencies);
  const plan = planStorageBatchMove({ holding, rowType, rowIds, rowQuantities, fromRoomId, toRoomId, dependencies: deps });
  if (!plan.ok) return plan;

  const messages = [];
  const placements = [];
  if (plan.rowType === "resources") {
    if (typeof deps.takeResourceRow !== "function") throw new TypeError("storage batch move engine requires dependencies.takeResourceRow");
    for (const planned of plan.rows) {
      const row = (holding?.storage?.resources ?? []).find((candidate) => String(candidate?.id ?? "") === planned.id);
      if (!row) continue;
      const amount = Math.max(0, Math.floor(deps.safeNumber(planned.qty, 0)));
      if (!amount) continue;
      const receipt = deps.takeResourceRow(holding, row, amount);
      if (receipt.takenQty !== amount) throw new RangeError("storage batch move could not take the planned quantity");
      const placed = deps.addResourceWithOverflow(holding, { ...row, roomId: plan.toRoomId, batches: receipt.batches }, amount);
      deps.appendStorageLog(holding, [{
        kind: "move-out",
        resourceId: row.resourceId,
        name: row.name,
        qty: -amount,
        roomId: plan.fromRoomId,
        source: "Пакетное перемещение",
        note: `в ${plan.toLabel}`,
        operationId
      }, ...placed.map((placement) => ({
        kind: "move-in",
        resourceId: row.resourceId,
        name: row.name,
        qty: placement.qty,
        roomId: placement.roomId,
        source: "Пакетное перемещение",
        note: placement.overflowFrom ? `из ${plan.fromLabel} · переполнение ${plan.toLabel}` : `из ${plan.fromLabel}`,
        operationId
      }))]);
      placements.push(...placed.map((placement) => ({ id: planned.id, label: planned.label, ...placement })));
      messages.push(`${planned.label}: ${deps.formatNumber(amount)} → ${placed.map((placement) => deps.storageRoomLabel(holding, placement.roomId)).join(", ")}`);
    }
  } else {
    for (const planned of plan.rows) {
      const items = holding?.storage?.items ?? [];
      const row = items.find((candidate) => String(candidate?.id ?? "") === planned.id);
      if (!row) continue;
      const available = deps.itemQuantity(row);
      const amount = Math.max(1, Math.floor(deps.safeNumber(planned.qty, 1)));
      let movedRow = row;
      if (amount < available) {
        movedRow = deps.clone(row);
        movedRow.id = deps.makeId("sitem", 12);
        deps.setItemQuantity(row, available - amount);
        deps.setItemQuantity(movedRow, amount);
        items.push(movedRow);
      }
      const targetRoomId = itemTargetRoom(holding, { ...movedRow, qty: amount }, plan.toRoomId, plan.fromRoomId, deps);
      movedRow.roomId = targetRoomId;
      placements.push({ id: planned.id, label: planned.label, roomId: targetRoomId, qty: planned.qty });
      messages.push(`${planned.label}: ${deps.formatNumber(planned.qty)} → ${deps.storageRoomLabel(holding, targetRoomId)}`);
    }
    deps.appendStorageLog(holding, [{
      kind: "note",
      resourceId: "custom",
      name: "Предметы",
      qty: 0,
      roomId: plan.toRoomId,
      source: "Пакетное перемещение",
      note: messages.join("; "),
      operationId
    }]);
  }

  return {
    ok: true,
    operationId: String(operationId ?? ""),
    rowType: plan.rowType,
    moved: placements.length,
    placements,
    messages,
    message: `Перемещено позиций: ${placements.length}.`
  };
}
