import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_BUILDING_TEMPLATES as templates } from "../data/building-templates.js";
import { DEFAULT_SKYHOLD_DATA } from "../data/defaults/default-skyhold-data.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { SkyholdData } from "../data/store.js";
import { SkyholdWorkflowService } from "../workflows/skyhold-workflow-service.js";
import { beginPerishableStoragePeriod, finishPerishableStoragePeriod } from "../engines/economy/perishable-storage.js";
import { MAINTENANCE_WORK_FUNCTION_ID } from "../data/work-allocations.js";
import { preparationProductionTradePlan } from "./economy-preparation-year-check.mjs";
import { marketDemandKey } from "../data/market/demand-state.js";
import { planMarketOutboundSale } from "../engines/market/outbound.js";
import { marketOutboundAvailableQuantity } from "../engines/market/outbound.js";
import { createMarketOutboundShipment } from "../workflows/market/outbound-shipment.js";
import { parseResourceCosts, resourceDef } from "../core/resources.js";

const total = (h, id) => h.storage.resources.filter((r) => r.resourceId === id).reduce((sum, r) => sum + r.qty, 0);
export async function settlementScenario({ population = 12, demandFactor = 1, priceFactor = 1, missedSowing = false, relief = false } = {}) {
  const savedGame = globalThis.game, savedView = SkyholdData.view;
  globalThis.game = { user: { id: "gm", isGM: true }, settings: { get: () => undefined }, modules: new Map(), i18n: { localize: (s) => s } };
  const app = new SkyholdWorkflowService();
  // Only the external calendar provider and random transport incident draw are replaced.
  // Production, finance, planning, food, storage, agriculture and delivery are real runtime domains.
  app._agricultureCalendarContext = (h, offset = 0) => {
    const qd = h.gm.calendaria.lastQd + offset, year = 1 + Math.floor(qd / 960);
    const seasonId = ["spring", "summer", "autumn", "winter"][Math.floor(qd / 240) % 4];
    return { year, seasonId, seasonKey: year + ":" + seasonId };
  };
  const dependencies = app._marketShipmentDependencies.bind(app);
  app._marketShipmentDependencies = () => ({ ...dependencies(), riskUnit: () => 1 });
  // Allocate part of the declared grain stock to a circulating flour buffer.
  // Real QD scheduling cannot spend milling output before that QD completes.
  const initialMoney = 1000000, initialFlour = population * 10, initialGrain = population * 150 - initialFlour;
  let h = mergeHoldingDefaults({ id: "scenario-village", name: "Сценарий", overview: { reputation: 0 },
    people: { list: Array.from({ length: population }, (_, i) => ({ id: "p" + i, name: "Житель " + i, age: 30,
      attributes: { strength: 3, agility: 3, wits: 3, empathy: 3 }, workAllocationMode: "explicit", workAllocations: [] })) },
    buildings: { list: [] }, storage: { moneyCopper: initialMoney, resources: [{ id: "seed-stock", resourceId: "grain", qty: initialGrain,
      roomId: "barn0", batches: [{ id: "initial-grain", qty: initialGrain, ageQd: 0 }] },
    { id: "milling-buffer", resourceId: "flour", qty: initialFlour, roomId: "barn0",
      batches: [{ id: "initial-flour", qty: initialFlour, ageQd: 0 }] }] } });
  function add(id, count = 1) {
    const template = templates.find((row) => row.id === id);
    assert.ok(template, id);
    for (let i = 0; i < count; i++) {
      const b = structuredClone(template);
      Object.assign(b, { id: id + i, templateId: id, built: true, constructionStatus: "built", status: "Построено",
        buildProgress: b.buildTarget, assignedWorkerIds: [] });
      for (const [j, line] of (b.productionLines ?? []).entries()) line.active = j === 0;
      h.buildings.list.push(b);
    }
  }
  add("grain-field", Math.ceil(population / 3.5));
  add("mill", Math.ceil(population / 12)); add("bakery", Math.ceil(population / 12));
  add("barn", Math.ceil(population / 10)); add("common-house", Math.ceil(population / 10)); add("well");
  add("lumbermill");
  if (population >= 50) { add("quarry"); add("bathhouse"); add("meeting-house"); }
  h = mergeHoldingDefaults(h);
  SkyholdData.view = () => ({ ...DEFAULT_SKYHOLD_DATA, holdings: [h] });
  const periods = [];
  try {
    for (let period = 0; period < 48; period++) {
      if (relief && period === 24) {
        // Explicit outside aid: sixty days of prepared food plus grain for the next crop.
        for (const [id, qty] of [["canned-protein", population * 60], ["grain", population * 150]]) {
          h.storage.resources.push({ id: "relief-" + id, resourceId: id, qty, roomId: "outdoors",
            batches: [{ id: "relief-batch-" + id, qty, ageQd: 0 }] });
        }
      }
      for (const p of h.people.list) p.workAllocations = [];
      for (const b of h.buildings.list) b.assignedWorkerIds = [];
      const millLine = h.buildings.list.find((b) => b.templateId === "mill").productionLines[0];
      const bakeryLine = h.buildings.list.find((b) => b.templateId === "bakery").productionLines[0];
      const bakeryInputs = parseResourceCosts(bakeryLine.expenses);
      const bakeryCycles = Math.ceil(Math.max(0, population * 10 - total(h, "bread")) / bakeryLine.outputQty);
      const flourPerCycle = bakeryInputs.find((input) => input.resourceId === "flour").qty;
      const millCycles = Math.ceil(Math.max(0, initialFlour + bakeryCycles * flourPerCycle - total(h, "flour")) / millLine.outputQty);
      let personIndex = 0, plannedQd = 0, flourNeed = millCycles * millLine.workQd, breadNeed = bakeryCycles * bakeryLine.workQd;
      // A declared local supplier provides finite heating inputs at catalog
      // prices. These paid purchases are part of the owner-funded scenario.
      let heatingInputCost = 0;
      for (const input of bakeryInputs.filter((row) => row.resourceId !== "flour")) {
        const qty = Math.max(0, bakeryCycles * input.qty - total(h, input.resourceId));
        if (!qty) continue;
        const cost = qty * resourceDef(input.resourceId).basePriceCopper;
        assert.ok(h.storage.moneyCopper >= cost, "heating inputs must be paid before baking starts");
        h.storage.moneyCopper -= cost;
        heatingInputCost += cost;
        h.storage.resources.push({ id: `heating-${input.resourceId}-${period}`, resourceId: input.resourceId, qty, roomId: "outdoors" });
      }
      const job = (b, fn, qd) => {
        if (qd <= 0) return;
        const p = h.people.list[personIndex++];
        assert.ok(p, "The plan must fit the real population");
        const amount = Math.min(20, qd);
        p.workAllocations = [{ id: "job-" + p.id, sourceId: b.id, functionId: fn, normalQd: amount, overtimeQd: 0 }];
        b.assignedWorkerIds.push(p.id); plannedQd += amount;
      };
      for (const b of h.buildings.list) {
        if (b.maintenance.requiredPoints > 0) job(b, MAINTENANCE_WORK_FUNCTION_ID, b.maintenance.requiredPoints);
        if (b.agriculture && app._agricultureNeedsLabor(b.agriculture, h) && !(missedSowing && period < 6)) job(b, "agriculture", 20);
        if (["mill", "bakery"].includes(b.templateId)) {
          const line = b.productionLines[0];
          const slots = Math.max(0, b.workersMax - b.assignedWorkerIds.length);
          for (let slot = 0; slot < slots; slot++) {
            const need = b.templateId === "mill" ? flourNeed : breadNeed;
            // Split workers at completed recipe cycles, not at an arbitrary
            // 20-QD boundary that leaves several ovens with unfinished batches.
            const amount = Math.min(Math.floor(20 / line.workQd) * line.workQd, need);
            if (!amount) break;
            job(b, "production:" + line.id, amount);
            if (b.templateId === "mill") flourNeed -= amount;
            else breadNeed -= amount;
          }
        }
        if (["bathhouse", "meeting-house"].includes(b.templateId)) for (let i = 0; i < b.workersMin; i++) job(b, "culture", 20);
        if (["lumbermill", "quarry"].includes(b.templateId)) for (let i = 0; i < Math.max(1, b.workersMin); i++) job(b, "production:" + b.productionLines[0].id, 20);
      }
      assert.equal(flourNeed, 0, "the built mills must cover all planned flour work");
      assert.equal(breadNeed, 0, "the built bakeries must cover all planned bread work");
      beginPerishableStoragePeriod(h);
      const report = await app._runEconomyForQd(h, 40, { operationId: "year-" + period, createdAt: "2026-10-08", data: SkyholdData.view() });
      finishPerishableStoragePeriod({ holding: h, elapsedQd: 40, report, appendLedger: () => {}, formatNumber: String });
      h.gm.calendaria.lastQd += 40;
      for (const b of h.buildings.list.filter((row) => ["bathhouse", "meeting-house"].includes(row.templateId))) {
        assert.equal(b.serviceState?.active, true, b.templateId + " must be staffed and funded");
      }
      if (population >= 20) for (const buildingId of population >= 50 ? ["lumbermill", "quarry"] : ["lumbermill"]) {
        const b = h.buildings.list.find((row) => row.templateId === buildingId), line = b.productionLines[0], id = line.resourceId;
        const demandState = h.special.market.demand?.[marketDemandKey("regional-port", id)];
        const baseDemand = Math.floor((id === "wood" ? 300 : 240) * demandFactor);
        const available = marketOutboundAvailableQuantity({ resources: h.storage.resources, outboundState: h.special.market.outbound, resourceId: id });
        const qty = Math.floor(Math.min(available, demandState?.availableDemand ?? baseDemand, id === "wood" ? 40 : 80) / line.outputQty) * line.outputQty;
        if (!qty) continue;
        const shipping = preparationProductionTradePlan({ distanceKm: 120, imported: false, buildingId, lineId: line.id, qd: qty / line.outputQty * line.workQd });
        const plan = planMarketOutboundSale({ resources: h.storage.resources, outboundState: h.special.market.outbound,
          marketId: "regional-port", marketLabel: "Региональный порт", routes: [shipping.outboundRoute], treasuryCopper: h.storage.moneyCopper,
          lines: [{ id, resourceId: id, demandId: id, name: id, qty,
            unitPriceCopper: Math.round(resourceDef(id).basePriceCopper * priceFactor),
            demandBaseDemand: baseDemand, demandStateRevision: demandState?.revision ?? 0 }] });
        assert.equal(plan.ok, true, plan.message);
        const order = createMarketOutboundShipment({ holding: h, plan, operationId: "sale-" + id + "-" + period, dependencies: app._marketShipmentDependencies() });
        assert.equal(order.ok, true, order.message);
      }
      periods.push({ period: period + 1, foodEaten: report.food.eaten, needed: report.food.needed, hunger: h.gm.food.hungerLevel,
        cash: h.storage.moneyCopper, debt: report.treasury.deficit, grain: total(h, "grain"), wood: total(h, "wood"), stone: total(h, "stone"),
        freeQd: population * 20 - plannedQd, heatingInputCost,
        deliveryRevenue: report.marketOutbound?.delivered?.reduce((sum, row) => sum + row.revenueCopper, 0) ?? 0 });
      h = mergeHoldingDefaults(h);
    }
    const years = [0, 1].map((year) => {
      const rows = periods.slice(year * 24, year * 24 + 24), before = year ? periods[year * 24 - 1].cash : initialMoney;
      return { year: year + 1, cashChange: rows.at(-1).cash - before, ownerFunding: Math.max(0, before - rows.at(-1).cash),
        foodEaten: rows.reduce((sum, row) => sum + row.foodEaten, 0), expectedFood: population * 240,
        hungryPeriods: rows.filter((row) => row.hunger > 0).length, closingGrain: rows.at(-1).grain,
        annualFreeQd: rows.reduce((sum, row) => sum + row.freeQd, 0),
        minimumFreeLaborPct: Math.round(Math.min(...rows.map((row) => row.freeQd)) / (population * 20) * 100),
        heatingInputCost: rows.reduce((sum, row) => sum + row.heatingInputCost, 0),
        exportReceipts: rows.reduce((sum, row) => sum + row.deliveryRevenue, 0), debt: rows.at(-1).debt };
    });
    return { population, demandFactor, priceFactor, missedSowing, relief, initialGrain, initialFlour,
      heatingInputs: "Finite local purchases at catalog prices, debited before each period's production.",
      reliefInputs: relief ? { "canned-protein": population * 60, grain: population * 150 } : {},
      buyerBaseDemand: { wood: Math.floor(300 * demandFactor), stone: Math.floor(240 * demandFactor) },
      startingCashNeed: initialMoney - Math.min(initialMoney, ...periods.map((row) => row.cash)),
      closingReceivables: (h.special.market.outbound?.orders ?? []).filter((order) => !["delivered", "lost", "cancelled"].includes(order.status))
        .reduce((sum, order) => sum + order.revenueCopper, 0), years, periods };
  } finally { globalThis.game = savedGame; SkyholdData.view = savedView; }
}
export async function checkSettlementScenarios() {
  const rows = [];
  for (const options of [{ population: 12 }, { population: 20 }, { population: 50 }, { population: 20, demandFactor: 0.5, priceFactor: 0.9 }, { population: 50, demandFactor: 0.5, priceFactor: 0.9 }, { population: 12, missedSowing: true }, { population: 12, missedSowing: true, relief: true }]) {
    const result = await settlementScenario(options);
    if (!result.missedSowing) for (const year of result.years) {
      assert.equal(year.hungryPeriods, 0, "normal and market-stress scenarios must remain food-autonomous");
      assert.equal(year.foodEaten, year.expectedFood);
      assert.equal(year.debt, 0, "owner-funded upkeep is paid");
      assert.ok(year.minimumFreeLaborPct >= 10, "seasonal work keeps at least 10% reserve");
    }
    else assert.ok(result.years[0].hungryPeriods > 0, "missing sowing must expose the limits of the declared starting grain");
    if (result.relief) assert.ok(result.periods.slice(-12).every((row) => row.hunger === 0), "declared aid must permit a sustained recovery");
    rows.push(result);
  }
  return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const rows = await checkSettlementScenarios();
  const output = process.argv.indexOf("--output");
  if (output >= 0) writeFileSync(process.argv[output + 1], JSON.stringify(rows, null, 2));
  for (const row of rows) console.log(JSON.stringify({ ...row, periods: undefined }));
}
