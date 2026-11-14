import assert from "node:assert/strict";
import { transportFixture } from "./fixtures/transport-v2.mjs";
import { planTransportChain } from "../engines/transport/planner.js";
import { bookTransportOrder, canCancelTransportOrder } from "../engines/transport/runtime.js";
import { startTransportShip } from "../workflows/transport/orders.js";
import { transportSourceToken } from "../apps/domains/transport-context.js";
import { createTransportOperationExecutor } from "../apps/transport-operation-executor.js";
import { SkyholdWorkflowService } from "../workflows/skyhold-workflow-service.js";
import { SkyholdData } from "../data/store.js";
import { normalizeSkyholdData, normalizeHoldingsPartition } from "../data/normalizers.js";

globalThis.game = { user: { id: "gm", isGM: true }, users: [{ id: "gm", isGM: true, active: true }],
  settings: { get: () => undefined }, modules: new Map(), time: { worldTime: 0 } };
globalThis.foundry = { utils: { deepClone: structuredClone } };
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };

function harness(initial) {
  let stored = structuredClone(initial), sequence = 0;
  const token = Symbol("skip"), skip = value => ({ [token]: true, value });
  const transaction = async updater => {
    const draft = structuredClone(stored), result = await updater(draft, { skip });
    if (result?.[token]) return result.value;
    draft.meta.revision++; stored = draft; return result;
  };
  SkyholdData.view = () => stored; SkyholdData.skipTransaction = skip;
  SkyholdData.updateHolding = (id, updater) => transaction(draft => updater(draft.holdings.find(row => row.id === id), draft));
  const workflow = new SkyholdWorkflowService();
  workflow._postTendaySummaryChat = async () => {}; workflow.requestRender = () => {};
  const execute = createTransportOperationExecutor({ transaction, workflow: () => workflow, getUser: id => ({ id, isGM: id === "gm" }) });
  return { get data() { return stored; }, holding: id => stored.holdings.find(row => row.id === (id ?? stored.holdings[0].id)), workflow, execute,
    reload() { stored = normalizeSkyholdData(JSON.parse(JSON.stringify(stored))); },
    async prepare(qd = 40, holdingId = stored.holdings[0].id) {
      const before = structuredClone(stored);
      const prepared = await workflow._prepareTendayOperation({ holdingId, qd, dataView: stored,
        operationId: `tenday-transport-${++sequence}`, pendingEventsCollected: true });
      assert.deepEqual(stored, before, "projection never writes world data");
      return prepared;
    },
    decision(prepared, resolution = { outcome: "success" }) {
      return { type: "transport-incident", operationId: `tenday-decision-${++sequence}`, holdingId: prepared.holdingId,
        expectedRevision: prepared.dataRevision, sourceToken: transportSourceToken(stored, this.holding(prepared.holdingId)),
        reviewQd: prepared.qd, runId: (prepared.transportReview.find(row => row.canResolve) ?? prepared.transportReview[0]).runId, resolution };
    },
    async decide(prepared, resolution = { outcome: "success" }) {
      const op = this.decision(prepared, resolution);
      const result = await execute(op, { userId: "gm" }), after = structuredClone(stored);
      assert.equal(result.ok, true); assert.equal((await execute(op, { userId: "gm" })).replay, true);
      assert.deepEqual(stored, after, "repeating a decision does not move cargo or money");
      return op;
    },
    async apply(prepared) {
      assert.equal(prepared.ok, true, prepared.message);
      assert.equal((await workflow._applyPreparedTendayOperation(prepared)).ok, true);
      const after = structuredClone(stored);
      assert.equal((await workflow._applyPreparedTendayOperation(prepared)).replay, true);
      assert.deepEqual(stored, after);
    }
  };
}

const feeder = { id: "tenday-feeder", kind: "regular", from: "home", to: "a", capacity: 40000,
  firstQd: 1, intervalQd: 40, travelQd: 3, loadingQd: 0, unloadingQd: 0, dispatchCopper: 1, riskBps: 10000 };
