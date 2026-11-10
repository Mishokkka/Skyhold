import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { ECONOMY_RESOURCE_CATALOG_VERSION, RESOURCE_BASE_DEFINITIONS } from "../data/resources/resource-base-definitions.js";

const cell = value => String(value ?? "—").replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
const rows = RESOURCE_BASE_DEFINITIONS;
let text = `# Каталог ресурсов v${ECONOMY_RESOURCE_CATALOG_VERSION}\n\nСтатус: сгенерированный справочник встроенных данных. ${rows.length} записей: ${rows.filter(row => row.id !== "money").length} товаров и служебные деньги. Поголовье ведётся отдельно по восьми видам. Источник — \`scripts/data/resources/resource-base-definitions.js\`; смысл единицы — \`resource-unit-notes.js\` в той же папке.\n\nОбновление: \`node scripts/dev/build-resource-catalog-reference.mjs\`; сверка без записи: та же команда с \`--check\`. Сохранённый пользовательский каталог может отличаться. [Калибровка цен и единиц](resource-pricing.md), [экономика](economy-contract.md).\n\n\`categoryTag\` разрешает замену в рецепте; \`marketTags\` классифицируют товар для рынка и не дают права такой замены. Одна единица нагрузки = 4 points; возраст и срок указаны в QD (4 QD = день). Срок 0 означает отсутствие календарной порчи.\n\n| ID | Название | Категория замены | Цена, ММ | Нагрузка, points | Срок, QD | Группа готовой пищи | Смысл единицы / примечание |\n|---|---|---|---:|---:|---:|---|---|\n`;
for (const row of rows) {
  text += `| ${[row.id, row.label, row.categoryTag || "—", row.basePriceCopper, row.loadPoints, row.shelfLifeQd, row.foodEdible ? row.foodType || "—" : "—", row.notes || row.unit].map(cell).join(" | ")} |\n`;
}
const destination = new URL("../../docs/economy-resource-catalog.md", import.meta.url);
if (process.argv.includes("--check")) assert.equal(readFileSync(destination, "utf8"), text, "The resource reference must match runtime data");
else writeFileSync(destination, text);
console.log(`Resource reference v${ECONOMY_RESOURCE_CATALOG_VERSION}: ${rows.length} records.`);
