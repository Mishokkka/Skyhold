import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { createShipRecord } from "../data/ships.js";
import { shortestMarketRouteDistanceKm } from "../engines/market/logistics.js";
import { buildShipWorldContext, configureWorldShipEconomy, generateWorldShipOffers, quoteWorldShipHomeUpkeep, quoteWorldShipReturn, quoteWorldShipRelocation, repriceWorldShipOffer, worldShipTimeBreakdown } from "../engines/ships/world-market.js";
import { initializeWorldShip, departWorldShip, resolveWorldShip, advanceWorldShips } from "../engines/ships/world-voyage.js";
import { embarkShipCrew, disembarkShipCrew } from "../engines/ships/crew.js";
import { worldShipPresenceDays, advanceWorldShipEconomy } from "../engines/ships/world-economy.js";
import { advanceShipVoyages } from "../engines/ships/runtime.js";
import { buildTendayChangeSet } from "../engines/tenday/change-set.js";

export function worldMarketFixture() {
  const region = (id, links, extra = {}) => ({ value: id, label: id, countryId: "public", marketTransportModes: ["airship"], marketLinks: links.map(([regionId, distanceKm]) => ({ regionId, distanceKm, modes: ["airship"] })), ...extra });
  const holding = mergeHoldingDefaults({ id: "holding", name: "Дом", overview: { region: "home" }, storage: { moneyCopper: 500000 }, gm: { calendaria: { lastQd: 0 } }, people: { list: [{ id: "sailor", name: "Матрос", dead: false, wageDailyOverrideCopper: 12 }] } });
  const ship = createShipRecord("magnifique");
  ship.name = "Магнифик";
  ship.crewResidentIds = ["sailor"];
  ship.hiddenCapacityLoadPoints = 200;
  holding.special.ships.list.push(ship);
  const data = {
    meta: { revision: 1 }, holdings: [holding],
    catalog: {
      resources: [{ id: "test-freight", label: "Ткани", basePriceCopper: 30, loadPoints: 4 }],
      eventRegions: [region("home", [["a", 150]]), region("a", [["b", 300]]), region("b", []), region("secret", [], { countryId: "hidden" }), region("closed", [], { marketEnabled: false })],
      marketEconomy: {
        countries: [{ id: "public", label: "Открытая страна", active: true, visibility: "public", taxRate: 0.05 }, { id: "hidden", label: "Секретный порт", active: true, visibility: "gm" }],
        baseOffers: [{ id: "textiles", resourceId: "test-freight", name: "Ткани", kind: "resource", ubiquity: "essential", baseStock: 2000, baseDemand: 2000, priceOverrideCopper: 30, active: true }]
      }
    }
  };
  initializeWorldShip(holding, ship, { profileId: "merchant-barque", clockQd: 0 });
  configureWorldShipEconomy(data, holding, ship);
  return { data, holding, ship };
}

