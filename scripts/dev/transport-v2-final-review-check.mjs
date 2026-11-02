import assert from "node:assert/strict";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { SkyholdWorkflowService } from "../workflows/skyhold-workflow-service.js";
import { SkyholdData } from "../data/store.js";
import { ensureTransportState } from "../data/transport/state.js";
import { planTransportChain } from "../engines/transport/planner.js";
import { bookTransportOrder, advanceTransportOrders, resolveTransportIncident } from "../engines/transport/runtime.js";
import { advanceTransportShipments } from "../workflows/transport/orders.js";
import { reserveMarketDemand } from "../engines/market/demand.js";
import { planMarketOutboundSale } from "../engines/market/outbound.js";
import { marketDemandKey } from "../data/market/demand-state.js";
import { bindSharedMarkets, sharedMarketEventTenday } from "../data/market/shared-context.js";
import { prepareTransportContext } from "../apps/domains/transport-context.js";
import { prepareMarketAuthorityContext } from "../apps/market/authority-context.js";
import { createTransportOperationExecutor } from "../apps/transport-operation-executor.js";

globalThis.game = { user: { id: "gm", isGM: true }, users: [{ id: "gm", isGM: true, active: true }],
  settings: { get: () => undefined }, modules: new Map(), time: { worldTime: 0 }, socket: { emit() {} } };
