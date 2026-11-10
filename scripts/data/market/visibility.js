import { transportOrders } from "../transport/state.js";

/** Index only the displayed log IDs; legacy aliases are data readers, never an execution path. */
export function marketLogSources(holding, rows) {
  const needed = new Set(rows.map(row => row.operationId)), sources = new Map();
  const legacy = [...(holding?.special?.market?.orders ?? []), ...(holding?.special?.market?.outbound?.orders ?? [])];
  for (const order of legacy) {
    const base = order.operationId || order.id;
    const aliases = [order.id, order.operationId, order.parentOperationId, order.deliveryOperationId, order.revenueOperationId,
      order.insuranceOperationId, order.riskResolutionOperationId, order.riskResolutionId, order.cancellationOperationId,
      order.cancelOperationId, ...(Array.isArray(order.historyOperationIds) ? order.historyOperationIds : []),
      ...(base ? [`${base}:arrival`, `${base}:revenue`, `${base}:insurance`] : [])];
    for (const id of aliases) if (id && needed.has(id)) sources.set(id, order);
  }
  for (const order of transportOrders(holding)) if (needed.has(order.id)) sources.set(order.id, order.commercial);
  return sources;
}

/** Role-aware labels for saved market operations. Unknown catalog context cannot disclose a saved private name. */
export function createMarketVisibility(data, { isGM = false } = {}) {
  const countries = new Map((data?.catalog?.marketEconomy?.countries ?? []).map(row => [row.id, row]));
  const regions = new Map((data?.catalog?.eventRegions ?? []).map(row => [row.value, row]));
  const companies = new Map((data?.catalog?.marketEconomy?.organizations ?? []).map(row => [row.id, row]));
  const countryHidden = id => !isGM && countries.get(id)?.visibility === "gm";
  const regionHidden = id => countryHidden(regions.get(String(id).replace(/:holding$/, ""))?.countryId);
  const pointHidden = id => !isGM && (!regions.has(String(id).replace(/:holding$/, "")) || regionHidden(id));
  const marketLabel = (commercial = {}) => {
    const label = commercial.marketLabel || "Внешний рынок";
    if (isGM) return label;
    const regionId = commercial.marketRegionId || String(commercial.marketId ?? "").replace(/^market-location:/, "");
    const countryId = commercial.countryId || regions.get(regionId)?.countryId;
    if (!data || (!regions.has(regionId) && !countries.has(countryId)) || countryHidden(countryId) || regionHidden(regionId)) return "Скрытый рынок";
    return label;
  };
  return {
    countryHidden, regionHidden, pointHidden, marketLabel,
    transportStageHidden(stage) {
      const companyId = stage.service.companyId;
      const company = companies.get(companyId);
      const externalCompany = companyId && companyId !== "independent-carriers" && !companyId.startsWith("owned:");
      return !isGM && (stage.service.visibility === "gm" || pointHidden(stage.from) || pointHidden(stage.to)
        || externalCompany && (!company || company.visibility === "gm"));
    },
    logSource(row, market) {
      if (market && row.source === market.marketLabel) return marketLabel(market);
      if (!isGM && String(row.kind ?? "").startsWith("market-")) {
        if (!market) return "Внешний рынок";
        if (marketLabel(market) === "Скрытый рынок") return "Скрытый рынок";
      }
      return row.source || "—";
    }
  };
}
