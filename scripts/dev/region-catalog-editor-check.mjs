import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SkyholdData } from "../data/store.js";
import { normalizeEventRegionOptions } from "../data/random-events.js";
import { regionCatalogGroups, moveCatalogRegion, moveCatalogFolder, placeCatalogRegion } from "../apps/domains/region-catalog-order.js";
import { HeldActionRenderMixin } from "../apps/common/held-action-render.js";

globalThis.foundry = { applications: { api: {
  ApplicationV2: class { get state() { return 0; } async _prepareContext() { return {}; } async _preClose() {} async _onClose() {} }, HandlebarsApplicationMixin: (Base) => Base
} } };
const { SkyholdRegionCatalogEditor } = await import("../apps/editors/region-catalog-editor.js");
const data = { catalog: { eventRegions: [{ value: "port", label: "Port", marketSpecialtyIds: [], marketLinks: [] }] } };
const originalView = SkyholdData.view;
const originalTransaction = SkyholdData.transaction;
const originalGame = globalThis.game;
SkyholdData.view = () => data;
let committedTransactions = 0;
SkyholdData.transaction = async (callback) => {
  let skipped = false;
  const result = await callback(data, { skip: (value) => { skipped = true; return value; } });
  if (!skipped) committedTransactions++;
  return result;
};
globalThis.game = { user: { isGM: true } };
let ownerRenders = 0;
try {
  const app = new SkyholdRegionCatalogEditor({ owner: { requestRender: () => ownerRenders++ } });
  app.regionId = "port";
  const badge = { lastChild: { textContent: "" } };
  app.element = { querySelector: () => badge, querySelectorAll: () => [] };
  const field = { dataset: { regionId: "port", regionSpecialtyId: "coastal-fishery" }, checked: true };
  await app._onSpecialtyChange({ preventDefault() {} }, field);
  assert.deepEqual(data.catalog.eventRegions[0].marketSpecialtyIds, ["coastal-fishery"]);
  assert.equal(ownerRenders, 0, "specialty changes must not rebuild the parent window during editing");
  assert.match(badge.lastChild.textContent, /1 выбрано/);
  await app._onClose({});
  assert.equal(ownerRenders, 1, "closing after edits refreshes the parent once");
  const template = readFileSync("templates/region-catalog-editor.hbs", "utf8");
  for (const key of ["region-list", "region-detail", "region-specialties"]) {
    assert.ok(template.includes('data-render-scroll-key="' + key + '"'), key + " scroll must survive renders");
  }
  const rows = normalizeEventRegionOptions([
    { value: "a", label: "A", catalogFolder: " Гавани ", marketLinks: [{ regionId: "b", modes: ["caravan"] }] },
    { value: "b", label: "B" }, { value: "c", label: "C", catalogFolder: "Гавани" }, { value: "d", label: "D", catalogFolder: "Острова" }
  ], { fallback: false });
  const links = structuredClone(rows[0].marketLinks);
  assert.deepEqual(regionCatalogGroups(rows).map((row) => row.name), ["Гавани", "", "Острова"]);
  assert.equal(moveCatalogRegion(rows, "c", -1), true);
  assert.deepEqual(regionCatalogGroups(rows)[0].rows.map((row) => row.value), ["c", "a"]);
  assert.equal(moveCatalogFolder(rows, "Острова", -1), true);
  assert.deepEqual(regionCatalogGroups(rows).map((row) => row.name), ["Гавани", "Острова", ""]);
  assert.equal(placeCatalogRegion(rows, "b", { beforeId: "a" }), true);
  assert.equal(rows.find((row) => row.value === "b").catalogFolder, "Гавани");
  assert.deepEqual(regionCatalogGroups(rows)[0].rows.map((row) => row.value), ["c", "b", "a"]);
  const beforeNoop = structuredClone(rows);
  assert.equal(placeCatalogRegion(rows, "a", { beforeId: "a" }), false);
  assert.equal(placeCatalogRegion(rows, "a", { beforeId: "deleted" }), false);
  assert.deepEqual(rows, beforeNoop, "stale targets cannot lose or move a location");
  const interleaved = () => normalizeEventRegionOptions([
    { value: "first", catalogFolder: "X" }, { value: "second", catalogFolder: "Y" }, { value: "third", catalogFolder: "X" }
  ], { fallback: false });
  for (const target of [{ folder: "Y" }, { beforeId: "second" }, { folder: "New" }, { folder: "" }]) {
    const moved = interleaved();
    assert.equal(placeCatalogRegion(moved, "first", target), true);
    assert.deepEqual(regionCatalogGroups(moved).slice(0, 2).map((group) => group.name), ["X", "Y"], "moving a first child retains the surviving folder order");
    assert.deepEqual([...moved.map((row) => row.value)].sort(), ["first", "second", "third"]);
  }
  data.catalog.eventRegions = interleaved(); app.requestRender = () => {};
  const beforeFolderNoop = structuredClone(data.catalog.eventRegions);
  const commitsBeforeFolderNoop = committedTransactions;
  await app._onRegionCatalogFieldChange({ preventDefault() {} }, { dataset: { regionId: "first", regionCatalogField: "catalogFolder" }, type: "text", value: " X " });
  assert.deepEqual(data.catalog.eventRegions, beforeFolderNoop, "an unchanged normalized folder name cannot reorder its locations");
  assert.equal(committedTransactions, commitsBeforeFolderNoop, "an unchanged folder must skip persistence and world revision changes");
  await app._onRegionCatalogFieldChange({ preventDefault() {} }, { dataset: { regionId: "first", regionCatalogField: "catalogFolder" }, type: "text", value: "Y" });
  assert.deepEqual(regionCatalogGroups(data.catalog.eventRegions).map((group) => group.name), ["X", "Y"], "editing a folder name uses the same ordering as drag/drop");
  assert.deepEqual(regionCatalogGroups(data.catalog.eventRegions)[1].rows.map((row) => row.value), ["second", "first"]);
  assert.equal(placeCatalogRegion(rows, "a", { folder: "" }), true);
  const restored = normalizeEventRegionOptions(JSON.parse(JSON.stringify(rows)), { fallback: false });
  assert.deepEqual(restored, rows, "folders and order survive save/load normalization");
  assert.deepEqual(restored.find((row) => row.value === "a").marketLinks, links, "organization must not rewrite route links");
  data.catalog.eventRegions = restored; app.regionId = "b"; app.requestRender = () => {};
  await app._onRegionCatalogFieldChange({ preventDefault() {} }, { dataset: { regionId: "b", regionCatalogField: "catalogFolder" }, type: "text", value: "Новая папка" });
  assert.equal(data.catalog.eventRegions.find((row) => row.value === "b").catalogFolder, "Новая папка");
  const context = await app._prepareContext({});
  assert.equal(context.selectedRegion.value, "b"); assert.equal(app.state, 0);
  assert.ok(context.selectedRegion.marketSpecialtyGroups.length > 1);
  assert.ok(context.selectedRegion.marketSpecialtyGroups.every((group) => group.rows.every((row) => row.category === group.label)));
  globalThis.game.user.isGM = false;
  const playerBefore = JSON.stringify(data);
  await app._saveOrder((current) => moveCatalogRegion(current, "b", -1));
  await app._onRegionCatalogFieldChange({ preventDefault() {} }, { dataset: { regionId: "b", regionCatalogField: "catalogFolder" }, type: "text", value: "Чужая папка" });
  assert.equal(JSON.stringify(data), playerBefore, "players cannot reorganize the world catalog");
  globalThis.game.user.isGM = true;
  const regularTransaction = SkyholdData.transaction; let finishSave, closed = false;
  SkyholdData.transaction = (callback) => new Promise((resolve) => { finishSave = () => resolve(regularTransaction(callback)); });
  const savingOrder = app._saveOrder((current) => placeCatalogRegion(current, "b", { folder: "После закрытия" }));
  const closing = app._preClose({}).then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false, "close must wait for a pending drag/drop or arrow write");
  finishSave(); await Promise.all([savingOrder, closing]);
  assert.equal(closed, true); assert.equal(data.catalog.eventRegions.find((row) => row.value === "b").catalogFolder, "После закрытия");
  SkyholdData.transaction = regularTransaction;
  let vetoClose = true;
  const Guarded = HeldActionRenderMixin(class { async close() { if (vetoClose) throw new Error("pending save"); return this; } });
  const guarded = new Guarded(); guarded._actionClickController = new AbortController(); guarded._pressedAction = true;
  await assert.rejects(guarded.close(), /pending save/);
  assert.equal(guarded._actionClickController.signal.aborted, false, "a vetoed close must retain interaction listeners");
  assert.equal(guarded._pressedAction, true);
  vetoClose = false; await guarded.close(); assert.equal(guarded._actionClickController.signal.aborted, true);
  const folderRow = (text) => ({ dataset: { regionSearchText: text }, hidden: false });
  const a = folderRow("гавань"), b = folderRow("остров");
  const folder = (name, open, row) => ({ dataset: { fblsDisclosure: `region-folder:${name}` }, open, hidden: false, querySelectorAll: () => [row] });
  const originalFolders = [folder("Гавани", false, a), folder("Острова", true, b)];
  const rootFor = (folders) => ({ querySelectorAll: (selector) => selector === "[data-region-folder]" ? folders : selector === "[data-region-search-text]" ? [a, b] : [], querySelector: () => null });
  app._applySearch(rootFor(originalFolders), "гавань"); assert.equal(originalFolders[0].open, true);
  const renderedFolders = [folder("Гавани", true, a), folder("Острова", true, b)];
  app._applySearch(rootFor(renderedFolders), "гавань");
  app._applySearch(rootFor(renderedFolders), "");
  assert.equal(renderedFolders[0].open, false, "clearing a search restores the folder collapsed before search, including across a render");
  assert.equal(renderedFolders[1].open, true);
} finally {
  SkyholdData.view = originalView;
  SkyholdData.transaction = originalTransaction;
  globalThis.game = originalGame;
}
console.log("Region catalog: specialty save keeps its editor and scroll keys; owner refreshes on close.");
