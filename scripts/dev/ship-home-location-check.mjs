import assert from "node:assert/strict";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { applyShipHomePlacement, previewShipHomePlacement, shipHomeLocationContext } from "../apps/domains/ship-home-location.js";
import { buildShipWorldContext, generateWorldShipOffers } from "../engines/ships/world-market.js";
import { normalizeEventRegionOptions } from "../data/random-events.js";
import { shortestMarketRoute } from "../engines/market/logistics.js";
import { shipRouteMapContext } from "../apps/common/route-map-view.js";
import { placeShipHome } from "../apps/domains/events/ship-home-events.js";
import { SkyholdData } from "../data/store.js";

function fixture() {
  const result = worldMarketFixture();
  const { data } = result;
  Object.assign(data.catalog.eventRegions[1], { marketMapX: 100, marketMapY: 100 });
  Object.assign(data.catalog.eventRegions[2], { marketMapX: 500, marketMapY: 300 });
  Object.assign(data.catalog.eventRegions[1].marketLinks[0], { routeId: "curved", pathPoints: [{ x: 100, y: 300 }] });
  data.catalog.eventRegions = normalizeEventRegionOptions(data.catalog.eventRegions, { fallback: false });
  return result;
}

{
  const { data, holding, ship } = fixture();
  const before = JSON.stringify(data);
  const context = shipHomeLocationContext(data, holding);
  assert.equal(context.routes.length, 1, "only public air links with saved coordinates may position home");
  const route = context.routes[0];
  const preview = previewShipHomePlacement(data, holding, route.key, 50);
  assert.deepEqual(preview.position, { x: 200, y: 300 }, "fraction follows polyline length, not a straight endpoint midpoint");
  assert.deepEqual([preview.fromKm, preview.toKm], [150, 150]);
  assert.equal(JSON.stringify(data), before, "opening settings and previews never changes data");
  for (const value of [0, 100, NaN, ""]) assert.throws(() => previewShipHomePlacement(data, holding, route.key, value), /процентов/);
  assert.throws(() => previewShipHomePlacement(data, holding, "missing", 50), /связь/);
  holding.special.ships.offers = [{ mode: "world", id: "free" }, { mode: "world", id: "accepted", consumedBy: "voyage" }, { id: "legacy" }];
  holding.special.ships.worldOfferLocks = { prior: true };
  const funds = [holding.storage.moneyCopper, ship.onboardCopper];
  const originalLink = structuredClone(data.catalog.eventRegions[1].marketLinks[0]);
  applyShipHomePlacement(data, holding, route.key, 50);
  let world = buildShipWorldContext(data, holding);
  assert.notEqual(world.home.regionId, "home");
  assert.equal(ship.location.regionId, world.home.regionId);
  assert.equal(world.ports.some((port) => port.regionId === world.home.regionId), false, "home is never a market");
  const home = world.regions.find((row) => row.value === world.home.regionId);
  assert.deepEqual(home.marketLinks.map((link) => link.distanceKm), [150, 150]);
  assert.deepEqual(home.marketLinks[0].pathPoints, [{ x: 100, y: 300 }]);
  assert.deepEqual(home.marketLinks[1].pathPoints, []);
  assert.deepEqual(data.catalog.eventRegions.find((row) => row.value === "a").marketLinks[0], originalLink, "existing network link is not split or removed");
  assert.equal(shortestMarketRoute("a", "b", world.regions, { mode: "airship" }).distanceKm, 300, "new point cannot shorten the trade route");
  assert.deepEqual([holding.storage.moneyCopper, ship.onboardCopper], funds);
  assert.deepEqual(holding.special.ships.offers.map((offer) => offer.id), ["accepted", "legacy"]);
  assert.deepEqual(holding.special.ships.worldOfferLocks, {});
  data.catalog.eventRegions = normalizeEventRegionOptions(JSON.parse(JSON.stringify(data.catalog.eventRegions)), { fallback: false });
  assert.equal(shipHomeLocationContext(data, holding).dedicated, true, "ownership and coordinates survive existing storage normalization");
  applyShipHomePlacement(data, holding, route.key, 25);
  assert.equal(data.catalog.eventRegions.filter((row) => row.value === home.value).length, 1, "move reuses the same node");
  world = buildShipWorldContext(data, holding);
  const offers = generateWorldShipOffers(data, holding, ship, { period: 0, random: () => 0.4 });
  assert.ok(offers.length > 0);
  assert.ok(offers.every((offer) => offer.contract.pickup?.regionId !== home.value && offer.to.regionId !== home.value));
  const map = shipRouteMapContext({ world, origin: world.home, finalPoint: world.home,
    overview: true, stops: [{ point: world.home }], legs: [] });
  assert.ok(map.nodes.some((node) => node.id === home.value && node.start));
  assert.equal(map.nodes.some((node) => node.id === "secret"), false);
  assert.ok(map.lines.length >= 2, "unselected map is useful without a contract");
}

