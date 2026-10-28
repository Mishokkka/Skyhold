import assert from "node:assert/strict";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { createHolding } from "../data/holding-factory.js";
import { createShipRecord } from "../data/ships.js";
import { addHoldingToData } from "../data/holding-operations.js";
import { ensureTransportState } from "../data/transport/state.js";
import { transportHoldingQd, transportCalendarQd } from "../data/transport/clock.js";
import { normalizeSkyholdData } from "../data/normalizers.js";
import { prepareTransportContext } from "../apps/domains/transport-context.js";
import { prepareMarketAuthorityContext } from "../apps/market/authority-context.js";
import { createTransportOperationExecutor } from "../apps/transport-operation-executor.js";
import { initializeWorldShip } from "../engines/ships/world-voyage.js";
import { configureWorldShipEconomy } from "../engines/ships/world-market.js";
import { SkyholdWorkflowService } from "../workflows/skyhold-workflow-service.js";
import { SkyholdData } from "../data/store.js";
import { planTransportChain } from "../engines/transport/planner.js";
import { bookTransportOrder } from "../engines/transport/runtime.js";
import { advanceTransportShipments } from "../workflows/transport/orders.js";
import { reserveMarketDemand } from "../engines/market/demand.js";
import { marketDemandKey } from "../data/market/demand-state.js";

globalThis.game = { user: { id: "gm", isGM: true }, users: [{ id: "gm", isGM: true, active: true }],
  settings: { get: () => undefined }, modules: new Map(), time: { worldTime: 0 }, socket: { emit() {} } };
globalThis.foundry = { utils: { deepClone: structuredClone } };
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };

function harness(data) {
  let stored = structuredClone(data), sequence = 0;
  const skipped = Symbol("skip"), skip = value => ({ [skipped]: true, value });
  const transaction = async updater => {
    const draft = structuredClone(stored), result = await updater(draft, { skip });
    if (result?.[skipped]) return result.value;
    draft.meta.revision++; stored = draft; return result;
  };
  SkyholdData.view = () => stored;
  SkyholdData.skipTransaction = skip;
  SkyholdData.updateHolding = (id, updater) => transaction(draft => updater(draft.holdings.find(row => row.id === id), draft));
  const workflow = new SkyholdWorkflowService();
  workflow._postTendaySummaryChat = async () => {}; workflow.requestRender = () => {};
  const execute = createTransportOperationExecutor({ transaction, workflow: () => workflow,
    getUser: id => ({ id, isGM: id === "gm" }) });
  return { get data() { return stored; }, workflow, execute,
    holding: id => stored.holdings.find(row => row.id === id),
    async period(id, qd = 40) {
      const before = structuredClone(stored);
      const prepared = await workflow._prepareTendayOperation({ holdingId: id, qd, dataView: stored,
        operationId: `boundary-period-${++sequence}`, pendingEventsCollected: true });
      assert.equal(prepared.ok, true, prepared.message);
      assert.deepEqual(stored, before, "the actual period preview is isolated");
      assert.equal((await workflow._applyPreparedTendayOperation(prepared)).ok, true);
      const after = structuredClone(stored);
      assert.equal((await workflow._applyPreparedTendayOperation(prepared)).replay, true);
      assert.deepEqual(stored, after);
      return prepared;
    },
    async book(id, userId, ownShipId = "") {
      const h = this.holding(id), market = prepareMarketAuthorityContext({ data: stored, holding: h, isGM: userId === "gm" })
        .markets.find(row => row.regionId === "a");
      const offer = prepareMarketAuthorityContext({ data: stored, holding: h, marketId: market.id, isGM: userId === "gm" })
        .quote.offers.find(row => row.resourceId === "test-freight");
      const request = { direction: ownShipId ? "outbound" : "inbound", marketId: market.id,
        quantities: { [ownShipId ? "test-freight" : offer.id]: 2 }, insurance: false, ownShipId, returnHome: true };
      const initial = prepareTransportContext({ data: stored, holding: h, request, isGM: userId === "gm" });
      request.serviceIds = [initial.services.find(row => row.from === initial.from && row.to === initial.to
        && row.kind === (ownShipId ? "owned" : "regular")).id];
      const quote = prepareTransportContext({ data: stored, holding: h, request, isGM: userId === "gm" });
      const operation = { type: "transport-book", operationId: `calendar-book-${++sequence}`, holdingId: id,
        expectedRevision: stored.meta.revision, sourceToken: quote.sourceToken, planToken: quote.planToken, request };
      assert.equal((await execute(operation, { userId, remote: userId !== "gm" })).ok, true);
      const after = structuredClone(stored);
      assert.equal((await execute(operation, { userId, remote: userId !== "gm" })).replay, true);
      assert.deepEqual(stored, after);
      return this.holding(id).special.transportV2.orders.at(-1);
    }
  };
}

