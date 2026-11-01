import assert from "node:assert/strict";
import { transportFixture, transportRequest, transportHarness } from "./fixtures/transport-v2.mjs";
import { createHolding } from "../data/holding-factory.js";
import { addHoldingToData, deleteHoldingFromData } from "../data/holding-operations.js";
import { ensureTransportState } from "../data/transport/state.js";
import { bindSharedMarkets } from "../data/market/shared-context.js";
import { previewSharedMarketMigration } from "../data/market/shared-migration.js";
import { marketDemandKey, marketDemandRecoveryDuration } from "../data/market/demand-state.js";
import { normalizeSkyholdData } from "../data/normalizers.js";
import { prepareMarketAuthorityContext } from "../apps/market/authority-context.js";
import { prepareTransportContext, transportSourceToken } from "../apps/domains/transport-context.js";
import { createTransportOperationExecutor } from "../apps/transport-operation-executor.js";
import { planTransportChain } from "../engines/transport/planner.js";
import { bookTransportOrder } from "../engines/transport/runtime.js";
import { worldShipTransportTerms } from "../engines/ships/world-market.js";
import { transportOperatingCharge } from "../engines/transport/quantities.js";
import { SkyholdWorkflowService } from "../workflows/skyhold-workflow-service.js";
import { SkyholdData } from "../data/store.js";

globalThis.game = { user: { id: "gm", isGM: true }, users: [{ id: "gm", isGM: true, active: true }],
  settings: { get: () => undefined }, modules: new Map(), time: { worldTime: 0 }, socket: { emit() {} } };
