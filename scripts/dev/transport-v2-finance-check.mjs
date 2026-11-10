import assert from "node:assert/strict";
import { transportFixture, transportRequest, transportHarness } from "./fixtures/transport-v2.mjs";
import { prepareShipsContext, prepareShipWindowContext } from "../apps/ships-context.js";
import { prepareShipFinancePresentation } from "../apps/domains/ship-finance-presentation.js";
import { shipMoneySummary, shipOutingSummary } from "../engines/ships/summary.js";
import { cargoValue } from "../engines/transport/quantities.js";
import { resolveTransportIncident } from "../engines/transport/runtime.js";

function finance(harness) {
  const { holding, ship } = harness;
  const before = JSON.stringify(harness.data);
  let gm;
  for (const isGM of [true, false]) {
    globalThis.game = { user: { id: isGM ? "gm" : "player", isGM },
      users: [{ id: "gm", isGM: true, active: true }], socket: { emit() { throw new Error("Viewing sent a mutation"); } } };
    const presentation = prepareShipWindowContext(holding, { data: harness.data, shipId: ship.id }).rows[0].financePresentation;
    if (isGM) gm = presentation; else assert.deepEqual(presentation, gm, "GM/player financial statements agree");
  }
  assert.equal(JSON.stringify(harness.data), before, "rendering neither writes money nor changes accepted plans");
  return gm;
}

for (const isGM of [true, false]) for (const direction of ["inbound", "outbound"]) {
  const f = transportFixture(), harness = transportHarness(f), initialCash = harness.holding.storage.moneyCopper;
  const request = transportRequest(f, "a", { direction, ownShipId: f.ship.id, returnHome: true, insurance: true }, isGM);
  const { preview, order } = await harness.book(request, `finance-${direction}-${isGM}`, isGM);
  const accepted = finance(harness);
  assert.equal(accepted.outing.plannedIncomeCopper, direction === "outbound" ? preview.valueCopper : 0);
  assert.equal(accepted.outing.plannedExpenseCopper, preview.totalCopper);
  assert.equal(accepted.pendingPayments.length, direction === "outbound" ? 1 : 0);
  if (direction === "outbound") assert.equal(accepted.pendingPayments[0].amountCopper, preview.valueCopper);
  harness.advance(preview.plan.shipReleaseQd);
  const completed = finance(harness);
  assert.equal(completed.outing.marketExpenseCopper, preview.commercial.taxCopper + preview.commercial.insuranceCopper);
  assert.equal(completed.outing.totalExpenseCopper, preview.totalCopper);
  assert.equal(completed.outing.netCopper, harness.holding.storage.moneyCopper - initialCash + (direction === "inbound" ? preview.valueCopper : 0));
  assert.equal(completed.outing.canComparePlan, true); assert.equal(completed.pendingPayments.length, 0);
  assert.equal(order.money.spentCopper, preview.plan.totalCopper);
  assert.deepEqual(finance(harness), completed, "repeat presentation cannot book costs twice");
}

// Known partial loss stops being a promise; insurance is received by the
// treasury even when surviving cargo revenue is paid aboard the ship.
{
  const f = transportFixture(); f.ship.capacityLoadPoints = 20; f.data.catalog.transportV2.riskBps = 10000;
  const harness = transportHarness(f), initialCash = harness.holding.storage.moneyCopper;
  const request = transportRequest(f, "a", { direction: "outbound", ownShipId: f.ship.id, returnHome: true, insurance: true });
  const { preview, order } = await harness.book(request, "partial-sale");
  const runs = order.stages[0].runs;
  harness.advance(runs[0].arrivalQd);
  resolveTransportIncident(harness.data.meta.transportV2, runs[0].id, { outcome: "loss", lossBps: 5000 });
  harness.advance(runs[0].arrivalQd);
  assert.equal(order.received.reduce((sum, lot) => sum + lot.qty, 0), 3);
  const partial = finance(harness);
  assert.equal(partial.pendingPayments[0].amountCopper, 5 * order.cargo[0].unitCopper);
  assert.equal(partial.outing.treasuryIncomeCopper, order.insurancePaidCopper);
  harness.advance(runs[1].arrivalQd);
  resolveTransportIncident(harness.data.meta.transportV2, runs[1].id, { outcome: "success" });
  harness.advance(preview.plan.shipReleaseQd);
  const done = finance(harness);
  assert.equal(done.outing.netCopper, cargoValue(order.received) + order.insurancePaidCopper - preview.totalCopper);
  assert.equal(done.outing.netCopper, harness.holding.storage.moneyCopper - initialCash);
  assert.equal(done.outing.plannedIncomeCopper, preview.valueCopper, "a loss cannot rewrite the accepted estimate");
  assert.equal(done.pendingPayments.length, 0); assert.equal(done.outing.canComparePlan, true);
}