function checkPickupOrdersAndWholesale() {
  const { data, holding, ship } = worldMarketFixture();
  // Use a fully staffed barque here; the shared fixture has only one named sailor.
  for (let index = 1; index < 36; index++) {
    const id = `pickup-sailor-${index}`;
    holding.people.list.push({ id, name: id, wageDailyOverrideCopper: 12 });
    ship.crewResidentIds.push(id);
  }
  const before = JSON.stringify(data);
  const offers = generateWorldShipOffers(data, holding, ship, { period: 0, random: () => 0.3 });
  assert.equal(JSON.stringify(data), before, "customer consignments never mutate retail stocks or world data");
  assert.ok(offers.every((offer) => offer.contract.pickup?.kind === "market"
    && offer.contract.pickup.regionId !== "home" && offer.to.regionId !== "home"),
  "home is only the ship's departure: all customers and consignees are external settlements");
  const obsolete = structuredClone(offers[0]);
  delete obsolete.contract.pickup;
  assert.throws(() => repriceWorldShipOffer(data, holding, ship, obsolete), /не выдаёт мировые заказы/);
  assert.ok(offers[0].contract.cargo.loadPoints >= ship.capacityLoadPoints * 0.6);
  const pickup = offers.find((row) => row.contract.pickup);
  assert.ok(pickup, "a pickup order can be issued from a third port");
  assert.equal(pickup.from.kind, "home");
  assert.equal(pickup.contract.pickup.id, "b");
  assert.equal(pickup.to.id, "a");
  assert.equal(pickup.quote.distanceKm, 750, "distance includes empty approach and loaded delivery");
  assert.equal(pickup.quote.durationQd, 26, "20 QD of flight plus 3 QD each to load and unload the 2820-unit lot");
  assert.deepEqual(worldShipTimeBreakdown(buildShipWorldContext(data, holding), pickup), {
    flightQd: 20, loadingQd: 3, unloadingQd: 3
  }, "transit through another route point adds no unplanned stop");
  assert.equal(pickup.quote.costs.crewCopper, 36 * 12 * 6.5, "crew wages cover flights and both port operations");
  assert.equal(pickup.quote.operatingCopper, ["crewCopper", "foodCopper", "upkeepCopper", "handlingCopper", "taxCopper"]
    .reduce((sum, key) => sum + pickup.quote.costs[key], 0), "combined expense lines equal the total");
  const refreshed = repriceWorldShipOffer(data, holding, ship, pickup);
  assert.deepEqual(refreshed.quote, pickup.quote);
  const slowerPort = structuredClone(data);
  const destination = slowerPort.catalog.eventRegions.find((row) => row.value === "a");
  destination.marketSizeId = "outpost";
  destination.marketTimeFactor = 2;
  const delayed = repriceWorldShipOffer(slowerPort, slowerPort.holdings[0], slowerPort.holdings[0].special.ships.list[0], pickup);
  assert.equal(delayed.quote.durationQd, 35, "an outpost in poor condition needs longer to unload the same lot");
  assert.ok(delayed.quote.operatingCopper > pickup.quote.operatingCopper, "extra port time costs wages and food");
  const unavailable = structuredClone(data);
  unavailable.catalog.eventRegions.find((row) => row.value === "b").marketEnabled = false;
  assert.throws(() => repriceWorldShipOffer(unavailable, holding, ship, pickup), /погрузки/);
  const disconnected = structuredClone(data);
  disconnected.catalog.eventRegions.find((row) => row.value === "a").marketLinks = [];
  assert.throws(() => repriceWorldShipOffer(disconnected, holding, ship, pickup), /маршрут/);
  const noThirdPort = structuredClone(data);
  noThirdPort.catalog.eventRegions.find((row) => row.value === "b").marketEnabled = false;
  assert.throws(() => generateWorldShipOffers(noThirdPort, holding, ship, { period: 0, random: () => 0.3 }), /два внешних поселения/);
  // A bigger wholesale lot should suit a barque even with a small retail shelf.
  const retail = structuredClone(data);
  retail.catalog.marketEconomy.baseOffers[0].baseStock = 60;
  retail.catalog.marketEconomy.baseOffers[0].baseDemand = 60;
  const bulk = generateWorldShipOffers(retail, holding, ship, { period: 0, random: () => 0.3 })[0];
  assert.ok(bulk.contract.cargo.quantity > 60);
  assert.ok(bulk.contract.cargo.loadPoints <= ship.capacityLoadPoints);
  assert.ok(bulk.quote.rewardCopper > bulk.quote.operatingCopper, "ordinary wholesale work pays a standard barque before events");
  let firstSmugglingDraw = true;
  const smugglers = generateWorldShipOffers(data, holding, ship, { period: 0, random: () => {
    if (firstSmugglingDraw) { firstSmugglingDraw = false; return 0.4; }
    return 0.2;
  } });
  assert.ok(smugglers.filter((row) => row.kind === "smuggling").every((row) => row.contract.cargo.loadPoints <= ship.hiddenCapacityLoadPoints));
  const smallCargo = smugglers.find((row) => row.kind === "smuggling");
  assert.ok(smallCargo, "fixture offers a small consignment for minimum handling-time coverage");
  const smallTiming = worldShipTimeBreakdown(buildShipWorldContext(data, holding), smallCargo);
  assert.equal(smallTiming.loadingQd, 1, "small cargo still needs a quarter-day to load");
  assert.equal(smallTiming.unloadingQd, 1, "small cargo still needs a quarter-day to unload");
  departWorldShip(holding, ship, { operationId: "pickup-depart", offer: refreshed, clockQd: 0 });
  assert.equal(ship.activeVoyage.quote.contract.pickup.id, "b");
  const terms = structuredClone(ship.activeVoyage.quote);
  pickup.contract.pickup.label = "Changed after departure";
  assert.deepEqual(ship.activeVoyage.quote, terms, "accepted pickup terms are frozen");
  const result = advanceWorldShips(holding, 14);
  assert.equal(result.awaiting.length, 0, "reaching the pickup does not finish or pay the order");
  advanceWorldShips(holding, 26);
  resolveWorldShip(holding, ship, { operationId: "pickup-resolve", random: () => 0.99 });
  assert.equal(ship.location.id, "a");
  const paid = ship.onboardCopper;
  advanceWorldShips(holding, 26);
  assert.equal(ship.onboardCopper, paid, "repeated processing does not pay twice");
}

