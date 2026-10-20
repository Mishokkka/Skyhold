import { splitList } from "../../core/helpers.js";

export const CONSTRUCTION_DICE_FIELDS = Object.freeze([
  { key: "base", label: "База за человека", default: 1, min: 0, max: 20, description: "Каждый доступный рабочий и квалифицированный руководитель." },
  { key: "professional", label: "Строительный тип", default: 1, min: -20, max: 20, description: "Один бонус за совпадение с любым строительным типом из списка ниже." },
  { key: "suitable", label: "Подходящий тип бригады", default: 1, min: -20, max: 20, description: "Один бонус за совпадение со списком «Подходящие типы» конкретной бригады. Складывается со строительным типом." },
  { key: "craftsman", label: "Черта «Мастеровой»", default: 1, min: -20, max: 20, description: "Дополнительно к бонусам типа работника." },
  { key: "strong", label: "Черта «Крепкий»", default: 1, min: -20, max: 20, description: "Применяется один раз за человека." },
  { key: "badBack", label: "Черта «Больная спина»", default: -1, min: -20, max: 20, description: "Отрицательное значение уменьшает личный вклад." },
  { key: "absentMinded", label: "Черта «Рассеянный»", default: -1, min: -20, max: 20, description: "Складывается с остальными чертами." },
  { key: "drunkard", label: "Черта «Пьяница»", default: -1, min: -20, max: 20, description: "Складывается с остальными чертами." },
  { key: "saboteur", label: "Черта «Саботажник»", default: -2, min: -20, max: 20, description: "Складывается с остальными чертами." },
  { key: "cap", label: "Максимум труда на человека", default: 6, min: 0, max: 60, description: "После сложения всех личных бонусов и штрафов вклад ограничивается диапазоном от 0 до этого значения." },
  { key: "coordination", label: "Координация Лидера", default: 1, min: 0, max: 20, description: "Один раз на бригаду: квалифицированный руководитель с чертой «Лидер» и минимум два доступных рабочих помимо него. Не входит в личный предел." }
]);

const PROFESSIONAL_TYPES = "Строитель, Механик, Бригадир, Мастеровой, Мастер на все руки";
export const CONSTRUCTION_TRAIT_KEYS = Object.freeze({ craftsman: "Мастеровой", strong: "Крепкий", badBack: "Больная спина", absentMinded: "Рассеянный", drunkard: "Пьяница", saboteur: "Саботажник" });

export function normalizeConstructionDiceRules(source = {}) {
  const rules = {};
  for (const field of CONSTRUCTION_DICE_FIELDS) {
    const raw = source?.[field.key];
    const value = typeof raw === "number" || (typeof raw === "string" && raw.trim()) ? Number(raw) : NaN;
    rules[field.key] = Number.isFinite(value) ? Math.max(field.min, Math.min(field.max, Math.trunc(value))) : field.default;
  }
  rules.professionalTypes = typeof source?.professionalTypes === "string"
    ? splitList(source.professionalTypes).slice(0, 50).map((type) => type.slice(0, 80)).join(", ")
    : PROFESSIONAL_TYPES;
  const rows = Array.isArray(source?.traitRules) ? source.traitRules : Object.entries(CONSTRUCTION_TRAIT_KEYS).map(([key, name]) => ({ name, dice: rules[key] }));
  const seen = new Set();
  rules.traitRules = rows.flatMap((row) => {
    const name = String(row?.name ?? "").trim().slice(0, 80);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) return [];
    seen.add(key);
    const dice = Number(row.dice);
    return [{ name, dice: Number.isFinite(dice) ? Math.max(-20, Math.min(20, Math.trunc(dice))) : 0 }];
  }).slice(0, 100);
  return rules;
}

export function constructionContributionDetail({ type, traits = [], suitableTypes = [], rules: source, matchesType }) {
  const rules = normalizeConstructionDiceRules(source);
  const reasons = [];
  let dice = 0;
  const add = (label, value) => {
    dice += value;
    reasons.push(`${label} ${value >= 0 ? "+" : ""}${value}`);
  };
  add("база", rules.base);
  // Preserve the existing substring matching of professional worker types.
  if (splitList(rules.professionalTypes).some((item) => String(type).toLowerCase().includes(item.toLowerCase()))) add(`тип ${type}`, rules.professional);
  if (suitableTypes.some((item) => matchesType(type, item))) add("подходящий тип", rules.suitable);
  for (const trait of rules.traitRules) {
    if (traits.includes(trait.name.toLowerCase())) add(trait.name, trait.dice);
  }
  const limited = Math.max(0, Math.min(rules.cap, dice));
  if (limited !== dice) reasons.push(`предел 0–${rules.cap}: ${dice} → ${limited}`);
  return { dice: limited, reasons };
}