// A mixed shipment can continue after its ship returns. Its sale proceeds go
// to the treasury; the final comparison waits for the hired stage as well.
{
  const f = transportFixture();
  f.data.catalog.eventRegions[1].marketTransportModes = ["airship", "caravan"];
  f.data.catalog.eventRegions[1].marketLinks = [{ regionId: "b", distanceKm: 100, modes: ["caravan"] }];
  f.data.catalog.eventRegions[2].marketTransportModes = ["caravan"];
  const harness = transportHarness(f), initialCash = harness.holding.storage.moneyCopper;
  const request = transportRequest(f, "b", { direction: "outbound", ownShipId: f.ship.id, returnHome: true, insurance: true });
  const { preview, order } = await harness.book(request, "mixed-sale");
  assert.equal(order.stages[0].service.kind, "owned"); assert.notEqual(order.stages.at(-1).service.kind, "owned");
  assert.equal(order.commercial.revenueOnBoard, false); assert.ok(preview.plan.shipReleaseQd < preview.plan.arrivalQd);
  harness.advance(preview.plan.shipReleaseQd);
  const waiting = finance(harness);
  assert.equal(waiting.outing.ongoing, false); assert.equal(waiting.outing.transportPending, true);
  assert.equal(waiting.outing.canComparePlan, false); assert.equal(waiting.outing.plannedExpenseCopper, preview.totalCopper);
  assert.match(waiting.pendingPayments[0].basisLabel, /в казну/);
  harness.advance(preview.plan.arrivalQd);
  const done = finance(harness);
  assert.equal(done.outing.treasuryIncomeCopper, preview.valueCopper);
  assert.equal(done.outing.totalExpenseCopper, preview.totalCopper);
  assert.equal(done.outing.netCopper, harness.holding.storage.moneyCopper - initialCash);
  assert.equal(done.outing.canComparePlan, true);
}

// Several accepted transport orders can belong to one outing. The first
// orderId alone cannot identify all of its expenses, nor the following outing.
{
  const f = transportFixture(), harness = transportHarness(f), initialCash = harness.holding.storage.moneyCopper;
  const firstRequest = transportRequest(f, "a", { direction: "outbound", ownShipId: f.ship.id, returnHome: false, insurance: true });
  const first = await harness.book(firstRequest, "outing-first");
  harness.advance(first.preview.plan.shipReleaseQd); assert.ok(harness.ship.currentOuting);
  const secondRequest = transportRequest(harness.fixture(), "home", { ownShipId: f.ship.id, returnHome: true, insurance: true });
  const second = await harness.book(secondRequest, "outing-second");
  harness.advance(second.preview.plan.shipReleaseQd);
  const done = finance(harness);
  assert.equal(done.outing.id, "outing-first");
  assert.equal(done.outing.totalExpenseCopper, first.preview.totalCopper + second.preview.totalCopper);
  assert.equal(done.outing.plannedIncomeCopper, first.preview.valueCopper);
  assert.equal(done.outing.netCopper, harness.holding.storage.moneyCopper - initialCash + second.preview.valueCopper);
  const previous = shipOutingSummary(harness.ship);
  const thirdRequest = transportRequest(harness.fixture(), "a", { direction: "outbound", ownShipId: f.ship.id, returnHome: true });
  await harness.book(thirdRequest, "next-outing");
  const past = prepareShipFinancePresentation(harness.holding, harness.ship, {
    outingReport: previous, money: shipMoneySummary(harness.holding, harness.ship)
  });
  assert.deepEqual(past.outing, done.outing, "an order starting at the next outing's boundary must not enter the previous result");
}
{
  const f = transportFixture(), harness = transportHarness(f);
  const region = harness.data.catalog.eventRegions.find(row => row.value === "a");
  region.label = "PRIVATE PORT DELTA";
  const request = transportRequest(harness.fixture(), "a", { direction: "outbound", ownShipId: f.ship.id, insurance: true });
  const { preview } = await harness.book(request, "hidden-sale");
  const check = hidden => {
    const before = structuredClone(harness.data);
    for (const isGM of [true, false]) {
      globalThis.game.user = { id: isGM ? "gm" : "player", isGM };
      const row = prepareShipWindowContext(harness.holding, { data: harness.data, shipId: harness.ship.id }).rows[0];
      const overview = prepareShipsContext(harness.holding, { data: harness.data }).rows[0];
      assert.equal(JSON.stringify(row.financePresentation).includes("PRIVATE PORT DELTA"), isGM || !hidden,
        "both the market payment and saved route journal obey ordinary window visibility");
      if (harness.ship.location.kind === "market") for (const view of [row, overview]) {
        assert.equal(view.locationLabel, hidden && !isGM ? "Скрытый рынок" : "PRIVATE PORT DELTA");
      }
      assert.deepEqual(row.financePresentation.outing.details.map(detail => [detail.kind, detail.displayAmountCopper]),
        prepareShipFinancePresentation(harness.holding, harness.ship, {
          data: harness.data, isGM: true, outingReport: shipOutingSummary(harness.ship), money: row.moneySummary
        }).outing.details.map(detail => [detail.kind, detail.displayAmountCopper]), "masking never changes the financial evidence");
    }
    assert.deepEqual(harness.data, before, "neither role can rewrite saved names, dates or receipts by viewing them");
  };
  harness.data.catalog.marketEconomy.countries[0].visibility = "gm";
  check(true);
  harness.advance(preview.plan.shipReleaseQd);
  check(true);
  harness.data.catalog.marketEconomy.countries[0].visibility = "public";
  check(false);
  const returning = await harness.book(transportRequest(harness.fixture(), "home", {
    ownShipId: f.ship.id, returnHome: true
  }), "private-return-home");
  harness.data.catalog.marketEconomy.countries[0].visibility = "gm";
  harness.advance(returning.preview.plan.shipReleaseQd);
  check(true);
  harness.data.catalog.marketEconomy.countries[0].visibility = "public";
  check(false);
  harness.data.catalog.eventRegions = harness.data.catalog.eventRegions.filter(row => row.value !== "a");
  check(true);
  assert.ok(harness.ship.lastOuting.details.some(detail => detail.reason.includes("PRIVATE PORT DELTA")),
    "the GM's original journal survives visibility changes and catalog replacement");
  globalThis.game.user = { id: "gm", isGM: true };
}

