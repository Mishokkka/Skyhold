import { marketPlanCargoExpiryWarnings } from "../engines/market/cargo-aging.js";
import { escapeHtml } from "../core/helpers.js";
import { dispatchDelegatedAction } from "./common/delegated-events.js";
import { visibleActiveShipments } from "./market/shipment-list.js";
import { MODULE_ID } from "../data/constants.js";
import { requestMarketOperation, SkyholdData } from "../data/store.js";
import { findReadableHoldingEntry } from "../data/access-guard.js";
import { holdingPermissionContext } from "../data/holding-permissions.js";
import { appendHoldingOperation } from "../data/operations.js";
import { makeId } from "../data/utils.js";
import { normalizeMarketEconomy } from "../data/market/economy.js";
import { marketRegionForValue } from "../data/market/region-market.js";
import { allResourceDefs } from "../core/resources.js";
import { copperCurrencyParts, formatCopperCurrencyCompact, formatCopperCurrencyCompact as formatCopperCurrency } from "../core/currency.js";
import { internalDemandBatchClockQd } from "../core/resource-batches.js";
import { planMarketPurchase } from "../engines/market/pricing.js";
import { cancelMarketShipment, deliverMarketShipmentNow, marketShipmentCancellationQuote, resolveMarketShipmentRisk } from "../engines/market/shipment.js";
import { holdingMarketAccessLevel, marketRegionAccessCostMap } from "../engines/market/logistics.js";
import { effectiveMarketLocations } from "../engines/market/composition.js";
import { carrierCapacityForLogistics } from "../engines/market/providers.js";
import { restoreMarketStockReservations } from "../engines/market/stock.js";
import {
  cancelMarketOutboundShipment,
  resolveMarketOutboundShipmentRisk
} from "../workflows/market/outbound-shipment.js";
import { foundryDialogV2, resolveFoundryUuid } from "../integrations/foundry-runtime.js";
import { requestSkyholdAppRender } from "./registry.js";
import { getSkyholdWorkflowService } from "../workflows/skyhold-workflow-service.js";
import { RenderSchedulerMixin } from "./common/render-scheduler.js";
import { bindImageFallbacks, capturePersistentImages, restorePersistentImages } from "./common/image-fallback.js";
import { bindFloatingTooltips, hideFloatingTooltip } from "./common/floating-tooltip.js";
import { restoreApplicationFocus } from "./common/window-focus-keeper.js";
import { focusMarketOutboundOrder } from "./market/outbound-focus.js";
import { DisclosureState } from "./common/disclosure-state.js";
import { groupMarketOffers, marketOfferGroupTotals, merchantAbbreviation, merchantTone } from "./market/offer-groups.js";
import { marketShipmentRiskContext } from "./market/shipment-context.js";
import { marketPurchaseCostPresentation, marketShipmentFinancialRiskText } from "./market/purchase-cost-presentation.js";
import { marketShipmentSchedule } from "../engines/market/shipment-schedule.js";
import { prepareMarketOutboundContext } from "./market/outbound-context.js";
import { authorityMarketLogistics, authorityMarketQuote, authorityOutboundRoutes, authorityOwnShipOutboundRoute, marketAuthoritySourceToken, marketPurchasePlanToken, validateOwnShipOutboundFunding } from "./market/authority-context.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function prepareLine(line, quantity = 0) {
  const qty = Math.max(0, Math.min(Math.floor(Number(quantity) || 0), line.stock));
  const movementPercent = Number(line.movementPercent) || 0;
  const movementDirection = movementPercent > 0 ? "выше" : movementPercent < 0 ? "ниже" : "равна";
  return {
    ...line,
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
  if (status === "needsResolution") return "Требует решения";
  if (status === "pending") return "Готовится";
  return "В пути";
}

function outboundShipmentStatusLabel(status = "") {
  if (status === "booked") return "Забронирован";
  if (status === "delivered") return "Продан";
  return shipmentStatusLabel(status);
}

function percentText(value = 0) {
  return `${(Math.max(0, Number(value) || 0) * 100).toFixed(1)}%`;
}

function loadText(value = 0) {
  const load = Math.max(0, Number(value) || 0);
  return `${Number.isInteger(load) ? load : Number(load.toFixed(1))} ед.`;
}

function marketServiceLabel(serviceLevel = "standard") {
  if (serviceLevel === "express") return "ускоренная";
  if (serviceLevel === "charter") return "выделенный рейс";
  return "попутный груз";
}