const yearStart = 881 * 960;
let nowQd = yearStart + 400;
function date(qd) {
  const day = Math.floor(qd / 4);
  return { year: Math.floor(day / 240), month: Math.floor(day % 240 / 30) + 1, day: day % 30 + 1, hour: (qd % 4) * 6, minute: 0 };
}
const qdForDate = d => (d.year * 240 + (d.month - 1) * 30 + d.day - 1) * 4 + (d.hour ?? 0) / 6;
globalThis.CALENDARIA = { api: {
  getActiveCalendar: () => ({ days: { hoursPerDay: 24 }, monthsArray: Array.from({ length: 8 }, (_, i) => ({ name: `${i + 1}`, days: 30 })) }),
  getCurrentDateTime: () => date(nowQd), dateToTimestamp: d => qdForDate(d) * 21600,
  addHours: (d, hours) => date(qdForDate(d) + hours / 6), formatDate: d => `${d.year}-${d.month}-${d.day}`
} };
{
  const f = worldMarketFixture(), oldId = f.holding.id;
  f.holding.type = "village"; f.holding.gm.modifiers.marketConnectionsLevel = 6;
  f.holding.special.ships.list = [];
  Object.assign(f.holding.gm.calendaria, { lastQd: 400, lastDateTime: date(nowQd) });
  ensureTransportState(f.data); f.data.catalog.transportV2 = { riskBps: 0 };
  const created = createHolding({ name: "New calendar holding", type: "village" });
  created.overview.region = "home"; created.storage.moneyCopper = 1000000; created.visibility = "public";
  created.gm.modifiers.marketConnectionsLevel = 6;
  created.gm.playersCanUseStorage = true; created.gm.playersCanManageShips = true;
  addHoldingToData(f.data, created);
  const h = harness(f.data), id = created.id;
  await h.period(id);
  assert.equal(h.holding(id).gm.calendaria.lastQd, 40);
  assert.equal(h.holding(oldId).gm.calendaria.lastQd, 400);
  assert.deepEqual(h.holding(id).gm.calendaria.lastDateTime, h.holding(oldId).gm.calendaria.lastDateTime);
  assert.equal(h.data.meta.transportV2.clockQd, 400);
  assert.equal(transportHoldingQd(h.data, h.holding(id)), 400);
  assert.equal(h.workflow._checkCalendariaEconomyAdvance(h.holding(id), 40).ok, false,
    "Calendaria still prevents future economic periods; bookings at the current date remain possible");
  for (const user of ["gm", "player"]) {
    const order = await h.book(id, user);
    assert.equal(order.plan.startQd, 400); assert.equal(order.clockOffsetQd, 360);
  }
  await h.book(oldId, "gm");
  assert.equal(h.data.meta.transportV2.runs.length, 1, "different holding ages share the same physical calendar departure");
  const newHolding = h.holding(id), ship = createShipRecord("magnifique");
  newHolding.people.list = structuredClone(f.holding.people.list); ship.crewTarget = 1; ship.crewResidentIds = ["sailor"];
  newHolding.special.ships.list.push(ship);
  initializeWorldShip(newHolding, ship, { profileId: "merchant-barque", clockQd: 40 });
  configureWorldShipEconomy(h.data, newHolding, ship);
  newHolding.storage.resources.push({ id: "sale", resourceId: "test-freight", qty: 2, forSale: true, roomId: "outdoors",
    batches: [{ id: "sale-batch", qty: 2, ageQd: 0 }] });
  const ownOrder = await h.book(id, "player", ship.id);
  assert.equal(ownOrder.plan.startQd, 400);
  assert.equal(h.holding(id).special.ships.list[0].timelineQd, 40, "booking keeps the ship's local clock");
  assert.equal(h.holding(id).special.ships.list[0].currentOuting.startedAtQd, 40);
  const reloaded = normalizeSkyholdData(h.data);
  assert.equal(transportHoldingQd(reloaded, reloaded.holdings.find(row => row.id === id)), 400);
  assert.deepEqual(reloaded.meta.transportV2, h.data.meta.transportV2);
  nowQd += 40;
  await h.period(oldId); await h.period(id);
  assert.equal(h.data.meta.transportV2.clockQd, 440);
  assert.equal(h.holding(oldId).gm.calendaria.lastQd, 440); assert.equal(h.holding(id).gm.calendaria.lastQd, 80);
  const returned = h.holding(id).special.ships.list[0];
  assert.equal(returned.transportOrderId, undefined);
  assert.equal(returned.lastOuting.startedAtQd, 40);
  assert.equal(returned.lastOuting.completedAtQd, ownOrder.plan.shipReleaseQd - 360);
  assert.equal(returned.timelineQd, 80);
  assert.ok(h.holding(id).special.transportV2.orders.every(order => order.status === "delivered"));
  const received = h.holding(id).storage.resources.filter(row => row.qty > 0);
  assert.equal(received.reduce((sum, row) => sum + row.qty, 0), 4);
  assert.ok(received.flatMap(row => row.batches).every(batch => batch.ageQd === 40), "warehouse aging never adds the calendar offset");
  const calendarApi = globalThis.CALENDARIA;
  delete globalThis.CALENDARIA;
  for (let period = 0; period < 2; period++) { await h.period(oldId); await h.period(id); }
  assert.equal(h.holding(id).gm.calendaria.lastQd, 160);
  assert.equal(transportHoldingQd(h.data, h.holding(id)), 520, "elapsed local periods still advance transport when the stored calendar date stops updating");
  assert.equal(h.data.meta.transportV2.clockQd, 520);
  assert.equal((await h.book(id, "player")).plan.startQd, 520);
  globalThis.CALENDARIA = calendarApi;
}
// Non-midnight dates preserve quarter-day alignment, including configured hours per day.
assert.equal(transportCalendarQd({ gm: { calendaria: { lastDateTime: { year: 881, month: 1, day: 1, hour: 18 } } } }), yearStart + 3);
globalThis.CALENDARIA.api.getActiveCalendar = () => ({ days: { hoursPerDay: 30 } });
assert.equal(transportCalendarQd({ gm: { calendaria: { lastDateTime: { year: 881, month: 1, day: 1, hour: 15 } } } }), yearStart + 2);
assert.equal(transportCalendarQd({ gm: { calendaria: { lastDateTime: { year: 881, month: 1, day: 1, hour: 7, minute: 30 } } } }), yearStart + 1);
delete globalThis.CALENDARIA;

