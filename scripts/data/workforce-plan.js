import {
  buildWorkAllocationTargets, parseWorkAllocationTargetKey, residentWorkUnavailable, validateHoldingWorkAllocations, workAllocationTargetKey, workFunctionMatches
} from "./work-allocations.js";
import { residentLaborCapacity } from "./labor-budget.js";
import { MAX_PRODUCTION_GOAL_UNITS } from "./labor-model.js";

export const WORKFORCE_PLAN_VERSION = 2;
export const workforceKey = (row) => workAllocationTargetKey(row?.sourceId, row?.functionId);
export const workforceProductionGoalKey = (row) => workforceKey(row) || String(row?.sourceId ?? "");
export const workforceLockKey = (row) => JSON.stringify([String(row?.personId), workforceKey(row)]);
export const workforcePlan = (holding) => holding?.workforcePlan ?? {
  version: WORKFORCE_PLAN_VERSION,
  locks: [],
  productionGoals: []
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function normalizeProductionGoals(goals) {
  if (Array.isArray(goals)) return structuredClone(goals);
  if (!goals || typeof goals !== "object") return [];
  return Object.entries(goals).flatMap(([key, raw]) => {
    const parsed = parseWorkAllocationTargetKey(key);
    const sourceId = parsed.sourceId || key.trim();
    const units = Number(raw?.preparedUnits ?? raw);
    return sourceId && Number.isFinite(units) && units >= 0
      ? [{ sourceId, functionId: parsed.functionId, preparedUnits: Math.floor(units) }]
      : [];
  });
}
const visible = (row, isGM) => row && (isGM || row.visibility !== "gm");

export function workforceIssueMessage(holding, issue, { isGM = false } = {}) {
  if (!issue) return "";
  const hidden = !isGM && ((holding.buildings?.list ?? []).some((row) => row.visibility === "gm" && String(row.id) === (issue.buildingId || issue.sourceId))
    || (holding.people?.list ?? []).some((row) => row.visibility === "gm" && String(row.id) === issue.personId));
  return hidden ? "План конфликтует с недоступным назначением. Его может проверить ГМ." : issue.message;
}

export function workforceCapacity(person = {}, holding = null) {
  return residentLaborCapacity(person, holding);
}

/** Reserved occupations remain owned by their respective editors, even when temporarily idle. */
export const workforceUnavailable = residentWorkUnavailable;

/** Validate only changed planning fields: unrelated legacy/custom data is not repaired on load. */
export function workforceChangeError(before, after, { isGM = false } = {}) {
  const oldPlan = workforcePlan(before), plan = workforcePlan(after);
  const targets = buildWorkAllocationTargets(after), byKey = new Map(targets.map((row) => [row.key, row]));
  const buildings = new Map((before.buildings?.list ?? []).map((row) => [String(row.id), row]));
  const people = new Map((before.people?.list ?? []).map((row) => [String(row.id), row]));
  const targetVisible = (row) => isGM || visible(buildings.get(String(row.sourceId)), isGM);
  if (!same(oldPlan, plan)) {
    if (![1, WORKFORCE_PLAN_VERSION].includes(plan.version)
      || Object.keys(plan).some((key) => !["version", "locks", "productionGoals"].includes(key))
      || !Array.isArray(plan.locks)
      || plan.locks.length > 4800) {
      return "Некорректный формат общего плана работ.";
    }
    if (plan.productionGoals !== undefined && !Array.isArray(plan.productionGoals)) return "Некорректные цели подготовки.";
    for (const [kind, keyFor, allowed] of [
      ["locks", workforceLockKey, ["personId", "sourceId", "functionId"]],
      ["productionGoals", workforceProductionGoalKey, ["sourceId", "functionId", "preparedUnits"]]
    ]) {
      const productionGoal = kind === "productionGoals";
      const previousRows = productionGoal ? normalizeProductionGoals(oldPlan.productionGoals) : oldPlan.locks ?? [];
      const keys = new Set();
      for (const row of plan[kind] ?? []) {
        if (!row || typeof row !== "object" || Object.keys(row).some((key) => !allowed.includes(key))
          || allowed.filter((key) => key !== "preparedUnits").some((key) => typeof row[key] !== "string"
            || (!row[key] && !(productionGoal && key === "functionId")) || row[key].length > 200)) {
          return "Некорректная цель или закрепление.";
        }
        if (kind === "productionGoals" && (!Number.isSafeInteger(row.preparedUnits) || row.preparedUnits < 0 || row.preparedUnits > MAX_PRODUCTION_GOAL_UNITS)) {
          return "Некорректное количество подготовленных заделов.";
        }
        const key = keyFor(row);
        if (keys.has(key)) return "Цель или закрепление повторяется.";
        keys.add(key);
        const prior = previousRows.find((value) => keyFor(value) === key);
        if (same(prior, row)) continue;
        const target = byKey.get(workforceKey(row));
        const available = productionGoal && !row.functionId
          ? targets.some((item) => item.sourceId === row.sourceId && item.available && workFunctionMatches(item.functionId, "production"))
          : target?.available;
        if (!available || !targetVisible(row) || !productionGoal && !visible(people.get(row.personId), isGM)) {
          return "Цель или закрепление относится к недоступной работе / жителю.";
        }
      }
      for (const prior of previousRows) {
        if (!same(prior, (plan[kind] ?? []).find((row) => keyFor(row) === keyFor(prior)))
          && (!targetVisible(prior) || kind === "locks" && !visible(people.get(prior.personId), isGM))) return "Нельзя менять скрытую часть общего плана.";
      }
    }
  }
  for (const person of after.people?.list ?? []) {
    const prior = people.get(String(person.id));
    if (!prior || same(prior.workAllocations ?? [], person.workAllocations ?? [])) continue;
    if (!visible(prior, isGM)) return "Нельзя менять план скрытого жителя.";
    if (!Array.isArray(person.workAllocations)) return "Некорректные назначения.";
    const priorRows = prior.workAllocations ?? [];
    for (const row of person.workAllocations) {
      if (!row || ![row.normalQd, row.overtimeQd].every((value) => Number.isSafeInteger(value) && value >= 0)) return "QD должны быть целыми неотрицательными числами.";
      if (!row.normalQd && !row.overtimeQd) continue;
      if (!targetVisible(row)) return "Нельзя назначать на скрытую работу.";
      const oldRow = priorRows.find((value) => workforceKey(value) === workforceKey(row));
      if (!isGM && row.volunteer === true
        && !(oldRow?.volunteer === true && String(oldRow?.volunteerReason ?? "") === String(row.volunteerReason ?? ""))) {
        return "Договорённость о бесплатной работе назначает ГМ.";
      }
    }
    if (!isGM && priorRows.some((row) => !targetVisible(row))) return "Назначения жителя содержат скрытую работу; их меняет ГМ.";
  }
  const { issues } = validateHoldingWorkAllocations(after, { previousHolding: before });
  return workforceIssueMessage(after, issues[0], { isGM });
}
