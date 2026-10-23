import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { marketOutboundRouteFromPurchasePlan } from "../apps/market/outbound-context.js";
// This calibrated scenario prices the existing-world staffing assumptions;
// changing labor modes is covered by the explicit hybrid transition/runtime checks.
import { BUILDING_TEMPLATES_BEFORE_LABOR_TRANSITION as DEFAULT_BUILDING_TEMPLATES } from "../data/building-templates.js";
import { preparationMaintenanceNorms } from "./building-maintenance-proposal-check.mjs";
import { APPROVED_BUILDING_TEMPLATE_ID_BY_NAME } from "../data/building-template-ids.js";
import { DEFAULT_INTERNAL_DEMAND_CONFIG, internalDemandTradeDefaults } from "../data/economy/internal-demand.js";
import { livestockProfileForSpecies } from "../data/livestock.js";
import { allResourceDefs, parseResourceCosts } from "../core/resources.js";
import { foodRationTarget } from "../engines/economy/food-rations.js";
import { buildInternalDemandPools, planInternalDemand } from "../engines/economy/internal-demand.js";
import { planLivestockTenday } from "../engines/economy/livestock.js";
import { resolveMarketLogistics } from "../engines/market/logistics.js";
import { planMarketOutboundSale } from "../engines/market/outbound.js";
import { planMarketPurchase } from "../engines/market/pricing.js";
import {
  BUILDING_LIVESTOCK_PROFILES,
  BUILDING_PRODUCTION_ECONOMY,
  BUILDING_SEASONAL_PROFILES
} from "./building-production-line-proposal-data.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const marketPack = JSON.parse(readFileSync(path.join(root, "examples/content-packs/air-islands-materials-and-country-markets.json"), "utf8"));
const packResourceRows = marketPack?.content?.resources ?? [];
const builtinResources = allResourceDefs({ catalogRows: [] });
const calibratedResources = allResourceDefs({ catalogRows: packResourceRows });
const builtinById = new Map(builtinResources.map((row) => [row.id, row]));
const resourcesById = new Map(calibratedResources.map((row) => [row.id, row]));
const templatesById = new Map(DEFAULT_BUILDING_TEMPLATES.map((row) => [row.id, row]));
const approvedEconomicTemplateIds = Object.freeze([...new Set([
  ...Object.keys(BUILDING_PRODUCTION_ECONOMY),
  ...BUILDING_SEASONAL_PROFILES.map((row) => row.building),
  ...BUILDING_LIVESTOCK_PROFILES.map((row) => row.building),
  "Рынок",
  "Управление кадров"
].map((name) => APPROVED_BUILDING_TEMPLATE_ID_BY_NAME[name]))].filter(Boolean));

const TENDAY_QD = 40;
const NORMAL_WORK_QD = 20;
const DAYS_PER_TENDAY = 10;
const CAMPAIGN_YEAR_TENDAYS = 24;

// The scenario mirrors the integer v1 defaults stored in the building catalog.
// Agriculture rows below are scenario-normalized throughput figures, not hidden
// daily production lines: the runtime field/garden remains seasonal.
const RUNTIME_ECONOMY_V2 = Object.freeze({
  wageDailyCopper: Object.freeze({ basic: 12, skilled: 18, hazardous: 18, trade: 18 }),
  baseUpkeepMonthlyCopper: "3 * max(1, legacy upkeep)",
  operatingUpkeepMonthlyCopper: Object.freeze({ simple: 3, processing: 6, heavy: 9, trade: 9 }),
  production: Object.freeze({
    "grain-field": Object.freeze({ outputQty: 4, inputQty: 0, source: "workers", workQd: 1 }),
    mill: Object.freeze({ outputQty: 6, inputQty: 6, source: "workers", workQd: 1 }),
    bakery: Object.freeze({ outputQty: 6, inputQty: 6, source: "workers", workQd: 1 }),
    "inn-food": Object.freeze({ outputQty: 3, inputQty: 3, source: "workers", workQd: 1 }),
    forge: Object.freeze({ outputQty: 1, inputQty: 1, source: "workers", workQd: 1 }),
    tannery: Object.freeze({ outputQty: 2, inputQty: 2, source: "workers", workQd: 1 }),
    "tailor-shop": Object.freeze({ outputQty: 2, inputQty: 2, source: "workers", workQd: 1 })
  })
});

const candidateProductionLines = Object.freeze([
  { buildingId: "grain-field", lineId: "grain", outputResourceId: "grain", outputQty: 4 },
  { buildingId: "garden", lineId: "vegetables", outputResourceId: "vegetables", outputQty: 2 },
  { buildingId: "garden", lineId: "herbs", outputResourceId: "herbs", outputQty: 1, workQd: 2 },
  { buildingId: "lumbermill", lineId: "wood", outputResourceId: "wood", outputQty: 2 },
  { buildingId: "quarry", lineId: "stone", outputResourceId: "stone", outputQty: 2 },
  { buildingId: "mine", lineId: "iron-ore", outputResourceId: "iron-ore", outputQty: 2 },
  { buildingId: "mill", lineId: "flour", outputResourceId: "flour", outputQty: 6, inputResourceId: "grain", inputQty: 6 },
  { buildingId: "bakery", lineId: "bread", outputResourceId: "bread", outputQty: 6, inputResourceId: "flour", inputQty: 6 },
  { buildingId: "inn", lineId: "food-protein", outputResourceId: "food-protein", outputQty: 3, inputResourceId: "meat", inputQty: 3 },
  { buildingId: "inn", lineId: "food-fruit", outputResourceId: "food-fruit", outputQty: 3, inputResourceId: "vegetables", inputQty: 3 },
  { buildingId: "inn", lineId: "food-dairy", outputResourceId: "food-dairy", outputQty: 3, inputResourceId: "milk", inputQty: 3 },
  { buildingId: "forge", lineId: "iron", outputResourceId: "iron", outputQty: 1, inputResourceId: "iron-ore", inputQty: 1 },
  { buildingId: "tannery", lineId: "leather", outputResourceId: "leather", outputQty: 2, inputResourceId: "pelt", inputQty: 2 },
  { buildingId: "tailor-shop", lineId: "cloth", outputResourceId: "cloth", outputQty: 2, inputResourceId: "wool", inputQty: 2 }
]);

function whole(value, fallback = 0) {
  const parsed = Number(value);
  return Math.max(0, Math.floor(Number.isFinite(parsed) ? parsed : fallback));
}

function oneDecimal(value) {
  return Number((Number(value) || 0).toFixed(1));
}

function price(resourceId) {
  return whole(resourcesById.get(resourceId)?.basePriceCopper);
}

function costPrice(cost = {}) {
  if (!cost.resourceGroup) return price(cost.resourceId);
  const candidates = calibratedResources
    .filter((resource) => resource.categoryTag === cost.resourceGroup && !resource.noAutoConsume)
    .map((resource) => whole(resource.basePriceCopper))
    .filter((value) => value > 0);
  return candidates.length ? Math.min(...candidates) : 0;
}

function loadPoints(resourceId) {
  return whole(resourcesById.get(resourceId)?.loadPoints);
}

function candidateDailyWage(buildingId) {
  return whole(templatesById.get(buildingId)?.wageDailyCopper);
}

function candidateBaseUpkeepMonthly(buildingId) {
  return whole(templatesById.get(buildingId)?.baseUpkeepMonthlyCopper);
}

function candidateOperatingUpkeepMonthly(buildingId) {
  return whole(templatesById.get(buildingId)?.operatingUpkeepMonthlyCopper);
}

function candidateTendayCashCost(buildingId, workers = 1, activeFunctions = 1) {
  const wage = candidateDailyWage(buildingId) * DAYS_PER_TENDAY * whole(workers);
  const upkeepMonthly = candidateBaseUpkeepMonthly(buildingId)
    + candidateOperatingUpkeepMonthly(buildingId) * whole(activeFunctions);
  return { wage, upkeepAverage: upkeepMonthly / 3, total: wage + upkeepMonthly / 3 };
}

