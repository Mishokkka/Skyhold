import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeEventRegionOptions } from "../data/random-events.js";
import { normalizeMarketOrganization } from "../data/market/economy.js";
import { planMarketTransport } from "../engines/market/transport-planner.js";
import { marketTransportFreightFactor, planMarketPurchase } from "../engines/market/pricing.js";
import { carrierProvidersForRoute } from "../engines/market/providers.js";
import { MARKET_DEFAULT_TRANSPORT_CAPACITY_LOAD, MARKET_TRANSPORT_TARIFFS } from "../engines/market/logistics.js";

const MODES = ["caravan", "rail", "airship"];
function company(id, countryIds, modes = MODES, terms = {}) {
  return normalizeMarketOrganization({ id, label: id, active: true, visibility: "public", carrier: {
    enabled: true, modes, priceFactor: 1, timeFactor: 1, riskFactor: 1, capacityFactor: 1,
    countryShares: countryIds.map((countryId) => ({ countryId, sharePct: 100 })), ...terms
  } });
}
function node(value, countryId, marketLinks = [], extra = {}) {
  return { value, label: value, countryId, marketLandmassId: "mainland", marketTransportModes: MODES, marketLinks, ...extra };
}
const edge = (regionId, modes, distanceKm = 40, extra = {}) => ({ regionId, modes, distanceKm, ursCost: 1, ...extra });
function fixture(regions, organizations, extra = {}) {
  return {
    holding: { id: "home", name: "Дом", type: "village", overview: { region: "h" },
      gm: { modifiers: { marketConnectionsLevel: 8 } }, storage: { moneyCopper: 1_000_000_000 } },
    market: { id: "m", regionId: "m", countryId: regions.find((row) => row.value === "m").countryId,
      transportModes: MODES, airshipHireCopper: 120 },
    regions: normalizeEventRegionOptions(regions, { fallback: false }), organizations, isGM: true,
    ...extra
  };
}
function purchase(input, { qty = 2, load = 1, price = 1, serviceLevel = "standard", ...selection } = {}) {
  const result = planMarketTransport({ ...input, ...selection });
  const plan = planMarketPurchase({ holding: input.holding, serviceLevel, quantities: { cargo: qty }, quote: {
    offers: [{ id: "cargo", stock: qty, unitPriceCopper: price, load }], location: {}, logistics: result.logistics,
    deliveryMode: "scheduled", deliveryBaseQd: 1, deliveryQd: 1 + Number(result.logistics?.travelQd || 0)
  } });
  return { ...result, plan };
}
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-7, `${message}: ${actual} != ${expected}`);
const legsOf = (result) => result.plan.logistics.transportPlan.legs;

