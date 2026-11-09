import assert from "node:assert/strict";
import { transportFixture, transportRequest } from "./fixtures/transport-v2.mjs";
import { fixture, book, harness } from "./fixtures/transport-tenday.mjs";
import { prepareTransportContext } from "../apps/domains/transport-context.js";
import { transportSeasonalCalendar, transportSeasonalMovement } from "../engines/transport/seasonal.js";
import { planTransportChain } from "../engines/transport/planner.js";
import { prepareOwnedTransportAbort } from "../engines/transport/owned-costs.js";
import { transportInsuranceCopper } from "../engines/transport/economics.js";
import { worldShipTransportTerms, buildShipWorldContext, generateWorldShipOffers, quoteWorldShipBundle } from "../engines/ships/world-market.js";
import { getCalendariaSeasonSnapshot, addCalendariaQd } from "../integrations/calendaria-bridge.js";

const months = ["Хладоход", "Теплорост", "Теплоход", "Зноерост", "Зноеход", "Дождерост", "Дождеход", "Хладорост"];
const coordinate = d => (d.year * 240 + (d.month - 1) * 30 + d.day - 1) * 4
  + (d.hour ?? 0) / 6 + (d.minute ?? 0) / 360 + (d.second ?? 0) / 21600;
const dateAt = qd => {
  const seconds = Math.round(qd * 21600), day = Math.floor(seconds / 86400), rest = seconds % 86400;
  return { year: Math.floor(day / 240), month: Math.floor(day % 240 / 30) + 1, day: day % 30 + 1,
    hour: Math.floor(rest / 3600), minute: Math.floor(rest % 3600 / 60), second: rest % 60 };
};
globalThis.CALENDARIA = { api: {
  getActiveCalendar: () => ({ days: { hoursPerDay: 24 }, monthsArray: months.map(name => ({ name, days: 30 })) }),
  dateToTimestamp: d => coordinate(d) * 21600,
  addHours: (d, hours) => dateAt(coordinate(d) + hours / 6), formatDate: d => `${d.year}-${d.month}-${d.day}`
} };
const modifiers = { winter: { enabled: true, timeFactor: 4, costFactor: 4, riskFactor: 4 },
  spring: { enabled: true, timeFactor: 1, costFactor: 1, riskFactor: 1 } };
const dated = (holding, day = 30, qd = 0, hour = 0) => {
  holding.gm.calendaria.lastDateTime = dateAt(coordinate({ year: 881, month: 1, day, hour }) + qd);
  holding.gm.calendaria.lastQd = qd;
};
const leg = movementQd => ({ movementQd, riskFactor: 1, operatingFactor: 1, seasonalModifiers: structuredClone(modifiers) });
const profile = (holding, work = 4, anchorQd = 0) => ({ calendar: transportSeasonalCalendar(holding, anchorQd), legs: [leg(work)], baseRiskBps: 300 });
const cargo = qty => [{ lotId: "cargo", resourceId: "wood", qty, unitLoad: 4000, unitCopper: 5, ageQd: 0 }];

// One unit of the four-unit route is covered before spring; the remaining three use spring speed.
{
  const f = fixture(); dated(f.holding);
  const p = profile(f.holding), whole = transportSeasonalMovement(p, 0);
  assert.equal(whole.durationQd, 7); assert.equal(whole.riskExposureQd, 19);
  assert.equal(whole.operatingFactor, 19 / 7);
  const divided = transportSeasonalMovement({ ...p, legs: [leg(2), leg(2)] }, 0);
  assert.deepEqual(divided, whole, "a transit node cannot add rounding, cost or danger at a season boundary");
  assert.deepEqual(transportSeasonalMovement(profile(f.holding, 4, 100), 100), whole, "common/local clock offsets do not change physical seasons");
  const api = globalThis.CALENDARIA;
  globalThis.CALENDARIA = undefined;
  assert.throws(() => transportSeasonalMovement(p, 0), error => error.code === "calendar-unavailable",
    "losing the date adapter cannot silently move a dated accepted flight back to booking season");
  assert.equal(transportSeasonalMovement({ ...p, calendar: { anchorQd: 0, dateTime: null, fallbackSeasonId: "winter" } }, 80).durationQd, 16,
    "a world using a manually assigned season keeps its explicit fixed-season terms");
  globalThis.CALENDARIA = api;
  dated(f.holding, 30, 0, 3);
  const fractional = transportSeasonalMovement(profile(f.holding), 0);
  assert.equal(fractional.movementQd, 6.625); assert.equal(fractional.riskExposureQd, 17.125);
  assert.equal(fractional.durationQd, 7, "round only once after integrating all movement");
}