function productionLineMargin(building, line) {
  const source = String(line.source ?? "workers");
  const workQd = Math.max(1, whole(line.workQd, 1));
  const cycles = source === "workers"
    ? Math.floor(NORMAL_WORK_QD / workQd)
    : (String(line.period ?? "day") === "tenday" ? 1 : (String(line.period ?? "day") === "qd" ? TENDAY_QD : DAYS_PER_TENDAY));
  const outputQty = whole(line.outputQty) * cycles;
  const outputValueCopper = outputQty * price(line.resourceId);
  const parsedCosts = parseResourceCosts(line.expenses);
  const inputValueCopper = parsedCosts.reduce((sum, row) => sum + row.qty * costPrice(row) * cycles, 0);
  const laborCopper = source === "workers" ? candidateDailyWage(building.id) * DAYS_PER_TENDAY : 0;
  const grossMarginCopper = outputValueCopper - inputValueCopper;
  return {
    buildingId: building.id,
    lineId: line.id,
    resourceId: line.resourceId,
    source,
    cycles,
    outputQty,
    outputValueCopper,
    inputValueCopper,
    grossMarginCopper,
    candidateLaborCopper: laborCopper,
    candidateNetBeforeUpkeepCopper: grossMarginCopper - laborCopper,
    grossMarginPctOfInputs: inputValueCopper > 0 ? oneDecimal((grossMarginCopper / inputValueCopper) * 100) : null,
    autonomous: source !== "workers"
  };
}

function currentProductionMargins() {
  return DEFAULT_BUILDING_TEMPLATES.flatMap((building) => (building.productionLines ?? [])
    .filter((line) => line?.active !== false)
    .map((line) => productionLineMargin(building, line)))
    .filter((row) => row.outputValueCopper > 0)
    .sort((left, right) => right.candidateNetBeforeUpkeepCopper - left.candidateNetBeforeUpkeepCopper || left.buildingId.localeCompare(right.buildingId));
}

function candidateProductionMargins() {
  return candidateProductionLines.map((line) => {
    const workQd = Math.max(1, whole(line.workQd, 1));
    const cycles = Math.floor(NORMAL_WORK_QD / workQd);
    const outputQty = line.outputQty * cycles;
    const inputQty = whole(line.inputQty) * cycles;
    const outputValueCopper = outputQty * price(line.outputResourceId);
    const inputValueCopper = inputQty * price(line.inputResourceId);
    const wageCopper = candidateDailyWage(line.buildingId) * DAYS_PER_TENDAY;
    const upkeepAverageCopper = (candidateBaseUpkeepMonthly(line.buildingId) + candidateOperatingUpkeepMonthly(line.buildingId)) / 3;
    return {
      ...line,
      workQd,
      cycles,
      outputQty,
      inputQty,
      outputValueCopper,
      inputValueCopper,
      grossMarginCopper: outputValueCopper - inputValueCopper,
      wageCopper,
      upkeepAverageCopper: oneDecimal(upkeepAverageCopper),
      netEconomicMarginCopper: oneDecimal(outputValueCopper - inputValueCopper - wageCopper - upkeepAverageCopper)
    };
  }).sort((left, right) => right.netEconomicMarginCopper - left.netEconomicMarginCopper || left.buildingId.localeCompare(right.buildingId));
}

function financeConfigurationGaps() {
  const economicTemplates = DEFAULT_BUILDING_TEMPLATES.filter((building) => (
    building?.functions?.production || building?.functions?.income || building?.livestock?.enabled
  ));
  return {
    economicTemplates: economicTemplates.length,
    zeroBaseUpkeepTemplates: economicTemplates.filter((building) => whole(building.baseUpkeepMonthlyCopper) === 0).map((building) => building.id),
    zeroBuildingWageTemplates: economicTemplates.filter((building) => whole(building.wageDailyCopper) === 0).map((building) => building.id),
    zeroProductionLineWages: economicTemplates.flatMap((building) => (building.productionLines ?? [])
      .filter((line) => line?.active !== false && (whole(line.wageDailyCopper) || whole(building.wageDailyCopper)) === 0)
      .map((line) => `${building.id}:${line.id}`)),
    zeroProductionLineOperatingUpkeep: economicTemplates.flatMap((building) => (building.productionLines ?? [])
      .filter((line) => line?.active !== false && (whole(line.operatingUpkeepMonthlyCopper) || whole(building.operatingUpkeepMonthlyCopper)) === 0)
      .map((line) => `${building.id}:${line.id}`)),
    zeroIncomeWages: economicTemplates.filter((building) => building?.functions?.income
      && (whole(building?.income?.wageDailyCopper) || whole(building.wageDailyCopper)) === 0).map((building) => building.id),
    zeroIncomeOperatingUpkeep: economicTemplates.filter((building) => building?.functions?.income
      && (whole(building?.income?.operatingUpkeepMonthlyCopper) || whole(building.operatingUpkeepMonthlyCopper)) === 0).map((building) => building.id),
    zeroMaintenanceRequirement: economicTemplates.filter((building) => building?.maintenance?.schemaVersion !== 2 && whole(building?.maintenance?.requiredPoints) === 0).map((building) => building.id),
    livestockWithoutPaidBuildingFunction: economicTemplates.filter((building) => building?.livestock?.enabled
      && (whole(building.wageDailyCopper) === 0 || whole(building.operatingUpkeepMonthlyCopper) === 0)).map((building) => building.id),
    agricultureWithoutPaidBuildingFunction: economicTemplates.filter((building) => building?.agriculture?.enabled
      && (whole(building.wageDailyCopper) === 0 || whole(building.operatingUpkeepMonthlyCopper) === 0)).map((building) => building.id)
  };
}

function runtimeProductionContract() {
  const lineById = (buildingId, lineId) => templatesById.get(buildingId)?.productionLines?.find((row) => row.id === lineId);
  const millFeed = lineById("mill", "line-feed");
  const innPlantFood = lineById("inn", "line-2");
  const forge = lineById("forge", "line");
  return {
    economicTemplateIds: [...approvedEconomicTemplateIds],
    millFeed: {
      outputResourceId: millFeed?.resourceId,
      outputQty: whole(millFeed?.outputQty),
      expenses: String(millFeed?.expenses ?? "")
    },
    innPlantFood: {
      outputResourceId: innPlantFood?.resourceId,
      outputQty: whole(innPlantFood?.outputQty),
      expenses: String(innPlantFood?.expenses ?? "")
    },
    forge: {
      outputResourceId: forge?.resourceId,
      outputQty: whole(forge?.outputQty),
      expenses: String(forge?.expenses ?? "")
    }
  };
}

function canonicalConflicts() {
  return packResourceRows.flatMap((row) => {
    const builtin = builtinById.get(row.id);
    if (!builtin) return [];
    const fields = ["basePriceCopper", "loadPoints"].filter((field) => whole(builtin[field]) !== whole(row[field]));
    return fields.length ? [{
      resourceId: row.id,
      fields,
      builtin: Object.fromEntries(fields.map((field) => [field, whole(builtin[field])])),
      fullPack: Object.fromEntries(fields.map((field) => [field, whole(row[field])]))
    }] : [];
  });
}

function loadDistribution() {
  const rows = calibratedResources.filter((row) => !row.isMoney);
  const foodRows = builtinResources.filter((row) => ["food.raw", "food.prepared"].includes(row.categoryTag));
  const frequencies = new Map();
  for (const row of rows) frequencies.set(loadPoints(row.id), (frequencies.get(loadPoints(row.id)) ?? 0) + 1);
  return {
    fullCatalogResources: rows.length,
    quarterLoadPointCounts: Object.fromEntries([...frequencies].sort((left, right) => left[0] - right[0])),
    builtinNonMoneyResources: builtinResources.filter((row) => !row.isMoney).length,
    builtinAtFourPoints: builtinResources.filter((row) => !row.isMoney && whole(row.loadPoints) === 4).length,
    foodAtOnePoint: foodRows.filter((row) => whole(row.loadPoints) === 1).map((row) => row.id),
    foodNotAtOnePoint: foodRows.filter((row) => whole(row.loadPoints) !== 1).map((row) => row.id)
  };
}

