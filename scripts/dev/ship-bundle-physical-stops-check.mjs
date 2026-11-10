import assert from "node:assert/strict";
import { transportFixture } from "./fixtures/transport-v2.mjs";
import { installTransportTestCalendar, transportTestDate, transportTestYearQd } from "./fixtures/transport-calendar.mjs";
import { buildShipWorldContext, generateWorldShipOffers, worldShipTransportTerms } from "../engines/ships/world-market.js";
import { createShipOperationExecutor } from "../apps/ship-operation-executor.js";
import { advanceWorldShips } from "../engines/ships/world-voyage.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { prepareShipCommandAvailability } from "../apps/domains/ship-command-availability.js";
import { shipMoneySummary } from "../engines/ships/summary.js";

const neverRoll = () => { throw new Error("A saved passage was rerolled"); };
const base = transportTestYearQd + 108;
const region = (value, links = []) => ({ value, label: value, countryId: "public", marketTransportModes: ["airship"],
  marketLinks: links.map(([regionId, distanceKm]) => ({ regionId, distanceKm, modes: ["airship"],
    seasonalModifiers: { winter: { enabled: true, timeFactor: 4, riskFactor: 1, costFactor: 1 } } })) });

function fixture() {
  const f = transportFixture();
  f.ship.speedKmPerDay = 160;
  f.holding.gm.calendaria.lastDateTime = transportTestDate(base);
  f.data.catalog.eventRegions = [region("home", [["a", 10]]), region("a", [["b", 80]]), region("b", [["c", 10]]), region("c")];
  f.data.catalog.marketEconomy.baseOffers[0].baseStock = 1;
  f.data.catalog.marketEconomy.baseOffers[0].baseDemand = 1;
  f.data.catalog.transportV2.riskBps = 3000;
  const context = buildShipWorldContext(f.data, f.holding);
  let pair;
  for (let seed = 1; seed < 4000 && !pair; seed++) {
    let state = seed;
    const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const offers = generateWorldShipOffers(f.data, f.holding, f.ship, { period: 0, random, context });
    const candidates = ["b", "c"].map(id => offers.find(o => o.to.id === id && o.contract.pickup?.id === "a" && o.kind === "freight"));
    if (candidates.every(Boolean)) pair = candidates;
  }
  assert.ok(pair, "generate real contracts with a common foreign pickup and distinct destinations");
  for (const offer of pair) offer.contract.cargo.shelfLifeQd = 24;
  f.holding.special.ships.offers = pair;
  return { ...f, pair, context };
}

