import path from "node:path";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkUiContract } from "../ui-contract-check.mjs";
import { checkTemplateBrowser } from "../template-browser-characterization-check.mjs";
import { checkMoraleDialogPresentation } from "../morale-dialog-presentation-check.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function walk(dir, output = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, output);
    else if (full.endsWith(".hbs")) output.push(full);
  }
  return output;
}

export function runUiContractSuite() {
  checkMoraleDialogPresentation();
  checkTemplateBrowser();
  const hbsFiles = walk(path.join(root, "templates"));
  checkUiContract({ root, hbsFiles });
  return { suite: "ui-contract", templates: hbsFiles.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = runUiContractSuite();
  console.log(`FBL Skyhold suite: UI contract passed (${result.templates} templates).`);
}
