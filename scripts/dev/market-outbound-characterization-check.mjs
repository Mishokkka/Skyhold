import assert from "node:assert/strict";
import { marketDemandKey, normalizeMarketDemandState } from "../data/market/demand-state.js";
import {
  MAX_ACTIVE_OUTBOUND_ORDERS,
  MAX_TERMINAL_OUTBOUND_ORDERS,
  normalizeMarketOutboundState
} from "../data/market/outbound-state.js";
import {
  allocateMarketOutboundBuyers,
  marketOutboundAvailableQuantity,
  planMarketOutboundSale
} from "../engines/market/outbound.js";
import {
  advanceMarketOutboundShipments,
  cancelMarketOutboundShipment,
  createMarketOutboundShipment,
  dispatchMarketOutboundShipment,
  resolveMarketOutboundShipmentRisk
} from "../workflows/market/outbound-shipment.js";

function holding() {
  return {
    storage: {
      moneyCopper: 100,
      resources: [{
        id: "wood-row",
        resourceId: "wood",
        name: "Древесина",
        qty: 10,
        batches: [
          { id: "wood-old", qty: 6, ageQd: 30 },
          { id: "wood-new", qty: 4, ageQd: 0 }
        ]
      }],
      log: []
    },
    special: { market: { demand: {}, outbound: { version: 1, orders: [] } } }
  };
}

const organizations = [
  { id: "buyer-a", label: "Покупатель А", active: true, buyer: { enabled: true, countryShares: [{ countryId: "north", sharePct: 30 }] } },
  { id: "buyer-b", label: "Покупатель Б", active: true, buyer: { enabled: true, countryShares: [{ countryId: "north", sharePct: 20 }] } },
  { id: "seller-only", label: "Только продавец", active: true, merchant: { enabled: true, countryShares: [{ countryId: "north", sharePct: 90 }] } }
];

const partialTagBuyers = allocateMarketOutboundBuyers({
  lines: [{ id: "spare-parts", resourceId: "spare-parts", qty: 1, tags: ["parts"] }],
  organizations: [{ id: "art-buyer", active: true, buyer: { enabled: true, includeTags: ["art"], countryShares: [{ countryId: "north", sharePct: 100 }] } }],
  countryId: "north"
});
assert.equal(partialTagBuyers.some((row) => row.buyerId === "art-buyer"), false, "buyer tag selectors must not match arbitrary substrings such as art inside parts");

const oversizedState = normalizeMarketOutboundState({
  orders: [
    ...Array.from({ length: MAX_ACTIVE_OUTBOUND_ORDERS + 5 }, (_, index) => ({
      id: `active-${index}`,
      operationId: `active-${index}`,
      status: "booked",
      dispatchStatus: "booked"
    })),
    ...Array.from({ length: MAX_TERMINAL_OUTBOUND_ORDERS + 50 }, (_, index) => ({
      id: `terminal-${index}`,
      operationId: `terminal-${index}`,
      status: "delivered",
      dispatchStatus: "delivered"
    }))
  ]
});
assert.equal(oversizedState.orders.filter((order) => order.status === "booked").length, MAX_ACTIVE_OUTBOUND_ORDERS + 5, "normalization must conserve every active outbound order, including legacy state above the booking cap");
assert.equal(oversizedState.orders.filter((order) => order.status === "delivered").length, MAX_TERMINAL_OUTBOUND_ORDERS, "only terminal outbound history may be bounded");

function routes({ risky = false } = {}) {
  return [
    {
      id: "expensive",
      ok: true,
      freightCopper: 9,
      tariffCopper: 1,
      insurancePremiumRate: 0.1,
      insuranceCoverageRate: 0.8,
      deliveryQd: 1,
      riskLossChance: risky ? 0.08 : 0,
      riskDelayChance: 0
    },
    {
      id: "cheap",
      ok: true,
      freightCopper: 5,
      tariffCopper: 2,
      insurancePremiumRate: 0.1,
      insuranceCoverageRate: 0.8,
      deliveryQd: 2,
      riskLossChance: risky ? 0.08 : 0,
      riskDelayChance: 0,
      routePath: ["laputa", "north-market"],
      routeModes: ["airship"],
      transportMode: "airship"
    }
  ];
}

