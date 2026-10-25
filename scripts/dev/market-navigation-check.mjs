import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SkyholdData } from "../data/store.js";
import { showSharedMarketMigration } from "../apps/market/shared-market-migration-dialog.js";

globalThis.foundry = { applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (Base) => Base } } };
globalThis.game = { user: { id: "gm", isGM: true }, modules: new Map(), settings: { get() {} } };
globalThis.ui = { notifications: { info() {} } };
const { NavigationEventActions, NavigationEventDomain } = await import("../apps/domains/events/navigation-events.js");
const { SkyholdBankApp } = await import("../apps/bank-app.js");
let opened;
SkyholdBankApp.open = (options) => { opened = options; };
const event = { preventDefault() {}, stopPropagation() {} };
assert.equal(NavigationEventActions.click["open-banks"], "_onOpenBanks");
assert.ok(NavigationEventActions.publicClick.includes("open-banks"), "Players may open the bank's read-only view");
assert.equal(NavigationEventActions.click["shared-market-preview"], "_onSharedMarketPreview");
assert.ok(!NavigationEventActions.publicClick.includes("shared-market-preview"));
for (const isGM of [true, false]) {
  game.user.isGM = isGM;
  opened = null;
  await NavigationEventDomain._onOpenBanks.call({ activeHoldingId: "village" }, event);
  assert.deepEqual(opened, { holdingId: "village" });
  opened = null;
  await NavigationEventDomain._onOpenBanks.call({ activeHoldingId: "" }, event);
  assert.equal(opened, null);
}

let data = { meta: {}, holdings: [{ id: "village", special: {} }] };
let writes = 0, confirmations = 0, confirmed = false, changeDuringConfirmation = false;
SkyholdData.view = () => data;
SkyholdData.transaction = async (updater, options) => {
  assert.equal(options.reason, "shared-market-migration");
  assert.equal(options.scope, "holdings");
  assert.equal(options.forceRollbackSnapshot, true);
  const draft = structuredClone(data);
  const result = await updater(draft);
  data = draft; writes++;
  return result;
};
foundry.applications.api.DialogV2 = { confirm: async () => {
  confirmations++;
  if (changeDuringConfirmation) data.holdings[0].special.market = { stock: {} };
  return confirmed;
} };
await NavigationEventDomain._onSharedMarketPreview.call({}, event);
await showSharedMarketMigration();
assert.equal(confirmations, 0, "The domain and dialog both reject player migration actions");
game.user.isGM = true;
const before = JSON.stringify(data);
await NavigationEventDomain._onSharedMarketPreview.call({}, event);
assert.equal(confirmations, 1);
assert.equal(writes, 0, "Preview/cancel never writes world data");
assert.equal(JSON.stringify(data), before);
confirmed = true; changeDuringConfirmation = true;
await assert.rejects(showSharedMarketMigration(), /изменился/);
assert.equal(writes, 0, "A stale migration preview cannot be applied");
changeDuringConfirmation = false;
await showSharedMarketMigration();
assert.equal(writes, 1);
assert.equal(data.meta.sharedMarkets.enabled, true);
const count = confirmations;
await showSharedMarketMigration();
assert.equal(confirmations, count, "An already enabled shared market does not offer migration again");
assert.equal(writes, 1);

const external = readFileSync("templates/parts/skyhold-tab-external-market.hbs", "utf8");
assert.match(external, /aria-label="Банки поселения"[\s\S]*data-action="open-banks"/);
const market = readFileSync("templates/market-app.hbs", "utf8");
assert.doesNotMatch(market, /market-open-banks|market-shared-preview/);
const gmTemplate = readFileSync("templates/parts/skyhold-tab-gm.hbs", "utf8");
assert.match(gmTemplate, /{{#if sharedMarketMigrationAvailable}}[\s\S]*data-action="shared-market-preview"[\s\S]*{{\/if}}/);
assert.match(readFileSync("scripts/apps/skyhold-app.js", "utf8"), /sharedMarketMigrationAvailable: canEdit && !data\.meta\?\.sharedMarkets\?\.enabled/);
console.log("Market navigation: standalone bank entry, GM/player routing and guarded GM migration preview/cancel/staleness/replay passed.");
