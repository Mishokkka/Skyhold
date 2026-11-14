import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleSkyholdSocketPayload, registerStorageOperationExecutor, SkyholdData } from "../data/store.js";
import { stableDataHash } from "../data/storage-commit.js";
import { deleteCollectionRow } from "../data/collection-operations.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { FinanceStorageDomain } from "../apps/domains/finance/storage-domain.js";
import { prepareMarketOutboundContext } from "../apps/market/outbound-context.js";
import { normalizeStorageRoomId } from "../engines/storage/capacity.js";
import { economyLedgerStorageRows } from "../engines/economy/ledger.js";
import { buildTendayOperationPayload } from "../engines/tenday/operation-payload.js";
import { ResidentDomain } from "../apps/domains/resident-domain.js";
import { BuildingDomain } from "../apps/domains/building-domain.js";
import { resourceUnitLoad } from "../core/resources.js";
import { appendHoldingOperation } from "../data/operations.js";
import { COMMAND_ERROR } from "../data/command-result.js";
import { buildPlayerPatch, validatePlayerPatch } from "../data/player-write-guard.js";

globalThis.foundry = { applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: Base => Base } } };
const { StorageEventDomain } = await import("../apps/domains/events/storage-events.js");
const { createStorageOperationExecutor } = await import("../apps/storage-operation-executor.js");
const { SkyholdStorageActionDialog } = await import("../apps/storage-action-dialog.js");
const { NavigationEventDomain } = await import("../apps/domains/events/navigation-events.js");
const { GmEventDomain } = await import("../apps/domains/events/gm-events.js");
const { ResidentEventDomain } = await import("../apps/domains/events/resident-events.js");

class Element {
  constructor(tag) { this.tag = tag; this.dataset = {}; this.style = {}; this.children = []; this.classList = { add() {} }; }
  setAttribute() {}
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); }
  addEventListener() {}
  focus() {}
  querySelectorAll() { return this.children.filter(child => child.tag === "button"); }
}
const body = new Element("body");
globalThis.document = { body, createElement: tag => new Element(tag), addEventListener() {}, removeEventListener() {} };
globalThis.window = { innerWidth: 1000, innerHeight: 800 };
let warnings = 0;
globalThis.ui = { notifications: { warn: () => warnings++, info() {} } };
globalThis.game = { user: { id: "player", isGM: false } };
const app = { ...StorageEventDomain, _closeStorageContextMenu() {}, _canUseStorage: () => true,
  _storageContextRow: () => { throw new Error("a denied player action must stop before opening a dialog"); } };
await app._showStorageContextMenu();
assert.deepEqual(body.children.at(-1).children.map(button => button.dataset.action), ["move"],
  "player menu must offer only the operation accepted by authority-GM");
for (const method of ["_openStorageGiveDialog", "_openStorageNoteDialog", "_openStorageDeleteDialog"]) await app[method]();
await app._onStorageDrop({ preventDefault() {}, stopPropagation() {}, currentTarget: { classList: { remove() {} } },
  dataTransfer: { getData: () => { throw new Error("player drop must not read/resolve Foundry items"); } } });
await app._setStorageMoneyFromUi({ changedField: { closest: () => { throw new Error("player money controls must stop before editing"); } } });
assert.equal(warnings, 4, "denied dialogs and drop explain the GM requirement locally");

globalThis.game.user = { id: "gm", isGM: true };
await app._showStorageContextMenu();
assert.deepEqual(body.children.at(-1).children.map(button => button.dataset.action), ["move", "give", "note", "delete"]);
let writes = 0;
const executor = createStorageOperationExecutor({ getUser: () => ({ id: "player", isGM: false }),
  updateHolding: () => { writes++; throw new Error("permission denial must precede writes"); } });
for (const type of ["depositItem", "withdrawResource", "giveStoredItem"]) {
  await assert.rejects(executor({ type, operationId: type, holdingId: "holding" }, { userId: "player", remote: true }), /directly by a GM/);
}
assert.equal(writes, 0, "UI alignment preserves server permission checks");

const wood = { id: "wood-row", resourceId: "wood", name: "Дерево", roomId: "outdoors", qty: 6,
  batches: [{ id: "wood-batch", qty: 6, ageQd: 4 }], notes: "" };
const order = { id: "order", status: "booked", direction: "outbound",
  cargo: [{ lotId: "lot", rowId: wood.id, batchId: "wood-batch", qty: 4 }] };
const data = { meta: { revision: 4 }, holdings: ["a", "b"].map(id => mergeHoldingDefaults({
  id, visibility: "public", gm: { playersCanUseStorage: true },
  storage: { resources: [wood], items: [], moneyCopper: 0, log: [] },
  special: { transportV2: { version: 2, orders: [order] } }
})) };
const skip = Symbol("skip");
SkyholdData.get = () => structuredClone(data);
SkyholdData.view = () => data;
SkyholdData.skipTransaction = (value) => ({ [skip]: true, value });
SkyholdData.updateHolding = async (id, updater) => {
  const index = data.holdings.findIndex(holding => holding.id === id);
  assert.ok(index >= 0);
  const draft = structuredClone(data.holdings[index]);
  const result = await updater(draft, data);
  if (result?.[skip]) return result.value;
  data.holdings[index] = mergeHoldingDefaults(draft);
  data.meta.revision++;
  return result;
};
globalThis.HTMLTextAreaElement = class {};
const manager = { ...BuildingDomain, ...FinanceStorageDomain, ...StorageEventDomain, ...NavigationEventDomain, activeHoldingId: "a",
  _onDefenseFieldChange: GmEventDomain._onDefenseFieldChange,
  _safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
  _normalizeStorageRoomId: normalizeStorageRoomId,
  _formatNumber: String, _moneyContext: () => ({}), _resourcePriceCopper: () => 1, _itemPriceCopper: () => 1,
  _canPlayerWriteFieldPath: () => game.user.isGM, _sanitizeTextBlock: value => value,
  _activeWritableHoldingId() { return this.activeHoldingId; },
  _canUseStorage: () => true, _warnNoActiveHolding: () => ui.notifications.warn("Владение недоступно."),
  requestRender() {}, _storageDefaultActor: () => ({ id: "actor" }) };
