const SCORE_PRECISION = 1000;

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundScore(value) {
  return Math.round(finiteNumber(value, 0) * SCORE_PRECISION) / SCORE_PRECISION;
}

function signed(value) {
  const number = finiteNumber(value, 0);
  return `${number > 0 ? "+" : ""}${String(number).replace(".", ",")}`;
}

function normalizeModifierEntries(value) {
  if (Array.isArray(value)) {
    return value.map((entry, index) => ({
      id: String(entry?.id ?? `modifier-${index + 1}`),
      label: String(entry?.label ?? entry?.id ?? `Модификатор ${index + 1}`),
      value: roundScore(entry?.value)
    }));
  }

  if (value && typeof value === "object") {
    return Object.entries(value).map(([id, entry]) => ({
      id,
      label: String(entry?.label ?? id),
      value: roundScore(entry && typeof entry === "object" ? entry.value : entry)
    }));
  }

  const number = roundScore(value);
  return number ? [{ id: "settlement", label: "Поселение", value: number }] : [];
}

function frozenModifiers({
  productionEfficiency = 0,
  constructionEfficiency = 1,
  constructionDice = 0,
  reputation = 0,
  defense = 0
} = {}) {
  return Object.freeze({
    productionEfficiency,
    constructionEfficiency,
    constructionDice,
    reputation,
    defense
  });
}

const BAND_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "riot",
    label: "Бунты",
    range: "ниже -3",
    icon: "fa-solid fa-face-angry",
    css: "riot",
    upperBound: -3,
    upperInclusive: false,
    modifiers: frozenModifiers({ productionEfficiency: -0.5, constructionEfficiency: 0.5, constructionDice: -3, reputation: -1, defense: -1 })
  }),
  Object.freeze({
    id: "discontent",
    label: "Недовольство",
    range: "от -3 до -1,5",
    icon: "fa-solid fa-face-frown",
    css: "bad",
    upperBound: -1.5,
    upperInclusive: true,
    modifiers: frozenModifiers({ productionEfficiency: -0.5, constructionEfficiency: 0.5, constructionDice: -2, reputation: -1, defense: -1 })
  }),
  Object.freeze({
    id: "apathy",
    label: "Апатия",
    range: "выше -1,5, но ниже 0",
    icon: "fa-solid fa-face-meh",
    css: "low",
    upperBound: 0,
    upperInclusive: false,
    modifiers: frozenModifiers({ productionEfficiency: -0.2, constructionEfficiency: 0.5, reputation: -1, defense: -1 })
  }),
  Object.freeze({
    id: "stable",
    label: "Без штрафов и бонусов",
    range: "от 0 до 1,5",
    icon: "fa-solid fa-face-smile",
    css: "neutral",
    upperBound: 1.5,
    upperInclusive: true,
    modifiers: frozenModifiers()
  }),
  Object.freeze({
    id: "hope",
    label: "Надежда",
    range: "выше 1,5, но не выше 3",
    icon: "fa-solid fa-face-grin-stars",
    css: "hope",
    upperBound: 3,
    upperInclusive: true,
    modifiers: frozenModifiers({ productionEfficiency: 0.2, constructionDice: 1, reputation: 1, defense: 1 })
  }),
  Object.freeze({
    id: "home",
    label: "Дом",
    range: "выше 3",
    icon: "fa-solid fa-face-laugh-beam",
    css: "home",
    upperBound: Number.POSITIVE_INFINITY,
    upperInclusive: true,
    modifiers: frozenModifiers({ productionEfficiency: 0.2, constructionDice: 2, reputation: 1, defense: 1 })
  })
]);

export function describeMoraleModifiers(modifiers = {}) {
  const normalized = frozenModifiers(modifiers);
  const parts = [];

  if (normalized.productionEfficiency) {
    parts.push(`Производство: ${signed(normalized.productionEfficiency)} к эффективности`);
  }

  if (normalized.constructionEfficiency !== 1 || normalized.constructionDice) {
    const construction = [];
    if (normalized.constructionEfficiency !== 1) {
      construction.push(`×${String(normalized.constructionEfficiency).replace(".", ",")}`);
    }
    if (normalized.constructionDice) construction.push(`${signed(normalized.constructionDice)}к6`);
    parts.push(`Строительство: ${construction.join(", затем ")}`);
  }

  if (normalized.reputation) parts.push(`Репутация: ${signed(normalized.reputation)}`);
  if (normalized.defense) parts.push(`Защищённость: ${signed(normalized.defense)}`);

  return parts.length ? `${parts.join(". ")}.` : "Механических модификаторов нет.";
}

function publicBand(definition) {
  return Object.freeze({
    id: definition.id,
    label: definition.label,
    range: definition.range,
    icon: definition.icon,
    css: definition.css,
    modifiers: definition.modifiers,
    notes: describeMoraleModifiers(definition.modifiers)
  });
}

export const MORALE_BANDS = Object.freeze(BAND_DEFINITIONS.map(publicBand));
const BANDS_BY_ID = new Map(MORALE_BANDS.map((band) => [band.id, band]));

export function moraleBandForScore(value = 0) {
  const score = finiteNumber(value, 0);
  const index = BAND_DEFINITIONS.findIndex((band) => (
    band.upperInclusive ? score <= band.upperBound : score < band.upperBound
  ));
  return MORALE_BANDS[Math.max(0, index)];
}

export function moraleBandById(id = "stable") {
  return BANDS_BY_ID.get(String(id)) ?? BANDS_BY_ID.get("stable");
}

export function calculateMoraleSnapshot({
  residents = [],
  residentScore = (resident) => resident?.morale ?? 0,
  settlementModifiers = []
} = {}) {
  const livingResidents = (Array.isArray(residents) ? residents : []).filter((resident) => !resident?.dead);
  const residentScores = livingResidents.map((resident) => {
    const result = residentScore(resident);
    return roundScore(result && typeof result === "object" ? result.total : result);
  });
  const residentTotal = roundScore(residentScores.reduce((sum, value) => sum + value, 0));
  const residentAverage = livingResidents.length ? roundScore(residentTotal / livingResidents.length) : 0;
  const modifierEntries = normalizeModifierEntries(settlementModifiers);
  const settlementModifier = roundScore(modifierEntries.reduce((sum, entry) => sum + entry.value, 0));
  const score = roundScore(residentAverage + settlementModifier);
  const band = moraleBandForScore(score);

  return {
    score,
    value: score,
    livingCount: livingResidents.length,
    residentTotal,
    residentAverage,
    settlementModifier,
    settlementModifiers: modifierEntries,
    bandId: band.id,
    band,
    modifiers: band.modifiers,
    description: band.notes
  };
}

export function applyMoraleToConstructionDice(rawDice = 0, morale = null) {
  const base = Math.max(0, finiteNumber(rawDice, 0));
  const modifiers = morale?.modifiers ?? morale?.band?.modifiers ?? moraleBandForScore(morale?.score ?? morale).modifiers;
  const scaled = Math.ceil(base * finiteNumber(modifiers?.constructionEfficiency, 1));
  return Math.max(0, scaled + finiteNumber(modifiers?.constructionDice, 0));
}
