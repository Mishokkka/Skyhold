import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkWorkAllocationCharacterization } from "../work-allocation-characterization-check.mjs";
import { checkLaborBudget } from "../labor-budget-check.mjs";
import { checkWorkforcePlanner } from "../workforce-planner-check.mjs";
import { checkWorkforcePlannerWindow } from "../workforce-planner-window-check.mjs";

export async function runWorkforceSuite() {
  checkWorkAllocationCharacterization();
  checkLaborBudget();
  await checkWorkforcePlanner();
  await checkWorkforcePlannerWindow();
  return { suite: "workforce" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runWorkforceSuite();
  console.log("FBL Skyhold suite: workforce passed.");
}
