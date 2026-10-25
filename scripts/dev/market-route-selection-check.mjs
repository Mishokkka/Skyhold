import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeEventRegionOptions } from "../data/random-events.js";
import { resolveMarketLogistics, shortestMarketRoute } from "../engines/market/logistics.js";
import { marketShipmentRiskProfile, planMarketPurchase } from "../engines/market/pricing.js";
import { createMarketOutboundOrder } from "../engines/market/outbound.js";
import { carrierProvidersForLogistics, carrierProvidersForRoute, applyCarrierToLogistics } from "../engines/market/providers.js";
import { prepareMarketAuthorityContext, authorityOutboundRoutes } from "../apps/market/authority-context.js";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { checkMarketMixedChoice } from "./market-mixed-choice-check.mjs";

function fixture(legs) {
  const { data, holding, ship } = worldMarketFixture();
  holding.type = "sky-island"; holding.gm.modifiers.marketConnectionsLevel = legs.length;
  for (let index = 1; index < 36; index++) {
    const id = `review-sailor-${index}`;
    holding.people.list.push({ id, name: id, wageDailyOverrideCopper: 12 }); ship.crewResidentIds.push(id);
  }
  holding.storage.resources = [{ id: "review-sale", resourceId: "test-freight", name: "Ткани", forSale: true, qty: 20,
    batches: [{ id: "review-batch", qty: 20, ageQd: 0 }] }];
  const ids = ["home", ...legs.slice(1).map((_, index) => `relay-${index}`), "a"];
  data.catalog.eventRegions = normalizeEventRegionOptions(ids.map((value, index) => ({ value, label: value,
    countryId: "public", marketLandmassId: "land", marketTransportModes: index === legs.length ? [...legs.at(-1)] : ["rail", "caravan", "airship"],
    marketLinks: index < legs.length ? [{ regionId: ids[index + 1], distanceKm: 75, modes: legs[index] }] : []
  })), { fallback: false });
  return { data, holding, ship, regions: data.catalog.eventRegions };
}

function ownShip() {
  const { data, holding, ship, regions } = fixture([["rail", "airship"], ["airship"]]);
  const selectedRoute = shortestMarketRoute("home", "a", regions, { mode: "airship" });
  const logistics = resolveMarketLogistics({ holding, market: { regionId: "a", transportModes: ["airship"] }, regions, selectedRoute, singleRoute: true });
  assert.deepEqual(logistics.routeModes, ["airship", "airship"], "an explicit airship route must retain its mode on intermediate multimode links");
  assert.equal(logistics.transportMode, "airship");
  const view = prepareMarketAuthorityContext({ data, holding, marketId: "a", ownShipId: ship.id,
    outboundQuantities: { "test-freight": 2 }, outboundInsuranceEnabled: false, isGM: true });
  assert.equal(view.outbound.plan.ok, true);
  const route = view.outbound.plan.route;
  const expected = marketShipmentRiskProfile({ logistics: { distanceKm: 150, riskFactor: 1, transportMode: "airship" }, deliveryQd: route.deliveryQd });
  assert.equal(route.riskLossChance, expected.lossChance, "own-ship plan uses the airship risk coefficient");
  assert.equal(route.riskDelayChance, expected.delayChance);
  const order = createMarketOutboundOrder({ plan: view.outbound.plan, operationId: "review-own-ship" });
  assert.deepEqual(order.routeModes, ["airship"]); assert.equal(order.transportMode, "airship");
  assert.equal(order.riskLossChance, expected.lossChance, "the saved order retains the same airship loss risk");
  assert.equal(order.riskDelayChance, expected.delayChance);
}

function candidates() {
  const { data, holding, regions } = fixture([["rail", "airship"], ["caravan"]]);
  const market = { regionId: "a", transportModes: ["caravan"] };
  for (const type of ["sky-island", "ship"]) {
    const logistics = resolveMarketLogistics({ holding: { ...holding, type }, market, regions });
    assert.equal(logistics.ok, true, "a rejected ground prefix must not hide a valid airship/caravan alternative");
    assert.deepEqual(logistics.routeModes, ["airship", "caravan"]);
    assert.ok(logistics.routeCandidates.every((route) => route.ok), "only admissible alternatives are offered to pricing and carriers");
  }
  for (const isGM of [true, false]) {
    const initial = prepareMarketAuthorityContext({ data, holding, marketId: "a", isGM });
    const offer = initial.quote.offers.find((row) => row.resourceId === "test-freight");
    const view = prepareMarketAuthorityContext({ data, holding, marketId: "a", isGM, quantities: { [offer.id]: 2 }, outboundQuantities: { "test-freight": 2 } });
    assert.equal(view.quote.logistics.ok, true); assert.equal(view.plan.ok, true, "GM/player purchase planning accepts the valid alternative");
    assert.equal(view.outbound.plan.ok, true, "GM/player outbound planning accepts the valid alternative");
  }
  const tooFar = resolveMarketLogistics({ holding, market, regions, accessLevel: 1 });
  assert.equal(tooFar.ok, false, "route substitution cannot bypass insufficient URS");
}

