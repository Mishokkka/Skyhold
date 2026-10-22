import { SkyholdData } from "../data/store.js";
import { appendHoldingOperation, findHoldingOperation } from "../data/operations.js";
import { applyHybridLaborMigration, applyHybridLaborCatalogMigration } from "../workflows/buildings/hybrid-labor-migration.js";

/** Only an explicit GM Apply persists the exact preview, through the normal authority/write queue. */
export async function executeHybridLaborMigration(raw = {}, { store = SkyholdData, getUser = () => globalThis.game?.user } = {}) {
  const { holdingId, holdingPlan, catalogPlan = null, operationId, expectedRevision } = raw;
  if (getUser()?.isGM !== true) return { ok: false, reason: "Переход применяет только ГМ." };
  if (typeof operationId !== "string" || !operationId || operationId.length > 100
    || !Number.isSafeInteger(expectedRevision) || typeof holdingId !== "string" || !holdingId || !holdingPlan?.ok) {
    return { ok: false, reason: "Некорректный подготовленный переход." };
  }
  const requestSignature = JSON.stringify([holdingId, holdingPlan.sourceHash, holdingPlan.targetHash, catalogPlan?.sourceHash, catalogPlan?.targetHash]);
  return store.transaction((data) => {
    if (getUser()?.isGM !== true) return store.skipTransaction({ ok: false, reason: "Право ГМа больше недоступно." });
    const index = (data.holdings ?? []).findIndex((holding) => holding.id === holdingId);
    if (index < 0) throw new Error("Поселение больше не существует.");
    const prior = findHoldingOperation(data.holdings[index], operationId);
    if (prior) return store.skipTransaction(prior.payload?.hybridLaborMigration && prior.payload.requestSignature === requestSignature
      ? { ok: true, replay: true } : { ok: false, reason: "Идентификатор операции уже использован другим действием." });
    if (Number(data.meta?.revision) !== expectedRevision) throw new Error("Данные изменились после просмотра перехода. Обновите расчёт.");
    const nextHolding = applyHybridLaborMigration({ holding: data.holdings[index], plan: holdingPlan });
    const nextCatalog = catalogPlan ? applyHybridLaborCatalogMigration({ catalog: data.catalog, plan: catalogPlan }) : null;
    if (holdingPlan.sourceHash === holdingPlan.targetHash && (!catalogPlan || catalogPlan.sourceHash === catalogPlan.targetHash)) {
      return store.skipTransaction({ ok: true, replay: false, unchanged: true });
    }
    appendHoldingOperation(nextHolding, { operationId, type: "system", title: "Переход к двум способам труда",
      summary: `Проверены ${holdingPlan.changes.length} построек${catalogPlan ? ` и ${catalogPlan.changes.length} шаблонов` : ""}.`,
      createdAt: new Date().toISOString(), payload: { hybridLaborMigration: true, requestSignature } });
    data.holdings[index] = nextHolding;
    if (nextCatalog) data.catalog = nextCatalog;
    return { ok: true, replay: false };
  }, { reason: `hybrid-labor-migration:${operationId}`, scope: catalogPlan ? "both" : "holdings", forceRollbackSnapshot: true });
}
