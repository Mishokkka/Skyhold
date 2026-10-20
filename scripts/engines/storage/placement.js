import { storageProfileMatches, storageEffectiveShelfLifeMultiplier } from "./specialization.js";

export function addStorageWithOverflow({ holding, resource = {}, qty = 0, dependencies } = {}) {
  const deps = dependencies ?? {};
  const required = [
    "safeNumber",
    "normalizeResourceId",
    "isMoneyResource",
    "normalizeStorageRoomId",
    "storageRooms",
    "storageAdd",
    "storageUnitLoad",
    "storageProfileLoadMultiplier",
    "splitTransferBatches"
  ];
  for (const name of required) {
    if (typeof deps[name] !== "function") throw new TypeError(`storage placement engine requires dependencies.${name}`);
  }

  const amount = Math.max(0, Math.floor(deps.safeNumber(qty, 0)));
  if (!amount) return [];
  const id = deps.normalizeResourceId(resource.resourceId, resource.id, resource.name);
  if (deps.isMoneyResource(id, resource.name)) {
    deps.storageAdd(holding, resource, amount);
    return [{ roomId: "", qty: amount, overflowFrom: "" }];
  }

  let targetRoomId = deps.normalizeStorageRoomId(resource.roomId ?? resource.storageRoomId);
  const rooms = deps.storageRooms(holding, { includeUnavailable: true });
  if (targetRoomId === "auto") {
    const candidates = rooms.filter((room) => room.id !== "outdoors" && room.available && room.autoReceive
      && Number(room.profileEffectFactor ?? 1) > 0)
      .sort((a, b) => Number(storageProfileMatches(b, resource)) - Number(storageProfileMatches(a, resource)));
    const placements = [];
    let left = amount;
    let batches = resource.batches;
    for (const room of candidates) {
      const unitLoad = deps.storageUnitLoad(resource) * deps.storageProfileLoadMultiplier(room, resource);
      const free = Math.max(0, deps.safeNumber(room.capacity) - deps.safeNumber(room.used));
      const fit = room.unlimited || unitLoad <= 0 ? left : Math.min(left, Math.floor((free + 0.0001) / unitLoad));
      if (fit <= 0) continue;
      const part = { ...resource, roomId: room.id };
      if (Array.isArray(batches)) {
        const split = deps.splitTransferBatches(batches, fit);
        if (split.shortfall) throw new RangeError("Automatic storage received fewer batches than requested");
        part.batches = split.batches; batches = split.remainingBatches;
      }
      placements.push(...addStorageWithOverflow({ holding, resource: part, qty: fit, dependencies: deps }));
      left -= fit;
      if (!left) return placements;
    }
    if (left) placements.push(...addStorageWithOverflow({ holding,
      resource: { ...resource, roomId: "outdoors", ...(Array.isArray(batches) ? { batches } : {}) }, qty: left, dependencies: deps }));
    return placements;
  }
  const targetRoom = rooms.find((room) => room.id === targetRoomId);
  const placements = [];
  let transferBatches = Object.prototype.hasOwnProperty.call(resource, "batches")
    ? (Array.isArray(resource.batches) ? resource.batches : [])
    : null;
  const addPlacement = (roomId, part, overflowFrom = "") => {
    const value = Math.max(0, Math.floor(deps.safeNumber(part, 0)));
    if (!value) return;
    let placedResource = { ...resource, resourceId: id, roomId };
    if (transferBatches) {
      const split = deps.splitTransferBatches(transferBatches, value);
      if (split.shortfall) throw new RangeError("storage placement received fewer batch units than requested");
      transferBatches = split.remainingBatches;
      placedResource = { ...placedResource, batches: split.batches };
    }
    let accepted = value;
    const arrivalShelfLifeQd = Math.max(0, Number(placedResource.arrivalShelfLifeQd) || 0);
    // A delivery may arrive partway through a long period. Check its end-of-period age
    // in the actual destination (including overflow) before production or food can use it.
    if (arrivalShelfLifeQd && Array.isArray(placedResource.batches)) {
      const room = rooms.find((candidate) => candidate.id === roomId) ?? {};
      const lifetime = arrivalShelfLifeQd * storageEffectiveShelfLifeMultiplier(room, placedResource);
      placedResource.batches = placedResource.batches.filter((batch) => Number(batch.ageQd) < lifetime);
      accepted = placedResource.batches.reduce((sum, batch) => sum + batch.qty, 0);
    }
    delete placedResource.arrivalShelfLifeQd;
    if (accepted) deps.storageAdd(holding, placedResource, accepted);
    placements.push({ roomId, qty: accepted, ...(accepted < value ? { spoiledQty: value - accepted } : {}), overflowFrom });
  };

  if (targetRoomId === "outdoors" || !targetRoom || !targetRoom.available || targetRoom.unlimited) {
    addPlacement(
      targetRoom && targetRoom.available ? targetRoomId : "outdoors",
      amount,
      targetRoom && !targetRoom.available ? targetRoomId : ""
    );
    return placements;
  }

  const unitLoad = deps.storageUnitLoad(resource) * deps.storageProfileLoadMultiplier(targetRoom, resource);
  const freeLoad = Math.max(0, deps.safeNumber(targetRoom.capacity, 0) - deps.safeNumber(targetRoom.used, 0));
  const fitAmount = unitLoad <= 0 ? amount : Math.max(0, Math.floor((freeLoad + 0.0001) / unitLoad));
  if (fitAmount >= amount) {
    addPlacement(targetRoomId, amount);
    return placements;
  }
  if (fitAmount > 0) addPlacement(targetRoomId, fitAmount);
  addPlacement("outdoors", amount - fitAmount, targetRoomId);
  return placements;
}