function lastMile() {
  const { holding, regions } = fixture([["caravan"], ["airship"], ["caravan"]]);
  const market = { regionId: "a", transportModes: ["caravan"] };
  for (const type of ["sky-island", "ship"]) {
    const blocked = resolveMarketLogistics({ holding: { ...holding, type }, market, regions });
    assert.equal(blocked.ok, false, "air transport in the middle cannot satisfy an unavailable aerial final delivery");
    assert.match(blocked.reasons.join(" "), /воздушн/i);
    const availableMarket = { ...market, transportModes: ["caravan", "airship"] };
    const aerial = resolveMarketLogistics({ holding: { ...holding, type }, market: availableMarket, regions });
    const ground = resolveMarketLogistics({ holding: { ...holding, type: "village" }, market: availableMarket, regions });
    assert.equal(aerial.ok, true); assert.equal(ground.ok, true);
    assert.equal(aerial.travelQd, ground.travelQd + 1, "a ground edge at the holding requires one additional aerial QD");
    assert.equal(aerial.routeOperatingTimeCopper, ground.routeOperatingTimeCopper + 20, "the separate aerial QD is paid even when the middle already uses air transport");
    const noLocalAir = structuredClone(regions); noLocalAir[0].marketTransportModes = ["caravan"];
    assert.equal(resolveMarketLogistics({ holding: { ...holding, type }, market: availableMarket, regions: noLocalAir }).ok, false);
  }
}

function lastMileCarrier() {
  const { data, holding, regions } = fixture([["caravan"]]);
  regions.at(-1).marketTransportModes = ["caravan", "airship"];
  const logistics = resolveMarketLogistics({ holding, market: { regionId: "a", transportModes: ["caravan", "airship"] }, regions });
  const organization = (id, modes, modeShares) => ({ id, label: id, active: true, visibility: "public", carrier: {
    enabled: true, modes, countryShares: [{ countryId: "public", sharePct: 100, modeShares }]
  } });
  data.catalog.marketEconomy.organizations = [organization("ground-only", ["caravan"]),
    organization("through-carrier", ["caravan", "airship"], { caravan: 80, airship: 30 })];
  assert.deepEqual(logistics.routeModes, ["caravan"]);
  assert.deepEqual(logistics.capacityModes, ["caravan", "airship"]);
  for (const isGM of [true, false]) {
    const carriers = carrierProvidersForLogistics({ organizations: data.catalog.marketEconomy.organizations, countryId: "public", logistics, isGM });
    assert.equal(carriers.some((row) => row.id === "ground-only"), false, "the selected carrier must also support the aerial last mile");
    assert.equal(carriers.find((row) => row.id === "through-carrier").sharePct, 30, "market share includes the extra air service");
    const initial = prepareMarketAuthorityContext({ data, holding, marketId: "a", carrierId: "ground-only", isGM });
    assert.notEqual(initial.quote.logistics.carrierId, "ground-only", "authority must recalculate an incompatible carrier choice");
    const offer = initial.quote.offers.find((row) => row.resourceId === "test-freight");
    const view = prepareMarketAuthorityContext({ data, holding, marketId: "a", carrierId: "through-carrier", isGM,
      quantities: { [offer.id]: 2 }, outboundQuantities: { "test-freight": 2 } });
    assert.equal(view.plan.ok, true); assert.equal(view.quote.logistics.carrierId, "through-carrier");
    assert.equal(view.outbound.plan.ok, true);
  }
  const groundCarrier = { id: "ground-only", modes: ["caravan"] };
  assert.equal(applyCarrierToLogistics(logistics, groundCarrier).ok, false, "route substitution also validates the aerial last mile");
}

