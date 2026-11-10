import assert from "node:assert/strict";
import { transportFixture, transportRequest, transportHarness, transportWorkflow } from "./fixtures/transport-v2.mjs";
import { prepareTransportContext } from "../apps/domains/transport-context.js";
import { transportServicesFromRoutes } from "../engines/transport/services.js";
import { advanceTransportShipments } from "../workflows/transport/orders.js";
import { normalizeSkyholdData } from "../data/normalizers.js";
import { planTransportChain } from "../engines/transport/planner.js";
import { bookTransportOrder } from "../engines/transport/runtime.js";
import { transportServicesShareFleet } from "../engines/transport/service-identity.js";
import { transportRefinements } from "../apps/domains/transport-view.js";

function fixture() {
  const f = transportFixture();
  f.holding.people.list = []; f.holding.special.ships.list = [];
  f.holding.gm.modifiers.marketLocalDistanceKm = 0;
  const far = structuredClone(f.holding);
  far.id = "far-holding"; far.name = "Far holding";
  far.gm.modifiers.marketLocalDistanceKm = 400;
  f.data.holdings.push(far);
  return f;
}

let scenarios = 0;
for (const isGM of [true, false]) for (const direction of ["inbound", "outbound"]) {
  for (const kind of ["regular", "charter"]) for (const reverse of [false, true]) {
    const f = fixture(), h = transportHarness(f);
    const holdingIds = h.data.holdings.map(row => row.id);
    const requests = new Map(), expected = new Map();
    for (const holding of h.data.holdings) {
      const request = transportRequest({ data: h.data, holding }, "home", { direction }, isGM);
      const quote = prepareTransportContext({ data: h.data, holding, request, isGM });
      request.serviceIds = [quote.services.find(service => service.kind === kind).id];
      requests.set(holding.id, request);
      expected.set(holding.id, prepareTransportContext({ data: h.data, holding, request, isGM }).plan);
    }
    assert.notEqual(expected.get(holdingIds[0]).stages[0].service.id, expected.get(holdingIds[1]).stages[0].service.id,
      "different warehouses in the same region are different physical services");
    const accepted = [];
    for (const id of reverse ? [...holdingIds].reverse() : holdingIds) {
      const holding = h.data.holdings.find(row => row.id === id), request = requests.get(id);
      const quote = prepareTransportContext({ data: h.data, holding, request, isGM });
      assert.deepEqual(quote.plan, expected.get(id), "another warehouse's booking cannot change this local journey");
      const operation = { type: "transport-book", operationId: `warehouse-${kind}-${direction}-${isGM}-${id}`,
        holdingId: id, expectedRevision: h.data.meta.revision, sourceToken: quote.sourceToken, planToken: quote.planToken, request };
      assert.equal((await h.execute(operation, { userId: isGM ? "gm" : "player", remote: !isGM })).ok, true);
      const after = structuredClone(h.data);
      assert.equal((await h.execute(operation, { userId: isGM ? "gm" : "player", remote: !isGM })).replay, true);
      assert.deepEqual(h.data, after);
      accepted.push({ id, orderId: operation.operationId, plan: quote.plan });
    }
    const reloaded = normalizeSkyholdData(JSON.parse(JSON.stringify(h.data)));
    const target = Math.max(...accepted.map(row => row.plan.arrivalQd));
    for (const { id, orderId, plan } of accepted) {
      const holding = reloaded.holdings.find(row => row.id === id);
      advanceTransportShipments(reloaded, holding, target, transportWorkflow);
      const order = holding.special.transportV2.orders.find(row => row.id === orderId);
      assert.equal(order.status, "delivered");
      assert.equal(order.received.reduce((sum, lot) => sum + lot.qty, 0), 10);
      assert.equal(order.stages[0].receipts[0].arrivalQd, plan.stages[0].runs[0].arrivalQd);
      assert.deepEqual(order.plan, plan, "loading and execution preserve each accepted distance and schedule");
    }
    scenarios++;
  }
}

