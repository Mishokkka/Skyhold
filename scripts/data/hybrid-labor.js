import { residentLaborCapacity } from "./labor-budget.js";

export const HYBRID_LABOR_VERSION = 1;
export const HYBRID_LABOR_MODES = Object.freeze(["staff", "qd", "passive"]);
export const MAX_PRODUCTION_GOAL_UNITS = 1000000;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" ? value.trim() : "";
const whole = (value) => Number.isSafeInteger(value) && value >= 0;
const keyFor = (sourceId, functionId) => `${sourceId}::${functionId}`;
const active = (row) => Number(row?.normalQd) > 0 || Number(row?.overtimeQd) > 0;
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
const extras = (value, fields) => Object.keys(value).some((key) => !fields.includes(key));
const buildingFields = ["version", "mode", "capacityQd"];
const appointmentFields = ["version", "buildingId", "primaryFunctionId", "reserveFunctionId", "wageDailyCopper", "overtimeQd", "volunteer", "volunteerReason"];

/** Missing data means the unchanged historical implementation, never an inferred migration. */
export function buildingLaborMode(building = {}) {
  if (building.labor === undefined || building.labor === null) return "legacy";
  return object(building.labor) && building.labor.version === HYBRID_LABOR_VERSION && HYBRID_LABOR_MODES.includes(building.labor.mode)
    ? building.labor.mode : "invalid";
}

export function buildingLaborCapacityQd(building = {}) {
  return buildingLaborMode(building) === "qd" && whole(building.labor.capacityQd) ? building.labor.capacityQd : null;
}

/** Preserve malformed/future data for an explicit validation error, rather than erase it on load. */
export function normalizeBuildingLabor(value) {
  if (value === undefined || value === null) return null;
  if (!object(value)) return structuredClone(value);
  return { ...structuredClone(value), version: value.version ?? HYBRID_LABOR_VERSION, capacityQd: value.capacityQd ?? null };
}

export function normalizeStaffAppointment(value) {
  if (value === undefined || value === null) return null;
  if (!object(value)) return structuredClone(value);
  return { ...structuredClone(value), version: value.version ?? HYBRID_LABOR_VERSION,
    reserveFunctionId: value.reserveFunctionId ?? "", overtimeQd: value.overtimeQd ?? 0,
    volunteer: value.volunteer ?? false, volunteerReason: value.volunteerReason ?? "" };
}

/** This is a reservation of the resident, even with a zero normal-work budget. */
export function staffAppointmentFor(person = {}) {
  return object(person?.staffAppointment) ? person.staffAppointment : null;
}

export function staffAppointmentWorkFunctions(personOrAppointment = {}) {
  const appointment = owns(personOrAppointment, "staffAppointment") ? staffAppointmentFor(personOrAppointment) : personOrAppointment;
  if (!object(appointment)) return [];
  return [...new Set([text(appointment.primaryFunctionId), text(appointment.reserveFunctionId)].filter(Boolean))];
}

export function staffWorkerIdsForBuilding(holding = {}, buildingId = "") {
  return (holding.people?.list ?? []).filter((person) => !person.dead && text(staffAppointmentFor(person)?.buildingId) === text(buildingId))
    .map((person) => text(person.id)).filter(Boolean);
}

export function productionPreparationGoal(holding = {}, sourceId = "", functionId = "") {
  const row = (holding.workforcePlan?.productionGoals ?? []).find((entry) => entry.sourceId === sourceId && entry.functionId === functionId);
  return whole(row?.preparedUnits) && row.preparedUnits > 0 && row.preparedUnits <= MAX_PRODUCTION_GOAL_UNITS ? row.preparedUnits : null;
}

