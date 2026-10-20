import { readFileSync, writeFileSync } from "node:fs";

import { BUILDING_TEMPLATES_CULTURE } from "../data/building-template-catalog/culture.js";
import { BUILDING_TEMPLATES_FOOD } from "../data/building-template-catalog/food.js";
import { BUILDING_TEMPLATES_TECHNOLOGY } from "../data/building-template-catalog/technology.js";
import { BUILDING_TEMPLATES_UNIQUE } from "../data/building-template-catalog/unique.js";
import { BUILDING_TEMPLATES_WAR } from "../data/building-template-catalog/war.js";
import { APPROVED_BUILDING_TEMPLATE_ID_BY_NAME } from "../data/building-template-ids.js";

const sourceUrl = new URL("../../docs/building-worker-affinity-proposal.md", import.meta.url);
const outputUrl = new URL("../data/building-worker-profile-data.js", import.meta.url);
const source = readFileSync(sourceUrl, "utf8");

const ATTRIBUTE_KEYS = Object.freeze({ СИЛ: "strength", ЛОВ: "agility", РАЗ: "wits", ЭМП: "empathy" });
const HARD_ADMISSION_BUILDINGS = new Set([
  "Лесоповал", "Каменоломня", "Стрельбище", "Тренировочный лагерь", "Казарма", "Сторожевой пост",
  "Рыбацкий причал", "Арсенал", "Линия баррикад", "Сигнальная башня", "Охранная башня", "Темница",
  "Пороховой погреб", "Полевой редут", "Караульный дом", "Кирпичный завод", "Шахта",
  "Стекольная мастерская", "Инструментальная мастерская", "Кузня", "Маяк", "Крепостной вал", "Ров",
  "Надвратная башня", "Артиллерийская платформа", "Решётка", "Пожарное депо", "Газовый завод",
  "Железнодорожное депо", "Участок охраны", "Машиностроительный цех", "Химический завод",
  "Металлургический завод", "Гарнизонное управление", "Завод высокотехнологичных компонентов",
  "Воздушная верфь", "Военный завод", "Военная академия", "Бастион", "Главный штаб", "Цитадель"
]);

function clean(value = "") {
  return String(value).replaceAll("`", "").replaceAll("**", "").trim();
}

function nameOf(value = "") {
  return clean(value).replace(/[«»]/g, "").replace(/\s+/g, " ");
}

function nameKey(value = "") {
  return nameOf(value).toLowerCase().replaceAll("ё", "е");
}

function pipeRow(line = "") {
  const escapedPipe = "\u0000";
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .replaceAll("\\|", escapedPipe)
    .split("|")
    .map((value) => clean(value.replaceAll(escapedPipe, "|")));
}

function tablesIn(markdown = "") {
  const lines = markdown.split(/\r?\n/);
  const tables = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith("|") || !lines[index + 1]?.startsWith("|---")) continue;
    const headers = pipeRow(lines[index]);
    const rows = [];
    let cursor = index + 2;
    while (cursor < lines.length && lines[cursor].startsWith("|")) rows.push(pipeRow(lines[cursor++]));
    tables.push({ headers, rows });
    index = cursor - 1;
  }
  return tables;
}

function listOf(value = "") {
  const text = clean(value);
  if (!text || text === "—") return [];
  return text.split(/\s+(?:или)\s+|\s*,\s*/i).map(clean).filter(Boolean);
}

function selectorsOf(value = "") {
  const text = clean(value);
  if (!text || text === "—") return [];
  return text.split("|").map(clean).filter(Boolean);
}

function admissionOf(value = "", hard = false) {
  const text = clean(value);
  if (!text || text === "—") return { text: "—", hard: false, clauses: [] };
  if (text === "Любой трудоспособный") return { text, hard: false, clauses: [] };
  const clauses = text.split(/\s+или\s+/i).map((clause) => clause.split(/\s+и\s+/i).map((part) => {
    const match = clean(part).match(/^(СИЛ|ЛОВ|РАЗ|ЭМП)≥([1-5])$/);
    if (!match) throw new Error(`Unknown admission selector: ${text}`);
    return { attribute: ATTRIBUTE_KEYS[match[1]], minimum: Number(match[2]) };
  }));
  return { text, hard, clauses };
}