function accessOverride() {
  const { holding, regions } = fixture([["rail", "airship"], ["caravan"]]);
  holding.gm.modifiers.marketConnectionsLevel = 1;
  const args = { holding, market: { regionId: "a", transportModes: ["caravan"] }, regions };
  const logistics = resolveMarketLogistics({ ...args, accessLevel: 2 });
  assert.equal(logistics.ok, true, "an admissible alternative must retain the effective political URS supplied by its caller");
  assert.deepEqual(logistics.routeModes, ["airship", "caravan"]);
  assert.equal(logistics.accessLevel, 2);
  assert.ok(logistics.routeCandidates.length > 0);
  assert.ok(logistics.routeCandidates.every((route) => route.accessLevel === 2));
  assert.equal(resolveMarketLogistics({ ...args, accessLevel: 1 }).ok, false);
}

function selectedModes() {
  for (const blockedId of ["home", "relay-0", "a"]) {
    const { data, holding, ship, regions } = fixture([["airship"], ["airship"]]);
    const directRoute = shortestMarketRoute("home", "a", regions, { mode: "airship" });
    const { directMode: _directMode, ...selectedRoute } = directRoute;
    regions.find((row) => row.value === blockedId).marketTransportModes = ["caravan"];
    const logistics = resolveMarketLogistics({ holding, market: { regionId: "a", transportModes: ["airship"] }, regions, selectedRoute, singleRoute: true });
    assert.equal(logistics.ok, false, `a selected mode cannot bypass ${blockedId}'s transport restriction`);
    const transit = blockedId === "relay-0";
    assert.equal(resolveMarketLogistics({ holding, market: { regionId: "a", transportModes: ["airship"] }, regions,
      selectedRoute: directRoute, singleRoute: true }).ok, transit, "revalidating a direct flight preserves transit but rejects a newly restricted endpoint");
    assert.equal(Boolean(shortestMarketRoute("home", "a", regions, { mode: "airship" })), transit, "direct flight checks endpoint ports, preserving a flight over a non-port transit point");
    if (transit) regions[1].marketEnabled = false;
    for (const isGM of [true, false]) {
      const view = prepareMarketAuthorityContext({ data, holding, marketId: "a", ownShipId: ship.id,
        outboundQuantities: { "test-freight": 2 }, isGM });
      assert.equal(view.outbound.plan.ok, transit, "GM/player own-ship sale rejects restricted endpoints but permits non-port overflight");
    }
  }
  const { data, holding, ship, regions } = fixture([["airship"], ["airship"]]);
  const selectedRoute = shortestMarketRoute("home", "a", regions, { mode: "airship" });
  const args = { holding, regions, selectedRoute, singleRoute: true };
  assert.equal(resolveMarketLogistics({ ...args, market: { regionId: "a", transportModes: ["caravan"] } }).ok, false, "a selected mode cannot bypass the supplier's terminal restrictions");
  selectedRoute.edges[0].modes = ["caravan"];
  assert.equal(resolveMarketLogistics({ ...args, market: { regionId: "a", transportModes: ["airship"] } }).ok, false, "a selected mode cannot bypass the edge's transport restrictions");
  regions[1].marketTransportModes = ["caravan"];
  regions[0].marketLinks[0].modes = ["caravan"];
  regions[0].marketLinks.push({ regionId: "detour", distanceKm: 120, modes: ["airship"] });
  regions.push({ ...structuredClone(regions[1]), value: "detour", label: "Обход", marketTransportModes: ["airship"],
    marketLinks: [{ regionId: "a", distanceKm: 120, modes: ["airship"] }] });
  const detour = shortestMarketRoute("home", "a", regions, { mode: "airship" });
  assert.deepEqual(detour.path, ["home", "detour", "a"], "a forbidden shortcut must not hide a longer permissible flight");
  assert.equal(detour.distanceKm, 240);
  for (const isGM of [true, false]) {
    const view = prepareMarketAuthorityContext({ data, holding, marketId: "a", ownShipId: ship.id,
      outboundQuantities: { "test-freight": 2 }, isGM });
    assert.equal(view.outbound.plan.ok, true); assert.deepEqual(view.outbound.plan.route.routePath, detour.path);
  }
  const legacy = fixture([["airship"], ["airship"], ["caravan"]]);
  const legacyRoute = shortestMarketRoute("home", "a", legacy.regions);
  legacy.regions[2].marketTransportModes = ["caravan"];
  const rejected = resolveMarketLogistics({ holding: legacy.holding, market: { regionId: "a", transportModes: ["caravan"] },
    regions: legacy.regions, selectedRoute: legacyRoute, singleRoute: true });
  assert.equal(rejected.ok, false, "a legacy route without selectedMode also rejects an unsupported transfer");
  assert.deepEqual(rejected.routeModes, ["airship", "", "caravan"], "an unavailable middle leg cannot shift cost attribution to the next edge");
}

