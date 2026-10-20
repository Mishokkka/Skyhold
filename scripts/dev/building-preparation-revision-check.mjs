import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { APPROVED_BUILDING_TEMPLATE_MANIFEST } from "../data/building-template-v14-base.js";
import { applyApprovedDevelopment } from "./building-development-approved-data.mjs";

const source = readFileSync(new URL("../../docs/building-preparation-revision-2026-09-05.md", import.meta.url), "utf8");
const keys = ["food", "technology", "culture", "war"];
const vector = (text) => Object.fromEntries(keys.map((key, index) => [key, Number(text.split("/")[index])]));
const cells = (line) => line.split("|").slice(1, -1).map((cell) => cell.trim().replaceAll("`", ""));

// Reconstruct the approved catalog from historical inputs and explicit decisions.
// This function itself never writes runtime files or world data.
export function preparationTemplates() {
  const rows = structuredClone(APPROVED_BUILDING_TEMPLATE_MANIFEST);
  const byName = new Map(rows.map((row) => [row.name, row]));
  const houseBlock = source.split("## 1. Дом собраний")[1].split("## 2.")[0];
  const fields = new Map(houseBlock.split(/\r?\n/).filter((line) => line.startsWith("| ")).map(cells));
  const house = {
    id: fields.get("ID"), name: fields.get("Название"), developmentStage: 2,
    requirements: vector(fields.get("Требования П/Т/К/В")),
    bonuses: vector(fields.get("Развитие П/Т/К/В")),
    requiredBuildingIds: [], requiredAnyBuildingIds: [], requiresConstructionCenter: false
  };
  assert.equal(house.id, "meeting-house");
  assert.deepEqual(house.requirements, vector("8/6/10/0"));
  rows.push(house);
  byName.set(house.name, house);
  const bonuses = source.split("## 2. Перераспределение развития")[1].split("## 3.")[0];
  const changes = bonuses.split(/\r?\n/).filter((line) => /^\| [^|]+ \| `\d/.test(line)).map(cells);
  assert.equal(changes.length, 4);
  for (const [name, before, after] of changes) {
    const row = byName.get(name);
    assert.ok(row, `Unknown changed building: ${name}`);
    assert.deepEqual(row.bonuses, vector(before), `${name}: proposal baseline changed`);
    const next = vector(after);
    assert.equal(keys.reduce((sum, key) => sum + row.bonuses[key] - next[key], 0), 1);
    assert.ok(keys.every((key) => next[key] <= row.bonuses[key]));
    row.bonuses = next;
  }
  const dependencyBlock = source.split("### Новые условия")[1].split("### Существующие условия")[0];
  // User correction after the first successful v15 migration: these services
  // do not develop food production. No other building receives those points.
  for (const id of ["lazaret", "lighthouse"]) {
    const row = rows.find((entry) => entry.id === id);
    row.bonuses.food = 0;
    row.primaryDev = id === "lighthouse" ? "technology" : "culture";
  }
  const additions = dependencyBlock.split(/\r?\n/).filter((line) => /^\| [^|]+ \| (Построить|Работать) \|/.test(line)).map(cells);
  assert.equal(additions.length, 14);
  for (const row of rows) row.proposalDependencies = [];
  for (const [name, kind, requires] of additions) {
    const row = byName.get(name);
    assert.ok(row, `Unknown dependency owner: ${name}`);
    const choices = requires.split(" ИЛИ ").map((name) => {
      const dependency = byName.get(name);
      assert.ok(dependency, `Unknown dependency: ${name}`);
      assert.notEqual(dependency.id, row.id);
      return dependency.id;
    });
    row.proposalDependencies.push({ kind, choices });
  }
  return applyApprovedDevelopment(rows);
}

export function preparationRoute(rows, targetIds) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const totals = vector("0/0/0/0");
  const built = new Set();
  const order = [];
  const groups = (row) => [
    ...(row.requiredBuildingIds ?? []).map((id) => [id]),
    ...((row.requiredAnyBuildingIds ?? []).length ? [row.requiredAnyBuildingIds] : []),
    ...(row.requiresConstructionCenter ? [["construction-center"]] : []),
    ...(row.proposalDependencies ?? []).map((entry) => entry.choices)
  ];
  const missing = (row) => groups(row).find((group) => !group.some((id) => built.has(id)));
  const numerical = (row) => keys.every((key) => totals[key] >= row.requirements[key]);
  while (targetIds.some((id) => !built.has(id))) {
    assert.ok(order.length < rows.length, "Construction route stalled");
    let target = byId.get(targetIds.find((id) => !built.has(id)));
    const visiting = new Set();
    while (missing(target)) {
      assert.ok(!visiting.has(target.id), `Cyclic prerequisite at ${target.id}`);
      visiting.add(target.id);
      target = byId.get(missing(target)[0]);
      assert.ok(target, "Unresolved prerequisite");
    }
    if (!numerical(target)) {
      const deficit = Object.fromEntries(keys.map((key) => [key, Math.max(0, target.requirements[key] - totals[key])]));
      target = rows.filter((row) => !built.has(row.id) && numerical(row) && !missing(row)).map((row) => ({
        row,
        score: keys.reduce((sum, key) => sum + Math.min(deficit[key], Math.max(0, row.bonuses[key])) * 100
          + Math.max(0, row.bonuses[key]) * 3 - Math.abs(Math.min(0, row.bonuses[key])) * 200, 0) - row.developmentStage
      })).sort((a, b) => b.score - a.score || a.row.developmentStage - b.row.developmentStage || a.row.id.localeCompare(b.row.id))[0]?.row;
      assert.ok(target, "No numerically reachable support building");
    }
    assert.ok(numerical(target) && !missing(target));
    built.add(target.id);
    order.push(target.id);
    for (const key of keys) totals[key] += target.bonuses[key];
  }
  return { order, totals };
}

export function checkPreparationRevision() {
  const rows = preparationTemplates();
  assert.equal(rows.length, 119);
  assert.equal(new Set(rows.map((row) => row.id)).size, 119);
  const totals = Object.fromEntries(keys.map((key) => [key, rows.reduce((sum, row) => sum + row.bonuses[key], 0)]));
  assert.deepEqual(totals, vector("104/164/149/113"));
  const routes = rows.map((row) => ({ id: row.id, ...preparationRoute(rows, [row.id]) }));
  assert.ok(routes.every((route) => route.order.length <= 60), "A target requires more than half the catalog");
  const house = routes.find((route) => route.id === "meeting-house");
  const opening = preparationRoute(rows, ["meeting-house", "shrine"]);
  assert.ok(opening.totals.culture >= 16, "The Politics opening route must reach its separate culture threshold");
  // The founding route can add culture support as needed, never assuming the
  // new building alone meets the separate Politics threshold.
  const report = {
    buildings: rows.length, totals, dependenciesAdded: rows.reduce((sum, row) => sum + row.proposalDependencies.length, 0),
    maximumRoute: Math.max(...routes.map((route) => route.order.length)),
    houseRoute: house, houseAndShrineRoute: opening,
    routes: routes.map((route) => ({ id: route.id, buildings: route.order.length, order: route.order }))
  };
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const report = checkPreparationRevision();
  const output = process.argv.indexOf("--output");
  if (output >= 0) writeFileSync(process.argv[output + 1], JSON.stringify(report, null, 2));
  console.log(`Preparation revision: ${report.buildings} templates; F104/T164/C149/W113; ${report.dependenciesAdded} new prerequisites; every target reachable within ${report.maximumRoute} buildings.`);
  console.log(`Meeting House route: ${report.houseRoute.order.length} buildings; development ${JSON.stringify(report.houseRoute.totals)}.`);
}
