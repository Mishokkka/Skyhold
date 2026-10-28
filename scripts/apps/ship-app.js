import { MODULE_ID } from "../data/constants.js";
import { SkyholdData } from "../data/store.js";
import { findReadableHoldingEntry } from "../data/access-guard.js";
import { fieldValue } from "../core/helpers.js";
import { bindGlobalInputGuard, bindInputGuards, unbindGlobalInputGuard } from "../utils/input-guards.js";
import { RenderSchedulerMixin } from "./common/render-scheduler.js";
import { focusApplicationContent } from "./common/window-focus-keeper.js";
import { dispatchDelegatedAction } from "./common/delegated-events.js";
import { requestSkyholdAppRender } from "./registry.js";
import { prepareShipWindowContext } from "./ships-context.js";
import { createShipViewState } from "./ships-view-state.js";
import { ShipEventDomain } from "./domains/events/ship-events.js";
import { bindFloatingTooltips, hideFloatingTooltip } from "./common/floating-tooltip.js";
import { WindowFrameMixin } from "./common/window-frame.js";
import { configureWorldShipEconomy } from "../engines/ships/world-market.js";
import { formatShipGold, parseShipGoldInput, shipGoldInput } from "../core/ship-gold.js";
import { ShipOrderPlanner } from "./ship-order-planner.js";
import { shipHomeLocationContext } from "./domains/ship-home-location.js";
import { placeShipHome } from "./domains/events/ship-home-events.js";
import { navigateFromShip } from "./domains/ship-navigation.js";
import { tabKeyTarget } from "./common/tab-navigation.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
globalThis.Handlebars?.registerHelper?.("fblsShipGold", (copper) => formatShipGold(copper));
globalThis.Handlebars?.registerHelper?.("fblsShipGoldInput", (copper) => shipGoldInput(copper));
const SHIP_OPERATIONS = new Set([
  "ship-delete", "ship-adopt", "ship-install-magnifique-crew", "ship-save-crew",
  "ship-generate-world", "ship-reroll-world", "ship-depart-world", "ship-depart-bundle", "ship-continue-bundle", "ship-resolve-bundle", "ship-return-home", "ship-relocate-world",
  "ship-resolve-world", "ship-depart", "ship-adjust", "ship-generate-offers", "ship-resolve"
]);
const SHIP_FIELDS = new Set([
  "name", "commanderName", "homeUpkeepEnabled", "speedKmPerDay", "capacityLoadPoints", "hiddenCapacityLoadPoints", "routePlan.destination", "routePlan.distanceKm",
  "routePlan.portDays", "routePlan.preparationCopper", "routePlan.upkeepPerDayCopper", "routePlan.rewardCopper"
]);

function keyFor(holdingId, shipId) {
  return `${String(holdingId ?? "")}\u0000${String(shipId ?? "")}`;
}

export class SkyholdShipApp extends WindowFrameMixin(RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2))) {
  static instances = new Map();

  static open({ holdingId = "", shipId = "" } = {}) {
    const key = keyFor(holdingId, shipId);
    const existing = this.instances.get(key);
    if (existing) {
      existing.render({ force: true, focus: true });
      return existing;
    }
    const app = new this({ holdingId, shipId });
    this.instances.set(key, app);
    app.render({ force: true, focus: true }).then(() => {
      const root = app.element;
      if (!root) return;
      // ApplicationV2 positions the first frame after _onRender. Apply only
      // dimensions here so the frame mixin cannot preserve an intrinsic size.
      const { width, height } = app.options?.position ?? this.DEFAULT_OPTIONS.position;
      app.setPosition({ width, height });
      app._bindWindowFrameSync(root);
    }).catch((error) => {
      if (this.instances.get(key) === app) this.instances.delete(key);
      console.error("FBL Skyhold | Failed to open ship window", error);
      globalThis.ui?.notifications?.error?.("Не удалось открыть корабль.");
    });
    return app;
  }

  static rerenderOpen({ skipFocused = true } = {}) {
    for (const app of this.instances.values()) {
      const root = app.element;
      if (skipFocused && root && globalThis.document?.activeElement && root.contains(globalThis.document.activeElement)) continue;
      app.requestRender({ focus: false });
    }
  }