const qtyChange = (value, defaultValue) => manager._onFieldChange({
  preventDefault() {},
  currentTarget: { value: String(value), defaultValue, dataset: { type: "number", field: "holdings.0.storage.resources.0.qty" },
    closest: () => ({ dataset: { storageHoldingId: "a", storageRowId: wood.id, storageRowRoomId: "outdoors", storageResourceId: "wood" } }) }
});
const row = (index) => data.holdings[index].storage.resources.find(resource => resource.id === wood.id);
const originalHolding = data.holdings[0];
data.holdings[0] = mergeHoldingDefaults({
  ...originalHolding,
  storage: { ...originalHolding.storage, resources: [wood, { ...wood, resourceId: "stone", name: "Камень", batches: [] }] }
});
const ambiguousHolding = structuredClone(data.holdings[0]);
assert.equal(ambiguousHolding.storage.resources.length, 2, "old duplicate IDs can survive holding normalization");
await qtyChange(9);
assert.deepEqual(data.holdings[0], ambiguousHolding, "an inline edit cannot choose the first of two matching storage IDs");
data.holdings[0] = originalHolding;

const saleChange = (index, checked) => manager._onFieldChange({
  preventDefault() {},
  currentTarget: { checked, dataset: { type: "checkbox", field: `holdings.0.storage.items.${index}.forSale` },
    closest: () => ({ dataset: { storageHoldingId: "a", storageRowId: "sale-item", storageRowRoomId: "outdoors" } }) }
});
const item = { id: "sale-item", name: "Канат", roomId: "outdoors", qty: 1, forSale: false };
data.holdings[0].storage.items = [item];
await saleChange(0, true);
assert.equal(data.holdings[0].storage.items[0].forSale, true, "a unique item still supports the sale toggle");
data.holdings[0].storage.items.push({ ...item, name: "Сундук" });
await saleChange(1, true);
assert.equal(data.holdings[0].storage.items[0].forSale, true, "editing a duplicate item must leave the other sale flag intact");
assert.equal(data.holdings[0].storage.items[1].forSale, false);
data.holdings[0].storage.items = [];
manager._onSelectHolding({ preventDefault() {}, currentTarget: { value: "b" } });
await qtyChange(9);
assert.equal(row(1).qty, 6, "the form rendered for A cannot edit an identically named row in B");
assert.equal(row(0).qty, 9, "the rendered holding ID remains authoritative during a switch");
manager.activeHoldingId = "a";
assert.deepEqual(row(0).batches.find(batch => batch.id === "wood-batch"), wood.batches[0]);
assert.equal(row(0).batches.find(batch => batch.ageQd === 0).qty, 3);
const afterIncrease = structuredClone(data);
await qtyChange(3);
assert.deepEqual(data, afterIncrease, "the inline editor must not lower stock beneath accepted cargo");
await qtyChange(5);
assert.equal(row(0).qty, 5);
assert.equal(row(0).batches.find(batch => batch.id === "wood-batch").qty, 4);
const afterOtherEdit = structuredClone(data);
await qtyChange(8, "6");
assert.deepEqual(data, afterOtherEdit, "an absolute edit in a stale field must not overwrite a newer balance");

{
  const holding = data.holdings[0];
  const actor = { id: "retry-recipient", uuid: "Actor.retry-recipient" };
  let command;
  let writes = 0;
  registerStorageOperationExecutor(async (operation) => {
    command = operation;
    writes++;
    throw Object.assign(new Error("Ответ потерян"), { code: COMMAND_ERROR.TIMEOUT });
  });
  const issue = () => manager._withdrawStoredResource({ holdingId: holding.id, expectedRevision: data.meta.revision,
    row: row(0), qty: 1, actor });
  const previousError = console.error;
  const confirm = manager._confirmAction;
  try {
    console.error = () => {};
    await issue();
    await issue();
    assert.equal(writes, 1, "the ordinary action cannot start another transfer while the same inventory result is unknown");
    const event = { preventDefault() {}, stopPropagation() {}, currentTarget: { dataset: { storageHoldingId: holding.id } } };
    manager._confirmAction = async () => false;
    await manager._onCheckStorageTransfer(event);
    assert.equal(manager._pendingStorageTransfer(holding.id), command.operationId, "a missing receipt keeps the pending exchange visible");
    appendHoldingOperation(holding, { type: "system", operationId: command.operationId,
      payload: { userId: game.user.id, result: { ok: true, message: "Выдана одна единица" } } });
    game.user.isGM = false;
    await manager._onCheckStorageTransfer(event);
    game.user.isGM = true;
    assert.equal(manager._pendingStorageTransfer(holding.id), command.operationId, "players cannot clear a GM's reconciliation");
    await manager._onCheckStorageTransfer(event);
    assert.equal(manager._pendingStorageTransfer(holding.id), "");
    assert.equal(writes, 1, "reconciliation reads the late receipt without running another Actor mutation");
  } finally {
    console.error = previousError;
    manager._confirmAction = confirm;
    holding.log = holding.log.filter(entry => entry.operationId !== command?.operationId);
  }
}

{
  const saved = structuredClone(data);
  try {
    const holding = data.holdings[0];
    holding.buildings.list.push({ id: "small-room", name: "Кладовая", constructionStatus: "built",
      functions: { storage: true }, storage: { capacity: 10 * resourceUnitLoad("wood") } });
    holding.storage.resources = [{ ...wood, roomId: "small-room", qty: 6 }];
    holding.special.transportV2.orders = [];
    const edit = (value, defaultValue) => manager._onFieldChange({
      preventDefault() {},
      currentTarget: { value: String(value), defaultValue: String(defaultValue),
        dataset: { type: "number", field: "holdings.0.storage.resources.0.qty" },
        closest: () => ({ dataset: { storageHoldingId: "a", storageRowId: wood.id,
          storageRowRoomId: "small-room", storageResourceId: "wood" } }) }
    });
    const before = structuredClone(data);
    await edit(11, 6);
    assert.deepEqual(data, before, "an absolute increase cannot overfill the rendered room or record a false credit");
    await edit(10, 6);
    assert.equal(row(0).qty, 10);
    assert.equal(data.holdings[0].storage.log.at(-1).qty, 4);
    await edit(9, 10);
    assert.equal(row(0).qty, 9);
  } finally {
    Object.assign(data, saved);
  }
}

