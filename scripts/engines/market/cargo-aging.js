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

/** Prorate whole copper before division; floating ratios can lose a whole coin. */
export function viableCargoValueCopper(order = {}, amountCopper = 0) {
  let total = 0n;
  let viable = 0n;
  for (const cargo of order.cargo ?? []) {
    const unitPrice = BigInt(Math.max(1, whole(cargo.unitPriceCopper ?? cargo.cargoValueCopper / cargo.qty)));
    total += BigInt(whole(cargo.qty)) * unitPrice;
    viable += BigInt(cargoDeliveryQuantity(cargo)) * unitPrice;
  }
  const amount = whole(amountCopper);
  return total > 0n ? Number(BigInt(amount) * viable / total) : amount;
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
  return viableCargoValueCopper(order, marketInsuranceLimitCopper(order));
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
