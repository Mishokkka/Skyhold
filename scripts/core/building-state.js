export const BUILDING_LIFECYCLES = Object.freeze(["planned", "building", "active", "disabled", "abandoned"]);
export const BUILDING_CONDITIONS = Object.freeze(["intact", "damaged", "heavilyDamaged", "destroyed"]);

const DAMAGE_CONDITIONS = new Set(BUILDING_CONDITIONS.slice(1));

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function inferBuildingLifecycle(building = {}) {
  if (BUILDING_LIFECYCLES.includes(building.lifecycle)) return building.lifecycle;
  const legacy = String(building.constructionStatus ?? "built");
  if (legacy === "planned") return "planned";
  if (legacy === "building" && !building.repairOf) return "building";
  if (legacy === "paused") return "disabled";
  return "active";
}

export function inferBuildingCondition(building = {}) {
  if (BUILDING_CONDITIONS.includes(building.condition)) return building.condition;
  const repairOf = String(building.repair?.fromCondition ?? building.repairOf ?? "");
  if (DAMAGE_CONDITIONS.has(repairOf)) return repairOf;
  const legacy = String(building.constructionStatus ?? "built");
  return DAMAGE_CONDITIONS.has(legacy) ? legacy : "intact";
}

export function legacyConstructionStatus(building = {}) {
  const lifecycle = inferBuildingLifecycle(building);
  const condition = inferBuildingCondition(building);
  if (building.repair?.active) return "building";
  if (lifecycle === "planned") return "planned";
  if (lifecycle === "building") return "building";
  if (lifecycle === "disabled") return "paused";
  if (lifecycle === "abandoned") return "destroyed";
  return condition === "intact" ? "built" : condition;
}

export function normalizeBuildingOperationalState(building = {}) {
  building.lifecycle = inferBuildingLifecycle(building);
  building.condition = inferBuildingCondition(building);
  const legacyRepairActive = String(building.constructionStatus ?? "") === "building" && DAMAGE_CONDITIONS.has(String(building.repairOf ?? ""));
  const sourceRepair = building.repair && typeof building.repair === "object" ? building.repair : {};
  const active = Boolean(sourceRepair.active ?? legacyRepairActive);
  const fromCondition = BUILDING_CONDITIONS.includes(sourceRepair.fromCondition)
    ? sourceRepair.fromCondition
    : (DAMAGE_CONDITIONS.has(String(building.repairOf ?? "")) ? String(building.repairOf) : building.condition);
  const target = Math.max(0, number(sourceRepair.target ?? building.repairTarget ?? (active ? building.buildTarget : 0), 0));
  const progress = Math.max(0, number(sourceRepair.progress ?? building.repairProgress ?? (active ? building.buildProgress : 0), 0));
  building.repair = {
    active,
    fromCondition,
    progress: target ? Math.min(target, progress) : progress,
    target,
    startedAt: String(sourceRepair.startedAt ?? "")
  };

  const constructionComplete = building.lifecycle === "building" && number(building.buildProgress, 0) >= Math.max(1, number(building.buildTarget, 6));
  const repairComplete = building.repair.active && building.repair.target > 0 && building.repair.progress >= building.repair.target;
  if (constructionComplete) building.lifecycle = "active";
  if (repairComplete) {
    building.condition = "intact";
    building.repair.active = false;
  }

  building.constructionStatus = legacyConstructionStatus(building);
  building.repairOf = building.repair.active ? building.repair.fromCondition : "";
  building.repairProgress = building.repair.progress;
  building.repairTarget = building.repair.target;
  if (building.repair.active) {
    building.buildProgress = building.repair.progress;
    building.buildTarget = Math.max(1, building.repair.target);
  }
  return building;
}

export function buildingOperationalState(building = {}) {
  const lifecycle = inferBuildingLifecycle(building);
  const condition = inferBuildingCondition(building);
  const repairActive = Boolean(building.repair?.active ?? (String(building.constructionStatus ?? "") === "building" && building.repairOf));
  const operational = lifecycle === "active" && condition === "intact" && !repairActive;
  if (repairActive) return { lifecycle, condition, repairActive, operational, value: "building", label: "Ремонт", css: "building", icon: "fa-solid fa-screwdriver-wrench" };
  if (lifecycle === "planned") return { lifecycle, condition, repairActive, operational, value: "planned", label: "Проект", css: "planned", icon: "fa-solid fa-drafting-compass" };
  if (lifecycle === "building") return { lifecycle, condition, repairActive, operational, value: "building", label: "Строится", css: "building", icon: "fa-solid fa-hammer" };
  if (lifecycle === "disabled") return { lifecycle, condition, repairActive, operational, value: "paused", label: "Не действует", css: "paused", icon: "fa-solid fa-pause" };
  if (lifecycle === "abandoned") return { lifecycle, condition, repairActive, operational, value: "abandoned", label: "Заброшено", css: "destroyed", icon: "fa-solid fa-building-circle-xmark" };
  if (condition === "damaged") return { lifecycle, condition, repairActive, operational, value: condition, label: "Повреждено", css: condition, icon: "fa-solid fa-triangle-exclamation" };
  if (condition === "heavilyDamaged") return { lifecycle, condition, repairActive, operational, value: condition, label: "Сильно повреждено", css: condition, icon: "fa-solid fa-house-crack" };
  if (condition === "destroyed") return { lifecycle, condition, repairActive, operational, value: condition, label: "Разрушено", css: condition, icon: "fa-solid fa-building-circle-xmark" };
  return { lifecycle, condition, repairActive, operational, value: "built", label: "Построено", css: "built", icon: "fa-solid fa-check" };
}

export function setBuildingCondition(building, condition) {
  normalizeBuildingOperationalState(building);
  building.condition = BUILDING_CONDITIONS.includes(condition) ? condition : "intact";
  building.repair.active = false;
  building.repair.fromCondition = building.condition;
  building.repair.progress = 0;
  building.repair.target = 0;
  return normalizeBuildingOperationalState(building);
}

export function startBuildingRepair(building, target, { startedAt = "" } = {}) {
  normalizeBuildingOperationalState(building);
  if (!DAMAGE_CONDITIONS.has(building.condition)) return false;
  building.repair = {
    active: true,
    fromCondition: building.condition,
    progress: 0,
    target: Math.max(1, number(target, 1)),
    startedAt: String(startedAt ?? "")
  };
  normalizeBuildingOperationalState(building);
  return true;
}

export function advanceBuildingProject(building, successes = 0) {
  normalizeBuildingOperationalState(building);
  const increment = Math.max(0, number(successes, 0));
  if (building.repair.active) {
    const oldProgress = building.repair.progress;
    building.repair.progress = Math.min(building.repair.target, oldProgress + increment);
    normalizeBuildingOperationalState(building);
    return { kind: "repair", oldProgress, nextProgress: building.repair.progress, target: building.repair.target, completed: !building.repair.active };
  }
  const oldProgress = Math.max(0, number(building.buildProgress, 0));
  const target = Math.max(1, number(building.buildTarget, 6));
  building.lifecycle = "building";
  building.buildProgress = Math.min(target, oldProgress + increment);
  normalizeBuildingOperationalState(building);
  return { kind: "construction", oldProgress, nextProgress: building.buildProgress, target, completed: building.lifecycle === "active" };
}
