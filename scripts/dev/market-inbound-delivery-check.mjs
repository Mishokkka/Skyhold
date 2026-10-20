import assert from "node:assert/strict";
import { planMarketPurchase } from "../engines/market/pricing.js";
import { advanceMarketShipments, cancelMarketShipment, createMarketShipment, resolveMarketShipmentRisk } from "../engines/market/shipment.js";

export function inboundDeliveryFixture() {
  return {
    holding: { id: "inbound-costs", gm: { calendaria: { lastQd: 40 } }, storage: { moneyCopper: 1000000, resources: [], items: [], log: [] }, special: { market: { orders: [] } } },
    quote: {
      marketId: "port-a", quoteKey: "inbound-costs-v1", deliveryMode: "scheduled", deliveryQd: 32,
      location: { deliveryFlatCopper: 8, deliveryLoadCopper: 1, deliverySubtotalRate: 0.02 },
      logistics: { ok: true, transportMode: "airship", distanceKm: 600, capacityLoad: 4000, distanceFlatCopper: 600,
        distanceLoadCopper: 0.3, deliveryFactor: 1, riskFactor: 1, importTaxRate: 0.05, exportTaxRate: 0.02 },
      offers: [{ id: "wood", sourceType: "resource", resourceId: "wood", name: "Древесина", stock: 2000, unitPriceCopper: 4, load: 1 }]
    }
  };
}

export const inboundDeliveryDependencies = {
  addMoney: (holding, value) => { holding.storage.moneyCopper += value; },
  snapshotItemForStorage: (item, qty, roomId) => ({ ...structuredClone(item), qty, roomId }),
  storageAddWithOverflow: (holding, row, qty) => {
    holding.storage.resources.push({ ...structuredClone(row), qty });
    return [{ roomId: row.roomId, qty }];
  },
  appendStorageLog: (holding, rows) => holding.storage.log.push(...rows),
  formatCurrency: (value) => `${value} ММ`,
  internalDemandAvailableFromQd: (holding) => holding.gm.calendaria.lastQd + 40,
  riskUnit: () => 0.99
};

for (const serviceLevel of ["standard", "express", "charter"]) {
  const { holding, quote } = inboundDeliveryFixture();
  const plan = planMarketPurchase({ holding, quote, quantities: { wood: 840 }, serviceLevel, targetRoomId: "warehouse" });
  assert.equal(plan.ok, true);
  assert.equal(plan.totalLoad, 840);
  assert.equal(plan.subtotalCopper, 3360);
  assert.equal(plan.shipmentBatches.reduce((sum, row) => sum + row.totalCopper, 0), plan.totalCopper);
  assert.equal(plan.deliveryCopper, plan.routeCopper + plan.handlingCopper + plan.insuranceCopper + plan.taxCopper + plan.expressSurchargeCopper);
  assert.equal(plan.deliveryBreakdown.deliveryCopper, plan.deliveryCopper);
  assert.equal(plan.importTaxCopper + plan.exportTaxCopper, plan.taxCopper);
  for (const batch of plan.shipmentBatches) {
    assert.equal(batch.routeCopper, Math.max(batch.valueFreightCopper, batch.operationalFreightCopper), "freight floors are alternatives rather than two added charges");
  }
  const before = holding.storage.moneyCopper;
  const created = createMarketShipment({ holding, plan, operationId: `buy-${serviceLevel}`, createdAt: "2026-10-06", dependencies: inboundDeliveryDependencies });
  assert.equal(created.ok, true);
  assert.equal(holding.storage.moneyCopper, before - plan.totalCopper);
  assert.equal(holding.storage.log.filter((row) => row.resourceId === "money").length, 1);
  assert.equal(holding.storage.log[0].operationId, `buy-${serviceLevel}:payment`);
  assert.equal(holding.storage.log[0].qty, -plan.totalCopper);
  assert.equal(created.orders.reduce((sum, order) => sum + order.totalCopper, 0), plan.totalCopper);
  assert.equal(createMarketShipment({ holding, plan, operationId: `buy-${serviceLevel}`, dependencies: inboundDeliveryDependencies }).replay, true);
  assert.equal(holding.storage.moneyCopper, before - plan.totalCopper);
  assert.equal(holding.storage.log.filter((row) => row.resourceId === "money").length, 1, "purchase replay cannot duplicate its payment receipt");
  const arrived = advanceMarketShipments({ holding, elapsedQd: plan.deliveryQd, dependencies: inboundDeliveryDependencies });
  assert.equal(arrived.delivered.length, plan.batchCount);
  assert.equal(holding.storage.resources.reduce((sum, row) => sum + row.qty, 0), 840);
  assert.ok(holding.storage.resources.every((row) => row.roomId === "warehouse" && row.batches[0].internalDemandAvailableFromQd === 80));
  assert.equal(holding.storage.moneyCopper, before - plan.totalCopper, "arrival never charges freight again");
  assert.equal(advanceMarketShipments({ holding, elapsedQd: plan.deliveryQd, dependencies: inboundDeliveryDependencies }).delivered.length, 0);
}

