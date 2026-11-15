import { copperDenominations } from "../../../core/currency.js";
import { SkyholdData } from "../../../data/store.js";
import { appendStorageLogEntries } from "../../../data/storage-log.js";

const DENOMINATION_FACTORS = { gold: 100, silver: 10, copper: 1 };

/** The market sets the total. The storage fields replace one denomination or apply a delta. */
export async function editHoldingTreasury(holdingId, { amount, expectedCopper, denomination = "", relative = false }) {
  if (!game.user?.isGM) return { ok: false, message: "Казну редактирует ГМ." };
  if (!Number.isSafeInteger(amount) || (!relative && amount < 0)
    || (denomination && !Object.hasOwn(DENOMINATION_FACTORS, denomination))) {
    return { ok: false, message: "Введите допустимую сумму целых монет." };
  }
  const factor = denomination ? DENOMINATION_FACTORS[denomination] : 1;
  const field = denomination || "totalCopper";
  return SkyholdData.updateHolding(holdingId, (holding) => {
    const coins = copperDenominations(holding.storage?.moneyCopper);
    const before = coins.totalCopper;
    const total = Math.max(0, before + (relative ? amount : amount - coins[field]) * factor);
    if (!Number.isSafeInteger(total)) return SkyholdData.skipTransaction({ ok: false, message: "Сумма выходит за допустимый диапазон." });
    if (total === before) return SkyholdData.skipTransaction({ ok: true });
    if (!relative && before !== expectedCopper) {
      return SkyholdData.skipTransaction({ ok: false, message: "Сумма изменилась во время редактирования. Сверьте её и повторите правку." });
    }
    holding.storage.moneyCopper = total;
    const diff = total - before;
    appendStorageLogEntries(holding, [{ kind: diff > 0 ? "income" : "expense", resourceId: "money",
      qty: diff, source: "Казна", note: "Ручная правка" }]);
    return { ok: true };
  }, { fallback: false, reason: "storage:set-money" });
}