function internalDemand({ population, innEfficiency, marketEfficiency = 0, candidates }) {
  const innDefaults = internalDemandTradeDefaults({ templateId: "inn" });
  const marketDefaults = internalDemandTradeDefaults({ templateId: "market" });
  const innSources = innEfficiency > 0 ? [{ id: "inn", budgetCopper: innDefaults.demandBudgetBaseCopper + innDefaults.demandBudgetPerWorkerCopper * innEfficiency, priority: 500 }] : [];
  const marketSources = marketEfficiency > 0 ? [{ id: "market", budgetCopper: marketDefaults.demandBudgetBaseCopper + marketDefaults.demandBudgetPerWorkerCopper * marketEfficiency, priority: 500 }] : [];
  const pools = buildInternalDemandPools({
    populationCount: population,
    populationBudgetPerResidentCopper: DEFAULT_INTERNAL_DEMAND_CONFIG.populationBudgetPerResidentCopper,
    satisfactionFactor: 1,
    wagePaymentRatio: 1,
    innVisitorSources: innSources,
    marketFlowSources: marketSources,
    priorities: { population: 30, innVisitors: 20, marketFlow: 10 }
  });
  const channels = [];
  if (innEfficiency > 0) channels.push({
    id: "inn",
    buildingId: "inn",
    sourceIds: ["population", "inn-visitors"],
    allowedTags: ["food.prepared", "service.inn"],
    allowedKinds: ["resource", "service"],
    throughputUnits: Math.floor(innEfficiency * 5),
    sellerEfficiency: innEfficiency,
    priority: 500
  });
  if (marketEfficiency > 0) channels.push({
    id: "market",
    buildingId: "market",
    sourceIds: ["population", "market-flow"],
    allowedTags: ["all"],
    allowedKinds: ["resource"],
    throughputUnits: Math.floor(marketEfficiency * 8),
    sellerEfficiency: marketEfficiency,
    priority: 500
  });
  return planInternalDemand({ pools, channels, candidates, operationId: "calibration" });
}

function innServiceCandidate(efficiency) {
  const service = internalDemandTradeDefaults({ templateId: "inn" }).service;
  return {
    id: "service:inn",
    kind: "service",
    name: "Inn service",
    qty: Math.floor(efficiency * 2),
    basePriceCopper: service.basePriceCopper,
    categoryTag: "service.inn",
    tags: ["service.inn"],
    sourceIds: ["inn-visitors"],
    channelId: "inn"
  };
}

function resourceCandidate(resourceId, qty, { expiresInQd = null } = {}) {
  const resource = resourcesById.get(resourceId) ?? {};
  return {
    id: `resource:${resourceId}`,
    kind: "resource",
    name: resource.label ?? resourceId,
    resourceId,
    qty: whole(qty),
    basePriceCopper: price(resourceId),
    categoryTag: resource.categoryTag,
    marketTags: resource.marketTags,
    ...(expiresInQd === null ? {} : { expiresInQd })
  };
}

function laputaSurvivalScenario() {
  const population = 12;
  const gardenTemplate = templatesById.get("garden");
  const vegetableCrop = gardenTemplate?.agriculture?.crops?.find((row) => row.resourceId === "vegetables");
  const gardenVegetables = whole(vegetableCrop?.outputQty);
  const livestock = planLivestockTenday({
    state: { speciesId: "cattle", capacity: 12, adults: 10, breedingMales: 1, young: [] },
    profile: livestockProfileForSpecies("cattle"),
    elapsedQd: TENDAY_QD,
    seasonId: "summer",
    seasonKey: "calibration-summer",
    availableFeedUnits: 0,
    availableWorkQd: NORMAL_WORK_QD,
    operations: { milk: true }
  });
  const milk = whole(livestock.milk.outputQty);
  const plantLine = templatesById.get("inn").productionLines.find((line) => line.id === "line-2");
  const plantInputs = parseResourceCosts(plantLine.expenses);
  const vegetablesPerBatch = plantInputs.find((cost) => cost.resourceId === "vegetables").qty;
  // The second inn worker handles service; one qualified cook supplies 40 effective QD.
  const plantCycles = Math.min(Math.floor(NORMAL_WORK_QD * 2 / plantLine.workQd), Math.floor(gardenVegetables / vegetablesPerBatch));
  const preparedPlantFood = plantCycles * plantLine.outputQty;
  const fuelCopper = plantCycles * plantInputs.filter((cost) => cost.resourceId !== "vegetables").reduce((sum, cost) => sum + cost.qty * costPrice(cost), 0);
  const demand = internalDemand({
    population,
    innEfficiency: 2,
    candidates: [
      resourceCandidate(plantLine.resourceId, preparedPlantFood, { expiresInQd: 60 }),
      innServiceCandidate(2)
    ]
  });
  const cashCosts = ["garden", "pasture", "inn"].map((id) => candidateTendayCashCost(id));
  const wages = cashCosts.reduce((sum, row) => sum + row.wage, 0);
  const upkeep = cashCosts.reduce((sum, row) => sum + row.upkeepAverage, 0);
  const sparseNeed = foodRationTarget({ residents: population, days: DAYS_PER_TENDAY, unitsPerTenday: 5 });
  const normalNeed = foodRationTarget({ residents: population, days: DAYS_PER_TENDAY, unitsPerTenday: 10 });
  return {
    id: "survival",
    basis: "Laputa seasonal harvest plus purchased cooking fuel: Garden + Pasture (10 cattle) + Inn",
    population,
    rawOutput: { vegetables: gardenVegetables, milk },
    preparedFood: preparedPlantFood,
    fuelCopper,
    food: {
      sparseNeed,
      sparseShortfall: Math.max(0, sparseNeed - preparedPlantFood),
      normalNeed,
      normalShortfall: Math.max(0, normalNeed - preparedPlantFood)
    },
    internalRevenueCopper: demand.revenueCopper,
    candidateWagesCopper: wages,
    candidateUpkeepAverageCopper: oneDecimal(upkeep),
    cashNetBeforeImportsCopper: oneDecimal(demand.revenueCopper - wages - upkeep - fuelCopper),
    bottleneck: "The local plant-food chain is complete, but one seasonal Garden harvest is not a continuous ration supply; opening storage, imports, or additional fields remain necessary."
  };
}

function candidateFoodCluster({ population, fieldWorkers, millWorkers, bakeryWorkers }) {
  const grain = fieldWorkers * NORMAL_WORK_QD * RUNTIME_ECONOMY_V2.production["grain-field"].outputQty;
  const flour = Math.min(grain, millWorkers * NORMAL_WORK_QD * RUNTIME_ECONOMY_V2.production.mill.outputQty);
  const bread = Math.min(flour, bakeryWorkers * NORMAL_WORK_QD * RUNTIME_ECONOMY_V2.production.bakery.outputQty);
  const livestock = planLivestockTenday({
    state: { speciesId: "cattle", capacity: 12, adults: 10, breedingMales: 1, young: [] },
    profile: livestockProfileForSpecies("cattle"),
    elapsedQd: TENDAY_QD,
    seasonId: "summer",
    seasonKey: `candidate-${population}`,
    availableWorkQd: NORMAL_WORK_QD,
    operations: { milk: true }
  });
  const milk = whole(livestock.milk.outputQty);
  const dairy = Math.min(milk, NORMAL_WORK_QD * RUNTIME_ECONOMY_V2.production["inn-food"].outputQty);
  const prepared = bread + dairy;
  const needed = foodRationTarget({ residents: population, days: DAYS_PER_TENDAY, unitsPerTenday: 10 });
  return { grain, flour, bread, milk, dairy, prepared, needed, surplus: Math.max(0, prepared - needed), shortfall: Math.max(0, needed - prepared) };
}

