import { bankCatalog } from "../../data/banks.js";
import { stableDataHash } from "../../data/storage-commit.js";

const whole = (value) => Math.max(0, Math.floor(Number(value) || 0));
const DENOMINATOR = 9600000n; // 240 days × 4 QD × 10,000 basis points.
export const bankState = (holding) => holding?.special?.banking ?? { loans: [], relationships: {} };
export function bankRelationship(holding, bankId) {
  return Math.min(100, Math.max(-100, Number(bankState(holding).relationships?.[bankId]) || 0));
}
function ensureState(holding) {
  holding.special ??= {};
  holding.special.banking ??= { loans: [], relationships: {} };
  holding.special.banking.loans ??= [];
  holding.special.banking.relationships ??= {};
  return holding.special.banking;
}
export function bankLoanBalance(loan = {}) {
  return whole(loan.principalCopper) + whole(loan.interestCopper) + (whole(loan.interestRemainder) > 0 ? 1 : 0);
}
export function bankTermsToken(data, holding) {
  return stableDataHash({ banks: bankCatalog(data), banking: bankState(holding), money: holding?.storage?.moneyCopper });
}
export function quoteBankLoan({ data, holding, bankId, offerId, amountCopper } = {}) {
  const bank = bankCatalog(data).find((row) => row.id === bankId && row.active);
  const offer = bank?.offers.find((row) => row.id === offerId && row.active);
  const principal = whole(amountCopper);
  if (!offer || !principal || principal !== Number(amountCopper)) return { ok: false, message: "Выберите доступное предложение и целую сумму в медных монетах." };
  const loans = bankState(holding).loans ?? [];
  if (loans.some((loan) => loan.status !== "paid" && whole(loan.elapsedQd) > whole(loan.termDays) * 4)) return { ok: false, message: "Сначала погасите просроченный заём." };
  if (loans.filter((loan) => loan.status !== "paid").length >= 100) return { ok: false, message: "Достигнут предел активных займов." };
  const exposure = loans.filter((loan) => loan.bankId === bank.id && loan.status !== "paid").reduce((sum, loan) => sum + whole(loan.principalCopper), 0);
  if (principal + exposure > offer.limitCopper) return { ok: false, message: "Превышен кредитный лимит банка с учётом действующих займов." };
  if (bankRelationship(holding, bank.id) < offer.minimumRelationship) return { ok: false, message: "Отношение банка ниже необходимого." };
  const feeCopper = Math.ceil(principal * offer.feeBps / 10000);
  const interestAtTermCopper = Number((BigInt(principal) * BigInt(offer.annualRateBps) * BigInt(offer.termDays * 4) + DENOMINATOR - 1n) / DENOMINATOR);
  return { ok: true, bank, offer, principalCopper: principal, feeCopper, receivedCopper: principal - feeCopper,
    interestAtTermCopper, totalAtTermCopper: principal + interestAtTermCopper,
    costAtTermCopper: feeCopper + interestAtTermCopper };
}
export function issueBankLoan({ data, holding, bankId, offerId, amountCopper, operationId, createdAt = "" } = {}) {
  const state = ensureState(holding);
  if (state.loans.some((loan) => loan.id === operationId)) throw new Error("Заём с этим идентификатором уже существует.");
  const quote = quoteBankLoan({ data, holding, bankId, offerId, amountCopper });
  if (!quote.ok) throw new Error(quote.message);
  const money = whole(holding.storage?.moneyCopper) + quote.receivedCopper;
  if (money > 1000000000) throw new Error("Сумма превышает допустимый размер казны.");
  const loan = { id: operationId, bankId, bankName: quote.bank.name, offerId, offerName: quote.offer.name, status: "active", createdAt,
    originalPrincipalCopper: quote.principalCopper, principalCopper: quote.principalCopper,
    annualRateBps: quote.offer.annualRateBps, termDays: quote.offer.termDays, feeCopper: quote.feeCopper,
    interestCopper: 0, interestRemainder: 0, elapsedQd: 0, overduePeriods: 0, paidCopper: 0 };
  state.loans.push(loan);
  holding.storage ??= {};
  holding.storage.moneyCopper = money;
  return { ok: true, loanId: loan.id, receivedCopper: quote.receivedCopper, principalCopper: quote.principalCopper, feeCopper: quote.feeCopper };
}
export function advanceBankLoans(holding, elapsedQd = 0) {
  const state = bankState(holding);
  const elapsed = whole(elapsedQd);
  const rows = [];
  if (!elapsed) return rows;
  for (const loan of state.loans ?? []) {
    if (loan.status === "paid") continue;
    const numerator = BigInt(whole(loan.principalCopper)) * BigInt(whole(loan.annualRateBps)) * BigInt(elapsed) + BigInt(whole(loan.interestRemainder));
    const interest = Number(numerator / DENOMINATOR);
    loan.interestRemainder = Number(numerator % DENOMINATOR);
    loan.interestCopper = whole(loan.interestCopper) + interest;
    loan.elapsedQd = whole(loan.elapsedQd) + elapsed;
    const lateQd = Math.max(0, loan.elapsedQd - whole(loan.termDays) * 4);
    const overduePeriods = Math.ceil(lateQd / 40);
    if (overduePeriods > whole(loan.overduePeriods)) {
      state.relationships ??= {};
      state.relationships[loan.bankId] = Math.max(-100, bankRelationship(holding, loan.bankId) - 5 * (overduePeriods - whole(loan.overduePeriods)));
    }
    loan.overduePeriods = overduePeriods;
    loan.status = lateQd > 0 ? "overdue" : "active";
    rows.push({ loanId: loan.id, bankName: loan.bankName, interestCopper: interest, balanceCopper: bankLoanBalance(loan), overdue: lateQd > 0 });
  }
  return rows;
}
export function repayBankLoan({ holding, loanId, amountCopper } = {}) {
  const state = ensureState(holding);
  const loan = state.loans.find((row) => row.id === loanId && row.status !== "paid");
  const amount = whole(amountCopper);
  if (!loan || !amount || amount !== Number(amountCopper)) throw new Error("Укажите действующий заём и целую сумму платежа.");
  const balance = bankLoanBalance(loan);
  if (amount > balance || amount > whole(holding.storage?.moneyCopper)) throw new Error("Платёж превышает остаток долга или казну.");
  const interestDue = whole(loan.interestCopper) + (whole(loan.interestRemainder) ? 1 : 0);
  const interestPaid = Math.min(amount, interestDue);
  if (interestPaid >= interestDue) { loan.interestCopper = 0; loan.interestRemainder = 0; }
  else loan.interestCopper = Math.max(0, whole(loan.interestCopper) - interestPaid);
  loan.principalCopper = Math.max(0, whole(loan.principalCopper) - (amount - interestPaid));
  loan.paidCopper = whole(loan.paidCopper) + amount;
  holding.storage.moneyCopper -= amount;
  if (!bankLoanBalance(loan)) {
    loan.status = "paid";
    if (whole(loan.elapsedQd) >= Math.min(40, whole(loan.termDays) * 4)) {
      state.relationships[loan.bankId] = Math.min(100, bankRelationship(holding, loan.bankId) + (whole(loan.overduePeriods) ? 1 : 5));
    }
  }
  return { ok: true, loanId, paidCopper: amount, interestPaidCopper: interestPaid, balanceCopper: bankLoanBalance(loan) };
}