function localCoverageAndDirection() {
  const input = fixture([
    node("h", "A", [edge("x", ["caravan"], 80)]),
    node("x", "B", [edge("m", ["airship"], 120)]), node("m", "C")
  ], [company("A-road", ["A"], ["caravan"]),
    company("B-transit", ["B"], ["caravan", "airship"], { timeFactor: 2, riskFactor: 2 }),
    company("C-air", ["C"], ["airship"], { timeFactor: 0.5, priceFactor: 2, capacityFactor: 0.75, riskFactor: 0.5 })]);
  const inbound = purchase(input, { direction: "inbound" });
  assert.equal(inbound.plan.ok, true);
  const legs = legsOf(inbound);
  assert.deepEqual(legs.map((leg) => [leg.fromRegionId, leg.toRegionId, leg.fromCountryId, leg.carrierId, leg.mode]), [
    ["m", "x", "C", "C-air", "airship"], ["x", "h", "B", "B-transit", "caravan"]
  ], "inbound pickup jurisdiction follows the cargo, not the reverse graph traversal");
  assert.equal(legs.reduce((sum, leg) => sum + leg.distanceKm, 0), 200);
  assert.equal(inbound.plan.deliveryBreakdown.routeDistanceCopper, Math.ceil(legs.reduce((sum, leg) => sum + leg.distanceCopper, 0)),
    "the explanatory distance tariff must use the actual company terms of every leg");
  assert.equal(inbound.plan.deliveryBreakdown.configuredDistanceFlatCopper, 0,
    "configured distance charges are already included in the leg distance tariff");
  close(legs.reduce((sum, leg) => sum + leg.movementQd, 0), 18.25, "local time factors apply only to their leg");
  close(legs.reduce((sum, leg) => sum + leg.travelQd, 0), 19.25, "changing carrier/mode includes one transfer QD");
  assert.equal(inbound.plan.logistics.travelQd, 20, "travel time is rounded after summing legs and transfers");
  assert.equal(inbound.plan.physicalCapacityLoad, 400, "shipment batches use the narrowest local service");
  close(inbound.plan.logistics.riskFactor, 2, "a risky local carrier remains in the conservative aggregate");
  assert.equal(inbound.plan.logistics.transportPlan.direction, "inbound");
  const outbound = purchase(input, { direction: "outbound" });
  assert.equal(outbound.plan.ok, true);
  assert.deepEqual(legsOf(outbound).map((leg) => [leg.fromRegionId, leg.fromCountryId, leg.carrierId]), [
    ["h", "A", "A-road"], ["x", "B", "B-transit"]
  ]);
  assert.equal(outbound.plan.logistics.transportPlan.direction, "outbound");
  const pinned = planMarketTransport({ ...input, carrierId: "C-air" });
  assert.equal(pinned.logistics.ok, false, "a selected company cannot silently borrow other countries' services");
  const changed = structuredClone(input);
  changed.organizations.find((row) => row.id === "B-transit").carrier.timeFactor = 3;
  const repriced = purchase(changed);
  assert.ok(repriced.plan.logistics.travelQd > inbound.plan.logistics.travelQd, "fresh quotes respond to changed intermediate-country speed");
  assert.equal(JSON.stringify(inbound.plan.logistics.transportPlan), JSON.stringify(JSON.parse(JSON.stringify(inbound.plan.logistics.transportPlan))), "the exact chosen chain is serializable");
}

function parallelServicesAndCheapDetour() {
  const parallel = fixture([
    node("h", "A", [edge("m", ["rail"], 80, { routeId: "track" }), edge("m", ["caravan"], 120, { routeId: "road" })]), node("m", "A")
  ], [company("rail", ["A"], ["rail"], { priceFactor: 3 }), company("road", ["A"], ["caravan"], { priceFactor: 0.5 })]);
  const result = purchase(parallel);
  assert.equal(result.plan.ok, true);
  assert.equal(legsOf(result)[0].routeId, "road", "the saved chain identifies the chosen parallel physical link");
  assert.equal(legsOf(result)[0].carrierId, "road");
  assert.equal(legsOf(result)[0].mode, "caravan");
  const detour = fixture([
    node("h", "A", [edge("m", ["caravan"], 100, { routeId: "direct" }), edge("x", ["caravan"], 1)]),
    node("x", "B", [edge("m", ["caravan"], 120)]), node("m", "C")
  ], [company("A-expensive", ["A"], ["caravan"], { priceFactor: 3 }), company("B-cheap", ["B"], ["caravan"], { priceFactor: 0.5 })]);
  const chosen = purchase(detour, { direction: "outbound" });
  assert.equal(chosen.plan.ok, true);
  assert.deepEqual(legsOf(chosen).map((leg) => leg.toRegionId), ["x", "m"], "bare physical distance must not prune a cheaper chain via local carriers");
  assert.equal(chosen.plan.logistics.distanceKm, 121);
}