// Without Calendaria a newly created holding starts at the current transport date, not at world day zero.
{
  const f = worldMarketFixture(); f.holding.gm.calendaria.lastQd = 400; ensureTransportState(f.data);
  const created = createHolding(); addHoldingToData(f.data, created);
  assert.equal(created.gm.calendaria.lastQd, 0);
  assert.equal(transportHoldingQd(f.data, f.data.holdings[1]), 400);
}

// A2: actual daily raw-food expiry, two real period previews + Apply, and strict FIFO validation.
{
  const f = worldMarketFixture(); f.holding.special.ships.list = []; f.holding.people.list = [];
  const state = ensureTransportState(f.data);
  f.holding.storage.resources = [{ id: "raw-meat", resourceId: "meat", qty: 20, roomId: "outdoors",
    batches: [{ id: "raw-batch", qty: 20, ageQd: 0 }] }];
  const cargo = [{ lotId: "raw", resourceId: "meat", rowId: "raw-meat", batchId: "raw-batch", qty: 20,
    ageQd: 0, shelfLifeQd: 20, unitLoad: 4000, unitCopper: 6 }];
  const services = [{ id: "slow-meat", from: "home", to: "a", kind: "regular", capacity: 40000,
    firstQd: 4, intervalQd: 80, travelQd: 4, dispatchCopper: 1 }];
  const reservation = reserveMarketDemand({ holding: f.holding, marketId: "a", operationId: "meat-market",
    lines: [{ demandId: "meat", qty: 20, demandBaseDemand: 100, demandStateRevision: 0 }] });
  const order = bookTransportOrder({ state, holding: f.holding, plan: planTransportChain({ cargo, services }), services,
    id: "meat-sale", direction: "outbound", commercial: { insuranceCoverageBps: 8400 } });
  order.demandReservations = reservation.reservations;
  const h = harness(f.data), id = f.holding.id;
  await h.period(id);
  const first = h.holding(id).special.transportV2.orders[0];
  assert.equal(first.received.reduce((sum, row) => sum + row.qty, 0), 10);
  assert.equal(first.sourceSpoiledPending.raw, 10);
  assert.equal(h.holding(id).storage.resources[0].qty, 0);
  await h.period(id, 80);
  const finished = h.holding(id).special.transportV2.orders[0];
  assert.equal(finished.status, "delivered"); assert.equal(finished.spoiledQty, 10); assert.equal(finished.insurancePaidCopper, 0);
  assert.equal(h.holding(id).special.market.demand[marketDemandKey("a", "meat")].reservedDemand, 0);
  const unexpected = structuredClone(f.data);
  unexpected.holdings[0].storage.resources[0].batches = []; unexpected.holdings[0].storage.resources[0].qty = 0;
  assert.throws(() => advanceTransportShipments(unexpected, unexpected.holdings[0], 40, h.workflow), /Reserved outbound cargo changed/,
    "unexpected missing inventory remains an error, distinct from registered natural expiry");
}
console.log("Transport calendar/period: create → actual preview/Apply → GM/player bookings → actual periods, local ship/warehouse clocks, raw-food expiry and strict FIFO passed.");
