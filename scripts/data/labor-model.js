import { isSheriffAppointment } from "./control-appointments.js";
import { DEFAULT_NORMAL_LABOR_QD, residentLaborCapacity } from "./labor-budget.js";
import { allocationSourceId, allocationTotalQd } from "./labor-primitives.js";
import { isResidentAbsentForLabor, isResidentAwayForLabor, residentLaborShips } from "./resident-presence.js";

const text = (value) => String(value ?? "").trim();
const includes = (ids, id) => (ids ?? []).some((value) => text(value) === id);
const at = (index, key) => index instanceof Map ? index.get(key) : Object.hasOwn(index ?? {}, key) ? index[key] : undefined;

function whole(value, fallback = 0) {
  const number = Number(value);
  return value != null && value !== "" && Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
}

export function buildingMinOperationalQd(building = {}) {
  return whole(building.activation?.minOperationalQd ?? building.minOperationalQd);
}

export function normalizeBuildingLabor(value, building = {}, { baseNormalQd = DEFAULT_NORMAL_LABOR_QD } = {}) {
  const workersMax = whole(building.workersMax, whole(building.workerProfile?.workersMax));
  const fallback = Math.max(workersMax * whole(baseNormalQd, DEFAULT_NORMAL_LABOR_QD), buildingMinOperationalQd(building));
  return { version: 2, capacityQd: value?.capacityQd === null ? null : whole(value?.capacityQd, fallback) };
}

export function buildingCapacityQd(building = {}, options) {
  return normalizeBuildingLabor(building.labor, building, options).capacityQd;
}

export const buildingLaborCapacityQd = buildingCapacityQd;

export function buildingAcceptsWorkers(building = {}, options) {
  return buildingCapacityQd(building, options) !== 0;
}

export function buildingAvailableCapacityQd(building = {}, reservedQd = 0, options) {
  const capacity = buildingCapacityQd(building, options);
  return capacity === null ? null : Math.max(0, capacity - whole(reservedQd));
}

export function productionPreparationGoal(holding = {}, sourceId = "", functionId = "") {
  const goals = holding.workforcePlan?.productionGoals;
  const source = text(sourceId), fn = text(functionId);
  let goal;
  if (Array.isArray(goals)) {
    const forBuilding = goals.filter((row) => text(row?.sourceId) === source);
    goal = forBuilding.find((row) => text(row.functionId) === fn)
      ?? forBuilding.find((row) => !text(row.functionId)) ?? (!fn ? forBuilding[0] : null);
  } else {
    goal = at(goals, `${source}::${fn}`) ?? at(goals, source);
  }
  return Math.min(1_000_000, whole(goal?.preparedUnits ?? goal));
}

export function residentLaborUnavailableReason(holding, person) {
  if (person.dead) return "Житель умер.";
  if (isResidentAbsentForLabor(holding, person)) return "Житель вне поселения.";
  if (Number(person.injuredDays) > 0) return "Житель ранен.";
  if (!residentLaborCapacity(person, DEFAULT_NORMAL_LABOR_QD).normalQd) return "Житель не может работать по возрасту.";
  return "";
}

export function reservedOccupation(holding = {}, person = {}) {
  const id = text(person.id), assignment = text(person.workAssignment);
  if (id) {
    for (const crew of holding.constructionCrews ?? []) {
      const name = text(crew.name || crew.id) || "Стройбригада";
      if (text(crew.leaderId) === id) {
        return { kind: "construction", label: `Руководитель стройбригады «${name}»` };
      }
      if (includes(crew.memberIds, id)) return { kind: "construction", label: `Стройбригада «${name}»` };
    }
    if (includes(holding.constructionCrewIds, id)) return { kind: "construction", label: "Строительная бригада" };

    const defense = holding.gm?.defense;
    if (text(defense?.commanderId) === id) return { kind: "defense", label: "Командующий обороной" };
    for (const squad of defense?.squads ?? []) {
      const name = text(squad?.name || squad?.id) || "Отряд";
      if (text(squad?.sergeantId) === id) return { kind: "defense", label: `Командир отряда «${name}»` };
      if (includes(squad?.memberIds, id)) return { kind: "defense", label: `Отряд «${name}»` };
    }
  }
  if (isResidentAwayForLabor(person)) return { kind: "ship", label: "В плавании" };
  const [ship] = residentLaborShips(holding, person);
  if (ship) return { kind: "ship", label: `Экипаж: ${text(ship.name || ship.id) || "корабль"}` };
  if (assignment.startsWith("construction")) return { kind: "construction", label: "Стройбригада" };
  if (["soldier", "defenseCommander"].includes(assignment)) return { kind: "defense", label: "Военная служба" };
  if (assignment.startsWith("ship:")) {
    const shoreDutyShipId = person.shipAssignment?.shoreDuty === true ? text(person.shipAssignment.shipId) : "";
    if (!shoreDutyShipId || shoreDutyShipId !== assignment.slice(5)) {
      return { kind: "ship", label: "Экипаж корабля" };
    }
  }
  if (["sheriff", "other"].includes(assignment) || isSheriffAppointment(person)) {
    return { kind: "control", label: text(person.role) || "Особая должность" };
  }
  return null;
}

/** Releases can be keyed by building ID, or nested by resident then building ID. */
export function buildingWorkReservations(holding = {}, { excludePersonId = "", releasedQdByPersonOrBuilding, presentIds, canRead } = {}) {
  const totals = new Map();
  for (const person of holding.people?.list ?? []) {
    const id = text(person?.id);
    if (!id || id === text(excludePersonId) || person.dead
      || (presentIds && !presentIds.has(id)) || (canRead && !canRead(person))) continue;
    const perBuilding = new Map();
    for (const row of Array.isArray(person.workAllocations) ? person.workAllocations : []) {
      const buildingId = allocationSourceId(row), qd = allocationTotalQd(row);
      if (buildingId && qd) perBuilding.set(buildingId, (perBuilding.get(buildingId) ?? 0) + qd);
    }
    for (const [buildingId, qd] of perBuilding) {
      const released = whole(at(at(releasedQdByPersonOrBuilding, id), buildingId));
      const remaining = Math.max(0, qd - released);
      if (remaining) totals.set(buildingId, (totals.get(buildingId) ?? 0) + remaining);
    }
  }
  for (const [buildingId, qd] of totals) {
    const remaining = Math.max(0, qd - whole(at(releasedQdByPersonOrBuilding, buildingId)));
    if (remaining) totals.set(buildingId, remaining);
    else totals.delete(buildingId);
  }
  return totals;
}

export function newLaborIssues(previous = [], current = []) {
  const remaining = [...previous];
  const identity = ({ message: _message, actual: _actual, limit: _limit, personName: _personName, buildingName: _buildingName, ...issue }) =>
    JSON.stringify(issue);
  return current.filter((issue) => {
    const key = identity(issue);
    const index = remaining.findIndex((prior) => identity(prior) === key
      && (issue.actual === undefined || prior.actual >= issue.actual && prior.limit <= issue.limit));
    if (index < 0) return true;
    remaining.splice(index, 1);
    return false;
  });
}

export function buildingReservedQd(holding, buildingId, options) {
  return buildingWorkReservations(holding, options).get(text(buildingId)) ?? 0;
}

export function uncollectibleProductionLine(building) {
  if (!building || buildingAcceptsWorkers(building) || building.functions?.production === false) return null;
  return (building.productionLines ?? []).find((line) => line.active !== false && line.requiresCollection
    && whole(line.collectQd) > 0 && line.autoCollect !== true) ?? null;
}