  constructor({ holdingId = "", shipId = "" } = {}, options = {}) {
    super(options);
    this.holdingId = String(holdingId ?? "");
    this.shipId = String(shipId ?? "");
    this.crewSearch = "";
    this.orderSearch = "";
    this.rosterSearch = "";
    this.activeShipPanel = "orders";
    this._shipViewState = createShipViewState();
    this._shipPlanner = new ShipOrderPlanner({ holdingId: this.holdingId, shipId: this.shipId, getData: () => SkyholdData.view(),
      onPreviewRendered: (root) => bindFloatingTooltips(this, root, { signal: this._shipAbortController?.signal }) });
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const data = SkyholdData.view();
    const { holding, index: holdingIndex } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
    const ship = (holding?.special?.ships?.list ?? []).find((row) => String(row?.id ?? "") === this.shipId);
    const shipsContext = holding && ship
      ? prepareShipWindowContext(holding, { revision: Number(data?.meta?.revision ?? 0), data, shipId: this.shipId })
      : null;
    const shipWindowTabs = [
      { id: "orders", label: "Рейсы", icon: "fa-solid fa-compass" },
      { id: "crew", label: "Экипаж", icon: "fa-solid fa-users" },
      { id: "finance", label: "Финансы", icon: "fa-solid fa-coins" },
      ...(shipsContext?.canCreateProfile ? [{ id: "settings", label: "Настройки", icon: "fa-solid fa-sliders" }] : [])
    ];
    if (!shipWindowTabs.some((tab) => tab.id === this.activeShipPanel)) this.activeShipPanel = "orders";
    let shipHome = null;
    if (holding && shipsContext?.canCreateProfile) {
      try { shipHome = shipHomeLocationContext(data, holding); }
      catch (error) { shipHome = { blocker: error.message }; }
    }
    return {
      ...context,
      holding,
      holdingIndex,
      shipsContext,
      shipHome,
      shipWindowTabs: shipWindowTabs.map((tab) => ({ ...tab, active: tab.id === this.activeShipPanel })),
      shipPanels: Object.fromEntries(shipWindowTabs.map((tab) => [tab.id, tab.id === this.activeShipPanel])),
      hasShip: Boolean(holding && ship),
      error: !holding ? "Владение недоступно." : "Корабль больше не найден."
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    bindInputGuards(root);
    // The intrinsic first frame may be only the title bar; open() binds it
    // after Foundry finishes positioning instead of remembering that size.
    if (!options?.isFirstRender) this._bindWindowFrameSync(root);
    bindGlobalInputGuard(this, root);
    this._shipViewState.bind(root);
    this._shipAbortController?.abort?.();
    const controller = new AbortController();
    this._shipAbortController = controller;
    const listener = { signal: controller.signal };
    bindFloatingTooltips(this, root, listener);
    this._shipPlanner.bind(root, controller.signal);
    root.addEventListener("keydown", (event) => this._onShipTabKey(event, root), listener);

    root.addEventListener("click", (event) => {
      const button = event.target?.closest?.("[data-action]");
      if (button && root.contains(button) && button.dataset.action === "ship-open-transport") {
        event.preventDefault();
        dispatchDelegatedAction(this, event, button,
          () => import("./lazy-apps.js").then(({ openTransportApp }) => openTransportApp({ holdingId: this.holdingId })));
        return;
      }
      if (button && root.contains(button) && button.dataset.action === "ship-place-home") {
        dispatchDelegatedAction(this, event, button, (delegated) => placeShipHome(this, delegated));
        return;
      }
      if (button && root.contains(button) && button.dataset.action === "ship-window-tab") {
        event.preventDefault();
        this._selectShipPanel(button.dataset.shipWindowTab ?? button.dataset.shipPanelTarget, root);
        return;
      }
      if (button && root.contains(button) && ["ship-open-sale", "ship-open-market", "ship-open-resident"].includes(button.dataset.action)) {
        dispatchDelegatedAction(this, event, button, (delegated) => navigateFromShip(this, delegated));
        return;
      }
      if (!button || !root.contains(button) || !SHIP_OPERATIONS.has(String(button.dataset.action ?? ""))) return;
      dispatchDelegatedAction(this, event, button, "_onShipOperation");
    }, listener);
    root.addEventListener("change", (event) => {
      const field = event.target;
      if (field?.matches?.("[data-field]")) dispatchDelegatedAction(this, event, field, "_onShipFieldChange");
      if (field?.matches?.("[data-ship-crew]")) this._syncCrewPicker(root);
    }, listener);
    root.addEventListener("input", (event) => {
      const listSearch = event.target?.closest?.("[data-ship-order-search], [data-ship-roster-search]");
      if (listSearch) {
        const kind = listSearch.hasAttribute("data-ship-order-search") ? "order" : "roster";
        this[`${kind}Search`] = String(listSearch.value ?? "");
        this._filterShipRows(kind, root);
        return;
      }
      const search = event.target?.closest?.("[data-ship-crew-search]");
      if (!search) return;
      this.crewSearch = String(search.value ?? "");
      this._filterCrewPicker(root);
    }, listener);
    const search = root.querySelector("[data-ship-crew-search]");
    if (search) search.value = this.crewSearch;
    this._filterCrewPicker(root);
    this._syncCrewPicker(root);
    for (const kind of ["order", "roster"]) {
      const field = root.querySelector(`[data-ship-${kind}-search]`);
      if (field) field.value = this[`${kind}Search`];
      this._filterShipRows(kind, root);
    }
    focusApplicationContent(this, { root, options, preferredSelector: "[data-ship-window-tab][aria-pressed='true']" });
  }

  _selectShipPanel(panelId, root = this.element) {
    const panels = [...(root?.querySelectorAll?.("[data-ship-panel]") ?? [])];
    if (!panels.some((panel) => panel.dataset.shipPanel === panelId)) return false;
    this.activeShipPanel = panelId;
    hideFloatingTooltip(this);
    for (const panel of panels) panel.hidden = panel.dataset.shipPanel !== panelId;
    for (const button of root.querySelectorAll("[data-ship-window-tab]")) {
      const selected = button.dataset.shipWindowTab === panelId;
      button.setAttribute("aria-pressed", String(selected));
      button.classList.toggle("active", selected);
      button.tabIndex = selected ? 0 : -1;
    }
    return true;
  }

  _onShipTabKey(event, root = this.element) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const tab = event.target?.closest?.("[data-ship-window-tab]");
    if (!tab || !root?.contains(tab)) return;
    const tabs = [...root.querySelectorAll("[data-ship-window-tab]")].filter((button) => !button.disabled && !button.hidden);
    const index = tabKeyTarget(event.key, tabs.indexOf(tab), tabs.length);
    if (index === null) return;
    event.preventDefault();
    tabs[index].focus({ preventScroll: true });
    tabs[index].click();
  }

