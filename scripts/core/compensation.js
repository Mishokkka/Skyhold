import { foodProvisionDaily, foodProvisionWarning, normalizeFoodProvisionMode } from "../data/food-provision.js";

export const COMPENSATION_TYPES = Object.freeze([
  Object.freeze({ value: "wage", label: "Денежная ставка без пансиона" }),
  Object.freeze({ value: "wage-with-board", label: "Ставка с пансионом" }),
  Object.freeze({ value: "share", label: "Доля результата" }),
  Object.freeze({ value: "dependent", label: "Член хозяйства на содержании" }),
  Object.freeze({ value: "volunteer", label: "Добровольная работа" }),
  Object.freeze({ value: "coerced", label: "Принудительный труд" })
]);

const TYPE_IDS = new Set(COMPENSATION_TYPES.map((row) => row.value));
const FIXED_WAGE_TYPES = new Set(["wage", "wage-with-board"]);

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeCompensationType(value = "", { salary = 0, assigned = false } = {}) {
  const type = String(value ?? "").trim().toLowerCase();
  if (TYPE_IDS.has(type)) return type;
  if (finite(salary, 0) > 0) return "wage-with-board";
  return assigned ? "volunteer" : "dependent";
}

export function isFixedWageCompensation(value = "") {
  return FIXED_WAGE_TYPES.has(String(value ?? ""));
}

export function compensationTypeLabel(value = "") {
  return COMPENSATION_TYPES.find((row) => row.value === String(value ?? ""))?.label ?? "Договор не указан";
}

export function compensationTypeOptions(current = "") {
  const selected = String(current ?? "");
  return COMPENSATION_TYPES.map((row) => ({ ...row, selected: row.value === selected }));
}

export function personCashWageDaily(person = {}) {
  return Math.max(0, finite(person.cashWageDaily ?? person.salary, 0));
}

export function personBoardFoodDaily(person = {}) {
  return foodProvisionDaily(person);
}

export function personShareRate(person = {}) {
  return Math.max(0, Math.min(1, finite(person.shareRate, 0)));
}

export function defaultBoardFoodDaily(type = "dependent") {
  return ["wage-with-board", "dependent", "coerced"].includes(String(type ?? "")) ? 1 : 0;
}

export function hasProvidedHousing(person = {}) {
  return Boolean(person.housingProvided);
}

export function compensationContractWarning(person = {}) {
  const type = normalizeCompensationType(person.compensationType, {
    salary: personCashWageDaily(person),
    assigned: Boolean(String(person.workAssignment ?? "").trim())
  });
  const note = String(person.compensationNote ?? "").trim();
  const provisionWarning = foodProvisionWarning(person);
  if (provisionWarning) return provisionWarning;
  if (isFixedWageCompensation(type) && personCashWageDaily(person) <= 0) return "У наёмного договора нулевая денежная ставка.";
  if (["volunteer", "coerced"].includes(type) && !note) return "Для этого договора нужна явная причина или условие.";
  if (type === "share" && personShareRate(person) <= 0) return "Для долевого договора не указана доля результата.";
  if (type === "wage-with-board" && normalizeFoodProvisionMode(person.foodProvisionMode, { boardFoodDaily: person.boardFoodDaily }) !== "settlement" && !hasProvidedHousing(person)) return "Договор с пансионом не содержит ни питания, ни жилья.";
  return "";
}
