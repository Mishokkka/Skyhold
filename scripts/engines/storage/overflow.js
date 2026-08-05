import { consumeResourceLots } from "../../core/resource-lots.js";
import { storageUnitLoad } from "./capacity.js";
import { effectiveConsumerRationPoints } from "../resource-ration-points.js";

export const STORAGE_OVERFLOW_GRACE_QD = 40;
export const STORAGE_OVERFLOW_LOSS_PERIOD_QD = 40;

const EPSILON = 0.000001;

function finiteNonNegative(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : Math.max(0, Number(fallback) || 0);
}

function whole(value, fallback = 0) {
  return Math.max(0, Math.floor(finiteNonNegative(value, fallback)));
}

function text(value = "") {
  return String(value ?? "").trim();
}

function normalizeRoomState(source = {}) {
  const sinceQd = whole(source.sinceQd);
  return {
    sinceQd,
    graceUntilQd: Math.max(sinceQd, whole(source.graceUntilQd, sinceQd + STORAGE_OVERFLOW_GRACE_QD)),
    processedPeriods: whole(source.processedPeriods),
    clearSinceQd: whole(source.clearSinceQd)
  };
}

export function normalizeStorageOverflowState(source = {}) {
  const rooms = {};
  for (const [roomId, row] of Object.entries(source?.rooms && typeof source.rooms === "object" ? source.rooms : {})) {
    const id = text(roomId);
    if (!id || !row || typeof row !== "object") continue;
    rooms[id] = normalizeRoomState(row);
  }
  return {
    version: 1,
    graceQd: STORAGE_OVERFLOW_GRACE_QD,
    lossPeriodQd: STORAGE_OVERFLOW_LOSS_PERIOD_QD,
    lastEvaluatedQd: whole(source?.lastEvaluatedQd),
    rooms
  };
}

export function storageOverflowRoomStatus({
  room = {},
  overflowState = {},
  currentQd = 0,
  formatLoad = (value) => String(value)
} = {}) {
  const capacityCargoPoints = finiteNonNegative(room?.capacityCargoPoints ?? room?.capacity, 0);
  const usedCargoPoints = finiteNonNegative(room?.used, 0);
  const excessCargoPoints = room?.unlimited === true ? 0 : Math.max(0, usedCargoPoints - capacityCargoPoints);
  if (excessCargoPoints <= EPSILON) {
    return {
      hasOverflow: false,
      excessCargoPoints: 0,
      excessCargoPointsText: formatLoad(0),
      overflowGraceRemainingQd: 0,
      overflowRiskActive: false,
      overflowStatusText: ""
    };
  }

  const roomId = text(room?.id) || "outdoors";
  const tracked = overflowState?.rooms?.[roomId];
  const graceUntilQd = tracked && typeof tracked === "object"
    ? whole(tracked.graceUntilQd, whole(tracked.sinceQd) + STORAGE_OVERFLOW_GRACE_QD)
    : 0;
  const effectiveCurrentQd = Math.max(whole(currentQd), whole(overflowState?.lastEvaluatedQd));
  const graceRemainingQd = graceUntilQd > 0 ? Math.max(0, graceUntilQd - effectiveCurrentQd) : 0;
  const excessText = formatLoad(excessCargoPoints);
  const overflowStatusText = !tracked
    ? `Переполнение ${excessText} груз. оч. · отсрочка ${STORAGE_OVERFLOW_GRACE_QD} QD начнётся при расчёте десятника.`
    : (graceRemainingQd > 0
      ? `Переполнение ${excessText} груз. оч. · отсрочка ещё ${graceRemainingQd} QD.`
      : `Переполнение ${excessText} груз. оч. · риск порчи, кражи и потери действует.`);
  return {
    hasOverflow: true,
    excessCargoPoints,
    excessCargoPointsText: excessText,
    overflowGraceRemainingQd: graceRemainingQd,
    overflowRiskActive: Boolean(tracked) && graceRemainingQd <= 0,
    overflowStatusText
  };
}

function resourceEntry(row, index, definitions) {
  const resourceId = text(row?.resourceId ?? row?.id);
  const definition = definitions.get(resourceId) ?? {};
  const qty = finiteNonNegative(row?.qty ?? row?.quantity, 0);
  const unitCargoPoints = storageUnitLoad({
    ...row,
    cargoPoints: definition?.cargoPoints ?? row?.cargoPoints,
    load: definition?.cargoPoints === undefined ? (definition?.load ?? row?.load) : row?.load
  });
  if (qty <= EPSILON || unitCargoPoints <= 0) return null;
  return {
    key: `resource:${text(row?.id) || index}`,
    row,
    rowType: "resource",
    index,
    roomId: text(row?.roomId ?? row?.storageRoomId) || "outdoors",
    resourceId,
    name: text(row?.name ?? definition?.label ?? resourceId) || "Ресурс",
    unit: text(row?.unit ?? definition?.unitLabel ?? definition?.unit) || "ед.",
    qty,
    quantityStep: Math.max(0.001, finiteNonNegative(row?.quantityStep ?? definition?.quantityStep, 1)),
    unitCargoPoints,
    cargoClass: text(definition?.cargoClass ?? row?.cargoClass).toLowerCase(),
    shelfLifeDays: whole(row?.shelfLifeDays ?? definition?.shelfLifeDays),
    tradable: definition?.tradable === true || row?.tradable === true,
    referencePriceCopper: whole(definition?.referencePriceCopper ?? row?.referencePriceCopper),
    foodPersonDaysPerUnit: effectiveConsumerRationPoints(row, definition)
  };
}

