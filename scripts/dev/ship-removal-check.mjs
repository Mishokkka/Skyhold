import assert from "node:assert/strict";
import { createShipRecord } from "../data/ships.js";
import { createShipOperationExecutor } from "../apps/ship-operation-executor.js";
import { shipOperationIntent, ShipEventActions } from "../apps/domains/events/ship-events.js";
import { prepareShipWindowContext } from "../apps/ships-context.js";

const ship = { ...createShipRecord("ship"), crewResidentIds: ["sailor"] };
const initial = {
  meta: { revision: 1 }, catalog: {}, holdings: [{
    id: "home", visibility: "public", gm: { playersCanManageShips: true, calendaria: { lastQd: 4 } },
    storage: { moneyCopper: 500 }, operations: [],
    people: { list: [
      { id: "sailor", name: "Матрос", workAssignment: "farm", actorUuid: "Actor.keep", shipAssignment: { shipId: "ship", away: false } },
      { id: "other", shipAssignment: { shipId: "other", away: true } }
    ] },
    buildings: { list: [{ id: "farm", assignedWorkerIds: ["sailor"] }] },
    special: { ships: { list: [ship, createShipRecord("other")],
      offers: [{ id: "offer", shipId: "ship" }, { id: "other-offer", shipId: "other" }],
      worldOfferLocks: { one: { shipId: "ship" }, two: { shipId: "other" } },
      history: [{ id: "completed", shipId: "ship" }]
    } }
  }]
};
let data = structuredClone(initial);
let commits = 0;
const skipToken = Symbol("skip");
const execute = createShipOperationExecutor({
  getUser: (id) => ({ id, isGM: id === "gm" }),
  skip: (result) => ({ [skipToken]: true, result }),
  updateHolding: async (id, updater) => {
    const draft = structuredClone(data);
    const result = await updater(draft.holdings.find((row) => row.id === id), draft);
    if (result?.[skipToken]) return result.result;
    draft.meta.revision++;
    data = draft;
    commits++;
    return result;
  }
});
const operation = { type: "delete", holdingId: "home", shipId: "ship", operationId: "delete-ship", expectedRevision: 1 };
assert.deepEqual(shipOperationIntent({ type: "delete", holding: initial.holdings[0], ship, button: { closest: () => null } }), {
  type: "delete", holdingId: "home", shipId: "ship"
});
assert.equal(ShipEventActions.click["ship-delete"], "_onShipOperation");
assert.ok(!ShipEventActions.publicClick.includes("ship-delete"));
await assert.rejects(execute(operation, { userId: "player", remote: true }), /Нет права/);
await assert.rejects(execute({ ...operation, expectedRevision: 0 }, { userId: "gm" }), /Данные изменились/);
for (const patch of [
  { activeVoyage: { id: "voyage" } }, { status: "away" }, { onboardCopper: 1 },
  { pendingPortBillCopper: 10 }, { currentOuting: { id: "outing" } },
  { navigationMode: "world", location: { kind: "market" } },
  { portBilling: { sinceQd: 0, dailyCopper: 12, chargedCopper: 0, carriedCopper: 0 } }
]) {
  data = structuredClone(initial);
  Object.assign(data.holdings[0].special.ships.list[0], patch);
  const before = JSON.stringify(data);
  await assert.rejects(execute(operation, { userId: "gm" }), (error) => error.code === "conflict");
  assert.equal(JSON.stringify(data), before, "failed deletion must be atomic");
}
data = structuredClone(initial);
data.holdings[0].people.list[0].shipAssignment.away = true;
await assert.rejects(execute(operation, { userId: "gm" }), /экипаж/);
assert.equal(commits, 0);

for (const world of [false, true]) {
  data = structuredClone(initial);
  if (world) Object.assign(data.holdings[0].special.ships.list[0], { navigationMode: "world", location: { kind: "home", id: "home" } });
  const result = await execute(operation, { userId: "gm" });
  assert.equal(result.deleted, true);
  const holding = data.holdings[0];
  assert.deepEqual(holding.special.ships.list.map((row) => row.id), ["other"]);
  assert.deepEqual(holding.special.ships.offers.map((row) => row.id), ["other-offer"]);
  assert.deepEqual(holding.special.ships.worldOfferLocks, { two: { shipId: "other" } });
  assert.deepEqual(holding.special.ships.history, initial.holdings[0].special.ships.history);
  assert.equal(holding.storage.moneyCopper, 500);
  assert.deepEqual(holding.buildings, initial.holdings[0].buildings);
  const expectedPeople = structuredClone(initial.holdings[0].people);
  delete expectedPeople.list[0].shipAssignment;
  assert.deepEqual(holding.people, expectedPeople, "residents, Actors, jobs and other ship assignments are preserved");
  const beforeReplay = JSON.stringify(data);
  assert.equal((await execute(operation, { userId: "gm" })).replay, true);
  assert.equal(JSON.stringify(data), beforeReplay);
  await assert.rejects(execute({ ...operation, shipId: "other" }, { userId: "gm" }), /ID уже использован/);
}
globalThis.game = { user: { isGM: true } };
const context = prepareShipWindowContext(initial.holdings[0], { data: initial, shipId: initial.holdings[0].special.ships.list[0].id });
assert.equal(context.rows[0].canDelete, true);
console.log("Ship removal: GM authority, guards, atomicity, replay, crew/jobs/history and legacy/world ships passed.");
