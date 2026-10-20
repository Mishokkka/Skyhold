import assert from "node:assert/strict";
import { normalizeMarketOutboundState } from "../data/market/outbound-state.js";
import { marketOutboundRouteFromPurchasePlan, prepareMarketOutboundContext } from "../apps/market/outbound-context.js";

const holding = {
  storage: {
    moneyCopper: 100,
    resources: [
      { id: "wood-row", resourceId: "wood", name: "Древесина", forSale: true, qty: 8, batches: [{ id: "wood-old", qty: 5, ageQd: 20 }, { id: "wood-new", qty: 3, ageQd: 0 }] },
      { id: "stone-row", resourceId: "stone", name: "Камень", forSale: false, qty: 50, batches: [{ id: "stone-batch", qty: 50, ageQd: 0 }] }
    ]
  },
  special: {
    market: {
      demand: {},
      outbound: {
        version: 1,
        orders: [{
          id: "existing",
          operationId: "existing",
          status: "booked",
          dispatchStatus: "booked",
          cargoReservations: [{ rowId: "wood-row", resourceId: "wood", batchId: "wood-old", qty: 2, ageQd: 20 }]
        }]
      }
    }
  }
};

const quote = {
  marketId: "north-market",
  marketLabel: "Северный рынок",
  countryId: "north",
  offers: [
    { id: "wood-a", sourceType: "resource", resourceId: "wood", name: "Древесина", stock: 4, unitPriceCopper: 10, load: 1, tags: ["construction"] },
    { id: "wood-b", sourceType: "resource", resourceId: "wood", name: "Древесина", stock: 6, unitPriceCopper: 8, load: 1, tags: ["wood"] },
    { id: "stone", sourceType: "resource", resourceId: "stone", name: "Камень", stock: 30, unitPriceCopper: 12, load: 1 }
  ],
  outboundOffers: [
    { id: "wood-buy", sourceType: "resource", resourceId: "wood", name: "Wood", demand: 10, unitPriceCopper: 9, load: 1, tags: ["construction", "wood"] },
    { id: "stone-buy", sourceType: "resource", resourceId: "stone", name: "Stone", demand: 2, unitPriceCopper: 11, load: 1 }
  ]
};

const resources = [
  { id: "wood", label: "Древесина", basePriceCopper: 9, loadPoints: 4, categoryTag: "construction.simple", marketTags: ["wood"] },
  { id: "stone", label: "Камень", basePriceCopper: 12, loadPoints: 4, categoryTag: "construction.simple", marketTags: ["stone"] }
];

const organizations = [{ id: "buyer", label: "Северная артель", active: true, buyer: { enabled: true, countryShares: [{ countryId: "north", sharePct: 60 }] } }];
const purchasePlan = {
  marketId: "north-market",
  carrierId: "carrier",
  carrierLabel: "Воздушная линия",
  empty: false,
  inaccessible: false,
  capacityExceeded: false,
  deliveryQd: 5,
  routeCopper: 4,
  handlingCopper: 2,
  taxCopper: 1,
  insuranceRate: 0.1,
  insuranceCoverageRate: 0.84,
  riskFactor: 1.2,
  riskLossChance: 0.02,
  riskDelayChance: 0.1,
  riskMaxDelayQd: 2,
  logistics: { routePath: ["laputa", "north"], routeModes: ["airship"], transportMode: "airship" }
};
const route = marketOutboundRouteFromPurchasePlan(purchasePlan, { id: "carrier", label: "Воздушная линия" });
assert.equal(route.freightCopper, 6);
assert.equal(route.tariffCopper, 1);
assert.equal(route.deliveryQd, 5);

const context = prepareMarketOutboundContext({
  holding,
  quote,
  resourceDefinitions: resources,
  organizations,
  routes: [route],
  quantities: { wood: 6 },
  insuranceEnabled: true
});
assert.equal(context.offers.length, 1, "only real forSale resource rows with market demand may be offered outbound");
assert.equal(context.offers[0].resourceId, "wood");
assert.equal(context.offers[0].availableStock, 6, "existing exact-batch soft reservations must reduce runtime availability");
assert.equal(context.offers[0].availableDemand, 10, "all same-resource market offers share one finite demand pool");
assert.equal(context.offers[0].unitPriceCopper, 9, "runtime outbound uses the independent buy-side unit quote");
assert.equal(context.plan.ok, true);
assert.equal(context.plan.cargoReservations.reduce((sum, row) => sum + row.qty, 0), 6);
assert.deepEqual(context.plan.cargoReservations.map((row) => [row.batchId, row.qty]), [["wood-old", 3], ["wood-new", 3]], "runtime booking must reserve the oldest unreserved FIFO quantities exactly");
assert.equal(context.plan.buyerAllocations.reduce((sum, row) => sum + row.qty, 0), 6);
assert.equal(context.plan.route.id, "carrier");

const normalized = normalizeMarketOutboundState(holding.special.market.outbound);
assert.equal(normalized.orders[0].cargoReservations[0].batchId, "wood-old");

console.log("FBL Skyhold outbound runtime: forSale gating, shared demand quote, exact FIFO soft reservations, buyer allocation and route adapter passed.");
