import { buildWorkAllocationTargets, workAllocationTargetKey, validateWorkAllocationPlan } from "./work-allocations.js";
import { isResidentInPopulation } from "./resident-presence.js";
import { DEFAULT_NORMAL_LABOR_QD, residentLaborCapacity } from "./labor-budget.js";
import { workerAdmission } from "../engines/workers/building-qualification.js";
import { staffAppointmentFor, staffAppointmentWorkFunctions, validateHybridLaborHolding } from "./hybrid-labor.js";

export const WORKFORCE_PLAN_VERSION = 1;
export const workforceKey = (row) => workAllocationTargetKey(row?.sourceId, row?.functionId);
export const workforceLockKey = (row) => JSON.stringify([String(row?.personId), workforceKey(row)]);
export const workforcePlan = (holding) => holding?.workforcePlan ?? { version: WORKFORCE_PLAN_VERSION, goals: [], locks: [] };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const visible = (row, isGM) => row && (isGM || row.visibility !== "gm");

export function workforceCapacity(person = {}) {
  return residentLaborCapacity(person);
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
  if (assignment === "other") return "Особая должность";
  return "";
}

/** Validate only changed planning fields: unrelated legacy/custom data is not repaired on load. */
export function workforceChangeError(before, after, { isGM = false } = {}) {
  const oldPlan = workforcePlan(before), plan = workforcePlan(after);
  const targets = buildWorkAllocationTargets(after), byKey = new Map(targets.map((row) => [row.key, row]));
  const buildings = new Map((before.buildings?.list ?? []).map((row) => [String(row.id), row]));
  const people = new Map((before.people?.list ?? []).map((row) => [String(row.id), row]));
  const targetVisible = (row) => isGM || row.sourceId === "maintenance" || visible(buildings.get(String(row.sourceId)), isGM);
  if (!same(oldPlan, plan)) {
    if (![WORKFORCE_PLAN_VERSION, 2].includes(plan.version) || Object.keys(plan).some((key) => !["version", "goals", "locks", ...(plan.version === 2 ? ["productionGoals"] : [])].includes(key))
      || !Array.isArray(plan.goals) || !Array.isArray(plan.locks) || plan.goals.length > 2000 || plan.locks.length > 4800) return "Некорректный формат общего плана работ.";
    if (plan.productionGoals !== undefined && !Array.isArray(plan.productionGoals)) return "Некорректные цели подготовки.";
    for (const [kind, keyFor, allowed] of [["goals", workforceKey, ["sourceId", "functionId", "normalQd"]], ["locks", workforceLockKey, ["personId", "sourceId", "functionId"]],
      ["productionGoals", workforceKey, ["sourceId", "functionId", "preparedUnits"]]]) {
      const keys = new Set();
      for (const row of plan[kind] ?? []) {
        if (!row || typeof row !== "object" || Object.keys(row).some((key) => !allowed.includes(key))
          || allowed.filter((key) => !["normalQd", "preparedUnits"].includes(key)).some((key) => typeof row[key] !== "string" || !row[key] || row[key].length > 200)) return "Некорректная цель или закрепление.";
        const key = keyFor(row);
        if (keys.has(key)) return "Цель или закрепление повторяется.";
        keys.add(key);
        if (kind === "goals" && (!Number.isSafeInteger(row.normalQd) || row.normalQd < 1 || row.normalQd > 10000)) return "Цель должна быть целым числом от 1 до 10000 QD.";
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
    if (!prior || same([prior.workAllocationMode, prior.workAllocations, prior.staffAppointment], [person.workAllocationMode, person.workAllocations, person.staffAppointment])) continue;
    if (!visible(prior, isGM)) return "Нельзя менять план скрытого жителя.";
    const oldAppointment = staffAppointmentFor(prior), appointment = staffAppointmentFor(person);
    if (oldAppointment && !visible(buildings.get(oldAppointment.buildingId), isGM)) return "Назначения жителя содержат скрытую работу; их меняет ГМ.";
    if (appointment) {
      const building = buildings.get(appointment.buildingId);
      if (!visible(building, isGM)) return "Нельзя назначать в скрытое или отсутствующее здание.";
      const unavailable = workforceUnavailable(before, prior);
      const reducingExistingAppointment = oldAppointment && same({ ...oldAppointment, overtimeQd: appointment.overtimeQd }, appointment)
        && appointment.overtimeQd <= oldAppointment.overtimeQd;
      if (unavailable && !reducingExistingAppointment) return `${prior.name || "Житель"}: ${unavailable}.`;
      const previousFunctions = oldAppointment?.buildingId === appointment.buildingId ? staffAppointmentWorkFunctions(oldAppointment) : [];
      for (const functionId of staffAppointmentWorkFunctions(appointment)) {
        const target = byKey.get(workAllocationTargetKey(appointment.buildingId, functionId));
        if (!previousFunctions.includes(functionId) && (!target || target.available === false)) return `${person.name || "Житель"}: выбранная работа сейчас недоступна.`;
      }
      const admission = workerAdmission(building, person);
      if (admission?.hard && !admission.eligible && !admission.overridden
        && staffAppointmentWorkFunctions(appointment).some((functionId) => functionId !== "maintenance")) return `${person.name || "Житель"}: не выполнен допуск к работе.`;
      if (!isGM) {
        const continuing = oldAppointment?.buildingId === appointment.buildingId;
        const expectedRate = continuing ? oldAppointment.wageDailyCopper
          : prior.wageDailyOverrideCopper ?? building.wageDailyCopper;
        if (appointment.wageDailyCopper !== Math.max(0, Number(expectedRate) || 0)) return "Согласованную ставку постоянного сотрудника меняет ГМ.";
        const authorizedVolunteer = continuing ? oldAppointment.volunteer === true : prior.volunteerLabor === true;
        const authorizedReason = continuing ? oldAppointment.volunteerReason : prior.volunteerReason;
        if (appointment.volunteer !== authorizedVolunteer || appointment.volunteer && appointment.volunteerReason !== authorizedReason) {
          return "Договорённость о бесплатной постоянной работе назначает ГМ.";
        }
      }
    }
    if (person.workAllocationMode !== "explicit") continue;
    if (!Array.isArray(person.workAllocations)) return "Некорректные назначения.";
    const unavailable = workforceUnavailable(before, prior);
    const priorRows = prior.workAllocationMode === "explicit" && !oldAppointment ? prior.workAllocations ?? [] : [];
    const increasesWork = person.workAllocations.some((row) => {
      if (!row || !row.normalQd && !row.overtimeQd) return false;
      const old = priorRows.find((value) => workforceKey(value) === workforceKey(row));
      return !old || row.normalQd > old.normalQd || row.overtimeQd > old.overtimeQd;
    });
    if (unavailable && increasesWork) return `${prior.name || "Житель"}: ${unavailable}.`;
    const capacity = workforceCapacity(person);
    const check = validateWorkAllocationPlan(person.workAllocations, { targets, maximumNormalQd: capacity.normalQd, maximumOvertimeQd: capacity.overtimeQd });
    if (!check.ok) return check.issues[0]?.message || "Превышен бюджет QD.";
    for (const row of person.workAllocations) {
      if (![row.normalQd, row.overtimeQd].every((value) => Number.isSafeInteger(value) && value >= 0)) return "QD должны быть целыми неотрицательными числами.";
      if (!row.normalQd && !row.overtimeQd) continue;
      if (!targetVisible(row)) return "Нельзя назначать на скрытую работу.";
      const target = byKey.get(workforceKey(row));
      const oldRow = (prior.workAllocations ?? []).find((value) => workforceKey(value) === workforceKey(row));
      if (target?.available === false && (!oldRow || row.normalQd > oldRow.normalQd || row.overtimeQd > oldRow.overtimeQd)) {
        return `${person.name || "Житель"}: ${target.blockedReason || "выбранная работа сейчас недоступна"}.`;
      }
      const building = buildings.get(String(row.sourceId));
      const admission = building && workerAdmission(building, person);
      if (admission?.hard && !admission.eligible && !admission.overridden && row.functionId !== "maintenance") return `${person.name || "Житель"}: не выполнен допуск к работе.`;
      if (!isGM && row.volunteer === true) {
        const old = (prior.workAllocations ?? []).find((value) => value.id === row.id);
        if (!old?.volunteer || workforceKey(old) !== workforceKey(row) || old.volunteerReason !== row.volunteerReason) return "Договорённость о бесплатной работе назначает ГМ.";
      }
    }
    if (!isGM && (prior.workAllocations ?? []).some((row) => !targetVisible(row))
      || !isGM && (before.buildings?.list ?? []).some((building) => building.visibility === "gm"
        && ((building.assignedWorkerIds ?? []).includes(prior.id) || [building.id, building.name].includes(prior.workAssignment)))) return "Назначения жителя содержат скрытую работу; их меняет ГМ.";
  }
  return validateHybridLaborHolding(after, { targets: byKey }).issues[0]?.message || "";
}
