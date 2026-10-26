import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { normalizeMarketOutboundState } from "../data/market/outbound-state.js";
import { normalizeMarketTransportPlan, marketTransportPlanSnapshot, marketTransportPlanForOrder, allocateMarketTransportCharges } from "../data/market/transport-plan.js";
import { createMarketShipment } from "../engines/market/shipment.js";
import { createMarketOutboundOrder, planMarketOutboundSale, marketOutboundPlanToken } from "../engines/market/outbound.js";
import { planMarketPurchase } from "../engines/market/pricing.js";

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

const deps = {
  addMoney: (holding, amount) => { holding.storage.moneyCopper += amount; },
  snapshotItemForStorage: (item) => structuredClone(item),
  appendStorageLog: (holding, rows) => holding.storage.log.push(...rows)
};
function inboundPlan(transportPlan, qty = 2) {
  const holding = mergeHoldingDefaults({ id: "snapshot-test", storage: { moneyCopper: 10_000 } });
  const plan = planMarketPurchase({ holding, quantities: { goods: qty }, quote: {
    marketId: "market", marketLabel: "Рынок", deliveryMode: "scheduled", deliveryQd: 12,
    location: {}, offers: [{ id: "goods", sourceType: "resource", resourceId: "wood", name: "Древесина", stock: qty, unitPriceCopper: 20, load: 1 }],
    logistics: { ok: true, transportMode: "multimodal", routePath: ["home", "transfer", "market"],
      distanceKm: 120.5, distanceFlatCopper: 40, distanceLoadCopper: 0.075, travelQd: 3.25, capacityLoad: 400.5,
      ...(transportPlan ? { transportPlan } : {}) }
  } });
  assert.equal(plan.ok, true);
  return { holding, plan };
}
function outboundPlan(transportPlan) {
  return { ok: true, marketId: "market", deliveryQd: 12, revenueCopper: 100, upfrontCopper: 5, freightCopper: 5,
    tariffCopper: 0, insuranceCopper: 0, insuredValueCopper: 100, maximumInsurancePayoutCopper: 0,
    lines: [{ resourceId: "wood", name: "Древесина", qty: 2 }], cargoReservations: [{ rowId: "wood", resourceId: "wood", qty: 2 }],
    buyerAllocations: [], route: { id: "route", carrierId: "chain", routePath: ["home", "transfer", "market"],
      routeModes: ["airship", "caravan"], transportMode: "multimodal", ...(transportPlan ? { transportPlan } : {}) } };
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

  const { holding, plan } = inboundPlan(original);
  const moneyBefore = holding.storage.moneyCopper;
  const created = createMarketShipment({ holding, plan, operationId: "book-inbound", dependencies: deps });
  assert.equal(created.ok, true); assert.equal(holding.storage.moneyCopper, moneyBefore - plan.totalCopper);
  const accepted = created.order.transportPlan, { billing: _billing, ...tariff } = accepted;
  assert.deepEqual({ ...tariff, legs: tariff.legs.map(({ chargedCopper: _charge, ...leg }) => leg) }, original,
    "booking preserves every frozen tariff field while adding actual paid attribution");
  assert.deepEqual(accepted.legs.map((leg) => leg.chargedCopper), plan.shipmentBatches[0].transportLegCosts);
  assert.equal(accepted.legs.reduce((sum, leg) => sum + leg.chargedCopper, 0), plan.routeCopper);
  assert.deepEqual(accepted.billing, { batchCount: 1, freightCopper: plan.routeCopper, insuranceCopper: plan.insuranceCopper,
    taxCopper: plan.taxCopper, handlingCopper: plan.handlingCopper, expressSurchargeCopper: plan.expressSurchargeCopper,
    deliveryCopper: plan.deliveryCopper, serviceLevel: plan.serviceLevel });
  original.legs[0].carrierLabel = "Каталог изменён"; original.legs[0].distanceCopper = 999;
  assert.notEqual(created.order.transportPlan.legs[0].carrierLabel, original.legs[0].carrierLabel);
  assert.notEqual(created.order.transportPlan.legs[0].distanceCopper, original.legs[0].distanceCopper);
  const loaded = mergeHoldingDefaults(JSON.parse(JSON.stringify(holding)));
  assert.deepEqual(loaded.special.market.orders[0].transportPlan, created.order.transportPlan);
  assert.equal(loaded.special.market.orders[0].totalCopper, created.order.totalCopper);
  const replay = createMarketShipment({ holding, plan, operationId: "book-inbound", dependencies: deps });
  assert.equal(replay.replay, true); assert.equal(holding.storage.moneyCopper, moneyBefore - plan.totalCopper);

  const outward = snapshot("outbound"), outPlan = outboundPlan(outward);
  const order = createMarketOutboundOrder({ plan: outPlan, operationId: "book-outbound" });
  assert.deepEqual(order.transportPlan, outward);
  outward.legs[0].carrierLabel = "Другая компания";
  assert.notEqual(order.transportPlan.legs[0].carrierLabel, outward.legs[0].carrierLabel);
  assert.deepEqual(normalizeMarketOutboundState(JSON.parse(JSON.stringify({ orders: [order] }))).orders[0].transportPlan, order.transportPlan);

  const legacyInbound = inboundPlan();
  const legacyCreated = createMarketShipment({ ...legacyInbound, operationId: "legacy", dependencies: deps });
  assert.equal(Object.hasOwn(legacyCreated.order, "transportPlan"), false);
  assert.equal(Object.hasOwn(mergeHoldingDefaults(JSON.parse(JSON.stringify(legacyInbound.holding))).special.market.orders[0], "transportPlan"), false);
  const legacyOutward = createMarketOutboundOrder({ plan: outboundPlan(), operationId: "legacy-outbound" });
  assert.equal(Object.hasOwn(legacyOutward, "transportPlan"), false);
  assert.equal(Object.hasOwn(normalizeMarketOutboundState({ orders: [legacyOutward] }).orders[0], "transportPlan"), false);

  for (const retained of [future, { version: 1, key: "broken", direction: "inbound", legs: [{ originalMetadata: true }] }]) {
    const loadedInbound = mergeHoldingDefaults({ special: { market: { orders: [{ ...legacyCreated.order, transportPlan: retained }] } } });
    assert.deepEqual(loadedInbound.special.market.orders[0].transportPlan, retained, "normal loading preserves newer/invalid metadata for recovery");
    assert.equal(loadedInbound.special.market.orders[0].totalCopper, legacyCreated.order.totalCopper);
    assert.deepEqual(normalizeMarketOutboundState({ orders: [{ ...legacyOutward, transportPlan: retained }] }).orders[0].transportPlan, retained);
  }
  const invalid = snapshot(); invalid.legs[0].carrierId = "";
  const rejected = inboundPlan(invalid), beforeRejected = JSON.stringify(rejected.holding);
  assert.throws(() => createMarketShipment({ ...rejected, operationId: "rejected", dependencies: deps }), /план перевозки/);
  assert.equal(JSON.stringify(rejected.holding), beforeRejected, "an invalid new agreement cannot debit money or append orders/logs");
  assert.throws(() => createMarketOutboundOrder({ plan: outboundPlan(invalid), operationId: "rejected-outward" }), /план перевозки/);

  const bulk = inboundPlan(snapshot(), 201);
  assert.ok(bulk.plan.batchCount > 1);
  const bulkCreated = createMarketShipment({ ...bulk, operationId: "bulk-inbound", dependencies: deps });
  assert.equal(bulkCreated.orders.length, bulk.plan.batchCount);
  bulkCreated.orders.forEach((batch, index) => {
    assert.equal(batch.transportPlan.billing.batchCount, 1);
    assert.deepEqual(batch.transportPlan.legs.map((leg) => leg.chargedCopper), bulk.plan.shipmentBatches[index].transportLegCosts);
    assert.equal(batch.transportPlan.billing.freightCopper, batch.routeCopper);
    assert.equal(batch.transportPlan.billing.deliveryCopper, batch.deliveryCopper);
    assert.equal(batch.transportPlan.billing.insuranceCopper, batch.insuranceCopper);
  });
  assert.equal(bulkCreated.orders.reduce((sum, batch) => sum + batch.transportPlan.billing.deliveryCopper, 0), bulk.plan.deliveryCopper);
  for (const leg of bulk.plan.logistics.transportPlan.legs) assert.equal(leg.chargedCopper,
    bulkCreated.orders.reduce((sum, batch) => sum + batch.transportPlan.legs.find((row) => row.id === leg.id).chargedCopper, 0));

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
    const orders = plan.shipmentBatches.map((part, index) => createMarketOutboundOrder({ plan: part, operationId: `out:${insuranceEnabled}:${index}` }));
    orders.forEach((order, index) => {
      assert.deepEqual(order.transportPlan, plan.shipmentBatches[index].route.transportPlan, "the per-order preview is exactly the saved paid snapshot");
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
  console.log("Transport-plan state: immutable inbound/outbound promises, fractional terms, JSON round trip, legacy/unknown preservation, replay and rejected-write atomicity passed.");
}
