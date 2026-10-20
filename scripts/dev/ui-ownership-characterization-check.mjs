import { SaveStatus } from "../apps/common/save-status.js";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createGmWriteAuthority } from "../data/gm-write-authority.js";
import { createWriteQueue } from "../data/write-queue.js";
import { assertAvailableEntityId, assertNoNewEntityCollisions } from "../data/entity-identity.js";
import { DEFAULT_SKYHOLD_DATA } from "../data/defaults/default-skyhold-data.js";
import { migrateData } from "../data/normalizers.js";
import { clone } from "../data/utils.js";
import { createSkyholdSplitStorage } from "../data/split-storage.js";
import { SETTING_META, SETTING_HOLDINGS, SETTING_CATALOG, SETTING_DATA } from "../data/constants.js";
import { normalizeRandomEventTables } from "../data/random-events.js";
import { stableDataHash } from "../data/storage-commit.js";
import { RenderSchedulerMixin } from "../apps/common/render-scheduler.js";
import { buildPlayerPatch } from "../data/player-write-guard.js";

export async function checkUiOwnership() {
  const saved = { game: globalThis.game, foundry: globalThis.foundry, ui: globalThis.ui,
    frame: globalThis.requestAnimationFrame, hooks: globalThis.Hooks };
  const gm = { id: "gm-a", isGM: true, active: true };
  const second = { id: "gm-b", isGM: true, active: true };
  const player = { id: "player", isGM: false, active: true };
  const users = new Map([gm, second, player].map((row) => [row.id, row]));
  let id = 0;
  try {
    globalThis.game = { user: gm, users: { contents: [...users.values()], get: (key) => users.get(key) } };
    globalThis.foundry = { applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (Base) => Base } },
      utils: { randomID: () => `fixture-${++id}`, setProperty(object, dottedPath, value) {
        const keys = dottedPath.split("."); const last = keys.pop();
        keys.reduce((row, key) => row[key], object)[last] = value;
      } } };
    globalThis.ui = { notifications: { warn() {}, info() {} } };
    globalThis.Hooks = { callAll() {} };
    let data = migrateData(clone(DEFAULT_SKYHOLD_DATA));
    data.meta.revision = 7;
    let writes = 0;
    const responses = [];
    const writer = createGmWriteAuthority({ getData: () => data, enqueueWrite: createWriteQueue(),
      persistData: async (next) => { data = clone(next); writes++; return { data, changed: true }; },
      notifyChanged() {}, user: () => gm, authority: () => gm, sender: (key) => users.get(key),
      socket: () => ({ emit: (_channel, payload) => responses.push(payload) }) });
    const a = clone(data); a.meta.revision = 8; a.holdings[0].name = "A";
    const b = clone(data); b.meta.revision = 8; b.holdings[0].gm.notes = "B";
    const request = (operationId, draft, userId = second.id) => ({ type: "gmCommitRequest", operationId,
      requestId: operationId, userId, targetGmId: gm.id, expectedRevision: 7, scope: "holdings", data: draft });
    await Promise.all([writer.handle(request("a", a), second.id), writer.handle(request("b", b), second.id)]);
    assert.equal(writes, 1, "overlapping GM drafts must share one authority queue");
    assert.equal(data.holdings[0].name, "A");
    assert.equal(responses[1].command.code, "conflict", "stale draft must fail instead of overwriting A");
    await writer.handle(request("a", a), second.id);
    assert.equal(writes, 1, "transport retry must reuse its receipt");
    await writer.handle(request("a", b), second.id);
    assert.equal(responses.at(-1).command.code, "conflict", "retry with changed payload must fail");
    const responseCount = responses.length;
    await writer.handle(request("spoof", a), player.id);
    await writer.handle(request("player", a, player.id), player.id);
    assert.equal(responses.length, responseCount, "players cannot impersonate or submit full GM commits");
    await assert.rejects(writer.requestCommit(b, { baseRevision: 7, scope: "holdings" }), { code: "conflict" });
    let transported;
    const remote = createGmWriteAuthority({ user: () => second, authority: () => gm, sender: (key) => users.get(key),
      socket: () => ({ emit: (_channel, payload) => { transported = payload; } }), timeoutMs: 1000 });
    const draft = clone(data); draft.meta.revision = 9;
    const wait = remote.requestCommit(draft, { baseRevision: 8, scope: "holdings" });
    await remote.handle({ type: "gmCommitResponse", requestId: transported.requestId,
      operationId: transported.operationId, userId: second.id, gmId: gm.id,
      command: { ok: true, operationId: transported.operationId, revision: 9 }, meta: draft.meta }, player.id);
    await writer.handle(transported, second.id);
    await remote.handle(responses.at(-1), gm.id);
    assert.equal((await wait).meta.revision, 9, "authenticated authority receipt must resolve the requesting GM");
    assert.equal(writes, 2);

    const rows = [{ id: "a" }, { id: "b" }];
    assert.throws(() => assertAvailableEntityId(rows, "b", { current: rows[0] }), { code: "conflict" });
    assert.equal(assertAvailableEntityId(rows, " a ", { current: rows[0] }), "a");
    const existingDuplicates = { holdings: [{ id: "legacy" }, { id: "legacy" }] };
    assert.doesNotThrow(() => assertNoNewEntityCollisions(existingDuplicates, clone(existingDuplicates)), "unrelated saves preserve legacy duplicates");
    assert.throws(() => assertNoNewEntityCollisions({}, existingDuplicates), { code: "conflict" });
    const nestedLegacyDuplicates = { holdings: [{ id: "legacy" }, { id: "legacy", people: { list: [{ id: "p" }, { id: "p" }] } }] };
    assert.doesNotThrow(() => assertNoNewEntityCollisions(nestedLegacyDuplicates, clone(nestedLegacyDuplicates)),
      "legacy holdings with different nested duplicates retain their own comparison baseline");

    const settings = new Map([[SETTING_META, clone(data.meta)], [SETTING_HOLDINGS, clone(data.holdings)],
      [SETTING_CATALOG, clone(data.catalog)], [SETTING_DATA, clone(data)]]);
    const storage = createSkyholdSplitStorage({ settings: { get: (_module, key) => clone(settings.get(key)),
      set: async (_module, key, value) => settings.set(key, clone(value)) } });
    const view = storage.getDataView();
    assert.throws(() => { view.holdings[0].name = "illegal"; }, TypeError);
    const mutable = storage.getData(); mutable.holdings[0].name = "draft";
    assert.notEqual(storage.getDataView().holdings[0].name, "draft", "get still returns an editable isolated draft");

    const { SkyholdRandomEventEditor } = await import("../apps/editors/random-event-editor.js");
    const { SkyholdData, handleSkyholdSocketPayload } = await import("../data/store.js");
    // Use the public store boundary as well as the isolated transport implementation.
    globalThis.game.settings = { get: (_module, key) => clone(settings.get(key)),
      set: async (_module, key, value) => { settings.set(key, clone(value)); return value; } };
    const storeResponses = [];
    globalThis.game.socket = { emit: (_channel, payload) => storeResponses.push(payload) };
    const staleRoot = SkyholdData.get();
    await SkyholdData.updateHolding(staleRoot.holdings[0].id, (row) => { row.gm.notes = "newer store edit"; });
    await assert.rejects(SkyholdData.set(staleRoot), { code: "conflict" }, "set must retain the revision of its input snapshot");
    const permitted = SkyholdData.get();
    permitted.holdings[0].visibility = "public";
    permitted.holdings[0].gm.playersCanEditOverview = true;
    await SkyholdData.set(permitted);
    const beforePlayer = SkyholdData.get();
    const playerDraft = clone(beforePlayer); playerDraft.holdings[0].overview.publicNotes = "Authenticated player note";
    await handleSkyholdSocketPayload({ type: "playerDataPatchRequest", requestId: "player-patch", operationId: "player-patch",
      userId: player.id, targetGmId: gm.id, patch: buildPlayerPatch(beforePlayer, playerDraft) }, player.id);
    assert.equal(storeResponses.at(-1)?.command?.ok, true, "public socket wrapper must forward the trusted sender ID");
    assert.equal(SkyholdData.view().holdings[0].overview.publicNotes, "Authenticated player note");

    const { HoldingDomain } = await import("../apps/domains/holding-domain.js");
    const scopedData = { holdings: [{ id: "first", name: "First" }, { id: "second", name: "Second" }] };
    const originalTransaction = SkyholdData.transaction;
    const originalView = SkyholdData.view;
    let queuedUpdate;
    const manager = { ...HoldingDomain, activeHoldingId: "second", requestRender() {} };
    try {
      SkyholdData.view = () => scopedData;
      SkyholdData.transaction = async (update) => { queuedUpdate = update; return true; };
      await manager._updateActiveHoldingPath("holdings.1.name", "captured");
      manager.activeHoldingId = "first";
      queuedUpdate(scopedData);
      assert.equal(scopedData.holdings[1].name, "captured", "queued changes retain the original holding ID");
      assert.equal(scopedData.holdings[0].name, "First");
      scopedData.holdings.splice(1, 1);
      assert.notEqual(queuedUpdate(scopedData), true, "a deleted target must skip instead of using the first holding");
      assert.equal(scopedData.holdings[0].name, "First");
    } finally { SkyholdData.transaction = originalTransaction; SkyholdData.view = originalView; }

    let authorityChecks = 0;
    const interruptedWrites = [];
    const interrupted = createSkyholdSplitStorage({ settings: { get: (_module, key) => clone(settings.get(key)),
      set: async (_module, key) => { interruptedWrites.push(key); } }, assertWriteAuthority() {
      if (++authorityChecks > 1) throw Object.assign(new Error("authority changed"), { code: "authority-offline" });
    } });
    const interruptedDraft = interrupted.getData(); interruptedDraft.holdings[0].name = "interrupted";
    interruptedDraft.meta.revision++;
    await assert.rejects(interrupted.persistData(interruptedDraft, { normalized: true, scope: "holdings" }), { code: "authority-offline" });
    assert.deepEqual(interruptedWrites, [SETTING_META], "handoff stops further setting writes after the pending marker");
    const updateHolding = SkyholdData.updateHolding;
    const holding = clone(data.holdings[0]);
    const tables = normalizeRandomEventTables(holding.gm.eventTables);
    holding.gm.eventTables = clone(tables);
    const editor = Object.create(SkyholdRandomEventEditor.prototype);
    Object.assign(editor, { holdingId: holding.id, _draftSourceHash: stableDataHash(tables),
      _saveStatus: new SaveStatus({ mode: "manual" }), _dirty: true, _commitOpenEditors() {}, _ensureDraftTables: () => clone(tables) });
    let eventWrites = 0;
    try {
      SkyholdData.updateHolding = async (_key, update) => { const result = update(holding);
        if (result === true) eventWrites++; return result === true; };
      holding.gm.eventTables.general.title = "New external title";
      await editor._saveDraftTables({ render: false });
      assert.equal(holding.gm.eventTables.general.title, "New external title");
      assert.equal(editor._dirty, true, "conflict must preserve the draft");
      assert.equal(eventWrites, 0);
      holding.gm.eventTables = clone(tables);
      holding.gm.notes = "unrelated";
      await editor._saveDraftTables({ render: false });
      assert.equal(eventWrites, 1, "an unrelated holding change must not invalidate event tables");
    } finally { SkyholdData.updateHolding = updateHolding; }

    let frame;
    let renders = 0;
    globalThis.requestAnimationFrame = (callback) => { frame = callback; return 1; };
    const App = RenderSchedulerMixin(class { render() { renders++; } async _onClose() {} });
    const app = new App();
    const scheduled = app.requestRender();
    await app._onClose({}); await frame(); await scheduled;
    assert.equal(renders, 0, "a closed generation must cancel a queued render");
    assert.equal(app.requestRender(), null, "late async completion must not reopen a closed window");
    app.render();
    const reopened = app.requestRender(); await frame(); await reopened;
    assert.equal(renders, 2, "explicit reopening restores render scheduling");
    const frames = [];
    globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
    const race = new App();
    const oldQueue = race.requestRender(); await race._onClose({});
    race.render(); const newQueue = race.requestRender();
    await frames[0](); await oldQueue;
    await frames[1](); await newQueue;
    assert.equal(renders, 4, "an old cancelled frame must not clear the reopened window's new queue");
  } finally {
    globalThis.game = saved.game; globalThis.foundry = saved.foundry; globalThis.ui = saved.ui;
    globalThis.requestAnimationFrame = saved.frame;
    globalThis.Hooks = saved.hooks;
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkUiOwnership();
  console.log("UI ownership: GM queue/auth/replay/conflict, identity, frozen view, event drafts and close generation passed.");
}