{
  const savedHoldings = structuredClone(data.holdings);
  const panel = { dataset: { storageHoldingId: "a", roomId: "outdoors" }, classList: { remove() {} } };
  const eventFor = (currentTarget) => ({ currentTarget, preventDefault() {}, stopPropagation() {} });
  const control = (dataset = {}, extra = {}) => ({
    dataset, closest: (selector) => selector === "[data-storage-drop-zone]" ? panel : null, ...extra
  });
  const requests = [];
  registerStorageOperationExecutor(request => { requests.push(request); return { ok: true }; });
  let finishDrop;
  foundry.utils = { fromUuid: () => new Promise(resolve => { finishDrop = resolve; }) };
  const dropping = manager._onStorageDrop({ ...eventFor(panel), dataTransfer: { getData: () => '{"uuid":"Item.dropped"}' } });
  manager._onSelectHolding(eventFor({ value: "b" }));
  finishDrop({ documentName: "Item", id: "dropped", uuid: "Item.dropped", type: "gear" });
  await dropping;
  assert.equal(requests[0].holdingId, "a", "an asynchronous Foundry drop stays in its rendered holding");
  assert.equal(manager.activeTab, "overview", "a completed drop cannot navigate a different holding's window");

  manager._moneyCopper = holding => holding.storage.moneyCopper;
  manager._setMoneyCopper = (holding, total) => { holding.storage.moneyCopper = total; };
  data.holdings[0].storage.moneyCopper = 120;
  data.holdings[1].storage.moneyCopper = 70;
  const moneyCounter = { dataset: { storageMoneyTotal: "100" } };
  const moneyControl = (dataset, value) => control(dataset, {
    value, closest: (selector) => selector === ".fbls-storage-money-counter" ? moneyCounter : panel
  });
  await manager._onStorageMoneyChange(eventFor(moneyControl({ storageMoneyField: "copper" }, "5")));
  assert.deepEqual(data.holdings.map(holding => holding.storage.moneyCopper), [120, 70], "a stale absolute treasury edit must be refused");
  await manager._onAdjustStorageMoney(eventFor(moneyControl({ moneyDenom: "silver", moneyOp: "plus" })));
  assert.deepEqual(data.holdings.map(holding => holding.storage.moneyCopper), [130, 70], "a treasury delta uses the rendered holding's current total");

  const logEntry = { id: "new-log", kind: "note", qty: 0, name: "Новая запись" };
  manager._confirmAction = async () => { data.holdings[0].storage.log.push(logEntry); return true; };
  await manager._onClearStorageLog(eventFor(control()));
  assert.ok(data.holdings[0].storage.log.some(entry => entry.id === logEntry.id), "new journal entries survive an older confirmation");
  data.holdings[1].storage.log.push(logEntry);
  manager._confirmAction = async () => true;
  await manager._onClearStorageLog(eventFor(control()));
  assert.equal(data.holdings[0].storage.log.length, 0);
  assert.ok(data.holdings[1].storage.log.some(entry => entry.id === logEntry.id), "clear log acts only on the rendered holding");

  const shown = [];
  globalThis.CONFIG = { Item: { documentClass: class {
    constructor(data) { this.sheet = { render: () => shown.push(data.name) }; }
  } } };
  data.holdings[0].storage.items = [{ id: "other", name: "Другая строка", roomId: "outdoors" },
    { id: "shared", name: "Канат из A", roomId: "outdoors" }];
  data.holdings[1].storage.items = [{ id: "shared", name: "Сундук из B", roomId: "outdoors" }];
  const itemButton = { dataset: { index: "0" }, closest: () => ({ dataset: { storageHoldingId: "a", storageRowId: "shared" } }) };
  game.user.isGM = false;
  await manager._onOpenStorageItem(eventFor(itemButton));
  assert.deepEqual(shown, ["Канат из A"], "a player opens the rendered item by its ID after reordering and navigation");
  data.holdings[0].visibility = "gm";
  await manager._onOpenStorageItem(eventFor(itemButton));
  assert.deepEqual(shown, ["Канат из A"], "a stale item card rechecks the current visibility");
  game.user.isGM = true;
  delete globalThis.CONFIG;

  data.holdings[0].visibility = "public";
  const savedRooms = manager._storageRooms;
  manager._storageRooms = () => [{ id: "outdoors", label: "Улица", available: true }, { id: "shed", label: "Сарай", available: true }];
  data.holdings[0].storage.resources.push({ ...wood, id: "shed-wood", roomId: "shed" });
  manager._onStorageBatchSelectionChange(eventFor(control({ storageBatchSelect: "shed-wood" }, { checked: true })));
  manager._onStorageBatchSelectionChange(eventFor(control({ storageBatchSelect: wood.id }, { checked: true })));
  assert.equal(manager._storageContext(data.holdings[1], true).batchSelection.selectedCount, 0,
    "matching row IDs in another holding never inherit the active batch selection");
  let moveDialogs = 0;
  SkyholdStorageActionDialog.open = async (config) => {
    moveDialogs++;
    assert.match(config.description, /Улица/);
    assert.equal(config.max, 1, "the only selection in the rendered room is movable");
    return null;
  };
  await manager._onStorageSelectionMove(eventFor(control({ storageBatchKind: "resources" })));
  assert.equal(moveDialogs, 1);
  game.user.isGM = false;
  game.users = [{ id: "gm", active: true, isGM: true }];
  game.socket = { emit() { throw new Error("a cancelled dialog cannot send a write"); } };
  await manager._onStorageSelectionMove(eventFor(control({ storageBatchKind: "resources" })));
  assert.equal(moveDialogs, 2, "a permitted player can preview the same rendered selection");
  data.holdings[0].gm.playersCanUseStorage = false;
  await manager._onStorageSelectionMove(eventFor(control({ storageBatchKind: "resources" })));
  assert.equal(moveDialogs, 2, "a stale player control rechecks access to the holding it represents");
  game.user.isGM = true;

  for (const holding of data.holdings) {
    holding.gm.defense.squads = [{ id: "shared", name: `Отряд ${holding.id}`, equipped: true,
      armamentResourceId: "armament-simple", armamentSourceRoomId: "outdoors" }];
  }
  const authority = { id: "gm", active: true, isGM: true };
  const player = { id: "player", active: true, isGM: false };
  game.user = authority;
  game.users = { contents: [authority, player] };
  const defenseExecutor = () => createStorageOperationExecutor({
    updateHolding: async (holdingId, updater, options) => {
      assert.equal(game.user.id, authority.id);
      assert.equal(options.localAuthority, true);
      return SkyholdData.updateHolding(holdingId, updater);
    }
  });
  registerStorageOperationExecutor(defenseExecutor());
  const defenseButton = (holding, choice) => {
    const squad = holding.gm.defense.squads[0];
    const card = { dataset: { holdingId: holding.id, squadId: squad.id, squadHash: stableDataHash(squad) },
      querySelector: () => ({ value: choice }) };
    return { closest: (selector) => selector === ".fbls-defense-squad" ? card : { dataset: { defenseHoldingId: holding.id } } };
  };
  manager._confirmAction = async () => { manager.activeHoldingId = "b"; return true; };
  manager.activeHoldingId = "a";
  await GmEventDomain._onDeleteDefenseSquad.call(manager, eventFor(defenseButton(data.holdings[0])));
  assert.deepEqual(data.holdings.map(holding => holding.gm.defense.squads.length), [0, 1]);
  const kits = (holding, resourceId) => holding.storage.resources.filter(row => row.resourceId === resourceId)
    .reduce((sum, row) => sum + row.qty, 0);
  assert.deepEqual(data.holdings.map(holding => kits(holding, "armament-simple")), [1, 0],
    "disbanding a squad returns the kit to the same holding that was confirmed");

  const sent = [];
  game.socket = { emit: (_channel, message) => sent.push(message) };
  game.user = player;
  const deliverToAuthority = async (request) => {
    assert.equal(request.type, "playerStorageOperationRequest");
    assert.equal(request.targetGmId, authority.id);
    game.user = authority;
    await handleSkyholdSocketPayload(request, player.id);
    game.user = player;
    const response = sent.shift();
    assert.equal(response.requestId, request.requestId);
    await handleSkyholdSocketPayload(response, authority.id);
    return response.result;
  };
  const finishPlayerDefense = async (pending) => {
    await Promise.resolve();
    const request = sent.shift();
    assert.ok(request, "the player action reaches the socket through the rendered card");
    const result = await deliverToAuthority(request);
    await pending;
    assert.equal(sent.length, 0);
    return { request, result };
  };
  const playerDefense = (method, button) => finishPlayerDefense(GmEventDomain[method].call(manager, eventFor(button)));
  const playerDefenseField = (field) => finishPlayerDefense(manager._onFieldChange(eventFor(field)));
  data.holdings[1].gm.playersCanEditDefense = true;
  data.holdings[1].gm.playersCanUseStorage = false;
  data.holdings[1].buildings.list.push({ id: "secret", name: "Скрытый арсенал", visibility: "gm" });
  data.holdings[1].storage.resources.push(
    { id: "hidden-complex", resourceId: "armament-complex", qty: 1, roomId: "secret" },
    { id: "hidden-elite", resourceId: "armament-elite", qty: 1, roomId: "secret" },
    { id: "visible-complex", resourceId: "armament-complex", qty: 1, roomId: "outdoors" }
  );
  const buttonBeforeAssignment = defenseButton(data.holdings[1], "armament-complex");
  const { request: assigned, result: assignedResult } = await playerDefense("_onAssignDefenseArmament", buttonBeforeAssignment);
  assert.equal(assignedResult.ok, true, "defense permission authorizes a narrowly scoped issue without warehouse write rights");
  assert.equal(data.holdings[1].gm.defense.squads[0].armamentResourceId, "armament-complex");
  assert.equal(data.holdings[1].storage.resources.find(row => row.id === "hidden-complex").qty, 1, "a player cannot consume hidden inventory");
  assert.equal(kits(data.holdings[1], "armament-complex"), 1);
  assert.equal(kits(data.holdings[1], "armament-simple"), 1, "the previous kit is returned atomically");
  assert.equal(data.holdings[1].storage.log.filter(row => row.operationId === assigned.requestId).length, 2);
  const { result: hiddenOnly } = await playerDefense("_onAssignDefenseArmament", defenseButton(data.holdings[1], "armament-elite"));
  assert.equal(hiddenOnly.ok, false);
  assert.doesNotMatch(hiddenOnly.message, /арсенал|secret/iu);
  const afterAssignment = structuredClone(data);
  registerStorageOperationExecutor(defenseExecutor());
  assert.equal((await deliverToAuthority(assigned)).replay, true, "the same request replays from the persisted receipt after executor restart");
  assert.deepEqual(data, afterAssignment);
  assert.equal((await playerDefense("_onUnassignDefenseArmament", buttonBeforeAssignment)).result.ok, false,
    "a stale card cannot return a newly assigned kit");
  assert.equal((await playerDefense("_onUnassignDefenseArmament", defenseButton(data.holdings[1]))).result.ok, true);
  assert.equal(kits(data.holdings[1], "armament-complex"), 2);

  data.holdings[1].people.list = [
    { id: "captain", name: "Капитан", age: 35, workAssignment: "soldier", background: "Солдат", attributes: { wits: 5, strength: 5 } },
    { id: "recruit", name: "Новобранец", age: 25, background: "Солдат", attributes: { wits: 4, strength: 5, agility: 5 } },
    { id: "closed-job", name: "Работник закрытого здания", age: 25, workAssignment: "secret", attributes: { strength: 6, agility: 6 } },
    { id: "sailor", name: "Матрос", age: 25, workAssignment: "soldier", background: "Солдат",
      attributes: { strength: 5, agility: 5 }, shipAssignment: { shipId: "expedition", away: true } }
  ];
  data.holdings[1] = mergeHoldingDefaults(data.holdings[1]);
  data.holdings[1].buildings.list.find(row => row.id === "secret").assignedWorkerIds = ["closed-job"];
  const commander = await playerDefenseField({ dataset: { field: "holdings.1.gm.defense.commanderId", defenseExpected: "" },
    value: "captain", closest: (selector) => selector === "[data-defense-holding-id]" ? { dataset: { defenseHoldingId: "b" } } : null });
  assert.equal(commander.result.ok, true);
  assert.equal(data.holdings[1].people.list[0].workAssignment, "defenseCommander");
  const beforeAbsent = structuredClone(data.holdings[1]);
  const absent = await playerDefenseField({ ...defenseButton(data.holdings[1]), value: "sailor",
    dataset: { field: "holdings.1.gm.defense.squads.0.memberIds.0" } });
  assert.equal(absent.result.ok, false, "the authority rechecks physical presence even with a current squad hash");
  assert.deepEqual(data.holdings[1], beforeAbsent, "rejected enlistment must not change staffing or wages");
  assert.equal((await playerDefense("_onFillDefenseSquadBest", defenseButton(data.holdings[1]))).result.ok, true,
    "the player can fill the squad and the authority owns the derived wages");
  assert.equal(data.holdings[1].gm.defense.squads[0].sergeantId, "recruit");
  assert.deepEqual(data.holdings[1].buildings.list.find(row => row.id === "secret").assignedWorkerIds, ["closed-job"],
    "the player cannot clear a hidden worker's assignment through squad autofill");
  assert.equal(data.holdings[1].people.list.find(row => row.id === "closed-job").workAssignment, "secret");
  assert.ok(data.holdings[1].people.list[1].salary > 0);
  data.holdings[1].people.list.push({ id: "recovering", age: 25, injuredDays: 3, workAssignment: "soldier",
    role: "Солдат: Другой отряд (Линейная пехота)", salary: 12, attributes: { strength: 3, agility: 3 } });
  const otherSquad = { id: "other-squad", name: "Другой отряд", type: "line", sergeantId: "",
    memberIds: ["recovering", "", "", ""] };
  data.holdings[1].gm.defense.squads.push(otherSquad);
  const edit = await playerDefenseField({ ...defenseButton(data.holdings[1]), value: "Караул",
    dataset: { field: "holdings.1.gm.defense.squads.0.name" } });
  assert.equal(edit.result.ok, true);
  assert.match(data.holdings[1].people.list[1].role, /Караул/);
  assert.equal(data.holdings[1].gm.defense.commanderId, "captain", "recalculating a different squad must preserve the acting commander");
  assert.deepEqual(data.holdings[1].gm.defense.squads[1].memberIds, otherSquad.memberIds);
  const recovering = data.holdings[1].people.list.find(row => row.id === "recovering");
  assert.equal(recovering.workAssignment, "soldier", "injury changes readiness without releasing an unrelated assignment");
  assert.equal(recovering.salary, 12);
  data.holdings[1].gm.defense.squads.pop();

  manager._confirmAction = async () => { data.holdings[1].gm.playersCanEditDefense = false; return true; };
  assert.equal((await playerDefense("_onDeleteDefenseSquad", defenseButton(data.holdings[1]))).result.ok, false);
  assert.equal(data.holdings[1].gm.defense.squads.length, 1, "a player's confirmation cannot outlive revoked defense access");
  data.holdings[1].gm.playersCanEditDefense = true;
  assert.equal((await playerDefense("_onAssignDefenseArmament", defenseButton(data.holdings[1], "armament-simple"))).result.ok, true);
  manager._confirmAction = async () => true;
  assert.equal((await playerDefense("_onDeleteDefenseSquad", defenseButton(data.holdings[1]))).result.ok, true);
  assert.equal(data.holdings[1].gm.defense.squads.length, 0);
  assert.equal(kits(data.holdings[1], "armament-simple"), 1, "armed disband returns a kit exactly once for a permitted player");
  assert.equal(data.holdings[1].people.list[1].workAssignment, "");
  assert.equal(data.holdings[1].people.list[1].salary, 0);
  delete game.users;
  delete game.socket;
  game.user = authority;

  for (const holding of data.holdings) holding.people.list = [{ id: "resident", name: `Житель ${holding.id}` }];
  const residentMenu = { ...ResidentEventDomain, activeHoldingId: "a", _canReturnResidentToShip: () => false, _closeResidentContextMenu() {} };
  game.user = player;
  await residentMenu._showResidentActionMenu("resident");
  assert.deepEqual(body.children.at(-1).children.map(button => button.dataset.action), ["edit"]);
  await ResidentEventDomain._onDeleteRow.call(manager,
    eventFor({ dataset: { holdingId: "a", collection: "holdings.0.people.list", id: "resident" } }));
  assert.equal(data.holdings[0].people.list.length, 1, "player profile permission cannot remove a resident");
  game.user = authority;
  await residentMenu._showResidentActionMenu("resident");
  assert.deepEqual(body.children.at(-1).children.map(button => button.dataset.action), ["edit", "mark-dead", "delete"]);
  foundry.utils.getProperty = (root, path) => path.split(".").reduce((node, key) => node?.[key], root);
  foundry.utils.setProperty = (root, path, value) => {
    const keys = path.split(".");
    const leaf = keys.pop();
    keys.reduce((node, key) => node[key], root)[leaf] = value;
  };
  SkyholdData.transaction = async (updater) => {
    const draft = structuredClone(data);
    const result = await updater(draft, { skip: SkyholdData.skipTransaction });
    if (result?.[skip]) return result.value;
    data.holdings = draft.holdings;
    return result;
  };
  manager._confirmAction = async () => { data.holdings.reverse(); return true; };
  await ResidentEventDomain._onDeleteRow.call(manager,
    eventFor({ dataset: { holdingId: "a", collection: "holdings.0.people.list", id: "resident" } }));
  assert.deepEqual(data.holdings.map(holding => [holding.id, holding.people.list.length]), [["b", 1], ["a", 0]],
    "a destructive confirmation resolves the holding again by ID after the array is reordered");
  manager._storageRooms = savedRooms;
  manager.storageBatchSelection.clear();
  data.holdings = savedHoldings;
  manager.activeHoldingId = "a";
}

