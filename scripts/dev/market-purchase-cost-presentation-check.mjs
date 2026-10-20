import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { marketPurchaseCostPresentation, marketShipmentFinancialRiskText } from "../apps/market/purchase-cost-presentation.js";
import { marketShipmentRiskContext } from "../apps/market/shipment-context.js";
import { planMarketPurchase } from "../engines/market/pricing.js";
import { createMarketShipment } from "../engines/market/shipment.js";
import { inboundDeliveryFixture, inboundDeliveryDependencies } from "./market-inbound-delivery-check.mjs";

function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
  return Object.freeze(value);
}

// A cheap heavy line pays operational freight; a weightless valuable line pays value fees.
const mixed = {
  deliveryMode: "scheduled", subtotalCopper: 1050, totalCopper: 1308, deliveryCopper: 258, maximumInsurancePayoutCopper: 882,
  shipmentBatches: [{
    routeCopper: 100, operationalFreightCopper: 100, valueFreightCopper: 90, handlingCopper: 10, insuranceCopper: 21, taxCopper: 105, expressSurchargeCopper: 22, deliveryCopper: 258,
    lines: [{ id: "heavy", name: "Камень", qty: 50, lineCopper: 50, unitPriceCopper: 1, load: 2 },
      { id: "valuable", name: "Самоцвет", qty: 1, lineCopper: 1000, unitPriceCopper: 1000, load: 0 }]
  }]
};
const mixedBefore = JSON.stringify(mixed);
const view = marketPurchaseCostPresentation(freeze(mixed));
assert.equal(view.allocationValid, true);
assert.equal(view.landedLines.find((row) => row.id === "heavy").landedCopper, 188);
assert.equal(view.landedLines.find((row) => row.id === "valuable").landedCopper, 1120);
assert.match(view.landedLines.find((row) => row.id === "heavy").unitText, /3,76 ММ/);
assert.equal(JSON.stringify(mixed), mixedBefore, "presentation never reprices or writes to the accepted plan");
assert.equal(view.unrecoveredText, "4 З 2 С 6 М");

const valueTariff = structuredClone(mixed);
Object.assign(valueTariff, { totalCopper: 1335, deliveryCopper: 285 });
Object.assign(valueTariff.shipmentBatches[0], { routeCopper: 149, valueFreightCopper: 149, expressSurchargeCopper: 0, deliveryCopper: 285 });
const valueView = marketPurchaseCostPresentation(valueTariff);
assert.equal(valueView.landedLines.find((row) => row.id === "heavy").landedCopper, 73);
assert.equal(valueView.landedLines.find((row) => row.id === "valuable").landedCopper, 1262);

// Integer rounding conserves every copper and is stable under line reordering.
const tiny = { subtotalCopper: 27, totalCopper: 31, deliveryCopper: 4, routeCopper: 1, handlingCopper: 1, insuranceCopper: 1, taxCopper: 1,
  lines: ["c", "a", "b"].map((id) => ({ id, name: id, qty: 3, lineCopper: 9, load: 1 })) };
const tinyView = marketPurchaseCostPresentation(tiny);
const reordered = marketPurchaseCostPresentation({ ...tiny, lines: [...tiny.lines].reverse() });
for (const row of tinyView.landedLines) assert.equal(reordered.landedLines.find((other) => other.id === row.id).landedCopper, row.landedCopper);
assert.equal(tinyView.landedLines.reduce((sum, row) => sum + row.landedCopper, 0), 31);
assert.equal(tinyView.landedLines.find((row) => row.id === "a").deliveryCopper, 4);

// Actual batch totals, including the expensive remainder departure, are represented once.
for (const serviceLevel of ["standard", "express", "charter"]) {
  const { holding, quote } = inboundDeliveryFixture();
  quote.offers.push({ ...quote.offers[0], id: "valuable", name: "Металл", unitPriceCopper: 100, load: 0.25 });
  const plan = planMarketPurchase({ holding, quote, quantities: { wood: 840, valuable: 3 }, serviceLevel });
  const before = JSON.stringify(plan);
  const cost = marketPurchaseCostPresentation(freeze(plan));
  assert.equal(cost.hasLandedLines, true);
  assert.equal(cost.landedLines.length, 2);
  assert.equal(cost.landedLines.reduce((sum, row) => sum + row.landedCopper, 0), plan.totalCopper);
  assert.equal(cost.landedLines.reduce((sum, row) => sum + row.deliveryCopper, 0), plan.deliveryCopper);
  assert.equal(cost.landedLines.find((row) => row.id === "wood").qty, 840);
  assert.equal(JSON.stringify(plan), before);
}

// Financial exposure uses public saved coverage, never the hidden proposed outcome.
{
  const { holding, quote } = inboundDeliveryFixture();
  const plan = planMarketPurchase({ holding, quote, quantities: { wood: 100 }, serviceLevel: "charter" });
  const order = createMarketShipment({ holding, plan, operationId: "cost-privacy", dependencies: inboundDeliveryDependencies }).order;
  order.status = "needsResolution";
  order.riskStatus = "needsResolution";
  order.riskProposal = { id: "private-event", outcome: "lost", lossRoll: 0.001, potentialInsurancePayoutCopper: 12345 };
  const saved = JSON.stringify(order);
  const player = marketShipmentRiskContext(order, { isGM: false });
  assert.equal(player.gmResolution, null);
  const financial = marketShipmentFinancialRiskText(freeze(order));
  assert.equal(financial.includes("private-event"), false);
  assert.equal(financial.includes("12345"), false);
  assert.equal(financial.includes("0.001"), false);
  assert.equal(JSON.stringify(order), saved);
  assert.equal(marketPurchaseCostPresentation(plan).hasInsuranceExposure, true);
  assert.equal(marketPurchaseCostPresentation({ ...plan, deliveryMode: "instant" }).hasInsuranceExposure, false);
}

assert.equal(marketPurchaseCostPresentation({}).hasLandedLines, false);
assert.equal(marketPurchaseCostPresentation({ totalCopper: 1, deliveryCopper: 1, lines: [] }).allocationValid, false);
const appSource = readFileSync(new URL("../apps/market-app.js", import.meta.url), "utf8");
const template = readFileSync(new URL("../../templates/market-app.hbs", import.meta.url), "utf8");
assert.match(appSource, /landedDetails[\s\S]*?"toggle"[\s\S]*?this\.landedPricesOpen = Boolean\(landedDetails\.open\)/);
assert.match(template, /data-market-landed-prices \{\{#if landedPricesOpen\}\}open/);
assert.match(template, /Цена товаров с доставкой/);
assert.match(template, /Не покрывается при полной утрате/);
assert.match(appSource, /canCancel: Boolean\(permissions\.isGM && cancellation\.cancellable\)/, "financial explanations preserve GM-only cancellation");

console.log("Market purchase cost presentation: mass/value attribution, exact copper conservation, batching, average unit price, saved coverage privacy and retained disclosure state passed.");