function runtimeSeasonalAgricultureScenario() {
  const population = 12;
  const field = templatesById.get("grain-field")?.agriculture?.crops?.find((row) => row.resourceId === "grain") ?? {};
  const garden = templatesById.get("garden")?.agriculture?.crops?.find((row) => row.resourceId === "vegetables") ?? {};
  const normalFoodNeedAnnual = population * 10 * CAMPAIGN_YEAR_TENDAYS;
  const sparseFoodNeedAnnual = population * 5 * CAMPAIGN_YEAR_TENDAYS;
  const fieldOutput = whole(field.outputQty);
  const gardenOutput = whole(garden.outputQty);
  const fieldStorageLoad = fieldOutput * loadPoints("grain") / 4;
  const gardenStorageLoad = gardenOutput * loadPoints("vegetables") / 4;
  const fieldsForLaputa = Math.ceil(normalFoodNeedAnnual / Math.max(1, fieldOutput));
  const laputaFieldStorageLoad = fieldsForLaputa * fieldStorageLoad;
  const rootCellarCapacity = whole(templatesById.get("root-cellar")?.storage?.capacity);
  const barnCapacity = whole(templatesById.get("barn")?.storage?.capacity);
  const annualProcessorCapacity = NORMAL_WORK_QD * CAMPAIGN_YEAR_TENDAYS * 6;
  return {
    id: "runtime-seasonal-agriculture",
    population,
    field: {
      crop: "grain",
      outputPerHarvest: fieldOutput,
      growingQd: whole(field.growingQd),
      preparedFoodEquivalent: fieldOutput,
      personYearsAtNormalRations: oneDecimal(fieldOutput / (10 * CAMPAIGN_YEAR_TENDAYS)),
      storageLoadPerHarvest: fieldStorageLoad
    },
    garden: {
      crop: "vegetables",
      outputPerHarvest: gardenOutput,
      growingQd: whole(garden.growingQd),
      preparedFoodEquivalent: Math.floor(gardenOutput / 3) * 3,
      personYearsAtNormalRations: oneDecimal(gardenOutput / (10 * CAMPAIGN_YEAR_TENDAYS)),
      storageLoadPerHarvest: gardenStorageLoad
    },
    laputaAnnualSupply: {
      normalFoodNeed: normalFoodNeedAnnual,
      sparseFoodNeed: sparseFoodNeedAnnual,
      grainFieldsRequired: fieldsForLaputa,
      grainQty: fieldsForLaputa * fieldOutput,
      storageLoad: laputaFieldStorageLoad,
      rootCellarsRequired: Math.ceil(laputaFieldStorageLoad / Math.max(1, rootCellarCapacity)),
      barnsRequired: Math.ceil(laputaFieldStorageLoad / Math.max(1, barnCapacity)),
      oneMillWorkerAnnualCapacity: annualProcessorCapacity,
      oneBakeryWorkerAnnualCapacity: annualProcessorCapacity,
      processingChainCoversAnnualNeed: annualProcessorCapacity >= normalFoodNeedAnnual
    },
    verdict: "Three seasonal Fields plus one shared Mill worker and one shared Bakery worker cover Laputa's annual normal ration; process Grain gradually because prepared food spoils faster."
  };
}

function candidateIndustrialExport(id) {
  if (id === "iron20") {
    const shipment = outboundTrade("iron", 20);
    const functionCost = candidateTendayCashCost("forge");
    const inputOpportunityCostCopper = 20 * price("iron-ore");
    return {
      id,
      workers: 1,
      shipment,
      inputOpportunityCostCopper,
      laborAndUpkeepCopper: oneDecimal(functionCost.total),
      netAfterProductionCopper: oneDecimal(shipment.netAfterLogisticsCopper - inputOpportunityCostCopper - functionCost.total)
    };
  }
  if (id === "cloth40") {
    const shipment = outboundTrade("cloth", 40);
    const functionCost = candidateTendayCashCost("tailor-shop");
    const inputOpportunityCostCopper = 40 * price("wool");
    return {
      id,
      workers: 1,
      shipment,
      inputOpportunityCostCopper,
      laborAndUpkeepCopper: oneDecimal(functionCost.total),
      netAfterProductionCopper: oneDecimal(shipment.netAfterLogisticsCopper - inputOpportunityCostCopper - functionCost.total)
    };
  }
  throw new Error(`Unknown calibration export portfolio row: ${id}`);
}

function candidateSettlementScenario({ id, population, fieldWorkers, millWorkers, bakeryWorkers, sellerEfficiency, industrialExports = [] }) {
  const food = candidateFoodCluster({ population, fieldWorkers, millWorkers, bakeryWorkers });
  const candidates = [
    resourceCandidate("food-dairy", food.surplus, { expiresInQd: 80 }),
    resourceCandidate("wood", 40),
    innServiceCandidate(sellerEfficiency)
  ];
  const demand = internalDemand({ population, innEfficiency: sellerEfficiency, marketEfficiency: sellerEfficiency, candidates });
  const staff = [
    ...Array(fieldWorkers).fill("grain-field"),
    ...Array(millWorkers).fill("mill"),
    ...Array(bakeryWorkers).fill("bakery"),
    "pasture",
    "inn",
    "market",
    "lumbermill"
  ];
  const wage = staff.reduce((sum, buildingId) => sum + candidateDailyWage(buildingId) * DAYS_PER_TENDAY, 0);
  const buildings = [...new Set(staff)];
  const upkeep = buildings.reduce((sum, buildingId) => sum + candidateTendayCashCost(buildingId, 0).upkeepAverage, 0)
    + Math.max(0, fieldWorkers - 1) * candidateTendayCashCost("grain-field", 0).upkeepAverage
    + Math.max(0, millWorkers - 1) * candidateTendayCashCost("mill", 0).upkeepAverage
    + Math.max(0, bakeryWorkers - 1) * candidateTendayCashCost("bakery", 0).upkeepAverage;
  const soldWoodInternal = demand.sales.filter((row) => row.resourceId === "wood").reduce((sum, row) => sum + row.qty, 0);
  const remainingWood = Math.max(0, 40 - soldWoodInternal);
  const outbound = outboundTrade("wood", remainingWood);
  const industry = industrialExports.map((exportId) => candidateIndustrialExport(exportId));
  const industrialExportNetCopper = industry.reduce((sum, row) => sum + row.netAfterProductionCopper, 0);
  return {
    id,
    basis: "Cash-envelope sensitivity using 4 Grain per worker-QD; not a runtime seasonal-field forecast.",
    runtimeSeasonalEquivalent: false,
    population,
    sellerEfficiency,
    food,
    workers: staff.length + industry.reduce((sum, row) => sum + row.workers, 0),
    internalRevenueCopper: demand.revenueCopper,
    internalSales: demand.sales.map((row) => ({ poolId: row.poolId, channelId: row.channelId, resourceId: row.resourceId, kind: row.kind, qty: row.qty, unitPriceCopper: row.unitPriceCopper, revenueCopper: row.revenueCopper })),
    externalWoodQty: remainingWood,
    externalWoodNetAfterLogisticsCopper: outbound.netAfterLogisticsCopper,
    industrialExports: industry,
    industrialExportNetCopper,
    candidateWagesCopper: wage,
    candidateUpkeepAverageCopper: oneDecimal(upkeep),
    totalCashNetCopper: oneDecimal(demand.revenueCopper + outbound.netAfterLogisticsCopper + industrialExportNetCopper - wage - upkeep)
  };
}

function calibrationRoute() {
  const holding = {
    id: "calibration-holding",
    type: "sky-island",
    overview: { region: "calibration-destination" },
    gm: { modifiers: { marketConnectionsLevel: 9 } },
    storage: { moneyCopper: Number.MAX_SAFE_INTEGER }
  };
  const regions = [
    {
      value: "calibration-destination",
      label: "Calibration destination",
      marketLandmassId: "calibration-landmass",
      marketTransportModes: ["airship"],
      marketLinks: [{ regionId: "calibration-origin", distanceKm: 120, ursCost: 1, modes: ["airship"] }]
    },
    {
      value: "calibration-origin",
      label: "Calibration origin",
      marketLandmassId: "calibration-landmass",
      marketTransportModes: ["airship"],
      marketLinks: []
    }
  ];
  const market = {
    id: "calibration-market",
    label: "Calibration market",
    regionId: "calibration-origin",
    transportModes: ["airship"],
    baseDeliveryQd: 2,
    airshipCapacityLoad: 4000,
    airshipHireCopper: 120
  };
  const logistics = resolveMarketLogistics({ holding, market, regions });
  return { holding, market, logistics };
}

