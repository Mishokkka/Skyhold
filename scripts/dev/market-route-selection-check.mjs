import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeEventRegionOptions } from "../data/random-events.js";
import { resolveMarketLogistics, shortestMarketRoute } from "../engines/market/logistics.js";
import { marketShipmentRiskProfile } from "../engines/market/pricing.js";
import { createMarketOutboundOrder } from "../engines/market/outbound.js";
import { carrierProvidersForLogistics, applyCarrierToLogistics } from "../engines/market/providers.js";
import { prepareMarketAuthorityContext } from "../apps/market/authority-context.js";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";

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

const cases = { "own-ship": ownShip, candidates, "last-mile": lastMile, "last-mile-carrier": lastMileCarrier, "access-override": accessOverride };
export function checkMarketRouteSelection() { for (const check of Object.values(cases)) check(); }
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2]) cases[process.argv[2]](); else checkMarketRouteSelection();
  console.log("Market route selection: airship risk, admissible alternatives, effective URS, GM/player planning and last-mile carrier compatibility/shares passed.");
}