const action = { rowId: wood.id, roomId: "outdoors" };
SkyholdStorageActionDialog.open = async () => {
  manager.activeHoldingId = "b";
  return "Заметка к первому складу";
};
await manager._openStorageNoteDialog(action);
assert.equal(row(0).notes, "Заметка к первому складу");
assert.equal(row(1).notes, "");

manager.activeHoldingId = "a";
SkyholdStorageActionDialog.open = async (config) => {
  assert.equal(config.max, 1, "the quantity dialog shows only available cargo");
  manager.activeHoldingId = "b";
  return 1;
};
manager._withdrawStoredResource = (request) => {
  assert.equal(request.holdingId, "a");
  assert.equal(request.expectedRevision, data.meta.revision);
  assert.equal(request.row.id, wood.id);
};
await manager._openStorageGiveDialog(action);

manager.activeHoldingId = "a";
data.holdings[0].special.transportV2.orders = [];
SkyholdStorageActionDialog.open = async () => {
  data.holdings[0].special.transportV2.orders.push(order);
  return true;
};
await manager._openStorageDeleteDialog(action);
assert.equal(row(0).qty, 5, "deleting must recheck reservations accepted during the dialog");
data.holdings[0].special.transportV2.orders = [];
SkyholdStorageActionDialog.open = async () => {
  manager.activeHoldingId = "b";
  return true;
};
await manager._openStorageDeleteDialog(action);
assert.equal(row(0), undefined);
assert.equal(row(1).qty, 6, "the confirmation stays bound to its original holding");

