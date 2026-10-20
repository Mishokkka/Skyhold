import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { preparationTemplates } from "./building-preparation-revision-check.mjs";

// Preparation-only data: no runtime catalog or saved building is modified.
export function preparationMaintenanceNorms() {
  const source = readFileSync(new URL("../../docs/building-maintenance-proposal.md", import.meta.url), "utf8");
  const templates = preparationTemplates();
  const byName = new Map(templates.map((row) => [row.name, row.id]));
  const norms = new Map(templates.map((row) => [row.id, 0]));
  const seen = new Set();
  for (const match of source.matchAll(/^\| ([123]) \| ([^|]+) \|/gm)) {
    for (const name of match[2].split(";").map((value) => value.trim())) {
      const id = byName.get(name);
      assert.ok(id, `Unknown technical building: ${name}`);
      assert.ok(!seen.has(id), `Duplicate technical building: ${name}`);
      seen.add(id);
      norms.set(id, Number(match[1]));
    }
  }
  assert.equal(seen.size, 19);
  assert.equal([...norms.values()].filter((qd) => qd === 0).length, 100);
  assert.equal(norms.get("meeting-house"), 0);
  return norms;
}

export function preparationMaintenanceTasks(buildings, activeIds) {
  const norms = preparationMaintenanceNorms();
  return buildings.filter((building) => activeIds.has(building.id))
    .map((building) => ({ source: building.id, functionId: "maintenance", qd: norms.get(building.templateId ?? building.id) ?? 0, wage: 18 }))
    .filter((task) => task.qd > 0);
}

export function checkMaintenanceProposal() {
  const buildings = [
    { id: "mill-a", templateId: "mill" }, { id: "mill-b", templateId: "mill" },
    { id: "idle-mine", templateId: "mine" }, { id: "home", templateId: "common-house" }
  ];
  const tasks = preparationMaintenanceTasks(buildings, new Set(["mill-a", "mill-b", "home"]));
  assert.deepEqual(tasks.map((row) => [row.source, row.qd]), [["mill-a", 1], ["mill-b", 1]]);
  assert.equal(tasks.reduce((sum, task) => sum + task.qd * task.wage / 2, 0), 18);
  assert.deepEqual(preparationMaintenanceTasks(buildings, new Set()), []);
  return { technicalTemplates: 19, ordinaryTemplates: 100, totalNormQd: [...preparationMaintenanceNorms().values()].reduce((a, b) => a + b, 0) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(checkMaintenanceProposal()));