function marketServiceDescription(serviceLevel = "standard") {
  if (serviceLevel === "express") return "До 10% вместимости на рейс · ETA ×0,70 · надбавка 20% к маршруту и обработке.";
  if (serviceLevel === "charter") return "Вся вместимость транспорта · ETA ×0,85 · оплачивается полный оборот, включая возвращение или перегон транспорта.";
  return "До 20% вместимости на рейс · ETA ×1,25 · остаток автоматически уходит следующей попуткой.";
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
  const bookingCapacity = Math.max(0, Number(plan.bookingCapacityLoad) || 0);
  const actualLoad = Math.max(0, Number(batch.totalLoad) || 0);
  const billableLoad = Math.max(0, Number(batch.billableLoad ?? batch.totalLoad) || 0);
  const valueFreight = Math.max(0, Number(batch.valueFreightCopper) || 0);
  const operationalFreight = Math.max(0, Number(batch.operationalFreightCopper) || 0);
  const routeCopper = Math.max(0, Number(batch.routeCopper) || 0);
  const routeBasis = operationalFreight > valueFreight ? "операционная смета" : "фрахт от цены";
  return {
    number,
    index: Math.max(0, number - 1),
    selected,
    optionLabel: `Рейс ${number} · ETA ${Math.max(0, Number(batch.deliveryQd) || 0)} QD · ${loadText(actualLoad)}`,
    etaText: `${Math.max(0, Number(batch.deliveryQd) || 0)} QD`,
    departureText: Number(batch.departureQd) > 0 ? `через ${batch.departureQd} QD` : "ближайшее отправление",
    transportText: `${Math.max(0, Number(batch.transportQd) || 0)} QD`,
    loadText: bookingCapacity > 0 ? `${loadText(actualLoad)} / ${loadText(bookingCapacity)}` : loadText(actualLoad),
    capacityShareText: percentText(batch.capacityShare),
    billableLoadText: loadText(billableLoad),
    billsFullCapacity: billableLoad > actualLoad + 0.0001,
    cargo: (batch.lines ?? []).map((line) => ({
      name: String(line.name ?? "Товар"),
      providerLabel: String(line.providerLabel ?? ""),
      qty: Math.max(0, Number(line.qty) || 0),
      lineText: formatCopperCurrencyCompact(line.lineCopper ?? (Number(line.qty) || 0) * (Number(line.unitPriceCopper) || 0))
    })),
    subtotalText: formatCopperCurrencyCompact(batch.subtotalCopper),
    valueFreightText: formatCopperCurrencyCompact(valueFreight),
    operationalFreightText: formatCopperCurrencyCompact(operationalFreight),
    routeText: `${formatCopperCurrencyCompact(routeCopper)} · выбран: ${routeBasis}`,
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

function shipmentRiskText(order = {}, riskContext = null) {
  if (riskContext?.needsResolution) return riskContext.genericEventText;
  if (order.status === "cancelled") return `Полностью возвращено ${formatCopperCurrency(order.cancellationRefundCopper || 0)}`;
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

function marketSeasonLabel(seasonId = "") {
  return ({ spring: "Весна", summer: "Лето", autumn: "Осень", winter: "Зима" })[seasonId] ?? "Сезон";
}

export class SkyholdMarketApp extends RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  static instances = new Map();

  static open({ holdingId, outboundOrderId = "", ownShipId = null } = {}) {
    const id = String(holdingId ?? "");
    const existing = this.instances.get(id);
    if (existing) {
      if (outboundOrderId) { existing._focusOutboundOrderId = String(outboundOrderId); existing._focusOutbound = false; }
      if (ownShipId !== null) {
        existing.ownShipId = String(ownShipId);
        existing._focusOutboundOrderId = String(outboundOrderId);
        existing._focusOutbound = true;
      }
      existing.render({ force: true, focus: true });
      return existing;
    }
    const app = new this({ holdingId: id });
    app._focusOutboundOrderId = String(outboundOrderId);
    if (ownShipId !== null) { app.ownShipId = String(ownShipId); app._focusOutbound = true; }
    this.instances.set(id, app);
    Promise.resolve(app.render({ force: true, focus: true })).catch((error) => {
      if (this.instances.get(id) === app) this.instances.delete(id);
      console.error("FBL Skyhold | Failed to open market window", error);
      globalThis.ui?.notifications?.error?.("Не удалось открыть рынок.");
    });
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
    this.landedPricesOpen = false;
    this.outboundQuantities = {};
    this.outboundInsuranceEnabled = true;
    this._outboundDisclosures = new DisclosureState();
    this.ownShipId = "";
    this._outboundOperationPending = false;
  }

  render(options = {}) {
    this._outboundDisclosures.capture();
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

  _marketLogistics(holding, data, market, { carrierId = this.carrierId, persistCarrier = false, isGM = Boolean(game.user?.isGM), economy = null } = {}) {
    const result = authorityMarketLogistics({ holding, data, market, carrierId, isGM, economy });
    if (persistCarrier) this.carrierId = String(result.carrier?.id ?? "");
    return result;
  }

  _marketQuote(holding, data, market, { isGM = Boolean(game.user?.isGM), economy = null, resources = null } = {}) {
    const quote = authorityMarketQuote({ holding, data, market, carrierId: this.carrierId, isGM, economy, resources });
    if (quote) this.carrierId = String(quote.selectedCarrierId ?? "");
    return quote;
  }

  _marketSourceHash(data, holding, marketId = "") {
    return marketAuthoritySourceToken({ data, holding, marketId, carrierId: this.carrierId });
  }

  _marketOutboundRoutes(options = {}) {
    return authorityOutboundRoutes(options);
  }

  _marketOutboundContext({ holding, data, market, quote, economy, resources, isGM = Boolean(game.user?.isGM) } = {}) {
    if (!holding || !market || !quote) return prepareMarketOutboundContext();
    const outboundQuote = { ...quote, offers: quote.outboundOffers ?? quote.offers ?? [], countryId: String(market.countryId ?? "") };
    const buyerOrganizations = (economy?.organizations ?? []).filter((organization) => isGM || organization?.visibility !== "gm");
    const preliminary = prepareMarketOutboundContext({
      holding,
      quote: outboundQuote,
      resourceDefinitions: resources,
      organizations: buyerOrganizations,
      quantities: this.outboundQuantities,
      insuranceEnabled: this.outboundInsuranceEnabled
    });
    const routes = this._marketOutboundRoutes({
      holding,
      data,
      market,
      economy,
      resources,
      offers: preliminary.offers,
      carriers: quote.carriers ?? [],
      isGM
    });
    const ownShip = this.ownShipId ? authorityOwnShipOutboundRoute({
      holding, data, market, offers: preliminary.offers, routes, ownShipId: this.ownShipId
    }) : null;
    const result = prepareMarketOutboundContext({
      holding,
      quote: outboundQuote,
      resourceDefinitions: resources,
      organizations: buyerOrganizations,
      routes: this.ownShipId ? (ownShip?.route ? [ownShip.route] : []) : routes,
      quantities: this.outboundQuantities,
      insuranceEnabled: this.outboundInsuranceEnabled
    });
    if (this.ownShipId && ownShip?.reason && result.plan) {
      result.plan.ok = false;
      result.plan.reasons = [...new Set([...result.plan.reasons, ownShip.reason])];
    }
    return { ...validateOwnShipOutboundFunding(holding, result, ownShip), ownShip };
  }

  _marketSnapshot({ isGM = Boolean(game.user?.isGM), includePlan = true } = {}) {
    const data = SkyholdData.view();
    const { holding } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
    const locations = data?.catalog?.eventRegions ?? [];
    const economy = normalizeMarketEconomy(data?.catalog?.marketEconomy, { locations });
    const resources = allResourceDefs({ catalogRows: data?.catalog?.resources });
    const markets = this._availableMarkets(data, { holding, isGM, economy, resources });
    const market = markets.find((row) => row.id === this.marketId) ?? markets[0] ?? null;
    if (market && market.id !== this.marketId) this.marketId = market.id;
    if (!holding) return { data, holding: null, markets, market, quote: null, plan: null, outbound: null, sourceHash: "" };
    let quote = this._marketQuote(holding, data, market, { isGM, economy, resources });
    const plan = includePlan && quote
      ? planMarketPurchase({ holding, quote, quantities: this.quantities, targetRoomId: this.targetRoomId, serviceLevel: this.serviceLevel })
      : null;
    const outbound = this._marketOutboundContext({ holding, data, market, quote, economy, resources, isGM });
    if (plan?.logistics) quote = { ...quote, logistics: plan.logistics };
    return {
      data,
      holding,
      markets,
      market,
      quote,
      plan,
      outbound,
      sourceHash: this._marketSourceHash(data, holding, market?.id)
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
    let { data, holding, markets, market, quote, plan, outbound } = this._marketSnapshot({ includePlan: false });
    const permissions = holdingPermissionContext(holding);
    const workflow = getSkyholdWorkflowService();
    const rooms = holding ? workflow._storageRooms(holding, { includeUnavailable: false }) : [];
    const availableRoomIds = new Set(rooms.map((room) => String(room.id ?? "")));
    if (!availableRoomIds.has(this.targetRoomId)) {
      const preferred = String(holding?.special?.market?.preferredRoomId ?? "outdoors") || "outdoors";
      this.targetRoomId = availableRoomIds.has(preferred) ? preferred : (availableRoomIds.has("outdoors") ? "outdoors" : String(rooms[0]?.id ?? "outdoors"));
    }
    quote = await this._enrichMarketQuoteItems(quote);
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
    if (quote) plan = planMarketPurchase({ holding, quote, quantities: this.quantities, targetRoomId: this.targetRoomId, serviceLevel: this.serviceLevel });
    const selectedCount = plan?.lines?.reduce((sum, line) => sum + line.qty, 0) ?? 0;
    const activeShipmentOrders = (holding?.special?.market?.orders ?? [])
      .filter((order) => ["pending", "in-transit", "delayed", "needsResolution"].includes(String(order?.status ?? "")));
    const shipments = visibleActiveShipments(activeShipmentOrders, 12)
      .map((order) => {
        const cancellation = marketShipmentCancellationQuote(order);
        const schedule = marketShipmentSchedule(order);
        const riskContext = marketShipmentRiskContext(order, {
          isGM: permissions.isGM,
          formatPercent: percentText,
          formatCurrency: formatCopperCurrency
        });
        return {
          id: String(order.id ?? order.operationId ?? ""),
          status: String(order.status ?? "in-transit"),
          marketLabel: String(order.marketLabel ?? "Внешний рынок"),
          statusLabel: schedule.booked ? "Ожидает отправления" : shipmentStatusLabel(order.status),
          canDeliverNow: ["pending", "in-transit", "delayed"].includes(String(order.status ?? "")) && !riskContext.needsResolution,
          canCancel: Boolean(permissions.isGM && cancellation.cancellable),
          canResolveRisk: riskContext.canResolveRisk,
          gmResolution: riskContext.gmResolution,
          cancellationRefundText: formatCopperCurrency(cancellation.refundCopper),
          cancellationWithheldText: formatCopperCurrency(cancellation.withheldCopper),
          serviceText: marketServiceLabel(order.serviceLevel),
          batchText: Number(order.batchCount) > 1 ? `партия ${Math.max(1, Number(order.batchIndex) + 1)} из ${order.batchCount}` : "одна партия",
          remainingText: `${Math.max(0, Number(order.remainingQd) || 0)} QD`,
          riskText: shipmentRiskText(order, riskContext),
          timingText: schedule.booked
            ? (schedule.isWaiting ? `До отправления ${schedule.waitingQd} QD; перевозка ${schedule.transportQd} QD.` : "Подготовлен к ближайшему отправлению.")
            : "",
          financialRiskText: marketShipmentFinancialRiskText(order),
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
        status: String(order.status ?? "delivered"),
        marketLabel: String(order.marketLabel ?? "Внешний рынок"),
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
    const outboundPlan = outbound?.plan ?? null;
    const outboundOffers = (outbound?.offers ?? []).map((offer) => ({
      ...offer,
      canSelect: Boolean(permissions.isGM && permissions.canUseStorage && offer.available > 0),
      priceText: formatCopperCurrency(offer.unitPriceCopper),
      lineText: formatCopperCurrency(offer.unitPriceCopper * offer.qty),
      availabilityText: `${offer.availableStock} на складе · спрос ${offer.availableDemand}`
    }));
    const outboundOrdersRaw = holding?.special?.market?.outbound?.orders ?? [];
    const outboundOrders = visibleActiveShipments(outboundOrdersRaw
      .filter((order) => ["booked", "in-transit", "delayed", "needsResolution"].includes(String(order?.status ?? ""))), 20)
      .map((order) => {
        const schedule = marketShipmentSchedule(order);
        const riskContext = marketShipmentRiskContext(order, {
          isGM: permissions.isGM,
          formatPercent: percentText,
          formatCurrency: formatCopperCurrency
        });
        return {
          id: String(order.id ?? order.operationId ?? ""),
          status: String(order.status ?? "booked"),
          statusLabel: schedule.booked ? "Ожидает отправления" : outboundShipmentStatusLabel(order.status),
          marketLabel: String(order.marketLabel ?? "Внешний рынок"),
          cargoText: (order.cargoReservations ?? order.cargo ?? order.lines ?? []).map((line) => `${line.name || line.resourceId || "Товар"} ×${Math.max(0, Number(line.qty) || 0)}`).slice(0, 6).join(" · "),
          buyerText: (order.buyerAllocations ?? []).map((row) => `${row.buyerLabel || row.buyerId || "Покупатель"} ×${Math.max(0, Number(row.qty) || 0)}`).slice(0, 6).join(" · "),
          routeText: String(order.carrierLabel ?? order.routeLabel ?? order.routeId ?? "Перевозчик"),
          remainingText: `${Math.max(0, Number(order.remainingQd) || 0)} QD`,
          upfrontText: formatCopperCurrency(order.upfrontCopper),
          revenueText: formatCopperCurrency(order.revenueCopper),
          batchText: Number(order.batchCount) > 1 ? `Партия ${Number(order.batchIndex) + 1} из ${order.batchCount}` : "",
          timingText: schedule.isWaiting ? `До отправления ${schedule.waitingQd} QD; перевозка ${schedule.transportQd} QD.` : "",
          financialRiskText: marketShipmentFinancialRiskText(order),
          riskText: shipmentRiskText(order, riskContext),
          canCancel: Boolean(permissions.isGM && String(order.dispatchStatus ?? "booked") === "booked" && !order.dispatchedAt),
          canResolveRisk: riskContext.canResolveRisk,
          gmResolution: riskContext.gmResolution
        };
      });
    const outboundArchive = outboundOrdersRaw
      .filter((order) => ["delivered", "lost", "cancelled"].includes(String(order?.status ?? "")))
      .slice(-20)
      .reverse()
      .map((order) => ({
        status: String(order.status ?? "delivered"),
        statusLabel: outboundShipmentStatusLabel(order.status),
        marketLabel: String(order.marketLabel ?? "Внешний рынок"),
        cargoText: (order.cargo ?? order.cargoReservations ?? order.lines ?? []).map((line) => `${line.name || line.resourceId || "Товар"} ×${Math.max(0, Number(line.qty) || 0)}`).slice(0, 6).join(" · "),
        revenueText: formatCopperCurrency(order.revenueCopper),
        statusText: shipmentRiskText(order),
        dateText: shipmentDateText(order.deliveredAt || order.lostAt || order.cancelledAt || order.createdAt)
      }));
    const regionLabels = new Map((data?.catalog?.eventRegions ?? []).map((row) => [String(row.value ?? ""), String(row.label ?? row.value ?? "")]));
    const routeLogistics = plan && !plan.empty ? (plan.logistics ?? quote?.logistics) : quote?.logistics;
    const routePathText = (routeLogistics?.routePath ?? []).map((id) => regionLabels.get(String(id)) ?? String(id)).join(" → ");
    const merchantTones = new Map((quote?.merchantProviders ?? []).map((provider, index) => [String(provider.id ?? ""), index % 6]));
    const shipmentBatches = Array.isArray(plan?.shipmentBatches) ? plan.shipmentBatches : [];
    const selectedBatchIndex = Math.min(Math.max(0, Math.floor(Number(this.batchPreviewIndex) || 0)), Math.max(0, shipmentBatches.length - 1));
    this.batchPreviewIndex = selectedBatchIndex;
    const shipmentBatchPreviews = shipmentBatches.map((batch, index) => marketBatchPreview(batch, plan, index === selectedBatchIndex));
    return {
      ...context,
      holding,
      isGM: permissions.isGM,
      cargoWarnings: [...marketPlanCargoExpiryWarnings(plan),
        ...marketPlanCargoExpiryWarnings(outbound?.plan, { direction: "outbound" })],
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
      carrierOptions: (quote?.carriers ?? []).map((carrier) => ({
        value: carrier.id,
        label: `${carrier.label} · до ${loadText(carrierCapacityForLogistics(routeLogistics, carrier).capacityLoad)} · цена ×${Number(carrier.priceFactor || 1).toFixed(2)}`,
        selected: carrier.id === quote?.selectedCarrierId
      })),
      hasCarrierChoice: (quote?.carriers ?? []).length > 1,
      carrierLabel: routeLogistics?.carrierLabel || "Независимые перевозчики",
      canPurchase: Boolean(holding && permissions.isGM),
      canOrder: Boolean(holding && permissions.isGM && routeLogistics?.ok !== false),
      readOnlyReason: permissions.isGM ? "" : "Сделки на внешнем рынке подтверждает GM.",
      logisticsOk: routeLogistics?.ok !== false,
      logisticsReason: (routeLogistics?.reasons ?? []).join(" "),
      transportLabel: routeLogistics?.transportLabel ?? "—",
      routeDistanceText: routeLogistics ? `${routeLogistics.hops} перех. · ${routeLogistics.distanceText}` : "—",
      routePathText: routePathText || "—",
      marketAccessText: routeLogistics ? `УРС ${routeLogistics.accessLevel} · рынок ${routeLogistics.requiredAccessLevel}` : "—",
      routeRiskText: routeLogistics ? `×${Number(routeLogistics.riskFactor || 1).toFixed(2)}` : "—",
      routeSeasonText: routeLogistics?.seasonalEdgeCount
        ? `${marketSeasonLabel(routeLogistics.seasonId)} · ${routeLogistics.seasonalEdgeCount} участ.`
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
      hiddenOfferCount: Math.max(0, Number(quote?.hiddenOfferCount) || 0),
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
      totalLoadValue: Math.max(0, Number(plan?.finalBatchLoad) || 0),
      capacityLoadValue: Math.max(0, Number(plan?.bookingCapacityLoad) || 0),
      totalLoadText: loadText(plan?.totalLoad),
      capacityLoadText: loadText(plan?.bookingCapacityLoad),
      physicalCapacityText: loadText(plan?.physicalCapacityLoad),
      capacityRemainingText: loadText(plan?.capacityRemainingLoad),
      finalBatchLoadText: loadText(plan?.finalBatchLoad),
      batchCount: Math.max(0, Number(plan?.batchCount) || 0),
      batchCountText: marketTripCountText(plan?.batchCount),
      hasMultipleShipmentBatches: shipmentBatchPreviews.length > 1,
      shipmentBatchPreviews,
      selectedShipmentBatch: shipmentBatchPreviews[selectedBatchIndex] ?? null,
      subtotalText: formatCopperCurrencyCompact(plan?.subtotalCopper ?? 0),
      purchaseCosts: marketPurchaseCostPresentation(plan ?? {}),
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
        fullVesselLoadText: `${loadText(plan?.deliveryBreakdown?.physicalCapacityLoad ?? 0)} × ${Number(plan?.deliveryBreakdown?.loadRateCopper ?? 0).toFixed(3)} М/ед. = ${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.fullVesselLoadCopper ?? 0)}`,
        fullOneWayOperatingText: formatCopperCurrencyCompact(plan?.deliveryBreakdown?.fullOneWayOperatingCopper ?? 0),
        operatingLegsText: Number(plan?.deliveryBreakdown?.operatingLegFactor ?? 1) > 1 ? "2 плеча: доставка + возврат/перегон" : "1 плечо; обратный рейс оплачивает другой груз",
        capacityShareText: plan?.hasCapacityLimit
          ? `${percentText(plan?.deliveryBreakdown?.capacityShare ?? 0)} полной сметы · ${marketTripCountText(plan?.batchCount)}`
          : "без лимита · полная операционная смета",
        valueFreightFormulaText: `сумма по ${marketTripCountText(plan?.batchCount)} при ставке ${percentText(plan?.deliveryBreakdown?.freightRate ?? 0)} = ${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.valueFreightCopper ?? 0)}`,
        operationalFormulaText: `${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.fullOneWayOperatingCopper ?? 0)} × суммарная доля ${percentText(plan?.deliveryBreakdown?.capacityShare ?? 0)} × ${Number(plan?.deliveryBreakdown?.operatingLegFactor ?? 1)} плеч. = ${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.operationalFreightCopper ?? 0)}`,
        routeTotalFormulaText: `сумма большего тарифа каждой партии = ${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.routeCopper ?? 0)}`,
        handlingFormulaText: `погрузка каждой из ${marketTripCountText(plan?.batchCount)} + массовый тариф = ${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.handlingCopper ?? 0)}`,
        insuranceFormulaText: `${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.subtotalCopper ?? 0)} × ${percentText(plan?.deliveryBreakdown?.insuranceRate ?? 0)} = ${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.insuranceCopper ?? 0)}`,
        taxFormulaText: `Ввоз ${percentText(plan?.deliveryBreakdown?.importTaxRate ?? 0)}: ${formatCopperCurrencyCompact(plan?.importTaxCopper ?? 0)}; вывоз ${percentText(plan?.deliveryBreakdown?.exportTaxRate ?? 0)}: ${formatCopperCurrencyCompact(plan?.exportTaxCopper ?? 0)}; всего ${formatCopperCurrencyCompact(plan?.taxCopper ?? 0)}`,
        expressText: formatCopperCurrencyCompact(plan?.deliveryBreakdown?.expressSurchargeCopper ?? 0),
        totalFormulaText: `${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.routeCopper ?? 0)} + ${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.handlingCopper ?? 0)} + ${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.insuranceCopper ?? 0)} + ${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.taxCopper ?? 0)} + ${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.expressSurchargeCopper ?? 0)} = ${formatCopperCurrencyCompact(plan?.deliveryBreakdown?.deliveryCopper ?? 0)}`
      },
      deliveryBreakdownOpen: this.deliveryBreakdownOpen,
      landedPricesOpen: this.landedPricesOpen,
      insufficientFunds: Boolean(plan?.insufficientFunds),
      canConfirm: Boolean(permissions.canUseStorage && plan?.ok),
      shipments,
      hasShipments: shipments.length > 0,
      activeShipmentCount: activeShipmentOrders.length,
      hiddenShipmentCount: Math.max(0, activeShipmentOrders.length - shipments.length),
      hasHiddenShipments: activeShipmentOrders.length > shipments.length,
      shipmentArchive,
      hasShipmentArchive: shipmentArchive.length > 0,
      outboundOffers,
      outboundHasOffers: outboundOffers.length > 0,
      outboundHasForSaleStock: Boolean(outbound?.hasForSaleStock),
      outboundShowSection: Boolean(outbound?.hasForSaleStock || outboundOrders.length || outboundArchive.length),
      outboundStockCount: Math.max(0, Number(outbound?.forSaleResourceCount) || 0),
      outboundNeedsAttention: outboundOrders.some((order) => order.canResolveRisk),
      outboundUnavailableForSaleCount: Math.max(0, Number(outbound?.unavailableForSaleCount) || 0),
      outboundSelectedUnits: Math.max(0, Number(outbound?.selectedUnits) || 0),
      outboundHasSelection: Math.max(0, Number(outbound?.selectedUnits) || 0) > 0,
      outboundInsuranceEnabled: this.outboundInsuranceEnabled,
      outboundShipOptions: [
        { value: "", label: "Наёмный перевозчик", selected: !this.ownShipId },
        ...(holding?.special?.ships?.list ?? [])
          .filter((ship) => (ship.navigationMode === "world" && ship.location?.kind === "home" && !ship.activeVoyage && !ship.orderBundle)
            || ship.id === this.ownShipId)
          .map((ship) => ({ value: ship.id, label: ship.name, selected: ship.id === this.ownShipId,
            disabled: !permissions.canManageShips || ship.navigationMode !== "world" || ship.location?.kind !== "home"
              || Boolean(ship.activeVoyage || ship.orderBundle) }))
      ],
      outboundOwnShipSelected: Boolean(this.ownShipId),
      outboundCanBook: Boolean(permissions.isGM && permissions.canUseStorage && (!this.ownShipId || permissions.canManageShips) && outboundPlan?.ok),
      outboundPlanReason: (outboundPlan?.reasons ?? []).join(" "),
      outboundRevenueText: formatCopperCurrency(outboundPlan?.revenueCopper ?? 0),
      outboundUpfrontText: formatCopperCurrency(outboundPlan?.upfrontCopper ?? 0),
      outboundImportTaxText: formatCopperCurrency(outboundPlan?.importTaxCopper ?? 0),
      outboundExportTaxText: formatCopperCurrency(outboundPlan?.exportTaxCopper ?? 0),
      outboundShipTransferText: formatCopperCurrency(Math.max(0,
        Number(outbound?.ownShip?.voyageOffer?.quote?.recommendedBudgetCopper ?? 0)
        - Number((holding?.special?.ships?.list ?? []).find((ship) => ship.id === this.ownShipId)?.onboardCopper ?? 0))),
      outboundShipOperatingText: formatCopperCurrency(outbound?.ownShip?.voyageOffer?.quote?.costs?.totalCopper ?? 0),
      outboundBalanceText: formatCopperCurrency(Math.max(0, Number(holding?.storage?.moneyCopper) - Number(outboundPlan?.upfrontCopper ?? 0)
        - Math.max(0, Number(outbound?.ownShip?.voyageOffer?.quote?.recommendedBudgetCopper ?? 0)
          - Number((holding?.special?.ships?.list ?? []).find((ship) => ship.id === this.ownShipId)?.onboardCopper ?? 0)))),
      outboundDeliveryText: outboundPlan?.shipmentBatches?.length > 1
        ? `${outboundPlan.shipmentBatches.length} партии; приход ${outboundPlan.shipmentBatches[0].deliveryQd}–${outboundPlan.deliveryQd} QD`
        : (outboundPlan?.deliveryQd ? `${outboundPlan.deliveryQd} QD` : "—"),
      outboundCarrierText: String(outboundPlan?.route?.label ?? outboundPlan?.route?.carrierLabel ?? "—"),
      outboundBuyerText: (outboundPlan?.buyerAllocations ?? []).map((row) => `${row.buyerLabel || row.buyerId || "Покупатель"} ×${Math.max(0, Number(row.qty) || 0)}`).slice(0, 8).join(" · "),
      outboundOrders,
      hasOutboundOrders: outboundOrders.length > 0,
      outboundArchive,
      hasOutboundArchive: outboundArchive.length > 0
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    restorePersistentImages(root, this._pendingPersistentImages);
    this._pendingPersistentImages = null;
    bindImageFallbacks(root);
    bindFloatingTooltips(this, root);
    this._marketAbortController?.abort?.();
    const controller = new AbortController();
    this._marketAbortController = controller;
    this._outboundDisclosures.bind(root);
    const listenerOptions = { signal: controller.signal };
    root.addEventListener("click", (event) => dispatchDelegatedAction(this, event, event.target, () => this._onClick(event, root)), listenerOptions);
    root.addEventListener("contextmenu", (event) => this._onContextMenu(event, root), listenerOptions);
    root.addEventListener("change", (event) => this._onChange(event, root), listenerOptions);
    root.addEventListener("input", (event) => this._onInput(event, root), listenerOptions);
    const deliveryDetails = root.querySelector?.("[data-market-delivery-breakdown]");
    deliveryDetails?.addEventListener?.("toggle", () => {
      this.deliveryBreakdownOpen = Boolean(deliveryDetails.open);
    }, listenerOptions);
    const landedDetails = root.querySelector?.("[data-market-landed-prices]");
    landedDetails?.addEventListener?.("toggle", () => {
      this.landedPricesOpen = Boolean(landedDetails.open);
    }, listenerOptions);
    this._applyFilters(root);
    if (this._focusOutboundOrderId || this._focusOutbound) {
      const orderId = this._focusOutboundOrderId;
      this._focusOutboundOrderId = "";
      this._focusOutbound = false;
      if (!focusMarketOutboundOrder(root, orderId)) globalThis.ui?.notifications?.warn?.(orderId
        ? "Продажа уже недоступна в списке. Обновите окно корабля."
        : context.hasMarket
          ? "Отметьте товары «к продаже» в хранилище, чтобы подготовить продажу."
          : "Нет доступного рынка для продажи. Проверьте УРС поселения и связи с рынками.");
    }
  }

  _onClick(event, root) {
    const element = event.target?.closest?.("[data-action]");
    if (!element || !root.contains(element)) return;
    const action = String(element.dataset.action ?? "");
    if (action === "market-select-merchant") {
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
      return this._onBuy();
    } else if (action === "market-deliver-shipment") {
      event.preventDefault();
      return this._onDeliverShipment(element);
    } else if (action === "market-cancel-shipment") {
      event.preventDefault();
      return this._onCancelShipment(element);
    } else if (action === "market-resolve-shipment-risk") {
      event.preventDefault();
      return this._onResolveShipmentRisk(element);
    } else if (action === "market-outbound-quantity-step") {
      event.preventDefault();
      const resourceId = String(element.dataset.resourceId ?? "");
      const step = Number(element.dataset.step) || 0;
      const available = Math.max(0, Number(element.dataset.available) || 0);
      this._setOutboundQuantity(resourceId, Math.floor(Number(this.outboundQuantities[resourceId]) || 0) + step, available);
    } else if (action === "market-outbound-clear") {
      event.preventDefault();
      this.outboundQuantities = {};
      this.requestRender({ focus: false });
    } else if (action === "market-outbound-book") {
      event.preventDefault();
      return this._onBookOutbound();
    } else if (action === "market-outbound-cancel") {
      event.preventDefault();
      return this._onCancelOutbound(element);
    } else if (action === "market-outbound-resolve-risk") {
      event.preventDefault();
      return this._onResolveOutboundRisk(element);
    }
  }

  _onContextMenu(event, root) {
    const element = event.target?.closest?.('[data-action="market-quantity-step"], [data-action="market-outbound-quantity-step"]');
    if (!element || !root.contains(element) || element.disabled) return;
    event.preventDefault();
    if (element.dataset.action === "market-outbound-quantity-step") {
      const resourceId = String(element.dataset.resourceId ?? "");
      const available = Math.max(0, Number(element.dataset.available) || 0);
      const step = Number(element.dataset.step) || 0;
      this._setOutboundQuantity(resourceId, step > 0 ? available : 0, available);
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

  _setOutboundQuantity(resourceId, value, available) {
    if (!resourceId) return;
    this.outboundQuantities[resourceId] = Math.max(0, Math.min(Math.max(0, Number(available) || 0), Math.floor(Number(value) || 0)));
    this.requestRender({ focus: false });
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
      this.serviceLevel = ["standard", "express", "charter"].includes(service.value) ? service.value : "standard";
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
      this.outboundQuantities = {};
      this.merchantSelections = {};
      this.requestRender({ focus: false });
      return;
    }
    const outboundQuantity = event.target?.closest?.("[data-market-outbound-quantity]");
    if (outboundQuantity && root.contains(outboundQuantity)) {
      const resourceId = String(outboundQuantity.dataset.resourceId ?? "");
      const available = Math.max(0, Number(outboundQuantity.max) || 0);
      this._setOutboundQuantity(resourceId, outboundQuantity.value, available);
      return;
    }
    const outboundInsurance = event.target?.closest?.("[data-market-outbound-insurance]");
    if (outboundInsurance && root.contains(outboundInsurance)) {
      this.outboundInsuranceEnabled = Boolean(outboundInsurance.checked);
      this.requestRender({ focus: false });
      return;
    }
    const outboundShip = event.target?.closest?.("[data-market-outbound-ship]");
    if (outboundShip && root.contains(outboundShip)) {
      this.ownShipId = String(outboundShip.value ?? "");
      this.requestRender({ focus: false });
      return;
    }
    const carrier = event.target?.closest?.("[data-market-carrier]");
    if (carrier && root.contains(carrier)) {
      this.carrierId = String(carrier.value ?? "");
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

  async _onBuy() {
    if (this._buyOperationPending) return;
    this._buyOperationPending = true;
    try {
      const snapshot = this._marketSnapshot();
      if (!holdingPermissionContext(snapshot.holding).canUseStorage) {
        return ui.notifications?.warn?.("Для рыночной покупки нужны права на хранилище и активный GM.");
      }
      const plan = snapshot.plan;
      if (!plan || plan.empty) return ui.notifications?.warn?.("Корзина рынка пуста.");
      if (plan.inaccessible) return ui.notifications?.warn?.(plan.logistics?.reasons?.join(" ") || "Маршрут к этой площадке недоступен.");
      if (plan.amountExceeded) return ui.notifications?.warn?.(`Сумма заказа превышает ${formatCopperCurrency(plan.amountLimitCopper)}. Разделите покупку на несколько заказов.`);
      if (plan.capacityExceeded) return ui.notifications?.warn?.(`Одна единица товара не помещается в лимит ${marketServiceLabel(plan.serviceLevel)} (${loadText(plan.bookingCapacityLoad)}). Выберите выделенный рейс или другого перевозчика.`);
      if (plan.insufficientFunds) return ui.notifications?.warn?.("В казне недостаточно денег с учётом доставки.");
      const timing = plan.deliveryMode === "scheduled"
        ? `${marketServiceLabel(plan.serviceLevel)}: ${marketTripCountText(plan.batchCount)}, прибытие ${plan.batchCount > 1 ? `${plan.firstDeliveryQd}–${plan.deliveryQd}` : plan.deliveryQd} QD${plan.serviceLevel === "express" ? `, надбавка ${formatCopperCurrency(plan.expressSurchargeCopper)}` : ""}.`
        : "Груз будет доставлен сразу.";
      const risk = plan.deliveryMode === "scheduled"
        ? `Риск утраты ${percentText(plan.riskLossChance)}, задержки ${percentText(plan.riskDelayChance)}. При утрате всего заказа страховка возместит до ${formatCopperCurrency(plan.maximumInsurancePayoutCopper)}; не покрываются ${marketPurchaseCostPresentation(plan).unrecoveredText}. Страхуется стоимость товаров; расходы доставки не возмещаются.`
        : "";
      const content = `<p><strong>${escapeHtml(plan.marketLabel)}</strong>: ${plan.lines.length} позиций, товары ${formatCopperCurrency(plan.subtotalCopper)}, доставка ${formatCopperCurrency(plan.deliveryCopper)}.</p><p>Итого: <strong>${formatCopperCurrency(plan.totalCopper)}</strong>. ${escapeHtml(plan.logistics?.transportLabel || plan.locationLabel)}, дальность ${escapeHtml(plan.logistics?.distanceText || "—")}. ${timing}</p>${risk ? `<p>${risk}</p>` : ""}`;
      const confirmed = await foundryDialogV2().confirm({
        window: { title: "Подтвердить покупку на рынке" },
        content,
        modal: true
      });
      if (!confirmed) return;

      const operationId = makeId("market-order", 20);
      let result;
      try {
        result = await requestMarketOperation({
          type: "purchase",
          operationId,
          holdingId: this.holdingId,
          expectedRevision: Math.max(0, Math.floor(Number(snapshot.data?.meta?.revision) || 0)),
          sourceToken: snapshot.sourceHash,
          planToken: marketPurchasePlanToken(plan),
          marketId: plan.marketId,
          carrierId: this.carrierId,
          targetRoomId: this.targetRoomId,
          serviceLevel: plan.serviceLevel,
          quantities: this.quantities
        });
      } catch (error) {
        return ui.notifications?.warn?.(error?.code === "conflict"
          ? "Данные поселения или котировки изменились. Проверь корзину ещё раз."
          : (error?.message || "Рыночная покупка не выполнена."));
      }

      if (!result?.ok) return ui.notifications?.warn?.("Данные поселения или котировки изменились. Проверь корзину ещё раз.");
      this.quantities = {};
      requestSkyholdAppRender();
      this.requestRender({ focus: false });
      ui.notifications?.info?.(result.scheduled
        ? `Заказ принят: ${marketServiceLabel(result.serviceLevel)}, ${marketTripCountText(result.batchCount)}. ETA ${result.batchCount > 1 ? `${result.firstDeliveryQd}–${result.deliveryQd}` : result.deliveryQd} QD, списано ${formatCopperCurrency(result.totalCopper)}.`
        : `Заказ доставлен в поселение. Списано ${formatCopperCurrency(result.totalCopper)}.`);
    } finally {
      this._buyOperationPending = false;
    }
  }

  async _onBookOutbound() {
    if (this._outboundOperationPending) return;
    const snapshot = this._marketSnapshot();
    const permissions = holdingPermissionContext(snapshot.holding);
    if (!permissions.canUseStorage) {
      return ui.notifications?.warn?.("Для исходящей продажи нужны права на хранилище и активный GM.");
    }
    if (this.ownShipId && !permissions.canManageShips) {
      return ui.notifications?.warn?.("Для отправки собственного судна нужны права на корабли и активный GM.");
    }
    const plan = snapshot.outbound?.plan;
    if (!plan || !snapshot.outbound?.selectedUnits) return ui.notifications?.warn?.("Не выбраны товары для исходящей продажи.");
    if (!plan.ok) return ui.notifications?.warn?.(plan.reasons?.join(" ") || "Исходящую продажу нельзя оформить.");
    const buyerText = (plan.buyerAllocations ?? []).map((row) => `${row.buyerLabel || row.buyerId} ×${row.qty}`).join(" · ");
    const shipQuote = snapshot.outbound?.ownShip?.voyageOffer?.quote;
    const ship = (snapshot.holding?.special?.ships?.list ?? []).find((row) => row.id === this.ownShipId);
    const shipTransferCopper = Math.max(0, Number(shipQuote?.recommendedBudgetCopper ?? 0) - Number(ship?.onboardCopper ?? 0));
    const confirmed = await foundryDialogV2().confirm({
      window: { title: "Подтвердить исходящую продажу" },
      content: `<p><strong>${escapeHtml(plan.marketLabel)}</strong>: ${this.ownShipId ? "погрузить и отправить" : "забронировать"} ${plan.lines.reduce((sum, line) => line.qty + sum, 0)} ед. товара.</p><p>Рыночные расходы: <strong>${formatCopperCurrency(plan.upfrontCopper)}</strong>${this.ownShipId ? `; перевод на борт: <strong>${formatCopperCurrency(shipTransferCopper)}</strong>, из него расходы рейса: ${formatCopperCurrency(shipQuote?.costs?.totalCopper ?? 0)}` : ""}. Выручка <strong>${formatCopperCurrency(plan.revenueCopper)}</strong> поступит ${this.ownShipId ? "на борт" : "в казну"} после доставки.</p>${buyerText ? `<p>Покупатели: ${escapeHtml(buyerText)}.</p>` : ""}`,
      modal: true
    });
    if (!confirmed) return;

    this._outboundOperationPending = true;
    try {
      const operationId = makeId("market-outbound", 20);
      const result = await requestMarketOperation({
        type: "outbound",
        operationId,
        holdingId: this.holdingId,
        expectedRevision: Math.max(0, Math.floor(Number(snapshot.data?.meta?.revision) || 0)),
        sourceToken: snapshot.sourceHash,
        planToken: String(plan.planToken ?? ""),
        marketId: plan.marketId,
        carrierId: this.carrierId,
        ownShipId: this.ownShipId,
        quantities: this.outboundQuantities,
        insuranceEnabled: this.outboundInsuranceEnabled
      });
      if (!result?.ok) return ui.notifications?.warn?.("Запас, спрос, маршрут или казна изменились. Проверьте исходящую продажу ещё раз.");
      this.outboundQuantities = {};
      requestSkyholdAppRender();
      this.requestRender({ focus: false });
      ui.notifications?.info?.(`${this.ownShipId ? "Корабль отправлен с товаром" : "Исходящая продажа забронирована"}. Рыночные расходы ${formatCopperCurrency(result.upfrontCopper)}; ${formatCopperCurrency(result.revenueCopper)} поступит после доставки.`);
    } catch (error) {
      ui.notifications?.warn?.(error?.code === "conflict"
        ? "Запас, спрос, маршрут или казна изменились. Проверьте исходящую продажу ещё раз."
        : (error?.message || "Исходящая продажа не выполнена."));
    } finally {
      this._outboundOperationPending = false;
    }
  }

  async _onCancelOutbound(element) {
    if (!game.user?.isGM) return ui.notifications?.warn?.("Отменить исходящую продажу может только GM.");
    const orderId = String(element?.dataset?.orderId ?? "").trim();
    if (!orderId) return;
    const holding = this._marketSnapshot({ isGM: true }).holding;
    const order = holding?.special?.market?.outbound?.orders?.find?.((row) => [row?.id, row?.operationId].some((value) => String(value ?? "") === orderId));
    if (!order || String(order.dispatchStatus ?? "booked") !== "booked" || order.dispatchedAt) return ui.notifications?.warn?.("Продажа уже отправлена или недоступна для отмены.");
    const confirmed = await foundryDialogV2().confirm({
      window: { title: "Отменить исходящую продажу" },
      content: `<p>Груз ещё находится на складе. Точная batch-бронь и внешний спрос будут освобождены, а в казну вернётся вся предоплата расходов: <strong>${formatCopperCurrency(order.upfrontCopper)}</strong>.</p>`,
      modal: true
    });
    if (!confirmed) return;
    const workflow = getSkyholdWorkflowService();
    const cancelledAt = new Date().toISOString();
    const result = await SkyholdData.updateHolding(this.holdingId, (freshHolding) => {
      const cancelled = cancelMarketOutboundShipment({
        holding: freshHolding,
        orderId,
        cancelledAt,
        dependencies: {
          addMoney: (target, amount) => workflow._addMoney(target, amount),
          appendStorageLog: (target, entries) => workflow._appendStorageLog(target, entries)
        }
      });
      if (!cancelled.ok) return SkyholdData.skipTransaction({ ok: false, message: cancelled.message });
      if (!cancelled.replay) appendHoldingOperation(freshHolding, {
        operationId: cancelled.operationId,
        type: "market-outbound",
        createdAt: cancelledAt,
        title: `Отменена исходящая продажа: ${cancelled.order.marketLabel}`,
        summary: `Batch-бронь и спрос освобождены; возвращено ${formatCopperCurrency(cancelled.refundCopper)}.`,
        payload: { orderId, orderOperationId: cancelled.order.operationId, refundCopper: cancelled.refundCopper }
      });
      return { ok: true, replay: cancelled.replay, refundCopper: cancelled.refundCopper };
    }, { fallback: false, reason: "market:outbound-cancel" });
    if (!result?.ok) return ui.notifications?.warn?.("Продажа уже отправлена или изменилась; отмена недоступна.");
    requestSkyholdAppRender();
    this.requestRender({ focus: false });
    ui.notifications?.info?.(`Исходящая продажа отменена. Возвращено ${formatCopperCurrency(result.refundCopper)}.`);
  }

  async _onResolveOutboundRisk(element) {
    if (!game.user?.isGM) return ui.notifications?.warn?.("Событие исходящей поставки разрешает только GM.");
    const orderId = String(element?.dataset?.orderId ?? "").trim();
    const requestedOutcome = String(element?.dataset?.riskOutcome ?? "proposal");
    if (!orderId || !["proposal", "clear", "delayed", "lost"].includes(requestedOutcome)) return;
    const holding = this._marketSnapshot({ isGM: true }).holding;
    const order = holding?.special?.market?.outbound?.orders?.find?.((row) => [row?.id, row?.operationId].some((value) => String(value ?? "") === orderId));
    const riskContext = marketShipmentRiskContext(order, { isGM: true, formatPercent: percentText, formatCurrency: formatCopperCurrency });
    if (!riskContext.canResolveRisk) return ui.notifications?.warn?.("Событие уже разрешено или недоступно.");
    const delayQd = Math.max(1, Math.min(20, Math.ceil(Number(element?.dataset?.delayQd ?? riskContext.gmResolution?.delayQd) || 1)));
    const confirmed = await foundryDialogV2().confirm({
      window: { title: "Разрешить событие исходящей поставки" },
      content: `<p><strong>${escapeHtml(order.marketLabel || "Внешний рынок")}</strong>: применить исход «${requestedOutcome === "proposal" ? riskContext.gmResolution?.proposalLabel : requestedOutcome}»?</p><p>При подтверждённой утрате спрос восстановится, товар на склад не вернётся, а страховая выплата будет начислена один раз.</p>`,
      modal: true
    });
    if (!confirmed) return;
    const workflow = getSkyholdWorkflowService();
    const expectedResolutionId = String(order.riskResolutionId ?? "");
    const resolvedAt = new Date().toISOString();
    const operationId = `${expectedResolutionId || orderId}:gm-resolution`;
    const result = await SkyholdData.updateHolding(this.holdingId, (freshHolding) => {
      const freshOrder = freshHolding?.special?.market?.outbound?.orders?.find?.((row) => [row?.id, row?.operationId].some((value) => String(value ?? "") === orderId));
      if (!freshOrder || String(freshOrder.riskResolutionId ?? "") !== expectedResolutionId) return SkyholdData.skipTransaction({ ok: false, stale: true });
      const resolution = resolveMarketOutboundShipmentRisk({
        holding: freshHolding,
        orderId,
        outcome: requestedOutcome,
        delayQd,
        operationId,
        resolvedAt,
        dependencies: {
          addMoney: (target, amount) => workflow._addMoney(target, amount),
          appendStorageLog: (target, entries) => workflow._appendStorageLog(target, entries),
          formatCurrency: (amount) => formatCopperCurrency(amount)
        }
      });
      if (!resolution.ok) return SkyholdData.skipTransaction({ ok: false, message: resolution.message });
      if (!resolution.replay) appendHoldingOperation(freshHolding, {
        operationId: resolution.operationId,
        type: "market-outbound",
        createdAt: resolvedAt,
        title: `Разрешено событие исходящей продажи: ${freshOrder.marketLabel}`,
        summary: resolution.outcome === "lost"
          ? `Груз утрачен; спрос восстановлен${resolution.payoutCopper > 0 ? `; страховка ${formatCopperCurrency(resolution.payoutCopper)}` : ""}.`
          : (resolution.outcome === "delayed" ? `Задержка +${resolution.delayQd} QD.`
            : resolution.delivered?.ok ? "Груз доставлен; выручка поступила в бортовой кошелёк." : "Маршрут свободен; доставка продолжается."),
        payload: { orderId, orderOperationId: freshOrder.operationId, outcome: resolution.outcome, delayQd: resolution.delayQd, payoutCopper: resolution.payoutCopper }
      });
      return { ok: true, replay: resolution.replay, outcome: resolution.outcome, delayQd: resolution.delayQd,
        payoutCopper: resolution.payoutCopper, delivered: Boolean(resolution.delivered?.ok) };
    }, { fallback: false, reason: "market:outbound-resolve-risk" });
    if (!result?.ok) return ui.notifications?.warn?.("Событие изменилось или уже было разрешено. Обновите рынок.");
    requestSkyholdAppRender();
    this.requestRender({ focus: false });
    ui.notifications?.info?.(result.replay ? "Событие уже было разрешено." : (result.outcome === "lost" ? `Груз утрачен${result.payoutCopper > 0 ? `; страховка ${formatCopperCurrency(result.payoutCopper)}` : ""}.` : result.outcome === "delayed" ? `Поставка задержана на ${result.delayQd} QD.` : result.delivered ? "Груз доставлен; выручка на борту." : "Поставка продолжит путь."));
  }

  async _onCancelShipment(element) {
    if (!game.user?.isGM) return ui.notifications?.warn?.("Отменить рыночную поставку может только GM.");
    const orderId = String(element?.dataset?.orderId ?? "").trim();
    if (!orderId) return;
    const workflow = getSkyholdWorkflowService();
    const { holding } = this._marketSnapshot({ isGM: true });
    const order = holding?.special?.market?.orders?.find?.((row) => [row?.id, row?.operationId].some((value) => String(value ?? "") === orderId));
    const cancellation = marketShipmentCancellationQuote(order);
    if (!cancellation.cancellable) return ui.notifications?.warn?.(cancellation.reason || "Эту поставку уже нельзя отменить.");
    const confirmed = await foundryDialogV2().confirm({
      window: { title: "Отменить рыночную поставку" },
      content: `<p>Заказ ещё не передан перевозчику. В казну вернётся вся уплаченная сумма: <strong>${formatCopperCurrency(cancellation.refundCopper)}</strong>.</p><p>Зарезервированный товар также полностью вернётся в запас рынка.</p>`,
      modal: true
    });
    if (!confirmed) return;
    const cancelledAt = new Date().toISOString();
    const result = await SkyholdData.updateHolding(this.holdingId, (freshHolding) => {
      const cancelled = cancelMarketShipment({
        holding: freshHolding,
        orderId,
        cancelledAt,
        dependencies: {
          addMoney: (target, amount) => workflow._addMoney(target, amount),
          appendStorageLog: (target, entries) => workflow._appendStorageLog(target, entries),
          formatCurrency: (amount) => formatCopperCurrency(amount),
          restoreMarketStock: (options) => restoreMarketStockReservations(options)
        }
      });
      if (!cancelled.ok) return SkyholdData.skipTransaction({ ok: false, message: cancelled.message });
      if (!cancelled.replay) appendHoldingOperation(freshHolding, {
        operationId: cancelled.operationId,
        type: "market-purchase",
        createdAt: cancelledAt,
        title: `Отменена поставка: ${cancelled.order.marketLabel}`,
        summary: `Полный возврат ${formatCopperCurrency(cancelled.refundCopper)}.`,
        payload: { orderId, orderOperationId: cancelled.order.operationId, refundCopper: cancelled.refundCopper, withheldCopper: cancelled.withheldCopper }
      });
      return { ok: true, replay: cancelled.replay, refundCopper: cancelled.refundCopper };
    }, { fallback: false, reason: "market:cancel-shipment" });
    if (!result?.ok) return ui.notifications?.warn?.("Поставку уже передали перевозчику; отмена недоступна.");
    requestSkyholdAppRender();
    this.requestRender({ focus: false });
    ui.notifications?.info?.(`Поставка отменена. В казну возвращено ${formatCopperCurrency(result.refundCopper)}.`);
  }

  async _onResolveShipmentRisk(element) {
    if (!game.user?.isGM) return ui.notifications?.warn?.("Событие поставки может разрешить только GM.");
    const orderId = String(element?.dataset?.orderId ?? "").trim();
    const requestedOutcome = String(element?.dataset?.riskOutcome ?? "proposal");
    if (!orderId || !["proposal", "clear", "delayed", "lost"].includes(requestedOutcome)) return;
    const workflow = getSkyholdWorkflowService();
    const { holding } = this._marketSnapshot({ isGM: true });
    const order = holding?.special?.market?.orders?.find?.((row) => [row?.id, row?.operationId].some((value) => String(value ?? "") === orderId));
    const riskContext = marketShipmentRiskContext(order, { isGM: true, formatPercent: percentText, formatCurrency: formatCopperCurrency });
    if (!riskContext.canResolveRisk) return ui.notifications?.warn?.("Это событие уже разрешено или недоступно.");
    const delayQd = Math.max(1, Math.min(20, Math.ceil(Number(element?.dataset?.delayQd ?? riskContext.gmResolution?.delayQd) || 1)));
    const actionText = requestedOutcome === "proposal"
      ? `Применить предложение: ${riskContext.gmResolution?.proposalLabel || "событие"}`
      : requestedOutcome === "clear"
        ? "Отменить событие и продолжить путь без последствий"
        : requestedOutcome === "delayed"
          ? `Изменить результат на задержку +${delayQd} QD`
          : "Изменить результат на полную утрату груза";
    const confirmed = await foundryDialogV2().confirm({
      window: { title: "Разрешить событие поставки" },
      content: `<p><strong>${escapeHtml(order.marketLabel || "Внешний рынок")}</strong>: ${actionText}?</p><p>Решение применяется только к этой партии. Страховая выплата возможна только при подтверждённой утрате.</p>`,
      modal: true
    });
    if (!confirmed) return;

    const expectedResolutionId = String(order.riskResolutionId ?? "");
    const resolvedAt = new Date().toISOString();
    const resolutionOperationId = `${expectedResolutionId || orderId}:gm-resolution`;
    const result = await SkyholdData.updateHolding(this.holdingId, (freshHolding) => {
      const freshOrder = freshHolding?.special?.market?.orders?.find?.((row) => [row?.id, row?.operationId].some((value) => String(value ?? "") === orderId));
      if (!freshOrder || String(freshOrder.riskResolutionId ?? "") !== expectedResolutionId) {
        return SkyholdData.skipTransaction({ ok: false, stale: true });
      }
      const resolution = resolveMarketShipmentRisk({
        holding: freshHolding,
        order: freshOrder,
        outcome: requestedOutcome,
        delayQd,
        operationId: resolutionOperationId,
        resolvedAt,
        dependencies: {
          addMoney: (target, amount) => workflow._addMoney(target, amount),
          appendStorageLog: (target, entries) => workflow._appendStorageLog(target, entries),
          formatCurrency: (amount) => formatCopperCurrency(amount)
        }
      });
      if (!resolution.ok) return SkyholdData.skipTransaction({ ok: false, message: resolution.message });
      if (!resolution.replay) {
        const outcomeLabel = resolution.outcome === "lost"
          ? "груз утрачен"
          : resolution.outcome === "delayed"
            ? `задержка +${resolution.delayQd} QD`
            : "маршрут свободен, путь продолжен";
        appendHoldingOperation(freshHolding, {
          operationId: resolution.operationId,
          type: "market-purchase",
          createdAt: resolvedAt,
          title: `Разрешено событие поставки: ${freshOrder.marketLabel}`,
          summary: `${outcomeLabel}${resolution.payoutCopper > 0 ? `; страховка ${formatCopperCurrency(resolution.payoutCopper)}` : ""}.`,
          payload: {
            orderId,
            orderOperationId: freshOrder.operationId,
            outcome: resolution.outcome,
            delayQd: resolution.delayQd,
            payoutCopper: resolution.payoutCopper,
            resolutionChoice: freshOrder.riskResolutionChoice,
            gmResolution: true
          }
        });
      }
      return {
        ok: true,
        replay: resolution.replay,
        outcome: resolution.outcome,
        delayQd: resolution.delayQd,
        payoutCopper: resolution.payoutCopper
      };
    }, { fallback: false, reason: "market:resolve-shipment-risk" });
    if (!result?.ok) return ui.notifications?.warn?.("Событие изменилось или уже было разрешено. Обновите рынок.");
    requestSkyholdAppRender();
    this.requestRender({ focus: false });
    const resultText = result.outcome === "lost"
      ? `Груз утрачен${result.payoutCopper > 0 ? `; выплачено ${formatCopperCurrency(result.payoutCopper)}` : ""}.`
      : result.outcome === "delayed"
        ? `Поставка задержана на ${result.delayQd} QD.`
        : "Событие отменено; поставка продолжит путь.";
    ui.notifications?.info?.(result.replay ? "Событие уже было разрешено." : resultText);
  }

  async _onDeliverShipment(element) {
    if (!game.user?.isGM) return ui.notifications?.warn?.("Доставить груз сейчас может только GM.");
    const orderId = String(element?.dataset?.orderId ?? "").trim();
    if (!orderId) return;
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
          formatCurrency: (amount) => formatCopperCurrency(amount),
          internalDemandAvailableFromQd: (target) => internalDemandBatchClockQd(target)
        }
      });
      const delivered = arrival.delivered?.[0];
      if (!arrival.ok || !delivered) return SkyholdData.skipTransaction({ ok: false });
      appendHoldingOperation(holding, {
        operationId: delivered.operationId,
        type: "market-purchase",
        createdAt: new Date().toISOString(),
        title: `Прибыла поставка: ${delivered.marketLabel}`,
        summary: `${delivered.delivered.length} грузовых позиций доставлено вручную GM${delivered.riskWaived ? "; ожидавшая проверки риска явно отменена GM" : ""}.`,
        payload: { orderId: delivered.orderId, orderOperationId: delivered.orderOperationId, manual: true, riskWaived: Boolean(delivered.riskWaived), riskWaiverOperationId: String(delivered.riskWaiverOperationId ?? "") }
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
    this._outboundDisclosures.close();
    hideFloatingTooltip(this);
    SkyholdMarketApp.instances.delete(this.holdingId);
    restoreApplicationFocus(this);
  }
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