function salePlan(target, options = {}) {
  return planMarketOutboundSale({
    resources: target.storage.resources,
    outboundState: normalizeMarketOutboundState(target.special.market.outbound),
    lines: [{
      id: "wood-sale",
      resourceId: "wood",
      demandId: "wood",
      name: "Древесина",
      qty: 5,
      unitPriceCopper: 10,
      demandBaseDemand: 10,
      demandStateRevision: 0,
      tags: ["construction"]
    }],
    routes: routes(options),
    organizations,
    marketId: "north-market",
    marketLabel: "Северный рынок",
    countryId: "north",
    treasuryCopper: target.storage.moneyCopper,
    insuranceEnabled: true
  });
}

function dependencies({ riskUnit = null } = {}) {
  return {
    addMoney: (target, amount) => { target.storage.moneyCopper += amount; },
    appendStorageLog: (target, rows) => { target.storage.log.push(...rows); },
    formatCurrency: (value) => `${value} медн.`,
    ...(riskUnit ? { riskUnit } : {})
  };
}

const reservedHolding = holding();
reservedHolding.special.market.outbound.orders.push({
  id: "existing",
  operationId: "existing",
  status: "booked",
  dispatchStatus: "booked",
  cargoReservations: [{ rowId: "wood-row", resourceId: "wood", batchId: "wood-old", qty: 2, ageQd: 30 }]
});
const reservedState = normalizeMarketOutboundState(reservedHolding.special.market.outbound);
assert.equal(marketOutboundAvailableQuantity({ resources: reservedHolding.storage.resources, outboundState: reservedState, resourceId: "wood" }), 8, "soft reservations must make exact batch quantities unavailable without deleting stock");
const planned = salePlan(reservedHolding);
assert.equal(planned.ok, true);
assert.equal(planned.route.id, "cheap", "planner must select the cheapest admissible complete route quote");
assert.equal(planned.revenueCopper, 50);
assert.equal(planned.freightCopper, 5);
assert.equal(planned.tariffCopper, 2);
assert.equal(planned.insuranceCopper, 6);
assert.equal(planned.upfrontCopper, 13, "freight, tariff and insurance premium must all be prepaid");
assert.equal(planned.insuredValueCopper, 57, "insurance value must include cargo value plus prepaid freight and tariff");
assert.equal(planned.maximumInsurancePayoutCopper, 45);
assert.deepEqual(planned.cargoReservations.map((row) => [row.batchId, row.qty, row.ageQd]), [["wood-old", 4, 30], ["wood-new", 1, 0]], "cargo must reserve the oldest still-available batches exactly");
assert.deepEqual(planned.buyerAllocations.map((row) => [row.buyerId, row.qty]), [["buyer-a", 2], ["buyer-b", 1], ["independent", 2]], "buyer-side shares must allocate real buyers and leave the unassigned remainder independent");
assert.ok(!planned.buyerAllocations.some((row) => row.buyerId === "seller-only"), "seller-side shares must not impersonate buyer-side shares");
assert.equal(reservedHolding.storage.resources[0].qty, 10, "preview must not remove cargo");

const createHolding = holding();
const createPlan = salePlan(createHolding);
const createDeps = dependencies();
const created = createMarketOutboundShipment({ holding: createHolding, plan: createPlan, operationId: "sale-create", createdAt: "2026-08-11T00:00:00Z", currentTenday: 4, dependencies: createDeps });
assert.equal(created.ok, true);
assert.equal(created.order.status, "booked");
assert.equal(createHolding.storage.moneyCopper, 87, "upfront costs must be charged when the outbound contract is booked");
assert.equal(createHolding.storage.resources[0].qty, 10, "booked outbound cargo must remain physically in storage until dispatch");
assert.equal(marketOutboundAvailableQuantity({ resources: createHolding.storage.resources, outboundState: createHolding.special.market.outbound, resourceId: "wood" }), 5, "booked cargo must be unavailable to other planners");
const demandKey = marketDemandKey("north-market", "wood");
let demand = normalizeMarketDemandState(createHolding.special.market.demand);
assert.equal(demand[demandKey].reservedDemand, 5);
assert.equal(demand[demandKey].consumedOutstanding, 0, "in-transit demand reservation must not start recovery");
assert.equal(Object.keys(createHolding.special.market.demand).length, 1, "buyer organizations must share one market-resource demand pool");
const createReplay = createMarketOutboundShipment({ holding: createHolding, plan: createPlan, operationId: "sale-create", dependencies: createDeps });
assert.equal(createReplay.replay, true);
assert.equal(createHolding.storage.moneyCopper, 87, "booking replay must not charge twice");

