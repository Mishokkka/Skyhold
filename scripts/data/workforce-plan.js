import { buildWorkAllocationTargets, workAllocationTargetKey, validateHoldingWorkAllocations } from "./work-allocations.js";
import { allocationFunctionId, allocationNormalQd, allocationSourceId, allocationTotalQd } from "./labor-primitives.js";
import { isResidentRestingOnShip } from "./resident-presence.js";
import { normalLaborQdPerTenday, residentLaborCapacity } from "./labor-budget.js";
import { reservedOccupation, residentLaborUnavailableReason } from "./labor-model.js";

export const WORKFORCE_PLAN_VERSION = 2;
export const workforceKey = (row) => workAllocationTargetKey(row?.sourceId, row?.functionId);
export const workforceLockKey = (row) => JSON.stringify([String(row?.personId), workforceKey(row)]);
export const workforceProductionGoalKey = workforceKey;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const lookupRow = (collection, id) => collection instanceof Map
  ? collection.get(id)
  : (Array.isArray(collection) ? collection : []).find((entry) => String(entry?.id ?? "") === id);

export function isWorkforcePlanRowVisible(row, { buildings, people, isGM = false } = {}) {
  if (!row || typeof row !== "object") return false;
  if (isGM) return true;
  if (row.visibility === "gm") return false;
  const building = lookupRow(buildings, String(row.sourceId ?? ""));
  if (building?.visibility === "gm") return false;
  if (row.personId !== undefined) {
    const person = lookupRow(people, String(row.personId ?? ""));
    if (person?.visibility === "gm") return false;
  }
  return true;
}

export function normalizeProductionGoals(goals) {
  return (Array.isArray(goals) ? goals : []).filter((row) => workforceKey(row)
    && Number.isSafeInteger(row.preparedUnits) && row.preparedUnits > 0 && row.preparedUnits <= 1_000_000);
}

export function normalizeWorkforcePlan(plan) {
  return { version: WORKFORCE_PLAN_VERSION, locks: Array.isArray(plan?.locks) ? plan.locks : [],
    productionGoals: normalizeProductionGoals(plan?.productionGoals) };
}

export const workforcePlan = (holding) => holding?.workforcePlan ?? normalizeWorkforcePlan();

export function workforceIssueMessage(holding, issue, { isGM = false } = {}) {
  if (!issue) return "";
  const hidden = !isGM && ((holding.buildings?.list ?? []).some((row) => row.visibility === "gm" && String(row.id) === issue.buildingId)
    || (holding.people?.list ?? []).some((row) => row.visibility === "gm" && String(row.id) === issue.personId));
  const privateCapacity = !isGM && issue.code === "allocation-capacity" && (holding.people?.list ?? []).some((person) =>
    person.visibility === "gm" && (person.workAllocations ?? []).some((row) => row.sourceId === issue.buildingId));
  if (privateCapacity) return "Свободных QD для назначения в здании недостаточно.";
  return hidden ? "План конфликтует с недоступным назначением. Его может проверить ГМ." : issue.message;
}

export function workforceCapacity(person = {}, holding) {
  return residentLaborCapacity(person, normalLaborQdPerTenday(holding));
}

export function workforceUnavailable(holding, person) {
  return residentLaborUnavailableReason(holding, person) || reservedOccupation(holding, person)?.label
    || (isResidentRestingOnShip(person, holding) ? "Отдых экипажа" : "");
}

