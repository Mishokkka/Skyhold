import assert from "node:assert/strict";
import { SkyholdData } from "../data/store.js";
import { DEFAULT_SKYHOLD_DATA } from "../data/defaults/default-skyhold-data.js";
import { migrateData } from "../data/normalizers.js";
import { createSkyholdSplitStorage } from "../data/split-storage.js";
import { prepareSkyholdCommit } from "../data/commit-preparation.js";
import { MODULE_ID, SETTING_DATA, SETTING_META, SETTING_HOLDINGS, SETTING_CATALOG } from "../data/constants.js";

// Run the real editor factory and split persistence with in-memory settings;
// this does not start Foundry or touch world data.
const previous = Object.fromEntries(["foundry", "game"].map(key => [key, globalThis[key]]));
const original = { get: SkyholdData.get, transaction: SkyholdData.transaction };
const rendered = [];
class Application {
  render() { rendered.push(this); return Promise.resolve(this); }
}

try {
  globalThis.game = { user: { isGM: true } };
  globalThis.foundry = { applications: { api: { ApplicationV2: Application, HandlebarsApplicationMixin: Base => Base } },
    utils: { setProperty(target, path, value) {
      const parts = path.split("."), last = parts.pop();
      for (const part of parts) target = target[part] ??= {};
      target[last] = value;
    } } };
  const { registerBuiltinUniqueBuildings } = await import("../apps/unique-buildings/builtins.js");
  const { SkyholdBuildingTemplateBrowser } = await import("../apps/editors/template-browser.js");
  const { SkyholdMedicalBuildingApp } = await import("../apps/unique-buildings/medical-app.js");
  registerBuiltinUniqueBuildings();
  const root = migrateData(structuredClone(DEFAULT_SKYHOLD_DATA));
  for (const kind of ["medical", "fasti-shop"]) root.catalog.buildings.push({
    id: `audit-${kind}`, name: `Original ${kind}`, special: { kind }, img: "before.webp", materialCosts: []
  });
  const holding = root.holdings[0];
  holding.buildings.list.push({ id: "audit-instance", name: "Original instance", special: { kind: "medical" }, materialCosts: [] });
  const values = new Map([[SETTING_DATA, root], [SETTING_META, root.meta], [SETTING_HOLDINGS, root.holdings], [SETTING_CATALOG, root.catalog]]);
  const settings = {
    get(moduleId, key) { assert.equal(moduleId, MODULE_ID); return structuredClone(values.get(key)); },
    async set(moduleId, key, value) { assert.equal(moduleId, MODULE_ID); values.set(key, structuredClone(value)); return value; }
  };
  let storage = createSkyholdSplitStorage({ settings });
  const scopes = [];
  SkyholdData.get = () => storage.getData();
  SkyholdData.transaction = async (updater, options) => {
    const draft = storage.getData(), result = await updater(draft);
    const prepared = prepareSkyholdCommit(draft, options);
    await storage.persistData(prepared.data, { normalized: true, scope: prepared.scope });
    scopes.push(options.scope);
    // A new reader exposes accidental cache-only success and mimics reload.
    storage = createSkyholdSplitStorage({ settings });
    return result;
  };
  const event = currentTarget => ({ currentTarget, preventDefault() {}, stopPropagation() {} });
  const browser = new SkyholdBuildingTemplateBrowser({ holdingId: holding.id });
  for (const kind of ["medical", "fasti-shop"]) {
    await browser._onEditTemplate(event({ dataset: { templateId: `audit-${kind}` } }));
    const app = rendered.at(-1);
    assert.equal(app.templateId, `audit-${kind}`, "the real browser must open the unique template subclass");
    app.requestRender = () => null;
    const readTemplate = () => SkyholdData.get().catalog.buildings.find(row => row.id === app.templateId);
    const holdingsBefore = structuredClone(SkyholdData.get().holdings);
    await app._onFieldChange(event({ dataset: { field: "catalog.buildings.0.name" }, value: `Edited ${kind}` }));
    assert.equal(readTemplate().name, `Edited ${kind}`, "editing a unique template field must survive a fresh split-storage read");
    await app._onAddBuildingMaterial(event({}));
    assert.equal(readTemplate().materialCosts.length, 1, "structural template changes must persist in the catalog");
    await app._onClearBuildingImage(event({}));
    assert.equal(readTemplate().img, "", "unique template image changes must persist in the catalog");
    assert.deepEqual(SkyholdData.get().holdings, holdingsBefore, "template changes cannot rewrite placed buildings");
    assert.deepEqual(scopes.slice(-3), ["catalog", "catalog", "catalog"]);
    game.user.isGM = false;
    const writeCount = scopes.length;
    await app._onFieldChange(event({ dataset: { field: "catalog.buildings.0.name" }, value: "Forbidden edit" }));
    await app._onAddBuildingMaterial(event({}));
    assert.equal(scopes.length, writeCount, "players must never mutate unique templates");
    game.user.isGM = true;
  }
  const app = new SkyholdMedicalBuildingApp({ holdingId: holding.id, buildingId: "audit-instance" });
  app.requestRender = () => null;
  const catalogBefore = structuredClone(SkyholdData.get().catalog);
  await app._onFieldChange(event({ dataset: { field: "holdings.0.buildings.list.0.name" }, value: "Edited instance" }));
  await app._onAddBuildingMaterial(event({}));
  const instance = SkyholdData.get().holdings[0].buildings.list.find(row => row.id === "audit-instance");
  assert.equal(instance.name, "Edited instance");
  assert.equal(instance.materialCosts.length, 1);
  assert.deepEqual(scopes.slice(-2), ["holdings", "holdings"]);
  assert.deepEqual(SkyholdData.get().catalog, catalogBefore, "placed-building edits must leave templates unchanged");
} finally {
  Object.assign(SkyholdData, original);
  Object.assign(globalThis, previous);
}
console.log("Unique building editors: actual template factory, field/list/image persistence after reload, GM/player gates and placed-building partition isolation passed.");
