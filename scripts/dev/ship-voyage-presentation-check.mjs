import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prepareShipVoyagePresentation } from "../apps/domains/ship-voyage-presentation.js";
import { prepareShipsContext, prepareShipWindowContext } from "../apps/ships-context.js";
import { generateWorldShipOffers, quoteWorldShipBundle, quoteWorldShipRelocation, quoteWorldShipReturn } from "../engines/ships/world-market.js";
import { advanceWorldShips, continueWorldShipBundle, departWorldShip, departWorldShipBundle, resolveWorldShip, resolveWorldShipBundleStop } from "../engines/ships/world-voyage.js";
import { skyholdTemplatePaths } from "../apps/template-preload.js";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function display(fixture) {
  const data = structuredClone(fixture.data);
  const holding = data.holdings[0];
  const ship = holding.special.ships.list[0];
  holding.visibility = "public";
  holding.gm.playersCanManageShips = true;
  const before = JSON.stringify(data);
  freeze(data);
  let gmPresentation;
  for (const isGM of [true, false]) {
    globalThis.game = { user: { id: isGM ? "gm" : "player", isGM },
      users: [{ id: "gm", isGM: true, active: true }], socket: { emit() { throw new Error("View sent a mutation"); } } };
    const overview = prepareShipsContext(holding, { data }).rows[0];
    const detail = prepareShipWindowContext(holding, { data, shipId: ship.id }).rows[0];
    assert.equal(overview.voyagePresentation, undefined, "fleet overview must stay lightweight");
    assert.equal(detail.statusLabel, overview.statusLabel);
    if (detail.voyagePresentation?.leg?.isDelay) {
      assert.equal(overview.statusLabel, "Задержан в порту", "fleet must not call an applied port delay a flight");
      assert.match(overview.nextAction, /окончания задержки/);
    }
    assert.equal(JSON.stringify(data), before, "GM/player views must not move time, bill ports or apply outcomes");
    if (isGM) gmPresentation = detail.voyagePresentation;
    else assert.deepEqual(detail.voyagePresentation, gmPresentation, "accepted route and clock have identical meaning for GM/player");
  }
  return gmPresentation;
}

const single = worldMarketFixture();
const pickupOffer = generateWorldShipOffers(single.data, single.holding, single.ship, { period: 0, random: () => 0.4 })
  .find((offer) => offer.contract.pickup);
assert.ok(pickupOffer);
departWorldShip(single.holding, single.ship, { operationId: "present-pickup", offer: pickupOffer, clockQd: 0 });
single.holding.gm.calendaria.lastQd = 4;
advanceWorldShips(single.holding, 4);
let presentation = display(single);
assert.deepEqual(presentation.stops.map((row) => row.label), [pickupOffer.from.label, pickupOffer.contract.pickup.label, pickupOffer.to.label]);
assert.equal(presentation.leg.elapsedDays, 1);
assert.equal(presentation.leg.durationDays, pickupOffer.quote.durationQd / 4);
assert.equal(presentation.stops[1].complete, false, "aggregate flight progress cannot prove that a remote pickup is complete");
assert.equal(presentation.hasRemotePickup, true);
const accepted = structuredClone(presentation);
single.data.catalog.eventRegions[1].label = "Переименованный порт";
single.data.catalog.eventRegions[1].marketLinks = [];
single.data.catalog.resources[0].loadPoints = 100;
assert.deepEqual(display(single), accepted, "catalog changes must not redraw or reprice an accepted itinerary");

single.holding.gm.calendaria.lastQd = 80;
advanceWorldShips(single.holding, 80);
presentation = display(single);
assert.equal(presentation.awaiting, true);
assert.equal(presentation.leg.remainingDays, 0);
assert.equal(presentation.leg.elapsedQd, presentation.leg.totalQd);
assert.equal(presentation.stops.at(-1).complete, true);
assert.equal(presentation.catchUpDays, (80 - single.ship.activeVoyage.arrivalQd) / 4,
  "ship stops at arrival rather than consuming the rest of the approved tenday");
assert.match(presentation.timeExplanation, /отдельного подтверждения/);

