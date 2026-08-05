import {
  EVENT_BUILDING_FUNCTION_OPTIONS,
  EVENT_CALENDAR_OPTIONS,
  EVENT_COMBAT_PRESET_OPTIONS,
  EVENT_DEVELOPMENT_OPTIONS,
  EVENT_FACTION_OPTIONS,
  EVENT_FAITH_OPTIONS,
  EVENT_FEATURE_OPTIONS,
  EVENT_HOLDING_TYPE_OPTIONS,
  EVENT_REQUIREMENT_LOGIC_OPTIONS,
  EVENT_REQUIREMENT_OPERATOR_OPTIONS,
  EVENT_REQUIREMENT_TYPE_OPTIONS,
  EVENT_VISIBILITY_OPTIONS,
  describeEventRequirement,
  evaluateEventRequirement,
  normalizeEventRequirement,
  normalizeRandomEventBoosts,
  normalizeRandomEventRequirements
} from "../../../data/random-events.js";
import {
  EVENT_EFFECT_DEVELOPMENT_OPTIONS,
  EVENT_EFFECT_MODIFIER_OPTIONS,
  EVENT_EFFECT_TYPE_OPTIONS,
  normalizeRandomEventEffects
} from "../../../data/random-event-effects.js";
import { resourceOptions } from "../../../core/resources.js";

const REQUIREMENT_TYPE_BY_VALUE = new Map(EVENT_REQUIREMENT_TYPE_OPTIONS.map((option) => [option.value, option]));

export function selectedOptions(options = [], selectedValue = "") {
  const selected = String(selectedValue ?? "");
  return options.map((option) => ({ ...option, selected: String(option.value) === selected }));
}

function effectRoomOptions(holding = {}, selectedValue = "outdoors") {
  const rows = [{ value: "outdoors", label: "Снаружи" }];
  for (const building of holding?.buildings?.list ?? []) {
    const id = String(building?.id ?? "");
    if (!id) continue;
    rows.push({ value: id, label: String(building?.name || id) });
  }
  return selectedOptions(rows, selectedValue);
}

function prepareEffectContext(effect = {}, holding = {}) {
  return {
    ...effect,
    isResource: effect.type === "resource",
    isMoney: effect.type === "money",
    isDevelopment: effect.type === "development",
    isModifier: effect.type === "modifier",
    typeOptions: selectedOptions(EVENT_EFFECT_TYPE_OPTIONS, effect.type),
    developmentOptions: selectedOptions(EVENT_EFFECT_DEVELOPMENT_OPTIONS, effect.key),
    modifierOptions: selectedOptions(EVENT_EFFECT_MODIFIER_OPTIONS, effect.key),
    resourceOptions: resourceOptions(effect.resourceId, effect.name, { includeMoney: false }),
    roomOptions: effectRoomOptions(holding, effect.roomId)
  };
}

function groupedOptions(options = []) {
  return Object.values(options.reduce((groups, option) => {
    const category = String(option.category || "Прочее");
    if (!groups[category]) groups[category] = { category, options: [] };
    groups[category].options.push(option);
    return groups;
  }, {}));
}

function defaultCalendarValue() {
  return EVENT_CALENDAR_OPTIONS[0]?.value ?? "";
}

function requirementLogicOptions(value = "all") {
  return selectedOptions(EVENT_REQUIREMENT_LOGIC_OPTIONS, value);
}

function requirementLogicMeta(value = "all") {
  return EVENT_REQUIREMENT_LOGIC_OPTIONS.find((option) => option.value === value) ?? EVENT_REQUIREMENT_LOGIC_OPTIONS[0];
}

function requirementOperatorOptions(value = "", type = "feature") {
  const allowed = new Set(REQUIREMENT_TYPE_BY_VALUE.get(type)?.operators ?? []);
  return EVENT_REQUIREMENT_OPERATOR_OPTIONS.map((option) => ({
    ...option,
    hidden: allowed.size > 0 && !allowed.has(option.value),
    selected: option.value === value
  }));
}