  _filterCrewPicker(root = this.element) {
    const query = this.crewSearch.trim().toLocaleLowerCase("ru");
    for (const row of root?.querySelectorAll?.("[data-ship-crew-option]") ?? []) {
      row.hidden = Boolean(query && !String(row.dataset.shipCrewSearchText ?? "").includes(query));
    }
    const empty = root?.querySelector?.("[data-ship-crew-empty]");
    if (empty) empty.hidden = [...root.querySelectorAll("[data-ship-crew-option]")].some((row) => !row.hidden);
  }

  _filterShipRows(kind, root = this.element) {
    const normalize = value => String(value ?? "").toLocaleLowerCase("ru").replace(/ё/g, "е");
    const query = normalize(this[`${kind}Search`]).trim();
    const rows = [...(root?.querySelectorAll?.(`[data-ship-${kind}-search-text]`) ?? [])];
    for (const row of rows) row.hidden = Boolean(query && !normalize(row.getAttribute(`data-ship-${kind}-search-text`)).includes(query));
    const empty = root?.querySelector?.(`[data-ship-${kind}-empty]`);
    if (empty) empty.hidden = !rows.length || rows.some(row => !row.hidden);
  }

  _syncCrewPicker(root = this.element) {
    const controls = [...(root?.querySelectorAll?.("[data-ship-crew]") ?? [])];
    const count = controls.filter((field) => field.checked).length;
    const label = root?.querySelector?.("[data-ship-crew-count]");
    if (label) label.textContent = `Выбрано: ${count}`;
    for (const field of controls) {
      const choice = field.closest?.("[data-ship-crew-option]")?.querySelector?.("[data-ship-crew-choice]");
      if (!choice) continue;
      choice.textContent = field.checked ? choice.dataset.removeLabel : choice.dataset.addLabel;
    }
  }

