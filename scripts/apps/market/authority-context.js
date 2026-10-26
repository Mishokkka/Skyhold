import { allResourceDefs } from "../../core/resources.js";
import { normalizeMarketEconomy } from "../../data/market/economy.js";
import { marketRegionForValue } from "../../data/market/region-market.js";
import { stableDataHash } from "../../data/storage-commit.js";
import { effectiveMarketLocations, marketLocationFactors } from "../../engines/market/composition.js";
import {
  holdingMarketAccessLevel,
  marketRegionAccessCostMap,
  resolveMarketLogistics,
  shortestMarketRoute
} from "../../engines/market/logistics.js";
import { planMarketPurchase, prepareMarketOutboundQuote, prepareMarketQuote, marketHistoricalInsuranceRate,
  marketShipmentRiskProfile, MARKET_INSURANCE_COVERAGE_RATE } from "../../engines/market/pricing.js";
import {
  allocateQuoteToMerchantProviders,
} from "../../engines/market/providers.js";
import { AUTO_CARRIERS, planMarketTransport } from "../../engines/market/transport-planner.js";
import { overlayMarketQuoteStock } from "../../engines/market/stock.js";
import { getCalendariaSeasonSnapshot } from "../../integrations/calendaria-bridge.js";
import { marketOutboundRouteFromPurchasePlan, prepareMarketOutboundContext } from "./outbound-context.js";
import { buildShipWorldContext, quoteWorldShipSale } from "../../engines/ships/world-market.js";
import { shipCrewReadiness } from "../../engines/ships/crew-readiness.js";
import { shipMoneySummary } from "../../engines/ships/summary.js";

function marketSeasonId(holding = {}) {
  const calendaria = holding?.gm?.calendaria ?? {};
  const snapshot = getCalendariaSeasonSnapshot(calendaria.lastDateTime, calendaria.lastDateText);
  return String(snapshot?.season?.key ?? "").trim();
}

export function marketAuthoritySourceToken({ data, holding, marketId = "", carrierId = "" } = {}) {
  return stableDataHash({
    holding,
    sharedMarkets: data?.meta?.sharedMarkets,
    eventRegions: data?.catalog?.eventRegions,
    marketEconomy: data?.catalog?.marketEconomy,
    marketRouteMap: data?.catalog?.marketRouteMap,
    resources: data?.catalog?.resources,
    marketId: String(marketId ?? ""),
    carrierId: String(carrierId ?? "")
  });
}

