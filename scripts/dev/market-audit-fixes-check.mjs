import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { normalizeMarketOutboundState, MAX_ACTIVE_OUTBOUND_ORDERS } from "../data/market/outbound-state.js";
import { marketDemandKey } from "../data/market/demand-state.js";
import { marketPlanCargoExpiryWarnings, marketInsurancePayoutCopper } from "../engines/market/cargo-aging.js";
import { planMarketPurchase } from "../engines/market/pricing.js";
import { planMarketOutboundSale, marketOutboundPlanToken, marketOutboundAvailableQuantity, allocateMarketOutboundBuyers } from "../engines/market/outbound.js";
import { marketOutboundBatchPlans } from "../engines/market/outbound-batches.js";
import { advanceMarketShipments, proposeMarketShipmentRisk, resolveMarketShipmentRisk } from "../engines/market/shipment.js";
import { marketShipmentSchedule } from "../engines/market/shipment-schedule.js";
import { createMarketOutboundShipment, advanceMarketOutboundShipments, cancelMarketOutboundShipment,
  dispatchMarketOutboundShipment, resolveMarketOutboundShipmentRisk } from "../workflows/market/outbound-shipment.js";
import { marketOutboundRouteFromPurchasePlan } from "../apps/market/outbound-context.js";
import { marketShipmentFinancialRiskText } from "../apps/market/purchase-cost-presentation.js";
import { marketShipmentRiskContext } from "../apps/market/shipment-context.js";
import { createMarketOperationExecutor } from "../apps/market-operation-executor.js";

const deps = {
  addMoney: (h, amount) => { h.storage.moneyCopper += amount; },
  appendStorageLog: (h, rows) => { h.storage.log.push(...rows); },
  formatCurrency: String, riskUnit: () => 0.99,
  storageAddWithOverflow: () => [], internalDemandAvailableFromQd: () => 40
};
function outboundFixture(oldQty = 800) {
  const holding = { storage: { moneyCopper: 1_000_000, resources: [{ id: "wood-row", resourceId: "wood", forSale: true,
    qty: 840, batches: [{ id: "old", qty: oldQty, ageQd: 7 }, { id: "new", qty: 840 - oldQty, ageQd: 2 }] }], log: [] },
    special: { market: { demand: {}, outbound: { orders: [] } } } };
  const quote = { marketId: "port", deliveryMode: "scheduled", deliveryQd: 32,
    location: { deliveryFlatCopper: 8, deliveryLoadCopper: 1, deliverySubtotalRate: 0.02 },
    logistics: { ok: true, transportMode: "airship", distanceKm: 600, capacityLoad: 4000, distanceFlatCopper: 600,
      distanceLoadCopper: 0.3, deliveryFactor: 1, riskFactor: 1, importTaxRate: 0.05, exportTaxRate: 0.02 },
    offers: [{ id: "wood-route", resourceId: "wood", sourceType: "resource", name: "Древесина", stock: 2000, unitPriceCopper: 4, load: 1 }] };
  const transport = planMarketPurchase({ holding, quote, quantities: { "wood-route": 840 }, transportOnly: true });
  const route = marketOutboundRouteFromPurchasePlan(transport);
  const plan = planMarketOutboundSale({ resources: holding.storage.resources, outboundState: holding.special.market.outbound,
    marketId: "port", treasuryCopper: holding.storage.moneyCopper,
    lines: [{ id: "sale", resourceId: "wood", demandId: "wood", name: "Древесина", qty: 840, unitPriceCopper: 4,
      demandBaseDemand: 2000, demandStateRevision: 0 }], routes: [route] });
  assert.equal(plan.ok, true, plan.reasons.join(" "));
  return { holding, plan, transport };
}
const ordersFor = (h) => h.special.market.outbound.orders;
const demandFor = (h) => h.special.market.demand[marketDemandKey("port", "wood")];
function lossFixture(ageQd = 5) {
  return { storage: { moneyCopper: 0, resources: [], log: [] }, special: { market: { orders: [{ id: "import", operationId: "import",
    status: "in-transit", dispatchStatus: "departed", riskStatus: "pending", riskLossChance: 0.08, deliveryQd: 8, remainingQd: 8,
    insuredValueCopper: 60, insuranceCoverageRate: 0.84, maximumInsurancePayoutCopper: 50, totalCopper: 80,
    cargo: [{ sourceType: "resource", resourceId: "custom-food", name: "Еда", qty: 10, unitPriceCopper: 6, ageQd, shelfLifeQd: 20 }] }] } } };
}

