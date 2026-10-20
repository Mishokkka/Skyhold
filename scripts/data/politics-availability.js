import { buildingServiceBlockReasons } from "../engines/economy/building-service.js";

export const DEFAULT_POLITICS_CULTURE_THRESHOLD = 16;

const POLITICS_BUILDING_IDS = new Set(["meeting-house", "town-hall"]);

export function politicsCultureThreshold(holding = {}) {
  const configured = holding?.gm?.politicsCultureThreshold;
  const value = configured === null || configured === undefined || configured === ""
    ? NaN
    : Number(configured);
  return Number.isFinite(value)
    ? Math.max(0, Math.min(1000, Math.floor(value)))
    : DEFAULT_POLITICS_CULTURE_THRESHOLD;
}

export function politicsAvailability(holding = {}, culture = 0) {
  const threshold = politicsCultureThreshold(holding);
  const currentCulture = Number.isFinite(Number(culture)) ? Number(culture) : 0;
  const hasInstitution = (holding?.buildings?.list ?? []).some((building) => (
    POLITICS_BUILDING_IDS.has(String(building?.templateId ?? ""))
    && buildingServiceBlockReasons(holding, building).active
  ));
  const ignoreInstitutionRequirement = holding?.gm?.politicsIgnoreInstitutionRequirement === true;
  const cultureReady = currentCulture >= threshold;
  return {
    available: cultureReady && (hasInstitution || ignoreInstitutionRequirement),
    culture: currentCulture,
    threshold,
    cultureReady,
    hasInstitution,
    ignoreInstitutionRequirement
  };
}
