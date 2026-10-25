import { bankState, bankRelationship, prepareBankingModel } from "./banking.js";

const whole = (n) => Math.max(0, Math.floor(Number(n) || 0));
const DENOMINATOR = 9600000n;
export const depositInterestAtTerm = (principal, rate, days) => Number(BigInt(principal) * BigInt(rate) * BigInt(days * 4) / DENOMINATOR);
export function quoteBankDeposit({ data, holding, bankId, offerId, amountCopper, model = prepareBankingModel(data, holding) } = {}) {
  const bank = model.byId.get(bankId), offer = bank?.depositOffers.find((row) => row.id === offerId && row.active);
  const amount = Number(amountCopper);
  if (!bank?.active || !offer) return { ok: false, message: "Выберите доступное предложение вклада." };
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100000000) return { ok: false, message: "Укажите целую сумму вклада от 1 до 100 000 000 ММ." };
  if (amount > whole(holding.storage?.moneyCopper)) return { ok: false, message: "В казне недостаточно денег для размещения." };
  if (model.depositCount >= 100) return { ok: false, message: "Достигнут предел 100 открытых вкладов." };
  if (amount + (model.deposited.get(bankId) ?? 0) > offer.limitCopper) return { ok: false, message: "Превышен лимит размещения в этом банке с учётом открытых вкладов." };
  if (bankRelationship(holding, bankId) < offer.minimumRelationship) return { ok: false, message: "Отношение банка ниже необходимого." };
  const interestCopper = depositInterestAtTerm(amount, offer.annualRateBps, offer.termDays);
  if (amount + interestCopper > 1000000000) return { ok: false, message: "Возврат вклада с процентами превысит предел казны. Уменьшите сумму размещения." };
  return { ok: true, bank, offer, principalCopper: amount, interestCopper, totalCopper: amount + interestCopper };
}
export function openBankDeposit({ data, holding, bankId, offerId, amountCopper, operationId, createdAt = "" } = {}) {
  if ((bankState(holding).deposits ?? []).some((row) => row.id === operationId)) throw new Error("Вклад с этим идентификатором уже существует.");
  const quote = quoteBankDeposit({ data, holding, bankId, offerId, amountCopper });
  if (!quote.ok) throw new Error(quote.message);
  const row = { id: operationId, bankId, bankName: quote.bank.name, offerId, offerName: quote.offer.name, createdAt, status: "active",
    kind: quote.offer.kind, annualRateBps: quote.offer.annualRateBps, termDays: quote.offer.termDays,
    originalPrincipalCopper: quote.principalCopper, principalCopper: quote.principalCopper, interestCopper: 0, interestRemainder: 0, elapsedQd: 0, withdrawnCopper: 0 };
  holding.special ??= {}; holding.special.banking ??= { loans: [], relationships: {} };
  (holding.special.banking.deposits ??= []).push(row);
  holding.storage.moneyCopper -= quote.principalCopper;
  return { ok: true, depositId: row.id, placedCopper: quote.principalCopper };
}
export function advanceBankDeposits(holding, elapsedQd = 0) {
  const elapsed = whole(elapsedQd), rows = [];
  if (!elapsed) return rows;
  for (const row of bankState(holding).deposits ?? []) {
    if (row.status === "closed" || row.kind === "storage" || row.status === "matured") continue;
    const delta = Math.min(elapsed, Math.max(0, whole(row.termDays) * 4 - whole(row.elapsedQd)));
    const numerator = BigInt(whole(row.principalCopper)) * BigInt(whole(row.annualRateBps)) * BigInt(delta) + BigInt(whole(row.interestRemainder));
    const interestCopper = Number(numerator / DENOMINATOR);
    row.interestCopper = whole(row.interestCopper) + interestCopper;
    row.interestRemainder = Number(numerator % DENOMINATOR);
    row.elapsedQd = whole(row.elapsedQd) + delta;
    row.status = row.elapsedQd >= whole(row.termDays) * 4 ? "matured" : "active";
    rows.push({ depositId: row.id, bankName: row.bankName, interestCopper, totalCopper: whole(row.principalCopper) + row.interestCopper, matured: row.status === "matured" });
  }
  return rows;
}
export function quoteBankWithdrawal({ holding, depositId, amountCopper } = {}) {
  const deposit = (bankState(holding).deposits ?? []).find((row) => row.id === depositId && row.status !== "closed");
  const amount = Number(amountCopper);
  if (!deposit || !Number.isSafeInteger(amount) || amount <= 0 || amount > whole(deposit.principalCopper)) return { ok: false, message: "Укажите открытый вклад и допустимую целую сумму снятия." };
  if (deposit.kind !== "storage" && amount !== whole(deposit.principalCopper)) return { ok: false, message: "Срочный вклад закрывается целиком. Досрочное закрытие — без процентов." };
  const matured = deposit.kind !== "storage" && whole(deposit.elapsedQd) >= whole(deposit.termDays) * 4;
  const interestCopper = matured ? whole(deposit.interestCopper) : 0;
  const receivedCopper = amount + interestCopper;
  if (whole(holding.storage?.moneyCopper) + receivedCopper > 1000000000) return { ok: false, message: "После снятия будет превышен допустимый размер казны." };
  return { ok: true, deposit, principalCopper: amount, interestCopper, receivedCopper, early: deposit.kind !== "storage" && !matured };
}
export function withdrawBankDeposit({ holding, depositId, amountCopper, closedAt = "" } = {}) {
  const quote = quoteBankWithdrawal({ holding, depositId, amountCopper });
  if (!quote.ok) throw new Error(quote.message);
  const row = quote.deposit;
  holding.storage ??= {}; holding.storage.moneyCopper = whole(holding.storage.moneyCopper) + quote.receivedCopper;
  row.principalCopper -= quote.principalCopper;
  row.withdrawnCopper = whole(row.withdrawnCopper) + quote.receivedCopper;
  if (!row.principalCopper) { row.status = "closed"; row.closedAt = closedAt; row.paidInterestCopper = quote.interestCopper; }
  return { ok: true, depositId, principalCopper: quote.principalCopper, interestCopper: quote.interestCopper, receivedCopper: quote.receivedCopper, early: quote.early };
}
