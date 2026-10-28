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
  normalizeResourceId,
  resourceCategoryTag,
  resourceDef,
  resourceLabel,
  resourceShelfLifeQd
} from "../../core/resources.js";
import { storageEffectiveShelfLifeMultiplier, storageProfileEffectFactor } from "../storage/specialization.js";

function definitionForRow(row = {}) {
  const id = normalizeResourceId(row.resourceId, row.id, row.name);
  return { id, definition: id === "custom" ? null : resourceDef(id) };
}

function shelfLifeForRow(row = {}) {
  const { id, definition } = definitionForRow(row);
  return definition ? resourceShelfLifeQd(id) : resourceShelfLifeQd(row);
}

function categoryForRow(row = {}) {
  const { id, definition } = definitionForRow(row);
  return definition ? resourceCategoryTag(id) : resourceCategoryTag(row);
}

function roomMultiplierForRow(holding, row = {}) {
  const roomId = String(row.roomId ?? row.storageRoomId ?? "outdoors") || "outdoors";
  if (roomId === "outdoors") return 1;
  const building = (holding?.buildings?.list ?? []).find((candidate) => String(candidate?.id ?? "") === roomId);
  if (!building || !buildingOperationalState(building).operational) return 1;
  const profileEffectFactor = storageProfileEffectFactor(holding, building);
  return storageEffectiveShelfLifeMultiplier({
    ...(building?.storage ?? {}),
    profileEffectFactor
  }, row);
}

export function perishableStorageExpiresInQd(holding, row = {}, ageQd = 0) {
  if (!isPerishableFoodDefinition(definitionForRow(row).definition ?? row)) return Number.POSITIVE_INFINITY;
  const shelfLifeQd = Math.max(0, Math.floor(Number(shelfLifeForRow(row)) || 0));
  if (!shelfLifeQd) return Number.POSITIVE_INFINITY;
  const multiplier = roomMultiplierForRow(holding, row);
  const effectiveShelfLifeQd = Math.max(1, Math.floor(shelfLifeQd * multiplier));
  return Math.max(0, effectiveShelfLifeQd - Math.max(0, Math.floor(Number(ageQd) || 0)));
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
    const definition = definitionForRow(row).definition ?? row;
    if (!isPerishableFoodDefinition(definition) || definition.foodEdible) continue;
    const expired = (row.batches ?? []).filter((batch) => perishableStorageExpiresInQd(holding, row,
      batch.ageQd + resourceBatchElapsedQd(holding, batch, step)) <= 0);
    if (!expired.length) continue;
    const ids = new Set(expired.map((batch) => batch.id));
    const qty = resourceBatchTotal(expired);
    for (const batch of expired) expireTransportReservation(holding, row.id, batch.id);
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
    shelfLifeQdForRow: shelfLifeForRow,
    categoryTagForRow: categoryForRow,
    isPerishableFoodForRow: (row) => isPerishableFoodDefinition(definitionForRow(row).definition ?? row),
    roomMultiplierForRow: (row) => roomMultiplierForRow(holding, row)
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
