export const MAX_HUNGER_LEVEL = 10;
export const HUNGER_PENALTY_PER_LEVEL = 0.05;
export const MIN_HUNGER_FACTOR = 0.5;

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeHungerLevel(value, fallback = 0) {
  const normalizedFallback = Math.max(0, Math.min(MAX_HUNGER_LEVEL, Math.floor(finite(fallback, 0))));
  return Math.max(0, Math.min(MAX_HUNGER_LEVEL, Math.floor(finite(value, normalizedFallback))));
}

export function hungerLevelForShortage({ hungryResidentDays = 0, livingCount = 0 } = {}) {
  const residents = Math.max(0, Math.floor(finite(livingCount, 0)));
  const shortageDays = Math.max(0, Math.floor(finite(hungryResidentDays, 0)));
  if (!residents || !shortageDays) return 0;
  return normalizeHungerLevel(Math.ceil(shortageDays / residents));
}

export function hungerPenaltyFactor(level = 0) {
  const normalized = normalizeHungerLevel(level);
  return Math.max(MIN_HUNGER_FACTOR, 1 - normalized * HUNGER_PENALTY_PER_LEVEL);
}

export function settlementHungerFactor(holding = {}) {
  return hungerPenaltyFactor(holding?.gm?.food?.hungerLevel);
}

export function applySettlementHunger({ holding, hungryResidentDays = 0, livingCount = 0, minimumLevel = 0, periodDays = 10, report = null } = {}) {
  if (!holding || typeof holding !== "object") {
    throw new TypeError("FBL Skyhold | Hunger update requires a holding draft.");
  }
  if (!holding.gm || typeof holding.gm !== "object") holding.gm = {};
  if (!holding.gm.food || typeof holding.gm.food !== "object") holding.gm.food = {};

  const before = normalizeHungerLevel(holding.gm.food.hungerLevel);
  const acuteBefore = Math.max(0, Math.min(10, finite(holding.gm.food.hungerAcuteDays, before)));
  const missingDays = Math.max(0, finite(hungryResidentDays)) / Math.max(1, finite(livingCount, 1));
  const acuteDays = Math.max(0, Math.min(10, acuteBefore + missingDays - (missingDays > 0 ? 0 : Math.max(0, finite(periodDays, 10)))));
  holding.gm.food.hungerAcuteDays = acuteDays;
  const after = Math.max(normalizeHungerLevel(minimumLevel), normalizeHungerLevel(Math.ceil(acuteDays)));
  const factor = hungerPenaltyFactor(after);
  holding.gm.food.hungerLevel = after;

  if (report?.food) {
    report.food.hungerLevelBefore = before;
    report.food.hungerLevelAfter = after;
    report.food.hungerFactor = factor;
    if (after > 0) {
      report.food.lines?.push?.(`Уровень голода: ${before} → ${after}; производительность и довольство ${Math.round(factor * 100)}%.`);
    } else if (before > 0) {
      report.food.lines?.push?.("Голод снят: питание восстановлено; производительность и довольство восстановлены.");
    }
  }

  return { before, after, factor, hungryResidentDays: Math.max(0, Math.floor(finite(hungryResidentDays, 0))) };
}
