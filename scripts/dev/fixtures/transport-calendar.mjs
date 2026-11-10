/** Deterministic eight-month calendar; no world or Foundry settings are written. */
export const transportTestYearQd = 881 * 960;

export function transportTestDate(qd) {
  const seconds = Math.round(qd * 21600), day = Math.floor(seconds / 86400), rest = seconds % 86400;
  return { year: Math.floor(day / 240), month: Math.floor(day % 240 / 30) + 1, day: day % 30 + 1,
    hour: Math.floor(rest / 3600), minute: Math.floor(rest % 3600 / 60), second: rest % 60 };
}

const coordinate = date => (date.year * 240 + (date.month - 1) * 30 + date.day - 1) * 4
  + (date.hour ?? 0) / 6 + (date.minute ?? 0) / 360 + (date.second ?? 0) / 21600;

export function installTransportTestCalendar(nowQd = transportTestYearQd + 400) {
  const previous = globalThis.CALENDARIA;
  const calendar = { days: { hoursPerDay: 24 }, monthsArray:
    ["Хладоход", "Теплорост", "Теплоход", "Зноерост", "Зноеход", "Дождерост", "Дождеход", "Хладорост"].map(name => ({ name, days: 30 })) };
  globalThis.CALENDARIA = { api: { getActiveCalendar: () => calendar,
    getCurrentDateTime: () => transportTestDate(nowQd), dateToTimestamp: date => coordinate(date) * 21600,
    addHours: (date, hours) => transportTestDate(coordinate(date) + hours / 6),
    formatDate: date => `${date.year}-${date.month}-${date.day}` } };
  return { setNow(qd) { nowQd = qd; }, restore() { globalThis.CALENDARIA = previous; } };
}
