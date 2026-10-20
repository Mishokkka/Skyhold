import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SkyholdData } from "../data/store.js";

globalThis.foundry = { applications: { api: {
  ApplicationV2: class { async _onClose() {} }, HandlebarsApplicationMixin: (Base) => Base
} } };
const { SkyholdRegionCatalogEditor } = await import("../apps/editors/region-catalog-editor.js");
const data = { catalog: { eventRegions: [{ value: "port", label: "Port", marketSpecialtyIds: [], marketLinks: [] }] } };
const originalView = SkyholdData.view;
const originalTransaction = SkyholdData.transaction;
const originalGame = globalThis.game;
SkyholdData.view = () => data;
SkyholdData.transaction = async (callback) => callback(data, { skip: (value) => value });
globalThis.game = { user: { isGM: true } };
let ownerRenders = 0;
try {
  const app = new SkyholdRegionCatalogEditor({ owner: { requestRender: () => ownerRenders++ } });
  app.regionId = "port";
  const badge = { lastChild: { textContent: "" } };
  app.element = { querySelector: () => badge };
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
} finally {
  SkyholdData.view = originalView;
  SkyholdData.transaction = originalTransaction;
  globalThis.game = originalGame;
}
console.log("Region catalog: specialty save keeps its editor and scroll keys; owner refreshes on close.");
