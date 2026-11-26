export const MILITARY_DAILY_RATES = Object.freeze({
  line: 12, militia: 12, fusiliers: 14, jaegers: 16, grenadiers: 16, sappers: 16, artillery: 18, cavalry: 20
});

export function militaryDailyWage(holding = {}, person = {}) {
  const override = person.wageDailyOverrideCopper;
  if (Number.isSafeInteger(override) && override > 0) return override;
  const relative = Number(person.militarySalaryModifier);
  const unifiedWage = person.militarySalaryModifier != null && Number.isFinite(relative);
  const modifier = Math.trunc(Number(person.salaryModifier) || 0) + (unifiedWage ? Math.trunc(relative) : 0);
  const defense = holding.gm?.defense ?? {};
  if (person.workAssignment === "defenseCommander") {
    const soldiers = (holding.people?.list ?? []).filter((row) => !row.dead && row.workAssignment === "soldier").length;
    return Math.max(1, Math.min(48, 24 + 2 * Math.ceil(soldiers / 5)) + modifier);
  }
  const squad = (defense.squads ?? []).find((row) => String(row.sergeantId ?? "") === String(person.id)
    || (row.memberIds ?? []).some((id) => String(id) === String(person.id)));
  const base = MILITARY_DAILY_RATES[squad?.type] ?? MILITARY_DAILY_RATES.line;
  return Math.max(1, base + (squad && String(squad.sergeantId) === String(person.id) ? 4 : 0) + modifier);
}