function food({ own = false, lifetime = 20, connection = null, reserve = 1000 } = {}) {
  const f = transportFixture(); if (!own) f.holding.special.ships.list = [];
  f.holding.people.list = []; f.ship.name = "Tenday ship"; f.ship.crewResidentIds = []; f.ship.crewTarget = 0;
  f.data.catalog.resources.push({ id: "tenday-food", label: "Food", basePriceCopper: 5, loadPoints: 4, shelfLifeQd: lifetime });
  f.holding.storage.resources = [{ id: "food-stock", resourceId: "tenday-food", roomId: "outdoors", qty: 10, forSale: true,
    batches: [{ id: "food-batch", qty: 10, ageQd: 0 }] }];
  const cargo = [{ lotId: "food-lot", rowId: "food-stock", batchId: "food-batch", resourceId: "tenday-food", name: "Food",
    qty: 10, unitLoad: 4000, unitCopper: 5, ageQd: 0, ageAtQd: 0, shelfLifeQd: lifetime }];
  const first = { ...feeder };
  if (own) Object.assign(first, { kind: "owned", shipId: f.ship.id, vehicles: 1, returnQd: 4, endReturnQd: 4,
    endReturnLocation: "home", returnAtEnd: true, operatingCopperPerQd: 10, returnOperatingCopperPerQd: 10, idleUpkeepCopperPerDay: 40 });
  const services = connection ? [first, connection] : [first];
  const order = bookTransportOrder({ state: f.data.meta.transportV2, holding: f.holding,
    plan: planTransportChain({ cargo, services }), services, id: "tenday-food", direction: "outbound", ship: own ? f.ship : null,
    commercial: { marketId: "a", marketLabel: "Test market", reserveCopper: own ? reserve : 0 } });
  order.demandReservations = []; if (own) startTransportShip(f.data, f.holding, order);
  return f;
}

