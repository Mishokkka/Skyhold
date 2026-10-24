import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createSkyholdSocketApi } from "../data/socket.js";
import { createGmWriteAuthority } from "../data/gm-write-authority.js";

export async function checkSocketPendingCharacterization() {
  const previous = { game: globalThis.game, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const timers = new Map();
  let timerId = 0;
  try {
    globalThis.setTimeout = (callback) => { const id = ++timerId; timers.set(id, callback); return id; };
    globalThis.clearTimeout = (id) => timers.delete(id);
    const emitted = [];
    const socket = { emit: (_channel, payload) => emitted.push(payload) };
    globalThis.game = { user: { id: "player", isGM: false }, socket,
      users: { contents: [{ id: "player", isGM: false, active: true }, { id: "gm", isGM: true, active: true }] } };
    const api = createSkyholdSocketApi({ getData: () => ({ meta: { revision: 0 }, holdings: [] }) });
    const acknowledge = async (request, gmId = "gm") => api.handleSkyholdSocketPayload({
      type: request.type.replace(/Request$/, "Response"), requestId: request.requestId,
      operationId: request.requestId, userId: "player", gmId, ok: true,
      result: { ok: true, operationId: request.requestId }
    }, gmId);
    const runNextTimer = () => {
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      callback();
    };

    for (const method of ["requestStorageOperation", "requestMarketOperation", "requestConstructionOperation"]) {
      const operation = { operationId: `pending-${method}`, expectedRevision: 0 };
      const original = api[method](operation);
      const request = emitted.at(-1);
      const emissionCount = emitted.length;
      let duplicateError;
      api[method](operation).catch((error) => { duplicateError = error; });
      await Promise.resolve();
      assert.equal(duplicateError?.code, "conflict", `${method}: a repeated in-flight ID must reject without replacing its original waiter`);
      assert.equal(emitted.length, emissionCount, `${method}: a duplicate invocation must not emit another request`);
      await acknowledge(request);
      assert.equal((await original).ok, true, `${method}: the original caller must receive its acknowledgement`);
      assert.equal(timers.size, 0, `${method}: settled requests must leave no retry timer`);

      // A retry can fail after the first emission, for example when socket access
      // disappears on reconnection. Its timer callback must reject, not throw.
      const retryOperation = { ...operation, operationId: `retry-${method}` };
      let retryError;
      const retry = api[method](retryOperation).catch((error) => { retryError = error; });
      const timer = timers.entries().next().value;
      timers.delete(timer[0]);
      game.socket = { emit() { throw new Error("transport disconnected"); } };
      assert.doesNotThrow(() => timer[1](), `${method}: a retry transport failure must not escape the timer`);
      await retry;
      assert.equal(retryError?.code, "socket-unavailable");
      assert.equal(timers.size, 0);
      game.socket = socket;
      const recovered = api[method](retryOperation);
      await acknowledge(emitted.at(-1));
      assert.equal((await recovered).ok, true, `${method}: transport failure must release the pending ID`);

      const metadata = { operationId: `failover-${method}`, expectedRevision: 7, sourceToken: "source-before-retry" };
      const failover = api[method](metadata);
      const firstAuthorityRequest = emitted.at(-1);
      const firstGm = game.users.contents.find((user) => user.id === "gm");
      firstGm.active = false;
      game.users.contents.push({ id: "next-gm", isGM: true, active: true });
      runNextTimer();
      const retriedRequest = emitted.at(-1);
      assert.equal(retriedRequest.targetGmId, "next-gm", `${method}: retry must select the new authority`);
      assert.deepEqual(retriedRequest.operation, metadata, `${method}: failover must preserve operation metadata`);
      assert.equal(retriedRequest.requestId, firstAuthorityRequest.requestId);
      if (method !== "requestStorageOperation") assert.equal(retriedRequest.expectedRevision, 7);
      if (method === "requestMarketOperation") assert.equal(retriedRequest.sourceToken, metadata.sourceToken);
      await acknowledge(firstAuthorityRequest);
      assert.equal((await failover).ok, true, `${method}: a late acknowledgement from the first tried GM must still settle the caller`);
      firstGm.active = true;
      game.users.contents.pop();
      assert.equal(timers.size, 0);

      const expiredOperation = { operationId: `timeout-${method}`, expectedRevision: 0 };
      const timedOut = assert.rejects(api[method](expiredOperation), (error) => {
        assert.match(error.message, /timed out/);
        assert.equal(error.code, method === "requestStorageOperation" ? undefined : "timeout", "retain the existing storage Error versus command-result contract");
        return true;
      });
      const beforeRetry = emitted.length;
      runNextTimer();
      runNextTimer();
      await timedOut;
      assert.equal(emitted.length, beforeRetry + 1, `${method}: timeout allows exactly one retry`);
      assert.equal(timers.size, 0);
      const afterTimeout = api[method](expiredOperation);
      await acknowledge(emitted.at(-1));
      assert.equal((await afterTimeout).ok, true, `${method}: timeout must release the pending ID`);

      const lostAuthority = assert.rejects(api[method]({ operationId: `offline-${method}` }), (error) => {
        assert.match(error.message, /No active GM/);
        assert.equal(error.code, method === "requestStorageOperation" ? undefined : "authority-offline");
        return true;
      });
      firstGm.active = false;
      runNextTimer();
      await lostAuthority;
      firstGm.active = true;
      assert.equal(timers.size, 0, `${method}: losing authority must release the pending request`);
    }

    game.user = { id: "gm-secondary", isGM: true };
    const gmAuthority = createGmWriteAuthority({ authority: () => ({ id: "gm", isGM: true }) });
    let commitError;
    const commit = gmAuthority.requestCommit({ meta: { revision: 1 }, holdings: [], catalog: {} }, { baseRevision: 0 })
      .catch((error) => { commitError = error; });
    const commitTimer = timers.entries().next().value;
    timers.delete(commitTimer[0]);
    game.socket = { emit() { throw new Error("transport disconnected"); } };
    assert.doesNotThrow(() => commitTimer[1](), "a secondary GM commit retry must reject rather than escape its timer");
    await commit;
    assert.equal(commitError?.code, "socket-unavailable");
    assert.equal(timers.size, 0);
  } finally {
    if (previous.game === undefined) delete globalThis.game;
    else globalThis.game = previous.game;
    globalThis.setTimeout = previous.setTimeout;
    globalThis.clearTimeout = previous.clearTimeout;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkSocketPendingCharacterization();
  console.log("FBL Skyhold socket pending characterization passed.");
}
