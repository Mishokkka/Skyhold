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

export function cargoExpiryWarnings(cargo = [], travelQd = 0, { direction = "outbound" } = {}) {
  return cargo.filter((row) => cargoShelfLife(row) > 0
    && whole(row.ageQd ?? row.reservedAgeQd) + whole(travelQd) >= cargoShelfLife(row))
    .map((row) => `${row.name || row.resourceId} ×${whole(row.qty)}: срок хранения истечёт до прибытия; ${direction === "inbound"
      ? "испорченный товар не поступит на склад" : "выручки за испорченный груз не будет"}.`);
}

export function marketPlanCargoExpiryWarnings(plan = {}, { direction = "inbound" } = {}) {
  const batches = plan?.shipmentBatches?.length ? plan.shipmentBatches : [plan ?? {}];
  return batches.flatMap((batch, index) => cargoExpiryWarnings(
    direction === "inbound" ? batch.lines ?? [] : batch.cargoReservations ?? [], batch.deliveryQd, { direction }
  ).map((warning) => batches.length > 1 ? `Партия ${index + 1}: ${warning}` : warning));
}