export async function checkMarketAuditFixes() {
  {
    const lines = [{ id: "sale", resourceId: "wood", demandId: "wood", qty: 21, unitPriceCopper: 4 }];
    const buyerAllocations = allocateMarketOutboundBuyers({ lines, countryId: "north", organizations: [
      { id: "buyer", active: true, buyer: { enabled: true, countryShares: [{ countryId: "north", sharePct: 45 }] } }
    ] });
    const batches = marketOutboundBatchPlans({ lines, demandLines: lines, buyerAllocations,
      cargoReservations: [{ lineId: "sale", resourceId: "wood", rowId: "row", batchId: "lot", qty: 21, unitPriceCopper: 4 }],
      revenueCopper: 84, insuredValueCopper: 84, route: { standardDeliveryQd: 32, serviceLevel: "standard", shipmentBatches: [10, 10, 1]
        .map((qty, index) => ({ lines: [{ resourceId: "wood", qty }], deliveryQd: 40 + index * 8 })) } });
    for (const buyer of buyerAllocations) assert.equal(batches.flatMap((batch) => batch.buyerAllocations)
      .filter((row) => row.buyerId === buyer.buyerId).reduce((sum, row) => sum + row.qty, 0), buyer.qty,
    "physical splits conserve the parent buyer allocation instead of rerounding country shares");
    const route = { ...batches[0].route, id: "rounded-policy", insurancePremiumRate: 0.01, insuranceCoverageRate: 0.84, deliveryQd: 56 };
    const policy = planMarketOutboundSale({ resources: [{ id: "row", resourceId: "wood", forSale: true, qty: 21,
      batches: [{ id: "lot", qty: 21, ageQd: 0 }] }], lines: [{ ...lines[0], demandBaseDemand: 21 }], routes: [route], treasuryCopper: 1000 });
    assert.equal(policy.ok, true);
    assert.deepEqual(policy.shipmentBatches.map((batch) => batch.maximumInsurancePayoutCopper), [33, 33, 3]);
    assert.equal(policy.maximumInsurancePayoutCopper, 69, "the displayed total is the sum of actual rounded shipment coverage");
    for (const batch of policy.shipmentBatches) assert.equal(marketInsurancePayoutCopper({ ...batch, cargo: batch.cargoReservations }), batch.maximumInsurancePayoutCopper);
    const capped = planMarketOutboundSale({ resources: [{ id: "row", resourceId: "wood", forSale: true, qty: 21,
      batches: [{ id: "lot", qty: 21, ageQd: 0 }] }], lines: [{ ...lines[0], demandBaseDemand: 21 }],
      routes: [{ ...route, insuranceCoverageRate: 1, maximumInsurancePayoutCopper: 1 }], treasuryCopper: 1000 });
    assert.equal(capped.ok, true);
    assert.deepEqual(capped.shipmentBatches.map((batch) => marketInsurancePayoutCopper({ ...batch, cargo: batch.cargoReservations })), [1, 0, 0],
      "a zero allocated limit never becomes uncapped legacy coverage");
  }
  {
    const plan = { deliveryQd: 42, lines: [{ resourceId: "bread", qty: 1, shelfLifeQd: 40 }], shipmentBatches: [
      { deliveryQd: 35, lines: [{ resourceId: "bread", name: "Хлеб", qty: 1, shelfLifeQd: 40 }] },
      { deliveryQd: 42, lines: [{ resourceId: "wood", qty: 840, shelfLifeQd: 0 }] }
    ] };
    assert.deepEqual(marketPlanCargoExpiryWarnings(plan), [], "early bread uses its own arrival, not the last consignment");
    plan.shipmentBatches[1].lines.push({ resourceId: "bread", name: "Хлеб", qty: 3, shelfLifeQd: 40 });
    const warnings = marketPlanCargoExpiryWarnings(plan);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Партия 2.*Хлеб ×3.*не поступит на склад/);
    assert.equal(warnings[0].includes("выручки"), false);
    assert.match(marketPlanCargoExpiryWarnings({ deliveryQd: 8, cargoReservations: [
      { name: "Старое мясо", qty: 2, reservedAgeQd: 15, shelfLifeQd: 20 }
    ] }, { direction: "outbound" })[0], /×2.*выручки/);
  }
  {
    let h = lossFixture(), order = h.special.market.orders[0];
    const lost = { ...deps, riskUnit: () => 0 };
    advanceMarketShipments({ holding: h, elapsedQd: 4, deliveredAt: "event-date", dependencies: lost });
    assert.equal(order.cargo[0].ageQd, 9);
    assert.equal(order.riskProposal.proposedInsurancePayoutCopper, 50);
    advanceMarketShipments({ holding: h, elapsedQd: 20, dependencies: deps });
    assert.equal(order.cargo[0].ageQd, 29, "time still spoils unresolved cargo");
    assert.equal(marketInsurancePayoutCopper(order), 0);
    assert.match(marketShipmentFinancialRiskText(order), /выплата до 0/);
    const publicText = marketShipmentFinancialRiskText(order);
    assert.equal(marketShipmentFinancialRiskText({ ...order, riskProposal: { ...order.riskProposal, outcome: "delayed" } }), publicText);
    assert.equal(marketShipmentRiskContext(order, { isGM: false }).gmResolution, null);
    assert.match(marketShipmentRiskContext(order, { isGM: true }).gmResolution.insuranceText, /выплата 50/);
    h = mergeHoldingDefaults(JSON.parse(JSON.stringify(h)));
    order = h.special.market.orders[0];
    const result = resolveMarketShipmentRisk({ holding: h, order, dependencies: deps });
    assert.equal(result.payoutCopper, 50, "confirmation pays the saved event value after reload");
    assert.equal(resolveMarketShipmentRisk({ holding: h, order, dependencies: deps }).replay, true);
    assert.equal(h.storage.moneyCopper, 50);
    assert.equal(h.storage.log.filter((row) => row.kind === "market-insurance").length, 1);
  }
  {
    const h = lossFixture(21), order = h.special.market.orders[0];
    proposeMarketShipmentRisk({ order, dependencies: { ...deps, riskUnit: () => 0 } });
    assert.equal(resolveMarketShipmentRisk({ holding: h, order, dependencies: deps }).payoutCopper, 0, "spoilage before the incident is never insured");
    const delayed = lossFixture(), delayOrder = delayed.special.market.orders[0];
    delayOrder.riskDelayChance = 0.4;
    proposeMarketShipmentRisk({ order: delayOrder, dependencies: { ...deps,
      riskUnit: (seed) => seed.endsWith("|loss") ? 0.99 : 0 } });
    advanceMarketShipments({ holding: delayed, elapsedQd: 20, dependencies: deps });
    assert.match(marketShipmentRiskContext(delayOrder, { isGM: true }).gmResolution.insuranceText, /выплаты нет/);
    assert.equal(resolveMarketShipmentRisk({ holding: delayed, order: delayOrder, outcome: "lost", dependencies: deps }).payoutCopper, 0,
      "overriding a delay with a new loss uses the new event date");
    const legacy = mergeHoldingDefaults(lossFixture(21)), legacyOrder = legacy.special.market.orders[0];
    Object.assign(legacyOrder, { status: "needsResolution", riskStatus: "needsResolution", riskProposal: { outcome: "lost" } });
    const reloaded = mergeHoldingDefaults(JSON.parse(JSON.stringify(legacy)));
    assert.equal(Object.hasOwn(reloaded.special.market.orders[0].riskProposal, "proposedInsurancePayoutCopper"), false);
    assert.equal(resolveMarketShipmentRisk({ holding: reloaded, order: reloaded.special.market.orders[0], dependencies: deps }).payoutCopper, 0);
  }
  {
    const { holding: h, plan, transport } = outboundFixture();
    assert.deepEqual(transport.shipmentBatches.map((batch) => batch.departureQd), [0, 8]);
    assert.deepEqual(plan.shipmentBatches.map((batch) => batch.deliveryQd), [40, 48]);
    for (const field of ["revenueCopper", "freightCopper", "tariffCopper", "insuranceCopper", "upfrontCopper", "insuredValueCopper", "maximumInsurancePayoutCopper"])
      assert.equal(plan.shipmentBatches.reduce((sum, batch) => sum + batch[field], 0), plan[field], field);
    assert.deepEqual(plan.shipmentBatches.map((batch) => batch.cargoReservations.map((row) => [row.batchId, row.qty])), [[["old", 800]], [["new", 40]]]);
    const changed = structuredClone(plan);
    changed.shipmentBatches[1].deliveryQd++;
    assert.notEqual(marketOutboundPlanToken(changed), plan.planToken, "accepted scheduling is part of the intent token");
    const before = h.storage.moneyCopper;
    const created = createMarketOutboundShipment({ holding: h, plan, operationId: "batch-sale", dependencies: deps });
    assert.equal(created.batchCount, 2);
    assert.equal(h.storage.moneyCopper, before - plan.upfrontCopper);
    assert.equal(demandFor(h).reservedDemand, 840);
    assert.equal(marketOutboundAvailableQuantity({ resources: h.storage.resources, outboundState: h.special.market.outbound, resourceId: "wood" }), 0);
    assert.equal(createMarketOutboundShipment({ holding: h, plan, operationId: "batch-sale", dependencies: deps }).replay, true);
    assert.equal(ordersFor(h).length, 2);
    assert.equal(h.storage.log.filter((row) => row.kind === "market-outbound-upfront").length, 1);
    assert.equal(dispatchMarketOutboundShipment({ holding: h, orderId: ordersFor(h)[1].id, dependencies: deps }).waiting, true);
    assert.notEqual(ordersFor(h)[0].riskSeed, ordersFor(h)[1].riskSeed);
    let rolls = 0;
    const counting = { ...deps, riskUnit: () => { rolls++; return 0.99; } };
    advanceMarketOutboundShipments({ holding: h, elapsedQd: 1, dependencies: counting });
    assert.equal(h.storage.resources[0].qty, 40, "only the first physical load leaves at the first checkpoint");
    assert.equal(ordersFor(h)[1].dispatchStatus, "booked");
    assert.equal(marketShipmentSchedule(ordersFor(h)[1]).waitingQd, 7);
    assert.equal(rolls, 3);
    h.special.market.outbound = normalizeMarketOutboundState(JSON.parse(JSON.stringify(h.special.market.outbound)));
    advanceMarketOutboundShipments({ holding: h, elapsedQd: 7, dependencies: counting });
    assert.equal(h.storage.resources[0].qty, 0);
    assert.equal(ordersFor(h)[1].remainingQd, 40);
    assert.equal(rolls, 3, "at the departure boundary zero road time has no road risk");
    advanceMarketOutboundShipments({ holding: h, elapsedQd: 32, dependencies: counting });
    assert.equal(ordersFor(h)[0].status, "delivered");
    assert.equal(ordersFor(h)[1].remainingQd, 8);
    assert.equal(demandFor(h).consumedOutstanding, 800);
    assert.equal(demandFor(h).reservedDemand, 40);
    advanceMarketOutboundShipments({ holding: h, elapsedQd: 8, dependencies: counting });
    assert.equal(demandFor(h).consumedOutstanding, 840);
    assert.equal(demandFor(h).reservedDemand, 0);
    assert.equal(h.storage.moneyCopper, before - plan.upfrontCopper + plan.revenueCopper);
    assert.equal(rolls, 6);
    assert.deepEqual(ordersFor(h).map((order) => order.cargo[0].ageQd), [47, 50]);
    const cash = h.storage.moneyCopper;
    advanceMarketOutboundShipments({ holding: h, elapsedQd: 48, dependencies: counting });
    assert.equal(h.storage.moneyCopper, cash);
  }
  {
    const { holding: h, plan } = outboundFixture();
    createMarketOutboundShipment({ holding: h, plan, operationId: "large-period", dependencies: deps });
    advanceMarketOutboundShipments({ holding: h, elapsedQd: 48, dependencies: deps });
    assert.deepEqual(ordersFor(h).map((order) => order.cargo[0].ageQd), [47, 50], "one large period agrees with segmented physical transit");
    assert.equal(demandFor(h).consumedOutstanding, 840);
  }
  {
    const { holding: h, plan } = outboundFixture(830);
    assert.deepEqual(plan.shipmentBatches[1].cargoReservations.map((row) => [row.batchId, row.qty]), [["old", 30], ["new", 10]],
      "a warehouse FIFO lot can span physical shipments without duplication");
    createMarketOutboundShipment({ holding: h, plan, operationId: "shared-lot", dependencies: deps });
    advanceMarketOutboundShipments({ holding: h, elapsedQd: 1, dependencies: deps });
    for (const row of h.storage.resources[0].batches) row.ageQd++;
    advanceMarketOutboundShipments({ holding: h, elapsedQd: 7, dependencies: deps });
    advanceMarketOutboundShipments({ holding: h, elapsedQd: 40, dependencies: deps });
    assert.deepEqual(ordersFor(h)[1].cargo.map((row) => [row.batchId, row.qty, row.ageQd]), [["old", 30, 55], ["new", 10, 50]],
      "actual warehouse aging is reconciled with queue aging exactly once");
    assert.equal(demandFor(h).consumedOutstanding, 840);
  }
  {
    const { holding: h, plan } = outboundFixture();
    const before = h.storage.moneyCopper;
    const created = createMarketOutboundShipment({ holding: h, plan, operationId: "cancel-all", dependencies: deps });
    for (const order of created.orders) assert.equal(cancelMarketOutboundShipment({ holding: h, orderId: order.id, dependencies: deps }).ok, true);
    assert.equal(h.storage.moneyCopper, before, "refunds conserve every prepaid copper including rounding");
    assert.equal(demandFor(h).reservedDemand, 0);
    assert.equal(h.storage.resources[0].qty, 840);
    assert.notEqual(ordersFor(h)[0].cancellationOperationId, ordersFor(h)[1].cancellationOperationId);
  }
  {
    const { holding: h, plan } = outboundFixture();
    createMarketOutboundShipment({ holding: h, plan, operationId: "partial-cancel", dependencies: deps });
    advanceMarketOutboundShipments({ holding: h, elapsedQd: 1, dependencies: deps });
    const queued = ordersFor(h)[1], queuedId = queued.id;
    assert.equal(cancelMarketOutboundShipment({ holding: h, orderId: ordersFor(h)[0].id, dependencies: deps }).ok, false);
    const refund = cancelMarketOutboundShipment({ holding: h, orderId: queuedId, dependencies: deps });
    assert.equal(refund.refundCopper, queued.upfrontCopper);
    assert.equal(demandFor(h).reservedDemand, 800);
    assert.equal(h.storage.resources[0].qty, 40);
    const cash = h.storage.moneyCopper;
    assert.equal(cancelMarketOutboundShipment({ holding: h, orderId: queuedId, dependencies: deps }).replay, true);
    assert.equal(h.storage.moneyCopper, cash);
    advanceMarketOutboundShipments({ holding: h, elapsedQd: 40, dependencies: deps });
    assert.equal(demandFor(h).consumedOutstanding, 800);
    assert.equal(demandFor(h).reservedDemand, 0);
  }
  {
    const { holding: h, plan } = outboundFixture();
    createMarketOutboundShipment({ holding: h, plan, operationId: "one-lost", dependencies: deps });
    const lost = { ...deps, riskUnit: (seed) => seed.includes(":batch:1|") && seed.endsWith("|loss") ? 0 : 0.99 };
    advanceMarketOutboundShipments({ holding: h, elapsedQd: 1, dependencies: lost });
    assert.equal(ordersFor(h)[0].status, "needsResolution");
    assert.equal(ordersFor(h)[1].dispatchStatus, "booked");
    const lostId = ordersFor(h)[0].id;
    const result = resolveMarketOutboundShipmentRisk({ holding: h, orderId: lostId, dependencies: deps });
    assert.equal(result.ok, true);
    assert.equal(demandFor(h).reservedDemand, 40);
    assert.equal(demandFor(h).consumedOutstanding, 0);
    const cash = h.storage.moneyCopper;
    assert.equal(resolveMarketOutboundShipmentRisk({ holding: h, orderId: lostId, dependencies: deps }).replay, true);
    assert.equal(h.storage.moneyCopper, cash);
    advanceMarketOutboundShipments({ holding: h, elapsedQd: 48, dependencies: deps });
    assert.equal(demandFor(h).consumedOutstanding, 40);
  }
  {
    const { holding: h, plan } = outboundFixture();
    h.special.market.outbound.orders = Array.from({ length: MAX_ACTIVE_OUTBOUND_ORDERS - 1 }, (_, index) => ({ id: `legacy-${index}`, status: "booked" }));
    const cash = h.storage.moneyCopper;
    const result = createMarketOutboundShipment({ holding: h, plan, operationId: "over-cap", dependencies: deps });
    assert.equal(result.capacityExceeded, true, "the cap counts physical batches before any reservation or payment");
    assert.equal(h.storage.moneyCopper, cash);
    assert.deepEqual(h.special.market.demand, {});
    const legacy = normalizeMarketOutboundState({ orders: [{ id: "accepted-single", deliveryQd: 48, cargoReservations: plan.cargoReservations }] });
    assert.equal(legacy.orders.length, 1, "existing aggregate contracts are not rewritten");
  }
  for (const isGM of [true, false]) {
    const { holding: initial, plan } = outboundFixture();
    initial.id = "holding";
    initial.visibility = "public";
    initial.gm = { playersCanUseStorage: true };
    let data = { meta: { revision: 1 }, holdings: [initial] }, commits = 0;
    const user = { id: isGM ? "gm" : "player", isGM };
    const skipToken = Symbol("skip");
    const buildExecutor = () => createMarketOperationExecutor({
      getUser: () => user, sourceTokenFor: () => "fixture-source",
      skipTransaction: (value) => ({ [skipToken]: true, value }),
      prepareContext: () => ({ market: { id: "port" }, outbound: { plan } }),
      getWorkflow: () => ({ _addMoney: deps.addMoney, _appendStorageLog: deps.appendStorageLog }),
      updateHolding: async (_id, updater) => {
        const draft = structuredClone(data);
        const response = await updater(draft.holdings[0], draft);
        if (response?.[skipToken]) return response.value;
        draft.meta.revision++;
        data = draft;
        commits++;
        return response;
      }
    });
    const execute = buildExecutor();
    const command = { type: "outbound", operationId: `authority-batches-${user.id}`, holdingId: "holding",
      expectedRevision: 1, sourceToken: "fixture-source", planToken: plan.planToken, marketId: "port", quantities: { wood: 840 } };
    const context = { userId: user.id, remote: !isGM };
    await assert.rejects(execute({ ...command, expectedRevision: 0 }, context), /changed after preview/);
    await assert.rejects(execute({ ...command, planToken: "stale" }, context), /preview is stale/);
    assert.equal(commits, 0);
    if (!isGM) {
      data.holdings[0].gm.playersCanUseStorage = false;
      await assert.rejects(execute(command, context), /No permission/);
      data.holdings[0].gm.playersCanUseStorage = true;
    }
    const result = await execute(command, context);
    assert.equal(result.batchCount, 2);
    assert.equal(commits, 1);
    assert.equal(ordersFor(data.holdings[0]).length, 2);
    assert.equal(data.holdings[0].storage.moneyCopper, initial.storage.moneyCopper - plan.upfrontCopper);
    assert.equal((await execute(command, context)).replay, true);
    assert.equal((await buildExecutor()(command, context)).replay, true, "parent receipt survives executor restart");
    assert.equal(commits, 1);
    await assert.rejects(buildExecutor()({ ...command, quantities: { wood: 839 } }, context), /another.*operation/);
  }
  console.log("Market audit fixes: batch ETA/FIFO/fees/demand/refunds/risk/reload, dated insurance and private player presentation passed.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkMarketAuditFixes();