/** Explicit edit only. A single contract owns the legacy slot projection; no extra wage is created. */
export function applyStaffAppointment(holding, personId, appointment = null) {
  const id = String(personId), person = (holding.people?.list ?? []).find((row) => String(row.id) === id);
  if (!person) throw new Error("Житель больше не существует.");
  const next = normalizeStaffAppointment(appointment);
  const building = next && (holding.buildings?.list ?? []).find((row) => String(row.id) === next.buildingId);
  if (next && (person.dead || !object(next) || buildingLaborMode(building) !== "staff" || reservedOccupation(holding, person))) {
    throw new Error("Постоянное назначение несовместимо со зданием или нынешней службой жителя.");
  }
  if (next && staffWorkerIdsForBuilding(holding, building.id).filter((value) => value !== id).length >= Number(building.workersMax || 0)) {
    throw new Error("В постоянном штате нет свободного места.");
  }
  const previous = staffAppointmentFor(person);
  const deadIds = new Set((holding.people?.list ?? []).filter((row) => row.dead).map((row) => String(row.id)));
  for (const row of holding.buildings?.list ?? []) {
    if (Array.isArray(row.assignedWorkerIds)) row.assignedWorkerIds = row.assignedWorkerIds.map((value) =>
      String(value) === id || next && row.id === next.buildingId && deadIds.has(String(value)) ? "" : value);
  }
  if (!next) {
    delete person.staffAppointment;
    if (previous && person.workAssignment === previous.buildingId) person.workAssignment = "";
    return person;
  }
  person.staffAppointment = next;
  person.workAllocationMode = "legacy";
  person.workAllocations = [];
  person.workAssignment = next.buildingId;
  person.role = building.workerRole || building.name || "Постоянная работа";
  building.assignedWorkerIds ??= [];
  let slot = building.assignedWorkerIds.findIndex((value) => !value);
  if (slot < 0) slot = building.assignedWorkerIds.length;
  building.assignedWorkerIds[slot] = id;
  return person;
}

function reservedOccupation(holding, person) {
  const id = text(person.id), assignment = text(person.workAssignment);
  const includes = (ids) => (ids ?? []).some((value) => String(value) === id);
  if (assignment.startsWith("construction") || includes(holding.constructionCrewIds)
    || (holding.constructionCrews ?? []).some((crew) => includes(crew.memberIds) || includes(crew.distributedIds)
      || [crew.leaderId, crew.distributedLeaderId].some((value) => String(value) === id))) return true;
  const defense = holding.gm?.defense;
  return ["soldier", "defenseCommander", "other"].includes(assignment)
    || String(defense?.commanderId) === id
    || (defense?.squads ?? []).some((squad) => includes(squad.memberIds) || String(squad.sergeantId) === id);
}

/** Edit-time check only: preserve old problems, but never create or worsen one.
 * Match occurrences, not just codes: an existing duplicate cannot authorize more duplicates.
 * Runtime and migration callers still use the complete validation result.
 */
export function newHybridLaborIssues(previous = [], current = []) {
  const remaining = [...previous];
  const identity = ({ message: _message, actual: _actual, limit: _limit, ...issue }) => JSON.stringify(issue);
  return current.filter((issue) => {
    const key = identity(issue);
    const index = remaining.findIndex((prior) => identity(prior) === key
      && (issue.actual === undefined || prior.actual >= issue.actual && prior.limit <= issue.limit));
    if (index < 0) return true;
    remaining.splice(index, 1);
    return false;
  });
}

/**
 * Cross-record invariants. The caller supplies the same task targets used by its planner/engine.
 * Existing buildings without `labor` are left to the historical validator.
 * Presence/admission of a newly hired resident is checked by the change validator: an absence
 * must not silently delete an existing contract or allow a second appointment.
 */
