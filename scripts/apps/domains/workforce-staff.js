import { residentLaborCapacity } from "../../data/labor-budget.js";
import { buildingLaborMode } from "../../data/hybrid-labor.js";
import { workforceKey } from "../../data/workforce-plan.js";

export function staffDraftAppointment(draft, person) {
  return Object.hasOwn(draft.staffAppointments ?? {}, String(person.id))
    ? draft.staffAppointments[String(person.id)] : person.staffAppointment ?? null;
}

/** One contract, one budget. Reserve work never creates a second allocation. */
export function staffPlanningRows(person, appointment) {
  if (!appointment) return [];
  return [{
    schemaVersion: 1, id: `staff-${person.id}`, sourceId: appointment.buildingId,
    functionId: appointment.primaryFunctionId, normalQd: residentLaborCapacity(person).normalQd,
    overtimeQd: appointment.overtimeQd, staff: true,
    reserveFunctionId: appointment.reserveFunctionId,
    ...(appointment.volunteer ? { volunteer: true, volunteerReason: appointment.volunteerReason } : {})
  }];
}

export function setWorkforceStaff(draft, person, task, {
  reserveFunctionId = "", wageDailyCopper, overtimeQd = 0, volunteer, volunteerReason
} = {}) {
  if (buildingLaborMode(task.building) !== "staff") throw new Error("Это здание работает по заданиям QD.");
  const prior = staffDraftAppointment(draft, person);
  if (prior && prior.buildingId !== task.buildingId) throw new Error("Сначала снимите постоянное назначение в другом здании.");
  if ((draft.allocations[person.id] ?? []).some((row) => row.normalQd || row.overtimeQd)) {
    throw new Error("Сначала снимите прежние задания QD: постоянный сотрудник занят весь десятник.");
  }
  if ((draft.plan.locks ?? []).some((row) => row.personId === String(person.id))) throw new Error("Сначала снимите закрепления работ жителя.");
  const rate = wageDailyCopper ?? prior?.wageDailyCopper ?? person.wageDailyOverrideCopper ?? task.building.wageDailyCopper;
  if (![rate, overtimeQd].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error("Ставка и сверхурочные должны быть целыми неотрицательными числами.");
  draft.staffAppointments ??= {};
  draft.staffAppointments[person.id] = {
    version: 1, buildingId: task.buildingId, primaryFunctionId: task.functionId,
    reserveFunctionId, wageDailyCopper: rate, overtimeQd,
    volunteer: volunteer ?? prior?.volunteer ?? person.volunteerLabor === true,
    volunteerReason: volunteerReason ?? prior?.volunteerReason ?? String(person.volunteerReason ?? "")
  };
  draft.allocations[person.id] = [];
  if (!draft.edited.includes(String(person.id))) draft.edited.push(String(person.id));
}

export function removeWorkforceStaff(draft, personId) {
  if ((draft.plan.locks ?? []).some((row) => row.personId === personId)) throw new Error("Сначала снимите закрепление работы жителя.");
  draft.staffAppointments ??= {};
  draft.staffAppointments[personId] = null;
  draft.allocations[personId] = [];
  if (!draft.edited.includes(personId)) draft.edited.push(personId);
}

export function staffWorkDescription(appointment, tasks) {
  if (!appointment) return "";
  const primary = tasks.get(workforceKey({ sourceId: appointment.buildingId, functionId: appointment.primaryFunctionId }));
  const reserve = tasks.get(workforceKey({ sourceId: appointment.buildingId, functionId: appointment.reserveFunctionId }));
  return `${primary?.name || "Недоступное здание"} · ${primary?.functionName || "Недоступная работа"}`
    + (appointment.reserveFunctionId ? `; резерв: ${reserve?.functionName || "Недоступная работа"}` : "")
    + ` · ${appointment.wageDailyCopper} ММ/день · весь десятник`;
}
