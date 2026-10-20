import { workerTypeFromAttributes } from "../../generators/resident-rules.js";

export function normalizeProfileModifiers(value) {
  if (!value || typeof value !== "object") return null;
  return Object.fromEntries(["types", "backgrounds", "traits"].map((key) => [key,
    (Array.isArray(value[key]) ? value[key] : []).map((row) => ({
      match: String(row?.match ?? "").trim(),
      percent: Number.isFinite(Number(row?.percent)) ? Math.max(-100, Math.min(1000, Math.trunc(Number(row.percent)))) : 0
    }))
  ]));
}

export function defaultProfileModifiers(profile) {
  if (!profile?.production && !profile?.modifiers) return { types: [], backgrounds: [], traits: [] };
  return normalizeProfileModifiers(profile?.modifiers ?? {
    types: [...(profile?.optimalSelectors ?? []).map((match) => ({ match, percent: 50 })), ...(profile?.suitableSelectors ?? []).map((match) => ({ match, percent: 25 }))],
    backgrounds: (profile?.production?.backgroundGroups ?? []).map((group) => ({ match: `group:${group}`, percent: 10 })),
    traits: [...(profile?.production?.positiveTraits ?? []).map((match) => ({ match, percent: 10 })), ...(profile?.production?.negativeTraits ?? []).map((match) => ({ match, percent: -10 }))]
  });
}

export function profileModifierQualification(modifiers, person, { selectorMatches, backgroundMatches, hasTrait, normalizeText }) {
  const type = modifiers.types.find((row) => row.match && (row.match.startsWith("type:")
    ? workerTypeFromAttributes(person.attributes) === row.match.slice(5) : selectorMatches(person, row.match)));
  const background = modifiers.backgrounds.find((row) => row.match && (row.match.startsWith("group:")
    ? backgroundMatches(person, [row.match.slice(6)]) : normalizeText(person.background) === normalizeText(row.match)));
  const positive = modifiers.traits.find((row) => row.percent > 0 && row.match && hasTrait(person, row.match));
  const negative = modifiers.traits.find((row) => row.percent < 0 && row.match && hasTrait(person, row.match));
  const units = (row) => (row?.percent ?? 0) * 100;
  return {
    workUnits: Math.max(0, 10000 + units(type) + units(background) + units(positive) + units(negative)),
    typeUnits: units(type), backgroundUnits: units(background), positiveTraitUnits: units(positive), negativeTraitUnits: units(negative),
    matchedSelector: type?.match ?? "", matchedBackground: Boolean(background), matchedPositiveTrait: positive?.match ?? "", matchedNegativeTrait: negative?.match ?? "",
    details: [type, background, positive, negative].filter(Boolean).map((row) => `${row.match.replace(/^(type|group):/, "")} ${row.percent >= 0 ? "+" : ""}${row.percent}%`)
  };
}
