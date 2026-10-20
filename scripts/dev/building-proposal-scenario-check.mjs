import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { proposedArrivalOdds } from "./newcomer-arrival-proposal-check.mjs";

// Keep the historical proposal scenario tied to its v14 prerequisites.
import { BUILDING_CATALOG_V14_TEMPLATES as DEFAULT_BUILDING_TEMPLATES } from "../data/building-template-v14-catalog.js";

const source = readFileSync(new URL("../../docs/building-development-tree-proposal.md", import.meta.url), "utf8");
const reputationStart = source.indexOf("## Утверждённый проект репутации и довольства");
const reputationEnd = source.indexOf("## Сюжетные шаблоны вне дерева", reputationStart);
assert.notEqual(reputationStart, -1, "reputation and morale proposal must exist");
assert.notEqual(reputationEnd, -1, "reputation and morale proposal boundary must exist");

const effectRows = [...source.slice(reputationStart, reputationEnd).matchAll(/^\| ([^|]+) \| `([+-]?\d+)\/([+-]?\d+)\/([+-]?\d+)` \|/gm)]
  .map((match) => ({
    name: match[1].trim(),
    reputation: Number(match[2]),
    globalMorale: Number(match[3]),
    workerMorale: Number(match[4])
  }));
const effectsByName = new Map(effectRows.map((row) => [row.name, row]));
assert.equal(effectsByName.size, 118, "scenario checks require all 118 approved project buildings");

const DEV_KEYS = ["food", "technology", "culture", "war"];
const STAGE_NUMBER = Object.freeze({ "0": 0, I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7 });
const treeStart = source.indexOf("## Этап 0 — Основание");
const treeEnd = source.indexOf("## Норматив стоимости строительства", treeStart);
assert.notEqual(treeStart, -1, "development tree must exist");
assert.notEqual(treeEnd, -1, "development tree boundary must exist");

function vector(value) {
  const match = String(value ?? "").replaceAll("`", "").trim().match(/^-?\d+\/-?\d+\/-?\d+\/-?\d+$/);
  return match ? match[0].split("/").map(Number) : null;
}

