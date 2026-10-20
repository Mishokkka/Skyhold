import { normalizeMarketOutboundState } from "../../data/market/outbound-state.js";
import { overlayMarketQuoteDemand } from "../../engines/market/demand.js";
import {
  marketOutboundAvailableQuantity,
  planMarketOutboundSale
} from "../../engines/market/outbound.js";

function whole(value, fallback = 0) {
  const parsed = Number(value);
  return Math.max(0, Math.floor(Number.isFinite(parsed) ? parsed : fallback));
}

function text(value = "") {
  return String(value ?? "").trim();
}

function resourceOfferGroups(offers = []) {
  const groups = new Map();
  for (const offer of Array.isArray(offers) ? offers : []) {
    if (offer?.sourceType === "item") continue;
    const resourceId = text(offer?.resourceId);
    const demand = whole(offer?.demand);
    const unitPriceCopper = whole(offer?.unitPriceCopper);
    if (!resourceId || !demand || !unitPriceCopper) continue;
    const existing = groups.get(resourceId) ?? {
      id: `outbound:${resourceId}`,
      resourceId,
      demandId: resourceId,
      name: text(offer?.name ?? resourceId),
      icon: text(offer?.icon ?? "fa-solid fa-box"),
      img: text(offer?.img),
      kind: text(offer?.kind ?? "resource"),
      demand: 0,
      weightedPriceCopper: 0,
      load: Math.max(0, Number(offer?.load) || 0),
      accessDifficulty: Math.max(0, Number(offer?.accessDifficulty) || 0),
      tags: new Set()
    };
    existing.demand += demand;
    existing.weightedPriceCopper += demand * unitPriceCopper;
    existing.load = Math.max(existing.load, Math.max(0, Number(offer?.load) || 0));
    existing.accessDifficulty = Math.max(existing.accessDifficulty, Math.max(0, Number(offer?.accessDifficulty) || 0));
    for (const tag of offer?.tags ?? []) if (text(tag)) existing.tags.add(text(tag));
    groups.set(resourceId, existing);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    unitPriceCopper: Math.max(1, Math.round(group.weightedPriceCopper / Math.max(1, group.demand))),
    tags: [...group.tags]
  }));
}

export function marketOutboundRouteFromPurchasePlan(plan = {}, carrier = null) {
  if (!plan || plan.empty || plan.inaccessible || plan.capacityExceeded || plan.amountExceeded || !(whole(plan.deliveryQd) > 0)) return null;
  const carrierId = text(carrier?.id ?? plan.carrierId ?? plan.logistics?.carrierId);
  return {
    id: carrierId || `route:${text(plan.marketId) || "external-market"}`,
    label: text(carrier?.label ?? plan.carrierLabel ?? plan.logistics?.carrierLabel ?? "Независимые перевозчики"),
    ok: true,
    carrierId,
    carrierLabel: text(carrier?.label ?? plan.carrierLabel ?? plan.logistics?.carrierLabel),
    routePath: Array.isArray(plan.logistics?.routePath) ? [...plan.logistics.routePath] : [],
    routeModes: Array.isArray(plan.logistics?.routeModes) ? [...plan.logistics.routeModes] : [],
    transportMode: text(plan.logistics?.transportMode),
    freightCopper: whole(plan.routeCopper) + whole(plan.handlingCopper) + whole(plan.expressSurchargeCopper),
    tariffCopper: whole(plan.taxCopper),
    importTaxCopper: whole(plan.importTaxCopper),
    exportTaxCopper: whole(plan.exportTaxCopper),
    insurancePremiumRate: Math.max(0, Number(plan.insuranceRate) || 0),
    insuranceCoverageRate: Math.max(0, Math.min(1, Number(plan.insuranceCoverageRate) || 0)),
    deliveryQd: Math.max(1, whole(plan.deliveryQd, 1)),
    standardDeliveryQd: whole(plan.standardDeliveryQd),
    serviceLevel: text(plan.serviceLevel) || "standard",
    shipmentBatches: (plan.shipmentBatches ?? []).map((batch) => ({ ...batch,
      lines: (batch.lines ?? []).map((line) => ({ ...line })) })),
    riskFactor: Math.max(0.25, Number(plan.riskFactor) || 1),
    riskLossChance: Math.max(0, Number(plan.riskLossChance) || 0),
    riskDelayChance: Math.max(0, Number(plan.riskDelayChance) || 0),
    riskMaxDelayQd: Math.max(1, whole(plan.riskMaxDelayQd, 1))
  };
}

