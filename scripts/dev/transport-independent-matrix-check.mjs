import assert from "node:assert/strict";
import { fixture, book, harness } from "./fixtures/transport-tenday.mjs";
import { mergeHoldingDefaults } from "../data/normalizers.js";

const permutations = [[0,1,2], [0,2,1], [1,0,2], [1,2,0], [2,0,1], [2,1,0]];
const totals = { scenarios: 0, decisions: 0, applies: 0, orders: 0 };
const household = data => data.holdings.map(row => ({ id: row.id, storage: structuredClone(row.storage),
  clock: structuredClone(row.gm.calendaria), ships: structuredClone(row.special.ships) }));
const started = performance.now();

for (const sequence of permutations) for (const outcome of ["success", "delay", "partial", "total"]) {
  for (const vehicles of [1, 2]) for (const periodQd of [40, 80]) {
    const f = fixture();
    const initial = f.data.holdings[0];
    f.data.holdings = [0,1,2].map(index => mergeHoldingDefaults({ ...structuredClone(initial), id: `h${index}`,
      people: { list: [] }, storage: { moneyCopper: 500000, resources: [] },
      special: { ...structuredClone(initial.special), transportV2: { version: 2, orders: [] } } }));
    const accepted = new Map();
    for (const [index, holding] of f.data.holdings.entries()) {
      const base = { kind: "charter", capacity: 40000, vehicles: 1, loadingQd: 1, travelQd: 2, unloadingQd: 1,
        returnQd: 2, dispatchCopper: 3, riskBps: 0 };
      const services = [
        { ...base, id: `feeder-${index}`, from: `source-${index}`, to: "hub", riskBps: 10000 },
        { ...base, id: "shared-regular", kind: "regular", from: "hub", to: "transfer", intervalQd: 13, firstQd: 2 },
        { ...base, id: "shared-charter", from: "transfer", to: "destination", capacity: 28000, vehicles }
      ];
      const order = book(f, holding, `order-${index}`, services, { resourceId: "wood", qty: [7,11,13][index], direction: index === 1 ? "outbound" : "inbound" });
      accepted.set(order.id, structuredClone(order.plan));
    }
    const h = harness(f.data); h.reload();
    async function ready(id, qd) {
      for (let pass = 0; pass < 80; pass++) {
        const prepared = await h.prepare(id, qd);
        if (prepared.ok) return prepared;
        const row = prepared.transportReview?.find(row => row.canResolve);
        assert.ok(row, JSON.stringify({ sequence, outcome, vehicles, periodQd, id, rows: prepared.transportReview }));
        const resolution = row.carrier ? { outcome: "carrier" } : outcome === "delay" ? { outcome: "delay", delayQd: 8 }
          : ["partial", "total"].includes(outcome) ? { outcome: "loss", lossBps: outcome === "partial" ? 2500 : 10000 }
          : { outcome: "success" };
        const before = household(h.data);
        await h.decide(prepared, resolution); totals.decisions++;
        assert.deepEqual(household(h.data), before, "physical decisions never apply a household ledger or clock");
        h.reload();
      }
      throw new Error("Transport decisions did not converge");
    }
    for (let round = 0; round < 8; round++) {
      for (const index of sequence) {
        const id = `h${index}`;
        await h.apply(await ready(id, periodQd)); totals.applies++; h.reload();
      }
      if (h.data.holdings.every(holding => holding.special.transportV2.orders.every(order => ["delivered", "lost"].includes(order.status)))) break;
      assert.notEqual(round, 7, "all accepted orders finish within this finite fixture");
    }
    for (const holding of h.data.holdings) for (const order of holding.special.transportV2.orders) {
      const quantity = lots => lots.reduce((sum, lot) => sum + lot.qty, 0);
      const received = quantity(order.received);
      assert.equal(received + order.lostQty + order.spoiledQty, quantity(order.cargo), "cargo conservation");
      assert.deepEqual(order.plan, accepted.get(order.id), "accepted contract is immutable");
      assert.equal(order.money.treasuryCopper, order.money.commercialSpentCopper + order.money.spentCopper
        + order.money.refundedCopper + order.money.escrowCopper, "escrow conservation");
      assert.equal(holding.storage.moneyCopper, 500000 - order.money.treasuryCopper + order.money.refundedCopper
        + order.insurancePaidCopper + (order.direction === "outbound" ? received * 5 : 0), "treasury conservation");
      for (const stage of order.stages) assert.equal(new Set(stage.receipts.map(row => row.runId)).size, stage.receipts.length,
        "one receipt per physical allocation");
      totals.orders++;
    }
    totals.scenarios++;
  }
}
console.log(JSON.stringify({ ...totals, seconds: Math.round((performance.now() - started) / 1000),
  dimensions: "3 holdings, 6 processing orders, 4 incident outcomes, 2 finite fleet sizes, 2 batch sizes; prepare/decision/Apply/reload/replay" }));
