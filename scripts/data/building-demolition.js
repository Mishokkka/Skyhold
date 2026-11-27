import { storageExpiresInQd } from "../engines/economy/perishable-storage.js";
import { normalizeStorageRoomId } from "../engines/storage/capacity.js";
import { expireResourceBatch, resourceBatchTotal } from "../core/resource-batches.js";
import { clearBuildingReferences } from "./normalizers/resident.js";
import { confirmedOutboundCargo, expireTransportReservation } from "./transport/state.js";
import { stableDataHash } from "./storage-commit.js";
import { appendStorageLogEntries, BUILDING_DEMOLITION_LOG_SOURCE } from "./storage-log.js";
import { makeId } from "./utils.js";
import { applyBuildingLaborWithdrawal, planBuildingLaborWithdrawal } from "./labor-mutations.js";
import { buildWorkAllocationTargets, workAllocationTargetKey } from "./work-allocations.js";

export function buildingLaborWithdrawalLines(holding, plan) {
  const people = new Map((holding.people?.list ?? []).map((row) => [String(row.id), row]));
  const buildings = new Map((holding.buildings?.list ?? []).map((row) => [String(row.id), row]));
  const targets = new Map(buildWorkAllocationTargets(holding).map((row) => [row.key, row]));
  const describe = (row) => {
    const building = buildings.get(row.sourceId);
    return `${people.get(row.personId)?.name || "Житель"} · ${targets.get(workAllocationTargetKey(row.sourceId, row.functionId))?.label
      || `${building?.name || row.sourceId} · ${row.functionId}`}`;
  };
  return [
    ...plan.trims.map((row) => `${describe(row)} · OT ${row.overtimeBefore} → ${row.overtimeAfter} · ${row.locked ? "закреплено" : "без закрепления"}`),
    ...plan.removedLocks.map((row) => `${describe(row)} · закрепление будет снято`)
  ];
}

export function canReadBuildingLaborWithdrawal(holding, plan, user = globalThis.game?.user) {
  if (user?.isGM) return true;
  const people = new Set([...plan.personIds, ...plan.removedLocks.map((row) => row.personId)]);
  const buildings = new Set([plan.buildingId, ...plan.trims.map((row) => row.sourceId)]);
  return !plan.trimsHiddenLock && !plan.removedLocks.some((row) => row.visibility === "gm")
    && !(holding.people?.list ?? []).some((row) => row.visibility === "gm" && people.has(String(row.id)))
    && !(holding.buildings?.list ?? []).some((row) => row.visibility === "gm" && buildings.has(String(row.id)));
}

export function planBuildingDemolition(holding, buildingId, transportState) {
  const matches = (holding?.buildings?.list ?? []).filter(row => String(row.id) === String(buildingId));
  if (matches.length !== 1) return null;
  const building = matches[0];
  const fromRoom = row => normalizeStorageRoomId(row.roomId ?? row.storageRoomId) === String(building.id);
  const resources = (holding.storage?.resources ?? []).filter(fromRoom);
  const items = (holding.storage?.items ?? []).filter(fromRoom);
  const confirmed = resources.length ? confirmedOutboundCargo(holding, transportState) : new Map();
  const expired = resources.flatMap(row => {
    const outdoors = { ...row, roomId: "outdoors" };
    return (row.batches ?? []).filter(batch => storageExpiresInQd(holding, outdoors, batch.ageQd) <= 0).map(batch => {
      const loaded = expireTransportReservation(holding, row, batch, confirmed, { preview: true });
      return { row, batch, qty: Math.max(0, batch.qty - loaded) };
    });
  });
  const labor = planBuildingLaborWithdrawal(holding, buildingId);
  return {
    building, resources, items, confirmed, expired, spoiledQty: resourceBatchTotal(expired),
    labor, laborTrims: labor.trims, locks: labor.removedLocks,
    token: stableDataHash([building, resources, items, expired.map(({ row, batch, qty }) => [row.id, batch.id, qty]), labor.token])
  };
}

export function applyBuildingDemolition(holding, plan, { confirmed = false } = {}) {
  const labor = applyBuildingLaborWithdrawal(holding, plan.labor, { confirmed });
  if (!labor.ok) return labor;
  const { building, resources, items, confirmed: confirmedCargo, expired } = plan;
  const roomId = String(building.id);
  const operationId = makeId("building-demolition", 20), entries = [];
  const source = BUILDING_DEMOLITION_LOG_SOURCE;
  const movement = (row, resourceId, qty) => {
    if (qty <= 0) return;
    const shared = { resourceId, name: row.name, source, operationId };
    entries.push(
      { ...shared, kind: "move-out", qty: -qty, roomId, note: "Под открытое небо" },
      { ...shared, kind: "move-in", qty, roomId: "outdoors", note: `Из «${building.name}»` }
    );
  };
  const spoilage = new Map();
  for (const { row, batch } of expired) {
    const qty = expireResourceBatch(holding, row, batch, confirmedCargo);
    spoilage.set(row, (spoilage.get(row) ?? 0) + qty);
  }
  for (const row of resources) {
    const spoiled = spoilage.get(row) ?? 0;
    if (spoiled) {
      row.batches = row.batches.filter(batch => batch.qty > 0);
      row.qty = resourceBatchTotal(row.batches);
      entries.push({ kind: "food", resourceId: row.resourceId, name: row.name, qty: -spoiled, roomId,
        source, note: "Истёк срок хранения под открытым небом", operationId });
    }
    movement(row, row.resourceId, row.qty);
    row.roomId = "outdoors";
  }
  for (const row of items) {
    movement(row, "custom", row.qty);
    row.roomId = "outdoors";
  }
  if (entries.length) appendStorageLogEntries(holding, entries);
  clearBuildingReferences(holding, building);
  holding.buildings.list = holding.buildings.list.filter(row => row !== building);
  return { ok: true };
}
