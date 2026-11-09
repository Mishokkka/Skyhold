import { allResourceDefs } from "../../core/resources.js";
import { normalizeMarketEconomy } from "../../data/market/economy.js";
import { marketRegionForValue } from "../../data/market/region-market.js";
import { stableDataHash } from "../../data/storage-commit.js";
import { effectiveMarketLocations, marketLocationFactors } from "../../engines/market/composition.js";
import {
  holdingMarketAccessLevel,
  marketRegionAccessCostMap
} from "../../engines/market/logistics.js";
import { planMarketPurchase, prepareMarketOutboundQuote, prepareMarketQuote } from "../../engines/market/pricing.js";
import {
  allocateQuoteToMerchantProviders,
} from "../../engines/market/providers.js";
import { AUTO_CARRIERS, planMarketTransport } from "../../engines/market/transport-planner.js";
import { overlayMarketQuoteStock } from "../../engines/market/stock.js";
import { getCalendariaSeasonSnapshot } from "../../integrations/calendaria-bridge.js";
import { marketOutboundRouteFromPurchasePlan, prepareMarketOutboundContext } from "./outbound-context.js";
import { transportRelevantHolding } from "../../data/transport/state.js";

function marketSeasonId(holding = {}) {
  const calendaria = holding?.gm?.calendaria ?? {};
  const snapshot = getCalendariaSeasonSnapshot(calendaria.lastDateTime, calendaria.lastDateText);
  return String(snapshot?.season?.key ?? "").trim();
}

export function marketAuthoritySourceToken({ data, holding, marketId = "", carrierId = "" } = {}) {
  return stableDataHash({
    holding: transportRelevantHolding(holding),
    sharedMarkets: data?.meta?.sharedMarkets,
    eventRegions: data?.catalog?.eventRegions,
    marketEconomy: data?.catalog?.marketEconomy,
    marketRouteMap: data?.catalog?.marketRouteMap,
    resources: data?.catalog?.resources,
    marketId: String(marketId ?? ""),
    carrierId: String(carrierId ?? "")
  });
}

export function availableAuthorityMarkets(data, {
  holding,
  isGM = false,
  economy: preparedEconomy = null,
  resources: preparedResources = null
} = {}) {
  const locations = data?.catalog?.eventRegions ?? [];
  const resources = preparedResources ?? allResourceDefs({ catalogRows: data?.catalog?.resources });
  const economy = preparedEconomy ?? normalizeMarketEconomy(data?.catalog?.marketEconomy, { locations });
  if (!holding) return [];
  const access = holdingMarketAccessLevel(holding);
  const accessByRegion = marketRegionAccessCostMap({
    holding,
    regions: locations,
    dependencies: { regionResolver: marketRegionForValue }
  });
  const reachableLocations = locations.filter((location) => {
    const routeAccessCost = accessByRegion.get(String(location?.value ?? ""));
    return Number.isFinite(routeAccessCost) && routeAccessCost <= access.level;
  });
  return effectiveMarketLocations({
    economy,
    locations: reachableLocations,
    resources,
    isGM,
    normalizedEconomy: true
  }).map((market) => {
    const routeAccessCost = accessByRegion.get(String(market.regionId ?? ""));
    return {
      ...market,
      routeAccessCost: Number.isFinite(routeAccessCost) ? routeAccessCost : null,
      offers: market.offers.filter((offer) => offer.active && (isGM || offer.visibility !== "gm"))
    };
  }).filter((market) => market.routeAccessCost !== null && market.routeAccessCost <= access.level);
}

export function authorityMarketLogistics({
  holding,
  data,
  market,
  carrierId = "",
  isGM = false,
  economy: preparedEconomy = null,
  direction = "inbound", preservePhysicalRoutes = false
} = {}) {
  if (!market) return { logistics: null, carriers: [], carrier: null };
  const locations = data?.catalog?.eventRegions ?? [];
  const economy = preparedEconomy ?? normalizeMarketEconomy(data?.catalog?.marketEconomy, { locations });
  return planMarketTransport({
    holding,
    market,
    regions: locations,
    organizations: economy.organizations,
    countries: economy.countries,
    carrierId: carrierId || AUTO_CARRIERS,
    isGM,
    seasonId: marketSeasonId(holding),
    direction,
    preservePhysicalRoutes,
    dependencies: {
      regionFactors: (region) => marketLocationFactors(region, economy, locations),
      regionResolver: marketRegionForValue
    }
  });
}

