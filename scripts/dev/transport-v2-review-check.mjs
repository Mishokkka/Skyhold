import assert from "node:assert/strict";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { ensureTransportState } from "../data/transport/state.js";
import { prepareTransportContext } from "../apps/domains/transport-context.js";
import { prepareMarketAuthorityContext } from "../apps/market/authority-context.js";
import { planTransportChain, findTransportPlans, validateTransportPlan } from "../engines/transport/planner.js";
import { transportServicesFromRoutes } from "../engines/transport/services.js";
import { bookTransportOrder, advanceTransportOrders, resolveTransportIncident } from "../engines/transport/runtime.js";
import { advanceTransportShipments } from "../workflows/transport/orders.js";
import { reserveMarketDemand } from "../engines/market/demand.js";
import { marketDemandKey } from "../data/market/demand-state.js";
import { resourceBatchAvailableToInternalDemand } from "../core/resource-batches.js";
import { bindSharedMarkets, marketStateFor, sharedMarketEventTenday } from "../data/market/shared-context.js";
import { normalizeSkyholdData } from "../data/normalizers.js";

const failures = [];
async function check(name, test) {
  try { await test(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
const service = (id = "regular", extra = {}) => ({ id, from: "A", to: "D", kind: "regular", capacity: 40000,
  firstQd: 4, intervalQd: 40, travelQd: 4, dispatchCopper: 1, ...extra });
const lot = (id = "cloth", qty = 2) => ({ lotId: id, resourceId: "test-freight", qty, unitLoad: 4000, unitCopper: 5, ageQd: 0 });
const holding = id => ({ id, storage: { moneyCopper: 1000000, resources: [], items: [], log: [] }, special: {}, gm: { calendaria: { lastQd: 0 } } });
function world() {
  const fixture = worldMarketFixture();
  fixture.holding.type = "village"; fixture.holding.gm.modifiers.marketConnectionsLevel = 6; fixture.ship.crewTarget = 1;
  ensureTransportState(fixture.data);
  const authority = prepareMarketAuthorityContext({ ...fixture, marketId: "a", isGM: true });
  const offer = authority.quote.offers.find(row => row.resourceId === "test-freight");
  return { ...fixture, request: { direction: "inbound", marketId: authority.market.id, quantities: { [offer.id]: 10 }, insurance: false } };
}

await check("R1 period arrivals defer internal sale of resources and Items", () => {
  for (const sourceType of ["resource", "item"]) {
    const h = holding(sourceType), data = { holdings: [h], meta: {} }, state = ensureTransportState(data);
    const cargo = [{ ...lot(), sourceType, item: { name: "Snapshot" } }], services = [service()];
    bookTransportOrder({ state, holding: h, plan: planTransportChain({ cargo, services }), services, id: sourceType, direction: "inbound" });
    let availableFrom;
    advanceTransportShipments(data, h, 40, { _appendStorageLog() {}, _storageAddWithOverflow(_h, row) {
      availableFrom = row.batches[0].internalDemandAvailableFromQd;
    } }, { deferInternalDemand: true });
    if (sourceType === "item") availableFrom = h.storage.items[0].internalDemandAvailableFromQd;
    assert.equal(resourceBatchAvailableToInternalDemand({ internalDemandAvailableFromQd: availableFrom }, h), false);
    assert.equal(availableFrom, 40);
  }
});

await check("R2 intermediate pins remain mandatory across cheaper bypasses", () => {
  const services = [service("direct"), service("via", { to: "B", dispatchCopper: 10 }),
    service("pinned", { from: "B", dispatchCopper: 10 })];
  const result = findTransportPlans({ from: "A", to: "D", cargo: [lot()], services, pins: { B: "pinned" } });
  assert.ok(result.plans.length > 0);
  assert.ok(result.plans.every(plan => plan.stages.some(stage => stage.service.id === "pinned")));
  const bypass = planTransportChain({ cargo: [lot()], services: [services[0]] });
  assert.throws(() => validateTransportPlan(bypass, { services, pins: { B: "pinned" } }), /закрепления/);
  assert.equal(findTransportPlans({ from: "A", to: "D", cargo: [lot()], services, pins: { B: "missing" } }).plans.length, 0);
  const fixture = world(), quote = prepareTransportContext({ ...fixture, isGM: true });
  for (const isGM of [true, false]) assert.throws(() => prepareTransportContext({ ...fixture, isGM,
    request: { ...fixture.request, serviceIds: quote.plan.stages.map(stage => stage.service.id), pins: { unused: "missing" } } }), /закрепления/);
});

await check("R3 collapsing transit nodes retains the maximum route risk", () => {
  const leg = (from, to, riskFactor) => ({ fromRegionId: from, toRegionId: to, fromCountryId: "country", toCountryId: "country",
    carrierId: "company", mode: "airship", capacityLoad: 10, movementQd: 2, distanceKm: 10,
    dispatchCopper: 1, hireCopper: 1, distanceCopper: 10, operatingCopper: 2, loadCopperPerUnit: 1, riskFactor, routeId: `${from}:${to}` });
  for (const risks of [[1, 4], [4, 1]]) {
    const services = transportServicesFromRoutes([{ transportPlan: { direction: "inbound", legs: [leg("A", "B", risks[0]), leg("B", "D", risks[1])] } }]);
    assert.ok(services.every(row => row.riskBps === 1200));
  }
});

await check("R4 configured handling reaches regular, charter and owned invoices", () => {
  for (const kind of ["regular", "charter", "owned"]) {
    const fixture = world();
    if (kind === "owned") fixture.request.ownShipId = fixture.ship.id;
    fixture.data.catalog.marketEconomy.settings = { handlingFlatCopper: 0, handlingLoadCopper: 0 };
    const first = prepareTransportContext({ ...fixture, isGM: true });
    const selected = first.services.find(row => row.from === first.from && row.to === first.to && row.kind === kind);
    assert.ok(selected);
    const request = { ...fixture.request, serviceIds: [selected.id] };
    const before = prepareTransportContext({ ...fixture, request, isGM: true });
    fixture.data.catalog.marketEconomy.settings = { handlingFlatCopper: 10000, handlingLoadCopper: 1000 };
    const after = prepareTransportContext({ ...fixture, request, isGM: true });
    assert.ok(after.plan.totalCopper > before.plan.totalCopper, `${kind}: handling must affect the invoice`);
    assert.ok(after.plan.stages[0].runs[0].charge.handlingCopper > 0);
    const divided = after.plan.cargo.flatMap(row => [{ ...row, lotId: row.lotId + "a", qty: 1 }, { ...row, lotId: row.lotId + "b", qty: row.qty - 1 }]);
    const repartitioned = planTransportChain({ cargo: divided, services: after.plan.stages.map(stage => stage.service) });
    assert.equal(repartitioned.totalCopper, after.plan.totalCopper, "handling is charged per physical departure, not per child lot");
    const frozen = structuredClone(after.plan);
    fixture.data.catalog.marketEconomy.settings.handlingFlatCopper = 0;
    assert.deepEqual(after.plan, frozen, "accepted terms are detached from current catalog edits");
  }
});

await check("R5 one physical partial loss conserves units across FIFO splits", () => {
  for (const cargo of [[lot("all", 2)], [lot("older", 1), lot("newer", 1)]]) {
    const h = holding("loss"), state = { version: 2, clockQd: 0, runs: [] }, services = [service("risky", { riskBps: 10000 })];
    const order = bookTransportOrder({ state, holding: h, plan: planTransportChain({ cargo, services }), services, id: "loss", direction: "inbound" });
    const dependencies = { receiveCargo() {} };
    advanceTransportOrders({ state, holding: h, targetQd: 8, dependencies });
    resolveTransportIncident(state, state.runs[0].id, { outcome: "loss", lossBps: 5000 });
    advanceTransportOrders({ state, holding: h, targetQd: 8, dependencies });
    assert.equal(order.lostQty, 1);
    assert.equal(order.received.reduce((sum, row) => sum + row.qty, 0), 1);
  }
});

await check("R5 shared incident is stable across holdings, order, reload and replay", () => {
  const scenarios = [];
  for (const reversed of [false, true]) {
    const left = holding("left"), right = holding("right"), state = { version: 2, clockQd: 0, runs: [] };
    const services = [service("shared-loss", { riskBps: 10000 })];
    for (const h of [left, right]) bookTransportOrder({ state, holding: h,
      plan: planTransportChain({ cargo: [lot("single", 1)], services, runs: state.runs }), services, id: h.id, direction: "inbound" });
    const dependencies = { receiveCargo() {} }, holdings = reversed ? [right, left] : [left, right];
    advanceTransportOrders({ state, holding: holdings[0], targetQd: 8, dependencies });
    resolveTransportIncident(state, state.runs[0].id, { outcome: "loss", lossBps: 5000 });
    // The second holding need not have been advanced before the GM's single physical decision.
    const reloaded = JSON.parse(JSON.stringify({ state, holdings }));
    for (const h of reloaded.holdings) advanceTransportOrders({ state: reloaded.state, holding: h, targetQd: 8, dependencies });
    const snapshot = structuredClone(reloaded);
    for (const h of reloaded.holdings) advanceTransportOrders({ state: reloaded.state, holding: h, targetQd: 8, dependencies });
    assert.deepEqual(reloaded, snapshot);
    const losses = reloaded.holdings.map(h => [h.id, h.special.transportV2.orders[0].lostQty]).sort();
    assert.equal(losses.reduce((sum, row) => sum + row[1], 0), 1);
    scenarios.push(losses);
  }
  assert.deepEqual(scenarios[0], scenarios[1]);
});

await check("R6 partial external sales recover demand before the last arrival", () => {
  const h = holding("sale"), data = { holdings: [h], meta: {} }, state = ensureTransportState(data);
  h.storage.resources = [{ id: "stock", resourceId: "test-freight", qty: 20, batches: [{ id: "batch", qty: 20, ageQd: 0 }] }];
  const cargo = [{ ...lot("sale", 20), rowId: "stock", batchId: "batch" }];
  const services = [service("slow", { intervalQd: 400 })];
  const demand = reserveMarketDemand({ holding: h, marketId: "port", operationId: "demand", lines: [
    { resourceId: "test-freight", qty: 20, demandBaseDemand: 20, demandStateRevision: 0 }] });
  assert.equal(demand.ok, true);
  const order = bookTransportOrder({ state, holding: h, plan: planTransportChain({ cargo, services }), services,
    id: "sale", direction: "outbound", commercial: { marketId: "port" } });
  order.demandReservations = demand.reservations;
  advanceTransportShipments(data, h, 400, { _appendStorageLog() {} });
  assert.equal(order.received.reduce((sum, row) => sum + row.qty, 0), 10);
  const row = h.special.market.demand[marketDemandKey("port", "test-freight")];
  assert.equal(row.reservedDemand, 10);
  assert.equal(row.availableDemand, 10, "the ten sold units have already recovered after ten tendays");
});

await check("R6 recovery dates survive shared-clock advancement and calendar step size", () => {
  function scenario(steps, reverse) {
    const data = { meta: { sharedMarkets: { enabled: true, clockTenday: 0, demand: {}, stock: {} } }, holdings: [holding("left"), holding("right")] };
    bindSharedMarkets(data);
    const state = ensureTransportState(data);
    for (const [index, h] of data.holdings.entries()) {
      h.storage.resources = [{ id: "stock", resourceId: "test-freight", qty: 10, batches: [{ id: "batch", qty: 10, ageQd: 0 }] }];
      const existing = marketStateFor(h, "demand")[marketDemandKey("port", "test-freight")];
      const demand = reserveMarketDemand({ holding: h, marketId: "port", operationId: h.id,
        lines: [{ resourceId: "test-freight", qty: 10, demandBaseDemand: 20, demandStateRevision: existing?.revision ?? 0 }] });
      assert.equal(demand.ok, true);
      const services = [service(`sale-${index}`, { firstQd: index ? 84 : 4 })];
      const order = bookTransportOrder({ state, holding: h, services,
        plan: planTransportChain({ cargo: [{ ...lot("cargo", 10), rowId: "stock", batchId: "batch" }], services, runs: state.runs }),
        id: h.id, direction: "outbound", commercial: { marketId: "port" } });
      order.demandReservations = demand.reservations;
    }
    const execution = reverse ? [...data.holdings].reverse() : data.holdings;
    for (const qd of steps) for (const h of execution) advanceTransportShipments(data, h, qd, { _appendStorageLog() {} });
    const row = data.meta.sharedMarkets.demand[marketDemandKey("port", "test-freight")];
    assert.deepEqual(normalizeSkyholdData(data).meta.sharedMarkets.demand, data.meta.sharedMarkets.demand);
    return { available: row.availableDemand, consumed: row.consumedOutstanding, reserved: row.reservedDemand, lots: row.recoveryLots };
  }
  const small = scenario([40, 80, 120, 160], false);
  assert.deepEqual(scenario([160], false), small);
  assert.deepEqual(scenario([160], true), small);
});

await check("R6 actual receipt dates preserve the phase of the stored calendar", () => {
  const h = holding("dated");
  h.gm.calendaria.lastDateTime = { year: 1, month: 1, day: 9 };
  bindSharedMarkets({ holdings: [h], meta: { sharedMarkets: { enabled: true, clockTenday: 100 } } });
  assert.equal(sharedMarketEventTenday(h, 8), 25, "a two-day journey crosses the dated tenday boundary");
  h.gm.calendaria.lastQd = 40;
  h.gm.calendaria.lastDateTime.day = 19;
  assert.equal(sharedMarketEventTenday(h, 8), 25, "a later processing date cannot move the original receipt");
});

await check("R6 partial loss and later spoilage release only the corresponding demand", () => {
  const h = holding("lost-sale"), data = { holdings: [h], meta: {} }, state = ensureTransportState(data);
  h.storage.resources = [{ id: "stock", resourceId: "test-freight", qty: 20, batches: [{ id: "batch", qty: 20, ageQd: 0 }] }];
  const cargo = [{ ...lot("cargo", 20), rowId: "stock", batchId: "batch", shelfLifeQd: 20 }];
  const services = [service("loss-and-expiry", { intervalQd: 400, riskBps: 10000 })];
  const reservation = reserveMarketDemand({ holding: h, marketId: "port", operationId: "demand",
    lines: [{ resourceId: "test-freight", qty: 20, demandBaseDemand: 20, demandStateRevision: 0 }] });
  const order = bookTransportOrder({ state, holding: h, services, plan: planTransportChain({ cargo, services }),
    id: "loss-and-expiry", direction: "outbound", commercial: { marketId: "port" } });
  order.demandReservations = reservation.reservations;
  const advance = qd => advanceTransportShipments(data, h, qd, { _appendStorageLog() {} });
  advance(8);
  resolveTransportIncident(state, order.stages[0].runs[0].id, { outcome: "loss", lossBps: 5000 });
  advance(8);
  let demand = marketStateFor(h, "demand")[marketDemandKey("port", "test-freight")];
  assert.equal(demand.reservedDemand, 10);
  assert.equal(demand.consumedOutstanding, 5);
  assert.equal(demand.availableDemand, 5, "lost cargo releases demand at its receipt without consuming it");
  advance(408);
  resolveTransportIncident(state, order.stages[0].runs[1].id, { outcome: "success" });
  advance(408);
  demand = marketStateFor(h, "demand")[marketDemandKey("port", "test-freight")];
  assert.equal(demand.reservedDemand, 0);
  assert.equal(demand.availableDemand, 20);
  assert.equal(order.spoiledQty, 10);
  assert.equal(order.received.reduce((sum, row) => sum + row.qty, 0), 5);
  const settled = structuredClone(data);
  advance(408);
  assert.deepEqual(data, settled);
});

await check("R7 the empty approach observes the settlement access limit", () => {
  const fixture = world();
  fixture.ship.location = { kind: "market", regionId: "b" };
  fixture.data.catalog.eventRegions.find(row => row.value === "a").marketLinks[0].ursCost = 10;
  assert.throws(() => prepareTransportContext({ ...fixture,
    request: { ...fixture.request, ownShipId: fixture.ship.id }, isGM: true }), /Пустой перегон/);
});

await check("R7 only required empty paths consume an independent access budget", () => {
  const owned = service("owned", { kind: "owned", shipId: "ship", vehicles: 1, capacity: 4000,
    accessCost: 1, emptyAccessLimit: 6, approachAccessCost: 0, returnAccessCost: 10, returnQd: 4,
    endReturnAccessCost: 10, endReturnQd: 4 });
  assert.doesNotThrow(() => planTransportChain({ cargo: [lot("one", 1)], services: [owned] }), "one-way delivery needs no empty return");
  assert.throws(() => planTransportChain({ cargo: [lot("two", 2)], services: [owned] }), /Пустой перегон/);
  assert.throws(() => planTransportChain({ cargo: [lot("one", 1)], services: [{ ...owned, returnAtEnd: true }] }), /Пустой перегон/);
  assert.doesNotThrow(() => planTransportChain({ cargo: [lot("many", 4)], services: [{ ...owned, returnAccessCost: 4 }] }),
    "repeated valid shuttles do not add their access costs together");
});

if (failures.length) process.exitCode = 1;
else console.log("Transport v2 review regressions passed.");
