import { MODULE_ID } from "../data/constants.js";
import { SkyholdData, requestMarketOperation } from "../data/store.js";
import { findReadableHoldingEntry } from "../data/access-guard.js";
import { holdingPermissionContext } from "../data/holding-permissions.js";
import { makeId } from "../data/utils.js";
import { legacyActiveMarketOrders, transportOrders } from "../data/transport/state.js";
import { canCancelTransportOrder } from "../engines/transport/runtime.js";
import { transportHoldingQd } from "../data/transport/clock.js";
import { TRANSPORT_SERVICE_DEFAULTS } from "../engines/transport/services.js";
import { prepareTransportOptions, transportSourceToken } from "./domains/transport-context.js";
import { formatCopperCurrencyCompact as money } from "../core/currency.js";
import { DisclosureState } from "./common/disclosure-state.js";
import { RenderSchedulerMixin } from "./common/render-scheduler.js";
import { restoreApplicationFocus } from "./common/window-focus-keeper.js";
import { requestSkyholdAppRender } from "./registry.js";
import { transportHistoryPage, transportRiskLabel, transportStageRiskLabel, transportStageSchedule } from "./domains/transport-view.js";
import { createMarketVisibility } from "../data/market/visibility.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const number = (value) => value.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
const days = (qd) => `${number(Math.max(0, qd) / 4)} дн.`;
const statuses = { booked: "Забронировано", travelling: "В пути", waitingCarrier: "Ожидает освобождения транспорта", needsResolution: "Ожидает решения ГМ", delivered: "Доставлено", lost: "Груз утрачен", cancelled: "Отменено" };
const legacyStatuses = { pending: "Ожидает исполнения", "in-transit": "В пути", delayed: "Задержан" };

function vehicleCountLabel(service) {
  const count = Math.max(1, Math.floor(Number(service?.vehicleCount ?? 1)));
  if (count <= 1) return "";
  if (service.mode === "caravan") return `${count} каравана`;
  if (service.mode === "rail") return `${count} состава`;
  return `${count} судна`;
}

function stageInvoice(stage) {
  const parts = [["Подача", "dispatchCopper"], ["Тариф за груз", "loadCopper"], ["Содержание в пути и возврат", "operatingCopper"],
    ["Обработка", "handlingCopper"], ["Надбавка перевозчика", "profitCopper"], ["Скидка", "discountCopper"]].map(([label, key]) => {
    const amount = stage.runs.reduce((sum, run) => sum + (run.charge[key] ?? 0), 0);
    return amount ? `${label}: ${key === "discountCopper" ? "−" : ""}${money(amount)}` : "";
  }).filter(Boolean);
  return parts.join("; ");
}

function optionSummaryCarriers(quote, visibility) {
  if (!quote?.plan?.stages?.length) return "";
  const names = [...new Set(quote.plan.stages.map((stage) => (
    visibility.transportStageHidden(stage) ? "Скрытый перевозчик" : stage.service.label
  )))];
  return names.join(" → ");
}

function orderCargoSummary(cargo = []) {
  const rows = (cargo ?? []).filter((lot) => Number(lot?.qty ?? 0) > 0);
  if (!rows.length) return "";
  const preview = rows.slice(0, 4).map((lot) => `${lot.name || lot.resourceId || "Товар"} × ${lot.qty}`);
  if (rows.length > 4) preview.push(`и ещё ${rows.length - 4}`);
  return preview.join(" · ");
}

function optionRiskLabel(quote) {
  if (!quote?.plan?.stages?.length) return "";
  const risks = quote.plan.stages.flatMap((stage) => stage.runs.map((run) => run.riskBps ?? 0));
  if (!risks.length) return "0%";
  const min = Math.min(...risks), max = Math.max(...risks);
  return min === max ? transportRiskLabel(min) : `${transportRiskLabel(min)}–${transportRiskLabel(max)}`;
}

const actions = [
  "transport-select-mode", "transport-confirm", "transport-retry", "transport-cancel", "transport-advance",
  "transport-configure", "transport-incident-success", "transport-incident-delay", "transport-incident-loss",
  "transport-ship-sync", "transport-fund", "transport-history-previous", "transport-history-next"
];

