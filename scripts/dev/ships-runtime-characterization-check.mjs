import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createShipRecord } from "../data/ships.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { quoteShipDeparture, departShip, advanceShipVoyages } from "../engines/ships/runtime.js";
import { createShipOperationExecutor } from "../apps/ship-operation-executor.js";
import { createSkyholdSocketApi } from "../data/socket.js";
import { holdingPermissionContext } from "../data/holding-permissions.js";
import { buildTendayChangeSet } from "../engines/tenday/change-set.js";
import { buildTendayOperationPayload, hydrateTendayOperation } from "../engines/tenday/operation-payload.js";
import { applyPreparedTenday, tendayDependencySnapshot } from "../apps/domains/events/tenday-preview.js";
import { FinanceEconomyDomain } from "../apps/domains/finance/economy-domain.js";
import { checkShipViewStateCharacterization } from "./ships-view-state-characterization-check.mjs";
import { shipOperationIntent } from "../apps/domains/events/ship-events.js";

export async function checkShipRuntimeCharacterization() {
checkShipViewStateCharacterization();

function fixture() {
  const ship = createShipRecord("ship");
  ship.routePlan = { destination: "Port", distanceKm: 150, portDays: 1, upkeepPerDayCopper: 10, preparationCopper: 20, rewardCopper: 150 };
  return { meta: { revision: 1 }, holdings: [mergeHoldingDefaults({ id: "holding", storage: { moneyCopper: 1000 }, gm: { playersCanManageShips: true }, special: { ships: { list: [ship] } } })] };
}
const intentHolding = { id: "holding" };
const intentShip = { id: "ship" };
const offerScope = { dataset: { shipOffer: "offer-1" }, querySelector: (selector) => ({ value: selector === "[data-ship-style]" ? "bold" : "2.22" }) };
const manualScope = { querySelector: () => ({ value: "1.11" }) };
const intentCard = { dataset: { shipVoyage: "rendered-voyage" }, querySelector: () => ({ value: "999" }) };
assert.deepEqual(shipOperationIntent({
  type: "depart", holding: intentHolding, ship: intentShip, card: intentCard,
  button: { closest: (selector) => selector === "[data-ship-offer]" ? offerScope : null }
}), { type: "depart", holdingId: "holding", shipId: "ship", budgetCopper: 222, offerId: "offer-1", style: "bold" });
assert.deepEqual(shipOperationIntent({
  type: "depart", holding: intentHolding, ship: intentShip, card: intentCard,
  button: { closest: (selector) => selector === "[data-ship-manual]" ? manualScope : null }
}), { type: "depart", holdingId: "holding", shipId: "ship", budgetCopper: 111, offerId: "", style: "normal" });
assert.equal(shipOperationIntent({ type: "resolve", holding: intentHolding, ship: intentShip, card: intentCard, button: { closest: () => null } }).voyageId, "rendered-voyage");
const gm = { id: "gm", isGM: true, active: true };
const player = { id: "player", isGM: false, active: true };
let data = fixture();
let commits = 0;
let queue = Promise.resolve();
const skipToken = Symbol("skip");
const execute = createShipOperationExecutor({
  getUser: (id) => [gm, player].find((user) => user.id === id),
  skip: (value) => ({ [skipToken]: true, value }),
  updateHolding: (id, updater) => {
    const job = queue.then(async () => {
      const draft = structuredClone(data);
      const holding = draft.holdings.find((row) => row.id === id);
      if (!holding) return null;
      const result = await updater(holding, draft);
      if (result?.[skipToken]) return result.value;
      draft.meta.revision++;
      data = draft;
      commits++;
      return result;
    });
    queue = job.catch(() => {});
    return job;
  }
});
const op = { type: "depart", operationId: "trip", holdingId: "holding", shipId: "ship", expectedRevision: 1, budgetCopper: 300 };
const quote = quoteShipDeparture(data.holdings[0].special.ships.list[0]);
assert.equal(quote.durationQd, 12);
assert.equal(quote.operatingCopper, 30);
await assert.rejects(execute({ ...op, budgetCopper: 29 }, { userId: gm.id }), /недостаточно/);
assert.equal(commits, 0);
data.holdings[0].gm.playersCanManageShips = false;
await assert.rejects(execute(op, { userId: player.id, remote: true }), /Нет права/);
data.holdings[0].gm.playersCanManageShips = true;
await assert.rejects(execute(op, { userId: gm.id, remote: true }), /отправитель/);
await assert.rejects(execute({ ...op, expectedRevision: 0 }, { userId: gm.id }), /изменились/);
const [first, repeat] = await Promise.all([execute(op, { userId: player.id, remote: true }), execute(op, { userId: player.id, remote: true })]);
assert.equal(first.ok, true);
assert.equal(repeat.replay, true);
assert.equal(commits, 1);
assert.equal(data.holdings[0].storage.moneyCopper, 680);
assert.equal(data.holdings[0].special.ships.list[0].onboardCopper, 270);
await assert.rejects(execute({ ...op, budgetCopper: 301 }, { userId: player.id, remote: true }), /ID/);
await assert.rejects(execute({ ...op, operationId: "twice", expectedRevision: 2 }, { userId: gm.id }), /занят/);
const adjustment = { type: "adjust", operationId: "repair", holdingId: "holding", shipId: "ship", voyageId: "trip", expectedRevision: 2, kind: "expense", amountCopper: 80, reason: "Repair" };
await assert.rejects(execute(adjustment, { userId: player.id, remote: true }), /Нет права/);
await assert.rejects(execute({ ...adjustment, amountCopper: 271 }, { userId: gm.id }), /Insufficient/);
await execute(adjustment, { userId: gm.id });
assert.equal(data.holdings[0].special.ships.list[0].onboardCopper, 190);
const before = structuredClone(data.holdings[0]);
const projected = structuredClone(before);
assert.equal(advanceShipVoyages(projected, 4).underway.length, 1);
assert.equal(projected.special.ships.list[0].activeVoyage.remainingQd, 8);
assert.equal(advanceShipVoyages(projected, 4).returned.length, 0);
// Later edits must not change an accepted contract.
projected.special.ships.list[0].routePlan.rewardCopper = 999999;
const returned = advanceShipVoyages(projected, 40);
assert.equal(returned.returned.length, 1);
assert.equal(projected.storage.moneyCopper, 1020); // 1000 - 20 - 30 - 80 + 150.
assert.equal(projected.special.ships.history[0].returnedCopper, 340);
assert.equal(projected.special.ships.history[0].netCopper, 20);
assert.equal(projected.special.ships.history[0].returnedAtQd, 12);
assert.equal(advanceShipVoyages(projected, 80).returned.length, 0);
assert.equal(projected.storage.moneyCopper, 1020);
assert.equal(before.storage.moneyCopper, 680); // Preview did not write source.
const changeSet = buildTendayChangeSet(before, projected);
assert.equal(changeSet.ships.length, 1);
const payload = buildTendayOperationPayload({ changeSet, qd: 40 });
assert.equal(hydrateTendayOperation({ operationId: "period", payload }).changeSet.ships.length, 1);
const hash = (value) => JSON.stringify(value);
const stale = structuredClone(before);
stale.special.ships.list[0].onboardCopper++;
assert.equal(applyPreparedTenday(stale, projected, hash(before), { hash, clone: structuredClone }).ok, false);
assert.equal(applyPreparedTenday(before, projected, hash(before), { hash, clone: structuredClone }).ok, true);
assert.equal(tendayDependencySnapshot(data, "holding").holding.special.ships.list.length, 1);
const long = fixture().holdings[0];
long.special.ships.list[0].routePlan.distanceKm = 3000;
departShip(long, long.special.ships.list[0], { operationId: "long", budgetCopper: 500, clockQd: 0 });
const batch = structuredClone(long);
advanceShipVoyages(long, 40); advanceShipVoyages(long, 80); advanceShipVoyages(long, 200);
advanceShipVoyages(batch, 200);
assert.deepEqual(long, batch);

// Generated offers are authority-owned, period-bounded, immutable at departure,
// and contract outcomes are rolled only after an authorized transaction begins.
let offerData = fixture();
let offerCommits = 0;
let offerQueue = Promise.resolve();
let randomDraws = 0;
const offerExecute = createShipOperationExecutor({
  getUser: (id) => [gm, player].find((user) => user.id === id),
  random: () => { randomDraws++; return 0; },
  skip: (value) => ({ [skipToken]: true, value }),
  updateHolding: (id, updater) => {
    const job = offerQueue.then(async () => {
      const draft = structuredClone(offerData);
      const holding = draft.holdings.find((row) => row.id === id);
      if (!holding) return null;
      const result = await updater(holding, draft);
      if (result?.[skipToken]) return result.value;
      draft.meta.revision++;
      offerData = draft;
      offerCommits++;
      return result;
    });
    offerQueue = job.catch(() => {});
    return job;
  }
});
const generate = { type: "generate", operationId: "offers-0", holdingId: "holding", expectedRevision: 1 };
await assert.rejects(offerExecute(generate, { userId: player.id, remote: true }), /Нет права/);
assert.equal(randomDraws, 0);
assert.equal(offerCommits, 0);
const generated = await offerExecute(generate, { userId: gm.id });
assert.equal(generated.offerCount, 4);
assert.equal(offerData.holdings[0].special.ships.offerPeriod, 0);
assert.equal(offerCommits, 1);
const drawsAfterGeneration = randomDraws;
assert.equal((await offerExecute(generate, { userId: gm.id })).replay, true);
assert.equal(randomDraws, drawsAfterGeneration);
await assert.rejects(offerExecute({ ...generate, operationId: "reroll-0", expectedRevision: 2 }, { userId: gm.id }), /уже подготовлены/);
assert.equal(randomDraws, drawsAfterGeneration);
offerData.holdings[0].special.ships.offerPeriod = 2;
offerData.holdings[0].gm.calendaria.lastQd = 40;
await assert.rejects(offerExecute({ ...generate, operationId: "rollback-reroll", expectedRevision: 2 }, { userId: gm.id }), /уже подготовлены/);
offerData.holdings[0].special.ships.offerPeriod = 0;
offerData.holdings[0].gm.calendaria.lastQd = 0;

const storedOffer = structuredClone(offerData.holdings[0].special.ships.offers[0]);
const contractDepart = {
  type: "depart", operationId: "contract-trip", holdingId: "holding", shipId: "ship", expectedRevision: 2,
  budgetCopper: storedOffer.guidance.minimumBudgetCopper, offerId: storedOffer.id, style: "normal",
  rewardCopper: 999999999, offer: { ...storedOffer, rewardCopper: 999999999 }
};
await offerExecute(contractDepart, { userId: player.id, remote: true });
const contractShip = offerData.holdings[0].special.ships.list[0];
assert.equal(contractShip.activeVoyage.quote.contract.rewardCopper, storedOffer.rewardCopper);
assert.equal(offerData.holdings[0].special.ships.offers[0].consumedBy, "contract-trip");
assert.equal(contractShip.onboardCopper, 0);
assert.equal(offerCommits, 2);
const beforeContractArrival = structuredClone(offerData.holdings[0]);
advanceShipVoyages(offerData.holdings[0], 40);
assert.equal(contractShip.activeVoyage.awaitingOutcome, true);
assert.ok(buildTendayChangeSet(beforeContractArrival, offerData.holdings[0]).ships[0].changes.some((row) => row.key === "awaitingOutcome"));
const resolve = { type: "resolve", operationId: "resolve-contract", holdingId: "holding", shipId: "ship", voyageId: "contract-trip", expectedRevision: 3 };
offerData.holdings[0].gm.playersCanManageShips = false;
const drawsBeforeUnauthorizedResolve = randomDraws;
await assert.rejects(offerExecute(resolve, { userId: player.id, remote: true }), /Нет права/);
assert.equal(randomDraws, drawsBeforeUnauthorizedResolve);
offerData.holdings[0].gm.playersCanManageShips = true;
const pending = await offerExecute(resolve, { userId: player.id, remote: true });
assert.equal(pending.waitingFunds, true);
assert.equal(randomDraws, drawsBeforeUnauthorizedResolve + 3);
const retainedOutcome = structuredClone(offerData.holdings[0].special.ships.list[0].activeVoyage.outcome);
const beforeAttention = structuredClone(offerData.holdings[0]);
const topUp = {
  type: "adjust", operationId: "contract-top-up", holdingId: "holding", shipId: "ship", voyageId: "contract-trip",
  expectedRevision: 4, kind: "income", amountCopper: retainedOutcome.expenseCopper, reason: "Резерв Элины"
};
await offerExecute(topUp, { userId: gm.id });
const completed = await offerExecute({ ...resolve, operationId: "continue-contract", expectedRevision: 5 }, { userId: player.id, remote: true });
assert.equal(completed.waitingFunds, false);
assert.equal(randomDraws, drawsBeforeUnauthorizedResolve + 3);
assert.deepEqual(completed.outcome, retainedOutcome);
assert.equal(completed.delayQd, 8);
assert.equal(offerData.holdings[0].special.ships.list[0].status, "away");
assert.equal(offerData.holdings[0].special.ships.list[0].activeVoyage.awaitingOutcome, false);
assert.equal(offerData.holdings[0].special.ships.list[0].activeVoyage.remainingQd, 8);
advanceShipVoyages(offerData.holdings[0], 48);
assert.equal(offerData.holdings[0].special.ships.list[0].status, "docked");
assert.ok(buildTendayChangeSet(beforeAttention, offerData.holdings[0]).ships[0].changes.some((row) => row.key.startsWith("attention:")));
assert.equal(offerData.holdings[0].special.ships.history.at(-1).contract.id, storedOffer.id);
assert.equal(offerData.holdings[0].special.ships.history.at(-1).attention.after, 3);
await assert.rejects(offerExecute({ ...contractDepart, operationId: "reuse-consumed", expectedRevision: 6 }, { userId: player.id, remote: true }), /устарело или уже использовано/);
offerData.holdings[0].gm.calendaria.lastQd = 40;
const unconsumedOldOffer = offerData.holdings[0].special.ships.offers[1];
await assert.rejects(offerExecute({ ...contractDepart, operationId: "use-stale", expectedRevision: 6, offerId: unconsumedOldOffer.id }, { userId: player.id, remote: true }), /устарело или уже использовано/);
const refreshDraws = randomDraws;
const refreshed = await offerExecute({ ...generate, operationId: "offers-1", expectedRevision: 6 }, { userId: gm.id });
assert.equal(refreshed.period, 1);
assert.equal(refreshed.offerCount, 4);
assert.ok(randomDraws > refreshDraws);
await assert.rejects(offerExecute({ ...generate, operationId: "reroll-1", expectedRevision: 7 }, { userId: gm.id }), /уже подготовлены/);

const noRouteData = fixture();
noRouteData.holdings[0].special.ships.list[0].routePlan.destination = "";
let noRouteCommits = 0;
const noRouteExecute = createShipOperationExecutor({
  getUser: () => gm,
  random: () => { throw new Error("random must not be called"); },
  skip: (value) => value,
  updateHolding: async (_id, updater) => {
    const draft = structuredClone(noRouteData);
    const result = await updater(draft.holdings[0], draft);
    noRouteCommits++;
    return result;
  }
});
await assert.rejects(noRouteExecute(generate, { userId: gm.id }), /Нет готовых кораблей/);
assert.equal(noRouteCommits, 0);
assert.equal(noRouteData.holdings[0].special.ships.offerPeriod, null);

// Test the real economy entry point up to the financing boundary.
const boundary = fixture().holdings[0];
departShip(boundary, boundary.special.ships.list[0], { operationId: "boundary", budgetCopper: 300, clockQd: 0 });
const reachedFinance = new Error("finance-boundary");
const owner = {
  _safeNumber: (value) => value, _periodLabel: () => "Period",
  _advanceMarketShipmentsForQd() {}, _advanceMarketOutboundForQd() {},
  _prepareFinanceForQd(holding, _qd, report) {
    assert.equal(holding.storage.moneyCopper, 1100);
    assert.equal(holding.special.ships.list[0].status, "docked");
    assert.equal(report.ledger[0].qty, 420);
    assert.equal(report.ledger[0].meta.internalTransfer, true);
    throw reachedFinance;
  }
};
await assert.rejects(FinanceEconomyDomain._runEconomyForQd.call(owner, boundary, 40), (error) => error === reachedFinance);

const awaitingBoundary = fixture().holdings[0];
const awaitingShip = awaitingBoundary.special.ships.list[0];
awaitingShip.status = "away";
awaitingShip.activeVoyage = { id: "awaiting", awaitingOutcome: true, waitingFunds: true, lastProcessedQd: 0, outcome: { expenseCopper: 70 } };
const awaitingOwner = {
  _safeNumber: (value) => value, _periodLabel: () => "Period",
  _advanceMarketShipmentsForQd() {}, _advanceMarketOutboundForQd() {},
  _prepareFinanceForQd(_holding, _qd, report) {
    assert.ok(report.work.some((row) => row.includes("исход рейса сохранён") && row.includes("70 ММ")));
    throw reachedFinance;
  }
};
await assert.rejects(FinanceEconomyDomain._runEconomyForQd.call(awaitingOwner, awaitingBoundary, 40), (error) => error === reachedFinance);

// Real transport dispatcher: unchanged ID across timeout and authority switch.
const savedGame = globalThis.game;
const savedSetTimeout = globalThis.setTimeout;
const savedClearTimeout = globalThis.clearTimeout;
try {
  const emitted = [];
  const timers = [];
  const gm2 = { id: "gm2", isGM: true, active: true };
  const users = { contents: [gm, gm2, player], get: (id) => [gm, gm2, player].find((user) => user.id === id) };
  globalThis.game = { user: player, users, socket: { emit: (_channel, value) => emitted.push(value) } };
  globalThis.setTimeout = (callback) => { timers.push(callback); return timers.length; };
  globalThis.clearTimeout = () => {};
  const api = createSkyholdSocketApi({ getData: () => data, executeShipOperation: execute });
  data = fixture(); commits = 0;
  const requested = api.requestShipOperation(op);
  assert.equal(emitted[0].targetGmId, gm.id);
  gm.active = false;
  timers[0]();
  assert.equal(emitted[1].targetGmId, gm2.id);
  assert.deepEqual(emitted[0].operation, emitted[1].operation);
  globalThis.game.user = gm2;
  await api.handleSkyholdSocketPayload(emitted[1], emitted[1].type.endsWith("Response") ? emitted[1].gmId : emitted[1].userId);
  const response = emitted.at(-1);
  assert.equal(response.ok, true);
  globalThis.game.user = player;
  await api.handleSkyholdSocketPayload(response, response.type.endsWith("Response") ? response.gmId : response.userId);
  assert.equal((await requested).ok, true);
  assert.equal(commits, 1);
  gm.active = true;
  const allowed = holdingPermissionContext(data.holdings[0]);
  assert.equal(allowed.canManageShips, true);
  assert.equal(allowed.canEditSpecial, false);
  globalThis.game.socket = null;
  assert.equal(holdingPermissionContext(data.holdings[0]).canManageShips, false);
  await assert.rejects(api.requestShipOperation({ ...op, operationId: "offline" }), /Socket/);
} finally {
  gm.active = true;
  globalThis.game = savedGame;
  globalThis.setTimeout = savedSetTimeout;
  globalThis.clearTimeout = savedClearTimeout;
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkShipRuntimeCharacterization();
  console.log("Ship runtime passed: transactions, permissions, replay, treasury, period projection, history and authority retry.");
}
