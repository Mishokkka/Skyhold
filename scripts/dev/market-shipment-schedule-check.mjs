import assert from "node:assert/strict";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { planMarketPurchase } from "../engines/market/pricing.js";
import { marketShipmentSchedule } from "../engines/market/shipment-schedule.js";
import { advanceMarketShipments, cancelMarketShipment, createMarketShipment, deliverMarketShipmentNow, marketShipmentCancellationQuote, proposeMarketShipmentRisk, resolveMarketShipmentRisk } from "../engines/market/shipment.js";
import { inboundDeliveryFixture, inboundDeliveryDependencies } from "./market-inbound-delivery-check.mjs";

function fixture(serviceLevel = "standard", qty = 840) {
  const { holding, quote } = inboundDeliveryFixture();
  const plan = planMarketPurchase({ holding, quote, quantities: { wood: qty }, serviceLevel });
  const created = createMarketShipment({ holding, plan, operationId: "schedule", createdAt: "2026-10-06", dependencies: inboundDeliveryDependencies });
  assert.equal(created.ok, true);
  return { holding, plan, created, late: created.orders[1] };
}

for (const serviceLevel of ["standard", "express", "charter"]) {
  const { holding, plan, created } = fixture(serviceLevel, 1640);
  assert.ok(plan.shipmentBatches.every((batch) => batch.riskProfile.maxDelayQd === plan.shipmentBatches[0].riskProfile.maxDelayQd), "waiting for a later departure never increases the road delay cap");
  for (const [index, order] of created.orders.entries()) {
    const snapshot = JSON.stringify(order);
    const timing = marketShipmentSchedule(Object.freeze(order));
    assert.equal(timing.waitingQd, index * plan.dispatchIntervalQd);
    assert.equal(timing.transportQd, plan.firstDeliveryQd);
    assert.equal(order.deliveryQd, timing.transportQd + timing.waitingQd);
    assert.equal(JSON.stringify(order), snapshot);
    assert.equal("departureQd" in order, false, "derived schedule needs no new persisted fields");
    assert.equal("transportQd" in order, false);
  }
  const reloaded = mergeHoldingDefaults(JSON.parse(JSON.stringify(holding)));
  for (const [index, order] of reloaded.special.market.orders.entries()) {
    assert.equal(marketShipmentSchedule(order).waitingQd, index * plan.dispatchIntervalQd);
  }
}

// Before, at and after departure: cancellation and risk have different boundaries.
{
  let { holding, late } = fixture();
  let lateRolls = 0;
  const dependencies = { ...inboundDeliveryDependencies, riskUnit: (seed) => {
    if (seed.includes(late.id)) lateRolls++;
    return 0.99;
  } };
  const before = JSON.stringify(late);
  assert.equal(proposeMarketShipmentRisk({ order: late, dependencies }).waiting, true);
  advanceMarketShipments({ holding, elapsedQd: 0, dependencies });
  assert.equal(JSON.stringify(late), before, "zero elapsed time must not depart or roll a booked shipment");
  advanceMarketShipments({ holding, elapsedQd: 7, dependencies });
  assert.equal(late.remainingQd, 41);
  assert.equal(late.dispatchStatus, "booked");
  assert.equal(marketShipmentSchedule(late).waitingQd, 1);
  assert.equal(marketShipmentCancellationQuote(late).cancellable, true);
  assert.equal(lateRolls, 0);
  holding = mergeHoldingDefaults(JSON.parse(JSON.stringify(holding)));
  late = holding.special.market.orders[1];
  const storedRiskSeed = late.riskSeed;
  advanceMarketShipments({ holding, elapsedQd: 1, dependencies });
  assert.equal(late.dispatchStatus, "departed");
  assert.equal(late.remainingQd, 40);
  assert.equal(late.riskStatus, "pending");
  assert.equal(lateRolls, 0, "departure itself has no elapsed road exposure");
  const money = holding.storage.moneyCopper;
  assert.equal(cancelMarketShipment({ holding, orderId: late.id, dependencies }).ok, false);
  assert.equal(holding.storage.moneyCopper, money);
  advanceMarketShipments({ holding, elapsedQd: 1, dependencies });
  assert.equal(late.riskStatus, "resolved");
  assert.equal(late.remainingQd, 39);
  assert.equal(lateRolls, 3);
  assert.equal(late.riskSeed, storedRiskSeed);
  advanceMarketShipments({ holding, elapsedQd: 0, dependencies });
  assert.equal(lateRolls, 3, "a stored clear outcome must never reroll");
}

// Cancellation after another batch departed still refunds only the waiting batch.
{
  const { holding, created, late } = fixture();
  advanceMarketShipments({ holding, elapsedQd: 7, dependencies: inboundDeliveryDependencies });
  const money = holding.storage.moneyCopper;
  const refund = cancelMarketShipment({ holding, orderId: late.id, dependencies: inboundDeliveryDependencies });
  assert.equal(refund.ok, true);
  assert.equal(refund.refundCopper, late.totalCopper);
  assert.equal(holding.storage.moneyCopper, money + late.totalCopper);
  assert.equal(created.orders[0].dispatchStatus, "departed");
  assert.equal(cancelMarketShipment({ holding, orderId: late.id, dependencies: inboundDeliveryDependencies }).replay, true);
  assert.equal(holding.storage.moneyCopper, money + late.totalCopper);
  advanceMarketShipments({ holding, elapsedQd: 100, dependencies: inboundDeliveryDependencies });
  assert.equal(holding.storage.resources.reduce((sum, row) => sum + row.qty, 0), 800);
}

