import assert from "node:assert/strict";
import {
  MAX_ACTIVE_OUTBOUND_ORDERS,
  MAX_TERMINAL_OUTBOUND_ORDERS,
  normalizeMarketOutboundState
} from "../data/market/outbound-state.js";
import {
  allocateMarketOutboundBuyers,
  applyMarketOutboundDispatch,
  marketOutboundAvailableQuantity,
  planMarketOutboundSale
} from "../engines/market/outbound.js";

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
const olderStock = [
  { id: "shared", resourceId: "wood", roomId: "private", qty: 3, batches: [{ id: "lot", qty: 3, ageQd: 7 }] },
  { id: "shared", resourceId: "stone", roomId: "outdoors", qty: 2, batches: [{ id: "lot", qty: 2, ageQd: 0 }] }
];
const legacyCargo = [{ rowId: "shared", batchId: "lot", resourceId: "wood", qty: 1 }];
const sent = applyMarketOutboundDispatch({ resources: olderStock, cargoReservations: legacyCargo });
assert.equal(sent.ok, true, "an accepted shipment can still resolve its unique material and batch despite a duplicate row ID");
assert.deepEqual(olderStock.map(row => row.qty), [2, 2], "dispatch must debit the saved material, not the last row with that ID");
assert.equal(sent.cargo[0].roomId, "private", "dispatch reports the real source for the role-filtered stock journal");
olderStock.push(structuredClone(olderStock[0]));
const duplicateLots = structuredClone(olderStock);
assert.equal(applyMarketOutboundDispatch({ resources: olderStock, cargoReservations: legacyCargo }).ok, false,
  "a saved shipment must stop when even its material and batch cannot distinguish the source");
assert.deepEqual(olderStock, duplicateLots);
const normalizedLegacy = [
  { id: "older-stock", resourceId: "custom", qty: 2, batches: [{ id: "older-lot", qty: 2 }] },
  { id: "older-stock", resourceId: "wood", qty: 2, batches: [{ id: "unrelated-lot", qty: 2 }] }
];
assert.equal(applyMarketOutboundDispatch({ resources: normalizedLegacy,
  cargoReservations: [{ rowId: "older-stock", batchId: "older-lot", resourceId: "retired-catalog-item", qty: 1 }] }).ok, true,
  "a unique saved lot still identifies a shipment after the catalog changes");
assert.deepEqual(normalizedLegacy.map(row => row.qty), [1, 2]);
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

console.log("Market outbound goods: buyer allocation, retained historical reservations, FIFO selection, prices and read-only preview passed.");
