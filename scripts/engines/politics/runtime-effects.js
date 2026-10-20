const POLITICS_EFFECTS = Symbol("fbl-skyhold-politics-effects");
let currentEffectsResolver = null;
const resolving = new WeakSet();

/** The application supplies the current context; pure consumers stay independent. */
export function setPoliticsRuntimeEffectsResolver(resolver = null) {
  currentEffectsResolver = typeof resolver === "function" ? resolver : null;
}

/** Preview-only state on the mutable tenday draft; symbols are not serialized. */
export function setPoliticsRuntimeEffects(holding, effects = null) {
  if (holding && typeof holding === "object") holding[POLITICS_EFFECTS] = effects;
}

export function politicsRuntimeEffects(holding) {
  if (!holding || typeof holding !== "object") return null;
  if (holding[POLITICS_EFFECTS]) return holding[POLITICS_EFFECTS];
  if (!currentEffectsResolver || resolving.has(holding)) return null;
  resolving.add(holding);
  try { return currentEffectsResolver(holding); }
  finally { resolving.delete(holding); }
}

/** Whole penalties keep deterministic output; sub-unit penalties use completion rolls. */
export function politicsProductionOutcome(qty, percent = 0, random = Math.random) {
  const base = Math.max(0, Math.floor(Number(qty) || 0));
  const value = Number.isFinite(Number(percent)) ? Number(percent) : 0;
  const lossRate = Math.min(1, Math.max(0, -value / 100));
  if (!base || !lossRate || base * lossRate >= 1) {
    const total = Math.max(0, Math.floor(base * Math.max(0, 1 + value / 100)));
    return { total, lost: Math.max(0, base - total), probabilistic: false };
  }
  let lost = 0;
  for (let unit = 0; unit < base; unit += 1) {
    const roll = Number(random());
    if (!Number.isFinite(roll) || roll < 0 || roll >= 1) throw new RangeError("Production random value must be in [0, 1).");
    if (roll < lossRate) lost += 1;
  }
  return { total: base - lost, lost, probabilistic: true };
}

/** Positive fractions are earned only by completed output and retained by resource. */
export function politicsProductionBonus(qty, percent = 0, previousUnits = 0) {
  const base = Math.max(0, Math.floor(Number(qty) || 0));
  const remainder = Number.isSafeInteger(previousUnits) && previousUnits >= 0 && previousUnits < 10_000 ? previousUnits : 0;
  const earned = base * Math.max(0, Math.round((Number(percent) || 0) * 100));
  const units = remainder + earned;
  if (!Number.isSafeInteger(units)) throw new RangeError("Production bonus exceeds safe integer range.");
  return { total: base + Math.floor(units / 10_000), remainderUnits: units % 10_000 };
}
