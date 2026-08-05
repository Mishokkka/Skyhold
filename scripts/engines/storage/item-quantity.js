export const FORBIDDEN_LANDS_ITEM_QUANTITY_ADAPTER = Object.freeze({
  id: "forbidden-lands.system.quantity",
  systemId: "forbidden-lands",
  path: "system.quantity",
  minimum: 1
});

function positiveInteger(value, fallback = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.floor(number)) : Math.max(1, Math.floor(Number(fallback) || 1));
}

export function itemQuantity(itemOrData = {}, adapter = FORBIDDEN_LANDS_ITEM_QUANTITY_ADAPTER) {
  const system = itemOrData?.system ?? itemOrData?.itemData?.system ?? {};
  return positiveInteger(itemOrData?.qty ?? itemOrData?.quantity ?? system?.quantity, adapter.minimum);
}

export function setItemQuantityData(itemData = {}, quantity = 1, {
  adapter = FORBIDDEN_LANDS_ITEM_QUANTITY_ADAPTER,
  clone = (value) => structuredClone(value)
} = {}) {
  const data = clone(itemData ?? {});
  if (!data.system || typeof data.system !== "object") data.system = {};
  data.system.quantity = positiveInteger(quantity, adapter.minimum);
  return data;
}

export function itemQuantityUpdateData(quantity = 1, adapter = FORBIDDEN_LANDS_ITEM_QUANTITY_ADAPTER) {
  return { [adapter.path]: positiveInteger(quantity, adapter.minimum) };
}
