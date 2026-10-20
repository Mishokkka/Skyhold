import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_BUILDING_TEMPLATES } from "../data/building-templates.js";
import { yearlyPlan, preparationProductionTradePlan } from "./economy-preparation-year-check.mjs";

// An explicit finite-order sensitivity scenario. These buyers/suppliers are
// test conditions, not claims about available orders in the user's world.
function specializationYear(base, { distanceKm, salePriceFactor, imported = false }) {
  const templates = new Map(DEFAULT_BUILDING_TEMPLATES.map((row) => [row.id, row]));
  const orders = [
    { buildingId: "apothecary", resourceId: "medical-supplies", maxPerPeriod: 100 },
    { buildingId: "tailor-shop", resourceId: "household-goods-simple", maxPerPeriod: 50 }
  ];
  let pendingRevenue = 0;
  let cash = 0;
  let funding = 0;
  let extraNet = 0;
  let operatingRevenue = 0;
  const output = {};
  const purchased = {};
  const periods = [];
  for (const period of base.periods) {
    const workers = structuredClone(period.workers);
    const batches = [];
    cash += pendingRevenue;
    pendingRevenue = 0;
    for (const order of orders) {
      assert.ok(base.constructionRoute.includes(order.buildingId), "An export workshop must be present and already included in base upkeep");
      const building = templates.get(order.buildingId);
      const line = building.productionLines.find((row) => row.resourceId === order.resourceId);
      const available = [...workers].filter((worker) => worker.qd < 20)
        .sort((a, b) => a.qd - b.qd || a.id.localeCompare(b.id)).slice(0, building.workersMax);
      const free = available.reduce((sum, worker) => sum + 20 - worker.qd, 0);
      const laborReserve = Math.max(0, 360 - workers.reduce((sum, worker) => sum + worker.qd, 0));
      const qd = Math.min(Math.floor(Math.min(free, laborReserve) / line.workQd), Math.floor(order.maxPerPeriod / line.outputQty)) * line.workQd;
      if (!qd) continue;
      const batch = preparationProductionTradePlan({ distanceKm, salePriceFactor, imported, buildingId: building.id, lineId: line.id, qd, includeBaseUpkeep: false });
      assert.equal(batch.maintenanceQd, 0, "This reference portfolio contains no additional technical-service job");
      assert.ok(batch.inboundQd + batch.outboundQd <= 40, "The declared next-period settlement requires a short transport route");
      let left = qd;
      for (const worker of available) {
        const take = Math.min(left, 20 - worker.qd);
        if (take) { worker.qd += take; worker.assignments.push({ source: building.id, qd: take }); left -= take; }
        if (!left) break;
      }
      assert.equal(left, 0);
      assert.ok(batch.qty <= order.maxPerPeriod);
      output[batch.resourceId] = (output[batch.resourceId] ?? 0) + batch.qty;
      for (const input of batch.inputs) purchased[input.resourceId] = (purchased[input.resourceId] ?? 0) + input.qty;
      pendingRevenue += batch.revenue;
      extraNet += batch.net;
      batches.push(batch);
    }
    const costs = period.wages + period.upkeep + period.inputsCopper + batches.reduce((sum, batch) => sum + batch.requiredFundingBeforeReceipt, 0);
    funding = Math.max(funding, costs - cash);
    cash += period.revenue - costs;
    operatingRevenue += period.revenue + batches.reduce((sum, batch) => sum + batch.revenue, 0);
    assert.ok(workers.every((worker) => worker.qd <= 20 && worker.assignments.reduce((sum, row) => sum + row.qd, 0) === worker.qd));
    for (const order of orders) assert.ok(workers.filter((worker) => worker.assignments.some((row) => row.source === order.buildingId)).length <= templates.get(order.buildingId).workersMax);
    periods.push({ period: period.period, totalQd: workers.reduce((sum, worker) => sum + worker.qd, 0), batches, workers });
  }
  const steadyNet = base.cashNet + extraNet;
  assert.ok(Math.abs(cash + pendingRevenue - steadyNet) < 0.01, "Unreceived final shipments must reconcile to the annual operating result");
  assert.ok((output["medical-supplies"] ?? 0) <= 2400 && (output["household-goods-simple"] ?? 0) <= 1200);
  return { distanceKm, salePriceFactor, imported, operatingRevenue, operatingMarginPct: Math.round(10000 * steadyNet / operatingRevenue) / 100,
    minimumFreeLaborPct: Math.min(...periods.map((period) => (400 - period.totalQd) / 4)), annualOperatingNet: Math.round(steadyNet), firstYearCashNet: Math.round(cash), closingReceivables: pendingRevenue,
    requiredStartingCash: Math.ceil(funding), output, purchased, annualFreeQd: periods.reduce((sum, period) => sum + 400 - period.totalQd, 0), periods };
}

export function checkPreparationSpecializations() {
  const base = yearlyPlan({ productionToDemand: true, extraTargetIds: ["apothecary", "tailor-shop"] });
  const cases = [30, 120].flatMap((distanceKm) => [1, 1.1, 1.2, 1.287, 1.3].map((salePriceFactor) => specializationYear(base, { distanceKm, salePriceFactor })));
  cases.push(specializationYear(base, { distanceKm: 120, salePriceFactor: 1.2, imported: true }));
  for (const distance of [30, 120]) {
    const rows = cases.filter((row) => !row.imported && row.distanceKm === distance);
    assert.ok(rows.every((row) => row.minimumFreeLaborPct >= 10), "specialization retains seasonal construction and recovery labor");
    assert.ok(rows.every((row, index) => index === 0 || row.annualOperatingNet > rows[index - 1].annualOperatingNet));
  }
  const mature = cases.find((row) => row.distanceKm === 120 && row.salePriceFactor === 1.3 && !row.imported);
  assert.ok(mature.operatingMarginPct >= 10 && mature.operatingMarginPct <= 25, "declared suitable specialization meets the approved calibration range");
  assert.ok(cases.find((row) => row.distanceKm === 120 && row.salePriceFactor === 1.287).annualOperatingNet > 0, "a one-percent price decline must not erase mature profitability");
  assert.ok(cases.at(-1).annualOperatingNet < cases.find((row) => !row.imported && row.distanceKm === 120 && row.salePriceFactor === 1.2).annualOperatingNet);
  return { scope: "Finite annual orders for existing apothecary/tailor workshops, baseline food/housing/guards and per-resident 20-QD limits. Quotes and suppliers are declared scenario conditions, not real-world market evidence.",
    limitations: ["Workers are assumed qualified; no professional/type efficiency bonus is granted.",
      "Export payments arrive the following period; closing receivables are not cash. Inputs are supplied locally at canonical prices except the explicit imported case.",
      "No new buildings, free inputs, additional population budget or subsidies. Base upkeep is already in the reference year; extra operating charges and wages are included.",
      "Finite buyers accept at most 100 medical supplies and 50 simple household goods each period; unused demand is lost. Repeating the year requires renewal of real contracts.",
      "The funded planning model still does not simulate every runtime shutdown, morale, qualification, market-access or random-event condition."], cases };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = checkPreparationSpecializations();
  const output = process.argv.indexOf("--output");
  if (output >= 0) writeFileSync(process.argv[output + 1], JSON.stringify(result, null, 2));
  for (const { periods: _periods, purchased: _purchased, ...row } of result.cases) console.log(JSON.stringify(row));
}
