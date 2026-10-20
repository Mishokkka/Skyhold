import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { preparationTemplates } from "./building-preparation-revision-check.mjs";
import { preparationMaintenanceNorms } from "./building-maintenance-proposal-check.mjs";
import { BUILDING_CATALOG_V14_TEMPLATES as DEFAULT_BUILDING_TEMPLATES, BUILDING_CATALOG_V14_VERSION as TEMPLATE_CATALOG_VERSION } from "../data/building-template-v14-catalog.js";

const proposal = preparationTemplates();
const norms = preparationMaintenanceNorms();
const source = readFileSync(new URL("../../docs/building-preparation-revision-2026-09-05.md", import.meta.url), "utf8");
const block = source.split("## 1. Дом собраний")[1].split("## 2.")[0];
const fields = new Map(block.split(/\r?\n/).filter((line) => line.startsWith("| "))
  .map((line) => line.split("|").slice(1, -1).map((value) => value.trim().replaceAll("`", ""))));
const numbers = (key) => (fields.get(key).match(/\d+/g) ?? []).map(Number);
assert.deepEqual(numbers("Строительство"), [3, 0, 0]);
assert.deepEqual(numbers("Штат"), [1, 2, 18]);
assert.deepEqual(numbers("Содержание"), [36, 18]);
assert.deepEqual(numbers("Активация"), [1, 20]);
assert.deepEqual(numbers("Услуга"), [120]);
assert.deepEqual(numbers("Контроль"), [1, 1]);
const house = {
  ...proposal.find((row) => row.id === "meeting-house"),
  type: "Инфраструктура", primaryDev: "culture", icon: "fa-solid fa-landmark", img: "", unlocked: true,
  description: "Место общественных сходов, разбора общинных дел и хранения решений.",
  compendiumId: "", sourceRequirement: fields.get("Требования П/Т/К/В"), sourceRawMaterials: fields.get("Материалы"),
  siteRequirementsText: fields.get("Участок"), activationConditionText: fields.get("Активация"),
  effect: fields.get("Услуга"), notes: fields.get("Развитие и повторы"), visibility: "public",
  specialRequirements: fields.get("Участок"),
  buildTarget: numbers("Строительство")[0], buildDifficulty: 0, buildProgress: 0, constructionStatus: "planned",
  materialCosts: fields.get("Канонические ресурсы").split(",").map((value) => {
    const [resourceId, qty] = value.trim().split(":");
    const names = { wood: "Wood", stone: "Stone", cloth: "Cloth", parchment: "Письменные материалы" };
    return { id: `mat-${resourceId}`, resourceId, name: names[resourceId], qty: Number(qty) };
  }),
  workersMin: 1, workersMax: 2, workerRole: "Староста, писарь", assignedWorkerIds: [], wageDailyCopper: 18,
  baseUpkeepMonthlyCopper: 36, operatingUpkeepMonthlyCopper: 18,
  functions: { production: false, income: false, defense: false, housing: false, storage: false, culture: true },
  activation: { minWorkers: 1, minOperationalQd: 20, requiresMeaningfulResult: false },
  service: { capacity: 120, coverageKind: "population", coveredBuildingIds: [] },
  control: { generalFlat: 1, maximum: 1, ceiling: null },
  reputation: 0, moraleDelta: 0, workerMoraleDelta: 0, upkeep: 0,
  housing: { capacity: 0, comfort: 0, quality: 0, notes: "" }, storage: { capacity: 0, security: 0, quality: 0 },
  defense: { base: 0, perStep: 0, workerStep: 0 }, income: { base: 0, perWorker: 0, formula: "", risk: 0, illegal: false },
  blockReasons: [], upgradesFromTemplateIds: [], repeatSettlementEffects: false,
  productionLines: [], serviceProjects: [],
  workerProfile: { version: 1, source: "approved", templateId: "meeting-house", name: "Дом собраний", stage: 2,
    workersMin: 1, workersMax: 2, admission: { text: "Обычная гражданская служба", hard: false, clauses: [] },
    suitableSelectors: [], optimalSelectors: [], composition: [], production: null, reason: fields.get("Допуск работников") }
};
delete house.proposalDependencies;
const patches = proposal.map((row) => {
  const current = DEFAULT_BUILDING_TEMPLATES.find((template) => template.id === row.id);
  const patch = { id: row.id, maintenance: { schemaVersion: 2, requiredPoints: norms.get(row.id), priority: 0, backlogTendays: 0, needsResolution: false, lastOperationId: "" } };
  if (current && JSON.stringify(current.bonuses) !== JSON.stringify(row.bonuses)) patch.bonuses = row.bonuses;
  if (current && JSON.stringify(current.requirements) !== JSON.stringify(row.requirements)) patch.requirements = row.requirements;
  if (row.primaryDev && row.primaryDev !== current?.primaryDev) patch.primaryDev = row.primaryDev;
  for (const dependency of row.proposalDependencies ?? []) {
    const field = dependency.choices.length > 1 ? "requiredAnyBuildingIds" : "requiredBuildingIds";
    const previous = patch[field] ?? current?.[field] ?? [];
    if (field === "requiredAnyBuildingIds") assert.ok(!previous.length, `${row.id}: independent OR groups require a separate representation`);
    patch[field] = [...new Set([...previous, ...dependency.choices])];
    patch.prerequisiteModes ??= {};
    for (const id of dependency.choices) {
      assert.ok(!previous.includes(id), `${row.id}: changing an existing dependency phase requires an explicit decision`);
      patch.prerequisiteModes[id] = dependency.kind === "Построить" ? "construction" : "service";
    }
  }
  return patch;
});
for (const row of DEFAULT_BUILDING_TEMPLATES.filter((row) => !proposal.some((template) => template.id === row.id))) {
  patches.push({ id: row.id, maintenance: { schemaVersion: 2, requiredPoints: 0, priority: 0, backlogTendays: 0, needsResolution: false, lastOperationId: "" } });
}
const output = `// Generated by scripts/dev/build-building-catalog-v15.mjs. Approved v15 revision.\nimport { BUILDING_CATALOG_V14_TEMPLATES as DEFAULT_BUILDING_TEMPLATES } from "./building-template-v14-catalog.js";\n\nexport const BUILDING_CATALOG_V15_VERSION = ${TEMPLATE_CATALOG_VERSION + 1};\nconst HOUSE = ${JSON.stringify(house, null, 2)};\nconst PATCHES = ${JSON.stringify(patches, null, 2)};\n\nexport function buildingCatalogV15Templates() {\n  const byId = new Map(PATCHES.map((row) => [row.id, row]));\n  return [...DEFAULT_BUILDING_TEMPLATES, HOUSE].map((row) => ({\n    ...structuredClone(row), ...structuredClone(byId.get(row.id)), templateVersion: BUILDING_CATALOG_V15_VERSION\n  }));\n}\n`;
const destination = new URL("../data/building-template-revision-v15.js", import.meta.url);
if (process.argv.includes("--check")) assert.equal(readFileSync(destination, "utf8"), output, "Next catalog must be regenerated from its documented sources");
else writeFileSync(destination, output);
console.log(`Approved catalog revision: ${patches.length} templates, version ${TEMPLATE_CATALOG_VERSION + 1}; no world data written.`);
