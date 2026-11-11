import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SkyholdData } from "../data/store.js";
import { normalizeResourceRow } from "../core/resources.js";

const previous = Object.fromEntries(["foundry", "game", "ui"].map(key => [key, globalThis[key]]));
const original = { get: SkyholdData.get, transaction: SkyholdData.transaction, updateHolding: SkyholdData.updateHolding };
const originalError = console.error;
let restorePicker;
try {
  globalThis.foundry = { applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: Base => Base } } };
  globalThis.game = { user: { isGM: true } };
  const errors = [];
  const warnings = [];
  globalThis.ui = { notifications: { error: message => errors.push(message), warn: message => warnings.push(message) } };
  const { SkyholdResourceCatalogEditor } = await import("../apps/editors/resource-catalog-editor.js");
  const { SkyholdBuildingEditor } = await import("../apps/editors/building-editor.js");
  const { StorageEventDomain } = await import("../apps/domains/events/storage-events.js");
  let picker;
  restorePicker = () => { SkyholdResourceCatalogEditor.pick = originalPick; };
  const originalPick = SkyholdResourceCatalogEditor.pick;
  SkyholdResourceCatalogEditor.pick = options => { picker = options; };
  const event = (dataset, storageRowId) => ({ currentTarget: { dataset,
    closest: () => ({ dataset: { storageHoldingId: "a", storageRowId } }) }, preventDefault() {} });
  const resource = { id: "stone", label: "Камень" };
  const app = Object.create(SkyholdBuildingEditor.prototype);
  app._canEditBuilding = () => true;
  app.requestRender = () => null;
  let building;
  app._getMutableBuilding = () => ({ building });
  app._updateMutableBuilding = updater => updater({ building });

  for (const [method, list] of [["_onPickBuildingMaterial", "materialCosts"], ["_onPickProductionResource", "productionLines"]]) {
    building = { [list]: [{ id: "before", resourceId: "wood" }, { id: "target", resourceId: "iron" }] };
    app[method](event({ index: "1" }));
    building[list].shift();
    await picker.onSelect(resource);
    assert.equal(building[list][0].resourceId, "stone", `${method}: a moved target must still receive its selection`);

    building = { [list]: [{ id: "target", resourceId: "wood" }, { id: "neighbor", resourceId: "iron" }] };
    app[method](event({ index: "0" }));
    building[list].shift();
    await picker.onSelect(resource);
    assert.equal(building[list][0].resourceId, "iron", `${method}: deleting the target cannot edit its replacement`);
  }

  building = { serviceProjects: [{ id: "before", resourceCosts: [] }, { id: "target", resourceCosts: [{ resourceId: "wood", qty: 2 }] }] };
  app._onPickServiceProjectResource(event({ projectIndex: "1", costIndex: "0" }));
  building.serviceProjects.shift();
  await picker.onSelect(resource);
  assert.equal(building.serviceProjects[0].resourceCosts[0].resourceId, "stone", "a moved project retains the original cost target");
  building = { serviceProjects: [{ id: "target", resourceCosts: [{ resourceId: "wood", qty: 2 }, { resourceId: "iron", qty: 3 }] }] };
  app._onPickServiceProjectResource(event({ projectIndex: "0", costIndex: "0" }));
  building.serviceProjects[0].resourceCosts.shift();
  const costsBefore = structuredClone(building.serviceProjects[0].resourceCosts);
  await assert.rejects(picker.onSelect(resource), /Список затрат проекта изменился/);
  assert.deepEqual(building.serviceProjects[0].resourceCosts, costsBefore, "unidentified cost rows require a fresh selection after a list change");

  const data = { holdings: [
    { id: "a", storage: { resources: [{ id: "before", resourceId: "wood" }, { id: "target", resourceId: "iron" }] } },
    { id: "b", storage: { resources: [{ id: "other", resourceId: "wood" }, { id: "target", resourceId: "iron" }] } }
  ] };
  SkyholdData.get = () => structuredClone(data);
  SkyholdData.updateHolding = async (id, updater, options) => {
    assert.equal(options.fallback, false);
    const result = await updater(data.holdings.find(holding => holding.id === id));
    return result?.value ?? result;
  };
  const manager = {
    activeHoldingId: "a", _canUseStorage: () => true,
    _activeWritableHoldingId() { return this.activeHoldingId; },
    _updateActiveHolding(updater) { return updater(data.holdings.find(holding => holding.id === this.activeHoldingId)); },
    requestRender() {}
  };
  StorageEventDomain._onPickStorageResource.call(manager, event({ storagePickerScope: "row" }, "target"));
  manager.activeHoldingId = "b";
  data.holdings[0].storage.resources.shift();
  await picker.onSelect(resource);
  assert.equal(data.holdings[0].storage.resources[0].resourceId, "stone", "a storage picker stays bound to its original holding and row");
  assert.equal(data.holdings[1].storage.resources[1].resourceId, "iron", "switching the manager cannot redirect a delayed selection");
  StorageEventDomain._onPickStorageResource.call(manager, event({ storagePickerScope: "row" }, "target"));
  await picker.onSelect({ id: "wood", label: "Древесина" });
  assert.equal(data.holdings[0].storage.resources[0].resourceId, "wood", "a picker opened from the previous render must use that render's holding");
  assert.equal(data.holdings[1].storage.resources[1].resourceId, "iron", "an equal row ID in the active holding cannot redirect the picker");
  manager.activeHoldingId = "a";
  StorageEventDomain._onPickStorageResource.call(manager, event({ storagePickerScope: "row" }, "target"));
  data.holdings[0].storage.resources.splice(0, 1, { id: "new", resourceId: "wood" });
  await picker.onSelect(resource);
  assert.equal(data.holdings[0].storage.resources[0].resourceId, "wood", "deleting a storage row cannot target a replacement");
  StorageEventDomain._onPickStorageResource.call(manager, event({ storagePickerScope: "row" }, "new"));
  data.holdings[0].special = { transportV2: { orders: [{
    id: "export", status: "booked", direction: "outbound", cargo: [{ lotId: "lot", rowId: "new", batchId: "batch", qty: 1 }]
  }] } };
  await picker.onSelect(resource);
  assert.equal(data.holdings[0].storage.resources[0].resourceId, "wood", "booking during the picker must prevent reclassifying its cargo");
  assert.match(warnings.at(-1), /груз по перевозке/);

  const storage = data.holdings[0].storage;
  data.holdings[0].special = {};
  StorageEventDomain._onPickStorageResource.call(manager, event({ storagePickerScope: "row" }, "new"));
  storage.resources.push({ id: "new", resourceId: "iron" });
  const ambiguousRows = structuredClone(storage.resources);
  await picker.onSelect(resource);
  assert.deepEqual(storage.resources, ambiguousRows, "the picker must recheck row identity when a duplicate appears while it is open");
  assert.match(warnings.at(-1), /одинаковый ID/);
  picker = null;
  StorageEventDomain._onPickStorageResource.call(manager, event({ storagePickerScope: "row" }, "new"));
  assert.equal(picker, null, "an ambiguous storage row cannot open the picker");

  storage.resources = [{ id: "wood", resourceId: "wood", name: "Древесина", roomId: "outdoors", qty: 3,
    itemUuid: "Item.old-wood", itemId: "old-wood", cost: "99 мм", notes: "Опись",
    batches: [{ id: "aged", qty: 3, ageQd: 8 }] }];
  StorageEventDomain._onPickStorageResource.call(manager, event({ storagePickerScope: "row" }, "wood"));
  await picker.onSelect({ id: "custom", label: "Другой материал…" });
  const changed = normalizeResourceRow(storage.resources[0]);
  assert.equal(changed.resourceId, "custom", "switching an old catalog row to a custom resource must survive normalization");
  assert.equal(changed.itemUuid, "", "the previous catalog Item must not remain attached");
  assert.equal(changed.cost, "", "the new custom material must not inherit the old market price");
  assert.equal(changed.notes, "Опись");
  assert.deepEqual(changed.batches, [{ id: "aged", qty: 3, ageQd: 8 }]);

  for (const isGM of [true, false]) {
    game.user.isGM = isGM;
    picker = null;
    manager._canUseStorage = () => false;
    StorageEventDomain._onPickStorageResource.call(manager, event({ storagePickerScope: "row" }, changed.id));
    assert.equal(picker, null, "the original storage permission gate remains effective");
  }
  game.user.isGM = true;

  let release, selections = 0, closes = 0;
  const buttons = [{ disabled: false }, { disabled: false }];
  const catalog = new SkyholdResourceCatalogEditor({ picker: { onSelect: () => {
    selections += 1; return new Promise(resolve => { release = resolve; });
  } } });
  catalog.element = { querySelectorAll: () => buttons };
  catalog.close = async () => { closes += 1; };
  const selectEvent = { type: "click", preventDefault() {} };
  const selection = catalog._onSelect(selectEvent, { dataset: { resourceId: "custom" } });
  await catalog._onSelect(selectEvent, { dataset: { resourceId: "custom" } });
  assert.equal(selections, 1, "rapid selection must not duplicate storage additions or production expenses");
  assert.ok(buttons.every(button => button.disabled), "selection controls must acknowledge the pending operation");
  release();
  await selection;
  assert.equal(closes, 1);

  const listeners = {};
  catalog._bindEvents({ addEventListener: (name, handler) => { listeners[name] = handler; }, contains: () => true });
  const click = (action, dataset = {}) => {
    const element = { dataset: { action, ...dataset } };
    return listeners.click({ type: "click", target: { closest: () => element }, preventDefault() {} });
  };
  console.error = () => {};
  catalog.picker.onSelect = async () => { throw new Error("save failed"); };
  assert.equal(await click("resource-select", { resourceId: "custom" }), false);
  assert.equal(closes, 1, "a failed selection retains its picker");
  assert.equal(catalog._selectingResource, false, "a failed operation must allow retry");
  assert.ok(buttons.every(button => !button.disabled));
  SkyholdData.transaction = async () => { throw new Error("write failed"); };
  assert.equal(await click("resource-add"), false, "resource add rejection is handled at the actual event boundary");
  assert.equal(errors.length, 2, "each failed async action must report an error to the user");
  catalog._resourceAbortController.abort();

  const template = readFileSync(new URL("../../templates/resource-row-editor.hbs", import.meta.url), "utf8");
  const fields = [...template.matchAll(/data-resource-field="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(fields).size, fields.length, "each resource property must have one editable control, avoiding conflicting stale values");
} finally {
  restorePicker?.();
  Object.assign(SkyholdData, original);
  Object.assign(globalThis, previous);
  console.error = originalError;
}
console.log("Resource pickers: reordered/deleted rows, holding switches, project cost conflicts, permission gates, single pending selection, errors/retry and unique field controls passed.");