async function check(isGM, legacyPickup) {
  const f = fixture();
  let data = structuredClone(f.data), random = () => 0.99;
  const skip = Symbol("skip");
  const execute = createShipOperationExecutor({
    getUser: id => ({ id, isGM: id === "gm" }), random: () => random(), skip: value => ({ [skip]: true, value }),
    updateHolding: async (_id, update) => {
      const draft = structuredClone(data), result = await update(draft.holdings[0], draft);
      if (result?.[skip]) return result.value;
      draft.meta.revision++; data = draft; return result;
    }
  });
  const actor = { userId: isGM ? "gm" : "player", remote: !isGM };
  const view = () => ({ h: data.holdings[0], s: data.holdings[0].special.ships.list[0] });
  const command = (type, operationId, extra = {}) => {
    const { h, s } = view();
    return { type, operationId, holdingId: h.id, shipId: s.id, expectedRevision: data.meta.revision,
      voyageId: s.orderBundle?.id, locationKind: s.location.kind, locationId: s.location.id, ...extra };
  };
  const depart = command("depart-bundle", "pickup-start", { offerIds: f.pair.map(o => o.id), budgetCopper: 100000 });
  await execute(depart, actor);
  let { h, s } = view();
  h.gm.calendaria.lastQd = 40; h.gm.calendaria.lastDateTime = transportTestDate(base + 40);
  advanceWorldShips(h, 40); data.meta.revision++;
  const pickupAt = s.timelineQd;
  assert.equal(pickupAt, 2);
  assert.equal(s.orderBundle.status, "awaiting-outcome");
  assert.ok(s.orderBundle.orders.every(o => o.state === "waiting-pickup"));
  if (legacyPickup) {
    // The former implementation saved this state after a pickup-only arrival.
    s.orderBundle.status = "at-port";
    for (const order of s.orderBundle.orders) {
      order.state = "loaded"; order.offer.contract.cargo.ageAtQd = pickupAt;
    }
  }
  const availability = prepareShipCommandAvailability(h, s, { permissions: { canManageShips: true } });
  assert.equal(availability.resolveBundle.allowed, true);
  assert.equal(availability.continueBundle, null);
  await assert.rejects(execute(command("continue-bundle", "premature"), actor), /не готов/);
  s.onboardCopper = 0;
  let draws = 0;
  random = () => { draws++; return 0; };
  assert.equal((await execute(command("resolve-bundle", "unpaid-approach"), actor)).pending, true);
  ({ h, s } = view());
  const saved = structuredClone(s.orderBundle.stops[0].physicalResolution);
  assert.equal(draws, 2, "an empty approach rolls one physical event and no commercial outcome");
  assert.equal(saved.delayQd, 8);
  assert.ok(saved.expenseCopper > 0);
  assert.equal(s.orderBundle.status, "awaiting-outcome", "old pickup saves remain retryable while unfunded");
  assert.equal(shipMoneySummary(h, s, { clockQd: pickupAt }).outcomeDueCopper, saved.expenseCopper);
  data.holdings[0] = mergeHoldingDefaults(JSON.parse(JSON.stringify(h)));
  random = neverRoll;
  assert.equal((await execute(command("resolve-bundle", "retry-unpaid"), actor)).pending, true);
  ({ h, s } = view());
  s.onboardCopper = 100000;
  const before = s.onboardCopper;
  const resolve = command("resolve-bundle", "funded-approach");
  await execute(resolve, actor);
  ({ h, s } = view());
  assert.equal(s.onboardCopper, before - saved.expenseCopper);
  assert.deepEqual(s.orderBundle.stops[0].physicalResolution, saved);
  assert.equal(s.orderBundle.delayUntilQd, pickupAt + 8);
  for (const order of s.orderBundle.orders) {
    assert.equal(order.state, "loaded");
    assert.equal(order.offer.contract.cargo.ageAtQd, pickupAt + 8, "empty approach delay never ages cargo before handover");
  }
  const snapshot = JSON.stringify(data);
  assert.equal((await execute(resolve, actor)).replay, true);
  assert.equal(JSON.stringify(data), snapshot);
  const terms = worldShipTransportTerms(data, h, s, "a", "b", { context: f.context, startQd: pickupAt + 8, fromHome: false, toHome: false });
  const expected = terms.durationQd + s.orderBundle.stops[1].legOffer.quote.seasonal.handlingQd;
  random = () => 0.99;
  const continuation = command("continue-bundle", "next-season-leg");
  await execute(continuation, actor);
  ({ h, s } = view());
  assert.equal(s.orderBundle.stops[1].legOffer.quote.durationQd, expected);
  assert.equal(expected, 5, "the real departure crosses into the faster season");
  assert.equal(s.timelineQd, 15);
  assert.equal(s.orderBundle.status, "awaiting-outcome");
  assert.equal(s.orderBundle.stops[1].physicalOutcome, undefined, "tenday catch-up never rolls decisions automatically");
  await execute(command("resolve-bundle", "deliver-b"), actor);
  ({ h, s } = view());
  assert.ok(s.orderBundle.orders.find(o => o.offer.to.id === "b").outcome.rewardCopper > 0, "the fresh loaded cargo earns its fee");
  const after = JSON.stringify(data);
  assert.equal((await execute(continuation, actor)).replay, true);
  assert.equal(JSON.stringify(data), after, "replaying an earlier departure cannot advance or charge again");
}

const previous = globalThis.game;
globalThis.game = { user: { id: "gm", isGM: true }, settings: { get() {} }, modules: new Map() };
const calendar = installTransportTestCalendar();
try {
  for (const isGM of [true, false]) for (const legacy of [false, true]) await check(isGM, legacy);
  console.log("Bundle physical stops: GM/player, tenday-only time, seasonal departure, pre-loading delay, funding/reload, old pickup saves and replay passed.");
} finally { calendar.restore(); globalThis.game = previous; }
