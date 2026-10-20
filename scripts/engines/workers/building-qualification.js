import {
  APPROVED_BUILDING_WORKER_PROFILES,
  APPROVED_WORKER_BACKGROUND_GROUPS,
  BUILDING_WORKER_PROFILE_VERSION
} from "../../data/building-worker-profile-data.js";
import { normalizeProfileModifiers, profileModifierQualification } from "./profile-modifiers.js";

export const WORK_UNITS_PER_QD = 10_000;
export const SUITABLE_TYPE_WORK_UNITS = 2_500;
export const OPTIMAL_TYPE_WORK_UNITS = 5_000;
export const BACKGROUND_WORK_UNITS = 1_000;
export const TRAIT_WORK_UNITS = 1_000;

const ATTRIBUTE_BY_SELECTOR = Object.freeze({
  "СИЛ": "strength",
  "ЛОВ": "agility",
  "РАЗ": "wits",
  "ЭМП": "empathy"
});

const PROFILE_BY_ID = new Map(APPROVED_BUILDING_WORKER_PROFILES
  .filter((profile) => profile.templateId)
  .map((profile) => [String(profile.templateId), profile]));
const PROFILE_BY_NAME = new Map(APPROVED_BUILDING_WORKER_PROFILES
  .map((profile) => [normalizeWorkerText(profile.name), profile]));

const EXTRA_BACKGROUND_GROUPS = Object.freeze({
  "ТОРГОВЛЯ": ["лавочник", "мелкий торговец", "торговец", "коммивояжер", "меняла", "ростовщик", "оценщик", "аукционист", "счетовод"],
  "МЕДИЦИНА": ["лекарь", "цирюльник", "повитуха", "аптекарь", "костоправ", "сиделка", "санитар", "корабельный лекарь"],
  "КУЛЬТ": ["жрец", "сакердот", "паломник", "могильщик", "певчий", "храмовый служка"]
});

function finiteInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function copy(value) {
  if (Array.isArray(value)) return value.map(copy);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, copy(entry)]));
}