export function workforcePlanChangeError(holding, plan, { isGM = false } = {}) {
  if (!plan || plan.version !== WORKFORCE_PLAN_VERSION
    || Object.keys(plan).some((key) => !["version", "locks", "productionGoals"].includes(key))
    || !Array.isArray(plan.locks) || !Array.isArray(plan.productionGoals)) return "Некорректный формат общего плана работ.";
  const previous = workforcePlan(holding);
  const targets = new Map(buildWorkAllocationTargets(holding).map((row) => [row.key, row]));
  const buildings = new Map((holding.buildings?.list ?? []).map((row) => [String(row.id), row]));
  const people = new Map((holding.people?.list ?? []).map((row) => [String(row.id), row]));
  for (const [kind, keyFor, allowed] of [
    ["locks", workforceLockKey, ["personId", "sourceId", "functionId"]],
    ["productionGoals", workforceProductionGoalKey, ["sourceId", "functionId", "preparedUnits"]]
  ]) {
    const priorRows = new Map(previous[kind].map((row) => [keyFor(row), row]));
    const nextRows = new Map();
    const canEdit = (row) => {
      if (!row || typeof row !== "object") return false;
      const building = buildings.get(String(row.sourceId));
      if (!building) return false;
      if (kind === "locks" && !people.get(String(row.personId))) return false;
      return isWorkforcePlanRowVisible(row, { buildings, people, isGM });
    };
    for (const row of plan[kind]) {
      if (!row || typeof row !== "object") return "Некорректная цель или закрепление.";
      const key = keyFor(row);
      const prior = priorRows.get(key);
      if (nextRows.has(key)) return "Цель или закрепление повторяется.";
      nextRows.set(key, row);
      if (same(prior, row)) continue;
      const fieldAllowed = (field) => allowed.includes(field)
        || (field === "visibility" && (
          (isGM && ["public", "gm"].includes(row.visibility))
          || (!isGM && prior?.visibility === "public" && row.visibility === "public")
        ));
      if (Object.keys(row).some((field) => !fieldAllowed(field))
        || !canEdit(row) || prior && !canEdit(prior)) return "Цель или закрепление недоступны.";
      const target = targets.get(workforceKey(row));
      if (!target?.available || kind === "productionGoals" && (target.kind !== "production"
        || !Number.isSafeInteger(row.preparedUnits) || row.preparedUnits < 1 || row.preparedUnits > 1_000_000)) {
        return "Некорректная цель или закрепление для выбранной работы.";
      }
    }
    for (const [key, row] of priorRows) {
      if (!nextRows.has(key) && !canEdit(row)) return "Нельзя менять скрытую часть общего плана.";
    }
  }
  return "";
}

function allocationPairFor(holding, personId, sourceId, functionId) {
  const person = (holding?.people?.list ?? []).find((entry) => String(entry?.id ?? "") === String(personId ?? ""));
  const key = workAllocationTargetKey(sourceId, functionId);
  let normal = 0;
  let overtime = 0;
  for (const row of person?.workAllocations ?? []) {
    if (workAllocationTargetKey(allocationSourceId(row), allocationFunctionId(row)) !== key) continue;
    const n = allocationNormalQd(row);
    const total = allocationTotalQd(row);
    normal += n;
    overtime += Math.max(0, total - n);
  }
  return [normal, overtime];
}

export function lockedAllocationChangeError(beforeHolding, afterHolding, nextPlan = workforcePlan(afterHolding), { isGM = false } = {}) {
  const beforeLocks = new Map((workforcePlan(beforeHolding).locks ?? []).map((row) => [workforceLockKey(row), row]));
  const afterLocks = new Map(((nextPlan ?? workforcePlan(afterHolding)).locks ?? []).map((row) => [workforceLockKey(row), row]));
  const buildings = new Map((beforeHolding?.buildings?.list ?? []).map((row) => [String(row.id), row]));
  const people = new Map((beforeHolding?.people?.list ?? []).map((row) => [String(row.id), row]));
  for (const [key, lock] of beforeLocks) {
    if (!afterLocks.has(key)) continue;
    const [beforeN, beforeO] = allocationPairFor(beforeHolding, lock.personId, lock.sourceId, lock.functionId);
    const [afterN, afterO] = allocationPairFor(afterHolding, lock.personId, lock.sourceId, lock.functionId);
    if (beforeN !== afterN || beforeO !== afterO) {
      return !isGM && !isWorkforcePlanRowVisible(lock, { buildings, people, isGM })
        ? "Назначение недоступно. Обновите окно или обратитесь к ГМу."
        : "Сначала снимите закрепление назначения.";
    }
  }
  for (const [key, lock] of afterLocks) {
    if (beforeLocks.has(key)) continue;
    const [afterN, afterO] = allocationPairFor(afterHolding, lock.personId, lock.sourceId, lock.functionId);
    if (afterN + afterO <= 0) return "Закрепить можно только активное назначение.";
  }
  return "";
}

export function workforceChangeError(before, after, options) {
  const planError = workforcePlanChangeError(before, workforcePlan(after), options);
  if (planError) return planError;
  const lockError = lockedAllocationChangeError(before, after, workforcePlan(after), options);
  if (lockError) return lockError;
  const { issues } = validateHoldingWorkAllocations(after, { previousHolding: before });
  return workforceIssueMessage(after, issues[0], options);
}