export class SkyholdTransportApp extends RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  static instances = new Map();
  static sessions = new Map();
  static inFlight = new Set();
  static DEFAULT_OPTIONS = {
    id: "fbls-transport",
    classes: ["fbl-skyhold", "fbls-secondary", "fbls-transport-window"],
    tag: "div",
    window: { title: "Перевозки", icon: "fa-solid fa-route", resizable: true },
    position: { width: 900, height: 760 },
    actions: Object.fromEntries(actions.map((action) => [action, function(event, target) { return this._action(event, target); }]))
  };
  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/transport-app.hbs` } };

  static open({ holdingId, request = null } = {}) {
    let app = this.instances.get(holdingId);
    if (!app) { app = new this({ holdingId }); this.instances.set(holdingId, app); }
    if (request && !app._pending) {
      const explicitMode = request.mode ?? (request.ownShipId ? "owned" : request.priority === "time" ? "charter" : "");
      app.request = {
        ...(explicitMode ? { mode: explicitMode } : {}),
        priority: explicitMode === "charter" ? "time" : "cost",
        insurance: true,
        reserveCopper: 0,
        returnHome: false,
        ...request
      };
      app._bundleCache = null;
      app._error = "";
    }
    app.render({ force: true, focus: true });
    return app;
  }

  static rerenderOpen() {
    for (const app of this.instances.values()) app.requestRender({ focus: false });
  }

  constructor(options = {}) {
    super({ ...options, id: `fbls-transport-${options.holdingId}` });
    this.holdingId = options.holdingId;
    this._disclosures = new DisclosureState();
    this._pending = this.constructor.sessions.get(this.holdingId) ?? null;
  }

  async _prepareContext(options) {
    if (this._pending && !this.constructor.sessions.has(this.holdingId)) this._pending = null;
    const base = await super._prepareContext(options), data = SkyholdData.view();
    const { holding } = findReadableHoldingEntry(data, this.holdingId);
    if (!holding) return { ...base, hasHolding: false };
    const permissions = holdingPermissionContext(holding);
    const clockQd = Math.max(data.meta?.transportV2?.clockQd ?? 0, transportHoldingQd(data, holding));

    let bundle = null, quote = null, quoteError = "";
    const liveSourceToken = transportSourceToken(data, holding);
    if (this.request) {
      const cacheKey = `${liveSourceToken}|${permissions.isGM ? 1 : 0}|${JSON.stringify(this.request)}`;
      try {
        if (this._bundleCache?.key === cacheKey) {
          bundle = this._bundleCache.bundle;
        } else {
          bundle = prepareTransportOptions({ data, holding, request: this.request, isGM: permissions.isGM });
          this._bundleCache = { key: cacheKey, bundle };
        }
        if (bundle.activeMode === "owned" && bundle.chosenShip && !this.request.ownShipId) {
          this.request.ownShipId = bundle.chosenShip.id;
        }
        quote = bundle.active?.ok ? bundle.active : null;
        quoteError = bundle.active?.ok ? "" : (bundle.active?.error ?? "");
      } catch (error) {
        this._bundleCache = null;
        quoteError = error.message;
      }
    } else {
      this._bundleCache = null;
    }
    this._view = { data, holding, permissions, bundle, quote, sourceToken: bundle?.sourceToken ?? liveSourceToken };

    const visibility = createMarketVisibility(data, { isGM: permissions.isGM });
    const pointLabel = (id) => visibility.pointHidden(id) ? "скрытый порт"
      : String(id).endsWith(":holding") ? holding.name : data.catalog.eventRegions.find((row) => row.value === id)?.label ?? id;
    const endpointLabel = (id, label) => String(id).endsWith(":holding") ? holding.name : label || pointLabel(id);
    const path = (stage) => visibility.transportStageHidden(stage) ? "Скрытый участок"
      : `${endpointLabel(stage.from, stage.service.fromLabel)} → ${endpointLabel(stage.to, stage.service.toLabel)}`;

    const shipTiming = (order) => {
      if (!order.ownShipId || order.shipArrived || order.status === "cancelled") return "";
      const last = order.stages.filter((stage) => stage.service.kind === "owned").flatMap((stage) => stage.runs).at(-1);
      const physical = data.meta.transportV2.runs.find((run) => run.id === last?.id) ?? last;
      if (!physical && !order.shipAbort) return "Грузовых ходок нет. Возврат корабля будет рассчитан при проведении поселения.";
      const destination = order.shipAbort?.location ?? physical.releaseLocation;
      const label = pointLabel(destination);
      return `Ожидаемое освобождение через ${days((order.shipAbort?.releaseQd ?? physical.releaseQd) - clockQd)}: ${label}; при происшествии срок уточняется`;
    };

    const worldShips = permissions.canManageShips
      ? (holding.special?.ships?.list ?? []).filter((ship) => ship.navigationMode === "world").map((ship) => ({
        id: ship.id,
        name: ship.name,
        selected: ship.id === (this.request?.ownShipId || bundle?.chosenShip?.id),
        busy: Boolean(ship.activeVoyage || ship.orderBundle || ship.transportOrderId)
      }))
      : [];

    const hiredOk = bundle ? [bundle.options.regular, bundle.options.charter].filter((row) => row?.ok) : [];
    const cheapestHiredCopper = hiredOk.length ? Math.min(...hiredOk.map((row) => row.totalCopper)) : Infinity;
    const fastestHiredQd = hiredOk.length ? Math.min(...hiredOk.map((row) => row.plan.arrivalQd - row.plan.startQd)) : Infinity;
    const badgeFor = (mode, result) => {
      if (!result?.ok || mode === "owned" || hiredOk.length < 2) return "";
      const tags = [];
      if (result.totalCopper === cheapestHiredCopper) tags.push("Выгоднее");
      const dur = result.plan.arrivalQd - result.plan.startQd;
      if (dur === fastestHiredQd && (bundle.options.regular.plan.arrivalQd !== bundle.options.charter.plan.arrivalQd)) tags.push("Быстрее");
      return tags.join(" · ");
    };

    const makeChoice = (mode, title, subtitle, result, icon) => ({
      mode, title, subtitle, icon,
      selected: bundle?.activeMode === mode,
      available: Boolean(result?.ok),
      badge: badgeFor(mode, result),
      arrival: result?.ok ? days(result.plan.arrivalQd - result.plan.startQd) : "",
      delivery: result?.ok ? money(result.totalCopper) : "",
      treasury: result?.ok ? money(result.treasuryCopper) : "",
      summary: result?.ok ? optionSummaryCarriers(result, visibility) : "",
      risk: result?.ok ? optionRiskLabel(result) : "",
      transferNote: result?.ok && result.transferPortLabel ? `Стыковка в порту: ${result.transferPortLabel}` : "",
      error: result?.ok ? "" : (result?.error ?? "Вариант недоступен")
    });

    const choices = bundle ? [
      makeChoice("regular", "Сборный рейс", "Регулярное расписание", bundle.options.regular, "fa-solid fa-boxes-stacked"),
      makeChoice("charter", "Фрахт (чартер)", "Отдельный рейс без ожидания", bundle.options.charter, "fa-solid fa-bolt"),
      ...(worldShips.length ? [makeChoice("owned", "Свой корабль", bundle.chosenShip?.name || "Собственное судно", bundle.options.owned, "fa-solid fa-ship")] : [])
    ] : [];

    const holdingTreasuryCopper = Math.max(0, Number(holding.storage?.moneyCopper ?? 0));
    const selected = quote?.plan ? {
      delivery: money(quote.totalCopper),
      value: money(quote.valueCopper),
      treasury: money(quote.treasuryCopper),
      holdingTreasury: money(holdingTreasuryCopper),
      shortfall: quote.affordable ? "" : money(Math.max(0, quote.treasuryCopper - holdingTreasuryCopper)),
      arrival: days(quote.plan.arrivalQd - quote.plan.startQd),
      firstArrival: days(quote.plan.firstArrivalQd - quote.plan.startQd),
      splitArrival: quote.plan.firstArrivalQd !== quote.plan.arrivalQd,
      shipRelease: quote.ship ? days(quote.plan.shipReleaseQd - quote.plan.startQd) : "",
      shipReleaseLocation: pointLabel(quote.plan.shipReleaseLocation),
      ownExpenses: money(quote.plan.ownExpensesCopper),
      reserve: money(quote.commercial.reserveCopper),
      approach: quote.ship && quote.plan.approachCopper > 0 ? money(quote.plan.approachCopper) : "",
      tax: money(quote.commercial.taxCopper),
      insurance: money(quote.commercial.insuranceCopper),
      coveragePercent: quote.commercial.insuranceCoverageBps / 100,
      revenueOnBoard: quote.commercial.revenueOnBoard,
      outbound: this.request.direction === "outbound",
      net: `${quote.valueCopper < quote.totalCopper ? "−" : ""}${money(Math.abs(quote.valueCopper - quote.totalCopper))}`,
      warnings: quote.warnings,
      cargo: quote.plan.cargo.map((lot) => ({ name: lot.name || lot.resourceId, qty: lot.qty })),
      stages: quote.plan.stages.map((stage) => {
        const firstRun = stage.runs[0];
        const lastRun = stage.runs.at(-1);
        return {
          path: path(stage),
          count: stage.runs.length,
          multiRun: stage.runs.length > 1,
          vehicles: vehicleCountLabel(stage.service),
          risk: transportStageRiskLabel(stage),
          label: visibility.transportStageHidden(stage) ? "Скрытый перевозчик" : stage.service.label,
          price: money(stage.totalCopper),
          invoice: stageInvoice(stage),
          interval: stage.service.kind === "regular" ? days(stage.service.intervalQd) : "",
          distance: Number.isFinite(stage.service.distanceKm) ? `${number(stage.service.distanceKm)} км` : "",
          departure: firstRun ? days(firstRun.departureQd - quote.plan.startQd) : "",
          arrival: lastRun ? days(lastRun.arrivalQd - quote.plan.startQd) : "",
          departures: stage.runs.map((run, index) => ({
            number: index + 1,
            qty: run.cargo.reduce((sum, lot) => sum + lot.qty, 0),
            departure: days(run.departureQd - quote.plan.startQd),
            arrival: days(run.arrivalQd - quote.plan.startQd),
            price: money(run.charge.totalCopper),
            risk: transportRiskLabel(run.riskBps)
          }))
        };
      })
    } : null;

    const configuration = { ...TRANSPORT_SERVICE_DEFAULTS, ...(this._configuration ?? data.catalog?.transportV2) };
    const page = transportHistoryPage(transportOrders(holding), this._historyPage);
    const physicalRuns = new Map((data.meta?.transportV2?.runs ?? []).map((run) => [run.id, run]));
    this._historyPage = page.history.page - 1;
    const orders = page.orders.map((order) => ({
      id: order.id,
      market: visibility.marketLabel(order.commercial),
      status: statuses[order.status] || order.status,
      direction: order.direction === "outbound" ? "Продажа" : "Покупка",
      waitingReason: order.replanFailure?.message ?? "",
      cost: money(order.status === "cancelled" ? 0 : order.money.spentCopper + order.commercial.taxCopper + order.commercial.insuranceCopper),
      escrow: money(order.money.escrowCopper),
      received: order.received.reduce((sum, lot) => sum + lot.qty, 0),
      total: order.cargo.reduce((sum, lot) => sum + lot.qty, 0),
      lost: order.lostQty ?? 0,
      spoiled: order.spoiledQty ?? 0,
      insurancePaid: order.insurancePaidCopper ? money(order.insurancePaidCopper) : "",
      fundingNeeded: order.fundingNeededCopper ? money(order.fundingNeededCopper) : "",
      canFund: permissions.canUseStorage && permissions.canManageShips,
      shipStatus: order.ownShipId ? order.shipReleased ? "Корабль свободен" : order.shipArrived
        ? "Корабль прибыл; ожидает расчёта, содержание продолжается" : "Корабль занят этим заказом" : "",
      shipReturnBlocked: order.shipAbort?.returnBlocked,
      shipTiming: shipTiming(order),
      canCancel: permissions.canUseStorage && canCancelTransportOrder(data.meta?.transportV2, order, clockQd),
      cargoSummary: orderCargoSummary(order.cargo),
      cargo: (order.cargo ?? []).map((lot) => ({ name: lot.name || lot.resourceId || "Товар", qty: lot.qty })),
      stages: order.stages.map((stage) => ({
        index: stage.index, path: path(stage), count: Math.max(stage.runs.length, stage.receipts?.length ?? 0),
        price: money(stage.totalCopper), invoice: stageInvoice(stage),
        departures: transportStageSchedule(stage, physicalRuns, clockQd, { cancelled: order.status === "cancelled" })
      }))
    }));
    const incidents = permissions.isGM ? (data.meta?.transportV2?.runs ?? []).filter((run) => run.incident?.status === "pending")
      .map((run) => ({
        id: run.id, label: run.serviceLabel, orders: run.claims.length,
        awaitingCargo: [...new Set(run.claims.filter((claim) => claim.manifestReady !== true)
          .map((claim) => data.holdings.find((row) => row.id === claim.holdingId)?.name ?? claim.holdingId))].join(", "),
        delayDays: this._incidentFields?.[run.id]?.delayDays ?? 1,
        lossPercent: this._incidentFields?.[run.id]?.lossPercent ?? 100
      })) : [];
    const legacyCargo = (row) => (row.cargo ?? row.cargoReservations ?? []).map((lot) => `${lot.name || lot.resourceId || "Товар"} × ${lot.qty}`).join(" · ");
    const legacyActive = permissions.isGM ? legacyActiveMarketOrders(holding).map(({ order, direction }) => ({
      id: order.id || order.operationId,
      direction: direction === "inbound" ? "Покупка" : "Продажа",
      status: legacyStatuses[order.status] || statuses[order.status] || order.status,
      market: visibility.marketLabel(order),
      cargo: legacyCargo(order)
    })) : [];
    const archive = [
      ...(holding.special?.market?.orders ?? []).map((row) => ({ ...row, direction: "Покупка" })),
      ...(holding.special?.market?.outbound?.orders ?? []).map((row) => ({ ...row, direction: "Продажа" }))
    ].filter((row) => ["delivered", "lost", "cancelled"].includes(row.status)).slice(-40).reverse().map((row) => ({
      direction: row.direction, status: statuses[row.status],
      market: visibility.marketLabel(row), cargo: legacyCargo(row)
    }));

    const canConfirm = Boolean(quote?.affordable && permissions.canUseStorage && (!quote.ship || permissions.canManageShips) && !this._pending && !this._busy);
    const confirmBlocker = !quote?.plan || canConfirm || this._busy || this._pending ? ""
      : !quote.affordable ? `Не хватает денег в казне: сейчас ${money(holdingTreasuryCopper)}, требуется ${money(quote.treasuryCopper)} (не хватает ${money(Math.max(0, quote.treasuryCopper - holdingTreasuryCopper))}).`
        : !permissions.canUseStorage ? "Нет прав оформлять заказы склада (или в мире нет активного ГМ)."
          : quote.ship && !permissions.canManageShips ? "Нет прав отправлять собственный корабль."
            : "";

    return {
      ...base, hasHolding: true, holdingName: holding.name, isGM: permissions.isGM, canUse: permissions.canUseStorage,
      canConfirm, confirmBlocker,
      choices, selected, isOwnedMode: bundle?.activeMode === "owned",
      showShipPicker: worldShips.length > 1,
      needsShipTimeSync: Boolean(permissions.isGM && bundle?.options?.owned?.needsTimeSync),
      history: page.history, quoteError, error: this._error,
      busy: this._busy || this.constructor.inFlight.has(this._pending?.operationId),
      pending: Boolean(this._pending),
      orders, incidents, archive, legacyActive,
      hasRequest: Boolean(this.request), request: this.request,
      configuration,
      configurationView: {
        intervalDays: configuration.regularIntervalQd / 4,
        phaseDays: configuration.regularFirstQd / 4,
        commercialPercent: configuration.commercialLoadBps / 100,
        insurancePercent: configuration.insuranceBps / 100,
        profitPercent: configuration.carrierProfitBps / 100,
        coveragePercent: configuration.insuranceCoverageBps / 100
      },
      ships: worldShips
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this._listeners?.abort();
    this._listeners = new AbortController();
    this._disclosures.bind(this.element);
    this.element.addEventListener("change", (event) => {
      if (this._busy || this._pending) return;
      const field = event.target.closest("[data-transport-field], [data-transport-config], [data-transport-incident-field]");
      if (!field) return;
      if (field.dataset.transportIncidentField && this._view.permissions.isGM) {
        const runId = field.closest("[data-transport-incident]").dataset.transportIncident;
        this._incidentFields ??= {};
        this._incidentFields[runId] ??= {};
        this._incidentFields[runId][field.dataset.transportIncidentField] = Number(field.value);
      } else if (field.dataset.transportConfig && this._view.permissions.isGM) {
        this._configuration = {
          ...(this._configuration ?? this._view.data.catalog?.transportV2 ?? TRANSPORT_SERVICE_DEFAULTS),
          [field.dataset.transportConfig]: Math.round(Number(field.value) * Number(field.dataset.scale ?? 1))
        };
      } else if (this.request && field.dataset.transportField) {
        const key = field.dataset.transportField;
        this.request[key] = field.type === "checkbox" ? field.checked : field.type === "number" ? Number(field.value) : field.value;
        if (key === "ownShipId" && this.request.ownShipId) this.request.mode = "owned";
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
      if (action === "transport-select-mode") {
        if (!this.request || this._pending) return;
        const mode = target.dataset.mode;
        if (!["regular", "charter", "owned"].includes(mode)) return;
        this.request.mode = mode;
        this.request.priority = mode === "charter" ? "time" : "cost";
        if (mode === "owned") {
          this.request.ownShipId = this.request.ownShipId || this._view?.bundle?.chosenShip?.id || "";
        } else {
          this.request.ownShipId = "";
        }
        return this.requestRender({ focus: false });
      }
      if (action === "transport-history-previous" || action === "transport-history-next") {
        this._historyPage = Math.max(0, (this._historyPage ?? 0) + (action === "transport-history-next" ? 1 : -1));
        return this.requestRender({ focus: false });
      }
      if (action === "transport-retry") return await this._submit();
      if (this._pending) throw new Error("Сначала получите результат предыдущей операции кнопкой «Проверить повторно».");
      const { data, holding, quote, bundle, sourceToken } = this._view;
      const type = action === "transport-confirm" ? "transport-book" : action.startsWith("transport-incident-") ? "transport-incident" : action;
      const op = { type, operationId: makeId("transport", 20), holdingId: holding.id, expectedRevision: data.meta.revision, sourceToken };
      if (type === "transport-book") {
        if (!quote?.affordable) throw new Error("Проверьте расчёт и деньги в казне.");
        op.request = {
          ...structuredClone(this.request),
          mode: bundle?.activeMode ?? this.request.mode,
          ownShipId: bundle?.activeMode === "owned" ? (quote.ship?.id ?? this.request.ownShipId ?? "") : ""
        };
        op.planToken = quote.planToken;
      }
      if (type === "transport-cancel") op.orderId = target.dataset.order;
      if (type === "transport-fund") op.orderId = target.dataset.order;
      if (type === "transport-ship-sync") op.shipId = bundle?.chosenShip?.id || this.request?.ownShipId || "";
      if (type === "transport-configure") op.configuration = this._configuration ?? data.catalog?.transportV2 ?? { ...TRANSPORT_SERVICE_DEFAULTS };
      if (type === "transport-incident") {
        op.runId = target.dataset.run;
        op.resolution = {
          outcome: action.split("-").at(-1),
          delayQd: (this._incidentFields?.[op.runId]?.delayDays ?? 1) * 4,
          lossBps: Math.round((this._incidentFields?.[op.runId]?.lossPercent ?? 100) * 100)
        };
      }
      this._pending = op;
      this.constructor.sessions.set(this.holdingId, op);
      await this._submit();
    } catch (error) {
      this._error = error?.message || String(error) || "Не удалось выполнить транспортную операцию.";
      if (globalThis.ui?.notifications) {
        console.error("FBL Skyhold | Transport action failed:", error);
        globalThis.ui.notifications.error?.(this._error);
      }
      if (!["timeout", "authority-offline", "socket-unavailable"].includes(error?.code) && !error?.retryable) {
        this._pending = null;
        this.constructor.sessions.delete(this.holdingId);
      }
      this.requestRender({ focus: false });
      this.constructor.rerenderOpen();
    }
  }

  async _submit() {
    if (!this._pending) return;
    const operation = this._pending;
    if (this.constructor.inFlight.has(operation.operationId)) return;
    this.constructor.inFlight.add(operation.operationId);
    this._busy = true;
    this.requestRender({ focus: false });
    try {
      const result = await requestMarketOperation(operation);
      if (!result?.ok) throw new Error("Транспортная операция не подтверждена.");
      if (operation.type === "transport-book") {
        this.request = null;
        this._bundleCache = null;
        const reopened = this.constructor.instances.get(this.holdingId);
        if (reopened) {
          reopened.request = null;
          reopened._bundleCache = null;
        }
        globalThis.ui?.notifications?.info?.("Заказ перевозки оформлен.");
      }
      this._pending = null;
      this.constructor.sessions.delete(this.holdingId);
      requestSkyholdAppRender();
      this.requestRender({ focus: false });
      this.constructor.rerenderOpen();
    } finally {
      this.constructor.inFlight.delete(operation.operationId);
      this._busy = false;
      this.requestRender({ focus: false });
      this.constructor.rerenderOpen();
    }
  }

  async close(options) {
    this._listeners?.abort();
    this._disclosures.close();
    if (this.constructor.instances.get(this.holdingId) === this) this.constructor.instances.delete(this.holdingId);
    return super.close(options);
  }
}
