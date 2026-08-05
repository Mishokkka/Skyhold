export function formatCopperCurrency(value = 0) {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  const gold = Math.floor(total / 100);
  const silver = Math.floor((total % 100) / 10);
  const copper = total % 10;
  const parts = [];
  if (gold) parts.push(`${gold} ЗМ`);
  if (silver) parts.push(`${silver} СМ`);
  if (copper || !parts.length) parts.push(`${copper} ММ`);
  return parts.join(" ");
}

export function copperCurrencyParts(value = 0) {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  const denominations = [
    { value: Math.floor(total / 100), label: "З", tone: "gold" },
    { value: Math.floor((total % 100) / 10), label: "С", tone: "silver" },
    { value: total % 10, label: "М", tone: "copper" }
  ];
  const visible = denominations.filter((part) => part.value > 0);
  return visible.length ? visible : [denominations[2]];
}

export function formatCopperCurrencyCompact(value = 0) {
  return copperCurrencyParts(value).map((part) => `${part.value} ${part.label}`).join(" ");
}

/**
 * Parse the compact Forbidden Lands-style cost notation into whole copper.
 *
 * Supported examples: `6 C`, `2 S`, `1 G`, `1 G 2 S 3 C`, as well as the
 * Russian abbreviations used by the Skyhold UI. This is deliberately kept in
 * the currency core so resource, market and treasury code cannot drift into
 * separate parsers again.
 */
export function parseCopperCurrency(value = "") {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  const text = String(value ?? "").trim();
  if (!text) return 0;

  let total = 0;
  let matched = false;
  const rx = /([-+]?\d+(?:[.,]\d+)?)\s*([a-zA-Zа-яА-Я]+)?/g;
  for (const match of text.matchAll(rx)) {
    const amount = Number(String(match[1]).replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const unit = String(match[2] ?? "C").trim().toLowerCase();
    let multiplier = 1;
    if (["g", "gp", "gold", "з", "зм"].includes(unit)) multiplier = 100;
    else if (["s", "sp", "silver", "с", "см"].includes(unit)) multiplier = 10;
    else if (!["c", "cp", "copper", "м", "мм"].includes(unit)) continue;
    total += amount * multiplier;
    matched = true;
  }

  if (!matched) {
    const fallback = Number(text.replace(",", ".").replace(/[^0-9.+-]/g, ""));
    return Number.isFinite(fallback) ? Math.max(0, Math.floor(fallback)) : 0;
  }
  return Math.max(0, Math.floor(total));
}

/**
 * Compatibility representation for the Forbidden Lands item cost field.
 * Exact denominations stay compact; mixed values remain copper so old item
 * parsers that accept a single denomination continue to work.
 */
export function formatForbiddenLandsCost(value = 0) {
  const copper = Math.max(0, Math.floor(Number(value) || 0));
  if (copper > 0 && copper % 100 === 0) return `${copper / 100} G`;
  if (copper > 0 && copper % 10 === 0) return `${copper / 10} S`;
  return `${copper} C`;
}
