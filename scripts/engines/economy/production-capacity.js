import { scaleProductionCosts } from "../../core/production-expenses.js";

const whole = (value) => Math.max(0, Math.floor(Number.isFinite(Number(value)) ? Number(value) : 0));

export function productionCapacity(line = {}) {
  return line.source === "content" ? 0 : whole(line.batchCapacity);
}

export function waitingProductionBatches(line = {}) {
  return Array.isArray(line.waitingBatches) ? line.waitingBatches : [];
}

export function productionBatchStates(line = {}) {
  return [...(line.workInputsReserved ? [line] : []), ...waitingProductionBatches(line)];
}

export function productionOccupiedQty(line = {}) {
  return whole(line.pendingQty) + productionBatchStates(line).reduce((sum, batch) => sum + whole(batch.workReservedOutputQty), 0);
}

export function productionBatchCosts(line, variableCosts, fixedCosts, qty, fullQty) {
  const multiplier = line.expenseMode === "unit" ? qty : qty / Math.max(1, fullQty);
  return [...scaleProductionCosts(variableCosts, multiplier), ...scaleProductionCosts(fixedCosts, 1)];
}

/** Monotone exact inventory quotes include OR groups, money and fixed start costs. */
export function affordableProductionBatch(limit, costsFor, canPay) {
  let low = 0, high = whole(limit);
  while (low < high) {
    const candidate = Math.ceil((low + high) / 2);
    if (canPay(costsFor(candidate)).ok) low = candidate;
    else high = candidate - 1;
  }
  return low;
}

export function enqueueProductionBatch(line) {
  const id = line.workReservedInputs?.batchId;
  if (!id) throw new Error("Production batch identity is missing.");
  line.waitingBatches ??= [];
  line.waitingBatches.push({ id, workInputsReserved: true,
    workProgressUnits: line.workProgressUnits, workReservedOutputQty: line.workReservedOutputQty,
    workReservedFormula: line.workReservedFormula, workReservedInputs: line.workReservedInputs });
}

export function stopProductionAfterDrain(line) {
  if (line.repeat === false && !productionBatchStates(line).length) line.active = false;
}
