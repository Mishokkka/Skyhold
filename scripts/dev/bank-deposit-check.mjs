import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { BANK_PRESETS, bankCatalog, validateBankCatalog } from "../data/banks.js";
import { bankTermsToken, quoteBankLoan, issueBankLoan, prepareBankingModel, loanPrincipalForNet } from "../engines/economy/banking.js";
import { quoteBankDeposit, openBankDeposit, advanceBankDeposits, quoteBankWithdrawal, withdrawBankDeposit } from "../engines/economy/bank-deposits.js";
import { createBankOperationExecutor } from "../apps/bank-operation-executor.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { prepareBankComparison, bankEditorContext } from "../apps/domains/finance/bank-context.js";
import { createEconomyHarness, makeHolding } from "./economy-characterization-check.mjs";

const fixture = () => ({ meta: { revision: 1 }, catalog: { banks: [structuredClone(BANK_PRESETS[0])] }, holdings: [mergeHoldingDefaults({ id: "village", visibility: "public", gm: { playersCanUseStorage: true }, storage: { moneyCopper: 10000 } })] });
const open = (data, offerId = "term", amountCopper = 1000) => openBankDeposit({ data, holding: data.holdings[0], bankId: "merchant", offerId, amountCopper, operationId: `deposit-${offerId}` });
export async function checkBankDeposits() {
  {
    const data = fixture(), holding = data.holdings[0];
    holding.storage.moneyCopper = 1000000000;
    const request = { data, holding, bankId: "merchant", offerId: "working-capital", amountCopper: 1000 };
    assert.equal(quoteBankLoan(request).ok, false, "Quote rejects treasury overflow before confirmation");
    const comparison = prepareBankComparison({ data, holding, model: prepareBankingModel(data, holding),
      state: { tab: "borrow", amount: 1000, days: 60 }, canTransact: true });
    assert.equal(comparison.selected.canReview, false);
    assert.match(comparison.selected.message, /размер казны/);
    holding.storage.moneyCopper = 999999010;
    assert.equal(quoteBankLoan(request).ok, true, "Net proceeds, after the fee, may exactly fill the treasury");
    issueBankLoan({ ...request, operationId: "exact-treasury-limit" });
    assert.equal(holding.storage.moneyCopper, 1000000000);
  }
  for (const rate of [0, 1, 299, 10000]) for (const days of [1, 60, 2400]) for (const amount of [1, 999, 1000000]) {
    const data = fixture(), holding = data.holdings[0];
    holding.storage.moneyCopper = amount;
    Object.assign(data.catalog.banks[0].depositOffers[1], { annualRateBps: rate, termDays: days });
    open(data, "term", amount);
    const split = structuredClone(holding), elapsed = days * 4 + 13;
    advanceBankDeposits(holding, elapsed);
    for (let left = elapsed; left > 0;) { const step = Math.min(left, left % 17 + 1); advanceBankDeposits(split, step); left -= step; }
    assert.deepEqual(split, holding, "Arbitrary period partitions conserve interest and the maturity boundary");
    const expected = Number(BigInt(amount) * BigInt(rate) * BigInt(days) / 2400000n);
    assert.equal(withdrawBankDeposit({ holding, depositId: "deposit-term", amountCopper: amount }).interestCopper, expected);
    assert.equal(holding.storage.moneyCopper, amount + expected, "Whole-term payout matches an independent day-based formula");
  }
  {
    const data = fixture(), holding = data.holdings[0];
    assert.equal(quoteBankLoan({ data, holding, bankId: "merchant", offerId: "working-capital", amountCopper: 1 }).ok, false);
    const noLoan = JSON.stringify(holding);
    assert.throws(() => issueBankLoan({ data, holding, bankId: "merchant", offerId: "working-capital", amountCopper: 1, operationId: "zero-proceeds" }));
    assert.equal(JSON.stringify(holding), noLoan, "zero-proceeds rejection cannot even create empty banking state");
    for (const net of [1, 99, 100, 1000, 9999]) for (const fee of [0, 1, 100, 333, 5000]) {
      const principal = loanPrincipalForNet(net, fee);
      assert.equal(principal - Math.ceil(principal * fee / 10000), net, "net amount includes rounded commission exactly");
    }
    const original = JSON.stringify(data);
    assert.equal(quoteBankDeposit({ data, holding, bankId: "merchant", offerId: "term", amountCopper: 10001 }).ok, false);
    assert.throws(() => open(data, "term", 0)); assert.equal(JSON.stringify(data), original);
    open(data); assert.equal(holding.storage.moneyCopper, 9000);
    const split = structuredClone(holding);
    advanceBankDeposits(holding, 280);
    for (let i = 0; i < 70; i++) advanceBankDeposits(split, 4);
    assert.deepEqual(split.special.banking, holding.special.banking, "split accrual is exact and stops at maturity");
    const deposit = holding.special.banking.deposits[0];
    assert.equal(deposit.interestCopper, 7); assert.equal(deposit.status, "matured"); assert.equal(deposit.elapsedQd, 240);
    assert.equal(holding.storage.moneyCopper, 9000, "interest stays on the contract until withdrawal");
    assert.deepEqual(mergeHoldingDefaults(holding).special.banking, holding.special.banking, "optional deposit fields survive reload");
    data.catalog.banks = []; // Closed or removed creditors must still return existing deposits.
    const result = withdrawBankDeposit({ holding, depositId: deposit.id, amountCopper: 1000, closedAt: "closed" });
    assert.equal(result.receivedCopper, 1007); assert.equal(holding.storage.moneyCopper, 10007); assert.equal(deposit.status, "closed");
    assert.throws(() => withdrawBankDeposit({ holding, depositId: deposit.id, amountCopper: 1000 }));
  }
  {
    const data = fixture(), holding = data.holdings[0]; open(data, "reserve");
    advanceBankDeposits(holding, 10000);
    const deposit = holding.special.banking.deposits[0]; assert.equal(deposit.interestCopper, 0);
    withdrawBankDeposit({ holding, depositId: deposit.id, amountCopper: 100 });
    assert.equal(deposit.principalCopper, 900); assert.equal(deposit.status, "active");
    const original = JSON.stringify(holding);
    assert.throws(() => withdrawBankDeposit({ holding, depositId: deposit.id, amountCopper: 901 }));
    assert.equal(JSON.stringify(holding), original);
    holding.storage.moneyCopper = 1000000000;
    assert.equal(quoteBankWithdrawal({ holding, depositId: deposit.id, amountCopper: 900 }).ok, false);
  }
  {
    const data = fixture(), holding = data.holdings[0]; holding.storage.moneyCopper = 100000000;
    Object.assign(data.catalog.banks[0].depositOffers[1], { annualRateBps: 10000, termDays: 2400 });
    assert.equal(quoteBankDeposit({ data, holding, bankId: "merchant", offerId: "term", amountCopper: 100000000 }).ok, false, "a whole-only withdrawal must fit even an empty treasury at maturity");
  }
  {
    const data = fixture(), holding = data.holdings[0]; open(data); advanceBankDeposits(holding, 239);
    const id = holding.special.banking.deposits[0].id;
    assert.equal(quoteBankWithdrawal({ holding, depositId: id, amountCopper: 500 }).ok, false);
    assert.equal(withdrawBankDeposit({ holding, depositId: id, amountCopper: 1000 }).receivedCopper, 1000, "early closure loses interest, never principal");
    assert.equal(holding.storage.moneyCopper, 10000);
  }
  {
    const data = fixture(), holding = data.holdings[0];
    open(data); data.catalog.banks[0].depositOffers[1].annualRateBps = 9000;
    assert.equal(holding.special.banking.deposits[0].annualRateBps, 300, "rate is fixed in the deposit contract");
    assert.equal(prepareBankingModel(data, holding).deposited.get("merchant"), 1000);
    data.catalog.banks[0].depositOffers[1].limitCopper = 1000;
    assert.equal(quoteBankDeposit({ data, holding, bankId: "merchant", offerId: "term", amountCopper: 1 }).ok, false);
    const other = structuredClone(holding); other.special.banking = {};
    assert.equal(quoteBankDeposit({ data, holding: other, bankId: "merchant", offerId: "term", amountCopper: 1000 }).ok, true, "limits belong to each holding");
    const old = fixture(); delete old.catalog.banks[0].depositOffers;
    assert.deepEqual(bankCatalog(old)[0].depositOffers, [], "opening old data does not invent new catalog products");
    const invalid = structuredClone(BANK_PRESETS); invalid[0].offers[0].annualRateBps = 25000;
    assert.ok(validateBankCatalog(invalid)); assert.equal(invalid[0].offers[0].annualRateBps, 25000, "editor rejects instead of clamping");
  }
  {
    let data = fixture(); const skipKey = Symbol(); let failWrite = false;
    const executor = createBankOperationExecutor({ getUser: (id) => ({ id, isGM: id === "gm" }), skipTransaction: (result) => ({ [skipKey]: true, result }),
      updateHolding: async (id, updater) => { const draft = structuredClone(data), result = updater(draft.holdings.find((row) => row.id === id), draft);
        if (result?.[skipKey]) return result.result;
        if (failWrite) throw new Error("write failed"); draft.meta.revision++; data = draft; return result; } });
    const op = (type, id, extra = {}) => ({ type, operationId: id, holdingId: "village", bankId: "merchant", offerId: "term", amountCopper: 1000,
      expectedRevision: data.meta.revision, sourceToken: bankTermsToken(data, data.holdings[0]), ...extra });
    const request = op("bank-deposit", "player-deposit");
    assert.equal((await executor(request, { userId: "player", remote: true })).placedCopper, 1000);
    assert.equal((await executor(request, { userId: "player", remote: true })).replay, true);
    assert.equal(data.holdings[0].storage.moneyCopper, 9000);
    await assert.rejects(executor({ ...request, operationId: "stale-deposit" }, { userId: "player", remote: true }), { code: "conflict" });
    await assert.rejects(executor(request, { userId: "gm", remote: true }), { code: "forbidden" });
    const withdraw = op("bank-withdraw", "player-withdraw", { depositId: "player-deposit" });
    assert.equal((await executor(withdraw, { userId: "player", remote: true })).receivedCopper, 1000);
    assert.equal((await executor(withdraw, { userId: "player", remote: true })).replay, true);
    assert.equal(data.holdings[0].storage.moneyCopper, 10000);
    failWrite = true; const before = JSON.stringify(data);
    await assert.rejects(executor(op("bank-deposit", "failed-write"), { userId: "gm" }), /write failed/); assert.equal(JSON.stringify(data), before);
    failWrite = false; data.holdings[0].gm.playersCanUseStorage = false;
    await assert.rejects(executor(op("bank-deposit", "not-allowed"), { userId: "player", remote: true }), { code: "forbidden" });
  }
  {
    const holding = makeHolding(); holding.storage.moneyCopper = 2000;
    const data = fixture(); data.holdings = [holding];
    openBankDeposit({ data, holding, bankId: "merchant", offerId: "term", amountCopper: 1000, operationId: "economy-deposit" });
    const before = structuredClone(holding), preview = structuredClone(holding), economy = createEconomyHarness();
    const report = await economy._runEconomyForQd(preview, 240);
    assert.deepEqual(holding, before, "offline preview works on a draft");
    assert.equal(preview.special.banking.deposits[0].status, "matured"); assert.ok(report.treasury.lines.some((line) => line.includes("по вкладу")));
    assert.equal(preview.storage.moneyCopper, 1000, "economy never spends placed money or silently returns it");
  }
  {
    const data = fixture(), holding = data.holdings[0];
    data.catalog.banks = Array.from({ length: 100 }, (_, i) => ({ ...structuredClone(BANK_PRESETS[0]), id: `bank-${i}`, offers: Array.from({ length: 20 }, (_, j) => ({ ...BANK_PRESETS[0].offers[0], id: `offer-${j}` })) }));
    const model = prepareBankingModel(data, holding), state = { tab: "borrow", amount: 1000, days: 60 };
    const comparison = prepareBankComparison({ data, holding, model, state, canTransact: true });
    assert.equal(comparison.total, 2000); assert.equal(comparison.rows.length, 10); assert.equal(comparison.selected.principal, 1011);
    assert.equal(bankEditorContext(model.banks, {}).bank.groups[0].rows.length, 20, "only the selected bank exposes editor fields");
    const withLoan = fixture(); issueBankLoan({ data: withLoan, holding: withLoan.holdings[0], bankId: "merchant", offerId: "working-capital", amountCopper: 1000, operationId: "existing-loan" });
    assert.equal(withLoan.holdings[0].special.banking.loans.length, 1);
  }
  console.log("Bank deposit checks passed: storage, maturity, early closure, frozen terms, limits, rounding, authority/replay, failed writes, economy and large catalogs.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkBankDeposits();
