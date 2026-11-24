import { buildWorkAllocationTargets, workAllocationTargetKey, validateWorkAllocationPlan } from "./work-allocations.js";
import { isResidentInPopulation } from "./resident-presence.js";
import { DEFAULT_NORMAL_LABOR_QD, residentLaborCapacity } from "./labor-budget.js";
import { workerAdmission } from "../engines/workers/building-qualification.js";
import { MAX_PRODUCTION_GOAL_UNITS, newLaborIssues, validateBuildingLaborAndGoals } from "./labor-model.js";

export const WORKFORCE_PLAN_VERSION = 2;
export const workforceKey = (row) => workAllocationTargetKey(row?.sourceId, row?.functionId);
export const workforceLockKey = (row) => JSON.stringify([String(row?.personId), workforceKey(row)]);
export const workforcePlan = (holding) => holding?.workforcePlan ?? {
  version: WORKFORCE_PLAN_VERSION,
  locks: [],
  productionGoals: []
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const visible = (row, isGM) => row && (isGM || row.visibility !== "gm");

export function workforceIssueMessage(holding, issue, { isGM = false } = {}) {
  if (!issue) return "";
  const hidden = !isGM && ((holding.buildings?.list ?? []).some((row) => row.visibility === "gm" && String(row.id) === issue.buildingId)
    || (holding.people?.list ?? []).some((row) => row.visibility === "gm" && String(row.id) === issue.personId));
  return hidden ? "План конфликтует с недоступным назначением. Его может проверить ГМ." : issue.message;
}

export function workforceCapacity(person = {}, holding = null) {
  return residentLaborCapacity(person, holding);
}

/** Reserved occupations remain owned by their respective editors, even when temporarily idle. */
export function workforceUnavailable(holding, person) {
  if (person.dead) return "Умер";
  if (!isResidentInPopulation(person, holding)) return "Вне поселения / отдых экипажа";
  if (Number(person.injuredDays) > 0) return "Ранен";
  if (!residentLaborCapacity(person, DEFAULT_NORMAL_LABOR_QD).normalQd) return "Не может работать по возрасту";
  const id = String(person.id), assignment = String(person.workAssignment ?? "");
  const includes = (ids) => (ids ?? []).some((value) => String(value) === id);
  if (assignment.startsWith("construction") || includes(holding.constructionCrewIds)
    || (holding.constructionCrews ?? []).some((crew) => includes(crew.memberIds) || includes(crew.distributedIds)
      || [crew.leaderId, crew.distributedLeaderId].some((value) => String(value) === id))) return "Строительная бригада";
  const defense = holding.gm?.defense;
  if (["soldier", "defenseCommander"].includes(assignment) || String(defense?.commanderId) === id
    || (defense?.squads ?? []).some((squad) => includes(squad.memberIds) || String(squad.sergeantId) === id)) return "Постоянная военная служба";
  if (assignment === "other" || assignment === "sheriff") return "Особая должность";
  return "";
}

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
      ["productionGoals", workforceKey, ["sourceId", "functionId", "preparedUnits"]]
    ]) {
      const keys = new Set();
      for (const row of plan[kind] ?? []) {
        if (!row || typeof row !== "object" || Object.keys(row).some((key) => !allowed.includes(key))
          || allowed.filter((key) => key !== "preparedUnits").some((key) => typeof row[key] !== "string" || !row[key] || row[key].length > 200)) {
          return "Некорректная цель или закрепление.";
        }
        if (kind === "productionGoals" && (!Number.isSafeInteger(row.preparedUnits) || row.preparedUnits < 0 || row.preparedUnits > MAX_PRODUCTION_GOAL_UNITS)) {
          return "Некорректное количество подготовленных заделов.";
        }
        const key = keyFor(row);
        if (keys.has(key)) return "Цель или закрепление повторяется.";
        keys.add(key);
        const prior = oldPlan[kind]?.find((value) => keyFor(value) === key);
        if (!same(prior, row) && (!byKey.has(workforceKey(row)) || byKey.get(workforceKey(row))?.available === false || !targetVisible(row)
          || kind === "locks" && !visible(people.get(row.personId), isGM))) return "Цель или закрепление относится к недоступной работе / жителю.";
      }
      for (const prior of oldPlan[kind] ?? []) {
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
    const unavailable = workforceUnavailable(before, prior);
    const priorRows = prior.workAllocations ?? [];
    const increasesWork = person.workAllocations.some((row) => {
      if (!row || !row.normalQd && !row.overtimeQd) return false;
      const old = priorRows.find((value) => workforceKey(value) === workforceKey(row));
      return !old || row.normalQd > old.normalQd || row.overtimeQd > old.overtimeQd;
    });
    if (unavailable && increasesWork) return `${prior.name || "Житель"}: ${unavailable}.`;
    const capacity = workforceCapacity(person, after);
    const check = validateWorkAllocationPlan(person.workAllocations, {
      targets,
      holding: after,
      maximumNormalQd: capacity.normalQd,
      maximumOvertimeQd: capacity.overtimeQd
    });
    if (!check.ok) return check.issues[0]?.message || "Превышен бюджет QD.";
    for (const row of person.workAllocations) {
      if (![row.normalQd, row.overtimeQd].every((value) => Number.isSafeInteger(value) && value >= 0)) return "QD должны быть целыми неотрицательными числами.";
      if (!row.normalQd && !row.overtimeQd) continue;
      if (!targetVisible(row)) return "Нельзя назначать на скрытую работу.";
      const target = byKey.get(workforceKey(row));
      const oldRow = priorRows.find((value) => workforceKey(value) === workforceKey(row));
      if (target?.available === false && (!oldRow || row.normalQd > oldRow.normalQd || row.overtimeQd > oldRow.overtimeQd)) {
        return `${person.name || "Житель"}: ${target.blockedReason || "выбранная работа сейчас недоступна"}.`;
      }
      const building = buildings.get(String(row.sourceId));
      const admission = building && workerAdmission(building, person);
      if (admission?.hard && !admission.eligible && !admission.overridden) return `${person.name || "Житель"}: не выполнен допуск к работе.`;
      if (!isGM && row.volunteer === true
        && !(oldRow?.volunteer === true && String(oldRow?.volunteerReason ?? "") === String(row.volunteerReason ?? ""))) {
        return "Договорённость о бесплатной работе назначает ГМ.";
      }
    }
    if (!isGM && priorRows.some((row) => !targetVisible(row))) return "Назначения жителя содержат скрытую работу; их меняет ГМ.";
  }
  const issues = newLaborIssues(
    validateBuildingLaborAndGoals(before, { targets: buildWorkAllocationTargets(before) }).issues,
    validateBuildingLaborAndGoals(after, { targets }).issues
  );
  return workforceIssueMessage(after, issues[0], { isGM });
}
