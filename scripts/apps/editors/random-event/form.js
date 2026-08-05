import { fieldValue } from "../../../core/helpers.js";
import {
  EVENT_REQUIREMENT_TYPE_OPTIONS,
  normalizeEventRequirement,
  normalizeRandomEventBoosts,
  normalizeRandomEventRequirements
} from "../../../data/random-events.js";
import { makeId } from "../../../data/utils.js";
import { defaultValueForType } from "./draft.js";

export const EVENT_FIELDS = new Set(["weight", "title", "text", "visibility", "gmText", "cooldown", "chainId", "nextEventId", "combatPreset"]);
export const REQUIREMENT_FIELDS = new Set(["type", "operator", "key", "value", "number"]);
export const EFFECT_FIELDS = new Set(["type", "key", "resourceId", "name", "amount", "roomId", "note"]);
const DEPENDENCY_KINDS = new Set(["requirements", "boosts"]);
export const REQUIREMENT_TYPE_BY_VALUE = new Map(EVENT_REQUIREMENT_TYPE_OPTIONS.map((option) => [option.value, option]));

export function cssEscape(value = "") {
  return globalThis.CSS?.escape?.(String(value ?? "")) ?? String(value ?? "").replace(/["\\]/g, "\\$&");
}

export function eventFieldValue(field, target, { final = false } = {}) {
  const raw = fieldValue(target);
  if (field === "weight" || field === "cooldown") return Math.max(0, Math.floor(Number(raw) || 0));
  if (field === "title") {
    const value = String(raw ?? "");
    return final ? (value.trim() || "Событие") : value;
  }
  return String(raw ?? "");
}

export function normalizeDependency(kind = "requirements", source = null) {
  return kind === "boosts" ? normalizeRandomEventBoosts(source) : normalizeRandomEventRequirements(source);
}

export function dependencyKindFromTarget(target = null) {
  const value = String(target?.dataset?.eventDependencyKind ?? target?.closest?.("[data-event-dependency-kind]")?.dataset?.eventDependencyKind ?? "requirements");
  return DEPENDENCY_KINDS.has(value) ? value : "requirements";
}

export function requirementFieldValue(field, target) {
  const raw = fieldValue(target);
  if (field === "number") return Number(raw) || 0;
  return String(raw ?? "");
}

export function effectFieldValue(field, target) {
  const raw = fieldValue(target);
  if (field === "amount") return Number(raw) || 0;
  return String(raw ?? "");
}

export function buildRequirementFromEditor(editor, buildingTemplates = [], regionOptions = []) {
  const type = String(editor?.querySelector?.("[data-event-requirement-type]")?.value ?? "feature");
  const definition = REQUIREMENT_TYPE_BY_VALUE.get(type) ?? REQUIREMENT_TYPE_BY_VALUE.get("feature");
  const valueKind = definition.valueKind ?? "feature";
  const operator = String(editor?.querySelector?.("[data-event-requirement-operator]")?.value ?? definition.defaultOperator);
  const seed = {
    id: makeId("req", 12),
    type,
    operator,
    ...defaultValueForType(type, buildingTemplates, regionOptions)
  };
  if (valueKind === "development") {
    seed.key = String(editor?.querySelector?.("[data-event-requirement-key]")?.value ?? "food");
    seed.number = Number(editor?.querySelector?.("[data-event-requirement-number]")?.value ?? 1) || 0;
  } else if (valueKind === "number") {
    seed.number = Number(editor?.querySelector?.("[data-event-requirement-number]")?.value ?? 1) || 0;
  } else if (valueKind === "text") {
    seed.value = String(editor?.querySelector?.("[data-event-requirement-text]")?.value ?? "").trim();
  } else if (valueKind !== "none") {
    seed.value = String(editor?.querySelector?.(`[data-event-requirement-value="${valueKind}"]`)?.value ?? seed.value ?? "");
  }
  return normalizeEventRequirement(seed);
}
