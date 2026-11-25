import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkBuildingLaborCatalog } from "../building-labor-catalog-check.mjs";
import { checkUnifiedLabor } from "../unified-labor-check.mjs";
import { checkLaborIntegration } from "../labor-integration-check.mjs";

export async function runHybridLaborSuite() {
  checkBuildingLaborCatalog();
  await checkUnifiedLabor();
  await checkLaborIntegration();
  return { suite: "hybrid-labor" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runHybridLaborSuite();
  console.log("FBL Skyhold suite: unified labor passed.");
}
