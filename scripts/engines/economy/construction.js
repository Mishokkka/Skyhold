import { politicsRuntimeEffects } from "../politics/runtime-effects.js";

function constructionDependencies(dependencies = {}) {
  const required = [
    "safeNumber",
    "buildingOperationalState",
    "advanceBuildingProject",
    "constructionCrew",
    "constructionAttemptGate",
    "constructionPeriodForHolding",
    "resolveConstructionAttempt",
    "rollDice",
    "planStorageCosts",
    "payStorageCosts"
  ];
  for (const name of required) {
    if (typeof dependencies[name] !== "function") {
      throw new TypeError(`FBL Skyhold | Construction requires dependency "${name}".`);
    }
  }
  return dependencies;
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
    const constructionPeriod = deps.constructionPeriodForHolding(holding, period);
    for (const building of holding?.buildings?.list ?? []) {
      const operationalState = deps.buildingOperationalState(building);
      if (!operationalState.repairActive && !["planned", "building"].includes(operationalState.lifecycle)) continue;
      const crewId = String(building.constructionCrewId ?? "");
      if (!crewId) continue;
      const crew = deps.constructionCrew(holding, crewId);
      if (!crew?.count || !crew?.dice) {
        report?.construction?.lines?.push?.(`${building.name || "Здание"}: стройбригада пуста.`);
        continue;
      }

      const gate = deps.constructionAttemptGate({ holding, crewId, crew, period: constructionPeriod });
      if (!gate.ok) {
        if (gate.replay) report?.construction?.lines?.push?.(`${building.name || "Здание"}: ${gate.message}`);
        continue;
      }

      const difficulty = deps.safeNumber(building.buildDifficulty, 0);
      const dicePool = Math.max(1, crew.dice + difficulty);
      const rolls = deps.rollDice(dicePool);
      const rolledSuccesses = (Array.isArray(rolls) ? rolls : []).filter((value) => value >= 6).length;
      const successBonus = Math.max(0, Math.floor(deps.safeNumber(deps.constructionSuccessBonus?.(holding, crewId), 0)));
      const politicsPercent = politicsRuntimeEffects(holding)?.constructionPercent ?? 0;
      const successes = Math.max(0, Math.round((rolledSuccesses + successBonus) * Math.max(0, 1 + politicsPercent / 100)));
      const result = deps.resolveConstructionAttempt({
        holding,
        building,
        crewId,
        crew,
        successes,
        period: constructionPeriod,
        operationId: `construction:${constructionPeriod}:${crewId}`,
        dependencies: deps
      });
      if (!result.attempted) continue;
      const { oldProgress, nextProgress, target } = result;
      building.status = result.completed ? "Построено" : (result.kind === "repair" ? "Ремонтируется" : "Строится");
      attempts += 1;
      if (result.completed && oldProgress < target) completed += 1;
      const limited = result.appliedStages < result.requestedStages
        ? ` Принято стадий: ${result.appliedStages}; не хватает материалов${result.missingText ? ` (${result.missingText})` : ""}.`
        : "";
      const bonusText = successBonus ? ` (${rolledSuccesses} на костях +${successBonus} Центр Строительства)` : "";
      report?.construction?.lines?.push?.(`${building.name || "Здание"}: ${crew.name || "Стройбригада"} ${successes} усп.${bonusText}; ${oldProgress} → ${nextProgress}/${target}.${limited}`);
      deps.appendLedger?.(report, {
        domain: "construction",
        kind: "progress",
        name: building.name || "Здание",
        qty: result.appliedStages,
        sourceId: crewId,
        source: crew.name || "Стройбригада",
        targetId: building.id,
        target: building.name || "Здание",
        status: result.completed ? "completed" : "in-progress",
        note: `${oldProgress} → ${nextProgress}/${target}`,
        meta: {
          kind: result.kind,
          rolledSuccesses,
          successBonus,
          appliedStages: result.appliedStages,
          oldProgress,
          nextProgress,
          target,
          completed: Boolean(result.completed)
        }
      });
      for (const cost of result.charged ?? []) {
        deps.appendLedger?.(report, {
          domain: "construction",
          kind: cost.resourceId === "money" ? "money" : "resource",
          resourceId: cost.resourceId,
          name: cost.name,
          qty: -cost.qty,
          roomId: cost.roomId,
          sourceId: crewId,
          source: building.name || "Строительство",
          targetId: building.id,
          target: building.name || "Здание",
          status: "spent",
          note: `Материалы стадий ${oldProgress + 1}-${nextProgress}`,
          meta: { storageKind: "construction-material" }
        });
      }
    }
  }

  if (report?.construction) {
    report.construction.attempts += attempts;
    report.construction.completed += completed;
  }
  return { attempts, completed };
}
