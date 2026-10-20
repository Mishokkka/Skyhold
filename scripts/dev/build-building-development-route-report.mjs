import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_BUILDING_TEMPLATES } from "../data/building-templates.js";
import { buildingRequiresConstructionCenter } from "../data/building-development-tree.js";
import { preparationRoute } from "./building-preparation-revision-check.mjs";
import { buildingCatalogV15Templates } from "../data/building-template-revision-v15.js";

const keys = ["food", "technology", "culture", "war"];
const vector = (value) => keys.map((key) => value[key] ?? 0).join("/");
const parse = (value) => Object.fromEntries(keys.map((key, index) => [key, Number(value.split("/")[index])]));
const current = DEFAULT_BUILDING_TEMPLATES.filter((row) => Number.isInteger(row.developmentStage));
const before = buildingCatalogV15Templates().filter((row) => Number.isInteger(row.developmentStage));

function available(row, built, total) {
  return keys.every((key) => total[key] >= row.requirements[key])
    && (!buildingRequiresConstructionCenter(row) || built.has("construction-center"))
    && (row.requiredBuildingIds ?? []).every((id) => built.has(id))
    && (!(row.requiredAnyBuildingIds ?? []).length || row.requiredAnyBuildingIds.some((id) => built.has(id)));
}
function analyze(rows) {
  const built = new Set(), totals = parse("0/0/0/0"), waves = [];
  while (built.size < rows.length) {
    const next = rows.filter((row) => !built.has(row.id) && available(row, built, totals));
    assert.ok(next.length, `Deadlock: ${rows.filter((r) => !built.has(r.id)).map((r) => r.id).join(", ")}`);
    waves.push({ before: { ...totals }, rows: next });
    for (const row of next) { built.add(row.id); for (const key of keys) totals[key] += row.bonuses[key]; }
  }
  const routes = new Map(rows.map((row) => {
    const route = preparationRoute(rows, [row.id]);
    const selected = new Set(), scores = parse("0/0/0/0");
    for (const id of route.order) {
      const step = rows.find((r) => r.id === id);
      assert.ok(!selected.has(id) && available(step, selected, scores), `${row.id}: invalid step ${id}`);
      selected.add(id); for (const key of keys) scores[key] += step.bonuses[key];
    }
    assert.equal(route.order.at(-1), row.id);
    assert.ok(route.order.length <= 60, `${row.id}: excessive support route`);
    return [row.id, route];
  }));
  return { waves, routes, totals, maximum: Math.max(...[...routes.values()].map((r) => r.order.length)) };
}
const old = analyze(before), next = analyze(current);
let text = `# Достижимость после утверждённых изменений развития\n\nДата проверки: 2026-09-14. Сравнение исторического каталога v15 с действующим v16; изменения досуга описаны в [правилах v16](morale-v16-implementation.md). Отчёт воспроизводится командой \`node scripts/dev/build-building-development-route-report.mjs\`; \`--check\` сверяет файл без записи.\n\n**Открываются все 124 здания дерева.** Два сюжетных шаблона в дерево не входят. Итог развития: **${vector(next.totals)}** вместо ${vector(old.totals)}. Добавлены пять заведений досуга, снижено развитие Трактира, Театра и Музея. Прежние требования и зависимости сохранены.\n\nПроверяются числовые требования, зависимости И/ИЛИ и обязательный Центр Строительства. Все поставщики считаются исправными и работающими. Развитие каждого шаблона начисляется один раз. Это структурная проверка: она не моделирует деньги, длительность строительства, кадры, географию, снабжение или ролевые разрешения.\n\nОтдельный поиск опорного маршрута выполнен для каждого здания. Максимум до правки — ${old.maximum}, после — ${next.maximum} построек. Каждый найденный шаг перепроверен теми же воротами, что массовые волны. Маршрут эвристический: его длина не является минимумом и сама по себе не доказывает оптимальную экономику.\n\n## Пороги ключевых ветвей\n\n| Здание | Требования до П/Т/К/В | После П/Т/К/В | Построек в найденном маршруте до → после |\n|---|---|---|---|\n`;
const targets = ["grain-elevator", "irrigation-system", "greenhouse-complex", "agronomic-institute", "militia-headquarters", "garrison-administration", "military-factory", "military-academy", "bastion", "main-headquarters", "citadel", "university", "high-tech-components-plant"];
for (const id of targets) { const row = current.find((r) => r.id === id); text += `| ${row.name} | ${vector(before.find((r) => r.id === id).requirements)} | ${vector(row.requirements)} | ${old.routes.get(id).order.length} → ${next.routes.get(id).order.length} |\n`; }
text += "\nТехнологические и культурные ворота не увеличены вслед за суммой бонусов. Несколько эвристических маршрутов стали немного длиннее: меняется набор подходящих опорных зданий; это не доказательство увеличения минимальной стоимости. Максимальная длина найденного маршрута указана выше.\n\n## Волны открытия\n\nЭто массовое последовательное открытие всех доступных зданий, а не рекомендуемый порядок строительства поселения.\n\n| Волна | Развитие перед волной | Новых зданий | Состав |\n|---|---|---|---|\n";
next.waves.forEach((wave, index) => { text += `| ${index + 1} | ${vector(wave.before)} | ${wave.rows.length} | ${wave.rows.map((r) => r.name).join("; ")} |\n`; });
text += "\n## Проверка каждого здания\n\n| Здание | ID | Требования П/Т/К/В | Длина опорного маршрута до → после |\n|---|---|---|---|\n";
for (const row of current) text += `| ${row.name} | ${row.id} | ${vector(row.requirements)} | ${old.routes.get(row.id)?.order.length ?? "новое"} → ${next.routes.get(row.id).order.length} |\n`;
text += "\n## Примеры проверенных последовательностей\n\nПорядок включает вспомогательные здания; он демонстрирует существование пути, а не обязательный набор для игрока.\n\n";
for (const id of ["meeting-house", "agronomic-institute", "main-headquarters", "citadel"]) {
  text += `### ${current.find((r) => r.id === id).name}\n\n${next.routes.get(id).order.map((key) => current.find((r) => r.id === key).name).join(" → ")}\n\n`;
}
const output = new URL("../../docs/building-development-reachability.md", import.meta.url);
if (process.argv.includes("--check")) assert.equal(readFileSync(output, "utf8"), text);
else writeFileSync(output, text);
console.log(`Development reachability: ${current.length}/124, ${next.waves.length} waves, maximum route ${next.maximum}, totals ${vector(next.totals)}.`);