{
  const f = food(), h = harness(f.data), before = structuredClone(h.holding());
  const review = await h.prepare();
  assert.equal(review.ok, false); assert.equal(review.transportReview[0].atQd, 4); assert.equal(review.transportReview[0].canResolve, true);
  assert.equal((await h.workflow._applyPreparedTendayOperation(review)).ok, false);
  await h.decide(review);
  assert.equal(h.holding().gm.calendaria.lastQd, 0); assert.equal(h.data.meta.transportV2.clockQd, 0);
  assert.deepEqual(h.holding().storage, before.storage, "decision freezes an outcome without spending or dispatching");
  assert.deepEqual(h.holding().special.transportV2.orders[0].money, before.special.transportV2.orders[0].money);
  assert.equal(h.holding().special.transportV2.orders[0].stages[0].receipts.length, 0);
  const prepared = await h.prepare();
  assert.equal(prepared.preparedHolding.special.transportV2.orders[0].received[0].qty, 10);
  assert.equal(prepared.preparedHolding.special.transportV2.orders[0].stages[0].receipts[0].arrivalQd, 4);
  assert.equal(prepared.preparedHolding.storage.moneyCopper - before.storage.moneyCopper, 50);
  assert.ok(prepared.changeSet.shipments.some(row => row.id === "transport:tenday-food" && row.changes.some(change => change.key === "received")));
  await h.apply(prepared);
  assert.ok(h.holding().log.find(row => row.operationId === prepared.operationId).payload.changes.shipments.rows.length,
    "the saved schema-3 report retains the new shipment details");
  const historical = structuredClone(prepared);
  historical.preparedHolding.special.transportV2.orders[0].status = "needsResolution";
  assert.equal((await h.workflow._applyPreparedTendayOperation(historical)).replay, true,
    "an already committed operation is acknowledged before rejecting an old pending-incident snapshot");
  historical.operationId = "uncommitted-old-pending";
  const beforeOld = structuredClone(h.data);
  assert.equal((await h.workflow._applyPreparedTendayOperation(historical)).stale, true);
  assert.deepEqual(h.data, beforeOld, "an uncommitted old snapshot cannot bypass the incident review");
}
for (const secondRisk of [0, 10000]) {
  const connection = { ...feeder, id: "tenday-connection", from: "a", to: "b", firstQd: 4, intervalQd: 10, travelQd: 2, riskBps: secondRisk };
  const h = harness(food({ connection, lifetime: 100 }).data);
  await h.decide(await h.prepare(), { outcome: "delay", delayQd: 4 });
  let next = await h.prepare();
  if (secondRisk) {
    assert.equal(next.transportReview[0].atQd, 16, "new physical departure after the missed connection is reviewed");
    const id = next.transportReview[0].runId;
    assert.ok(!h.data.meta.transportV2.runs.some(run => run.id === id), "this run has not yet been reserved in live data");
    await h.decide(next);
    assert.ok(h.data.meta.transportV2.runs.some(run => run.id === id && run.incident.status === "resolved"));
    next = await h.prepare();
  }
  assert.equal(next.preparedHolding.special.transportV2.orders[0].received[0].qty, 10);
  assert.equal(next.preparedHolding.special.transportV2.orders[0].stages[1].receipts[0].arrivalQd, 16);
  await h.apply(next);
}
{
  const h = harness(food({ own: true }).data);
  const quote = h.holding().special.transportV2.orders[0].plan.ownExpensesCopper;
  await h.decide(await h.prepare());
  const prepared = await h.prepare(), order = prepared.preparedHolding.special.transportV2.orders[0];
  assert.equal(order.ownedActualCopper, quote); assert.equal(order.received[0].qty, 10);
  assert.equal(prepared.preparedHolding.special.ships.list[0].lastOuting.completedAtQd, 8);
  await h.apply(prepared);
}
{
  const f = food(), right = structuredClone(f.holding); right.id = "right-holding"; right.name = "Right";
  f.holding.special.transportV2.orders = []; right.special.transportV2.orders = [];
  f.data.holdings.push(right); f.data.meta.transportV2.runs = [];
  const shared = { ...feeder, id: "shared-tenday", from: "a", to: "b", firstQd: 12, travelQd: 4, capacity: 10 };
  for (const holding of f.data.holdings) {
    const first = { ...feeder, id: `feeder-${holding.id}`, capacity: 10 };
    bookTransportOrder({ state: f.data.meta.transportV2, holding, services: [first, shared],
      plan: planTransportChain({ cargo: [{ lotId: "lot", resourceId: "wood", qty: 1, unitLoad: 1, unitCopper: 1 }],
        services: [first, shared], runs: f.data.meta.transportV2.runs }), id: `order-${holding.id}`, direction: "inbound",
      commercial: { targetRoomId: "outdoors" } });
  }
  const h = harness(f.data), leftId = f.holding.id;
  await h.decide(await h.prepare(40, leftId));
  const blocked = await h.prepare(40, leftId), beforeBlocked = structuredClone(h.data);
  assert.equal(blocked.transportReview[0].canResolve, false);
  assert.equal(blocked.transportReview[0].blockers[0].holdingId, right.id);
  await assert.rejects(h.decide(blocked, { outcome: "loss", lossBps: 5000 }), /предыдущие участки/);
  assert.deepEqual(h.data, beforeBlocked, "unknown related cargo cannot be allocated a premature physical loss");
  await h.decide(await h.prepare(40, right.id));
  const joint = await h.prepare(40, leftId);
  assert.equal(joint.transportReview[0].runId, "shared-tenday:regular:12");
  assert.equal(joint.transportReview[0].canLose, true, "both feeder manifests are forecast without either household Apply");
  await h.decide(joint, { outcome: "loss", lossBps: 5000 });
  assert.equal(h.holding(right.id).gm.calendaria.lastQd, 0);
  await h.apply(await h.prepare(40, leftId));
  await h.apply(await h.prepare(40, right.id));
  assert.equal(h.data.holdings.flatMap(row => row.special.transportV2.orders).reduce((sum, order) => sum + order.lostQty, 0), 1);
  assert.equal(h.data.holdings.flatMap(row => row.special.transportV2.orders).flatMap(order => order.received).reduce((sum, lot) => sum + lot.qty, 0), 1);
}

