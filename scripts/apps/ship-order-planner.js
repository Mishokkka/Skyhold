import { MODULE_ID } from "../data/constants.js";
import { findReadableHoldingEntry } from "../data/access-guard.js";
import { holdingPermissionContext } from "../data/holding-permissions.js";
import { parseShipGoldInput } from "../core/ship-gold.js";
import { previewShipOrders, withShipOrderBudget } from "../engines/ships/order-preview.js";
import { shipRouteMapContext, bindRouteMapView } from "./common/route-map-view.js";
import { buildShipWorldContext } from "../engines/ships/world-market.js";

const TEMPLATE = `modules/${MODULE_ID}/templates/parts/ship-window/order-preview.hbs`;

/** An ephemeral draft belongs to this window, never to the ship or world settings. */
export class ShipOrderPlanner {
  constructor({ holdingId, shipId, getData, onPreviewRendered }) {
    Object.assign(this, { holdingId, shipId, getData, onPreviewRendered });
    this.selected = new Set();
    this.viewport = {};
    this.mapOpen = false;
  }

  clear() { this.selected.clear(); this.cache = null; this.focusedOfferIds = ""; }

  bind(root, signal) {
    this.mapController?.abort();
    this.root = root;
    this.signal = signal;
    const output = root.querySelector?.("[data-ship-planner-preview]");
    if (!output) return;
    for (const field of root.querySelectorAll("[data-ship-bundle-select]")) field.checked = this.selected.has(field.value);
    root.addEventListener("change", (event) => {
      const field = event.target;
      if (field.matches?.("[data-ship-bundle-select]")) {
        if (field.checked) this.selected.add(field.value);
        else this.selected.delete(field.value);
        this.update();
      } else if (field.matches?.("[data-ship-bundle-style]")) this.update();
    }, { signal });
    root.addEventListener("input", (event) => {
      if (event.target.matches?.("[data-ship-bundle-budget]")) this.update();
    }, { signal });
    root.addEventListener("click", (event) => {
      const mapToggle = event.target.closest?.("[data-ship-planner-map-toggle]");
      if (mapToggle) this.toggleMap();
      if (event.target.closest?.("[data-ship-planner-clear]")) {
        this.clear();
        for (const field of root.querySelectorAll("[data-ship-bundle-select]")) field.checked = false;
        this.update();
      }
      const focus = event.target.closest?.("[data-ship-planner-focus]");
      if (focus) this.highlight(focus.dataset.shipPlannerFocus);
    }, { signal });
    this.update();
  }

  parameters() {
    const budget = this.root.querySelector("[data-ship-bundle-budget]");
    if (budget?.validity?.badInput) throw new Error("Укажите бюджет числом в ЗМ или полностью очистите поле для автоматического расчёта.");
    const value = String(budget?.value ?? "").trim();
    return { offerIds: [...this.selected], style: this.root.querySelector("[data-ship-bundle-style]")?.value ?? "normal",
      budgetCopper: value ? parseShipGoldInput(value) : null };
  }

  calculate() {
    const data = this.getData();
    const { holding } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
    if (!holding) throw new Error("Владение недоступно.");
    const ship = holding.special?.ships?.list?.find((row) => row.id === this.shipId);
    const parameters = this.parameters();
    const key = JSON.stringify([data.meta?.revision, parameters]);
    const routeKey = JSON.stringify([data.meta?.revision, parameters.offerIds, parameters.style]);
    if (!this.cache || this.cache.data !== data || this.cache.routeKey !== routeKey) {
      const basePlan = previewShipOrders(data, holding, ship, { ...parameters, budgetCopper: null });
      this.cache = { data, routeKey, basePlan, map: shipRouteMapContext(basePlan, data.catalog?.marketRouteMap) };
    }
    const permissions = holdingPermissionContext(holding);
    return { ...this.cache, key, plan: withShipOrderBudget(this.cache.basePlan, parameters.budgetCopper),
      permissions, parameters, revision: Number(data.meta?.revision ?? 0) };
  }

