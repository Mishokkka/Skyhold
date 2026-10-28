import assert from "node:assert/strict";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { ensureTransportState } from "../data/transport/state.js";
import { deleteHoldingFromData } from "../data/holding-operations.js";
import { prepareTransportContext, transportSourceToken } from "../apps/domains/transport-context.js";
import { prepareMarketAuthorityContext } from "../apps/market/authority-context.js";
import { createTransportOperationExecutor } from "../apps/transport-operation-executor.js";
import { planTransportChain, TransportPlanningUnavailableError } from "../engines/transport/planner.js";
import { bookTransportOrder, advanceTransportOrders, cancelTransportOrder, resolveTransportIncident } from "../engines/transport/runtime.js";
import { cargoValue } from "../engines/transport/quantities.js";
import { MAX_MARKET_OPERATION_COPPER } from "../data/market/money-limits.js";
import { reserveMarketDemand, settleMarketDemandReservations, recoverMarketDemand } from "../engines/market/demand.js";
import { marketDemandKey, normalizeMarketDemandState } from "../data/market/demand-state.js";
import { bindSharedMarkets } from "../data/market/shared-context.js";
import { previewSharedMarketMigration } from "../data/market/shared-migration.js";
import { prepareShipsContext, prepareShipWindowContext } from "../apps/ships-context.js";
import { normalizeSkyholdData } from "../data/normalizers.js";
import { preflightMarketOutboundDispatch } from "../engines/market/outbound.js";

const holding = id => ({ id, gm: { calendaria: { lastQd: 0 } }, storage: { moneyCopper: 1000000, resources: [] }, special: { market: {} } });
const cargo = (qty = 10) => [{ lotId: "cloth", resourceId: "test-freight", qty, unitLoad: 4000, unitCopper: 5, ageQd: 0 }];
const service = (extra = {}) => ({ id: "regular", from: "A", to: "B", kind: "regular", capacity: 40000,
  firstQd: 4, intervalQd: 40, travelQd: 4, dispatchCopper: 1, ...extra });
const dependencies = { receiveCargo() {} };
function book(state, h, id, services, qty = 10, startQd = state.clockQd) {
  return bookTransportOrder({ state, holding: h, id, direction: "inbound", services,
    plan: planTransportChain({ cargo: cargo(qty), services, startQd, runs: state.runs }) });
}
function world() {
  const f = worldMarketFixture();
  f.holding.type = "village"; f.holding.visibility = "public";
  f.holding.gm.playersCanManageShips = true; f.holding.gm.playersCanUseStorage = true;
  f.holding.gm.modifiers.marketConnectionsLevel = 6; f.ship.crewTarget = 1;
  f.data.catalog.transportV2 = { riskBps: 0 }; ensureTransportState(f.data);
  return f;
}

// A3: deletion is an atomic guard, including return travel and an undetermined shared manifest.
for (const shared of [false, true]) {
  const a = holding("a"), b = holding("b"), data = { meta: {}, holdings: [a, b] }, state = ensureTransportState(data);
  const services = shared ? [service(), service({ id: "connection", from: "B", to: "C", firstQd: 12, riskBps: 10000 })]
    : [service({ id: "charter", kind: "charter", vehicles: 1, returnQd: 8 })];
  const first = book(state, a, "first", services, 5);
  book(state, b, "second", services, 5);
  const before = structuredClone(data);
  assert.throws(() => deleteHoldingFromData(data, a.id), /перевозки/);
  assert.deepEqual(data, before);
  if (shared) {
    advanceTransportOrders({ state, holding: b, targetQd: 40, dependencies });
    assert.equal(state.runs.at(-1).claims.find(row => row.holdingId === "a").manifestReady, false);
    assert.throws(() => deleteHoldingFromData(data, a.id), /перевозки/);
    advanceTransportOrders({ state, holding: a, targetQd: 40, dependencies });
    resolveTransportIncident(state, state.runs.at(-1).id, { outcome: "loss", lossBps: 5000 });
    for (const h of [a, b]) advanceTransportOrders({ state, holding: h, targetQd: 40, dependencies });
  } else {
    advanceTransportOrders({ state, holding: a, targetQd: first.plan.arrivalQd, dependencies });
    assert.equal(first.status, "delivered");
    assert.throws(() => deleteHoldingFromData(data, a.id), /возвращение/);
    advanceTransportOrders({ state, holding: a, targetQd: first.stages[0].runs[0].releaseQd, dependencies });
  }
  const runs = structuredClone(state.runs);
  deleteHoldingFromData(data, a.id);
  assert.deepEqual(state.runs, runs, "deletion of completed ownership must not erase another holding's physical run");
  assert.equal(data.holdings.length, 1);
}

