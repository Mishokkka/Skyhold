const MONEY_FLOW_SCALE_V2 = 6;

export const DEFAULT_INTERNAL_DEMAND_CONFIG = Object.freeze({
  populationBudgetPerResidentCopper: 2 * MONEY_FLOW_SCALE_V2,
  moraleScale: 40,
  minimumSatisfactionFactor: 0.5,
  maximumSatisfactionFactor: 1.5,
  satisfactionOverrideFactor: null,
  priorities: Object.freeze({ population: 30, innVisitors: 20, marketFlow: 10 })
});

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function whole(value, fallback = 0) {
  return Math.max(0, Math.floor(finite(value, fallback)));
}

function text(value = "") {
  return String(value ?? "").trim();
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string") return ["1", "true", "yes", "on", "да"].includes(value.trim().toLocaleLowerCase("ru"));
  return Boolean(value);
}

function list(value = []) {
  const rows = Array.isArray(value) ? value : String(value ?? "").split(/[,;\n]/);
  return [...new Set(rows.map((row) => text(row).toLowerCase()).filter(Boolean))];
}

function clamp(value, min, max, fallback) {
  return Math.min(max, Math.max(min, finite(value, fallback)));
}

function templateIdFor(building = {}) {
  return text(building.templateId ?? building.id);
}

export function internalDemandTradeDefaults(building = {}) {
  const templateId = templateIdFor(building);
  if (templateId === "inn") {
    return {
      sourceIds: ["population", "inn-visitors"],
      allowedTags: ["food.prepared", "alcohol", "beverage", "service.inn"],
      demandSource: "inn-visitors",
      demandBudgetBaseCopper: 40 * MONEY_FLOW_SCALE_V2,
      demandBudgetPerWorkerCopper: 10 * MONEY_FLOW_SCALE_V2,
      throughputUnitsPerWorker: 5,
      service: { enabled: true, categoryTag: "service.inn", basePriceCopper: 5 * MONEY_FLOW_SCALE_V2, unitsPerWorker: 2 }
    };
  }
  if (templateId === "market") {
    return {
      sourceIds: ["population", "market-flow"],
      allowedTags: ["all"],
      demandSource: "market-flow",
      demandBudgetBaseCopper: 80 * MONEY_FLOW_SCALE_V2,
      demandBudgetPerWorkerCopper: 15 * MONEY_FLOW_SCALE_V2,
      throughputUnitsPerWorker: 8,
      service: { enabled: false, categoryTag: "", basePriceCopper: 0, unitsPerWorker: 0 }
    };
  }
  return {
    sourceIds: ["population"],
    allowedTags: ["all"],
    demandSource: "",
    demandBudgetBaseCopper: 0,
    demandBudgetPerWorkerCopper: 0,
    throughputUnitsPerWorker: 5,
    service: { enabled: false, categoryTag: "", basePriceCopper: 0, unitsPerWorker: 0 }
  };
}

export function normalizeInternalDemandTrade(value = {}, { building = {} } = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const defaults = internalDemandTradeDefaults(building);
  const serviceSource = source.service && typeof source.service === "object" && !Array.isArray(source.service) ? source.service : {};
  const sourceIds = list(source.sourceIds);
  const allowedTags = list(source.allowedTags);
  const kind = ["all", "resources", "items"].includes(text(source.kind ?? source.saleKind)) ? text(source.kind ?? source.saleKind) : "all";
  return {
    enabled: bool(source.enabled, false),
    sourceIds: sourceIds.length ? sourceIds : [...defaults.sourceIds],
    allowedTags: allowedTags.length ? allowedTags : [...defaults.allowedTags],
    demandSource: text(source.demandSource || defaults.demandSource),
    demandBudgetBaseCopper: whole(source.demandBudgetBaseCopper, defaults.demandBudgetBaseCopper),
    demandBudgetPerWorkerCopper: whole(source.demandBudgetPerWorkerCopper, defaults.demandBudgetPerWorkerCopper),
    throughputUnitsPerWorker: whole(source.throughputUnitsPerWorker, defaults.throughputUnitsPerWorker),
    gmPriority: whole(source.gmPriority, 500),
    roomId: text(source.roomId ?? source.storageRoomId ?? "all") || "all",
    kind,
    service: {
      enabled: bool(serviceSource.enabled, defaults.service.enabled),
      categoryTag: text(serviceSource.categoryTag || defaults.service.categoryTag),
      basePriceCopper: whole(serviceSource.basePriceCopper, defaults.service.basePriceCopper),
      unitsPerWorker: whole(serviceSource.unitsPerWorker, defaults.service.unitsPerWorker)
    },
    notes: text(source.notes),
    legacyBudgetFormula: text(source.legacyBudgetFormula ?? source.budgetFormula),
    legacyMaxLotsPerBuyer: whole(source.legacyMaxLotsPerBuyer ?? source.maxLotsPerBuyer, 1)
  };
}

export function normalizeInternalDemandConfig(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const override = source.satisfactionOverrideFactor;
  return {
    populationBudgetPerResidentCopper: whole(source.populationBudgetPerResidentCopper, DEFAULT_INTERNAL_DEMAND_CONFIG.populationBudgetPerResidentCopper),
    moraleScale: Math.max(1, finite(source.moraleScale, DEFAULT_INTERNAL_DEMAND_CONFIG.moraleScale)),
    minimumSatisfactionFactor: clamp(source.minimumSatisfactionFactor, 0, 2, DEFAULT_INTERNAL_DEMAND_CONFIG.minimumSatisfactionFactor),
    maximumSatisfactionFactor: clamp(source.maximumSatisfactionFactor, 0.5, 2, DEFAULT_INTERNAL_DEMAND_CONFIG.maximumSatisfactionFactor),
    satisfactionOverrideFactor: override === null || override === undefined || override === "" ? null : clamp(override, 0, 2, 1),
    priorities: {
      population: whole(source?.priorities?.population, DEFAULT_INTERNAL_DEMAND_CONFIG.priorities.population),
      innVisitors: whole(source?.priorities?.innVisitors, DEFAULT_INTERNAL_DEMAND_CONFIG.priorities.innVisitors),
      marketFlow: whole(source?.priorities?.marketFlow, DEFAULT_INTERNAL_DEMAND_CONFIG.priorities.marketFlow)
    }
  };
}
