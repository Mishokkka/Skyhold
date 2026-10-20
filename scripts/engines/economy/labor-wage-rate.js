function optionalWhole(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : null;
}

/** A zero wage is valid only for explicitly volunteered labor. */
export function laborWageRate({ volunteer = false, wageOverrideCopper = null, dailyRateCopper = null } = {}) {
  const rate = optionalWhole(wageOverrideCopper) ?? optionalWhole(dailyRateCopper);
  return {
    ok: volunteer === true || (rate !== null && rate > 0),
    effectiveDailyRateCopper: volunteer === true ? 0 : rate
  };
}
