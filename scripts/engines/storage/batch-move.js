function requireDependencies(dependencies = {}) {
  const required = [
    "safeNumber",
    "normalizeStorageRoomId",
    "itemQuantity",
    "resolveStorageRows",
    "storageRooms",
    "storageRowLoad",
    "storageEffectiveRowLoad",
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
  const ids = (Array.isArray(rowIds) ? rowIds : []).map((id) => String(id ?? "").trim()).filter(Boolean);
  const selected = dependencies.resolveStorageRows(holding?.storage?.[rowType], ids);
  if (selected.rows?.some((row) => dependencies.normalizeStorageRoomId(row.roomId ?? row.storageRoomId) !== fromRoomId)) {
    return { message: "Позиция больше не находится в этом хранилище." };
  }
  return selected;
}

function rowLabel(row = {}, rowType = "resources") {
  return String(row?.name ?? row?.label ?? (rowType === "items" ? "Предмет" : "Ресурс"));
}

function roomCanFit(room = {}, load = 0) {
  return Boolean(room?.available) && (room?.unlimited || Number(room?.free ?? 0) + 0.0001 >= load);
}

/** Reserve projected room capacity for the complete item batch before changing stock. */
function planItemDestinations(holding, rows, plannedRows, fromRoomId, toRoomId, dependencies) {
  const rooms = dependencies.storageRooms(holding, { includeUnavailable: true })
    .filter((room) => room.available && room.id !== fromRoomId)
    .map((room) => ({ ...room }));
  const preferred = rooms.find((room) => room.id === toRoomId);
  const candidates = preferred ? [preferred, ...rooms.filter((room) => room !== preferred)] : rooms;
  for (const [index, planned] of plannedRows.entries()) {
    const source = rows[index];
    // A split stack receives a fresh ID. Only its item metadata determines its storage profile.
    const stack = { ...source, id: planned.qty < planned.availableQty ? "" : source.id, qty: planned.qty };
    for (const room of candidates) {
      const load = dependencies.storageEffectiveRowLoad(room, stack, planned.load);
      if (!roomCanFit(room, load)) continue;
      planned.roomId = room.id;
      if (!room.unlimited) room.free = Math.max(0, Number(room.free ?? 0) - load);
      break;
    }
    if (!planned.roomId) return planned;
  }
  return null;
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

function planSelectedRows({
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

  const selection = selectedRows(holding, { rowType: type, rowIds, fromRoomId: fromRoom }, deps);
  if (!selection.rows?.length) {
    return { ok: false, message: selection.message ?? "Выбери хотя бы одну позицию в текущем помещении.", rowType: type, rows: [] };
  }
  const { rows } = selection;

  const plannedRows = rows.map((row) => {
    const { available, requested } = requestedRowQuantity(row, type, rowQuantities, deps, holding);
    const load = type === "items" ? deps.storageRowLoad({ ...row, qty: requested })
      : deps.storageRowLoad(row) * (available > 0 ? requested / available : 0);
    return {
      id: String(row.id ?? ""),
      label: rowLabel(row, type),
      qty: requested,
      availableQty: available,
      load: Math.max(0, load)
    };
  });
  const invalid = plannedRows.find((row) => row.qty < 1 || row.qty > row.availableQty);
  if (invalid) {
    return {
      ok: false,
      message: invalid.qty < 1 && invalid.availableQty > 0
        ? `Укажи количество для «${invalid.label}».`
        : `Для «${invalid.label}» доступно только ${deps.formatNumber(invalid.availableQty)} ед.`,
      rowType: type,
      rows: []
    };
  }

  if (type === "items") {
    const blocked = planItemDestinations(holding, rows, plannedRows, fromRoom, toRoom, deps);
    if (blocked) {
      return { ok: false, message: `Нет места для «${blocked.label}» в доступных помещениях.`, rowType: type, rows: [] };
    }
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

function prepareStorageBatchMove(options) {
  const plan = planSelectedRows(options);
  if (!plan.ok || plan.rowType === "items") return { plan };

  const { holding, dependencies: deps } = options;
  if (typeof deps.takeResourceRow !== "function") throw new TypeError("storage batch move engine requires dependencies.takeResourceRow");
  // Run the regular resource placement on a private draft so preview and apply obey the same capacity rules.
  const resources = deps.clone(holding.storage.resources);
  const draft = { ...holding, storage: { ...holding.storage, resources } };
  const { byId } = deps.resolveStorageRows(resources, plan.rows.map((row) => row.id));
  const transfers = [];
  for (const planned of plan.rows) {
    const row = byId.get(planned.id);
    const receipt = deps.takeResourceRow(draft, row, planned.qty);
    if (receipt.takenQty !== planned.qty) throw new RangeError("storage batch move could not take the planned quantity");
    const placements = deps.addResourceWithOverflow(draft, { ...row, roomId: plan.toRoomId, batches: receipt.batches }, planned.qty);
    if (placements.some((placement) => placement.roomId === plan.fromRoomId && placement.qty > 0)) {
      return { plan: { ok: false, message: `Нет места для всего объёма «${planned.label}». Уменьшите количество или выберите другое помещение.`,
        rowType: plan.rowType, rows: [] } };
    }
    if (placements.reduce((sum, placement) => sum + placement.qty, 0) !== planned.qty) {
      throw new RangeError("storage batch move could not place the planned quantity");
    }
    transfers.push({ planned, row, placements });
  }
  return { plan, resources, transfers };
}

export function planStorageBatchMove(options = {}) {
  return prepareStorageBatchMove(options).plan;
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
  const { plan, resources, transfers } = prepareStorageBatchMove({
    holding, rowType, rowIds, rowQuantities, fromRoomId, toRoomId, dependencies: deps
  });
  if (!plan.ok) return plan;

  const messages = [];
  const placements = [];
  if (plan.rowType === "resources") {
    holding.storage.resources = resources;
    for (const { planned, row, placements: placed } of transfers) {
      deps.appendStorageLog(holding, [{
        kind: "move-out",
        resourceId: row.resourceId,
        name: row.name,
        qty: -planned.qty,
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
      messages.push(`${planned.label}: ${deps.formatNumber(planned.qty)} → ${placed.map((placement) => deps.storageRoomLabel(holding, placement.roomId)).join(", ")}`);
    }
  } else {
    const { byId } = deps.resolveStorageRows(holding.storage.items, plan.rows.map((row) => row.id));
    const entries = [];
    for (const planned of plan.rows) {
      const row = byId.get(planned.id);
      const { qty: amount, availableQty: available, roomId: targetRoomId } = planned;
      let movedRow = row;
      if (amount < available) {
        movedRow = deps.clone(row);
        movedRow.id = deps.makeId("sitem", 12);
        deps.setItemQuantity(row, available - amount);
        deps.setItemQuantity(movedRow, amount);
        holding.storage.items.push(movedRow);
      }
      movedRow.roomId = targetRoomId;
      placements.push({ id: planned.id, label: planned.label, roomId: targetRoomId, qty: planned.qty });
      const destination = deps.storageRoomLabel(holding, targetRoomId);
      messages.push(`${planned.label}: ${deps.formatNumber(planned.qty)} → ${destination}`);
      const log = { resourceId: "custom", name: planned.label, source: "Пакетное перемещение", operationId };
      entries.push(
        { ...log, kind: "move-out", roomId: plan.fromRoomId, qty: -amount, note: `в ${destination}` },
        { ...log, kind: "move-in", roomId: targetRoomId, qty: amount, note: `из ${plan.fromLabel}` }
      );
    }
    deps.appendStorageLog(holding, entries);
  }

  const destinations = [...new Set(placements.map((placement) => placement.roomId))]
    .map((id) => deps.storageRoomLabel(holding, id)).join(", ");
  return {
    ok: true,
    operationId: String(operationId ?? ""),
    rowType: plan.rowType,
    moved: plan.rows.length,
    placements,
    messages,
    message: `Перемещено позиций ${plan.rows.length}. Размещено в помещениях ${destinations}.`
  };
}
