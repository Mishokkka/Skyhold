import assert from "node:assert/strict";
import { transportFixture, transportRequest } from "./fixtures/transport-v2.mjs";
import { harness } from "./fixtures/transport-tenday.mjs";
import { transportHoldingQd } from "../data/transport/clock.js";
import { ensureTransportState } from "../data/transport/state.js";
import { prepareTransportContext } from "../apps/domains/transport-context.js";
import { installTransportTestCalendar, transportTestDate, transportTestYearQd as epoch } from "./fixtures/transport-calendar.mjs";

const calendar = installTransportTestCalendar();
try {
  for (const qd of [40, 80]) {
    const f = transportFixture(); f.holding.people.list = []; f.holding.special.ships.list = [];
    Object.assign(f.holding.gm.calendaria, { lastQd: 40, lastDateTime: transportTestDate(epoch + 400) });
    const dormant = structuredClone(f.holding); dormant.id = "dormant";
    Object.assign(dormant.gm.calendaria, { lastQd: 0, lastDateTime: transportTestDate(epoch) });
    f.data.holdings.push(dormant); delete f.data.meta.transportV2; ensureTransportState(f.data);
    const h = harness(f.data); h.reload();
    const other = structuredClone(h.holding(f.holding.id)), initialEpoch = h.data.meta.transportV2.calendarEpochQd;
    assert.equal(transportHoldingQd(h.data, h.holding("dormant")), -360);
    assert.equal(h.workflow._checkCalendariaEconomyAdvance(h.holding("dormant"), qd).ok, true);
    const request = transportRequest({ ...f, data: h.data, holding: h.holding("dormant") });
    assert.throws(() => prepareTransportContext({ data: h.data, holding: h.holding("dormant"), request, isGM: true }), /отстаёт/);
    while (h.holding("dormant").gm.calendaria.lastQd < 400) {
      await h.apply(await h.prepare("dormant", qd)); h.reload();
      assert.equal(h.data.meta.transportV2.calendarEpochQd, initialEpoch, "backfill cannot move accepted schedules' coordinate origin");
      assert.deepEqual(h.holding(f.holding.id), other, "catch-up cannot process the other holding");
    }
    assert.equal(transportHoldingQd(h.data, h.holding("dormant")), 40);
    assert.equal(h.data.meta.transportV2.clockQd, 40);
    assert.ok(prepareTransportContext({ data: h.data, holding: h.holding("dormant"), request, isGM: true }).plan);
  }
} finally { calendar.restore(); }
console.log("Transport clock catch-up: signed common dates, ordinary and batched tendays, fixed epoch, new-booking gate, actual Apply/reload/replay and foreign isolation passed.");
