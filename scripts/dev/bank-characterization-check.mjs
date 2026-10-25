import assert from "node:assert/strict";
import { BANK_PRESETS } from "../data/banks.js";
import { bankTermsToken, quoteBankLoan, issueBankLoan, advanceBankLoans, repayBankLoan, bankLoanBalance, bankRelationship } from "../engines/economy/banking.js";
import { createBankOperationExecutor } from "../apps/bank-operation-executor.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { pathToFileURL } from "node:url";
import { checkBankDeposits } from "./bank-deposit-check.mjs";
export async function checkBankCharacterization() {
function fixture() { const holding = { id: "village", visibility: "all", gm: { playersCanUseStorage: true }, storage: { moneyCopper: 0 }, special: {} };
  return { meta: { revision: 1 }, catalog: { banks: [structuredClone(BANK_PRESETS[0])] }, holdings: [holding] }; }
{
  const data = fixture(), holding = data.holdings[0];
  const quote = quoteBankLoan({ data, holding, bankId: "merchant", offerId: "working-capital", amountCopper: 1000 });
  assert.equal(quote.receivedCopper, 990);
  assert.equal(quote.interestAtTermCopper, 25);
  issueBankLoan({ data, holding, bankId: "merchant", offerId: "working-capital", amountCopper: 1000, operationId: "loan-term" });
  const split = structuredClone(holding);
  advanceBankLoans(holding, 240);
  for (let day = 0; day < 60; day++) advanceBankLoans(split, 4);
  assert.deepEqual(split.special.banking, holding.special.banking, "daily and full-term accrual are identical");
  const loan = holding.special.banking.loans[0];
  assert.equal(bankLoanBalance(loan), 1025);
  data.catalog.banks[0].offers[0].annualRateBps = 9000;
  assert.equal(loan.annualRateBps, 1000, "existing contract fixes its rate");
  const reloaded = mergeHoldingDefaults(holding);
  assert.deepEqual(reloaded.special.banking, holding.special.banking);
  holding.storage.moneyCopper += 35;
  repayBankLoan({ holding, loanId: loan.id, amountCopper: 1025 });
  assert.equal(bankRelationship(holding, "merchant"), 5);
  assert.equal(loan.status, "paid");
  assert.equal(holding.storage.moneyCopper, 0);
}
{
  const data = fixture(), holding = data.holdings[0];
  issueBankLoan({ data, holding, bankId: "merchant", offerId: "working-capital", amountCopper: 1000, operationId: "loan-late" });
  const split = structuredClone(holding);
  advanceBankLoans(holding, 280);
  for (let day = 0; day < 70; day++) advanceBankLoans(split, 4);
  assert.deepEqual(split.special.banking, holding.special.banking);
  assert.equal(bankRelationship(holding, "merchant"), -5);
  assert.equal(quoteBankLoan({ data, holding, bankId: "merchant", offerId: "working-capital", amountCopper: 100 }).ok, false);
  assert.equal(holding.storage.moneyCopper, 990, "interest is debt, not a silent treasury withdrawal");
}
{
  let data = fixture();
  const skipKey = Symbol();
  const executor = createBankOperationExecutor({
    getUser: (id) => ({ id, isGM: id === "gm" }),
    skipTransaction: (result) => ({ [skipKey]: true, result }),
    updateHolding: async (id, updater) => {
      const draft = structuredClone(data), holding = draft.holdings.find((row) => row.id === id);
      const result = updater(holding, draft);
      if (result?.[skipKey]) return result.result;
      draft.meta.revision++; data = draft; return result;
    }
  });
  const op = { type: "bank-borrow", holdingId: "village", operationId: "player-loan", expectedRevision: 1,
    sourceToken: bankTermsToken(data, data.holdings[0]), bankId: "merchant", offerId: "working-capital", amountCopper: 1000 };
  assert.equal((await executor(op, { userId: "player", remote: true })).receivedCopper, 990);
  assert.equal((await executor(op, { userId: "player", remote: true })).replay, true);
  assert.equal(data.holdings[0].special.banking.loans.length, 1);
  await assert.rejects(executor({ ...op, amountCopper: 2000 }, { userId: "player", remote: true }), { code: "conflict" });
  await assert.rejects(executor({ ...op, operationId: "new-stale" }, { userId: "player", remote: true }), { code: "conflict" });
  await assert.rejects(executor(op, { userId: "gm", remote: true }), { code: "forbidden" });
  const beforeRejected = JSON.stringify(data);
  await assert.rejects(executor({ ...op, operationId: "over-limit", amountCopper: 99999,
    expectedRevision: data.meta.revision, sourceToken: bankTermsToken(data, data.holdings[0]) }, { userId: "gm" }), { code: "invalid" });
  assert.equal(JSON.stringify(data), beforeRejected, "a rejected quote must leave no partial loan or debit");
  data.holdings[0].gm.playersCanUseStorage = false;
  await assert.rejects(executor({ ...op, operationId: "no-rights" }, { userId: "player", remote: true }), { code: "forbidden" });
}
{
  const data = fixture(), holding = data.holdings[0];
  data.catalog.banks = [structuredClone(BANK_PRESETS[2])];
  issueBankLoan({ data, holding, bankId: "private", offerId: "urgent", amountCopper: 100, operationId: "instant" });
  repayBankLoan({ holding, loanId: "instant", amountCopper: 100 });
  assert.equal(bankRelationship(holding, "private"), 0, "instant borrow-return cannot farm bank relationship");
}
console.log("Bank checks passed: 240-day interest, split periods, frozen terms, persistence, repayment, arrears, authority, replay and stale requests.");
await checkBankDeposits();

}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkBankCharacterization();
