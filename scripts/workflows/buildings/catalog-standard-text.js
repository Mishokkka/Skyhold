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
