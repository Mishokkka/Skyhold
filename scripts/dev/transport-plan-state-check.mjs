import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { normalizeMarketOutboundState } from "../data/market/outbound-state.js";
import { normalizeMarketTransportPlan, marketTransportPlanSnapshot, marketTransportPlanForOrder, allocateMarketTransportCharges } from "../data/market/transport-plan.js";
import { planMarketOutboundSale, marketOutboundPlanToken } from "../engines/market/outbound.js";

function snapshot(direction = "inbound") {
  const leg = (id, from, to, mode, extra = {}) => ({ id, routeId: id, fromRegionId: from, toRegionId: to,
    fromCountryId: `country:${from}`, toCountryId: `country:${to}`, fromLabel: `Локация ${from}`, toLabel: `Локация ${to}`,
    mode, modeLabel: mode, carrierId: `carrier:${id}`, carrierLabel: `Компания ${id}`, visibility: "public", kind: "route",
    distanceKm: 60.25, travelQd: 1.375, capacityLoad: 400.5, dispatchCopper: 6, distanceCopper: 5.125,
    loadCopperPerUnit: 0.0375, operatingCopper: 20.75, hireCopper: 12.125, riskFactor: 1.15,
    priceFactor: 0.75, timeFactor: 1.25, capacityFactor: 1.5, sharePct: 45.5, ...extra });
  let legs = [leg("road", "market", "transfer", "caravan"),
    leg("air", "transfer", "home", "airship", { visibility: "gm" }),
    leg("last", "home", "home", "airship", { routeId: "", kind: "last-mile", distanceKm: 0, travelQd: 0.5 })];
  if (direction === "outbound") legs = legs.reverse().map((row) => ({ ...row,
    fromRegionId: row.toRegionId, toRegionId: row.fromRegionId, fromCountryId: row.toCountryId, toCountryId: row.fromCountryId,
    fromLabel: row.toLabel, toLabel: row.fromLabel }));
  return { version: 1, key: `accepted:${direction}`, direction, legs,
    distanceKm: 120.5, travelQd: 3.25, capacityLoad: 400.5, dispatchCopper: 38,
    distanceCopper: 10.25, loadCopperPerUnit: 0.075, operatingCopper: 62.25, hireCopper: 24.25, riskFactor: 1.125 };
}

export function checkTransportPlanState() {
  assert.deepEqual(allocateMarketTransportCharges(0, [1, 2, 3]), [0, 0, 0]);
  assert.deepEqual(allocateMarketTransportCharges(5, [0, 0, 0]), [2, 2, 1]);
  assert.deepEqual(allocateMarketTransportCharges(10, [1, 1, 1]), [4, 3, 3]);
  assert.deepEqual(allocateMarketTransportCharges(0, []), []);
  assert.throws(() => allocateMarketTransportCharges(1, []), /стоимость перевозки/);
  assert.throws(() => allocateMarketTransportCharges(2.5, [1, 1]), /распределение/);
  const original = snapshot(), normalized = normalizeMarketTransportPlan(JSON.parse(JSON.stringify(original)));
  assert.deepEqual(normalized, original, "fractional accepted terms, labels, visibility and same-endpoint last mile survive normalization");
  assert.notEqual(normalized, original); assert.notEqual(normalized.legs[0], original.legs[0]);
  assert.equal(normalizeMarketTransportPlan(undefined), undefined);
  const future = { version: 2, key: "future", legs: [{ future: true }], futureTotal: 123.75 };
  assert.deepEqual(normalizeMarketTransportPlan(future), future, "unknown versions retain their promises without reinterpretation");
  assert.notEqual(normalizeMarketTransportPlan(future), future);
  assert.throws(() => marketTransportPlanSnapshot(future), /план перевозки/);
  for (const mutate of [
    (value) => { value.legs[1].carrierId = ""; },
    (value) => { value.legs[1].id = value.legs[0].id; },
    (value) => { value.legs[1].fromRegionId = "disconnected"; },
    (value) => { value.legs[1].mode = "unsupported"; },
    (value) => { value.legs[1].travelQd = Infinity; },
    (value) => { value.operatingCopper = -1; }
  ]) {
    const invalid = snapshot(); mutate(invalid);
    assert.throws(() => marketTransportPlanSnapshot(invalid), /план перевозки/);
  }
  const readCorrupt = snapshot(); readCorrupt.legs[0].dispatchCopper = -10; readCorrupt.legs[1].riskFactor = Infinity;
  const bounded = normalizeMarketTransportPlan(readCorrupt);
  assert.equal(bounded.legs[0].dispatchCopper, 0); assert.equal(bounded.legs[1].riskFactor, 1);

  const accepted = marketTransportPlanForOrder(original, { transportLegCosts: [10, 15, 5], freightCopper: 30,
    insuranceCopper: 4, taxCopper: 3, handlingCopper: 2, expressSurchargeCopper: 1, deliveryCopper: 40, serviceLevel: "express" });
  const { billing: _billing, ...tariff } = accepted;
  assert.deepEqual({ ...tariff, legs: tariff.legs.map(({ chargedCopper: _charge, ...leg }) => leg) }, original);
  assert.deepEqual(accepted.legs.map(leg => leg.chargedCopper), [10, 15, 5]);
  assert.deepEqual(accepted.billing, { batchCount: 1, freightCopper: 30, insuranceCopper: 4, taxCopper: 3,
    handlingCopper: 2, expressSurchargeCopper: 1, deliveryCopper: 40, serviceLevel: "express" });
  original.legs[0].carrierLabel = "Changed catalog";
  assert.notEqual(accepted.legs[0].carrierLabel, original.legs[0].carrierLabel);
  const saved = { id: "accepted-history", status: "delivered", totalCopper: 90, transportPlan: accepted };
  const loaded = mergeHoldingDefaults({ special: { market: { orders: [saved] } } });
  assert.deepEqual(loaded.special.market.orders[0].transportPlan, accepted);
  assert.equal(loaded.special.market.orders[0].totalCopper, 90);
  const outward = marketTransportPlanSnapshot(snapshot("outbound"));
  assert.deepEqual(normalizeMarketOutboundState({ orders: [{ id: "old-sale", status: "delivered", transportPlan: outward }] }).orders[0].transportPlan, outward);
  assert.equal(Object.hasOwn(mergeHoldingDefaults({ special: { market: { orders: [{ id: "legacy", status: "delivered" }] } } }).special.market.orders[0], "transportPlan"), false);
  assert.equal(Object.hasOwn(normalizeMarketOutboundState({ orders: [{ id: "legacy", status: "delivered" }] }).orders[0], "transportPlan"), false);
  for (const retained of [future, { version: 1, key: "broken", direction: "inbound", legs: [{ originalMetadata: true }] }]) {
    const imported = mergeHoldingDefaults({ special: { market: { orders: [{ ...saved, transportPlan: retained }] } } });
    assert.deepEqual(imported.special.market.orders[0].transportPlan, retained);
    assert.equal(imported.special.market.orders[0].totalCopper, 90);
    assert.deepEqual(normalizeMarketOutboundState({ orders: [{ id: "old-sale", transportPlan: retained }] }).orders[0].transportPlan, retained);
  }
  checkOutboundBilling();
}

