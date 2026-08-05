import { FBL_SOURCE_BUILDING_MATERIAL_COSTS } from "./building-templates.js";
import {
  LEGACY_CAMPAIGN_BUILDING_MATERIAL_CALIBRATION,
  materialCostFingerprint
} from "./building-template-materials.js";

export const BUILDING_MATERIAL_RECIPE_SNAPSHOT_VERSION = 1;

function text(value = "") {
  return String(value ?? "").trim();
}

function finiteNonNegative(value = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

function cloneRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({ ...row }));
}

function projectProtection(record = {}) {
  const status = text(record?.constructionStatus ?? record?.status).toLowerCase();
  const progress = finiteNonNegative(record?.buildProgress);
  const target = finiteNonNegative(record?.buildTarget);
  const completed = status === "built" || (target > 0 && progress >= target);
  const started = progress > 0 || [
    "building",
    "paused",
    "damaged",
    "heavilydamaged",
    "destroyed"
  ].includes(status);
  const allocated = Boolean(
    record?.materialsAllocated
    || text(record?.materialsAllocatedAt)
    || text(record?.materialsAllocatedLine)
  );
  const reserved = Boolean(
    record?.constructionReservation && typeof record.constructionReservation === "object"
  ) || Boolean(record?.materialsReserved || record?.reservedMaterials);
  const reasons = [];
  if (allocated) reasons.push("allocated");
  if (reserved) reasons.push("reserved");
  if (completed) reasons.push("completed");
  else if (started) reasons.push("started");
  return { protected: reasons.length > 0, allocated, reserved, started, completed, reasons };
}

function legacySnapshot(templateId, rows) {
  return {
    version: BUILDING_MATERIAL_RECIPE_SNAPSHOT_VERSION,
    kind: "building-material-recipe",
    origin: "legacy-campaign-calibration",
    templateId,
    fingerprint: materialCostFingerprint(rows),
    materialCosts: cloneRows(rows)
  };
}

/**
 * Pure activation planner for the Economy V2 recipe reset. It never mutates the
 * stored row and is intentionally not called by ordinary normalization.
 */
export function classifyStoredBuildingMaterialRecipe(record = {}, { kind = "instance" } = {}) {
  const recordKind = kind === "template" ? "template" : "instance";
  const templateId = text(record?.templateId) || text(record?.id);
  const storedRows = cloneRows(record?.materialCosts);
  const storedFingerprint = materialCostFingerprint(storedRows);
  const hasSource = Object.hasOwn(FBL_SOURCE_BUILDING_MATERIAL_COSTS, templateId);
  const sourceRows = hasSource ? cloneRows(FBL_SOURCE_BUILDING_MATERIAL_COSTS[templateId]) : null;
  const sourceFingerprint = hasSource ? materialCostFingerprint(sourceRows) : null;
  const legacyDefinition = LEGACY_CAMPAIGN_BUILDING_MATERIAL_CALIBRATION[templateId] ?? null;
  const legacyRows = legacyDefinition ? cloneRows(legacyDefinition.materialCosts) : null;
  const legacyFingerprint = legacyRows ? materialCostFingerprint(legacyRows) : null;
  const protection = projectProtection(record);

  const common = {
    templateId,
    kind: recordKind,
    storedFingerprint,
    sourceFingerprint,
    legacyFingerprint,
    protection,
    action: "preserve",
    replacementMaterialCosts: null,
    legacySnapshot: null,
    plannedPatch: null
  };

  if (!hasSource) {
    return {
      ...common,
      classification: "unknown-template",
      reason: "У записи нет канонического встроенного рецепта; пользовательские материалы сохранены."
    };
  }

  if (storedFingerprint === sourceFingerprint) {
    return {
      ...common,
      classification: "current-source",
      action: "none",
      reason: "Рецепт уже совпадает с исходным рецептом Forbidden Lands."
    };
  }

  if (legacyRows && storedFingerprint === legacyFingerprint) {
    const snapshot = legacySnapshot(templateId, storedRows);
    if (!protection.protected) {
      return {
        ...common,
        classification: "legacy-calibration-safe-replace",
        action: "replace-with-source",
        replacementMaterialCosts: sourceRows,
        legacySnapshot: snapshot,
        plannedPatch: {
          materialCosts: cloneRows(sourceRows),
          materialRecipeSnapshot: snapshot
        },
        reason: "Нет прогресса, резерва или оплаты: старую кампанийную калибровку можно безопасно заменить исходным рецептом."
      };
    }
    return {
      ...common,
      classification: "legacy-calibration-snapshot",
      legacySnapshot: snapshot,
      plannedPatch: { materialRecipeSnapshot: snapshot },
      reason: "Проект уже начат, оплачен, завершён или зарезервирован; его исторический рецепт должен остаться снимком."
    };
  }

  return {
    ...common,
    classification: "customized",
    reason: "Рецепт отличается и от исходного, и от прежней кампанийной калибровки; пользовательские материалы сохранены."
  };
}