  async _onShipFieldChange(event) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    const field = event.currentTarget;
    const rawPath = String(field?.dataset?.field ?? "");
    const marker = ".special.ships.list.";
    const markerIndex = rawPath.indexOf(marker);
    const tail = markerIndex >= 0 ? rawPath.slice(markerIndex + marker.length).replace(/^\d+\./, "") : "";
    if (!SHIP_FIELDS.has(tail)) return;
    const revision = Number(field.closest?.("[data-ship-card]")?.dataset?.shipRevision);
    try {
      const value = tail.endsWith("Copper") ? parseShipGoldInput(field.value) : fieldValue(field);
      if (!Number.isSafeInteger(revision)) throw new Error("Обновите окно корабля перед изменением настроек.");
      if (tail === "homeUpkeepEnabled" && typeof value !== "boolean") throw new Error("Некорректное значение галочки содержания.");
      if (!["name", "commanderName", "routePlan.destination", "homeUpkeepEnabled"].includes(tail)
        && (!Number.isFinite(value) || value < (tail === "speedKmPerDay" ? 1 : 0))) throw new Error("Некорректное числовое значение.");
      if (["speedKmPerDay", "capacityLoadPoints", "hiddenCapacityLoadPoints"].includes(tail)
        && (!Number.isSafeInteger(value) || value < (tail === "hiddenCapacityLoadPoints" ? 0 : 1)
          || value > (tail === "speedKmPerDay" ? 10_000 : 1_000_000))) throw new Error("Некорректное значение параметра корабля.");
      await SkyholdData.transaction((data) => {
        if (Number(data.meta?.revision) !== revision) throw new Error("Данные изменились. Проверьте настройки в обновлённом окне и повторите правку.");
        const holding = data.holdings?.find((row) => String(row?.id ?? "") === this.holdingId);
        const ship = holding?.special?.ships?.list?.find((row) => String(row?.id ?? "") === this.shipId);
        if (!ship) throw new Error("Корабль больше не найден.");
        if ((ship.activeVoyage || ship.orderBundle || ship.transportOrderId) && tail !== "homeUpkeepEnabled") throw new Error("Настройки нельзя менять во время активного рейса.");
        if (tail === "homeUpkeepEnabled" && ship.navigationMode !== "world") throw new Error("Подключите корабль к мировому рынку.");
        if (["speedKmPerDay", "capacityLoadPoints", "hiddenCapacityLoadPoints"].includes(tail)
          && (ship.location?.kind !== "home" || ship.status !== "docked")) throw new Error("Параметры корабля меняются только дома между рейсами.");
        if (tail === "hiddenCapacityLoadPoints" && value > Number(ship.capacityLoadPoints ?? 0)) throw new Error("Тайники не могут превышать вместимость трюма.");
        if (tail === "capacityLoadPoints" && value < Number(ship.hiddenCapacityLoadPoints ?? 0)) throw new Error("Вместимость не может быть меньше размера тайников.");
        foundry.utils.setProperty(ship, tail, value);
        if (tail === "homeUpkeepEnabled") configureWorldShipEconomy(data, holding, ship);
        return true;
      }, { reason: `ship-window:field:${tail}`, scope: "holdings" });
      requestSkyholdAppRender();
    } catch (error) {
      globalThis.ui?.notifications?.error?.(error.message || "Не удалось сохранить настройки корабля.");
    } finally {
      this.requestRender({ focus: false });
    }
  }

  async _onClose(options) {
    this._unbindWindowFrameSync();
    await super._onClose(options);
    this._shipAbortController?.abort?.();
    unbindGlobalInputGuard(this);
    this._shipPlanner.close();
    hideFloatingTooltip(this);
    SkyholdShipApp.instances.delete(keyFor(this.holdingId, this.shipId));
    requestSkyholdAppRender({ deferForActiveWindow: false });
  }
}

Object.assign(SkyholdShipApp.prototype, ShipEventDomain);

SkyholdShipApp.DEFAULT_OPTIONS = {
  classes: ["fbl-skyhold", "fbl-skyhold-ship"],
  tag: "section",
  window: { title: "Корабль", icon: "fa-solid fa-ship", resizable: true },
  position: { width: 880, height: 680 }
};

SkyholdShipApp.PARTS = {
  body: { template: `modules/${MODULE_ID}/templates/ship-app.hbs` }
};
