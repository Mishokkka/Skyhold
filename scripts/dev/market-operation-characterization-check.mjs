import assert from "node:assert/strict";
import { createMarketOperationExecutor, resolveMarketItemDocuments } from "./fixtures/legacy-market-executor.mjs";
import { marketAuthoritySourceToken, marketPurchasePlanToken } from "../apps/market/authority-context.js";
import { createSkyholdSocketApi } from "../data/socket.js";
import { planMarketOutboundSale } from "../engines/market/outbound.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function checkMarketItemResolutionConcurrency() {
  const uuids = ["Item.a", "Item.b", "Item.c", "Item.d", "Item.e", "Item.a"];
  const lines = uuids.map((itemUuid, index) => ({
    id: `offer-${index}`,
    sourceType: "item",
    itemUuid,
    name: `Item ${index}`
  }));
  const started = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = resolveMarketItemDocuments(lines, async (uuid) => {
    started.push(uuid);
    await gate;
    return { documentName: "Item", uuid, name: uuid };
  });
  await Promise.resolve();
  await Promise.resolve();
  try {
    assert.equal(started.length, 4, "market UUID lookup must use bounded concurrency instead of a sequential chain");
  } finally {
    release();
  }
  const documents = await pending;
  assert.equal(started.length, 5, "duplicate market item UUIDs must be resolved only once");
  assert.equal(documents.size, lines.length, "every item offer must retain its own resolved document mapping");
  assert.equal(documents.get("offer-0"), documents.get("offer-5"), "offers sharing one UUID must reuse the resolved Item");
}

function initialData() {
  return {
    meta: { revision: 3 },
    catalog: { eventRegions: [], marketEconomy: {}, marketRouteMap: {}, resources: [] },
    holdings: [{
      id: "laputa",
      visibility: "public",
      gm: { playersCanUseStorage: true, calendaria: { lastQd: 0 } },
      log: [],
      storage: {
        moneyCopper: 500,
        resources: [{
          id: "sale-row",
          resourceId: "wood",
          name: "Древесина",
          qty: 4,
          batches: [{ id: "sale-batch", qty: 4, ageQd: 3 }]
        }],
        items: [],
        log: []
      },
      special: {
        market: {
          orders: [],
          stock: {},
          demand: {},
          outbound: { version: 1, orders: [], operationIds: [], updatedAt: "" }
        }
      }
    }]
  };
}

function instantPurchasePlan() {
  return {
    ok: true,
    marketId: "north-market",
    marketLabel: "Северный рынок",
    quoteKey: "quote-1",
    locationId: "north-market",
    locationText: "Северный рынок",
    targetRoomId: "outdoors",
    serviceLevel: "standard",
    carrierId: "carrier",
    carrierLabel: "Перевозчик",
    merchantProviderIds: [],
    deliveryMode: "instant",
    deliveryQd: 0,
    firstDeliveryQd: 0,
    batchCount: 1,
    totalCopper: 20,
    subtotalCopper: 16,
    deliveryCopper: 4,
    routeCopper: 4,
    taxCopper: 0,
    handlingCopper: 0,
    insuranceCopper: 0,
    totalLoad: 2,
    capacityLoad: 2,
    logistics: {},
    lines: [{
      id: "wood-offer:merchant",
      sourceOfferId: "wood-offer",
      stockOfferId: "wood-offer",
      sourceType: "resource",
      resourceId: "wood",
      name: "Древесина",
      unit: "ед.",
      qty: 2,
      unitPriceCopper: 8,
      stock: 5,
      stockBaseStock: 5,
      stockStateRevision: 0,
      providerId: "merchant"
    }]
  };
}

function outboundPlan(holding) {
  return planMarketOutboundSale({
    resources: holding.storage.resources,
    outboundState: holding.special.market.outbound,
    lines: [{
      id: "wood-sale",
      resourceId: "wood",
      demandId: "wood",
      name: "Древесина",
      qty: 1,
      unitPriceCopper: 12,
      demandBaseDemand: 5,
      demandStateRevision: 0
    }],
    routes: [{
      id: "air-route",
      ok: true,
      freightCopper: 2,
      tariffCopper: 0,
      insurancePremiumRate: 0,
      insuranceCoverageRate: 0,
      deliveryQd: 2,
      riskLossChance: 0,
      riskDelayChance: 0
    }],
    organizations: [],
    marketId: "north-market",
    marketLabel: "Северный рынок",
    countryId: "north",
    treasuryCopper: holding.storage.moneyCopper,
    insuranceEnabled: false
  });
}

