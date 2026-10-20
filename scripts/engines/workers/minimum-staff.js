/** Minimum operating team, independent of output/qualification multipliers. */
export function minimumStaffStatus(building = {}, people = []) {
  const minimum = Math.max(0, Math.floor(Number(building.workersMin) || 0));
  const ids = new Set(people.filter((person) => person && !person.dead && !(Number(person.injuredDays) > 0))
    .map((person) => String(person.id ?? "")).filter(Boolean));
  return { met: ids.size >= minimum, minimum, count: ids.size,
    text: `минимум ${minimum}, доступно ${ids.size} работников` };
}
