import { allResourceDefs } from "../../core/resources.js";
import { normalizeMarketEconomy } from "../../data/market/economy.js";
import { selectMarketPurchaseCargo } from "../../engines/market/pricing.js";
import { availableAuthorityMarkets, authorityMarketQuote } from "./authority-context.js";
import { prepareMarketOutboundContext } from "./outbound-context.js";

/** Goods, stock, demand and FIFO selection; physical eligibility belongs to v2. */
export function prepareTransportCommerce({ data, holding, request = {}, isGM = false, searchBudget = null }) {
  const economy = normalizeMarketEconomy(data?.catalog?.marketEconomy, { locations: data?.catalog?.eventRegions ?? [] });
  const resources = allResourceDefs({ catalogRows: data?.catalog?.resources });
  const markets = availableAuthorityMarkets(data, { holding, isGM, economy, resources });
  const market = markets.find(row => row.id === String(request.marketId ?? ""));
  if (!market) throw new Error("Этот рынок недоступен поселению.");
  const quote = authorityMarketQuote({ data, holding, market, isGM, economy, resources, discoverTransport: true, searchBudget });
  const outbound = request.direction === "outbound" ? prepareMarketOutboundContext({
    holding, quote, resourceDefinitions: resources,
    organizations: economy.organizations.filter(row => isGM || row.visibility !== "gm"),
    quantities: request.quantities
  }) : null;
  const plan = request.direction === "outbound" ? null : selectMarketPurchaseCargo({
    quote, quantities: request.quantities, targetRoomId: request.targetRoomId
  });
  return { market, markets, quote, plan, outbound, economy, resources };
}
