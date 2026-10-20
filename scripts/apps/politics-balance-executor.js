import { SkyholdData } from "../data/store.js";
import { appendHoldingOperation, findHoldingOperation } from "../data/operations.js";
import { applyPoliticsBalanceEdit } from "../engines/politics/balance-edit.js";

export async function executePoliticsBalanceOperation(raw = {}, {
  store = SkyholdData,
  getUser = () => globalThis.game?.user
} = {}) {
  if (!getUser()?.isGM) return { ok: false, reason: "Редактор баланса доступен только ГМу." };
  const holdingId = String(raw.holdingId ?? "").trim();
  const operationId = String(raw.operationId ?? "").trim();
  const expectedRevision = raw.expectedRevision;
  if (!holdingId || holdingId.length > 100 || !operationId || operationId.length > 100
    || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return { ok: false, reason: "Некорректные данные изменения баланса." };
  }
  const action = String(raw.action ?? "");
  const payload = raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload) ? raw.payload : {};
  let signature;
  try { signature = JSON.stringify({ action, payload }); }
  catch { return { ok: false, reason: "Некорректные данные изменения баланса." }; }
  if (signature.length > 16000) return { ok: false, reason: "Слишком большой запрос изменения баланса." };
  const result = await store.updateHolding(holdingId, (holding, data) => {
    if (!getUser()?.isGM) return store.skipTransaction({ ok: false, reason: "Полномочия ГМа утрачены." });
    const prior = findHoldingOperation(holding, operationId);
    if (prior) return store.skipTransaction(prior.type === "politics" && prior.payload?.signature === signature
      ? { ok: true, replay: true, operationId, summary: prior.summary, rowId: prior.payload?.rowId ?? "" }
      : { ok: false, reason: "Идентификатор операции уже использован." });
    if (Number(data?.meta?.revision) !== expectedRevision) {
      return store.skipTransaction({ ok: false, conflict: true, reason: "Данные владения изменились. Обновите редактор и повторите правку." });
    }
    const applied = applyPoliticsBalanceEdit(holding?.gm?.politicsBalance, action, payload);
    if (!applied.ok || applied.noop) return store.skipTransaction(applied);
    holding.gm.politicsBalance = applied.balance;
    appendHoldingOperation(holding, {
      operationId, type: "politics", createdAt: new Date().toISOString(),
      title: "Настройка Политики", summary: applied.summary,
      payload: { signature, rowId: applied.rowId ?? "" }
    });
    return { ok: true, operationId, summary: applied.summary, rowId: applied.rowId ?? "" };
  }, { fallback: false, reason: `politics-balance:${action}` });
  return result ?? { ok: false, reason: "Владение не найдено." };
}