{
  const h = harness(food().data), review = await h.prepare(), invalid = h.decision(review, { outcome: "delay", delayQd: -1 });
  const before = structuredClone(h.data);
  await assert.rejects(h.execute(invalid, { userId: "gm" }), /задержка/);
  assert.deepEqual(h.data, before, "invalid decisions do not partly rebook a shipment");
  const player = h.decision(review);
  await assert.rejects(h.execute(player, { userId: "player", remote: true }), /ГМ/);
  assert.deepEqual(h.data, before, "players cannot publish decisions through the existing command route");
  const stale = h.decision(review);
  h.data.meta.revision++;
  const changed = structuredClone(h.data);
  await assert.rejects(h.execute(stale, { userId: "gm" }), /Данные изменились/);
  assert.deepEqual(h.data, changed);
  await h.decide(await h.prepare());
  const frozen = structuredClone(h.data.meta.transportV2);
  h.reload();
  assert.deepEqual(h.data.meta.transportV2, frozen, "accepted future outcome survives normalization");
  const prepared = await h.prepare();
  assert.equal(prepared.preparedHolding.special.transportV2.orders[0].received[0].qty, 10);
  await h.apply(prepared);
}
{
  const h = harness(food({ lifetime: 1000 }).data);
  await h.decide(await h.prepare(), { outcome: "delay", delayQd: 40 });
  const first = await h.prepare();
  assert.equal(first.preparedHolding.special.transportV2.orders[0].received.length, 0);
  assert.equal(first.preparedHolding.special.transportV2.orders[0].status, "travelling");
  await h.apply(first);
  const second = await h.prepare();
  assert.equal(second.preparedHolding.special.transportV2.orders[0].stages[0].receipts[0].arrivalQd, 44);
  assert.equal(second.preparedHolding.special.transportV2.orders[0].received[0].qty, 10);
  await h.apply(second);
}
async function splitTendays(batch) {
  const f = food({ lifetime: 1000 }), state = f.data.meta.transportV2, order = f.holding.special.transportV2.orders[0];
  // Two successive physical departures, one in each tenday.
  for (const lot of order.cargo) lot.qty = 20;
  f.holding.storage.resources[0].qty = 20; f.holding.storage.resources[0].batches[0].qty = 20;
  f.holding.special.transportV2.orders = []; state.runs = [];
  bookTransportOrder({ state, holding: f.holding, services: [feeder], plan: planTransportChain({ cargo: order.cargo, services: [feeder] }),
    id: "batch-food", direction: "outbound", commercial: { marketId: "a", marketLabel: "a" } }).demandReservations = [];
  const h = harness(f.data);
  for (let period = 0; period < (batch ? 1 : 2); period++) {
    let prepared = await h.prepare(batch ? 80 : 40);
    while (prepared.transportReview) {
      assert.equal(prepared.qd, batch ? 80 : 40);
      await h.decide(prepared); prepared = await h.prepare(batch ? 80 : 40);
    }
    await h.apply(prepared);
    if (!batch && period === 0) {
      assert.equal(h.holding().storage.resources.find(row => row.id === "food-stock")?.resourceId, "tenday-food",
        "closing the period preserves catalog identity for the remaining outbound lot");
    }
  }
  const final = h.holding().special.transportV2.orders[0];
  return { clock: h.holding().gm.calendaria.lastQd, cash: h.holding().storage.moneyCopper,
    received: final.received, money: final.money, spoiled: final.spoiledQty, lost: final.lostQty };
}
assert.deepEqual(await splitTendays(true), await splitTendays(false), "a sequential batch and two separately reviewed tendays agree");