{
  const { data, holding } = fixture();
  const regions = data.catalog.eventRegions;
  regions.find((row) => row.value === "a").marketLinks = [{ regionId: "transit", distanceKm: 100, modes: ["airship"] }];
  regions.find((row) => row.value === "b").marketLinks = [{ regionId: "secret", distanceKm: 100, modes: ["airship"] }];
  regions.push({ value: "transit", label: "Открытая транзитная точка", countryId: "public", marketEnabled: false,
    marketTransportModes: ["caravan"], marketMapX: 300, marketMapY: 200,
    marketLinks: [{ regionId: "b", distanceKm: 100, modes: ["airship"] }] });
  const world = buildShipWorldContext(data, holding);
  assert.equal(world.ports.some((port) => port.regionId === "transit"), false);
  assert.equal(world.mapRegionIds.includes("transit"), true, "public transit points remain visible without becoming ship ports");
  assert.equal(world.mapRegionIds.includes("secret"), false, "GM-only regions remain hidden from the ship map");
  const overview = shipRouteMapContext({ world, origin: world.home, finalPoint: world.home,
    overview: true, stops: [{ point: world.home }], legs: [] });
  assert.equal(overview.lines.filter((line) => /транзитная точка/.test(line.label)).length, 2);
  assert.equal(overview.lines.some((line) => /secret/.test(line.label)), false);
  const route = shortestMarketRoute("a", "b", world.regions, { mode: "airship" });
  const planned = shipRouteMapContext({ world, origin: { regionId: "a" }, finalPoint: { regionId: "b" },
    stops: [{ point: { regionId: "a", label: "a" } }, { point: { regionId: "b", label: "b" } }],
    legs: [{ route, from: { label: "a" }, to: { label: "b" }, offerIds: [] }] });
  assert.equal(planned.incomplete, false, "a public non-port transit point must not erase the planned flight");
  assert.equal(planned.lines.length, 2);
  assert.ok(planned.nodes.some((node) => node.id === "transit"));
}

{
  const { data, holding } = fixture();
  const link = data.catalog.eventRegions.find((row) => row.value === "a").marketLinks[0];
  data.catalog.eventRegions.find((row) => row.value === "a").marketLinks = [
    { ...link, routeId: "first", pathPoints: [] }
  ];
  data.catalog.eventRegions.find((row) => row.value === "b").marketLinks.push(
    { ...link, regionId: "a", routeId: "second", pathPoints: [] });
  const before = JSON.stringify(data.catalog.eventRegions);
  const world = buildShipWorldContext(data, holding);
  const map = shipRouteMapContext({ world, origin: world.home, finalPoint: world.home,
    overview: true, stops: [{ point: world.home }], legs: [] });
  const parallel = map.lines.filter((line) => /^(a → b|b → a)/.test(line.label));
  assert.equal(parallel.length, 2);
  assert.equal(new Set(parallel.map((line) => line.points)).size, 2, "parallel links must have distinct display geometry");
  assert.ok(parallel.every((line) => /путь [12]\/2/.test(line.label)));
  assert.equal(JSON.stringify(data.catalog.eventRegions), before, "display separation must not alter stored route geometry");
}

for (const block of [
  ({ ship }) => { ship.activeVoyage = { id: "active" }; },
  ({ ship }) => { ship.orderBundle = { id: "bundle" }; },
  ({ ship }) => { ship.location.kind = "market"; },
  ({ holding }) => { holding.special.market.orders = [{ status: "in-transit" }]; },
  ({ holding }) => { holding.special.market.outbound = { orders: [{ status: "needsResolution" }] }; }
]) {
  const fixtureData = fixture();
  const route = shipHomeLocationContext(fixtureData.data, fixtureData.holding).routes[0];
  block(fixtureData);
  const before = JSON.stringify(fixtureData.data);
  assert.throws(() => applyShipHomePlacement(fixtureData.data, fixtureData.holding, route.key, 50), /рейсы|доставки/);
  assert.equal(JSON.stringify(fixtureData.data), before, "blocked placement is atomic");
}

// The only writer is an explicit GM action with a second revision check after review.
{
  const { data, holding } = fixture();
  const route = shipHomeLocationContext(data, holding).routes[0];
  let commits = 0, confirms = 0;
  const errors = [];
  globalThis.ui = { notifications: { error: (message) => errors.push(message) } };
  globalThis.game = { user: { isGM: false } };
  globalThis.foundry = { applications: { api: { DialogV2: { confirm: async () => { confirms++; return true; } } } } };
  SkyholdData.view = () => data;
  SkyholdData.transaction = async (callback, options) => {
    assert.equal(options.scope, "both");
    const draft = structuredClone(data);
    await callback(draft);
    commits++;
  };
  const app = { holdingId: holding.id, _shipPlanner: { clear() {} }, requestRender() {}, element: { querySelector(selector) {
    if (selector === "[data-ship-card]") return { dataset: { shipRevision: "1" } };
    return { value: selector.includes("route") ? route.key : "50" };
  } } };
  const event = { preventDefault() {}, currentTarget: { disabled: false } };
  await placeShipHome(app, event);
  assert.deepEqual([commits, confirms], [0, 0], "players cannot invoke a world write");
  game.user.isGM = true;
  foundry.applications.api.DialogV2.confirm = async () => { confirms++; data.meta.revision++; return true; };
  await placeShipHome(app, event);
  assert.equal(commits, 0);
  assert.match(errors.at(-1), /после просмотра/);
  data.meta.revision = 1;
  foundry.applications.api.DialogV2.confirm = async () => false;
  await placeShipHome(app, event);
  assert.equal(commits, 0, "cancelling review never writes");
  foundry.applications.api.DialogV2.confirm = async () => true;
  await placeShipHome(app, event);
  assert.equal(commits, 1);
}

console.log("Ship home location: explicit GM placement, polyline geometry, schema round trip, no home customers, active-work blockers and stale review guards passed.");
