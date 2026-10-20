import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../docs/building-development-tree-proposal.md", import.meta.url), "utf8");

function between(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

function unique(values) {
  return [...new Set(values)];
}

function total(rows, key) {
  return rows.reduce((sum, row) => sum + row[key], 0);
}

const treeSection = between("## Этап 0 — Основание", "## Норматив стоимости строительства");
const proposalSection = between("## Утверждённый проект репутации и довольства", "## Сюжетные шаблоны вне дерева");

const treeRows = [...treeSection.matchAll(/^\| ([^|]+) \|(?: `[^`]+` \|)? `-?\d+\/-?\d+\/-?\d+\/-?\d+` \|$/gm)]
  .map((match) => match[1].trim());
const developmentRows = [...treeSection.matchAll(/^\| ([^|]+) \|(?: `[^`]+` \|)? `(-?\d+)\/(-?\d+)\/(-?\d+)\/(-?\d+)` \|$/gm)]
  .map((match) => ({
    name: match[1].trim(),
    food: Number(match[2]),
    technology: Number(match[3]),
    culture: Number(match[4]),
    war: Number(match[5])
  }));
const effectRows = [...proposalSection.matchAll(/^\| ([^|]+) \| `([+-]?\d+)\/([+-]?\d+)\/([+-]?\d+)` \|/gm)]
  .map((match) => ({
    name: match[1].trim(),
    reputation: Number(match[2]),
    globalMorale: Number(match[3]),
    workerMorale: Number(match[4])
  }));

assert.equal(treeRows.length, 118, "the approved project development tree must contain 118 templates");
assert.equal(unique(treeRows).length, 118, "development tree template names must be unique");
assert.equal(developmentRows.length, 118, "development control totals require every approved project template");
assert.deepEqual(
  {
    food: total(developmentRows, "food"),
    technology: total(developmentRows, "technology"),
    culture: total(developmentRows, "culture"),
    war: total(developmentRows, "war")
  },
  { food: 150, technology: 150, culture: 150, war: 150 },
  "full-catalog development totals must remain explicit"
);

const expectedDevelopmentStages = [
  { heading: "## Этап 0 — Основание", count: 12, totals: [8, 4, 4, 8] },
  { heading: "## Этап I — Становление", count: 24, totals: [25, 17, 16, 16] },
  { heading: "## Этап II — Развитое поселение", count: 27, totals: [35, 23, 26, 22] },
  { heading: "## Этап III — Город", count: 22, totals: [22, 31, 33, 38] },
  { heading: "## Этап IV — Передовая инфраструктура", count: 12, totals: [28, 23, 20, 15] },
  { heading: "## Этап V — Индустриальный город", count: 12, totals: [20, 24, 25, 17] },
  { heading: "## Этап VI — Крупный центр", count: 8, totals: [11, 27, 25, 23] },
  { heading: "## Этап VII — Вершина развития", count: 1, totals: [1, 1, 1, 11] }
];
for (const [index, expected] of expectedDevelopmentStages.entries()) {
  const startIndex = treeSection.indexOf(expected.heading);
  const nextHeading = expectedDevelopmentStages[index + 1]?.heading;
  const endIndex = nextHeading ? treeSection.indexOf(nextHeading, startIndex + expected.heading.length) : treeSection.length;
  assert.notEqual(startIndex, -1, `missing development stage: ${expected.heading}`);
  assert.ok(endIndex > startIndex, `missing development boundary after: ${expected.heading}`);
  const rows = [...treeSection.slice(startIndex, endIndex).matchAll(/^\| ([^|]+) \|(?: `[^`]+` \|)? `(-?\d+)\/(-?\d+)\/(-?\d+)\/(-?\d+)` \|$/gm)]
    .map((match) => [Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])]);
  assert.deepEqual(
    { count: rows.length, totals: rows.reduce((sum, row) => sum.map((value, i) => value + row[i]), [0, 0, 0, 0]) },
    { count: expected.count, totals: expected.totals },
    `development stage totals drifted: ${expected.heading}`
  );
}
assert.equal(effectRows.length, 118, "every development template must have one reputation/global morale/worker morale project row");
assert.equal(unique(effectRows.map((row) => row.name)).length, 118, "project rows must not repeat template names");
assert.deepEqual(effectRows.map((row) => row.name), treeRows, "proposal rows must match the development tree in stage order");
assert.equal(effectRows.every((row) => Number.isInteger(row.reputation) && Number.isInteger(row.globalMorale) && Number.isInteger(row.workerMorale)), true, "all proposal values must be whole numbers");
assert.equal(effectRows.every((row) => row.reputation >= 0), true, "building reputation represents fame and must not be negative");
assert.deepEqual(
  {
    reputation: total(effectRows, "reputation"),
    globalMorale: total(effectRows, "globalMorale"),
    workerMorale: total(effectRows, "workerMorale")
  },
  { reputation: 54, globalMorale: 54, workerMorale: -28 },
  "full-catalog control totals must remain explicit"
);

const expectedStages = [
  { heading: "### Этап 0 — основание", count: 12, reputation: 0, globalMorale: 2, workerMorale: -3 },
  { heading: "### Этап I — становление", count: 24, reputation: 4, globalMorale: -1, workerMorale: -6 },
  { heading: "### Этап II — развитое поселение", count: 27, reputation: 5, globalMorale: 8, workerMorale: -6 },
  { heading: "### Этап III — город", count: 22, reputation: 8, globalMorale: 6, workerMorale: -7 },
  { heading: "### Этап IV — передовая инфраструктура", count: 12, reputation: 9, globalMorale: 16, workerMorale: -7 },
  { heading: "### Этап V — индустриальный город", count: 12, reputation: 12, globalMorale: 11, workerMorale: 1 },
  { heading: "### Этап VI — крупный центр", count: 8, reputation: 13, globalMorale: 9, workerMorale: 0 },
  { heading: "### Этап VII — вершина развития", count: 1, reputation: 3, globalMorale: 3, workerMorale: 0 }
];

for (const [index, expected] of expectedStages.entries()) {
  const startIndex = proposalSection.indexOf(expected.heading);
  const nextHeading = expectedStages[index + 1]?.heading ?? "### Питание, жильё и базовое довольство";
  const endIndex = proposalSection.indexOf(nextHeading, startIndex + expected.heading.length);
  assert.notEqual(startIndex, -1, `missing proposal stage: ${expected.heading}`);
  assert.notEqual(endIndex, -1, `missing proposal boundary after: ${expected.heading}`);
  const rows = [...proposalSection.slice(startIndex, endIndex).matchAll(/^\| ([^|]+) \| `([+-]?\d+)\/([+-]?\d+)\/([+-]?\d+)` \|/gm)]
    .map((match) => ({ reputation: Number(match[2]), globalMorale: Number(match[3]), workerMorale: Number(match[4]) }));
  assert.deepEqual(
    {
      count: rows.length,
      reputation: total(rows, "reputation"),
      globalMorale: total(rows, "globalMorale"),
      workerMorale: total(rows, "workerMorale")
    },
    {
      count: expected.count,
      reputation: expected.reputation,
      globalMorale: expected.globalMorale,
      workerMorale: expected.workerMorale
    },
    `proposal stage totals drifted: ${expected.heading}`
  );
}

const byName = new Map(effectRows.map((row) => [row.name, row]));
const developmentByName = new Map(developmentRows.map((row) => [row.name, row]));
for (const row of [
  ["Элеватор", "22/20/8/0", "12/1/0/0"],
  ["Штаб ополчения", "0/22/14/30", "0/1/2/12"],
  ["Оросительная система", "44/42/16/0", "7/1/0/0"],
  ["Продовольственный распределительный центр", "48/44/28/12", "6/1/2/2"],
  ["Тепличный комплекс", "66/62/30/0", "11/2/0/0"],
  ["Гарнизонное управление", "0/58/40/66", "2/1/1/10"],
  ["Агрономический институт", "80/70/45/0", "6/2/6/0"],
  ["Главный штаб", "0/72/46/86", "1/1/5/10"]
]) {
  assert.equal(source.includes(`| ${row[0]} | \`${row[1]}\` | \`${row[2]}\` |`), true, `${row[0]} must retain its approved requirement and development vectors`);
}
assert.deepEqual(developmentByName.get("Палаточный лагерь"), { name: "Палаточный лагерь", food: 0, technology: 0, culture: 0, war: 0 }, "tent housing penalty must remain personal and must not deadlock zero-requirement construction");
assert.deepEqual(developmentByName.get("Школа"), { name: "Школа", food: 0, technology: 3, culture: 3, war: 0 });
assert.deepEqual(developmentByName.get("Агентство Найма"), { name: "Агентство Найма", food: 0, technology: 1, culture: 2, war: 0 });
assert.equal(byName.get("Общий дом")?.reputation, 0, "ordinary housing must not create fame");
assert.equal(byName.get("Пирс")?.reputation, 1, "the pier must create fame through visitor traffic");
assert.equal(byName.get("Трактир")?.reputation, 1, "the tavern must create fame through visitor traffic");
assert.equal(byName.get("Голубятня")?.reputation, 1, "dove mail must create fame through communications");
assert.equal(byName.get("Телеграфная станция")?.reputation, 2, "telegraph must create strong fame through communications");
for (const name of ["Семейный дом", "Рабочее общежитие", "Доходный городской дом", "Благоустроенный дом", "Особняк"]) {
  assert.deepEqual(
    [byName.get(name)?.reputation, byName.get(name)?.globalMorale],
    [0, 0],
    `${name} must apply housing comfort personally rather than as fame or global morale`
  );
}
assert.deepEqual(byName.get("Суд"), { name: "Суд", reputation: 1, globalMorale: 0, workerMorale: 1 });
for (const name of ["Шахта", "Центр Строительства", "Кузня", "Крепостной вал", "Надвратная башня", "Артиллерийская платформа"]) {
  assert.equal(byName.get(name)?.reputation, 0, `${name} must not add a separate generic fame channel`);
}
assert.equal(byName.get("Воздушная верфь")?.workerMorale, -1);
assert.equal(byName.get("Завод высокотехнологичных компонентов")?.workerMorale, 0);
assert.equal(byName.get("Цитадель")?.workerMorale, 0);
assert.deepEqual(byName.get("Элеватор"), { name: "Элеватор", reputation: 1, globalMorale: 0, workerMorale: -1 });
assert.deepEqual(byName.get("Штаб ополчения"), { name: "Штаб ополчения", reputation: 0, globalMorale: 1, workerMorale: 0 });
assert.deepEqual(byName.get("Главный штаб"), { name: "Главный штаб", reputation: 0, globalMorale: 1, workerMorale: 1 });
assert.match(source, /^\| Школа \| 5 \| -1 \| Wood 160; Stone 80; Письменные материалы 20; Простые компоненты 10 \| — \|$/m, "School must keep the approved more expensive construction recipe");

assert.match(proposalSection, /перенесён в runtime-каталог v14/);
assert.match(proposalSection, /обычная загрузка модуля ничего не записывают в сохранённый каталог мира/);
assert.match(proposalSection, /Репутация, глобальное довольство и развитие шаблона учитываются только от первого действующего экземпляра/);
assert.match(proposalSection, /workerMoraleDelta/);
assert.match(proposalSection, /Каждый житель начинает расчёт десятника с личного `-1`/);
assert.match(proposalSection, /Голод \| `-2`/);
assert.match(proposalSection, /Не менее `150%` базовой ставки \| `\+2`/);
assert.match(source, /сверхпрестижный исключительный — `120`/);
assert.match(source, /`6\/9\/12\/60 ММ за QD`/);
assert.match(source, /^\| Баня \| 2 \| 18 \| 36 \/ 144 \| 1 \|/m, "Bathhouse must have exactly two workers and the approved 144 operating upkeep");
assert.match(proposalSection, /`1–5 QD` сверх нормы дают `-1`, `6–10 QD` — `-2`/);
assert.match(proposalSection, /Запугивание не делает людей довольными/);
assert.match(proposalSection, /не должна автоматически улучшать закупочную и отпускную цену каждого товара/);
assert.match(source, /обычное топливо насосов включено в эксплуатационное содержание/);
assert.match(source, /обычное топливо и мелкие технологические расходники включены в эксплуатационное содержание/);

console.log("FBL Skyhold building reputation/morale proposal: 118 templates; development F150/T150/C150/W150; total R+54/G+54/W-28.");