const warehouse = mergeHoldingDefaults({
  id: "warehouse", gm: { playersCanUseStorage: true },
  buildings: { list: [{ id: "hidden", name: "Тайная кладовая", visibility: "gm", constructionStatus: "built",
    functions: { storage: true }, storage: { capacity: 10 } }] },
  storage: {
    resources: [{ ...wood, forSale: true }, { ...wood, id: "hidden-wood", roomId: "hidden", forSale: true }],
    items: [{ id: "hidden-item", roomId: "hidden", name: "Тайный жетон", qty: 1 }],
    log: [
      { kind: "move-out", roomId: "hidden", qty: -1, operationId: "hidden-move" },
      { kind: "move-in", roomId: "outdoors", qty: 1, operationId: "hidden-move", note: "из Тайная кладовая" },
      { kind: "manual-add", roomId: "outdoors", qty: 1, operationId: "public" }
    ]
  }
});
warehouse.storage.log.push({ kind: "note", roomId: "outdoors", qty: 0, source: "Пакетное перемещение",
  note: "Предмет → Тайная кладовая", operationId: "legacy-overflow" });
warehouse.storage.log.push({ kind: "note", roomId: "outdoors", qty: 0, source: "Пакетное перемещение",
  note: "Старый предмет → Тайная кладовая", operationId: "expired-receipt" });