// Partial cancellation returns precisely the cancelled batch's goods and charges.
{
  const { holding, quote } = inboundDeliveryFixture();
  const plan = planMarketPurchase({ holding, quote, quantities: { wood: 840 } });
  const initialMoney = holding.storage.moneyCopper;
  const created = createMarketShipment({ holding, plan, operationId: "partial-cancel", dependencies: inboundDeliveryDependencies });
  const cancelled = cancelMarketShipment({ holding, orderId: created.orders[1].id, dependencies: inboundDeliveryDependencies });
  assert.equal(cancelled.ok, true);
  assert.equal(holding.storage.moneyCopper, initialMoney - created.orders[0].totalCopper);
  assert.equal(holding.storage.log.filter((row) => row.resourceId === "money").reduce((sum, row) => sum + row.qty, 0), holding.storage.moneyCopper - initialMoney);
  assert.equal(cancelMarketShipment({ holding, orderId: created.orders[1].id, dependencies: inboundDeliveryDependencies }).replay, true);
  advanceMarketShipments({ holding, elapsedQd: plan.deliveryQd, dependencies: inboundDeliveryDependencies });
  assert.equal(holding.storage.resources.reduce((sum, row) => sum + row.qty, 0), 800);
  assert.equal(holding.storage.moneyCopper, initialMoney - created.orders[0].totalCopper);
}

// An insured loss returns 84% of goods value, with no tariff refund or duplicate payout.
{
  const { holding, quote } = inboundDeliveryFixture();
  const plan = planMarketPurchase({ holding, quote, quantities: { wood: 100 }, serviceLevel: "charter" });
  const initialMoney = holding.storage.moneyCopper;
  const created = createMarketShipment({ holding, plan, operationId: "insured-loss", dependencies: inboundDeliveryDependencies });
  const dependencies = { ...inboundDeliveryDependencies, riskUnit: (seed) => seed.endsWith("|loss") ? 0 : 0.99 };
  const advance = advanceMarketShipments({ holding, elapsedQd: 1, dependencies });
  assert.equal(advance.needsResolution.length, 1);
  assert.equal(holding.storage.moneyCopper, initialMoney - plan.totalCopper);
  const resolved = resolveMarketShipmentRisk({ holding, orderId: created.order.id, dependencies, resolvedAt: "2026-10-06" });
  assert.equal(resolved.payoutCopper, Math.floor(plan.subtotalCopper * 0.84));
  assert.equal(holding.storage.moneyCopper, initialMoney - plan.totalCopper + resolved.payoutCopper);
  assert.equal(holding.storage.log.filter((row) => row.resourceId === "money").reduce((sum, row) => sum + row.qty, 0), holding.storage.moneyCopper - initialMoney);
  assert.equal(resolveMarketShipmentRisk({ holding, orderId: created.order.id, dependencies }).replay, true);
  assert.equal(holding.storage.moneyCopper, initialMoney - plan.totalCopper + resolved.payoutCopper);
  assert.equal(advanceMarketShipments({ holding, elapsedQd: plan.deliveryQd, dependencies }).delivered.length, 0);
  assert.equal(holding.storage.resources.length, 0);
}

{
  const { holding, quote } = inboundDeliveryFixture();
  const instant = planMarketPurchase({ holding, quote: { ...quote, deliveryMode: "instant" }, quantities: { wood: 100 } });
  assert.equal(instant.insuranceCopper, 0, "instant delivery never sells an unusable policy");
  assert.equal(planMarketPurchase({ holding, quote, quantities: {} }).totalCopper, 0);
  const restricted = planMarketPurchase({ holding, quote, quantities: { wood: 100 } });
  assert.equal(planMarketPurchase({ holding: { storage: { moneyCopper: restricted.totalCopper - 1 } }, quote, quantities: { wood: 100 } }).ok, false);
}

console.log("Inbound delivery costs: service/batch reconciliation, one-time purchase, exact refunds, insurance coverage, loss/arrival replay and delayed internal demand passed.");