// Only the actual warehouse end is private to a holding; a regional feeder
// still has shared capacity and one physical outcome across settlements.
for (const direction of ["inbound", "outbound"]) {
  const leg = (fromRegionId, toRegionId, carrierId) => ({ fromRegionId, toRegionId, carrierId, carrierLabel: carrierId,
    mode: "caravan", modeLabel: "caravan", capacityLoad: 100, movementQd: 1, distanceKm: 40,
    dispatchCopper: 0, hireCopper: 0, distanceCopper: 0, operatingCopper: 0, loadCopperPerUnit: 0 });
  const local = { ...leg("home", "home", "last"), kind: "last-mile" };
  const legs = direction === "inbound" ? [leg("a", "home", "feeder"), local] : [local, leg("home", "a", "feeder")];
  const routes = [{ transportPlan: { direction, legs } }];
  const services = ["one", "two"].map(holdingId => transportServicesFromRoutes(routes, {}, [],
    { holdingId, homeRegionId: "home", homeEndpoint: "home:holding" }));
  for (const kind of ["regular", "charter"]) {
    const feeder = services.map(rows => rows.find(row => row.companyId === "feeder" && row.kind === kind));
    const local = services.map(rows => rows.find(row => row.companyId === "last" && row.kind === kind));
    assert.equal(feeder[0].id, feeder[1].id, "the shared regional line keeps its common identity");
    assert.notEqual(local[0].id, local[1].id, "the warehouse service identifies its actual settlement");
  }
  const regional = ["one", "two"].map(holdingId => transportServicesFromRoutes([
    { transportPlan: { direction, legs: legs.filter(row => row.kind !== "last-mile") } }
  ], {}, [], { holdingId, homeRegionId: "home", homeEndpoint: "home:holding" }));
  assert.deepEqual(regional[0], regional[1], "attaching a holding's display endpoint does not privatize a regional arrival");
}

// Both previous generations of IDs remain readable. An older ambiguous booking
// conservatively occupies either warehouse service until its transport is free;
// it is never rekeyed, merged with a new manifest, or silently made unoccupied.
for (const kind of ["regular", "charter"]) for (const generation of ["regional", "group"]) {
  const f = fixture(), h = transportHarness(f), request = transportRequest(h.fixture(), "home");
  const initial = prepareTransportContext({ data: h.data, holding: h.holding, request, isGM: true });
  const service = initial.services.find(row => row.kind === kind);
  const regionalId = service.id.split(":holding:")[0], groupId = regionalId.split(":route:")[0];
  const previousId = generation === "regional" ? regionalId : groupId;
  const legacy = { ...structuredClone(service), id: previousId };
  const plan = planTransportChain({ cargo: initial.plan.cargo, services: [legacy] });
  const order = bookTransportOrder({ state: h.data.meta.transportV2, holding: h.holding, services: [legacy], plan,
    id: `older-${kind}-${generation}`, direction: "inbound" });
  const physical = structuredClone(h.data.meta.transportV2.runs);
  for (const holding of h.data.holdings) {
    const selectedRequest = transportRequest({ data: h.data, holding }, "home", { serviceIds: [previousId] });
    const before = structuredClone(selectedRequest);
    const quoted = prepareTransportContext({ data: h.data, holding, request: selectedRequest, isGM: true });
    const selected = quoted.plan.stages[0].service;
    assert.ok(selected.id.includes(`:holding:${holding.id}`));
    assert.equal(transportServicesShareFleet(selected.id, previousId), true);
    assert.ok(quoted.plan.stages[0].runs[0].startQd >= (kind === "regular" ? plan.stages[0].runs[0].startQd + service.intervalQd
      : plan.stages[0].runs[0].releaseQd), "old booking still occupies the transport time");
    assert.deepEqual(selectedRequest, before, "resolving an old choice is read-only");
    const refinements = transportRefinements(quoted.services, { pins: { [selected.from]: previousId } });
    assert.equal(refinements.groups.find(row => row.from === selected.from).options.find(row => row.selected)?.value, selected.id);
    const excluded = prepareTransportContext({ data: h.data, holding,
      request: { ...selectedRequest, serviceIds: undefined, excluded: [previousId] }, isGM: true });
    assert.ok(excluded.plan.stages.every(stage => stage.service.kind !== kind), "old exclusions cover their warehouse successors");
  }
  assert.deepEqual(h.data.meta.transportV2.runs, physical);
  assert.deepEqual(order.plan, plan);
  const loaded = normalizeSkyholdData(JSON.parse(JSON.stringify(h.data)));
  assert.deepEqual(loaded.meta.transportV2.runs, physical);
  assert.deepEqual(loaded.holdings[0].special.transportV2.orders[0].plan, plan);
  h.data.catalog.transportV2.overrides = { [groupId]: { riskBps: 111 }, [regionalId]: { riskBps: 222 }, [service.id]: { riskBps: 333 } };
  const quote = () => prepareTransportContext({ data: h.data, holding: h.holding, request, isGM: true }).services.find(row => row.kind === kind);
  assert.equal(quote().riskBps, 333, "warehouse override wins over inherited regional/group settings");
  delete h.data.catalog.transportV2.overrides[service.id]; assert.equal(quote().riskBps, 222);
  delete h.data.catalog.transportV2.overrides[regionalId]; assert.equal(quote().riskBps, 111);
}
console.log(`Transport warehouse endpoints: ${scenarios} real GM/player bookings, both directions/orders/fleets, local dates, reload/replay, shared regional lines and two generations of accepted IDs/settings/pins/exclusions passed.`);