// A large step consumes waiting, then stops at a road incident using the old pause contract.
{
  const { holding, late } = fixture();
  const dependencies = { ...inboundDeliveryDependencies, riskUnit: (seed) => seed.includes(late.id) && seed.endsWith("|loss") ? 0 : 0.99 };
  const money = holding.storage.moneyCopper;
  const advance = advanceMarketShipments({ holding, elapsedQd: 9, dependencies });
  assert.equal(advance.needsResolution.length, 1);
  assert.equal(late.dispatchStatus, "departed");
  assert.equal(late.remainingQd, 40, "waiting is consumed; the blocked incident's road portion stays paused");
  assert.equal(holding.storage.moneyCopper, money, "a proposed loss does not pay insurance");
  const proposal = JSON.stringify(late.riskProposal);
  advanceMarketShipments({ holding, elapsedQd: 100, dependencies });
  assert.equal(JSON.stringify(late.riskProposal), proposal);
  assert.equal(late.remainingQd, 40);
  const resolved = resolveMarketShipmentRisk({ holding, orderId: late.id, outcome: "delayed", delayQd: 2, operationId: "schedule:gm-delay", dependencies });
  assert.equal(resolved.ok, true);
  assert.equal(late.remainingQd, 42);
  assert.equal(resolveMarketShipmentRisk({ holding, orderId: late.id, dependencies }).replay, true);
  advanceMarketShipments({ holding, elapsedQd: 42, dependencies });
  assert.equal(late.status, "delivered");
  assert.equal(holding.storage.resources.reduce((sum, row) => sum + row.qty, 0), 840);
  assert.equal(holding.storage.moneyCopper, money);
}

// Manual delivery explicitly waives risk even while the selected batch waits.
{
  const { holding, late } = fixture();
  const dependencies = { ...inboundDeliveryDependencies, riskUnit: () => { throw new Error("Manual delivery must not roll risk"); } };
  const delivered = deliverMarketShipmentNow({ holding, orderId: late.id, dependencies });
  assert.equal(delivered.delivered.length, 1);
  assert.equal(late.riskStatus, "waived");
  assert.equal(late.riskResolutionChoice, "manual-delivery");
  assert.equal(holding.storage.resources.reduce((sum, row) => sum + row.qty, 0), 40);
  assert.equal(deliverMarketShipmentNow({ holding, orderId: late.id, dependencies }).delivered.length, 0);
}

// A clear route's state and money agree for one large step versus quarter-day steps.
for (const serviceLevel of ["standard", "express", "charter"]) {
  const large = fixture(serviceLevel, 1640);
  const small = fixture(serviceLevel, 1640);
  advanceMarketShipments({ holding: large.holding, elapsedQd: large.plan.deliveryQd, dependencies: inboundDeliveryDependencies });
  for (let qd = 0; qd < small.plan.deliveryQd; qd++) advanceMarketShipments({ holding: small.holding, elapsedQd: 1, dependencies: inboundDeliveryDependencies });
  const state = (holding) => holding.special.market.orders.map((order) => [order.status, order.dispatchStatus, order.remainingQd, order.riskOutcome]);
  assert.deepEqual(state(small.holding), state(large.holding));
  assert.equal(small.holding.storage.moneyCopper, large.holding.storage.moneyCopper);
  assert.equal(small.holding.storage.resources.reduce((sum, row) => sum + row.qty, 0), 1640);
}

// Existing departed cargo and its accepted risk must not be rewound or repriced.
{
  const { holding, late } = fixture();
  late.dispatchStatus = "departed";
  late.dispatchedAt = "old-save";
  late.remainingQd = 47;
  late.riskMaxDelayQd = 12;
  const acceptedMoney = late.totalCopper;
  assert.equal(marketShipmentSchedule(late).waitingQd, 0);
  advanceMarketShipments({ holding, elapsedQd: 1, dependencies: inboundDeliveryDependencies });
  assert.equal(late.remainingQd, 46);
  assert.equal(late.dispatchedAt, "old-save");
  assert.equal(late.riskMaxDelayQd, 12);
  assert.equal(late.totalCopper, acceptedMoney);
  assert.equal(marketShipmentCancellationQuote(late).cancellable, false);
  const legacy = mergeHoldingDefaults({ id: "old", special: { market: { orders: [{ id: "old-order", status: "in-transit", deliveryQd: 4, remainingQd: 3 }] } } }).special.market.orders[0];
  assert.equal(marketShipmentSchedule(legacy).booked, false);
  assert.equal(legacy.riskStatus, "waived");
  const partial = { ...late, dispatchStatus: "booked", dispatchedAt: "", standardDeliveryQd: undefined };
  assert.equal(marketShipmentSchedule(partial).waitingQd, 0, "partial legacy metadata must not invent a queue");
  holding.storage.log = [];
  const beforeReplayMoney = holding.storage.moneyCopper;
  const replay = createMarketShipment({ holding, plan: fixture().plan, operationId: "schedule", dependencies: inboundDeliveryDependencies });
  assert.equal(replay.replay, true);
  assert.equal(holding.storage.log.length, 0, "replaying an old purchase must not reconstruct a historical payment receipt");
  assert.equal(holding.storage.moneyCopper, beforeReplayMoney);
}

console.log("Market shipment schedule: waiting/dispatch/risk boundaries, reload, partial cancellation, incident pause, GM manual waiver, large-step parity and saved-order compatibility passed.");