function capacityFloorAndLaterBottleneck() {
  const big = company("A-big", ["A"], ["caravan"]), small = company("A-small", ["A"], ["caravan"], { capacityFactor: 0.1 });
  big.carrier.countryShares[0].sharePct = 50; small.carrier.countryShares[0].sharePct = 50;
  const input = fixture([node("h", "A", [edge("x", ["caravan"])]), node("x", "B", [edge("m", ["caravan"])]), node("m", "C")],
    [big, small, company("B-tail", ["B"], ["caravan"], { capacityFactor: 0.1 })]);
  const selected = purchase(input, { direction: "outbound" });
  assert.equal(selected.plan.ok, true);
  assert.equal(legsOf(selected)[0].carrierId, "A-small", "higher capacity is not always cheaper under a 2% minimum occupied share");
  assert.equal(selected.plan.physicalCapacityLoad, 40);
  const legCost = (leg, batchLoad, factor) => {
    const setup = leg.dispatchCopper + leg.distanceCopper + leg.operatingCopper + leg.hireCopper;
    return (setup + leg.capacityLoad * leg.loadCopperPerUnit) * Math.max(0.02, batchLoad / leg.capacityLoad) * factor;
  };
  for (const batch of selected.plan.shipmentBatches) {
    const expected = Math.ceil(legsOf(selected).reduce((sum, leg) => sum + legCost(leg, batch.totalLoad, batch.operatingLegFactor), 0));
    assert.equal(batch.operationalFreightCopper, expected, "each service bills its own vehicle occupancy while batches respect the final bottleneck");
  }
}

function splitHaulInvariance() {
  const organizations = [company("liner", ["A"], ["airship"], { priceFactor: 1.5, timeFactor: 0.7 })];
  const direct = fixture([node("h", "A", [edge("m", ["airship"], 80, { ursCost: 2 })]), node("m", "A")], organizations);
  const split = fixture([node("h", "A", [edge("x", ["airship"], 40)]), node("x", "A", [edge("m", ["airship"], 40)]), node("m", "A")], organizations);
  for (const direction of ["inbound", "outbound"]) for (const serviceLevel of ["standard", "express", "charter"]) for (const price of [1, 100_000]) {
    const one = purchase(direct, { direction, serviceLevel, price }), two = purchase(split, { direction, serviceLevel, price });
    assert.equal(one.plan.ok, true); assert.equal(two.plan.ok, true);
    const sum = (result, key) => legsOf(result).reduce((total, leg) => total + leg[key], 0);
    close(sum(one, "dispatchCopper"), sum(two, "dispatchCopper"), "a continuous haul dispatches once");
    close(sum(one, "hireCopper"), sum(two, "hireCopper"), "a continuous air haul hires once");
    assert.equal(one.plan.deliveryQd, two.plan.deliveryQd, "splitting a flight on the map does not add rounding delays");
    assert.equal(one.plan.totalCopper, two.plan.totalCopper, "map segmentation without a handover cannot add freight");
  }
}

function localAerialTail() {
  const input = fixture([node("h", "A", [edge("m", ["caravan"], 80)]), node("m", "C", [], { marketTransportModes: ["caravan"] })],
    [company("A-local", ["A"], ["airship", "caravan"]), company("C-road", ["C"], ["caravan"])]);
  input.holding.type = "sky-island"; input.market.transportModes = ["caravan"];
  for (const direction of ["inbound", "outbound"]) {
    const result = purchase(input, { direction });
    assert.equal(result.plan.ok, true, "the local country can provide aerial handling even when the distant supplier only offers caravan");
    const legs = legsOf(result), local = legs.find((leg) => leg.kind === "last-mile");
    assert.ok(local); assert.equal(local.carrierId, "A-local");
    assert.equal(local.fromCountryId, "A"); assert.equal(local.distanceKm, 0); assert.equal(local.movementQd, 1);
    assert.equal(legs.reduce((sum, leg) => sum + leg.transferQd, 0), 1, "the ground/air handover is counted in either direction");
    assert.equal(direction === "inbound" ? legs.at(-1).kind : legs[0].kind, "last-mile");
    assert.equal(result.plan.logistics.distanceKm, 80, "the synthetic local leg does not invent measured map distance");
  }
}

function ordinaryVisibility() {
  const hidden = company("private-company", ["A"], ["caravan"], { priceFactor: 0.5 }); hidden.visibility = "gm";
  const publicCompany = company("public-company", ["A"], ["caravan"], { priceFactor: 2 });
  const input = fixture([node("h", "A", [edge("m", ["caravan"])]), node("m", "A")], [hidden, publicCompany]);
  const gm = purchase(input), player = purchase(input, { isGM: false });
  assert.equal(gm.plan.ok, true); assert.equal(player.plan.ok, true);
  assert.equal(legsOf(gm)[0].carrierId, "private-company");
  assert.ok(legsOf(player).every((leg) => leg.carrierId !== "private-company"), "ordinary player planning cannot select a GM-only company");
}

