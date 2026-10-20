import { ageGroupFromAge } from "../../generators/resident-rules.js";
import { isResidentInPopulation } from "../../data/resident-presence.js";

function requireDependencies(dependencies = {}) {
  const required = [
    "safeNumber",
    "buildingOperationalState",
    "workerEfficiencyForPerson",
    "isSoldierResident",
    "isMilitaryResidentLike"
  ];
  for (const name of required) {
    if (typeof dependencies[name] !== "function") throw new TypeError(`worker assignment planner requires dependencies.${name}`);
  }
  return dependencies;
}

function defenseBuilding(building = {}, safeNumber = Number) {
  return Boolean(
    building?.functions?.defense
    || safeNumber(building?.defense?.base, 0)
    || safeNumber(building?.defense?.perStep, 0)
    || safeNumber(building?.defense?.workerStep, 0)
  );
}

export function isBuiltAssignableBuilding(building = {}, dependencies = {}) {
  const deps = requireDependencies(dependencies);
  return deps.buildingOperationalState(building).operational && Math.max(0, deps.safeNumber(building?.workersMax, 0)) > 0;
}

export function isCivilianWorkerCandidate(person = {}, building = null, dependencies = {}, holding = null) {
  const deps = requireDependencies(dependencies);
  if (!person || !isResidentInPopulation(person, holding) || deps.safeNumber(person?.injuredDays, 0) > 0) return false;
  const ageGroup = String(person.ageGroup ?? ageGroupFromAge(person.age, person.race, person.subrace) ?? "");
  if (ageGroup === "Ре" && deps.safeNumber(person?.age, 0) < 12) return false;
  if (!defenseBuilding(building, deps.safeNumber) && (deps.isSoldierResident(person) || deps.isMilitaryResidentLike(person))) return false;
  return true;
}

export function workerAssignmentScore(holding, building, person, dependencies = {}) {
  const deps = requireDependencies(dependencies);
  const result = deps.workerEfficiencyForPerson(holding, building, person) ?? { value: 1 };
  const base = Number.isFinite(Number(result.value)) ? Number(result.value) : 0;
  const militaryBonus = defenseBuilding(building, deps.safeNumber) && (deps.isSoldierResident(person) || deps.isMilitaryResidentLike(person)) ? 0.5 : 0;
  return Math.max(0, base + militaryBonus);
}
