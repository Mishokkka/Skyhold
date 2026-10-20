import { workerAttribute, workerBackgroundMatches, workerHasTrait } from "./building-qualification.js";

export function sellerUnitSalePrice(baseCopper = 0, efficiency = 1) {
  const base = Math.max(0, Math.floor(Number.isFinite(Number(baseCopper)) ? Number(baseCopper) : 0));
  const eff = Math.max(0, Number.isFinite(Number(efficiency)) ? Number(efficiency) : 1);
  return base ? Math.max(1, Math.floor(base * 0.5 * eff)) : 0;
}

/** One ordinary seller = 50% of base price; ability changes price, not headcount. */
export function sellerQualification(person = {}) {
  const parts = [
    { label: "Опыт торговли", value: workerBackgroundMatches(person, ["ТОРГОВЛЯ"]) ? 0.5 : 0 },
    { label: "Разум", value: Math.max(0, Math.min(2, workerAttribute(person, "wits") - 3)) * 0.25 },
    { label: "Эмпатия", value: Math.max(0, Math.min(2, workerAttribute(person, "empathy") - 3)) * 0.25 },
    { label: "Бережливость", value: workerHasTrait(person, "Бережливый") ? 0.25 : 0 },
    { label: "Грамотность", value: workerHasTrait(person, "Грамотный") ? 0.25 : 0 }
  ];
  return { efficiency: Math.min(3, 1 + parts.reduce((sum, part) => sum + part.value, 0)), parts };
}
