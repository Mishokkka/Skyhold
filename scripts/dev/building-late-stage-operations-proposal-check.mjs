import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ECONOMY_RESOURCE_PRICE_COPPER } from "../data/resources/resource-base-definitions.js";

const source = readFileSync(new URL("../../docs/building-development-tree-proposal.md", import.meta.url), "utf8");
const start = source.indexOf("### Этап V — эксплуатация тяжёлой промышленности");
const end = source.indexOf("## Утверждённый проект репутации и довольства", start);
assert.notEqual(start, -1, "late-stage operations section must exist");
assert.notEqual(end, -1, "late-stage operations section must end before the reputation proposal");
const section = source.slice(start, end);

const operationRows = [...section.matchAll(/^\| ([^|]+) \| `(\d+)–(\d+)` \| `(\d+)` \| `(\d+) \/ (\d+)` \| `(\d+)` \|/gm)]
  .map((match) => ({
    name: match[1].trim(),
    workersMin: Number(match[2]),
    workersMax: Number(match[3]),
    wageDailyCopper: Number(match[4]),
    baseUpkeepMonthlyCopper: Number(match[5]),
    operatingUpkeepMonthlyCopper: Number(match[6]),
    maintenanceRequiredPoints: Number(match[7])
  }));

const expectedOperations = [
  ["Машиностроительный цех", 10, 40, 18, 108, 144, 3],
  ["Химический завод", 10, 40, 18, 108, 162, 3],
  ["Металлургический завод", 15, 60, 18, 144, 180, 3],
  ["Ратуша", 4, 12, 18, 108, 90, 3],
  ["Больница", 6, 24, 18, 126, 144, 3],
  ["Банк и торговая биржа", 4, 16, 18, 90, 108, 3],
  ["Городской театр", 6, 24, 18, 90, 108, 2],
  ["Музей", 4, 16, 18, 90, 90, 2],
  ["Особняк", 1, 4, 12, 90, 72, 2],
  ["Суд", 3, 8, 24, 108, 108, 3],
  ["Тепличный комплекс", 6, 20, 18, 126, 180, 3],
  ["Гарнизонное управление", 4, 12, 24, 108, 108, 3],
  ["Завод высокотехнологичных компонентов", 15, 60, 18, 144, 216, 3],
  ["Воздушная верфь", 20, 80, 18, 180, 216, 3],
  ["Военный завод", 20, 80, 18, 180, 216, 3],
  ["Университет", 8, 32, 24, 126, 144, 3],
  ["Военная академия", 6, 24, 18, 126, 126, 3],
  ["Бастион", 5, 20, 18, 180, 108, 3],
  ["Агрономический институт", 6, 16, 24, 144, 180, 3],
  ["Главный штаб", 6, 18, 24, 180, 180, 3],
  ["Цитадель", 8, 32, 18, 300, 216, 3]
].map(([name, workersMin, workersMax, wageDailyCopper, baseUpkeepMonthlyCopper, operatingUpkeepMonthlyCopper, maintenanceRequiredPoints]) => ({
  name,
  workersMin,
  workersMax,
  wageDailyCopper,
  baseUpkeepMonthlyCopper,
  operatingUpkeepMonthlyCopper,
  maintenanceRequiredPoints
}));

assert.deepEqual(operationRows, expectedOperations, "all 21 stage V–VII buildings must retain their exact operating contract");
assert.equal(operationRows.every((row) => row.workersMin > 0 && row.workersMax >= row.workersMin), true, "late-stage buildings must have coherent staffing ranges");
assert.equal(operationRows.every((row) => row.maintenanceRequiredPoints >= 1 && row.maintenanceRequiredPoints <= 3), true, "maintenance must fit the current normalized 0–3 scale");

const recipeRows = [...section.matchAll(/^\| ([^|]+) \| ([^|]+) \| ([^|]+) \| `(\d+)` \| `(\d+)` \| `(\d+)` \| `(\d+)` \| `(\d+)` \|$/gm)]
  .map((match) => ({
    name: match[1].trim(),
    qd: Number(match[4]),
    inputCopper: Number(match[5]),
    outputCopper: Number(match[6]),
    wageCopper: Number(match[7]),
    marginCopper: Number(match[8])
  }));

