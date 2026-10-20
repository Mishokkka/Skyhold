const CURRENCY_MULTIPLIERS = Object.freeze({
  C: 1,
  S: 10,
  G: 100,
  ММ: 1,
  СМ: 10,
  ЗМ: 100
});

/**
 * Parse the compact Forbidden Lands currency notation into copper coins.
 *
 * A denomination is deliberately required. Plain numbers and prose are not
 * interpreted as prices, which keeps legacy catalog migration deterministic.
 */
export function parseCurrencyCopper(value = "", fallback = 0) {
  const text = String(value ?? "").normalize("NFKC").toUpperCase();
  const pattern = /([-+]?\d+(?:[.,]\d+)?)\s*(ЗМ|СМ|ММ|G|S|C)(?=$|[\s,;+/])/gu;
  let matched = false;
  let total = 0;
  for (const match of text.matchAll(pattern)) {
    const amount = Number(String(match[1]).replace(",", "."));
    const multiplier = CURRENCY_MULTIPLIERS[match[2]];
    if (!Number.isFinite(amount) || !multiplier) continue;
    matched = true;
    total += amount * multiplier;
  }
  if (!matched || !Number.isFinite(total)) return Math.max(0, Math.round(Number(fallback) || 0));
  return Math.max(0, Math.round(total));
}

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
