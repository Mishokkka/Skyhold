import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { ECONOMY_RESOURCE_CATALOG_VERSION, RESOURCE_BASE_DEFINITIONS } from "../data/resources/resource-base-definitions.js";

const UNIT_PREFIX = "Смысл 1 ЕД.: ";
const UNIT_DISCLAIMER = "Масса и объём служат пояснением; склад и перевозки используют прежние ЕД. и грузовые очки.";
const cell = (value) => String(value ?? "—").replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
const compactNote = (value) => {
  let note = String(value ?? "").trim();
  if (note.startsWith(UNIT_PREFIX)) note = note.slice(UNIT_PREFIX.length);
  if (note.endsWith(UNIT_DISCLAIMER)) note = note.slice(0, -UNIT_DISCLAIMER.length).trim();
  return note || "—";
};

const rows = RESOURCE_BASE_DEFINITIONS;
let text = `# Каталог ресурсов v${ECONOMY_RESOURCE_CATALOG_VERSION}\n\n`
  + `Автогенерируемый справочник встроенных данных (${rows.length} записей: ${rows.filter((row) => row.id !== "money").length} товаров и деньги; поголовье ведётся отдельно по 8 видам). Источник — \`scripts/data/resources/resource-base-definitions.js\` и \`resource-unit-notes.js\`. Обновление: \`node scripts/dev/build-resource-catalog-reference.mjs\` (сверка: \`--check\`).\n\n`
  + `\`categoryTag\` разрешает замену сырья в рецептах; \`marketTags\` служат только для рынка. 1 ед. нагрузки = 4 points; срок указан в QD (4 QD = день, \`0\` — не портится). Масса и объём в описании единицы носят пояснительный характер; склад и перевозки считают целые ЕД. и грузовые очки. См. [калибровку](resource-pricing.md) и [экономику](economy-contract.md).\n\n`
  + `| ID | Название | Категория замены | Цена, ММ | Нагрузка, pts | Срок, QD | Группа пищи | Смысл 1 ЕД. / примечание |\n`
  + `|---|---|---|---:|---:|---:|---|---|\n`;

for (const row of rows) {
  text += `| ${[
    row.id,
    row.label,
    row.categoryTag || "—",
    row.basePriceCopper,
    row.loadPoints,
    row.shelfLifeQd,
    row.foodEdible ? row.foodType || "—" : "—",
    compactNote(row.notes || row.unit)
  ].map(cell).join(" | ")} |\n`;
}

const destination = new URL("../../docs/economy-resource-catalog.md", import.meta.url);
if (process.argv.includes("--check")) {
  assert.equal(readFileSync(destination, "utf8"), text, "The resource reference must match runtime data");
} else {
  writeFileSync(destination, text);
}
console.log(`Resource reference v${ECONOMY_RESOURCE_CATALOG_VERSION}: ${rows.length} records.`);