export function authorityMarketQuote({
  holding,
  data,
  market,
  carrierId = "",
  isGM = false,
  economy: preparedEconomy = null,
  resources: preparedResources = null,
  discoverTransport = false
} = {}) {
  if (!market) return null;
  const locations = data?.catalog?.eventRegions ?? [];
  const economy = preparedEconomy ?? normalizeMarketEconomy(data?.catalog?.marketEconomy, { locations });
  const resources = preparedResources ?? allResourceDefs({ catalogRows: data?.catalog?.resources });
  const { logistics, carriers, carrier } = authorityMarketLogistics({
    holding,
    data,
    market,
    carrierId,
    isGM,
    economy
  });
  // Discovery uses the regional lower bound: the selected vessel may take a
  // lower-access path than a hired carrier. V2 validates the actual full chain.
  const quote = overlayMarketQuoteStock({
    holding,
    quote: prepareMarketQuote({ holding, market, resources, location: market.locationProfile, logistics,
      offerAccessCost: discoverTransport ? market.routeAccessCost
        ?? marketRegionAccessCostMap({ holding, regions: locations, dependencies: { regionResolver: marketRegionForValue } }).get(String(market.regionId)) : null })
  });
  const allocated = allocateQuoteToMerchantProviders({
    offers: quote.offers,
    organizations: economy.organizations,
    countryId: market.countryId,
    quoteKey: quote.quoteKey,
    isGM
  });
  const outboundQuote = prepareMarketOutboundQuote({
    holding,
    market,
    resources,
    location: market.locationProfile,
    // Offer discovery must not inherit a pinned inbound chain's access cost.
    // The selected outbound/own-ship route validates the full URS requirement later.
    logistics: { ...logistics, routeAccessLevel: marketRegionAccessCostMap({ holding, regions: locations,
      dependencies: { regionResolver: marketRegionForValue } }).get(String(market.regionId)) ?? logistics.routeAccessLevel },
    inboundOffers: allocated.priceOffers
  });
  return {
    ...quote,
    countryId: String(market.countryId ?? ""),
    outboundOffers: outboundQuote.offers,
    offers: allocated.offers,
    merchantProviders: allocated.providers,
    carriers,
    selectedCarrierId: String(carrier?.id ?? "")
  };
}

export function authorityOutboundRoutes({ holding, data, market, economy, resources, offers = [], carriers = [], isGM = false,
  carrierId = AUTO_CARRIERS, preparedLogistics = null } = {}) {
  const selected = offers.filter((offer) => Math.max(0, Math.floor(Number(offer?.qty) || 0)) > 0);
  if (!holding || !market || !selected.length) return [];
  const transport = preparedLogistics ?? authorityMarketLogistics({ holding, data, market, carrierId, isGM, economy, direction: "outbound" }).logistics;
  const routeCarriers = transport?.transportPlan || transport?.routeCandidates?.some((row) => row.transportPlan)
    ? [{ id: "", label: "Составная перевозка", prepared: transport }] : carriers.length ? carriers : [null];
  const routes = [];
  for (const carrier of routeCarriers) {
    const { logistics } = carrier?.prepared ? { logistics: carrier.prepared } : authorityMarketLogistics({
      holding,
      data,
      market,
      carrierId: carrier?.id ?? "",
      isGM,
      economy,
      direction: "outbound"
    });
    if (logistics?.ok === false) continue;
    for (const candidate of logistics.routeCandidates?.length ? logistics.routeCandidates : [logistics]) {
      const difficulty = Math.max(0, ...selected.map((offer) => Number(offer.accessDifficulty) || 0));
      if (candidate.routeAccessCost + difficulty > candidate.accessLevel) continue;
      const prepared = prepareMarketQuote({
        holding,
        market,
        resources,
        location: market.locationProfile,
        logistics: candidate
      });
      const transportOffers = selected.map((offer) => ({
        ...offer,
        id: `outbound-route:${offer.resourceId}`,
        stock: offer.qty,
        load: Math.max(0, Number(offer.load) || 0)
      }));
      const quantities = Object.fromEntries(transportOffers.map((offer) => [offer.id, offer.stock]));
      const routeQuote = {
        ...prepared,
        countryId: String(market.countryId ?? ""),
        offers: transportOffers,
        deliveryMode: "scheduled",
        deliveryQd: Math.max(1, Number(prepared.deliveryQd) || Math.ceil(
          Math.max(1, Number(market.baseDeliveryQd) || 1)
          * Math.max(0.1, Number(prepared.location?.deliveryQdFactor) || 1)
          + Math.max(0, Number(candidate?.travelQd) || 0)
        ))
      };
      const routePlan = planMarketPurchase({
        holding: { ...holding, storage: { ...(holding.storage ?? {}), moneyCopper: Number.MAX_SAFE_INTEGER } },
        quote: routeQuote,
        quantities,
        targetRoomId: "outdoors",
        serviceLevel: "standard",
        transportOnly: true
      });
      const route = marketOutboundRouteFromPurchasePlan(routePlan, candidate.transportPlan ? null : carrier);
      if (route) routes.push({ ...route, distanceKm: candidate.distanceKm,
        id: `${route.id}:${stableDataHash([route.routePath, route.routeModes, candidate.distanceKm, candidate.routeAccessCost,
          candidate.distanceFlatCopper, candidate.distanceLoadCopper, candidate.riskFactor, candidate.transportPlan?.key])}` });
    }
  }
  return routes;
}

