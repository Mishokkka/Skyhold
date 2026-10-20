import { mergeDefaults } from "./utils.js";

export function createDefaultShipsState() {
  return { list: [], offers: [], offerPeriod: null, history: [] };
}

// Additive defaults only: never erase voyage ledgers or reconcile money on load.
export function normalizeShipsState(value) {
  return mergeDefaults(createDefaultShipsState(), value);
}

export function createShipRecord(id) {
  if (typeof id !== "string" || !id.trim()) throw new TypeError("Ship id is required");
  return {
    id, name: "Новый корабль", commanderName: "", commanderResidentId: "",
    coCommanderResidentIds: [], crewResidentIds: [], crewTarget: 0,
    // Retain the original reference defaults for existing integrations.
    commanderRef: "", coCommanderRefs: [], crewRefs: [],
    speedKmPerDay: 150, cargoTonnes: 0,
    capacityLoadPoints: null, hiddenCapacityLoadPoints: null,
    condition: "ready", traits: [], status: "docked", onboardCopper: 0,
    routePlan: { destination: "", distanceKm: 0, portDays: 0, preparationCopper: 0, upkeepPerDayCopper: 0, rewardCopper: 0 },
    attentionByDirection: {}, activeVoyage: null
  };
}