warehouse.storage.log.push({ kind: "move-in", roomId: "outdoors", qty: 1,
  note: "из Тайная кладовая", operationId: "trimmed-source" });
warehouse.storage.log.push({ kind: "note", roomId: "outdoors", qty: 0, source: "Пакетное перемещение",
  note: "Ящик → Открытый склад", operationId: "public-item-move" });
const movementReceipt = (operationId, fromRoomId, toRoomId, actualRoomId) => ({
  operationId, type: "system",
  payload: { signature: JSON.stringify({ type: "batchMove", fromRoomId, toRoomId }),
    result: { rowType: "items", placements: [{ roomId: actualRoomId, label: "Ящик" }] } }
});
warehouse.log.push(movementReceipt("legacy-overflow", "shed", "outdoors", "hidden"),
  movementReceipt("public-item-move", "shed", "outdoors", "outdoors"));
manager._storageRooms = () => [{ id: "outdoors", label: "Открытый склад", available: true },
  { id: "shed", label: "Обычная кладовая", available: true },
  { id: "hidden", label: "Тайная кладовая", available: true }];
manager.activeStorageTab = "log";
const quote = { marketId: "market", outboundOffers: [{ resourceId: "wood", demand: 20, unitPriceCopper: 1 }] };
for (const isGM of [true, false]) {
  game.user.isGM = isGM;
  const context = manager._storageContext(warehouse, true, "hidden");
  assert.equal(context.activeRoomId, isGM ? "hidden" : "outdoors");
  assert.equal(context.visibleCount, isGM ? 2 : 1);
  assert.equal(context.itemCount, isGM ? 1 : 0);
  assert.equal(context.logRows.length, isGM ? 7 : 3);
  assert.ok(context.logRows.some(entry => entry.note.includes("Ящик → Открытый склад")));
  assert.equal(/Тайная кладовая|Тайный жетон/.test(JSON.stringify(context)), isGM);
  const outbound = prepareMarketOutboundContext({ holding: warehouse, quote, isGM });
  assert.equal(outbound.offers[0].availableStock, isGM ? 12 : 6);
}

const actorJournal = structuredClone(warehouse);
actorJournal.storage.log.push(
  { kind: "manual-spend", source: "Выдача Foundry", roomId: "outdoors", qty: -1,
    note: "получатель: Скрытый персонаж", operationId: "private-withdraw" },
  { kind: "manual-add", source: "Предмет Foundry", roomId: "outdoors", qty: 1,
    note: "из Скрытый персонаж · переполнение: Тайная кладовая", operationId: "private-deposit" }
);
for (const isGM of [true, false]) {
  game.user.isGM = isGM;
  const visible = manager._storageLogRows(actorJournal).filter(row => row.operationId.startsWith("private-"));
  assert.equal(visible.length, 2, "the shared warehouse still shows the receipt and expense");
  assert.equal(JSON.stringify(visible).includes("Скрытый персонаж"), isGM, "a public warehouse cannot reveal a private Foundry Actor");
  assert.match(visible.find(row => row.operationId === "private-deposit").note, /переполнение/);
}

const ambiguousExport = structuredClone(warehouse);
ambiguousExport.storage.resources[1].id = ambiguousExport.storage.resources[0].id;
for (const isGM of [true, false]) {
  assert.equal(prepareMarketOutboundContext({ holding: ambiguousExport, quote, isGM }).offers.length, 0,
    "a duplicate ID across rooms must not be offered for a new export, even if only one row is visible");
}

const rooms = [{ id: "outdoors", label: "Открытый склад", available: true, unlimited: true },
  { id: "full", label: "Заполненный склад", available: true, free: 0 },
  { id: "hidden", label: "Тайная кладовая", available: true, free: 10 }];
manager._storageRooms = () => rooms;
const overflowHolding = structuredClone(warehouse);
const manual = manager._applyManualStorageChange(overflowHolding, { resourceId: "wood", qty: 2, roomId: "hidden",
  note: "Получено за день", operationId: "manual-overflow" });
assert.equal(manual.ok, true);
overflowHolding.storage.log.push({ kind: "collect", roomId: "outdoors", qty: 1,
  note: "Ручной сбор, переполнение: Тайная кладовая", operationId: "collect-overflow" });
