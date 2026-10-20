import assert from "node:assert/strict";
import { parseResourceCosts } from "../core/resources.js";
import { appendProductionExpense, scaleProductionCosts } from "../core/production-expenses.js";
import { planStorageCosts } from "../engines/storage/group-payment.js";

export function checkProductionExpenses() {
  const deps = { safeNumber: (value, fallback = 0) => Number(value ?? fallback),
    isMoneyResource: () => false, normalizeRoomId: (id) => id || "outdoors",
    storageResourceMatches: (row, cost) => row.resourceId === cost.resourceId,
    resourceMatchesGroup: () => false };
  const holding = { storage: { resources: [
    { id: "wood-row", resourceId: "wood", qty: 2 },
    { id: "stone-row", resourceId: "stone", qty: 1 }
  ] } };
  const source = structuredClone(holding);
  const costs = parseResourceCosts("wood 2 ИЛИ stone 1; wood 1 # примечание, которое не списывается");
  assert.equal(costs.length, 2);
  assert.deepEqual(costs[0].alternatives.map((row) => row.qty), [2, 1]);
  const paid = planStorageCosts({ holding, costs, dependencies: deps });
  assert.equal(paid.ok, true, "Choose stone because the mandatory wood also consumes the same inventory");
  assert.deepEqual(paid.costs.map((row) => [row.resourceId, row.qty]), [["wood", 1], ["stone", 1]]);
  assert.deepEqual(holding, source, "Alternative selection must not mutate stock");
  const scaled = scaleProductionCosts(costs, 3);
  assert.deepEqual(scaled[0].alternatives.map((row) => row.qty), [6, 3]);
  assert.equal(scaled[1].qty, 3);
  assert.equal(planStorageCosts({ holding, costs: scaled, dependencies: deps }).ok, false);
  assert.deepEqual(scaleProductionCosts(costs, 0), []);
  const mixedOnly = { storage: { resources: [{ resourceId: "wood", qty: 1 }, { resourceId: "stone", qty: 1 }] } };
  assert.equal(planStorageCosts({ holding: mixedOnly, costs: parseResourceCosts("wood 2 ИЛИ stone 2"), dependencies: deps }).ok, false, "OR selects one complete option, not fractions of both");
  assert.equal(parseResourceCosts("wood 1 И stone 2").length, 2);
  assert.deepEqual(parseResourceCosts("# примечание 100"), []);
  assert.equal(appendProductionExpense("wood 2 # заметка", "stone", 1, "or"), "wood 2 ИЛИ stone 1 # заметка");
  assert.equal(appendProductionExpense("wood 2", "stone", 3, "and"), "wood 2; stone 3");
}