export function validateHybridLaborHolding(holding = {}, { targets = null } = {}) {
  const issues = [];
  // Snapshot evidence before an in-place editor update; names/messages are not identity.
  const add = (code, message, details = {}) => issues.push({ code, message, ...structuredClone(details) });
  const buildings = new Map((holding.buildings?.list ?? []).map((building) => [text(building.id), building]));
  const people = new Map((holding.people?.list ?? []).map((person) => [text(person.id), person]));
  const targetMap = targets instanceof Map ? targets : Array.isArray(targets)
    ? new Map(targets.map((target) => [target.key ?? keyFor(target.sourceId, target.functionId), target])) : null;
  const staffCounts = new Map(), qdTotals = new Map();
  for (const [id, building] of buildings) {
    const mode = buildingLaborMode(building);
    if (mode === "legacy") continue;
    if (mode === "invalid" || extras(building.labor, buildingFields)
      || building.labor.capacityQd !== null && !whole(building.labor.capacityQd)) {
      add("labor-format", `${building.name || "Здание"}: некорректный способ работы или предел QD.`, { buildingId: id, evidence: building.labor });
    }
  }
  for (const [personId, person] of people) {
    if (person.dead) continue;
    const raw = person.staffAppointment;
    if (raw !== undefined && raw !== null) {
      const appointment = staffAppointmentFor(person);
      if (!appointment || appointment.version !== HYBRID_LABOR_VERSION || extras(appointment, appointmentFields)
        || !text(appointment.buildingId) || !text(appointment.primaryFunctionId)
        || typeof appointment.reserveFunctionId !== "string"
        || !whole(appointment.wageDailyCopper) || !whole(appointment.overtimeQd)
        || typeof appointment.volunteer !== "boolean" || typeof appointment.volunteerReason !== "string") {
        add("staff-format", `${person.name || "Житель"}: некорректный договор постоянной работы.`, { personId, evidence: raw });
        continue;
      }
      const buildingId = appointment.buildingId, building = buildings.get(buildingId);
      if (buildingLaborMode(building) !== "staff") add("staff-building", `${person.name || "Житель"}: постоянное назначение требует здания со штатным режимом.`, { personId, buildingId, evidence: buildingLaborMode(building) });
      staffCounts.set(buildingId, (staffCounts.get(buildingId) ?? 0) + 1);
      if ((person.workAllocations ?? []).some(active) || reservedOccupation(holding, person)
        || text(person.workAssignment) && text(person.workAssignment) !== buildingId) {
        add("staff-incompatible", `${person.name || "Житель"}: постоянная работа несовместима с другими назначениями.`, {
          personId, buildingId, evidence: [person.workAssignment, (person.workAllocations ?? []).filter(active), reservedOccupation(holding, person)]
        });
      }
      if (appointment.reserveFunctionId && appointment.reserveFunctionId === appointment.primaryFunctionId) {
        add("staff-duplicate-function", `${person.name || "Житель"}: основная и резервная работа совпадают.`, { personId, buildingId, functionId: appointment.primaryFunctionId });
      }
      if (appointment.overtimeQd > residentLaborCapacity(person).overtimeQd) {
        add("staff-overtime-cap", `${person.name || "Житель"}: сверхурочные превышают личный предел.`, {
          personId, buildingId, actual: appointment.overtimeQd, limit: residentLaborCapacity(person).overtimeQd
        });
      }
      if (appointment.wageDailyCopper === 0 && !appointment.volunteer
        || appointment.volunteer && !text(appointment.volunteerReason)) {
        add("staff-wage", `${person.name || "Житель"}: укажите ставку или подтверждённую ГМом причину бесплатной работы.`, {
          personId, buildingId, evidence: [appointment.wageDailyCopper, appointment.volunteer, appointment.volunteerReason]
        });
      }
      if (targetMap) {
        const functions = staffAppointmentWorkFunctions(appointment);
        for (const functionId of functions) if (!targetMap.has(keyFor(buildingId, functionId))) {
          add("staff-function", `${person.name || "Житель"}: выбранная работа больше недоступна.`, { personId, buildingId, functionId });
        }
        if (appointment.overtimeQd > 0 && !functions.some((functionId) => targetMap.get(keyFor(buildingId, functionId))?.overtimeAllowed)) {
          add("staff-overtime-function", `${person.name || "Житель"}: выбранные работы не разрешают сверхурочные.`, {
            personId, buildingId, evidence: functions, actual: appointment.overtimeQd, limit: 0
          });
        }
      }
    }
    if (person.workAllocationMode !== "explicit") continue;
    for (const row of person.workAllocations ?? []) {
      if (!active(row)) continue;
      const building = buildings.get(text(row.sourceId)), mode = buildingLaborMode(building);
      const externalMaintenance = row.functionId === "maintenance";
      if (["staff", "passive", "invalid"].includes(mode) && !externalMaintenance) {
        add("labor-qd-mode", `${person.name || "Житель"}: это здание не принимает обычные задания по QD.`, {
          personId, buildingId: row.sourceId, functionId: row.functionId, evidence: [mode, row.normalQd, row.overtimeQd]
        });
      }
      if (mode === "qd" && !externalMaintenance) qdTotals.set(row.sourceId, (qdTotals.get(row.sourceId) ?? 0) + Number(row.normalQd || 0) + Number(row.overtimeQd || 0));
    }
  }
  for (const [buildingId, building] of buildings) {
    const mode = buildingLaborMode(building);
    if (mode === "legacy") continue;
    const assigned = (building.assignedWorkerIds ?? []).filter(Boolean).map(String);
    for (const personId of assigned) {
      if (people.get(personId)?.dead) continue;
      if (mode !== "staff" || staffAppointmentFor(people.get(personId))?.buildingId !== buildingId) {
        add("labor-legacy-assignment", `${building.name || "Здание"}: прежнее назначение нужно явно перенести или снять.`, {
          buildingId, personId, evidence: [mode, staffAppointmentFor(people.get(personId))?.buildingId]
        });
      }
    }
    if (mode === "staff" && (staffCounts.get(buildingId) ?? 0) > Math.max(0, Number(building.workersMax) || 0)) {
      add("staff-capacity", `${building.name || "Здание"}: превышено число штатных мест.`, {
        buildingId, actual: staffCounts.get(buildingId), limit: Math.max(0, Number(building.workersMax) || 0)
      });
    }
    const cap = buildingLaborCapacityQd(building);
    if (cap !== null && (qdTotals.get(buildingId) ?? 0) > cap) {
      add("labor-qd-capacity", `${building.name || "Здание"}: назначено ${qdTotals.get(buildingId)} QD при пределе ${cap}.`, {
        buildingId, actual: qdTotals.get(buildingId), limit: cap
      });
    }
    if (mode !== "staff") for (const [personId, person] of people) {
      if (person.workAllocationMode !== "explicit" && [buildingId, building.name].filter(Boolean).includes(person.workAssignment)) {
        add("labor-legacy-assignment", `${person.name || "Житель"}: прежнее постоянное назначение не соответствует способу работы здания.`, {
          buildingId, personId, evidence: [mode, person.workAssignment]
        });
      }
    }
  }
  const productionGoals = holding.workforcePlan?.productionGoals;
  if (productionGoals !== undefined) {
    if (holding.workforcePlan.version !== 2 || !Array.isArray(productionGoals) || productionGoals.length > 2000) {
      add("production-goal-format", "Некорректный формат общих целей подготовки.", { evidence: [holding.workforcePlan.version, productionGoals] });
    } else {
      const seen = new Set();
      for (const row of productionGoals) {
        if (!object(row) || extras(row, ["sourceId", "functionId", "preparedUnits"])
          || !text(row.sourceId) || !text(row.functionId).startsWith("production:")
          || !whole(row.preparedUnits) || row.preparedUnits < 1 || row.preparedUnits > MAX_PRODUCTION_GOAL_UNITS) {
          add("production-goal-format", `Цель подготовки должна содержать линию и целое количество от 1 до ${MAX_PRODUCTION_GOAL_UNITS} ЕД.`, { evidence: row });
          continue;
        }
        const key = keyFor(row.sourceId, row.functionId);
        if (seen.has(key)) add("production-goal-duplicate", "Для линии допускается одна общая цель подготовки.", { buildingId: row.sourceId, functionId: row.functionId });
        seen.add(key);
        const building = buildings.get(row.sourceId);
        if (!["staff", "qd"].includes(buildingLaborMode(building)) || targetMap && !targetMap.has(key)) {
          add("production-goal-target", "Цель подготовки относится к недоступной производственной линии.", {
            buildingId: row.sourceId, functionId: row.functionId, evidence: [buildingLaborMode(building), row.preparedUnits]
          });
        }
        const line = (building?.productionLines ?? []).find((entry) => `production:${entry.id}` === row.functionId);
        const formula = String(line?.formula ?? "").trim();
        const fullQty = formula ? /^\d+$/.test(formula) ? Number(formula) : 0 : Number(line?.outputQty ?? line?.output ?? line?.quantity ?? 1);
        if (line?.source !== "workers") {
          add("production-goal-source", "Цель подготовки доступна для трудовой линии. Сбор у линии времени или содержимого задаётся трудом QD.", {
            buildingId: row.sourceId, functionId: row.functionId, evidence: [line?.source, row.preparedUnits]
          });
        }
        if (!Number.isSafeInteger(fullQty) || fullQty <= 0) {
          add("production-goal-formula", "Для вычисляемого или случайного выпуска используйте предел труда вместо цели в ЕД.", {
            buildingId: row.sourceId, functionId: row.functionId, evidence: [formula, fullQty, row.preparedUnits]
          });
        }
      }
    }
  }
  return { ok: issues.length === 0, issues, staffCounts, qdTotals };
}
