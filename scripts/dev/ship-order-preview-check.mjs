import assert from "node:assert/strict";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { generateWorldShipOffers, quoteWorldShipBundle, repriceWorldShipOffer, worldShipTimeBreakdown } from "../engines/ships/world-market.js";
import { advanceWorldShips, departWorldShip, departWorldShipBundle, resolveWorldShip, resolveWorldShipBundleStop } from "../engines/ships/world-voyage.js";
import { previewShipOrders } from "../engines/ships/order-preview.js";
import { shipRouteMapContext } from "../apps/common/route-map-view.js";
import { ShipOrderPlanner } from "../apps/ship-order-planner.js";
import { shipOperationIntent } from "../apps/domains/events/ship-events.js";
import { createShipOperationExecutor } from "../apps/ship-operation-executor.js";

function fixture() {
  const result = worldMarketFixture();
  const { data, holding, ship } = result;
  holding.visibility = "public";
  holding.gm.playersCanManageShips = true;
  ship.crewTarget = 1;
  ship.commanderName = "Капитан";
  // Customer cargo is picked up at an external port, one kilometre from home.
  data.catalog.eventRegions.push({ ...structuredClone(data.catalog.eventRegions[0]), value: "origin", label: "origin",
    marketLinks: [{ regionId: "home", distanceKm: 1, modes: ["airship"] }] });
  const board = generateWorldShipOffers(data, holding, ship, { period: 0, random: () => 0.4 });
  const job = (id, to, load, pickup = null) => {
    const offer = structuredClone(board[0]);
    Object.assign(offer, { id, title: `Груз ${id}`, to: { kind: "market", id: to, regionId: to, label: to } });
    Object.assign(offer.contract, { destination: to, directionKey: `port:${to}` });
    Object.assign(offer.contract.cargo, { quantity: load / 4, loadPoints: load, valueCopper: load * 8 });
    if (pickup) offer.contract.pickup = { kind: "market", id: pickup, regionId: pickup, label: pickup };
    else offer.contract.pickup = { kind: "market", id: "origin", regionId: "origin", label: "origin" };
    return offer;
  };
  holding.special.ships.offers = [job("first", "a", 1200), job("second", "b", 1200), job("pickup", "b", 600, "a")];
  data.catalog.eventRegions.forEach((row, index) => { row.marketMapX = 100 + index * 150; row.marketMapY = 100 + index * 70; });
  return { ...result, job };
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

{
  const { data, holding, ship } = fixture();
  const before = JSON.stringify(data);
  const normal = repriceWorldShipOffer(data, holding, ship, holding.special.ships.offers[0]);
  const oldRandom = Math.random;
  Math.random = () => { throw new Error("preview rolled randomness"); };
  freeze(data);
  try {
    for (const style of ["normal", "cautious", "bold"]) {
      const single = previewShipOrders(data, holding, ship, { offerIds: ["first"], style });
      assert.equal(single.totalDurationQd, normal.quote.durationQd);
      assert.equal(single.totalOperatingCopper, normal.quote.operatingCopper);
      assert.equal(single.mandatoryTripCopper, single.totalOperatingCopper + single.guaranteedStyleCostCopper);
      assert.equal(single.recommendedReserveCopper, single.recommendedBudgetCopper - single.mandatoryTripCopper);
      assert.equal(single.effectiveBudgetCopper, single.recommendedBudgetCopper);
      assert.equal(single.plannedReserveCopper, single.recommendedReserveCopper);
      assert.equal(single.totalDurationQd, single.flightQd + single.portQd);
      assert.equal(single.finalPoint.id, "a");
      assert.equal(single.legs[0].loadOnLegPoints, 0, "leave home empty");
      assert.equal(single.legs[1].loadOnLegPoints, 1200);
      assert.equal(single.canDepart, true, single.blockers.join("; "));
      const ids = ["first", "second", "pickup"];
      const preview = previewShipOrders(data, holding, ship, { offerIds: ids, style });
      const quote = quoteWorldShipBundle(data, holding, ship, preview.offers);
      assert.equal(preview.totalOperatingCopper, quote.totalOperatingCopper);
      assert.equal(preview.totalDurationQd, quote.totalDurationQd);
      assert.equal(preview.recommendedBudgetCopper, quote.recommendedBudgetCopper);
      assert.equal(preview.mandatoryTripCopper, preview.totalOperatingCopper + preview.guaranteedStyleCostCopper);
      assert.equal(preview.recommendedReserveCopper, preview.recommendedBudgetCopper - preview.mandatoryTripCopper);
      assert.equal(preview.plannedReserveCopper, preview.recommendedReserveCopper);
      assert.deepEqual(preview.stops.map((stop) => stop.point.id), [holding.id, "origin", "a", "b"]);
      assert.deepEqual(preview.legs.map((leg) => leg.loadOnLegPoints), [0, 2400, 1800]);
      assert.deepEqual(preview.legs.map((leg) => leg.offerIds), [[], ["first", "second"], ["second", "pickup"]]);
      assert.equal(preview.totalDurationQd, preview.flightQd + preview.portQd);
      assert.equal(preview.finalPoint.id, "b");
    }
    assert.equal(JSON.stringify(data), before, "even nested frozen input must be untouched");
  } finally { Math.random = oldRandom; }
}

{
  const { data, holding, ship, job } = fixture();
  holding.special.ships.offers.push(job("remote", "a", 1200, "b"));
  const remote = previewShipOrders(data, holding, ship, { offerIds: ["remote"] });
  assert.deepEqual(remote.legs.map((leg) => [leg.from.regionId, leg.to.regionId, leg.loadOnLegPoints]), [["home", "b", 0], ["b", "a", 1200]]);
  assert.equal(remote.distanceKm, 750);
  assert.equal(remote.flightQd, 20);
  assert.deepEqual(remote.stops.map((stop) => stop.point.regionId), ["home", "b", "a"], "a transit node is not a stop");
  assert.throws(() => previewShipOrders(data, holding, ship, { offerIds: ["pickup", "remote"] }), /Повторный заход/);
  assert.throws(() => previewShipOrders(data, holding, ship, { offerIds: ["first", "first"] }), /дважды/);
  assert.throws(() => previewShipOrders(data, holding, ship, { offerIds: ["first", "second", "pickup", "remote"] }), /трёх/);
  holding.special.ships.offers.push(job("large", "b", 3000));
  assert.throws(() => previewShipOrders(data, holding, ship, { offerIds: ["first", "large"] }), /4200.*4000/);
  holding.special.ships.offers.push(job("later-overload", "b", 3000, "a"));
  assert.throws(() => previewShipOrders(data, holding, ship, { offerIds: ["first", "second", "later-overload"] }), /промежуточных участках/);
  const smuggled = [job("hidden-a", "a", 120), job("hidden-b", "b", 120)];
  for (const offer of smuggled) { offer.contract.kind = "smuggling"; offer.contract.cargo.kind = "smuggling"; }
  holding.special.ships.offers.push(...smuggled);
  assert.throws(() => previewShipOrders(data, holding, ship, { offerIds: smuggled.map((offer) => offer.id) }), /тайники: 240 \/ 200/);
  const stale = holding.special.ships.offers[0];
  stale.consumedBy = "other";
  assert.throws(() => previewShipOrders(data, holding, ship, { offerIds: [stale.id] }), /устарел/);
  delete stale.consumedBy;
  stale.period = 1;
  assert.throws(() => previewShipOrders(data, holding, ship, { offerIds: [stale.id] }), /устарел/);
  stale.period = 0;
  stale.shipId = "another";
  assert.throws(() => previewShipOrders(data, holding, ship, { offerIds: [stale.id] }), /устарел/);
  stale.shipId = ship.id;
  data.catalog.eventRegions[0].marketLinks = [];
  assert.throws(() => previewShipOrders(data, holding, ship, { offerIds: [stale.id] }), /Нет воздушного маршрута/);
}

{
  const { data, holding, ship, job } = fixture();
  ship.location = { kind: "market", id: "a", regionId: "a", label: "a" };
  ship.status = "away";
  const offer = job("foreign", "b", 600);
  delete offer.contract.pickup;
  offer.from = { ...ship.location };
  holding.special.ships.offers = [offer];
  ship.onboardCopper = 50000;
  ship.timelineQd = holding.gm.calendaria.lastQd = 4;
  ship.portBilling = { scope: "foreign", sinceQd: 0, lastCalculatedQd: 0, dailyCopper: 100, carriedCopper: 0, chargedCopper: 0 };
  const plan = previewShipOrders(data, holding, ship, { offerIds: [offer.id] });
  assert.equal(plan.atHome, false);
  assert.equal(plan.debtCopper, 100);
  assert.equal(plan.transferCopper, 0);
  assert.equal(plan.targetBudgetCopper, 49900);
  ship.onboardCopper = plan.firstLegCopper + 99;
  const missing = previewShipOrders(data, holding, ship, { offerIds: [offer.id] });
  assert.equal(missing.shortageCopper, 1, "foreign departure cannot spend home treasury or future contract payouts");
  assert.equal(missing.canDepart, false);
  ship.onboardCopper++;
  const minimal = previewShipOrders(data, holding, ship, { offerIds: [offer.id] });
  assert.equal(minimal.canDepart, true);
  assert.ok(minimal.reserveShortageCopper > 0, "a deliberately small reserve is a warning, not a new rule");
}

{
  const { data, holding, ship } = fixture();
  const get = (budgetCopper = null) => previewShipOrders(data, holding, ship, { offerIds: ["first"], budgetCopper });
  ship.onboardCopper = 1000;
  ship.timelineQd = holding.gm.calendaria.lastQd = 4;
  ship.portBilling = { scope: "home", sinceQd: 0, lastCalculatedQd: 0, dailyCopper: 100, carriedCopper: 0, chargedCopper: 0 };
    const withBill = get();
  assert.equal(withBill.debtCopper, 100);
  assert.equal(withBill.transferCopper, Math.max(0, withBill.recommendedBudgetCopper - 900));
  const tripOnly = get(withBill.totalOperatingCopper);
  assert.equal(tripOnly.canDepart, true, "trip-only budget without extra reserve remains sendable at home");
  assert.equal(tripOnly.plannedReserveCopper, Math.max(0, Math.max(900, withBill.totalOperatingCopper) - withBill.totalOperatingCopper));
  assert.equal(tripOnly.effectiveBudgetCopper, Math.max(900, withBill.totalOperatingCopper));
  assert.equal(get(0).canDepart, false, "explicit zero is not automatic budget");
  holding.storage.moneyCopper = 0;
  assert.equal(get().canDepart, false);
  assert.ok(get().shortageCopper > 0);
  holding.storage.moneyCopper = 500000;
  holding.gm.calendaria.lastQd = 0;
  assert.match(get().blockers.join(" "), /раньше времени/);
  holding.gm.calendaria.lastQd = 4;
  ship.crewTarget = 10;
  assert.equal(get().canDepart, false, "preview remains visible with an unready crew");
  ship.crewTarget = 1;
  ship.condition = "damaged";
  assert.match(get().blockers.join(" "), /ремонта/);
}

{
  const { data, holding, ship } = fixture();
  const home = data.catalog.eventRegions[0];
  home.marketLinks[0].distanceKm = 400;
  home.marketLinks.push({ regionId: "a", distanceKm: 100, modes: ["airship"], routeId: "fast", pathPoints: [{ x: 180, y: 260 }] });
  let preview = previewShipOrders(data, holding, ship, { offerIds: ["first"] });
  assert.equal(preview.legs[1].route.edges[1].routeId, "fast");
  let map = shipRouteMapContext(preview, { background: "maps/world.webp" });
  assert.ok(map.lines.some((line) => /180,260/.test(line.points)));
  assert.equal(map.background, "maps/world.webp");
  assert.equal(map.nodes.some((node) => node.id === "secret"), false);
  const reverse = structuredClone(preview);
  const line = reverse.legs[1];
  [line.from, line.to] = [line.to, line.from];
  line.route.edges = [{ ...line.route.edges[1], from: "a", to: "home" }];
  map = shipRouteMapContext(reverse);
  assert.equal(map.lines[1].points, "250,170 180,260 100,100", "parallel edge bends reverse with the flight");
  data.catalog.eventRegions[0].marketMapX = data.catalog.eventRegions[0].marketMapY = 0;
  preview = previewShipOrders(data, holding, ship, { offerIds: ["first"] });
  assert.equal(shipRouteMapContext(preview).schematic, true);
}

// The existing GM and player command paths must execute exactly the reviewed amounts.
for (const isGM of [true, false]) {
  for (const ids of [["first"], ["first", "second", "pickup"]]) {
    let { data, holding, ship } = fixture();
    const user = { id: isGM ? "gm" : "player", isGM };
    const plan = previewShipOrders(data, holding, ship, { offerIds: ids, style: "cautious" });
    const beforeMoney = holding.storage.moneyCopper;
    const skipToken = Symbol("skip");
    let commits = 0;
    const execute = createShipOperationExecutor({ getUser: () => user, random: () => 0.99,
      skip: (value) => ({ [skipToken]: true, value }),
      updateHolding: async (id, callback) => {
        const draft = structuredClone(data);
        const result = await callback(draft.holdings.find((row) => row.id === id), draft);
        if (result?.[skipToken]) return result.value;
        draft.meta.revision++; data = draft; commits++; return result;
      } });
    const intent = shipOperationIntent({ type: ids.length === 1 ? "depart-world" : "depart-bundle", holding, ship,
      card: { querySelectorAll: () => ids.map((value) => ({ value })), querySelector: (selector) => ({ value: selector.includes("style") ? "cautious" : "" }) },
      button: { dataset: { shipPlanned: "" }, closest: () => null } });
    const command = { ...intent, operationId: `preview-${isGM}-${ids.length}`, expectedRevision: data.meta.revision };
    await assert.rejects(execute({ ...command, expectedRevision: 0 }, { userId: user.id, remote: !isGM }), /изменил|устарел/i);
    assert.equal(commits, 0);
    const result = await execute(command, { userId: user.id, remote: !isGM });
    assert.equal(result.ok, true);
    const updated = data.holdings[0].special.ships.list[0];
    assert.equal(updated.activeVoyage.quote.operatingCopper, plan.firstLegCopper);
    assert.equal(data.holdings[0].storage.moneyCopper, beforeMoney - plan.transferCopper);
    assert.equal(updated.onboardCopper, plan.recommendedBudgetCopper - plan.firstLegCopper);
    assert.equal((await execute(command, { userId: user.id, remote: !isGM })).replay, true);
    assert.equal(commits, 1);
  }
}

{
  let { data, holding, ship } = fixture();
  globalThis.game = { user: { id: "gm", isGM: true } };
  const controller = new ShipOrderPlanner({ holdingId: holding.id, shipId: ship.id, getData: () => data });
  const budgetField = { value: "" };
  controller.root = { querySelector: (selector) => selector.includes("style") ? { value: "normal" } : budgetField };
  controller.selected.add("first");
  controller.reviewed = controller.calculate();
  assert.equal(controller.assertReviewed().plan.finalPoint.id, "a");
  const basePlan = controller.cache.basePlan;
  budgetField.value = "0";
  assert.equal(controller.calculate().plan.canDepart, false);
  assert.equal(controller.cache.basePlan, basePlan, "budget input reuses the market and route calculation");
  budgetField.value = (basePlan.totalOperatingCopper / 100).toFixed(2);
  const minimumBudget = controller.calculate();
  assert.equal(minimumBudget.plan.canDepart, true);
  assert.equal(minimumBudget.plan.plannedReserveCopper, 0);
  assert.equal(minimumBudget.plan.reserveShortageCopper, basePlan.recommendedReserveCopper);
  budgetField.value = "";
  let refreshed = 0;
  controller.update = () => { refreshed++; };
  data = structuredClone(data); data.meta.revision++;
  assert.throws(() => controller.assertReviewed(), /Данные изменились/);
  assert.equal(refreshed, 1);
  controller.reviewed = controller.calculate();
  game.user = { id: "player", isGM: false };
  assert.throws(() => controller.assertReviewed(), /недоступно/, "player cannot send without authority GM");
  data.holdings[0].gm.playersCanManageShips = false;
  assert.equal(controller.calculate().permissions.canManageShips, false);
  data.holdings[0].visibility = "gm";
  assert.throws(() => controller.calculate(), /недоступно/, "loss of read permission is checked before returning a cached preview");
  controller.clear();
  assert.equal(controller.selected.size, 0);
}

{
  const { data, holding, ship } = fixture();
  globalThis.game = { user: { id: "gm", isGM: true } };
  const listeners = new Map();
  let inputEvents = 0;
  let focused = "";
  const budgetField = { value: "", matches: (selector) => selector === "[data-ship-bundle-budget]",
    dispatchEvent(event) { inputEvents += 1; listeners.get(event.type)?.({ target: this }); } };
  const modeField = { value: "recommended", matches: (selector) => selector === "[data-ship-bundle-budget-mode]",
    dispatchEvent(event) { inputEvents += 1; listeners.get(event.type)?.({ target: this }); } };
  const styleField = { value: "normal", matches: (selector) => selector === "[data-ship-bundle-style]" };
  const minimumButton = { dataset: { shipPlannerBudgetPreset: "minimum" },
    focus() { focused = "minimum"; }, closest: (selector) => selector === "[data-ship-planner-budget-preset]" ? minimumButton : null };
  const recommendedButton = { dataset: { shipPlannerBudgetPreset: "recommended" },
    focus() { focused = "recommended"; }, closest: (selector) => selector === "[data-ship-planner-budget-preset]" ? recommendedButton : null };
  const output = { innerHTML: "", contains: (node) => node === minimumButton || node === recommendedButton, querySelectorAll: () => [],
    querySelector: (selector) => selector === '[data-ship-planner-budget-preset="minimum"]' ? minimumButton
      : selector === '[data-ship-planner-budget-preset="recommended"]' ? recommendedButton : null };
  const root = {
    querySelector: (selector) => ({ "[data-ship-planner-preview]": output, "[data-ship-bundle-budget]": budgetField,
      "[data-ship-bundle-budget-mode]": modeField, "[data-ship-bundle-style]": styleField })[selector] ?? null,
    querySelectorAll: () => [],
    addEventListener(type, fn) { listeners.set(type, fn); }
  };
  const previousHandlebars = globalThis.Handlebars;
  const previousDocument = globalThis.document;
  let lastContext = null;
  globalThis.Handlebars = { partials: { "modules/fbl-skyhold/templates/parts/ship-window/order-preview.hbs": (ctx) => { lastContext = ctx; return "ok"; } } };
  globalThis.document = { activeElement: minimumButton };
  try {
    const controller = new ShipOrderPlanner({ holdingId: holding.id, shipId: ship.id, getData: () => data });
    controller.selected.add("first");
    controller.bind(root);
    assert.equal(lastContext.isAutoBudget, true);
    assert.equal(lastContext.isTripOnlyBudget, false);
    const firstMandatory = lastContext.mandatoryTripCopper;

    // Switching to "Только рейс" tracks mode separately and recalculates across order and style changes.
    listeners.get("click")({ target: minimumButton });
    assert.ok(inputEvents >= 1, "preset switch dispatches input so drafts stay synchronized");
    assert.equal(modeField.value, "minimum");
    assert.equal(budgetField.value, (firstMandatory / 100).toFixed(2));
    assert.equal(lastContext.isAutoBudget, false);
    assert.equal(lastContext.isTripOnlyBudget, true);
    assert.equal(lastContext.plannedReserveCopper, 0);
    assert.equal(focused, "minimum", "re-rendering preview preserves focus on the activated budget preset");

    // Switching to a more expensive order recalculates minimum mode instead of leaving the old sum.
    controller.selected.clear();
    controller.selected.add("second");
    controller.update();
    const secondMandatory = lastContext.mandatoryTripCopper;
    assert.notEqual(secondMandatory, firstMandatory);
    assert.equal(lastContext.isTripOnlyBudget, true);
    assert.equal(budgetField.value, (secondMandatory / 100).toFixed(2), "minimum mode follows the newly selected order");

    // Switching to cautious adds guaranteed precaution fee to minimum mode automatically.
    styleField.value = "cautious";
    listeners.get("change")({ target: styleField });
    assert.ok(lastContext.guaranteedStyleCostCopper > 0);
    assert.equal(lastContext.mandatoryTripCopper, lastContext.totalOperatingCopper + lastContext.guaranteedStyleCostCopper);
    assert.equal(budgetField.value, (lastContext.mandatoryTripCopper / 100).toFixed(2));
    assert.equal(lastContext.nominalExitCopper, lastContext.rewardCopper - lastContext.mandatoryTripCopper - lastContext.returnReserveCopper);

    // Switching back to the cheaper order lowers the budget so no excess is withdrawn from treasury.
    styleField.value = "normal";
    controller.selected.clear();
    controller.selected.add("first");
    controller.update();
    assert.equal(budgetField.value, (firstMandatory / 100).toFixed(2));

    // Manual input exits minimum mode into custom mode; switching back to recommended clears the field.
    budgetField.value = "5.00";
    listeners.get("input")({ target: budgetField });
    assert.equal(modeField.value, "custom");
    assert.equal(lastContext.isTripOnlyBudget, false);
    assert.equal(lastContext.isAutoBudget, false);
    globalThis.document.activeElement = recommendedButton;
    listeners.get("click")({ target: recommendedButton });
    assert.equal(modeField.value, "recommended");
    assert.equal(budgetField.value, "");
    assert.equal(lastContext.isAutoBudget, true);
    assert.equal(focused, "recommended");
    controller.close();
  } finally {
    globalThis.Handlebars = previousHandlebars;
    globalThis.document = previousDocument;
  }
}

// P1: cautious single order and cautious bundle sent with "Только рейс" resolve a quiet trip without waitingFunds.
{
  const { data, holding, ship } = fixture();
  ship.onboardCopper = 0;
  const plan = previewShipOrders(data, holding, ship, { offerIds: ["first"], style: "cautious" });
  assert.ok(plan.guaranteedStyleCostCopper > 0);
  const tripOnly = previewShipOrders(data, holding, ship, { offerIds: ["first"], style: "cautious", budgetCopper: plan.mandatoryTripCopper });
  assert.equal(tripOnly.canDepart, true);
  assert.equal(tripOnly.plannedReserveCopper, 0);
  assert.equal(tripOnly.firstLegShortageCopper, 0);
  assert.equal(tripOnly.remainingTripShortageCopper, 0);
  assert.equal(tripOnly.extraReserveShortageCopper, tripOnly.recommendedReserveCopper);
  const departed = departWorldShip(holding, ship, { operationId: "cautious-min", offer: tripOnly.offers[0], style: "cautious", budgetCopper: tripOnly.mandatoryTripCopper, clockQd: 0 });
  assert.equal(departed.ok, true);
  assert.equal(ship.onboardCopper, plan.guaranteedStyleCostCopper, "precaution fee remains onboard for arrival resolution");
  holding.gm.calendaria.lastQd = departed.arrivalQd;
  advanceWorldShips(holding, departed.arrivalQd);
  const resolved = resolveWorldShip(holding, ship, { operationId: "cautious-min-resolve", random: () => 0.99 });
  assert.equal(resolved.waitingFunds, false, "quiet cautious arrival pays precaution fee and collects reward without GM intervention");
  assert.equal(resolved.pending, false);
  assert.equal(ship.onboardCopper, resolved.outcome.rewardCopper);
}
{
  const { data, holding, ship } = fixture();
  ship.onboardCopper = 0;
  const plan = previewShipOrders(data, holding, ship, { offerIds: ["first", "second"], style: "cautious" });
  assert.ok(plan.guaranteedStyleCostCopper > 0);
  const bundleQuote = quoteWorldShipBundle(data, holding, ship, plan.offers);
  const departed = departWorldShipBundle(holding, ship, { operationId: "cautious-bundle-min", plan: bundleQuote, style: "cautious", budgetCopper: plan.mandatoryTripCopper, clockQd: 0 });
  assert.equal(departed.ok, true);
  holding.gm.calendaria.lastQd = departed.arrivalQd;
  advanceWorldShips(holding, departed.arrivalQd);
  const firstStop = resolveWorldShipBundleStop(holding, ship, { operationId: "cautious-bundle-stop-0", bundleId: departed.bundleId, random: () => 0.99 });
  assert.equal(firstStop.waitingFunds, false, "empty approach stop in a cautious bundle pays its guaranteed precaution fee cleanly");
  assert.equal(firstStop.pending, false);
}

// P2: shortfall buckets separate first leg, remaining mandatory costs, and optional reserve cleanly.
{
  const { data, holding, ship } = fixture();
  ship.onboardCopper = 0;
  const zero = previewShipOrders(data, holding, ship, { offerIds: ["first"], style: "cautious", budgetCopper: 0 });
  assert.equal(zero.canDepart, false);
  assert.equal(zero.firstLegShortageCopper, zero.firstLegCopper);
  assert.equal(zero.remainingTripShortageCopper, zero.guaranteedStyleCostCopper);
  assert.equal(zero.extraReserveShortageCopper, zero.recommendedReserveCopper);
  assert.equal(zero.firstLegShortageCopper + zero.remainingTripShortageCopper + zero.extraReserveShortageCopper, zero.reserveShortageCopper);
  // Already-funded onboard wallet preserves surplus without extra treasury transfer.
  ship.onboardCopper = zero.mandatoryTripCopper + 500;
  const surplus = previewShipOrders(data, holding, ship, { offerIds: ["first"], style: "cautious", budgetCopper: zero.mandatoryTripCopper });
  assert.equal(surplus.walletCoversTarget, true);
  assert.equal(surplus.transferCopper, 0);
  assert.equal(surplus.effectiveBudgetCopper, ship.onboardCopper);
  assert.equal(surplus.plannedReserveCopper, 500);
}

// P2: seasonal flight multipliers (speedup, slowdown, boundary transition) stay synchronized with quote timing.
for (const [label, multiplier, clockQd] of [["winter-fast", 0.25, 0], ["winter-slow", 2, 0], ["season-boundary", 2, 36]]) {
  const { data, holding, ship } = fixture();
  data.catalog.marketEconomy.seasons = {
    currentSeasonId: "winter",
    sequence: ["winter", "spring"],
    periodDays: 10
  };
  for (const region of data.catalog.eventRegions) {
    for (const link of region.marketLinks ?? []) {
      link.seasonalModifiers = { winter: { enabled: true, timeMultiplier: multiplier, costMultiplier: 1, riskMultiplier: 1 } };
    }
  }
  ship.timelineQd = holding.gm.calendaria.lastQd = clockQd;
  const single = previewShipOrders(data, holding, ship, { offerIds: ["first"] });
  const timing = worldShipTimeBreakdown(single.world, single.offers[0]);
  assert.equal(single.flightQd, timing.flightQd, `${label}: single flightQd matches seasonal quote`);
  assert.equal(single.portQd, timing.loadingQd + timing.unloadingQd, `${label}: single portQd never goes negative`);
  assert.ok(single.portQd >= 0);
  assert.equal(single.legs.reduce((sum, leg) => sum + leg.flightQd, 0), single.flightQd);

  const bundle = previewShipOrders(data, holding, ship, { offerIds: ["first", "second", "pickup"] });
  assert.equal(bundle.totalDurationQd, bundle.flightQd + bundle.portQd, `${label}: bundle flight + port matches total`);
  assert.ok(bundle.portQd >= 0, `${label}: bundle portQd never goes negative`);
  assert.equal(bundle.legs.reduce((sum, leg) => sum + leg.flightQd, 0), bundle.flightQd);
}

console.log("Ship order preview: immutable quotes, 1–3 orders, cautious fees, seasonal leg timing, shortfall separation, dynamic budget presets, stale/permission guards and GM/player command parity passed.");