const routeFixture = calibrationRoute();

function outboundTrade(resourceId, quantity, unitPriceCopper = price(resourceId)) {
  const qty = whole(quantity);
  if (!qty) return { resourceId, qty: 0, unitPriceCopper, revenueCopper: 0, upfrontCopper: 0, netAfterLogisticsCopper: 0, marginPct: 0 };
  const offer = {
    id: `calibration-offer:${resourceId}`,
    resourceId,
    name: resourceId,
    kind: "material",
    stock: qty,
    unitPriceCopper,
    basePriceCopper: unitPriceCopper,
    load: loadPoints(resourceId) / 4
  };
  const purchasePlan = planMarketPurchase({
    holding: routeFixture.holding,
    quote: {
      marketId: routeFixture.market.id,
      marketLabel: routeFixture.market.label,
      location: { deliveryFlatCopper: 8, deliveryLoadCopper: 1, deliverySubtotalRate: 0.02, deliveryQdFactor: 1 },
      logistics: routeFixture.logistics,
      deliveryMode: "scheduled",
      deliveryQd: 7,
      offers: [offer]
    },
    quantities: { [offer.id]: qty },
    serviceLevel: "standard"
  });
  const route = marketOutboundRouteFromPurchasePlan(purchasePlan);
  const plan = planMarketOutboundSale({
    resources: [{ id: `row:${resourceId}`, resourceId, qty, batches: [{ id: "batch", qty, ageQd: 0 }] }],
    outboundState: { orders: [] },
    lines: [{
      id: `line:${resourceId}`,
      resourceId,
      demandId: resourceId,
      name: resourceId,
      qty,
      unitPriceCopper,
      demandBaseDemand: qty,
      demandStateRevision: 0
    }],
    routes: [route],
    treasuryCopper: Number.MAX_SAFE_INTEGER,
    insuranceEnabled: true
  });
  return {
    resourceId,
    qty,
    unitPriceCopper,
    load: qty * loadPoints(resourceId) / 4,
    revenueCopper: plan.revenueCopper,
    freightCopper: plan.freightCopper,
    tariffCopper: plan.tariffCopper,
    insuranceCopper: plan.insuranceCopper,
    upfrontCopper: plan.upfrontCopper,
    netAfterLogisticsCopper: plan.revenueCopper - plan.upfrontCopper,
    marginPct: oneDecimal(((plan.revenueCopper - plan.upfrontCopper) / Math.max(1, plan.revenueCopper)) * 100)
  };
}

function transportScenario() {
  const cargo = [
    outboundTrade("wood", 1),
    outboundTrade("wood", 10),
    outboundTrade("wood", 40),
    outboundTrade("stone", 40),
    outboundTrade("iron", 20),
    outboundTrade("cloth", 40)
  ];
  const woodBatch = cargo.find((row) => row.resourceId === "wood" && row.qty === 40);
  const woodProductionCost = candidateTendayCashCost("lumbermill");
  const ironBatch = cargo.find((row) => row.resourceId === "iron");
  const ironProductionCost = {
    inputs: 20 * price("iron-ore"),
    ...candidateTendayCashCost("forge")
  };
  return {
    id: "trade",
    route: {
      mode: routeFixture.logistics.transportMode,
      distanceKm: routeFixture.logistics.distanceKm,
      capacityLoad: routeFixture.logistics.capacityLoad,
      standardBookingCapacityLoad: routeFixture.logistics.capacityLoad * 0.2,
      travelQd: routeFixture.logistics.travelQd
    },
    cargo,
    fullWorkerBatches: {
      wood40: {
        netAfterLogisticsCopper: woodBatch.netAfterLogisticsCopper,
        candidateLaborAndUpkeepCopper: oneDecimal(woodProductionCost.total),
        netAfterProductionCopper: oneDecimal(woodBatch.netAfterLogisticsCopper - woodProductionCost.total)
      },
      iron20: {
        netAfterLogisticsCopper: ironBatch.netAfterLogisticsCopper,
        inputOpportunityCostCopper: ironProductionCost.inputs,
        candidateLaborAndUpkeepCopper: oneDecimal(ironProductionCost.total),
        netAfterProductionCopper: oneDecimal(ironBatch.netAfterLogisticsCopper - ironProductionCost.inputs - ironProductionCost.total)
      }
    }
  };
}

function annualFoodProvisioningScenario(population = 20) {
  const field = templatesById.get("grain-field");
  const mill = templatesById.get("mill");
  const bakery = templatesById.get("bakery");
  const grainCrop = field?.agriculture?.crops?.find((row) => row.resourceId === "grain");
  const flourLine = mill?.productionLines?.find((row) => row.resourceId === "flour");
  const breadLine = bakery?.productionLines?.find((row) => row.resourceId === "bread");
  const annualNeed = population * 10 * CAMPAIGN_YEAR_TENDAYS;
  const fields = Math.ceil(annualNeed / Math.max(1, whole(grainCrop?.outputQty)));
  const grainQty = fields * whole(grainCrop?.outputQty);
  const processingCycles = Math.ceil(annualNeed / Math.max(1, whole(breadLine?.outputQty)));
  const breadInputs = parseResourceCosts(breadLine?.expenses);
  const flourRequired = processingCycles * (breadInputs.find((cost) => cost.resourceId === "flour")?.qty ?? 0);
  const flourCycles = Math.ceil(flourRequired / Math.max(1, whole(flourLine?.outputQty)));
  const flourQd = flourCycles * Math.max(1, whole(flourLine?.workQd, 1));
  const bakeryQd = processingCycles * Math.max(1, whole(breadLine?.workQd, 1));
  const annualWorkerCapacityQd = NORMAL_WORK_QD * CAMPAIGN_YEAR_TENDAYS;
  const millWorkers = Math.ceil(flourQd / annualWorkerCapacityQd);
  const bakeryWorkers = Math.ceil(bakeryQd / annualWorkerCapacityQd);
  const fieldWorkQdEach = whole(grainCrop?.sowingWorkQd) + whole(grainCrop?.harvestWorkQd);
  const fieldWorkerTendays = Math.ceil(fields * fieldWorkQdEach / NORMAL_WORK_QD);
  const wagesCopper = fieldWorkerTendays * candidateDailyWage(field.id) * DAYS_PER_TENDAY
    + (millWorkers * candidateDailyWage(mill.id) + bakeryWorkers * candidateDailyWage(bakery.id)) * DAYS_PER_TENDAY * CAMPAIGN_YEAR_TENDAYS;
  const annualMonths = CAMPAIGN_YEAR_TENDAYS / 3;
  const baseUpkeepCopper = (fields * candidateBaseUpkeepMonthly(field.id)
    + candidateBaseUpkeepMonthly(mill.id)
    + candidateBaseUpkeepMonthly(bakery.id)) * annualMonths;
  const activeFieldTendaysEach = Math.ceil(fieldWorkQdEach / NORMAL_WORK_QD);
  const operatingUpkeepCopper = fields * activeFieldTendaysEach * candidateOperatingUpkeepMonthly(field.id) / 3
    + (candidateOperatingUpkeepMonthly(mill.id) + candidateOperatingUpkeepMonthly(bakery.id)) * annualMonths;
  // V18 baking batches are larger than milling batches and explicitly consume fuel.
  const additionalInputCopper = breadInputs.filter((cost) => cost.resourceId !== "flour")
    .reduce((sum, cost) => sum + cost.qty * costPrice(cost) * processingCycles, 0);
  const totalCostCopper = wagesCopper + baseUpkeepCopper + operatingUpkeepCopper + additionalInputCopper;
  const consumedFoodValueCopper = annualNeed * price("bread");
  return {
    population,
    annualNeed,
    fields,
    grainQty,
    millWorkers,
    bakeryWorkers,
    flourQd,
    bakeryQd,
    flourRequired,
    flourCycles,
    additionalInputCopper,
    wagesCopper,
    baseUpkeepCopper,
    operatingUpkeepCopper,
    totalCostCopper,
    consumedFoodValueCopper,
    averageTendayCostCopper: oneDecimal(totalCostCopper / CAMPAIGN_YEAR_TENDAYS),
    averageTendayFoodValueCopper: oneDecimal(consumedFoodValueCopper / CAMPAIGN_YEAR_TENDAYS)
  };
}

