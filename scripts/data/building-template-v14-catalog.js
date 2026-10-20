// Historical baseline for explicit migration comparisons and reproducible v15 generation.
import { APPROVED_BUILDING_TEMPLATE_MANIFEST } from "./building-template-v14-base.js";
import { BUILDING_TEMPLATES_UNIQUE } from "./building-template-catalog/unique.js";
import { applyEconomicTemplateCalibration } from "./building-template-economy-calibration.js";
import { applyApprovedBuildingWorkerProfile } from "../engines/workers/building-qualification.js";

export const BUILDING_CATALOG_V14_VERSION = 14;
export const BUILDING_CATALOG_V14_TEMPLATES = [
  ...APPROVED_BUILDING_TEMPLATE_MANIFEST,
  ...applyEconomicTemplateCalibration(BUILDING_TEMPLATES_UNIQUE)
    .filter((row) => ["fasti-shop", "laputa-excavated-crypt"].includes(row.id))
].map(applyApprovedBuildingWorkerProfile).map((row) => ({ ...row, templateVersion: 14 }));
