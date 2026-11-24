import { BUILDING_TEMPLATES_UNIQUE } from "./building-template-catalog/unique.js";
import { APPROVED_BUILDING_TEMPLATE_MANIFEST } from "./building-template-manifest.js";
import { APPROVED_BUILDING_TEMPLATE_IDS } from "./building-template-ids.js";
import { applyApprovedBuildingWorkerProfile } from "../engines/workers/building-qualification.js";
import { applyApprovedBuildingLaborProfile } from "./building-labor-catalog.js";

export const TEMPLATE_CATALOG_VERSION = 19;
export const DEPRECATED_TEMPLATE_IDS = new Set(["campfire", "hut", "storehouse", "field", "lumberyard", "smithy", "tavern", "watchtower", "fireplace"]);

const STORY_TEMPLATE_IDS = Object.freeze(["fasti-shop", "laputa-excavated-crypt"]);
export const TEMPLATE_ORDER = [...APPROVED_BUILDING_TEMPLATE_IDS, ...STORY_TEMPLATE_IDS];
const STORY_TEMPLATES = BUILDING_TEMPLATES_UNIQUE
  .filter((template) => STORY_TEMPLATE_IDS.includes(String(template?.id ?? "")))
  .map((template) => ({ ...template }));
function applyCatalogWorkerProfile(template) {
  const workersMin = Number(template?.workersMin ?? 0);
  const workersMax = Number(template?.workersMax ?? 0);
  const profiled = applyApprovedBuildingWorkerProfile(template);
  return {
    ...profiled,
    workersMin,
    workersMax,
    ...(profiled.workerProfile ? {
      workerProfile: { ...profiled.workerProfile, workersMin, workersMax }
    } : {})
  };
}

const TEMPLATE_ROWS = [
  ...APPROVED_BUILDING_TEMPLATE_MANIFEST,
  ...STORY_TEMPLATES
].map(applyCatalogWorkerProfile)
  .map((template) => ({ ...template, templateVersion: TEMPLATE_CATALOG_VERSION }));
const TEMPLATE_BY_ID = new Map(TEMPLATE_ROWS.map((template) => [String(template.id), template]));

// The catalog/recipe migration operates directly on the unified v2 templates.
export const DEFAULT_BUILDING_TEMPLATES = TEMPLATE_ORDER
  .map((id) => TEMPLATE_BY_ID.get(id))
  .filter(Boolean)
  .map((template) => applyApprovedBuildingLaborProfile({ ...template }));