function itemEntry(row, index) {
  const qty = finiteNonNegative(row?.qty ?? row?.quantity ?? row?.itemData?.system?.quantity, 0);
  const unitCargoPoints = storageUnitLoad(row);
  if (qty <= EPSILON || unitCargoPoints <= 0) return null;
  return {
    key: `item:${text(row?.id) || index}`,
    row,
    rowType: "item",
    index,
    roomId: text(row?.roomId ?? row?.storageRoomId) || "outdoors",
    resourceId: "custom",
    name: text(row?.name ?? row?.itemData?.name) || "Предмет",
    unit: "шт.",
    qty,
    quantityStep: 1,
    unitCargoPoints,
    cargoClass: text(row?.cargoClass).toLowerCase(),
    shelfLifeDays: 0,
    tradable: true,
    referencePriceCopper: whole(row?.priceCopper),
    foodPersonDaysPerUnit: 0
  };
}

function storageEntries(holding, definitions) {
  return [
    ...(holding?.storage?.resources ?? []).map((row, index) => resourceEntry(row, index, definitions)),
    ...(holding?.storage?.items ?? []).map((row, index) => itemEntry(row, index))
  ].filter(Boolean);
}

function riskProfile(entry, security = 0) {
  let kind = "loss";
  let baseRate = entry.unitCargoPoints >= 40 ? 0.08 : 0.12;
  let priority = 1;
  if (entry.shelfLifeDays > 0) {
    kind = "spoilage";
    baseRate = 0.25;
    priority = 4;
  } else if (entry.cargoClass === "livestock") {
    kind = "loss";
    baseRate = 0.2;
    priority = 3;
  } else if (entry.rowType === "item" || (entry.tradable && entry.unitCargoPoints <= 5)) {
    kind = "theft";
    baseRate = entry.referencePriceCopper >= 100 ? 0.25 : 0.18;
    priority = 2;
  }
  const protection = Math.max(0.15, 1 - finiteNonNegative(security, 0) * 0.12);
  return { kind, rate: Math.max(0.01, baseRate * protection), priority };
}

function roundedAtRiskQuantity(entry, excessCargoPoints) {
  const rawQty = Math.min(entry.qty, excessCargoPoints / entry.unitCargoPoints);
  if (entry.quantityStep >= 1) return Math.min(entry.qty, Math.max(1, Math.ceil(rawQty - EPSILON)));
  const steps = Math.max(1, Math.ceil(rawQty / entry.quantityStep - EPSILON));
  return Math.min(entry.qty, steps * entry.quantityStep);
}

function roundedLossQuantity(entry, atRiskQty, rate) {
  const rawLoss = atRiskQty * rate;
  if (entry.quantityStep >= 1) return Math.min(atRiskQty, Math.max(1, Math.floor(rawLoss + EPSILON)));
  const steps = Math.max(1, Math.floor(rawLoss / entry.quantityStep + EPSILON));
  return Math.min(atRiskQty, steps * entry.quantityStep);
}

function deductEntry(entry, qty, currentQd) {
  if (entry.rowType === "resource") {
    consumeResourceLots(entry.row, qty, { currentQd, shelfLifeDays: entry.shelfLifeDays });
    return;
  }
  entry.row.qty = Math.max(0, finiteNonNegative(entry.row.qty ?? entry.row.quantity, 0) - qty);
  if (entry.row.itemData?.system && typeof entry.row.itemData.system === "object") {
    entry.row.itemData.system.quantity = entry.row.qty;
  }
}

function roomUsage(entries, roomId) {
  return entries.filter((entry) => entry.roomId === roomId)
    .reduce((sum, entry) => sum + finiteNonNegative(entry.row?.qty ?? entry.qty, 0) * entry.unitCargoPoints, 0);
}