const cappedHolding = holding();
cappedHolding.special.market.outbound = normalizeMarketOutboundState({
  orders: Array.from({ length: MAX_ACTIVE_OUTBOUND_ORDERS }, (_, index) => ({
    id: `cap-${index}`,
    operationId: `cap-${index}`,
    status: "booked",
    dispatchStatus: "booked"
  }))
});
const cappedBefore = JSON.parse(JSON.stringify(cappedHolding));
const capRejected = createMarketOutboundShipment({
  holding: cappedHolding,
  plan: salePlan(cappedHolding),
  operationId: "sale-over-cap",
  dependencies: createDeps
});
assert.equal(capRejected.ok, false);
assert.equal(capRejected.capacityExceeded, true, "a 301st active outbound order must be rejected explicitly");
assert.deepEqual(cappedHolding, cappedBefore, "active-order cap rejection must not debit money, reserve demand or rewrite outbound state");

const cancelled = cancelMarketOutboundShipment({ holding: createHolding, orderId: "sale-create", cancelledAt: "2026-08-11T01:00:00Z", dependencies: createDeps });
assert.equal(cancelled.ok, true);
assert.equal(cancelled.refundCopper, 13);
assert.equal(createHolding.storage.moneyCopper, 100);
assert.equal(createHolding.storage.resources[0].qty, 10, "pre-dispatch cancellation must release soft cargo without recreating it");
demand = normalizeMarketDemandState(createHolding.special.market.demand);
assert.equal(demand[demandKey].reservedDemand, 0);
assert.equal(demand[demandKey].availableDemand, 10, "pre-dispatch cancellation must restore demand immediately");
const cancelReplay = cancelMarketOutboundShipment({ holding: createHolding, orderId: "sale-create", dependencies: createDeps });
assert.equal(cancelReplay.replay, true);
assert.equal(createHolding.storage.moneyCopper, 100, "cancellation replay must not refund twice");

const deliveryHolding = holding();
const deliveryDeps = dependencies();
const deliveryCreated = createMarketOutboundShipment({ holding: deliveryHolding, plan: salePlan(deliveryHolding), operationId: "sale-delivery", createdAt: "2026-08-11T02:00:00Z", dependencies: deliveryDeps });
assert.equal(deliveryCreated.ok, true);
deliveryHolding.storage.resources[0].batches[0].ageQd = 35;
const dispatched = dispatchMarketOutboundShipment({ holding: deliveryHolding, orderId: "sale-delivery", dispatchedAt: "2026-08-11T03:00:00Z", dependencies: deliveryDeps });
assert.equal(dispatched.ok, true);
assert.equal(deliveryHolding.storage.resources[0].qty, 5, "dispatch must remove the exact reserved cargo once");
assert.equal(dispatched.order.cargo[0].ageQd, 35, "dispatch must preserve the batch age actually loaded");
assert.equal(deliveryHolding.storage.moneyCopper, 87, "revenue must not be paid at booking or dispatch");
const deliveryAdvance = advanceMarketOutboundShipments({ holding: deliveryHolding, elapsedQd: 2, currentTenday: 1, advancedAt: "2026-08-12T00:00:00Z", dependencies: deliveryDeps });
assert.equal(deliveryAdvance.delivered.length, 1);
assert.equal(deliveryHolding.storage.moneyCopper, 137, "sale revenue must be paid only on successful delivery");
demand = normalizeMarketDemandState(deliveryHolding.special.market.demand);
assert.equal(demand[demandKey].reservedDemand, 0);
assert.equal(demand[demandKey].consumedOutstanding, 5, "successful delivery must convert reservation into consumed recovering demand");
assert.equal(demand[demandKey].recoveryStartedTenday, 1, "delivery must start demand recovery at the end-period boundary, not before the shipment arrived");
const deliveryReplay = advanceMarketOutboundShipments({ holding: deliveryHolding, elapsedQd: 2, dependencies: deliveryDeps });
assert.equal(deliveryReplay.ignored, 1);
assert.equal(deliveryHolding.storage.moneyCopper, 137, "delivery replay must not pay revenue twice");
const lateCancel = cancelMarketOutboundShipment({ holding: deliveryHolding, orderId: "sale-delivery", dependencies: deliveryDeps });
assert.equal(lateCancel.ok, false, "departed or delivered outbound cargo cannot be cancelled back into storage");

