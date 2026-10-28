import { dispatchDelegatedAction } from "./common/delegated-events.js";

import { MODULE_ID } from "../data/constants.js";
import { SkyholdData } from "../data/store.js";

import { findReadableHoldingEntry } from "../data/access-guard.js";
import { holdingPermissionContext } from "../data/holding-permissions.js";
import { normalizeMarketEconomy } from "../data/market/economy.js";
import { marketRegionForValue } from "../data/market/region-market.js";
import { allResourceDefs } from "../core/resources.js";
import { copperCurrencyParts, formatCopperCurrencyCompact, formatCopperCurrencyCompact as formatCopperCurrency } from "../core/currency.js";

import { holdingMarketAccessLevel, marketRegionAccessCostMap } from "../engines/market/logistics.js";
import { effectiveMarketLocations } from "../engines/market/composition.js";

import { resolveFoundryUuid } from "../integrations/foundry-runtime.js";
import { getSkyholdWorkflowService } from "../workflows/skyhold-workflow-service.js";
import { RenderSchedulerMixin } from "./common/render-scheduler.js";
import { bindImageFallbacks, capturePersistentImages, restorePersistentImages } from "./common/image-fallback.js";
import { bindFloatingTooltips, hideFloatingTooltip } from "./common/floating-tooltip.js";
import { restoreApplicationFocus } from "./common/window-focus-keeper.js";
import { focusMarketOutboundOrder } from "./market/outbound-focus.js";
import { DisclosureState } from "./common/disclosure-state.js";
import { groupMarketOffers, marketOfferGroupTotals, merchantAbbreviation, merchantTone } from "./market/offer-groups.js";

import { prepareMarketOutboundContext } from "./market/outbound-context.js";

import { authorityMarketLogistics, authorityMarketQuote, authorityOutboundRoutes, marketAuthoritySourceToken } from "./market/authority-context.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const TRANSPORT_MODE_NAMES = { caravan: "Караван", rail: "Железная дорога", airship: "Воздушный корабль" };
const TRANSPORT_NUMBER_FORMAT = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

/** Role-safe presentation of immutable transport terms; never looks up current prices. */
export function marketTransportPlanView(transportPlan, { isGM = false, hiddenCarrierIds = new Set(), hiddenCountryIds = new Set(), hiddenRegionIds = new Set() } = {}) {
  if (transportPlan?.version !== 1 || !Array.isArray(transportPlan.legs)
    || transportPlan.legs.some((leg) => !leg || typeof leg !== "object")) return { legs: [], pathText: "", carrierText: "", choiceText: "", transportText: "" };
  const decimal = (value) => TRANSPORT_NUMBER_FORMAT.format(Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0);
  const legs = transportPlan.legs.map((leg, index) => {
    const hidden = leg.visibility === "gm" || hiddenCarrierIds.has(leg.carrierId) || hiddenCountryIds.has(leg.fromCountryId)
      || hiddenCountryIds.has(leg.toCountryId) || hiddenRegionIds.has(leg.fromRegionId) || hiddenRegionIds.has(leg.toRegionId);
    if (!isGM && hidden) return { number: index + 1, hidden: true, fromLabel: "Скрытый участок", toLabel: "",
      modeLabel: "", carrierLabel: "", distanceText: "", timeText: "", capacityText: "", transferText: "", chargedText: "" };
    return { number: index + 1, hidden: false, fromLabel: String(leg.fromLabel || "Пункт отправления"), toLabel: String(leg.toLabel || "Пункт назначения"),
      modeLabel: leg.kind === "last-mile" ? "Местный воздушный участок" : String(leg.modeLabel || TRANSPORT_MODE_NAMES[leg.mode] || "Перевозка"),
      carrierLabel: String(leg.carrierLabel || "Независимые перевозчики"), distanceText: `${decimal(leg.distanceKm)} км`, timeText: `${decimal(leg.travelQd)} QD`,
      capacityText: loadText(leg.capacityLoad), transferText: Number.isFinite(leg.transferQd) && leg.transferQd > 0 ? `перегрузка ${decimal(leg.transferQd)} QD` : "",
      chargedText: Number.isFinite(leg.chargedCopper) ? `за перевозку: ${formatCopperCurrencyCompact(leg.chargedCopper)}` : "" };
  });
  const carriers = [...new Set(legs.map((leg) => leg.carrierLabel).filter(Boolean))];
  const hidden = legs.some((leg) => leg.hidden);
  return { legs, pathText: legs.map((leg) => leg.hidden ? "Скрытый участок" : `${leg.fromLabel} → ${leg.toLabel}`).join(" · "),
    carrierText: hidden || carriers.length > 1 ? "Составная перевозка" : carriers[0] || "",
    choiceText: legs.map((leg) => leg.hidden ? "Скрытый участок" : `${leg.modeLabel} · ${leg.carrierLabel}`).join(" → "),
    transportText: [...new Set(legs.map((leg) => leg.hidden ? "Скрытый участок" : leg.modeLabel))].join(" + ") };
}

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