single.ship.onboardCopper = 0;
resolveWorldShip(single.holding, single.ship, { operationId: "present-unfunded", random: () => 0.01 });
presentation = display(single);
assert.match(presentation.leg.statusLabel, /Нужны средства/);
assert.match(presentation.timeExplanation, /Исход уже сохранён/);
const savedOutcome = structuredClone(single.ship.activeVoyage.outcome);
single.ship.onboardCopper = savedOutcome.expenseCopper + 100000;
resolveWorldShip(single.holding, single.ship, { operationId: "present-funded", random: () => { throw new Error("Rerolled"); } });
assert.ok(savedOutcome.delayQd > 0);
presentation = display(single);
assert.equal(presentation.traveling, false, "applied incident delay is port time, not another flight");
assert.equal(presentation.leg.isDelay, true);
assert.equal(presentation.leg.durationDays, savedOutcome.delayQd / 4);
assert.equal(presentation.leg.elapsedDays, 0);
assert.match(presentation.leg.statusLabel, /Задержан/);
const delayEnd = single.ship.activeVoyage.arrivalQd;
advanceWorldShips(single.holding, delayEnd - 1);
presentation = display(single);
assert.equal(presentation.leg.remainingDays, 0.25);
assert.equal(presentation.leg.elapsedDays, (savedOutcome.delayQd - 1) / 4);
advanceWorldShips(single.holding, delayEnd);
assert.equal(prepareShipVoyagePresentation(single.holding, single.ship), null);

const bundle = worldMarketFixture();
const offers = generateWorldShipOffers(bundle.data, bundle.holding, bundle.ship, { period: 0, random: () => 0.4 });
const plan = quoteWorldShipBundle(bundle.data, bundle.holding, bundle.ship, [offers[0], offers[1]]);
departWorldShipBundle(bundle.holding, bundle.ship, { operationId: "present-bundle", plan, clockQd: 0 });
presentation = display(bundle);
assert.deepEqual(presentation.stops.slice(1).map((row) => row.label), plan.stops.map((row) => row.point.label));
assert.equal(presentation.remainingPlannedDays, plan.stops.reduce((sum, row) => sum + row.legOffer.quote.durationQd, 0) / 4);
assert.deepEqual(presentation.stops.slice(1).map((row) => [row.loadOnLegPoints, row.loadAfterPoints]),
  plan.stops.map((row) => [row.loadOnLegPoints, row.loadAfterPoints]));
assert.equal(presentation.stops[1].current, true);
const firstArrival = bundle.ship.activeVoyage.arrivalQd;
bundle.holding.gm.calendaria.lastQd = firstArrival;
advanceWorldShips(bundle.holding, firstArrival);
presentation = display(bundle);
assert.equal(presentation.leg, null);
assert.equal(presentation.stops[1].current, true);
assert.equal(presentation.stops[1].complete, true);
if (bundle.ship.orderBundle.status === "awaiting-outcome") {
  resolveWorldShipBundleStop(bundle.holding, bundle.ship, { operationId: "present-first-stop", bundleId: "present-bundle", random: () => 0.99 });
}
presentation = display(bundle);
assert.match(presentation.timeExplanation, /нужен приказ/);
continueWorldShipBundle(bundle.holding, bundle.ship, { operationId: "present-next-leg", bundleId: "present-bundle", clockQd: firstArrival });
presentation = display(bundle);
assert.equal(presentation.stops[1].current, false);
assert.equal(presentation.stops[2].current, true);
assert.equal(presentation.leg.elapsedDays, 0);
assert.equal(presentation.leg.durationDays, plan.stops[1].legOffer.quote.durationQd / 4);
const lastArrival = bundle.ship.activeVoyage.arrivalQd;
bundle.holding.gm.calendaria.lastQd = lastArrival;
advanceWorldShips(bundle.holding, lastArrival);
bundle.ship.onboardCopper = 1000000;
resolveWorldShipBundleStop(bundle.holding, bundle.ship, { operationId: "present-last-delay", bundleId: "present-bundle", random: () => 0.01 });
assert.equal(bundle.ship.orderBundle.status, "final-delay");
presentation = display(bundle);
assert.equal(presentation.stops.at(-1).complete, true);
assert.equal(presentation.remainingPlannedDays, 0);
assert.ok(presentation.delayDays > 0);
assert.match(presentation.timeExplanation, /Все грузы доставлены/);
assert.equal(bundle.ship.orderBundle.orders.every((order) => order.state === "delivered"), true);