function normalLocalTradeScenario() {
  const population = 20;
  const food = annualFoodProvisioningScenario(population);
  const building = templatesById.get("tool-workshop");
  const line = building?.productionLines?.find((row) => row.resourceId === "tools-simple");
  const workers = 1;
  const workerQd = workers * NORMAL_WORK_QD;
  const cycles = Math.floor(workerQd / Math.max(1, whole(line?.workQd, 1)));
  const outputQty = cycles * whole(line?.outputQty);
  const inputValueCopper = parseResourceCosts(line?.expenses).reduce((sum, row) => sum + row.qty * costPrice(row) * cycles, 0);
  const productionWagesCopper = workers * candidateDailyWage(building.id) * DAYS_PER_TENDAY;
  const productionUpkeepCopper = candidateTendayCashCost(building.id, 0).upkeepAverage;
  const marketWorkers = 2;
  const marketEfficiency = 2;
  const demand = internalDemand({
    population,
    innEfficiency: 0,
    marketEfficiency,
    candidates: [resourceCandidate(line.resourceId, outputQty)]
  });
  const soldQty = demand.sales.reduce((sum, row) => sum + whole(row.qty), 0);
  const inventoryQty = Math.max(0, outputQty - soldQty);
  const marketWagesCopper = marketWorkers * candidateDailyWage("market") * DAYS_PER_TENDAY;
  const marketUpkeepCopper = candidateTendayCashCost("market", 0).upkeepAverage;
  const tradeCostCopper = inputValueCopper + productionWagesCopper + productionUpkeepCopper + marketWagesCopper + marketUpkeepCopper;
  const inventoryValueCopper = inventoryQty * price(line.resourceId);
  const tradeEconomicNetCopper = demand.revenueCopper + inventoryValueCopper - tradeCostCopper;
  const totalOutputValueCopper = outputQty * price(line.resourceId) + food.averageTendayFoodValueCopper;
  return {
    id: "normal-local-full-cycle",
    basis: "Normal annual bread ration plus one ordinary Tool Workshop worker and two ordinary Market workers; canonical inputs, finite local demand, full wages and base/operating upkeep.",
    population,
    food,
    outputResourceId: line.resourceId,
    outputQty,
    outputValueCopper: outputQty * price(line.resourceId),
    inputValueCopper,
    productionWagesCopper,
    productionUpkeepCopper: oneDecimal(productionUpkeepCopper),
    marketWagesCopper,
    marketUpkeepCopper: oneDecimal(marketUpkeepCopper),
    soldQty,
    revenueCopper: demand.revenueCopper,
    inventoryQty,
    inventoryValueCopper,
    tradeEconomicNetCopper: oneDecimal(tradeEconomicNetCopper),
    totalOutputValueCopper,
    cashNetCopper: oneDecimal(demand.revenueCopper - tradeCostCopper - food.averageTendayCostCopper),
    economicNetCopper: oneDecimal(tradeEconomicNetCopper + food.averageTendayFoodValueCopper - food.averageTendayCostCopper)
  };
}

function matureIndustrialExportScenario() {
  const building = templatesById.get("steelworks");
  const line = building?.productionLines?.find((row) => row.resourceId === "steel");
  const workers = whole(building?.workersMin);
  const workerQd = workers * NORMAL_WORK_QD;
  const cycles = Math.floor(workerQd / Math.max(1, whole(line?.workQd, 1)));
  const outputQty = cycles * whole(line?.outputQty);
  const inputValueCopper = parseResourceCosts(line?.expenses).reduce((sum, row) => sum + row.qty * costPrice(row) * cycles, 0);
  const wagesCopper = workers * candidateDailyWage(building.id) * DAYS_PER_TENDAY;
  const upkeepCopper = candidateTendayCashCost(building.id, 0).upkeepAverage;
  const shipment = outboundTrade(line.resourceId, outputQty);
  const netCopper = shipment.netAfterLogisticsCopper - inputValueCopper - wagesCopper - upkeepCopper;
  return {
    id: "mature-industrial-full-cycle",
    basis: "Minimum-staff Steelworks at full normal QD, canonical purchased inputs and one 120 km insured airship sale; includes wages, base/operating upkeep and logistics.",
    buildingId: building.id,
    workers,
    workerQd,
    cycles,
    outputResourceId: line.resourceId,
    outputQty,
    outputValueCopper: outputQty * price(line.resourceId),
    inputValueCopper,
    wagesCopper,
    upkeepCopper: oneDecimal(upkeepCopper),
    shipment,
    netCopper: oneDecimal(netCopper),
    marginPctOfRevenue: oneDecimal((netCopper / Math.max(1, shipment.revenueCopper)) * 100)
  };
}

function runtimeExportCycleAudit() {
  return DEFAULT_BUILDING_TEMPLATES.flatMap((building) => (building.productionLines ?? []).flatMap((line) => {
    if (line?.active === false || line?.requiresGmConfirmation === true || String(line?.source ?? "workers") !== "workers") return [];
    if (!price(line?.resourceId)) return [];
    const workers = Math.max(1, whole(building?.workersMin));
    const workerQd = workers * NORMAL_WORK_QD;
    const cycles = Math.floor(workerQd / Math.max(1, whole(line?.workQd, 1)));
    if (!cycles) return [];
    const outputQty = cycles * whole(line?.outputQty);
    const inputValueCopper = parseResourceCosts(line?.expenses).reduce((sum, row) => sum + row.qty * costPrice(row) * cycles, 0);
    const wagesCopper = workers * (whole(line?.wageDailyCopper) || candidateDailyWage(building.id)) * DAYS_PER_TENDAY;
    const upkeepCopper = (candidateBaseUpkeepMonthly(building.id)
      + (whole(line?.operatingUpkeepMonthlyCopper) || candidateOperatingUpkeepMonthly(building.id))) / 3;
    const shipment = outboundTrade(line.resourceId, outputQty);
    const netCopper = shipment.netAfterLogisticsCopper - inputValueCopper - wagesCopper - upkeepCopper;
    return [{
      buildingId: building.id,
      lineId: line.id,
      resourceId: line.resourceId,
      workers,
      cycles,
      outputQty,
      revenueCopper: shipment.revenueCopper,
      inputValueCopper,
      wagesCopper,
      upkeepCopper: oneDecimal(upkeepCopper),
      logisticsCopper: shipment.upfrontCopper,
      netCopper: oneDecimal(netCopper),
      marginPctOfRevenue: oneDecimal((netCopper / Math.max(1, shipment.revenueCopper)) * 100)
    }];
  })).sort((left, right) => right.marginPctOfRevenue - left.marginPctOfRevenue || left.buildingId.localeCompare(right.buildingId));
}

