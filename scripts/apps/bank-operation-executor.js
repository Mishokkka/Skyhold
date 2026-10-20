import { SkyholdData } from "../data/store.js";
import { canReadHolding } from "../data/access-guard.js";
import { appendHoldingOperation, findHoldingOperation } from "../data/operations.js";
import { bankTermsToken, issueBankLoan, repayBankLoan } from "../engines/economy/banking.js";

function fail(message, code = "invalid") { return Object.assign(new Error(message), { code }); }
export function createBankOperationExecutor({
  updateHolding = (id, updater, options) => SkyholdData.updateHolding(id, updater, options),
  skipTransaction = (result) => SkyholdData.skipTransaction(result),
  getUser = (id) => globalThis.game?.users?.get?.(id) ?? (globalThis.game?.user?.id === id ? globalThis.game.user : null),
  now = () => new Date().toISOString()
} = {}) {
  return async (raw = {}, { userId = "", remote = false } = {}) => {
    const op = { type: String(raw.type ?? ""), operationId: String(raw.operationId ?? ""), holdingId: String(raw.holdingId ?? ""),
      expectedRevision: Number(raw.expectedRevision), sourceToken: String(raw.sourceToken ?? ""), bankId: String(raw.bankId ?? ""),
      offerId: String(raw.offerId ?? ""), loanId: String(raw.loanId ?? ""), amountCopper: Number(raw.amountCopper) };
    if (!["bank-borrow", "bank-repay"].includes(op.type) || !/^[a-zA-Z0-9:_-]{6,160}$/.test(op.operationId)
      || !op.holdingId || !op.sourceToken || !Number.isSafeInteger(op.expectedRevision) || op.expectedRevision < 0
      || !Number.isSafeInteger(op.amountCopper) || op.amountCopper <= 0 || op.amountCopper > 100000000) throw fail("Некорректная банковская операция.");
    const user = getUser(userId);
    if (!user || (remote && user.isGM)) throw fail("Не удалось подтвердить пользователя.", "forbidden");
    const signature = JSON.stringify(op);
    const result = await updateHolding(op.holdingId, (holding, data) => {
      if (!canReadHolding(holding, user) || (!user.isGM && holding.gm?.playersCanUseStorage !== true)) throw fail("Нет права распоряжаться казной.", "forbidden");
      const previous = findHoldingOperation(holding, op.operationId);
      if (previous) {
        if (previous.type !== "bank" || previous.payload?.signature !== signature || previous.payload?.userId !== userId) throw fail("Этот идентификатор уже использован другой операцией.", "conflict");
        return skipTransaction({ ...previous.payload.result, replay: true });
      }
      if (op.expectedRevision !== Number(data.meta?.revision) || op.sourceToken !== bankTermsToken(data, holding)) throw fail("Условия банка или казна изменились. Пересмотрите расчёт.", "conflict");
      const at = now();
      let result;
      try {
        result = op.type === "bank-borrow"
          ? issueBankLoan({ data, holding, ...op, createdAt: at })
          : repayBankLoan({ holding, ...op });
      } catch (error) {
        throw fail(error.message || "Банк отклонил операцию.", "invalid");
      }
      result.operationId = op.operationId;
      holding.storage.log ??= [];
      const cashRows = op.type === "bank-borrow"
        ? [{ qty: result.principalCopper, name: "Получен банковский заём" }, { qty: -result.feeCopper, name: "Комиссия банка" }]
        : [{ qty: -result.paidCopper, name: "Погашение банковского займа" }];
      holding.storage.log.push(...cashRows.filter((row) => row.qty).map((row) => ({ ...row, kind: "bank", resourceId: "money", roomId: "treasury",
        source: "Банк", note: op.type === "bank-borrow" ? "Заём подлежит возврату; это финансирование, а не прибыль." : "Погашение тела и начисленных процентов.", ts: at, operationId: op.operationId })));
      appendHoldingOperation(holding, { type: "bank", operationId: op.operationId, createdAt: at,
        title: op.type === "bank-borrow" ? "Банковский заём" : "Погашение займа",
        payload: { signature, userId, result } });
      return result;
    }, { reason: op.type });
    if (!result) throw fail("Поселение не найдено.");
    return result;
  };
}
export const executeBankOperation = createBankOperationExecutor();
