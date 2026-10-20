import { isResidentAway, residentShipAssignment } from "../../data/resident-presence.js";

function text(value = "") {
  return String(value ?? "").trim();
}

function whole(value, fallback = 0) {
  const parsed = Number(value);
  return Math.max(0, Math.floor(Number.isFinite(parsed) ? parsed : fallback));
}

function clone(value) {
  if (value === undefined) return undefined;
  return globalThis.structuredClone ? globalThis.structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function crewResidentIds(ship = {}) {
  return (Array.isArray(ship?.crewResidentIds) ? ship.crewResidentIds : []).map(text).filter(Boolean);
}

function validateCrewResidents(holding = {}, ship = {}) {
  const shipId = text(ship?.id);
  if (!shipId) throw new TypeError("FBL Skyhold | Ship crew requires a stable ship id.");
  const residentIds = crewResidentIds(ship);
  if (new Set(residentIds).size !== residentIds.length) {
    throw new TypeError(`FBL Skyhold | Ship ${shipId} crewResidentIds contains duplicate resident ids.`);
  }
  const people = Array.isArray(holding?.people?.list) ? holding.people.list : [];
  const peopleById = new Map(people.map((person) => [text(person?.id), person]).filter(([id]) => id));
  const missing = residentIds.filter((id) => !peopleById.has(id));
  if (missing.length) {
    throw new TypeError(`FBL Skyhold | Ship ${shipId} references missing residents: ${missing.join(", ")}.`);
  }
  const conflicts = residentIds.filter((id) => {
    const assignment = residentShipAssignment(peopleById.get(id));
    return assignment?.away === true && text(assignment.shipId) !== shipId;
  });
  if (conflicts.length) {
    throw new TypeError(`FBL Skyhold | Residents already aboard another ship: ${conflicts.join(", ")}.`);
  }
  return { shipId, residentIds, peopleById };
}

function settlementPlanForResident(holding, residentId, person) {
  const buildings = [];
  for (const building of holding?.buildings?.list ?? []) {
    const buildingId = text(building?.id);
    const workerSlots = [];
    for (const [index, value] of (building?.assignedWorkerIds ?? []).entries()) {
      if (text(value) === residentId) workerSlots.push(index);
    }
    const admissionOverride = (building?.workerAdmissionOverrideIds ?? []).some((value) => text(value) === residentId);
    if (workerSlots.length || admissionOverride) buildings.push({ buildingId, workerSlots, admissionOverride });
  }

  const construction = [];
  for (const crew of holding?.constructionCrews ?? []) {
    const crewId = text(crew?.id);
    const member = (crew?.memberIds ?? []).some((value) => text(value) === residentId);
    const distributed = (crew?.distributedIds ?? []).some((value) => text(value) === residentId);
    const leader = text(crew?.leaderId) === residentId;
    const distributedLeader = text(crew?.distributedLeaderId) === residentId;
    if (member || distributed || leader || distributedLeader) construction.push({ crewId, member, distributed, leader, distributedLeader });
  }

  const defense = holding?.gm?.defense ?? {};
  const squads = [];
  for (const squad of defense?.squads ?? []) {
    const squadId = text(squad?.id);
    const memberSlots = [];
    for (const [index, value] of (squad?.memberIds ?? []).entries()) {
      if (text(value) === residentId) memberSlots.push(index);
    }
    const sergeant = text(squad?.sergeantId) === residentId;
    if (memberSlots.length || sergeant) squads.push({ squadId, memberSlots, sergeant });
  }

  return {
    workAssignment: text(person?.workAssignment),
    workAllocationMode: text(person?.workAllocationMode),
    workAllocations: clone(Array.isArray(person?.workAllocations) ? person.workAllocations : []),
    buildings,
    construction,
    legacyConstructionCrew: (holding?.constructionCrewIds ?? []).some((value) => text(value) === residentId),
    defense: {
      commander: text(defense?.commanderId) === residentId,
      squads
    }
  };
}

function clearResidentSettlementAssignments(holding, residentId, person) {
  let cleared = 0;
  for (const building of holding?.buildings?.list ?? []) {
    if (Array.isArray(building?.assignedWorkerIds)) {
      building.assignedWorkerIds = building.assignedWorkerIds.map((value) => {
        if (text(value) !== residentId) return value;
        cleared += 1;
        return "";
      });
    }
    if (Array.isArray(building?.workerAdmissionOverrideIds)) {
      const before = building.workerAdmissionOverrideIds.length;
      building.workerAdmissionOverrideIds = building.workerAdmissionOverrideIds.filter((value) => text(value) !== residentId);
      cleared += before - building.workerAdmissionOverrideIds.length;
    }
  }

  for (const crew of holding?.constructionCrews ?? []) {
    for (const field of ["memberIds", "distributedIds"]) {
      if (!Array.isArray(crew?.[field])) continue;
      const before = crew[field].length;
      crew[field] = crew[field].filter((value) => text(value) !== residentId);
      cleared += before - crew[field].length;
    }
    for (const field of ["leaderId", "distributedLeaderId"]) {
      if (text(crew?.[field]) !== residentId) continue;
      crew[field] = "";
      cleared += 1;
    }
  }
  if (Array.isArray(holding?.constructionCrewIds)) {
    const before = holding.constructionCrewIds.length;
    holding.constructionCrewIds = holding.constructionCrewIds.filter((value) => text(value) !== residentId);
    cleared += before - holding.constructionCrewIds.length;
  }

  const defense = holding?.gm?.defense;
  if (defense && typeof defense === "object") {
    if (text(defense.commanderId) === residentId) {
      defense.commanderId = "";
      cleared += 1;
    }
    for (const squad of defense.squads ?? []) {
      if (text(squad?.sergeantId) === residentId) {
        squad.sergeantId = "";
        cleared += 1;
      }
      if (Array.isArray(squad?.memberIds)) {
        squad.memberIds = squad.memberIds.map((value) => {
          if (text(value) !== residentId) return value;
          cleared += 1;
          return "";
        });
      }
    }
  }

  if (text(person?.workAssignment)) cleared += 1;
  if (Array.isArray(person?.workAllocations) && person.workAllocations.length) cleared += person.workAllocations.length;
  person.workAssignment = "";
  person.workAllocationMode = "legacy";
  person.workAllocations = [];
  if (text(person.home)) cleared += 1;
  person.home = "";
  return cleared;
}

export function returnCrewResidentToShip(holding = {}, ship = {}, residentId = "") {
  if (!holding || typeof holding !== "object") throw new TypeError("FBL Skyhold | Return to ship requires a holding draft.");
  if (!ship || typeof ship !== "object") throw new TypeError("FBL Skyhold | Return to ship requires a ship draft.");
  const shipId = text(ship.id);
  const normalizedResidentId = text(residentId);
  if (!shipId) throw new TypeError("FBL Skyhold | Ship crew requires a stable ship id.");
  if (!normalizedResidentId || !crewResidentIds(ship).includes(normalizedResidentId)) {
    throw new TypeError("FBL Skyhold | Return to ship requires a current crew resident.");
  }
  const person = (holding.people?.list ?? []).find((row) => text(row?.id) === normalizedResidentId);
  if (!person) throw new TypeError("FBL Skyhold | Return to ship requires an existing resident.");
  const clearedAssignments = clearResidentSettlementAssignments(holding, normalizedResidentId, person);
  person.shipAssignment = { ...(person.shipAssignment ?? {}), shipId, away: false };
  delete person.shipAssignment.shoreDuty;
  return { ok: true, residentId: normalizedResidentId, shipId, shoreDuty: false, clearedAssignments };
}

export function embarkShipCrew(holding = {}, ship = {}, clockQd = 0) {
  if (!holding || typeof holding !== "object") throw new TypeError("FBL Skyhold | Embark requires a holding draft.");
  if (!ship || typeof ship !== "object") throw new TypeError("FBL Skyhold | Embark requires a ship draft.");
  const { shipId, residentIds, peopleById } = validateCrewResidents(holding, ship);
  const issues = [];
  let changed = 0;
  let clearedAssignments = 0;
  for (const residentId of residentIds) {
    const person = peopleById.get(residentId);
    const existing = residentShipAssignment(person);
    if (existing?.away === true && text(existing.shipId) === shipId) continue;
    if (person?.dead) issues.push({ code: "dead", residentId, message: `${text(person?.name) || residentId}: погибший житель числится в экипаже.` });
    else if (whole(person?.injuredDays) > 0) issues.push({ code: "injured", residentId, message: `${text(person?.name) || residentId}: житель ранен.` });
    const previousSettlementPlan = settlementPlanForResident(holding, residentId, person);
    clearedAssignments += clearResidentSettlementAssignments(holding, residentId, person);
    person.shipAssignment = {
      shipId,
      away: true,
      sinceQd: whole(clockQd),
      previousSettlementPlan
    };
    changed += 1;
  }
  return { ok: true, changed, shipId, clockQd: whole(clockQd), residentIds, clearedAssignments, issues };
}

export function disembarkShipCrew(holding = {}, ship = {}, clockQd = 0) {
  if (!holding || typeof holding !== "object") throw new TypeError("FBL Skyhold | Disembark requires a holding draft.");
  if (!ship || typeof ship !== "object") throw new TypeError("FBL Skyhold | Disembark requires a ship draft.");
  const shipId = text(ship.id);
  if (!shipId) throw new TypeError("FBL Skyhold | Ship crew requires a stable ship id.");
  const residentIds = [...new Set(crewResidentIds(ship))];
  const peopleById = new Map((holding.people?.list ?? []).map((person) => [text(person.id), person]));
  let changed = 0;
  const issues = [];
  for (const residentId of residentIds) {
    const person = peopleById.get(residentId);
    if (!person) {
      issues.push({ code: "missing", residentId, message: `Житель ${residentId} удалён из поселения; оставшаяся команда возвращена.` });
      continue;
    }
    const existing = residentShipAssignment(person);
    if (!existing || text(existing.shipId) !== shipId || existing.away !== true) {
      issues.push({ code: "not-aboard", residentId, message: `${text(person?.name) || residentId}: житель не числился на борту.` });
      continue;
    }
    person.shipAssignment = {
      ...existing,
      shipId,
      away: false,
      returnedQd: whole(clockQd)
    };
    delete person.shipAssignment.shoreDuty;
    changed += 1;
  }
  return { ok: true, changed, shipId, clockQd: whole(clockQd), residentIds, clearedAssignments: 0, issues };
}

export { isResidentAway };
