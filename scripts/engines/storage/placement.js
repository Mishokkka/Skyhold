const QUANTITY_EPSILON = 0.000001;

function nonNegativeQuantity(value, fallback = 0) {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return Math.max(0, parsed);
  const fallbackNumber = Number(fallback);
  return Number.isFinite(fallbackNumber) ? Math.max(0, fallbackNumber) : 0;
}

function splitResourceLots(lots = [], qty = 0) {
  let remaining = Math.max(0, Number(qty) || 0);
  const taken = [];
  const rest = [];
  for (const raw of Array.isArray(lots) ? lots : []) {
    const amount = Math.max(0, Number(raw?.qty) || 0);
    if (amount <= QUANTITY_EPSILON) continue;
    const take = Math.min(amount, remaining);
    if (take > QUANTITY_EPSILON) taken.push({ ...raw, qty: take });
    if (amount - take > QUANTITY_EPSILON) rest.push({ ...raw, qty: amount - take });
    remaining = Math.max(0, remaining - take);
  }
  return { taken, rest };
}

export function addStorageWithOverflow({ holding, resource = {}, qty = 0, dependencies } = {}) {
  const deps = dependencies ?? {};
  const required = [
    "safeNumber",
    "normalizeResourceId",
    "isMoneyResource",
    "normalizeStorageRoomId",
    "storageRooms",
    "storageAdd",
    "storageUnitLoad"
  ];
  for (const name of required) {
    if (typeof deps[name] !== "function") throw new TypeError(`storage placement engine requires dependencies.${name}`);
  }

  const requestedAmount = nonNegativeQuantity(deps.safeNumber(qty, 0));
  if (requestedAmount <= QUANTITY_EPSILON) return [];
  const id = deps.normalizeResourceId(resource.resourceId, resource.id, resource.name);
  if (deps.isMoneyResource(id, resource.name)) {
    const amount = Math.floor(requestedAmount);
    if (!amount) return [];
    deps.storageAdd(holding, resource, amount);
    return [{ roomId: "", qty: amount, overflowFrom: "" }];
  }
  const amount = requestedAmount;

  const targetRoomId = deps.normalizeStorageRoomId(resource.roomId ?? resource.storageRoomId);
  const rooms = deps.storageRooms(holding, { includeUnavailable: true });
  const targetRoom = rooms.find((room) => room.id === targetRoomId);
  const placements = [];
  let remainingLots = Array.isArray(resource?.lots) ? resource.lots : [];
  const addPlacement = (roomId, part, overflowFrom = "") => {
    const value = nonNegativeQuantity(deps.safeNumber(part, 0));
    if (value <= QUANTITY_EPSILON) return;
    const split = splitResourceLots(remainingLots, value);
    remainingLots = split.rest;
    deps.storageAdd(holding, { ...resource, resourceId: id, roomId, lots: split.taken }, value);
    placements.push({ roomId, qty: value, overflowFrom });
  };

  if (targetRoomId === "outdoors" || !targetRoom || !targetRoom.available || targetRoom.unlimited) {
    addPlacement(
      targetRoom && targetRoom.available ? targetRoomId : "outdoors",
      amount,
      targetRoom && !targetRoom.available ? targetRoomId : ""
    );
    return placements;
  }

  const unitLoad = deps.storageUnitLoad(resource);
  const freeLoad = Math.max(0, deps.safeNumber(targetRoom.capacity, 0) - deps.safeNumber(targetRoom.used, 0));
  const fitCapacity = unitLoad <= 0 ? amount : Math.max(0, freeLoad / unitLoad);
  const fitAmount = fitCapacity + QUANTITY_EPSILON >= amount ? amount : Math.min(amount, fitCapacity);
  if (fitAmount + QUANTITY_EPSILON >= amount) {
    addPlacement(targetRoomId, amount);
    return placements;
  }
  if (fitAmount > QUANTITY_EPSILON) addPlacement(targetRoomId, fitAmount);
  addPlacement("outdoors", amount - fitAmount, targetRoomId);
  return placements;
}