function buildingTemplateOptions(catalog = [], value = "") {
  const selected = String(value ?? "");
  return [...(Array.isArray(catalog) ? catalog : [])]
    .map((template) => ({ value: String(template?.id ?? ""), label: String(template?.name ?? template?.id ?? "") }))
    .filter((option) => option.value)
    .sort((a, b) => a.label.localeCompare(b.label, "ru"))
    .map((option) => ({ ...option, selected: option.value === selected }));
}

function requirementValueOptions(rule = {}, buildingTemplates = [], regionOptions = []) {
  return {
    developmentOptions: selectedOptions(EVENT_DEVELOPMENT_OPTIONS, rule.key || "food"),
    featureOptions: selectedOptions(EVENT_FEATURE_OPTIONS, rule.value),
    regionOptions: selectedOptions(regionOptions, rule.value),
    faithOptions: selectedOptions(EVENT_FAITH_OPTIONS, rule.value || "any"),
    factionOptions: selectedOptions(EVENT_FACTION_OPTIONS, rule.value),
    calendarOptions: selectedOptions(EVENT_CALENDAR_OPTIONS, rule.value || defaultCalendarValue()),
    holdingTypeOptions: selectedOptions(EVENT_HOLDING_TYPE_OPTIONS, rule.value || "sky-island"),
    buildingFunctionOptions: selectedOptions(EVENT_BUILDING_FUNCTION_OPTIONS, rule.value),
    buildingTemplateOptions: buildingTemplateOptions(buildingTemplates, rule.value)
  };
}

function prepareRequirementContext(rule = {}, buildingTemplates = [], regionOptions = []) {
  const normalized = normalizeEventRequirement(rule);
  const definition = REQUIREMENT_TYPE_BY_VALUE.get(normalized.type) ?? REQUIREMENT_TYPE_BY_VALUE.get("feature");
  return {
    ...normalized,
    label: describeEventRequirement(normalized, { buildingTemplates, regionOptions }),
    valueKind: definition.valueKind ?? "feature",
    typeOptions: selectedOptions(EVENT_REQUIREMENT_TYPE_OPTIONS, normalized.type),
    operatorOptions: requirementOperatorOptions(normalized.operator, normalized.type),
    ...requirementValueOptions(normalized, buildingTemplates, regionOptions)
  };
}

function optionLabel(options = [], value = "", fallback = "") {
  const selected = String(value ?? "");
  return options.find((option) => String(option.value) === selected)?.label ?? fallback;
}

function shortText(value = "", fallback = "Без текста события") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
}

export function rowSearchText(row = {}, buildingTemplates = [], regionOptions = []) {
  const requirements = normalizeRandomEventRequirements(row.requirements);
  const boosts = normalizeRandomEventBoosts(row.boosts);
  const requirementText = requirements.rules.map((rule) => describeEventRequirement(rule, { buildingTemplates, regionOptions })).join(" ");
  const boostText = boosts.rules.map((rule) => describeEventRequirement(rule, { buildingTemplates, regionOptions })).join(" ");
  const effectText = normalizeRandomEventEffects(row.effects).map((effect) => [effect.type, effect.key, effect.resourceId, effect.name, effect.note, effect.amount].join(" ")).join(" ");
  return [row.title, row.text, row.gmText, row.chainId, row.nextEventId, row.combatPreset, requirementText, boostText, effectText]
    .map((part) => String(part ?? "").toLowerCase())
    .join(" ");
}

export function tagsFromEventFacts(facts = null) {
  if (!facts) return new Set();
  return new Set([
    ...(facts.features ?? []),
    ...(facts.regions ?? []),
    ...(facts.faiths ?? []),
    ...(facts.factions ?? []),
    ...(facts.calendar?.tags ?? [])
  ]);
}