for (const isGM of [true, false]) {
  game.user.isGM = isGM;
  const entry = manager._storageLogRows(overflowHolding, rooms).find(row => row.operationId === "manual-overflow");
  assert.equal(entry.qty, 2, "visible stock received by overflow remains in the player's journal");
  assert.match(entry.note, /Получено за день/);
  assert.equal(entry.note.includes("Тайная кладовая"), isGM, "an overflow note must not disclose the intended hidden room");
  const collected = manager._storageLogRows(overflowHolding, rooms).find(row => row.operationId === "collect-overflow");
  assert.equal(collected.qty, 1);
  assert.match(collected.note, /Ручной сбор, переполнение/);
  assert.equal(collected.note.includes("Тайная кладовая"), isGM, "manual collection uses a comma in the legacy overflow note");
}

const production = structuredClone(warehouse);
production.buildings.list.push(
  { id: "public-producer", name: "Новая вывеска", visibility: "public" },
  { id: "hidden-producer", name: "Закрытая мастерская", visibility: "gm" },
  { id: "public-lookalike", name: "Старая тайная кузница", visibility: "public" }
);
const output = (sourceId, source, qty) => ({ domain: "production", kind: "resource",
  resourceId: "wood", qty, roomId: "outdoors", sourceId, source });
const productionReceipt = (operationId, ledger, ledgerTruncated = false) => {
  manager._appendStorageLog(production, economyLedgerStorageRows(ledger, { operationId }));
  production.log.push({ operationId, type: "tenday", payload: buildTendayOperationPayload({ report: { ledger, ledgerTruncated } }) });
};
productionReceipt("production-names", [
  output("public-producer", "Прежняя открытая мастерская", 1),
  output("hidden-producer", "Старая тайная кузница", 2),
  output("deleted-producer", "Снесённый тайный цех", 3),
  output("public-producer", "Совпавшее имя", 4),
  output("hidden-producer", "Совпавшее имя", 4)
]);
productionReceipt("truncated-production", [output("public-producer", "Неполная квитанция", 5)], true);
manager._appendStorageLog(production, [{ kind: "collect", resourceId: "wood", roomId: "outdoors",
  source: "Старая тайная кузница", qty: 6, operationId: "legacy-collection" }]);
for (const isGM of [true, false]) {
  game.user.isGM = isGM;
  const journal = manager._storageLogRows(production, rooms);
  const labels = journal.filter(row => row.operationId === "production-names").map(row => row.source);
  assert.deepEqual(labels, isGM
    ? ["Совпавшее имя", "Совпавшее имя", "Снесённый тайный цех", "Старая тайная кузница", "Прежняя открытая мастерская"]
    : ["Источник недоступен", "Источник недоступен", "Источник недоступен", "Источник недоступен", "Новая вывеска"]);
  assert.equal(journal.find(row => row.operationId === "truncated-production").source, isGM ? "Неполная квитанция" : "Источник недоступен");
  const legacy = journal.find(row => row.operationId === "legacy-collection");
  assert.equal(legacy.source, isGM ? "Старая тайная кузница" : "Источник недоступен",
    "a public building with the same name cannot identify an old collection entry");
  assert.equal(legacy.qty, 6, "redaction must retain the amount stored in a public room");
}

const staffing = mergeHoldingDefaults({
  id: "staffing", visibility: "public", gm: { playersCanEditBuildings: true },
  buildings: { list: [
    { id: "secret-work", name: "Закрытый арсенал", visibility: "gm", constructionStatus: "built",
      workersMax: 2, assignedWorkerIds: ["keeper"] },
    { id: "public-work", name: "Открытая мастерская", constructionStatus: "built", workersMax: 2 }
  ] },
  people: { list: [
    { id: "keeper", name: "Хранитель", age: 30, workAssignment: "secret-work", role: "Закрытый арсенал" },
    { id: "available", name: "Подмастерье", age: 30 }
  ] }
});
const residents = { ...ResidentDomain, _constructionCrews: () => [], _safeNumber: manager._safeNumber,
  _workMorale: () => ({ value: 1, conditions: 1, reason: "условия: +1 (Закрытый арсенал +1 × 20 QD)" }),
  _personMatchesResidentFilters: () => true };
for (const isGM of [true, false]) {
  game.user.isGM = isGM;
  const rows = residents._prepareRows(staffing, false, "people", { canEditBuildings: true });
  assert.equal(rows.residentWorkOptionCatalog.some((option) => option.value === "secret-work"), isGM);
  assert.ok(rows.residentWorkOptionCatalog.some((option) => option.value === "public-work"));
  assert.equal(rows.people[0].workLabel, isGM ? "Закрытый арсенал" : "Назначение скрыто");
  assert.equal(rows.people[0].workInlineValue, isGM ? "secret-work" : undefined);
  assert.equal(rows.people[0].moraleTooltip.includes("Закрытый арсенал"), isGM, "the player tooltip must not disclose a prior workplace");
}
const visibleAtRender = { meta: { revision: 1 }, holdings: [structuredClone(staffing)] };
visibleAtRender.holdings[0].buildings.list[0].visibility = "public";
const playerDraft = structuredClone(visibleAtRender);
playerDraft.holdings[0].people.list[1].workAssignment = "secret-work";
const afterGmChange = { meta: { revision: 2 }, holdings: [staffing] };
const deniedAssignment = validatePlayerPatch(afterGmChange, buildPlayerPatch(visibleAtRender, playerDraft), "player");
assert.equal(deniedAssignment.ok, false, "the authority must reject a now-hidden workplace even when resident fields have not changed");
assert.doesNotMatch(deniedAssignment.error, /secret-work|Закрытый арсенал/);

const recovering = structuredClone(afterGmChange);
const recoveringHolding = recovering.holdings[0];
recoveringHolding.people.list[0].injuredDays = 3;
recoveringHolding.people.list[1].injuredDays = 2;
recoveringHolding.constructionCrews.push({ id: "crew", name: "Бригада", leaderId: "recovering-leader", memberIds: ["recovering-builder"] });
recoveringHolding.people.list.push(
  { id: "recovering-leader", age: 30, injuredDays: 1, workAssignment: "construction-leader:crew" },
  { id: "recovering-builder", age: 30, injuredDays: 1, workAssignment: "construction:crew" }
);
const renamed = structuredClone(recovering);
renamed.holdings[0].buildings.list[1].name = "Открытая мастерская";
assert.equal(validatePlayerPatch(recovering, buildPlayerPatch(recovering, renamed), "player").ok, true,
  "an existing injury in a hidden building or a construction crew must not block unrelated public edits");