export function normalizeWorkerText(value = "") {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("ru")
    .replaceAll("ё", "е")
    .replace(/[«»"'()]/g, " ")
    .replace(/[—–-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function workerTraits(person = {}) {
  const value = person?.traitsText ?? person?.traits ?? "";
  const rows = Array.isArray(value) ? value : String(value).split(/[,;\n]/);
  return rows.map((row) => String(row ?? "").trim()).filter(Boolean);
}

export function workerHasTrait(person = {}, trait = "") {
  const wanted = normalizeWorkerText(trait);
  return Boolean(wanted) && workerTraits(person).some((value) => normalizeWorkerText(value) === wanted);
}

export function workerAttribute(person = {}, key = "") {
  const value = Number(person?.attributes?.[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export function approvedBuildingWorkerProfile(building = {}) {
  const byId = PROFILE_BY_ID.get(String(building?.templateId ?? building?.id ?? ""));
  const profile = byId ?? PROFILE_BY_NAME.get(normalizeWorkerText(building?.name));
  return profile ? copy(profile) : null;
}

export function normalizeBuildingWorkerProfile(value = null, building = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? copy(value)
    : approvedBuildingWorkerProfile(building);
  if (!source) return null;
  const admission = source.admission && typeof source.admission === "object" ? source.admission : {};
  return {
    version: Math.max(1, finiteInteger(source.version, BUILDING_WORKER_PROFILE_VERSION)),
    source: String(source.source ?? "approved"),
    ...(source.modifiers ? { modifiers: normalizeProfileModifiers(source.modifiers) } : {}),
    templateId: String(source.templateId ?? building?.templateId ?? ""),
    name: String(source.name ?? building?.name ?? ""),
    stage: Math.max(0, finiteInteger(source.stage, 0)),
    workersMin: Math.max(0, finiteInteger(source.workersMin ?? building?.workersMin, 0)),
    workersMax: Math.max(0, finiteInteger(source.workersMax ?? building?.workersMax, 0)),
    admission: {
      text: String(admission.text ?? "—"),
      hard: Boolean(admission.hard),
      clauses: (Array.isArray(admission.clauses) ? admission.clauses : []).map((clause) =>
        (Array.isArray(clause) ? clause : []).map((rule) => ({
          attribute: String(rule?.attribute ?? ""),
          minimum: Math.max(0, finiteInteger(rule?.minimum, 0))
        })).filter((rule) => Object.values(ATTRIBUTE_BY_SELECTOR).includes(rule.attribute) && rule.minimum > 0)
      ).filter((clause) => clause.length)
    },
    suitableSelectors: (Array.isArray(source.suitableSelectors) ? source.suitableSelectors : []).map(String).filter(Boolean),
    optimalSelectors: (Array.isArray(source.optimalSelectors) ? source.optimalSelectors : []).map(String).filter(Boolean),
    staffingClass: String(source.staffingClass ?? ""),
    composition: (Array.isArray(source.composition) ? source.composition : []).map((row) => ({
      count: Math.max(1, finiteInteger(row?.count, 1)),
      ...(Array.isArray(row?.backgrounds) ? { backgrounds: [...new Set(row.backgrounds.map((name) => String(name).trim()).filter(Boolean))] } : { group: String(row?.group ?? "") })
    })).filter((row) => row.group || Array.isArray(row.backgrounds)),
    production: source.production && typeof source.production === "object" ? {
      backgroundGroups: (Array.isArray(source.production.backgroundGroups) ? source.production.backgroundGroups : []).map(String).filter(Boolean),
      positiveTraits: (Array.isArray(source.production.positiveTraits) ? source.production.positiveTraits : []).map(String).filter(Boolean),
      negativeTraits: (Array.isArray(source.production.negativeTraits) ? source.production.negativeTraits : []).map(String).filter(Boolean)
    } : null,
    reason: String(source.reason ?? "")
  };
}

export function applyApprovedBuildingWorkerProfile(building = {}) {
  const next = { ...building };
  const profile = approvedBuildingWorkerProfile(next);
  if (profile) {
    next.workerProfile = normalizeBuildingWorkerProfile(profile, next);
    next.workersMin = next.workerProfile.workersMin;
    next.workersMax = next.workerProfile.workersMax;
  }
  delete next.workerPrimaryAttribute;
  delete next.primaryWorkerAttribute;
  delete next.suitableWorkerTypes;
  delete next.workerTypeEffects;
  delete next.workerTypes;
  return next;
}

export function workerAdmission(building = {}, person = {}) {
  const profile = normalizeBuildingWorkerProfile(building?.workerProfile, building);
  const clauses = profile?.admission?.clauses ?? [];
  const eligible = !clauses.length || clauses.some((clause) => clause.every((rule) =>
    workerAttribute(person, rule.attribute) >= rule.minimum
  ));
  return {
    eligible,
    hard: Boolean(profile?.admission?.hard),
    overridden: (building?.workerAdmissionOverrideIds ?? []).map(String).includes(String(person?.id ?? "")),
    text: String(profile?.admission?.text ?? "—")
  };
}

export function holdingWorkerAdmissionIssues(holding = {}) {
  const buildingsById = new Map((holding?.buildings?.list ?? [])
    .map((building) => [String(building?.id ?? ""), building])
    .filter(([id]) => Boolean(id)));
  const issues = [];
  for (const person of holding?.people?.list ?? []) {
    if (String(person?.workAllocationMode ?? "") !== "explicit") continue;
    const buildingIds = new Set((person?.workAllocations ?? [])
      .filter((row) => Math.max(0, finiteInteger(row?.normalQd, 0)) + Math.max(0, finiteInteger(row?.overtimeQd, 0)) > 0)
      .map((row) => String(row?.sourceId ?? ""))
      .filter((id) => buildingsById.has(id)));
    for (const buildingId of buildingIds) {
      const building = buildingsById.get(buildingId);
      const admission = workerAdmission(building, person);
      if (!admission.hard || admission.eligible || admission.overridden) continue;
      issues.push({
        code: "allocation-admission",
        workerId: String(person?.id ?? ""),
        personId: String(person?.id ?? ""),
        personName: String(person?.name ?? "Житель"),
        buildingId,
        buildingName: String(building?.name ?? buildingId),
        message: `${String(person?.name ?? "Житель")}: нет обязательного допуска в «${String(building?.name ?? buildingId)}» (${admission.text}).`
      });
    }
  }
  return issues;
}

export function workerMatchesSelector(person = {}, selector = "") {
  const value = String(selector ?? "").trim().toUpperCase();
  if (value === "РР*") {
    const values = Object.values(ATTRIBUTE_BY_SELECTOR).map((key) => workerAttribute(person, key));
    return values.every((entry) => entry >= 3 && entry < 5) && values.reduce((sum, entry) => sum + entry, 0) >= 13;
  }
  const parts = value.split("&").map((part) => part.trim()).filter(Boolean);
  return Boolean(parts.length) && parts.every((part) => {
    const key = ATTRIBUTE_BY_SELECTOR[part];
    return key ? workerAttribute(person, key) >= 5 : false;
  });
}

function backgroundValues(group = "") {
  return APPROVED_WORKER_BACKGROUND_GROUPS[group] ?? EXTRA_BACKGROUND_GROUPS[group] ?? [];
}

export function workerBackgroundGroupNames() {
  return [...new Set([...Object.keys(APPROVED_WORKER_BACKGROUND_GROUPS), ...Object.keys(EXTRA_BACKGROUND_GROUPS)])];
}

export function workerBackgroundGroupMembers(group) {
  return [...backgroundValues(group)];
}

export function workerBackgroundMatches(person = {}, groups = []) {
  const background = normalizeWorkerText(person?.background);
  if (!background) return false;
  return groups.some((group) => backgroundValues(String(group)).some((candidate) => {
    const wanted = normalizeWorkerText(candidate);
    return background === wanted || background.includes(wanted);
  }));
}

export function workerProductionQualification(building = {}, person = {}) {
  const profile = normalizeBuildingWorkerProfile(building?.workerProfile, building);
  if (profile?.modifiers) return profileModifierQualification(profile.modifiers, person, {
    selectorMatches: workerMatchesSelector, backgroundMatches: workerBackgroundMatches, hasTrait: workerHasTrait, normalizeText: normalizeWorkerText
  });
  if (!profile?.production) {
    return {
      workUnits: WORK_UNITS_PER_QD,
      typeUnits: 0,
      backgroundUnits: 0,
      positiveTraitUnits: 0,
      negativeTraitUnits: 0,
      matchedSelector: "",
      matchedBackground: false,
      matchedPositiveTrait: "",
      matchedNegativeTrait: "",
      details: []
    };
  }
  const optimal = profile.optimalSelectors.find((selector) => workerMatchesSelector(person, selector));
  const suitable = optimal ? "" : profile.suitableSelectors.find((selector) => workerMatchesSelector(person, selector));
  const typeUnits = optimal ? OPTIMAL_TYPE_WORK_UNITS : (suitable ? SUITABLE_TYPE_WORK_UNITS : 0);
  const matchedBackground = workerBackgroundMatches(person, profile.production.backgroundGroups);
  const matchedPositiveTrait = profile.production.positiveTraits.find((trait) => workerHasTrait(person, trait)) ?? "";
  const matchedNegativeTrait = profile.production.negativeTraits.find((trait) => workerHasTrait(person, trait)) ?? "";
  const backgroundUnits = matchedBackground ? BACKGROUND_WORK_UNITS : 0;
  const positiveTraitUnits = matchedPositiveTrait ? TRAIT_WORK_UNITS : 0;
  const negativeTraitUnits = matchedNegativeTrait ? -TRAIT_WORK_UNITS : 0;
  const details = [];
  if (optimal) details.push(`${optimal} +50%`);
  else if (suitable) details.push(`${suitable} +25%`);
  if (matchedBackground) details.push("прошлое +10%");
  if (matchedPositiveTrait) details.push(`${matchedPositiveTrait} +10%`);
  if (matchedNegativeTrait) details.push(`${matchedNegativeTrait} -10%`);
  return {
    workUnits: Math.max(0, WORK_UNITS_PER_QD + typeUnits + backgroundUnits + positiveTraitUnits + negativeTraitUnits),
    typeUnits,
    backgroundUnits,
    positiveTraitUnits,
    negativeTraitUnits,
    matchedSelector: optimal || suitable || "",
    matchedBackground,
    matchedPositiveTrait,
    matchedNegativeTrait,
    details
  };
}

export function workerMatchesCompositionGroup(person = {}, group = "") {
  const key = String(group ?? "").toUpperCase();
  if (key === "СТРОИТЕЛЬСТВО") return workerBackgroundMatches(person, ["СТРОИТЕЛЬСТВО"]) || workerHasTrait(person, "Builder");
  if (key === "ГРАМОТА") return workerBackgroundMatches(person, ["ГРАМОТА"]) || (workerHasTrait(person, "Грамотный") && workerAttribute(person, "wits") >= 3);
  if (key === "ТЕХНИКА") return workerBackgroundMatches(person, ["ТЕХНИКА"]) || (workerHasTrait(person, "Мастеровой") && workerAttribute(person, "wits") >= 4);
  if (key === "ТОРГОВЛЯ") return workerBackgroundMatches(person, ["ТОРГОВЛЯ"]) || (workerHasTrait(person, "Бережливый") && workerAttribute(person, "empathy") >= 4);
  if (key === "МЕДИЦИНА") return workerBackgroundMatches(person, ["МЕДИЦИНА"]) || (workerHasTrait(person, "Грамотный") && workerAttribute(person, "wits") >= 4 && workerAttribute(person, "empathy") >= 4);
  if (key === "КУЛЬТ") return workerBackgroundMatches(person, ["КУЛЬТ"]) || (workerHasTrait(person, "Верующий") && workerAttribute(person, "empathy") >= 4);
  if (key === "ОХРАНА") return workerBackgroundMatches(person, ["ВОЕННОЕ"]) || (workerHasTrait(person, "Храбрец") && workerAttribute(person, "strength") >= 3 && workerAttribute(person, "wits") >= 3);
  if (key === "МОРЕ") return workerBackgroundMatches(person, ["МОРЕ"]) || (workerAttribute(person, "agility") >= 4 && workerAttribute(person, "wits") >= 4);
  if (key === "ЧУДОТВОРЕЦ") return workerHasTrait(person, "Чудотворец");
  return false;
}

export function compositionBackgrounds(row = {}) {
  if (Array.isArray(row.backgrounds)) return [...row.backgrounds];
  return workerBackgroundGroupMembers(row.group === "ОХРАНА" ? "ВОЕННОЕ" : row.group);
}

function matchesCompositionRequirement(person, row) {
  if (!Array.isArray(row.backgrounds)) return workerMatchesCompositionGroup(person, row.group);
  const background = normalizeWorkerText(person.background);
  return Boolean(background) && row.backgrounds.some((name) => normalizeWorkerText(name) === background);
}

function compositionLabel(row) {
  return Array.isArray(row.backgrounds) ? (row.backgrounds.join(" / ") || "предыстории не выбраны") : row.group;
}

function matchCompositionSlots(slots, people) {
  // Augmenting paths preserve distinct-person matching without enumerating all
  // permutations of a 200-person candidate pool when a specialty is absent.
  const ownerByPerson = new Map();
  const assign = (slotIndex, visited) => {
    for (let index = 0; index < people.length; index += 1) {
      if (visited.has(index) || !matchesCompositionRequirement(people[index], slots[slotIndex])) continue;
      visited.add(index);
      if (!ownerByPerson.has(index) || assign(ownerByPerson.get(index), visited)) {
        ownerByPerson.set(index, slotIndex);
        return true;
      }
    }
    return false;
  };
  return slots.every((_slot, index) => assign(index, new Set()));
}

export function buildingCompositionStatus(building = {}, assignedPeople = [], { excludeGroups = [] } = {}) {
  const profile = normalizeBuildingWorkerProfile(building?.workerProfile, building);
  const excluded = new Set(excludeGroups.map((value) => String(value).toUpperCase()));
  const requirements = (profile?.composition ?? []).filter((row) => !excluded.has(String(row.group).toUpperCase()));
  const people = assignedPeople.filter((person) => person && !person.dead && Number(person.injuredDays ?? 0) <= 0);
  const slots = requirements.flatMap((row) => Array.from({ length: row.count }, () => row));
  const met = matchCompositionSlots(slots, people);
  const missing = requirements.filter((row) => people.filter((person) => matchesCompositionRequirement(person, row)).length < row.count);
  return {
    met,
    requirements,
    missing,
    text: requirements.length ? requirements.map((row) => `${row.count}× ${compositionLabel(row)}`).join("; ") : "—"
  };
}

export function workerProfileSummary(building = {}) {
  const profile = normalizeBuildingWorkerProfile(building?.workerProfile, building);
  if (!profile) return { admission: "—", bonuses: "—", composition: "—", reason: "" };
  const bonuses = [];
  if (profile.modifiers) {
    for (const rows of Object.values(profile.modifiers)) for (const row of rows) {
      if (row.match) bonuses.push(`${row.match.replace(/^(type|group):/, "")} ${row.percent >= 0 ? "+" : ""}${row.percent}%`);
    }
  }
  if (!profile.modifiers && profile.suitableSelectors.length) bonuses.push(`+25%: ${profile.suitableSelectors.join(" | ")}`);
  if (!profile.modifiers && profile.optimalSelectors.length) bonuses.push(`+50%: ${profile.optimalSelectors.join(" | ")}`);
  if (!profile.modifiers && profile.production?.backgroundGroups?.length) bonuses.push(`прошлое +10%: ${profile.production.backgroundGroups.join(", ")}`);
  if (!profile.modifiers && profile.production?.positiveTraits?.length) bonuses.push(`черта +10%: ${profile.production.positiveTraits.join(" | ")}`);
  if (!profile.modifiers && profile.production?.negativeTraits?.length) bonuses.push(`черта -10%: ${profile.production.negativeTraits.join(" | ")}`);
  return {
    admission: `${profile.admission.text}${profile.admission.hard ? " (жёсткий)" : ""}`,
    bonuses: bonuses.join("; ") || "—",
    composition: profile.composition.length ? profile.composition.map((row) => `${row.count}× ${compositionLabel(row)}`).join("; ") : "—",
    reason: profile.reason
  };
}
