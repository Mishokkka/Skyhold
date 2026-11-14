import { isPerishableFoodDefinition } from "../../core/perishable-food.js";
import { expireTransportReservation } from "../../data/transport/state.js";
import { buildingOperationalState } from "../../core/building-state.js";
import {
  beginResourceBatchPeriod,
  cancelResourceBatchPeriod,
  finishResourceBatchPeriod,
  resourceBatchElapsedQd,
  resourceBatchTotal
} from "../../core/resource-batches.js";
import {
  resourceDef,
  resourceLabel,
  storageResourceId,
  storageShelfLifeForRow
} from "../../core/resources.js";
import { normalizeStorageRoomId } from "../storage/capacity.js";
import { storageEffectiveShelfLifeQd, storageProfileEffectFactor } from "../storage/specialization.js";

function definitionForRow(row) {
  const id = storageResourceId(row);
  return id === "custom" ? row : (resourceDef(id) ?? row);
}

function expirationRoom(holding, row) {
  const roomId = normalizeStorageRoomId(row.roomId ?? row.storageRoomId);
  if (roomId === "outdoors") return undefined;
  const building = (holding?.buildings?.list ?? []).find((candidate) => String(candidate?.id ?? "") === roomId);
  if (!building || building.functions?.storage === false || !buildingOperationalState(building).operational) return undefined;
  return { ...building.storage, profileEffectFactor: storageProfileEffectFactor(holding, building) };
}

export function storageExpiresInQd(holding, row = {}, ageQd = 0) {
  const shelfLifeQd = storageShelfLifeForRow(row);
  if (!shelfLifeQd) return Infinity;
  const deadlineQd = storageEffectiveShelfLifeQd(expirationRoom(holding, row), row, shelfLifeQd);
  return Math.max(0, deadlineQd - Math.max(0, Math.floor(Number(ageQd) || 0)));
}

// Internal demand gives urgency to food purchases only.
export function perishableStorageExpiresInQd(holding, row = {}, ageQd = 0) {
  return isPerishableFoodDefinition(definitionForRow(row))
    ? storageExpiresInQd(holding, row, ageQd)
    : Infinity;
}

export function beginPerishableStoragePeriod(holding) {
  return beginResourceBatchPeriod(holding);
}

export function cancelPerishableStoragePeriod(holding) {
  cancelResourceBatchPeriod(holding);
}

/** Raw ingredients may expire between the daily deliveries and processing shifts. */
export function expireProductionIngredients(holding, step, report, appendLedger) {
  for (const row of holding?.storage?.resources ?? []) {
    const shelfLifeQd = storageShelfLifeForRow(row);
    if (!shelfLifeQd || definitionForRow(row).foodEdible) continue;
    const deadlineQd = storageEffectiveShelfLifeQd(expirationRoom(holding, row), row, shelfLifeQd);
    const expired = (row.batches ?? []).filter((batch) => batch.ageQd + resourceBatchElapsedQd(holding, batch, step) >= deadlineQd);
    if (!expired.length) continue;
    const ids = new Set(expired.map((batch) => batch.id));
    const qty = resourceBatchTotal(expired);
    for (const batch of expired) expireTransportReservation(holding, row, batch);
    row.batches = row.batches.filter((batch) => !ids.has(batch.id));
    row.qty = resourceBatchTotal(row.batches);
    const name = row.name || resourceLabel(row.resourceId);
    report.skipped.push(`${name}: испорчено сырья ${qty} перед производственной сменой.`);
    report.food ??= { lines: [] };
    report.food.expiredQty = (report.food.expiredQty ?? 0) + qty;
    appendLedger?.(report, { domain: "food", kind: "resource", resourceId: row.resourceId, name, qty: -qty,
      roomId: row.roomId, source: "Порча сырья", status: "expired", note: `Истёк срок к ${step} QD периода` });
  }
}

export function finishPerishableStoragePeriod({
  holding,
  elapsedQd = 0,
  report = null,
  appendLedger = null,
  formatNumber = (value) => String(value)
} = {}) {
  const result = finishResourceBatchPeriod(holding, {
    elapsedQd,
    shelfLifeQdForRow: storageShelfLifeForRow,
    effectiveShelfLifeQdForRow: (row, baseQd) => storageEffectiveShelfLifeQd(expirationRoom(holding, row), row, baseQd)
  });
  if (!result.expiredQty) return result;

  const aggregated = new Map();
  for (const item of result.expired) {
    const key = `${item.rowId}\u0000${item.resourceId}\u0000${item.roomId}`;
    const current = aggregated.get(key) ?? { ...item, qty: 0 };
    current.qty += item.qty;
    aggregated.set(key, current);
  }
  const losses = [...aggregated.values()];
  if (report && typeof report === "object") {
    if (!report.food || typeof report.food !== "object") report.food = { lines: [] };
    if (!Array.isArray(report.food.lines)) report.food.lines = [];
    report.food.expiredQty = Math.max(0, Number(report.food.expiredQty) || 0) + result.expiredQty;
    report.food.lines.push(`Испорчено: ${losses.map((item) => `${item.name || resourceLabel(item.resourceId)} -${formatNumber(item.qty)}`).join(", ")}.`);
  }
  if (typeof appendLedger === "function") {
    appendLedger(report, losses.map((item) => ({
      domain: "food",
      kind: "resource",
      resourceId: item.resourceId,
      name: item.name || resourceLabel(item.resourceId),
      qty: -item.qty,
      roomId: item.roomId,
      source: "Порча запасов",
      status: "expired",
      note: `Возраст ${item.ageQd} QD; срок ${item.effectiveShelfLifeQd} QD`
    })));
  }
  return result;
}
