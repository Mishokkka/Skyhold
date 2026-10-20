import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_BUILDING_TEMPLATES, TEMPLATE_CATALOG_VERSION } from "../data/building-templates.js";

const rows = DEFAULT_BUILDING_TEMPLATES;
assert.equal(rows.length, 126);
const names = new Map(rows.map((row) => [row.id, row.name]));
const v = (value = {}) => ["food", "technology", "culture", "war"].map((key) => value[key] ?? 0).join("/");
const show = (value) => JSON.stringify(value);
const safe = (value = "") => String(value).replaceAll("\n", " ").replaceAll("\r", "");
const functions = { production: "производство", income: "доход", defense: "оборона", housing: "жильё", storage: "склад", culture: "общественная служба" };
let text = `# Каталог зданий v${TEMPLATE_CATALOG_VERSION}\n\nЕдиный справочник действующего кода: 124 здания дерева и 2 сюжетных. Сгенерирован командой \`node scripts/dev/build-building-catalog-reference.mjs\`; \`--check\` проверяет соответствие без записи. Установка кода не переносит сохранённые здания: для них нужен отдельный Preview/Apply.\n\nП/Т/К/В — Пища, Технология, Культура, Война. Деньги указаны в ММ; содержание — за месяц, ставка — за день, обслуживание — прямые QD на экземпляр за десятник. Нулевая трудовая норма не отменяет денежного содержания. Общие правила находятся в [экономическом контракте](economy-contract.md), правила перехода — в [руководстве v16](morale-v16-implementation.md).\n\n`;
for (const row of rows) {
  text += `## ${safe(row.name)}\n\n`;
  text += `ID: \`${row.id}\`. ${safe(row.type)}; этап ${row.developmentStage ?? "сюжетный"}. Требования П/Т/К/В: **${v(row.requirements)}**; развитие: **${v(row.bonuses)}**.\n\n`;
  text += `- Строительство: ${row.buildTarget ?? 0} этапов; сложность ${row.buildDifficulty ?? 0}. Материалы: ${(row.materialCosts ?? []).map((cost) => `${safe(cost.name || cost.resourceId)} ${cost.qty}`).join("; ") || "нет"}.\n`;
  text += `- Штат: ${row.workersMin ?? 0}–${row.workersMax ?? 0}; ставка ${row.wageDailyCopper ?? 0}. Содержание: база ${row.baseUpkeepMonthlyCopper ?? 0}, эксплуатация ${row.operatingUpkeepMonthlyCopper ?? 0}. Техобслуживание: ${row.maintenance.requiredPoints} QD.\n`;
  text += `- Функции: ${Object.entries(functions).filter(([key]) => row.functions?.[key]).map(([,label]) => label).join(", ") || "нет"}. Репутация / довольство / условия труда: ${row.reputation ?? 0}/${row.moraleDelta ?? 0}/${row.workerMoraleDelta ?? 0}.\n`;
  text += `- Активация: ${row.activation?.minWorkers ?? 0} работников, ${row.activation?.minOperationalQd ?? 0} QD; содержательный результат ${row.activation?.requiresMeaningfulResult ? "обязателен" : "не требуется"}.\n`;
  const dependency = (id) => `${names.get(id) ?? id} (${row.prerequisiteModes?.[id] === "construction" ? "при создании проекта" : row.prerequisiteModes?.[id] === "service" ? "действующая услуга" : "прежнее условие присутствия"})`;
  text += `- Зависимости: ${(row.requiredBuildingIds ?? []).map(dependency).join("; ") || "нет"}${row.requiredAnyBuildingIds?.length ? `; одна из: ${row.requiredAnyBuildingIds.map(dependency).join(" ИЛИ ")}` : ""}${row.requiresConstructionCenter ? "; нужен Центр Строительства" : ""}.\n`;
  if (row.specialRequirements || row.siteRequirementsText) text += `- Участок: ${safe(row.siteRequirementsText || row.specialRequirements)}\n`;
  if (row.workerProfile) text += `- Работники: ${safe(row.workerProfile.admission?.text || "без особого допуска")}; обязательный состав: ${(row.workerProfile.composition ?? []).map((part) => `${part.count} × ${part.group}`).join("; ") || "нет"}. ${safe(row.workerProfile.reason)}\n`;
  for (const [key, label] of [["service", "Услуга"], ["control", "Контроль"], ["housing", "Жильё"], ["storage", "Склад"]]) {
    if (row[key] && (key === "service" || key === "control" || row.functions?.[key])) text += `- ${label}: \`${show(row[key])}\`.\n`;
  }
  for (const line of row.productionLines ?? []) text += `- Производственная линия: \`${show(line)}\`.\n`;
  for (const [key,label] of [["agriculture","Сельское хозяйство"],["livestock","Животные"],["serviceProjects","Проекты учреждения"]]) {
    if (row[key] && (!Array.isArray(row[key]) || row[key].length)) text += `- ${label}: \`${show(row[key])}\`.\n`;
  }
  if (row.functions?.income) text += `- Доходная функция: \`${show(row.income)}\`.\n`;
  text += `\n${safe(row.description)}${row.effect ? ` ${safe(row.effect)}` : ""}${row.notes ? ` ${safe(row.notes)}` : ""}\n\n`;
}
const destination = new URL("../../docs/building-catalog.md", import.meta.url);
if (process.argv.includes("--check")) assert.equal(readFileSync(destination,"utf8"), text, "The canonical building reference must match runtime data");
else writeFileSync(destination,text);
console.log(`Building reference v${TEMPLATE_CATALOG_VERSION}: ${rows.length} templates.`);
