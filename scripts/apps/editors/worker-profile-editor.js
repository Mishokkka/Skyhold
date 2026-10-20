import { normalizeBuildingWorkerProfile, compositionBackgrounds, workerBackgroundGroupMembers, normalizeWorkerText } from "../../engines/workers/building-qualification.js";
import { defaultProfileModifiers } from "../../engines/workers/profile-modifiers.js";
import { WORKER_TYPE_OPTIONS } from "../../core/helpers.js";
import { ATTRIBUTE_META, SOCIAL_BACKGROUND_OPTIONS, workerTypeFromAttributes } from "../../generators/resident-rules.js";

import { TRAIT_DEFINITIONS } from "../../generators/trait-definitions.js";
import { selectionSummary } from "../common/selection-summary.js";

const attributes = Object.entries(ATTRIBUTE_META).map(([value, meta]) => ({ value, label: meta.label }));
const selectorKeys = { СИЛ: "strength", ЛОВ: "agility", РАЗ: "wits", ЭМП: "empathy" };
function typeLabel(value) {
  if (value.startsWith("type:")) return value.slice(5);
  if (value === "РР*") return "Разнорабочий с усиленными характеристиками";
  const keys = value.split("&").map((key) => selectorKeys[key]).filter(Boolean);
  if (!keys.length) return value;
  return `${workerTypeFromAttributes(Object.fromEntries(keys.map((key) => [key, 5])))} и смежные`;
}

function editorModifiers(profile) {
  const modifiers = defaultProfileModifiers(profile);
  modifiers.backgrounds = modifiers.backgrounds.flatMap((row) => row.match.startsWith("group:")
    ? workerBackgroundGroupMembers(row.match.slice(6)).map((match) => ({ match, percent: row.percent })) : [row]);
  return modifiers;
}

function backgroundChoices(selected = []) {
  const choices = new Map();
  for (const value of [...SOCIAL_BACKGROUND_OPTIONS, ...selected]) {
    const search = normalizeWorkerText(value);
    if (!choices.has(search)) choices.set(search, { value, label: value, search, selected: selected.some((name) => normalizeWorkerText(name) === search) });
  }
  return [...choices.values()];
}

export function editableWorkerProfile(building) {
  return normalizeBuildingWorkerProfile(building.workerProfile, building) ?? normalizeBuildingWorkerProfile({ source: "custom", production: {} }, building);
}

export function workerProfileEditorContext(building) {
  const profile = editableWorkerProfile(building);
  const modifiers = editorModifiers(profile);
  const typeOptions = [...new Set([...modifiers.types.map((row) => row.match), "", "СИЛ", "ЛОВ", "РАЗ", "ЭМП", "РР*", ...WORKER_TYPE_OPTIONS.filter((name) => !name.startsWith("Все с ")).map((name) => `type:${name}`)])];
  return {
    hard: profile.admission.hard,
    compositionRows: profile.composition.map((row, index) => {
      const backgrounds = compositionBackgrounds(row);
      const summary = selectionSummary(backgrounds, row.group === "ЧУДОТВОРЕЦ" ? "Черта «Чудотворец»" : "Выберите предыстории");
      return { ...row, index, selectedText: summary.tooltip, selectedSummary: summary, choices: backgroundChoices(backgrounds) };
    }),
    admissionRows: profile.admission.clauses.flatMap((clause, group) => clause.map((rule) => ({ ...rule, group: group + 1, options: attributes.map((option) => ({ ...option, selected: rule.attribute === option.value })) }))),
    sections: [["types", "Эффективность типов"], ["backgrounds", "Прошлое"], ["traits", "Черты"]].map(([key, label]) => ({
      key, label, isTypes: key === "types", isBackgrounds: key === "backgrounds",
      rows: modifiers[key].map((row, index) => ({ ...row, index, displayMatch: row.match,
        choices: key === "types" ? [] : key === "backgrounds" ? backgroundChoices([row.match].filter(Boolean)) : TRAIT_DEFINITIONS.map((trait) => ({ value: trait.name, label: trait.name, search: normalizeWorkerText(trait.name) })),
        options: typeOptions.map((value) => ({ value, label: value ? typeLabel(value) : "Выберите тип", selected: value === row.match })) }))
    }))
  };
}

export function changeWorkerProfile(building, { section, index, field, value, operation }) {
  const profile = editableWorkerProfile(building);
  if (section === "composition") {
    const rows = profile.composition;
    if (operation === "add") rows.push({ count: 1, backgrounds: [] });
    else if (operation === "remove" && Number.isInteger(index) && index >= 0) rows.splice(index, 1);
    else if (rows[index] && field === "count") rows[index].count = value;
    else if (rows[index] && field === "background") {
      const backgrounds = compositionBackgrounds(rows[index]);
      const existing = backgrounds.findIndex((name) => normalizeWorkerText(name) === normalizeWorkerText(value));
      if (existing >= 0) backgrounds.splice(existing, 1);
      else if (String(value).trim()) backgrounds.push(String(value).trim());
      rows[index] = { count: rows[index].count, backgrounds };
    }
    return normalizeBuildingWorkerProfile(profile, building);
  }
  if (section === "admission") {
    if (field === "hard") { profile.admission.hard = Boolean(value); return profile; }
    const rows = profile.admission.clauses.flatMap((clause, group) => clause.map((rule) => ({ ...rule, group: group + 1 })));
    if (operation === "add") rows.push({ attribute: "strength", minimum: 3, group: 1 });
    else if (operation === "remove" && Number.isInteger(index) && index >= 0) rows.splice(index, 1);
    else if (rows[index] && ["attribute", "minimum", "group"].includes(field)) rows[index][field] = value;
    const groups = new Map();
    for (const row of rows) {
      const group = Math.max(1, Math.trunc(Number(row.group) || 1));
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push({ attribute: row.attribute, minimum: row.minimum });
    }
    profile.admission.clauses = [...groups.values()];
    const normalized = normalizeBuildingWorkerProfile(profile, building);
    normalized.admission.text = normalized.admission.clauses.map((clause) => clause.map((rule) => `${ATTRIBUTE_META[rule.attribute].label}≥${rule.minimum}`).join(" И ")).join(" ИЛИ ") || "Без ограничений";
    return normalized;
  }
  if (!["types", "backgrounds", "traits"].includes(section)) return profile;
  profile.modifiers = editorModifiers(profile);
  const rows = profile.modifiers[section];
  if (operation === "add") rows.push({ match: "", percent: 0 });
  else if (operation === "remove" && Number.isInteger(index) && index >= 0) rows.splice(index, 1);
  else if (operation === "up" && index > 0 && index < rows.length) [rows[index - 1], rows[index]] = [rows[index], rows[index - 1]];
  else if (rows[index] && ["match", "percent"].includes(field)) rows[index][field] = value;
  return normalizeBuildingWorkerProfile(profile, building);
}
