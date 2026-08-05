import { foodProvisionDaily } from "../../data/food-provision.js";

export const RESIDENT_MEAL_CAPACITY_PER_WORKER = 20;

function mealCapacityDependencies(dependencies = {}) {
  const required = ["buildingOperationalState", "assignedBuildingPeople", "enterpriseCapitalReady"];
  for (const name of required) {
    if (typeof dependencies[name] !== "function") {
      throw new TypeError(`FBL Skyhold | Resident meal capacity requires dependency "${name}".`);
    }
  }
  return dependencies;
}

function normalizedIdentity(value) {
  return String(value ?? "").trim().toLowerCase().replace(/ё/g, "е");
}

export function isInnMealServiceBuilding(building = {}) {
  const identities = [building?.templateId, building?.id, building?.name]
    .map(normalizedIdentity)
    .filter(Boolean);
  if (identities.some((value) => value === "inn" || value === "tavern" || /(?:трактир|таверн)/.test(value))) return true;
  return building?.income?.service?.enabled === true
    && normalizedIdentity(building?.income?.service?.demandPool) === "hospitality";
}

function livingResidents(holding = {}) {
  return (holding?.people?.list ?? []).filter((person) => person && !person.dead && foodProvisionDaily(person) > 0);
}

/**
 * Calculates how many residents can use an inn common table for one tenday.
 *
 * This is an infrastructure snapshot only: uncovered residents are still able
 * to eat at home. The result reserves common-table seats in deterministic
 * building order so paid hospitality can use only remaining service capacity.
 */
export function residentMealCapacitySnapshot({
  holding,
  workerContext = null,
  dependencies = {}
} = {}) {
  const deps = mealCapacityDependencies(dependencies);
  const residents = livingResidents(holding);
  const seenWorkerIds = new Set();
  const contributingInns = [];
  const contributingWorkers = [];
  let residentsRemaining = residents.length;

  for (const building of holding?.buildings?.list ?? []) {
    if (!isInnMealServiceBuilding(building)) continue;
    if (!deps.buildingOperationalState(building)?.operational) continue;
    if (!deps.enterpriseCapitalReady(building, holding)) continue;

    const workers = [];
    for (const person of deps.assignedBuildingPeople(holding, building, workerContext) ?? []) {
      const workerId = String(person?.id ?? "").trim();
      if (!workerId || person?.dead || Number(person?.injuredDays ?? 0) > 0 || seenWorkerIds.has(workerId)) continue;
      seenWorkerIds.add(workerId);
      workers.push(person);
    }
    if (!workers.length) continue;

    const buildingId = String(building?.id ?? building?.templateId ?? "").trim();
    const buildingName = String(building?.name ?? "Трактир").trim() || "Трактир";
    const workerIds = workers.map((person) => String(person.id));
    const configuredPerWorker = building?.income?.service?.residentMealCapacityPerWorker;
    const capacityPerWorker = configuredPerWorker === undefined || configuredPerWorker === null || configuredPerWorker === ""
      ? RESIDENT_MEAL_CAPACITY_PER_WORKER
      : Math.max(0, Math.floor(Number(configuredPerWorker) || 0));
    const configuredCapacity = workerIds.length * capacityPerWorker;
    const laborCapacity = typeof deps.buildingLaborCapacity === "function"
      ? deps.buildingLaborCapacity(holding, building, workerContext, {
        unitsPerWorker: capacityPerWorker,
        purpose: "common-table",
        useEfficiency: false
      })
      : null;
    const capacity = laborCapacity && Number.isFinite(Number(laborCapacity.capacity))
      ? Math.min(configuredCapacity, Math.max(0, Math.floor(Number(laborCapacity.capacity))))
      : configuredCapacity;
    const residentUsed = Math.min(residentsRemaining, capacity);
    const remainingServiceCapacity = capacity - residentUsed;
    residentsRemaining -= residentUsed;

    contributingInns.push({
      buildingId,
      buildingName,
      capacityPerWorker,
      capacity,
      laborCapacityQd: laborCapacity ? Math.max(0, Math.floor(Number(laborCapacity.laborQd) || 0)) : null,
      residentUsed,
      remainingServiceCapacity,
      workerIds
    });
    for (const person of workers) {
      contributingWorkers.push({
        workerId: String(person.id),
        workerName: String(person?.name ?? "").trim(),
        buildingId,
        buildingName,
        capacity: capacityPerWorker
      });
    }
  }

  const totalCapacity = contributingInns.reduce((sum, inn) => sum + inn.capacity, 0);
  const coveredResidents = residents.length - residentsRemaining;
  const remainingServiceCapacity = contributingInns.reduce((sum, inn) => sum + inn.remainingServiceCapacity, 0);
  return {
    capacityPerWorker: RESIDENT_MEAL_CAPACITY_PER_WORKER,
    residentCount: residents.length,
    totalCapacity,
    coveredResidents,
    uncoveredResidents: residentsRemaining,
    remainingServiceCapacity,
    fullyCovered: residentsRemaining === 0,
    contributingInns,
    contributingWorkers
  };
}
