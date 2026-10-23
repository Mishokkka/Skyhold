import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { preparationRoute } from "./building-preparation-revision-check.mjs";
// These fixed economic scenarios characterize worlds before the explicit labor transition.
// Hybrid staffing and actual tenday execution are covered by the hybrid-labor suite.
import { BUILDING_TEMPLATES_BEFORE_LABOR_TRANSITION as DEFAULT_BUILDING_TEMPLATES } from "../data/building-templates.js";
import { usesTechnicalMaintenance } from "../data/economy/maintenance.js";
import { allResourceDefs, parseResourceCosts } from "../core/resources.js";
import { addResourceBatches, beginResourceBatchPeriod, finishResourceBatchPeriod, takeResourceBatches } from "../core/resource-batches.js";
import { planAgriculturePlot } from "../engines/economy/agriculture.js";
import { resolveFoodRation } from "../engines/economy/food-rations.js";
import { buildInternalDemandPools, planInternalDemand } from "../engines/economy/internal-demand.js";
import { DEFAULT_INTERNAL_DEMAND_CONFIG, internalDemandTradeDefaults } from "../data/economy/internal-demand.js";
import { resolveMarketLogistics } from "../engines/market/logistics.js";
import { planMarketPurchase } from "../engines/market/pricing.js";
import { planMarketOutboundSale } from "../engines/market/outbound.js";
import { marketOutboundRouteFromPurchasePlan } from "../apps/market/outbound-context.js";

// A funded planning scenario, not a replacement for the application tenday
// coordinator. Its scope and assumptions are reported alongside every result.
const pack = JSON.parse(readFileSync(new URL("../../examples/content-packs/air-islands-materials-and-country-markets.json", import.meta.url), "utf8"));
const resources = new Map(allResourceDefs({ catalogRows: pack.content.resources }).map((row) => [row.id, row]));
const templates = structuredClone(DEFAULT_BUILDING_TEMPLATES.filter((row) => !["fasti-shop", "laputa-excavated-crypt"].includes(row.id)));
const preparationMaintenanceNorms = () => new Map(templates.map((row) => [row.id, usesTechnicalMaintenance(row) ? Number(row.maintenance.requiredPoints) || 0 : 0]));
const preparationMaintenanceTasks = (buildings, activeIds) => buildings.filter((row) => activeIds.has(row.id) && usesTechnicalMaintenance(row) && row.maintenance.requiredPoints > 0)
  .map((row) => ({ source: row.id, functionId: "maintenance", qd: row.maintenance.requiredPoints, wage: 18 }));
const byId = new Map(templates.map((row) => [row.id, row]));
const price = (id) => {
  assert.ok(resources.has(id), `Unknown resource ${id}`);
  return resources.get(id).basePriceCopper;
};
const round = (value) => Math.round(value * 100) / 100;

