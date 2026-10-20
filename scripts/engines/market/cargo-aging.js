import { resourceDef } from "../../core/resources.js";

const whole = (value) => Math.max(0, Math.floor(Number(value) || 0));

/** Freeze shelf life when cargo is packed; saved legacy cargo is resolved once. */
export function cargoShelfLife(cargo = {}) {
  if (cargo.sourceType === "item") return 0;
  return whole(cargo.shelfLifeQd ?? resourceDef(cargo.resourceId)?.shelfLifeQd);
}

export function ageMarketCargo(order, elapsedQd = 0) {
  const elapsed = whole(elapsedQd);
  for (const cargo of order.cargo ?? []) {
    if (cargo.sourceType === "item") continue;
    cargo.shelfLifeQd = cargoShelfLife(cargo);
    cargo.ageQd = whole(cargo.ageQd ?? cargo.reservedAgeQd) + elapsed;
    if (cargo.shelfLifeQd > 0 && cargo.ageQd >= cargo.shelfLifeQd) cargo.spoiledQty = whole(cargo.qty);
  }
}

export function cargoDeliveryQuantity(cargo = {}) {
  const expired = cargoShelfLife(cargo) > 0 && whole(cargo.ageQd) >= cargoShelfLife(cargo);
  return expired ? 0 : Math.max(0, whole(cargo.qty) - whole(cargo.spoiledQty));
}

export function viableCargoValueRatio(order = {}) {
  let total = 0;
  let viable = 0;
  for (const cargo of order.cargo ?? []) {
    const unitPrice = Math.max(1, whole(cargo.unitPriceCopper ?? cargo.cargoValueCopper / cargo.qty));
    total += whole(cargo.qty) * unitPrice;
    viable += cargoDeliveryQuantity(cargo) * unitPrice;
  }
  return total > 0 ? viable / total : 1;
}

export function marketInsuranceLimitCopper(order = {}) {
  const insured = whole(order.insuredValueCopper ?? order.subtotalCopper);
  const coverage = Math.max(0, Math.min(1, Number(order.insuranceCoverageRate) || 0));
  const calculated = Math.floor(insured * coverage);
  // Legacy aggregate orders use zero as an unspecified limit. A new physical
  // outbound batch can receive a genuine zero share of a capped parent policy.
  const allocatedLimit = order.direction === "outbound" && Number(order.batchCount) > 1;
  const maximum = whole(order.maximumInsurancePayoutCopper) || (allocatedLimit ? 0 : calculated);
  return Math.min(calculated, maximum);
}

/** Current public value; an already proposed loss has its own saved event value. */
export function marketInsurancePayoutCopper(order = {}) {
  return Math.floor(marketInsuranceLimitCopper(order) * viableCargoValueRatio(order));
}

/** GM-only event value. A delay changed to loss is assessed now, not at the old proposal. */
export function marketLossInsurancePayoutCopper(order = {}) {
  const proposal = order.riskProposal ?? {};
  const snapshot = proposal.proposedInsurancePayoutCopper ?? proposal.potentialInsurancePayoutCopper;
  return proposal.outcome === "lost" && snapshot != null && Number.isFinite(Number(snapshot))
    ? Math.min(whole(snapshot), marketInsuranceLimitCopper(order))
    : marketInsurancePayoutCopper(order);
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
