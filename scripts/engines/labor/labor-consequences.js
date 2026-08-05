import { isFixedWageCompensation, normalizeCompensationType, personShareRate } from "../../core/compensation.js";
import { employmentContractState } from "../../data/labor/employment-terms.js";
import { ageGroupFromAge } from "../../generators/resident-rules.js";

export const LABOR_CONSEQUENCES_SCHEMA_VERSION = 1;

export const LABOR_STREAK_STEPS = Object.freeze([
  Object.freeze({ minimum: 0, laborFactor: 1, moraleDelta: 0, level: "clear" }),
  Object.freeze({ minimum: 1, laborFactor: 0.75, moraleDelta: -0.5, level: "strained" }),
  Object.freeze({ minimum: 2, laborFactor: 0.5, moraleDelta: -1, level: "severe" }),
  Object.freeze({ minimum: 3, laborFactor: 0, moraleDelta: -2, level: "stopped" })
]);

export const LABOR_COMPENSATION_FACTORS = Object.freeze({
  paid: 1,
  share: 1,
  volunteer: 0.75,
  coerced: 0.5,
  dependent: 0
});

export const LABOR_COMPENSATION_MORALE = Object.freeze({
  paid: 0,
  share: 0,
  volunteer: -0.25,
  coerced: -2,
  dependent: 0
});

const KNOWN_COMPENSATION_TYPES = new Set([
  "wage",
  "wage-with-board",
  "share",
  "dependent",
  "volunteer",
  "coerced"
]);

const INACTIVE_EMPLOYMENT_REASONS = new Set([
  "before-contract",
  "after-contract",
  "inactive-season"
]);

const FREE_ASSIGNMENTS = new Set([
  "",
  "free",
  "unassigned",
  "child",
  "свободен",
  "без работы",
  "ребенок",
  "ребёнок"
]);

