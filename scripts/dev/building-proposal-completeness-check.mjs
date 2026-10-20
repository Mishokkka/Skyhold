import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// This document specifies v14. Current v15/v16 behavior has separate catalog contracts.
import { BUILDING_CATALOG_V14_TEMPLATES as DEFAULT_BUILDING_TEMPLATES, BUILDING_CATALOG_V14_VERSION as TEMPLATE_CATALOG_VERSION } from "../data/building-template-v14-catalog.js";
import { RESOURCE_BASE_DEFINITIONS } from "../data/resources/resource-base-definitions.js";

const source = readFileSync(new URL("../../docs/building-development-tree-proposal.md", import.meta.url), "utf8");
const STAGES = Object.freeze({ "0": 0, I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7 });
const WAGE_TIERS = new Set([12, 18, 24]);

function clean(value = "") {
  return String(value).replaceAll("`", "").replaceAll("**", "").trim();
}

function nameOf(value = "") {
  return clean(value).replace(/[«»]/g, "").replace(/\s+/g, " ");
}

function pipeRow(line = "") {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(clean);
}

function stageOf(value = "") {
  const match = String(value).match(/Этап\s+(VII|VI|IV|V|III|II|I|0)\b/);
  return match ? STAGES[match[1]] : null;
}

function tablesIn(markdown = "") {
  const lines = markdown.split(/\r?\n/);
  const tables = [];
  let h2 = "";
  let h3 = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("## ")) {
      h2 = clean(line.slice(3));
      h3 = "";
      continue;
    }
    if (line.startsWith("### ")) {
      h3 = clean(line.slice(4));
      continue;
    }
    if (!line.startsWith("|") || !lines[index + 1]?.startsWith("|---")) continue;
    const headers = pipeRow(line);
    const rows = [];
    let cursor = index + 2;
    while (cursor < lines.length && lines[cursor].startsWith("|")) rows.push(pipeRow(lines[cursor++]));
    tables.push({ h2, h3, headers, rows });
    index = cursor - 1;
  }
  return tables;
}

function numberOf(value, fallback = 0) {
  const match = clean(value).replace(/\s+/g, "").match(/-?\d+(?:[.,]\d+)?/);
  return match ? Number(match[0].replace(",", ".")) : fallback;
}

function vectorOf(value) {
  const values = clean(value).match(/[+-]?\d+/g)?.map(Number) ?? [];
  assert.equal(values.length, 4, `expected a four-part development vector in ${value}`);
  return values;
}

function workersOf(value) {
  const text = clean(value);
  if (/^Нет\b/i.test(text) || text === "—") return { min: 0, max: 0 };
  const values = text.match(/\d+/g)?.map(Number) ?? [];
  if (values.length >= 2) return { min: values[0], max: values[1] };
  if (values.length === 1) return { min: values[0], max: values[0] };
  return { min: 0, max: 0 };
}

const tables = tablesIn(source);
const treeEnd = source.indexOf("## Норматив стоимости строительства");
const treeTables = tablesIn(source.slice(0, treeEnd)).filter((table) => table.headers[0] === "Шаблон");
const buildings = [];
for (const table of treeTables) {
  const stage = stageOf(table.h2);
  if (stage === null) continue;
  for (const row of table.rows) {
    const bonusIndex = table.headers.indexOf("Бонус");
    const vectors = row.slice(1).map((cell) => clean(cell)).filter((cell) => /^-?\d+\/-?\d+\/-?\d+\/-?\d+$/.test(cell));
    buildings.push({
      name: nameOf(row[0]),
      stage,
      requirements: vectors.length > 1 ? vectorOf(vectors[0]) : [0, 0, 0, 0],
      bonuses: vectorOf(row[bonusIndex])
    });
  }
}
assert.equal(buildings.length, 118, "the approved development tree must contain 118 buildings");
assert.equal(new Set(buildings.map((row) => row.name)).size, 118, "approved building names must be unique");
assert.deepEqual(
  buildings.reduce((totals, row) => totals.map((value, index) => value + row.bonuses[index]), [0, 0, 0, 0]),
  [150, 150, 150, 150],
  "the complete catalog must preserve the approved 150-point ceilings"
);
const buildingByName = new Map(buildings.map((row) => [row.name, row]));

