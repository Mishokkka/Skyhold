import { bankState, bankLoanBalance, bankRelationship, quoteBankLoan, loanPrincipalForNet, loanInterestForDays, quoteBankRepayment } from "../../../engines/economy/banking.js";
import { quoteBankDeposit, quoteBankWithdrawal, depositInterestAtTerm } from "../../../engines/economy/bank-deposits.js";
import { formatCopperCurrencyCompact as money } from "../../../core/currency.js";

const pct = (bps) => `${(bps / 100).toFixed(2)}%`;
export const bankProductKey = (bankId, offerId) => JSON.stringify([bankId, offerId]);
export function bankPage(rows, page = 0, size = 10) {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  page = Math.max(0, Math.min(pages - 1, Number.isSafeInteger(page) ? page : 0));
  return { rows: rows.slice(page * size, (page + 1) * size), page, pageText: `${page + 1} / ${pages}`, total: rows.length, previous: page > 0, next: page + 1 < pages };
}
export function prepareBankComparison({ data, holding, model, state, canTransact, blocked }) {
  const deposit = state.tab === "deposit", amount = Number(state.amount), days = Number(state.days);
  const valid = Number.isSafeInteger(amount) && amount > 0 && amount <= 100000000 && Number.isSafeInteger(days) && days >= 1 && days <= 2400;
  let rows = [];
  if (valid) for (const bank of model.banks) {
    if (!bank.active || (state.query && !`${bank.name} ${bank.description}`.toLocaleLowerCase().includes(state.query.toLocaleLowerCase()))) continue;
    for (const offer of (deposit ? bank.depositOffers : bank.offers)) {
      if (!offer.active) continue;
      const principal = deposit ? amount : loanPrincipalForNet(amount, offer.feeBps);
      const quote = deposit ? quoteBankDeposit({ data, holding, model, bankId: bank.id, offerId: offer.id, amountCopper: principal })
        : quoteBankLoan({ data, holding, model, bankId: bank.id, offerId: offer.id, amountCopper: principal });
      const withinTerm = deposit || offer.termDays >= days;
      const message = quote.message || (!withinTerm ? "Срок договора короче выбранного срока возврата." : "");
      const eligible = quote.ok && withinTerm;
      const depositIncome = deposit ? depositInterestAtTerm(amount, offer.annualRateBps, offer.termDays) : 0;
      const income = deposit && days >= offer.termDays ? depositIncome : 0;
      const interest = deposit ? 0 : loanInterestForDays(principal, offer.annualRateBps, days);
      const total = deposit ? amount + income : principal + interest;
      const value = deposit ? income : (quote.feeCopper ?? Math.ceil(principal * offer.feeBps / 10000)) + interest;
      rows.push({ key: bankProductKey(bank.id, offer.id), bankId: bank.id, offerId: offer.id, bankName: bank.name, name: offer.name,
        description: bank.description, relationship: bankRelationship(holding, bank.id), rateText: pct(offer.annualRateBps), termText: offer.kind === "storage" ? "В любой момент" : `${offer.termDays} дн.`,
        amountText: money(principal), receivedText: money(deposit ? amount : principal - Math.ceil(principal * offer.feeBps / 10000)), feeText: money(quote.feeCopper ?? 0),
        totalText: money(total), valueText: money(value), termTotalText: money(deposit ? amount + depositIncome : principal + loanInterestForDays(principal, offer.annualRateBps, offer.termDays)),
        message, eligible, canReview: eligible && canTransact && !blocked, value, rate: offer.annualRateBps, deposit,
        early: deposit && offer.kind !== "storage" && days < offer.termDays, storage: offer.kind === "storage", principal,
        terms: deposit ? (offer.kind === "storage" ? "Частичное снятие в любой момент, без процентов." : "Досрочное закрытие только целиком, без процентов. После окончания срока начисление прекращается.")
          : `Лимит тела долга перед этим банком: ${money(offer.limitCopper)}; отношение от ${offer.minimumRelationship}. Комиссия удерживается при выдаче.`,
        operation: { type: deposit ? "bank-deposit" : "bank-borrow", bankId: bank.id, offerId: offer.id, amountCopper: principal } });
    }
  }
  if (state.availableOnly) rows = rows.filter((row) => row.eligible);
  rows.sort((a, b) => Number(b.eligible) - Number(a.eligible) || (state.sort === "rate" ? deposit ? b.rate - a.rate : a.rate - b.rate : deposit ? b.value - a.value : a.value - b.value) || a.bankName.localeCompare(b.bankName));
  const selected = rows.find((row) => row.key === state.selected) ?? rows[0];
  const page = bankPage(rows, state.page);
  return { ...page, rows: page.rows.map((row) => ({ ...row, selected: row.key === selected?.key })), selected,
    invalidInput: valid ? "" : "Укажите целую сумму от 1 до 100 000 000 ММ и срок от 1 до 2400 дней.", deposit };
}
export function prepareBankContracts({ holding, state, canTransact, blocked }) {
  const deposits = state.contractKind === "deposits", history = Boolean(state.history);
  const list = (deposits ? bankState(holding).deposits : bankState(holding).loans) ?? [];
  const rows = list.filter((row) => history === (row.status === (deposits ? "closed" : "paid"))).map((row) => ({
    ...row, deposits, rateText: pct(row.annualRateBps), storage: row.kind === "storage", termText: row.kind === "storage" ? "Свободный срок" : `${row.termDays} дн.`,
    amountText: money(deposits ? (history ? row.withdrawnCopper : row.principalCopper) : history ? row.paidCopper : bankLoanBalance(row)),
    amountLabel: history ? deposits ? "Возвращено в казну" : "Выплачено" : deposits ? "Основная сумма" : "Остаток долга",
    statusText: history ? "Закрыт" : row.kind === "storage" ? "В любой момент" : row.status === "overdue" ? "Просрочен" : row.status === "matured" ? "Срок завершён" : `Осталось ${Math.max(0, (row.termDays * 4 - row.elapsedQd) / 4)} дн.`
  }));
  const selected = rows.find((row) => row.id === state.contractId) ?? rows[0];
  const page = bankPage(rows, state.contractPage);
  let payment;
  if (selected && !history) {
    const amount = state.contractId === selected.id && state.payment !== null ? state.payment : deposits ? selected.principalCopper : bankLoanBalance(selected);
    const quote = deposits ? quoteBankWithdrawal({ holding, depositId: selected.id, amountCopper: amount }) : quoteBankRepayment({ holding, loanId: selected.id, amountCopper: amount });
    payment = { ...selected, amount, canEditAmount: !deposits || selected.storage, message: quote.message, early: quote.early,
      canReview: quote.ok && canTransact && !blocked, interestText: money(deposits ? quote.interestCopper : quote.interestPaid),
      principalText: money(deposits ? quote.principalCopper : quote.principalPaid), remainingText: money(deposits ? selected.principalCopper - amount : quote.remainingCopper),
      treasuryAfterText: money((holding.storage?.moneyCopper ?? 0) + (deposits ? quote.receivedCopper ?? 0 : -Number(amount))),
      operation: { type: deposits ? "bank-withdraw" : "bank-repay", [deposits ? "depositId" : "loanId"]: selected.id, amountCopper: Number(amount) } };
  }
  const archived = selected && history ? { ...selected, originalText: money(selected.originalPrincipalCopper),
    cumulativeText: money(deposits ? selected.withdrawnCopper : selected.paidCopper), daysText: selected.kind === "storage" ? "Свободный срок" : `${selected.termDays} дн.` } : null;
  return { ...page, rows: page.rows.map((row) => ({ ...row, selected: row.id === selected?.id })), payment, archived, deposits, history };
}
export function bankEditorContext(banks, state) {
  const filtered = banks.filter((bank) => bank.name.toLocaleLowerCase().includes((state.editorQuery ?? "").toLocaleLowerCase()));
  const bank = banks.find((row) => row.id === state.editorId) ?? filtered[0];
  const page = bankPage(filtered, state.editorPage, 8);
  const fields = (row, deposits) => [
    { key: "annualRateBps", label: "Годовая ставка, %", min: 0, max: 100, step: 0.01, value: row.annualRateBps / 100, percent: true },
    { key: "termDays", label: "Срок, дни", min: 1, max: 2400, step: 1, value: row.termDays },
    ...(!deposits ? [{ key: "feeBps", label: "Комиссия, %", min: 0, max: 50, step: 0.01, value: row.feeBps / 100, percent: true }] : []),
    { key: "limitCopper", label: "Лимит на поселение, ММ", min: 1, max: 100000000, step: 1, value: row.limitCopper },
    { key: "minimumRelationship", label: "Минимальное отношение", min: -100, max: 100, step: 1, value: row.minimumRelationship }
  ].filter((field) => !deposits || row.kind !== "storage" || !["annualRateBps", "termDays"].includes(field.key));
  return { ...page, rows: page.rows.map((row) => ({ id: row.id, name: row.name, selected: row.id === bank?.id })), bank: bank ? { ...bank,
    groups: [["offers", "Займы", false], ["depositOffers", "Вклады", true]].map(([key, label, deposits]) => ({ key, label, deposits,
      canAdd: (bank[key]?.length ?? 0) < 20, rows: (bank[key] ?? []).map((row) => ({ ...row, deposits, storage: row.kind === "storage", fields: fields(row, deposits) })) })) } : null };
}