// Independent check: coalescing equal warehouse rows must not invalidate frozen source references.
{
  const h = holding("coalescing"), data = { meta: {}, holdings: [h], catalog: {} }, state = ensureTransportState(data);
  h.storage.resources = ["first", "reserved"].map(id => ({ id, resourceId: "wood", qty: 10, roomId: id,
    batches: [{ id: `${id}-batch`, qty: 10, ageQd: 0 }] }));
  const lots = [{ ...cargo()[0], resourceId: "wood", rowId: "reserved", batchId: "reserved-batch" }];
  const services = [service()];
  const order = bookTransportOrder({ state, holding: h, services, direction: "outbound", id: "reserved-row",
    plan: planTransportChain({ cargo: lots, services }) });
  for (const row of h.storage.resources) row.roomId = "outdoors";
  const reloaded = normalizeSkyholdData(data), saved = reloaded.holdings[0];
  assert.equal(preflightMarketOutboundDispatch({ resources: saved.storage.resources, cargoReservations: saved.special.transportV2.orders[0].cargo }).ok, true,
    "normalization preserves the row and batch referenced by the transport contract");
  assert.deepEqual(saved.special.transportV2.orders[0].plan, order.plan);
}

// A4: reconstruct all balances, not just the first holding's dated recovery lots.
for (const legacy of [false, true]) {
  const data = { meta: {}, holdings: [holding("a"), holding("b")] }, key = marketDemandKey("port", "wood");
  for (const h of data.holdings) {
    const r = reserveMarketDemand({ holding: h, marketId: "port", operationId: h.id,
      lines: [{ demandId: "wood", qty: 10, demandBaseDemand: 100, demandStateRevision: 0 }] });
    assert.equal(settleMarketDemandReservations({ holding: h, reservations: r.reservations,
      operationId: `${h.id}-sold`, outcome: "consumed", occurredTenday: 0 }).ok, true);
  }
  if (legacy) delete data.holdings[1].special.market.demand[key].recoveryLots;
  const before = structuredClone(data), preview = previewSharedMarketMigration(data);
  assert.deepEqual(data, before, "only the prepared draft is inspected");
  assert.equal(preview.prepared.demand[key].consumedOutstanding, 20);
  data.meta.sharedMarkets = { ...preview.prepared, demand: normalizeMarketDemandState(preview.prepared.demand) };
  bindSharedMarkets(data);
  recoverMarketDemand({ holding: data.holdings[0], currentTenday: 0 });
  assert.equal(data.meta.sharedMarkets.demand[key].consumedOutstanding, 20);
  recoverMarketDemand({ holding: data.holdings[0], currentTenday: 1 });
  const remaining = data.meta.sharedMarkets.demand[key].consumedOutstanding;
  assert.ok(remaining > 0 && remaining < 20);
  recoverMarketDemand({ holding: data.holdings[1], currentTenday: 1 });
  assert.equal(data.meta.sharedMarkets.demand[key].consumedOutstanding, remaining);
}

