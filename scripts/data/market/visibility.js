/** Role-aware labels for saved market operations. Unknown catalog context cannot disclose a saved private name. */
export function createMarketVisibility(data, { isGM = false } = {}) {
  const countries = new Map((data?.catalog?.marketEconomy?.countries ?? []).map(row => [row.id, row]));
  const regions = new Map((data?.catalog?.eventRegions ?? []).map(row => [row.value, row]));
  const countryHidden = id => !isGM && countries.get(id)?.visibility === "gm";
  const regionHidden = id => countryHidden(regions.get(String(id).replace(/:holding$/, ""))?.countryId);
  return {
    countryHidden, regionHidden,
    marketLabel(commercial = {}) {
      const label = commercial.marketLabel || "Внешний рынок";
      if (isGM) return label;
      const regionId = commercial.marketRegionId || String(commercial.marketId ?? "").replace(/^market-location:/, "");
      const countryId = commercial.countryId || regions.get(regionId)?.countryId;
      if (!data || !regions.has(regionId) && !countries.has(countryId) || countryHidden(countryId) || regionHidden(regionId)) return "Скрытый рынок";
      return label;
    }
  };
}