function exploitFindings({ financeGaps, margins, conflicts, loadStats, survival }) {
  const marginByBuilding = new Map(margins.map((row) => [row.buildingId, row]));
  const findings = [];
  const financeGapCount = financeGaps.zeroProductionLineWages.length
    + financeGaps.zeroProductionLineOperatingUpkeep.length
    + financeGaps.zeroIncomeWages.length
    + financeGaps.zeroIncomeOperatingUpkeep.length
    + financeGaps.zeroBaseUpkeepTemplates.length
    + financeGaps.zeroBuildingWageTemplates.length
    + financeGaps.zeroMaintenanceRequirement.length;
  if (financeGapCount > 0) findings.push({
      severity: "blocker",
      id: "zero-finance-defaults",
      evidence: `${financeGapCount} zero-cost or zero-maintenance defaults remain across ${financeGaps.economicTemplates} economic templates.`,
      owner: "scripts/data/building-template-catalog/*.js",
      recommendation: "Seed positive integer wageDailyCopper, baseUpkeepMonthlyCopper and per-function operatingUpkeepMonthlyCopper before the Laputa cutover."
    });
  const unpaidSpecialFunctions = [
    ...financeGaps.livestockWithoutPaidBuildingFunction,
    ...financeGaps.agricultureWithoutPaidBuildingFunction
  ];
  if (unpaidSpecialFunctions.length) findings.push({
      severity: "blocker",
      id: "special-production-unpaid-function",
      evidence: `${unpaidSpecialFunctions.join(", ")} have agriculture/livestock production without positive building-level wage and operating upkeep.`,
      owner: "scripts/apps/domains/finance/economy-domain.js::_financePlanInputs",
      recommendation: "Represent agriculture/livestock as a paid building-level function using the same assigned QD as the seasonal engine."
    });
  if ((templatesById.get("grain-field")?.productionLines ?? []).some((row) => row.active !== false && row.source !== "workers")) findings.push({
      severity: "high",
      id: "autonomous-grain",
      evidence: `grain-field is source=time and creates ${marginByBuilding.get("grain-field")?.outputQty ?? 0} Grain per tenday without consuming worker QD or requiring an assigned worker.`,
      owner: "scripts/data/building-template-catalog/food.js and scripts/engines/economy/production-cycle.js",
      recommendation: "Candidate v1: source=workers, period=qd, outputQty=4, workQd=1."
    });
  const localPlantFood = templatesById.get("inn")?.productionLines?.some((row) => (
    row.resourceId === "food-vegetables" && row.outputQty > 0
    && parseResourceCosts(row.expenses).some((cost) => cost.resourceId === "vegetables" && cost.qty > 0)
    && parseResourceCosts(row.expenses).some((cost) => cost.resourceId === "fuel-solid" && cost.qty > 0)
  ));
  if (!localPlantFood) findings.push({
      severity: "high",
      id: "laputa-food-gap",
      evidence: `Empty-storage Laputa produces ${survival.preparedFood}/${survival.food.sparseNeed} units even for a sparse ration; plant ingredients cannot enter a complete local prepared-food recipe.`,
      owner: "scripts/data/building-template-catalog/culture.js and food.js",
      recommendation: "Add one integer local Produce recipe (for example 3 Vegetables -> 3 Food (Fruit)) or a local Fruits output; provide an explicit opening food buffer."
    });
  if (!templatesById.get("mill")?.productionLines?.some((row) => row.resourceId === "animal-feed")) findings.push({
      severity: "medium",
      id: "feed-import-only",
      evidence: "Animal Feed costs 2 MM and is required by pigs every tenday and by grazing livestock in winter, but no default building produces it.",
      owner: "scripts/data/resources/resource-base-definitions.js and building templates",
      recommendation: "Add one selectable local feed line, e.g. Grain 2 -> Animal Feed 2 per QD, while retaining imports as the emergency option."
    });
  if (conflicts.length) findings.push({
      severity: "medium",
      id: "dual-canonical-prices",
      evidence: `${conflicts.length} overlapping resources differ between built-ins and the full economy pack: ${conflicts.map((row) => row.resourceId).join(", ")}.`,
      owner: "scripts/data/resources/world-resource-bindings.js and examples/content-packs/air-islands-materials-and-country-markets.json",
      recommendation: "Choose one canonical price owner and make the pack inherit it; an optional content import must not redefine the base price."
    });
  if (loadStats.builtinAtFourPoints === loadStats.builtinNonMoneyResources) findings.push({
      severity: "medium",
      id: "uniform-builtin-load",
      evidence: `${loadStats.builtinAtFourPoints}/${loadStats.builtinNonMoneyResources} built-in non-money resources use exactly 4 quarter-load points.`,
      owner: "scripts/data/resources/resource-base-definitions.js and world-resource-bindings.js",
      recommendation: "This is safe only if one unit deliberately means one cargo slot for every core resource; document it explicitly. Otherwise bulk cargo profitability cannot differ by material."
    });
  return findings;
}

function recommendedNumbers() {
  return {
    status: "implemented as editable runtime building-template defaults",
    wagesDailyCopper: {
      basicExtractionAgricultureLivestock: RUNTIME_ECONOMY_V2.wageDailyCopper.basic,
      skilledProcessing: RUNTIME_ECONOMY_V2.wageDailyCopper.skilled,
      hazardousMine: RUNTIME_ECONOMY_V2.wageDailyCopper.hazardous,
      innAndMarket: RUNTIME_ECONOMY_V2.wageDailyCopper.trade,
      overtimePerQd: "one additional full daily rate, unchanged"
    },
    upkeepMonthlyCopper: {
      baseFormula: "18 * max(1, legacy upkeep)",
      simpleFunction: 18,
      processingFunction: 36,
      heavyFunction: 54,
      tradeFunction: 54
    },
    productionPerWorkerQd: RUNTIME_ECONOMY_V2.production,
    internalDemand: {
      populationBudgetPerResidentCopper: DEFAULT_INTERNAL_DEMAND_CONFIG.populationBudgetPerResidentCopper,
      innBudget: "240 + 60 * effective workers",
      marketBudget: "480 + 90 * effective workers",
      sellerPriceFactor: "0.5 .. 1.5",
      verdict: "Income budgets use the same sixfold money-flow scale as wages and upkeep; finite shared demand still prevents unlimited local sales."
    },
    transport: {
      verdict: "Keep the current 120 km airship tariff and quote cargo from the canonical resource catalog.",
      minimumPracticalLots: "Small low-value consignments remain inefficient because the fixed freight component is paid before distance and load charges."
    }
  };
}

export function buildReport() {
  const margins = currentProductionMargins();
  const candidateMargins = candidateProductionMargins();
  const financeGaps = financeConfigurationGaps();
  const conflicts = canonicalConflicts();
  const loadStats = loadDistribution();
  const survival = laputaSurvivalScenario();
  const seasonalAgriculture = runtimeSeasonalAgricultureScenario();
  const scenarios = [
    survival,
    seasonalAgriculture,
    candidateSettlementScenario({ id: "normal-baseline-seller", population: 12, fieldWorkers: 2, millWorkers: 1, bakeryWorkers: 1, sellerEfficiency: 2, industrialExports: ["iron20"] }),
    candidateSettlementScenario({ id: "normal-elite-seller", population: 12, fieldWorkers: 2, millWorkers: 1, bakeryWorkers: 1, sellerEfficiency: 3, industrialExports: ["iron20"] }),
    candidateSettlementScenario({ id: "growth-baseline-seller", population: 24, fieldWorkers: 4, millWorkers: 2, bakeryWorkers: 2, sellerEfficiency: 2, industrialExports: ["iron20", "cloth40"] }),
    candidateSettlementScenario({ id: "growth-elite-seller", population: 24, fieldWorkers: 4, millWorkers: 2, bakeryWorkers: 2, sellerEfficiency: 3, industrialExports: ["iron20", "cloth40"] }),
    normalLocalTradeScenario(),
    matureIndustrialExportScenario(),
    transportScenario()
  ];
  return {
    reportVersion: 1,
    units: { money: "integer copper (MM)", load: "quarter-load points", labor: "QD", tendayQd: TENDAY_QD, normalWorkerQd: NORMAL_WORK_QD },
    sourceOwners: {
      resources: "scripts/data/resources/* plus full native economy content pack",
      production: "scripts/data/building-template-catalog/*.js",
      finance: "scripts/engines/economy/finance-period.js and finance-obligations.js",
      demand: "scripts/data/economy/internal-demand.js and scripts/engines/economy/internal-demand.js",
      food: "scripts/engines/economy/food-rations.js",
      livestock: "scripts/data/livestock.js and scripts/engines/economy/livestock.js",
      transport: "scripts/engines/market/logistics.js, pricing.js and outbound.js"
    },
    financeGaps,
    runtimeProductionContract: runtimeProductionContract(),
    canonicalConflicts: conflicts,
    loadDistribution: loadStats,
    currentProductionMargins: margins,
    candidateProductionMargins: candidateMargins,
    runtimeExportCycleAudit: runtimeExportCycleAudit(),
    scenarios,
    recommendedNumbers: recommendedNumbers(),
    exploits: exploitFindings({ financeGaps, margins, conflicts, loadStats, survival })
  };
}

