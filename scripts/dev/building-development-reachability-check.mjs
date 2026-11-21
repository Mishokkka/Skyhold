import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_BUILDING_TEMPLATES, TEMPLATE_CATALOG_VERSION } from "../data/building-templates.js";
import { buildingRequiresConstructionCenter } from "../data/building-development-tree.js";
import { usesTechnicalMaintenance } from "../data/economy/maintenance.js";

const KEYS = ["food", "technology", "culture", "war"];
const vector = (value = {}) => KEYS.map((key) => value[key] ?? 0).join("/");
const parseVector = (text) => Object.fromEntries(KEYS.map((key, index) => [key, Number(text.split("/")[index])]));

/** Explicit selective technical maintenance norms (QD per instance per tenday) for the 19 technical buildings. */
export const TECHNICAL_MAINTENANCE_NORM_QD = Object.freeze(new Map([
  ["mill", 1],
  ["grain-elevator", 1],
  ["irrigation-system", 1],
  ["lighthouse", 1],
  ["telegraph-station", 1],
  ["industrial-icehouse", 1],
  ["cannery", 1],
  ["greenhouse-complex", 1],
  ["mine", 2],
  ["waterworks", 2],
  ["sewer-system", 2],
  ["gasworks", 2],
  ["railway-depot", 2],
  ["machine-works", 2],
  ["chemical-plant", 2],
  ["steelworks", 3],
  ["military-factory", 3],
  ["high-tech-components-plant", 3],
  ["airship-yard", 3]
]));

function isTemplateAvailable(row, built, totals) {
  return KEYS.every((key) => totals[key] >= (row.requirements?.[key] ?? 0))
    && (!buildingRequiresConstructionCenter(row) || built.has("construction-center"))
    && (row.requiredBuildingIds ?? []).every((id) => built.has(id))
    && (!(row.requiredAnyBuildingIds ?? []).length || row.requiredAnyBuildingIds.some((id) => built.has(id)));
}

/** Heuristic support-route builder verifying structural reachability for a list of target building IDs. */
export function buildingDevelopmentRoute(rows, targetIds) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const totals = parseVector("0/0/0/0");
  const built = new Set();
  const order = [];
  const groups = (row) => [
    ...(row.requiredBuildingIds ?? []).map((id) => [id]),
    ...((row.requiredAnyBuildingIds ?? []).length ? [row.requiredAnyBuildingIds] : []),
    ...(buildingRequiresConstructionCenter(row) ? [["construction-center"]] : []),
    ...(row.proposalDependencies ?? []).map((entry) => entry.choices)
  ];
  const missing = (row) => groups(row).find((group) => !group.some((id) => built.has(id)));
  const numerical = (row) => KEYS.every((key) => totals[key] >= (row.requirements?.[key] ?? 0));
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
      const deficit = Object.fromEntries(KEYS.map((key) => [key, Math.max(0, (target.requirements?.[key] ?? 0) - totals[key])]));
      target = rows
        .filter((row) => !built.has(row.id) && numerical(row) && !missing(row))
        .map((row) => ({
          row,
          score: KEYS.reduce((sum, key) => sum
            + Math.min(deficit[key], Math.max(0, row.bonuses?.[key] ?? 0)) * 100
            + Math.max(0, row.bonuses?.[key] ?? 0) * 3
            - Math.abs(Math.min(0, row.bonuses?.[key] ?? 0)) * 200, 0) - (row.developmentStage ?? 0)
        }))
        .sort((a, b) => b.score - a.score || (a.row.developmentStage ?? 0) - (b.row.developmentStage ?? 0) || a.row.id.localeCompare(b.row.id))[0]?.row;
      assert.ok(target, "No numerically reachable support building");
    }
    assert.ok(numerical(target) && !missing(target));
    built.add(target.id);
    order.push(target.id);
    for (const key of KEYS) totals[key] += rowBonus(target, key);
  }
  return { order, totals };
}

function rowBonus(row, key) {
  return Number(row?.bonuses?.[key] ?? 0);
}

