export function canReadHolding(holding, user = globalThis.game?.user) {
  if (!holding) return false;
  if (user?.isGM) return true;
  return holding.visibility !== "gm";
}

export function readableHoldings(data, user = globalThis.game?.user) {
  const holdings = Array.isArray(data?.holdings) ? data.holdings : [];
  return holdings.filter((holding) => canReadHolding(holding, user));
}

export function hiddenBuildingIds(holding, isGM = Boolean(globalThis.game?.user?.isGM)) {
  return new Set(isGM ? [] : (holding?.buildings?.list ?? [])
    .filter((building) => building.visibility === "gm")
    .map((building) => String(building.id)));
}

export const hiddenStorageRoomIds = hiddenBuildingIds;

export function residentHasHiddenWork(holding, person, hidden = hiddenBuildingIds(holding)) {
  if (!person || !hidden.size) return false;
  if ([person.workAssignment, person.staffAppointment?.buildingId, ...(person.workAllocations ?? []).map((row) => row?.sourceId)]
    .some((id) => hidden.has(String(id ?? "")))) return true;
  return (holding?.buildings?.list ?? []).some((building) => hidden.has(String(building.id))
    && (building.assignedWorkerIds ?? []).some((id) => String(id) === String(person.id)));
}

export function findHoldingIndex(data, holdingId, { fallback = false } = {}) {
  const holdings = Array.isArray(data?.holdings) ? data.holdings : [];
  const id = String(holdingId ?? "");
  const exact = id ? holdings.findIndex((holding) => String(holding?.id ?? "") === id) : -1;
  if (exact >= 0) return exact;
  return fallback && holdings.length ? 0 : -1;
}

export function findReadableHoldingEntry(data, holdingId, { fallback = false, user = globalThis.game?.user } = {}) {
  const holdings = Array.isArray(data?.holdings) ? data.holdings : [];
  const id = String(holdingId ?? "");
  const exactIndex = id ? holdings.findIndex((holding) => String(holding?.id ?? "") === id) : -1;
  if (exactIndex >= 0 && canReadHolding(holdings[exactIndex], user)) return { data, holding: holdings[exactIndex], index: exactIndex };

  if (!fallback) return { data, holding: null, index: -1 };
  const fallbackIndex = holdings.findIndex((holding) => canReadHolding(holding, user));
  return {
    data,
    holding: fallbackIndex >= 0 ? holdings[fallbackIndex] : null,
    index: fallbackIndex
  };
}

export function warnNoHoldingAccess() {
  globalThis.ui?.notifications?.warn?.("Нет доступа к этому владению.");
}
