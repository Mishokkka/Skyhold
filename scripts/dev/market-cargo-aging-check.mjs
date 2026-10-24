import assert from "node:assert/strict";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { advanceMarketShipments, proposeMarketShipmentRisk, resolveMarketShipmentRisk } from "../engines/market/shipment.js";
import { ageMarketCargo, marketInsurancePayoutCopper, viableCargoValueCopper } from "../engines/market/cargo-aging.js";
import { planMarketOutboundSale } from "../engines/market/outbound.js";
import { createMarketOutboundShipment, advanceMarketOutboundShipments } from "../workflows/market/outbound-shipment.js";
import { marketDemandKey } from "../data/market/demand-state.js";
import { normalizeMarketOutboundState } from "../data/market/outbound-state.js";
import { pathToFileURL } from "node:url";
export function checkMarketCargoAging() {

const deps = {
  addMoney: (h, amount) => { h.storage.moneyCopper += amount; },
  appendStorageLog: (h, rows) => { h.storage.log.push(...rows); },
  formatCurrency: String, internalDemandAvailableFromQd: () => 40,
  storageAddWithOverflow: (h, row, qty) => { h.storage.resources.push({ ...row, qty }); return [{ roomId: row.roomId, qty }]; }
};
function inbound(ageQd = 3, shelfLifeQd = 20) {
  return { storage: { moneyCopper: 0, resources: [], items: [], log: [] },
    special: { market: { orders: [{ id: "import", operationId: "import", status: "in-transit", dispatchStatus: "departed",
      riskStatus: "waived", deliveryQd: 8, remainingQd: 8, cargo: [
        { resourceId: "custom", name: "Свежая еда", sourceType: "resource", qty: 5, ageQd, shelfLifeQd, unitPriceCopper: 10 }
      ] }] } } };
}
{
  const one = inbound(), split = inbound();
  advanceMarketShipments({ holding: one, elapsedQd: 12, dependencies: deps });
  for (let i = 0; i < 8; i++) advanceMarketShipments({ holding: split, elapsedQd: 1, dependencies: deps });
  assert.equal(one.storage.resources[0].batches[0].ageQd, 15, "arrival preserves travel age and time since arrival in a large period");
  assert.equal(split.storage.resources[0].batches[0].ageQd, 11);
  const reloaded = mergeHoldingDefaults(JSON.parse(JSON.stringify(split)));
  assert.equal(reloaded.special.market.orders[0].cargo[0].ageQd, 11);
  assert.equal(reloaded.special.market.orders[0].cargo[0].shelfLifeQd, 20);
  const count = one.storage.resources.length;
  advanceMarketShipments({ holding: one, elapsedQd: 12, dependencies: deps });
  assert.equal(one.storage.resources.length, count, "delivery cannot duplicate cargo");
}
{
  const h = inbound(3, 10);
  advanceMarketShipments({ holding: h, elapsedQd: 8, dependencies: deps });
  assert.equal(h.storage.resources.length, 0, "cargo expiring en route never becomes fresh inventory");
  assert.equal(h.storage.log[0].kind, "market-spoilage");
  assert.equal(h.storage.moneyCopper, 0, "natural spoilage has no insurance payout");
}
{
  const h = inbound(3, 10), order = h.special.market.orders[0];
  Object.assign(order, { status: "needsResolution", riskStatus: "needsResolution", riskProposal: { outcome: "lost" },
    insuredValueCopper: 50, maximumInsurancePayoutCopper: 50, insuranceCoverageRate: 1 });
  advanceMarketShipments({ holding: h, elapsedQd: 12, dependencies: deps });
  assert.equal(order.cargo[0].ageQd, 15, "waiting for GM does not freeze physical cargo while world time advances");
  const result = resolveMarketShipmentRisk({ holding: h, order, outcome: "lost", dependencies: deps });
  assert.equal(result.payoutCopper, 0, "a later accident cannot insure cargo already spoiled");
}
{
  const h = { storage: { moneyCopper: 100, resources: [{ id: "food", resourceId: "food-fruit", name: "Фрукты", qty: 10,
    batches: [{ id: "old", qty: 6, ageQd: 30 }, { id: "new", qty: 4, ageQd: 0 }] }], log: [] },
    special: { market: { demand: {}, outbound: { orders: [] } } } };
  const plan = planMarketOutboundSale({ resources: h.storage.resources, outboundState: h.special.market.outbound,
    marketId: "port", lines: [{ id: "sale", resourceId: "food-fruit", demandId: "fruit-demand", name: "Фрукты",
      qty: 10, unitPriceCopper: 10, demandBaseDemand: 20, demandStateRevision: 0 }],
    routes: [{ id: "route", ok: true, deliveryQd: 10, freightCopper: 0, tariffCopper: 0 }] });
  assert.equal(plan.ok, true);
  const created = createMarketOutboundShipment({ holding: h, plan, operationId: "food-sale", dependencies: deps });
  assert.equal(created.ok, true);
  // Test an explicit cargo contract with two different ages and one shared expiry.
  for (const row of created.order.cargoReservations) row.shelfLifeQd = 35;
  let result = advanceMarketOutboundShipments({ holding: h, elapsedQd: 5, dependencies: deps });
  assert.equal(result.ok, true);
  h.special.market.outbound = normalizeMarketOutboundState(JSON.parse(JSON.stringify(h.special.market.outbound)));
  result = advanceMarketOutboundShipments({ holding: h, elapsedQd: 5, dependencies: deps });
  assert.equal(result.delivered[0].revenueCopper, 40, "only four fresh units are paid");
  const demand = h.special.market.demand[marketDemandKey("port", "fruit-demand")];
  assert.equal(demand.reservedDemand, 0);
  assert.equal(demand.consumedOutstanding, 4, "six spoiled units release customer demand");
  assert.equal(demand.availableDemand, 16);
  assert.equal(h.special.market.outbound.orders[0].spoiledQty, 6);
  const cash = h.storage.moneyCopper;
  advanceMarketOutboundShipments({ holding: h, elapsedQd: 10, dependencies: deps });
  assert.equal(h.storage.moneyCopper, cash);
}
{
  const h = { storage: { moneyCopper: 0, resources: [{ id: "food", resourceId: "food-fruit", qty: 100,
    batches: [{ id: "old", qty: 71, ageQd: 30 }, { id: "new", qty: 29, ageQd: 0 }] }], log: [] },
    special: { market: { demand: {}, outbound: { orders: [] } } } };
  const plan = planMarketOutboundSale({ resources: h.storage.resources,
    marketId: "port", lines: [{ id: "sale", resourceId: "food-fruit", qty: 100, unitPriceCopper: 1, demandBaseDemand: 100 }],
    routes: [{ id: "route", deliveryQd: 10, freightCopper: 0, tariffCopper: 0 }] });
  const created = createMarketOutboundShipment({ holding: h, plan, operationId: "exact-sale", dependencies: deps });
  assert.equal(created.ok, true);
  for (const row of created.order.cargoReservations) row.shelfLifeQd = 35;
  const result = advanceMarketOutboundShipments({ holding: h, elapsedQd: 10, dependencies: deps });
  assert.equal(result.delivered[0].revenueCopper, 29, "29 fresh units at one copper pay exactly 29, without float-ratio loss");
  assert.equal(h.storage.moneyCopper, 29);

  const order = { insuredValueCopper: 100, insuranceCoverageRate: 1, maximumInsurancePayoutCopper: 100,
    cargo: [{ resourceId: "custom", qty: 71, unitPriceCopper: 1, ageQd: 35, shelfLifeQd: 35 },
      { resourceId: "custom", qty: 29, unitPriceCopper: 1, ageQd: 10, shelfLifeQd: 35 }] };
  assert.equal(marketInsurancePayoutCopper(order), 29, "full coverage preserves the exact viable cargo value");
  assert.equal(viableCargoValueCopper(order, 7), 2, "genuinely fractional copper still rounds down");
  assert.equal(viableCargoValueCopper({}, 7), 7, "legacy orders without cargo retain their accepted value");
  assert.equal(viableCargoValueCopper({ cargo: [{ qty: 0, cargoValueCopper: 12 }] }, 7), 7,
    "an empty legacy cargo row cannot turn its fallback unit price into a BigInt conversion error");
  assert.equal(viableCargoValueCopper(order, Infinity), 0, "non-finite amounts use the same safe fallback as normalized orders");
  Object.assign(order, { id: "exact-loss", status: "in-transit", riskStatus: "pending", riskLossChance: 0.08 });
  const risk = proposeMarketShipmentRisk({ order, dependencies: { riskUnit: () => 0 } });
  assert.equal(risk.proposal.insuredValueCopper, 29);
  assert.equal(risk.proposal.proposedInsurancePayoutCopper, 29);
}
{
  const shipOrder = { cargo: [{ sourceType: "resource", resourceId: "custom", qty: 1, ageQd: 2, shelfLifeQd: 6 }] };
  ageMarketCargo(shipOrder, 4);
  assert.equal(shipOrder.cargo[0].spoiledQty, 1);
}
console.log("Market cargo aging: arrival age, spoilage, mixed sale, demand release, reload, pause and insurance passed.");

}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) checkMarketCargoAging();