function contextualWeightFromPreview(row = {}, preview = {}) {
  const base = Math.max(0, Number(row.weight) || 0);
  if (!base || !preview.eligible) return 0;
  const matches = Number(preview.matches) || 0;
  const multiplier = 1 + Math.min(1.4, matches * 0.18);
  return Math.max(1, Math.round(base * multiplier));
}

export function eventPreviewFromFacts(row = {}, facts = null, buildingTemplates = [], regionOptions = []) {
  if (!facts) {
    return { eligible: false, matches: 0, status: "нет владения", weight: 0, missing: [], blocked: [], boostMatches: [], boostMisses: [] };
  }

  const requirements = normalizeRandomEventRequirements(row.requirements);
  const boosts = normalizeRandomEventBoosts(row.boosts);
  const checks = requirements.rules.map((rule) => evaluateEventRequirement(rule, facts));
  const boostChecks = boosts.rules.map((rule) => evaluateEventRequirement(rule, facts));
  const passed = checks.filter((check) => check.ok);
  const boostPassed = boostChecks.filter((check) => check.ok);
  const blocked = [];
  let eligible = true;
  if (checks.length) {
    if (requirements.logic === "any") eligible = passed.length > 0;
    else if (requirements.logic === "none") eligible = passed.length === 0;
    else eligible = passed.length === checks.length;
  }

  const cooldown = Math.max(0, Math.floor(Number(row.cooldown) || 0));
  if (cooldown > 0 && (facts.eventHistoryIds ?? []).slice(-cooldown).includes(String(row.id))) {
    eligible = false;
    blocked.push(`Кулдаун: выпадало в последних ${cooldown}`);
  }

  const preview = {
    eligible,
    matches: boostPassed.length,
    status: eligible ? "доступно" : "закрыто",
    missing: checks.filter((check) => !check.ok).map((check) => describeEventRequirement(check.rule, { buildingTemplates, regionOptions })),
    blocked: [...blocked, ...(requirements.logic === "none" ? passed.map((check) => describeEventRequirement(check.rule, { buildingTemplates, regionOptions })) : [])],
    boostMatches: boostPassed.map((check) => describeEventRequirement(check.rule, { buildingTemplates, regionOptions })),
    boostMisses: boostChecks.filter((check) => !check.ok).map((check) => describeEventRequirement(check.rule, { buildingTemplates, regionOptions }))
  };
  preview.weight = contextualWeightFromPreview(row, preview);
  return preview;
}

export function prepareTableSummary(kind, table = {}, activeTable = "general") {
  const eventCount = Array.isArray(table.rows) ? table.rows.length : 0;
  return {
    id: table.id ?? kind,
    version: table.version,
    title: table.title ?? "",
    rollTitle: table.rollTitle ?? table.title ?? "",
    description: table.description ?? "",
    kind,
    icon: kind === "general" ? "fa-solid fa-house-chimney" : "fa-solid fa-globe",
    active: kind === activeTable,
    eventCount,
    count: eventCount
  };
}

export function prepareTableControls(buildingTemplates = [], regionOptions = []) {
  return {
    requirementTypeGroups: groupedOptions(EVENT_REQUIREMENT_TYPE_OPTIONS),
    requirementOperatorOptions: EVENT_REQUIREMENT_OPERATOR_OPTIONS,
    requirementLogicOptions: EVENT_REQUIREMENT_LOGIC_OPTIONS,
    developmentOptions: selectedOptions(EVENT_DEVELOPMENT_OPTIONS, "food"),
    featureOptions: selectedOptions(EVENT_FEATURE_OPTIONS, EVENT_FEATURE_OPTIONS[0]?.value ?? "storage"),
    regionOptions: selectedOptions(regionOptions, regionOptions[0]?.value ?? ""),
    faithOptions: selectedOptions(EVENT_FAITH_OPTIONS, "any"),
    factionOptions: selectedOptions(EVENT_FACTION_OPTIONS, EVENT_FACTION_OPTIONS[0]?.value ?? "stl"),
    calendarOptions: selectedOptions(EVENT_CALENDAR_OPTIONS, defaultCalendarValue()),
    holdingTypeOptions: selectedOptions(EVENT_HOLDING_TYPE_OPTIONS, "sky-island"),
    buildingFunctionOptions: selectedOptions(EVENT_BUILDING_FUNCTION_OPTIONS, EVENT_BUILDING_FUNCTION_OPTIONS[0]?.value ?? "storage"),
    buildingTemplateOptions: buildingTemplateOptions(buildingTemplates)
  };
}