const staleHolding = holding();
const staleDeps = dependencies();
createMarketOutboundShipment({ holding: staleHolding, plan: salePlan(staleHolding), operationId: "sale-stale", dependencies: staleDeps });
staleHolding.storage.resources[0].batches[0].qty = 4;
staleHolding.storage.resources[0].qty = 8;
const staleDispatch = dispatchMarketOutboundShipment({ holding: staleHolding, orderId: "sale-stale", dependencies: staleDeps });
assert.equal(staleDispatch.ok, false);
assert.equal(staleDispatch.stale, true);
assert.equal(staleHolding.storage.resources[0].qty, 8, "failed exact-batch dispatch must not partially mutate storage");

const lossHolding = holding();
const lossDeps = dependencies({ riskUnit: () => 0 });
const lossCreated = createMarketOutboundShipment({ holding: lossHolding, plan: salePlan(lossHolding, { risky: true }), operationId: "sale-loss", createdAt: "2026-08-11T04:00:00Z", dependencies: lossDeps });
assert.equal(lossCreated.ok, true);
const lossAdvance = advanceMarketOutboundShipments({ holding: lossHolding, elapsedQd: 1, advancedAt: "2026-08-12T00:00:00Z", dependencies: lossDeps });
assert.equal(lossAdvance.needsResolution.length, 1, "loss or delay must pause only this shipment for GM resolution");
assert.equal(lossHolding.storage.resources[0].qty, 5, "cargo must already be gone after dispatch even while risk awaits GM");
assert.equal(lossHolding.storage.moneyCopper, 87, "unresolved loss must pay neither revenue nor insurance");
const lossResolved = resolveMarketOutboundShipmentRisk({ holding: lossHolding, orderId: "sale-loss", outcome: "proposal", resolvedAt: "2026-08-12T01:00:00Z", dependencies: lossDeps });
assert.equal(lossResolved.ok, true);
assert.equal(lossResolved.outcome, "lost");
assert.equal(lossResolved.payoutCopper, 45, "insurance must cover cargo value plus prepaid freight and tariff at the confirmed coverage rate");
assert.equal(lossHolding.storage.moneyCopper, 132);
assert.equal(lossHolding.storage.resources[0].qty, 5, "lost cargo must not return to storage");
demand = normalizeMarketDemandState(lossHolding.special.market.demand);
assert.equal(demand[demandKey].reservedDemand, 0);
assert.equal(demand[demandKey].consumedOutstanding, 0);
assert.equal(demand[demandKey].availableDemand, 10, "lost outbound cargo must restore demand instead of consuming it");
const lossReplay = resolveMarketOutboundShipmentRisk({ holding: lossHolding, orderId: "sale-loss", outcome: "proposal", dependencies: lossDeps });
assert.equal(lossReplay.replay, true);
assert.equal(lossHolding.storage.moneyCopper, 132, "GM resolution replay must not pay insurance twice");

console.log("FBL Skyhold outbound market: shared demand, buyer shares, cheapest route, FIFO booking, dispatch, delivery, cancellation, loss and insurance passed.");