export function yearlyPlan({ demandFactor = 1, productionToDemand = false, extraTargetIds = [] } = {}) {
  const targetIds = ["well", "common-house", "barn", "watch-post", "grain-field", "mill", "bakery", "tool-workshop", "market", ...extraTargetIds];
  const route = preparationRoute(templates, targetIds);
  const buildings = route.order.map((id) => ({ ...structuredClone(byId.get(id)), templateId: id }));
  for (const [id, extra] of [["grain-field", 4], ["common-house", 1], ["watch-post", 1]]) {
    for (let index = 0; index < extra; index += 1) buildings.push({ ...structuredClone(byId.get(id)), templateId: id, id: `${id}-extra-${index}` });
  }
  const housingCapacity = buildings.reduce((sum, row) => sum + (row.housing?.capacity ?? 0), 0);
  assert.ok(buildings.filter((row) => row.templateId === "common-house").reduce((sum, row) => sum + row.housing.capacity, 0) >= 20);
  const holding = { storage: { resources: [] } };
  const row = (resourceId) => {
    let result = holding.storage.resources.find((entry) => entry.resourceId === resourceId);
    if (!result) {
      result = { id: resourceId, resourceId, qty: 0, batches: [], roomId: "scenario-storage" };
      holding.storage.resources.push(result);
    }
    return result;
  };
  let batchId = 0;
  const add = (id, qty, ageQd = 0) => addResourceBatches(row(id), { qty, ageQd }, { holding, makeId: () => `year-batch-${String(++batchId).padStart(8, "0")}` });
  const take = (id, qty) => takeResourceBatches(row(id), qty, { holding });
  add("grain", 2400, 480);
  const initialStockValue = 2400 * price("grain");
  const fields = buildings.filter((entry) => entry.templateId === "grain-field");
  const crop = byId.get("grain-field").agriculture.crops.find((entry) => entry.resourceId === "grain");
  const fieldStates = new Map(fields.map((entry) => [entry.id, {}]));
  const periods = [];
  let cumulativeCash = 0;
  let cashRequired = 0;
  let totalHarvest = 0;
  let peakLoad = 0;
  // The approved route can use a warehouse instead of an elevator. Count
  // each built storage function, without inventing capacity for future buildings.
  const storageCapacity = buildings.filter((entry) => entry.functions?.storage)
    .reduce((sum, entry) => sum + (entry.storage?.capacity ?? 0), 0);
  const basePerPeriod = buildings.reduce((sum, entry) => sum + entry.baseUpkeepMonthlyCopper / 3, 0);
  const toolLine = byId.get("tool-workshop").productionLines.find((entry) => entry.resourceId === "tools-simple");
  const toolInputs = parseResourceCosts(toolLine.expenses);
  const toolInputCost = toolInputs.reduce((sum, entry) => sum + entry.qty * price(entry.resourceId), 0);
  const mill = byId.get("mill").productionLines.find((entry) => entry.resourceId === "flour");
  const bakery = byId.get("bakery").productionLines.find((entry) => entry.resourceId === "bread");
  const millInputs = parseResourceCosts(mill.expenses);
  const bakeryInputs = parseResourceCosts(bakery.expenses);
  const grainPerMillCycle = millInputs.find((entry) => entry.resourceId === "grain")?.qty;
  const flourPerBakeryCycle = bakeryInputs.find((entry) => entry.resourceId === "flour")?.qty;
  assert.ok(millInputs.length === 1 && grainPerMillCycle === mill.outputQty, "The year model requires the current 1:1 grain/flour recipe");
  assert.equal(flourPerBakeryCycle, bakery.outputQty, "The year model requires the current 1:1 flour/bread recipe");
  const purchasedBakeryInputs = bakeryInputs.filter((entry) => entry.resourceId !== "flour");

  for (let period = 1; period <= 24; period += 1) {
    beginResourceBatchPeriod(holding);
    const tasks = [];
    let harvest = 0;
    for (const field of fields) {
      const plan = planAgriculturePlot({
        state: fieldStates.get(field.id), crop, operations: { sow: true, harvest: true }, elapsedQd: 40,
        availableWorkQd: 20, operationId: `year-${period}-${field.id}`,
        calendarContextForOffset: (offset) => {
          const elapsed = (period - 1) * 40 + offset;
          const season = ["spring", "summer", "autumn", "winter"][Math.floor(elapsed / 240)];
          return { seasonId: season, seasonKey: `year-1-${season}`, year: 1 };
        }
      });
      fieldStates.set(field.id, plan.stateAfter);
      const quantity = plan.resourceChanges.reduce((sum, entry) => sum + (entry.qty ?? entry.delta ?? 0), 0);
      harvest += quantity;
      if (plan.workQdUsed) tasks.push({ source: field.id, qd: plan.workQdUsed, wage: field.wageDailyCopper });
    }
    totalHarvest += harvest;
    add("grain", harvest);
    peakLoad = Math.max(peakLoad, holding.storage.resources.reduce((sum, entry) => sum + entry.qty * resources.get(entry.resourceId).loadPoints / 4, 0));
    // Grain -> flour -> bread uses the actual recipe sizes and integer cycles.
    const bakeryCycles = Math.ceil(Math.max(0, 200 - row("bread").qty) / bakery.outputQty);
    const flourNeeded = bakeryCycles * flourPerBakeryCycle;
    const millCycles = Math.ceil(Math.max(0, flourNeeded - row("flour").qty) / mill.outputQty);
    const grainUsed = millCycles * grainPerMillCycle;
    assert.equal(take("grain", grainUsed).shortfall, 0, `period ${period}: seed stock/harvest fails to feed residents`);
    add("flour", millCycles * mill.outputQty);
    assert.equal(take("flour", flourNeeded).shortfall, 0);
    add("bread", bakeryCycles * bakery.outputQty);
    tasks.push({ source: "mill", qd: millCycles * mill.workQd, wage: byId.get("mill").wageDailyCopper });
    tasks.push({ source: "bakery", qd: bakeryCycles * bakery.workQd, wage: byId.get("bakery").wageDailyCopper });
    for (const building of buildings.filter((entry) => entry.templateId === "watch-post")) tasks.push({ source: building.id, qd: 20, wage: building.wageDailyCopper });
    // The valid development route includes an elevator. Keep its actual storage
    // service staffed throughout the year, rather than assigning free capacity.
    if (route.order.includes("grain-elevator")) tasks.push({ source: "grain-elevator", qd: 10, minWorkers: 2, wage: byId.get("grain-elevator").wageDailyCopper });
    tasks.push(...preparationMaintenanceTasks(buildings, new Set(tasks.filter((task) => task.qd > 0).map((task) => task.source))));
    const requiredQd = tasks.reduce((sum, entry) => sum + entry.qd, 0);
    assert.ok(requiredQd <= 400, `period ${period}: essential work exceeds 20 residents (${requiredQd} QD)`);
    const tradeActive = requiredQd + 60 <= 400;
    // Heating inputs are supplied locally under the same paid-input assumption
    // as tools; the V18 bakery recipe must not receive free fuel.
    const foodInputsCopper = purchasedBakeryInputs.reduce((sum, entry) => sum + entry.qty * bakeryCycles * price(entry.resourceId), 0);
    let inputsCopper = foodInputsCopper;
    let toolsProduced = 0;
    const marketDefaults = internalDemandTradeDefaults({ templateId: "market" });
    const tool = resources.get("tools-simple");
    const planTrade = (availableQty) => planInternalDemand({
      operationId: `trade-${period}`,
      pools: buildInternalDemandPools({
        populationCount: 20, populationBudgetPerResidentCopper: DEFAULT_INTERNAL_DEMAND_CONFIG.populationBudgetPerResidentCopper,
        satisfactionFactor: demandFactor, wagePaymentRatio: 1,
        marketFlowSources: tradeActive ? [{ id: "market", budgetCopper: marketDefaults.demandBudgetBaseCopper + marketDefaults.demandBudgetPerWorkerCopper * 2 }] : []
      }),
      channels: tradeActive ? [{ id: "market", buildingId: "market", sourceIds: ["population", "market-flow"], allowedTags: ["all"], allowedKinds: ["resource"], throughputUnits: 16, sellerEfficiency: 2 }] : [],
      candidates: [{ id: "tools-simple", resourceId: "tools-simple", kind: "resource", qty: availableQty, basePriceCopper: price("tools-simple"), categoryTag: tool.categoryTag, marketTags: tool.marketTags }]
    });
    if (tradeActive) {
      tasks.push({ source: "market", qd: 40, minWorkers: 2, wage: byId.get("market").wageDailyCopper });
      const maximumCycles = Math.floor(20 / toolLine.workQd);
      const plannedSales = planTrade(row("tools-simple").qty + maximumCycles * toolLine.outputQty).sales.reduce((sum, entry) => sum + entry.qty, 0);
      const toolCycles = productionToDemand ? Math.min(maximumCycles, Math.ceil(Math.max(0, plannedSales - row("tools-simple").qty) / toolLine.outputQty)) : maximumCycles;
      if (toolCycles) tasks.push({ source: "tool-workshop", qd: toolCycles * toolLine.workQd, wage: byId.get("tool-workshop").wageDailyCopper });
      toolsProduced = toolCycles * toolLine.outputQty;
      inputsCopper += toolCycles * toolInputCost;
      // This fixture has a named local supplier at canonical prices. It does
      // not claim these inputs are free or instantly imported from abroad.
      add("tools-simple", toolsProduced);
    }
    const trade = planTrade(row("tools-simple").qty);
    const sold = trade.sales.reduce((sum, entry) => sum + entry.qty, 0);
    assert.equal(take("tools-simple", sold).shortfall, 0);
    const food = resolveFoodRation({ residents: 20, days: 10, available: row("bread").qty, selectedUnits: 10 });
    assert.equal(food.effectiveTier, "normal");
    assert.equal(take("bread", food.consumeTarget).shortfall, 0);
    const expiry = finishResourceBatchPeriod(holding, {
      elapsedQd: 40,
      shelfLifeQdForRow: (entry) => resources.get(entry.resourceId).shelfLifeQd ?? 0,
      categoryTagForRow: (entry) => resources.get(entry.resourceId).categoryTag,
      roomMultiplierForRow: () => 1
    });
    // Allocate real integer QD across named workers, with no overtime. Capacity
    // is a workload proof; professional admission is an explicit fixture input.
    const workers = Array.from({ length: 20 }, (_, index) => ({ id: `resident-${index + 1}`, qd: 0, assignments: [] }));
    // Technical labor consumes the same finite QD pool as production.
    for (const task of [...tasks].sort((a, b) => Number(b.source === "maintenance") - Number(a.source === "maintenance"))) {
      let left = task.qd;
      const available = [...workers].filter((worker) => worker.qd < 20).sort((a, b) => a.qd - b.qd || a.id.localeCompare(b.id));
      const assign = (worker, amount) => {
        worker.qd += amount;
        left -= amount;
        const existing = worker.assignments.find((entry) => entry.source === task.source && entry.functionId === task.functionId);
        if (existing) existing.qd += amount;
        else worker.assignments.push({ source: task.source, functionId: task.functionId, qd: amount });
      };
      const taskMinimum = task.functionId === "maintenance" ? 1 : task.minWorkers ?? buildings.find((row) => row.id === task.source)?.workersMin ?? 1;
      assert.ok(available.length >= taskMinimum && left >= taskMinimum, `${task.source}: insufficient staff/time for the minimum team`);
      for (const worker of available.slice(0, taskMinimum)) assign(worker, 1);
      for (const worker of available) {
        const assigned = Math.min(left, 20 - worker.qd);
        if (assigned > 0) assign(worker, assigned);
        if (!left) break;
      }
      assert.equal(left, 0);
    }
    for (const task of tasks.filter((entry) => entry.functionId === "maintenance")) {
      assert.equal(workers.flatMap((worker) => worker.assignments).filter((entry) => entry.source === task.source && entry.functionId === "maintenance").reduce((sum, entry) => sum + entry.qd, 0), task.qd);
    }
    assert.ok(workers.every((worker) => worker.qd <= 20 && worker.assignments.reduce((sum, entry) => sum + entry.qd, 0) === worker.qd));
    const wages = tasks.reduce((sum, task) => sum + task.qd * task.wage / 2, 0);
    const active = new Set(tasks.filter((task) => task.qd > 0 && task.functionId !== "maintenance").map((task) => task.source));
    const upkeep = basePerPeriod + buildings.filter((entry) => active.has(entry.id)).reduce((sum, entry) => sum + entry.operatingUpkeepMonthlyCopper / 3, 0);
    const cost = wages + upkeep + inputsCopper;
    // Costs must be fundable before this period's sales settle.
    cashRequired = Math.max(cashRequired, cost - cumulativeCash);
    cumulativeCash += trade.revenueCopper - cost;
    const load = holding.storage.resources.reduce((sum, entry) => sum + entry.qty * resources.get(entry.resourceId).loadPoints / 4, 0);
    peakLoad = Math.max(peakLoad, load);
    periods.push({ period, harvest, grain: row("grain").qty, bread: row("bread").qty, tools: row("tools-simple").qty, toolsProduced, sold,
      foodConsumed: food.consumeTarget, expired: expiry.expiredQty, qd: tasks.reduce((sum, task) => sum + task.qd, 0),
      maintenanceQd: tasks.filter((task) => task.functionId === "maintenance").reduce((sum, task) => sum + task.qd, 0),
      tradeActive, wages, upkeep, foodInputsCopper, inputsCopper, revenue: trade.revenueCopper, cumulativeCash, load, workers });
  }
  assert.equal(totalHarvest, 4800);
  const expiredFood = periods.reduce((sum, entry) => sum + entry.expired, 0);
  // A stable buffer is an observed outcome, not an assumption: integer bread
  // batches can leave prepared food or losses instead of identical seed stock.
  assert.equal(row("grain").qty + row("bread").qty + expiredFood, 2400, "All grain must resolve to consumed food, closing stock, or explicit spoilage");
  assert.equal(row("grain").qty, 2400, "The funded plan must restore next spring's grain buffer");
  assert.equal(periods.reduce((sum, entry) => sum + entry.foodConsumed, 0), 4800);
  assert.ok(peakLoad <= storageCapacity, `Peak load ${peakLoad} exceeds built storage ${storageCapacity}`);
  const finalStockValue = holding.storage.resources.reduce((sum, entry) => sum + entry.qty * price(entry.resourceId), 0);
  return { maintenanceModel: "technical-qd", productionToDemand, demandFactor, constructionRoute: route.order, buildings: buildings.map((entry) => entry.id),
    housingCapacity, annualMaintenanceQd: periods.reduce((sum, entry) => sum + entry.maintenanceQd, 0), initialGrain: 2400, initialGrainAgeQd: 480, initialStockValue,
    annualHarvest: totalHarvest, finalGrain: row("grain").qty, finalBread: row("bread").qty, expiredFood,
    grainBufferRestorationQty: Math.max(0, 2400 - row("grain").qty),
    finalTools: row("tools-simple").qty, cashNet: cumulativeCash,
    requiredStartingCash: cashRequired, annualExternalFundingForStableCash: Math.max(0, -cumulativeCash),
    economicNetIncludingConsumedFoodAndStock: cumulativeCash + finalStockValue - initialStockValue + 4800 * price("bread"),
    peakLoad, storageCapacity, maxWorkerQd: Math.max(...periods.flatMap((entry) => entry.workers.map((worker) => worker.qd))),
    tradePeriods: periods.filter((entry) => entry.tradeActive).length, periods };
}