export function marketPurchasePlanToken(plan = {}) {
  return stableDataHash({
    version: 1,
    marketId: String(plan?.marketId ?? ""),
    quoteKey: String(plan?.quoteKey ?? ""),
    locationId: String(plan?.locationId ?? ""),
    targetRoomId: String(plan?.targetRoomId ?? ""),
    serviceLevel: String(plan?.serviceLevel ?? ""),
    carrierId: String(plan?.carrierId ?? ""),
    deliveryMode: String(plan?.deliveryMode ?? ""),
    transportPlan: plan?.logistics?.transportPlan ?? null,
    totalCopper: Math.max(0, Math.floor(Number(plan?.totalCopper) || 0)),
    deliveryQd: Math.max(0, Math.floor(Number(plan?.deliveryQd) || 0)),
    lines: (Array.isArray(plan?.lines) ? plan.lines : []).map((line) => ({
      id: String(line?.id ?? ""),
      stockOfferId: String(line?.stockOfferId ?? line?.sourceOfferId ?? line?.id ?? ""),
      sourceType: String(line?.sourceType ?? ""),
      resourceId: String(line?.resourceId ?? ""),
      itemUuid: String(line?.itemUuid ?? ""),
      providerId: String(line?.providerId ?? ""),
      qty: Math.max(0, Math.floor(Number(line?.qty) || 0)),
      unitPriceCopper: Math.max(0, Math.floor(Number(line?.unitPriceCopper) || 0)),
      stockBaseStock: Math.max(0, Math.floor(Number(line?.stockBaseStock ?? line?.stock) || 0)),
      stockStateRevision: Math.max(0, Math.floor(Number(line?.stockStateRevision) || 0))
    }))
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
  direction = "inbound"
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
  resources: preparedResources = null
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
  const quote = overlayMarketQuoteStock({
    holding,
    quote: prepareMarketQuote({ holding, market, resources, location: market.locationProfile, logistics })
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

export function authorityOwnShipOutboundRoute({ holding, data, market, offers = [], ownShipId = "" } = {}) {
  const ship = (holding?.special?.ships?.list ?? []).find((row) => row.id === ownShipId);
  if (!ship) return { route: null, reason: "Собственный корабль не найден." };
  const readiness = shipCrewReadiness(holding, ship, { catalog: data?.catalog });
  if (!readiness.ready) return { route: null, reason: readiness.issues.map((row) => row.message).join(" ") };
  const selected = offers.filter((row) => Number(row.qty) > 0);
  const loadPoints = selected.reduce((sum, row) => sum + Number(row.qty) * Math.max(0, Math.round(Number(row.load || 0) * 4)), 0);
  const valueCopper = selected.reduce((sum, row) => sum + Number(row.qty) * Number(row.unitPriceCopper || 0), 0);
  try {
    const world = buildShipWorldContext(data, holding, { offerLocationIds: [market.regionId] });
    const voyageOffer = quoteWorldShipSale(data, holding, ship, market.regionId, { loadPoints, valueCopper, context: world });
    const route = shortestMarketRoute(world.home.regionId, market.regionId, world.regions, { mode: "airship" });
    const economy = normalizeMarketEconomy(data?.catalog?.marketEconomy, { locations: world.regions });
    const logistics = resolveMarketLogistics({ holding, market: { ...market, transportModes: ["airship"] },
      regions: world.regions, selectedRoute: route, singleRoute: true, direction: "outbound", seasonId: marketSeasonId(holding),
      dependencies: { regionFactors: (region) => marketLocationFactors(region, economy, world.regions), regionResolver: marketRegionForValue } });
    const difficulty = Math.max(0, ...selected.map((offer) => Number(offer.accessDifficulty) || 0));
    if (!logistics.ok || logistics.routeAccessCost + difficulty > logistics.accessLevel) throw new Error(
      logistics.reasons.join(" ") || "Недостаточно УРС для воздушного маршрута и выбранного товара.");
    const risk = marketShipmentRiskProfile({ logistics, deliveryQd: voyageOffer.quote.durationQd });
    const importTaxCopper = Math.ceil(valueCopper * logistics.importTaxRate);
    const exportTaxCopper = Math.ceil(valueCopper * logistics.exportTaxRate);
    return { route: {
      id: `own-ship:${ship.id}`, label: ship.name, carrierId: `own-ship:${ship.id}`,
      carrierLabel: ship.name, ownShipId: ship.id, freightCopper: 0,
      tariffCopper: importTaxCopper + exportTaxCopper, importTaxCopper, exportTaxCopper,
      insurancePremiumRate: marketHistoricalInsuranceRate({ location: market.locationProfile, logistics }),
      insuranceCoverageRate: MARKET_INSURANCE_COVERAGE_RATE,
      riskFactor: risk.riskFactor, riskLossChance: risk.lossChance, riskDelayChance: risk.delayChance, riskMaxDelayQd: risk.maxDelayQd,
      routePath: voyageOffer.quote.path, routeModes: ["airship"], transportMode: "airship",
      deliveryQd: voyageOffer.quote.durationQd, ok: true
    }, voyageOffer, loadPoints, reason: "" };
  } catch (error) {
    return { route: null, reason: error.message };
  }
}

export function validateOwnShipOutboundFunding(holding, result, ownShip) {
  if (!ownShip?.voyageOffer || !result?.plan?.ok) return result;
  const ship = (holding?.special?.ships?.list ?? []).find((row) => row.id === ownShip.voyageOffer.shipId);
  if (!ship) {
    result.plan.ok = false;
    result.plan.reasons = [...(result.plan.reasons ?? []), "Собственный корабль не найден."];
    return result;
  }
  const quote = ownShip.voyageOffer.quote;
  const money = shipMoneySummary(holding, ship, { clockQd: Math.max(
    Number(holding.gm?.calendaria?.lastQd ?? 0), Number(ship.timelineQd ?? 0)) });
  if (!money.calculationValid) {
    result.plan.ok = false;
    result.plan.reasons = [...(result.plan.reasons ?? []), "Не удалось рассчитать корабельные деньги. ГМ должен проверить данные."];
    return result;
  }
  const walletAfterBilling = Math.max(0, money.walletCopper - money.portDebtCopper);
  const homeBillCopper = Math.max(0, money.portDebtCopper - money.walletCopper);
  const transferCopper = Math.max(0, Number(quote.recommendedBudgetCopper ?? 0) - walletAfterBilling);
  const requiredCopper = Number(result.plan.upfrontCopper ?? 0) + transferCopper + homeBillCopper + Number(quote.preparationCopper ?? 0);
  if (Number(holding?.storage?.moneyCopper ?? 0) < requiredCopper) {
    result.plan.ok = false;
    result.plan.reasons = [...new Set([...(result.plan.reasons ?? []),
      `Для продажи и отправки корабля требуется ${requiredCopper} ММ в казне поселения.`])];
  }
  return result;
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
  ownShipId = "",
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
  const ownShip = ownShipId ? authorityOwnShipOutboundRoute({ holding, data, market, offers: preliminary.offers, ownShipId }) : null;
  const result = prepareMarketOutboundContext({
    holding,
    quote: outboundQuote,
    resourceDefinitions: resources,
    organizations,
    routes: ownShipId ? (ownShip?.route ? [ownShip.route] : []) : routes,
    quantities,
    insuranceEnabled
  });
  if (ownShipId && ownShip?.reason && result.plan) {
    result.plan.ok = false;
    result.plan.reasons = [...new Set([...result.plan.reasons, ownShip.reason])];
  }
  return { ...validateOwnShipOutboundFunding(holding, result, ownShip), ownShip };
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
  ownShipId = "",
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
    ownShipId,
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