const developmentRows = [];
let currentStage = 0;
for (const line of source.slice(treeStart, treeEnd).split(/\r?\n/)) {
  const heading = line.match(/^## Этап (VII|VI|IV|V|III|II|I|0)\b/);
  if (heading) currentStage = STAGE_NUMBER[heading[1]];
  if (!line.startsWith("|")) continue;
  const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
  if (cells.length < 2 || cells[0] === "Шаблон" || cells[0].startsWith("---")) continue;
  const vectors = cells.slice(1).map(vector).filter(Boolean);
  if (!vectors.length) continue;
  const requirements = vectors.length === 1 ? [0, 0, 0, 0] : vectors[0];
  const bonuses = vectors.at(-1);
  developmentRows.push({
    name: cells[0],
    stage: currentStage,
    requirements: Object.fromEntries(DEV_KEYS.map((key, index) => [key, requirements[index]])),
    bonuses: Object.fromEntries(DEV_KEYS.map((key, index) => [key, bonuses[index]]))
  });
}
assert.equal(developmentRows.length, 118, "scenario checks require the complete approved project development tree");
const developmentByName = new Map(developmentRows.map((row) => [row.name, row]));
const PROJECT_NAME_BY_RUNTIME_ID = Object.freeze({
  "grain-field": "Полевое хозяйство",
  portcullis: "Решётка"
});
const projectNameForRuntime = (template) => PROJECT_NAME_BY_RUNTIME_ID[template.id] ?? template.name;
const runtimeNameById = new Map(DEFAULT_BUILDING_TEMPLATES.map((template) => [template.id, projectNameForRuntime(template)]));
const requiredAllByName = new Map();
const requiredAnyByName = new Map();
for (const template of DEFAULT_BUILDING_TEMPLATES) {
  const name = projectNameForRuntime(template);
  if (!developmentByName.has(name)) continue;
  const requiredAll = (template.requiredBuildingIds ?? []).map((id) => runtimeNameById.get(id));
  const requiredAny = (template.requiredAnyBuildingIds ?? []).map((id) => runtimeNameById.get(id));
  for (const dependency of [...requiredAll, ...requiredAny]) {
    assert.ok(dependency, `${name}: runtime prerequisite must resolve to a known template`);
    assert.ok(developmentByName.has(dependency), `${name}: runtime prerequisite ${dependency} must exist in the approved project`);
    assert.notEqual(dependency, name, `${name}: a building cannot require itself`);
  }
  requiredAllByName.set(name, requiredAll);
  requiredAnyByName.set(name, requiredAny);
}
requiredAnyByName.set("Благоустроенный дом", ["Колодец", "Водопроводная станция"]);
requiredAllByName.set("Особняк", ["Благоустроенный дом"]);
requiredAllByName.set("Караульный дом", ["Пост шерифа"]);
requiredAllByName.set("Участок охраны", ["Караульный дом"]);
requiredAnyByName.set("Участок охраны", ["Управление кадров", "Ратуша"]);
requiredAllByName.set("Суд", ["Ратуша", "Участок охраны"]);
requiredAllByName.set("Элеватор", ["Мельница", "Амбар"]);
requiredAllByName.set("Штаб ополчения", ["Казарма"]);
requiredAnyByName.set("Штаб ополчения", ["Стрельбище", "Тренировочный лагерь"]);
requiredAnyByName.set("Оросительная система", ["Колодец", "Водопроводная станция"]);
requiredAllByName.set("Продовольственный распределительный центр", ["Рынок"]);
requiredAnyByName.set("Продовольственный распределительный центр", ["Амбар", "Охраняемый склад"]);
requiredAllByName.set("Тепличный комплекс", ["Стекольная мастерская", "Водопроводная станция"]);
requiredAllByName.set("Гарнизонное управление", ["Штаб ополчения", "Телеграфная станция"]);
requiredAllByName.set("Агрономический институт", ["Тепличный комплекс"]);
requiredAnyByName.set("Агрономический институт", ["Университет", "Библиотека"]);
requiredAllByName.set("Главный штаб", ["Гарнизонное управление", "Военная академия", "Телеграфная станция"]);

for (const [owner, dependencies] of [...requiredAllByName, ...requiredAnyByName]) {
  assert.ok(developmentByName.has(owner), `dependency owner ${owner} must exist in the approved project`);
  for (const dependency of dependencies) {
    assert.ok(developmentByName.has(dependency), `${owner}: prerequisite ${dependency} must exist in the approved project`);
    assert.notEqual(dependency, owner, `${owner}: a building cannot require itself`);
  }
}

function uniqueNames(values) {
  return [...new Set(values.filter(Boolean))];
}

function requiredAll(row) {
  return uniqueNames([...(row.stage >= 4 ? ["Центр Строительства"] : []), ...(requiredAllByName.get(row.name) ?? [])]);
}

function dependenciesMet(row, built) {
  const allMet = requiredAll(row).every((name) => built.has(name));
  const any = requiredAnyByName.get(row.name) ?? [];
  return allMet && (any.length === 0 || any.some((name) => built.has(name)));
}

function nextMissingDependency(row, built) {
  const missingAll = requiredAll(row).find((name) => !built.has(name));
  if (missingAll) return missingAll;
  const any = requiredAnyByName.get(row.name) ?? [];
  if (any.length && !any.some((name) => built.has(name))) return any[0];
  return "";
}

function requirementsMet(row, totals) {
  return DEV_KEYS.every((key) => totals[key] >= row.requirements[key]);
}

function validateConstructionRoute(order, scenarioName) {
  const totals = Object.fromEntries(DEV_KEYS.map((key) => [key, 0]));
  const built = new Set();
  for (const [index, name] of order.entries()) {
    const row = developmentByName.get(name);
    assert.ok(row, `${scenarioName}: unknown development building ${name}`);
    assert.equal(built.has(name), false, `${scenarioName}: repeated development template ${name}`);
    assert.equal(requirementsMet(row, totals), true, `${scenarioName}: ${name} is unavailable at step ${index + 1}; totals ${JSON.stringify(totals)}, requirements ${JSON.stringify(row.requirements)}`);
    assert.equal(dependenciesMet(row, built), true, `${scenarioName}: ${name} is missing a mandatory or alternative building dependency at step ${index + 1}`);
    built.add(name);
    for (const key of DEV_KEYS) totals[key] += row.bonuses[key];
  }
  return { totals, built };
}

function planConstructionRoute(targetNames) {
  const targets = targetNames.map((name) => {
    const row = developmentByName.get(name);
    assert.ok(row, `unknown route target ${name}`);
    return row;
  });
  const totals = Object.fromEntries(DEV_KEYS.map((key) => [key, 0]));
  const built = new Set();
  const order = [];
  const build = (row) => {
    built.add(row.name);
    order.push(row.name);
    for (const key of DEV_KEYS) totals[key] += row.bonuses[key];
  };
  let guard = 0;
  while (targets.some((row) => !built.has(row.name))) {
    assert.ok(++guard <= developmentRows.length, `route planner stalled at ${JSON.stringify(totals)}`);
    let target = targets.find((row) => !built.has(row.name));
    let dependencyGuard = 0;
    while (nextMissingDependency(target, built)) {
      assert.ok(++dependencyGuard <= developmentRows.length, `dependency chain stalled for ${target.name}`);
      const prerequisiteName = nextMissingDependency(target, built);
      target = developmentByName.get(prerequisiteName);
      assert.ok(target, `unknown required building ${prerequisiteName}`);
    }
    const targetAvailable = requirementsMet(target, totals) && dependenciesMet(target, built);
    if (targetAvailable) {
      build(target);
      continue;
    }
    const deficit = Object.fromEntries(DEV_KEYS.map((key) => [key, Math.max(0, target.requirements[key] - totals[key])]));
    const available = developmentRows.filter((row) => !built.has(row.name)
      && requirementsMet(row, totals)
      && dependenciesMet(row, built));
    const support = available.map((row) => {
      const direct = DEV_KEYS.reduce((sum, key) => sum + Math.min(deficit[key], Math.max(0, row.bonuses[key])), 0);
      const total = DEV_KEYS.reduce((sum, key) => sum + Math.max(0, row.bonuses[key]), 0);
      const negative = DEV_KEYS.reduce((sum, key) => sum + Math.abs(Math.min(0, row.bonuses[key])), 0);
      return { row, score: direct * 100 + total * 3 - negative * 200 - row.stage };
    }).sort((left, right) => right.score - left.score
      || left.row.stage - right.row.stage
      || left.row.name.localeCompare(right.row.name, "ru"))[0]?.row;
    assert.ok(support, `no available support building for ${target.name} at ${JSON.stringify(totals)}`);
    build(support);
  }
  validateConstructionRoute(order, `route to ${targetNames.at(-1)}`);
  return order;
}

function residentLayer(count, ration, housing, workConditions = 0, pay = 0, overtime = 0) {
  return { count, ration, housing, workConditions, pay, overtime };
}

const reachabilityRoutes = new Map(developmentRows.map((row) => [row.name, planConstructionRoute([row.name])]));
assert.equal(reachabilityRoutes.size, 118, "every approved project template needs a real construction route");
assert.equal([...reachabilityRoutes.values()].every((route) => route.length <= 60), true, "no single target may require more than half of the 118-template catalog");
for (const name of ["Элеватор", "Штаб ополчения", "Оросительная система", "Продовольственный распределительный центр", "Тепличный комплекс", "Гарнизонное управление", "Агрономический институт", "Главный штаб"]) {
  assert.ok(reachabilityRoutes.get(name)?.includes(name), `${name} must have a validated dependency-aware route`);
}

function scenario({ id, name, targets, residentLayers, expectation }) {
  const residents = residentLayers.reduce((sum, row) => sum + row.count, 0);
  for (const row of residentLayers) {
    assert.ok(Number.isInteger(row.count) && row.count > 0, `${name}: resident cohorts need a positive whole count`);
    assert.ok(row.ration >= -2 && row.ration <= 1, `${name}: ration effect must use the approved range`);
    assert.ok(row.housing >= -2 && row.housing <= 2, `${name}: housing effect must use the approved range`);
    assert.ok(row.pay >= -2 && row.pay <= 2, `${name}: pay effect must use the approved range`);
    assert.ok(row.overtime >= -2 && row.overtime <= 0, `${name}: overtime effect must use the approved range`);
    const combinedWork = row.workConditions + row.pay + row.overtime;
    assert.ok(combinedWork >= -3 && combinedWork <= 3, `${name}: work, pay and overtime cohort exceeds the approved personal cap`);
  }
  const sumLayer = (key) => residentLayers.reduce((sum, row) => sum + row.count * row[key], 0);
  return Object.freeze({
    id,
    name,
    targets: Object.freeze([...targets]),
    residents,
    residentLayers: Object.freeze(residentLayers.map(Object.freeze)),
    buildings: Object.freeze(planConstructionRoute(targets)),
    foodMorale: sumLayer("ration"),
    housingMorale: sumLayer("housing"),
    workMorale: sumLayer("workConditions") + sumLayer("overtime"),
    payMorale: sumLayer("pay"),
    expectation
  });
}

const EARLY_TARGETS = ["Колодец", "Кладбище", "Общий дом", "Пирс", "Рынок", "Школа", "Пекарня", "Трактир", "Баня", "Святилище", "Лазарет"];
const INDUSTRIAL_TARGETS = ["Колодец", "Кладбище", "Рынок", "Школа", "Пекарня", "Трактир", "Баня", "Святилище", "Лазарет", "Водопроводная станция", "Пожарное депо", "Канализация", "Ратуша", "Больница", "Телеграфная станция", "Типография", "Железнодорожное депо", "Машиностроительный цех", "Химический завод", "Металлургический завод"];

export const BUILDING_PROPOSAL_SCENARIOS = Object.freeze([
  scenario({
    id: "poor-foundation",
    name: "Бедное основание",
    targets: ["Колодец", "Палаточный лагерь", "Кладбище", "Лесоповал", "Каменоломня", "Сторожевой пост"],
    residentLayers: [
      residentLayer(6, -1, -2, -1, 0, 0),
      residentLayer(2, -1, -2, 0, 0, 0)
    ],
    expectation: "Бунты: восемь реальных личных слоёв палаток, скудного рациона и тяжёлой работы не компенсируются водой и кладбищем."
  }),
  scenario({
    id: "cared-early-town",
    name: "Ухоженное раннее поселение",
    targets: EARLY_TARGETS,
    residentLayers: [
      residentLayer(6, 0, 0, 0, 0, 0),
      residentLayer(3, 1, 0, 0, 0, 0),
      residentLayer(3, 0, 0, -1, 0, 0)
    ],
    expectation: "Нейтрально: маршрут действительно строится от основания, а улучшенный рацион и общественные службы покрывают потребности двенадцати жителей."
  }),
  scenario({
    id: "supported-industrial-city",
    name: "Поддержанный промышленный город",
    targets: INDUSTRIAL_TARGETS,
    residentLayers: [
      residentLayer(20, 0, 1, -1, 1, 0),
      residentLayer(10, 0, 0, -2, 1, 0),
      residentLayer(10, 1, 0, 0, 0, 0)
    ],
    expectation: "Нейтрально: полный валидный промышленный маршрут, комфорт половины жителей, питание и повышенная оплата удерживают тяжёлый город у нуля."
  }),
  scenario({
    id: "industrial-crisis",
    name: "Промышленный кризис",
    targets: INDUSTRIAL_TARGETS,
    residentLayers: [
      residentLayer(20, -1, 0, -1, -2, 0),
      residentLayer(20, 0, -1, -2, -1, 0)
    ],
    expectation: "Бунты: тот же реально достижимый город не скрывает массовый скудный рацион, тесное жильё, опасный труд и невыплаты."
  }),
  scenario({
    id: "citadel-city",
    name: "Город на пути к Цитадели",
    targets: ["Колодец", "Кладбище", "Школа", "Цитадель"],
    residentLayers: [
      residentLayer(30, 0, 1, -1, 1, 0),
      residentLayer(10, 0, 0, -1, 1, 0),
      residentLayer(20, 1, 0, 0, 0, 0)
    ],
    expectation: "Нейтрально: Цитадель достигается валидной смешанной цепочкой, а Репутация остаётся в диапазоне регионального центра, не требуя полного каталога."
  })
]);

function moraleState(value) {
  if (value < -30) return "Бунты";
  if (value <= -15) return "Недовольство";
  if (value < 0) return "Апатия";
  if (value <= 15) return "Нейтрально";
  if (value <= 30) return "Надежда";
  return "Дом";
}

export function evaluateBuildingProposalScenario(scenarioRow) {
  const route = validateConstructionRoute(scenarioRow.buildings, scenarioRow.name);
  for (const target of scenarioRow.targets) assert.equal(route.built.has(target), true, `${scenarioRow.name}: route lost target ${target}`);
  const buildingRows = scenarioRow.buildings.map((name) => {
    const row = effectsByName.get(name);
    assert.ok(row, `${scenarioRow.name}: unknown building ${name}`);
    return row;
  });
  const reputation = buildingRows.reduce((sum, row) => sum + row.reputation, 0);
  const buildingMorale = buildingRows.reduce((sum, row) => sum + row.globalMorale, 0);
  const baseMorale = -scenarioRow.residents;
  const rawMorale = baseMorale
    + scenarioRow.foodMorale
    + scenarioRow.housingMorale
    + scenarioRow.workMorale
    + scenarioRow.payMorale
    + buildingMorale;
  return {
    ...scenarioRow,
    developmentTotals: route.totals,
    buildingCount: buildingRows.length,
    baseMorale,
    buildingMorale,
    rawMorale,
    moraleState: moraleState(rawMorale),
    reputation,
    chanceAtLeastOneEvent: reputation ? 1 - (5 / 6) ** reputation : 0,
    expectedExternalEvents: reputation / 6,
    // This route model has no completed food/wage/housing snapshot. Report
    // the ordinary candidate expectation, not automatic resident acceptance.
    proposedArrivalOrdinary: proposedArrivalOdds(reputation)
  };
}

export const BUILDING_PROPOSAL_SCENARIO_RESULTS = Object.freeze(BUILDING_PROPOSAL_SCENARIOS.map(evaluateBuildingProposalScenario));
const byId = new Map(BUILDING_PROPOSAL_SCENARIO_RESULTS.map((row) => [row.id, row]));
const courtDependencyRoute = planConstructionRoute(["Суд"]);
const mansionDependencyRoute = planConstructionRoute(["Особняк"]);
const before = (route, prerequisite, target) => route.indexOf(prerequisite) >= 0 && route.indexOf(prerequisite) < route.indexOf(target);

assert.deepEqual(BUILDING_PROPOSAL_SCENARIO_RESULTS.map((row) => row.buildingCount), [6, 17, 44, 44, 55], "route sizes must stay explicit and reviewable after the 150-point rebalance");
for (const [prerequisite, target] of [["Пост шерифа", "Караульный дом"], ["Караульный дом", "Участок охраны"], ["Центр Строительства", "Участок охраны"], ["Ратуша", "Суд"], ["Участок охраны", "Суд"]]) {
  assert.equal(before(courtDependencyRoute, prerequisite, target), true, `${prerequisite} must precede ${target} in a real Court route`);
}
assert.equal(["Управление кадров", "Ратуша"].some((name) => before(courtDependencyRoute, name, "Участок охраны")), true, "the Guard Precinct needs one approved administrative alternative");
assert.equal(before(mansionDependencyRoute, "Благоустроенный дом", "Особняк"), true, "a Comfortable House must precede a Mansion");
assert.equal(["Колодец", "Водопроводная станция"].some((name) => before(mansionDependencyRoute, name, "Благоустроенный дом")), true, "a Comfortable House needs an approved water source");
assert.equal(byId.get("poor-foundation").buildings.indexOf("Палаточный лагерь") < byId.get("poor-foundation").buildings.indexOf("Кладбище"), true, "a tent camp must no longer deadlock later zero-requirement foundation buildings");
assert.equal(byId.get("poor-foundation").moraleState, "Бунты");
assert.equal(byId.get("cared-early-town").moraleState, "Нейтрально");
assert.equal(byId.get("supported-industrial-city").moraleState, "Нейтрально");
assert.equal(byId.get("industrial-crisis").moraleState, "Бунты");
assert.equal(byId.get("citadel-city").moraleState, "Нейтрально");
assert.equal(byId.get("supported-industrial-city").reputation <= 18, true, "industrial control route must stay within the proposed reputation ceiling");
assert.equal(byId.get("citadel-city").reputation >= 14 && byId.get("citadel-city").reputation <= 18, true, "Citadel route must remain within the regional-center reputation range");
assert.equal(byId.get("citadel-city").developmentTotals.war >= 110, true, "Citadel route must genuinely satisfy the 110 War requirement");

console.log("FBL Skyhold building proposal scenarios passed:");
for (const row of BUILDING_PROPOSAL_SCENARIO_RESULTS) {
  console.log(`- ${row.name}: ${row.buildingCount} valid construction steps, morale ${row.rawMorale} (${row.moraleState}), reputation ${row.reputation}, expected events ${row.expectedExternalEvents.toFixed(2)}.`);
}
