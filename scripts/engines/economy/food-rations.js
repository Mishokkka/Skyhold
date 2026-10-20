export const FOOD_RATION_TIERS = Object.freeze([5, 10, 15]);

export function normalizeFoodRationUnits(value, fallback = 10) {
  const parsed = Math.floor(Number(value));
  return FOOD_RATION_TIERS.includes(parsed) ? parsed : fallback;
}

export function foodRationTierKey(units = 10) {
  const normalized = normalizeFoodRationUnits(units);
  if (normalized >= 15) return "enhanced";
  if (normalized >= 10) return "normal";
  return "sparse";
}

export function foodRationTierLabel(tier = "normal") {
  if (tier === "enhanced") return "Усиленный";
  if (tier === "sparse") return "Скудный";
  if (tier === "hunger") return "Голод";
  return "Обычный";
}

export function foodRationTarget({ residents = 0, days = 0, residentDays = null, unitsPerTenday = 10, multiplier = 1 } = {}) {
  const people = Math.max(0, Math.floor(Number(residents) || 0));
  const elapsedDays = Math.max(0, Math.floor(Number(days) || 0));
  const presence = residentDays === null || residentDays === undefined
    ? people * elapsedDays
    : Math.max(0, Number(residentDays) || 0);
  const units = normalizeFoodRationUnits(unitsPerTenday);
  return Math.ceil((presence * units * Math.max(0, Number(multiplier) || 0)) / 10);
}

export function resolveFoodRation({ residents = 0, days = 0, residentDays = null, available = 0, selectedUnits = 10, multiplier = 1 } = {}) {
  const selected = normalizeFoodRationUnits(selectedUnits);
  const stock = Math.max(0, Math.floor(Number(available) || 0));
  const exactResidentDays = residentDays === null || residentDays === undefined
    ? Math.max(0, Math.floor(Number(residents) || 0) * Math.floor(Number(days) || 0))
    : Math.max(0, Number(residentDays) || 0);
  const targets = Object.fromEntries(FOOD_RATION_TIERS.map((units) => [units, foodRationTarget({ residentDays: exactResidentDays, unitsPerTenday: units, multiplier })]));
  const minimumTarget = targets[5];
  const selectedTarget = targets[selected];
  const consumeTarget = Math.min(stock, selectedTarget);
  const achievedUnits = selectedTarget > 0 ? selected * consumeTarget / selectedTarget : selected;
  const moraleModifier = Math.round(Math.max(-2, Math.min(1, (achievedUnits - 10) / 5)) * 100) / 100;
  const minimumShortfall = Math.max(0, minimumTarget - stock);
  const hungryResidentDays = multiplier === 1
    ? Math.min(Math.ceil(exactResidentDays), minimumShortfall * 2)
    : Math.min(Math.ceil(exactResidentDays), minimumTarget ? Math.ceil(exactResidentDays * minimumShortfall / minimumTarget) : 0);
  const effectiveTier = achievedUnits >= 15 ? "enhanced" : achievedUnits >= 10 ? "normal" : achievedUnits >= 5 ? "sparse" : "hunger";
  return {
    selectedUnits: selected,
    selectedTier: foodRationTierKey(selected),
    selectedTarget,
    minimumTarget,
    consumeTarget,
    achievedUnits,
    moraleModifier,
    effectiveTier,
    fallback: consumeTarget < selectedTarget,
    hungryResidentDays
  };
}
