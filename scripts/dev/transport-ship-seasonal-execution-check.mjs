import assert from "node:assert/strict";
import { transportFixture, transportRequest, transportHarness } from "./fixtures/transport-v2.mjs";
import { installTransportTestCalendar, transportTestDate, transportTestYearQd as epoch } from "./fixtures/transport-calendar.mjs";
import { prepareTransportContext } from "../apps/domains/transport-context.js";
import { buildShipWorldContext, generateWorldShipOffers, quoteWorldShipBundle, worldShipTransportTerms,
  worldShipTransportOptions } from "../engines/ships/world-market.js";
import { departWorldShipBundle, advanceWorldShips, resolveWorldShipBundleStop, continueWorldShipBundle } from "../engines/ships/world-voyage.js";
import { createShipOperationExecutor } from "../apps/ship-operation-executor.js";
import { transportPeriodCosts, TRANSPORT_LIMITS } from "../engines/transport/quantities.js";
import { transportRiskBps } from "../engines/transport/economics.js";

globalThis.game = { user: { id: "gm", isGM: true }, settings: { get() {} }, modules: new Map() };
const calendar = installTransportTestCalendar();
const winter = { winter: { enabled: true, timeFactor: 4, costFactor: 1, riskFactor: 4 } };
const region = (value, links = [], extra = {}) => ({ value, label: value, countryId: "public", marketTransportModes: ["airship"],
  marketLinks: links.map(([regionId, distanceKm, seasonalModifiers = {}]) => ({ regionId, distanceKm, modes: ["airship"], seasonalModifiers })), ...extra });