function applyLossPeriod({ holding, definitions, room, targetQd, periodNumber }) {
  const entries = storageEntries(holding, definitions).filter((entry) => entry.roomId === room.id);
  let exposedCargoPoints = Math.max(0, roomUsage(entries, room.id) - room.capacity);
  const candidates = entries.map((entry) => ({ entry, risk: riskProfile(entry, room.security) }))
    .sort((left, right) => right.risk.priority - left.risk.priority || left.entry.key.localeCompare(right.entry.key, "en"));
  const rows = [];
  for (const { entry, risk } of candidates) {
    if (exposedCargoPoints <= EPSILON) break;
    const atRiskQty = roundedAtRiskQuantity(entry, exposedCargoPoints);
    const qty = roundedLossQuantity(entry, atRiskQty, risk.rate);
    if (qty <= EPSILON) continue;
    deductEntry(entry, qty, targetQd);
    const lostCargoPoints = qty * entry.unitCargoPoints;
    exposedCargoPoints = Math.max(0, exposedCargoPoints - atRiskQty * entry.unitCargoPoints);
    rows.push({
      kind: `overflow-${risk.kind}`,
      lossKind: risk.kind,
      resourceId: entry.resourceId,
      name: entry.name,
      unit: entry.unit,
      qty,
      foodPersonDays: qty * entry.foodPersonDaysPerUnit,
      roomId: room.id,
      roomLabel: room.label,
      storageSecurity: room.security,
      cargoClass: entry.cargoClass,
      unitCargoPoints: entry.unitCargoPoints,
      lostCargoPoints,
      overflowPeriod: periodNumber
    });
  }
  holding.storage.resources = (holding.storage.resources ?? []).filter((row) => finiteNonNegative(row?.qty, 0) > EPSILON);
  holding.storage.items = (holding.storage.items ?? []).filter((row) => finiteNonNegative(row?.qty ?? row?.itemData?.system?.quantity, 0) > EPSILON);
  return rows;
}

export function applyStorageOverflow({
  holding,
  fromQd = 0,
  toQd = fromQd,
  resourceDefinitions = [],
  rooms = []
} = {}) {
  if (!holding || typeof holding !== "object") throw new TypeError("storage overflow requires a holding draft");
  if (!holding.storage || typeof holding.storage !== "object") holding.storage = { resources: [], items: [], moneyCopper: 0, log: [] };
  const targetQd = whole(toQd, fromQd);
  const state = normalizeStorageOverflowState(holding.storage.overflow);
  const definitions = new Map((Array.isArray(resourceDefinitions) ? resourceDefinitions : [])
    .map((row) => [text(row?.id ?? row?.resourceId), row])
    .filter(([id]) => id));
  const roomRows = (Array.isArray(rooms) ? rooms : []).map((room) => ({
    id: text(room?.id) || "outdoors",
    label: text(room?.label ?? room?.id) || "Хранилище",
    capacity: room?.available === false ? 0 : finiteNonNegative(room?.capacityCargoPoints ?? room?.capacity, 0),
    security: finiteNonNegative(room?.security, 0),
    unlimited: room?.available !== false && room?.unlimited === true
  }));
  const entries = storageEntries(holding, definitions);
  const warnings = [];
  const rows = [];

  for (const room of roomRows) {
    if (room.unlimited) continue;
    const usedCargoPoints = roomUsage(entries, room.id);
    const excessCargoPoints = Math.max(0, usedCargoPoints - room.capacity);
    let roomState = state.rooms[room.id] ?? null;
    if (excessCargoPoints <= EPSILON) {
      if (!roomState) continue;
      if (!roomState.clearSinceQd) roomState.clearSinceQd = targetQd;
      if (targetQd - roomState.clearSinceQd >= STORAGE_OVERFLOW_GRACE_QD) delete state.rooms[room.id];
      continue;
    }

    if (!roomState) {
      roomState = {
        sinceQd: targetQd,
        graceUntilQd: targetQd + STORAGE_OVERFLOW_GRACE_QD,
        processedPeriods: 0,
        clearSinceQd: 0
      };
      state.rooms[room.id] = roomState;
    } else {
      roomState.clearSinceQd = 0;
    }
    const duePeriods = targetQd < roomState.graceUntilQd
      ? 0
      : Math.floor((targetQd - roomState.graceUntilQd) / STORAGE_OVERFLOW_LOSS_PERIOD_QD) + 1;
    const applyPeriods = Math.max(0, duePeriods - roomState.processedPeriods);
    for (let offset = 0; offset < applyPeriods; offset += 1) {
      rows.push(...applyLossPeriod({
        holding,
        definitions,
        room,
        targetQd,
        periodNumber: roomState.processedPeriods + offset + 1
      }));
    }
    roomState.processedPeriods = Math.max(roomState.processedPeriods, duePeriods);
    const remainingUsedCargoPoints = roomUsage(storageEntries(holding, definitions), room.id);
    warnings.push({
      roomId: room.id,
      roomLabel: room.label,
      capacityCargoPoints: room.capacity,
      usedCargoPoints: remainingUsedCargoPoints,
      excessCargoPoints: Math.max(0, remainingUsedCargoPoints - room.capacity),
      sinceQd: roomState.sinceQd,
      graceUntilQd: roomState.graceUntilQd,
      graceRemainingQd: Math.max(0, roomState.graceUntilQd - targetQd),
      lossPeriodsApplied: applyPeriods
    });
  }

  state.lastEvaluatedQd = targetQd;
  holding.storage.overflow = state;
  return {
    fromQd: whole(fromQd),
    toQd: targetQd,
    rows,
    warnings,
    totalQty: rows.reduce((sum, row) => sum + row.qty, 0),
    totalCargoPoints: rows.reduce((sum, row) => sum + row.lostCargoPoints, 0),
    hasLosses: rows.length > 0,
    state
  };
}
