import { buildingCatalogV18Templates } from "./building-template-revision-v18.js";

const OLD_BANK_TEXT = "Явные займы, вклады, гарантии и крупные договоры без пассивной эмиссии денег";
const STANDARD_TEXT_UPDATES = Object.freeze({
  school: {
    effect: {
      previous: [
        "Оплаченный учитель открывает ролевые образовательные решения",
        "Если в школе назначен взрослый учитель, дети получают шанс развития при прохождении первой трети детства, второй трети детства и выхода из детского возраста.",
        "Оплаченный учитель создаёт предложение решения ГМа при возрастной вехе ребёнка; характеристики и черты не меняются автоматически."
      ],
      current: "Работающая школа открывает ролевое решение ГМа при возрастной вехе ребёнка."
    },
    notes: {
      previous: ["Механика работает при годовом старении: шанс небольшой, но может дать +1 к характеристике и положительную черту."],
      current: "При годовом старении учитывается присутствие ребёнка и работа культурной службы с учителем. Характеристики и черты школа автоматически не меняет."
    }
  },
  "bank-exchange": {
    description: { previous: [OLD_BANK_TEXT], current: "Банковское учреждение и место крупных сделок." },
    effect: { previous: [OLD_BANK_TEXT], current: "Займы, хранение и срочные вклады оформляются в окне «Банк» по предложениям справочника." }
  }
});

/** Replace only the exact earlier stock wording on a prepared row and report the field changes. */
export function applyStandardBuildingText(row, templateId) {
  if (!Object.hasOwn(STANDARD_TEXT_UPDATES, templateId)) return [];
  const updates = [];
  for (const [field, { previous, current }] of Object.entries(STANDARD_TEXT_UPDATES[templateId])) {
    const before = row[field];
    if (!previous.includes(before)) continue;
    row[field] = current;
    updates.push({ field, before, after: current });
  }
  return updates;
}

// Approved waiting periods and shared production capacity, 13 October 2026.
// [building, resource, recipe multiplier, total capacity, minimum load, waiting days]
export const PRODUCTION_CAPACITY_REVISIONS = Object.freeze([
  ["cheesery", "aged-cheese", 10, 240, 8, 30],
  ["brewery", "alcohol-brewed-cheap-weak", 4, 160, 8, 10],
  ["brewery", "alcohol-brewed-fine-weak", 4, 128, 8, 20],
  ["winery", "alcohol-wine-cheap-weak", 20, 160, 1, 30],
  ["winery", "alcohol-wine-fine-weak", 20, 200, 1, 90],
  ["tannery", "leather", 15, 150, 1, 30],
  ["smokehouse", "dried-fruit", 2, 48, 12, 1],
  ["brickworks", "bricks", 10, 120, 4, 5]
].map((row) => Object.freeze(row)));

function enlargeRecipe(line, multiplier) {
  if (line.expenseMode !== "cycle") throw new Error("Capacity revision requires a cycle recipe.");
  line.expenses = String(line.expenses).split(/\s*,\s*/).filter(Boolean).map((part) => {
    const match = /^([a-z0-9-]+)\s+(\d+)$/.exec(part);
    if (!match) throw new Error(`Unsupported capacity recipe: ${part}`);
    return `${match[1]} ${Number(match[2]) * multiplier}`;
  }).join(", ");
  line.costsText = line.expenses;
  line.outputQty *= multiplier;
  line.workQd *= multiplier;
}

export function buildingCatalogV19Templates() {
  return buildingCatalogV18Templates().map((source) => {
    const row = structuredClone(source);
    row.templateVersion = 19;
    applyStandardBuildingText(row, row.id);
    for (const [buildingId, resourceId, multiplier, capacity, minimum, days] of PRODUCTION_CAPACITY_REVISIONS) {
      if (row.id !== buildingId) continue;
      const line = row.productionLines.find((item) => item.resourceId === resourceId);
      if (!line) throw new Error(`Missing approved capacity recipe: ${buildingId}/${resourceId}`);
      enlargeRecipe(line, multiplier);
      Object.assign(line, { waitDays: days, batchCapacity: capacity, batchStartQty: minimum });
      row.notes = [row.notes, `${line.mode || line.resource}: до ${line.outputQty} ЕД. в партии, запуск от ${minimum} ЕД., общая вместимость ${capacity} ЕД. Сырьё и труд пропорциональны загрузке; после подготовки — ${days} дн. ожидания без труда. Партии выдерживаются независимо.`].filter(Boolean).join(" ");
    }
    return row;
  });
}