export function preparationProductionTradePlan({ distanceKm, imported, buildingId, lineId, qd, salePriceFactor = 1, includeBaseUpkeep = true, includeOperatingUpkeep = true }) {
  const building = byId.get(buildingId);
  const line = building.productionLines.find((entry) => entry.id === lineId);
  assert.ok(line && qd >= line.workQd);
  const cycles = Math.floor(qd / line.workQd);
  const qty = cycles * line.outputQty;
  const inputs = parseResourceCosts(line.expenses).map((entry) => ({ ...entry, qty: entry.qty * cycles }));
  const holding = { id: "industrial-plan", type: "sky-island", overview: { region: "home" }, gm: { modifiers: { marketConnectionsLevel: 9 } }, storage: { moneyCopper: Number.MAX_SAFE_INTEGER } };
  const regions = [
    { value: "home", marketLandmassId: "test", marketTransportModes: ["airship"], marketLinks: [{ regionId: "market", distanceKm, ursCost: 1, modes: ["airship"] }] },
    { value: "market", marketLandmassId: "test", marketTransportModes: ["airship"], marketLinks: [] }
  ];
  const market = { id: "market", label: "Test market", regionId: "market", transportModes: ["airship"], baseDeliveryQd: 2, airshipCapacityLoad: 4000, airshipHireCopper: 120 };
  const logistics = resolveMarketLogistics({ holding, market, regions });
  const purchase = (entries) => {
    const offers = entries.map((entry) => ({ id: entry.resourceId, resourceId: entry.resourceId, name: entry.resourceId, kind: "material", stock: entry.qty,
      unitPriceCopper: price(entry.resourceId), basePriceCopper: price(entry.resourceId), load: resources.get(entry.resourceId).loadPoints / 4 }));
    return planMarketPurchase({ holding, quote: { marketId: "market", marketLabel: "Test market", location: { deliveryFlatCopper: 8, deliveryLoadCopper: 1, deliverySubtotalRate: 0.02, deliveryQdFactor: 1 },
      logistics, deliveryMode: "scheduled", deliveryQd: Math.max(1, Math.ceil(distanceKm / 20) + 1), offers },
    quantities: Object.fromEntries(entries.map((entry) => [entry.resourceId, entry.qty])), serviceLevel: "standard" });
  };
  const inputPurchase = purchase(inputs);
  const resourceId = line.resourceId;
  const outRoute = marketOutboundRouteFromPurchasePlan(purchase([{ resourceId, qty }]));
  const outbound = planMarketOutboundSale({ resources: [{ id: resourceId, resourceId, qty, batches: [{ id: "sale-batch", qty, ageQd: 0 }] }], outboundState: { orders: [] },
    lines: [{ id: resourceId, resourceId, demandId: resourceId, qty, unitPriceCopper: Math.round(price(resourceId) * salePriceFactor), demandBaseDemand: qty, demandStateRevision: 0 }],
    routes: [outRoute], treasuryCopper: Number.MAX_SAFE_INTEGER, insuranceEnabled: true });
  assert.ok((!inputs.length || inputPurchase.ok) && outbound.ok, "Transport plan must be feasible");
  const inputCost = imported ? inputPurchase.totalCopper : inputs.reduce((sum, entry) => sum + entry.qty * price(entry.resourceId), 0);
  const wage = qd * building.wageDailyCopper / 2;
  const upkeep = ((includeBaseUpkeep ? building.baseUpkeepMonthlyCopper : 0) + (includeOperatingUpkeep ? building.operatingUpkeepMonthlyCopper : 0)) / 3;
  const maintenanceQd = preparationMaintenanceNorms().get(building.id);
  const maintenanceWage = maintenanceQd * 18 / 2;
  const net = outbound.revenueCopper - outbound.upfrontCopper - inputCost - wage - upkeep - maintenanceWage;
  return { maintenanceModel: "technical-qd", maintenanceQd, distanceKm, imported, qty, workQd: qd, resourceId, inputs, inputCost, inboundFreightAndFees: imported ? inputPurchase.deliveryCopper : 0,
    inboundQd: imported ? inputPurchase.deliveryQd : 0, outboundQd: outRoute.deliveryQd, outboundRoute: outRoute, wages: wage, upkeep, maintenanceWage,
    revenue: outbound.revenueCopper, outboundFees: outbound.upfrontCopper, net: round(net),
    requiredFundingBeforeReceipt: round(inputCost + wage + upkeep + maintenanceWage + outbound.upfrontCopper) };
}

