import assert from "node:assert/strict";
import { fixture, book, harness } from "./fixtures/transport-tenday.mjs";

function createScenario() {
  const f = fixture({ two: true });
  for (const [index, holding] of f.data.holdings.entries()) {
    holding.people.list = [];
    const base = { kind: "charter", capacity: 16000, vehicles: 1, loadingQd: 1, unloadingQd: 1,
      travelQd: 2, returnQd: 2, dispatchCopper: 3, riskBps: 10000 };
    book(f, holding, `priority-${index}`, [
      { ...base, id: `feeder-${holding.id}`, from: `source-${holding.id}`, to: "hub", travelQd: index + 1 },
      { ...base, id: "shared-line", kind: "regular", from: "hub", to: "transfer", capacity: 48000,
        intervalQd: 13, firstQd: 2, travelQd: 3 },
      { ...base, id: "shared-final", from: "transfer", to: "home", capacity: 28000, travelQd: 4 }
    ], { qty: 21 });
  }
  const h = harness(f.data); h.reload(); return h;
}

const resolutions = new Map([
  ["feeder-second:0:0", { outcome: "loss", lossBps: 2500 }],
  ["feeder-second:0:6", { outcome: "delay", delayQd: 8 }],
  ["feeder-second:0:26", { outcome: "loss", lossBps: 10000 }],
  ["feeder-second:0:32", { outcome: "loss", lossBps: 2500 }],
  ["feeder-first:0:0", { outcome: "delay", delayQd: 8 }],
  ["feeder-first:0:18", { outcome: "delay", delayQd: 8 }],
  ["shared-line:regular:15", { outcome: "loss", lossBps: 2500 }],
  ["shared-line:regular:28", { outcome: "loss", lossBps: 10000 }]
]);
const resolution = row => row.carrier ? { outcome: "carrier" } : resolutions.get(row.runId) ?? { outcome: "success" };
const household = h => h.data.holdings.map(row => ({ id: row.id, clock: structuredClone(row.gm.calendaria), storage: structuredClone(row.storage) }));
async function decide(h, prepared) {
  const row = prepared.transportReview.find(row => row.canResolve), before = household(h);
  assert.ok(row, "a ready physical prerequisite must be reachable");
  await h.decide(prepared, resolution(row));
  assert.deepEqual(household(h), before, "physical decisions cannot apply either household's cargo, money or clock");
  h.reload();
}

async function ready(h, id, qd = 40, trail = new Set()) {
  assert.ok(!trail.has(id), "prerequisite navigation cannot cycle");
  for (let pass = 0; pass < 80; pass++) {
    const prepared = await h.prepare(id, qd);
    if (prepared.ok) return prepared;
    if (prepared.transportReview?.some(row => row.canResolve)) await decide(h, prepared);
    else {
      const blocker = prepared.transportReview?.flatMap(row => row.blockers).find(row => row.holdingId !== id && !trail.has(row.holdingId));
      assert.ok(blocker, prepared.message);
      await ready(h, blocker.holdingId, blocker.qd || 40, new Set([...trail, id]));
    }
  }
  assert.fail("the finite transport review must terminate");
}

for (const periodQd of [40, 80]) for (const reverse of [false, true]) {
  const h = createScenario();
  // The valid public decision prefix from the audit, before a late shared manifest is frozen.
  for (const id of ["second", "second", "second", "second", "second", "first", "first"]) await decide(h, await h.prepare(id, 40));
  const projected = await h.prepare("second", 40, { includeTransportProjection: true });
  const first = projected.transportProjection.data.holdings.find(row => row.id === "first").special.transportV2.orders[0];
  assert.equal(first.stages[1].receipts.some(row => row.runId === "shared-line:regular:28"), false,
    "eight ready units cannot all board the late flight while four still belong to the earlier departure");
  assert.equal(projected.transportReview.find(row => row.runId === "shared-line:regular:28")?.canLose, false,
    "a manifest depending on an unresolved feeder cannot freeze an irreversible shared loss");
  for (const id of reverse ? ["second", "first"] : ["first", "second"]) await h.apply(await ready(h, id, periodQd));
  for (const id of ["first", "second"]) while (h.holding(id).gm.calendaria.lastQd < 160) await h.apply(await ready(h, id));
  for (const holding of h.data.holdings) for (const order of holding.special.transportV2.orders) {
    assert.ok(["delivered", "lost"].includes(order.status));
    assert.equal(order.received.reduce((sum, lot) => sum + lot.qty, 0) + order.lostQty + order.spoiledQty, 21);
    assert.equal(holding.storage.moneyCopper + order.money.escrowCopper + order.money.spentCopper + order.money.commercialSpentCopper, 500000);
    assert.ok(order.stages.every(stage => new Set(stage.receipts.map(row => row.runId)).size === stage.receipts.length));
  }
}
console.log("Transport cargo priority: earlier reservations, causal shared manifests, partial/total loss, delayed feeder, single/batch tendays, both holding orders, reload/replay and household isolation passed.");
