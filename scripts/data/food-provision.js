export const FOOD_PROVISION_MODES = Object.freeze([
  Object.freeze({ value: "settlement", label: "Из общего склада · 1 паёк/день" }),
  Object.freeze({ value: "self", label: "Питается самостоятельно" })
]);

const MODE_IDS = new Set(FOOD_PROVISION_MODES.map((row) => row.value));

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeFoodProvisionMode(value = "", { boardFoodDaily = 1 } = {}) {
  const mode = String(value ?? "").trim().toLowerCase();
  if (MODE_IDS.has(mode)) return mode;
  const legacy = Math.max(0, finite(boardFoodDaily, 1));
  if (legacy === 0) return "self";
  if (legacy === 1) return "settlement";
  return "legacy";
}

export function foodProvisionDaily(person = {}) {
  const mode = normalizeFoodProvisionMode(person?.foodProvisionMode, {
    boardFoodDaily: person?.boardFoodDaily
  });
  if (mode === "settlement") return 1;
  if (mode === "self") return 0;
  return Math.max(0, finite(person?.boardFoodDaily, 0));
}

export function foodProvisionModeOptions(person = {}) {
  const selected = normalizeFoodProvisionMode(person?.foodProvisionMode, {
    boardFoodDaily: person?.boardFoodDaily
  });
  const options = FOOD_PROVISION_MODES.map((row) => ({ ...row, selected: row.value === selected }));
  if (selected === "legacy") {
    options.unshift({
      value: "legacy",
      label: `Наследуемая дробная норма · ${foodProvisionDaily(person)}/день`,
      selected: true,
      legacy: true
    });
  }
  return options;
}

export function foodProvisionWarning(person = {}) {
  return normalizeFoodProvisionMode(person?.foodProvisionMode, {
    boardFoodDaily: person?.boardFoodDaily
  }) === "legacy"
    ? "Выберите целый режим питания: один паёк из общего склада или самостоятельное питание."
    : "";
}

export function foodProvisionReadiness(people = []) {
  const blockers = (Array.isArray(people) ? people : [])
    .filter((person) => person && !person.dead)
    .filter((person) => normalizeFoodProvisionMode(person.foodProvisionMode, { boardFoodDaily: person.boardFoodDaily }) === "legacy")
    .map((person) => ({
      personId: String(person.id ?? ""),
      name: String(person.name ?? person.id ?? "Житель"),
      boardFoodDaily: foodProvisionDaily(person),
      code: "legacy-fractional-food-provision",
      message: `${String(person.name ?? person.id ?? "Житель")}: выберите целый режим пропитания вместо ${foodProvisionDaily(person)} пайка/день.`
    }));
  return {
    ready: blockers.length === 0,
    blockers,
    message: blockers.length ? blockers[0].message : "Режимы пропитания готовы."
  };
}