function localIndependentPools() {
  const input = fixture([node("h", "A", [edge("x", ["caravan"])]), node("x", "B", [edge("m", ["caravan"])]), node("m", "C")], []);
  for (const direction of ["inbound", "outbound"]) {
    const result = purchase(input, { direction });
    assert.equal(result.plan.ok, true);
    const legs = legsOf(result);
    assert.equal(new Set(legs.map((leg) => leg.fromCountryId)).size, 2);
    assert.equal(legs.reduce((sum, leg) => sum + leg.transferQd, 0), 1, "independent pools in different dispatch countries are not one global through carrier");
    assert.equal(legs.reduce((sum, leg) => sum + leg.dispatchCopper, 0), 12, "the new country's independent pool starts a new haul");
  }
}

function independentBoundaryDominance() {
  const input = fixture([
    node("h", "A", [edge("j", ["caravan"], 20), edge("k", ["caravan"], 10)]),
    node("k", "B", [edge("j", ["caravan"], 10, { seasonalModifiers: { winter: { enabled: true, costFactor: 0.5, timeFactor: 1, riskFactor: 1 } } })]),
    node("j", "B", [edge("m", ["caravan"], 10)]), node("m", "C")
  ], [], { seasonId: "winter" });
  input.market.caravanCapacityLoad = 1;
  const selected = purchase(input, { direction: "outbound", serviceLevel: "charter", qty: 1, load: 0.1 });
  assert.equal(selected.plan.ok, true);
  assert.deepEqual(selected.plan.logistics.routePath, ["h", "k", "j", "m"],
    "a prefix ending in another country's local independent pool cannot erase a cheaper continuing local haul");
  assert.equal(selected.plan.shipmentBatches[0].operationalFreightCopper, 28);
}

