import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_BUILDING_TEMPLATES, TEMPLATE_CATALOG_VERSION } from "../data/building-templates.js";
import { buildingRequiresConstructionCenter } from "../data/building-development-tree.js";
import { normalizeBuilding } from "../data/normalizers/building.js";

const KEYS = ["food", "technology", "culture", "war"];
const vector = (value = {}) => KEYS.map((key) => value[key] ?? 0).join("/");
const parseVector = (text) => Object.fromEntries(KEYS.map((key, index) => [key, Number(text.split("/")[index])]));

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

/** Verifies unified catalog templates carry v2 labor contracts and strip legacy maintenance on load. */
export function checkTechnicalMaintenanceNorms() {
  for (const template of DEFAULT_BUILDING_TEMPLATES) {
    assert.equal(template.labor?.version, 2, `${template.id}: missing v2 labor`);
    const loaded = structuredClone(template);
    normalizeBuilding(loaded);
    assert.equal(Object.hasOwn(loaded, "maintenance"), false, `${template.id}: normalized buildings must omit maintenance`);
  }
  return { technicalTemplates: 0, ordinaryTemplates: DEFAULT_BUILDING_TEMPLATES.length, totalNormQd: 0 };
}

/** Formats a human-readable unlock route for one target building (by ID or exact Russian name). */
export function formatBuildingDevelopmentRoute(rows, query) {
  const normalized = String(query ?? "").trim().toLowerCase();
  const target = rows.find((row) => row.id.toLowerCase() === normalized || String(row.name ?? "").trim().toLowerCase() === normalized);
  if (!target) {
    throw new Error(`Unknown ordinary building template: "${query}". Pass a template ID (e.g. forge, town-hall) or exact name.`);
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  const route = buildingDevelopmentRoute(rows, [target.id]);
  const totals = parseVector("0/0/0/0");
  const lines = [
    `${target.name} (${target.id}) · этап ${target.developmentStage} · треб. ${vector(target.requirements)} · шагов: ${route.order.length}`
  ];
  route.order.forEach((id, index) => {
    const step = byId.get(id);
    for (const key of KEYS) totals[key] += rowBonus(step, key);
    lines.push(`${String(index + 1).padStart(2, " ")}. ${step.name} [${step.id}] (эт. ${step.developmentStage}) +${vector(step.bonuses)} → ${vector(totals)}`);
  });
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const routeFlagIndex = process.argv.indexOf("--route");
  if (routeFlagIndex !== -1) {
    const query = process.argv.slice(routeFlagIndex + 1).join(" ").trim();
    if (!query) {
      console.error("Usage: node scripts/dev/building-development-reachability-check.mjs --route <building-id|name>");
      process.exit(1);
    }
    const ordinary = DEFAULT_BUILDING_TEMPLATES.filter((row) => Number.isInteger(row.developmentStage));
    console.log(formatBuildingDevelopmentRoute(ordinary, query));
  } else {
    const reachability = checkBuildingDevelopmentReachability();
    const maintenance = checkTechnicalMaintenanceNorms();
    console.log(`Development reachability v${reachability.version}: ${reachability.count}/124, ${reachability.waves} waves, max route ${reachability.maximumRoute}, totals ${reachability.totals}; technical maintenance ${maintenance.technicalTemplates} templates (${maintenance.totalNormQd} QD).`);
  }
}
