import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SkyholdData } from "../data/store.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { FinanceStorageDomain } from "../apps/domains/finance/storage-domain.js";
import { prepareMarketOutboundContext } from "../apps/market/outbound-context.js";
import { normalizeStorageRoomId } from "../engines/storage/capacity.js";

globalThis.foundry = { applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: Base => Base } } };
const { StorageEventDomain } = await import("../apps/domains/events/storage-events.js");
const { createStorageOperationExecutor } = await import("../apps/storage-operation-executor.js");
const { SkyholdStorageActionDialog } = await import("../apps/storage-action-dialog.js");
const { NavigationEventDomain } = await import("../apps/domains/events/navigation-events.js");

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
globalThis.ui = { notifications: { warn: () => warnings++ } };
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
const manager = { ...FinanceStorageDomain, ...StorageEventDomain, ...NavigationEventDomain, activeHoldingId: "a",
  _safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
  _normalizeStorageRoomId: normalizeStorageRoomId,
  _formatNumber: String, _moneyContext: () => ({}), _canPlayerWriteFieldPath: () => game.user.isGM, _sanitizeTextBlock: value => value,
  _activeWritableHoldingId() { return this.activeHoldingId; },
  requestRender() {}, _storageDefaultActor: () => ({ id: "actor" }) };
const qtyChange = (value) => manager._onFieldChange({
  preventDefault() {},
  currentTarget: { value: String(value), dataset: { type: "number", field: "holdings.0.storage.resources.0.qty" },
    closest: () => ({ dataset: { storageRowId: wood.id, storageRowRoomId: "outdoors" } }) }
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
    closest: () => ({ dataset: { storageRowId: "sale-item", storageRowRoomId: "outdoors" } }) }
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

await qtyChange(9);
assert.equal(row(0).qty, 9, "inline quantity survives actual holding normalization");
assert.deepEqual(row(0).batches.find(batch => batch.id === "wood-batch"), wood.batches[0]);
assert.equal(row(0).batches.find(batch => batch.ageQd === 0).qty, 3);
const afterIncrease = structuredClone(data);
await qtyChange(3);
assert.deepEqual(data, afterIncrease, "the inline editor must not lower stock beneath accepted cargo");
await qtyChange(5);
assert.equal(row(0).qty, 5);
assert.equal(row(0).batches.find(batch => batch.id === "wood-batch").qty, 4);

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
    result: { rowType: "items", placements: [{ roomId: actualRoomId }] } }
});
warehouse.log.push(movementReceipt("legacy-overflow", "shed", "outdoors", "hidden"),
  movementReceipt("public-item-move", "shed", "outdoors", "outdoors"));
manager._storageRooms = () => [{ id: "outdoors", label: "Открытый склад", available: true },
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

const rooms = [{ id: "outdoors", label: "Открытый склад", available: true, unlimited: true },
  { id: "full", label: "Заполненный склад", available: true, free: 0 },
  { id: "hidden", label: "Тайная кладовая", available: true, free: 10 }];
manager._storageRooms = () => rooms;
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

for (const file of ["resources", "items", "tabs", "log"]) {
  const template = readFileSync(`templates/parts/storage/${file}.hbs`, "utf8");
  const stack = [];
  for (const match of template.matchAll(/{{#(if|unless|each)\s+([^}]+)}}|{{\/(if|unless|each)}}|<input\b[^>]*>|<button\b[^>]*>/g)) {
    if (match[1]) stack.push(match[2]);
    else if (match[3]) stack.pop();
    else if (/data-field=|data-storage-money-field=|data-action="(?:adjust-storage-money|clear-storage-log|pick-storage-resource)"/.test(match[0])) {
      assert.ok(stack.some(condition => /^(?:\.\.\/)?isGM$/.test(condition)), `${file}: a GM-only control must be gated by GM permissions`);
    }
  }
}
console.log("Storage UI: GM/player permissions, batch quantity, protected cargo, dialog targets and hidden-room views passed.");