{
  const f = food({ lifetime: 1000 });
  f.data.holdings[0] = normalizeHoldingsPartition([
    { ...f.holding, people: { list: [{ id: "consumer", name: "Consumer", age: 30 }] } }
  ], f.data.catalog)[0];
  f.holding = f.data.holdings[0];
  f.data.catalog.resources.push({ id: "bread", label: "Bread", foodReady: true, shelfLifeQd: 120, loadPoints: 4, basePriceCopper: 5 });
  const supplies = { ...feeder, id: "tenday-supplies", from: "a", to: "home", capacity: 80000 };
  const cargo = ["bread", "wood"].map(id => ({ lotId: id, resourceId: id, name: id, qty: 10, unitLoad: 4000, unitCopper: 5,
    ageQd: 0, shelfLifeQd: id === "bread" ? 120 : 0 }));
  bookTransportOrder({ state: f.data.meta.transportV2, holding: f.holding, services: [supplies],
    plan: planTransportChain({ cargo, services: [supplies], runs: f.data.meta.transportV2.runs }), id: "period-supplies",
    direction: "inbound", commercial: { targetRoomId: "outdoors" } });
  const h = harness(f.data), finance = h.workflow._prepareFinanceForQd, production = h.workflow._runProductionAndLivestockForQd;
  let financeCash = 0, productionWood = 0;
  h.workflow._prepareFinanceForQd = function(holding, ...args) { financeCash = holding.storage.moneyCopper; return finance.call(this, holding, ...args); };
  h.workflow._runProductionAndLivestockForQd = function(holding, ...args) {
    productionWood = holding.storage.resources.filter(row => row.resourceId === "wood").reduce((sum, row) => sum + row.qty, 0);
    return production.call(this, holding, ...args);
  };
  const cash = h.holding().storage.moneyCopper;
  let prepared = await h.prepare();
  while (prepared.transportReview) { await h.decide(prepared); prepared = await h.prepare(); }
  assert.equal(financeCash, cash + 50, "the successful sale is available before household financing");
  assert.equal(productionWood, 10, "incoming raw materials are available to the actual production phase");
  assert.equal(prepared.report.food.eaten, 10, "arriving bread feeds this tenday, including an incident resolved before Apply");
  assert.equal(prepared.report.food.hungryResidentDays, 0);
  await h.apply(prepared);
}
{
  const f = food({ lifetime: 100 }), prior = f.holding.special.transportV2.orders[0];
  f.holding.special.transportV2.orders = []; f.holding.special.transportV2.clockOffsetQd = 360;
  f.data.meta.transportV2.runs = []; f.data.meta.transportV2.clockQd = 360;
  const shifted = { ...feeder, firstQd: 361 };
  bookTransportOrder({ state: f.data.meta.transportV2, holding: f.holding, services: [shifted],
    plan: planTransportChain({ cargo: prior.cargo.map(lot => ({ ...lot, ageAtQd: 360 })), services: [shifted], startQd: 360 }),
    id: "offset-food", direction: "outbound", clockOffsetQd: 360, commercial: { marketId: "a", marketLabel: "a" } }).demandReservations = [];
  const h = harness(f.data), review = await h.prepare();
  assert.equal(review.transportReview[0].atQd, 364); assert.equal(review.transportReview[0].localQd, 4);
  await h.decide(review); const prepared = await h.prepare();
  assert.equal(prepared.preparedHolding.special.transportV2.orders[0].stages[0].receipts[0].arrivalQd, 364);
  assert.equal(prepared.preparedHolding.special.transportV2.orders[0].received[0].ageQd, 4, "calendar offset never ages food");
  await h.apply(prepared); assert.equal(h.holding().gm.calendaria.lastQd, 40);
}
{
  const f = food({ lifetime: 1000 }), prior = f.holding.special.transportV2.orders[0];
  f.holding.special.ships.list = [f.ship]; f.holding.special.transportV2.orders = []; f.data.meta.transportV2.runs = [];
  f.data.catalog.eventRegions.push({ value: "c", label: "C", marketTransportModes: ["airship"], marketLinks: [] });
  const own = { ...feeder, id: "rebook-own-first", kind: "owned", shipId: f.ship.id, from: "a", to: "b", firstQd: 0,
    approachQd: 2, approachCopper: 2, returnQd: 4, endReturnQd: 4, endReturnLocation: "home", returnAtEnd: true, operatingCopperPerQd: 10 };
  const services = [feeder, own, { ...own, id: "rebook-own-next", from: "b", to: "c", approachQd: 0, riskBps: 0 }];
  const order = bookTransportOrder({ state: f.data.meta.transportV2, holding: f.holding, services,
    plan: planTransportChain({ cargo: prior.cargo, services }), id: "rebook-owned-block", ship: f.ship, direction: "outbound",
    commercial: { reserveCopper: 1000, marketId: "a" } });
  order.demandReservations = []; startTransportShip(f.data, f.holding, order);
  const h = harness(f.data);
  await h.decide(await h.prepare(), { outcome: "delay", delayQd: 8 });
  const ownReview = await h.prepare(); assert.equal(ownReview.transportReview[0].atQd, 15);
  await h.decide(ownReview);
  const prepared = await h.prepare(), result = prepared.preparedHolding.special.transportV2.orders[0];
  assert.equal(result.status, "delivered", "later owned reservations cannot block an adopted earlier shuttle");
  assert.equal(result.stages[1].runs[0].startQd, 12); assert.equal(result.stages[2].runs[0].startQd, 15);
  assert.equal(prepared.preparedHolding.special.ships.list[0].lastOuting.completedAtQd, 22);
  await h.apply(prepared);
}
{
  const f = food(), holding = f.holding;
  holding.special.transportV2.orders = []; f.data.meta.transportV2.runs = [];
  const shared = { ...feeder, id: "causal-shared", from: "a", to: "b", firstQd: 12, travelQd: 4, capacity: 10 };
  const book = (id, services) => bookTransportOrder({ state: f.data.meta.transportV2, holding, services,
    plan: planTransportChain({ cargo: [{ lotId: id, resourceId: "wood", qty: 1, unitLoad: 1, unitCopper: 1 }], services, runs: f.data.meta.transportV2.runs }),
    id, direction: "inbound", commercial: { targetRoomId: "outdoors" } });
  book("direct", [shared]);
  book("connecting", [{ ...feeder, id: "causal-root", to: "x", capacity: 10 },
    { ...feeder, id: "causal-feeder", from: "x", to: "a", firstQd: 5, intervalQd: 1, capacity: 10 }, shared]);
  const h = harness(f.data);
  await h.decide(await h.prepare(), { outcome: "delay", delayQd: 12 });
  const next = await h.prepare();
  assert.equal(next.transportReview[0].atQd, 16); assert.equal(next.transportReview[0].canResolve, false);
  assert.ok(next.transportReview.find(row => row.canResolve)?.atQd > 16,
    "a blocked earlier shared manifest must allow its later incoming dependency to be resolved");
  await h.decide(next);
  const sharedReview = await h.prepare(); assert.equal(sharedReview.transportReview[0].canResolve, true);
  await h.decide(sharedReview);
  const prepared = await h.prepare();
  assert.equal(prepared.preparedHolding.special.transportV2.orders.find(row => row.id === "direct").received[0].qty, 1);
  await h.apply(prepared);
}
{
  const h = harness(food({ own: true, reserve: 0 }).data);
  await h.decide(await h.prepare(), { outcome: "delay", delayQd: 4 });
  const prepared = await h.prepare(), order = prepared.preparedHolding.special.transportV2.orders[0];
  assert.equal(order.fundingNeededCopper, 40);
  assert.ok(prepared.warnings.some(row => row.key === "transport-funding:tenday-food"));
  assert.equal(prepared.preparedHolding.special.ships.list[0].location.kind, "home", "unpaid adjustment does not prevent physical return");
  await h.apply(prepared);
  assert.ok(h.holding().log.find(row => row.operationId === prepared.operationId).payload.warnings.some(row => row.key === "transport-funding:tenday-food"));
}
{
  const connection = { ...feeder, id: "busy-connection", from: "a", to: "b", firstQd: 4, intervalQd: 10, travelQd: 2, riskBps: 0 };
  const f = food({ connection, lifetime: 1000 }), other = structuredClone(f.holding);
  other.id = "busy-other"; other.special.transportV2.orders = []; f.data.holdings.push(other);
  const blockerService = { ...connection, firstQd: 14 }, cargo = [{ lotId: "blocker", qty: 1430, unitLoad: 4000, unitCopper: 1 }];
  bookTransportOrder({ state: f.data.meta.transportV2, holding: other, services: [blockerService],
    plan: planTransportChain({ cargo, services: [blockerService], runs: f.data.meta.transportV2.runs }), id: "busy-blocker", direction: "inbound" });
  const h = harness(f.data); await h.decide(await h.prepare(), { outcome: "delay", delayQd: 4 });
  const prepared = await h.prepare();
  assert.equal(prepared.preparedHolding.special.transportV2.orders[0].status, "waitingCarrier");
  assert.ok(prepared.warnings.some(row => row.key === "transport-wait:tenday-food"));
  await h.apply(prepared);
}
{
  const connection = { ...feeder, id: "cancel-reviewed-connection", from: "a", to: "b", firstQd: 4, intervalQd: 10, travelQd: 2 };
  const f = food({ connection, lifetime: 100 });
  const order = f.holding.special.transportV2.orders[0];
  order.stages[0].service.riskBps = 0; order.stages[0].runs[0].riskBps = 0; f.data.meta.transportV2.runs[0].riskBps = 0;
  const h = harness(f.data);
  assert.equal(canCancelTransportOrder(h.data.meta.transportV2, h.holding().special.transportV2.orders[0]), true);
  assert.equal(canCancelTransportOrder(null, h.holding().special.transportV2.orders[0]), false);
  assert.equal(canCancelTransportOrder({}, h.holding().special.transportV2.orders[0]), false);
  const review = await h.prepare(); assert.equal(review.transportReview[0].atQd, 6);
  await h.decide(review);
  assert.equal(canCancelTransportOrder(h.data.meta.transportV2, h.holding().special.transportV2.orders[0]), false,
    "a recorded later-stage event cannot be erased by cancelling the still-unprocessed first stage");
  await h.apply(await h.prepare());
}
{
  const f = food({ lifetime: 1000 }), prior = f.holding.special.transportV2.orders[0];
  f.holding.special.transportV2.orders = []; f.data.meta.transportV2.runs = [];
  const later = { ...feeder, firstQd: 81 };
  bookTransportOrder({ state: f.data.meta.transportV2, holding: f.holding, services: [later],
    plan: planTransportChain({ cargo: prior.cargo, services: [later] }), id: "future-shared", direction: "outbound",
    commercial: { marketId: "a", marketLabel: "a" } }).demandReservations = [];
  // A different consumer may already have exposed this shared physical event;
  // the lagging holding must still be able to prepare its earlier tendays.
  const physical = f.data.meta.transportV2.runs[0];
  physical.status = "travelling"; physical.incident = { status: "pending", atQd: 84 };
  f.data.meta.transportV2.clockQd = 120;
  const h = harness(f.data);
  await h.apply(await h.prepare()); assert.equal(h.holding().gm.calendaria.lastQd, 40);
  await h.apply(await h.prepare()); assert.equal(h.holding().gm.calendaria.lastQd, 80);
  const review = await h.prepare(); assert.equal(review.transportReview[0].atQd, 84);
  await h.decide(review); const prepared = await h.prepare();
  assert.equal(prepared.preparedHolding.special.transportV2.orders[0].stages[0].receipts[0].arrivalQd, 84);
  await h.apply(prepared);
}
// A warehouse expiry is already a stock movement; the later transport receipt
// accounts for that spoiled promise without claiming a second warehouse dispatch.
{
  const f = transportFixture(); f.holding.people.list = []; f.holding.special.ships.list = [];
  f.holding.storage.resources = [{ id: "expired-stock", resourceId: "meat", name: "Meat", roomId: "outdoors", qty: 10,
    batches: [{ id: "expired-batch", qty: 10, ageQd: 0 }] }];
  const cargo = [{ lotId: "expired-lot", rowId: "expired-stock", batchId: "expired-batch", resourceId: "meat", name: "Meat",
    qty: 10, unitLoad: 4000, unitCopper: 5, ageQd: 0, shelfLifeQd: 20 }];
  const service = { ...feeder, id: "expired-carrier", firstQd: 80, riskBps: 0 };
  bookTransportOrder({ state: f.data.meta.transportV2, holding: f.holding, services: [service],
    plan: planTransportChain({ cargo, services: [service] }), id: "expired-sale", direction: "outbound",
    commercial: { marketId: "a", marketLabel: "Test market" } }).demandReservations = [];
  const h = harness(f.data);
  await h.apply(await h.prepare()); h.reload();
  assert.equal(h.holding().storage.log.filter(row => row.resourceId === "meat").reduce((sum, row) => sum + row.qty, 0), -10);
  const departure = await h.prepare();
  assert.equal(departure.report.ledger.filter(row => row.resourceId === "meat" && row.meta?.storageKind === "transport").length, 0,
    "an entirely expired reservation never becomes a new warehouse dispatch in the tenday report");
  await h.apply(departure); h.reload();
  assert.equal(h.holding().storage.log.filter(row => row.resourceId === "meat").reduce((sum, row) => sum + row.qty, 0), -10,
    "warehouse history conserves the original ten units after expiry and scheduled departure");
  await h.apply(await h.prepare());
  const order = h.holding().special.transportV2.orders[0];
  assert.equal(order.spoiledQty, 10); assert.equal(order.status, "lost");
  assert.equal(order.dispatched["expired-lot"], 10, "the full promise is retired even though no stock was loaded");
}
console.log("Transport tendays: pre-economy GM decisions, true dates, cargo/cash isolation, fresh sales, new connections, own return costs, shared feeder manifests, expired-source history, atomic Apply and replay passed.");