const assigning = structuredClone(recovering);
const newBuilding = assigning.holdings[0].buildings.list[1];
newBuilding.assignedWorkerIds = ["available"];
Object.assign(assigning.holdings[0].people.list[1], { workAssignment: newBuilding.id, role: newBuilding.workerRole || newBuilding.name });
const newlyInjured = validatePlayerPatch(recovering, buildPlayerPatch(recovering, assigning), "player");
assert.equal(newlyInjured.ok, false, "a new injured worker must still be refused at the authority");
assert.match(newlyInjured.error, /недоступного жителя/);

const playerProfile = structuredClone(visibleAtRender);
playerProfile.holdings[0].gm.playersCanEditResidents = true;
const editedProfile = structuredClone(playerProfile);
editedProfile.holdings[0].people.list[1].background = "Офицер";
assert.equal(validatePlayerPatch(playerProfile, buildPlayerPatch(playerProfile, editedProfile), "player").ok, false,
  "editing residents and buildings must not grant the right to change military background");
const residentTemplate = readFileSync("templates/parts/skyhold-resident-editor.hbs", "utf8");
assert.match(residentTemplate, /<select data-field="[^"]+\.background" {{#unless @root\.isGM}}disabled\b/,
  "the resident card must not offer a writable background control to a player");

let movementHolding = structuredClone(warehouse);
movementHolding.storage.items.push({ id: "public-item", name: "Предмет", roomId: "outdoors", qty: 1 });
const move = createStorageOperationExecutor({
  logic: manager,
  getUser: id => ({ id, isGM: id === "gm" }),
  skipTransaction: SkyholdData.skipTransaction,
  async updateHolding(_id, updater) {
    const draft = structuredClone(movementHolding);
    const result = await updater(draft, { meta: { revision: 1 } });
    if (result?.[skip]) return result.value;
    movementHolding = draft;
    return result;
  }
});
const movement = { type: "batchMove", holdingId: warehouse.id, rowType: "items", rowIds: ["public-item"],
  fromRoomId: "outdoors", toRoomId: "full", expectedRevision: 1 };
const movementBefore = structuredClone(movementHolding);
const player = { userId: "player", remote: true };
assert.equal((await move({ ...movement, operationId: "player-hidden", toRoomId: "hidden" }, player)).ok, false);
assert.equal((await move({ ...movement, operationId: "player-full" }, player)).ok, false,
  "player overflow cannot use a hidden room or create another stack in its source");
assert.deepEqual(movementHolding, movementBefore);
const gmMove = await move({ ...movement, operationId: "gm-overflow" }, { userId: "gm" });
assert.equal(gmMove.placements[0].roomId, "hidden", "GM can use the physical capacity of the hidden warehouse");
assert.deepEqual(movementHolding.storage.log.filter(entry => entry.operationId === "gm-overflow")
  .map(({ roomId, qty }) => [roomId, qty]), [["outdoors", -1], ["hidden", 1]]);
assert.equal(manager._storageLogRows(movementHolding, rooms).some(entry => entry.operationId === "gm-overflow"), false,
  "player history hides both records of a GM move to a hidden overflow room");

const movedOut = await move({ ...movement, operationId: "removed-room", fromRoomId: "hidden", toRoomId: "outdoors" }, { userId: "gm" });
assert.equal(movedOut.ok, true);
assert.equal(manager._storageLogRows(movementHolding, rooms).some(row => row.operationId === "removed-room"), false);
const savedMovement = { holdings: [movementHolding] };
deleteCollectionRow(savedMovement, "holdings.0.buildings.list", "hidden");
const afterRemoval = mergeHoldingDefaults(savedMovement.holdings[0]);
const currentRooms = rooms.filter(room => room.id !== "hidden");
assert.ok(!afterRemoval.storage.items.some(row => row.roomId === "hidden"),
  "deleting the last hidden room must not strand its items outside every room tab");
const recoveredWood = afterRemoval.storage.resources.find(row => row.id === "hidden-wood");
assert.equal(recoveredWood.roomId, "outdoors");
assert.deepEqual(recoveredWood.batches, wood.batches, "relocation preserves the lots used by existing bookings");
manager._storageRooms = () => currentRooms;
const publicItemContext = manager._storageContext(afterRemoval, true, "outdoors");
assert.equal(publicItemContext.visibleCount, afterRemoval.storage.resources.filter(row => row.qty > 0).length);
manager.activeStorageTab = "items";
assert.ok(manager._storageContext(afterRemoval, true, "outdoors").activeItemRows.some(row => row.id === "hidden-item"));
manager.activeStorageTab = "log";
manager._storageRooms = () => rooms;
const history = manager._storageLogRows(afterRemoval, currentRooms).filter(row => row.operationId === "removed-room");
assert.deepEqual(history.map(row => [row.qty, row.note]), [[1, "Открытый склад"]],
  "after the last hidden room was deleted the player sees the public credit without historical room text");
game.user.isGM = true;
assert.ok(manager._storageLogRows(afterRemoval, currentRooms)
  .some(row => row.operationId === "removed-room" && row.note.includes("Тайная кладовая")), "the GM retains the original detail");
game.user.isGM = false;

for (const file of ["resources", "items", "tabs", "log"]) {
  const template = readFileSync(`templates/parts/storage/${file}.hbs`, "utf8");
  const stack = [];
  for (const match of template.matchAll(/{{#(if|unless|each)\s+([^}]+)}}|{{\/(if|unless|each)}}|<input\b[^>]*>|<button\b[^>]*>/g)) {
    if (match[1]) stack.push(match[2]);
    else if (match[3]) stack.pop();
    else if (/data-field=|data-storage-money-field=|data-action="(?:adjust-storage-money|clear-storage-log|pick-storage-resource|check-storage-transfer)"/.test(match[0])) {
      assert.ok(stack.some(condition => /^(?:\.\.\/)?isGM$/.test(condition)), `${file}: a GM-only control must be gated by GM permissions`);
    }
  }
}
console.log("Storage UI: GM/player permissions, batch quantity, protected cargo, dialog targets and hidden-room views passed.");
