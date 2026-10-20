import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_SKYHOLD_DATA } from "../data/defaults/default-skyhold-data.js";
import { clone } from "../data/utils.js";
import { migrateData } from "../data/normalizers.js";
import { prepareSkyholdCommit } from "../data/commit-preparation.js";
import { normalizeResourceId, withResourceCatalog } from "../core/resources.js";
import { assertResourceCatalogUnused } from "../data/catalog-dependencies.js";
import { applyContentPackImport, planContentPackImport } from "../data/content-packs.js";
import { EventAutomationDomain } from "../apps/domains/events/event-automation-events.js";
import { ResidentGeneratorEventDomain } from "../apps/domains/events/resident/generator-events.js";
import { createSkyholdSocketApi } from "../data/socket.js";
import { buildPlayerPatch } from "../data/player-write-guard.js";
import { createWriteQueue } from "../data/write-queue.js";
import { commandSuccess } from "../data/command-result.js";
import { ensureSkyholdStylesheet } from "../apps/lazy-styles.js";
import { PendingFieldSavesMixin } from "../apps/common/pending-field-saves.js";
import { dispatchDelegatedAction } from "../apps/common/delegated-events.js";

export async function checkAuditRegressions() {
  const saved = Object.fromEntries(["game", "foundry", "ui", "document"].map((key) => [key, globalThis[key]]));
  const originalError = console.error;
  const gm = { id: "gm-a", active: true, isGM: true };
  const gm2 = { id: "gm-b", active: true, isGM: true };
  const player = { id: "player", active: true, isGM: false };
  const stranger = { id: "stranger", active: true, isGM: false };
  const users = new Map([gm, gm2, player, stranger].map((row) => [row.id, row]));
  const emitted = [];
  let serial = 0;
  class Application {
    static DEFAULT_OPTIONS = {};
    constructor() {}
    async _preClose() {}
    async close(options) { await this._preClose(options); this.closed = true; return this; }
  }
  try {
    globalThis.foundry = { applications: { api: { ApplicationV2: Application, HandlebarsApplicationMixin: (Base) => Base } },
      utils: { randomID: () => `audit-${++serial}`, getProperty: (row, key) => key.split(".").reduce((value, part) => value?.[part], row) } };
    globalThis.game = { user: gm, users: { contents: [...users.values()], get: (id) => users.get(id) },
      socket: { emit: (_channel, payload) => emitted.push(payload) } };
    globalThis.ui = { notifications: { warn() {}, error() {}, info() {} } };

    const resource = { id: "audit-custom", label: "Audit material", hidden: true };
    const data = clone(DEFAULT_SKYHOLD_DATA);
    data.catalog.resources.push(resource);
    data.holdings[0].buildings.list.push({ id: "audit-building", name: "Audit workshop", type: "craft",
      fuelAlternatives: [{ resourceId: resource.id, qty: 2 }],
      serviceProjects: [{ id: "audit-project", resourceCosts: [{ resourceId: resource.id, qty: 3 }] }] });
    data.holdings[0].storage.resources.push({ id: "audit-stock", resourceId: resource.id, name: resource.label, qty: 4 });
    for (const scope of ["both", "holdings"]) {
      const normalized = prepareSkyholdCommit(data, { scope }).data;
      const building = normalized.holdings[0].buildings.list.find((row) => row.id === "audit-building");
      assert.equal(building.fuelAlternatives[0].resourceId, resource.id, "draft and hidden resources must survive fuel normalization");
      assert.equal(building.serviceProjects[0].resourceCosts[0].resourceId, resource.id, "new project costs must use the same draft catalog");
      assert.equal(normalized.holdings[0].storage.resources.find((row) => row.id === "audit-stock").resourceId, resource.id);
    }
    assert.equal(normalizeResourceId(resource.id), "custom", "draft context must not leak to the world index");
    assert.throws(() => withResourceCatalog([resource], () => { throw new Error("normalization failed"); }), /normalization failed/);
    assert.equal(normalizeResourceId(resource.id), "custom", "throwing normalization must restore the previous index");
    assert.throws(() => assertResourceCatalogUnused(data, resource.id), /используется/);
    assert.doesNotThrow(() => assertResourceCatalogUnused(data, "unused-id"));
    const costsOnly = clone(DEFAULT_SKYHOLD_DATA);
    costsOnly.catalog.resources = [resource];
    costsOnly.catalog.buildings = [{ productionLines: [{ expenses: `${resource.label} 3` }] }];
    assert.throws(() => assertResourceCatalogUnused(costsOnly, resource.id), /используется/, "recipe text must retain its resource dependency");
    costsOnly.catalog.buildings = [{ storage: { profileResourceIds: [resource.id] } }];
    assert.throws(() => assertResourceCatalogUnused(costsOnly, resource.id), /используется/, "resource ID arrays are dependencies too");

    const pack = { schema: "fbl-skyhold.content-pack", formatVersion: 1, id: "audit-pack", source: "audit", version: 1,
      install: { replaceResources: true }, content: { resources: [] } };
    const plan = planContentPackImport({ data, rawPack: pack });
    const before = clone(data);
    const rejected = applyContentPackImport({ data, plan });
    assert.equal(rejected.ok, false);
    assert.ok(rejected.dependencies.some((row) => row.id === resource.id));
    assert.deepEqual(data, before, "rejected replacement must not partially mutate the data root");
    const retainedPack = { ...pack, content: { resources: [resource] } };
    assert.equal(applyContentPackImport({ data: clone(data), plan: planContentPackImport({ data, rawPack: retainedPack }) }).ok, true);
    const regionData = clone(DEFAULT_SKYHOLD_DATA);
    regionData.catalog.eventRegions = [{ value: "audit-port", label: "Audit port" }];
    regionData.holdings[0].overview.region = "audit-port";
    const regionPack = { ...pack, install: { replaceMarket: true }, content: { regions: [{ value: "replacement", label: "Replacement" }] } };
    const regionPlan = planContentPackImport({ data: regionData, rawPack: regionPack });
    assert.equal(applyContentPackImport({ data: regionData, plan: regionPlan }).ok, false, "replacement cannot strand a holding in a removed port");
    const countryData = clone(DEFAULT_SKYHOLD_DATA);
    countryData.catalog.marketEconomy = { countries: [{ id: "audit-country" }] };
    const countryPack = { ...pack, install: { replaceMarket: true }, content: { regions: [{ value: "port", label: "Port", marketCountryId: "audit-country" }] } };
    countryData.holdings[0].special = { shipment: { countryId: "audit-country" } };
    const countryBefore = clone(countryData);
    const countryResult = applyContentPackImport({ data: countryData, plan: planContentPackImport({ data: countryData, rawPack: countryPack }) });
    assert.equal(countryResult.ok, false, "replacement cannot remove a country used by a shipment");
    assert.ok(countryResult.dependencies.some((row) => row.kind === "country"));
    assert.deepEqual(countryData, countryBefore);

    for (const terminal of ["applied", "done", "archived", "cancelled"]) {
      assert.equal(EventAutomationDomain._eventAutomationSource({ gm: { eventSchedule: [{ id: "event", status: terminal }] } }, "event"), null);
    }
    assert.equal(EventAutomationDomain._eventAutomationSource({ gm: { eventSchedule: [{ id: "event", effectStatus: "applied" }] } }, "event"), null);
    assert.equal(EventAutomationDomain._eventAutomationSource({ gm: { lastRoll: { effectStatus: "applied", effects: [{ type: "money", amount: 10 }] } } }), null);
    assert.equal(EventAutomationDomain._eventAutomationSource({ gm: { eventSchedule: [{ id: "event", status: "pending" }] } }, "event").scheduleId, "event");

    const actor = { name: "Actor fixture", uuid: "Actor.fixture", system: { bio: {
      age: { label: "BIO.AGE", value: 47 }, kin: { label: "BIO.KIN", value: "Эльф" },
      profession: { label: "BIO.PROFESSION", value: "Охотник" }, face: { value: "Шрам" }, body: { value: "Высокий" }, clothing: { value: "Плащ" }
    }, attribute: { strength: { max: 5, value: 2 } } } };
    const person = ResidentGeneratorEventDomain._residentFromActorGenerated.call(ResidentGeneratorEventDomain, actor, data.holdings[0]);
    assert.equal(person.age, 47);
    assert.equal(person.race, "Эльф");
    assert.equal(person.background, "Охотник");
    assert.equal(person.attributes.strength, 5, "import uses the undamaged maximum attribute");
    assert.equal(person.appearance, "Шрам; Высокий; Плащ");

    let current = migrateData(clone(DEFAULT_SKYHOLD_DATA));
    current.holdings[0].visibility = "all";
    current.holdings[0].gm.playersCanEditOverview = true;
    const proposed = clone(current);
    proposed.holdings[0].overview.description = "Saved by player";
    const patch = buildPlayerPatch(current, proposed);
    let writes = 0;
    const options = { getData: () => clone(current), enqueueWrite: createWriteQueue(),
      persistData: async (value) => { current = clone(value); writes += 1; }, notifyChanged() {} };
    const request = { type: "playerDataPatchRequest", requestId: "audit-patch", operationId: "audit-patch", userId: player.id,
      targetGmId: gm.id, expectedRevision: patch.baseRevision, patch };
    await createSkyholdSocketApi(options).handleSkyholdSocketPayload(request, player.id);
    assert.equal(writes, 1);
    await createSkyholdSocketApi(options).handleSkyholdSocketPayload(request, player.id);
    assert.equal(writes, 1, "a new GM API instance must replay a persisted patch receipt without another write");
    assert.equal(emitted.at(-1).command.ok, true);
    console.error = () => {};
    await createSkyholdSocketApi(options).handleSkyholdSocketPayload({ ...request, requestId: "mismatched-transport" }, player.id);
    assert.equal(emitted.at(-1).command.ok, false, "mismatched transport IDs must not execute");
    assert.equal(writes, 1);
    await createSkyholdSocketApi(options).handleSkyholdSocketPayload({ ...request, userId: stranger.id }, stranger.id);
    assert.equal(emitted.at(-1).command.ok, false, "another player cannot reuse the persisted operation ID");
    assert.equal(writes, 1);
    console.error = originalError;
    globalThis.game.user = gm2;
    await createSkyholdSocketApi(options).handleSkyholdSocketPayload({ ...request, targetGmId: gm2.id }, player.id);
    assert.equal(writes, 1, "non-authority GM must ignore player requests");
    globalThis.game.user = player;
    const playerApi = createSkyholdSocketApi(options);
    const next = clone(current);
    next.holdings[0].overview.description = "Player draft";
    const pending = playerApi.requestGmDataPatch(next);
    const sent = emitted.at(-1);
    const authoritativeHolding = { ...next.holdings[0], overview: { ...next.holdings[0].overview, description: "Canonical value" } };
    await playerApi.handleSkyholdSocketPayload({ type: "playerDataPatchResponse", requestId: sent.requestId, operationId: sent.operationId,
      userId: player.id, gmId: gm.id, ok: true, command: commandSuccess({ operationId: sent.operationId, revision: current.meta.revision + 1 }),
      holding: authoritativeHolding, meta: { ...current.meta, revision: current.meta.revision + 1 } }, gm.id);
    assert.equal((await pending).holdings[0].overview.description, "Canonical value", "response must resolve from committed data, not the unnormalized draft");

    const links = [];
    globalThis.document = { querySelector: () => links.find((link) => !link.removed) ?? null,
      createElement: () => ({ dataset: {}, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, remove() { this.removed = true; } }),
      head: { append: (link) => links.push(link) } };
    const firstStyle = ensureSkyholdStylesheet("secondary");
    assert.equal(ensureSkyholdStylesheet("secondary"), firstStyle, "concurrent windows must await the same load");
    links[0].listeners.error();
    await assert.rejects(firstStyle, /Failed to load/);
    const retryStyle = ensureSkyholdStylesheet("secondary");
    assert.equal(links.length, 2, "failed links must be removed so the next open retries");
    links[1].listeners.load();
    assert.equal(await retryStyle, true);

    const { SkyholdStorageActionDialog } = await import("../apps/storage-action-dialog.js");
    for (const asyncFailure of [false, true]) {
      class FailedDialog extends SkyholdStorageActionDialog {
        render() { if (asyncFailure) return Promise.reject(new Error("render failed")); throw new Error("render failed"); }
      }
      console.error = () => {};
      assert.equal(await FailedDialog.open(), null, "render failures must settle the awaiting storage action");
    }
    console.error = originalError;
    const { SkyholdResidentEditor } = await import("../apps/editors/resident-editor.js");
    const editor = new SkyholdResidentEditor();
    editor.element = { querySelector: () => ({}) };
    editor._saveDraft = async () => false;
    await editor.close();
    assert.notEqual(editor.closed, true, "failed save must leave the resident editor open");
    editor._saveDraft = async () => true;
    await editor.close();
    assert.equal(editor.closed, true);
    SkyholdResidentEditor.instances.delete(editor);

    const { SkyholdMarketApp } = await import("../apps/market-app.js");
    globalThis.game.user = gm;
    let confirmations = 0;
    let finishConfirmation;
    globalThis.foundry.applications.api.DialogV2 = { confirm: () => {
      confirmations += 1;
      return new Promise((resolve) => { finishConfirmation = resolve; });
    } };
    const market = { _marketSnapshot: () => ({ holding: current.holdings[0], plan: { lines: [], marketLabel: "Market", subtotalCopper: 0, deliveryCopper: 0, totalCopper: 0 } }) };
    const purchase = SkyholdMarketApp.prototype._onBuy.call(market);
    await SkyholdMarketApp.prototype._onBuy.call(market);
    assert.equal(confirmations, 1, "two fast purchase clicks must share one confirmation/operation");
    finishConfirmation(false);
    await purchase;
    assert.equal(market._buyOperationPending, false, "cancel must release the purchase guard");

    const { SkyholdContentPackImporter } = await import("../apps/editors/content-pack-importer.js");
    const importer = new SkyholdContentPackImporter();
    importer.requestRender = () => {};
    let finishImport;
    importer._importOnce = () => new Promise((resolve) => { finishImport = resolve; });
    const importing = importer._onImport({});
    assert.equal(importer._onImport({}), importing, "a repeated import click must reuse the pending operation");
    const closing = importer.close();
    await Promise.resolve();
    assert.notEqual(importer.closed, true, "close must wait for the import result");
    finishImport(true);
    await closing;
    assert.equal(importer.closed, true);
    const failedImporter = new SkyholdContentPackImporter();
    failedImporter.requestRender = () => {};
    failedImporter._importOnce = () => new Promise((resolve) => { finishImport = resolve; });
    failedImporter._onImport({});
    const failedClose = failedImporter.close();
    finishImport(false);
    await failedClose;
    assert.notEqual(failedImporter.closed, true, "failed import during close must retain the preview");

    const fields = new (PendingFieldSavesMixin(Application))();
    let failField;
    console.error = () => {};
    const saveField = dispatchDelegatedAction(fields, { type: "change" }, {}, () => new Promise((_resolve, reject) => { failField = reject; }));
    const closeFields = fields.close();
    await Promise.resolve();
    assert.notEqual(fields.closed, true);
    failField(new Error("offline"));
    await Promise.all([saveField, closeFields]);
    assert.notEqual(fields.closed, true, "a failed field save during close must retain the editor and its input");
    await fields.close();
    assert.equal(fields.closed, true, "a later explicit close is possible after the failure was reported");
    console.error = originalError;
  } finally {
    console.error = originalError;
    for (const [key, value] of Object.entries(saved)) globalThis[key] = value;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkAuditRegressions();
  console.log("Audit regressions: draft catalogs, dependencies, event replay, Actor import, socket restart, stylesheet retry and failed close passed.");
}