// Two quotations for the very same published spring departure must agree, even when booked in winter.
{
  const quotes = [];
  for (const qd of [0, 40]) {
    const f = transportFixture(); f.holding.people.list = []; f.holding.special.ships.list = [];
    dated(f.holding, 21, qd);
    f.data.meta.transportV2 = { version: 2, clockQd: qd, runs: [] };
    Object.assign(f.data.catalog.transportV2, { regularFirstQd: 80, regularIntervalQd: 40, riskBps: 300 });
    for (const region of f.data.catalog.eventRegions) for (const link of region.marketLinks ?? []) link.seasonalModifiers = structuredClone(modifiers);
    const request = transportRequest(f, "a", { insurance: true });
    const initial = prepareTransportContext({ ...f, request, isGM: true });
    const service = initial.services.find(row => row.kind === "regular" && row.mode === "airship" && row.from === initial.from && row.to === initial.to);
    assert.ok(service); request.serviceIds = [service.id];
    const quote = prepareTransportContext({ ...f, request, isGM: true }), run = quote.plan.stages[0].runs[0];
    assert.equal(getCalendariaSeasonSnapshot(addCalendariaQd(f.holding.gm.calendaria.lastDateTime, run.departureQd - qd)).season.key, "spring");
    assert.equal(quote.commercial.insuranceCopper, transportInsuranceCopper(quote.plan, f.data.catalog.transportV2));
    // Commodity prices/taxes can change between booking dates. Compare transport and the same insured value.
    const insured = { ...quote.plan, cargo: quote.plan.cargo.map(lot => ({ ...lot, unitCopper: 5 })) };
    quotes.push({ departure: run.departureQd, arrival: run.arrivalQd, risk: run.riskBps, charge: run.charge,
      fee: quote.plan.totalCopper, insurance: transportInsuranceCopper(insured, f.data.catalog.transportV2) });
    // A different later tariff cannot rewrite a physical departure that has already been reserved.
    const changed = structuredClone(service); changed.travelQd = 99; changed.riskBps = 9999;
    changed.seasonal.fixed = { ...changed.seasonal.fixed, travel: true, risk: true };
    const existing = { ...run, from: service.from, to: service.to, kind: "regular", capacity: service.capacity, reservedLoad: 4000 };
    const joined = planTransportChain({ cargo: cargo(1), services: [changed], startQd: qd, runs: [existing] }).stages[0].runs[0];
    assert.equal(joined.id, run.id); assert.equal(joined.arrivalQd, run.arrivalQd); assert.equal(joined.riskBps, run.riskBps);
    const closed = planTransportChain({ cargo: cargo(1), services: [service], startQd: qd,
      runs: [{ ...existing, riskChecked: true, status: "arrived" }] }).stages[0].runs[0];
    assert.notEqual(closed.id, existing.id, "new claims cannot board a flight whose physical outcome is already known");
    f.data.catalog.transportV2.overrides = { [service.id]: { travelQd: 9, riskBps: 17, loadCopper: 3 } };
    const manual = prepareTransportContext({ ...f, request, isGM: true }).plan.stages[0].runs[0];
    assert.equal(manual.arrivalQd - manual.departureQd - service.unloadingQd, 9);
    assert.equal(manual.riskBps, 17); assert.equal(manual.charge.loadCopper, 30,
      "explicit GM time, risk and fare overrides remain authoritative");
  }
  assert.deepEqual(quotes[0], quotes[1]);
}