function checkOutboundBilling() {
  const line = { id: "wood", demandId: "wood", resourceId: "wood", name: "Древесина", qty: 2, unitPriceCopper: 20 };
  const batch = (index, routeCopper, handlingCopper, expressSurchargeCopper, taxCopper, transportLegCosts) => ({
    lines: [{ ...line, qty: 1 }], deliveryQd: 9 + index * 2, routeCopper, handlingCopper, expressSurchargeCopper, taxCopper,
    importTaxCopper: taxCopper, exportTaxCopper: 0, transportLegCosts, riskProfile: { insuranceCoverageRate: 0.84 }
  });
  const transportPlan = marketTransportPlanForOrder(snapshot("outbound"), { transportLegCosts: [7, 6, 5],
    batchCount: 2, freightCopper: 18, insuranceCopper: 14, taxCopper: 5, handlingCopper: 8,
    expressSurchargeCopper: 3, deliveryCopper: 48, serviceLevel: "express" });
  const route = { id: "multibatch", label: "Составной путь", ok: true, transportPlan,
    freightCopper: 30, tariffCopper: 5, insuranceCopper: 14, insuranceCoverageRate: 0.84,
    deliveryQd: 11, standardDeliveryQd: 12, serviceLevel: "express", shipmentBatches: [
      batch(0, 11, 5, 2, 3, [4, 4, 3]), batch(1, 7, 3, 1, 2, [3, 2, 2])
    ] };
  const before = structuredClone(route);
  for (const insuranceEnabled of [true, false]) {
    const plan = planMarketOutboundSale({ resources: [{ id: "row", resourceId: "wood", qty: 2,
      batches: [{ id: "fifo", qty: 2, ageQd: 0 }] }], lines: [line], routes: [route], treasuryCopper: 10_000, insuranceEnabled });
    assert.equal(plan.ok, true, plan.reasons.join(" "));
    assert.equal(plan.shipmentBatches.length, 2);
    assert.equal(plan.route.transportPlan.billing.insuranceCopper, plan.insuranceCopper);
    assert.equal(plan.route.transportPlan.billing.deliveryCopper, plan.upfrontCopper);
    const orders = normalizeMarketOutboundState({ orders: plan.shipmentBatches.map((part, index) => ({
      id: `historical:${insuranceEnabled}:${index}`, status: "delivered", transportPlan: part.route.transportPlan,
      freightCopper: part.freightCopper, tariffCopper: part.tariffCopper, insuranceCopper: part.insuranceCopper,
      upfrontCopper: part.upfrontCopper
    })) }).orders;
    orders.forEach((order, index) => {
      assert.deepEqual(order.transportPlan, plan.shipmentBatches[index].route.transportPlan, "historical read preserves the saved paid snapshot");
      const bill = order.transportPlan.billing;
      assert.equal(order.transportPlan.legs.reduce((sum, leg) => sum + leg.chargedCopper, 0), bill.freightCopper);
      assert.equal(bill.freightCopper + bill.handlingCopper + bill.expressSurchargeCopper, order.freightCopper);
      assert.equal(bill.taxCopper, order.tariffCopper); assert.equal(bill.insuranceCopper, order.insuranceCopper);
      assert.equal(bill.deliveryCopper, order.upfrontCopper); assert.equal(bill.batchCount, 1);
    });
    assert.equal(orders.reduce((sum, order) => sum + order.transportPlan.billing.deliveryCopper, 0), plan.upfrontCopper);
    for (const leg of plan.route.transportPlan.legs) assert.equal(leg.chargedCopper,
      orders.reduce((sum, order) => sum + order.transportPlan.legs.find((row) => row.id === leg.id).chargedCopper, 0));
    const modified = structuredClone(plan); modified.route.transportPlan.legs[0].carrierId = "other";
    assert.notEqual(marketOutboundPlanToken(plan), marketOutboundPlanToken(modified), "equal money/path still binds the exact carrier snapshot");
  }
  assert.deepEqual(route, before, "outbound repricing cannot mutate an incoming quote or its accepted terms");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkTransportPlanState();
  console.log("Transport-plan state: immutable historical inbound/outbound terms, billing attribution, fractional values, JSON round trip and unknown-version preservation passed.");
}
