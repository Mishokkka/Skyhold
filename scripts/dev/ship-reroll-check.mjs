import assert from "node:assert/strict";
import { createShipOperationExecutor } from "../apps/ship-operation-executor.js";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";

let { data } = worldMarketFixture();
data.holdings[0].gm.playersCanManageShips = true;
data.holdings[0].visibility = "public";
let commits = 0, draws = 0;
const skipToken = Symbol("skip");
const execute = createShipOperationExecutor({
  getUser: (id) => ({ id, isGM: id === "gm" }), random: () => { draws += 1; return 0.4; },
  skip: (value) => ({ [skipToken]: true, value }),
  updateHolding: async (_id, updater) => {
    const draft = structuredClone(data);
    const result = await updater(draft.holdings[0], draft);
    if (result?.[skipToken]) return result.value;
    draft.meta.revision += 1; data = draft; commits += 1; return result;
  }
});
const base = { holdingId: "holding", shipId: "magnifique", locationKind: "home", locationId: "holding" };
await execute({ ...base, type: "generate-world", operationId: "original", expectedRevision: 1 }, { userId: "gm" });
const reroll = { ...base, type: "reroll-world", operationId: "r".repeat(128), expectedRevision: 2 };
await assert.rejects(execute(reroll, { userId: "player", remote: true }), /Нет права/);
await assert.rejects(execute({ ...reroll, locationId: "wrong" }, { userId: "gm" }), /другом месте/);
const board = data.holdings[0].special.ships;
const oldIds = board.offers.map((row) => row.id);
board.offers[0].consumedBy = "old-voyage";
const consumed = structuredClone(board.offers[0]);
const otherShip = { ...structuredClone(board.offers[1]), id: "other-ship-offer", shipId: "other" };
const otherPort = { ...structuredClone(board.offers[1]), id: "other-port-offer", from: { kind: "market", id: "a" } };
board.offers.push(otherShip, otherPort);
const beforeCash = data.holdings[0].storage.moneyCopper;
await execute(reroll, { userId: "gm" });
const offers = data.holdings[0].special.ships.offers;
assert.deepEqual(offers.find((row) => row.id === consumed.id), consumed);
assert.deepEqual(offers.find((row) => row.id === otherShip.id), otherShip);
assert.deepEqual(offers.find((row) => row.id === otherPort.id), otherPort);
assert.ok(oldIds.slice(1).every((id) => !offers.some((row) => row.id === id)), "the previous open board is replaced");
assert.ok(offers.every((row) => row.id.length <= 128));
assert.equal(data.holdings[0].storage.moneyCopper, beforeCash);
const rollsBeforeReplay = draws;
assert.equal((await execute(reroll, { userId: "gm" })).replay, true);
assert.equal(draws, rollsBeforeReplay);
assert.equal(commits, 2);
data.holdings[0].special.ships.list[0].activeVoyage = { id: "in-progress" };
const activeSnapshot = JSON.stringify(data);
await assert.rejects(execute({ ...reroll, operationId: "active-reroll", expectedRevision: 3 }, { userId: "gm" }), /стоянке/);
assert.equal(JSON.stringify(data), activeSnapshot, "active contracts and their offers cannot be changed by reroll");
let quietData = worldMarketFixture().data;
const quietExecute = createShipOperationExecutor({
  getUser: () => ({ id: "gm", isGM: true }), random: () => 0,
  skip: (value) => ({ [skipToken]: true, value }),
  updateHolding: async (_id, updater) => {
    const draft = structuredClone(quietData);
    const result = await updater(draft.holdings[0], draft);
    if (result?.[skipToken]) return result.value;
    draft.meta.revision += 1; quietData = draft; return result;
  }
});
const quietOperation = { ...base, type: "generate-world", operationId: "quiet-period", expectedRevision: 1 };
const quietResult = await quietExecute(quietOperation, { userId: "gm" });
assert.equal(quietResult.offerCount, 0, "a quiet period commits as a valid market result");
assert.equal(quietData.holdings[0].special.ships.offers.length, 0);
assert.ok(Object.keys(quietData.holdings[0].special.ships.worldOfferLocks).length > 0,
  "the empty board is locked for the current port and period");
assert.equal((await quietExecute(quietOperation, { userId: "gm" })).replay, true);
await assert.rejects(quietExecute({ ...quietOperation, operationId: "free-second-look", expectedRevision: 2 }, { userId: "gm" }),
  /уже подготовлены/, "an empty board cannot be redrawn for free in the same period");
console.log("FBL Skyhold ship GM reroll check passed.");