function checkHomeDepartureRationPrice() {
  const { data, holding, ship } = worldMarketFixture();
  ship.crewTarget = 1;
  data.catalog.marketEconomy.baseOffers.push({ id: "crew-rations", resourceId: "bread", name: "Хлеб",
    kind: "consumable", ubiquity: "essential", baseStock: 2000, baseDemand: 2000, priceOverrideCopper: 4, active: true });
  const before = quoteWorldShipHomeUpkeep(data, holding, ship).homeUpkeepCopperPerDay;
  const ordinary = generateWorldShipOffers(data, holding, ship, { period: 0, random: () => 0.4 })[0];
  const home = data.catalog.eventRegions.find((region) => region.value === "home");
  home.marketPriceFactor = 3;
  const after = quoteWorldShipHomeUpkeep(data, holding, ship).homeUpkeepCopperPerDay;
  const dearer = generateWorldShipOffers(data, holding, ship, { period: 0, random: () => 0.4 })[0];
  const approachKm = shortestMarketRouteDistanceKm(ordinary.from.regionId, ordinary.contract.pickup.regionId,
    data.catalog.eventRegions, { mode: "airship" });
  const approachQd = Math.ceil(approachKm * 4 / ship.speedKmPerDay);
  assert.ok(after > before, "home ration reflects its market price");
  assert.equal(dearer.quote.costs.foodCopper - ordinary.quote.costs.foodCopper,
    (after - before) * approachQd / 4,
    "empty approach must buy rations at the same home price as home upkeep");
  assert.equal(dearer.quote.costs.crewCopper, ordinary.quote.costs.crewCopper,
    "market ration repricing does not alter crew wages");

  home.marketEnabled = false;
  const detachedSnapshot = JSON.stringify(data);
  const world = buildShipWorldContext(data, holding);
  assert.ok(!world.ports.some((port) => port.regionId === "home"), "a separate home point is not a market");
  const homeRate = quoteWorldShipHomeUpkeep(data, holding, ship, { context: world }).homeUpkeepCopperPerDay;
  const departure = quoteWorldShipRelocation(data, holding, ship, "a", { context: world }).quote;
  assert.equal(departure.durationQd, 4, "the fixture's empty approach lasts one day");
  assert.equal(departure.costs.foodCopper + departure.costs.crewCopper + departure.costs.upkeepCopper, homeRate,
    "a home point without a market uses the same catalog ration fallback at rest and on departure");
  assert.equal(JSON.stringify(data), detachedSnapshot, "ration quotes must not write world data");
}

