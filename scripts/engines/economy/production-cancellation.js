import { refundProductionInputs } from "./production-inputs.js";
import { productionBatchLife, clearProductionBatch } from "./production-batch-life.js";
import { perishableStorageExpiresInQd } from "./perishable-storage.js";
import { waitingProductionBatches, stopProductionAfterDrain } from "./production-capacity.js";

function cancellationPlan(holding, line) {
  if (productionBatchLife(holding, line).expired) return { ok: true, expired: true };
  if (!line.workReservedInputs || line.workReservedInputs.version !== 1 || line.workReservedInputs.refundUnavailable) return { ok: false, reason: "У старой оплаченной партии нет чека сырья. Сначала завершите её; точный возврат восстановить невозможно." };
  let discardedQty = 0;
  const receipt = { ...line.workReservedInputs, entries: line.workReservedInputs.entries.map((entry) => {
    if (entry.kind === "money" || !Array.isArray(entry.batches)) return entry;
    if (entry.batches.reduce((sum, batch) => sum + batch.qty, 0) < entry.qty) throw new Error("Production input receipt is incomplete.");
    const batches = entry.batches.filter((batch) => perishableStorageExpiresInQd(holding, entry.resource, batch.ageQd) > 0);
    const qty = Math.min(entry.qty, batches.reduce((sum, batch) => sum + batch.qty, 0));
    discardedQty += Math.max(0, entry.qty - qty);
    return { ...entry, batches, qty };
  }) };
  return { ok: true, receipt, discardedQty };
}

export function cancelProductionBatch(holding, line, { addMoney, addResource, batchId = "" } = {}) {
  const states = [...(line.workInputsReserved || line.workProgressUnits ? [line] : []), ...waitingProductionBatches(line)];
  const selected = batchId ? states.filter((batch) => (batch.id === batchId && batch !== line) || batch.workReservedInputs?.batchId === batchId) : states;
  if (batchId && selected.length !== 1) return { ok: false, reason: "Партия не найдена или её ID неоднозначен. Обновите окно." };
  if (!selected.length) return { ok: true, noop: true, refunds: [] };
  // Validate every receipt before refunding any of them (delete/all-cancel).
  const plans = selected.map((batch) => ({ batch, ...cancellationPlan(holding, batch) }));
  const failed = plans.find((plan) => !plan.ok);
  if (failed) return { ok: false, reason: failed.reason };
  const refunds = [];
  let discardedQty = 0, expiredBatches = 0;
  for (const plan of plans) {
    if (plan.expired) expiredBatches++;
    else refunds.push(...refundProductionInputs(holding, plan.receipt, 1, 1, { addMoney, addResource }));
    discardedQty += plan.discardedQty ?? 0;
    clearProductionBatch(plan.batch);
    if (plan.batch !== line) line.waitingBatches = waitingProductionBatches(line).filter((batch) => batch !== plan.batch);
  }
  if (!batchId) line.active = false;
  else stopProductionAfterDrain(line);
  return { ok: true, refunds, discardedQty, expired: expiredBatches === plans.length, expiredBatches };
}