function compositionOf(value = "") {
  const text = clean(value);
  if (!text || text === "—") return [];
  return text.split(";").map((part) => {
    const match = clean(part).match(/^(\d+)×\s+(.+)$/);
    if (!match) throw new Error(`Unknown composition requirement: ${text}`);
    return { count: Number(match[1]), group: match[2] };
  });
}

const tables = tablesIn(source);
const mapping = tables.find((table) => table.headers.join("|") === "Этап|Шаблон|Штат|Допуск каждого работника|+25%|+50%|Класс|Ключевое условие состава|Основание");
const runtimeSpecials = tables.find((table) => table.headers.join("|") === "Слой|Сюжетный runtime-шаблон|Штат|Допуск каждого работника|+25%|+50%|Класс|Ключевое условие состава|Основание");
const production = tables.find((table) => table.headers.join("|") === "Производственный шаблон|Подходящее прошлое +10%|Положительная черта +10%|Мешающая черта -10%");
if (!mapping || !runtimeSpecials || !production) throw new Error("Approved worker profile tables were not found.");

const runtimeTemplates = [
  ...BUILDING_TEMPLATES_FOOD,
  ...BUILDING_TEMPLATES_CULTURE,
  ...BUILDING_TEMPLATES_TECHNOLOGY,
  ...BUILDING_TEMPLATES_WAR,
  ...BUILDING_TEMPLATES_UNIQUE
];
const runtimeIdByName = new Map(runtimeTemplates.map((template) => [nameKey(template.name), String(template.id ?? "")]));
runtimeIdByName.set(nameKey("Полевое хозяйство"), "grain-field");
for (const [name, id] of Object.entries(APPROVED_BUILDING_TEMPLATE_ID_BY_NAME)) runtimeIdByName.set(nameKey(name), id);
const productionByName = new Map(production.rows.map(([name, backgrounds, positiveTraits, negativeTraits]) => [nameOf(name), {
  backgroundGroups: listOf(backgrounds),
  positiveTraits: listOf(positiveTraits),
  negativeTraits: listOf(negativeTraits)
}]));

const profiles = [...mapping.rows, ...runtimeSpecials.rows].map(([stage, rawName, staff, admission, suitable, optimal, staffingClass, composition, reason]) => {
  const name = nameOf(rawName);
  const staffNumbers = clean(staff).match(/\d+/g)?.map(Number) ?? [];
  const workersMin = staffNumbers[0] ?? 0;
  const workersMax = staffNumbers[1] ?? workersMin;
  return {
    templateId: runtimeIdByName.get(nameKey(name)) || "",
    name,
    stage: Number(stage),
    workersMin,
    workersMax,
    admission: admissionOf(admission, HARD_ADMISSION_BUILDINGS.has(name)),
    suitableSelectors: selectorsOf(suitable),
    optimalSelectors: selectorsOf(optimal),
    staffingClass: clean(staffingClass) === "—" ? "" : clean(staffingClass),
    composition: compositionOf(composition),
    production: productionByName.get(name) ?? null,
    reason: clean(reason)
  };
});

const backgroundGroups = {};
for (const match of source.matchAll(/^- `([^`]+)`: (.+)\.$/gm)) backgroundGroups[match[1]] = listOf(match[2]);

const output = `// Generated by scripts/dev/build-building-worker-profiles.mjs from the approved Markdown tables.\n`
  + `// Runtime never reads Markdown; regenerate this checked-in manifest after an approved table change.\n\n`
  + `export const BUILDING_WORKER_PROFILE_VERSION = 1;\n\n`
  + `export const APPROVED_WORKER_BACKGROUND_GROUPS = Object.freeze(${JSON.stringify(backgroundGroups, null, 2)});\n\n`
  + `export const APPROVED_BUILDING_WORKER_PROFILES = Object.freeze(${JSON.stringify(profiles, null, 2)});\n`;

writeFileSync(outputUrl, output, "utf8");
console.log(`Generated ${profiles.length} building worker profiles (${profiles.filter((profile) => profile.templateId).length} current runtime ids).`);
