function text(value = "") {
  return String(value ?? "").trim();
}

/**
 * Return the persisted ship-presence marker for a resident, when valid.
 * The marker is deliberately small and remains on the resident after return
 * so the UI can show the last voyage without reviving an old job assignment.
 */
export function residentShipAssignment(person = {}) {
  const assignment = person?.shipAssignment;
  if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)) return null;
  const shipId = text(assignment.shipId);
  if (!shipId) return null;
  return assignment;
}

export function isResidentAway(person = {}) {
  return residentShipAssignment(person)?.away === true;
}

export function isResidentPresent(person = {}) {
  return !isResidentAway(person);
}

/** Membership is current; shipAssignment alone may describe a previous voyage. */
export function shipForResident(person = {}, holding = null) {
  const id = text(person.id);
  if (!id || !holding) return null;
  return (holding.special?.ships?.list ?? []).find((ship) =>
    (ship.crewResidentIds ?? []).some((residentId) => text(residentId) === id)) ?? null;
}

export function hasResidentSettlementWork(person = {}, holding = null) {
  if (person.staffAppointment?.buildingId) return true;
  if (text(person.workAssignment) || (person.workAllocations ?? []).some((row) => Number(row.normalQd ?? row.qd) > 0 || Number(row.overtimeQd) > 0)) return true;
  if (!holding) return false;
  const id = text(person.id);
  if (!id) return false;
  const contains = (ids) => (ids ?? []).some((value) => text(value) === id);
  if ((holding.buildings?.list ?? []).some((row) => contains(row.assignedWorkerIds))) return true;
  if (contains(holding.constructionCrewIds) || (holding.constructionCrews ?? []).some((row) =>
    contains(row.memberIds) || contains(row.distributedIds) || text(row.leaderId) === id || text(row.distributedLeaderId) === id)) return true;
  const defense = holding.gm?.defense;
  return text(defense?.commanderId) === id || (defense?.squads ?? []).some((row) => contains(row.memberIds) || text(row.sergeantId) === id);
}

export function isResidentRestingOnShip(person = {}, holding = null) {
  if (person.dead || isResidentAway(person)) return false;
  const ship = shipForResident(person, holding);
  const assignment = residentShipAssignment(person);
  if (holding ? !ship : !assignment) return false;
  if (ship && (ship.activeVoyage || ship.status === "away" || (ship.location && ship.location.kind !== "home"))) return false;
  if (assignment?.shoreDuty === true && (!ship || text(assignment.shipId) === text(ship.id))) return false;
  // Existing explicit jobs survive this feature; reading never rewrites them.
  return !hasResidentSettlementWork(person, holding);
}

export function isResidentInPopulation(person = {}, holding = null) {
  return !person.dead && isResidentPresent(person) && !isResidentRestingOnShip(person, holding);
}
