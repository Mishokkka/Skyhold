import assert from "node:assert/strict";
import { BANK_PRESETS } from "../data/banks.js";
import { SkyholdData, registerMarketOperationExecutor } from "../data/store.js";
import { openBankDeposit } from "../engines/economy/bank-deposits.js";

globalThis.foundry = { applications: { api: { ApplicationV2: class {
  constructor(options) { this.id = options.id; }
  async _prepareContext() { return {}; }
  async _onRender() {}
  render() { return this; }
  async close() {}
}, HandlebarsApplicationMixin: (Base) => Base } } };
const gm = { id: "gm", isGM: true, active: true };
globalThis.game = { user: gm, users: [gm], settings: { get() {} }, modules: new Map(), socket: { emit() {} } };
const warnings = []; globalThis.ui = { notifications: { warn: (text) => warnings.push(text) } };
const { SkyholdBankApp } = await import("../apps/bank-app.js");
let data = { meta: { revision: 1 }, catalog: { banks: structuredClone(BANK_PRESETS) }, holdings: [
  { id: "village", name: "Поселение", visibility: "public", gm: { playersCanUseStorage: true }, special: {}, storage: { moneyCopper: 10000 } }
] };
SkyholdData.view = () => data;
let writes = 0;
SkyholdData.transaction = async (updater) => { const draft = structuredClone(data); updater(draft); draft.meta.revision++; writes++; data = draft; };
const event = { preventDefault() {} };
const action = (app, name, values = {}) => app._action(event, { dataset: { action: name, ...values } });
const app = new SkyholdBankApp({ holdingId: "village" });
let renders = 0; app.requestRender = () => { renders++; };
const before = JSON.stringify(data);
let context = await app._prepareContext({});
assert.equal(JSON.stringify(data), before, "opening the window is read-only");
assert.equal(context.comparison.selected.principal, 1011);
app.state.page = 999; await app._prepareContext({}); assert.equal(app.state.page, 0, "a shortened catalog clamps the stored page, preserving navigation");
await action(app, "bank-review"); assert.equal(writes, 0, "review never submits an operation");
assert.equal(app._confirmation.operation.amountCopper, 1011);
data.meta.revision++;
assert.equal((await app._prepareContext({})).confirmationStale, true, "render cannot silently refresh a reviewed contract");
await action(app, "bank-cancel");

app.state.tab = "admin"; context = await app._prepareContext({});
assert.equal(context.editor.bank.id, "merchant");
const buttons = [{ disabled: true }, { disabled: true }], listeners = {}, status = { textContent: "" };
app.element = { ownerDocument: {}, querySelectorAll: (selector) => selector.includes('data-action="bank-save"') ? buttons : [],
  querySelector: () => status, addEventListener: (name, fn) => { listeners[name] = fn; } };
await app._onRender(context, {});
const field = { dataset: { bankField: "name" }, type: "text", value: "Мой банк", closest: (selector) => selector.includes("data-bank-view-field") ? field : selector === "[data-bank-id]" ? { dataset: { bankId: "merchant" } } : null };
listeners.input({ target: field, type: "input" });
assert.equal(buttons[0].disabled, false, "first edit immediately enables Save without replacing the focused input");
assert.match(status.textContent, /несохранённые/);
await action(app, "bank-tab", { tab: "borrow" }); await action(app, "bank-tab", { tab: "admin" });
assert.equal((await app._prepareContext({})).editor.bank.name, "Мой банк");
app._draftBanks[0].offers[0].annualRateBps = 25000;
await action(app, "bank-save"); assert.equal(writes, 0); assert.match(app._editorError, /ставку/);
assert.equal(app._draftBanks[0].offers[0].annualRateBps, 25000);
await action(app, "bank-discard"); assert.equal((await app._prepareContext({})).editor.bank.name, BANK_PRESETS[0].name);
app._ensureDraft(); app._draftBanks[0].name = "Сохранённый банк";
await action(app, "bank-save"); assert.equal(writes, 1); assert.equal(data.catalog.banks[0].name, "Сохранённый банк");
app._ensureDraft(); app._draftBanks[0].name = "Конкурирующий черновик"; data.catalog.banks[1].name = "Чужое изменение";
await action(app, "bank-save"); assert.equal(writes, 1); assert.ok(app._draftBanks); assert.match(app._editorError, /другом окне/);
await action(app, "bank-discard");

game.user = { id: "player", isGM: false };
app.state.tab = "admin"; context = await app._prepareContext({});
assert.equal(context.admin, false); assert.equal(context.editor, null); assert.equal(context.canTransact, true);
await action(app, "bank-add"); assert.equal(app._draftBanks, null, "player cannot create a draft");
game.users = []; context = await app._prepareContext({}); assert.equal(context.canTransact, false); assert.match(context.readonlyMessage, /нет активного GM/);
data.holdings[0].gm.playersCanUseStorage = false; context = await app._prepareContext({}); assert.match(context.readonlyMessage, /не разрешил/);
game.user = gm; game.users = [gm]; data.holdings[0].gm.playersCanUseStorage = true;

openBankDeposit({ data, holding: data.holdings[0], bankId: "merchant", offerId: "reserve", amountCopper: 1000, operationId: "storage-contract" });
app.state.tab = "contracts"; app.state.contractKind = "deposits"; context = await app._prepareContext({});
assert.equal(app.state.contractId, "storage-contract", "the first visible contract accepts a custom amount without an extra selection click");
app.state.payment = 300; context = await app._prepareContext({}); assert.equal(context.contracts.payment.operation.amountCopper, 300);
await action(app, "bank-review");
let rejectPending, seenId;
registerMarketOperationExecutor((operation) => { seenId = operation.operationId; return new Promise((_resolve, reject) => { rejectPending = reject; }); });
const pending = action(app, "bank-confirm"); await Promise.resolve();
assert.equal(app._busy, true); assert.ok(renders > 0); assert.equal((await app._prepareContext({})).busy, true);
await action(app, "bank-review"); assert.equal(app._pendingOperation.operationId, seenId);
rejectPending(Object.assign(new Error("timeout"), { code: "timeout" })); await pending;
assert.equal(app._pendingOperation.operationId, seenId);
await app.close();
const reopened = new SkyholdBankApp({ holdingId: "village" }); reopened.requestRender = () => {};
assert.equal(reopened._pendingOperation.operationId, seenId, "close/reopen preserves the uncertain operation ID");
registerMarketOperationExecutor(async (operation) => { assert.equal(operation.operationId, seenId); return { ok: true, depositId: "storage-contract", replay: true }; });
await reopened._prepareContext({}); await action(reopened, "bank-retry");
assert.equal(reopened._pendingOperation, null);
console.log("Bank window checks passed: review/staleness, editor validation/conflicts/drafts, GM/player/offline, first-contract payment, busy feedback and close/reopen retry.");