export function checkEconomyBalanceScenario() {
  const report = buildReport();
  const replay = buildReport();
  assert.deepEqual(replay, report, "economy calibration report must be deterministic");
  assert.ok(report.currentProductionMargins.every((row) => Number.isFinite(row.outputValueCopper) && Number.isFinite(row.candidateNetBeforeUpkeepCopper)));
  assert.ok(report.runtimeExportCycleAudit.length >= 70, "the full-cycle export audit must cover every ordinary runtime line with a priced output");
  assert.ok(report.runtimeExportCycleAudit.every((row) => Number.isFinite(row.netCopper) && Number.isFinite(row.marginPctOfRevenue)), "every full-cycle export row must resolve inputs, wages, upkeep and logistics to finite numbers");
  assert.ok(report.runtimeExportCycleAudit.some((row) => row.netCopper > 0) && report.runtimeExportCycleAudit.some((row) => row.netCopper < 0), "external trade must reward route and product choice instead of making every cargo automatically profitable");
  // The approved cannery upgrade earns a capital return; a labor-wage cap would erase its benefit.
  assert.ok(report.runtimeExportCycleAudit.every((row) => row.marginPctOfRevenue <= 30), "neutral exports must retain a bounded margin after wages, inputs, upkeep and delivery");
  assert.ok(report.runtimeExportCycleAudit.filter((row) => row.buildingId === "cannery").every((row) => row.marginPctOfRevenue <= 25), "industrial preservation must not become an unlimited-profit recipe");
  assert.ok(report.currentProductionMargins.filter((row) => row.buildingId === "inn" && row.lineId === "line").every((row) => row.inputValueCopper > 0), "category-based recipes must retain their cheapest valid input opportunity cost");
  assert.ok(report.candidateProductionMargins.every((row) => Number.isFinite(row.netEconomicMarginCopper)));
  const ordinaryMargins = new Map(report.candidateProductionMargins.map((row) => [row.buildingId, row.netEconomicMarginCopper]));
  for (const buildingId of ["lumbermill", "quarry", "forge", "tannery", "tailor-shop"]) {
    assert.ok(ordinaryMargins.get(buildingId) >= 0 && ordinaryMargins.get(buildingId) <= 50, `${buildingId}: one worker must earn a modest non-negative tenday margin before external logistics`);
  }
  assert.equal(report.scenarios.find((row) => row.id === "trade")?.route?.distanceKm, 120);
  const normalFullCycle = report.scenarios.find((row) => row.id === "normal-local-full-cycle");
  assert.equal(normalFullCycle.food.annualNeed, normalFullCycle.food.grainQty, "the normal scenario must cover one complete 240-day bread ration without hidden food imports or surplus");
  assert.ok(Math.abs(normalFullCycle.economicNetCopper) <= normalFullCycle.totalOutputValueCopper * 0.1, "a normal fed and paid settlement chain must stay within 10% of economic break-even after upkeep and finite demand");
  assert.ok(normalFullCycle.cashNetCopper < normalFullCycle.economicNetCopper && normalFullCycle.inventoryQty > 0, "finite demand must leave real unsold stock rather than silently monetizing all output");
  const matureFullCycle = report.scenarios.find((row) => row.id === "mature-industrial-full-cycle");
  assert.ok(matureFullCycle.netCopper > 0, "a fully staffed mature industrial export must be able to earn a real profit after inputs, wages, upkeep and logistics");
  assert.ok(matureFullCycle.marginPctOfRevenue <= 15, "mature industrial profit must stay limited rather than becoming an unlimited high-margin export loop");

  const economicTemplates = DEFAULT_BUILDING_TEMPLATES.filter((building) => (
    building?.functions?.production || building?.functions?.income || building?.livestock?.enabled
  ));
  assert.deepEqual(
    economicTemplates.map((building) => building.id).sort(),
    [...approvedEconomicTemplateIds].sort(),
    "the approved economic manifest must explicitly own all and only the 44 producing, livestock, seasonal and income templates"
  );
  const technicalNorms = preparationMaintenanceNorms();
  for (const building of economicTemplates) {
    assert.ok(whole(building.baseUpkeepMonthlyCopper) > 0 && whole(building.baseUpkeepMonthlyCopper) % 18 === 0, `${building.id}: approved base upkeep must be a positive whole wage-step multiple`);
    assert.ok(whole(building.wageDailyCopper) > 0, `${building.id}: building-level wage must be positive`);
    assert.ok(whole(building.operatingUpkeepMonthlyCopper) > 0, `${building.id}: building-level operating upkeep must be positive`);
    assert.equal(building.maintenance?.schemaVersion, 2);
    assert.equal(whole(building.maintenance?.requiredPoints), technicalNorms.get(building.id), `${building.id}: labor maintenance must match the selective technical norm`);
    for (const productionLine of building.productionLines ?? []) {
      if (productionLine.active === false) continue;
      assert.ok((whole(productionLine.wageDailyCopper) || whole(building.wageDailyCopper)) > 0, `${building.id}:${productionLine.id}: effective production wage must be positive`);
      assert.ok((whole(productionLine.operatingUpkeepMonthlyCopper) || whole(building.operatingUpkeepMonthlyCopper)) > 0, `${building.id}:${productionLine.id}: effective production operating upkeep must be positive`);
    }
    if (building.functions?.income) {
      assert.ok((whole(building.income?.wageDailyCopper) || whole(building.wageDailyCopper)) > 0, `${building.id}: effective income wage must be positive`);
      assert.ok((whole(building.income?.operatingUpkeepMonthlyCopper) || whole(building.operatingUpkeepMonthlyCopper)) > 0, `${building.id}: effective income operating upkeep must be positive`);
    }
  }

  const gapArrays = Object.entries(report.financeGaps)
    .filter(([, value]) => Array.isArray(value));
  assert.deepEqual(
    gapArrays.filter(([, value]) => value.length).map(([key]) => key),
    [],
    "calibrated economic templates must not retain zero-finance or zero-maintenance gaps"
  );
  assert.deepEqual(report.runtimeProductionContract.millFeed, {
    outputResourceId: "animal-feed",
    outputQty: 6,
    expenses: "grain 6"
  });
  assert.deepEqual(report.runtimeProductionContract.innPlantFood, {
    outputResourceId: "food-vegetables",
    outputQty: 12,
    expenses: "vegetables 12, fuel-solid 1"
  });
  assert.deepEqual(report.runtimeProductionContract.forge, {
    outputResourceId: "iron",
    outputQty: 4,
    expenses: "iron-ore 4, fuel-solid 1"
  });
  const seasonal = report.scenarios.find((row) => row.id === "runtime-seasonal-agriculture");
  assert.equal(seasonal?.field?.personYearsAtNormalRations, 4, "one Field must supply roughly four person-years at 10 food units/tenday");
  assert.equal(seasonal?.garden?.personYearsAtNormalRations, 2, "one vegetable Garden must supply roughly two person-years");
  assert.equal(seasonal?.laputaAnnualSupply?.grainFieldsRequired, 3, "three seasonal Fields must cover annual normal rations for 12 residents");
  assert.equal(seasonal?.laputaAnnualSupply?.storageLoad, 720, "three food-scaled Grain harvests must require 720 standard storage load");
  assert.equal(seasonal?.laputaAnnualSupply?.rootCellarsRequired, 2, "the annual Grain reserve must fit in two 400-load Root Cellars");
  assert.equal(seasonal?.laputaAnnualSupply?.barnsRequired, 2, "the annual Grain reserve must fit in two 600-load Barns");
  assert.equal(seasonal?.laputaAnnualSupply?.processingChainCoversAnnualNeed, true, "one Mill and one Bakery worker must process the annual Laputa ration in the campaign work budget");
  assert.deepEqual(report.loadDistribution.foodNotAtOnePoint, [], "all raw and prepared resident food must share one quarter-load point per unit");
  assert.deepEqual(
    report.exploits.filter((row) => ["blocker", "high"].includes(row.severity)),
    [],
    "calibrated runtime must not retain blocker or high-severity economy exploits"
  );
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(checkEconomyBalanceScenario(), null, 2));
}
