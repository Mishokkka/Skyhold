import { clone } from "../../data/utils.js";
import { normalizeResourceId, resourceDef } from "../../core/resources.js";
import { availableResourceBatchInventory, availableResourceRowQuantity,
  isResourceBatchPeriodActive, syncResourceRowBatches, takeResourceBatchById } from "../../core/resource-batches.js";

function readyFood(row) {
  const id = normalizeResourceId(row.resourceId, row.id, row.name);
  const definition = resourceDef(id, row.name);
  if (row.noAutoConsume === true || definition?.noAutoConsume === true) return false;
  return id === "custom" ? row.foodEdible === true : definition?.foodEdible === true;
}

export function politicsReadyFood(holding = {}) {
  return (holding.storage?.resources ?? []).filter(readyFood)
    .reduce((sum, row) => sum + availableResourceRowQuantity(row, holding), 0);
}

/** Returns an isolated storage draft; a failed payment cannot touch the holding. */
export function preparePoliticsDecreePayment(holding = {}, { copper = 0, food = 0 } = {}) {
  const money = Math.max(0, Math.floor(Number(holding.storage?.moneyCopper) || 0));
  if (money < copper || politicsReadyFood(holding) < food) return null;
  const draft = { ...holding, storage: clone(holding.storage ?? { moneyCopper: 0, resources: [] }) };
  draft.storage.moneyCopper = money - copper;
  const compact = !isResourceBatchPeriodActive(draft);
  const rows = (draft.storage.resources ?? []).filter(readyFood);
  for (const row of rows) syncResourceRowBatches(row, { compact });
  const batches = rows.flatMap((row, rowIndex) => availableResourceBatchInventory(row, draft, { compact })
    .map((batch, batchIndex) => ({ row, rowIndex, batchIndex, batch })))
    .sort((a, b) => b.batch.ageQd - a.batch.ageQd || a.rowIndex - b.rowIndex || a.batchIndex - b.batchIndex);
  let remaining = food;
  const taken = [];
  for (const entry of batches) {
    if (!remaining) break;
    const receipt = takeResourceBatchById(entry.row, entry.batch.id, Math.min(remaining, entry.batch.qty), { holding: draft });
    if (!receipt) continue;
    remaining -= receipt.qty;
    taken.push({ resourceId: normalizeResourceId(entry.row.resourceId, entry.row.id, entry.row.name), qty: receipt.qty });
  }
  return remaining ? null : { storage: draft.storage, taken };
}
