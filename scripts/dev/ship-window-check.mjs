import assert from "node:assert/strict";
import { prepareShipsContext, prepareShipWindowContext } from "../apps/ships-context.js";
import { createShipViewState } from "../apps/ships-view-state.js";
import { shipOperationIntent } from "../apps/domains/events/ship-events.js";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { SkyholdData } from "../data/store.js";

globalThis.game = { user: { id: "gm", isGM: true } };
let { data, holding, ship } = worldMarketFixture();
holding.visibility = "public";
const blockedMarket = { catalog: { get marketEconomy() { throw new Error("overview touched market inventory"); } } };
const overview = prepareShipsContext(holding, { data: blockedMarket });
assert.equal(overview.detailMode, false);
assert.equal(overview.rows.length, 1);
assert.equal(overview.rows[0].offers, undefined);
assert.equal(overview.rows[0].crewOptions, undefined);
assert.equal(overview.rows[0].outingReport, undefined);
holding.people.list.push({ id: "other-sailor", name: "Другой матрос" }, { id: "dead", name: "Погибший", dead: true });
ship.crewResidentIds.push("dead");
holding.special.ships.list.push({ id: "other", crewResidentIds: ["other-sailor"], navigationMode: "world", location: { kind: "home" } });
const detail = prepareShipWindowContext(holding, { data, shipId: ship.id });
assert.equal(detail.rows.length, 1, "one window must only prepare its selected ship");
assert.equal(detail.rows[0].crewOptions.find((row) => row.id === "other-sailor").disabled, true);
assert.equal(detail.rows[0].crewOptions.find((row) => row.id === "dead").disabled, false, "a selected dead member must remain explicitly removable");
assert.deepEqual(shipOperationIntent({ type: "reroll-world", holding, ship, button: { closest: () => null } }), {
  type: "reroll-world", holdingId: holding.id, shipId: ship.id, locationKind: "home", locationId: holding.id
});

const viewState = createShipViewState();
function checkboxRoot(checked) {
  const listeners = {};
  const input = { type: "checkbox", checked, value: "sailor", dataset: { shipDraft: "resident-sailor" }, closest: (selector) =>
    selector === "[data-ship-draft]" ? input : selector === "[data-ship-draft-scope]" ? { dataset: { shipDraftScope: `crew:${ship.id}` } } : { dataset: { shipHoldingRoot: holding.id } } };
  return { input, listeners, querySelectorAll: (selector) => selector === "[data-ship-draft]" ? [input] : [], addEventListener: (type, fn) => { listeners[type] = fn; } };
}
const first = checkboxRoot(false);
viewState.bind(first); first.input.checked = true; first.listeners.change({ target: first.input });
const rerender = checkboxRoot(false); viewState.bind(rerender);
assert.equal(rerender.input.checked, true, "checkbox state survives a refresh");
viewState.clearOperation({ type: "crew", holdingId: holding.id, shipId: ship.id });
const saved = checkboxRoot(false); viewState.bind(saved);
assert.equal(saved.input.checked, false, "after save the authoritative roster wins");

// Reproduce ApplicationV2's opening order: an intrinsic frame is inserted,
// _onRender runs, and only then is the shared position object applied.
class OpeningApplication {
  constructor() {
    this.position = { left: 100, top: 100, ...this.constructor.DEFAULT_OPTIONS.position };
    this.bounds = { left: 0, top: 0, width: 180, height: 32 };
    this.element = {
      querySelectorAll: () => [], querySelector: () => null,
      addEventListener() {}, removeEventListener() {},
      getBoundingClientRect: () => ({ ...this.bounds })
    };
  }
  async _prepareContext() { return {}; }
  async _onRender() {}
  setPosition(position) {
    Object.assign(this.position, position);
    Object.assign(this.bounds, this.position);
    return this.position;
  }
  render(options) {
    this.lastRender = (async () => {
      options.isFirstRender = !this.rendered;
      if (options.isFirstRender) options.position = this.position;
      this.rendered = true;
      await this._onRender({}, options);
      if (options.position) this.setPosition(options.position);
      return this;
    })();
    return this.lastRender;
  }
}
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.foundry = { applications: { api: { ApplicationV2: OpeningApplication, HandlebarsApplicationMixin: (Base) => Base } },
  utils: { setProperty: (object, key, value) => { object[key] = value; } } };
