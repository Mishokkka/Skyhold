import { storageExpiresInQd } from "../engines/economy/perishable-storage.js";
import { normalizeStorageRoomId } from "../engines/storage/capacity.js";
import { expireResourceBatch, resourceBatchTotal } from "../core/resource-batches.js";
import { clearBuildingReferences } from "./normalizers/resident.js";
import { confirmedOutboundCargo, expireTransportReservation } from "./transport/state.js";
import { stableDataHash } from "./storage-commit.js";
import { appendStorageLogEntries, BUILDING_DEMOLITION_LOG_SOURCE } from "./storage-log.js";
import { makeId } from "./utils.js";

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
  return {
    building, resources, items, confirmed, expired, spoiledQty: resourceBatchTotal(expired),
    token: stableDataHash([building, resources, items, expired.map(({ row, batch, qty }) => [row.id, batch.id, qty])])
  };
}

export function applyBuildingDemolition(holding, plan) {
  const { building, resources, items, confirmed, expired } = plan;
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
    const qty = expireResourceBatch(holding, row, batch, confirmed);
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
}