// A5: the local market is a real handling endpoint, distinct from its holding's warehouse.
for (const direction of ["inbound", "outbound"]) for (const kind of ["regular", "charter"]) {
  const f = world();
  f.holding.storage.resources = [{ id: "stock", resourceId: "test-freight", qty: 10, forSale: true,
    batches: [{ id: "old", qty: 5, ageQd: 4 }, { id: "new", qty: 5, ageQd: 0 }] }];
  const market = prepareMarketAuthorityContext({ ...f, isGM: true }).markets.find(row => row.regionId === "home");
  const offer = prepareMarketAuthorityContext({ ...f, marketId: market.id, isGM: true }).quote.offers.find(row => row.resourceId === "test-freight");
  const request = { direction, marketId: market.id, quantities: { [direction === "outbound" ? "test-freight" : offer.id]: 10 }, insurance: false };
  f.data.catalog.marketEconomy.settings = { handlingFlatCopper: 0, handlingLoadCopper: 0 };
  const q = prepareTransportContext({ ...f, request, isGM: true });
  request.serviceIds = [q.services.find(row => row.from === q.from && row.to === q.to && row.kind === kind).id];
  const before = prepareTransportContext({ ...f, request, isGM: true });
  f.data.catalog.marketEconomy.settings = { handlingFlatCopper: 10000, handlingLoadCopper: 1000 };
  const after = prepareTransportContext({ ...f, request, isGM: true });
  assert.ok(after.plan.totalCopper > before.plan.totalCopper);
  const split = after.plan.cargo.flatMap(lot => Array.from({ length: lot.qty }, (_, i) => ({ ...lot, qty: 1, lotId: `${lot.lotId}-${i}` })));
  assert.equal(planTransportChain({ cargo: split, services: after.plan.stages.map(row => row.service) }).totalCopper, after.plan.totalCopper);
}

// A6: money limits apply to cargo/revenue even if the buyer pays no insurance or tax upfront.
assert.equal(cargoValue([{ qty: 1, unitCopper: MAX_MARKET_OPERATION_COPPER }]), MAX_MARKET_OPERATION_COPPER);
assert.throws(() => cargoValue([{ qty: 1, unitCopper: MAX_MARKET_OPERATION_COPPER + 1 }]), /стоимость/);
for (const isGM of [true, false]) for (const direction of ["inbound", "outbound"]) {
  const f = world();
  f.data.catalog.marketEconomy.baseOffers[0].priceOverrideCopper = 1000000;
  f.data.catalog.marketEconomy.baseOffers[0].baseStock = 10000;
  f.data.catalog.marketEconomy.baseOffers[0].baseDemand = 10000;
  f.data.catalog.marketEconomy.countries[0].taxRate = 0;
  f.holding.storage.resources = [{ id: "stock", resourceId: "test-freight", qty: 2000, forSale: true,
    batches: [{ id: "batch", qty: 2000, ageQd: 0 }] }];
  const market = prepareMarketAuthorityContext({ ...f, isGM }).markets.find(row => row.regionId === "a");
  const offer = prepareMarketAuthorityContext({ ...f, marketId: market.id, isGM }).quote.offers.find(row => row.resourceId === "test-freight");
  const request = { direction, marketId: market.id, quantities: { [direction === "inbound" ? offer.id : "test-freight"]: 2000 }, insurance: false };
  const before = structuredClone(f.data), sourceToken = transportSourceToken(f.data, f.holding);
  assert.throws(() => prepareTransportContext({ ...f, request, isGM }), /стоимость груза/);
  const execute = createTransportOperationExecutor({ getUser: () => ({ id: "user", isGM }), workflow: () => ({}),
    transaction: async updater => updater(f.data, { skip: value => value }) });
  await assert.rejects(execute({ type: "transport-book", operationId: "money-limit", holdingId: f.holding.id,
    expectedRevision: f.data.meta.revision, sourceToken, planToken: "invalid-large-cargo", request }, { userId: "user", remote: !isGM }), /стоимость груза/);
  assert.deepEqual(f.data, before, "cash, stock and demand are unchanged even before a transaction rollback");
}

