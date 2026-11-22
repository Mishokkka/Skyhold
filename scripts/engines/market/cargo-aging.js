import { resourceDef } from "../../core/resources.js";

const whole = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
};

/** Freeze shelf life when cargo is packed; saved legacy cargo is resolved once. */
export function cargoShelfLife(cargo = {}) {
  if (cargo.sourceType === "item") return 0;
  return whole(cargo.shelfLifeQd ?? resourceDef(cargo.resourceId)?.shelfLifeQd);
}

export function cargoDeliveryQuantity(cargo = {}) {
  const expired = cargoShelfLife(cargo) > 0 && whole(cargo.ageQd) >= cargoShelfLife(cargo);
  return expired ? 0 : Math.max(0, whole(cargo.qty) - whole(cargo.spoiledQty));
}
