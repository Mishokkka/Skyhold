import { MODULE_ID } from "../data/constants.js";
import { SkyholdData, requestStorageOperation } from "../data/store.js";
import { findReadableHoldingEntry } from "../data/access-guard.js";
import { holdingPermissionContext } from "../data/holding-permissions.js";
import { appendHoldingOperation } from "../data/operations.js";
import { stableDataHash } from "../data/storage-commit.js";
import { clone, makeId } from "../data/utils.js";
import { economyV2RuntimeStatus } from "../data/economy-v2-activation.js";
import { normalizeMarketEconomy } from "../data/market/economy.js";
import { marketRegionForValue } from "../data/market/region-market.js";
import { allResourceDefs, compactResourceUnit } from "../core/resources.js";
import { copperCurrencyParts, formatCopperCurrencyCompact, formatCopperCurrencyCompact as formatCopperCurrency } from "../core/currency.js";
import { planMarketPurchase, prepareMarketQuote } from "../engines/market/pricing.js";
import { MARKET_PRICING_DEPENDENCIES } from "../engines/market/pricing-adapter.js";
import { deliverMarketShipmentNow, marketShipmentCancellationQuote } from "../engines/market/shipment.js";
import { applyMarketStockReservationsToQuote } from "../engines/market/stock.js";
import { planMarketExport } from "../engines/market/export-plan.js";
import { createMarketExportLiquidityDemandAdapter } from "../engines/market/export-liquidity-adapter.js";
import { analyzeMarketIntegrity } from "../engines/market/integrity.js";
import { holdingMarketAccessLevel, marketRegionAccessCostMap, resolveMarketLogistics } from "../engines/market/logistics.js";
import { effectiveMarketLocations, marketLocationFactors } from "../engines/market/composition.js";
import { allocateQuoteToMerchantProviders, applyCarrierToLogistics, carrierCapacityForLogistics, carrierProvidersForRoute } from "../engines/market/providers.js";
import { FLEET_OWNED_DELIVERY_SERVICE, fleetVesselIdFromCarrier, matchedExternalCharterLogistics, ownedFleetCarriersForMarket } from "../engines/fleet/market-integration.js";
import { getCalendariaSeasonSnapshot } from "../integrations/calendaria-bridge.js";
import { foundryDialogV2, resolveFoundryUuid } from "../integrations/foundry-runtime.js";
import { requestSkyholdAppRender } from "./registry.js";
import { getSkyholdWorkflowService } from "../workflows/skyhold-workflow-service.js";
import { RenderSchedulerMixin } from "./common/render-scheduler.js";
import { bindImageFallbacks, capturePersistentImages, restorePersistentImages } from "./common/image-fallback.js";
import { bindFloatingTooltips, hideFloatingTooltip } from "./common/floating-tooltip.js";
import { groupMarketOffers, marketOfferGroupTotals, merchantAbbreviation, merchantTone } from "./market/offer-groups.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function prepareLine(line, quantity = 0) {
  const qty = Math.max(0, Math.min(Math.floor(Number(quantity) || 0), line.stock));
  const movementPercent = Number(line.movementPercent) || 0;
  const movementDirection = movementPercent > 0 ? "выше" : movementPercent < 0 ? "ниже" : "равна";
  return {
    ...line,
    unitFull: String(line.unit ?? "ед."),
    unit: compactResourceUnit(line.unit),
    qty,
    selected: qty > 0,
    priceText: formatCopperCurrencyCompact(line.unitPriceCopper),
    priceParts: copperCurrencyParts(line.unitPriceCopper),
    lineText: formatCopperCurrencyCompact(line.unitPriceCopper * qty),
    lineParts: copperCurrencyParts(line.unitPriceCopper * qty),
    movementText: movementPercent > 0 ? `+${movementPercent}%` : `${movementPercent}%`,
    movementTooltip: `Текущая цена ${movementDirection} базовой цены товара на ${Math.abs(movementPercent)}%. Котировка учитывает рынок, сезон и продавца.`,
    providerShareText: `${Math.round(Number(line.providerSharePct ?? 0))}%`,
    searchText: [line.name, line.kindLabel, line.resourceId, line.itemUuid, line.origin, line.providerLabel, ...(line.tags ?? [])].filter(Boolean).join(" ").toLocaleLowerCase("ru")
  };
}

function shipmentStatusLabel(status = "") {
  if (status === "delivered") return "Доставлен";
  if (status === "lost") return "Утрачен";
  if (status === "cancelled") return "Отменён";
  if (status === "delayed") return "Задержан";
  if (status === "pending") return "Готовится";
  return "В пути";
}

function exportStatusLabel(status = "") {
  if (status === "delivered") return "Продан";
  if (status === "lost") return "Утрачен";
  if (status === "cancelled") return "Отменён";
  if (status === "reserved") return "Бронь";
  return "В пути";
}

function activeExportReservations(exportBook = {}) {
  const reserved = new Map();
  for (const order of exportBook?.orders ?? []) {
    if (String(order?.status ?? "") !== "reserved") continue;
    for (const source of order?.sources ?? []) {
      const rowId = String(source?.storageRowId ?? "").trim();
      if (!rowId) continue;
      reserved.set(rowId, (reserved.get(rowId) ?? 0) + Math.max(0, Math.floor(Number(source?.qty) || 0)));
    }
  }
  return reserved;
}

function exportStorageRows(holding = {}, exportBook = {}, resourceId = "") {
  const id = String(resourceId ?? "").trim();
  const resources = Array.isArray(holding?.storage?.resources) ? holding.storage.resources : [];
  const idCounts = new Map();
  for (const row of resources) {
    const rowId = String(row?.id ?? "").trim();
    if (rowId) idCounts.set(rowId, (idCounts.get(rowId) ?? 0) + 1);
  }
  const reserved = activeExportReservations(exportBook);
  return resources.map((row, index) => {
    const rowId = String(row?.id ?? "").trim();
    const storedQty = Math.max(0, Math.floor(Number(row?.qty) || 0));
    const reservedQty = Math.max(0, reserved.get(rowId) ?? 0);
    return {
      row,
      index,
      rowId,
      roomId: String(row?.roomId ?? row?.storageRoomId ?? "outdoors") || "outdoors",
      storedQty,
      reservedQty,
      availableQty: Math.max(0, storedQty - reservedQty)
    };
  }).filter((entry) => (
    entry.rowId
      && idCounts.get(entry.rowId) === 1
      && String(entry.row?.resourceId ?? "") === id
      && entry.availableQty > 0
  ));
}

function exportQuantitiesForSelection(holding = {}, exportBook = {}, resourceId = "", requestedQty = 0) {
  let remaining = Math.max(0, Math.floor(Number(requestedQty) || 0));
  const quantities = {};
  for (const entry of exportStorageRows(holding, exportBook, resourceId)) {
    if (remaining <= 0) break;
    const qty = Math.min(entry.availableQty, remaining);
    if (qty > 0) quantities[entry.rowId] = qty;
    remaining -= qty;
  }
  return quantities;
}

function percentText(value = 0) {
  return `${(Math.max(0, Number(value) || 0) * 100).toFixed(1)}%`;
}