// B1: both rebooking paths retain their old reservations when the complete horizon is occupied.
for (const shuttle of [false, true]) {
  const a = holding("waiting"), b = holding("other-owner"), state = { version: 2, clockQd: 0, runs: [] };
  const next = shuttle ? service({ id: "charter", kind: "charter", vehicles: 1, firstQd: 0, returnQd: 4, riskBps: 10000 })
    : service({ id: "connection", from: "B", to: "C", firstQd: 12 });
  const order = book(state, a, "delayed", shuttle ? [next] : [service({ riskBps: 10000 }), next], shuttle ? 20 : 10);
  advanceTransportOrders({ state, holding: a, targetQd: 200, dependencies });
  resolveTransportIncident(state, state.runs[0].id, { outcome: "success", atQd: 200 });
  const blocker = book(state, b, "blocks-horizon", [next], shuttle ? 1800 : 360, shuttle ? 204 : 200);
  const healthy = book(state, a, "healthy", [service({ id: "independent", firstQd: 0, intervalQd: 1 })], 1);
  const reservations = structuredClone(state.runs), stages = structuredClone(order.stages), escrow = order.money.escrowCopper;
  advanceTransportOrders({ state, holding: a, targetQd: 210, dependencies });
  assert.equal(order.status, "waitingCarrier"); assert.ok(order.replanFailure);
  assert.equal(healthy.status, "delivered", "one unavailable chain does not block another order");
  assert.equal(order.money.escrowCopper, escrow, "failed rebooking does not spend or refund the reserved leg");
  assert.deepEqual(order.stages.map(stage => stage.runs), stages.map(stage => stage.runs));
  for (const run of reservations.filter(row => row.claims.some(claim => claim.orderId === order.id))) {
    assert.deepEqual(state.runs.find(row => row.id === run.id).claims, run.claims, "every original claim survives failed planning");
  }
  const historyCount = order.history.filter(row => row.kind === "rebooking-wait").length;
  advanceTransportOrders({ state, holding: a, targetQd: 210, dependencies });
  assert.equal(order.history.filter(row => row.kind === "rebooking-wait").length, historyCount);
  cancelTransportOrder({ state, holding: b, order: blocker });
  advanceTransportOrders({ state, holding: a, targetQd: 250, dependencies });
  // A charter's second physical run can roll its own incident; it must be resolvable after rebooking.
  for (const run of state.runs.filter(row => row.incident?.status === "pending")) resolveTransportIncident(state, run.id, { outcome: "success" });
  advanceTransportOrders({ state, holding: a, targetQd: 250, dependencies });
  assert.equal(order.status, "delivered"); assert.equal(order.replanFailure, undefined);
  assert.equal(order.received.reduce((sum, lot) => sum + lot.qty, 0), shuttle ? 20 : 10);
}
assert.throws(() => planTransportChain({ cargo: cargo(513), services: [service({ capacity: 4000, intervalQd: 1 })] }),
  error => error instanceof TransportPlanningUnavailableError && error.code === "run-limit");

// A8: both read models agree with the existing authority lock throughout a transport assignment.
for (const isGM of [true, false]) {
  const f = world();
  f.holding.gm.playersCanEditResidents = true;
  globalThis.game = { user: { id: "user", isGM }, users: [{ id: "gm", isGM: true, active: true }], socket: { emit() {} } };
  const order = { id: "transport-ship", stageIndex: 0, stages: [{}], status: "travelling" };
  f.holding.special.transportV2 = { orders: [order] }; f.ship.transportOrderId = order.id;
  f.ship.status = "away"; f.ship.location = { kind: "transit", id: order.id, regionId: "home" };
  for (const phase of ["travelling", "funding", "arrived", "released"]) {
    if (phase === "funding") order.fundingNeededCopper = 100;
    if (phase === "arrived") { order.shipArrived = true; f.ship.location = { kind: "market", id: "a", regionId: "a" }; }
    if (phase === "released") { order.shipReleased = true; delete f.ship.transportOrderId; }
    const before = structuredClone(f.data);
    const overview = prepareShipsContext(f.holding, { data: f.data }).rows[0];
    const detail = prepareShipWindowContext(f.holding, { data: f.data, shipId: f.ship.id }).rows[0];
    assert.deepEqual(f.data, before); assert.equal(overview.statusLabel, detail.statusLabel);
    if (phase === "released") { assert.equal(detail.canGenerateWorld, true); assert.equal(detail.canManageResidents, true); }
    else {
      for (const key of ["canGenerateWorld", "canRerollWorld", "canDepartOffer", "canDepartBundle", "canReturnHome", "canRelocate", "canEditPlan", "canConfigureCrew", "canAdjust", "canManageResidents"]) assert.equal(detail[key], false, key);
      assert.ok(detail.transportStageText); assert.match(detail.nextAction, /Перевозки/);
      assert.notEqual(detail.statusLabel, "В чужом порту");
    }
  }
}
console.log("Transport system boundaries: deletion, recovery migration draft, local handling, GM/player money limits, atomic rebooking/retry and ship read models passed.");
