import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { DEFAULT_BUILDING_TEMPLATES } from "../data/building-templates.js";
import { normalizeBuilding } from "../data/normalizers/building.js";

const PROJECT_TEMPLATE_IDS = ["agronomic-institute", "airship-yard", "military-academy", "university"];

export function checkBuildingServiceProjectCharacterization() {
  const projectTemplates = DEFAULT_BUILDING_TEMPLATES
    .filter((template) => PROJECT_TEMPLATE_IDS.includes(template.id) || (Array.isArray(template.serviceProjects) && template.serviceProjects.length > 0))
    .map((template) => template.id)
    .sort();
  assert.deepEqual(projectTemplates, PROJECT_TEMPLATE_IDS, "only the four approved institutions must opt into the shared long-term project contract");

  const building = {
    id: "project-building",
    templateId: "university",
    serviceProjects: [{
      id: "project-one",
      kind: "research",
      title: "Исследование подъёмного кристалла",
      status: "active",
      progressQd: 9.8,
      targetQd: 20,
      participantIds: [" scholar ", "scholar", "assistant"],
      targetIds: ["crystal"],
      resourceCosts: [{ resourceId: "parchment", qty: 3.2 }],
      notes: "Результат требует решения GM.",
      gmDecisionStatus: "pending"
    }]
  };
  normalizeBuilding(building);
  assert.equal(building.serviceProjects[0].progressQd, 9, "project work must remain integer QD");
  assert.equal(building.serviceProjects[0].resourceCosts[0].qty, 4, "project resource costs must remain whole and sufficient");
  assert.deepEqual(building.serviceProjects[0].participantIds, ["scholar", "assistant"], "project participant IDs must be trimmed and unique");
  assert.equal(building.serviceProjects[0].gmDecisionStatus, "pending", "the GM decision gate must survive normalization");

  const shell = fs.readFileSync(new URL("../../templates/building-editor.hbs", import.meta.url), "utf8");
  const rules = fs.readFileSync(new URL("../../templates/parts/building-editor/rules.hbs", import.meta.url), "utf8");
  const culture = fs.readFileSync(new URL("../../templates/parts/building-editor/culture.hbs", import.meta.url), "utf8");
  const projects = fs.readFileSync(new URL("../../templates/parts/building-editor/projects.hbs", import.meta.url), "utf8");
  const editor = fs.readFileSync(new URL("../apps/editors/building-editor.js", import.meta.url), "utf8");
  assert.match(shell, /building-editor\/rules\.hbs/, "the building editor must expose structured activation, service and control rules");
  assert.match(shell, /building-editor\/projects\.hbs/, "the building editor must expose the shared project contract");
  for (const field of ["siteRequirementsText", "activationConditionText", "repeatSettlementEffects", "service\.capacity", "control\.ceiling", "upgradesFromTemplateIds"]) {
    assert.match(rules, new RegExp(field), `the main tab rules block must expose ${field}`);
  }
  assert.match(rules, /building\.showEditorMain/, "structured rules must render with the main tab");
  assert.doesNotMatch(rules, /service\.leisure/, "the main tab rules block must not duplicate leisure fields");
  for (const field of ["kind", "capacity", "minWorkers", "qdPerCapacity", "functionId"]) {
    assert.match(culture, new RegExp(`service\\.leisure\\.${field}`), `the culture tab must expose leisure ${field}`);
  }
  assert.doesNotMatch(editor, /id:\s*["']rules["']/, "the removed standalone rules tab must not return");
  assert.match(editor, /functions\?\.culture\s*\|\|\s*building\.hasConfiguredLeisure/, "configured leisure must remain editable on a non-culture building");
  assert.match(editor, /!tabs\.some\(\(tab\)\s*=>\s*tab\.id\s*===\s*this\.activeTab\)[\s\S]{0,100}tabs\[0\]/, "a saved rules-tab selection must fall back to the main tab");
  for (const action of ["add-service-project", "delete-service-project", "add-service-project-cost", "delete-service-project-cost", "pick-service-project-resource"]) {
    assert.match(projects, new RegExp(`data-action=["']${action}["']`), `the project tab must expose ${action}`);
    assert.match(editor, new RegExp(`["']${action}["']\\s*:`), `the building editor must wire ${action}`);
  }
  assert.match(projects, /gmDecisionStatus/, "projects must expose the explicit GM decision state");
  assert.match(projects, /list-picker\.hbs.*participantPicker/, "projects must expose the participant selection list");
  assert.match(editor, /projectParticipantPicker\(project, holding, `\$\{building\.basePath\}\.serviceProjects\.\$\{project\.projectIndex\}\.participantIds`\)/,
    "the list must still save the project's participant IDs through its scoped field path");
  assert.match(projects, /targetIds/, "projects must expose targets");
  assert.match(projects, /resourceCosts/, "projects must expose resource costs");
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkBuildingServiceProjectCharacterization();
  console.log("FBL Skyhold building service projects: four institutions, integer project state, rules UI and GM decision gate passed.");
}
