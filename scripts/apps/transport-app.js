import { MODULE_ID } from "../data/constants.js";
import { SkyholdData, requestMarketOperation } from "../data/store.js";
import { findReadableHoldingEntry } from "../data/access-guard.js";
import { holdingPermissionContext } from "../data/holding-permissions.js";
import { makeId } from "../data/utils.js";
import { transportOrders } from "../data/transport/state.js";
import { TRANSPORT_SERVICE_DEFAULTS } from "../engines/transport/services.js";
import { prepareTransportContext, transportSourceToken } from "./domains/transport-context.js";
import { formatCopperCurrencyCompact as money } from "../core/currency.js";
import { DisclosureState } from "./common/disclosure-state.js";
import { RenderSchedulerMixin } from "./common/render-scheduler.js";
import { restoreApplicationFocus } from "./common/window-focus-keeper.js";
import { requestSkyholdAppRender } from "./registry.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const days = (qd) => `${Math.max(0, qd) / 4} дн.`;
const statuses = { booked: "Забронировано", travelling: "В пути", waitingCarrier: "Ожидает освобождения транспорта", needsResolution: "Ожидает решения ГМ", delivered: "Доставлено", lost: "Груз утрачен", cancelled: "Отменено" };
function stageInvoice(stage) {
  const parts = [["Подача", "dispatchCopper"], ["Тариф за груз", "loadCopper"], ["Содержание в пути и возврат", "operatingCopper"],
    ["Обработка", "handlingCopper"], ["Скидка", "discountCopper"]].map(([label, key]) => {
    const amount = stage.runs.reduce((sum, run) => sum + (run.charge[key] ?? 0), 0);
    return amount ? `${label}: ${key === "discountCopper" ? "−" : ""}${money(amount)}` : "";
  }).filter(Boolean);
  if (stage.storageCopper) parts.push(`Хранение до отправления: ${money(stage.storageCopper)}`);
  return parts.join("; ");
}
const actions = ["transport-confirm", "transport-retry", "transport-cancel", "transport-advance", "transport-configure",
  "transport-incident-success", "transport-incident-delay", "transport-incident-loss", "transport-ship-sync", "transport-clear-pin", "transport-clear-pins", "transport-fund", "transport-exclude", "transport-restore-companies"];