// Enumerate every simple path, edge mode and local provider without production graph/pruning helpers.
function exhaustivePlans(input, direction) {
  const byId = new Map(input.regions.map((row) => [row.value, row])), graph = new Map(input.regions.map((row) => [row.value, []]));
  for (const row of input.regions) for (const link of row.marketLinks) {
    graph.get(row.value).push({ ...link, from: row.value, to: link.regionId });
    graph.get(link.regionId).push({ ...link, from: link.regionId, to: row.value });
  }
  const result = [], start = direction === "inbound" ? "m" : "h", end = direction === "inbound" ? "h" : "m";
  const visit = (path, legs, access) => {
    const from = path.at(-1);
    if (from === end) {
      const sum = (field) => legs.reduce((total, leg) => total + leg[field], 0), distanceKm = sum("distanceKm");
      const capacityLoad = Math.min(...legs.map((leg) => leg.capacityLoad)), used = [...new Set(legs.map((leg) => leg.mode))];
      const transportPlan = { version: 1, key: `oracle:${result.length}`, direction, legs, distanceKm, travelQd: sum("travelQd"), capacityLoad,
        riskFactor: Math.max(...legs.map((leg) => leg.riskFactor)),
        freightFactor: legs.reduce((total, leg) => total + leg.distanceKm * leg.freightFactor, 0) / distanceKm };
      result.push({ ok: true, transportPlan, distanceKm, distance: distanceKm / 40, hops: legs.length,
        routePath: direction === "inbound" ? [...path].reverse() : path,
        routeModes: (direction === "inbound" ? [...legs].reverse() : legs).map((leg) => leg.mode),
        capacityLoad, baseCapacityLoad: capacityLoad, capacityModes: used,
        travelQd: Math.ceil(transportPlan.travelQd), riskFactor: transportPlan.riskFactor,
        routeAccessCost: access, routeAccessLevel: access, requiredAccessLevel: access,
        accessLevel: input.holding.gm.modifiers.marketConnectionsLevel, transportMode: used.length > 1 ? "multimodal" : used[0],
        deliveryFactor: 1, carrierPriceFactor: 1, importTaxRate: 0, exportTaxRate: 0,
        distanceFlatCopper: Math.ceil(sum("dispatchCopper") + sum("distanceCopper") + sum("operatingCopper") + sum("hireCopper")),
        distanceLoadCopper: sum("loadCopperPerUnit") });
      return;
    }
    for (const link of graph.get(from)) {
      if (path.includes(link.to) || access + link.ursCost > input.holding.gm.modifiers.marketConnectionsLevel) continue;
      for (const mode of link.modes) {
        if (!byId.get(from).marketTransportModes.includes(mode) || !byId.get(link.to).marketTransportModes.includes(mode)
          || ((from === "m" || link.to === "m") && !input.market.transportModes.includes(mode))) continue;
        const options = carrierProvidersForRoute({ organizations: input.organizations, countryId: byId.get(from).countryId,
          transportMode: mode, routeModes: [mode], isGM: input.isGM });
        for (const carrier of options) {
          const prior = legs.at(-1), same = prior?.carrierId === carrier.id && prior.mode === mode
            && (!carrier.independent || prior.fromCountryId === byId.get(from).countryId);
          const tariff = MARKET_TRANSPORT_TARIFFS[mode], units = link.distanceKm / 40;
          const movementQd = units * tariff.qdPerDistance * carrier.timeFactor;
          const leg = { id: `oracle-leg:${legs.length}`, routeId: link.routeId ?? "", mode, carrierId: carrier.id,
            fromRegionId: from, toRegionId: link.to, fromCountryId: byId.get(from).countryId, toCountryId: byId.get(link.to).countryId,
            distanceKm: link.distanceKm, movementQd, transferQd: legs.length && !same ? 1 : 0,
            travelQd: movementQd + (legs.length && !same ? 1 : 0),
            capacityLoad: MARKET_DEFAULT_TRANSPORT_CAPACITY_LOAD[mode] * carrier.capacityFactor,
            dispatchCopper: same ? 0 : tariff.dispatchCopper * carrier.priceFactor,
            hireCopper: same || mode !== "airship" ? 0 : input.market.airshipHireCopper * carrier.priceFactor,
            distanceCopper: units * tariff.distanceCopper * carrier.priceFactor,
            loadCopperPerUnit: units * tariff.loadDistanceCopper * carrier.priceFactor,
            operatingCopper: movementQd * tariff.operatingCopperPerQd * carrier.priceFactor,
            riskFactor: carrier.riskFactor, freightFactor: marketTransportFreightFactor(mode) * carrier.priceFactor };
          visit([...path, link.to], [...legs, leg], access + link.ursCost);
        }
      }
    }
  };
  visit([start], [], 0); return result;
}

function exhaustiveLocalServices() {
  const a = company("A-ground", ["A"], ["caravan", "rail"], { priceFactor: 0.8, timeFactor: 1.5, capacityFactor: 0.1 });
  a.carrier.countryShares[0].sharePct = 60;
  const b = company("B-all", ["B"], MODES, { priceFactor: 1.5, timeFactor: 0.8, riskFactor: 1.5 });
  const b2 = company("B-train-air", ["B"], ["rail", "airship"], { priceFactor: 0.6, capacityFactor: 0.5, riskFactor: 0.5 });
  b.carrier.countryShares[0].sharePct = 50; b2.carrier.countryShares[0].sharePct = 50;
  const input = fixture([
    node("h", "A", [edge("x", ["caravan", "rail"], 60), edge("y", ["airship"], 100)]),
    node("x", "B", [edge("m", ["rail", "airship"], 80, { routeId: "main" }), edge("y", ["caravan", "airship"], 20),
      edge("m", ["caravan"], 120, { routeId: "road" })]),
    node("y", "B", [edge("m", ["caravan", "rail"], 70)]), node("m", "C")
  ], [a, company("A-air", ["A"], ["airship"], { priceFactor: 2, timeFactor: 0.5 }), b, b2,
    company("C-rail-air", ["C"], ["rail", "airship"]), company("C-road", ["C"], ["caravan"], { priceFactor: 0.5, capacityFactor: 0.1 })]);
  let checked = 0;
  for (const direction of ["inbound", "outbound"]) {
    const exhaustive = exhaustivePlans(input, direction), selected = planMarketTransport({ ...input, direction });
    assert.ok(exhaustive.length > 10, "the brute-force oracle must exercise genuine physical/service alternatives");
    for (const serviceLevel of ["standard", "express", "charter"]) for (const qty of [2, 25]) for (const load of [1, 50, 500]) for (const price of [1, 100_000]) {
      const plan = (logistics) => planMarketPurchase({ holding: input.holding, serviceLevel, quantities: { cargo: qty }, quote: {
        offers: [{ id: "cargo", stock: qty, unitPriceCopper: price, load }], location: {}, logistics,
        deliveryMode: "scheduled", deliveryBaseQd: 1, deliveryQd: 1 + logistics.travelQd
      } });
      const expected = exhaustive.map(plan).filter((row) => row.ok).sort((left, right) => left.totalCopper - right.totalCopper || left.deliveryQd - right.deliveryQd)[0];
      const actual = plan(selected.logistics), label = `${direction}/${serviceLevel}/${qty}/${load}/${price}`;
      assert.equal(actual.ok, Boolean(expected), `${label}: carrier search must preserve eligible shipments`);
      if (expected) assert.deepEqual([actual.totalCopper, actual.deliveryQd], [expected.totalCopper, expected.deliveryQd], `${label}: exact exhaustive physical/carrier optimum`);
      checked++;
    }
  }
  assert.equal(checked, 72);
}

