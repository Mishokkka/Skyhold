function requireDependencies(dependencies = {}) {
  const required = [
    "safeNumber",
    "normalizeStorageRoomId",
    "itemQuantity",
    "storageRooms",
    "storageRowLoad",
    "storageAvailableQuantity",
    "storageRoomLabel",
    "addResourceWithOverflow",
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
    const qty = type === "items" ? dependencies.itemQuantity(row) : dependencies.storageAvailableQuantity(holding, row);
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

export function planStorageBatchMove({
  holding,
  rowType = "resources",
  rowIds = [],
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

  return {
    ok: true,
    rowType: type,
    fromRoomId: fromRoom,
    toRoomId: toRoom,
    fromLabel: deps.storageRoomLabel(holding, fromRoom),
    toLabel: deps.storageRoomLabel(holding, toRoom),
    rows: rows.map((row) => {
      const rawQty = Math.max(0, deps.safeNumber(row?.qty, 0));
      const qty = type === "items" ? deps.itemQuantity(row) : Math.max(0, deps.storageAvailableQuantity(holding, row));
      const fullLoad = Math.max(0, deps.storageRowLoad(row));
      const load = type === "items" || rawQty <= 0 ? fullLoad : fullLoad * (qty / rawQty);
      return {
        id: String(row.id ?? ""),
        label: rowLabel(row, type),
        qty,
        load
      };
    })
  };
}

export function applyStorageBatchMove({
  holding,
  rowType = "resources",
  rowIds = [],
  fromRoomId = "outdoors",
  toRoomId = "outdoors",
  operationId = "",
  dependencies
} = {}) {
  const deps = requireDependencies(dependencies);
  const plan = planStorageBatchMove({ holding, rowType, rowIds, fromRoomId, toRoomId, dependencies: deps });
  if (!plan.ok) return plan;

  const messages = [];
  const placements = [];
  if (plan.rowType === "resources") {
    for (const planned of plan.rows) {
      const row = (holding?.storage?.resources ?? []).find((candidate) => String(candidate?.id ?? "") === planned.id);
      if (!row) continue;
      const amount = Math.min(planned.qty, Math.max(0, deps.storageAvailableQuantity(holding, row)));
      if (!amount) continue;
      const lots = typeof deps.takeResourceLots === "function" ? deps.takeResourceLots(holding, row, amount) : [];
      if (typeof deps.takeResourceLots !== "function") row.qty = Math.max(0, deps.safeNumber(row.qty, 0) - amount);
      const placed = deps.addResourceWithOverflow(holding, { ...row, qty: 0, roomId: plan.toRoomId, lots }, amount);
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
      const row = (holding?.storage?.items ?? []).find((candidate) => String(candidate?.id ?? "") === planned.id);
      if (!row) continue;
      const targetRoomId = itemTargetRoom(holding, row, plan.toRoomId, plan.fromRoomId, deps);
      row.roomId = targetRoomId;
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