const movement = worldMarketFixture();
const relocation = quoteWorldShipRelocation(movement.data, movement.holding, movement.ship, "a");
departWorldShip(movement.holding, movement.ship, { operationId: "present-relocation", offer: relocation, clockQd: 0 });
assert.equal(display(movement).title, "Передислокация");
movement.holding.gm.calendaria.lastQd = movement.ship.activeVoyage.arrivalQd;
advanceWorldShips(movement.holding, movement.ship.activeVoyage.arrivalQd);
const homeward = quoteWorldShipReturn(movement.data, movement.holding, movement.ship);
departWorldShip(movement.holding, movement.ship, { operationId: "present-return", offer: homeward, clockQd: movement.ship.timelineQd });
assert.equal(display(movement).title, "Возвращение домой");
assert.equal(display(movement).stops.some((row) => row.pickupText || row.deliveryText), false,
  "empty relocation/return cannot claim to load customer cargo");

const sale = { marketLabel: "a", status: "needsResolution", remainingQd: 0 };
const parked = { navigationMode: "world", timelineQd: 0, location: { kind: "market", label: "a" } };
presentation = prepareShipVoyagePresentation(movement.holding, freeze(parked), { ownSale: freeze(sale) });
assert.equal(presentation.title, "Продажа товара поселения");
assert.match(presentation.statusLabel, /решение ГМа/);
assert.equal(presentation.stops.length, 1, "missing historical endpoints must not be invented");
assert.match(presentation.timeExplanation, /Внешнем рынке/);
const saleFlight = prepareShipVoyagePresentation(movement.holding, freeze(structuredClone(movement.ship)),
  { ownSale: { marketLabel: "a", status: "delayed", delayRemainingQd: 4 } });
assert.equal(saleFlight.stops.at(-1).complete, false, "a market delay does not place an underway ship at its destination");
assert.equal(saleFlight.traveling, true);
assert.match(saleFlight.timeExplanation, /ведутся отдельно/, "sale settlement delays must not masquerade as a stopped flight");
const missingLeg = prepareShipVoyagePresentation(movement.holding, { ...parked,
  orderBundle: { orders: [], stops: [], nextStopIndex: 0, status: "travelling" } });
assert.match(missingLeg.snapshotIssue, /отсутствует текущий участок/);
assert.match(missingLeg.statusLabel, /проверка ГМа/);
const legacyCursor = { ...parked, timelineQd: undefined, portBilling: { lastCalculatedQd: 20 } };
assert.equal(prepareShipVoyagePresentation({ gm: { calendaria: { lastQd: 10 } } }, legacyCursor, { ownSale: sale }).clockReversed, true);
assert.equal(prepareShipVoyagePresentation({ gm: { calendaria: { lastQd: 10 } } }, legacyCursor, { ownSale: sale }).catchUpDays, 0);
assert.equal(prepareShipVoyagePresentation(movement.holding, { ...parked, navigationMode: "legacy" }, { ownSale: sale }), null);

const template = readFileSync(new URL("../../templates/parts/ship-window/voyage-progress.hbs", import.meta.url), "utf8");
assert.match(template, /<progress[^>]*aria-label=/);
assert.match(template, /aria-valuetext=/);
assert.match(template, /aria-current=/);
assert.ok(skyholdTemplatePaths("shipWindow").some((path) => path.endsWith("voyage-progress.hbs")), "voyage partial loads with the lazy ship window");
console.log("Ship voyage presentation: accepted snapshots, GM/player read-only parity, pickup uncertainty, arrival cursor, saved outcomes, port delays, bundle stops, relocation/return and sale passed.");
