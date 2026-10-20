import { APPROVED_BUILDING_TEMPLATE_MANIFEST } from "./building-template-manifest.js";

export const CONSTRUCTION_CENTER_TEMPLATE_ID = "construction-center";

/**
 * Runtime projection of the approved 124-template development contract.
 * The generated manifest is the single machine-readable source; this export is
 * retained for existing callers and characterization checks.
 */
export const BUILDING_DEVELOPMENT_TREE_V1 = Object.freeze(Object.fromEntries(
  APPROVED_BUILDING_TEMPLATE_MANIFEST.map((template) => [String(template.id), Object.freeze({
    developmentStage: Number(template.developmentStage) || 0,
    requiresConstructionCenter: template.requiresConstructionCenter === true,
    requirements: { ...(template.requirements ?? {}) },
    bonuses: { ...(template.bonuses ?? {}) },
    requiredBuildingIds: [...(template.requiredBuildingIds ?? [])],
    requiredAnyBuildingIds: [...(template.requiredAnyBuildingIds ?? [])],
    buildTarget: template.buildTarget,
    buildDifficulty: template.buildDifficulty
  })])
));

export const BUILDING_DEVELOPMENT_TREE_IDS_V1 = Object.freeze(Object.keys(BUILDING_DEVELOPMENT_TREE_V1));

export function buildingRequiresConstructionCenter(building = {}) {
  const id = String(building?.id ?? building?.templateId ?? "").trim();
  if (id === CONSTRUCTION_CENTER_TEMPLATE_ID) return false;
  if (building?.requiresConstructionCenter !== undefined) return building.requiresConstructionCenter === true;
  return Number(building?.developmentStage ?? 0) >= 4;
}

export function applyBuildingDevelopmentTree(templates = []) {
  return (templates ?? []).map((template) => {
    const override = BUILDING_DEVELOPMENT_TREE_V1[String(template?.id ?? "")];
    if (!override) return { ...template };
    return {
      ...template,
      ...override,
      requirements: { ...override.requirements },
      bonuses: { ...override.bonuses },
      requiredBuildingIds: [...override.requiredBuildingIds],
      requiredAnyBuildingIds: [...override.requiredAnyBuildingIds]
    };
  });
}
