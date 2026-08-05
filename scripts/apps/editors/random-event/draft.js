import { makeId } from "../../../data/utils.js";
import {
  EVENT_BUILDING_FUNCTION_OPTIONS,
  EVENT_CALENDAR_OPTIONS,
  EVENT_FACTION_OPTIONS,
  EVENT_FEATURE_OPTIONS,
  EVENT_REQUIREMENT_TYPE_OPTIONS,
  normalizeEventRequirement,
  normalizeRandomEventRow
} from "../../../data/random-events.js";
import { normalizeRandomEventEffect } from "../../../data/random-event-effects.js";

const REQUIREMENT_TYPE_BY_VALUE = new Map(EVENT_REQUIREMENT_TYPE_OPTIONS.map((option) => [option.value, option]));

function defaultCalendarValue() {
  return EVENT_CALENDAR_OPTIONS[0]?.value ?? "";
}

export function defaultValueForType(type = "feature", buildingTemplates = [], regionOptions = []) {
  const valueKind = REQUIREMENT_TYPE_BY_VALUE.get(type)?.valueKind ?? "feature";
  if (valueKind === "development") return { key: "food", value: "", number: 1 };
  if (valueKind === "feature") return { key: "", value: EVENT_FEATURE_OPTIONS[0]?.value ?? "storage", number: 0 };
  if (valueKind === "region") return { key: "", value: regionOptions[0]?.value ?? "", number: 0 };
  if (valueKind === "faith") return { key: "", value: "any", number: 0 };
  if (valueKind === "faction") return { key: "", value: EVENT_FACTION_OPTIONS[0]?.value ?? "stl", number: 0 };
  if (valueKind === "calendar") return { key: "", value: defaultCalendarValue(), number: 0 };
  if (valueKind === "holding-type") return { key: "", value: "sky-island", number: 0 };
  if (valueKind === "building-function") return { key: "", value: EVENT_BUILDING_FUNCTION_OPTIONS[0]?.value ?? "storage", number: 0 };
  if (valueKind === "building-template") return { key: "", value: buildingTemplates[0]?.id ?? "", number: 0 };
  if (valueKind === "number") return { key: "", value: "", number: 1 };
  if (valueKind === "text") return { key: "", value: "", number: 0 };
  return { key: "", value: "", number: 0 };
}

export function newRequirement(type = "feature", buildingTemplates = [], regionOptions = []) {
  const definition = REQUIREMENT_TYPE_BY_VALUE.get(type) ?? REQUIREMENT_TYPE_BY_VALUE.get("feature");
  return normalizeEventRequirement({
    id: makeId("req", 12),
    type: definition.value,
    operator: definition.defaultOperator,
    ...defaultValueForType(definition.value, buildingTemplates, regionOptions)
  });
}

export function newEventEffect(type = "resource") {
  return normalizeRandomEventEffect({
    id: makeId("effect", 12),
    type,
    key: type === "development" ? "food" : type === "modifier" ? "morale" : "",
    resourceId: "custom",
    name: "",
    amount: 1,
    roomId: "outdoors",
    note: ""
  });
}

export function newEventRow(kind = "general") {
  return normalizeRandomEventRow({
    id: makeId("event", 12),
    weight: kind === "external" ? 3 : 4,
    title: "Новое событие",
    text: "",
    requirements: { logic: "all", rules: [] },
    boosts: { logic: "any", rules: [] },
    visibility: "public",
    cooldown: 0,
    effects: []
  });
}
