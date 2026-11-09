import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { marketPlanCargoExpiryWarnings } from "../engines/market/cargo-aging.js";
import { planMarketOutboundSale, allocateMarketOutboundBuyers } from "../engines/market/outbound.js";
import { marketOutboundBatchPlans } from "../engines/market/outbound-batches.js";


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
    assert.equal(policy.shipmentBatches.reduce((sum, batch) => sum + batch.maximumInsurancePayoutCopper, 0), 69);
    const capped = planMarketOutboundSale({ resources: [{ id: "row", resourceId: "wood", forSale: true, qty: 21,
      batches: [{ id: "lot", qty: 21, ageQd: 0 }] }], lines: [{ ...lines[0], demandBaseDemand: 21 }],
      routes: [{ ...route, insuranceCoverageRate: 1, maximumInsurancePayoutCopper: 1 }], treasuryCopper: 1000 });
    assert.equal(capped.ok, true);
    assert.deepEqual(capped.shipmentBatches.map((batch) => batch.maximumInsurancePayoutCopper), [1, 0, 0],
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

console.log("Market quote contracts: conserved buyer shares and policy rounding, physical-batch expiry warnings and inbound/outbound wording passed.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkMarketAuditFixes();
