import { HoldingService } from "../../data/holding-service.js";
import { ensureSkyholdStylesheet } from "../lazy-styles.js";
import { ensureSkyholdTemplateGroup } from "../template-preload.js";

function stopEvent(event) {
  event.preventDefault();
  event.stopPropagation();
}

function activeHoldingId(app) {
  const id = String(app.activeHoldingId ?? "");
  return HoldingService.getData()?.holdings?.some((holding) => String(holding.id) === id) ? id : "";
}

export const ChildWindowDomain = {
async _onOpenWorkforcePlanner(event) {
  stopEvent(event);
  const holdingId = activeHoldingId(this);
  if (!holdingId) return;
  const { openWorkforcePlanner } = await import("../lazy-apps.js");
  await openWorkforcePlanner({ holdingId });
},

async _onOpenBuildingTemplateBrowser(event) {
  stopEvent(event);
  const holdingId = activeHoldingId(this);
  if (!holdingId) return;
  await ensureSkyholdStylesheet("templateBrowser");
  const { SkyholdBuildingTemplateBrowser } = await import("../editors/template-browser.js");
  new SkyholdBuildingTemplateBrowser({ holdingId }).render({ force: true, focus: true });
},

async _onOpenMassCombatTagEditor(event) {
  stopEvent(event);
  if (!game.user?.isGM) return;
  await ensureSkyholdStylesheet("secondary");
  const { SkyholdMassCombatTagEditor } = await import("../editors/mass-combat-tag-editor.js");
  new SkyholdMassCombatTagEditor().render({ force: true, focus: true });
},

async _onOpenRandomEventEditor(event) {
  stopEvent(event);
  if (!game.user?.isGM) return;
  const holdingId = activeHoldingId(this);
  if (!holdingId) return;
  await ensureSkyholdStylesheet("secondary");
  const { SkyholdRandomEventEditor } = await import("../editors/random-event-editor.js");
  new SkyholdRandomEventEditor({ holdingId }).render({ force: true, focus: true });
},

async _onOpenRegionCatalogEditor(event) {
  stopEvent(event);
  if (!game.user?.isGM) return;
  await ensureSkyholdStylesheet("secondary");
  const { SkyholdRegionCatalogEditor } = await import("../editors/region-catalog-editor.js");
  new SkyholdRegionCatalogEditor({ owner: this }).render({ force: true, focus: true });
},

async _onOpenResourceCatalogEditor(event) {
  stopEvent(event);
  if (!game.user?.isGM) return;
  await ensureSkyholdStylesheet("secondary");
  const { SkyholdResourceCatalogEditor } = await import("../editors/resource-catalog-editor.js");
  SkyholdResourceCatalogEditor.open();
},

async _onOpenMarketCatalogEditor(event) {
  stopEvent(event);
  if (!game.user?.isGM) return;
  await ensureSkyholdStylesheet("secondary");
  const { SkyholdMarketCatalogEditor } = await import("../editors/market-catalog-editor.js");
  SkyholdMarketCatalogEditor.open();
},

async _onOpenContentPackImporter(event) {
  stopEvent(event);
  if (!game.user?.isGM) return;
  const holdingId = activeHoldingId(this);
  if (!holdingId) return;
  await ensureSkyholdStylesheet("secondary");
  const { SkyholdContentPackImporter } = await import("../editors/content-pack-importer.js");
  new SkyholdContentPackImporter({ holdingId, owner: this }).render({ force: true, focus: true });
},

async _onOpenUiReview(event) {
  stopEvent(event);
  if (!game.user?.isGM) return;
  await Promise.all([ensureSkyholdStylesheet("secondary"), ensureSkyholdTemplateGroup("uiReview")]);
  const { SkyholdUiReviewApp } = await import("../ui-review-app.js");
  SkyholdUiReviewApp.open();
},

async _onOpenLaputaMigrationImporter(event) {
  stopEvent(event);
  if (!game.user?.isGM) return;
  await ensureSkyholdStylesheet("secondary");
  const { SkyholdLaputaMigrationImporter } = await import("../editors/laputa-migration-importer.js");
  new SkyholdLaputaMigrationImporter({ owner: this }).render({ force: true, focus: true });
},

async _onOpenBuildingCatalogMigration(event) {
  stopEvent(event);
  if (!game.user?.isGM) return;
  await ensureSkyholdStylesheet("secondary");
  const { SkyholdBuildingCatalogMigration } = await import("../editors/building-catalog-migration.js");
  new SkyholdBuildingCatalogMigration({ owner: this }).render({ force: true, focus: true });
},

async _onOpenHybridLaborMigration(event) {
  stopEvent(event);
  if (!game.user?.isGM) return;
  const holdingId = activeHoldingId(this);
  if (!holdingId) return;
  await ensureSkyholdStylesheet("secondary");
  const { SkyholdHybridLaborMigration } = await import("../editors/hybrid-labor-migration.js");
  new SkyholdHybridLaborMigration({ holdingId, owner: this }).render({ force: true, focus: true });
}
};