globalThis.foundry = { utils: { deepClone: structuredClone } };
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };
const failures = [];
async function check(name, test) {
  try { await test(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack}`); }
}
const service = (extra = {}) => ({ id: "carrier", from: "home", to: "a", kind: "regular", capacity: 40000,
  firstQd: 0, intervalQd: 40, travelQd: 2, dispatchCopper: 1, riskBps: 0, ...extra });
const lot = (extra = {}) => ({ lotId: "wood", resourceId: "wood", qty: 10, unitLoad: 4000, unitCopper: 6, ageQd: 0, ...extra });
function fixture() {
  const f = worldMarketFixture(); f.holding.special.ships.list = []; f.holding.people.list = [];
  f.holding.storage.resources = []; ensureTransportState(f.data);
  const workflow = new SkyholdWorkflowService(); workflow._postTendaySummaryChat = async () => {}; workflow.requestRender = () => {};
  return { ...f, workflow };
}
function sale(f, cargo, services, id = "sale") {
  const lines = [...new Set(cargo.map(row => row.demandId ?? row.resourceId))].map(demandId => ({ demandId,
    qty: cargo.filter(row => (row.demandId ?? row.resourceId) === demandId).reduce((sum, row) => sum + row.qty, 0), demandBaseDemand: 100, demandStateRevision: 0 }));
  const reservation = reserveMarketDemand({ holding: f.holding, marketId: "a", operationId: id, lines });
  assert.equal(reservation.ok, true, reservation.message);
  const order = bookTransportOrder({ state: f.data.meta.transportV2, holding: f.holding, services,
    plan: planTransportChain({ cargo, services, runs: f.data.meta.transportV2.runs }), id, direction: "outbound", commercial: { insuranceCoverageBps: 8400 } });
  order.demandReservations = reservation.reservations;
  return order;
}
async function period(f) {
  let stored = structuredClone(f.data);
  const skipped = Symbol("skip");
  SkyholdData.view = () => stored;
  SkyholdData.skipTransaction = value => ({ [skipped]: true, value });
  SkyholdData.updateHolding = async (id, updater) => {
    const draft = structuredClone(stored), result = await updater(draft.holdings.find(row => row.id === id), draft);
    if (result?.[skipped]) return result.value;
    draft.meta.revision++; stored = draft; return result;
  };
  const before = structuredClone(stored);
  const prepared = await f.workflow._prepareTendayOperation({ holdingId: f.holding.id, qd: 40, dataView: stored,
    operationId: "final-review-period", pendingEventsCollected: true });
  assert.equal(prepared.ok, true, prepared.message); assert.deepEqual(stored, before);
  assert.equal((await f.workflow._applyPreparedTendayOperation(prepared)).ok, true);
  const after = structuredClone(stored);
  assert.equal((await f.workflow._applyPreparedTendayOperation(prepared)).replay, true); assert.deepEqual(stored, after);
  return stored;
}

await check("C1 unchanged connection carries actual warehouse age through real period preview and Apply", async () => {
  const f = fixture();
  f.holding.storage.resources = [{ id: "meat-row", resourceId: "meat", qty: 8, roomId: "outdoors",
    batches: Array.from({ length: 8 }, (_, i) => ({ id: `batch-${i}`, qty: 1, ageQd: i * 2 + 1 })) }];
  const cargo = f.holding.storage.resources[0].batches.map(row => lot({ lotId: row.id, rowId: "meat-row", batchId: row.id,
    resourceId: "meat", qty: 1, ageQd: row.ageQd, shelfLifeQd: 20 }));
  const order = sale(f, cargo, [service(), service({ id: "connection", from: "a", to: "b", firstQd: 2 })]);
  const contract = structuredClone(order.plan);
  f.workflow._storageAddWithOverflow(f.holding, { resourceId: "meat", roomId: "outdoors", batches: [{ id: "incoming", qty: 1, ageQd: 17 }] }, 1);
  assert.equal(f.holding.storage.resources[0].batches.find(row => row.id === "batch-7").ageQd, 17);
  const data = await period(f), h = data.holdings[0], result = h.special.transportV2.orders[0];
  assert.deepEqual(result.plan, contract, "accepted prices and estimate remain immutable");
  assert.equal(result.received.reduce((sum, row) => sum + row.qty, 0), 7);
  assert.equal(result.spoiledQty, 1); assert.equal(result.insurancePaidCopper, 0);
  assert.equal(result.stages[1].receipts[0].cargo.find(row => row.lotId === "batch-7").ageQd, 19);
  assert.equal(h.special.market.demand[marketDemandKey("a", "meat")].recoveryLots.reduce((n, row) => n + row.qty, 0), 7);
});

await check("C2 receipt calendar includes hour and minute at the decade boundary", () => {
  for (const [hoursPerDay, hour, minute, delta] of [[24, 17, 59, 2], [24, 18, 5, 1], [30, 22, 29, 2], [30, 22, 30, 1]]) {
    globalThis.CALENDARIA = { api: { getActiveCalendar: () => ({ days: { hoursPerDay } }) } };
    const f = fixture(); f.holding.gm.calendaria = { lastQd: 0, lastDateTime: { year: 881, month: 1, day: 10, hour, minute } };
    f.data.meta.sharedMarkets = { enabled: true, clockTenday: 21144, demand: {}, stock: {} }; bindSharedMarkets(f.data);
    assert.equal(sharedMarketEventTenday(f.holding, delta - 1), 21144);
    assert.equal(sharedMarketEventTenday(f.holding, delta), 21145);
  }
  delete globalThis.CALENDARIA;
});

await check("C2 arriving in the current calendar decade does not immediately recover demand", () => {
  const f = fixture();
  f.holding.gm.calendaria = { lastQd: 0, lastDateTime: { year: 881, month: 1, day: 10, hour: 18, minute: 5 } };
  f.data.meta.sharedMarkets = { enabled: true, clockTenday: 21144, demand: {}, stock: {} }; bindSharedMarkets(f.data);
  f.holding.storage.resources = [{ id: "stock", resourceId: "wood", qty: 10, batches: [{ id: "batch", qty: 10, ageQd: 0 }] }];
  sale(f, [lot({ rowId: "stock", batchId: "batch" })], [service()]);
  advanceTransportShipments(f.data, f.holding, 40, f.workflow);
  const demand = f.data.meta.sharedMarkets.demand[marketDemandKey("a", "wood")];
  assert.equal(demand.recoveryLots[0].startedTenday, 21145);
  assert.equal(demand.consumedOutstanding, 10);
});

await check("C3 shared physical schedule and risk survive catalogue edits and reload", () => {
  const f = fixture(), state = f.data.meta.transportV2, first = service({ firstQd: 4, loadingQd: 2, riskBps: 10000 });
  const one = bookTransportOrder({ state, holding: f.holding, services: [first],
    plan: planTransportChain({ cargo: [lot({ qty: 1 })], services: [first] }), id: "first", direction: "inbound" });
  const contract = structuredClone(one.plan), changed = { ...first, loadingQd: 0, capacity: 80000, riskBps: 0 };
  const plan = planTransportChain({ cargo: [lot({ qty: 1 })], services: [changed], runs: state.runs });
  const run = plan.stages[0].runs[0];
  for (const key of ["startQd", "departureQd", "arrivalQd", "releaseQd", "riskBps", "capacity"]) assert.equal(run[key], state.runs[0][key], key);
  bookTransportOrder({ state, holding: f.holding, services: [changed], plan, id: "second", direction: "inbound" });
  assert.deepEqual(one.plan, contract);
  const saved = JSON.parse(JSON.stringify(f.data));
  advanceTransportOrders({ state: saved.meta.transportV2, holding: saved.holdings[0], targetQd: 6, dependencies: { receiveCargo() {} } });
  assert.ok(saved.holdings[0].special.transportV2.orders.every(row => row.status === "needsResolution"));
  resolveTransportIncident(saved.meta.transportV2, run.id, { outcome: "success" });
  advanceTransportOrders({ state: saved.meta.transportV2, holding: saved.holdings[0], targetQd: 6, dependencies: { receiveCargo() {} } });
  assert.ok(saved.holdings[0].special.transportV2.orders.every(row => row.status === "delivered"));
  assert.equal(saved.meta.transportV2.runs.length, 1);
  const tooLate = planTransportChain({ cargo: [lot({ qty: 1 })], services: [changed], runs: state.runs, startQd: 3 });
  assert.ok(tooLate.stages[0].runs[0].departureQd > 4, "cannot join an already started loading operation");
});

await check("C3 GM and player authority bookings agree with an existing run after a country risk edit", async () => {
  const f = fixture(); let stored = f.data;
  f.holding.type = "village"; f.holding.visibility = "public"; f.holding.gm.playersCanUseStorage = true;
  f.holding.gm.modifiers.marketConnectionsLevel = 6; f.data.catalog.marketEconomy.countries[0].riskFactor = 4;
  const execute = createTransportOperationExecutor({ workflow: () => f.workflow, getUser: id => ({ id, isGM: id === "gm" }),
    transaction: async updater => {
      const draft = structuredClone(stored), skipped = Symbol("skip"); bindSharedMarkets(draft);
      const result = await updater(draft, { skip: value => ({ [skipped]: true, value }) });
      if (result?.[skipped]) return result.value;
      draft.meta.revision++; stored = draft; return result;
    } });
  let firstPlan;
  for (const userId of ["gm", "player"]) {
    const h = stored.holdings[0], isGM = userId === "gm";
    const market = prepareMarketAuthorityContext({ data: stored, holding: h, isGM }).markets.find(row => row.regionId === "a");
    const offer = prepareMarketAuthorityContext({ data: stored, holding: h, isGM, marketId: market.id }).quote.offers.find(row => row.resourceId === "test-freight");
    const request = { direction: "inbound", marketId: market.id, quantities: { [offer.id]: 1 }, insurance: false };
    const initial = prepareTransportContext({ data: stored, holding: h, request, isGM });
    request.serviceIds = [initial.services.find(row => row.kind === "regular" && row.from === initial.from && row.to === initial.to).id];
    const quote = prepareTransportContext({ data: stored, holding: h, request, isGM });
    if (!isGM) {
      assert.ok(quote.plan.stages[0].service.riskBps < firstPlan.stages[0].runs[0].riskBps);
      assert.equal(quote.plan.stages[0].runs[0].riskBps, stored.meta.transportV2.runs[0].riskBps);
    }
    const operation = { type: "transport-book", operationId: `risk-book-${userId}`, holdingId: h.id,
      expectedRevision: stored.meta.revision, sourceToken: quote.sourceToken, planToken: quote.planToken, request };
    assert.equal((await execute(operation, { userId, remote: !isGM })).ok, true);
    const saved = structuredClone(stored);
    assert.equal((await execute(operation, { userId, remote: !isGM })).replay, true); assert.deepEqual(stored, saved);
    firstPlan ??= structuredClone(stored.holdings[0].special.transportV2.orders[0].plan);
    stored.catalog.marketEconomy.countries[0].riskFactor = 1;
  }
  assert.equal(stored.meta.transportV2.runs.length, 1);
  assert.deepEqual(stored.holdings[0].special.transportV2.orders[0].plan, firstPlan);
});

await check("I1 shared loss waits for the actual outbound warehouse manifest", () => {
  const f = fixture(), other = fixture().holding;
  f.holding.id = "a-warehouse"; other.id = "z-purchase"; f.data.holdings.push(other);
  f.holding.storage.resources = [{ id: "meat-row", resourceId: "meat", qty: 8, roomId: "outdoors",
    batches: Array.from({ length: 8 }, (_, i) => ({ id: `batch-${i}`, qty: 1, ageQd: i * 2 + 1 })) }];
  const services = [service({ firstQd: 2, riskBps: 10000 })], state = f.data.meta.transportV2;
  const outbound = sale(f, [lot({ qty: 1, resourceId: "meat", rowId: "meat-row", batchId: "batch-7", ageQd: 15, shelfLifeQd: 20 })], services);
  const inbound = bookTransportOrder({ state, holding: other, services, id: "purchase", direction: "inbound",
    plan: planTransportChain({ cargo: [lot({ qty: 1 })], services, runs: state.runs }) });
  f.workflow._storageAddWithOverflow(f.holding, { resourceId: "meat", roomId: "outdoors", batches: [{ id: "incoming", qty: 1, ageQd: 17 }] }, 1);
  advanceTransportShipments(f.data, other, 4, f.workflow);
  const run = state.runs[0];
  assert.throws(() => resolveTransportIncident(state, run.id, { outcome: "loss", lossBps: 5000 }), /состав груза/);
  advanceTransportShipments(f.data, f.holding, 4, f.workflow);
  resolveTransportIncident(state, run.id, { outcome: "loss", lossBps: 5000 });
  for (const h of [other, f.holding]) advanceTransportShipments(f.data, h, 4, f.workflow);
  assert.equal(inbound.lostQty, 0, "50% of one eligible unit rounds to zero, spoiled cargo cannot affect other holdings");
  assert.equal(outbound.spoiledQty, 1); assert.equal(outbound.insurancePaidCopper, 0);
});

await check("I2 demand dates are independent of period splitting while Calendaria is unavailable", () => {
  const results = [];
  for (const split of [false, true]) {
    const f = fixture();
    f.holding.gm.calendaria = { lastQd: 0, lastDateTime: { year: 881, month: 1, day: 10, hour: 18, minute: 5 } };
    f.data.meta.sharedMarkets = { enabled: true, clockTenday: 21144, demand: {}, stock: {} }; bindSharedMarkets(f.data);
    f.holding.storage.resources = [{ id: "stock", resourceId: "wood", qty: 20, batches: [{ id: "batch", qty: 20, ageQd: 0 }] }];
    sale(f, [lot({ rowId: "stock", batchId: "batch", qty: 20 })], [service()]);
    if (split) { advanceTransportShipments(f.data, f.holding, 40, f.workflow); f.holding.gm.calendaria.lastQd = 40; }
    advanceTransportShipments(f.data, f.holding, 80, f.workflow);
    const demand = f.data.meta.sharedMarkets.demand[marketDemandKey("a", "wood")];
    results.push({ clock: f.data.meta.sharedMarkets.clockTenday, lots: demand.recoveryLots, consumed: demand.consumedOutstanding });
  }
  assert.deepEqual(results[1], results[0]);
  assert.equal(results[0].clock, 21146); assert.deepEqual(results[0].lots.map(row => row.startedTenday), [21145, 21146]);
});

await check("B3 demand identity is preserved across FIFO cargo and partial receipts", () => {
  const f = fixture();
  f.holding.storage.resources = [{ id: "stock", resourceId: "wood", forSale: true, qty: 4, batches: [{ id: "batch", qty: 4, ageQd: 0 }] }];
  const planned = planMarketOutboundSale({ resources: f.holding.storage.resources, lines: ["buyer-a", "buyer-b"].map(demandId =>
    ({ id: demandId, demandId, resourceId: "wood", qty: 2, unitPriceCopper: 6, demandBaseDemand: 100 })), routes: [{ id: "route", deliveryQd: 2 }] });
  const cargo = planned.cargoReservations.map((row, i) => lot({ ...row, lotId: `fifo-${i}`, unitCopper: row.unitPriceCopper }));
  assert.equal(cargo.length, 2);
  const order = sale(f, cargo, [service({ capacity: 8000 })]);
  advanceTransportShipments(f.data, f.holding, 2, f.workflow);
  const demand = id => f.holding.special.market.demand[marketDemandKey("a", id)];
  assert.equal(demand("buyer-a").consumedOutstanding, 2); assert.equal(demand("buyer-a").reservedDemand, 0);
  assert.equal(demand("buyer-b").reservedDemand, 2); assert.equal(demand("buyer-b").consumedOutstanding, 0);
  advanceTransportShipments(f.data, f.holding, 42, f.workflow);
  assert.equal(order.status, "delivered"); assert.equal(demand("buyer-b").reservedDemand, 0); assert.equal(demand("buyer-b").consumedOutstanding, 2);
});

assert.deepEqual(failures, [], `${failures.length} final review regressions failed`);
console.log("Transport final review: warehouse age, calendar demand, shared-run contracts and demand identity passed.");
