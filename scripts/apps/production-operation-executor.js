import { appendHoldingOperation, findHoldingOperation } from "../data/operations.js";
import { COMMAND_ERROR } from "../data/command-result.js";
import { cancelProductionBatch } from "../engines/economy/production-cancellation.js";

const TYPES = new Set(["cancelProductionBatch", "deleteProductionLine"]);
function fail(message, code = COMMAND_ERROR.INVALID) { throw Object.assign(new Error(message), { code }); }

/** Reuses the authority building-operation channel, never a player storage patch. */
export async function executeProductionOperation(raw, { userId, remote }, { updateHolding, skipTransaction, getUser, logic, now }) {
  if (!globalThis.game?.user?.isGM) fail("Производственные операции сохраняет authority-ГМ.", COMMAND_ERROR.FORBIDDEN);
  const operation = Object.fromEntries(["type", "operationId", "holdingId", "buildingId", "lineId"].map((key) => [key, String(raw[key] ?? "").trim()]));
  operation.expectedRevision = Number(raw.expectedRevision);
  if (raw.batchId !== undefined) {
    if (typeof raw.batchId !== "string" || !raw.batchId.trim() || raw.batchId.length > 128 || raw.type !== "cancelProductionBatch") fail("Некорректный ID производственной партии.");
    operation.batchId = raw.batchId.trim();
  }
  if (!TYPES.has(operation.type) || Object.values(operation).some((value) => typeof value === "string" && (!value || value.length > 128))
    || !Number.isSafeInteger(operation.expectedRevision) || operation.expectedRevision < 0) fail("Некорректная операция производственной линии.");
  const signature = JSON.stringify(operation);
  if (remote && getUser(userId)?.isGM) fail("Недопустимый отправитель.", COMMAND_ERROR.FORBIDDEN);
  return updateHolding(operation.holdingId, (holding, data) => {
    if (!globalThis.game?.user?.isGM) fail("Полномочия ГМа утрачены.", COMMAND_ERROR.FORBIDDEN);
    const user = getUser(userId);
    if (!user || (!user.isGM && (holding.visibility === "gm" || holding.gm?.playersCanEditBuildings !== true))) fail("Нет права изменять производственные линии.", COMMAND_ERROR.FORBIDDEN);
    const prior = findHoldingOperation(holding, operation.operationId);
    if (prior) {
      if (prior.type !== "construction-cancellation" || prior.payload?.kind !== "production" || prior.payload?.signature !== signature || prior.payload?.actorId !== userId) fail("ID операции уже использован.", COMMAND_ERROR.CONFLICT);
      return skipTransaction({ ok: true, replay: true, summary: prior.summary });
    }
    if (operation.expectedRevision !== data.meta?.revision) fail("Данные изменились. Обновите окно и повторите действие.", COMMAND_ERROR.CONFLICT);
    const building = holding.buildings?.list?.find((row) => row.id === operation.buildingId);
    if (!building || (!user.isGM && building.visibility === "gm")) fail("Здание недоступно.", COMMAND_ERROR.FORBIDDEN);
    const index = building.productionLines?.findIndex((row) => row.id === operation.lineId) ?? -1;
    if (index < 0) fail("Производственная линия не найдена.");
    const line = building.productionLines[index];
    if (operation.type === "deleteProductionLine" && Number(line.pendingQty) > 0) fail("Перед удалением линии соберите готовую продукцию.");
    const cancelled = cancelProductionBatch(holding, line, {
      batchId: operation.batchId,
      addMoney: (draft, amount) => logic._addMoney(draft, amount),
      addResource: (draft, resource, amount) => logic._restoreProductionResource(draft, resource, amount)
    });
    if (!cancelled.ok) fail(cancelled.reason);
    if (cancelled.noop && operation.type !== "deleteProductionLine") return skipTransaction(cancelled);
    if (operation.type === "deleteProductionLine") building.productionLines.splice(index, 1);
    const summary = `${building.name || "Здание"}: ${operation.type === "deleteProductionLine" ? "линия удалена" : operation.batchId ? "выбранная партия отменена" : "партии отменены, линия остановлена"}. ${cancelled.expired ? "Просроченные партии списаны без возврата сырья." : `Пригодное сырьё возвращено: ${cancelled.refunds.map((row) => `${row.name} ${row.qty}`).join(", ") || "нет"}.${cancelled.discardedQty ? ` Испорчено сырья: ${cancelled.discardedQty}.` : ""}${cancelled.expiredBatches ? ` Просроченных партий списано: ${cancelled.expiredBatches}.` : ""}`} Затраченный труд не возвращается.`;
    appendHoldingOperation(holding, { type: "construction-cancellation", operationId: operation.operationId, createdAt: now().toISOString(),
      title: "Производственная партия", summary, payload: { kind: "production", signature, actorId: userId, refunds: cancelled.refunds } });
    return { ok: true, summary };
  }, { fallback: false, reason: `production:${operation.type}` });
}
