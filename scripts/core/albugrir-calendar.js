export const ALBUGRIR_DAYS_PER_TRILUNE = 30;
export const ALBUGRIR_DAYS_PER_TENDAY = 10;
export const ALBUGRIR_QD_PER_DAY = 4;
export const ALBUGRIR_TRILUNES_PER_YEAR = 8;
export const ALBUGRIR_DAYS_PER_YEAR = ALBUGRIR_DAYS_PER_TRILUNE * ALBUGRIR_TRILUNES_PER_YEAR;
export const ALBUGRIR_TENDAYS_PER_YEAR = ALBUGRIR_DAYS_PER_YEAR / ALBUGRIR_DAYS_PER_TENDAY;
export const ALBUGRIR_QD_PER_TENDAY = ALBUGRIR_DAYS_PER_TENDAY * ALBUGRIR_QD_PER_DAY;
export const ALBUGRIR_QD_PER_MAJOR_SEASON = (ALBUGRIR_DAYS_PER_YEAR / 2) * ALBUGRIR_QD_PER_DAY;
export const ALBUGRIR_QD_PER_YEAR = ALBUGRIR_DAYS_PER_YEAR * ALBUGRIR_QD_PER_DAY;

export const ALBUGRIR_MOON_CYCLES = Object.freeze({
  ael: 10,
  muna: 28,
  treo: 62
});

export const ALBUGRIR_COMBINED_MOON_CYCLE_DAYS = 4340;

export const ALBUGRIR_TRILUNES = Object.freeze([
  Object.freeze({ id: "hladohod", name: "Хладоход", majorSeason: "ukhudno", majorSeasonLabel: "Ухудно", technicalSeasonKey: "winter", halfLabel: "Ухудно (2 половина)", short: "У-II" }),
  Object.freeze({ id: "teplorost", name: "Теплорост", majorSeason: "zarost", majorSeasonLabel: "Зарость", technicalSeasonKey: "spring", halfLabel: "Зарость (1 половина)", short: "З-I" }),
  Object.freeze({ id: "teplohod", name: "Теплоход", majorSeason: "zarost", majorSeasonLabel: "Зарость", technicalSeasonKey: "spring", halfLabel: "Зарость (1 половина)", short: "З-I" }),
  Object.freeze({ id: "znoerost", name: "Зноерост", majorSeason: "zarost", majorSeasonLabel: "Зарость", technicalSeasonKey: "summer", halfLabel: "Зарость (2 половина)", short: "З-II" }),
  Object.freeze({ id: "znoehod", name: "Зноеход", majorSeason: "zarost", majorSeasonLabel: "Зарость", technicalSeasonKey: "summer", halfLabel: "Зарость (2 половина)", short: "З-II" }),
  Object.freeze({ id: "dozhderost", name: "Дождерост", majorSeason: "ukhudno", majorSeasonLabel: "Ухудно", technicalSeasonKey: "autumn", halfLabel: "Ухудно (1 половина)", short: "У-I" }),
  Object.freeze({ id: "dozhdehod", name: "Дождеход", majorSeason: "ukhudno", majorSeasonLabel: "Ухудно", technicalSeasonKey: "autumn", halfLabel: "Ухудно (1 половина)", short: "У-I" }),
  Object.freeze({ id: "hladorost", name: "Хладорост", majorSeason: "ukhudno", majorSeasonLabel: "Ухудно", technicalSeasonKey: "winter", halfLabel: "Ухудно (2 половина)", short: "У-II" })
]);

export const ALBUGRIR_TRILUNES_BY_NAME = Object.freeze(Object.fromEntries(
  ALBUGRIR_TRILUNES.map((trilune) => [trilune.name.toLowerCase().replace(/ё/g, "е"), trilune])
));

function positiveDay(value = 1) {
  const numeric = Number(value);
  return Math.max(1, Math.floor(Number.isFinite(numeric) ? numeric : 1));
}

export function albugrirCalendarDay(absoluteDay = 1) {
  const day = positiveDay(absoluteDay);
  const zeroBased = day - 1;
  const yearIndex = Math.floor(zeroBased / ALBUGRIR_DAYS_PER_YEAR);
  const dayOfYear = (zeroBased % ALBUGRIR_DAYS_PER_YEAR) + 1;
  const triluneIndex = Math.floor((dayOfYear - 1) / ALBUGRIR_DAYS_PER_TRILUNE);
  const dayOfTrilune = ((dayOfYear - 1) % ALBUGRIR_DAYS_PER_TRILUNE) + 1;
  const trilune = ALBUGRIR_TRILUNES[triluneIndex];
  return {
    absoluteDay: day,
    yearIndex,
    dayOfYear,
    triluneIndex,
    triluneNumber: triluneIndex + 1,
    dayOfTrilune,
    tendayOfTrilune: Math.ceil(dayOfTrilune / ALBUGRIR_DAYS_PER_TENDAY),
    dayOfTenday: ((dayOfTrilune - 1) % ALBUGRIR_DAYS_PER_TENDAY) + 1,
    shadowDay: dayOfTrilune % ALBUGRIR_DAYS_PER_TENDAY === 0,
    trilune,
    majorSeason: trilune.majorSeason,
    technicalSeasonKey: trilune.technicalSeasonKey
  };
}

export function albugrirMoonCycleDay(moonId = "ael", absoluteDay = 1) {
  const cycle = ALBUGRIR_MOON_CYCLES[String(moonId ?? "").trim().toLowerCase()];
  if (!cycle) return null;
  return ((positiveDay(absoluteDay) - 1) % cycle) + 1;
}
