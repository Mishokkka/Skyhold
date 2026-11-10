import assert from "node:assert/strict";
import { fixture, book, harness } from "./fixtures/transport-tenday.mjs";

const quantity = cargo => cargo.reduce((sum, lot) => sum + lot.qty, 0);
async function scenario(kind, qd, reverse) {
  const f = fixture({ two: true }), split = ["late-loss", "early-only"].includes(kind);
  f.data.holdings[1].people.list = [];
  const a = { ...f.carrier, id: "early-feeder", kind: "regular", from: "a", to: "c",
    capacity: (split ? 5 : 60) * 4000, firstQd: 1, intervalQd: split ? 28 : 80,
    loadingQd: 0, unloadingQd: 0, travelQd: 3, riskBps: 10000 };
  const b = { ...a, id: "late-feeder", from: "b", capacity: (split ? 5 : 40) * 4000, firstQd: 29, riskBps: 0 };
  const shared = { ...f.carrier, id: "shared-line", kind: "regular", from: "c", to: "home",
    capacity: (split ? 10 : 50) * 4000, firstQd: 5, intervalQd: 28,
    loadingQd: 1, travelQd: 3, unloadingQd: 0, riskBps: kind === "shared-calm" ? 0 : 10000 };
  const tail = { ...f.carrier, id: "finite-tail", kind: "charter", from: "home", to: "destination",
    capacity: shared.capacity, loadingQd: 0, unloadingQd: 0, travelQd: 2, returnQd: 1, riskBps: 0 };
  book(f, f.data.holdings[0], "first-food", [a, shared, tail], { qty: split ? 10 : 60 });
  book(f, f.data.holdings[1], "second-food", [b, shared, tail], { qty: split ? 5 : 40 });
  const h = harness(f.data);
  const resolution = row => {
    if (row.carrier) return { outcome: "carrier" };
    if (row.runId.startsWith("early-feeder:")) {
      if (!split) return { outcome: "delay", delayQd: 4 };
      const early = row.runId.endsWith(":1");
      if (kind === "early-only") return { outcome: "loss", lossBps: early ? 8000 : 10000 };
      return early ? { outcome: "success" } : { outcome: "loss", lossBps: 8000 };
    }
    return kind === "shared-loss" ? { outcome: "loss", lossBps: 5000 } : { outcome: "success" };
  };
  async function ready(id, periodQd = qd, depth = 0) {
    assert.ok(depth < 6, "related-holding navigation terminates");
    for (let pass = 0; pass < 60; pass++) {
      const prepared = await h.prepare(id, periodQd);
      if (prepared.ok) return prepared;
      const next = prepared.transportReview?.find(row => row.canResolve);
      if (!next) {
        const blocker = prepared.transportReview.flatMap(row => row.blockers).find(row => row.holdingId !== id);
        assert.ok(blocker, prepared.message);
        await ready(blocker.holdingId, blocker.qd || 40, depth + 1);
        continue;
      }
      const cash = h.data.holdings.map(holding => ({ storage: structuredClone(holding.storage), calendar: structuredClone(holding.gm.calendaria),
        receipts: holding.special.transportV2.orders.map(order => order.stages.map(stage => structuredClone(stage.receipts))) }));
      await h.decide(prepared, resolution(next)); h.reload();
      assert.deepEqual(h.data.holdings.map(holding => ({ storage: holding.storage, calendar: holding.gm.calendaria,
        receipts: holding.special.transportV2.orders.map(order => order.stages.map(stage => stage.receipts)) })), cash,
      "keeping a manifest reservation cannot conduct the other holding's cargo, cash or clock");
    }
    assert.fail("review terminates");
  }
  let first;
  for (const id of reverse ? ["second", "first"] : ["first", "second"]) {
    const prepared = await ready(id);
    if (id === "first") first = structuredClone(prepared);
    await h.apply(prepared); h.reload();
  }
  const order = first.preparedHolding.special.transportV2.orders[0];
  const summary = { received: quantity(order.received), eaten: first.report.food.eaten, hungry: first.report.food.hungryResidentDays,
    stages: order.stages.map(stage => stage.receipts.map(receipt => ({ at: receipt.arrivalQd, qty: quantity(receipt.cargo) }))
      .sort((a, b) => a.at - b.at)) };
  if (qd === 40) {
    assert.equal(summary.received, { delay: 10, "shared-calm": 10, "shared-loss": 5, "late-loss": 6, "early-only": 1 }[kind]);
    if (["delay", "shared-calm"].includes(kind)) { assert.equal(summary.eaten, 10); assert.equal(summary.hungry, 0); }
    if (kind === "late-loss") assert.deepEqual(summary.stages[2].map(row => row.at), [10, 38], "a partial manifest keeps its catchable shared departure");
    if (kind === "early-only") assert.deepEqual(summary.stages[2].map(row => row.at), [10], "a later shared reservation cannot hold all early stock");
  }
  for (const id of ["first", "second"]) while (h.holding(id).gm.calendaria.lastQd < 120) await h.apply(await ready(id, 40));
  for (const holding of h.data.holdings) for (const completed of holding.special.transportV2.orders) {
    assert.ok(["delivered", "lost"].includes(completed.status));
    assert.equal(quantity(completed.received) + completed.lostQty + completed.spoiledQty, quantity(completed.cargo));
    const money = completed.money;
    assert.equal(money.treasuryCopper + money.boardCopper, money.commercialSpentCopper + money.spentCopper + money.escrowCopper + money.refundedCopper);
    for (const stage of completed.stages) assert.equal(new Set(stage.receipts.map(row => row.runId)).size, stage.receipts.length);
  }
  return summary;
}

for (const kind of ["delay", "shared-calm", "shared-loss", "late-loss", "early-only"]) for (const qd of [40, 80]) {
  assert.deepEqual(await scenario(kind, qd, true), await scenario(kind, qd, false),
    `${kind}/${qd}: holding order cannot remove an allocated, catchable shared departure`);
}
console.log("Shared rebooking: catchable and partial manifests, early-stock priority, single/batch tendays, both holding orders, cargo/cash isolation and conservation passed.");
