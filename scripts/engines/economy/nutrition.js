/** One sparse tenday is an emergency allowance; repeated underfeeding accumulates. */
export function nutritionBalance({ deficitDays = 0, days = 0, effectiveUnits = 10, foodGroups = {}, eaten = 0 } = {}) {
  const elapsed = Math.max(0, Number(days) || 0);
  const units = Math.max(0, Number(effectiveUnits) || 0);
  const previous = Math.max(0, Number(deficitDays) || 0);
  const deficit = units < 10 ? previous + elapsed * (1 - units / 10) : previous - elapsed;
  const nextDeficitDays = Math.round(Math.min(55, Math.max(0, deficit)) * 1000) / 1000;
  const chronicHungerLevel = Math.min(10, Math.max(0, Math.ceil((nextDeficitDays - 5) / 5)));
  const substantialGroups = Object.values(foodGroups).filter((qty) => eaten > 0 && qty / eaten >= 0.2).length;
  const diversityBonus = units >= 10 ? Math.min(2, Math.max(0, substantialGroups - 1)) : 0;
  return { deficitDays: nextDeficitDays, chronicHungerLevel, substantialGroups, diversityBonus };
}
