import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SkyholdData } from "../data/store.js";
import { DEFAULT_SKYHOLD_DATA } from "../data/defaults/default-skyhold-data.js";
import { normalizeSkyholdData } from "../data/normalizers.js";

const renderedBanks = [], loadedTemplates = [];
globalThis.foundry = { applications: { api: { ApplicationV2: class {
  constructor(options = {}) { this.id = options.id; }
  get state() { return 0; }
  async _prepareContext() { return {}; }
  render(options) { renderedBanks.push({ app: this, options }); return this; }
}, HandlebarsApplicationMixin: (Base) => Base }, handlebars: { loadTemplates: async (paths) => { loadedTemplates.push(...paths); return paths; } } } };
globalThis.game = { user: { id: "gm", isGM: true }, modules: new Map(), settings: { get() {} } };
globalThis.ui = { notifications: { info() {} } };
const { NavigationEventActions, NavigationEventDomain } = await import("../apps/domains/events/navigation-events.js");
const { SkyholdBankApp } = await import("../apps/bank-app.js");
let opened;
const openBank = SkyholdBankApp.open;
SkyholdBankApp.open = (options) => { opened = options; };
const event = { preventDefault() {}, stopPropagation() {} };
assert.equal(NavigationEventActions.click["open-banks"], "_onOpenBanks");
assert.ok(NavigationEventActions.publicClick.includes("open-banks"), "Players may open the bank's read-only view");
assert.equal(NavigationEventActions.click["shared-market-preview"], undefined);
for (const isGM of [true, false]) {
  game.user.isGM = isGM;
  opened = null;
  await NavigationEventDomain._onOpenBanks.call({ activeHoldingId: "village" }, event);
  assert.deepEqual(opened, { holdingId: "village" });
  opened = null;
  await NavigationEventDomain._onOpenBanks.call({ activeHoldingId: "" }, event);
  assert.equal(opened, null);
}
// Exercise the actual first-button path through lazy loading and construction.
// The routing-only spy above cannot catch collisions with ApplicationV2 getters.
SkyholdBankApp.open = openBank;
const previousView = SkyholdData.view;
SkyholdData.view = () => ({ meta: { revision: 1 }, catalog: { banks: [] }, holdings: [
  { id: "village", name: "Поселение", visibility: "public", special: {}, storage: { moneyCopper: 0 } }
] });
for (const isGM of [true, false]) {
  game.user.isGM = isGM; SkyholdBankApp.instances.clear();
  const beforeOpen = renderedBanks.length;
  await NavigationEventDomain._onOpenBanks.call({ activeHoldingId: "village" }, event);
  assert.equal(renderedBanks.length, beforeOpen + 1, "the first bank button reaches the real application render call");
  const { app, options } = renderedBanks.at(-1);
  assert.equal(app.holdingId, "village"); assert.equal(app.state, 0, "Foundry retains ownership of its render state");
  assert.deepEqual(options, { force: true, focus: true });
  const context = await app._prepareContext({});
  assert.equal(context.hasHolding, true); assert.equal(context.borrow, true); assert.equal(context.isGM, isGM);
}
assert.ok(loadedTemplates.includes("modules/fbl-skyhold/templates/parts/save-status.hbs"));
SkyholdBankApp.instances.clear(); SkyholdData.view = previousView;

assert.equal(DEFAULT_SKYHOLD_DATA.meta.sharedMarkets.enabled, true, "Shared markets are enabled by default in new worlds");
const normalized = normalizeSkyholdData({
  meta: { schemaVersion: 72, templateCatalogVersion: 19 },
  catalog: {},
  holdings: [{ id: "village", special: {} }]
});
assert.equal(normalized.meta.sharedMarkets.enabled, true, "Normalized world data activates shared markets");

const external = readFileSync("templates/parts/skyhold-tab-external-market.hbs", "utf8");
assert.match(external, /aria-label="Банки поселения"[\s\S]*data-action="open-banks"/);
const market = readFileSync("templates/market-app.hbs", "utf8");
assert.doesNotMatch(market, /market-open-banks|market-shared-preview/);
const gmTemplate = readFileSync("templates/parts/skyhold-tab-gm.hbs", "utf8");
assert.doesNotMatch(gmTemplate, /sharedMarketMigrationAvailable|shared-market-preview/);
assert.doesNotMatch(readFileSync("scripts/apps/skyhold-app.js", "utf8"), /sharedMarketMigrationAvailable/);
console.log("Market navigation: standalone bank entry, GM/player routing and default-enabled shared markets passed.");