export function prepareMarketOutboundContext({
  holding = null,
  quote = null,
  resourceDefinitions = [],
  organizations = [],
  routes = [],
  quantities = {},
  insuranceEnabled = true
} = {}) {
  const empty = {
    offers: [],
    plan: null,
    selectedUnits: 0,
    hasForSaleStock: false,
    unavailableForSaleCount: 0
  };
  if (!holding || !quote) return empty;

  const definitionById = new Map((Array.isArray(resourceDefinitions) ? resourceDefinitions : [])
    .map((row) => [text(row?.id ?? row?.resourceId), row]));
  const storageRows = (holding?.storage?.resources ?? []).filter((row) => row?.forSale && whole(row?.qty) > 0);
  const outboundState = normalizeMarketOutboundState(holding?.special?.market?.outbound);
  const grouped = resourceOfferGroups(quote.outboundOffers ?? []);
  const demandQuote = overlayMarketQuoteDemand({
    holding,
    quote: {
      marketId: text(quote.marketId || "external-market"),
      offers: grouped
    }
  });
  const stockResourceIds = new Set(storageRows.map((row) => text(row?.resourceId ?? row?.id)).filter(Boolean));
  const offers = demandQuote.offers
    .filter((offer) => stockResourceIds.has(text(offer.resourceId)))
    .map((offer) => {
      const resourceId = text(offer.resourceId);
      const definition = definitionById.get(resourceId) ?? {};
      const availableStock = marketOutboundAvailableQuantity({
        resources: storageRows,
        outboundState,
        resourceId
      });
      const availableDemand = whole(offer.demand);
      const available = Math.min(availableStock, availableDemand);
      const requested = Math.min(available, whole(quantities?.[resourceId]));
      return {
        ...offer,
        id: resourceId,
        resourceId,
        name: text(definition.label ?? offer.name ?? resourceId),
        icon: text(definition.icon ?? offer.icon ?? "fa-solid fa-box"),
        img: text(definition.img ?? offer.img),
        tags: [...new Set([...(offer.tags ?? []), ...(definition.marketTags ?? []), definition.categoryTag].map(text).filter(Boolean))],
        load: definition.loadPoints == null ? Math.max(0, Number(offer.load) || 0)
          : Math.max(0, Number(definition.loadPoints) || 0) / 4,
        accessDifficulty: Math.max(offer.accessDifficulty, Number(definition.marketAccessDifficulty) || 0),
        availableStock,
        availableDemand,
        available,
        qty: requested,
        selected: requested > 0,
        demandBaseDemand: whole(offer.demandBaseDemand),
        demandStateRevision: whole(offer.demandStateRevision),
        unitPriceCopper: whole(offer.unitPriceCopper)
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, "ru") || left.resourceId.localeCompare(right.resourceId));

  const lines = offers.filter((offer) => offer.qty > 0).map((offer) => ({
    id: `outbound:${offer.resourceId}`,
    resourceId: offer.resourceId,
    demandId: offer.resourceId,
    name: offer.name,
    qty: offer.qty,
    unitPriceCopper: offer.unitPriceCopper,
    demandBaseDemand: offer.demandBaseDemand,
    demandStateRevision: offer.demandStateRevision,
    tags: offer.tags
  }));
  const plan = lines.length ? planMarketOutboundSale({
    resources: storageRows,
    outboundState,
    lines,
    routes,
    organizations,
    marketId: quote.marketId,
    marketLabel: quote.marketLabel,
    countryId: quote.countryId,
    treasuryCopper: holding?.storage?.moneyCopper,
    insuranceEnabled
  }) : null;

  return {
    offers,
    plan,
    selectedUnits: lines.reduce((sum, line) => sum + line.qty, 0),
    hasForSaleStock: storageRows.length > 0,
    unavailableForSaleCount: Math.max(0, stockResourceIds.size - new Set(offers.map((row) => row.resourceId)).size)
  };
}
