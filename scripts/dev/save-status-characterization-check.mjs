import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SaveStatus, syncSaveStatus } from "../apps/common/save-status.js";
import { DisclosureState } from "../apps/common/disclosure-state.js";
import { SkyholdData } from "../data/store.js";
import { cloneDefaultRandomEventTables } from "../data/random-events.js";
import { stableDataHash } from "../data/storage-commit.js";
import { captureResidentEditorDraft, ResidentEventDomain } from "../apps/domains/events/resident-events.js";
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
const methods = { get: SkyholdData.get, transaction: SkyholdData.transaction, updateHolding: SkyholdData.updateHolding,
  skipTransaction: SkyholdData.skipTransaction };
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

  const field = { dataset: { field: "holdings.0.people.list.0.name" }, value: "Старое имя", type: "text" };
  const editor = { dataset: { holdingId: "holding", residentId: "person" },
    querySelectorAll: selector => selector === "[data-field]" ? [field] : [], querySelector: () => null };
  const manager = { _canManagePeople: () => true, _canPlayerWriteFieldPath: () => true,
    _resolveActiveHoldingScopedPath: (_data, path) => path };
  const event = { currentTarget: { closest: () => editor } };
  const initialPerson = { id: "person", name: field.value };
  captureResidentEditorDraft(editor, initialPerson);
  field.value = "Руна";
  SkyholdData.get = () => ({ holdings: [{ id: "holding", people: { list: [initialPerson] } }] });
  SkyholdData.transaction = async () => null;
  assert.equal(await ResidentEventDomain._savePersonEditorDraft.call(manager, event), false, "missing resident/refused transaction must block close and success");
  SkyholdData.transaction = async () => ({ saved: true, person: { ...initialPerson, name: field.value } });
  assert.equal(await ResidentEventDomain._savePersonEditorDraft.call(manager, event), true);
  const allocationEvent = { preventDefault() {}, currentTarget: { dataset: { allocationId: "allocation" }, closest: () => editor } };
  const allocationManager = { _canEditBuildings: () => true, _savePersonEditorDraft: async () => true, requestRender() {} };
  for (const method of ["_onAddWorkAllocation", "_onRemoveWorkAllocation"]) {
    SkyholdData.transaction = async () => false;
    assert.equal(await ResidentEventDomain[method].call(allocationManager, allocationEvent), false, "allocation refusal must reach the editor status");
    SkyholdData.transaction = async () => true;
    assert.equal(await ResidentEventDomain[method].call(allocationManager, allocationEvent), true);
  }

  {
    const skipped = Symbol("skipped");
    const person = { id: "person", name: "Старое имя", appearance: "Старое описание" };
    const live = { holdings: [{ id: "holding", people: { list: [person] } }] };
    const name = { ...field, value: person.name };
    const appearance = { dataset: { field: "holdings.0.people.list.0.appearance" }, value: person.appearance, type: "text" };
    const profile = { ...editor, closest: () => profile,
      querySelectorAll: (selector) => selector === "[data-field]" ? [name, appearance] : [] };
    captureResidentEditorDraft(profile, person);
    const app = new SkyholdResidentEditor({ holdingId: "holding", personId: "person" });
    app.element = { querySelector: (selector) => selector === ".fbls-person-editor.v2" ? profile : null };
    app._manager = () => ({ ...ResidentEventDomain, ...manager });
    let renders = 0;
    app.requestRender = () => { renders++; };
    SkyholdData.get = () => structuredClone(live);
    SkyholdData.skipTransaction = (value) => ({ [skipped]: true, value });
    let writes = 0;
    let gate = deferred();
    SkyholdData.transaction = async (updater) => {
      const wait = gate;
      writes++;
      if (wait) { gate = null; await wait.promise; }
      const result = await updater(live);
      return result?.[skipped] ? result.value : result;
    };

    const firstGate = gate;
    name.value = "Новое имя";
    const firstEdit = app._saveDraft(profile, { render: true });
    appearance.value = "Новое описание";
    app._saveStatus.markDirty();
    const secondEdit = app._saveDraft(profile);
    const closing = app.close();
    await Promise.resolve();
    assert.equal(writes, 1, "a queued draft must not read the resident revision before the previous write");
    assert.equal(renders, 0, "a render must wait for the queued form edits");
    assert.notEqual(app.closed, true);
    firstGate.resolve();
    assert.deepEqual(await Promise.all([firstEdit, secondEdit]), [true, true], "the editor must not conflict with its own first save");
    await closing;
    assert.equal(app.closed, true);
    assert.equal(app._saveStatus.context.state, "saved");
    assert.equal(renders, 1);
    assert.equal(writes, 2, "closing a confirmed draft must not submit the form again");
    assert.deepEqual([person.name, person.appearance], ["Новое имя", "Новое описание"]);

    app.closed = false;
    const conflict = deferred();
    gate = conflict;
    name.value = "Несохранённое имя";
    const staleEdit = app._saveDraft(profile);
    const pendingEdit = app._saveDraft(profile);
    const refusedClose = app.close();
    person.name = "Имя от другого клиента";
    conflict.resolve();
    assert.deepEqual(await Promise.all([staleEdit, pendingEdit]), [false, false]);
    await refusedClose;
    assert.equal(writes, 3, "a queued save must not overwrite a detected external conflict");
    assert.equal(person.name, "Имя от другого клиента");
    assert.equal(app._saveStatus.context.state, "error");
    assert.equal(app.closed, false);
    SkyholdResidentEditor.instances.delete(app);
    SkyholdData.skipTransaction = methods.skipTransaction;
  }

  {
    const person = { id: "person", name: "Руна", notes: "Старая заметка", workAllocations: [
      { id: "farm", normalQd: 5 }, { id: "forge", normalQd: 7 }
    ] };
    const live = { holdings: [{ id: "holding", people: { list: [person] } }] };
    const name = { ...field, value: person.name };
    const notes = { dataset: { field: "holdings.0.people.list.0.notes" }, value: person.notes };
    const allocation = { dataset: { field: "holdings.0.people.list.0.workAllocations.0.normalQd", type: "number" }, value: "5" };
    const profile = { ...editor, closest: () => profile,
      querySelectorAll: selector => selector === "[data-field]" ? [name, notes, allocation] : [] };
    captureResidentEditorDraft(profile, person);
    SkyholdData.get = () => structuredClone(live);
    SkyholdData.transaction = async (updater) => updater(live);
    person.notes = "Заметка второго ГМа";
    person.workAllocations.reverse();
    name.value = "Руна Каменщик";
    allocation.value = "6";
    const save = () => ResidentEventDomain._savePersonEditorDraft.call(manager, { currentTarget: profile });
    assert.equal(await save(), true);
    assert.deepEqual([person.name, person.notes], ["Руна Каменщик", "Заметка второго ГМа"], "a different field edit retains the already saved note");
    assert.deepEqual(person.workAllocations.map(({ id, normalQd }) => [id, normalQd]), [["forge", 7], ["farm", 6]],
      "the visible allocation remains bound to its ID after reordering");
    notes.value = "Моя правка старой заметки";
    assert.equal(await save(), false, "an edit based on a stale value of the same field is refused");
    assert.equal(person.notes, "Заметка второго ГМа");
    assert.equal(notes.value, "Моя правка старой заметки", "refusal retains the draft for recovery");
  }

  {
    const { workerAdmission } = await import("../engines/workers/building-qualification.js");
    const priorUser = game.user;
    const building = { id: "workshop", name: "Кузница", constructionStatus: "built",
      functions: { production: true }, productionLines: [{ id: "smithing", active: true, source: "workers" }],
      workerProfile: { admission: { hard: true, text: "СИЛ 4+", clauses: [[{ attribute: "strength", minimum: 4 }]] } } };
    const resident = { id: "worker", name: "Руна", age: 30, attributes: { strength: 2 },
      workAllocationMode: "explicit", workAllocations: [{ id: "shift", sourceId: building.id, functionId: "production:smithing", normalQd: 2 }] };
    const name = { ...field, value: resident.name };
    const amount = { dataset: { field: "holdings.0.people.list.0.workAllocations.0.normalQd", type: "number" }, value: "2" };
    const profile = { ...editor, dataset: { holdingId: "shift", residentId: resident.id }, closest: () => profile,
      querySelectorAll: selector => selector === "[data-field]" ? [name, amount] : [] };
    const live = { holdings: [{ id: "shift", visibility: "public",
      gm: { playersCanEditResidents: true, playersCanEditBuildings: true }, buildings: { list: [building] }, people: { list: [resident] } }] };
    const priorUsers = game.users;
    const priorSocket = game.socket;
    game.user = { id: "player", isGM: false };
    game.users = [{ id: "gm", active: true, isGM: true }];
    game.socket = { emit() {} };
    try {
      SkyholdData.get = () => structuredClone(live);
      SkyholdData.transaction = async (updater) => updater(live);
      const editorManager = { ...manager, _buildingWorkerAdmission: workerAdmission };
      assert.equal(workerAdmission(building, resident).hard, true);
      assert.equal(workerAdmission(building, resident).eligible, false);
      captureResidentEditorDraft(profile, resident);
      name.value = "Руна Кузнец";
      const save = () => ResidentEventDomain._savePersonEditorDraft.call(editorManager, { currentTarget: profile });
      assert.equal(await save(), true, "an existing admission problem cannot block the resident's unrelated name edit");
      assert.equal(resident.name, name.value);
      assert.equal(resident.workAllocations[0].normalQd, 2);
      assert.equal(building.workerAdmissionOverrideIds, undefined);
      amount.value = "3";
      assert.equal(await save(), false, "extending the same ineligible assignment is a new violation");
      assert.equal(resident.workAllocations[0].normalQd, 2);
    } finally {
      game.user = priorUser;
      game.users = priorUsers;
      game.socket = priorSocket;
    }
  }

  // The work select contains the current foreman role. A routine save must not
  // clear it as though it were an unknown building, including during injury.
  game.users = [{ id: "gm", active: true, isGM: true }];
  game.socket = { emit() {} };
  for (const isGM of [true, false]) {
    globalThis.game.user.isGM = isGM;
    const person = { id: "foreman", name: "Руна", injuredDays: 3, salary: 18,
      workAssignment: "construction-leader:crew", workAllocationMode: "legacy", role: "Руководитель: Каменщики" };
    const leaderHolding = { id: "holding", gm: { playersCanEditResidents: true, playersCanEditBuildings: true },
      people: { list: [person] }, buildings: { list: [] },
      constructionCrews: [{ id: "crew", name: "Каменщики", memberIds: [], leaderId: person.id }] };
    const leaderData = { holdings: [leaderHolding] };
    SkyholdData.get = () => leaderData;
    SkyholdData.transaction = async (updater, options) => {
      assert.equal(options.scope, "holdings", "GM and player edits retain the transaction/authority path");
      return updater(leaderData);
    };
    const leaderManager = { ...AssignmentDomain, ...ResidentEventDomain, ...manager, requestRender() {} };
    const nameField = { dataset: { field: "holdings.0.people.list.0.name" }, value: person.name, type: "text" };
    const residentRow = { dataset: { holdingId: "holding", id: "foreman" } };
    const workField = { dataset: { workAssignmentField: "holdings.0.people.list.0.workAssignment" }, value: person.workAssignment,
      closest: () => residentRow };
    const leaderEditor = { dataset: { holdingId: "holding", residentId: "foreman" },
      querySelectorAll: selector => selector === "[data-field]" ? [nameField] : [],
      querySelector: selector => selector === "[data-work-assignment-field]" ? workField : null };
    captureResidentEditorDraft(leaderEditor, person);
    nameField.value = "Руна Каменщик";
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
  delete game.users;
  delete game.socket;

  {
    let live = { holdings: ["a", "b"].map(id => ({
      id, people: { list: [{ id: "resident", name: id, workAssignment: `current-${id}` }] },
      buildings: { list: [{ id: "job", assignedWorkerIds: [], workersMax: 1, name: "Кузня" }] }
    })) };
    const approval = deferred();
    const skipped = Symbol("skipped");
    SkyholdData.skipTransaction = (value) => ({ [skipped]: true, value });
    SkyholdData.get = () => structuredClone(live);
    SkyholdData.transaction = async (updater) => {
      const draft = structuredClone(live);
      const result = await updater(draft);
      if (result?.[skipped]) return result.value;
      live = draft;
      return result;
    };
    const worker = { ...AssignmentDomain, ...ResidentEventDomain, ...manager, activeHoldingId: "a", requestRender() {},
      _safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
      _workAssignmentAdmissionDecision: () => approval.promise };
    const row = { dataset: { holdingId: "a", id: "resident" } };
    const changeWork = { preventDefault() {}, currentTarget: { value: "job", closest: () => row,
      dataset: { workAssignmentField: "holdings.0.people.list.0.workAssignment" } } };
    const assigning = worker._onWorkAssignmentChange(changeWork);
    worker.activeHoldingId = "b";
    live.holdings.reverse();
    approval.resolve({ allowed: true });
    await assigning;
    assert.deepEqual(live.holdings.map(item => item.people.list[0].workAssignment), ["current-b", "job"]);
    changeWork.currentTarget.value = "vanished-job";
    await worker._onWorkAssignmentChange(changeWork);
    assert.equal(live.holdings[1].people.list[0].workAssignment, "job", "a failed transfer preserves the resident's existing assignment");

    const profile = { ...editor, dataset: { holdingId: "a", residentId: "resident" } };
    const proposedName = field.value;
    field.value = live.holdings[1].people.list[0].name;
    captureResidentEditorDraft(profile, live.holdings[1].people.list[0]);
    field.value = proposedName;
    const save = worker._savePersonEditorDraft({ currentTarget: { closest: () => profile } });
    assert.equal(await save, true);
    assert.equal(live.holdings[0].people.list[0].name, "b");
    assert.equal(live.holdings[1].people.list[0].name, field.value);
    assert.equal(live.holdings[1].people.list[0].workAssignment, "job");
    SkyholdData.skipTransaction = methods.skipTransaction;
  }

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
