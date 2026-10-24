import path from "node:path";
import { checkWorkerProfileEditor } from "../worker-profile-editor-check.mjs";
import { pathToFileURL } from "node:url";
import { checkCalendariaCharacterization } from "../calendaria-characterization-check.mjs";
import { checkContentPackCharacterization } from "../content-pack-characterization-check.mjs";
import { checkEventAutomationCharacterization } from "../event-automation-characterization-check.mjs";
import { checkRandomEventsCharacterization } from "../random-events-characterization-check.mjs";
import { checkWorkerPlannerCharacterization } from "../worker-planner-characterization-check.mjs";
import { checkSocketCharacterization } from "../socket-characterization-check.mjs";
import { checkSkyholdContextCharacterization } from "../context-characterization-check.mjs";
import { checkEconomyResourceCatalogCharacterization } from "../economy-resource-catalog-characterization-check.mjs";
import { checkBuildingDevelopmentTreeCharacterization } from "../building-development-tree-characterization-check.mjs";
import { checkResidentCharacterization } from "../resident-characterization-check.mjs";
import { checkBuildingCatalogV15 } from "../building-catalog-v15-check.mjs";
import { checkBuildingCatalogV16 } from "../building-catalog-v16-check.mjs";
import { checkApprovedBuildingDevelopment } from "../building-approved-development-check.mjs";
import { checkMagnifiqueCrewContent } from "../magnifique-crew-content-check.mjs";
import { checkPoliticsAvailability } from "../politics-availability-check.mjs";
import { checkPoliticsRules } from "../politics-rules-check.mjs";
import { checkAuditRegressions } from "../audit-regression-check.mjs";
import { checkCoreSafety } from "../core-safety-check.mjs";

/** Runs data, catalog, normalization and socket/context safety checks, awaiting checks that use asynchronous fixtures. */
export async function runDataSuite() {
  checkCoreSafety();
  checkWorkerProfileEditor();
  checkPoliticsAvailability();
  checkPoliticsRules();
  checkBuildingCatalogV15();
  checkBuildingCatalogV16();
  checkApprovedBuildingDevelopment();
  checkCalendariaCharacterization();
  checkRandomEventsCharacterization();
  checkWorkerPlannerCharacterization();
  checkEventAutomationCharacterization();
  checkContentPackCharacterization();
  checkEconomyResourceCatalogCharacterization();
  checkBuildingDevelopmentTreeCharacterization();
  checkResidentCharacterization();
  await checkMagnifiqueCrewContent();
  await checkSocketCharacterization();
  await checkSkyholdContextCharacterization();
  await checkAuditRegressions();
  return { suite: "data" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runDataSuite();
  console.log("FBL Skyhold suite: data passed.");
}
