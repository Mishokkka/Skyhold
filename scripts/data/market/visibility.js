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
  // Fleet overviews with home/legacy ships need no world-market data. Build
  // only the metadata index actually used, once per read-only projection.
  let countries, regions, companies;
  const countryRows = () => countries ??= new Map((data?.catalog?.marketEconomy?.countries ?? []).map(row => [row.id, row]));
  const regionRows = () => regions ??= new Map((data?.catalog?.eventRegions ?? []).map(row => [row.value, row]));
  const companyRows = () => companies ??= new Map((data?.catalog?.marketEconomy?.organizations ?? []).map(row => [row.id, row]));
  const countryHidden = id => !isGM && countryRows().get(id)?.visibility === "gm";
  const regionHidden = id => !isGM && countryHidden(regionRows().get(String(id).replace(/:holding$/, ""))?.countryId);
  const pointHidden = id => !isGM && (!regionRows().has(String(id).replace(/:holding$/, "")) || regionHidden(id));
  const marketHidden = (commercial = {}) => {
    if (isGM) return false;
    const regionId = commercial.marketRegionId || String(commercial.marketId ?? "").replace(/^market-location:/, "");
    const countryId = commercial.countryId || regionRows().get(regionId)?.countryId;
    return !data || (!regionRows().has(regionId) && !countryRows().has(countryId)) || countryHidden(countryId) || regionHidden(regionId);
  };
  const marketLabel = (commercial = {}) => marketHidden(commercial) ? "Скрытый рынок" : commercial.marketLabel || "Внешний рынок";
  const savedPointHidden = point => point?.kind === "market" && pointHidden(point.regionId || point.id);
  const pointLabel = (point, fallback = "—") => savedPointHidden(point) ? "Скрытый рынок" : point?.label || fallback;
  const routeHidden = route => [route?.from, route?.contract?.pickup, route?.to].some(savedPointHidden);
  return {
    countryHidden, regionHidden, pointHidden, marketHidden, marketLabel, pointLabel, routeHidden,
    transportStageHidden(stage) {
      if (isGM) return false;
      const companyId = stage.service.companyId;
      const externalCompany = companyId && companyId !== "independent-carriers" && !companyId.startsWith("owned:");
      const company = externalCompany ? companyRows().get(companyId) : null;
      return stage.service.visibility === "gm" || pointHidden(stage.from) || pointHidden(stage.to)
        || Boolean(externalCompany && (!company || company.visibility === "gm"));
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
