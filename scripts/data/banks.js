const number = (value, fallback, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Number(value) : fallback));
export const BANK_PRESETS = Object.freeze([
  { id: "merchant", name: "Купеческий учётный дом", description: "Краткосрочное содержание торгового оборота. Аналог коммерческих векселей; ставки являются игровыми.",
    offers: [{ id: "working-capital", name: "Оборотный заём", annualRateBps: 1000, termDays: 60, feeBps: 100, limitCopper: 20000, minimumRelationship: -20 }] },
  { id: "land", name: "Земельный банк", description: "Долгосрочное развитие хозяйства под поручительство владельца. Поручительство разыгрывается GM, без автоматического изъятия имущества.",
    offers: [{ id: "estate", name: "Хозяйственный заём", annualRateBps: 700, termDays: 240, feeBps: 200, limitCopper: 60000, minimumRelationship: 0 }] },
  { id: "private", name: "Частный банкир", description: "Небольшой доступный заём с высокой ставкой и коротким сроком.",
    offers: [{ id: "urgent", name: "Неотложное содержание", annualRateBps: 2000, termDays: 30, feeBps: 0, limitCopper: 6000, minimumRelationship: -50 }] }
]);
export function normalizeBank(raw = {}) {
  return {
    id: String(raw.id ?? "").slice(0, 100), name: String(raw.name ?? "Банк").slice(0, 160),
    description: String(raw.description ?? "").slice(0, 3000), active: raw.active !== false,
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
  return (Array.isArray(data?.catalog?.banks) ? data.catalog.banks : [])
    .map(normalizeBank).filter((row, i, rows) => row.id && rows.findIndex((other) => other.id === row.id) === i);
}