  update() {
    const root = this.root;
    const output = root?.querySelector?.("[data-ship-planner-preview]");
    if (!output) return;
    this.mapController?.abort();
    const active = globalThis.document?.activeElement;
    const restoreClear = output.contains?.(active) && active?.hasAttribute?.("data-ship-planner-clear");
    const disclosures = new Map([...output.querySelectorAll("details")].map((node) => [node.dataset.shipPlanDetails ?? "budget", node.open]));
    const restoreMapToggle = output.contains?.(active) && active?.hasAttribute?.("data-ship-planner-map-toggle");
    const context = { selectedCount: this.selected.size, mapOpen: this.mapOpen, mapPanelId: `ship-route-map-${this.holdingId}-${this.shipId}` };
    this.reviewed = null;
    for (const field of root.querySelectorAll("[data-ship-bundle-select]")) {
      field.disabled = !field.checked && this.selected.size >= 3;
      field.closest("[data-ship-order-choice]")?.classList.toggle("is-selected", field.checked);
    }
    if (this.selected.size) {
      try {
        const result = this.calculate();
        const { plan, permissions } = result;
        const numbers = new Map(plan.offers.map((offer, index) => [offer.id, index + 1]));
        Object.assign(context, plan, { map: result.map, hasPlan: true, revision: result.revision,
          durationDays: plan.totalDurationQd / 4, flightDays: plan.flightQd / 4, portDays: plan.portQd / 4,
          canDepart: plan.canDepart && permissions.canManageShips,
          permissionReason: permissions.canManageShips ? "" : permissions.mayManageShips ? "Для отправления нужен активный ГМ." : "Доступен просмотр плана; управление кораблём не разрешено.",
          orders: plan.offers.map((offer) => ({ id: offer.id, focusIds: JSON.stringify([offer.id]), number: numbers.get(offer.id), title: offer.title,
            route: `${(offer.contract.pickup ?? offer.from).label} → ${offer.to.label}` })),
          stops: plan.stops.map((stop, index) => ({ ...stop, number: index,
            pickupText: stop.pickupOfferIds.map((id) => `№${numbers.get(id)}`).join(", "),
            deliveryText: stop.deliveryOfferIds.map((id) => `№${numbers.get(id)}`).join(", "),
            offerIds: JSON.stringify([...stop.pickupOfferIds, ...stop.deliveryOfferIds]) })),
          legs: plan.legs.map((leg, index) => ({ ...leg, number: index + 1, flightDays: leg.flightQd / 4,
            hasCosts: leg.operatingCopper != null, durationDays: leg.durationQd / 4,
            cargoText: leg.offerIds.map((id) => `№${numbers.get(id)}`).join(", ") || "Порожний подход" })) });
        this.reviewed = result;
      } catch (error) { context.error = error.message || "Не удалось рассчитать рейс."; }
    } else {
      try {
        const data = this.getData();
        const { holding } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
        if (!holding) throw new Error("Владение недоступно.");
        const ship = holding.special?.ships?.list?.find((row) => row.id === this.shipId);
        if (!ship) throw new Error("Корабль больше не найден.");
        if (this.overviewCache?.data !== data || this.overviewCache?.revision !== data.meta?.revision) {
          const world = buildShipWorldContext(data, holding, { offerLocationIds: [] });
          const origin = ship.location?.kind === "home" ? world.home : ship.location;
          const map = shipRouteMapContext({ world, origin, finalPoint: origin, overview: true,
            stops: [{ point: origin }], legs: [] }, data.catalog?.marketRouteMap);
          this.overviewCache = { data, revision: data.meta?.revision, map, origin };
        }
        context.map = this.overviewCache.map;
        context.locationLabel = this.overviewCache.origin?.label;
      } catch (error) { context.error = error.message || "Карта недоступна."; }
    }
    const render = globalThis.Handlebars?.partials?.[TEMPLATE];
    const status = root.querySelector("[data-ship-planner-status]");
    if (status) status.textContent = context.error ? "Проверьте план" : context.hasPlan
      ? `Выбрано: ${context.selectedCount} / 3` : "Выберите 1–3 заказа";
    const departure = root.querySelector("[data-ship-planned]");
    if (departure) {
      departure.disabled = !context.hasPlan || !context.canDepart || typeof render !== "function";
      departure.dataset.action = context.isBundle ? "ship-depart-bundle" : "ship-depart-world";
      departure.dataset.shipRevision = String(context.revision ?? "");
    }
    if (typeof render !== "function") {
      output.textContent = "Предпросмотр недоступен: закройте и снова откройте окно корабля.";
      this.onPreviewRendered?.(root);
      this.reviewed = null;
      return;
    }
    output.innerHTML = render(context);
    this.onPreviewRendered?.(root);
    for (const node of output.querySelectorAll("details")) node.open = disclosures.get(node.dataset.shipPlanDetails ?? "budget") ?? false;
    if (context.map) {
      this.mapController = new AbortController();
      bindRouteMapView(output, context.map, this.viewport, this.mapController.signal);
    }
    this.highlight(this.focusedOfferIds ?? "");
    if (restoreClear) (output.querySelector("[data-ship-planner-clear]") ?? root.querySelector("[data-ship-bundle-select]"))?.focus({ preventScroll: true });
    if (restoreMapToggle) output.querySelector("[data-ship-planner-map-toggle]")?.focus({ preventScroll: true });
  }

  toggleMap() {
    const panel = this.root?.querySelector?.("[data-ship-planner-map]");
    const button = this.root?.querySelector?.("[data-ship-planner-map-toggle]");
    if (!panel || !button) return;
    this.mapOpen = !this.mapOpen;
    panel.hidden = !this.mapOpen;
    button.setAttribute("aria-expanded", String(this.mapOpen));
  }

  highlight(value) {
    this.focusedOfferIds = value;
    const ids = new Set(value ? JSON.parse(value) : []);
    for (const line of this.root.querySelectorAll("[data-route-offers]")) {
      const match = JSON.parse(line.dataset.routeOffers).some((id) => ids.has(id));
      line.classList.toggle("is-highlighted", match);
    }
    for (const button of this.root.querySelectorAll("[data-ship-planner-focus]")) {
      button.setAttribute("aria-pressed", String(Boolean(value) && button.dataset.shipPlannerFocus === value));
    }
  }

  /** Reject stale displayed quotes before the existing command/revision protocol is invoked. */
  assertReviewed() {
    const shown = this.reviewed;
    const current = this.calculate();
    if (!shown || shown.data !== current.data || shown.key !== current.key) {
      this.update();
      throw new Error("Данные изменились. Проверьте обновлённый план и повторите отправление.");
    }
    if (!current.permissions.canManageShips || !current.plan.canDepart) throw new Error("Отправление недоступно. Проверьте причины в плане рейса.");
    return current;
  }

  close() { this.mapController?.abort(); this.root = null; this.cache = null; this.overviewCache = null; }
}