function aerialDominance() {
  // The 1 km rail shortcut is cheaper in EVERY search metric, including load,
  // but cannot serve a floating holding. It must not erase the 4-leg air entry.
  const { data, holding, regions } = fixture([["airship"], ["rail"], ["airship"], ["caravan"]]);
  regions[0].marketLinks.push({ regionId: "relay-1", distanceKm: 1, modes: ["rail"] });
  const market = { regionId: "a", transportModes: ["caravan"] };
  const ground = resolveMarketLogistics({ holding: { ...holding, type: "village" }, market, regions, accessLevel: 3 });
  assert.equal(ground.ok, true); assert.deepEqual(ground.routePath, ["home", "relay-1", "relay-2", "a"], "ordinary ground holdings retain the cheaper shortcut at URS 3");
  for (const type of ["sky-island", "ship"]) {
    const logistics = resolveMarketLogistics({ holding: { ...holding, type }, market, regions });
    assert.equal(logistics.ok, true, "a cheaper ground entry cannot dominate the only admissible aerial entry");
    assert.deepEqual(logistics.routePath, ["home", "relay-0", "relay-1", "relay-2", "a"]);
    assert.deepEqual(logistics.routeModes, ["airship", "rail", "airship", "caravan"]);
    assert.equal(resolveMarketLogistics({ holding: { ...holding, type }, market, regions, accessLevel: 3 }).ok, false, "the valid detour must still have sufficient URS");
  }
  for (const isGM of [true, false]) {
    const initial = prepareMarketAuthorityContext({ data, holding, marketId: "a", isGM });
    const offer = initial.quote.offers.find((row) => row.resourceId === "test-freight");
    const view = prepareMarketAuthorityContext({ data, holding, marketId: "a", isGM,
      quantities: { [offer.id]: 2 }, outboundQuantities: { "test-freight": 2 } });
    assert.equal(view.plan.ok, true); assert.equal(view.outbound.plan.ok, true);
    assert.equal(view.plan.logistics.routeModes[0], "airship");
    assert.equal(view.outbound.plan.route.routeModes[0], "airship");
  }
  const equal = fixture([["rail", "airship"], ["rail", "airship"], ["caravan"]]);
  const logistics = resolveMarketLogistics({ holding: equal.holding, market, regions: equal.regions });
  assert.ok(logistics.routeCandidates.some((route) => route.routeModes.join() === "airship,rail,caravan"), "equal aggregate metrics do not make ground/air entries interchangeable");
}

function candidatePricing() {
  const legs = [["rail", "airship"], ["rail", "airship"], ["caravan"]];
  const { holding, regions } = fixture(legs);
  regions.at(-1).marketTransportModes = ["caravan", "airship"];
  const path = shortestMarketRoute("home", "a", regions);
  const assignments = legs.reduce((rows, modes) => rows.flatMap((prefix) => modes.map((mode) => [...prefix, mode])), [[]]);
  for (const type of ["village", "sky-island", "ship"]) for (const localAir of [false, true]) {
    const subject = { ...holding, type }, market = { regionId: "a", transportModes: localAir ? ["caravan", "airship"] : ["caravan"] };
    const logistics = resolveMarketLogistics({ holding: subject, market, regions });
    // Enumerate every mode assignment, bypassing the search's dominance pruning.
    const all = assignments.map((modes) => resolveMarketLogistics({ holding: subject, market, regions, singleRoute: true,
      selectedRoute: { ...path, edges: path.edges.map((edge, index) => ({ ...edge, selectedMode: modes[index] })) }
    })).filter((route) => route.ok);
    for (const serviceLevel of ["standard", "express", "charter"]) for (const load of [1, 25]) for (const unitPriceCopper of [30, 100_000]) {
      const plan = (route) => planMarketPurchase({ holding: subject, serviceLevel, quantities: { test: 2 }, quote: {
        offers: [{ id: "test", stock: 2, unitPriceCopper, load }], location: {}, logistics: route,
        deliveryMode: "scheduled", deliveryBaseQd: 1, deliveryQd: 1 + route.travelQd
      } });
      const expected = all.map(plan).filter((row) => row.ok).sort((a, b) => a.totalCopper - b.totalCopper || a.deliveryQd - b.deliveryQd)[0];
      const actual = plan(logistics);
      assert.ok(expected, `${type}/${localAir}/${serviceLevel}/${load}/${unitPriceCopper}: the exhaustive fixture has at least one eligible shipment`);
      assert.deepEqual([actual.ok, actual.totalCopper, actual.deliveryQd], [true, expected.totalCopper, expected.deliveryQd],
        `${type}/${localAir}/${serviceLevel}/${load}/${unitPriceCopper}: search must preserve the cheapest admissible purchase, including last-mile costs and insurance`);
    }
  }
}