function loadText(value = 0) {
  const load = Math.max(0, Number(value) || 0);
  return `${Number.isInteger(load) ? load : Number(load.toFixed(1))} ед.`;
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
    this.outboundQuantities = {};
    this._outboundDisclosures = new DisclosureState();
    this.ownShipId = "";
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
    const transport = authorityMarketLogistics({ holding, data, market, economy, isGM,
      direction: "outbound", carrierId: "auto-carriers" });
    const routes = this._marketOutboundRoutes({
      holding,
      data,
      market,
      economy,
      resources,
      offers: preliminary.offers,
      carriers: transport?.carriers ?? [],
      carrierId: "auto-carriers",
      preparedLogistics: transport?.logistics,
      isGM
    });
    const result = prepareMarketOutboundContext({
      holding,
      quote: outboundQuote,
      resourceDefinitions: resources,
      organizations: buyerOrganizations,
      routes,
      quantities: this.outboundQuantities
    });
    return result;
  }

  _marketSnapshot({ isGM = Boolean(game.user?.isGM) } = {}) {
    const data = SkyholdData.view();

    const { holding } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
    const locations = data?.catalog?.eventRegions ?? [];
    const economy = normalizeMarketEconomy(data?.catalog?.marketEconomy, { locations });
    const resources = allResourceDefs({ catalogRows: data?.catalog?.resources });
    const markets = this._availableMarkets(data, { holding, isGM, economy, resources });
    const market = markets.find((row) => row.id === this.marketId) ?? markets[0] ?? null;
    if (market && market.id !== this.marketId) this.marketId = market.id;
    if (!holding) return { data, holding: null, markets, market, quote: null, plan: null, outbound: null, sourceHash: "" };
    const quote = this._marketQuote(holding, data, market, { isGM, economy, resources });
    const outbound = this._marketOutboundContext({ holding, data, market, quote, economy, resources, isGM });
    return {
      data,
      holding,
      markets,
      market,
      quote,
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
    let { holding, markets, market, quote, outbound } = this._marketSnapshot();
    const permissions = holdingPermissionContext(holding);
    const workflow = getSkyholdWorkflowService();
    const rooms = holding ? workflow._storageRooms(holding, { includeUnavailable: false }) : [];
    const availableRoomIds = new Set(rooms.map((room) => String(room.id ?? "")));
    if (!availableRoomIds.has(this.targetRoomId)) {
      const preferred = String(holding?.special?.market?.preferredRoomId ?? "outdoors") || "outdoors";
      this.targetRoomId = availableRoomIds.has(preferred) ? preferred : (availableRoomIds.has("outdoors") ? "outdoors" : String(rooms[0]?.id ?? "outdoors"));
    }
    quote = await this._enrichMarketQuoteItems(quote);
    // Submit exactly the quantities displayed after stock/demand changes.
    this.quantities = Object.fromEntries((quote?.offers ?? []).map((offer) => [offer.id,
      Math.max(0, Math.min(Math.floor(Number(this.quantities[offer.id]) || 0), Number(offer.stock) || 0))]).filter(([, qty]) => qty > 0));
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

    const selectedCount = Object.values(this.quantities).reduce((sum, qty) => sum + Math.max(0, Number(qty) || 0), 0);

    const outboundPlan = outbound?.plan ?? null;
    const outboundOffers = (outbound?.offers ?? []).map((offer) => ({
      ...offer,
      canSelect: Boolean(permissions.canUseStorage && offer.available > 0),
      priceText: formatCopperCurrency(offer.unitPriceCopper),
      lineText: formatCopperCurrency(offer.unitPriceCopper * offer.qty),
      availabilityText: `${offer.availableStock} на складе · спрос ${offer.availableDemand}`
    }));
    this.outboundQuantities = Object.fromEntries(outboundOffers.filter((offer) => offer.qty > 0).map((offer) => [offer.resourceId, offer.qty]));

    const routeLogistics = quote?.logistics;

    const merchantTones = new Map((quote?.merchantProviders ?? []).map((provider, index) => [String(provider.id ?? ""), index % 6]));
    return {
      ...context,
      holding,
      hasHolding: Boolean(holding),
      hasMarket: Boolean(market),
      marketLabel: market?.label ?? "—",
      marketDescription: market?.description ?? "",
      marketCountryLabel: market?.countryLabel ?? "—",
      marketSizeLabel: market?.sizeLabel ?? "—",
      marketConditionLabel: market?.conditionLabel ?? "Стабильно",
      marketOptions: markets.map((row) => ({ value: row.id, label: `${row.label} · ${row.routeAccessCost ? `УРС ${row.routeAccessCost}` : "локально"}`, selected: row.id === market?.id })),
      canPurchase: Boolean(holding && permissions.canUseStorage),
      canOrder: Boolean(holding && permissions.canUseStorage),
      readOnlyReason: permissions.isGM ? "" : "Сделки на внешнем рынке подтверждает GM.",
      logisticsOk: routeLogistics?.ok !== false,
      logisticsReason: (routeLogistics?.reasons ?? []).join(" "),
      treasuryText: formatCopperCurrencyCompact(holding?.storage?.moneyCopper ?? 0),
      treasuryParts: copperCurrencyParts(holding?.storage?.moneyCopper ?? 0),
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
      canConfirm: Boolean(permissions.canUseStorage && selectedCount > 0),
      outboundOffers,
      outboundHasOffers: outboundOffers.length > 0,
      outboundHasForSaleStock: Boolean(outbound?.hasForSaleStock),
      outboundShowSection: Boolean(outbound?.hasForSaleStock),
      outboundStockCount: Math.max(0, Number(outbound?.forSaleResourceCount) || 0),
      outboundUnavailableForSaleCount: Math.max(0, Number(outbound?.unavailableForSaleCount) || 0),
      outboundSelectedUnits: Math.max(0, Number(outbound?.selectedUnits) || 0),
      outboundHasSelection: Math.max(0, Number(outbound?.selectedUnits) || 0) > 0,
      outboundCanBook: Boolean(permissions.canUseStorage && Object.values(this.outboundQuantities).some((qty) => qty > 0)),
      outboundRevenueText: formatCopperCurrency(outboundPlan?.revenueCopper ?? 0)
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
      this.requestRender({ focus: false });
    } else if (action === "market-transport-orders") {
      event.preventDefault();
      return import("./lazy-apps.js").then(({ openTransportApp }) => openTransportApp({ holdingId: this.holdingId }));
    } else if (action === "market-buy") {
      event.preventDefault();
      return this._onBuy();
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
    }
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
    const provider = event.target?.closest?.("[data-market-provider]");
    if (provider && root.contains(provider)) {
      this.marketId = String(provider.value ?? "");
      this.carrierId = "";
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

  async _onBuy() { return this._openTransport("inbound"); }

  async _onBookOutbound() { return this._openTransport("outbound"); }

  async _openTransport(direction) {
    if (this._buyOperationPending) return;
    this._buyOperationPending = true;
    try {
      const snapshot = this._marketSnapshot();
      if (!holdingPermissionContext(snapshot.holding).canUseStorage) return;
      return await this._showTransport({ holdingId: this.holdingId, request: { direction, marketId: snapshot.market?.id,
        quantities: structuredClone(direction === "inbound" ? this.quantities : this.outboundQuantities), targetRoomId: this.targetRoomId,
        ownShipId: this.ownShipId || "" } });
    } finally { this._buyOperationPending = false; }
  }

  async _showTransport(options) {
    const { openTransportApp } = await import("./lazy-apps.js");
    return openTransportApp(options);
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
