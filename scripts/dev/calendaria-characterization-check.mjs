import assert from "node:assert/strict";
import {
  calendariaDateKey,
  calendariaDateTimeToInput,
  calendariaMonthNumber,
  getCalendariaSeasonSnapshot,
  getCalendariaSnapshot,
  normalizeCalendariaDateTime,
  parseCalendariaDateInput,
  resolveCalendariaSeason
} from "../integrations/calendaria-bridge.js";
import { BuildingProductionDomain } from "../apps/domains/building/production-domain.js";

const MONTHS = [
  ["Хладоход", "winter", "Ухудно (2 половина)"],
  ["Теплорост", "spring", "Зарость (1 половина)"],
  ["Теплоход", "spring", "Зарость (1 половина)"],
  ["Зноерост", "summer", "Зарость (2 половина)"],
  ["Зноеход", "summer", "Зарость (2 половина)"],
  ["Дождерост", "autumn", "Ухудно (1 половина)"],
  ["Дождеход", "autumn", "Ухудно (1 половина)"],
  ["Хладорост", "winter", "Ухудно (2 половина)"]
];

function restoreGlobal(name, value, existed) {
  if (existed) globalThis[name] = value;
  else delete globalThis[name];
}

export function checkCalendariaCharacterization() {
  const calendar = {
    days: { hoursPerDay: 24 },
    monthsArray: MONTHS.map(([name], index) => ({
      name,
      days: 30,
      numericRepresentation: index + 1
    }))
  };

  MONTHS.forEach(([name, key, label], monthIndex) => {
    const monthNumber = monthIndex + 1;
    const resolved = resolveCalendariaSeason({ year: 881, month: monthNumber, day: 18 }, calendar);
    assert.equal(resolved?.monthName, name, `${name} must resolve from the Calendaria public month number`);
    assert.equal(resolved?.monthNumber, monthIndex + 1, `${name} must preserve its human month number`);
    assert.equal(resolved?.key, key, `${name} must map to the expected production season`);
    assert.equal(resolved?.label, label, `${name} must map to the expected display season`);
  });

  assert.equal(calendariaMonthNumber({ month: 8 }, calendar), 8, "Calendaria public month 8 must display as month 8");
  assert.equal(calendariaMonthNumber({ month: 9 }, calendar), "", "out-of-range month 9 must not display for an 8-month calendar");
  assert.deepEqual(
    normalizeCalendariaDateTime({ year: 881, month: 7, dayOfMonth: 17, hour: 18, minute: 45 }, calendar),
    { year: 881, month: 8, hour: 18, minute: 45, day: 18 },
    "internal Calendaria components must be converted to public month/day numbers"
  );
  assert.equal(calendariaDateKey({ year: 881, month: 8, day: 18 }, calendar), "881-8-18", "date keys must use human month numbers");

  const hadCalendaria = Object.hasOwn(globalThis, "CALENDARIA");
  const previousCalendaria = globalThis.CALENDARIA;
  let timestampInput = null;
  globalThis.CALENDARIA = {
    api: {
      getActiveCalendar: () => calendar,
      getCurrentDateTime: () => ({ year: 881, month: 8, day: 18, hour: 13, minute: 0 }),
      getCurrentSeason: () => ({ name: "Зарость (1 половина)" }),
      getCurrentWeather: () => null,
      formatDate: () => "18 Хладорост 881",
      dateToTimestamp: (dateTime) => {
        timestampInput = { ...dateTime };
        return 12345;
      }
    }
  };

  try {
    assert.equal(
      calendariaDateTimeToInput({ year: 881, month: 8, day: 18, hour: 13, minute: 0 }),
      "881-08-18 13:00",
      "date input must keep Calendaria's public month number"
    );
    const parsed = parseCalendariaDateInput("881-08-18 13:00");
    assert.equal(parsed?.month, 8, "date input month 8 must stay as Calendaria public month 8");
    assert.equal(parsed?.day, 18, "date parsing must preserve the day");
    assert.equal(
      calendariaDateTimeToInput({ year: 881, month: 8, day: 3, hour: 18, minute: 45 }),
      "881-08-03 18:45",
      "Calendaria public month 8 must render as month 08, not as month 09"
    );
    assert.equal(parseCalendariaDateInput("881-09-03 18:45"), null, "manual input must reject month 09 for an 8-month calendar");
    assert.equal(parseCalendariaDateInput("881-08-31 18:45"), null, "manual input must reject day 31 for a 30-day month");

    const snapshot = getCalendariaSnapshot();
    assert.equal(snapshot.dateKey, "881-8-18", "snapshot date keys must use human month numbers");
    assert.equal(snapshot.season?.key, "winter", "snapshot season must be derived from Хладорост, not a stale native season");
    assert.equal(snapshot.season?.label, "Ухудно (2 половина)", "snapshot must display the canonical winter label");
    assert.equal(snapshot.nativeSeason?.name, "Зарость (1 половина)", "snapshot must retain the native season for diagnostics");
    assert.equal(timestampInput?.month, 8, "timestamp conversion must receive Calendaria's public month number");
    assert.equal(
      BuildingProductionDomain._currentProductionSeasonKey(snapshot),
      "winter",
      "production must use the canonical season key derived from the current month"
    );
    const settlementSnapshot = getCalendariaSeasonSnapshot({ year: 881, month: 2, day: 18, hour: 0, minute: 0 });
    assert.equal(settlementSnapshot?.season?.key, "spring", "an arbitrary settlement date must resolve independently from the current world date");
    assert.equal(snapshot.season?.key, "winter", "resolving a settlement season must not replace the current world snapshot");
    assert.equal(
      getCalendariaSeasonSnapshot(null, "18 Хладорост, 881")?.season?.key,
      "winter",
      "legacy text-only settlement dates must still resolve their season"
    );
    assert.equal(
      getCalendariaSeasonSnapshot({ year: 881, month: 8, day: 18 }, "18 Хладорост, 881")?.season?.key,
      "winter",
      "legacy off-by-one structured dates must fall back to their stored month text"
    );
  } finally {
    restoreGlobal("CALENDARIA", previousCalendaria, hadCalendaria);
  }
}