// A private order affects its own (possibly multi-order) outing, never a later one.
for (const returnHome of [true, false]) {
  const f = transportFixture(), harness = transportHarness(f);
  const first = await harness.book(transportRequest(harness.fixture(), "a", {
    direction: "outbound", ownShipId: f.ship.id, returnHome
  }), "private-past-outing");
  harness.advance(first.preview.plan.shipReleaseQd);
  const hidden = structuredClone(harness.holding.special.transportV2.orders[0]);
  hidden.commercial.marketRegionId = "removed-private-port";
  hidden.commercial.marketId = "market-location:removed-private-port";
  harness.holding.special.transportV2.orders[0] = hidden;
  await harness.book(transportRequest(harness.fixture(), returnHome ? "a" : "home", {
    ownShipId: f.ship.id, returnHome: true
  }), "public-next-outing");
  for (const isGM of [true, false]) {
    globalThis.game.user = { id: isGM ? "gm" : "player", isGM };
    const row = prepareShipWindowContext(harness.holding, { data: harness.data, shipId: harness.ship.id }).rows[0];
    const routes = row.financePresentation.outing.details.filter(detail => detail.kind === "leg-start");
    assert.ok(routes.length);
    assert.equal(routes.every(detail => detail.reason === "Скрытый участок"), !isGM && !returnHome,
      "only accepted orders belonging to this outing can hide its text-only route notes");
  }
}
delete globalThis.game;
{
  const f = transportFixture();
  const oldSale = { id: "old-private-sale", operationId: "old-private-sale", ownShipId: f.ship.id,
    marketId: "market-location:a", marketLabel: "LEGACY PRIVATE PORT", status: "needsResolution", revenueCopper: 123, cargo: [] };
  f.holding.special.market.outbound.orders.push(oldSale);
  f.data.catalog.marketEconomy.countries[0].visibility = "gm";
  const before = structuredClone(f.data);
  for (const isGM of [true, false]) {
    globalThis.game = { user: { id: isGM ? "gm" : "player", isGM },
      users: [{ id: "gm", isGM: true, active: true }], socket: { emit() { throw new Error("Rendering wrote data"); } } };
    const row = prepareShipWindowContext(f.holding, { data: f.data, shipId: f.ship.id }).rows[0];
    assert.equal(row.ownSale.marketLabel, isGM ? "LEGACY PRIVATE PORT" : "Скрытый рынок");
    assert.equal(row.voyagePresentation.stops[0].label, isGM ? "LEGACY PRIVATE PORT" : "Скрытый рынок");
    assert.equal(JSON.stringify(row.financePresentation).includes("LEGACY PRIVATE PORT"), isGM);
  }
  assert.deepEqual(f.data, before, "ordinary legacy sale controls use a projection, not a rewritten order");
}
delete globalThis.game;
console.log("Transport finance: real GM/player bookings/views, plan and receipt attribution, inventory exclusion, partial loss/insurance, mixed delivery and multiple orders per outing passed.");