function workflow() {
  return {
    _addMoney(target, amount) {
      target.storage.moneyCopper += Number(amount) || 0;
    },
    _storageAddWithOverflow(target, resource, qty) {
      const amount = Math.max(0, Math.floor(Number(qty) || 0));
      target.storage.resources.push({
        id: `arrival-${target.storage.resources.length + 1}`,
        resourceId: resource.resourceId,
        name: resource.name,
        roomId: resource.roomId,
        qty: amount,
        batches: [{ id: `arrival-batch-${target.storage.resources.length + 1}`, qty: amount, ageQd: 0 }]
      });
      return [{ roomId: resource.roomId, qty: amount }];
    },
    _snapshotItemForStorage() {
      throw new Error("Item delivery is not used by this fixture.");
    },
    _appendStorageLog(target, rows) {
      target.storage.log.push(...rows);
    }
  };
}

export async function checkMarketOperationCharacterization() {
  const previousGame = globalThis.game;
  const previousUi = globalThis.ui;
  const previousConsoleError = console.error;
  try {
    let current = initialData();
    const users = [
      { id: "player-1", name: "Player", isGM: false },
      { id: "gm-1", name: "GM", isGM: true, active: true }
    ];
    const skipToken = Symbol("skip");
    const purchasePlan = instantPurchasePlan();
    let preparedOutboundPlan = null;
    let commits = 0;
    const contextCalls = [];
    const updateHolding = async (holdingId, updater) => {
      const draft = clone(current);
      const holding = draft.holdings.find((row) => row.id === holdingId);
      if (!holding) return null;
      const result = await updater(holding, draft);
      if (result?.[skipToken]) return result.value;
      draft.meta.revision += 1;
      current = draft;
      commits += 1;
      return result;
    };
    const prepareContext = (options) => {
      contextCalls.push(options);
      return {
        market: { id: "north-market" },
        plan: purchasePlan,
        outbound: Object.keys(options.outboundQuantities ?? {}).length ? { plan: preparedOutboundPlan } : { plan: null }
      };
    };
    const executor = createMarketOperationExecutor({
      updateHolding,
      skipTransaction: (value) => ({ [skipToken]: true, value }),
      getUser: (userId) => users.find((user) => user.id === userId),
      getWorkflow: workflow,
      prepareContext,
      now: () => "2026-08-13T12:00:00.000Z"
    });

    const emitted = [];
    globalThis.ui = { notifications: { warn() {} } };
    globalThis.game = {
      user: users[0],
      users: {
        contents: users,
        get: (id) => users.find((user) => user.id === id)
      },
      socket: { emit(_channel, payload) { emitted.push(payload); } }
    };
    const api = createSkyholdSocketApi({
      getData: () => current,
      enqueueWrite: async (operation) => operation(),
      persistData: async () => {},
      notifyChanged: () => {},
      executeMarketOperation: executor
    });

    const purchaseOperation = {
      type: "purchase",
      operationId: "market-purchase-player-1",
      holdingId: "laputa",
      expectedRevision: current.meta.revision,
      sourceToken: marketAuthoritySourceToken({
        data: current,
        holding: current.holdings[0],
        marketId: "north-market",
        carrierId: "carrier"
      }),
      planToken: marketPurchasePlanToken(purchasePlan),
      marketId: "north-market",
      carrierId: "carrier",
      targetRoomId: "outdoors",
      serviceLevel: "standard",
      quantities: { "wood-offer:merchant": 2 }
    };
    const purchasePending = api.requestMarketOperation(purchaseOperation);
    const purchaseRequest = emitted.at(-1);
    assert.equal(purchaseRequest.type, "playerMarketOperationRequest", "players must use the dedicated market command protocol");
    assert.equal(purchaseRequest.expectedRevision, purchaseOperation.expectedRevision);
    assert.equal(purchaseRequest.sourceToken, purchaseOperation.sourceToken);
    assert.equal("patch" in purchaseRequest, false, "market commands must not tunnel through the generic player patch guard");

    globalThis.game.user = users[1];
    await api.handleSkyholdSocketPayload(purchaseRequest, purchaseRequest.type.endsWith("Response") ? purchaseRequest.gmId : purchaseRequest.userId);
    const purchaseResponse = emitted.at(-1);
    assert.equal(purchaseResponse.type, "playerMarketOperationResponse");
    assert.equal(purchaseResponse.ok, true, "the authority GM must recompute and atomically apply a valid player purchase");
    globalThis.game.user = users[0];
    await api.handleSkyholdSocketPayload(purchaseResponse, purchaseResponse.type.endsWith("Response") ? purchaseResponse.gmId : purchaseResponse.userId);
    const purchaseResult = await purchasePending;
    assert.equal(purchaseResult.ok, true);
    assert.equal(current.holdings[0].storage.moneyCopper, 480);
    const paymentReceipt = current.holdings[0].storage.log.filter((row) => row.resourceId === "money");
    assert.equal(paymentReceipt.length, 1, "the authority transaction must persist one purchase payment receipt");
    assert.equal(paymentReceipt[0].qty, -20);
    assert.equal(paymentReceipt[0].operationId, "market-purchase-player-1:payment");
    assert.equal(current.holdings[0].log.at(-1).type, "market-purchase");
    assert.equal(commits, 1);
    assert.equal(contextCalls.at(-1).isGM, false, "the authority GM must recompute a player quote with player-visible market inputs");

    const persistedReplayExecutor = createMarketOperationExecutor({
      updateHolding,
      skipTransaction: (value) => ({ [skipToken]: true, value }),
      getUser: (userId) => users.find((user) => user.id === userId),
      getWorkflow: workflow,
      prepareContext,
      now: () => "2026-08-13T12:00:00.000Z"
    });
    await assert.rejects(persistedReplayExecutor({ ...purchaseOperation, quantities: { "wood-offer:merchant": 999 } },
      { userId: "player-1" }), /another/, "persisted receipt must reject a changed quantity under the same operation id");
    const persistedReplay = await persistedReplayExecutor(purchaseOperation, { userId: "player-1" });
    assert.equal(persistedReplay.replay, true, "a persisted operation log must preserve replay safety after an executor restart");
    assert.equal(current.holdings[0].storage.log.filter((row) => row.operationId === "market-purchase-player-1:payment").length, 1, "persisted command retry must not duplicate the money receipt");
    assert.equal(commits, 1, "persisted replay must bypass stale revision checks without another commit");
    await assert.rejects(executor({ ...purchaseOperation, quantities: { "wood-offer:merchant": 999 } },
      { userId: "player-1", remote: true }), /another/, "in-memory replay must compare the complete intent");
    assert.equal(commits, 1, "conflicting retries must have no side effects");

    const replayPending = api.requestMarketOperation(purchaseOperation);
    const replayRequest = emitted.at(-1);
    globalThis.game.user = users[1];
    await api.handleSkyholdSocketPayload(replayRequest, replayRequest.type.endsWith("Response") ? replayRequest.gmId : replayRequest.userId);
    const replayResponse = emitted.at(-1);
    globalThis.game.user = users[0];
    await api.handleSkyholdSocketPayload(replayResponse, replayResponse.type.endsWith("Response") ? replayResponse.gmId : replayResponse.userId);
    assert.equal((await replayPending).replay, true, "a repeated market operation id must be acknowledged as a replay");
    assert.equal(current.holdings[0].storage.moneyCopper, 480, "market operation replay must never charge twice");
    assert.equal(commits, 1, "market operation replay must not create another commit");

    const staleOperation = {
      ...purchaseOperation,
      operationId: "market-purchase-stale",
      expectedRevision: current.meta.revision,
      sourceToken: marketAuthoritySourceToken({ data: current, holding: current.holdings[0], marketId: "north-market", carrierId: "carrier" }),
      planToken: "stale-plan-token"
    };
    const staleBefore = clone(current);
    const stalePending = api.requestMarketOperation(staleOperation);
    const staleAssertion = assert.rejects(stalePending, (error) => error?.code === "conflict", "a stale player quote must surface a conflict result");
    const staleRequest = emitted.at(-1);
    console.error = () => {};
    globalThis.game.user = users[1];
    await api.handleSkyholdSocketPayload(staleRequest, staleRequest.type.endsWith("Response") ? staleRequest.gmId : staleRequest.userId);
    const staleResponse = emitted.at(-1);
    globalThis.game.user = users[0];
    await api.handleSkyholdSocketPayload(staleResponse, staleResponse.type.endsWith("Response") ? staleResponse.gmId : staleResponse.userId);
    await staleAssertion;
    assert.deepEqual(clone(current), staleBefore, "stale quote rejection must not debit money or mutate stock");

    current.holdings[0].gm.playersCanUseStorage = false;
    current.meta.revision += 1;
    const forbiddenOperation = {
      ...purchaseOperation,
      operationId: "market-purchase-forbidden",
      expectedRevision: current.meta.revision,
      sourceToken: marketAuthoritySourceToken({ data: current, holding: current.holdings[0], marketId: "north-market", carrierId: "carrier" })
    };
    const forbiddenBefore = clone(current);
    const forbiddenPending = api.requestMarketOperation(forbiddenOperation);
    const forbiddenAssertion = assert.rejects(forbiddenPending, (error) => error?.code === "forbidden", "revoked storage permission must reject a player market command");
    const forbiddenRequest = emitted.at(-1);
    globalThis.game.user = users[1];
    await api.handleSkyholdSocketPayload(forbiddenRequest, forbiddenRequest.type.endsWith("Response") ? forbiddenRequest.gmId : forbiddenRequest.userId);
    const forbiddenResponse = emitted.at(-1);
    globalThis.game.user = users[0];
    await api.handleSkyholdSocketPayload(forbiddenResponse, forbiddenResponse.type.endsWith("Response") ? forbiddenResponse.gmId : forbiddenResponse.userId);
    await forbiddenAssertion;
    assert.deepEqual(clone(current), forbiddenBefore, "unauthorized market commands must not mutate the holding");

    current.holdings[0].gm.playersCanUseStorage = true;
    current.meta.revision += 1;
    preparedOutboundPlan = outboundPlan(current.holdings[0]);
    assert.equal(preparedOutboundPlan.ok, true);
    globalThis.game.user = users[1];
    const outboundOperation = {
      type: "outbound",
      operationId: "market-outbound-gm-1",
      holdingId: "laputa",
      expectedRevision: current.meta.revision,
      sourceToken: marketAuthoritySourceToken({ data: current, holding: current.holdings[0], marketId: "north-market", carrierId: "carrier" }),
      planToken: preparedOutboundPlan.planToken,
      marketId: "north-market",
      carrierId: "carrier",
      quantities: { wood: 1 },
      insuranceEnabled: false
    };
    const outboundResult = await api.requestMarketOperation(outboundOperation);
    assert.equal(outboundResult.ok, true, "a GM must use the same executor for a direct outbound booking");
    assert.equal(current.holdings[0].special.market.outbound.orders.length, 1);
    assert.equal(current.holdings[0].log.at(-1).type, "market-outbound", "market-outbound must remain a known operation type");
    assert.equal(contextCalls.at(-1).isGM, true, "the direct GM path must recompute the quote with GM market visibility");

    const forgedRemoteGmBefore = clone(current);
    await assert.rejects(
      executor({
        ...purchaseOperation,
        operationId: "market-forged-remote-gm",
        expectedRevision: current.meta.revision,
        sourceToken: marketAuthoritySourceToken({ data: current, holding: current.holdings[0], marketId: "north-market", carrierId: "carrier" })
      }, { userId: "gm-1", remote: true }),
      (error) => error?.code === "forbidden",
      "a socket caller must not claim GM authority in a remote market command"
    );
    assert.deepEqual(clone(current), forgedRemoteGmBefore, "a forged remote-GM command must not mutate market state");

    globalThis.game.user = users[0];
    globalThis.game.users.contents = [users[0]];
    const emissionsBeforeOffline = emitted.length;
    await assert.rejects(
      api.requestMarketOperation({ ...purchaseOperation, operationId: "market-no-gm" }),
      (error) => error?.code === "authority-offline" && error?.retryable === true,
      "a player market command must fail explicitly while no authority GM is active"
    );
    assert.equal(emitted.length, emissionsBeforeOffline, "no-GM failure must not emit an untargeted market command");
  } finally {
    console.error = previousConsoleError;
    if (previousGame === undefined) delete globalThis.game;
    else globalThis.game = previousGame;
    if (previousUi === undefined) delete globalThis.ui;
    else globalThis.ui = previousUi;
  }
}

await checkMarketItemResolutionConcurrency();
await checkMarketOperationCharacterization();
console.log("FBL Skyhold market authority: player/GM command, replay, stale quote, permission and no-GM fixtures passed.");