const aliasToResourceId = new Map();
for (const resource of RESOURCE_BASE_DEFINITIONS) {
  for (const alias of [resource.id, resource.name, resource.label, ...(resource.aliases ?? [])].filter(Boolean)) {
    aliasToResourceId.set(String(alias).toLocaleLowerCase("ru"), resource.id);
  }
}
const constructionAliases = Object.freeze({
  "rare wood": "rare-wood",
  "simple components": "components-simple",
  "complex components": "components-complex",
  "high-tech components": "components-hightech",
  "simple tools": "tools-simple",
  "complex tools": "tools-complex",
  "medical supplies": "medical-supplies",
  "complex alloys": "complex-alloys",
  "simple military supplies": "military-supplies-simple",
  "complex military supplies": "military-supplies-complex",
  "written goods": "goods-written",
  "art goods": "goods-art"
});
function constructionResourceId(value) {
  const key = clean(value).toLocaleLowerCase("ru");
  return constructionAliases[key] ?? aliasToResourceId.get(key) ?? "";
}

const costRows = new Map();
let constructionMaterialRows = 0;
let constructionMoneyRows = 0;
for (const table of tables.filter((row) => row.h2 === "Норматив стоимости строительства" && row.headers[0] === "Шаблон")) {
  const stage = stageOf(table.h3);
  for (const row of table.rows) {
    const name = nameOf(row[0]);
    assert.ok(buildingByName.has(name), `construction cost references unknown building ${name}`);
    assert.equal(buildingByName.get(name).stage, stage, `${name}: construction stage must match the development tree`);
    assert.equal(costRows.has(name), false, `${name}: duplicate construction cost row`);
    const buildTarget = numberOf(row[1]);
    const buildDifficulty = numberOf(row[2]);
    const moneyCopper = numberOf(row[4]);
    assert.ok(Number.isInteger(buildTarget) && buildTarget > 0, `${name}: buildTarget must be a positive integer`);
    assert.ok(Number.isInteger(buildDifficulty) && buildDifficulty >= -3 && buildDifficulty <= 1, `${name}: buildDifficulty must be an integer from -3 to +1`);
    assert.ok(Number.isInteger(moneyCopper) && moneyCopper >= 0, `${name}: construction money must be a non-negative integer`);
    if (moneyCopper > 0) constructionMoneyRows += 1;
    const materialText = clean(row[3]);
    if (materialText && materialText !== "—") {
      for (const part of materialText.split(";").map((value) => value.trim()).filter(Boolean)) {
        const match = part.match(/^(.+?)\s+([\d\s]+)$/);
        assert.ok(match, `${name}: cannot parse construction material ${part}`);
        const qty = Number(match[2].replace(/\s+/g, ""));
        const resourceId = constructionResourceId(match[1]);
        assert.ok(resourceId, `${name}: construction material ${match[1]} has no canonical resource`);
        assert.ok(Number.isInteger(qty) && qty > 0, `${name}: construction material ${match[1]} must have a positive integer quantity`);
        constructionMaterialRows += 1;
      }
    }
    costRows.set(name, { buildTarget, buildDifficulty, moneyCopper });
  }
}
assert.equal(costRows.size, 118, "construction tables must cover all 118 buildings exactly once");
assert.equal(constructionMaterialRows, 486, "physical construction material coverage changed and needs an explicit review");
assert.equal(constructionMoneyRows, 36, "construction money coverage changed and needs an explicit review");