export class SkyholdTransportApp extends RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  static instances = new Map();
  static sessions = new Map();
  static inFlight = new Set();
  static DEFAULT_OPTIONS = { id: "fbls-transport", classes: ["fbl-skyhold", "fbls-secondary", "fbls-transport-window"], tag: "div",
    window: { title: "Перевозки", resizable: true }, position: { width: 900, height: 760 },
    actions: Object.fromEntries(actions.map((action) => [action, function(event, target) { return this._action(event, target); }])) };
  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/transport-app.hbs` } };
  static open({ holdingId, request = null } = {}) {
    let app = this.instances.get(holdingId);
    if (!app) { app = new this({ holdingId }); this.instances.set(holdingId, app); }
    if (request && !app._pending) app.request = { priority: "cost", insurance: true, reserveCopper: 0, returnHome: false, ...request };
    app.render({ force: true, focus: true }); return app;
  }
  static rerenderOpen() { for (const app of this.instances.values()) app.requestRender({ focus: false }); }
  constructor(options = {}) {
    super(options); this.holdingId = options.holdingId; this._disclosures = new DisclosureState();
    this._pending = this.constructor.sessions.get(this.holdingId) ?? null;
  }
  async _prepareContext(options) {
    if (this._pending && !this.constructor.sessions.has(this.holdingId)) this._pending = null;
    const base = await super._prepareContext(options), data = SkyholdData.view();
    const { holding } = findReadableHoldingEntry(data, this.holdingId);
    if (!holding) return { ...base, hasHolding: false };
    const permissions = holdingPermissionContext(holding);
    const clockQd = Math.max(data.meta?.transportV2?.clockQd ?? 0, holding.gm?.calendaria?.lastQd ?? 0);
    let quote = null, quoteError = "";
    if (this.request) {
      try { quote = prepareTransportContext({ data, holding, request: this.request, isGM: permissions.isGM }); }
      catch (error) { quoteError = error.message; }
    }
    this._view = { data, holding, permissions, quote, sourceToken: transportSourceToken(data, holding) };
    const hiddenCountries = new Set((data.catalog?.marketEconomy?.countries ?? []).filter((row) => row.visibility === "gm").map((row) => row.id));
    const hiddenRegions = new Set((data.catalog?.eventRegions ?? []).filter((row) => hiddenCountries.has(row.countryId)).map((row) => row.value));
    const hiddenCompanies = new Set((data.catalog?.marketEconomy?.organizations ?? []).filter((row) => row.visibility === "gm").map((row) => row.id));
    const path = (stage) => !permissions.isGM && (stage.service.visibility === "gm" || hiddenRegions.has(stage.from)
      || hiddenRegions.has(stage.to) || hiddenCompanies.has(stage.service.companyId)) ? "Скрытый участок"
      : `${stage.service.fromLabel || stage.from} → ${stage.service.toLabel || stage.to}`;
    const shipTiming = (order) => {
      if (!order.ownShipId || order.shipArrived || order.status === "cancelled") return "";
      const last = order.stages.filter((stage) => stage.service.kind === "owned").flatMap((stage) => stage.runs).at(-1);
      const physical = data.meta.transportV2.runs.find((run) => run.id === last?.id) ?? last;
      const destination = order.shipAbort?.location ?? physical.releaseLocation;
      const label = !permissions.isGM && hiddenRegions.has(destination) ? "скрытый порт"
        : data.catalog.eventRegions.find((row) => row.value === destination)?.label ?? destination;
      return `Ожидаемое освобождение через ${days((order.shipAbort?.releaseQd ?? physical.releaseQd) - clockQd)}: ${label}; при происшествии срок уточняется`;
    };
    const selected = quote ? {
      delivery: money(quote.totalCopper), value: money(quote.valueCopper), treasury: money(quote.treasuryCopper),
      arrival: days(quote.plan.arrivalQd - quote.plan.startQd), firstArrival: days(quote.plan.firstArrivalQd - quote.plan.startQd),
      splitArrival: quote.plan.firstArrivalQd !== quote.plan.arrivalQd, shipRelease: quote.ship ? days(quote.plan.shipReleaseQd - quote.plan.startQd) : "",
      shipReleaseLocation: data.catalog.eventRegions.find((row) => row.value === quote.plan.shipReleaseLocation)?.label ?? quote.plan.shipReleaseLocation,
      ownExpenses: money(quote.plan.ownExpensesCopper), reserve: money(quote.commercial.reserveCopper),
      approach: quote.ship ? money(quote.plan.approachCopper) : "",
      tax: money(quote.commercial.taxCopper), insurance: money(quote.commercial.insuranceCopper),
      coveragePercent: quote.commercial.insuranceCoverageBps / 100,
      revenueOnBoard: quote.commercial.revenueOnBoard, outbound: this.request.direction === "outbound",
      net: `${quote.valueCopper < quote.totalCopper ? "−" : ""}${money(Math.abs(quote.valueCopper - quote.totalCopper))}`, limited: quote.search.limited,
      warnings: quote.warnings,
      cargo: quote.plan.cargo.map((lot) => ({ name: lot.name || lot.resourceId, qty: lot.qty })),
      stages: quote.plan.stages.map((stage) => ({ path: path(stage), count: stage.runs.length,
        label: stage.service.label, price: money(stage.totalCopper), invoice: stageInvoice(stage), from: stage.from, company: stage.service.companyId,
        departures: stage.runs.map((run, index) => ({ number: index + 1, qty: run.cargo.reduce((sum, lot) => sum + lot.qty, 0),
          departure: days(run.departureQd - quote.plan.startQd), arrival: days(run.arrivalQd - quote.plan.startQd), price: money(run.charge.totalCopper) })),
        pinned: Boolean(this.request.pins?.[stage.from]),
        options: quote.services.filter((service) => service.from === stage.from && service.to === stage.to).map((service) => ({
          value: service.id, label: `${service.label} · ${service.kind === "regular" ? "регулярный" : service.kind === "owned" ? "свой корабль" : "чартер"}`,
          selected: service.id === stage.service.id })) }))
    } : null;
    const configuration = this._configuration ?? data.catalog?.transportV2 ?? TRANSPORT_SERVICE_DEFAULTS;
    const orders = [...transportOrders(holding)].reverse().map((order) => ({ id: order.id,
      market: !permissions.isGM && hiddenRegions.has(order.commercial.marketRegionId) ? "Скрытый рынок" : order.commercial.marketLabel,
      status: statuses[order.status] || order.status, direction: order.direction === "outbound" ? "Продажа" : "Покупка",
      cost: money(order.status === "cancelled" ? 0 : order.money.spentCopper + order.commercial.taxCopper + order.commercial.insuranceCopper), escrow: money(order.money.escrowCopper),
      received: order.received.reduce((sum, lot) => sum + lot.qty, 0), total: order.cargo.reduce((sum, lot) => sum + lot.qty, 0),
      fundingNeeded: order.fundingNeededCopper ? money(order.fundingNeededCopper) : "", canFund: permissions.canUseStorage && permissions.canManageShips,
      shipStatus: order.ownShipId ? order.shipReleased ? "Корабль свободен" : order.shipArrived
        ? "Корабль прибыл; ожидает расчёта, содержание продолжается" : "Корабль занят этим заказом" : "",
      shipReturnBlocked: order.shipAbort?.returnBlocked,
      shipTiming: shipTiming(order),
      arrival: days(Math.max(...order.stages.flatMap((stage) => stage.runs.map((run) => run.arrivalQd))) - clockQd),
      canCancel: permissions.canUseStorage && !order.shipStarted && !order.history.some((row) => row.kind === "departed") && order.status === "booked",
      stages: order.stages.map((stage) => ({ path: path(stage), count: stage.runs.length, price: money(stage.totalCopper), invoice: stageInvoice(stage) })) }));
    const incidents = permissions.isGM ? (data.meta?.transportV2?.runs ?? []).filter((run) => run.incident?.status === "pending")
      .map((run) => ({ id: run.id, label: run.serviceLabel, orders: run.claims.length,
        awaitingCargo: [...new Set(run.claims.filter(claim => claim.stage > 0 && claim.manifestReady !== true)
          .map(claim => data.holdings.find(row => row.id === claim.holdingId)?.name ?? claim.holdingId))].join(", "),
        delayDays: this._incidentFields?.[run.id]?.delayDays ?? 1, lossPercent: this._incidentFields?.[run.id]?.lossPercent ?? 100 })) : [];
    const archive = [...(holding.special?.market?.orders ?? []).map((row) => ({ ...row, direction: "Покупка" })),
      ...(holding.special?.market?.outbound?.orders ?? []).map((row) => ({ ...row, direction: "Продажа" }))]
      .filter((row) => ["delivered", "lost", "cancelled"].includes(row.status)).slice(-40).reverse().map((row) => ({
        direction: row.direction, status: statuses[row.status],
        market: !permissions.isGM && (hiddenCountries.has(row.countryId) || hiddenRegions.has(row.originRegionId)
          || hiddenRegions.has(row.destinationRegionId) || hiddenRegions.has(String(row.marketId ?? "").replace(/^market-location:/, ""))) ? "Скрытый рынок" : row.marketLabel,
        cargo: (row.cargo ?? row.cargoReservations ?? []).map((lot) => `${lot.name || lot.resourceId || "Товар"} × ${lot.qty}`).join(" · ") }));
    return { ...base, hasHolding: true, holdingName: holding.name, isGM: permissions.isGM, canUse: permissions.canUseStorage,
      canConfirm: Boolean(quote?.affordable && permissions.canUseStorage && (!quote.ship || permissions.canManageShips) && !this._pending && !this._busy),
      selected, quoteError, error: this._error, busy: this._busy || this.constructor.inFlight.has(this._pending?.operationId), pending: Boolean(this._pending), orders, incidents, archive,
      hasRequest: Boolean(this.request), request: this.request, byTime: this.request?.priority === "time", configuration,
      configurationView: { intervalDays: configuration.regularIntervalQd / 4, phaseDays: configuration.regularFirstQd / 4,
        commercialPercent: configuration.commercialLoadBps / 100, insurancePercent: configuration.insuranceBps / 100,
        coveragePercent: configuration.insuranceCoverageBps / 100 },
      hasExcludedCompanies: Boolean(this.request?.excluded?.length),
      hasPins: Boolean(Object.keys(this.request?.pins ?? {}).length),
      ships: permissions.canManageShips ? (holding.special?.ships?.list ?? []).filter((ship) => ship.navigationMode === "world").map((ship) => ({
        id: ship.id, name: ship.name, selected: ship.id === this.request?.ownShipId, busy: Boolean(ship.activeVoyage || ship.orderBundle || ship.transportOrderId) })) : [] };
  }
  async _onRender(context, options) {
    await super._onRender(context, options);
    this._listeners?.abort(); this._listeners = new AbortController(); this._disclosures.bind(this.element);
    this.element.addEventListener("change", (event) => {
      if (this._busy || this._pending) return;
      const field = event.target.closest("[data-transport-field], [data-transport-pin], [data-transport-config], [data-transport-incident-field]");
      if (!field) return;
      if (field.dataset.transportIncidentField && this._view.permissions.isGM) {
        const runId = field.closest("[data-transport-incident]").dataset.transportIncident;
        this._incidentFields ??= {}; this._incidentFields[runId] ??= {};
        this._incidentFields[runId][field.dataset.transportIncidentField] = Number(field.value);
      } else if (field.dataset.transportConfig && this._view.permissions.isGM) {
        this._configuration = { ...(this._configuration ?? this._view.data.catalog?.transportV2 ?? TRANSPORT_SERVICE_DEFAULTS),
          [field.dataset.transportConfig]: Math.round(Number(field.value) * Number(field.dataset.scale ?? 1)) };
      } else if (this.request && field.dataset.transportPin) {
        this.request.pins = { ...this.request.pins, [field.dataset.transportPin]: field.value };
      } else if (this.request && field.dataset.transportField) {
        this.request[field.dataset.transportField] = field.type === "checkbox" ? field.checked : field.type === "number" ? Number(field.value) : field.value;
      }
      this.requestRender({ focus: false });
    }, { signal: this._listeners.signal });
    restoreApplicationFocus(this, options);
  }
  async _action(_event, target) {
    if (this._busy) return;
    this._error = "";
    try {
      const action = target.dataset.action;
      if (action === "transport-clear-pin") { delete this.request.pins?.[target.dataset.from]; return this.requestRender({ focus: false }); }
      if (action === "transport-clear-pins") { this.request.pins = {}; return this.requestRender({ focus: false }); }
      if (action === "transport-exclude") {
        this.request.excluded = [...new Set([...(this.request.excluded ?? []), target.dataset.company])];
        return this.requestRender({ focus: false });
      }
      if (action === "transport-restore-companies") { this.request.excluded = []; return this.requestRender({ focus: false }); }
      if (action === "transport-retry") return await this._submit();
      if (this._pending) throw new Error("Сначала получите результат предыдущей операции кнопкой «Проверить повторно».");
      const { data, holding, quote, sourceToken } = this._view;
      const type = action === "transport-confirm" ? "transport-book" : action.startsWith("transport-incident-") ? "transport-incident" : action;
      const op = { type, operationId: makeId("transport", 20), holdingId: holding.id, expectedRevision: data.meta.revision, sourceToken };
      if (type === "transport-book") {
        if (!quote?.affordable) throw new Error("Проверьте расчёт и деньги в казне.");
        op.request = { ...structuredClone(this.request), serviceIds: quote.plan.stages.map((stage) => stage.service.id) };
        op.planToken = quote.planToken;
      }
      if (type === "transport-cancel") op.orderId = target.dataset.order;
      if (type === "transport-fund") op.orderId = target.dataset.order;
      if (type === "transport-ship-sync") op.shipId = this.request?.ownShipId;
      if (type === "transport-configure") op.configuration = this._configuration ?? data.catalog?.transportV2 ?? { ...TRANSPORT_SERVICE_DEFAULTS };
      if (type === "transport-incident") op.runId = target.dataset.run;
      if (type === "transport-incident") op.resolution = { outcome: action.split("-").at(-1),
        delayQd: (this._incidentFields?.[op.runId]?.delayDays ?? 1) * 4,
        lossBps: Math.round((this._incidentFields?.[op.runId]?.lossPercent ?? 100) * 100) };
      this._pending = op; this.constructor.sessions.set(this.holdingId, op);
      await this._submit();
    } catch (error) {
      this._error = error.message;
      if (!["timeout", "authority-offline", "socket-unavailable"].includes(error.code) && !error.retryable) {
        this._pending = null; this.constructor.sessions.delete(this.holdingId);
      }
      this.constructor.rerenderOpen();
    }
  }
  async _submit() {
    if (!this._pending) return;
    const operation = this._pending;
    if (this.constructor.inFlight.has(operation.operationId)) return;
    this.constructor.inFlight.add(operation.operationId);
    this._busy = true; this.requestRender({ focus: false });
    try {
      const result = await requestMarketOperation(operation);
      if (!result?.ok) throw new Error("Транспортная операция не подтверждена.");
      if (operation.type === "transport-book") {
        this.request = null;
        const reopened = this.constructor.instances.get(this.holdingId);
        if (reopened) reopened.request = null;
      }
      this._pending = null; this.constructor.sessions.delete(this.holdingId);
      requestSkyholdAppRender(); this.constructor.rerenderOpen();
    } finally { this.constructor.inFlight.delete(operation.operationId); this._busy = false; this.constructor.rerenderOpen(); }
  }
  async close(options) {
    this._listeners?.abort(); this._disclosures.close(); this.constructor.instances.delete(this.holdingId);
    return super.close(options);
  }
}
