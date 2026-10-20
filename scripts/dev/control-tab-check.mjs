import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_BUILDING_TEMPLATES } from "../data/building-templates.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { prepareSkyholdCommit } from "../data/commit-preparation.js";
import { buildPlayerPatch, validatePlayerPatch } from "../data/player-write-guard.js";
import { AssignmentDomain } from "../apps/domains/assignment-domain.js";
import { ResidentDomain } from "../apps/domains/resident-domain.js";
import { workerAdmission } from "../engines/workers/building-qualification.js";
import { settlementControlSummary } from "../engines/settlement/control.js";
import { prepareControlContext } from "../apps/domains/control-context.js";
import { executeControlWorkOperation } from "../apps/control-work-executor.js";

const copy = (value) => structuredClone(value);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manager = {
  ...ResidentDomain, ...AssignmentDomain,
  _safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
  _constructionCrews: (holding) => holding.constructionCrews ?? [],
  _buildingWorkerAdmission: workerAdmission,
  _developmentSummary: () => ({ totals: { food: 10, technology: 14, culture: 8, war: 8 } })
};

function fixture() {
  const holding = mergeHoldingDefaults({ id: "control-test", name: "Контроль", visibility: "public",
    gm: { playersCanEditBuildings: true },
    people: { list: ["alice", "bob", "weak", "child", "away", "hidden"].map((id) => ({
      id, name: id, age: id === "child" ? 8 : 30, ageGroup: id === "child" ? "Ре" : "Вз",
      background: "Солдат", role: "Свободен", workAssignment: "", workAllocationMode: "legacy", workAllocations: [],
      salary: 0, salaryModifier: 0, injuredDays: 0, dead: false, visibility: id === "hidden" ? "gm" : "public",
      attributes: { strength: id === "weak" ? 1 : 4, wits: id === "weak" ? 1 : 4, empathy: 4, agility: 3 },
      ...(id === "away" ? { shipAssignment: { shipId: "ship", away: true } } : {})
    })) },
    buildings: { list: [{ id: "post", templateId: "sheriff-post", name: "Местная охрана", workerRole: "",
      lifecycle: "active", condition: "intact", constructionStatus: "built", workersMin: 1, workersMax: 2,
      assignedWorkerIds: ["", ""], workerAdmissionOverrideIds: [], functions: { defense: true },
      activation: { minWorkers: 1, minOperationalQd: 20 }, control: { generalPerWorker: 1, maximum: 2, ceiling: -10, capacity: 20 } }] }
  });
  // This fixture tests real assignment/service rules without the catalog's composition contract.
  holding.buildings.list[0].workerProfile = null;
  return { meta: { revision: 1 }, holdings: [holding], catalog: { buildings: copy(DEFAULT_BUILDING_TEMPLATES) } };
}

function memoryStore(initial, { player = false, normalize = false } = {}) {
  let data = normalize ? prepareSkyholdCommit(copy(initial), { scope: "holdings", baseRevision: initial.meta.revision - 1 }).data : copy(initial);
  let commits = 0;
  return {
    view: () => data, commits: () => commits,
    skipTransaction: (value) => ({ skip: true, value }),
    async updateHolding(id, update) {
      const draft = copy(data);
      const holding = draft.holdings.find((row) => row.id === id);
      if (!holding) return null;
      const result = await update(holding, draft);
      if (result?.skip) return result.value;
      const next = normalize ? prepareSkyholdCommit(draft, { scope: "holdings", baseRevision: data.meta.revision }).data : draft;
      if (player) {
        const patch = buildPlayerPatch(data, next);
        const validation = validatePlayerPatch(data, patch, "player");
        assert.equal(validation.ok, true, validation.error);
        assert.equal(validation.action, "buildings");
      }
      if (!normalize) next.meta.revision += 1;
      data = next;
      commits += 1;
      return result;
    }
  };
}