const operationStart = source.indexOf("## Эксплуатационный норматив");
const operationEnd = source.indexOf("## Утверждённый проект репутации и довольства", operationStart);
const operationTables = tablesIn(source.slice(operationStart, operationEnd)).filter((table) => table.headers[0] === "Шаблон");
const operationRows = new Map();
for (const table of operationTables) {
  const stage = stageOf(table.h3);
  for (const row of table.rows) {
    const cells = Object.fromEntries(table.headers.map((header, index) => [header, row[index] ?? ""]));
    const name = nameOf(row[0]);
    const workers = workersOf(cells["Рабочие места"]);
    let wage = numberOf(cells["Ставка, ММ/день"]);
    if (!table.headers.includes("Ставка, ММ/день") && workers.max > 0 && stage === 3) wage = 18;
    const upkeep = clean(cells["База / эксплуатация, ММ/месяц"]).match(/\d+/g)?.map(Number) ?? [];
    const maintenance = table.headers.includes("Обсл.") ? numberOf(cells["Обсл."]) : 1;
    assert.ok(buildingByName.has(name), `operation row references unknown building ${name}`);
    assert.equal(buildingByName.get(name).stage, stage, `${name}: operation stage must match the development tree`);
    assert.equal(operationRows.has(name), false, `${name}: duplicate operation row`);
    assert.ok(Number.isInteger(workers.min) && Number.isInteger(workers.max) && workers.min >= 0 && workers.min <= workers.max, `${name}: invalid staffing range`);
    if (workers.max > 0) assert.ok(WAGE_TIERS.has(wage), `${name}: staffed building must use an approved ordinary wage tier`);
    else assert.equal(wage, 0, `${name}: unstaffed building must not have a template wage`);
    assert.equal(wage === 120, false, `${name}: the exceptional 120 MM wage cannot be a whole-template default`);
    assert.equal(upkeep.length >= 2, true, `${name}: base and operating upkeep must both be explicit`);
    assert.equal(upkeep.slice(0, 2).every((value) => Number.isInteger(value) && value >= 0), true, `${name}: upkeep must use non-negative integer MM values`);
    assert.ok(Number.isInteger(maintenance) && maintenance >= 1 && maintenance <= 3, `${name}: maintenance must be an integer from 1 to 3`);
    operationRows.set(name, { ...workers, wage, maintenance });
  }
}
assert.equal(operationRows.size, 118, "operation tables must cover all 118 buildings exactly once");
assert.deepEqual(operationRows.get("Баня"), { min: 2, max: 2, wage: 18, maintenance: 1 }, "Bathhouse staffing must stay fixed at two workers");

const effectsStart = source.indexOf("## Утверждённый проект репутации и довольства");
const effectsEnd = source.indexOf("## Сюжетные шаблоны вне дерева", effectsStart);
const effectRows = [...source.slice(effectsStart, effectsEnd).matchAll(/^\| ([^|]+) \| `([+-]?\d+)\/([+-]?\d+)\/([+-]?\d+)` \|/gm)]
  .map((match) => ({ name: nameOf(match[1]), reputation: Number(match[2]), morale: Number(match[3]), workerMorale: Number(match[4]) }));
assert.equal(effectRows.length, 118, "reputation and morale tables must cover all 118 buildings");
assert.equal(new Set(effectRows.map((row) => row.name)).size, 118, "reputation and morale rows must be unique");
assert.equal(effectRows.every((row) => buildingByName.has(row.name)), true, "reputation and morale rows must reference approved buildings");
assert.equal(effectRows.every((row) => row.reputation >= 0), true, "building reputation must represent non-negative fame");
assert.deepEqual(
  effectRows.reduce((totals, row) => [totals[0] + row.reputation, totals[1] + row.morale, totals[2] + row.workerMorale], [0, 0, 0]),
  [54, 54, -28],
  "reputation and morale totals changed without an explicit review"
);

const projectNamesByRuntimeId = Object.freeze({ "grain-field": "Полевое хозяйство", portcullis: "Решётка" });
const runtimeInProject = DEFAULT_BUILDING_TEMPLATES.filter((template) => buildingByName.has(projectNamesByRuntimeId[template.id] ?? template.name));
assert.equal(TEMPLATE_CATALOG_VERSION, 14, "the approved runtime catalog must use migration version 14");
assert.equal(DEFAULT_BUILDING_TEMPLATES.length, 120, "runtime catalog must contain 118 approved and two story templates");
assert.equal(runtimeInProject.length, 118, "every approved tree building must be present in the runtime catalog");

for (const field of [
  "siteRequirementsText",
  "activationConditionText",
  "service.capacity",
  "service.coveredBuildingIds",
  "serviceProjects",
  "minOperationalQd",
  "upgradesFromTemplateIds",
  "repeatSettlementEffects",
  "blockReasons"
]) assert.ok(source.includes(`\`${field}\``), `the proposal must define ${field}`);

const staffedCount = [...operationRows.values()].filter((row) => row.max > 0).length;
const wageCounts = [...operationRows.values()].reduce((counts, row) => {
  if (row.max > 0) counts.set(row.wage, (counts.get(row.wage) ?? 0) + 1);
  return counts;
}, new Map());
console.log(`Building proposal completeness passed: 118 tree/cost/operation/effect rows, ${constructionMaterialRows} material and ${constructionMoneyRows} money cost rows, ${staffedCount} staffed templates (12/18/24 MM: ${wageCounts.get(12) ?? 0}/${wageCounts.get(18) ?? 0}/${wageCounts.get(24) ?? 0}), runtime catalog v${TEMPLATE_CATALOG_VERSION} has all 118 approved templates plus two story templates.`);