export function authorityMarketOutboundContext({
  holding,
  data,
  market,
  quote,
  economy,
  resources,
  quantities = {},
  insuranceEnabled = true,
  carrierId = AUTO_CARRIERS,
  isGM = false
} = {}) {
  if (!holding || !market || !quote) return prepareMarketOutboundContext();
  const outboundQuote = {
    ...quote,
    offers: quote.outboundOffers ?? quote.offers ?? [],
    countryId: String(market.countryId ?? "")
  };
  const organizations = (economy?.organizations ?? []).filter((organization) => isGM || organization?.visibility !== "gm");
  const preliminary = prepareMarketOutboundContext({
    holding,
    quote: outboundQuote,
    resourceDefinitions: resources,
    organizations,
    quantities,
    insuranceEnabled
  });
  const routes = authorityOutboundRoutes({
    holding,
    data,
    market,
    economy,
    resources,
    offers: preliminary.offers,
    carriers: quote.carriers ?? [],
    carrierId,
    isGM
  });
  return prepareMarketOutboundContext({ holding, quote: outboundQuote, resourceDefinitions: resources,
    organizations, routes, quantities, insuranceEnabled });
}

export function prepareMarketAuthorityContext({
  data,
  holding,
  marketId = "",
  carrierId = "",
  outboundCarrierId = AUTO_CARRIERS,
  quantities = {},
  targetRoomId = "outdoors",
  serviceLevel = "standard",
  outboundQuantities = {},
  outboundInsuranceEnabled = true,
  isGM = false
} = {}) {
  const locations = data?.catalog?.eventRegions ?? [];
  const economy = normalizeMarketEconomy(data?.catalog?.marketEconomy, { locations });
  const resources = allResourceDefs({ catalogRows: data?.catalog?.resources });
  const markets = availableAuthorityMarkets(data, { holding, isGM, economy, resources });
  const market = markets.find((row) => row.id === String(marketId ?? "")) ?? null;
  if (!holding || !market) {
    return { markets, market: null, quote: null, plan: null, outbound: null, economy, resources, selectedCarrierId: "" };
  }
  const quote = authorityMarketQuote({ holding, data, market, carrierId, isGM, economy, resources });
  const plan = planMarketPurchase({ holding, quote, quantities, targetRoomId, serviceLevel });
  const outbound = authorityMarketOutboundContext({
    holding,
    data,
    market,
    quote,
    economy,
    resources,
    quantities: outboundQuantities,
    insuranceEnabled: outboundInsuranceEnabled,
    carrierId: outboundCarrierId,
    isGM
  });
  return {
    markets,
    market,
    quote,
    plan,
    outbound,
    economy,
    resources,
    selectedCarrierId: String(quote?.selectedCarrierId ?? "")
  };
}
