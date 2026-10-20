/** Recognize the existing free-text office, including legacy assignments. */
export function isSheriffAppointment(person = {}) {
  return [person.role, person.workAssignment].some((value) =>
    ["шериф", "sheriff"].includes(String(value ?? "").trim().toLocaleLowerCase("ru")));
}