const recipes = [
  { name: "Машиностроение — сложные компоненты", qd: 4, inputs: { iron: 2, steel: 1, copper: 1, "components-simple": 2 }, output: { id: "components-complex", qty: 2 } },
  { name: "Машиностроение — сложные инструменты", qd: 8, inputs: { steel: 4, copper: 2, "components-complex": 4 }, output: { id: "tools-complex", qty: 2 } },
  { name: "Химия — простые материалы", qd: 2, inputs: { tallow: 4, "fuel-solid": 1 }, output: { id: "chemicals-simple", qty: 2 } },
  { name: "Химия — сложные материалы", qd: 6, inputs: { "chemicals-simple": 4, salt: 4, "fuel-solid": 2 }, output: { id: "chemicals-complex", qty: 2 } },
  { name: "Химия — взрывчатка", qd: 4, inputs: { "chemicals-complex": 1, "fuel-solid": 1, salt: 2 }, output: { id: "explosives", qty: 2 } },
  { name: "Химия — жидкое топливо", qd: 2, inputs: { tallow: 4, "chemicals-simple": 1 }, output: { id: "fuel-liquid", qty: 4 } },
  { name: "Металлургия — сталь", qd: 1, inputs: { iron: 2, "fuel-solid": 1 }, output: { id: "steel", qty: 2 } },
  { name: "Металлургия — лёгкие сплавы", qd: 4, inputs: { copper: 1, "nonferrous-metals": 1, "fuel-solid": 1 }, output: { id: "light-alloys", qty: 2 } },
  { name: "Металлургия — сложные сплавы", qd: 6, inputs: { steel: 2, "nonferrous-metals": 2, "light-alloys": 1, "chemicals-simple": 1, "fuel-solid": 2 }, output: { id: "complex-alloys", qty: 2 } },
  { name: "Высокие технологии — компоненты", qd: 10, inputs: { "components-complex": 3, copper: 2, "complex-alloys": 1, "rare-earth-metals": 1, glass: 1 }, output: { id: "components-high-tech", qty: 4 } },
  { name: "Военный завод — сложные припасы", qd: 4, inputs: { iron: 2, copper: 1, "chemicals-simple": 2, explosives: 1 }, output: { id: "military-supplies-complex", qty: 2 } },
  { name: "Военный завод — сложное вооружение", qd: 20, inputs: { wood: 40, steel: 20, "components-complex": 6, "military-supplies-complex": 3 }, output: { id: "armament-complex", qty: 1 } },
  { name: "Военный завод — элитное вооружение", qd: 40, inputs: { "armament-complex": 1, "complex-alloys": 8, "components-high-tech": 4, "military-supplies-complex": 6 }, output: { id: "armament-elite", qty: 1 } }
];

function resourceValue(resourceId, qty) {
  assert.equal(Object.hasOwn(ECONOMY_RESOURCE_PRICE_COPPER, resourceId), true, `unknown recipe resource: ${resourceId}`);
  return ECONOMY_RESOURCE_PRICE_COPPER[resourceId] * qty;
}

const expectedRecipes = recipes.map((recipe) => {
  const inputCopper = Object.entries(recipe.inputs).reduce((sum, [resourceId, qty]) => sum + resourceValue(resourceId, qty), 0);
  const outputCopper = resourceValue(recipe.output.id, recipe.output.qty);
  const wageCopper = recipe.qd * 18 / 2;
  const marginCopper = outputCopper - inputCopper - wageCopper;
  assert.equal(Number.isInteger(wageCopper), true, `${recipe.name}: wage must remain whole copper`);
  assert.equal(marginCopper > 0, true, `${recipe.name}: neutral-price margin must remain positive`);
  return { name: recipe.name, qd: recipe.qd, inputCopper, outputCopper, wageCopper, marginCopper };
});

assert.deepEqual(recipeRows, expectedRecipes, "late-stage recipe economics must follow the canonical neutral price catalog");
assert.match(section, /не создаёт универсальный складской товар «корабль»/);
assert.match(section, /не получает процентный доход из пустоты/);
assert.match(section, /не печатает очки Технологии, Культуры или деньги за QD/);
assert.match(section, /не включает глобальный флаг подготовки всего ополчения/);
assert.match(section, /Одна секция Тепличного комплекса требует шесть оплаченных работников и суммарно 20 QD за десятник/);
assert.match(section, /Агрономический институт не создаёт урожай, очки развития или деньги за QD/);
assert.match(section, /Главный штаб действует только при минимальных шести оплаченных работниках/);
assert.match(section, /Цитадель не создаёт пассивного дохода, бесплатных войск, вооружения или военных припасов/);

console.log("FBL Skyhold late-stage operations proposal: 21 buildings and 13 price-checked recipes passed.");
