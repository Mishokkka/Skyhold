import { isResidentAway } from "./resident-presence.js";
import { createDefaultPoliticsState, POLITICS_STATE_VERSION } from "./politics-state.js";

/** Explicit office vacancy, independent of ordinary changes of job. */
export function vacatePoliticsRepresentative(holding, residentId, reason) {
  const politics = holding?.politics;
  if (!politics || politics.version > POLITICS_STATE_VERSION
    || !residentId || String(politics.representative?.residentId) !== String(residentId)) return false;
  politics.representative = createDefaultPoliticsState().representative;
  politics.history = [...(politics.history ?? []), { type: "representative-vacant",
    residentId: String(residentId), periodIndex: Math.floor(Math.max(0, Number(holding?.gm?.calendaria?.lastQd) || 0) / 40) + 1,
    summary: `Должность представителя освобождена: ${reason}.` }].slice(-250);
  return true;
}

export function clearPersonFromAssignments(holding, personId) {
  const id = String(personId ?? "");
  if (!id || !holding || typeof holding !== "object") return false;
  if (Array.isArray(holding.constructionCrewIds)) holding.constructionCrewIds = holding.constructionCrewIds.filter((value) => String(value) !== id);

  for (const building of holding?.buildings?.list ?? []) {
    if (!Array.isArray(building.assignedWorkerIds)) building.assignedWorkerIds = [];
    building.assignedWorkerIds = building.assignedWorkerIds.map((value) => String(value) === id ? "" : value);
    if (Array.isArray(building.workerAdmissionOverrideIds)) building.workerAdmissionOverrideIds = building.workerAdmissionOverrideIds.filter((value) => String(value) !== id);
  }
  for (const crew of holding?.constructionCrews ?? []) {
    if (!Array.isArray(crew.memberIds)) crew.memberIds = [];
    crew.memberIds = crew.memberIds.filter((value) => String(value) !== id);
    if (Array.isArray(crew.distributedIds)) crew.distributedIds = crew.distributedIds.filter((value) => String(value) !== id);
    if (String(crew.leaderId ?? "") === id) crew.leaderId = "";
    if (String(crew.distributedLeaderId ?? "") === id) crew.distributedLeaderId = "";
  }
  for (const squad of holding?.gm?.defense?.squads ?? []) {
    if (!Array.isArray(squad.memberIds)) squad.memberIds = [];
    squad.memberIds = squad.memberIds.map((value) => String(value) === id ? "" : value);
    if (String(squad.sergeantId ?? "") === id) squad.sergeantId = "";
  }
  if (String(holding?.gm?.defense?.commanderId ?? "") === id) holding.gm.defense.commanderId = "";
  return true;
}

/** Explicit resident transfer only; ordinary job changes must retain ship membership. */
export function transferResidentBetweenHoldings(source, target, residentId) {
  const id = String(residentId ?? "");
  const person = source.people?.list?.find((row) => String(row.id) === id);
  if (!person || source === target) return { ok: false, message: "Житель или целевое владение не найдены." };
  if ((target.people?.list ?? []).some((row) => String(row.id) === id)) return { ok: false, message: "В целевом владении уже есть житель с этим ID." };
  if ((target.special?.ships?.list ?? []).some((ship) => (ship.crewResidentIds ?? []).includes(id)
    || ship.commanderResidentId === id || (ship.coCommanderResidentIds ?? []).includes(id))) {
    return { ok: false, message: "В целевом владении уже есть корабельная ссылка на этого жителя. ГМ должен проверить состав." };
  }
  const ships = (source.special?.ships?.list ?? []).filter((ship) => (ship.crewResidentIds ?? []).includes(id)
    || ship.commanderResidentId === id || (ship.coCommanderResidentIds ?? []).includes(id)
    || person.shipAssignment?.shipId === ship.id);
  if (isResidentAway(person) || ships.some((ship) => ship.activeVoyage || ship.orderBundle || ship.status !== "docked"
    || ship.navigationMode === "world" && ship.location?.kind !== "home")) {
    return { ok: false, message: "Перед переносом жителя верните его корабль и экипаж домой." };
  }
  clearPersonFromAssignments(source, id);
  vacatePoliticsRepresentative(source, id, "житель перенесён в другое владение");
  for (const ship of ships) {
    ship.crewResidentIds = (ship.crewResidentIds ?? []).filter((value) => value !== id);
    ship.coCommanderResidentIds = (ship.coCommanderResidentIds ?? []).filter((value) => value !== id);
    if (ship.commanderResidentId === id) { ship.commanderResidentId = ""; ship.commanderName = ""; }
  }
  source.people.list = source.people.list.filter((row) => String(row.id) !== id);
  delete person.shipAssignment;
  person.workAssignment = "";
  person.workAllocations = [];
  person.role = "Свободен";
  person.home = "";
  target.people ??= { notes: "", list: [] };
  target.people.list ??= [];
  target.people.list.push(person);
  return { ok: true, personName: person.name || "Житель", targetName: target.name || "другое владение",
    shipIds: ships.filter((ship) => ship.navigationMode === "world").map((ship) => ship.id) };
}
