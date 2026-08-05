import { FBL_SOURCE_BUILDING_MATERIAL_COSTS } from "./building-templates.js";

function rowsFrom(templateId) {
  return Object.freeze((FBL_SOURCE_BUILDING_MATERIAL_COSTS[templateId] ?? [])
    .map((row) => Object.freeze({ ...row })));
}

function family({ id, label, size, complexity, exampleTemplateId, notes }) {
  return Object.freeze({
    id,
    label,
    size,
    complexity,
    scope: "new-custom-template-only",
    exampleTemplateId,
    notes,
    materialCosts: rowsFrom(exampleTemplateId)
  });
}

/**
 * Optional starting recipes for a GM creating a brand-new custom template.
 * They are copied from source catalog examples; no normalization or migration
 * applies them to an existing custom template.
 */
export const CUSTOM_BUILDING_RECIPE_FAMILIES = Object.freeze([
  family({
    id: "small-simple",
    label: "Малая простая",
    size: "small",
    complexity: "simple",
    exampleTemplateId: "pasture",
    notes: "Лёгкая деревянная ограда или навес. Пример: пастбище."
  }),
  family({
    id: "small-masonry",
    label: "Малая каменная",
    size: "small",
    complexity: "masonry",
    exampleTemplateId: "well",
    notes: "Небольшая кладка без сложного оснащения. Пример: колодец."
  }),
  family({
    id: "medium-simple",
    label: "Средняя простая",
    size: "medium",
    complexity: "simple",
    exampleTemplateId: "tannery",
    notes: "Обычная деревянная мастерская. Пример: кожевня."
  }),
  family({
    id: "medium-mixed",
    label: "Средняя смешанная",
    size: "medium",
    complexity: "mixed",
    exampleTemplateId: "common-house",
    notes: "Деревянный корпус с каменным основанием. Пример: общий дом."
  }),
  family({
    id: "large-technical",
    label: "Большая техническая",
    size: "large",
    complexity: "technical",
    exampleTemplateId: "forge",
    notes: "Тяжёлая кладка и стационарное железное оснащение. Пример: кузница."
  }),
  family({
    id: "monumental-masonry",
    label: "Монументальная каменная",
    size: "monumental",
    complexity: "massive",
    exampleTemplateId: "ramparts",
    notes: "Поселенческий масштаб каменной обороны. Пример: стены."
  })
]);

export function materialCostsForNewCustomTemplate(familyId = "") {
  const familyRow = CUSTOM_BUILDING_RECIPE_FAMILIES.find((row) => row.id === String(familyId));
  return familyRow ? familyRow.materialCosts.map((row) => ({ ...row })) : null;
}