globalThis.foundry = { utils: { deepClone: structuredClone } };
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };
const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack}`); }
}

function simulation(source, { resolveItems } = {}) {
  let data = bindSharedMarkets(structuredClone(source)), sequence = 0;
  const skipToken = Symbol("skip"), skip = value => ({ [skipToken]: true, value });
  const transaction = async update => {
    const draft = bindSharedMarkets(structuredClone(data));
    const result = await update(draft, { skip });
    if (result?.[skipToken]) return result.value;
    draft.meta.revision++; data = draft; return result;
  };
  const workflow = new SkyholdWorkflowService();
  workflow._postTendaySummaryChat = async () => {}; workflow.requestRender = () => {};
  SkyholdData.view = () => data; SkyholdData.skipTransaction = skip;
  SkyholdData.updateHolding = (id, update) => transaction(draft => update(draft.holdings.find(h => h.id === id), draft));
  const execute = createTransportOperationExecutor({ transaction, workflow: () => workflow, resolveItems, getUser: id => ({ id, isGM: id === "gm" }) });
  return {
    get data() { return data; }, holding: id => data.holdings.find(h => h.id === id),
    async edit(update) { await transaction(update); },
    reload(normalize = false) { data = bindSharedMarkets(normalize ? normalizeSkyholdData(data) : JSON.parse(JSON.stringify(data))); },
    async command(id, type, extra = {}, userId = "gm") {
      const holding = this.holding(id), operation = { type, operationId: `cross-system-${++sequence}`, holdingId: id,
        expectedRevision: data.meta.revision, sourceToken: transportSourceToken(data, holding), ...extra };
      const options = { userId, remote: userId !== "gm" };
      assert.equal((await execute(operation, options)).ok, true);
      const before = structuredClone(data);
      assert.equal((await execute(operation, options)).replay, true);
      assert.deepEqual(data, before, "saved command results are idempotent");
      return operation;
    },
    async advance(id, qd) {
      await this.edit(draft => { draft.holdings.find(h => h.id === id).gm.calendaria.lastQd = qd; });
      await this.command(id, "transport-advance");
    },
    async period(id) {
      const before = structuredClone(data);
      const prepared = await workflow._prepareTendayOperation({ holdingId: id, qd: 40, dataView: data,
        operationId: `cross-period-${++sequence}`, pendingEventsCollected: true });
      assert.equal(prepared.ok, true, prepared.message); assert.deepEqual(data, before, "preview is isolated");
      assert.equal((await workflow._applyPreparedTendayOperation(prepared)).ok, true);
      const after = structuredClone(data);
      assert.equal((await workflow._applyPreparedTendayOperation(prepared)).replay, true); assert.deepEqual(data, after);
    }
  };
}

const service = extra => ({ id: "connection", from: "hub", to: "a", kind: "regular", capacity: 8000,
  firstQd: 60, intervalQd: 40, travelQd: 4, dispatchCopper: 1, riskBps: 0, ...extra });
function inbound(data, holding, id, services, qty = 2) {
  const cargo = [{ lotId: id, resourceId: "test-freight", name: "Ткани", qty, unitLoad: 4000, unitCopper: 5, ageQd: 0 }];
  const state = ensureTransportState(data);
  return bookTransportOrder({ state, holding, id, direction: "inbound", services,
    plan: planTransportChain({ cargo, services, runs: state.runs }), commercial: { targetRoomId: "outdoors" } });
}
function withoutFleet(f) { f.holding.special.ships.list = []; f.holding.people.list = []; return f; }

await check("R1 a removed completed owner cannot release historical capacity to a lagging replan", async () => {
  for (const remove of [false, true]) {
    const f = withoutFleet(transportFixture()), a = f.holding;
    const b = structuredClone(a); b.id = "lagging"; f.data.holdings.push(b);
    const connection = service(), feeder = service({ id: "feeder", from: "home", to: "hub", firstQd: 20, travelQd: 10, riskBps: 10000 });
    const first = inbound(f.data, a, "first", [connection]);
    const second = inbound(f.data, b, "second", [feeder, connection]);
    assert.equal(first.plan.stages[0].runs[0].departureQd, 60);
    assert.equal(second.plan.stages[1].runs[0].departureQd, 100);
    const sim = simulation(f.data);
    await sim.advance(b.id, 40); await sim.advance(a.id, 40);
    await sim.command(a.id, "transport-incident", { runId: second.stages[0].runs[0].id, resolution: { outcome: "loss", lossBps: 5000 } });
    assert.equal(sim.holding(b.id).special.transportV2.orders[0].status, "needsResolution", "the other window does not execute this holding");
    await sim.advance(a.id, 80);
    if (remove) await sim.edit(draft => deleteHoldingFromData(draft, a.id));
    const physical = sim.data.meta.transportV2.runs.find(run => run.id === first.stages[0].runs[0].id);
    assert.equal(physical.reservedLoad, physical.capacity, "already used capacity remains full until the safe pruning boundary");
    sim.reload(); await sim.advance(b.id, 80);
    const order = sim.holding(b.id).special.transportV2.orders[0];
    assert.equal(order.stages[1].runs[0].departureQd, 100);
    assert.equal(order.received.length, 0, "the surviving unit cannot use the full QD 60 departure");
    await sim.advance(b.id, 120);
    assert.equal(sim.holding(b.id).special.transportV2.orders[0].received[0].qty, 1);
    assert.equal(sim.data.meta.transportV2.runs.length, 0, "retired owners do not make the schedule immortal");
  }
});

await check("R2 local port stays distinct from the warehouse on the next remote GM/player order", async () => {
  for (const isGM of [true, false]) for (const type of ["village", "sky-island"]) {
    const f = transportFixture(); f.holding.type = type;
    const harness = transportHarness(f);
    const first = await harness.book(transportRequest(f, "home", { direction: "outbound", ownShipId: f.ship.id }, isGM), `local-first-${isGM}-${type}`, isGM);
    harness.advance(first.preview.plan.shipReleaseQd);
    assert.equal(harness.ship.location.kind, "market"); assert.equal(harness.ship.location.regionId, "home");
    const pickup = worldShipTransportTerms(harness.data, harness.holding, harness.ship, "home", "home", { fromHome: false, toHome: true });
    assert.equal(pickup.distanceKm, 20); assert.equal(pickup.durationQd, 1);
    const second = await harness.book(transportRequest(harness.fixture(), "a", {
      direction: "outbound", ownShipId: f.ship.id, returnHome: true
    }, isGM), `remote-second-${isGM}-${type}`, isGM);
    const stage = second.preview.plan.stages.find(row => row.service.kind === "owned");
    assert.equal(stage.service.approachQd, pickup.durationQd);
    assert.equal(stage.service.approachCopper, transportOperatingCharge(pickup, pickup.durationQd));
    assert.ok(stage.runs[0].startQd >= second.preview.plan.startQd + pickup.durationQd);
    harness.advance(second.preview.plan.shipReleaseQd);
    assert.equal(second.order.ownedActualCopper, second.preview.plan.ownExpensesCopper);
    assert.equal(harness.ship.location.kind, "home");
  }
});

await check("R3 undated shared markets keep a new holding's common clock through actual preview/Apply", async () => {
  for (const isGM of [true, false]) {
    const f = withoutFleet(transportFixture()); f.holding.gm.calendaria.lastQd = 400;
    f.data.catalog.resources[0].id = "wood"; f.data.catalog.marketEconomy.baseOffers[0].resourceId = "wood";
    f.holding.storage.resources[0].resourceId = "wood";
    delete f.data.meta.transportV2; ensureTransportState(f.data);
    const created = createHolding({ name: "New holding", type: "village" });
    created.overview.region = "home"; created.visibility = "public";
    created.gm.playersCanUseStorage = true; created.gm.modifiers.marketConnectionsLevel = 6;
    created.storage = structuredClone(f.holding.storage);
    addHoldingToData(f.data, created);
    const prepared = previewSharedMarketMigration(f.data);
    assert.equal(prepared.ok, true); f.data.meta.sharedMarkets = prepared.prepared;
    const sim = simulation(f.data), holding = sim.holding(created.id);
    assert.equal(holding.special.transportV2.clockOffsetQd, 400);
    assert.equal(sim.data.meta.sharedMarkets.clockTenday, 10);
    const request = { marketId: "a", direction: "outbound", quantities: { wood: 10 }, insurance: false };
    const quote = prepareTransportContext({ data: sim.data, holding, request, isGM });
    await sim.command(created.id, "transport-book", { request, planToken: quote.planToken }, isGM ? "gm" : "player");
    assert.equal(Math.floor(quote.plan.arrivalQd / 40), 10);
    await sim.period(created.id);
    const key = marketDemandKey(quote.commercial.marketId, "wood"), duration = marketDemandRecoveryDuration(quote.commercial.marketId, "wood");
    assert.deepEqual({ clock: sim.data.meta.sharedMarkets.clockTenday, consumed: sim.data.meta.sharedMarkets.demand[key].consumedOutstanding },
      { clock: 11, consumed: 10 - Math.floor(10 / duration) });
    assert.equal(sim.data.meta.sharedMarkets.demand[key].recoveryLots[0].startedTenday, 10);
    sim.reload(); await sim.period(created.id);
    assert.equal(sim.data.meta.sharedMarkets.clockTenday, 12);
    assert.equal(sim.data.meta.sharedMarkets.demand[key].consumedOutstanding, 10 - Math.floor(20 / duration));
    assert.equal(sim.holding(f.holding.id).gm.calendaria.lastQd, 400);
    assert.equal(sim.holding(created.id).gm.calendaria.lastQd, 80);
    const demand = structuredClone(sim.data.meta.sharedMarkets.demand[key]);
    await sim.period(f.holding.id); await sim.period(f.holding.id);
    assert.equal(sim.data.meta.sharedMarkets.clockTenday, 12);
    assert.deepEqual(sim.data.meta.sharedMarkets.demand[key], demand, "another holding cannot recover demand twice for the same date");
  }
});

await check("R4 resolved incidents yield to the real waiting state without hiding another incident", async () => {
  const f = withoutFleet(transportFixture());
  const feeder = service({ id: "feeder", from: "home", to: "hub", firstQd: 4, intervalQd: 4, travelQd: 2, riskBps: 10000 });
  const order = inbound(f.data, f.holding, "two-incidents", [feeder, service({ capacity: 16000 })], 4);
  const sim = simulation(f.data), id = f.holding.id, ids = order.stages[0].runs.map(run => run.id);
  await sim.advance(id, 40);
  await sim.command(id, "transport-incident", { runId: ids[0], resolution: { outcome: "success" } });
  assert.equal(sim.holding(id).special.transportV2.orders[0].status, "needsResolution");
  await sim.command(id, "transport-incident", { runId: ids[1], resolution: { outcome: "success" } });
  assert.ok(sim.data.meta.transportV2.runs.every(run => run.incident?.status !== "pending"));
  assert.equal(sim.holding(id).special.transportV2.orders[0].status, "booked", "the connection is booked for QD 60");
  sim.reload(); await sim.advance(id, 59);
  assert.equal(sim.holding(id).special.transportV2.orders[0].status, "booked");
  await sim.advance(id, 60); assert.equal(sim.holding(id).special.transportV2.orders[0].status, "travelling");
  await sim.advance(id, 70); assert.equal(sim.holding(id).special.transportV2.orders[0].status, "delivered");
});

await check("I1 another departure cannot overwrite an unresolved receipt's status", async () => {
  const f = withoutFleet(transportFixture());
  const order = inbound(f.data, f.holding, "overlapping-status", [service({ from: "home", firstQd: 4, intervalQd: 4, travelQd: 2, riskBps: 10000 })], 4);
  const sim = simulation(f.data);
  await sim.advance(f.holding.id, 8);
  const current = sim.holding(f.holding.id).special.transportV2.orders[0];
  assert.equal(current.stages[0].receipts.length, 2);
  assert.equal(sim.data.meta.transportV2.runs.find(run => run.id === order.stages[0].runs[0].id).incident.status, "pending");
  assert.equal(current.status, "needsResolution", "a later departing receipt must not mask an earlier incident");
});

await check("I2 real Item bookings preserve snapshots and per-run quantities through normal loading", async () => {
  for (const isGM of [true, false]) {
    const f = withoutFleet(transportFixture());
    f.data.catalog.marketEconomy.baseOffers = [{ id: "item", sourceType: "item", itemUuid: "Item.audit", name: "Configured tools",
      kind: "consumable", baseStock: 20, baseDemand: 20, priceOverrideCopper: 40, loadOverridePoints: 4, ubiquity: "essential", active: true }];
    const doc = { documentName: "Item", uuid: "Item.audit", name: "Original tools", type: "gear",
      system: { quantity: 20, cost: "40 C", weight: "1" },
      toObject() { return { name: this.name, type: this.type, system: structuredClone(this.system) }; } };
    const sim = simulation(f.data, { resolveItems: async lines => new Map(lines.filter(row => row.sourceType === "item").map(row => [row.id, doc])) });
    const offer = prepareMarketAuthorityContext({ data: sim.data, holding: sim.holding(f.holding.id), marketId: "a", isGM }).quote.offers.find(row => row.sourceType === "item");
    assert.ok(offer);
    const request = { marketId: "a", direction: "inbound", quantities: { [offer.id]: 3 }, insurance: false };
    const quote = () => prepareTransportContext({ data: sim.data, holding: sim.holding(f.holding.id), request, isGM });
    const service = quote().services.find(row => row.kind === "regular");
    await sim.edit(draft => { draft.catalog.transportV2.overrides = { [service.id]: { capacity: 4000 } }; });
    request.serviceIds = [service.id]; const preview = quote();
    await sim.command(f.holding.id, "transport-book", { request, planToken: preview.planToken }, isGM ? "gm" : "player");
    sim.reload(true); doc.name = "Edited after booking"; doc.system.quantity = 999;
    await sim.advance(f.holding.id, preview.plan.arrivalQd);
    const items = sim.holding(f.holding.id).storage.items;
    assert.equal(items.length, 3); assert.equal(new Set(items.map(row => row.id)).size, 3);
    assert.ok(items.every(row => row.qty === 1 && row.itemData.system.quantity === 1 && row.name === "Configured tools"));
    assert.ok(items.every(row => row.itemData.name === "Original tools"), "accepted Item data remains a frozen snapshot");
  }
});

if (failures.length) throw new Error(`Transport cross-system regressions failed: ${failures.join("; ")}`);
console.log("Transport cross-system review: historical capacity, physical ship location, undated shared demand, incident status and authority replay passed.");