try {
  // Both priorities compare complete own-ship plans, including empty approach/return.
  for (const isGM of [true, false]) for (const priority of ["cost", "time"]) {
    const f = transportFixture(); f.holding.gm.calendaria.lastDateTime = transportTestDate(epoch);
    f.data.catalog.eventRegions = [
      region("home", [["a", 150, winter], ["transit", 100]]), region("a"),
      region("transit", [["a", 100]], { marketEnabled: false, marketTransportModes: [] })
    ];
    const request = transportRequest(f, "a", { ownShipId: f.ship.id, priority, returnHome: true }, isGM);
    const discovery = prepareTransportContext({ ...f, request, isGM });
    request.excluded = [...new Set(discovery.services.filter(row => row.kind !== "owned").map(row => row.companyId))];
    const quoted = prepareTransportContext({ ...f, request, isGM });
    assert.equal(quoted.search.limited, false);
    assert.deepEqual(quoted.services.filter(row => row.kind === "owned" && row.from === quoted.from && row.to === quoted.to)
      .map(row => row.distanceKm).sort((a, b) => a - b), [150, 200]);
    assert.equal(quoted.plan.stages[0].service.distanceKm, 200, "a longer open route beats the winter shortcut");
    const control = structuredClone(f.data); control.catalog.eventRegions[0].marketLinks.shift();
    const alternate = prepareTransportContext({ data: control, holding: control.holdings[0], request, isGM });
    for (const key of ["arrivalQd", "totalCopper", "shipReleaseQd"]) assert.equal(quoted.plan[key], alternate.plan[key]);
    const serviceId = quoted.plan.stages[0].service.id;
    request.pins = { [quoted.from]: serviceId };
    const future = structuredClone(f.data), futureHolding = future.holdings[0], futureShip = futureHolding.special.ships.list[0];
    Object.assign(futureHolding.gm.calendaria, { lastQd: 40, lastDateTime: transportTestDate(epoch + 40) });
    futureShip.timelineQd = 40; futureShip.portBilling = null; future.meta.transportV2.clockQd = 40;
    const futureRequest = transportRequest({ data: future, holding: futureHolding, ship: futureShip }, "a", request, isGM);
    assert.ok(prepareTransportContext({ data: future, holding: futureHolding, request: futureRequest, isGM }).plan,
      "a physical-route pin survives a later quote date");
    const h = transportHarness(f), { order, operation, preview } = await h.book(request, `winter-own-${isGM}-${priority}`, isGM);
    const frozen = structuredClone(order.stages[0].service.seasonal);
    h.data.catalog.eventRegions.forEach(row => { row.marketLinks = []; });
    h.advance(preview.plan.shipReleaseQd);
    assert.equal(order.status, "delivered"); assert.deepEqual(order.stages[0].service.seasonal, frozen);
    assert.equal(order.ownedActualCopper, preview.plan.ownExpensesCopper);
    const saved = structuredClone(h.data);
    assert.equal((await h.execute(operation, { userId: isGM ? "gm" : "player", remote: !isGM })).replay, true);
    assert.deepEqual(h.data, saved);
  }
  // Search exhaustion remains explicit even for a usable shortest-path fallback.
  {
    const f = transportFixture(), links = to => Array.from({ length: 150 }, (_, i) => ({
      regionId: to, routeId: String(i), distanceKm: i + 1, ursCost: 1, modes: ["airship"], seasonalModifiers: winter
    }));
    f.holding.gm.calendaria.lastDateTime = transportTestDate(epoch);
    f.data.catalog.eventRegions = [region("home"), region("a"), region("b")];
    f.data.catalog.eventRegions[0].marketLinks = links("a"); f.data.catalog.eventRegions[1].marketLinks = links("b");
    const result = worldShipTransportOptions(f.data, f.holding, f.ship, "home", "b", { maxAccess: 6 });
    assert.equal(result.limited, true); assert.ok(result.terms.length);
  }
  // Dense seasonal graphs must share a quote budget, rather than preparing
  // thousands of alternatives independently for every pair of ports.
  {
    const f = transportFixture(), names = ["home", "a", "b", ...Array.from({ length: 5 }, (_, i) => `dense-${i}`)];
    f.data.catalog.eventRegions = names.map((name, i) => region(name, names.slice(i + 1).map((to, j) =>
      [to, 10 + j, { winter: { enabled: true, timeFactor: 1 + (i + j) % 3, riskFactor: 1 } }])));
    const request = transportRequest(f, "a", { ownShipId: f.ship.id });
    const result = prepareTransportContext({ ...f, request, isGM: true });
    assert.ok(result.plan);
    assert.equal(result.search.limits.routes, true, "truncated physical alternatives cannot be presented as a complete search");
    assert.ok(result.services.filter(row => row.kind === "owned").length <= names.length * (names.length - 1) + TRANSPORT_LIMITS.paths,
      "one baseline per pair and a shared extra-route budget bound retained services");
  }

  for (const legacy of [false, true]) for (const isGM of [true, false]) {
    const f = transportFixture(), base = epoch + 108;
    f.ship.speedKmPerDay = 160; f.ship.location = { kind: "market", id: "a", regionId: "a", label: "A" };
    f.ship.status = "away"; f.ship.onboardCopper = 100000;
    f.holding.gm.calendaria.lastDateTime = transportTestDate(base);
    f.data.catalog.eventRegions = [region("home", [["a", 10, winter]]), region("a", [["b", 10, winter]]),
      region("b", [["c", 80, winter]]), region("c")];
    f.data.catalog.marketEconomy.baseOffers[0].baseStock = 1; f.data.catalog.marketEconomy.baseOffers[0].baseDemand = 1;
    f.data.catalog.transportV2.riskBps = 3000;
    const context = buildShipWorldContext(f.data, f.holding);
    let pair;
    for (let seed = 1; seed < 1000 && !pair; seed++) {
      let state = seed;
      const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
      const offers = generateWorldShipOffers(f.data, f.holding, f.ship, { period: 0, random, context });
      pair = ["b", "c"].map(id => offers.find(offer => offer.to.id === id && !offer.contract.pickup && offer.kind === "freight"));
      if (pair.some(row => !row)) pair = null;
    }
    assert.ok(pair);
    const plan = quoteWorldShipBundle(f.data, f.holding, f.ship, pair, { context });
    const original = structuredClone(plan.stops[1]);
    assert.equal(original.legOffer.quote.durationQd, 9);
    if (legacy) for (const stop of plan.stops) delete stop.legOffer.quote.seasonal;
    departWorldShipBundle(f.holding, f.ship, { operationId: "season-bundle", plan, clockQd: 0 });
    f.holding.gm.calendaria.lastQd = 40; f.holding.gm.calendaria.lastDateTime = transportTestDate(base + 40);
    advanceWorldShips(f.holding, 40);
    assert.equal(f.ship.timelineQd, 3);
    let roll = 0; const draws = [0, 0, 0.5, 0.5];
    resolveWorldShipBundleStop(f.holding, f.ship, { operationId: "first-outcome", bundleId: "season-bundle",
      random: () => draws[roll++] ?? 0.5 });
    const leave = f.ship.orderBundle.delayUntilQd; assert.equal(leave, 11);
    advanceWorldShips(f.holding, leave);
    const terms = worldShipTransportTerms(f.data, f.holding, f.ship, "b", "c", { fromHome: false, toHome: false, startQd: leave });
    assert.equal(terms.durationQd + 1, 4);
    // Reload, then change today's catalog and ship inputs: the accepted snapshot must survive.
    let data = JSON.parse(JSON.stringify(f.data)), holding = data.holdings[0], ship = holding.special.ships.list[0];
    holding.gm.calendaria.lastQd = leave;
    data.catalog.eventRegions.forEach(row => { row.marketLinks = []; }); ship.speedKmPerDay = 1;
    const bundle = ship.orderBundle, next = bundle.stops[1], before = structuredClone(next);
    ship.onboardCopper = 0;
    const blocked = continueWorldShipBundle(holding, ship, { operationId: "unfunded", bundleId: bundle.id, clockQd: leave });
    assert.equal(blocked.blocked, true); assert.deepEqual(next, before, "unfunded retry cannot replace accepted physical terms");
    assert.equal(bundle.totalOperatingCopper, plan.totalOperatingCopper);
    ship.onboardCopper = 100000;
    if (!legacy) {
      const api = globalThis.CALENDARIA, ledger = structuredClone(ship.worldLedger); globalThis.CALENDARIA = undefined;
      assert.throws(() => continueWorldShipBundle(holding, ship, { operationId: "offline", bundleId: bundle.id, clockQd: leave }), /Calendaria/);
      assert.deepEqual(ship.worldLedger, ledger); assert.deepEqual(next, before); globalThis.CALENDARIA = api;
    }
    const skipKey = Symbol("skip");
    const execute = createShipOperationExecutor({ getUser: id => ({ id, isGM: id === "gm" }), skip: value => ({ [skipKey]: true, value }),
      updateHolding: async (_id, updater) => {
        const draft = structuredClone(data), result = await updater(draft.holdings[0], draft);
        if (result?.[skipKey]) return result.value;
        draft.meta.revision++; data = draft; return result;
      } });
    const actor = { userId: isGM ? "gm" : "player", remote: !isGM };
    const command = { type: "continue-bundle", operationId: "season-continue", holdingId: holding.id, shipId: ship.id,
      voyageId: bundle.id, expectedRevision: data.meta.revision, locationKind: "market", locationId: "b" };
    await execute(command, actor);
    holding = data.holdings[0]; ship = holding.special.ships.list[0];
    assert.equal(ship.activeVoyage.quote.durationQd, legacy ? 9 : 4);
    const expectedCosts = transportPeriodCosts(4, original.legOffer.quote.seasonal.dailyCosts);
    const expectedOperating = expectedCosts.totalCopper + original.legOffer.quote.costs.handlingCopper + original.legOffer.quote.costs.taxCopper;
    assert.equal(ship.activeVoyage.quote.operatingCopper, legacy ? original.legOffer.quote.operatingCopper : expectedOperating);
    assert.equal(ship.onboardCopper, 100000 - ship.activeVoyage.quote.operatingCopper, "the actual leg is charged once");
    assert.equal(ship.orderBundle.totalOperatingCopper,
      ship.orderBundle.stops.reduce((sum, stop) => sum + stop.legOffer.quote.operatingCopper, 0));
    assert.equal(ship.orderBundle.totalDurationQd,
      ship.orderBundle.stops.reduce((sum, stop) => sum + stop.legOffer.quote.durationQd, 0));
    assert.equal(ship.orderBundle.stops[1].economics.riskBps, legacy ? original.economics.riskBps
      : transportRiskBps(terms.riskExposureQd, 3000));
    assert.deepEqual(ship.orderBundle.orders.map(row => row.offer.contract.rewardCopper), pair.map(row => row.contract.rewardCopper));
    const saved = structuredClone(data);
    assert.equal((await execute(command, actor)).replay, true); assert.deepEqual(data, saved);
  }
} finally { calendar.restore(); }
console.log("Ship seasonal execution: physical route alternatives, non-port transit, priorities, approach/return, frozen catalog, bounded search, real bundle delay, costs/risk, unpaid/offline retry, legacy terms and GM/player replay passed.");
