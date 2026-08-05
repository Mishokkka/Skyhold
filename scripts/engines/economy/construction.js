function constructionDependencies(dependencies = {}) {
  const required = [
    "safeNumber",
    "buildingStatus",
    "buildingOperationalState",
    "advanceBuildingProject",
    "constructionCrew",
    "rollDice",
    "validConstructionReservation"
  ];
  for (const name of required) {
    if (typeof dependencies[name] !== "function") {
      throw new TypeError(`FBL Skyhold | Construction requires dependency "${name}".`);
    }
  }
  return dependencies;
}

function requiresAllocatedConstructionMaterials(building = {}, operationalState = {}) {
  if (operationalState.repairActive) return true;
  const reservationRecipe = Array.isArray(building?.constructionReservation?.recipe)
    ? building.constructionReservation.recipe
    : null;
  return (reservationRecipe ?? (Array.isArray(building?.materialCosts) ? building.materialCosts : []))
    .some((item) => Math.max(0, Number(item?.qty ?? 0) || 0) > 0);
}

function hasAllocatedConstructionMaterials(building = {}, dependencies = {}) {
  if (building?.constructionReservation && typeof building.constructionReservation === "object") {
    return building.constructionReservation.status === "reserved" && dependencies.validConstructionReservation(building);
  }
  return Boolean(building?.materialsAllocated);
}

export function runConstruction({
  holding,
  qd = 0,
  report = null,
  dependencies = {}
} = {}) {
  if (!holding || typeof holding !== "object") throw new TypeError("FBL Skyhold | Construction requires a holding draft.");
  const deps = constructionDependencies(dependencies);
  const periods = Math.floor(Math.max(0, deps.safeNumber(qd, 0)) / 40);
  if (!periods) return { attempts: 0, completed: 0 };

  let attempts = 0;
  let completed = 0;
  for (let period = 0; period < periods; period += 1) {
    const attemptedCrewIds = new Set();
    for (const building of holding?.buildings?.list ?? []) {
      const operationalState = deps.buildingOperationalState(building);
      if (!operationalState.repairActive && !["planned", "building"].includes(operationalState.lifecycle)) continue;
      const crewId = String(building.constructionCrewId ?? "");
      if (!crewId) continue;
      if (requiresAllocatedConstructionMaterials(building, operationalState) && !hasAllocatedConstructionMaterials(building, deps)) {
        report?.construction?.lines?.push?.(`${building.name || "Здание"}: материалы для строительства не выделены.`);
        continue;
      }
      const crew = deps.constructionCrew(holding, crewId);
      if (!crew?.count || !crew?.dice) {
        report?.construction?.lines?.push?.(`${building.name || "Здание"}: стройбригада пуста.`);
        continue;
      }
      const actualCrewId = String(crew.id ?? crewId) || crewId;
      if (attemptedCrewIds.has(actualCrewId)) {
        report?.construction?.lines?.push?.(`${building.name || "Здание"}: ${crew.name || "стройбригада"} уже работала над другим проектом в этом десятнике.`);
        continue;
      }

      const labor = typeof deps.spendConstructionLabor === "function"
        ? deps.spendConstructionLabor(holding, crew, {
          purpose: `construction:${actualCrewId}:period-${period + 1}`,
          building
        })
        : null;
      if (labor && !labor.ok) {
        report?.construction?.lines?.push?.(`${building.name || "Здание"}: ${crew.name || "стройбригада"} не работала — не осталось доступных рабочих QD.`);
        continue;
      }

      attemptedCrewIds.add(actualCrewId);
      const difficulty = deps.safeNumber(building.buildDifficulty, 0);
      const laborFactor = labor?.legacy || !labor ? 1 : Math.max(0, Math.min(1, deps.safeNumber(labor?.laborFactor, 0)));
      const laborDice = Math.max(0, Math.floor(deps.safeNumber(crew.dice, 0) * laborFactor));
      const dicePool = Math.max(1, laborDice + difficulty);
      const rolls = deps.rollDice(dicePool);
      const successes = (Array.isArray(rolls) ? rolls : []).filter((value) => value >= 6).length;
      const progress = deps.advanceBuildingProject(building, successes);
      const { oldProgress, nextProgress, target } = progress;
      if (progress.completed && building?.constructionReservation?.status === "reserved" && deps.validConstructionReservation(building)) {
        building.constructionReservation.status = "consumed";
      }
      building.status = progress.completed ? "Построено" : (progress.kind === "repair" ? "Ремонтируется" : "Строится");
      attempts += 1;
      if (progress.completed && oldProgress < target) completed += 1;
      const laborText = labor && !labor.legacy ? `; труд ${labor.laborQd} QD (${Math.round(laborFactor * 100)}%)` : "";
      report?.construction?.lines?.push?.(`${building.name || "Здание"}: ${crew.name || "Стройбригада"} ${successes} усп.; ${oldProgress} → ${nextProgress}/${target}${laborText}.`);
      deps.appendLedger?.(report, {
        domain: "construction",
        kind: "progress",
        name: building.name || "Здание",
        qty: successes,
        sourceId: actualCrewId,
        source: crew.name || "Стройбригада",
        targetId: building.id,
        target: building.name || "Здание",
        status: progress.completed ? "completed" : "in-progress",
        note: `${oldProgress} → ${nextProgress}/${target}`,
        meta: {
          kind: progress.kind,
          oldProgress,
          nextProgress,
          target,
          completed: Boolean(progress.completed),
          laborQd: Math.max(0, Number(labor?.laborQd) || 0),
          laborFactor
        }
      });
    }
  }

  if (report?.construction) {
    report.construction.attempts += attempts;
    report.construction.completed += completed;
  }
  return { attempts, completed };
}