const shipHelpers = new Map();
globalThis.Handlebars = { registerHelper: (name, helper) => shipHelpers.set(name, helper) };
const { SkyholdShipApp } = await import("../apps/ship-app.js");
assert.equal(shipHelpers.get("fblsShipGold")(1234), "12,34");
assert.equal(shipHelpers.get("fblsShipGoldInput")(1234), "12.34");
for (const isGM of [true, false]) {
  game.user.isGM = isGM;
  const opening = SkyholdShipApp.open({ holdingId: `opening-${isGM}`, shipId: ship.id });
  await opening.lastRender;
  assert.equal(opening.bounds.width, 880, "initial intrinsic header width must not replace ship window width");
  assert.equal(opening.bounds.height, 680, "initial intrinsic header height must not replace ship window height");
  opening.setPosition({ width: 740, height: 560 });
  opening._syncWindowFrameState();
  opening.setPosition({ left: 210, top: 150 });
  SkyholdShipApp.open({ holdingId: `opening-${isGM}`, shipId: ship.id });
  await opening.lastRender;
  assert.equal(opening.bounds.width, 740, "reopening an existing window preserves the user's size");
  assert.equal(opening.bounds.height, 560);
  assert.equal(opening.bounds.left, 210);
  opening._unbindWindowFrameSync();
}
SkyholdShipApp.instances.clear();
game.user.isGM = true;
const app = new SkyholdShipApp({ holdingId: holding.id, shipId: ship.id });
const panels = ["orders", "crew", "finance", "settings"].map((id) => ({ dataset: { shipPanel: id }, hidden: id !== "orders", scrollTop: 37 }));
const tabButtons = panels.map((panel) => ({ dataset: { shipWindowTab: panel.dataset.shipPanel }, classList: { toggle() {} }, setAttribute(key, value) { this[key] = value; } }));
const panelRoot = { querySelectorAll: (selector) => selector === "[data-ship-panel]" ? panels : tabButtons };
assert.equal(app._selectShipPanel("crew", panelRoot), true);
assert.equal(app.activeShipPanel, "crew");
assert.deepEqual(panels.map((panel) => panel.hidden), [true, false, true, true]);
assert.equal(panels[0].scrollTop, 37, "switching panels retains each panel's scroll without rendering or clearing drafts");
assert.equal(tabButtons[1]["aria-pressed"], "true");
assert.deepEqual(tabButtons.map(button => button.tabIndex), [-1, 0, -1, -1], "only the selected section enters the Tab sequence");
assert.equal(app._selectShipPanel("unknown", panelRoot), false);
let keyPrevented = 0, tabFocused = null;
panelRoot.contains = button => tabButtons.includes(button);
for (const button of tabButtons) {
  button.closest = () => button;
  button.focus = () => { tabFocused = button.dataset.shipWindowTab; };
  button.click = () => app._selectShipPanel(button.dataset.shipWindowTab, panelRoot);
}
app._onShipTabKey({ key: "End", target: tabButtons[1], preventDefault: () => keyPrevented++ }, panelRoot);
assert.equal(app.activeShipPanel, "settings");
assert.equal(tabFocused, "settings");
app._onShipTabKey({ key: "ArrowRight", target: tabButtons[3], preventDefault: () => keyPrevented++ }, panelRoot);
assert.equal(app.activeShipPanel, "orders", "arrow navigation wraps through the existing click path");
assert.equal(keyPrevented, 2);
const searchRows = ["Зелёный пояс Ткани", "Ассур Пассажиры"].map(text => ({ hidden: false, selected: true, getAttribute: () => text }));
const searchEmpty = { hidden: true };
const searchRoot = { querySelectorAll: () => searchRows, querySelector: () => searchEmpty };
app.orderSearch = "  ЗЕЛЕНЫЙ ";
app._filterShipRows("order", searchRoot);
assert.deepEqual(searchRows.map(row => row.hidden), [false, true], "search folds case and ё/е without changing selected orders");
assert.ok(searchRows.every(row => row.selected));
assert.equal(searchEmpty.hidden, true);
app.orderSearch = "неизвестный груз";
app._filterShipRows("order", searchRoot);
assert.equal(searchEmpty.hidden, false);
app.orderSearch = "";
app._filterShipRows("order", searchRoot);
assert.ok(searchRows.every(row => !row.hidden), "clearing a query restores the whole board");
let renders = 0, commits = 0;
const errors = [];
globalThis.ui = { notifications: { error: (message) => errors.push(message) } };
app.requestRender = () => { renders += 1; };
SkyholdData.view = () => data;
SkyholdData.transaction = async (callback) => {
  const draft = structuredClone(data);
  const result = callback(draft);
  draft.meta.revision += 1; data = draft; commits += 1; return result;
};
const event = (revision, value) => ({ preventDefault() {}, currentTarget: {
  dataset: { field: "holdings.999.special.ships.list.999.name" }, value,
  closest: () => ({ dataset: { shipRevision: revision } })
} });
await app._onShipFieldChange(event(0, "Устаревшая правка"));
assert.equal(commits, 0);
assert.match(errors.at(-1), /Данные изменились/);
await app._onShipFieldChange(event(1, "Новое имя"));
assert.equal(commits, 1, "stable ids, not stale list indices, identify the edited ship");
assert.equal(data.holdings[0].special.ships.list[0].name, "Новое имя");
data.holdings[0].special.ships.list[0].activeVoyage = { id: "voyage" };
await app._onShipFieldChange(event(2, "Во время рейса"));
assert.equal(commits, 1);
assert.match(errors.at(-1), /активного рейса/);
game.user.isGM = false;
await app._onShipFieldChange(event(2, "Игрок"));
assert.equal(commits, 1);
assert.equal(renders, 3);
app.activeShipPanel = "settings";
const playerContext = await app._prepareContext({});
assert.equal(playerContext.shipWindowTabs.some((tab) => tab.id === "settings"), false);
assert.equal(playerContext.shipPanels.orders, true, "losing GM permission returns to a visible panel");
const upkeepEvent = (revision, checked) => ({ preventDefault() {}, currentTarget: {
  type: "checkbox", checked, dataset: { field: "holdings.999.special.ships.list.999.homeUpkeepEnabled" },
  closest: () => ({ dataset: { shipRevision: revision } })
} });
await app._onShipFieldChange(upkeepEvent(2, false));
assert.equal(commits, 1, "players cannot toggle home upkeep");
game.user.isGM = true;
await app._onShipFieldChange(upkeepEvent(1, false));
assert.equal(commits, 1, "stale toggles must be rejected");
await app._onShipFieldChange(upkeepEvent(2, false));
assert.equal(commits, 2, "GM may configure future home upkeep even during a voyage");
assert.equal(data.holdings[0].special.ships.list[0].homeUpkeepEnabled, false);
assert.equal(data.holdings[0].special.ships.list[0].homeUpkeepCopperPerDay, 0);
const disabledContext = await app._prepareContext({});
assert.equal(disabledContext.shipsContext.rows[0].homeUpkeepEnabled, false);
data.holdings[0].special.ships.list[0].activeVoyage = null;
data.holdings[0].special.ships.list[0].status = "docked";
data.holdings[0].special.ships.list[0].location.kind = "home";
const numericEvent = (revision, tail, value) => ({ preventDefault() {}, currentTarget: {
  type: "number", value: String(value), dataset: { field: `holdings.999.special.ships.list.999.${tail}` },
  closest: () => ({ dataset: { shipRevision: revision } })
} });
await app._onShipFieldChange(numericEvent(3, "speedKmPerDay", 160));
assert.equal(data.holdings[0].special.ships.list[0].speedKmPerDay, 160);
const capacity = data.holdings[0].special.ships.list[0].capacityLoadPoints;
await app._onShipFieldChange(numericEvent(4, "hiddenCapacityLoadPoints", capacity + 1));
assert.match(errors.at(-1), /Тайники/);
assert.equal(data.holdings[0].special.ships.list[0].hiddenCapacityLoadPoints <= capacity, true);
await app._onShipFieldChange(numericEvent(4, "capacityLoadPoints", capacity + 500));
assert.equal(data.holdings[0].special.ships.list[0].capacityLoadPoints, capacity + 500);
console.log("Ship window: lightweight overview, selected detail, crew membership/drafts, GM reroll intent and stale settings guards passed.");
