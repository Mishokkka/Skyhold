export const DEFAULT_WAGE_INDEX = 1;
export const MIN_WAGE_INDEX = 0.5;
export const MAX_WAGE_INDEX = 2;

export const WAGE_CLASS_IDS = Object.freeze(["common", "skilled", "expert"]);

export const WAGE_CATALOG = Object.freeze([
  Object.freeze({ id: "common", label: "Обычный труд", baseCopperPerTenday: 50 }),
  Object.freeze({ id: "skilled", label: "Квалифицированный труд", baseCopperPerTenday: 80 }),
  Object.freeze({ id: "expert", label: "Экспертный труд", baseCopperPerTenday: 120 })
]);

const WAGE_BY_ID = new Map(WAGE_CATALOG.map((row) => [row.id, row]));

export function wageClassDef(wageClassId) {
  const id = String(wageClassId ?? "").trim();
  const row = WAGE_BY_ID.get(id);
  if (!row) throw new RangeError(`Unknown wage class: ${id || "(empty)"}`);
  return row;
}

export function normalizeWageIndex(value = DEFAULT_WAGE_INDEX) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_WAGE_INDEX;
  return Math.min(MAX_WAGE_INDEX, Math.max(MIN_WAGE_INDEX, numeric));
}

export function wageCopperPerTenday(wageClassId, { wageIndex = DEFAULT_WAGE_INDEX } = {}) {
  const wageClass = wageClassDef(wageClassId);
  const obligation = Math.max(0, Math.round(wageClass.baseCopperPerTenday * normalizeWageIndex(wageIndex)));
  if (!Number.isSafeInteger(obligation)) throw new RangeError("Indexed wage exceeds the safe whole-copper range.");
  return obligation;
}

export function wageObligationCopper({ wageClassId, tendays = 1, wageIndex = DEFAULT_WAGE_INDEX } = {}) {
  const periods = Number(tendays);
  if (!Number.isInteger(periods) || periods < 0) {
    throw new RangeError("Wage obligations require a non-negative whole number of tendays.");
  }
  const obligation = wageCopperPerTenday(wageClassId, { wageIndex }) * periods;
  if (!Number.isSafeInteger(obligation)) throw new RangeError("Wage obligation exceeds the safe whole-copper range.");
  return obligation;
}