function unresolvedEndpointsAndFractionalCapacity() {
  const input = fixture([node("h", "A", [edge("m", ["caravan"], 4000)]), node("m", "A")],
    [company("small", ["A"], ["caravan"], { capacityFactor: 0.1 })]);
  input.market.caravanCapacityLoad = 1;
  const result = purchase(input, { qty: 1, load: 0.01 });
  assert.equal(result.plan.ok, true);
  const leg = legsOf(result)[0];
  close(leg.capacityLoad, 0.1, "carrier factors may produce a fractional physical capacity");
  const fare = leg.dispatchCopper + leg.distanceCopper + leg.operatingCopper + leg.hireCopper + leg.capacityLoad * leg.loadCopperPerUnit;
  assert.equal(result.plan.shipmentBatches[0].operationalFreightCopper, Math.ceil(fare * 0.1),
    "occupied share and vehicle fare must use the same actual fractional capacity");
  for (const missing of [
    {}, { ...input, market: { ...input.market, regionId: "missing" } },
    { ...input, holding: { ...input.holding, overview: { region: "missing" } } }
  ]) {
    const blocked = planMarketTransport(missing);
    assert.equal(blocked.logistics.ok, false, "unresolved endpoints cannot create a fictitious empty transport agreement");
    assert.deepEqual(blocked.logistics.routeCandidates, []);
    assert.equal(blocked.logistics.transportPlan, undefined);
  }
}

function serviceSearchBudget() {
  const layers = Array.from({ length: 5 }, (_, layer) => Array.from({ length: 10 }, (_, index) => `layer-${layer}-${index}`));
  const regions = [node("h", "A", layers[0].map((id) => edge(id, ["caravan"]))), node("m", "A")];
  layers.forEach((layer, index) => layer.forEach((id) => regions.push(node(id, "A", (layers[index + 1] ?? ["m"]).map((next) => edge(next, ["caravan"]))))));
  const result = planMarketTransport(fixture(regions, [company("one", ["A"], ["caravan"])]));
  assert.equal(result.logistics.ok, false, "a bounded carrier search cannot call a partial answer optimal");
  assert.deepEqual(result.logistics.routeCandidates, []);
  assert.match(result.logistics.reasons.join(" "), /слишком много альтернатив/i);
}

export function checkTransportNetwork() {
  localCoverageAndDirection(); parallelServicesAndCheapDetour(); capacityFloorAndLaterBottleneck();
  splitHaulInvariance(); localAerialTail(); ordinaryVisibility(); localIndependentPools(); independentBoundaryDominance(); exhaustiveLocalServices(); unresolvedEndpointsAndFractionalCapacity(); serviceSearchBudget();
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkTransportNetwork();
  console.log("Transport network: local pickup-country coverage, direction, parallel services, cheaper detours, capacity billing, continuous hauls and aerial tails passed.");
}
