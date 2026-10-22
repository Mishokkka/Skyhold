import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Linter } from "eslint";
import { fieldValue } from "../core/helpers.js";
import { DEFAULT_SKYHOLD_DATA } from "../data/defaults/default-skyhold-data.js";
import { migrateData } from "../data/normalizers.js";
import { prepareSkyholdCommit } from "../data/commit-preparation.js";
import { createSkyholdSplitStorage } from "../data/split-storage.js";
import { SETTING_CATALOG, SETTING_HOLDINGS } from "../data/constants.js";
import { SaveStatus } from "../apps/common/save-status.js";
import { buildingPickerValues } from "../apps/domains/building-editor-pickers.js";
import { assertProductionIdentityUnchanged, createProductionTiming } from "../engines/economy/production-timing.js";
import { validateHybridLaborHolding, newHybridLaborIssues } from "../data/hybrid-labor.js";
import { buildWorkAllocationTargets } from "../data/work-allocations.js";

export async function checkBuildingEditorPersistence() {
// Run real editor methods without booting Foundry, then reload real split storage.
const source = readFileSync(new URL("../apps/editors/building-editor.js", import.meta.url), "utf8");
const names = new Set(["_resolveBuildingScopedPath", "_onFieldChange", "_onBuildingStringListChange", "_updateMutableBuilding", "_saveTransaction"]);
const methods = [];
new Linter().verify(source, [{ plugins: { fixture: { rules: { extract: { create: () => ({
  MethodDefinition(node) {
    if (names.has(node.key.name)) methods.push(source.slice(node.range[0], node.range[1]));
  }
}) } } } }, rules: { "fixture/extract": "error" } }]);
assert.equal(methods.length, names.size);

const values = new Map();
const writes = [];
const settings = {
  get: (_module, key) => structuredClone(values.get(key)),
  set: async (_module, key, value) => { writes.push(key); values.set(key, structuredClone(value)); }
};
const storage = createSkyholdSplitStorage({ settings });
const initial = migrateData(structuredClone(DEFAULT_SKYHOLD_DATA));
initial.holdings[0].buildings.list = [{ ...structuredClone(initial.catalog.buildings[0]), id: "instance" }];
await storage.persistData(initial);
const skipped = Symbol("skip");
const dataApi = {
  skipTransaction: (value) => ({ [skipped]: true, value }),
  async transaction(updater, options) {
    const draft = storage.getData();
    const result = await updater(draft);
    if (result?.[skipped]) return result.value;
    const prepared = prepareSkyholdCommit(draft, options);
    await storage.persistData(prepared.data, { normalized: true, scope: prepared.scope });
    return result;
  }
};
const foundry = { utils: {
  setProperty(object, path, value) {
    const parts = path.split(".");
    const last = parts.pop();
    for (const key of parts) object = object[key] ??= {};
    object[last] = value;
  },
  getProperty: (object, path) => path.split(".").reduce((row, key) => row?.[key], object)
} };
const Editor = new Function("SkyholdData", "foundry", "fieldValue", "buildingPickerValues", "requestSkyholdAppRender", "ui", "assertProductionIdentityUnchanged", "newHybridLaborIssues", "validateHybridLaborHolding", "buildWorkAllocationTargets",
  `return class { ${methods.join("\n")} }`)(dataApi, foundry, fieldValue,
  buildingPickerValues, () => {},
  { notifications: { error(message) { assert.fail(message); } } }, assertProductionIdentityUnchanged,
  newHybridLaborIssues, validateHybridLaborHolding, buildWorkAllocationTargets);
const reload = () => createSkyholdSplitStorage({ settings }).getData();
for (const template of [true, false]) {
  const editor = new Editor();
  editor._saveStatus = new SaveStatus();
  editor.templateId = template ? initial.catalog.buildings[0].id : null;
  editor._canEditBuilding = () => true;
  editor.requestRender = () => {};
  editor._getMutableBuilding = (data) => ({
    holding: template ? null : data.holdings[0], holdingIndex: template ? -1 : 0, buildingIndex: 0,
    building: template ? data.catalog.buildings[0] : data.holdings[0].buildings.list[0]
  });
  const base = template ? "catalog.buildings.0" : "holdings.0.buildings.list.0";
  const read = () => template ? reload().catalog.buildings[0] : reload().holdings[0].buildings.list[0];
  writes.length = 0;
  await editor._onFieldChange({ preventDefault() {}, currentTarget: { dataset: { field: `${base}.name` }, value: "Edited name" } });
  assert.equal(read().name, "Edited name", "text edit must survive reopening storage");
  await editor._onFieldChange({ preventDefault() {}, currentTarget: { dataset: { field: `${base}.service.leisure.capacity`, type: "number" }, value: "37" } });
  assert.equal(read().service.leisure.capacity, 37, "nested numeric edit must survive normalization and reload");
  await editor._onBuildingStringListChange({ preventDefault() {}, currentTarget: { dataset: { buildingStringListField: `${base}.service.coveredBuildingIds` }, value: "a, b, a" } });
  assert.deepEqual(read().service.coveredBuildingIds, ["a", "b"]);
  await editor._updateMutableBuilding(({ building }) => { building.materialCosts.push({ resourceId: "wood", qty: 13 }); });
  assert.ok(read().materialCosts.some((row) => row.resourceId === "wood" && row.qty === 13), "structural edits must persist too");
  await editor._updateMutableBuilding(({ building }) => {
    building.productionLines.push({ id: "wait-test", source: "workers", resourceId: "stone", workQd: 1, outputQty: 2, waitDays: 2.5, repeat: false });
  });
  assert.equal(read().productionLines.find((line) => line.id === "wait-test").waitDays, 2.5);
  assert.equal(read().productionLines.find((line) => line.id === "wait-test").repeat, false);
  if (!template) {
    await editor._updateMutableBuilding(({ building }) => {
      const line = building.productionLines.find((row) => row.id === "wait-test");
      const timing = { ...createProductionTiming(line, "stone", "Камень"), phase: "waiting", elapsedQd: 2 };
      Object.assign(line, { workInputsReserved: true, workReservedOutputQty: 2, workProgressUnits: 10_000,
        workReservedInputs: { version: 1, entries: [], timing } });
    });
    const before = read().productionLines.find((line) => line.id === "wait-test");
    assert.equal(before.workProgressUnits, 10_000, "Completed labor and waiting must survive split storage reload");
    const writeCount = writes.length;
    await assert.rejects(editor._updateMutableBuilding(({ building }) => {
      building.productionLines.find((line) => line.id === "wait-test").resourceId = "iron";
    }), /источник и ресурс/);
    assert.equal(writes.length, writeCount, "Identity change of a funded batch cannot write any partition");
    await editor._updateMutableBuilding(({ building }) => {
      building.productionLines.find((line) => line.id === "wait-test").waitDays = 30;
    });
    const after = read().productionLines.find((line) => line.id === "wait-test");
    assert.equal(after.waitDays, 30);
    assert.deepEqual(after.workReservedInputs, before.workReservedInputs, "Next recipe edits must preserve funded batch timing");
  }
  await editor._updateMutableBuilding(({ building }) => { building.serviceProjects = [{ id: "picker-project", title: "Выбор участников", participantIds: ["external"] }]; });
  const pickerEvent = (relativePath, selected) => ({ preventDefault() {}, currentTarget: {
    dataset: {}, value: selected.at(-1), checked: true, closest: () => ({
      dataset: { buildingListPicker: `${base}.${relativePath}` }, querySelectorAll: () => selected.map(value => ({ value })),
      querySelector: selector => selector === "[data-building-list-search]" ? { value: "ру" } : { scrollTop: 24 }
    })
  } });
  await editor._onBuildingStringListChange(pickerEvent("serviceProjects.0.participantIds", ["external", "runa"]));
  assert.deepEqual(read().serviceProjects[0].participantIds, ["external", "runa"], "picker participants, including saved unknown IDs, must survive storage reload");
  await editor._onBuildingStringListChange(pickerEvent("income.trade.allowedTags", ["food.raw", "custom-tag"]));
  assert.deepEqual(read().income.trade.allowedTags, ["food.raw", "custom-tag"], "catalog and custom category selections must survive normalization and reload");
  assert.ok(writes.includes(template ? SETTING_CATALOG : SETTING_HOLDINGS));
  assert.ok(!writes.includes(template ? SETTING_HOLDINGS : SETTING_CATALOG), "editing must not write the other partition");
  editor._canEditBuilding = () => false;
  writes.length = 0;
  await editor._onFieldChange({ preventDefault() {}, currentTarget: { dataset: { field: `${base}.name` }, value: "Forbidden" } });
  await editor._onBuildingStringListChange(pickerEvent("serviceProjects.0.participantIds", ["forbidden"]));
  assert.equal(writes.length, 0, "read-only editors must not write");
  assert.equal(read().name, "Edited name");
  assert.deepEqual(read().serviceProjects[0].participantIds, ["external", "runa"], "read-only picker attempts cannot mutate project participation");
}

// A stale contract in one building must not lock all editors in the settlement.
const damaged = reload();
damaged.holdings[0].buildings.list.push({
  id: "broken-employer", name: "Broken employer", constructionStatus: "built", workersMin: 0, workersMax: 1,
  labor: { version: 1, mode: "staff", capacityQd: null }, assignedWorkerIds: ["stale-worker"],
  functions: { production: true }, productionLines: []
});
damaged.holdings[0].people.list.push({ id: "stale-worker", name: "Stale worker", age: 30, workAssignment: "broken-employer",
  staffAppointment: { version: 1, buildingId: "broken-employer", primaryFunctionId: "production:deleted",
    reserveFunctionId: "", wageDailyCopper: 12, overtimeQd: 0, volunteer: false, volunteerReason: "" } });
await storage.persistData(damaged);
const editor = new Editor();
editor._saveStatus = new SaveStatus();
editor._canEditBuilding = () => true;
let buildingIndex = 0;
editor._getMutableBuilding = data => ({ holding: data.holdings[0], holdingIndex: 0, buildingIndex,
  building: data.holdings[0].buildings.list[buildingIndex] });
await editor._updateMutableBuilding(({ building }) => { building.name = "Unrelated edit"; });
assert.equal(reload().holdings[0].buildings.list[0].name, "Unrelated edit");
buildingIndex = damaged.holdings[0].buildings.list.length - 1;
await editor._updateMutableBuilding(({ building }) => { building.name = "Renamed employer"; });
assert.equal(reload().holdings[0].buildings.list[buildingIndex].name, "Renamed employer",
  "Renaming the affected building must not turn an unchanged issue into a new one");
let writeCount = writes.length;
await assert.rejects(editor._updateMutableBuilding(({ building }) => { building.workersMax = 0; }), /штатных мест/);
assert.equal(writes.length, writeCount, "An old broken reference cannot authorize a new capacity violation");
await editor._updateMutableBuilding(({ building }) => {
  building.productionLines.push({ id: "deleted", active: true, source: "workers", resourceId: "wood", outputQty: 1, workQd: 1 });
});
assert.equal(validateHybridLaborHolding(reload().holdings[0], { targets: buildWorkAllocationTargets(reload().holdings[0]) }).ok, true);
writeCount = writes.length;
await assert.rejects(editor._updateMutableBuilding(({ building }) => { building.productionLines = []; }), /недоступна/);
assert.equal(writes.length, writeCount, "Deleting a restored contracted line is a new error and cannot persist");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkBuildingEditorPersistence();
  console.log("Building editor persistence: template and instance edits survive split-storage reload; read-only edits blocked.");
}
