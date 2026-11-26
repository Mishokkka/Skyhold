import { residentActiveQd } from "./labor-primitives.js";

export function syncResidentLaborRole(person, { isChild = false, clearServiceRole = false } = {}) {
  if (!person) return;
  const hasAssignment = Boolean(String(person.workAssignment ?? "").trim());
  if (residentActiveQd(person) > 0) {
    if (clearServiceRole || !hasAssignment) person.role = "План QD";
  } else if (!hasAssignment && person.role === "План QD") {
    person.role = isChild ? "Ребенок" : "Свободен";
  }
}