/** Verifies structural reachability, wave unlock order, and Politics opening route for the current runtime catalog. */
export function checkBuildingDevelopmentReachability() {
  const rows = DEFAULT_BUILDING_TEMPLATES.filter((row) => Number.isInteger(row.developmentStage));
  assert.equal(rows.length, 124, "Current development tree must contain 124 ordinary templates");
  assert.equal(new Set(rows.map((row) => row.id)).size, 124);

  const built = new Set();
  const totals = parseVector("0/0/0/0");
  const waves = [];
  while (built.size < rows.length) {
    const next = rows.filter((row) => !built.has(row.id) && isTemplateAvailable(row, built, totals));
    assert.ok(next.length, `Deadlock: ${rows.filter((r) => !built.has(r.id)).map((r) => r.id).join(", ")}`);
    waves.push({ before: { ...totals }, count: next.length });
    for (const row of next) {
      built.add(row.id);
      for (const key of KEYS) totals[key] += rowBonus(row, key);
    }
  }
  assert.deepEqual(totals, parseVector("102/164/149/113"), "Current catalog development totals must match v19");

  let maximumRoute = 0;
  for (const row of rows) {
    const route = buildingDevelopmentRoute(rows, [row.id]);
    const selected = new Set();
    const scores = parseVector("0/0/0/0");
    for (const id of route.order) {
      const step = rows.find((r) => r.id === id);
      assert.ok(!selected.has(id) && isTemplateAvailable(step, selected, scores), `${row.id}: invalid step ${id}`);
      selected.add(id);
      for (const key of KEYS) scores[key] += rowBonus(step, key);
    }
    assert.equal(route.order.at(-1), row.id);
    assert.ok(route.order.length <= 60, `${row.id}: excessive support route (${route.order.length})`);
    if (route.order.length > maximumRoute) maximumRoute = route.order.length;
  }

  const opening = buildingDevelopmentRoute(rows, ["meeting-house", "shrine"]);
  assert.ok(opening.totals.culture >= 16, "The Politics opening route must reach its separate culture threshold");
  return { version: TEMPLATE_CATALOG_VERSION, count: rows.length, waves: waves.length, maximumRoute, totals: vector(totals) };
}

/** Verifies selective technical maintenance norms (v2 QD) across the current runtime catalog. */
export function checkTechnicalMaintenanceNorms() {
  assert.equal(TECHNICAL_MAINTENANCE_NORM_QD.size, 19);
  const byId = new Map(DEFAULT_BUILDING_TEMPLATES.map((row) => [row.id, row]));
  for (const [id, expectedQd] of TECHNICAL_MAINTENANCE_NORM_QD) {
    const template = byId.get(id);
    assert.ok(template, `Missing technical maintenance template: ${id}`);
    assert.equal(usesTechnicalMaintenance(template), true, `${id}: must use v2 technical maintenance`);
    assert.equal(template.maintenance?.requiredPoints, expectedQd, `${id}: technical maintenance QD mismatch`);
  }
  let nonTechnicalCount = 0;
  for (const template of DEFAULT_BUILDING_TEMPLATES) {
    if (TECHNICAL_MAINTENANCE_NORM_QD.has(template.id)) continue;
    assert.equal(template.maintenance?.requiredPoints ?? 0, 0, `${template.id}: ordinary template must have 0 technical QD`);
    nonTechnicalCount += 1;
  }
  assert.equal(byId.get("meeting-house")?.maintenance?.requiredPoints, 0);
  const totalNormQd = [...TECHNICAL_MAINTENANCE_NORM_QD.values()].reduce((sum, qd) => sum + qd, 0);
  return { technicalTemplates: TECHNICAL_MAINTENANCE_NORM_QD.size, ordinaryTemplates: nonTechnicalCount, totalNormQd };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const reachability = checkBuildingDevelopmentReachability();
  const maintenance = checkTechnicalMaintenanceNorms();
  console.log(`Development reachability v${reachability.version}: ${reachability.count}/124, ${reachability.waves} waves, max route ${reachability.maximumRoute}, totals ${reachability.totals}; technical maintenance ${maintenance.technicalTemplates} templates (${maintenance.totalNormQd} QD).`);
}
