const number = (value, fallback, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Number(value) : fallback));
const depositPresets = (rate, days) => [
  { id: "reserve", name: "Счёт хранения", kind: "storage", annualRateBps: 0, termDays: 0, limitCopper: 100000000, minimumRelationship: -100 },
  { id: "term", name: "Срочный вклад", kind: "term", annualRateBps: rate, termDays: days, limitCopper: 100000000, minimumRelationship: 0 }
];
export const BANK_PRESETS = Object.freeze([
  { id: "merchant", name: "Купеческий учётный дом", description: "Краткосрочное содержание торгового оборота. Аналог коммерческих векселей; ставки являются игровыми.",
    depositOffers: depositPresets(300, 60), offers: [{ id: "working-capital", name: "Оборотный заём", annualRateBps: 1000, termDays: 60, feeBps: 100, limitCopper: 20000, minimumRelationship: -20 }] },
  { id: "land", name: "Земельный банк", description: "Долгосрочное развитие хозяйства под поручительство владельца. Поручительство разыгрывается GM, без автоматического изъятия имущества.",
    depositOffers: depositPresets(400, 240), offers: [{ id: "estate", name: "Хозяйственный заём", annualRateBps: 700, termDays: 240, feeBps: 200, limitCopper: 60000, minimumRelationship: 0 }] },
  { id: "private", name: "Частный банкир", description: "Небольшой доступный заём с высокой ставкой и коротким сроком.",
    depositOffers: depositPresets(200, 30), offers: [{ id: "urgent", name: "Неотложное содержание", annualRateBps: 2000, termDays: 30, feeBps: 0, limitCopper: 6000, minimumRelationship: -50 }] }
]);
export function normalizeBank(raw = {}) {
  return {
    id: String(raw.id ?? "").slice(0, 100), name: String(raw.name ?? "Банк").slice(0, 160),
    description: String(raw.description ?? "").slice(0, 3000), active: raw.active !== false,
    depositOffers: (Array.isArray(raw.depositOffers) ? raw.depositOffers : []).slice(0, 20).map((offer) => ({
      id: String(offer.id ?? "").slice(0, 100), name: String(offer.name ?? "Вклад").slice(0, 160), active: offer.active !== false,
      kind: offer.kind === "storage" ? "storage" : "term",
      annualRateBps: offer.kind === "storage" ? 0 : Math.round(number(offer.annualRateBps, 300, 0, 10000)),
      termDays: offer.kind === "storage" ? 0 : Math.round(number(offer.termDays, 60, 1, 2400)),
      limitCopper: Math.round(number(offer.limitCopper, 100000000, 1, 100000000)),
      minimumRelationship: Math.round(number(offer.minimumRelationship, 0, -100, 100))
    })).filter((offer, i, rows) => offer.id && rows.findIndex((other) => other.id === offer.id) === i),
    offers: (Array.isArray(raw.offers) ? raw.offers : []).slice(0, 20).map((offer) => ({
      id: String(offer.id ?? "").slice(0, 100), name: String(offer.name ?? "Заём").slice(0, 160), active: offer.active !== false,
      annualRateBps: Math.round(number(offer.annualRateBps, 1000, 0, 10000)),
      termDays: Math.round(number(offer.termDays, 60, 1, 2400)),
      feeBps: Math.round(number(offer.feeBps, 0, 0, 5000)),
      limitCopper: Math.round(number(offer.limitCopper, 10000, 1, 100000000)),
      minimumRelationship: Math.round(number(offer.minimumRelationship, 0, -100, 100))
    })).filter((offer, i, rows) => offer.id && rows.findIndex((other) => other.id === offer.id) === i)
  };
}
export function bankCatalog(data = {}) {
  const seen = new Set();
  return (Array.isArray(data?.catalog?.banks) ? data.catalog.banks : [])
    .map(normalizeBank).filter((row) => row.id && !seen.has(row.id) && seen.add(row.id));
}

// Editor validation deliberately precedes the defensive loading normalizer.
export function validateBankCatalog(banks) {
  for (const bank of banks) {
    if (!bank.name?.trim() || bank.name.length > 160) return "Название банка должно содержать от 1 до 160 символов.";
    for (const [key, deposits] of [["offers", false], ["depositOffers", true]]) {
      if ((bank[key]?.length ?? 0) > 20) return "У банка может быть до 20 предложений каждого вида.";
      for (const offer of bank[key] ?? []) {
        const label = `${bank.name}: ${offer.name || "предложение"}`;
        if (!offer.name?.trim() || offer.name.length > 160) return `${label}: укажите название до 160 символов.`;
        const ranges = [["limitCopper", 1, 100000000], ["minimumRelationship", -100, 100]];
        if (!deposits || offer.kind !== "storage") ranges.push(["annualRateBps", 0, 10000], ["termDays", 1, 2400]);
        if (!deposits) ranges.push(["feeBps", 0, 5000]);
        for (const [field, min, max] of ranges) {
          if (!Number.isSafeInteger(offer[field]) || offer[field] < min || offer[field] > max) return `${label}: проверьте ставку (0–100%), срок (1–2400 дней), комиссию (0–50%), лимит и отношение.`;
        }
      }
    }
  }
  return "";
}
