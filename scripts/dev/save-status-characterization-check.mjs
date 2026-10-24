import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SaveStatus, syncSaveStatus } from "../apps/common/save-status.js";
import { DisclosureState } from "../apps/common/disclosure-state.js";
import { SkyholdData } from "../data/store.js";
import { cloneDefaultRandomEventTables } from "../data/random-events.js";
import { stableDataHash } from "../data/storage-commit.js";
import { ResidentEventDomain } from "../apps/domains/events/resident-events.js";
import { AssignmentDomain } from "../apps/domains/assignment-domain.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const status = new SaveStatus();
assert.equal(status.context.state, "saved");
status.markDirty("name");
const gate = deferred();
const saving = status.track(() => gate.promise, { key: "name" });
assert.equal(status.context.state, "saving");
status.markDirty("name");
gate.resolve(true);
await saving;
assert.equal(status.context.state, "dirty", "an acknowledged older value cannot acknowledge new input");
await status.track(() => false, { key: "name" });
assert.equal(status.context.state, "error", "a skipped or rejected write is not a success");
await status.track(() => true, { key: "salary" });
assert.equal(status.context.state, "error", "saving another field cannot clear an earlier failure");
await status.track(() => true, { key: "name" });
assert.equal(status.context.state, "saved", "retry acknowledges the failed field");
const older = deferred();
const olderAttempt = status.track(() => older.promise, { key: "name" });
await status.track(() => true, { key: "name" });
older.reject(new Error("old request failed"));
await assert.rejects(olderAttempt, /old request failed/);
assert.equal(status.context.state, "saved", "obsolete completion cannot overwrite the latest attempt");
await assert.rejects(status.track(() => { throw new Error("write failed"); }), /write failed/);
assert.equal(status.context.state, "error");
const chip = { dataset: {}, setAttribute(name, value) { this[name] = value; } }, button = {};
syncSaveStatus({ querySelectorAll: selector => selector === "[data-save-status]" ? [chip] : [button] }, status);
assert.match(chip.textContent, /Авто · Ошибка/);
assert.match(chip.dataset.fblsTooltip, /не сохранено/);
assert.equal(chip["aria-label"], chip.textContent, "tooltip fallback must not leave an obsolete accessible status");

class Detail extends globalThis.EventTarget {
  constructor(key, open) { super(); this.dataset = { gmSection: key }; this.open = open; }
}
const disclosures = new DisclosureState();
const first = new Detail("service", false);
disclosures.bind({ querySelectorAll: () => [first] });
first.open = true; // Capture must work even before an asynchronous native toggle fires.
const second = new Detail("service", false);
disclosures.bind({ querySelectorAll: () => [second] });
assert.equal(second.open, true);
first.open = false;
first.dispatchEvent(new Event("toggle"));
assert.equal(disclosures.states.get("service"), true, "removed DOM listeners must be aborted");
second.open = false;
second.dispatchEvent(new Event("toggle"));
disclosures.bind({ querySelectorAll: () => [] });
const third = new Detail("service", true);
disclosures.bind({ querySelectorAll: () => [third] });
assert.equal(third.open, false, "changing tabs must retain the disclosure choice");
disclosures.close();
assert.equal(disclosures.elements.length, 0);