function cargoPointsText(value = 0) {
  const cargoPoints = Math.max(0, Math.round(Number(value) || 0));
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(cargoPoints)} груз. очк.`;
}

function marketServiceLabel(serviceLevel = "standard") {
  if (serviceLevel === FLEET_OWNED_DELIVERY_SERVICE) return "свой корабль";
  if (serviceLevel === "express") return "Express";
  if (serviceLevel === "charter") return "Charter";
  return "Standard";
}

function marketServiceDescription(serviceLevel = "standard") {
  if (serviceLevel === FLEET_OWNED_DELIVERY_SERVICE) return "Свой корабль: один рейс в пределах его грузовых очков. Оплачиваются эксплуатация и резерв корабля; стоимость товара не задаёт фрахт.";
  if (serviceLevel === "express") return "Express: до 10% вместимости на рейс, оплачивается занятая доля одного плеча; ETA ×0,70 и надбавка 20% за срочность.";
  if (serviceLevel === "charter") return "Charter: бронируется вся машина и оплачиваются два плеча — доставка и возврат либо перегон транспорта.";
  return "Standard: до 20% вместимости на рейс, оплачивается занятая доля одного плеча; остаток автоматически уходит следующей попуткой.";
}

function marketTripCountText(value = 0) {
  const count = Math.max(0, Math.floor(Number(value) || 0));
  const mod100 = count % 100;
  const mod10 = count % 10;
  const word = mod100 >= 11 && mod100 <= 14 ? "рейсов" : (mod10 === 1 ? "рейс" : (mod10 >= 2 && mod10 <= 4 ? "рейса" : "рейсов"));
  return `${count} ${word}`;
}

function marketBatchPreview(batch = {}, plan = {}, selected = false) {
  const number = Math.max(1, Number(batch.number) || Number(batch.index) + 1 || 1);
  const bookingCapacityCargoPoints = Math.max(0, Number(plan.bookingCapacityCargoPoints) || 0);
  const actualCargoPoints = Math.max(0, Number(batch.totalCargoPoints) || 0);
  const billsFullCapacity = Number(batch.billableLoad) > Number(batch.totalLoad) + 0.0001;
  const billableCargoPoints = billsFullCapacity
    ? Math.max(0, Number(plan.physicalCapacityCargoPoints) || bookingCapacityCargoPoints)
    : actualCargoPoints;
  const routeCopper = Math.max(0, Number(batch.routeCopper) || 0);
  const billingRule = plan.serviceLevel === "charter"
    ? "Charter: вся машина, два плеча"
    : "Standard/Express: занятая доля одного плеча";
  return {
    number,
    index: Math.max(0, number - 1),
    selected,
    optionLabel: `Рейс ${number} · ETA ${Math.max(0, Number(batch.deliveryQd) || 0)} QD · ${cargoPointsText(actualCargoPoints)}`,
    etaText: `${Math.max(0, Number(batch.deliveryQd) || 0)} QD`,
    cargoPointsText: bookingCapacityCargoPoints > 0
      ? `${cargoPointsText(actualCargoPoints)} / ${cargoPointsText(bookingCapacityCargoPoints)}`
      : cargoPointsText(actualCargoPoints),
    capacityShareText: percentText(batch.capacityShare),
    billableCargoPointsText: cargoPointsText(billableCargoPoints),
    billsFullCapacity,
    cargo: (batch.lines ?? []).map((line) => ({
      name: String(line.name ?? "Товар"),
      providerLabel: String(line.providerLabel ?? ""),
      qty: Math.max(0, Number(line.qty) || 0),
      lineText: formatCopperCurrencyCompact(line.lineCopper ?? (Number(line.qty) || 0) * (Number(line.unitPriceCopper) || 0))
    })),
    subtotalText: formatCopperCurrencyCompact(batch.subtotalCopper),
    routeText: `${formatCopperCurrencyCompact(routeCopper)} · ${billingRule}`,
    handlingText: formatCopperCurrencyCompact(batch.handlingCopper),
    insuranceText: formatCopperCurrencyCompact(batch.insuranceCopper),
    taxText: formatCopperCurrencyCompact(batch.taxCopper),
    expressText: formatCopperCurrencyCompact(batch.expressSurchargeCopper),
    hasExpress: Number(batch.expressSurchargeCopper) > 0,
    deliveryText: formatCopperCurrencyCompact(batch.deliveryCopper),
    totalText: formatCopperCurrencyCompact(batch.totalCopper),
    lossText: percentText(batch.riskProfile?.lossChance),
    delayText: percentText(batch.riskProfile?.delayChance)
  };
}

function shipmentRiskText(order = {}) {
  if (order.status === "cancelled") return `Возвращено ${formatCopperCurrency(order.cancellationRefundCopper || 0)} · удержано ${formatCopperCurrency(order.cancellationWithheldCopper || 0)}`;
  if (order.status === "lost" || order.riskOutcome === "lost") {
    const payout = Math.max(0, Number(order.insurancePayoutCopper) || 0);
    return payout > 0 ? `Груз утрачен · страховка ${formatCopperCurrency(payout)}` : "Груз утрачен без выплаты";
  }
  if (order.riskOutcome === "delayed") return `Маршрутная задержка +${Math.max(1, Number(order.delayQd) || 1)} QD`;
  if (order.riskOutcome === "clear") return "Риск разрешён: без происшествий";
  if (order.riskOutcome === "waived") return "Риск не применялся";
  return `Оценка: утрата ${percentText(order.riskLossChance)}, задержка ${percentText(order.riskDelayChance)}`;
}

function shipmentDateText(value = "") {
  const source = String(value ?? "").trim();
  if (!source) return "—";
  const parsed = new Date(source);
  if (!Number.isFinite(parsed.getTime())) return source;
  return parsed.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
}

function shipmentTimeline(order = {}) {
  const rows = [];
  if (order.orderedAt) rows.push({ label: "Заказ принят", at: shipmentDateText(order.orderedAt) });
  if (order.dispatchedAt) rows.push({ label: "Передан перевозчику", at: shipmentDateText(order.dispatchedAt) });
  if (order.delayedAt) rows.push({ label: `Задержка +${Math.max(1, Number(order.delayQd) || 1)} QD`, at: shipmentDateText(order.delayedAt) });
  if (order.lostAt) rows.push({ label: "Груз утрачен", at: shipmentDateText(order.lostAt) });
  if (order.cancelledAt) rows.push({ label: "Заказ отменён", at: shipmentDateText(order.cancelledAt) });
  if (order.deliveredAt) rows.push({ label: "Груз доставлен", at: shipmentDateText(order.deliveredAt) });
  return rows;
}

function marketSeasonId(holding = {}) {
  const calendaria = holding?.gm?.calendaria ?? {};
  const snapshot = getCalendariaSeasonSnapshot(calendaria.lastDateTime, calendaria.lastDateText);
  return String(snapshot?.season?.id ?? "").trim();
}

function marketSeasonLabel(seasonId = "") {
  return ({ spring: "Весна", summer: "Лето", autumn: "Осень", winter: "Зима" })[seasonId] ?? "Сезон";
}

export class SkyholdMarketApp extends RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  static instances = new Map();

  static open({ holdingId } = {}) {
    const id = String(holdingId ?? "");
    const existing = this.instances.get(id);
    if (existing) {
      existing.render({ force: true, focus: true });
      return existing;
    }
    const app = new this({ holdingId: id });
    this.instances.set(id, app);
    app.render({ force: true, focus: true });
    return app;
  }

  constructor({ holdingId } = {}, options = {}) {
    super(options);
    this.holdingId = String(holdingId ?? "");
    this.quantities = {};
    this.targetRoomId = "";
    this.search = "";
    this.kind = "all";
    this.marketId = "";
    this.merchantSelections = {};
    this.carrierId = "";
    this.serviceLevel = "standard";
    this.batchPreviewIndex = 0;
    this.deliveryBreakdownOpen = true;
    this.tradeMode = "buy";
    this.exportOfferId = "";
    this.exportQuantity = 0;
    this.exportCarrierId = "";
    this.exportServiceLevel = "charter";
  }

  render(options = {}) {
    if (this.rendered && this.element) this._pendingPersistentImages = capturePersistentImages(this.element);
    return super.render(options);
  }

  _availableMarkets(data, { holding = null, isGM = Boolean(game.user?.isGM), economy: preparedEconomy = null, resources: preparedResources = null } = {}) {
    const locations = data?.catalog?.eventRegions ?? [];
    const resources = preparedResources ?? allResourceDefs({ catalogRows: data?.catalog?.resources });
    const economy = preparedEconomy ?? normalizeMarketEconomy(data?.catalog?.marketEconomy, { locations });
    if (!holding) return [];
    const access = holdingMarketAccessLevel(holding);
    const accessByRegion = marketRegionAccessCostMap({ holding, regions: locations, dependencies: { regionResolver: marketRegionForValue } });
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

  _marketLogistics(holding, data, market, { carrierId = this.carrierId, persistCarrier = false, includeFleet = true, isGM = Boolean(game.user?.isGM), economy: preparedEconomy = null } = {}) {
    if (!market) return { logistics: null, carriers: [], carrier: null };
    const locations = data?.catalog?.eventRegions ?? [];
    const economy = preparedEconomy ?? normalizeMarketEconomy(data?.catalog?.marketEconomy, { locations });
    const baseLogistics = resolveMarketLogistics({
      holding,
      market,
      regions: locations,
      seasonId: marketSeasonId(holding),
      dependencies: {
        regionFactors: (region) => marketLocationFactors(region, economy, locations),
        regionResolver: marketRegionForValue
      }
    });
    const externalCarriers = carrierProvidersForRoute({
      organizations: economy.organizations,
      countryId: market.countryId,
      transportMode: baseLogistics.transportMode,
      routeModes: baseLogistics.routeModes,
      isGM
    });
    const externalCarrier = externalCarriers.find((row) => row.id === String(carrierId ?? "")) ?? externalCarriers[0] ?? null;
    const referenceLogistics = applyCarrierToLogistics(baseLogistics, externalCarrier);
    const fleetCarriers = includeFleet ? ownedFleetCarriersForMarket({ holding, market, regions: locations, baseLogistics }) : [];
    const carriers = [...externalCarriers, ...fleetCarriers];
    const requestedFleetVesselId = fleetVesselIdFromCarrier(carrierId);
    const fleetCarrier = requestedFleetVesselId
      ? fleetCarriers.find((row) => String(row.vesselId ?? "") === requestedFleetVesselId) ?? null
      : null;
    const carrier = fleetCarrier ?? externalCarrier;
    if (persistCarrier) this.carrierId = String(carrier?.id ?? "");
    return {
      logistics: fleetCarrier?.logistics ?? applyCarrierToLogistics(baseLogistics, externalCarrier),
      referenceLogistics,
      carriers,
      carrier
    };
  }

  _marketQuote(holding, data, market, { isGM = Boolean(game.user?.isGM), economy: preparedEconomy = null, resources: preparedResources = null } = {}) {
    if (!market) return null;
    const economy = preparedEconomy ?? normalizeMarketEconomy(data?.catalog?.marketEconomy, { locations: data?.catalog?.eventRegions ?? [] });
    const { logistics, referenceLogistics, carriers, carrier } = this._marketLogistics(holding, data, market, { persistCarrier: true, isGM, economy });
    const resources = preparedResources ?? allResourceDefs({ catalogRows: data?.catalog?.resources });
    const quoteMarket = logistics?.ownedVesselId ? { ...market, deliveryMode: "scheduled" } : market;
    const quote = prepareMarketQuote({
      holding,
      market: quoteMarket,
      resources,
      location: market.locationProfile,
      logistics
    }, MARKET_PRICING_DEPENDENCIES);
    const referenceQuote = logistics?.ownedVesselId
      ? prepareMarketQuote({
          holding,
          market: quoteMarket,
          resources,
          location: market.locationProfile,
          logistics: referenceLogistics
        }, MARKET_PRICING_DEPENDENCIES)
      : null;
    const allocated = allocateQuoteToMerchantProviders({
      offers: quote.offers,
      organizations: economy.organizations,
      countryId: market.countryId,
      quoteKey: quote.quoteKey,
      isGM
    });
    return applyMarketStockReservationsToQuote({ holding, side: "ask", quote: {
      ...quote,
      offers: allocated.offers,
      merchantProviders: allocated.providers,
      carriers,
      referenceLogistics,
      referenceDeliveryQd: Math.max(0, Number(referenceQuote?.deliveryQd) || 0),
      selectedCarrierId: String(carrier?.id ?? "")
    } });
  }

  _marketSellQuote(holding, data, market, { isGM = Boolean(game.user?.isGM), economy: preparedEconomy = null, resources: preparedResources = null } = {}) {
    if (!market) return null;
    const economy = preparedEconomy ?? normalizeMarketEconomy(data?.catalog?.marketEconomy, { locations: data?.catalog?.eventRegions ?? [] });
    const { logistics, carriers, carrier } = this._marketLogistics(holding, data, market, {
      carrierId: this.exportCarrierId,
      persistCarrier: false,
      includeFleet: false,
      isGM,
      economy
    });
    this.exportCarrierId = String(carrier?.id ?? "");
    const resources = preparedResources ?? allResourceDefs({ catalogRows: data?.catalog?.resources });
    const quote = prepareMarketQuote({
      holding,
      market: { ...market, deliveryMode: "scheduled" },
      resources,
      location: market.locationProfile,
      logistics
    }, MARKET_PRICING_DEPENDENCIES);
    return applyMarketStockReservationsToQuote({ holding, side: "bid", quote: {
      ...quote,
      carriers,
      selectedCarrierId: this.exportCarrierId
    } });
  }

  _exportPlan(holding, quote) {
    if (!holding || !quote || !this.exportOfferId) return null;
    const offer = (quote.offers ?? []).find((row) => String(row?.id ?? row?.offerId ?? "") === String(this.exportOfferId));
    if (!offer) return null;
    const exportBook = holding?.special?.market?.exportBook ?? { version: 1, orders: [], advanceRuns: [] };
    const quantities = exportQuantitiesForSelection(holding, exportBook, offer.resourceId, this.exportQuantity);
    const liquidity = holding?.special?.market?.liquidity;
    const demand = liquidity && typeof liquidity === "object"
      ? createMarketExportLiquidityDemandAdapter(liquidity)
      : null;
    return planMarketExport({
      holding,
      exportBook,
      quote,
      offerId: offer.id,
      quantities,
      serviceLevel: ["standard", "express", "charter"].includes(this.exportServiceLevel) ? this.exportServiceLevel : "charter",
      dependencies: demand ? { demand } : {}
    });
  }

  _exportPlanFingerprint(plan = null) {
    if (!plan) return "";
    return stableDataHash({
      offerId: plan.offerId,
      resourceId: plan.resourceId,
      totalQty: plan.totalQty,
      cargo: plan.cargo,
      exportQuote: plan.exportQuote,
      financials: plan.financials,
      eta: plan.eta,
      risk: plan.risk,
      capacity: plan.capacity,
      dispatchCash: plan.dispatchCash
    });
  }

  _purchasePlan(holding, quote) {
    if (!quote) return null;
    const owned = Boolean(quote?.logistics?.ownedVesselId);
    const serviceLevel = owned
      ? FLEET_OWNED_DELIVERY_SERVICE
      : (this.serviceLevel === FLEET_OWNED_DELIVERY_SERVICE ? "standard" : this.serviceLevel);
    const plan = planMarketPurchase({ holding, quote, quantities: this.quantities, targetRoomId: this.targetRoomId, serviceLevel }, MARKET_PRICING_DEPENDENCIES);
    if (!owned || !quote.referenceLogistics) return plan;
    const comparisonLogistics = matchedExternalCharterLogistics(quote.referenceLogistics, quote.logistics);
    const referenceQuote = {
      ...quote,
      deliveryQd: Math.max(1, Number(quote.referenceDeliveryQd) || Number(quote.deliveryQd) || 1),
      logistics: comparisonLogistics
    };
    const externalPlan = planMarketPurchase({ holding, quote: referenceQuote, quantities: this.quantities, targetRoomId: this.targetRoomId, serviceLevel: "charter" }, MARKET_PRICING_DEPENDENCIES);
    plan.externalComparison = {
      carrierLabel: String(referenceQuote.logistics?.carrierLabel ?? "Внешний перевозчик"),
      capacityLoad: Math.max(0, Number(comparisonLogistics.capacityLoad) || 0),
      capacityCargoPoints: Math.max(0, Number(comparisonLogistics.capacityCargoPoints) || 0),
      capacityTonnes: Math.max(0, Number(comparisonLogistics.comparisonCapacityTonnes) || 0),
      capacityVolumeM3: Math.max(0, Number(comparisonLogistics.comparisonCapacityVolumeM3) || 0),
      deliveryCopper: Math.max(0, Number(externalPlan.deliveryCopper) || 0),
      routeCopper: Math.max(0, Number(externalPlan.routeCopper) || 0),
      deliveryQd: Math.max(0, Number(externalPlan.deliveryQd) || 0),
      differenceCopper: Math.max(0, Number(plan.deliveryCopper) || 0) - Math.max(0, Number(externalPlan.deliveryCopper) || 0)
    };
    return plan;
  }

  _marketSourceHash(data, holding, marketId = "") {
    return stableDataHash({
      holding,
      eventRegions: data?.catalog?.eventRegions,
      marketEconomy: data?.catalog?.marketEconomy,
      marketRouteMap: data?.catalog?.marketRouteMap,
      resources: data?.catalog?.resources,
      marketId: String(marketId ?? ""),
      carrierId: String(this.carrierId ?? ""),
      serviceLevel: String(this.serviceLevel ?? "standard"),
      exportCarrierId: String(this.exportCarrierId ?? ""),
      exportServiceLevel: String(this.exportServiceLevel ?? "charter")
    });
  }

  _marketSnapshot({ isGM = Boolean(game.user?.isGM), data: suppliedData = null } = {}) {
    const data = suppliedData ?? SkyholdData.view();
    const { holding: sourceHolding } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
    const locations = data?.catalog?.eventRegions ?? [];
    const economy = normalizeMarketEconomy(data?.catalog?.marketEconomy, { locations });
    const resources = allResourceDefs({ catalogRows: data?.catalog?.resources });
    const markets = this._availableMarkets(data, { holding: sourceHolding, isGM, economy, resources });
    const market = markets.find((row) => row.id === this.marketId) ?? markets[0] ?? null;
    if (market && market.id !== this.marketId) this.marketId = market.id;
    if (!sourceHolding) return { data, holding: null, markets, market, quote: null, plan: null, sellQuote: null, exportPlan: null, marketIntegrity: { ready: true, issues: [] }, sourceHash: "" };
    const sourceHash = this._marketSourceHash(data, sourceHolding, market?.id);
    // Quote projection lazily materializes ledger lines. Rendering must never
    // mutate SkyholdData.view(), so all quote work happens on a detached copy.
    const holding = clone(sourceHolding);
    const quote = this._marketQuote(holding, data, market, { isGM, economy, resources });
    const plan = this._purchasePlan(holding, quote);
    const sellQuote = this._marketSellQuote(holding, data, market, { isGM, economy, resources });
    const exportPlan = this._exportPlan(holding, sellQuote);
    const marketIntegrity = analyzeMarketIntegrity({ quotes: [quote, sellQuote].filter(Boolean) });
    return {
      data,
      holding,
      markets,
      market,
      quote,
      plan,
      sellQuote,
      exportPlan,
      marketIntegrity,
      sourceHash
    };
  }

  async _enrichMarketQuoteItems(quote) {
    if (!quote?.offers?.some((offer) => offer.sourceType === "item")) return quote;
    if (!(this._itemMetadataCache instanceof Map)) this._itemMetadataCache = new Map();
    const offers = await Promise.all(quote.offers.map(async (offer) => {
      if (offer.sourceType !== "item" || (offer.configuredName && offer.configuredImg)) return offer;
      const uuid = String(offer.itemUuid ?? "");
      if (!uuid) return offer;
      let metadata = this._itemMetadataCache.get(uuid);
      if (!metadata) {
        try {
          const document = await resolveFoundryUuid(uuid);
          metadata = document ? { name: String(document.name ?? ""), img: String(document.img ?? ""), type: String(document.type ?? "") } : {};
        } catch (_error) { metadata = {}; }
        this._itemMetadataCache.set(uuid, metadata);
      }
      return {
        ...offer,
        name: offer.configuredName || metadata.name || offer.name,
        img: offer.configuredImg || metadata.img || offer.img,
        itemType: metadata.type || offer.itemType || ""
      };
    }));
    return { ...quote, offers };
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    let { data, holding, markets, market, quote, plan, sellQuote, exportPlan, marketIntegrity } = this._marketSnapshot();
    const permissions = holdingPermissionContext(holding);
    const workflow = getSkyholdWorkflowService();
    const rooms = holding ? workflow._storageRooms(holding, { includeUnavailable: false }) : [];
    const availableRoomIds = new Set(rooms.map((room) => String(room.id ?? "")));
    if (!availableRoomIds.has(this.targetRoomId)) {
      const preferred = String(holding?.special?.market?.preferredRoomId ?? "outdoors") || "outdoors";
      this.targetRoomId = availableRoomIds.has(preferred) ? preferred : (availableRoomIds.has("outdoors") ? "outdoors" : String(rooms[0]?.id ?? "outdoors"));
      plan = this._purchasePlan(holding, quote);
    }
    quote = await this._enrichMarketQuoteItems(quote);
    const exportBook = holding?.special?.market?.exportBook ?? { version: 1, orders: [], advanceRuns: [] };
    const roomLabels = new Map(rooms.map((room) => [String(room.id ?? ""), String(room.name ?? room.label ?? room.id ?? "Хранилище")]));
    const sellCandidates = (sellQuote?.offers ?? []).map((offer) => {
      const storageRows = exportStorageRows(holding, exportBook, offer.resourceId);
      const availableQty = storageRows.reduce((sum, row) => sum + row.availableQty, 0);
      const bidDemand = Math.max(0, Math.floor(Number(offer.bidDemand) || 0));
      const maxQty = Math.min(availableQty, bidDemand);
      return { offer, storageRows, availableQty, bidDemand, maxQty };
    }).filter((row) => row.maxQty > 0 && Math.max(0, Number(row.offer?.bidUnitCopper) || 0) > 0 && row.offer?.sourceType !== "item");
    if (!sellCandidates.some((row) => String(row.offer?.id ?? "") === String(this.exportOfferId ?? ""))) {
      this.exportOfferId = String(sellCandidates[0]?.offer?.id ?? "");
      this.exportQuantity = 0;
    }
    const selectedSellCandidate = sellCandidates.find((row) => String(row.offer?.id ?? "") === this.exportOfferId) ?? null;
    this.exportQuantity = Math.max(0, Math.min(selectedSellCandidate?.maxQty ?? 0, Math.floor(Number(this.exportQuantity) || 0)));
    exportPlan = this._exportPlan(holding, sellQuote);
    const selectionHints = { ...this.merchantSelections };
    for (const offer of quote?.offers ?? []) {
      if ((Number(this.quantities[offer.id]) || 0) <= 0) continue;
      const sourceOfferId = String(offer.sourceOfferId ?? offer.id ?? "");
      if (sourceOfferId && !selectionHints[sourceOfferId]) selectionHints[sourceOfferId] = String(offer.providerId ?? "");
    }
    const offerGroups = groupMarketOffers(quote?.offers ?? [], selectionHints);
    for (const group of offerGroups) {
      const selectedOffer = group.selectedOffer;
      if (!selectedOffer) continue;
      this.merchantSelections[group.sourceOfferId] = String(selectedOffer.providerId ?? "");
    }
    if (quote) plan = this._purchasePlan(holding, quote);
    const selectedCount = plan?.lines?.reduce((sum, line) => sum + line.qty, 0) ?? 0;
    const activeShipmentOrders = (holding?.special?.market?.orders ?? [])
      .filter((order) => ["pending", "in-transit", "delayed"].includes(String(order?.status ?? "")));
    const shipments = activeShipmentOrders
      .slice(0, 12)
      .map((order) => {
        const cancellation = marketShipmentCancellationQuote(order);
        return {
          ...order,
          statusLabel: shipmentStatusLabel(order.status),
          canDeliverNow: Boolean(permissions.isGM && permissions.writeAvailable && !order.ownedVesselDelivery && ["pending", "in-transit", "delayed"].includes(String(order.status ?? ""))),
          canCancel: Boolean(permissions.canManageMarkets && cancellation.cancellable),
          cancellationRefundText: formatCopperCurrency(cancellation.refundCopper),
          cancellationWithheldText: formatCopperCurrency(cancellation.withheldCopper),
          serviceText: marketServiceLabel(order.serviceLevel),
          batchText: Number(order.batchCount) > 1 ? `партия ${Math.max(1, Number(order.batchIndex) + 1)} из ${order.batchCount}` : "одна партия",
          remainingText: `${Math.max(0, Number(order.remainingQd) || 0)} QD`,
          riskText: shipmentRiskText(order),
          totalText: formatCopperCurrency(order.totalCopper),
          routeText: (order.routePath ?? []).map((id) => String(id)).join(" → "),
          carrierText: String(order.carrierLabel ?? "") || "Независимые перевозчики",
          cargoText: (order.cargo ?? order.lines ?? []).map((line) => `${line.name || "Товар"} ×${line.qty || 0}`).slice(0, 4).join(" · ")
        };
      });
    const shipmentArchive = (holding?.special?.market?.orders ?? [])
      .filter((order) => ["delivered", "lost", "cancelled"].includes(String(order?.status ?? "")))
      .slice(-20)
      .slice()
      .reverse()
      .map((order) => ({
        ...order,
        statusLabel: shipmentStatusLabel(order.status),
        statusText: shipmentRiskText(order),
        orderedText: shipmentDateText(order.orderedAt),
        totalText: formatCopperCurrency(order.totalCopper),
        routeText: (order.routePath ?? []).map((id) => String(id)).join(" → ") || "Локальная доставка",
        carrierText: String(order.carrierLabel ?? "") || "Независимые перевозчики",
        batchText: Number(order.batchCount) > 1 ? `партия ${Math.max(1, Number(order.batchIndex) + 1)} из ${order.batchCount}` : "одна партия",
        cargoText: (order.cargo ?? order.lines ?? []).map((line) => `${line.name || "Товар"} ×${line.qty || 0}`).slice(0, 6).join(" · "),
        timeline: shipmentTimeline(order)
      }));
    const isSellMode = this.tradeMode === "sell";
    const activeQuote = isSellMode ? sellQuote : quote;
    const regionLabels = new Map((data?.catalog?.eventRegions ?? []).map((row) => [String(row.value ?? ""), String(row.label ?? row.value ?? "")]));
    const routePathText = (activeQuote?.logistics?.routePath ?? []).map((id) => regionLabels.get(String(id)) ?? String(id)).join(" → ");
    const merchantTones = new Map((quote?.merchantProviders ?? []).map((provider, index) => [String(provider.id ?? ""), index % 6]));
    const shipmentBatches = Array.isArray(plan?.shipmentBatches) ? plan.shipmentBatches : [];
    const selectedBatchIndex = Math.min(Math.max(0, Math.floor(Number(this.batchPreviewIndex) || 0)), Math.max(0, shipmentBatches.length - 1));
    this.batchPreviewIndex = selectedBatchIndex;
    const shipmentBatchPreviews = shipmentBatches.map((batch, index) => marketBatchPreview(batch, plan, index === selectedBatchIndex));
    const exportOrders = Array.isArray(exportBook.orders) ? exportBook.orders : [];
    const exports = exportOrders
      .filter((order) => ["reserved", "in-transit"].includes(String(order?.status ?? "")))
      .slice(0, 12)
      .map((order) => {
        const frozen = order?.quoteSnapshot ?? {};
        const costs = Math.max(0, Number(frozen?.costs?.totalCopper) || 0);
        const etaQd = Math.max(0, Number(frozen?.route?.etaQd) || 0);
        const remainingQd = Math.max(0, Number(order?.remainingQd ?? etaQd) || 0);
        return {
          id: String(order?.id ?? order?.operationId ?? ""),
          status: String(order?.status ?? "in-transit"),
          statusLabel: exportStatusLabel(order?.status),
          marketLabel: String(frozen?.market?.label ?? "Внешний рынок"),
          offerName: String(frozen?.offer?.name ?? order?.cargoSnapshot?.name ?? "Товар"),
          qty: Math.max(0, Number(order?.qty) || 0),
          unit: compactResourceUnit(frozen?.offer?.unit ?? "ед."),
          remainingText: `${remainingQd} QD`,
          etaText: `${etaQd} QD`,
          carrierText: String(frozen?.route?.carrierLabel ?? frozen?.freight?.serviceLabel ?? "Внешний перевозчик"),
          grossText: formatCopperCurrency(frozen?.bid?.grossCopper ?? 0),
          costsText: formatCopperCurrency(costs),
          netText: formatCopperCurrency(frozen?.projectedNetCopper ?? 0),
          riskText: `Утрата ${percentText(frozen?.risk?.lossChance)}${Number(frozen?.insurance?.payoutCopper) > 0 ? ` · страховка ${formatCopperCurrency(frozen.insurance.payoutCopper)}` : " · без страховой выплаты"}`
        };
      });
    const exportArchive = exportOrders
      .filter((order) => ["delivered", "lost", "cancelled"].includes(String(order?.status ?? "")))
      .slice(-20)
      .reverse()
      .map((order) => {
        const frozen = order?.quoteSnapshot ?? {};
        const settlement = order?.settlement ?? {};
        const status = String(order?.status ?? "cancelled");
        const resolvedAt = order?.deliveredAt ?? order?.lostAt ?? order?.cancelledAt ?? "";
        return {
          status,
          statusLabel: exportStatusLabel(status),
          marketLabel: String(frozen?.market?.label ?? "Внешний рынок"),
          offerName: String(frozen?.offer?.name ?? order?.cargoSnapshot?.name ?? "Товар"),
          qty: Math.max(0, Number(order?.qty) || 0),
          unit: compactResourceUnit(frozen?.offer?.unit ?? "ед."),
          resolvedText: shipmentDateText(resolvedAt),
          outcomeText: status === "delivered" ? "продано по зафиксированной ставке" : status === "lost" ? "груз утрачен в пути" : "контракт отменён до отправки",
          grossText: formatCopperCurrency(settlement?.grossCopper ?? 0),
          costsText: formatCopperCurrency(settlement?.costs?.totalCopper ?? frozen?.costs?.totalCopper ?? 0),
          insurancePayoutText: formatCopperCurrency(settlement?.insurancePayoutCopper ?? 0),
          netText: formatCopperCurrency(settlement?.netCopper ?? (status === "cancelled" ? 0 : frozen?.projectedNetCopper ?? 0))
        };
      });
    const exportFinancials = exportPlan?.financials ?? {};
    return {
      ...context,
      isBuyMode: !isSellMode,
      isSellMode,
      holding,
      hasHolding: Boolean(holding),
      hasMarket: Boolean(market),
      marketLabel: market?.label ?? "—",
      marketDescription: market?.description ?? "",
      marketCountryLabel: market?.countryLabel ?? "—",
      marketSizeLabel: market?.sizeLabel ?? "—",
      marketConditionLabel: market?.conditionLabel ?? "Стабильно",
      marketOptions: markets.map((row) => ({ value: row.id, label: `${row.label} · ${row.routeAccessCost ? `УРС ${row.routeAccessCost}` : "локально"}`, selected: row.id === market?.id })),
      merchantProviders: (quote?.merchantProviders ?? []).map((provider) => ({
        ...provider,
        shareText: `${Math.round(Number(provider.sharePct ?? 0))}%`
      })),
      carrierOptions: (activeQuote?.carriers ?? []).map((carrier) => ({
        value: carrier.id,
        label: carrier.ownFleet
          ? `${carrier.label} · ${cargoPointsText(carrier.capacityCargoPoints)} · ${carrier.available ? `забор ${carrier.pickupQd} QD + доставка ${carrier.cargoQd} QD` : carrier.reason || "недоступен"}`
          : `${carrier.label} · до ${cargoPointsText(
            Math.max(0, Number(activeQuote?.referenceLogistics?.baseCapacityCargoPoints ?? activeQuote?.logistics?.baseCapacityCargoPoints ?? activeQuote?.logistics?.capacityCargoPoints) || 0)
              * Math.max(0.1, Number(carrier.capacityFactor) || 1)
              || carrierCapacityForLogistics(activeQuote?.referenceLogistics ?? activeQuote?.logistics, carrier).capacityLoad * 10
          )} · цена ×${Number(carrier.priceFactor || 1).toFixed(2)}`,
        selected: carrier.id === activeQuote?.selectedCarrierId,
        disabled: carrier.ownFleet && !carrier.available
      })),
      hasCarrierChoice: (activeQuote?.carriers ?? []).length > 1,
      carrierLabel: activeQuote?.logistics?.carrierLabel || "Независимые перевозчики",
      canPurchase: Boolean(holding && permissions.canManageMarkets),
      canOrder: Boolean(holding && permissions.canManageMarkets && activeQuote?.logistics?.ok !== false),
      readOnlyReason: permissions.canManageMarkets
        ? ""
        : (permissions.mayManageMarkets ? "Рыночные операции временно недоступны: нет активного authority-GM." : "GM не делегировал управление внешним рынком."),
      marketIntegrityOk: marketIntegrity?.ready !== false,
      marketIntegrityMessage: (marketIntegrity?.issues ?? []).filter((issue) => issue.severity === "error").map((issue) => issue.message).slice(0, 3).join(" "),
      logisticsOk: activeQuote?.logistics?.ok !== false,
      logisticsReason: (activeQuote?.logistics?.reasons ?? []).join(" "),
      transportLabel: activeQuote?.logistics?.transportLabel ?? "—",
      routeDistanceText: activeQuote?.logistics ? `${activeQuote.logistics.hops} перех. · ${activeQuote.logistics.distanceText}` : "—",
      routePathText: routePathText || "—",
      marketAccessText: activeQuote?.logistics ? `УРС ${activeQuote.logistics.accessLevel} · рынок ${activeQuote.logistics.requiredAccessLevel}` : "—",
      routeRiskText: activeQuote?.logistics ? `×${Number(activeQuote.logistics.riskFactor || 1).toFixed(2)}` : "—",
      routeSeasonText: activeQuote?.logistics?.seasonalEdgeCount
        ? `${marketSeasonLabel(activeQuote.logistics.seasonId)} · ${activeQuote.logistics.seasonalEdgeCount} участ.`
        : "нет активной надбавки",
      treasuryText: formatCopperCurrencyCompact(plan?.treasuryCopper ?? holding?.storage?.moneyCopper ?? 0),
      treasuryParts: copperCurrencyParts(plan?.treasuryCopper ?? holding?.storage?.moneyCopper ?? 0),
      offers: offerGroups.map((group) => {
        const line = prepareLine(group.selectedOffer, this.quantities[group.selectedOffer.id]);
        const totals = marketOfferGroupTotals(group.offers, this.quantities);
        return {
          ...line,
          selected: totals.totalQty > 0,
          selectedProviderCount: totals.providerCount,
          totalQty: totals.totalQty,
          lineText: formatCopperCurrencyCompact(totals.totalCopper),
          lineParts: copperCurrencyParts(totals.totalCopper),
          sourceOfferId: group.sourceOfferId,
          providerChips: group.offers.map((offer) => {
            const quantity = Math.max(0, Math.min(Math.max(0, Number(offer.stock) || 0), Math.floor(Number(this.quantities[offer.id]) || 0)));
            const providerLabel = String(offer.providerLabel ?? "Продавец");
            return {
              providerId: String(offer.providerId ?? ""),
              providerLabel,
              abbreviation: merchantAbbreviation(providerLabel),
              tone: merchantTones.get(String(offer.providerId ?? "")) ?? merchantTone(offer.providerId),
              active: offer.id === group.selectedOffer.id,
              hasQuantity: quantity > 0,
              quantity,
              tooltip: `${providerLabel} · ${formatCopperCurrency(offer.unitPriceCopper)} · доступно ${Math.max(0, Number(offer.stock) || 0)} ${String(offer.unit ?? "ед.")}${quantity > 0 ? ` · в заказе ${quantity}` : ""}`,
              offerId: String(offer.id ?? ""),
              stock: Math.max(0, Number(offer.stock) || 0)
            };
          }),
          searchText: `${line.searchText} ${group.offers.map((offer) => offer.providerLabel).filter(Boolean).join(" ")}`.toLocaleLowerCase("ru")
        };
      }),
      sellOffers: sellCandidates.map(({ offer, storageRows, availableQty, bidDemand, maxQty }) => {
        const selected = String(offer.id ?? "") === String(this.exportOfferId ?? "");
        const qty = selected ? this.exportQuantity : 0;
        const unitPriceCopper = Math.max(0, Number(offer.bidUnitCopper) || 0);
        const roomsText = storageRows.map((row) => `${roomLabels.get(row.roomId) ?? row.roomId} ×${row.availableQty}`).join(" · ");
        return {
          ...offer,
          id: String(offer.id ?? offer.offerId ?? ""),
          unitFull: String(offer.unit ?? "ед."),
          unit: compactResourceUnit(offer.unit),
          availableQty,
          bidDemand,
          maxQty,
          qty,
          selected,
          priceText: formatCopperCurrencyCompact(unitPriceCopper),
          priceParts: copperCurrencyParts(unitPriceCopper),
          lineText: formatCopperCurrencyCompact(unitPriceCopper * qty),
          lineParts: copperCurrencyParts(unitPriceCopper * qty),
          roomsText,
          searchText: [offer.name, offer.kindLabel, offer.resourceId, roomsText, ...(offer.tags ?? [])].filter(Boolean).join(" ").toLocaleLowerCase("ru")
        };
      }),
      exportSelectedCount: this.exportQuantity,
      hasExportSelection: Boolean(this.exportOfferId),
      exportGrossText: formatCopperCurrency(exportFinancials.grossCopper ?? 0),
      exportFreightText: formatCopperCurrency(exportFinancials.freightCopper ?? 0),
      exportHandlingText: formatCopperCurrency(exportFinancials.handlingCopper ?? 0),
      exportTaxText: formatCopperCurrency(exportFinancials.taxCopper ?? 0),
      exportInsuranceText: formatCopperCurrency(exportFinancials.insuranceCopper ?? 0),
      exportTotalCostsText: formatCopperCurrency(exportFinancials.totalCostCopper ?? 0),
      exportNetText: formatCopperCurrency(exportFinancials.projectedNetCopper ?? 0),
      exportNetPositive: Number(exportFinancials.projectedNetCopper ?? 0) >= 0,
      exportEtaText: `${Math.max(0, Number(exportPlan?.eta?.qd) || 0)} QD${Number(exportPlan?.eta?.batchCount) > 1 ? ` · ${marketTripCountText(exportPlan.eta.batchCount)}` : ""}`,
      exportLossChanceText: percentText(exportPlan?.risk?.lossChance),
      exportInsurancePayoutText: formatCopperCurrency(exportPlan?.risk?.insurancePayoutCopper ?? 0),
      exportCargoText: cargoPointsText(exportPlan?.capacity?.requiredCargoPoints),
      exportCapacityText: `${cargoPointsText(exportPlan?.capacity?.requiredCargoPoints)} / ${cargoPointsText(exportPlan?.capacity?.bookingCapacityCargoPoints)}`,
      exportDemandText: `${Math.max(0, Number(exportPlan?.demand?.availableQty ?? selectedSellCandidate?.bidDemand) || 0)} ед.`,
      exportReserveText: `${formatCopperCurrency(exportPlan?.dispatchCash?.requiredCopper ?? 0)} сейчас · доступно ${formatCopperCurrency(exportPlan?.dispatchCash?.availableCopper ?? holding?.storage?.moneyCopper ?? 0)}`,
      exportIssues: this.exportQuantity > 0 ? (exportPlan?.issues ?? []) : [],
      canConfirmExport: Boolean(permissions.canManageMarkets && marketIntegrity?.ready !== false && this.exportQuantity > 0 && exportPlan?.ready),
      exportServiceStandard: this.exportServiceLevel === "standard",
      exportServiceExpress: this.exportServiceLevel === "express",
      exportServiceCharter: this.exportServiceLevel === "charter",
      exports,
      hasExports: exports.length > 0,
      exportArchive,
      hasExportArchive: exportArchive.length > 0,
      hiddenOfferCount: Math.max(0, Number(activeQuote?.hiddenOfferCount) || 0),
      rooms: rooms.map((room) => ({ ...room, selected: room.id === this.targetRoomId })),
      search: this.search,
      kind: this.kind,
      kindAll: this.kind === "all",
      kindMaterial: this.kind === "material",
      kindResource: this.kind === "resource",
      kindConsumable: this.kind === "consumable",
      selectedCount,
      hasSelection: selectedCount > 0,
      hasCapacityLimit: Boolean(plan?.hasCapacityLimit),
      capacityExceeded: Boolean(plan?.capacityExceeded),
      totalLoadValue: Math.max(0, Math.min(100, (Number(plan?.finalBatchCapacityShare) || 0) * 100)),
      capacityLoadValue: 100,
      totalCargoPointsText: cargoPointsText(plan?.totalCargoPoints),
      bookingCapacityCargoPointsText: cargoPointsText(plan?.bookingCapacityCargoPoints),
      physicalCapacityCargoPointsText: cargoPointsText(plan?.physicalCapacityCargoPoints),
      capacityRemainingCargoPointsText: cargoPointsText(plan?.capacityRemainingCargoPoints),
      finalBatchCargoPointsText: cargoPointsText(plan?.finalBatchCargoPoints),
      batchCount: Math.max(0, Number(plan?.batchCount) || 0),
      batchCountText: marketTripCountText(plan?.batchCount),
      hasMultipleShipmentBatches: shipmentBatchPreviews.length > 1,
      shipmentBatchPreviews,
      selectedShipmentBatch: shipmentBatchPreviews[selectedBatchIndex] ?? null,
      subtotalText: formatCopperCurrencyCompact(plan?.subtotalCopper ?? 0),
      subtotalParts: copperCurrencyParts(plan?.subtotalCopper ?? 0),
      deliveryText: formatCopperCurrencyCompact(plan?.deliveryCopper ?? 0),
      deliveryParts: copperCurrencyParts(plan?.deliveryCopper ?? 0),
      routeCostText: formatCopperCurrencyCompact(plan?.routeCopper ?? 0),
      routeCostParts: copperCurrencyParts(plan?.routeCopper ?? 0),
      taxText: formatCopperCurrencyCompact(plan?.taxCopper ?? 0),
      taxParts: copperCurrencyParts(plan?.taxCopper ?? 0),
      handlingText: formatCopperCurrencyCompact(plan?.handlingCopper ?? 0),
      handlingParts: copperCurrencyParts(plan?.handlingCopper ?? 0),
      insuranceText: formatCopperCurrencyCompact(plan?.insuranceCopper ?? 0),
      insuranceParts: copperCurrencyParts(plan?.insuranceCopper ?? 0),
      expressSurchargeText: formatCopperCurrencyCompact(plan?.expressSurchargeCopper ?? 0),
      expressSurchargeParts: copperCurrencyParts(plan?.expressSurchargeCopper ?? 0),
      hasExpressSurcharge: Number(plan?.expressSurchargeCopper ?? 0) > 0,
      serviceLevel: plan?.serviceLevel ?? "standard",
      serviceDescription: marketServiceDescription(plan?.serviceLevel),
      serviceStandard: plan?.serviceLevel === "standard",
      serviceExpress: plan?.serviceLevel === "express",
      serviceCharter: plan?.serviceLevel === "charter",
      serviceOwned: plan?.serviceLevel === FLEET_OWNED_DELIVERY_SERVICE,
      ownedVesselDelivery: Boolean(plan?.ownedVesselDelivery),
      ownedVesselName: String(plan?.ownedVesselName ?? ""),
      ownedCapacityText: cargoPointsText(plan?.logistics?.ownedCapacityCargoPoints ?? plan?.physicalCapacityCargoPoints),
      ownedPickupTimingText: `${Math.max(0, Number(plan?.ownedPickupQd) || 0)} QD`,
      ownedCargoTimingText: `${Math.max(0, Number(plan?.ownedCargoQd) || 0)} QD`,
      ownedHandlingTimingText: `${Math.max(0, Number(plan?.ownedHandlingQd) || 0)} QD`,
      ownedOperatingCostText: formatCopperCurrency(plan?.ownedOperatingCostCopper ?? 0),
      ownedReplacementReserveText: formatCopperCurrency(plan?.ownedReplacementReserveCopper ?? 0),
      hasExternalComparison: Boolean(plan?.ownedVesselDelivery && plan?.externalComparison),
      externalComparisonCarrier: String(plan?.externalComparison?.carrierLabel ?? "Внешний перевозчик"),
      externalComparisonCapacityText: cargoPointsText(plan?.externalComparison?.capacityCargoPoints),
      externalComparisonDeliveryText: formatCopperCurrency(plan?.externalComparison?.deliveryCopper ?? 0),
      externalComparisonEtaText: `${Math.max(0, Number(plan?.externalComparison?.deliveryQd) || 0)} QD`,
      externalComparisonDifferenceText: `${Number(plan?.externalComparison?.differenceCopper) >= 0 ? "+" : "−"}${formatCopperCurrency(Math.abs(Number(plan?.externalComparison?.differenceCopper) || 0))}`,
      externalComparisonMoreExpensive: Number(plan?.externalComparison?.differenceCopper) > 0,
      expressAvailable: plan?.deliveryMode === "scheduled",
      riskLossChanceText: percentText(plan?.riskLossChance),
      riskDelayChanceText: percentText(plan?.riskDelayChance),
      riskMaxDelayText: `${Math.max(1, Number(plan?.riskMaxDelayQd) || 1)} QD`,
      insuranceCoverageText: percentText(plan?.insuranceCoverageRate),
      insuranceMaximumPayoutText: formatCopperCurrency(plan?.maximumInsurancePayoutCopper ?? 0),
      hasTax: Number(plan?.taxCopper ?? 0) > 0,
      hasHandling: Number(plan?.handlingCopper ?? 0) > 0,
      hasInsurance: Number(plan?.insuranceCopper ?? 0) > 0,
      deliveryTimingText: plan?.deliveryMode === "scheduled"
        ? (Number(plan?.batchCount) > 1 ? `${plan.firstDeliveryQd}–${plan.deliveryQd} QD` : `${plan.deliveryQd} QD`)
        : "сразу",
      scheduledDelivery: plan?.deliveryMode === "scheduled",
      totalText: formatCopperCurrencyCompact(plan?.totalCopper ?? 0),
      totalParts: copperCurrencyParts(plan?.totalCopper ?? 0),
      balanceAfterText: formatCopperCurrencyCompact(Math.max(0, plan?.balanceAfterCopper ?? 0)),
      balanceAfterParts: copperCurrencyParts(Math.max(0, plan?.balanceAfterCopper ?? 0)),
      deliveryBreakdown: {
        distanceText: `${Number(plan?.deliveryBreakdown?.distanceKm ?? 0)} км · ${Math.max(0, Number(plan?.deliveryBreakdown?.hops) || 0)} перех. · УРС ${Math.max(0, Number(plan?.deliveryBreakdown?.accessCost) || 0)}`,
        dispatchText: formatCopperCurrencyCompact(plan?.deliveryBreakdown?.dispatchCopper ?? 0),
        distanceTariffText: formatCopperCurrencyCompact((plan?.deliveryBreakdown?.routeDistanceCopper ?? 0) + (plan?.deliveryBreakdown?.configuredDistanceFlatCopper ?? 0)),
        factorText: `регион ×${Number(plan?.deliveryBreakdown?.distanceFactor ?? 1).toFixed(2)} · перевозчик ×${Number(plan?.deliveryBreakdown?.carrierPriceFactor ?? 1).toFixed(2)}`,
        airshipHireText: formatCopperCurrencyCompact(plan?.deliveryBreakdown?.airshipHireCopper ?? 0),
        operatingTimeText: formatCopperCurrencyCompact(plan?.deliveryBreakdown?.operatingTimeCopper ?? 0),
        fullCapacityCargoPointsText: `${cargoPointsText(plan?.deliveryBreakdown?.physicalCapacityCargoPoints)} · составляющая тарифа ${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.fullVesselLoadCopper ?? 0)}`,
        fullOneWayOperatingText: formatCopperCurrencyCompact(plan?.deliveryBreakdown?.fullOneWayOperatingCopper ?? 0),
        operatingLegsText: Number(plan?.deliveryBreakdown?.operatingLegFactor ?? 1) > 1 ? "2 плеча: доставка + возврат/перегон" : "1 плечо; обратный рейс оплачивает другой груз",
        capacityShareText: plan?.hasCapacityLimit
          ? `${percentText(plan?.deliveryBreakdown?.capacityShare ?? 0)} полной сметы · ${marketTripCountText(plan?.batchCount)}`
          : "без лимита · полная операционная смета",
        operationalFormulaText: `${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.fullOneWayOperatingCopper ?? 0)} × суммарная доля ${percentText(plan?.deliveryBreakdown?.capacityShare ?? 0)} × ${Number(plan?.deliveryBreakdown?.operatingLegFactor ?? 1)} плеч. = ${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.operationalFreightCopper ?? 0)}`,
        routeTotalFormulaText: `операционный фрахт всех партий = ${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.routeCopper ?? 0)}`,
        handlingFormulaText: `погрузка каждой из ${marketTripCountText(plan?.batchCount)} + тариф грузовых очков = ${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.handlingCopper ?? 0)}`,
        insuranceFormulaText: `${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.subtotalCopper ?? 0)} × ${percentText(plan?.deliveryBreakdown?.insuranceRate ?? 0)} = ${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.insuranceCopper ?? 0)}`,
        taxFormulaText: `${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.subtotalCopper ?? 0)} × ${percentText(plan?.deliveryBreakdown?.taxRate ?? 0)} = ${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.taxCopper ?? 0)}`,
        expressText: formatCopperCurrencyCompact(plan?.deliveryBreakdown?.expressSurchargeCopper ?? 0),
        totalFormulaText: `${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.routeCopper ?? 0)} + ${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.handlingCopper ?? 0)} + ${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.insuranceCopper ?? 0)} + ${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.taxCopper ?? 0)} + ${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.expressSurchargeCopper ?? 0)} = ${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.deliveryCopper ?? 0)}`
      },
      deliveryBreakdownOpen: this.deliveryBreakdownOpen,
      insufficientFunds: Boolean(plan?.insufficientFunds),
        canConfirm: Boolean(permissions.canManageMarkets && marketIntegrity?.ready !== false && plan?.ok),
      shipments,
      hasShipments: shipments.length > 0,
      activeShipmentCount: activeShipmentOrders.length,
      hiddenShipmentCount: Math.max(0, activeShipmentOrders.length - shipments.length),
      hasHiddenShipments: activeShipmentOrders.length > shipments.length,
      shipmentArchive,
      hasShipmentArchive: shipmentArchive.length > 0
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    restorePersistentImages(root, this._pendingPersistentImages);
    this._pendingPersistentImages = null;
    bindImageFallbacks(root);
    bindFloatingTooltips(this, root, { followPointer: true });
    this._marketAbortController?.abort?.();
    const controller = new AbortController();
    this._marketAbortController = controller;
    const listenerOptions = { signal: controller.signal };
    root.addEventListener("click", (event) => this._onClick(event, root), listenerOptions);
    root.addEventListener("contextmenu", (event) => this._onContextMenu(event, root), listenerOptions);
    root.addEventListener("change", (event) => this._onChange(event, root), listenerOptions);
    root.addEventListener("input", (event) => this._onInput(event, root), listenerOptions);
    const deliveryDetails = root.querySelector?.("[data-market-delivery-breakdown]");
    deliveryDetails?.addEventListener?.("toggle", () => {
      this.deliveryBreakdownOpen = Boolean(deliveryDetails.open);
    }, listenerOptions);
    this._applyFilters(root);
  }

  _onClick(event, root) {
    const element = event.target?.closest?.("[data-action]");
    if (!element || !root.contains(element)) return;
    const action = String(element.dataset.action ?? "");
    if (action === "market-set-trade-mode") {
      event.preventDefault();
      this.tradeMode = element.dataset.mode === "sell" ? "sell" : "buy";
      this.requestRender({ focus: false });
    } else if (action === "market-select-merchant") {
      event.preventDefault();
      const sourceOfferId = String(element.dataset.sourceOfferId ?? "");
      if (sourceOfferId) this.merchantSelections[sourceOfferId] = String(element.dataset.providerId ?? "");
      this._requestOfferRender();
    } else if (action === "market-quantity-step") {
      event.preventDefault();
      const offerId = String(element.dataset.offerId ?? "");
      const step = Number(element.dataset.step) || 0;
      const stock = Math.max(0, Number(element.dataset.stock) || 0);
      this._setMarketQuantity(offerId, Math.floor(Number(this.quantities[offerId]) || 0) + step, stock);
    } else if (action === "market-clear") {
      event.preventDefault();
      this.quantities = {};
      this.batchPreviewIndex = 0;
      this.requestRender({ focus: false });
    } else if (action === "market-buy") {
      event.preventDefault();
      this._onBuy();
    } else if (action === "market-export-select") {
      event.preventDefault();
      const offerId = String(element.dataset.offerId ?? "");
      if (offerId) {
        const changed = offerId !== this.exportOfferId;
        this.exportOfferId = offerId;
        if (changed || this.exportQuantity <= 0) this.exportQuantity = 1;
      }
      this.requestRender({ focus: false });
    } else if (action === "market-export-quantity-step") {
      event.preventDefault();
      const offerId = String(element.dataset.offerId ?? "");
      if (offerId && offerId !== this.exportOfferId) {
        this.exportOfferId = offerId;
        this.exportQuantity = 0;
      }
      const step = Number(element.dataset.step) || 0;
      const max = Math.max(0, Number(element.dataset.max) || 0);
      this._setExportQuantity(this.exportQuantity + step, max);
    } else if (action === "market-export-clear") {
      event.preventDefault();
      this.exportOfferId = "";
      this.exportQuantity = 0;
      this.requestRender({ focus: false });
    } else if (action === "market-export-dispatch") {
      event.preventDefault();
      this._onExport();
    } else if (action === "market-deliver-shipment") {
      event.preventDefault();
      this._onDeliverShipment(element);
    } else if (action === "market-cancel-shipment") {
      event.preventDefault();
      this._onCancelShipment(element);
    }
  }

  _onContextMenu(event, root) {
    const element = event.target?.closest?.('[data-action="market-quantity-step"], [data-action="market-export-quantity-step"]');
    if (!element || !root.contains(element) || element.disabled) return;
    event.preventDefault();
    if (element.dataset.action === "market-export-quantity-step") {
      const offerId = String(element.dataset.offerId ?? "");
      if (offerId) this.exportOfferId = offerId;
      const max = Math.max(0, Number(element.dataset.max) || 0);
      const step = Number(element.dataset.step) || 0;
      this._setExportQuantity(step > 0 ? max : 0, max);
      return;
    }
    const offerId = String(element.dataset.offerId ?? "");
    const stock = Math.max(0, Number(element.dataset.stock) || 0);
    const step = Number(element.dataset.step) || 0;
    this._setMarketQuantity(offerId, step > 0 ? stock : 0, stock);
  }

  _setMarketQuantity(offerId, value, stock) {
    if (!offerId) return;
    this.quantities[offerId] = Math.max(0, Math.min(Math.max(0, Number(stock) || 0), Math.floor(Number(value) || 0)));
    this._requestOfferRender();
  }

  _setExportQuantity(value, max) {
    this.exportQuantity = Math.max(0, Math.min(Math.max(0, Number(max) || 0), Math.floor(Number(value) || 0)));
    this._requestOfferRender();
  }

  _requestOfferRender() {
    this.requestRender({ focus: false });
  }

  _onChange(event, root) {
    const batchPreview = event.target?.closest?.("[data-market-batch-preview]");
    if (batchPreview && root.contains(batchPreview)) {
      this.batchPreviewIndex = Math.max(0, Math.floor(Number(batchPreview.value) || 0));
      this.requestRender({ focus: false });
      return;
    }
    const service = event.target?.closest?.("[data-market-service-level]");
    if (service && root.contains(service)) {
      const nextService = ["standard", "express", "charter"].includes(service.value) ? service.value : "standard";
      if (this.tradeMode === "sell") this.exportServiceLevel = nextService;
      else this.serviceLevel = nextService;
      this.batchPreviewIndex = 0;
      this.requestRender({ focus: false });
      return;
    }
    const provider = event.target?.closest?.("[data-market-provider]");
    if (provider && root.contains(provider)) {
      this.marketId = String(provider.value ?? "");
      this.carrierId = "";
      this.batchPreviewIndex = 0;
      this.quantities = {};
      this.merchantSelections = {};
      this.exportOfferId = "";
      this.exportQuantity = 0;
      this.requestRender({ focus: false });
      return;
    }
    const carrier = event.target?.closest?.("[data-market-carrier]");
    if (carrier && root.contains(carrier)) {
      if (this.tradeMode === "sell") {
        this.exportCarrierId = String(carrier.value ?? "");
      } else {
        this.carrierId = String(carrier.value ?? "");
        if (fleetVesselIdFromCarrier(this.carrierId)) this.serviceLevel = FLEET_OWNED_DELIVERY_SERVICE;
        else if (this.serviceLevel === FLEET_OWNED_DELIVERY_SERVICE) this.serviceLevel = "standard";
      }
      this.batchPreviewIndex = 0;
      this.requestRender({ focus: false });
      return;
    }
    const quantity = event.target?.closest?.("[data-market-quantity]");
    if (quantity && root.contains(quantity)) {
      const offerId = String(quantity.dataset.offerId ?? "");
      const stock = Math.max(0, Number(quantity.max) || 0);
      this._setMarketQuantity(offerId, quantity.value, stock);
      return;
    }
    const exportQuantity = event.target?.closest?.("[data-market-export-quantity]");
    if (exportQuantity && root.contains(exportQuantity)) {
      const offerId = String(exportQuantity.dataset.offerId ?? "");
      if (offerId) this.exportOfferId = offerId;
      this._setExportQuantity(exportQuantity.value, exportQuantity.max);
      return;
    }
    const room = event.target?.closest?.("[data-market-room]");
    if (room && root.contains(room)) {
      this.targetRoomId = String(room.value || "outdoors");
      this.requestRender({ focus: false });
      return;
    }
    const kind = event.target?.closest?.("[data-market-kind]");
    if (kind && root.contains(kind)) {
      this.kind = String(kind.value || "all");
      this._applyFilters(root);
    }
  }

  _onInput(event, root) {
    const search = event.target?.closest?.("[data-market-search]");
    if (!search || !root.contains(search)) return;
    this.search = String(search.value ?? "");
    this._applyFilters(root);
  }

  _applyFilters(root) {
    const search = String(this.search ?? "").trim().toLocaleLowerCase("ru");
    let visible = 0;
    for (const row of root.querySelectorAll?.("[data-market-offer]") ?? []) {
      const matchesKind = this.kind === "all" || row.dataset.marketKind === this.kind;
      const matchesSearch = !search || String(row.dataset.marketSearchText ?? "").includes(search);
      row.hidden = !(matchesKind && matchesSearch);
      if (!row.hidden) visible += 1;
    }
    const count = root.querySelector?.("[data-market-visible-count]");
    if (count) count.textContent = String(visible);
  }

  async _resolveMarketItemDocuments(lines = []) {
    const documents = new Map();
    for (const line of lines) {
      if (line.sourceType !== "item") continue;
      const uuid = String(line.itemUuid ?? "").trim();
      if (!uuid) return { ok: false, message: `Для «${line.name}» не указан Item UUID.` };
      let document = null;
      try { document = await resolveFoundryUuid(uuid); } catch (_error) {}
      const documentName = document?.documentName ?? document?.constructor?.documentName;
      if (!document || documentName !== "Item") return { ok: false, message: `Item не найден: ${uuid}.` };
      documents.set(line.id, document);
    }
    return { ok: true, documents };
  }

  async _onExport() {
    const snapshot = this._marketSnapshot();
    const permissions = holdingPermissionContext(snapshot.holding);
    if (!permissions.canManageMarkets) return ui.notifications?.warn?.(permissions.mayManageMarkets ? "Рыночные операции временно недоступны: нет активного authority-GM." : "GM не делегировал управление внешним рынком.");
    const economyStatus = economyV2RuntimeStatus(snapshot.data);
    if (!economyStatus.ready) return ui.notifications?.warn?.(economyStatus.message);
    if (snapshot.marketIntegrity?.ready === false) return ui.notifications?.warn?.(`Рыночная котировка нарушает контракт Market V2: ${snapshot.marketIntegrity.issues?.[0]?.message ?? "проверьте цены и ликвидность"}`);
    const plan = snapshot.exportPlan;
    if (!plan || this.exportQuantity <= 0) return ui.notifications?.warn?.("Выберите один товар и целое количество для продажи.");
    if (!plan.ready) return ui.notifications?.warn?.(plan.issues?.map((issue) => issue.message).filter(Boolean).join(" ") || "Экспортный контракт пока не готов к отправке.");
    const offer = snapshot.sellQuote?.offers?.find?.((row) => String(row?.id ?? "") === String(plan.offerId ?? ""));
    const content = [
      `<p><strong>${String(offer?.name ?? plan.resourceId ?? "Товар")}</strong> ×${plan.totalQty} → ${String(snapshot.sellQuote?.marketLabel ?? "Внешний рынок")}.</p>`,
      `<p>Ожидаемая выручка <strong>${formatCopperCurrency(plan.financials.grossCopper)}</strong>; все расходы ${formatCopperCurrency(plan.financials.totalCostCopper)}; чистый итог ${formatCopperCurrency(plan.financials.projectedNetCopper)}.</p>`,
      `<p>При отправке будут сразу списаны товары и ${formatCopperCurrency(plan.dispatchCash.requiredCopper)} за фрахт, страхование и обработку. Пошлина удерживается только при продаже.</p>`,
      `<p>ETA ${Math.max(0, Number(plan.eta?.qd) || 0)} QD; риск утраты ${percentText(plan.risk?.lossChance)}${Number(plan.risk?.insurancePayoutCopper) > 0 ? `; страховая выплата ${formatCopperCurrency(plan.risk.insurancePayoutCopper)}` : "; без страховой выплаты"}.</p>`
    ].join("");
    const confirmed = await foundryDialogV2().confirm({
      window: { title: "Отправить товар на внешний рынок" },
      content,
      modal: true
    });
    if (!confirmed) return;

    const operationId = makeId("market-export", 20);
    const expectedFingerprint = this._exportPlanFingerprint(plan);
    const result = await requestStorageOperation({
      type: "marketExport",
      operationId,
      expectedRevision: Math.max(0, Number(snapshot.data?.meta?.revision) || 0),
      holdingId: this.holdingId,
      marketId: String(plan.exportQuote?.market?.id ?? this.marketId),
      exportOfferId: this.exportOfferId,
      exportQuantity: this.exportQuantity,
      exportCarrierId: this.exportCarrierId,
      exportServiceLevel: this.exportServiceLevel,
      expectedSourceHash: snapshot.sourceHash,
      expectedFingerprint
    }).catch((error) => ({ ok: false, message: error?.message ?? String(error) }));

    if (!result?.ok) return ui.notifications?.warn?.(result?.message || "Данные поселения или экспортного контракта изменились. Проверьте его ещё раз.");
    this.exportQuantity = 0;
    requestSkyholdAppRender();
    this.requestRender({ focus: false });
    ui.notifications?.info?.(`Экспорт отправлен: ${result.qty} ед., расходы ${formatCopperCurrency(result.upfrontCostsCopper)}, ETA ${result.etaQd} QD. Выручка поступит после прибытия.`);
  }

  async _onBuy() {
    const snapshot = this._marketSnapshot();
    const permissions = holdingPermissionContext(snapshot.holding);
    if (!permissions.canManageMarkets) return ui.notifications?.warn?.(permissions.mayManageMarkets ? "Рыночные операции временно недоступны: нет активного authority-GM." : "GM не делегировал управление внешним рынком.");
    const economyStatus = economyV2RuntimeStatus(snapshot.data);
    if (!economyStatus.ready) return ui.notifications?.warn?.(economyStatus.message);
    if (snapshot.marketIntegrity?.ready === false) return ui.notifications?.warn?.(`Рыночная котировка нарушает контракт Market V2: ${snapshot.marketIntegrity.issues?.[0]?.message ?? "проверьте цены и ликвидность"}`);
    const plan = snapshot.plan;
    if (!plan || plan.empty) return ui.notifications?.warn?.("Корзина рынка пуста.");
    if (plan.inaccessible) return ui.notifications?.warn?.(plan.logistics?.reasons?.join(" ") || "Маршрут к этой площадке недоступен.");
    if (plan.capacityExceeded) {
      const message = plan.ownedVesselDelivery
        ? `Общий груз не помещается в ${marketServiceLabel(plan.serviceLevel)} (${cargoPointsText(plan.bookingCapacityCargoPoints)}). Уменьшите заказ или выберите внешнего перевозчика.`
        : `Одна единица товара не помещается в лимит ${marketServiceLabel(plan.serviceLevel)} (${cargoPointsText(plan.bookingCapacityCargoPoints)}). Выберите Charter или другого перевозчика.`;
      return ui.notifications?.warn?.(message);
    }
    if (plan.insufficientFunds) return ui.notifications?.warn?.("В казне недостаточно денег с учётом доставки.");
    const timing = plan.deliveryMode === "scheduled"
      ? `${marketServiceLabel(plan.serviceLevel)}: ${marketTripCountText(plan.batchCount)}, прибытие ${plan.batchCount > 1 ? `${plan.firstDeliveryQd}–${plan.deliveryQd}` : plan.deliveryQd} QD${plan.serviceLevel === "express" ? `, надбавка ${formatCopperCurrency(plan.expressSurchargeCopper)}` : ""}.`
      : "Груз будет доставлен сразу.";
    const risk = plan.deliveryMode === "scheduled"
      ? (plan.ownedVesselDelivery
        ? `Свой корабль: до точки забора ${plan.ownedPickupQd} QD, погрузка ${plan.ownedHandlingQd} QD, с грузом ${plan.ownedCargoQd} QD. Эксплуатация ${formatCopperCurrency(plan.ownedOperatingCostCopper)}, резерв замены ${formatCopperCurrency(plan.ownedReplacementReserveCopper)}.`
        : `Риск утраты ${percentText(plan.riskLossChance)}, задержки ${percentText(plan.riskDelayChance)}. При утрате страховка возместит до ${formatCopperCurrency(plan.maximumInsurancePayoutCopper)}.`)
      : "";
    const content = `<p><strong>${plan.marketLabel}</strong>: ${plan.lines.length} позиций, товары ${formatCopperCurrency(plan.subtotalCopper)}, доставка ${formatCopperCurrency(plan.deliveryCopper)}.</p><p>Итого: <strong>${formatCopperCurrency(plan.totalCopper)}</strong>. ${plan.logistics?.transportLabel || plan.locationLabel}, дальность ${plan.logistics?.distanceText || "—"}. ${timing}</p>${risk ? `<p>${risk}</p>` : ""}`;
    const confirmed = await foundryDialogV2().confirm({
      window: { title: "Подтвердить покупку на рынке" },
      content,
      modal: true
    });
    if (!confirmed) return;

    const operationId = makeId("market-order", 20);
    const result = await requestStorageOperation({
      type: "marketPurchase",
      operationId,
      expectedRevision: Math.max(0, Number(snapshot.data?.meta?.revision) || 0),
      holdingId: this.holdingId,
      marketId: plan.marketId,
      quantities: this.quantities,
      targetRoomId: this.targetRoomId,
      serviceLevel: this.serviceLevel,
      carrierId: this.carrierId,
      expectedSourceHash: snapshot.sourceHash,
      expectedQuoteKey: plan.quoteKey,
      expectedTotalCopper: plan.totalCopper
    }).catch((error) => ({ ok: false, message: error?.message ?? String(error) }));

    if (!result?.ok) return ui.notifications?.warn?.(result?.message || "Данные поселения или котировки изменились. Проверь корзину ещё раз.");
    this.quantities = {};
    requestSkyholdAppRender();
    this.requestRender({ focus: false });
    ui.notifications?.info?.(result.scheduled
      ? `Заказ принят: ${marketServiceLabel(result.serviceLevel)}, ${marketTripCountText(result.batchCount)}. ETA ${result.batchCount > 1 ? `${result.firstDeliveryQd}–${result.deliveryQd}` : result.deliveryQd} QD, списано ${formatCopperCurrency(result.totalCopper)}.`
      : `Заказ доставлен в поселение. Списано ${formatCopperCurrency(result.totalCopper)}.`);
  }

  async _onCancelShipment(element) {
    const orderId = String(element?.dataset?.orderId ?? "").trim();
    if (!orderId) return;
    const snapshot = this._marketSnapshot();
    const permissions = holdingPermissionContext(snapshot.holding);
    if (!permissions.canManageMarkets) return ui.notifications?.warn?.(permissions.mayManageMarkets ? "Рыночные операции временно недоступны: нет активного authority-GM." : "GM не делегировал управление внешним рынком.");
    const { holding } = snapshot;
    const order = holding?.special?.market?.orders?.find?.((row) => [row?.id, row?.operationId].some((value) => String(value ?? "") === orderId));
    const cancellation = marketShipmentCancellationQuote(order);
    if (!cancellation.cancellable) return ui.notifications?.warn?.(cancellation.reason || "Эту поставку уже нельзя отменить.");
    const cancellationContent = order?.ownedVesselDelivery
      ? `<p>Собственный рейс ещё не начат. Корабль освободится, а в казну вернётся полная сумма: <strong>${formatCopperCurrency(cancellation.refundCopper)}</strong>.</p>`
      : `<p>Заказ ещё не передан перевозчику. В казну вернётся <strong>${formatCopperCurrency(cancellation.refundCopper)}</strong>.</p><p>Бронирование маршрута, обработка и срочная надбавка не возвращаются: ${formatCopperCurrency(cancellation.withheldCopper)}.</p>`;
    const confirmed = await foundryDialogV2().confirm({
      window: { title: "Отменить рыночную поставку" },
      content: cancellationContent,
      modal: true
    });
    if (!confirmed) return;
    const result = await requestStorageOperation({
      type: "marketCancelShipment",
      operationId: makeId("market-cancel", 20),
      expectedRevision: Math.max(0, Number(snapshot.data?.meta?.revision) || 0),
      holdingId: this.holdingId,
      orderId,
      marketId: this.marketId,
      expectedSourceHash: snapshot.sourceHash
    }).catch((error) => ({ ok: false, message: error?.message ?? String(error) }));
    if (!result?.ok) return ui.notifications?.warn?.(result?.message || "Поставку уже передали перевозчику; отмена недоступна.");
    requestSkyholdAppRender();
    this.requestRender({ focus: false });
    ui.notifications?.info?.(`Поставка отменена. В казну возвращено ${formatCopperCurrency(result.refundCopper)}.`);
  }

  async _onDeliverShipment(element) {
    if (!game.user?.isGM) return ui.notifications?.warn?.("Доставить груз сейчас может только GM.");
    const orderId = String(element?.dataset?.orderId ?? "").trim();
    if (!orderId) return;
    const snapshot = this._marketSnapshot({ isGM: true });
    const existing = snapshot.holding?.special?.market?.orders?.find?.((row) => [row?.id, row?.operationId].some((value) => String(value ?? "") === orderId));
    if (existing?.ownedVesselDelivery) return ui.notifications?.warn?.("Доставка своим кораблём завершается только вместе с его рейсом по календарю.");
    const workflow = getSkyholdWorkflowService();
    const result = await SkyholdData.updateHolding(this.holdingId, (holding) => {
      const arrival = deliverMarketShipmentNow({
        holding,
        orderId,
        deliveredAt: new Date().toISOString(),
        dependencies: {
          addMoney: (target, amount) => workflow._addMoney(target, amount),
          storageAddWithOverflow: (target, resource, qty) => workflow._storageAddWithOverflow(target, resource, qty),
          appendStorageLog: (target, entries) => workflow._appendStorageLog(target, entries),
          formatCurrency: (amount) => formatCopperCurrency(amount)
        }
      });
      const delivered = arrival.delivered?.[0];
      if (!arrival.ok || !delivered) return SkyholdData.skipTransaction({ ok: false });
      appendHoldingOperation(holding, {
        operationId: delivered.operationId,
        type: "market-purchase",
        createdAt: new Date().toISOString(),
        title: `Прибыла поставка: ${delivered.marketLabel}`,
        summary: `${delivered.delivered.length} грузовых позиций доставлено вручную GM.`,
        payload: { orderId: delivered.orderId, orderOperationId: delivered.orderOperationId, manual: true }
      });
      return { ok: true, count: delivered.delivered.length };
    }, { fallback: false, reason: "market:deliver-now" });
    if (!result?.ok) return ui.notifications?.warn?.("Поставка уже обработана или недоступна.");
    requestSkyholdAppRender();
    this.requestRender({ focus: false });
    ui.notifications?.info?.(`Поставка доставлена: ${result.count} позиций.`);
  }

  async _onClose(options) {
    await super._onClose(options);
    this._marketAbortController?.abort?.();
    hideFloatingTooltip(this);
    SkyholdMarketApp.instances.delete(this.holdingId);
  }
}

export function createHeadlessMarketAdapter({ holdingId = "", marketId = "", quantities = {}, targetRoomId = "", serviceLevel = "standard", carrierId = "", exportOfferId = "", exportQuantity = 0, exportCarrierId = "", exportServiceLevel = "charter" } = {}) {
  const adapter = Object.create(SkyholdMarketApp.prototype);
  Object.assign(adapter, {
    holdingId: String(holdingId ?? ""),
    marketId: String(marketId ?? ""),
    quantities: quantities && typeof quantities === "object" ? clone(quantities) : {},
    targetRoomId: String(targetRoomId ?? ""),
    serviceLevel: String(serviceLevel ?? "standard"),
    carrierId: String(carrierId ?? ""),
    exportOfferId: String(exportOfferId ?? ""),
    exportQuantity: Math.max(0, Math.floor(Number(exportQuantity) || 0)),
    exportCarrierId: String(exportCarrierId ?? ""),
    exportServiceLevel: String(exportServiceLevel ?? "charter")
  });
  return adapter;
}

SkyholdMarketApp.DEFAULT_OPTIONS = {
  id: "fbl-skyhold-market",
  classes: ["fbl-skyhold", "fbl-skyhold-market"],
  tag: "section",
  window: { title: "Внешний рынок", icon: "fa-solid fa-store", resizable: true },
  position: { width: 1260, height: 760 }
};

SkyholdMarketApp.PARTS = {
  body: { template: `modules/${MODULE_ID}/templates/market-app.hbs` }
};