export function checkWorldShipMarketCharacterization() {
  checkPickupOrdersAndWholesale();
  checkHomeDepartureRationPrice();
  const { data, holding, ship } = worldMarketFixture();
  const beforeView = JSON.stringify(data);
  const context = buildShipWorldContext(data, holding);
  assert.deepEqual(context.ports.map((port) => port.id), ["home", "a", "b"], "closed and GM ports must not create public contracts");
  const relocation = quoteWorldShipRelocation(data, holding, ship, "a", { context });
  assert.equal(relocation.contract, null);
  assert.equal(relocation.quote.rewardCopper, 0, "an empty relocation cannot promise a customer fee");
  assert.equal(relocation.quote.durationQd, 4, "repositioning includes only flight time");
  assert.throws(() => quoteWorldShipRelocation(data, holding, ship, "secret", { context }), /недоступен/);
  assert.throws(() => quoteWorldShipRelocation(data, holding, ship, "home", { context }), /уже находится/);
  assert.equal(JSON.stringify(data), beforeView, "world lookup must never mutate holding/catalog");
  const offers = generateWorldShipOffers(data, holding, ship, { period: 0, random: () => 0.4 });
  assert.equal(offers.length, 3, "an ordinary market board has a variable number of offers");
  assert.deepEqual(generateWorldShipOffers(data, holding, ship, { period: 0, random: () => 0 }), [],
    "a quiet port may have no customer orders in this period");
  const outbound = offers.find((offer) => offer.kind === "freight");
  assert.equal(outbound.to.id, "a");
  assert.equal(outbound.quote.durationQd, 26, "450 km empty approach + 300 km delivery take 20 QD, plus 3 QD each for loading and unloading");
  assert.ok(outbound.quote.costs.crewCopper > 0 && outbound.quote.costs.foodCopper > 0 && outbound.quote.costs.taxCopper > 0);
  const sharedSpace = offers.find((offer) => offer.kind === "commission");
  assert.equal(sharedSpace.contract.cargo.loadPoints, Math.floor(ship.capacityLoadPoints * 0.2));
  assert.ok(sharedSpace.contract.rewardCopper < outbound.contract.rewardCopper,
    "passengers and mail renting one-fifth of the hold must not receive a whole-ship freight fee");
  assert.equal(outbound.quote.idleReserveCopper, Math.ceil(outbound.quote.idleUpkeepCopperPerDay * 14 / 4),
    "a 26-QD voyage reserves the remaining 14 QD of port waiting until the next tenday");
  assert.equal(outbound.quote.costs.totalCopper, ["foodCopper", "crewCopper", "upkeepCopper", "handlingCopper", "taxCopper"].reduce((sum, key) => sum + outbound.quote.costs[key], 0));
  assert.ok(outbound.contract.cargo.loadPoints <= ship.capacityLoadPoints);
  assert.equal(holding.storage.moneyCopper, 500000, "quoting and reserves do not spend money");

  const expensive = structuredClone(data);
  expensive.holdings[0].people.list[0].wageDailyOverrideCopper = 1200;
  const costly = generateWorldShipOffers(expensive, expensive.holdings[0], expensive.holdings[0].special.ships.list[0], { period: 0, random: () => 0.4 })[0];
  assert.equal(costly.quote.rewardCopper, outbound.quote.rewardCopper, "market fees must not reimburse the actual crew's arbitrarily higher wages");
  assert.ok(costly.quote.operatingCopper > outbound.quote.operatingCopper);
  const repriced = repriceWorldShipOffer(expensive, expensive.holdings[0], expensive.holdings[0].special.ships.list[0], outbound);
  assert.equal(repriced.quote.operatingCopper, costly.quote.operatingCopper, "saved offers must use the current crew's actual cost before acceptance");
  assert.equal(repriced.quote.rewardCopper, outbound.quote.rewardCopper);
  assert.deepEqual(repriced.contract.cargo, outbound.contract.cargo);
  assert.throws(() => generateWorldShipOffers({ ...data, catalog: { ...data.catalog, eventRegions: [] } }, holding, ship, { period: 0 }), /локац/);
  assert.throws(() => generateWorldShipOffers(data, holding, ship, { period: 0, random: () => 1 }), /случайн/);

  const initialTreasury = holding.storage.moneyCopper;
  departWorldShip(holding, ship, { operationId: "outbound", offer: outbound, clockQd: 0 });
  embarkShipCrew(holding, ship, 0);
  const homeAfterDeparture = holding.storage.moneyCopper;
  assert.ok(homeAfterDeparture < initialTreasury);
  const snapshot = structuredClone(ship.activeVoyage.quote);
  outbound.quote.rewardCopper = 1;
  assert.deepEqual(ship.activeVoyage.quote, snapshot, "later market changes do not rewrite accepted terms");
  assert.deepEqual(advanceShipVoyages(holding, 40), { returned: [], underway: [], blocked: [], awaiting: [] }, "legacy engine must skip world vessels");
  advanceWorldShips(holding, 40);
  holding.gm.calendaria.lastQd = 40;
  assert.equal(ship.location.id, "a");
  assert.equal(ship.status, "away");
  assert.equal(ship.pendingPortBillCopper, 0, "automatic reserve covers mandatory wait to the next manager decision");
  resolveWorldShip(holding, ship, { operationId: "resolve-a", random: () => 0.99 });
  assert.equal(ship.activeVoyage, null);
  assert.equal(holding.storage.moneyCopper, homeAfterDeparture, "contract payment remains on board");
  const onward = generateWorldShipOffers(data, holding, ship, { period: 1, random: () => 0.99 }).find((offer) => offer.kind === "freight");
  assert.equal(onward.from.id, "a");
  assert.equal(onward.to.id, "b");
  departWorldShip(holding, ship, { operationId: "onward", offer: onward, clockQd: 40 });
  assert.equal(holding.storage.moneyCopper, homeAfterDeparture, "foreign departure cannot pull funds from home");
  const onwardArrivalQd = ship.activeVoyage.arrivalQd;
  assert.ok(onwardArrivalQd > 50, "larger freight requires more port time than the former fixed stop");
  advanceWorldShips(holding, onwardArrivalQd);
  holding.gm.calendaria.lastQd = onwardArrivalQd;
  resolveWorldShip(holding, ship, { operationId: "resolve-b", random: () => 0.99 });
  const closedData = structuredClone(data);
  closedData.catalog.eventRegions.find((row) => row.value === "b").marketEnabled = false;
  assert.equal(quoteWorldShipReturn(closedData, closedData.holdings[0], closedData.holdings[0].special.ships.list[0]).to.kind, "home", "closing the current market must not trap an existing ship when its return route still exists");
  assert.throws(() => generateWorldShipOffers(closedData, closedData.holdings[0], closedData.holdings[0].special.ships.list[0], { period: 1 }), /недоступен/);
  const homeLeg = quoteWorldShipReturn(data, holding, ship);
  assert.throws(() => quoteWorldShipRelocation(data, holding, ship, "home"), /возвращения/,
    "a market in the home region cannot bypass crew return and treasury transfer");
  assert.equal(homeLeg.contract, null);
  assert.equal(homeLeg.quote.rewardCopper, 0);
  assert.equal(homeLeg.quote.durationQd, Math.ceil(homeLeg.quote.distanceKm * 4 / ship.speedKmPerDay),
    "an empty return needs flight time only");
  departWorldShip(holding, ship, { operationId: "return", offer: homeLeg, clockQd: onwardArrivalQd });
  const beforeReturn = structuredClone(holding);
  const present = worldShipPresenceDays(holding, onwardArrivalQd, 90);
  assert.equal(present.get("sailor"), 0, "returned crew rests aboard and uses ship upkeep until explicitly sent to shore duty");
  const report = { work: [], skipped: [], ledger: [] };
  advanceWorldShipEconomy(holding, 90, report, (target, row) => target.ledger.push(row));
  assert.equal(ship.location.kind, "home");
  assert.equal(ship.onboardCopper, 0);
  assert.equal(holding.people.list[0].shipAssignment.away, false);
  assert.equal(report.ledger.filter((row) => row.meta?.internalTransfer).length, 1);
  assert.ok(buildTendayChangeSet(beforeReturn, holding).ships[0].changes.some((row) => row.key === "location" || row.field === "location"));
  const moneyAfterReturn = holding.storage.moneyCopper;
  advanceWorldShipEconomy(holding, 90, report, (target, row) => target.ledger.push(row));
  assert.ok(holding.storage.moneyCopper < moneyAfterReturn, "home upkeep starts only after the return was reported");
  const afterHomeUpkeep = holding.storage.moneyCopper;
  advanceWorldShipEconomy(holding, 90, report, (target, row) => target.ledger.push(row));
  assert.equal(holding.storage.moneyCopper, afterHomeUpkeep, "repeated boundary does not pay or transfer twice");

  const homeRate = ship.homeUpkeepCopperPerDay;
  holding.gm.calendaria.lastQd = 94;
  configureWorldShipEconomy(data, holding, ship);
  assert.equal(ship.pendingPortBillCopper, 0, "refreshing the rate cannot charge days beyond the ship cursor");
  const beforeNextBoundary = holding.storage.moneyCopper;
  advanceWorldShips(holding, 94);
  assert.equal(beforeNextBoundary - holding.storage.moneyCopper, homeRate, "the next time advance charges the waiting day exactly once");
  const custom = { ...createShipRecord("custom-ship"), speedKmPerDay: 210, crewTarget: 32, capacityLoadPoints: 4500, cargoTonnes: 600 };
  initializeWorldShip(holding, custom, { profileId: "merchant-barque", clockQd: 94 });
  assert.deepEqual([custom.speedKmPerDay, custom.crewTarget, custom.capacityLoadPoints, custom.cargoTonnes], [210, 32, 4500, 600], "explicit adoption must preserve existing custom characteristics");
  const removed = worldMarketFixture();
  removed.ship.status = "away";
  assert.throws(() => worldShipPresenceDays(removed.holding, 0, 40), /не совпадают связи/, "inconsistent presence must block a forecast before double food and labor accounting");
  embarkShipCrew(removed.holding, removed.ship, 0);
  removed.ship.crewResidentIds.push("deleted-sailor");
  const disembarked = disembarkShipCrew(removed.holding, removed.ship, 10);
  assert.equal(disembarked.changed, 1);
  assert.equal(disembarked.issues[0].code, "missing", "a deleted resident must not strand the surviving crew");
  const longIds = worldMarketFixture();
  longIds.holding.id = "дом".repeat(30);
  longIds.ship.id = "корабль".repeat(15);
  assert.ok(generateWorldShipOffers(longIds.data, longIds.holding, longIds.ship, { period: 0, random: () => 0.4 }).every((offer) => offer.id.length <= 128), "localized long port/ship IDs must produce sendable operation IDs");
  return { offers: offers.length, fullCycle: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkWorldShipMarketCharacterization();
  console.log("FBL Skyhold world ship market characterization passed.");
}
