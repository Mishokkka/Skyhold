import { buildingCatalogV18Templates } from "./building-template-revision-v18.js";

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
