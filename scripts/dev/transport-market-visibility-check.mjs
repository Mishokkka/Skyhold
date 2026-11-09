import assert from "node:assert/strict";
import { transportFixture, transportRequest } from "./fixtures/transport-v2.mjs";
import { harness } from "./fixtures/transport-tenday.mjs";
import { prepareTransportContext } from "../apps/domains/transport-context.js";
import { createMarketVisibility } from "../data/market/visibility.js";

for (const direction of ["inbound", "outbound"]) for (const hiddenAtBooking of [false, true]) {
  const f = transportFixture(), id = f.holding.id, label = "PRIVATE PORT OMEGA";
  f.holding.people.list = []; f.holding.special.ships.list = [];
  f.data.catalog.eventRegions.find(row => row.value === "a").label = label;
  if (hiddenAtBooking) f.data.catalog.eventRegions.find(row => row.value === "a").countryId = "hidden";
  const h = harness(f.data), current = () => h.holding(id);
  const request = transportRequest({ ...f, data: h.data, holding: current() }, "a", { direction, insurance: false });
  const quote = prepareTransportContext({ data: h.data, holding: current(), request, isGM: true });
  const operation = { type: "transport-book", operationId: `visibility-${direction}-${hiddenAtBooking}`, holdingId: id,
    expectedRevision: h.data.meta.revision, sourceToken: quote.sourceToken, planToken: quote.planToken, request };
  await h.execute(operation, { userId: "gm" }); h.reload();
  const order = () => current().special.transportV2.orders[0];
  function view(hidden) {
    const before = structuredClone(h.data);
    h.workflow._contextData = h.data; h.workflow.activeStorageTab = "log";
    for (const isGM of [true, false]) {
      game.user = { id: isGM ? "gm" : "player", isGM };
      const rows = h.workflow._storageContext(current(), false).logRows;
      const hasMarketEntry = current().storage.log.some(row => row.source === label);
      assert.equal(rows.some(row => row.source === label), hasMarketEntry && (isGM || !hidden), `${direction}: saved market label follows viewer visibility`);
      if (hasMarketEntry && !isGM && hidden) assert.ok(rows.some(row => row.source === "Скрытый рынок"));
      assert.ok(rows.some(row => row.source === "Перевозки"), "generic reserve-transfer labels stay generic");
      assert.equal(createMarketVisibility(h.data, { isGM }).marketLabel(order().commercial), isGM || !hidden ? label : "Скрытый рынок");
    }
    assert.deepEqual(h.data, before, "role projection cannot erase GM labels or change financial history");
    game.user = { id: "gm", isGM: true };
  }
  view(hiddenAtBooking);
  if (!hiddenAtBooking) {
    h.data.catalog.eventRegions.find(row => row.value === "a").countryId = "hidden";
    view(true);
  }
  await h.apply(await h.prepare(id, 120)); h.reload();
  assert.equal(order().status, "delivered");
  view(true);
  assert.ok(current().storage.log.some(row => row.source === label && row.operationId === order().id), "actual booking/delivery labels remain stored for GM");
  // Older v2 records can identify a market through marketId, without a redundant region field.
  delete order().commercial.marketRegionId;
  view(true);
  h.data.catalog.eventRegions.find(row => row.value === "a").countryId = "public";
  view(false);
  const unknown = createMarketVisibility(null);
  assert.equal(unknown.marketLabel(order().commercial), "Скрытый рынок");
}
console.log("Market visibility: actual GM import/export, booking and delivery logs, public/private changes, missing legacy region hints, normalization and read-only player projections passed.");
