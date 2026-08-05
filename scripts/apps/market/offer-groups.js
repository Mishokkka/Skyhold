function normalizedId(value = "") {
  return String(value ?? "").trim();
}

export function merchantAbbreviation(label = "") {
  const words = String(label ?? "").normalize("NFKC").trim().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return "—";
  if (words.length === 1) return [...words[0]].slice(0, 3).join("").toLocaleUpperCase("ru");
  return words.slice(0, 4).map((word) => [...word][0] ?? "").join("").toLocaleUpperCase("ru");
}

export function merchantTone(providerId = "", toneCount = 6) {
  const count = Math.max(1, Math.floor(Number(toneCount) || 1));
  let hash = 0;
  for (const character of String(providerId ?? "")) hash = ((hash * 31) + character.codePointAt(0)) >>> 0;
  return hash % count;
}

export function marketOfferGroupTotals(offers = [], quantities = {}) {
  let totalQty = 0;
  let totalCopper = 0;
  let providerCount = 0;
  for (const offer of offers ?? []) {
    const stock = Math.max(0, Math.floor(Number(offer?.stock) || 0));
    const qty = Math.max(0, Math.min(stock, Math.floor(Number(quantities?.[offer?.id]) || 0)));
    if (qty > 0) providerCount += 1;
    totalQty += qty;
    totalCopper += qty * Math.max(0, Math.floor(Number(offer?.unitPriceCopper) || 0));
  }
  return { totalQty, totalCopper, providerCount };
}

/**
 * Collapse provider allocations into one product row while retaining the
 * concrete quote line that pricing and delivery must purchase.
 */
export function groupMarketOffers(offers = [], providerSelections = {}) {
  const groups = new Map();
  for (const offer of offers ?? []) {
    const sourceOfferId = normalizedId(offer?.sourceOfferId ?? offer?.id);
    if (!sourceOfferId) continue;
    if (!groups.has(sourceOfferId)) groups.set(sourceOfferId, []);
    groups.get(sourceOfferId).push(offer);
  }

  return [...groups.entries()].map(([sourceOfferId, providerOffers]) => {
    const selectedProviderId = normalizedId(providerSelections?.[sourceOfferId]);
    const selectedOffer = providerOffers.find((offer) => normalizedId(offer?.providerId) === selectedProviderId)
      ?? providerOffers.find((offer) => offer?.providerIndependent)
      ?? providerOffers[0];
    return {
      sourceOfferId,
      offers: providerOffers,
      selectedOffer
    };
  });
}
