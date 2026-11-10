import assert from "node:assert/strict";
import { resolveMarketItemDocuments } from "../apps/market-operation-executor.js";
import { createSkyholdSocketApi } from "../data/socket.js";
import { transportFixture, transportHarness, transportRequest } from "./fixtures/transport-v2.mjs";
import { prepareTransportContext, transportSourceToken } from "../apps/domains/transport-context.js";

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


export async function checkMarketOperationCharacterization() {
  const previousGame = globalThis.game, previousUi = globalThis.ui, previousError = console.error;
  try {
    const f = transportFixture(); f.holding.special.ships.list = [];
    const h = transportHarness(f), users = [{ id: "player", isGM: false, active: true }, { id: "gm", isGM: true, active: true }];
    const emitted = [];
    globalThis.game = { user: users[0], users: { contents: users, get: id => users.find(user => user.id === id) },
      settings: { get: () => undefined }, modules: new Map(), socket: { emit(_channel, packet) { emitted.push(packet); } } };
    globalThis.ui = { notifications: { warn() {} } }; console.error = () => {};
    const api = createSkyholdSocketApi({ getData: () => h.data, enqueueWrite: async operation => operation(),
      persistData: async () => {}, notifyChanged() {}, executeMarketOperation: h.execute });
    const request = transportRequest({ ...f, data: h.data, holding: h.holding }, "a", { insurance: false }, false);
    const quote = prepareTransportContext({ data: h.data, holding: h.holding, request, isGM: false });
    const operation = { type: "transport-book", operationId: "current-purchase-player", holdingId: h.holding.id,
      expectedRevision: h.data.meta.revision, sourceToken: quote.sourceToken, planToken: quote.planToken, request };
    async function roundTrip(op) {
      game.user = users[0];
      const pending = api.requestMarketOperation(op);
      const settled = pending.then(value => ({ value }), error => ({ error }));
      const packet = emitted.at(-1);
      game.user = users[1]; await api.handleSkyholdSocketPayload(packet, packet.userId);
      const response = emitted.at(-1);
      game.user = users[0]; await api.handleSkyholdSocketPayload(response, response.gmId);
      const result = await settled; if (result.error) throw result.error; return result.value;
    }
    const beforeMoney = h.holding.storage.moneyCopper, beforeRevision = h.data.meta.revision;
    assert.equal((await roundTrip(operation)).ok, true);
    assert.equal(h.holding.special.transportV2.orders.length, 1);
    assert.ok(h.holding.storage.moneyCopper < beforeMoney);
    assert.equal(h.data.meta.revision, beforeRevision + 1, "player writes are committed once by the authority executor");
    const committed = structuredClone(h.data);
    assert.equal((await roundTrip(operation)).replay, true);
    assert.deepEqual(h.data, committed, "socket replay cannot charge, reserve stock or commit twice");
    const current = id => ({ ...operation, operationId: id, expectedRevision: h.data.meta.revision,
      sourceToken: transportSourceToken(h.data, h.holding) });
    await assert.rejects(roundTrip({ ...current("stale-plan"), planToken: "stale" }), error => error.code === "conflict");
    assert.deepEqual(h.data, committed, "a stale quote cannot change stock, funds or saved orders");
    h.holding.gm.playersCanUseStorage = false; h.data.meta.revision++;
    const revoked = structuredClone(h.data);
    await assert.rejects(roundTrip(current("permission-revoked")), error => error.code === "forbidden");
    assert.deepEqual(h.data, revoked, "revoked storage permission is enforced by the real transport handler");
    h.holding.gm.playersCanUseStorage = true;
    game.user = users[1];
    const gmRequest = transportRequest({ ...f, data: h.data, holding: h.holding }, "a", { insurance: false });
    const gmQuote = prepareTransportContext({ data: h.data, holding: h.holding, request: gmRequest, isGM: true });
    assert.equal((await api.requestMarketOperation({ ...current("current-purchase-gm"), request: gmRequest, planToken: gmQuote.planToken })).ok, true);
    assert.equal(h.holding.special.transportV2.orders.length, 2, "the same command route also supports direct GM booking");
    game.user = users[0]; game.users.contents = [users[0]];
    const emissions = emitted.length;
    await assert.rejects(api.requestMarketOperation(current("no-authority")), error => error.code === "authority-offline" && error.retryable === true);
    assert.equal(emitted.length, emissions, "an offline authority cannot cause an untargeted write request");
  } finally { globalThis.game = previousGame; globalThis.ui = previousUi; console.error = previousError; }
}
await checkMarketItemResolutionConcurrency();
await checkMarketOperationCharacterization();
console.log("Current market authority: real transport handler, GM/player socket routing, durable replay, stale refusal, revoked permission, offline authority and bounded Item resolution passed.");
