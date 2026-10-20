import { contractGuidance } from "./contracts.js";

/** Integer shares in input order, with equal remainders settled by stable offer ID. */
export function bundleOperatingShares(offers, totalCopper) {
  if (!Number.isSafeInteger(totalCopper) || totalCopper < 0 || !offers?.length) {
    throw new Error("Некорректные расходы составного рейса.");
  }
  const rows = offers.map((offer) => {
    const load = Number(offer?.contract?.cargo?.loadPoints);
    if (!Number.isSafeInteger(load) || load <= 0) throw new Error("Некорректный груз составного рейса.");
    return { id: String(offer.id), load: BigInt(load) };
  });
  const totalLoad = rows.reduce((sum, row) => sum + row.load, 0n);
  for (const row of rows) {
    const numerator = BigInt(totalCopper) * row.load;
    row.share = Number(numerator / totalLoad);
    row.remainder = numerator % totalLoad;
  }
  let remaining = totalCopper - rows.reduce((sum, row) => sum + row.share, 0);
  const ranked = [...rows].sort((a, b) => a.remainder === b.remainder
    ? a.id.localeCompare(b.id) : a.remainder > b.remainder ? -1 : 1);
  for (const row of ranked) {
    if (remaining <= 0) break;
    row.share++;
    remaining--;
  }
  return rows.map((row) => row.share);
}

/** Derived from the accepted snapshot; no new persisted fields or load-time repair. */
export function bundleOutcomeReserves(offers, totalCopper) {
  const firstAtPort = new Map();
  for (const offer of [...offers].sort((a, b) => Number(b.contract.kind === "smuggling") - Number(a.contract.kind === "smuggling") || String(a.id).localeCompare(String(b.id)))) {
    const key = `${offer.to?.kind ?? ""}:${offer.to?.id ?? offer.contract.destination}`;
    if (!firstAtPort.has(key)) firstAtPort.set(key, offer.id);
  }
  return bundleOperatingShares(offers, totalCopper).map((share, index) => {
    const offer = offers[index];
    const key = `${offer.to?.kind ?? ""}:${offer.to?.id ?? offer.contract.destination}`;
    const commercialOnly = firstAtPort.get(key) !== offer.id;
    const contract = { ...offers[index].contract,
      guidance: { ...offers[index].contract.guidance, operatingCopper: share, preparationCopper: 0 } };
    return Math.max(...["cautious", "normal", "bold"].map((style) =>
      contractGuidance(contract, style, { commercialOnly }).suggestedBudgetCopper - share));
  });
}
