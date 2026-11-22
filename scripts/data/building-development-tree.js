export const CONSTRUCTION_CENTER_TEMPLATE_ID = "construction-center";

export function buildingRequiresConstructionCenter(building = {}) {
  const id = String(building?.id ?? building?.templateId ?? "").trim();
  if (id === CONSTRUCTION_CENTER_TEMPLATE_ID) return false;
  if (building?.requiresConstructionCenter !== undefined) return building.requiresConstructionCenter === true;
  return Number(building?.developmentStage ?? 0) >= 4;
}
