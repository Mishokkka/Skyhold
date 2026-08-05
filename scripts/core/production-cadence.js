import {
  ALBUGRIR_QD_PER_DAY,
  ALBUGRIR_QD_PER_MAJOR_SEASON,
  ALBUGRIR_QD_PER_TENDAY,
  ALBUGRIR_QD_PER_YEAR
} from "./albugrir-calendar.js";

export const PRODUCTION_CADENCES = Object.freeze(["qd", "day", "tenday", "season", "year"]);

const CADENCE_QD = Object.freeze({
  qd: 1,
  day: ALBUGRIR_QD_PER_DAY,
  tenday: ALBUGRIR_QD_PER_TENDAY,
  season: ALBUGRIR_QD_PER_MAJOR_SEASON,
  year: ALBUGRIR_QD_PER_YEAR
});

const YEAR_OPENING_UKHUDNO_QD = ALBUGRIR_QD_PER_DAY * 30;
const MAJOR_SEASON_WINDOW_OFFSET_QD = ALBUGRIR_QD_PER_MAJOR_SEASON - YEAR_OPENING_UKHUDNO_QD;

export function normalizeProductionCadence(value = "day", fallback = "day") {
  const normalizedFallback = PRODUCTION_CADENCES.includes(String(fallback)) ? String(fallback) : "day";
  const cadence = String(value ?? "").trim().toLowerCase();
  return PRODUCTION_CADENCES.includes(cadence) ? cadence : normalizedFallback;
}

export function productionCadenceSpanQd(cadence = "day", every = 1) {
  const unit = CADENCE_QD[normalizeProductionCadence(cadence)] ?? ALBUGRIR_QD_PER_DAY;
  const multiplier = Math.max(1, Math.floor(Number(every) || 1));
  return unit * multiplier;
}

export function productionCadenceWindow(line = {}, absoluteQd = 1) {
  const cadence = normalizeProductionCadence(line?.cadence ?? line?.period, "day");
  const every = Math.max(1, Math.floor(Number(line?.cadenceEvery) || 1));
  const spanQd = productionCadenceSpanQd(cadence, every);
  const elapsedQd = Math.max(1, Math.floor(Number(absoluteQd) || 1));
  // Ухудно пересекает границу года: Хладоход открывает новый год, но завершает
  // сезон, начавшийся Дождеростом в предыдущем. Сезонное окно поэтому сдвинуто
  // на три трилуния, чтобы следующая граница пришлась на конец Хладохода.
  const cadencePositionQd = cadence === "season" ? elapsedQd + MAJOR_SEASON_WINDOW_OFFSET_QD : elapsedQd;
  const bucket = Math.floor((cadencePositionQd - 1) / spanQd);
  return {
    cadence,
    every,
    spanQd,
    bucket,
    key: `${cadence}:${every}:${bucket}`,
    due: cadencePositionQd % spanQd === 0
  };
}