function industrialPlan(distanceKm, utilization, imported) {
  const building = byId.get("steelworks");
  const line = building.productionLines.find((entry) => entry.resourceId === "steel");
  return { ...preparationProductionTradePlan({ distanceKm, imported, buildingId: building.id, lineId: line.id, qd: building.workersMin * 20 * utilization }), utilization };
}

export function checkPreparationYear() {
  const annual = [yearlyPlan(), yearlyPlan({ productionToDemand: true }), yearlyPlan({ productionToDemand: true, demandFactor: 0.5 })];
  // The approved development corrections now choose a 24-building route with
  // a warehouse, rather than the historical 26-building route with an elevator.
  // Keep exact route, capacity and cash contracts for the reconstructed inputs.
  assert.deepEqual(annual[0].constructionRoute, ["well", "barracks", "lumbermill", "common-house", "garden", "grain-field", "barn", "watch-post", "mill", "bakery", "school", "distillery", "writing-workshop", "tailor-shop", "warehouse", "mine", "tool-workshop", "market"]);
  assert.ok(annual.every((row) => row.buildings.length === 24 && row.storageCapacity === 1600));
  for (const row of annual) {
    const workFor = (source) => row.periods.flatMap((period) => period.workers).flatMap((worker) => worker.assignments)
      .filter((assignment) => assignment.source === source && assignment.functionId !== "maintenance").reduce((sum, assignment) => sum + assignment.qd, 0);
    assert.equal(workFor("mill"), 800, "4,800 flour requires 800 current six-unit milling cycles");
    assert.equal(workFor("bakery"), 600, "4,800 bread requires 200 current 24-unit baking cycles at three QD each");
    assert.equal(row.periods.reduce((sum, period) => sum + period.foodInputsCopper, 0), 2000, "200 baking cycles must pay for 200 fuel at ten copper each");
  }
  // V18 saves 200 bakery QD at 9 copper but adds 200 fuel at 10 copper:
  // each previously recorded annual cash result therefore falls by 200 copper.
  assert.deepEqual(annual.map((row) => row.cashNet), [-45014, -37670, -38102], "current recipes, paid heating inputs, manual fields and direct-QD maintenance funding contract");
  assert.equal(annual[0].periods.reduce((sum, row) => sum + row.sold, 0), annual[1].periods.reduce((sum, row) => sum + row.sold, 0));
  assert.ok(annual[1].cashNet > annual[0].cashNet, "Matching production to demand must avoid unsold inventory costs");
  assert.equal(annual[1].finalTools, 0);
  assert.ok(annual[2].cashNet < annual[1].cashNet, "A demand slump must increase the owner's funding requirement");
  const industry = [30, 120, 300].flatMap((distance) => [0.5, 1].flatMap((load) => [false, true].map((imported) => industrialPlan(distance, load, imported))));
  assert.equal(industry.length, 12);
  for (const row of industry.filter((entry) => entry.imported)) {
    const local = industry.find((entry) => !entry.imported && entry.distanceKm === row.distanceKm && entry.utilization === row.utilization);
    assert.ok(row.net < local.net, "Paid inbound transport must not improve the margin");
  }
  return { scope: "Funded 24-period planning model with actual agriculture, FIFO, ration, demand and logistics helpers; no Foundry or world writes.",
    limitations: ["All residents are qualified adults. Only the current direct-QD technical-maintenance model is simulated; superseded point models are removed.",
      "Idle support buildings retain base upkeep; selective maintenance applies only to active technical objects. No new construction occurs during the year.",
      "Demand morale factor is tested at 1 and 0.5, not derived from a full resident-morale simulation.",
      "No random disasters, illness or construction amortization. Industrial demand/stock are finite for one batch, not a guaranteed recurring contract.",
      "Cash requirement is calculated for a fully funded plan; unfunded runtime would stop work instead of allowing negative treasury.",
      "Shipping time uses an explicitly declared test schedule of one QD plus ceil(km/20); infrastructure construction costs are not part of isolated factory profit."], annual, industry };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const report = checkPreparationYear();
  const output = process.argv.indexOf("--output");
  if (output >= 0) writeFileSync(process.argv[output + 1], JSON.stringify(report, null, 2));
  for (const row of report.annual) console.log(JSON.stringify({ maintenance: row.maintenanceModel, productionToDemand: row.productionToDemand, annualMaintenanceQd: row.annualMaintenanceQd, demand: row.demandFactor, buildings: row.buildings.length, tradePeriods: row.tradePeriods,
    cashNet: row.cashNet, funding: row.requiredStartingCash, economicNet: row.economicNetIncludingConsumedFoodAndStock, finalGrain: row.finalGrain, finalTools: row.finalTools, peakLoad: row.peakLoad }));
  console.log(JSON.stringify(report.industry));
}