function text(value = "") {
  return String(value ?? "").trim();
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nonnegativeWhole(value, fallback = 0) {
  const parsed = finiteNumber(value, fallback);
  const whole = Math.max(0, Math.floor(parsed));
  return Number.isSafeInteger(whole) ? whole : fallback;
}

function optionalSafeQd(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const qd = Math.floor(numeric);
  return Number.isSafeInteger(qd) ? qd : null;
}

function signed(value) {
  const numeric = finiteNumber(value, 0);
  return `${numeric > 0 ? "+" : ""}${String(numeric).replace(".", ",")}`;
}

function percent(value) {
  return `${Math.round(Math.max(0, Math.min(1, finiteNumber(value, 0))) * 100)}%`;
}

function assignedAsWorker(person = {}, explicitValue) {
  if (typeof explicitValue === "boolean") return explicitValue;
  const assignment = text(person?.workAssignment).toLocaleLowerCase("ru");
  return !FREE_ASSIGNMENTS.has(assignment);
}

function childStatus(person = {}, explicitValue) {
  if (typeof explicitValue === "boolean") return explicitValue;
  if (person?.child === true || person?.isChild === true) return true;
  const group = text(person?.ageGroup) || ageGroupFromAge(person?.age, person?.race, person?.subrace);
  return group === "Ре" && nonnegativeWhole(person?.age, 0) < 12;
}

function injuryStatus(person = {}, explicitValue) {
  if (typeof explicitValue === "boolean") return explicitValue;
  return person?.injured === true || person?.isInjured === true || nonnegativeWhole(person?.injuredDays, 0) > 0;
}

function streakValue(value) {
  if (value && typeof value === "object") {
    return nonnegativeWhole(value.streakTendays ?? value.tendays ?? value.overdueTendays, 0);
  }
  return nonnegativeWhole(value, 0);
}

function stepForStreak(streak) {
  return [...LABOR_STREAK_STEPS].reverse().find((step) => streak >= step.minimum) ?? LABOR_STREAK_STEPS[0];
}

function consequenceComponent({ id, label, active = true, laborFactor = 1, moraleDelta = 0, level = "clear" } = {}) {
  const component = {
    id: text(id),
    label: text(label),
    active: Boolean(active),
    laborFactor: Math.max(0, Math.min(1, finiteNumber(laborFactor, 1))),
    moraleDelta: finiteNumber(moraleDelta, 0),
    level: text(level) || "clear"
  };
  return { ...component, description: describeLaborConsequenceComponent(component) };
}

function streakComponent(id, label, streak) {
  const normalizedStreak = streakValue(streak);
  const step = stepForStreak(normalizedStreak);
  return {
    ...consequenceComponent({
      id,
      label: `${label}: ${normalizedStreak} дес.`,
      active: normalizedStreak > 0,
      laborFactor: step.laborFactor,
      moraleDelta: step.moraleDelta,
      level: step.level
    }),
    streakTendays: normalizedStreak
  };
}

function termState({ startQd, endQd, currentQd, kind }) {
  if (startQd === null || endQd === null) {
    return { valid: false, active: false, reason: `${kind}-missing-term` };
  }
  if (endQd < startQd) return { valid: false, active: false, reason: `${kind}-invalid-term` };
  if (currentQd === null) return { valid: false, active: false, reason: "missing-current-qd" };
  if (currentQd < startQd) return { valid: true, active: false, reason: `${kind}-not-started` };
  if (currentQd > endQd) return { valid: true, active: false, reason: `${kind}-expired` };
  return { valid: true, active: true, reason: "active" };
}

function inactiveContract(type, reason, overrides = {}) {
  return {
    type,
    valid: true,
    active: false,
    reason,
    wageEligible: false,
    wageDueMode: "none",
    laborFactor: 0,
    moraleDelta: 0,
    eventRisks: [],
    ...overrides
  };
}

function assessFixedWageContract(person, context) {
  const employment = employmentContractState(person, context);
  const inactive = INACTIVE_EMPLOYMENT_REASONS.has(employment.reason);
  const valid = employment.reason === "active" || inactive;
  const wageDueMode = employment.employmentMode === "day-labor" ? "worked-days" : "fixed-tariff";
  return {
    type: context.compensationType,
    valid,
    active: employment.active,
    reason: employment.reason,
    wageEligible: employment.active,
    wageDueMode: employment.active ? wageDueMode : "none",
    laborFactor: employment.active ? LABOR_COMPENSATION_FACTORS.paid : 0,
    moraleDelta: LABOR_COMPENSATION_MORALE.paid,
    eventRisks: [],
    employment
  };
}

function assessShareContract(person, context) {
  const shareRate = personShareRate(person);
  const valid = shareRate > 0;
  return {
    type: context.compensationType,
    valid,
    active: valid,
    reason: valid ? "active" : "missing-share-rate",
    wageEligible: false,
    wageDueMode: valid ? "profit-share" : "none",
    laborFactor: valid ? LABOR_COMPENSATION_FACTORS.share : 0,
    moraleDelta: LABOR_COMPENSATION_MORALE.share,
    eventRisks: [],
    shareRate
  };
}

function assessVolunteerContract(person, context) {
  const reasonText = text(person?.volunteerReason || person?.compensationNote);
  const startQd = optionalSafeQd(person?.volunteerTermStartQd ?? person?.employmentContractStartQd);
  const endQd = optionalSafeQd(person?.volunteerTermEndQd ?? person?.employmentContractEndQd);
  if (!reasonText) {
    return inactiveContract(context.compensationType, "volunteer-missing-reason", { valid: false, startQd, endQd });
  }
  const term = termState({ startQd, endQd, currentQd: context.currentQd, kind: "volunteer" });
  if (!term.active) {
    return inactiveContract(context.compensationType, term.reason, {
      valid: term.valid,
      reasonText,
      startQd,
      endQd
    });
  }
  return {
    type: context.compensationType,
    valid: true,
    active: true,
    reason: "active",
    reasonText,
    startQd,
    endQd,
    wageEligible: false,
    wageDueMode: "none",
    laborFactor: LABOR_COMPENSATION_FACTORS.volunteer,
    moraleDelta: LABOR_COMPENSATION_MORALE.volunteer,
    eventRisks: [{ id: "volunteer-fatigue", level: "low", active: true }]
  };
}

function assessCoercedContract(person, context) {
  const basis = text(person?.coercionBasis || person?.compensationNote);
  if (!basis) return inactiveContract(context.compensationType, "coerced-missing-basis", { valid: false });
  return {
    type: context.compensationType,
    valid: true,
    active: true,
    reason: "active",
    basis,
    wageEligible: false,
    wageDueMode: "none",
    laborFactor: LABOR_COMPENSATION_FACTORS.coerced,
    moraleDelta: LABOR_COMPENSATION_MORALE.coerced,
    eventRisks: [{ id: "coerced-labor-unrest", level: "high", active: true }]
  };
}

function assessCompensationContract(person, context) {
  if (isFixedWageCompensation(context.compensationType)) return assessFixedWageContract(person, context);
  if (context.compensationType === "share") return assessShareContract(person, context);
  if (context.compensationType === "dependent") return inactiveContract(context.compensationType, "dependent");
  if (context.compensationType === "volunteer") return assessVolunteerContract(person, context);
  if (context.compensationType === "coerced") return assessCoercedContract(person, context);
  return inactiveContract(context.compensationType, "unknown-compensation-type", { valid: false });
}

function blockerMessage(code) {
  const messages = {
    "dead-worker": "Погибший житель не может быть назначен работником.",
    "child-worker": "Ребёнок не может быть назначен работником.",
    "dependent-worker": "Иждивенец не может работать без явного трудового договора.",
    "missing-wage-class": "Для оплачиваемой работы не выбран класс ставки Economy V2.",
    "invalid-contract-term": "Срок оплачиваемого договора задан неверно.",
    "missing-current-qd": "Нельзя проверить договор без даты следующего десятника.",
    "missing-season": "Нельзя проверить сезонный договор без сезона следующего десятника.",
    "volunteer-missing-reason": "Для добровольной работы нужна явная причина.",
    "volunteer-missing-term": "Добровольная работа требует конечного срока начала и окончания.",
    "volunteer-invalid-term": "Срок добровольной работы задан неверно.",
    "coerced-missing-basis": "Для принудительного труда нужно явно указать основание.",
    "missing-share-rate": "Для долевого договора нужна положительная доля результата.",
    "unknown-compensation-type": "Тип трудового договора не распознан."
  };
  return messages[code] ?? `Трудовой договор заблокирован: ${code}.`;
}

export function describeLaborConsequenceComponent(component = {}) {
  const label = text(component?.label) || text(component?.id) || "Фактор";
  return `${label}: труд ${percent(component?.laborFactor)}, довольство ${signed(component?.moraleDelta)}.`;
}

export function describeLaborAssessment(assessment = {}) {
  const labor = percent(assessment?.laborFactor);
  const morale = signed(assessment?.moraleDelta);
  const state = assessment?.blocked
    ? `заблокировано (${(assessment?.blockers ?? []).map((row) => row.message).join("; ")})`
    : (assessment?.laborEligible ? "доступно" : "недоступно");
  return `Труд на следующий десятник: ${state}; эффективность ${labor}; довольство ${morale}.`;
}

/**
 * Pure assessment for the next tenday. `currentQd` and `season` describe the
 * target tenday being assessed, not the tenday that has just been applied.
 */
export function assessNextTendayLabor(person = {}, options = {}) {
  const rawCompensationType = text(person?.compensationType).toLocaleLowerCase("en");
  const compensationType = KNOWN_COMPENSATION_TYPES.has(rawCompensationType)
    ? rawCompensationType
    : (rawCompensationType || normalizeCompensationType(rawCompensationType, {
      salary: person?.cashWageDaily ?? person?.salary,
      assigned: assignedAsWorker(person, options?.assignedAsWorker)
    }));
  const currentQd = optionalSafeQd(options?.currentQd);
  const season = text(options?.season?.key ?? options?.season?.id ?? options?.season).toLocaleLowerCase("en");
  const isAssigned = assignedAsWorker(person, options?.assignedAsWorker);
  const living = options?.living === undefined ? !person?.dead : Boolean(options.living);
  const child = childStatus(person, options?.child);
  const injured = injuryStatus(person, options?.injured);
  const context = { currentQd, season, compensationType };
  const contract = assessCompensationContract(person, context);
  const blockers = [];

  if (isAssigned && !living) blockers.push("dead-worker");
  if (isAssigned && child) blockers.push("child-worker");
  if (isAssigned && compensationType === "dependent") blockers.push("dependent-worker");
  if (isAssigned && !contract.valid) blockers.push(contract.reason);

  const physicalFactor = living && !child && !injured ? 1 : 0;
  const physicalReason = !living ? "dead" : (child ? "child" : (injured ? "injured" : "available"));
  const contractComponent = consequenceComponent({
    id: `contract:${compensationType}`,
    label: `Договор (${compensationType})`,
    active: isAssigned && contract.active,
    laborFactor: isAssigned ? contract.laborFactor : 1,
    moraleDelta: isAssigned ? contract.moraleDelta : 0,
    level: contract.reason
  });
  const physicalComponent = consequenceComponent({
    id: "physical-availability",
    label: `Доступность (${physicalReason})`,
    active: physicalFactor < 1,
    laborFactor: physicalFactor,
    moraleDelta: 0,
    level: physicalReason
  });
  const arrears = streakComponent("arrears", "Просрочка оплаты", options?.payrollAccount?.overdueTendays ?? options?.arrearsStreak);
  const hunger = streakComponent("hunger", "Голод", options?.hungerStreak);
  const components = [contractComponent, physicalComponent, arrears, hunger];
  const blocked = blockers.length > 0;
  const laborFactor = blocked ? 0 : Math.min(...components.map((component) => component.laborFactor));
  const moraleDelta = living ? components.reduce((sum, component) => sum + component.moraleDelta, 0) : 0;
  const eventRisks = living ? [
    ...(isAssigned ? (contract.eventRisks ?? []) : []),
    ...(arrears.streakTendays >= 2 ? [{ id: "payroll-arrears-unrest", level: arrears.streakTendays >= 3 ? "high" : "medium", active: true }] : []),
    ...(hunger.streakTendays >= 2 ? [{ id: "hunger-crisis", level: hunger.streakTendays >= 3 ? "high" : "medium", active: true }] : [])
  ] : [];
  const assessment = {
    schemaVersion: LABOR_CONSEQUENCES_SCHEMA_VERSION,
    personId: text(person?.id),
    evaluationQd: currentQd,
    season,
    assignedAsWorker: isAssigned,
    living,
    child,
    injured,
    physicalReason,
    compensationType,
    contract,
    contractValid: contract.valid,
    contractActive: contract.active,
    blocked,
    blockers: [...new Set(blockers)].map((code) => ({ code, message: blockerMessage(code) })),
    laborEligible: isAssigned && !blocked && contract.active && physicalFactor > 0 && laborFactor > 0,
    wageEligible: living && contract.wageEligible,
    wageDueMode: living ? contract.wageDueMode : "none",
    laborFactor,
    moraleDelta,
    eventRisks,
    components
  };
  return { ...assessment, description: describeLaborAssessment(assessment) };
}