export async function checkControlTab() {
  const hadGame = Object.hasOwn(globalThis, "game");
  const priorGame = globalThis.game;
  const gm = { id: "gm", isGM: true, active: true };
  const player = { id: "player", isGM: false, active: true };
  globalThis.game = { user: gm, users: [gm, player], socket: { emit() {} } };
  try {
    const data = fixture();
    const holding = data.holdings[0];
    const before = JSON.stringify(data);
    const context = prepareControlContext(holding, data.catalog.buildings, settlementControlSummary(holding), manager);
    assert.equal(JSON.stringify(data), before, "context must never write data");
    assert.deepEqual(context.chain.map((row) => row.id), ["sheriff-post", "guard-house", "guard-precinct", "court"]);
    assert.equal(context.chain[0].present, true);
    assert.equal(context.chain[1].present, false);
    assert.match(context.chain[1].effects, /максимум 6.*охват 60.*−?[-]5/);
    assert.match(context.chain[1].prerequisites, /Пост шерифа/);
    assert.match(context.chain[0].instances[0].reasons, /работников/);
    assert.equal(context.jobs[0].candidates.some((row) => ["child", "away"].includes(row.id)), false);

    const store = memoryStore(data);
    let seq = 0;
    const execute = (action, residentId = "", extra = {}) => executeControlWorkOperation({
      operationId: `control-${++seq}`, holdingId: holding.id, expectedRevision: store.view().meta.revision,
      action, residentId, buildingId: action === "sheriff" ? "" : "post", ...extra
    }, { store, getManager: () => manager });
    assert.equal((await execute("sheriff", "alice")).ok, true);
    assert.equal(store.view().holdings[0].people.list[0].workAssignment, "other");
    assert.equal(settlementControlSummary(store.view().holdings[0]).generalControl, 1);
    assert.equal((await execute("add", "alice")).ok, false, "occupied sheriff cannot also fill a building job");
    assert.equal((await execute("sheriff", "bob")).ok, true);
    assert.equal(store.view().holdings[0].people.list[0].role, "Свободен");
    assert.equal(settlementControlSummary(store.view().holdings[0]).sources.filter((row) => row.sourceKind === "appointment").length, 1);
    const replayId = `control-${seq}`;
    const commits = store.commits();
    const replay = await execute("sheriff", "bob", { operationId: replayId, expectedRevision: 0 });
    assert.equal(replay.replay, true);
    assert.equal(store.commits(), commits);
    assert.equal((await execute("sheriff", "alice", { operationId: replayId })).ok, false);
    assert.equal((await execute("sheriff", "alice", { expectedRevision: 0 })).conflict, true);
    assert.equal(store.commits(), commits);
    assert.equal((await execute("sheriff", "")).ok, true);
    assert.equal(settlementControlSummary(store.view().holdings[0]).generalControl, 0);
    assert.equal((await execute("add", "alice")).ok, true);
    assert.equal(store.view().holdings[0].people.list[0].role, "Местная охрана");
    assert.equal(settlementControlSummary(store.view().holdings[0]).generalControl, 1);
    assert.equal((await execute("remove", "alice")).ok, true);
    assert.equal(store.view().holdings[0].buildings.list[0].assignedWorkerIds.some(Boolean), false);
    assert.equal((await execute("sheriff", "away")).ok, false);
    assert.equal((await execute("sheriff", "child")).ok, false);

    const hard = fixture();
    hard.holdings[0].buildings.list[0].workerProfile = copy(DEFAULT_BUILDING_TEMPLATES.find((row) => row.id === "guard-house").workerProfile);
    hard.holdings[0].buildings.list[0].workerProfile.composition = [];
    const hardStore = memoryStore(hard);
    const hardOperation = { operationId: "hard", holdingId: holding.id, expectedRevision: 1, action: "add", buildingId: "post", residentId: "weak" };
    assert.equal((await executeControlWorkOperation(hardOperation, { store: hardStore, getManager: () => manager })).ok, false);
    assert.equal(hardStore.commits(), 0);
    assert.equal((await executeControlWorkOperation({ ...hardOperation, allowAdmissionOverride: true }, { store: hardStore, getManager: () => manager })).ok, true);
    assert.deepEqual(hardStore.view().holdings[0].buildings.list[0].workerAdmissionOverrideIds, ["weak"]);

    globalThis.game.user = player;
    const playerStore = memoryStore(fixture(), { player: true });
    const playerExecute = (action, residentId, extra = {}) => executeControlWorkOperation({ operationId: `player-${++seq}`,
      holdingId: holding.id, expectedRevision: playerStore.view().meta.revision, action, residentId,
      buildingId: action === "sheriff" ? "" : "post", ...extra }, { store: playerStore, getManager: () => manager });
    const playerContext = prepareControlContext(holding, data.catalog.buildings, settlementControlSummary(holding), manager);
    assert.equal(playerContext.canAssign, true);
    assert.equal(playerContext.jobs[0].candidates.some((row) => row.id === "hidden"), false);
    assert.equal((await playerExecute("sheriff", "hidden")).ok, false);
    assert.equal((await playerExecute("sheriff", "alice")).ok, true);
    assert.equal((await playerExecute("sheriff", "bob")).ok, true);
    assert.equal((await playerExecute("sheriff", "")).ok, true);
    assert.equal((await playerExecute("add", "alice")).ok, true, "empty workerRole falls back to building name in the GM validator");
    assert.equal((await playerExecute("remove", "alice")).ok, true);
    const normalizedStore = memoryStore(fixture(), { player: true, normalize: true });
    assert.equal((await executeControlWorkOperation({ ...hardOperation, operationId: "normalized-add", residentId: "alice" },
      { store: normalizedStore, getManager: () => manager })).ok, true, "ordinary commit normalization and GM validation preserve work assignments");
    assert.equal(normalizedStore.view().holdings[0].people.list[0].workAssignment, "post");
    assert.equal((await executeControlWorkOperation({ ...hardOperation, operationId: "normalized-remove", action: "remove", residentId: "alice", expectedRevision: 2 },
      { store: normalizedStore, getManager: () => manager })).ok, true);
    assert.equal((await executeControlWorkOperation({ ...hardOperation, operationId: "normalized-sheriff", action: "sheriff", buildingId: "", residentId: "alice", expectedRevision: 3 },
      { store: normalizedStore, getManager: () => manager })).ok, true);
    assert.equal(normalizedStore.view().holdings[0].people.list[0].role, "Шериф");
    const fullLog = fixture();
    fullLog.holdings[0].log = Array.from({ length: 250 }, (_, i) => ({ id: `old-${i}`, operationId: `old-${i}`,
      type: "system", summary: String(i), payload: {} }));
    const fullStore = memoryStore(fullLog, { player: true });
    assert.equal((await executeControlWorkOperation({ ...hardOperation, action: "sheriff", residentId: "alice" },
      { store: fullStore, getManager: () => manager })).ok, true);
    assert.equal(fullStore.view().holdings[0].log.length, 250);
    assert.equal(fullStore.view().holdings[0].log[0].id, "old-1");
    const tamperedLog = copy(fullStore.view());
    tamperedLog.meta.revision = fullLog.meta.revision;
    tamperedLog.holdings[0].log[30].summary = "Forged";
    assert.equal(validatePlayerPatch(fullLog, buildPlayerPatch(fullLog, tamperedLog)).ok, false, "retained history is immutable");
    const deletedLog = copy(fullLog);
    deletedLog.holdings[0].log.shift();
    assert.equal(validatePlayerPatch(fullLog, buildPlayerPatch(fullLog, deletedLog)).ok, false, "rotation requires an append");
    const exceptionStore = memoryStore(hardStore.view(), { player: true });
    assert.equal((await executeControlWorkOperation({ ...hardOperation, operationId: "exception-remove", expectedRevision: 2, action: "remove" },
      { store: exceptionStore, getManager: () => manager })).ok, true);
    assert.deepEqual(exceptionStore.view().holdings[0].buildings.list[0].workerAdmissionOverrideIds, ["weak"]);
    assert.equal((await executeControlWorkOperation({ ...hardOperation, operationId: "exception-add", expectedRevision: 3 },
      { store: exceptionStore, getManager: () => manager })).ok, true, "a player can use an existing GM admission");
    const noExceptionStore = memoryStore(hard, { player: true });
    assert.equal((await executeControlWorkOperation({ ...hardOperation, allowAdmissionOverride: true },
      { store: noExceptionStore, getManager: () => manager })).ok, false, "a player cannot grant a GM admission");
    const bad = fixture();
    const wrongRole = copy(bad);
    wrongRole.holdings[0].people.list[0].workAssignment = "post";
    wrongRole.holdings[0].people.list[0].role = "Чужая роль";
    wrongRole.holdings[0].buildings.list[0].assignedWorkerIds[0] = "alice";
    assert.equal(validatePlayerPatch(bad, buildPlayerPatch(bad, wrongRole)).ok, false);
    const forbiddenCustom = copy(bad);
    forbiddenCustom.holdings[0].people.list[0].workAssignment = "other";
    forbiddenCustom.holdings[0].people.list[0].role = "Произвольная должность";
    assert.equal(validatePlayerPatch(bad, buildPlayerPatch(bad, forbiddenCustom)).ok, false, "do not expand arbitrary custom work permissions");
    globalThis.game.users = [player];
    assert.equal(prepareControlContext(holding, data.catalog.buildings, {}, manager).canAssign, false);
    assert.equal((await playerExecute("sheriff", "alice")).ok, false);
    globalThis.game.users = [gm, player];
    const denied = fixture();
    denied.holdings[0].gm.playersCanEditBuildings = false;
    const deniedStore = memoryStore(denied, { player: true });
    assert.equal((await executeControlWorkOperation({ ...hardOperation, action: "sheriff", residentId: "alice" },
      { store: deniedStore, getManager: () => manager })).ok, false);
    assert.equal(deniedStore.commits(), 0);
    const hiddenBuilding = fixture();
    hiddenBuilding.holdings[0].buildings.list[0].visibility = "gm";
    assert.equal(prepareControlContext(hiddenBuilding.holdings[0], data.catalog.buildings, {}, manager).jobs.length, 0);
    const hiddenCatalog = copy(data.catalog.buildings);
    hiddenCatalog.find((row) => row.id === "sheriff-post").visibility = "gm";
    const hiddenContext = prepareControlContext(holding, hiddenCatalog, {}, manager);
    assert.match(hiddenContext.chain.find((row) => row.id === "guard-house").prerequisites, /Скрытая предпосылка/);
    assert.doesNotMatch(hiddenContext.chain.find((row) => row.id === "guard-house").prerequisites, /Пост шерифа/);

    globalThis.game.user = gm;
    const explicit = fixture();
    const explicitPerson = explicit.holdings[0].people.list[0];
    explicitPerson.workAllocationMode = "explicit";
    explicitPerson.workAllocations = [{ id: "qd", sourceId: "post", functionId: "defense", normalQd: 20, overtimeQd: 0 }];
    const explicitContext = prepareControlContext(explicit.holdings[0], data.catalog.buildings, {}, manager);
    assert.equal(explicitContext.jobs[0].workers[0].explicit, true);
    assert.equal(explicitContext.jobs[0].workers[0].canRemove, false);
    const explicitStore = memoryStore(explicit);
    assert.equal((await executeControlWorkOperation({ ...hardOperation, action: "remove", residentId: "alice" },
      { store: explicitStore, getManager: () => manager })).ok, false);
    assert.equal(explicitStore.commits(), 0);

    const stopped = fixture();
    stopped.holdings[0].buildings.list[0].lifecycle = "disabled";
    const stoppedStore = memoryStore(stopped);
    assert.equal((await executeControlWorkOperation({ ...hardOperation, residentId: "alice" },
      { store: stoppedStore, getManager: () => manager })).ok, false);
    const planned = fixture();
    planned.holdings[0].buildings.list[0].lifecycle = "planned";
    const plannedContext = prepareControlContext(planned.holdings[0], data.catalog.buildings, {}, manager);
    assert.equal(plannedContext.chain[0].present, false, "a project is not a completed building");
    assert.match(plannedContext.chain[0].statusLabel, /Не построено/);
    const custom = fixture();
    custom.catalog.buildings.find((row) => row.id === "guard-house").control.maximum = 9;
    custom.holdings[0].buildings.list.push({ ...copy(custom.holdings[0].buildings.list[0]), id: "post-2", name: "Второй пост", control: { generalFlat: 4 } });
    const customContext = prepareControlContext(custom.holdings[0], custom.catalog.buildings, settlementControlSummary(custom.holdings[0]), manager);
    assert.match(customContext.chain[1].effects, /максимум 9/);
    assert.equal(customContext.chain[0].instances.length, 2);
    assert.match(customContext.chain[0].instances[1].effects, /Контроль \+4/);
    const template = readFileSync(path.join(root, "templates/politics-app.hbs"), "utf8");
    for (const action of ["sheriff", "add", "remove"]) assert.ok(template.includes(`data-control-assignment="${action}"`));
    assert.ok(template.includes("control.buildingGroups"));
    // Exercise the actual window coordinator without a running Foundry world.
    const hadFoundry = Object.hasOwn(globalThis, "foundry");
    const hadFormData = Object.hasOwn(globalThis, "FormData");
    const priorFoundry = globalThis.foundry;
    const priorFormData = globalThis.FormData;
    const { SkyholdData } = await import("../data/store.js");
    const priorView = SkyholdData.view;
    const priorUpdateHolding = SkyholdData.updateHolding;
    class FakeApplication { async _prepareContext() { return {}; } }
    globalThis.foundry = { applications: { api: { ApplicationV2: FakeApplication, HandlebarsApplicationMixin: (Base) => Base } } };
    globalThis.FormData = class { constructor(form) { this.form = form; } get(key) { return this.form.fields?.[key]; } };
    try {
      const { SkyholdPoliticsApp } = await import("../apps/politics-app.js");
      const windowData = fixture();
      windowData.holdings.push({ ...copy(windowData.holdings[0]), id: "other-holding" });
      const windowStore = memoryStore(windowData);
      SkyholdData.view = windowStore.view;
      SkyholdData.updateHolding = windowStore.updateHolding.bind(windowStore);
      const button = { disabled: false };
      const app = Object.assign(Object.create(SkyholdPoliticsApp.prototype), { holdingId: holding.id, activeTab: "control",
        owner: { ...manager, activeHoldingId: "other-holding", _calculateMorale: () => 0 },
        renders: [], requestRender(options) { this.renders.push(options); } });
      const windowContext = await app._prepareContext({});
      assert.equal(windowContext.control.canAssign, true);
      assert.equal(windowContext.panels.control, true);
      await app._submitControlAssignment({ dataset: { controlAssignment: "sheriff" }, fields: { residentId: "alice" },
        querySelector: () => button }, windowContext);
      assert.equal(windowStore.view().holdings[0].people.list[0].role, "Шериф");
      assert.equal(windowStore.view().holdings[1].people.list[0].role, "Свободен", "window holding is independent of the manager's active holding");
      assert.equal(app.activeTab, "control");
      assert.deepEqual(app.renders, [{ focus: false }]);
      assert.equal(button.disabled, false);
      globalThis.game.user = player;
      const readonly = await app._prepareContext({});
      assert.equal(readonly.control.canAssign, true);
      assert.equal(readonly.canManagePolitics, false, "work rights do not grant political-act rights");
      globalThis.game.user = gm;
      const viewHolding = windowStore.view().holdings[0];
      viewHolding.buildings.list.push({ id: "hidden-source", name: "Секретная охрана", visibility: "gm",
        lifecycle: "active", condition: "intact", workersMin: 0, workersMax: 0, assignedWorkerIds: [],
        activation: { minWorkers: 0, minOperationalQd: 0 }, control: { generalFlat: 2 } });
      app.activeTab = "cabinet";
      const gmView = await app._prepareContext({});
      assert.equal(gmView.control.sources.some((source) => source.id === "hidden-source"), true);
      const commitsBeforePreview = windowStore.commits();
      app._togglePlayerPreview();
      assert.equal(app._isPlayerPreview(), true);
      assert.equal(globalThis.game.user, gm, "preview must never replace the actual Foundry user");
      const preview = await app._prepareContext({});
      assert.equal(preview.canManagePolitics, false);
      assert.deepEqual(preview.tabs.map((tab) => tab.id), ["control"]);
      assert.equal(preview.panels.control, true);
      assert.equal(app.activeTab, "cabinet", "temporarily unavailable player tabs must not overwrite the GM tab");
      assert.equal(preview.control.sources.some((source) => source.id === "hidden-source"), false);
      assert.equal(preview.control.generalControl, gmView.control.generalControl, "visibility does not alter derived settlement effects");
      assert.equal(preview.control.sheriff.options.some((person) => person.id === "hidden"), false);
      await app._submitControlAssignment({ dataset: { controlAssignment: "sheriff" }, fields: { residentId: "bob" },
        querySelector: () => button }, windowContext);
      assert.equal(windowStore.commits(), commitsBeforePreview, "preview blocks even an old GM form context");
      globalThis.game.user = player;
      const realPlayerView = await app._prepareContext({});
      for (const key of ["hasHolding", "tabs", "panels", "canManagePolitics", "showPoliticsPanels", "control"]) {
        assert.deepEqual(preview[key], realPlayerView[key], `preview must match actual player context: ${key}`);
      }
      app._togglePlayerPreview();
      assert.equal(app.previewAsPlayer, true, "a real player cannot use the GM view toggle");
      globalThis.game.user = gm;
      app._togglePlayerPreview();
      const restored = await app._prepareContext({});
      assert.equal(restored.canManagePolitics, true);
      assert.equal(restored.panels.cabinet, true);
      viewHolding.gm.politicsIgnoreInstitutionRequirement = true;
      app.owner._developmentSummary = () => ({ totals: { culture: 20 } });
      app.activeTab = "course";
      app._togglePlayerPreview();
      const availablePreview = await app._prepareContext({});
      assert.equal(availablePreview.tabs.length, 4);
      assert.equal(availablePreview.panels.course, true);
      viewHolding.gm.playersCanEditBuildings = false;
      assert.equal((await app._prepareContext({})).control.canAssign, false);
      viewHolding.visibility = "gm";
      assert.equal((await app._prepareContext({})).hasHolding, false, "GM-only holding is unavailable to player view");
      app._togglePlayerPreview();
      assert.equal((await app._prepareContext({})).hasHolding, true, "GM can return from an inaccessible player view");
      assert.equal((await app._prepareContext({})).control.canAssign, true);

      const hadDocument = Object.hasOwn(globalThis, "document");
      const priorDocument = globalThis.document;
      class HeaderElement {
        constructor() {
          this.children = []; this.attributes = {}; this.listeners = []; this.className = "";
          this.classList = { add: (name) => { this.className += ` ${name}`; } };
        }
        setAttribute(key, value) { this.attributes[key] = value; }
        querySelector(selector) {
          return this.children.find((child) => selector.split(", ").some((part) => child.className.split(" ").includes(part.slice(1)))) ?? null;
        }
        appendChild(child) { child.parentElement = this; this.children.push(child); }
        insertBefore(child, before) { child.parentElement = this; this.children.splice(this.children.indexOf(before), 0, child); }
        replaceChildren(...children) { this.children = []; children.forEach((child) => this.appendChild(child)); }
        addEventListener(type, callback, { signal } = {}) { this.listeners.push({ type, callback, signal }); }
        remove() { this.parentElement.children = this.parentElement.children.filter((child) => child !== this); }
        focus() { globalThis.document.activeElement = this; }
        click() {
          const event = { preventDefault() {}, stopPropagation() {} };
          for (const listener of this.listeners.filter((row) => row.type === "click" && !row.signal?.aborted)) listener.callback(event);
        }
      }
      try {
        globalThis.document = { createElement: () => new HeaderElement(), activeElement: null };
        const header = new HeaderElement();
        const controls = new HeaderElement(); controls.className = "window-controls"; header.appendChild(controls);
        const frame = { querySelector: () => header };
        app._getWindowFrameElement = () => frame;
        const firstController = new AbortController();
        app._syncViewToggle(frame, { signal: firstController.signal });
        const toggle = header.querySelector(".fbls-politics-view-toggle");
        assert.equal(toggle.type, "button");
        assert.equal(header.children[1], controls, "toggle sits beside the native window controls");
        assert.equal(toggle.attributes["aria-pressed"], "false");
        firstController.abort();
        const secondController = new AbortController();
        app._syncViewToggle(frame, { signal: secondController.signal });
        assert.equal(header.children.length, 2, "rerender must not duplicate the header control");
        toggle.click();
        assert.equal(app.previewAsPlayer, true, "exactly one live click listener toggles the view");
        secondController.abort();
        const thirdController = new AbortController();
        app._syncViewToggle(frame, { signal: thirdController.signal });
        assert.equal(toggle.attributes["aria-pressed"], "true");
        assert.equal(toggle.children[1].textContent, "Вид игрока");
        assert.equal(globalThis.document.activeElement, toggle, "keyboard focus returns to the view toggle");
        globalThis.game.user = player;
        app._syncViewToggle(frame, { signal: thirdController.signal });
        assert.equal(header.children.length, 1, "real players never receive the GM header toggle");
        thirdController.abort();
      } finally {
        if (hadDocument) globalThis.document = priorDocument; else delete globalThis.document;
      }
    } finally {
      SkyholdData.view = priorView;
      SkyholdData.updateHolding = priorUpdateHolding;
      if (hadFoundry) globalThis.foundry = priorFoundry; else delete globalThis.foundry;
      if (hadFormData) globalThis.FormData = priorFormData; else delete globalThis.FormData;
    }
  } finally {
    if (hadGame) globalThis.game = priorGame; else delete globalThis.game;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkControlTab();
  console.log("Control tab: catalog progression, real assignments, service effects, GM/player validation, replay and conflicts passed.");
}
