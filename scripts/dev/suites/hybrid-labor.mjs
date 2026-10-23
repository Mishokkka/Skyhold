import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkHybridLaborData, checkHybridLaborMigration } from "../hybrid-labor-data-check.mjs";
import { checkBuildingLaborCatalog } from "../building-labor-catalog-check.mjs";
import { checkHybridLaborPlanner } from "../hybrid-labor-planner-check.mjs";
import { checkHybridLaborRuntime } from "../hybrid-labor-runtime-check.mjs";
import { checkHybridLaborPeriodic } from "../hybrid-labor-periodic-check.mjs";
import { checkHybridService } from "../hybrid-service-check.mjs";
import { checkHybridStaffSelection } from "../hybrid-staff-selection-check.mjs";
import { checkHybridLaborMigrationWindow } from "../hybrid-labor-migration-window-check.mjs";
import { checkHybridLaborReview } from "../hybrid-labor-review-check.mjs";
import { checkHybridLaborFunctional } from "../hybrid-labor-functional-check.mjs";
import { checkHybridLaborDeepReview } from "../hybrid-labor-deep-review-check.mjs";

export async function runHybridLaborSuite() {
  await checkHybridLaborData();
  await checkHybridLaborMigration();
  await checkHybridLaborMigrationWindow();
  checkBuildingLaborCatalog();
  await checkHybridLaborPlanner();
  checkHybridStaffSelection();
  await checkHybridLaborRuntime();
  await checkHybridLaborReview();
  await checkHybridLaborFunctional();
  await checkHybridLaborDeepReview();
  checkHybridLaborPeriodic();
  checkHybridService();
  return { suite: "hybrid-labor" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runHybridLaborSuite();
  console.log("FBL Skyhold suite: hybrid labor passed.");
}