export function prepareRowContext(row = {}, index = 0, {
  full = false,
  facts = null,
  buildingTemplates = [],
  regionOptions = [],
  holding = null
} = {}) {
  const requirements = normalizeRandomEventRequirements(row.requirements);
  const boosts = normalizeRandomEventBoosts(row.boosts);
  const preview = eventPreviewFromFacts(row, facts, buildingTemplates, regionOptions);
  const requirementMeta = requirementLogicMeta(requirements.logic);
  const boostMeta = requirementLogicMeta(boosts.logic);
  const effects = normalizeRandomEventEffects(row.effects);
  const requirementLabels = requirements.rules.map((rule) => describeEventRequirement(rule, { buildingTemplates, regionOptions }));
  const boostLabels = boosts.rules.map((rule) => describeEventRequirement(rule, { buildingTemplates, regionOptions }));
  const combatPresetLabel = row.combatPreset ? optionLabel(EVENT_COMBAT_PRESET_OPTIONS, row.combatPreset, row.combatPreset) : "";
  const chainLine = [row.chainId ? `цепь ${row.chainId}` : "", row.nextEventId ? `след. ${row.nextEventId}` : ""].filter(Boolean).join(" / ");
  return {
    ...row,
    _index: index,
    displayIndex: index + 1,
    shortText: shortText(row.text),
    visibilityLabel: optionLabel(EVENT_VISIBILITY_OPTIONS, row.visibility || "public", "В чат"),
    combatPresetLabel,
    chainLine,
    visibilityOptions: full ? selectedOptions(EVENT_VISIBILITY_OPTIONS, row.visibility || "public") : [],
    combatPresetOptions: full ? selectedOptions(EVENT_COMBAT_PRESET_OPTIONS, row.combatPreset || "") : [],
    requirementLogicOptions: full ? requirementLogicOptions(requirements.logic) : [],
    requirementLogicLabel: requirementMeta?.shortLabel ?? requirementMeta?.label ?? "И",
    requirementLogicTitle: requirementMeta?.label ?? "Все условия",
    requirementLabels: requirementLabels.map((label) => ({ label })),
    requirementRules: full ? requirements.rules.map((rule) => prepareRequirementContext(rule, buildingTemplates, regionOptions)) : [],
    requirementCount: requirements.rules.length,
    hasRequirements: requirements.rules.length > 0,
    boostLogicLabel: boostMeta?.shortLabel ?? boostMeta?.label ?? "ИЛИ",
    boostLogicTitle: boostMeta?.label ?? "Любое условие",
    boostLabels: boostLabels.map((label) => ({ label })),
    boostRules: full ? boosts.rules.map((rule) => prepareRequirementContext(rule, buildingTemplates, regionOptions)) : [],
    boostCount: boosts.rules.length,
    hasBoosts: boosts.rules.length > 0,
    effects: full ? effects.map((effect) => prepareEffectContext(effect, holding)) : [],
    effectCount: effects.length,
    hasEffects: effects.length > 0,
    hasRuleSummary: requirements.rules.length > 0 || boosts.rules.length > 0,
    preview,
    searchText: rowSearchText(row, buildingTemplates, regionOptions)
  };
}
