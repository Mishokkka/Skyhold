import { RESOURCE_BASE_DEFINITIONS } from "../resources/resource-base-definitions.js";

export const DEFAULT_MARKET_LOCATION_PROFILES = [
  {
    id: "connected",
    label: "Крупный торговый узел",
    match: ["столица", "город", "порт", "торгов", "central", "capital", "city", "port"],
    priceFactor: 0.94,
    availabilityFactor: 1.2,
    deliveryQdFactor: 0.75,
    deliveryFlatCopper: 4,
    deliverySubtotalRate: 0.01,
    deliveryLoadCopper: 1,
    categoryFactors: { consumable: 0.95, material: 0.98 }
  },
  {
    id: "aerial",
    label: "Воздушный маршрут",
    match: ["небо", "воздуш", "остров", "sky", "air", "island"],
    priceFactor: 1.12,
    availabilityFactor: 0.85,
    deliveryQdFactor: 1.25,
    deliveryFlatCopper: 18,
    deliverySubtotalRate: 0.03,
    deliveryLoadCopper: 2,
    categoryFactors: { consumable: 1.08, material: 1.04 }
  },
  {
    id: "remote",
    label: "Удалённая местность",
    match: ["глуш", "пустош", "гора", "фронтир", "remote", "waste", "mountain", "frontier"],
    priceFactor: 1.16,
    availabilityFactor: 0.72,
    deliveryQdFactor: 1.5,
    deliveryFlatCopper: 14,
    deliverySubtotalRate: 0.03,
    deliveryLoadCopper: 2,
    categoryFactors: { consumable: 1.12, material: 1.06 }
  },
  {
    id: "standard",
    label: "Обычный маршрут",
    match: [],
    priceFactor: 1,
    availabilityFactor: 1,
    deliveryQdFactor: 1,
    deliveryFlatCopper: 8,
    deliverySubtotalRate: 0.02,
    deliveryLoadCopper: 1,
    categoryFactors: {}
  }
];

const ESSENTIAL_RESOURCE_IDS = new Set(["wood", "stone", "grain", "flour", "vegetables", "water", "bread", "animal-feed"]);

function defaultAvailability(resource = {}) {
  if (ESSENTIAL_RESOURCE_IDS.has(resource.id)) return { ubiquity: "essential", baseStock: 180, volatility: 0.2 };
  const difficulty = Number(resource.marketAccessDifficulty ?? 0);
  if (difficulty >= 4) return { ubiquity: "restricted", baseStock: 8, volatility: 0.42 };
  if (difficulty >= 2) return { ubiquity: "specialized", baseStock: 24, volatility: 0.34 };
  if (difficulty >= 1) return { ubiquity: "ordinary", baseStock: 55, volatility: 0.28 };
  return { ubiquity: "common", baseStock: 100, volatility: 0.24 };
}

function defaultOfferKind(resource = {}) {
  if (resource.foodEdible || resource.marketTags?.some((tag) => ["medicine", "consumer", "alcohol"].includes(tag))) return "consumable";
  if (resource.marketTags?.some((tag) => ["fuel", "ore", "food.raw"].includes(tag))) return "resource";
  return "material";
}

export const DEFAULT_EXTERNAL_MARKET_OFFERS = RESOURCE_BASE_DEFINITIONS
  .filter((resource) => resource.id !== "money")
  .map((resource) => {
    const availability = defaultAvailability(resource);
    return {
      id: `market-${resource.id}`,
      resourceId: resource.id,
      kind: defaultOfferKind(resource),
      baseStock: availability.baseStock,
      baseDemand: availability.baseStock,
      volatility: availability.volatility,
      ubiquity: availability.ubiquity,
      accessDifficulty: resource.marketAccessDifficulty ?? 0,
      tags: [...new Set([resource.categoryTag, ...(resource.marketTags ?? [])].filter(Boolean))]
    };
  });

export const DEFAULT_EXTERNAL_MARKET = {
  schemaVersion: 2,
  id: "external-market",
  label: "Внешний рынок",
  quotePeriodDays: 10,
  deliveryMode: "scheduled",
  baseDeliveryQd: 2,
  accessLevelOverride: 0,
  transportModes: ["caravan", "rail", "airship"],
  deliveryDistanceCopper: 0,
  deliveryLoadDistanceCopper: 0,
  airshipHireCopper: 120,
  caravanCapacityLoad: 400,
  railCapacityLoad: 8000,
  airshipCapacityLoad: 4000,
  locationProfiles: DEFAULT_MARKET_LOCATION_PROFILES,
  offers: DEFAULT_EXTERNAL_MARKET_OFFERS
};
