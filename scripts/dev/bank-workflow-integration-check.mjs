import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { SkyholdData } from "../data/store.js";
import { BANK_PRESETS } from "../data/banks.js";
import { bankTermsToken } from "../engines/economy/banking.js";
import { openBankDeposit } from "../engines/economy/bank-deposits.js";
import { createBankOperationExecutor } from "../apps/bank-operation-executor.js";
import { SkyholdWorkflowService } from "../workflows/skyhold-workflow-service.js";
import { makeHolding } from "./economy-characterization-check.mjs";
import { createSkyholdSocketApi } from "../data/socket.js";

/** Real prepare/apply orchestration with an isolated transactional store. */
export async function checkBankWorkflowIntegration() {
  const previous = { game: globalThis.game, ui: globalThis.ui, view: SkyholdData.view, updateHolding: SkyholdData.updateHolding, skipTransaction: SkyholdData.skipTransaction };
  try {
    globalThis.game = { user: { id: "gm", isGM: true }, users: [], settings: { get() {} }, modules: new Map(), i18n: { localize: (text) => text } };
    globalThis.ui = { notifications: { warn() {}, info() {} } };
    let data;
    const reset = () => {
      const holding = makeHolding(); holding.storage.moneyCopper = 10000;
      data = { meta: { revision: 1 }, catalog: { banks: structuredClone(BANK_PRESETS) }, holdings: [holding] };
      return holding;
    };
    const skip = Symbol();
    SkyholdData.view = () => data;
    SkyholdData.skipTransaction = (result) => ({ [skip]: true, result });
    SkyholdData.updateHolding = async (id, updater) => {
      const draft = structuredClone(data), result = await updater(draft.holdings.find((row) => row.id === id), draft);
      if (result?.[skip]) return result.result;
      draft.meta.revision++; data = draft; return result;
    };
    const workflow = new SkyholdWorkflowService();
    workflow._postTendaySummaryChat = async () => {}; workflow.requestRender = () => {};
    const execute = createBankOperationExecutor({ getUser: () => game.user });
    let holding = reset();
    openBankDeposit({ data, holding, bankId: "merchant", offerId: "term", amountCopper: 1000, operationId: "integrated-term" });
    const original = structuredClone(data);
    const oldOperation = { type: "bank-withdraw", operationId: "after-tenday", holdingId: holding.id, depositId: "integrated-term", amountCopper: 1000,
      expectedRevision: data.meta.revision, sourceToken: bankTermsToken(data, holding) };
    const prepared = await workflow._prepareTendayOperation({ holdingId: holding.id, qd: 240, operationId: "integrated-tenday" });
    assert.equal(prepared.ok, true); assert.deepEqual(data, original, "actual tenday preview is read-only");
    assert.equal(prepared.preparedHolding.special.banking.deposits[0].interestCopper, 7);
    assert.equal((await workflow._applyPreparedTendayOperation(prepared)).ok, true);
    await assert.rejects(execute(oldOperation, { userId: "gm" }), { code: "conflict" });
    const currentOperation = { ...oldOperation, expectedRevision: data.meta.revision, sourceToken: bankTermsToken(data, data.holdings[0]) };
    assert.equal((await execute(currentOperation, { userId: "gm" })).receivedCopper, 1007);
    assert.equal((await execute(currentOperation, { userId: "gm" })).replay, true);
    assert.equal((await workflow._applyPreparedTendayOperation(prepared)).replay, true);
    assert.equal(data.holdings[0].storage.moneyCopper, 10007, "replaying either workflow cannot duplicate interest or principal");
    holding = reset();
    openBankDeposit({ data, holding, bankId: "merchant", offerId: "term", amountCopper: 1000, operationId: "before-preview" });
    const stale = await workflow._prepareTendayOperation({ holdingId: holding.id, qd: 40, operationId: "stale-tenday" });
    openBankDeposit({ data, holding, bankId: "merchant", offerId: "reserve", amountCopper: 100, operationId: "after-preview" }); data.meta.revision++;
    assert.equal((await workflow._applyPreparedTendayOperation(stale)).stale, true);
    assert.equal(data.holdings[0].special.banking.deposits.length, 2, "a stale tenday cannot erase a newer bank contract");

    // The same four commands must round-trip through the real player socket API.
    holding = reset(); holding.visibility = "public"; holding.gm.playersCanUseStorage = true;
    const player = { id: "player", isGM: false, active: true }, gm = { id: "gm", isGM: true, active: true }, messages = [];
    const users = { contents: [player, gm], get: (id) => users.contents.find((user) => user.id === id) };
    game.users = users; game.socket = { emit: (_channel, payload) => messages.push(payload) };
    const remoteExecutor = createBankOperationExecutor({ getUser: (id) => users.get(id) });
    const socket = createSkyholdSocketApi({ getData: () => data, executeMarketOperation: remoteExecutor });
    const send = async (operation, duplicate = false) => {
      game.user = player;
      const pending = socket.requestMarketOperation({ ...operation, holdingId: holding.id,
        expectedRevision: data.meta.revision, sourceToken: bankTermsToken(data, data.holdings[0]) });
      const request = messages.at(-1);
      assert.equal(request.type, "playerMarketOperationRequest"); assert.equal(request.targetGmId, gm.id);
      game.user = gm;
      await socket.handleSkyholdSocketPayload(request, player.id);
      if (duplicate) await socket.handleSkyholdSocketPayload(request, player.id);
      const response = messages.at(-1);
      assert.equal(response.ok, true); assert.equal("data" in response, false);
      game.user = player; await socket.handleSkyholdSocketPayload(response, gm.id);
      return pending;
    };
    const deposit = await send({ type: "bank-deposit", operationId: "socket-deposit", bankId: "merchant", offerId: "reserve", amountCopper: 1000 }, true);
    assert.equal(deposit.replay, true); assert.equal(data.holdings[0].special.banking.deposits.length, 1);
    assert.equal(data.holdings[0].storage.moneyCopper, 9000, "a repeated authority request debits the deposit once");
    assert.equal((await send({ type: "bank-withdraw", operationId: "socket-withdraw", depositId: deposit.depositId, amountCopper: 300 })).receivedCopper, 300);
    const loan = await send({ type: "bank-borrow", operationId: "socket-borrow", bankId: "merchant", offerId: "working-capital", amountCopper: 1000 });
    assert.equal(loan.receivedCopper, 990);
    assert.equal((await send({ type: "bank-repay", operationId: "socket-repay", loanId: loan.loanId, amountCopper: 500 })).balanceCopper, 500);
    assert.equal(data.holdings[0].storage.moneyCopper, 9790);
    assert.equal(data.holdings[0].special.banking.deposits[0].principalCopper, 700);
  } finally {
    if (previous.game === undefined) delete globalThis.game; else globalThis.game = previous.game;
    if (previous.ui === undefined) delete globalThis.ui; else globalThis.ui = previous.ui;
    SkyholdData.view = previous.view; SkyholdData.updateHolding = previous.updateHolding; SkyholdData.skipTransaction = previous.skipTransaction;
  }
  console.log("Bank workflow integration passed: actual tenday preview/apply, maturity/conflicts/replay and all four GM/player socket commands.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkBankWorkflowIntegration();