// A finite charter must re-evaluate duration after its previous vehicle commitment moves departure.
{
  const f = fixture(); dated(f.holding);
  const service = { ...f.carrier, kind: "charter", from: "a", to: "b", capacity: 4000, travelQd: 16,
    loadingQd: 0, unloadingQd: 0, returnQd: 0, vehicles: 1, distanceKm: 40,
    seasonal: { ...profile(f.holding), fixed: { backTravel: true } } };
  const occupied = { id: "earlier", serviceId: service.id, vehicle: 0, startQd: 1, releaseQd: 10, status: "booked" };
  const run = planTransportChain({ cargo: cargo(1), services: [service], runs: [occupied] }).stages[0].runs[0];
  assert.equal(run.startQd, 10); assert.equal(run.arrivalQd, 14);
  const prepared = planTransportChain({ cargo: cargo(1), services: [{ ...service, preparationQd: 1, loadingQd: 2 }] });
  const repeated = planTransportChain({ cargo: cargo(1), services: [structuredClone(prepared.stages[0].service)], startQd: 10 });
  assert.equal(prepared.stages[0].runs[0].departureQd - prepared.stages[0].runs[0].startQd, 3);
  assert.equal(repeated.stages[0].runs[0].departureQd - repeated.stages[0].runs[0].startQd, 3,
    "the saved seasonal snapshot cannot count preparation twice on replanning");
}

// Own-vessel approach, cargo, empty final return and aborted pickup use their actual movement dates.
{
  const f = fixture(); dated(f.holding);
  const own = { ...f.carrier, id: "own", kind: "owned", shipId: "ship", from: "a", to: "b", capacity: 4000,
    distanceKm: 40, travelQd: 16, loadingQd: 1, unloadingQd: 1, approachQd: 8, approachCopper: 8,
    returnQd: 8, returnAtEnd: true, endReturnQd: 8, endReturnLocation: "home", abortReturnQd: 24,
    dailyCosts: { foodCopper: 4 }, returnDailyCosts: { foodCopper: 4 }, approachDailyCosts: { foodCopper: 4 },
    seasonal: profile(f.holding), approachSeasonal: profile(f.holding, 2),
    returnSeasonal: profile(f.holding, 2), endReturnSeasonal: profile(f.holding, 2), abortReturnSeasonal: profile(f.holding, 6) };
  const plan = planTransportChain({ cargo: cargo(1), services: [own] }), run = plan.stages[0].runs[0];
  assert.equal(plan.stages[0].service.approachQd, 5); assert.equal(plan.shipApproachCopper, 5);
  assert.equal(run.startQd, 5); assert.equal(run.departureQd, 6); assert.equal(run.arrivalQd, 11);
  assert.equal(run.releaseQd, 13); assert.equal(run.releaseLocation, "home");
  const order = { plan, ownShipId: "ship", stages: [{ ...plan.stages[0], receipts: [], status: "cancelled" }],
    abortedFromStage: 0, finishedQd: 1 };
  prepareOwnedTransportAbort(order, { runs: [] });
  assert.equal(order.shipAbort.releaseQd, 11); assert.equal(order.shipAbort.returnCopper, 6);
  const later = planTransportChain({ cargo: cargo(3), services: [own], startQd: 10 });
  assert.deepEqual(later.stages[0].runs.map(row => row.releaseQd - row.arrivalQd), [2, 2, 2]);
  assert.ok(later.stages[0].runs.every((row, index, all) => !index || row.startQd >= all[index - 1].releaseQd));
}

