import { normalizeMarketEconomy } from "../../data/market/economy.js";
import { marketLocationFactors } from "../market/composition.js";
import { holdingMarketAccessLevel, marketRegionAccessCostMap, resolveMarketLogistics } from "../market/logistics.js";

const resolving = new WeakSet();

/** A real external link must satisfy URS, transport modes and trading restrictions. */
export function politicsRouteAvailable(holding, data = {}, { marketAccess = 0 } = {}) {
  if (!holding || resolving.has(holding)) return false;
  const regions = data?.catalog?.eventRegions ?? [];
  if (!regions.length) return false;
  resolving.add(holding);
  try {
    const costs = marketRegionAccessCostMap({ holding, regions });
    const access = holdingMarketAccessLevel(holding, { politicsMarketAccess: marketAccess }).level;
    const economy = normalizeMarketEconomy(data.catalog?.marketEconomy, { locations: regions });
    return regions.some((region) => {
      const cost = costs.get(String(region.value));
      if (!Number.isFinite(cost) || cost <= 0 || cost > access) return false;
      return resolveMarketLogistics({ holding, regions, accessLevel: access, market: { regionId: region.value, transportModes: region.marketTransportModes },
        dependencies: { regionFactors: (source) => marketLocationFactors(source, economy, regions, { normalizedEconomy: true }) } }).ok;
    });
  } finally { resolving.delete(holding); }
}
