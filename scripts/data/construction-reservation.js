export const CONSTRUCTION_RESERVATION_VERSION = 1;

function text(value = "") {
  return String(value ?? "").trim();
}

function nonNegative(value = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

function optionalWhole(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeRecipeRow(row = {}, index = 0) {
  const normalized = {
    id: text(row?.id) || `material-${index + 1}`,
    resourceId: text(row?.resourceId ?? row?.resource ?? row?.name),
    resourceGroup: text(row?.resourceGroup),
    name: text(row?.name ?? row?.label ?? row?.resourceId) || "Материал",
    qty: nonNegative(row?.qty ?? row?.quantity)
  };
  if (row?.roomId !== undefined || row?.storageRoomId !== undefined) {
    normalized.roomId = text(row?.roomId ?? row?.storageRoomId) || "outdoors";
  }
  return normalized;
}

function normalizeSourceRow(row = {}) {
  const rawIndex = Number(row?.storageRowIndex);
  return {
    storageRowId: text(row?.storageRowId),
    storageRowIndex: Number.isInteger(rawIndex) ? Math.max(-1, rawIndex) : -1,
    resourceId: text(row?.resourceId ?? "custom"),
    name: text(row?.name ?? row?.resourceId) || "Материал",
    roomId: text(row?.roomId) || "outdoors",
    qty: nonNegative(row?.qty),
    costIds: Array.isArray(row?.costIds) ? row.costIds.map(text).filter(Boolean) : [],
    lots: Array.isArray(row?.lots) ? clone(row.lots) : [],
    untrackedQty: nonNegative(row?.untrackedQty)
  };
}

export function normalizeConstructionReservation(raw = null) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const status = text(raw?.status);
  return {
    version: Math.max(0, Math.floor(Number(raw?.version) || 0)),
    operationId: text(raw?.operationId),
    status: status || "reserved",
    reservedAt: text(raw?.reservedAt),
    reservedQd: optionalWhole(raw?.reservedQd),
    recipe: (Array.isArray(raw?.recipe) ? raw.recipe : []).map(normalizeRecipeRow),
    concreteCosts: (Array.isArray(raw?.concreteCosts) ? raw.concreteCosts : []).map((row) => ({ ...clone(row), qty: nonNegative(row?.qty) })),
    sources: (Array.isArray(raw?.sources) ? raw.sources : []).map(normalizeSourceRow)
  };
}

export function validConstructionReservation(buildingOrReservation = {}) {
  const raw = buildingOrReservation?.constructionReservation ?? buildingOrReservation;
  const reservation = normalizeConstructionReservation(raw);
  if (!reservation) return false;
  if (reservation.version !== CONSTRUCTION_RESERVATION_VERSION) return false;
  if (!reservation.operationId || !["reserved", "consumed"].includes(reservation.status)) return false;
  if (!reservation.recipe.length || !reservation.sources.length) return false;
  if (reservation.recipe.some((row) => !Number.isSafeInteger(row.qty) || row.qty <= 0)) return false;
  if (reservation.sources.some((row) => !Number.isSafeInteger(row.qty) || row.qty <= 0)) return false;
  const recipeQty = reservation.recipe.reduce((sum, row) => sum + row.qty, 0);
  const sourceQty = reservation.sources.reduce((sum, row) => sum + row.qty, 0);
  return Number.isSafeInteger(recipeQty) && recipeQty > 0 && sourceQty === recipeQty;
}