// A real tenday decision can move a reserved downstream leg to spring. Preserve its accepted invoice and profile through reload.
{
  const f = fixture(); dated(f.holding); f.holding.people.list = [];
  const feeder = { ...f.carrier, id: "season-feeder", kind: "regular", from: "a", to: "b",
    firstQd: 1, intervalQd: 80, loadingQd: 0, unloadingQd: 0, travelQd: 1, returnQd: 0, riskBps: 10000 };
  const tail = { ...f.carrier, id: "season-tail", kind: "charter", from: "b", to: "home", capacity: 40000,
    loadingQd: 0, unloadingQd: 0, travelQd: 16, returnQd: 0, distanceKm: 40, riskBps: 0,
    seasonal: { ...profile(f.holding), fixed: { risk: true, backTravel: true } } };
  book(f, f.holding, "season-order", [feeder, tail], { resourceId: "wood" });
  const accepted = structuredClone(f.holding.special.transportV2.orders[0].plan);
  const h = harness(f.data), id = f.holding.id;
  const pending = await h.prepare(id, 40); assert.equal(pending.ok, false);
  await h.decide(pending, { outcome: "delay", delayQd: 40 }); h.reload();
  const calendarApi = globalThis.CALENDARIA;
  globalThis.CALENDARIA = undefined;
  const waiting = await h.prepare(id, 80);
  assert.equal(waiting.preparedHolding.special.transportV2.orders[0].replanFailure.code, "calendar-unavailable");
  assert.equal(waiting.preparedHolding.special.transportV2.orders[0].status, "waitingCarrier");
  assert.deepEqual(waiting.preparedHolding.special.transportV2.orders[0].stages[1].runs,
    h.holding(id).special.transportV2.orders[0].stages[1].runs, "failed date projection preserves the old allocations for retry");
  globalThis.CALENDARIA = calendarApi;
  // Editing the current catalog cannot change the frozen original seasonal coefficients.
  h.data.catalog.eventRegions = [{ value: "b", marketLinks: [{ regionId: "home", seasonalModifiers: { spring: { enabled: true, timeFactor: 4 } } }] }];
  const ready = await h.prepare(id, 80); assert.equal(ready.ok, true); await h.apply(ready); h.reload();
  const order = h.holding(id).special.transportV2.orders[0], run = order.stages[1].runs[0];
  assert.equal(run.arrivalQd - run.departureQd, 4);
  assert.equal(order.status, "delivered"); assert.deepEqual(order.plan, accepted);
  assert.equal(order.stages[1].totalCopper, accepted.stages[1].totalCopper);
  assert.equal(order.stages[1].service.seasonal.legs[0].seasonalModifiers.spring.timeFactor, 1);
}

// The legacy customer-order planner also dates each next leg after the prior port's handling.
{
  const f = transportFixture(); dated(f.holding); f.holding.people.list = [];
  for (const region of f.data.catalog.eventRegions) for (const link of region.marketLinks ?? []) link.seasonalModifiers = structuredClone(modifiers);
  f.ship.location = { kind: "market", id: "a", regionId: "a", label: "A" }; f.ship.status = "away";
  const context = buildShipWorldContext(f.data, f.holding);
  const direct = worldShipTransportTerms(f.data, f.holding, f.ship, "a", "b", { context, loadPoints: 4, fromHome: false, toHome: false, startQd: 8 });
  const atSpring = structuredClone(f.holding); dated(atSpring, 30, 8);
  const springShip = { ...f.ship, timelineQd: 8 };
  const comparable = worldShipTransportTerms(f.data, atSpring, springShip, "a", "b", { loadPoints: 4, fromHome: false, toHome: false, startQd: 8 });
  assert.equal(direct.durationQd, comparable.durationQd); assert.equal(direct.riskExposureQd, comparable.riskExposureQd);
  const source = generateWorldShipOffers(f.data, f.holding, f.ship, { period: 0, random: () => 0.4 })[0]; assert.ok(source);
  const offers = ["b", "home"].map((regionId, index) => {
    const offer = structuredClone(source); offer.id = `season-customer-${index}`;
    offer.to = { kind: "market", id: regionId, regionId, label: regionId };
    delete offer.contract.pickup; offer.contract.destination = regionId; offer.contract.directionKey = `port:${regionId}`;
    Object.assign(offer.contract.cargo, { quantity: 1, loadPoints: 4, valueCopper: 32 });
    delete offer.contract.cargo.shelfLifeQd; return offer;
  });
  const bundle = quoteWorldShipBundle(f.data, f.holding, f.ship, offers, { context });
  let clock = 0, from = "a";
  for (const stop of bundle.stops) {
    const quoted = worldShipTransportTerms(f.data, f.holding, f.ship, from, stop.point.regionId,
      { context, fromHome: false, toHome: false, startQd: clock + (clock === 0 ? 1 : 0) });
    const handling = clock === 0 ? 2 : 1;
    assert.equal(stop.legOffer.quote.durationQd, quoted.durationQd + handling);
    clock += stop.legOffer.quote.durationQd; from = stop.point.regionId;
  }
  assert.equal(bundle.totalDurationQd, clock);
}
console.log("Seasonal transport: analytic boundary integration, transit invariance, same future fare/risk/insurance, finite fleet gaps, owned approach/shuttles/returns/abort, real tenday delay/reload/frozen terms and customer bundle dates passed.");
