export function clearPersonFromAssignments(holding, personId) {
  const id = String(personId ?? "");
  if (!id || !holding || typeof holding !== "object") return false;

  for (const building of holding?.buildings?.list ?? []) {
    if (!Array.isArray(building.assignedWorkerIds)) building.assignedWorkerIds = [];
    building.assignedWorkerIds = building.assignedWorkerIds.map((value) => String(value) === id ? "" : value);
  }
  for (const crew of holding?.constructionCrews ?? []) {
    if (!Array.isArray(crew.memberIds)) crew.memberIds = [];
    crew.memberIds = crew.memberIds.filter((value) => String(value) !== id);
    if (String(crew.leaderId ?? "") === id) crew.leaderId = "";
  }
  for (const squad of holding?.gm?.defense?.squads ?? []) {
    if (!Array.isArray(squad.memberIds)) squad.memberIds = [];
    squad.memberIds = squad.memberIds.map((value) => String(value) === id ? "" : value);
    if (String(squad.sergeantId ?? "") === id) squad.sergeantId = "";
  }
  if (String(holding?.gm?.defense?.commanderId ?? "") === id) holding.gm.defense.commanderId = "";
  for (const vessel of holding?.special?.fleet?.vessels ?? []) {
    if (!vessel?.crew || typeof vessel.crew !== "object") continue;
    if (!Array.isArray(vessel.crew.memberIds)) vessel.crew.memberIds = [];
    vessel.crew.memberIds = vessel.crew.memberIds.filter((value) => String(value) !== id);
  }
  return true;
}

export function assignPersonToFleetCrew(holding, personId, vesselId) {
  const id = String(personId ?? "");
  const targetId = String(vesselId ?? "");
  if (!id || !targetId || !holding || typeof holding !== "object") return false;
  const person = (holding?.people?.list ?? []).find((row) => String(row?.id ?? "") === id);
  const vessel = (holding?.special?.fleet?.vessels ?? []).find((row) => String(row?.id ?? "") === targetId);
  const age = Number(person?.age);
  if (!person || person.dead || Math.max(0, Number(person?.injuredDays) || 0) > 0 || (Number.isFinite(age) && age < 12) || !vessel || vessel.status === "archived") return false;

  const currentIds = [...new Set((Array.isArray(vessel?.crew?.memberIds) ? vessel.crew.memberIds : [])
    .map((value) => String(value ?? ""))
    .filter(Boolean))];
  const target = Math.max(0, Math.floor(Number(vessel?.profile?.crewTarget) || 0));
  const alreadyAssigned = currentIds.includes(id);
  if (target <= 0 || (!alreadyAssigned && currentIds.length >= target)) return false;

  clearPersonFromAssignments(holding, id);
  if (!vessel.crew || typeof vessel.crew !== "object") vessel.crew = {};
  if (!Array.isArray(vessel.crew.memberIds)) vessel.crew.memberIds = [];
  vessel.crew.memberIds.push(id);
  person.workAssignment = `fleet:${targetId}`;
  person.role = vessel.name ? `Экипаж: ${vessel.name}` : "Экипаж корабля";
  return true;
}
