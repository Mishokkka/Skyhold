import { ageGroupFromAge } from "../../generators/resident-rules.js";

function requireDependencies(dependencies = {}) {
  const required = [
    "safeNumber",
    "buildingOperationalState",
    "workerEfficiencyForPerson",
    "isSoldierResident",
    "isMilitaryResidentLike",
    "setPersonFree",
    "assignedWorkerSet",
    "applyPersonSalaryForAssignment"
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

export function isCivilianWorkerCandidate(person = {}, building = null, dependencies = {}) {
  const deps = requireDependencies(dependencies);
  if (!person || person.dead || deps.safeNumber(person?.injuredDays, 0) > 0) return false;
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

function defenseResidentIds(holding = {}) {
  const ids = new Set();
  const defense = holding?.gm?.defense ?? {};
  if (defense.commanderId) ids.add(String(defense.commanderId));
  for (const squad of defense.squads ?? []) {
    if (squad?.sergeantId) ids.add(String(squad.sergeantId));
    for (const id of (squad?.memberIds ?? []).slice(0, 4)) if (id) ids.add(String(id));
  }
  return ids;
}

export function applyWorkerAssignmentPlan({ holding, mode = "free", dependencies } = {}) {
  const deps = requireDependencies(dependencies);
  const normalizedMode = mode === "all" ? "all" : "free";
  const buildings = (holding?.buildings?.list ?? []).filter((building) => isBuiltAssignableBuilding(building, deps));
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead && deps.safeNumber(person?.injuredDays, 0) <= 0);
  if (!buildings.length) return { ok: false, mode: normalizedMode, assigned: 0, cleared: 0, assignments: [], message: "Нет построенных зданий со слотами работников." };

  let cleared = 0;
  if (normalizedMode === "all") {
    const protectedIds = defenseResidentIds(holding);
    for (const building of buildings) {
      const max = Math.max(0, deps.safeNumber(building.workersMax, 0));
      const oldIds = (building.assignedWorkerIds ?? []).filter(Boolean);
      cleared += oldIds.length;
      for (const id of oldIds) if (!protectedIds.has(String(id))) deps.setPersonFree(holding, id);
      building.assignedWorkerIds = Array.from({ length: max }, () => "");
    }
    for (const crew of holding?.constructionCrews ?? []) {
      const oldIds = Array.isArray(crew.memberIds) ? crew.memberIds.filter(Boolean) : [];
      cleared += oldIds.length;
      for (const id of oldIds) if (!protectedIds.has(String(id))) deps.setPersonFree(holding, id);
      crew.memberIds = [];
      crew.leaderId = "";
    }
    for (const person of people) {
      const id = String(person?.id ?? "");
      if (!id || protectedIds.has(id) || deps.isSoldierResident(person) || deps.isMilitaryResidentLike(person)) continue;
      const ageGroup = String(person.ageGroup ?? ageGroupFromAge(person.age, person.race, person.subrace) ?? "");
      if (ageGroup === "Ре" && deps.safeNumber(person?.age, 0) < 12) continue;
      deps.setPersonFree(holding, id);
    }
  }

  const used = new Set(deps.assignedWorkerSet(holding) ?? []);
  const assignments = [];
  const sortedBuildings = buildings.slice().sort((left, right) => Number(defenseBuilding(right, deps.safeNumber)) - Number(defenseBuilding(left, deps.safeNumber)));

  for (const building of sortedBuildings) {
    const max = Math.max(0, deps.safeNumber(building.workersMax, 0));
    if (!Array.isArray(building.assignedWorkerIds)) building.assignedWorkerIds = [];
    while (building.assignedWorkerIds.length < max) building.assignedWorkerIds.push("");
    const candidates = people
      .filter((person) => normalizedMode === "all" || ["", "Свободен", "Без работы", "Ребенок"].includes(String(person?.workAssignment || person?.role || "")))
      .filter((person) => isCivilianWorkerCandidate(person, building, deps))
      .map((person) => ({ person, score: workerAssignmentScore(holding, building, person, deps) }))
      .filter((row) => row.score > 0)
      .sort((left, right) => right.score - left.score || String(left.person.name ?? "").localeCompare(String(right.person.name ?? ""), "ru"));

    for (let slot = 0; slot < max; slot += 1) {
      if (building.assignedWorkerIds[slot]) continue;
      const candidate = candidates.find((row) => !used.has(String(row.person.id)));
      if (!candidate) continue;
      const person = candidate.person;
      building.assignedWorkerIds[slot] = String(person.id);
      person.workAssignment = String(building.id);
      person.role = building.workerRole || building.name || "Работает в здании";
      deps.applyPersonSalaryForAssignment(holding, person, building);
      used.add(String(person.id));
      assignments.push({
        personId: String(person.id),
        personName: String(person.name || "Житель"),
        buildingId: String(building.id ?? ""),
        buildingName: String(building.name || "Здание"),
        slot,
        score: candidate.score
      });
    }
  }

  return {
    ok: assignments.length > 0 || cleared > 0,
    mode: normalizedMode,
    assigned: assignments.length,
    cleared,
    assignments,
    message: assignments.length
      ? `Назначено работников: ${assignments.length}${cleared ? `, очищено старых слотов: ${cleared}` : ""}.`
      : cleared
        ? `Очищено старых слотов: ${cleared}; подходящих работников не найдено.`
        : "Подходящих свободных работников не найдено."
  };
}