const gmTemplate = readFileSync(new URL("../../templates/parts/skyhold-tab-gm.hbs", import.meta.url), "utf8");
const blocks = [], groups = [];
for (const token of gmTemplate.matchAll(/{{([#/])(\w+)\s*([^}]*?)}}|data-gm-section="([^"]+)"/g)) {
  const [, marker, name, argument, group] = token;
  if (group) {
    groups.push(group);
    assert.deepEqual(blocks, [{ name: "if", argument: "active.gm" }], "GM groups must render independently of lastRoll/eventSchedule and remain in the GM gate");
  } else if (marker === "#") blocks.push({ name, argument: argument.trim() });
  else assert.equal(blocks.pop()?.name, name, "GM Handlebars blocks must remain balanced");
}
assert.deepEqual(groups, ["actions", "catalogs", "balance", "service"]);
assert.equal(blocks.length, 0);

const globals = { foundry: globalThis.foundry, game: globalThis.game, ui: globalThis.ui, HTMLTextAreaElement: globalThis.HTMLTextAreaElement };
const methods = { get: SkyholdData.get, transaction: SkyholdData.transaction, updateHolding: SkyholdData.updateHolding };
const originalError = console.error;
try {
  class Base {
    async _prepareContext() { return {}; }
    async _preClose() {}
    async close(options) { await this._preClose(options); this.closed = true; return this; }
  }
  globalThis.foundry = { applications: { api: { ApplicationV2: Base, HandlebarsApplicationMixin: Parent => Parent } },
    utils: { setProperty(object, path, value) {
      const parts = path.split(".");
      const last = parts.pop();
      let target = object;
      for (const part of parts) target = target[part] ??= {};
      target[last] = value;
    } } };
  globalThis.game = { user: { isGM: true } };
  globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };
  globalThis.HTMLTextAreaElement = class {};
  const { SkyholdBuildingEditor } = await import("../apps/editors/building-editor.js");
  const building = new SkyholdBuildingEditor();
  const options = { reason: "building-editor:field:name", scope: "holdings" };
  SkyholdData.transaction = async (_updater, actualOptions) => { assert.deepEqual(actualOptions, options); return false; };
  assert.equal(await building._saveTransaction(() => true, options), false);
  assert.equal(building._saveStatus.context.state, "error");
  await building.close();
  assert.notEqual(building.closed, true, "a settled refused autosave must retain the editor");
  SkyholdData.transaction = async () => true;
  await building._saveTransaction(() => true, options);
  assert.equal(building._saveStatus.context.state, "saved");
  SkyholdData.transaction = async () => { throw new Error("already offline"); };
  await assert.rejects(building._saveTransaction(() => true, options), /already offline/);
  assert.equal(building._pendingFieldSaves.size, 0, "the failed promise has already left the pending set");
  await building.close();
  assert.notEqual(building.closed, true, "a failure before close must retain the editor");
  SkyholdData.transaction = async () => true;
  await building._saveTransaction(() => true, { ...options, reason: "building-editor:field:other" });
  await building.close();
  assert.notEqual(building.closed, true, "saving another field cannot permit loss of the failed field");
  await building._saveTransaction(() => true, options);
  const pendingSave = deferred();
  SkyholdData.transaction = () => pendingSave.promise;
  const failedSave = building._saveTransaction(() => true, options);
  const failedSaveAssertion = assert.rejects(failedSave, /offline/);
  const pendingClose = building.close();
  await Promise.resolve();
  assert.notEqual(building.closed, true, "closing the building editor must wait for an in-flight autosave");
  pendingSave.reject(new Error("offline"));
  await Promise.all([failedSaveAssertion, pendingClose]);
  assert.notEqual(building.closed, true, "an autosave failure during close must retain the building draft");
  assert.equal(building._saveStatus.context.state, "error");
  const retrySave = deferred();
  SkyholdData.transaction = () => retrySave.promise;
  const retry = building._saveTransaction(() => true, options);
  const retryClose = building.close();
  await Promise.resolve();
  assert.notEqual(building.closed, true);
  retrySave.resolve(true);
  await Promise.all([retry, retryClose]);
  assert.equal(building.closed, true, "successful retry permits closing after confirmation");
  SkyholdBuildingEditor.instances.delete(building);

  const { SkyholdResidentEditor } = await import("../apps/editors/resident-editor.js");
  const resident = new SkyholdResidentEditor();
  resident._manager = () => ({ _savePersonEditorDraft: async () => false });
  assert.equal(await resident._saveDraft(), false);
  assert.equal(resident._saveStatus.context.state, "error");
  resident._manager = () => ({ _savePersonEditorDraft: async () => true });
  assert.equal(await resident._saveDraft(), true);
  assert.equal(resident._saveStatus.context.state, "saved");
  SkyholdResidentEditor.instances.delete(resident);

  const field = { dataset: { field: "holdings.0.people.list.0.name" }, value: "Руна", type: "text" };
  const editor = { querySelectorAll: selector => selector === "[data-field]" ? [field] : [], querySelector: () => null };
  const manager = { _canManagePeople: () => true, _canPlayerWriteFieldPath: () => true,
    _resolveActiveHoldingScopedPath: (_data, path) => path };
  const event = { currentTarget: { closest: () => editor } };
  SkyholdData.get = () => ({ holdings: [{ people: { list: [{ id: "person", name: "Руна" }] } }] });
  SkyholdData.transaction = async () => null;
  assert.equal(await ResidentEventDomain._savePersonEditorDraft.call(manager, event), false, "missing resident/refused transaction must block close and success");
  SkyholdData.transaction = async () => ({ warnNoSlot: false });
  assert.equal(await ResidentEventDomain._savePersonEditorDraft.call(manager, event), true);
  const allocationEvent = { preventDefault() {}, currentTarget: { dataset: { personId: "person", allocationId: "allocation" } } };
  const allocationManager = { _canManagePeople: () => true, _savePersonEditorDraft: async () => true,
    _updateActiveHolding: async () => false, requestRender() {} };
  for (const method of ["_onAddWorkAllocation", "_onRemoveWorkAllocation"]) {
    assert.equal(await ResidentEventDomain[method].call(allocationManager, allocationEvent), false, "allocation refusal must reach the editor status");
    allocationManager._updateActiveHolding = async () => true;
    assert.equal(await ResidentEventDomain[method].call(allocationManager, allocationEvent), true);
    allocationManager._updateActiveHolding = async () => false;
  }

  // The work select contains the current foreman role. A routine save must not
  // clear it as though it were an unknown building, including during injury.
  for (const isGM of [true, false]) {
    globalThis.game.user.isGM = isGM;
    const person = { id: "foreman", name: "Руна", injuredDays: 3, salary: 18,
      workAssignment: "construction-leader:crew", workAllocationMode: "legacy", role: "Руководитель: Каменщики" };
    const leaderHolding = { people: { list: [person] }, buildings: { list: [] },
      constructionCrews: [{ id: "crew", name: "Каменщики", memberIds: [], leaderId: person.id }] };
    const leaderData = { holdings: [leaderHolding] };
    SkyholdData.get = () => leaderData;
    SkyholdData.transaction = async (updater, options) => {
      assert.equal(options.scope, "holdings", "GM and player edits retain the transaction/authority path");
      return updater(leaderData);
    };
    const leaderManager = { ...AssignmentDomain, ...ResidentEventDomain, ...manager, requestRender() {} };
    const nameField = { dataset: { field: "holdings.0.people.list.0.name" }, value: "Руна Каменщик", type: "text" };
    const workField = { dataset: { workAssignmentField: "holdings.0.people.list.0.workAssignment" }, value: person.workAssignment };
    const leaderEditor = { querySelectorAll: selector => selector === "[data-field]" ? [nameField] : [],
      querySelector: selector => selector === "[data-work-assignment-field]" ? workField : null };
    const leaderEvent = { currentTarget: { closest: () => leaderEditor } };
    assert.equal(await leaderManager._savePersonEditorDraft(leaderEvent), true);
    assert.equal(person.name, "Руна Каменщик");
    assert.equal(person.workAssignment, "construction-leader:crew");
    assert.equal(leaderHolding.constructionCrews[0].leaderId, person.id);
    assert.equal(person.salary, 18, "unchanged leadership must not reset salary");
    await leaderManager._onWorkAssignmentChange({ preventDefault() {}, currentTarget: workField });
    assert.equal(leaderHolding.constructionCrews[0].leaderId, person.id, "selecting the current role is harmless");
    workField.value = "";
    assert.equal(await leaderManager._savePersonEditorDraft(leaderEvent), true);
    assert.equal(person.workAssignment, "", "a deliberate reassignment still releases the leader");
    assert.equal(leaderHolding.constructionCrews[0].leaderId, "");
  }
  globalThis.game.user.isGM = true;

  const { SkyholdRandomEventEditor } = await import("../apps/editors/random-event-editor.js");
  const events = new SkyholdRandomEventEditor({ holdingId: "holding" });
  const tables = cloneDefaultRandomEventTables();
  events._draftTables = structuredClone(tables);
  events._draftSourceHash = stableDataHash(tables);
  events._ensureDraftTables = () => events._draftTables;
  events._requestRenderPreservingPosition = () => {};
  const holding = { gm: { eventTables: tables } };
  const saveGate = deferred();
  let writes = 0;
  SkyholdData.updateHolding = async (_id, updater) => { writes++; await saveGate.promise; return updater(holding); };
  const beforeTitle = events._draftTables.general.rows[0].title;
  events._markDirty();
  const firstSave = events._saveDraftTables({ render: false });
  const repeatedSave = events._saveDraftTables({ render: false });
  assert.equal(writes, 1, "two windows saving one draft must share the pending write");
  events._draftTables.general.rows[0].title = "Новая правка во время записи";
  events._markDirty();
  saveGate.resolve();
  assert.equal(await firstSave, true);
  assert.equal(await repeatedSave, true);
  assert.equal(holding.gm.eventTables.general.rows[0].title, beforeTitle);
  assert.equal(events._draftTables.general.rows[0].title, "Новая правка во время записи", "a completed save must preserve newer draft edits");
  assert.equal(events._saveStatus.context.state, "dirty");
  assert.equal(events._dirty, true);
  SkyholdData.updateHolding = async (_id, updater) => {
    const result = updater(holding);
    return result?.value === false ? false : result;
  };
  assert.equal(await events._saveDraftTables({ render: false }), true);
  assert.equal(events._saveStatus.context.state, "saved");
  assert.equal(events._dirty, false);
  holding.gm.eventTables.general.rows[0].title = "Другой редактор изменил мир";
  events._markDirty();
  assert.equal(await events._saveDraftTables({ render: false }), false);
  assert.equal(events._saveStatus.context.state, "error", "source revision conflict must preserve error and draft");
  console.error = () => {};
  SkyholdData.updateHolding = async () => { throw new Error("offline storage failure"); };
  const failed = events._saveDraftTables({ render: false });
  const alsoFailed = events._saveDraftTables({ render: false });
  assert.equal(await failed, false);
  assert.equal(await alsoFailed, false, "coalesced failures must be handled for both callers");
  globalThis.game.user.isGM = false;
  writes = 0;
  SkyholdData.updateHolding = async () => { writes++; return true; };
  await events._saveDraftTables();
  assert.equal(writes, 0, "player clients cannot save GM event tables");
  console.log("Save feedback: confirmed/skipped/failed writes, keyed retries, concurrent edits, editor integration, event conflict/GM gate and disclosure lifecycle passed.");
} finally {
  Object.assign(globalThis, globals);
  Object.assign(SkyholdData, methods);
  console.error = originalError;
}
