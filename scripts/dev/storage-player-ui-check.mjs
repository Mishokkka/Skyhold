import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.foundry = { applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: Base => Base } } };
const { StorageEventDomain } = await import("../apps/domains/events/storage-events.js");
const { createStorageOperationExecutor } = await import("../apps/storage-operation-executor.js");

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
console.log("Storage UI permissions: player/GM menus, early local refusals, protected controls and unchanged authority checks passed.");