function modeShareFallback() {
  const organization = { id: "regional", label: "Региональный", carrier: { enabled: true, modes: ["rail", "caravan"],
    countryShares: [{ countryId: "public", sharePct: 20, modeShares: { rail: 70, caravan: null } }] } };
  const provider = carrierProvidersForRoute({ organizations: [organization], countryId: "public", transportMode: "multimodal",
    routeModes: ["rail", "caravan"], isGM: true }).find((row) => row.id === organization.id);
  assert.equal(provider.sharePct, 20, "an unspecified mode share inherits the country's general share before taking the bottleneck");
}

function carrierPresence() {
  const { data, holding, regions } = fixture([["rail", "caravan"]]); holding.type = "village";
  const organization = { id: "regional", label: "Региональный", visibility: "public", carrier: { enabled: true, modes: ["rail", "caravan"],
    countryShares: [{ countryId: "public", sharePct: 100, modeShares: { rail: 100, caravan: 0 } }] } };
  data.catalog.marketEconomy.organizations = [organization];
  const logistics = resolveMarketLogistics({ holding, market: { regionId: "a", transportModes: ["rail", "caravan"] }, regions });
  for (const isGM of [true, false]) {
    const providers = carrierProvidersForLogistics({ organizations: [organization], countryId: "public", logistics, isGM });
    for (const [id, mode] of [["regional", "rail"], ["independent-carriers", "caravan"]]) {
      const carrier = providers.find((row) => row.id === id), selected = applyCarrierToLogistics(logistics, carrier);
      assert.ok(selected.routeCandidates.length > 0);
      assert.ok(selected.routeCandidates.every((route) => route.routeModes.every((value) => value === mode)), "a provider cannot borrow a route with zero local presence from another provider");
      const denied = logistics.routeCandidates.find((route) => !route.routeModes.includes(mode));
      assert.equal(applyCarrierToLogistics(denied, carrier).ok, false, "a direct candidate also checks the provider's local presence");
      const initial = prepareMarketAuthorityContext({ data, holding, marketId: "a", carrierId: id, isGM });
      const offer = initial.quote.offers.find((row) => row.resourceId === "test-freight");
      const view = prepareMarketAuthorityContext({ data, holding, marketId: "a", carrierId: id, isGM,
        quantities: { [offer.id]: 2 }, outboundQuantities: { "test-freight": 2 } });
      assert.equal(view.plan.ok, true); assert.deepEqual(view.plan.logistics.routeModes, [mode]);
      assert.equal(view.plan.logistics.carrierSharePct, 100);
      const outbound = authorityOutboundRoutes({ data, holding, market: view.market, economy: view.economy, resources: view.resources,
        offers: view.outbound.offers, carriers: view.quote.carriers, isGM }).filter((route) => route.carrierId === id);
      assert.ok(outbound.length > 0);
      assert.ok(outbound.every((route) => route.routeModes.every((value) => value === mode)), "outbound authority uses the same provider-specific availability as purchases");
    }
  }
}

const cases = { "own-ship": ownShip, candidates, "last-mile": lastMile, "last-mile-carrier": lastMileCarrier, "access-override": accessOverride,
  "selected-modes": selectedModes, "aerial-dominance": aerialDominance, "candidate-pricing": candidatePricing,
  "mixed-choice": checkMarketMixedChoice, "mode-share-fallback": modeShareFallback, "carrier-presence": carrierPresence };
export function checkMarketRouteSelection() { for (const check of Object.values(cases)) check(); }
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2]) cases[process.argv[2]](); else checkMarketRouteSelection();
  console.log("Market route selection: exhaustive multimodal choice, explicit restrictions/transit, aerial dominance, URS, GM/player planning, route-specific carrier presence and inherited shares passed.");
}
