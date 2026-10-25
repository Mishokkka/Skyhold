import { MODULE_ID } from "../data/constants.js";
import { requestMarketOperation, SkyholdData } from "../data/store.js";
import { findReadableHoldingEntry } from "../data/access-guard.js";
import { holdingPermissionContext } from "../data/holding-permissions.js";
import { BANK_PRESETS, bankCatalog, normalizeBank, validateBankCatalog } from "../data/banks.js";
import { bankState, bankTermsToken, prepareBankingModel, bankLoanBalance } from "../engines/economy/banking.js";
import { depositInterestAtTerm } from "../engines/economy/bank-deposits.js";
import { prepareBankComparison, prepareBankContracts, bankEditorContext } from "./domains/finance/bank-context.js";
import { stableDataHash } from "../data/storage-commit.js";
import { makeId } from "../data/utils.js";
import { formatCopperCurrencyCompact as money } from "../core/currency.js";
import { DisclosureState } from "./common/disclosure-state.js";
import { bindTabNavigation } from "./common/tab-navigation.js";
import { RenderSchedulerMixin } from "./common/render-scheduler.js";
import { restoreApplicationFocus } from "./common/window-focus-keeper.js";
import { requestSkyholdAppRender } from "./registry.js";
import { saveStatusContext, syncSaveStatus } from "./common/save-status.js";
import { FloatingTooltipsMixin } from "./common/floating-tooltip.js";
import { HeldActionRenderMixin } from "./common/held-action-render.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const EDIT_ACTIONS = ["bank-add", "bank-save", "bank-discard", "bank-clone", "bank-add-offer", "bank-remove-offer"];
const ACTIONS = [...EDIT_ACTIONS, "bank-tab", "bank-select", "bank-page", "bank-review", "bank-confirm", "bank-cancel", "bank-retry", "bank-contract-kind", "bank-history", "bank-contract", "bank-payment-max", "bank-editor-select"];
export class SkyholdBankApp extends FloatingTooltipsMixin(HeldActionRenderMixin(RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2)))) {
  static inFlight = new Set();
  static instances = new Map();
  static sessions = new Map();
  static DEFAULT_OPTIONS = {
    id: "fbls-banks", classes: ["fbl-skyhold", "fbls-secondary", "fbl-skyhold-bank"], tag: "div",
    window: { title: "Банки поселения", resizable: true }, position: { width: 1100, height: 780 },
    actions: Object.fromEntries(ACTIONS.map((id) => [id, function(event, target) { return this._action(event, target); }]))
  };
  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/bank-app.hbs` } };
  static open({ holdingId } = {}) {
    const id = String(holdingId ?? "");
    let app = this.instances.get(id);
    if (!app) { app = new this({ holdingId: id }); this.instances.set(id, app); }
    app.render({ force: true, focus: true }); return app;
  }
  static rerenderOpen({ skipFocused = false } = {}) {
    for (const app of this.instances.values()) {
      if (skipFocused && app.element?.contains(globalThis.document?.activeElement)) continue;
      app.requestRender({ focus: false });
    }
  }
  constructor({ holdingId } = {}, options = {}) {
    super({ ...options, id: `fbls-banks-${holdingId}` }); this.holdingId = holdingId;
    // ApplicationV2.state is its read-only render lifecycle, not our view model.
    this._bankViewState = { tab: "borrow", amount: 1000, days: 60, query: "", sort: "value", availableOnly: false, page: 0,
      contractKind: "loans", history: false, contractPage: 0, contractId: "", payment: null, editorId: "", editorQuery: "", editorPage: 0 };
    const session = this.constructor.sessions.get(holdingId);
    if (session) {
      Object.assign(this._bankViewState, session.state); this._draftBanks = session.draft; this._catalogToken = session.token; this._pendingOperation = session.pending;
      this._catalogSave = session.saving; this._busy = Boolean(this._catalogSave || this.constructor.inFlight.has(this._pendingOperation?.operationId));
    }
    this._disclosures = new DisclosureState();
  }
  _catalogStatus() {
    return saveStatusContext("manual", this._catalogSave ? "saving" : this._editorError ? "error" : this._draftBanks ? "dirty" : "saved");
  }
  async _prepareContext(options) {
    const base = await super._prepareContext(options), data = SkyholdData.view();
    const { holding } = findReadableHoldingEntry(data, this.holdingId);
    if (!holding) { this._view = null; return { ...base, hasHolding: false }; }
    const permissions = holdingPermissionContext(holding), canTransact = permissions.canUseStorage;
    if (!permissions.isGM && this._bankViewState.tab === "admin") this._bankViewState.tab = "borrow";
    const model = prepareBankingModel(data, holding), sourceToken = bankTermsToken(data, holding);
    this._view = { data, holding, model, revision: data.meta?.revision, sourceToken, canTransact };
    const blocked = Boolean(this._busy || this._pendingOperation), deposits = (bankState(holding).deposits ?? []).filter((row) => row.status !== "closed");
    const placed = deposits.reduce((n, row) => n + row.principalCopper, 0);
    const projected = deposits.reduce((n, row) => n + (row.kind === "term" ? depositInterestAtTerm(row.principalCopper, row.annualRateBps, row.termDays) : 0), 0);
    const borrow = this._bankViewState.tab === "borrow", deposit = this._bankViewState.tab === "deposit", contractsTab = this._bankViewState.tab === "contracts", admin = this._bankViewState.tab === "admin" && permissions.isGM;
    const comparison = borrow || deposit ? prepareBankComparison({ ...this._view, state: this._bankViewState, canTransact, blocked }) : null;
    const contracts = contractsTab ? prepareBankContracts({ holding, state: this._bankViewState, canTransact, blocked }) : null;
    const editor = admin ? bankEditorContext(this._draftBanks ?? model.banks, this._bankViewState) : null;
    if (comparison) this._bankViewState.page = comparison.page;
    if (contracts) this._bankViewState.contractPage = contracts.page;
    if (editor) this._bankViewState.editorPage = editor.page;
    if (contracts?.payment) {
      if (this._bankViewState.contractId !== contracts.payment.id) this._bankViewState.payment = null;
      this._bankViewState.contractId = contracts.payment.id;
    }
    if (editor?.bank) this._bankViewState.editorId = editor.bank.id;
    const confirmationStale = this._confirmation && (this._confirmation.operation.sourceToken !== sourceToken || this._confirmation.operation.expectedRevision !== data.meta?.revision);
    return { ...base, hasHolding: true, holdingName: holding.name, isGM: permissions.isGM, canTransact, blocked, busy: this._busy,
      readonlyMessage: !permissions.mayUseStorage ? "ГМ не разрешил распоряжаться казной этого поселения." : !canTransact ? permissions.authorityStatus.detail : "",
      state: this._bankViewState, sortRate: this._bankViewState.sort === "rate", borrow, deposit, contractsTab, admin, comparison, contracts, editor, dirty: Boolean(this._draftBanks), editorError: this._editorError,
      saveStatus: this._catalogStatus(), bankCount: model.banks.length, treasuryText: money(holding.storage?.moneyCopper), placedText: money(placed), projectedText: money(projected),
      pending: Boolean(this._pendingOperation), confirmation: this._confirmation, confirmationStale, canConfirm: canTransact && !blocked && !confirmationStale,
      presets: BANK_PRESETS, history: this._bankViewState.history, loanContracts: this._bankViewState.contractKind === "loans", depositContracts: this._bankViewState.contractKind === "deposits" };
  }
  async _onRender(context, options) {
    await super._onRender(context, options); this._listeners?.abort(); this._listeners = new AbortController();
    this._disclosures.bind(this.element); bindTabNavigation(this, this.element, { signal: this._listeners.signal });
    const update = (event) => {
      const field = event.target.closest("[data-bank-view-field], [data-bank-field]");
      if (!field) return;
      if (field.dataset.bankField && globalThis.game?.user?.isGM && !this._busy) {
        this._ensureDraft();
        for (const button of this.element.querySelectorAll('[data-action="bank-save"], [data-action="bank-discard"]')) button.disabled = false;
        syncSaveStatus(this.element, { context: this._catalogStatus() });
        const bank = this._draftBanks.find((row) => row.id === field.closest("[data-bank-id]")?.dataset.bankId);
        const group = field.closest("[data-offer-group]")?.dataset.offerGroup, id = field.closest("[data-offer-id]")?.dataset.offerId;
        const row = id ? bank?.[group]?.find((offer) => offer.id === id) : bank;
        if (row) {
          row[field.dataset.bankField] = field.type === "checkbox" ? field.checked : field.type === "number" ? Number(((field.value === "" ? NaN : Number(field.value)) * (field.hasAttribute("data-bank-percent") ? 100 : 1)).toFixed(8)) : field.value;
          if (field.dataset.bankField === "kind") { row.termDays = row.kind === "storage" ? 0 : row.termDays || 60; row.annualRateBps = row.kind === "storage" ? 0 : row.annualRateBps || 300; this.requestRender({ focus: false }); }
        }
      }
      if (field.dataset.bankViewField) {
        const key = field.dataset.bankViewField;
        this._bankViewState[key] = field.type === "checkbox" ? field.checked : field.type === "number" ? Number(field.value) : field.value;
        if (key === "editorQuery") this._bankViewState.editorPage = 0; else this._bankViewState.page = 0;
        this._confirmation = null;
        if (event.type === "change") this.requestRender({ focus: false });
      }
    };
    this.element?.addEventListener("input", update, { signal: this._listeners.signal });
    this.element?.addEventListener("change", update, { signal: this._listeners.signal });
    if (this._busy) for (const field of this.element?.querySelectorAll(".fbls-bank-shell :is(button, input, select, textarea)") ?? []) field.disabled = true;
    restoreApplicationFocus(this, options);
  }
  _ensureDraft() {
    if (this._draftBanks) return;
    const current = bankCatalog(SkyholdData.view()); this._catalogToken = stableDataHash(current); this._draftBanks = structuredClone(current);
  }
  async _edit(action, target) {
    if (!globalThis.game?.user?.isGM) return;
    if (action === "bank-discard") { this._draftBanks = null; this._editorError = ""; return; }
    this._ensureDraft();
    let bank = this._draftBanks.find((row) => row.id === this._bankViewState.editorId) ?? this._draftBanks[0];
    if (action === "bank-add") {
      const preset = BANK_PRESETS.find((row) => row.id === this.element?.querySelector("[data-bank-preset]")?.value) ?? BANK_PRESETS[0];
      bank = normalizeBank({ ...structuredClone(preset), id: makeId("bank", 16) }); this._draftBanks.push(bank); this._bankViewState.editorId = bank.id;
    }
    if (action === "bank-clone" && bank) { bank = { ...structuredClone(bank), id: makeId("bank", 16), name: `${bank.name.slice(0, 150)} · копия` }; this._draftBanks.push(bank); this._bankViewState.editorId = bank.id; }
    if (action === "bank-add-offer" && bank) {
      const key = target.dataset.group === "depositOffers" ? "depositOffers" : "offers", rows = bank[key] ??= [];
      if (rows.length >= 20) throw new Error("Достигнут предел 20 предложений этого вида.");
      rows.push({ ...structuredClone(BANK_PRESETS[0][key][key === "offers" ? 0 : 1]), id: makeId("offer", 16), active: true });
    }
    if (action === "bank-remove-offer" && bank) {
      const key = target.dataset.group === "depositOffers" ? "depositOffers" : "offers"; bank[key] = bank[key].filter((row) => row.id !== target.dataset.offerId);
    }
    if (action === "bank-save") {
      const invalid = [...(this.element?.querySelectorAll("[data-bank-field]") ?? [])].find((field) => !field.checkValidity()), error = validateBankCatalog(this._draftBanks);
      if (invalid || error) { invalid?.reportValidity(); throw new Error(error || "Проверьте заполнение полей редактора."); }
      const draft = this._draftBanks.map(normalizeBank), token = this._catalogToken;
      const save = { draft: this._draftBanks, sourceHash: stableDataHash(this._draftBanks), savedToken: stableDataHash(draft) };
      this._catalogSave = save;
      this._busy = true; this.requestRender({ focus: false });
      try {
        await SkyholdData.transaction((data) => {
          if (stableDataHash(bankCatalog(data)) !== token) throw new Error("Общий каталог изменился в другом окне. Черновик сохранён здесь; отмените изменения, чтобы загрузить актуальный каталог.");
          data.catalog.banks = draft;
        }, { reason: "bank-catalog", scope: "catalog" });
        this._settleCatalogSave(save);
        SkyholdBankApp.rerenderOpen();
      } catch (error) { this._settleCatalogSave(save, error); throw error; }
    }
  }
  _settleCatalogSave(save, error = null) {
    const unchanged = stableDataHash(save.draft) === save.sourceHash;
    for (const app of new Set([this, this.constructor.instances.get(this.holdingId)])) {
      if (app?._catalogSave !== save) continue;
      app._catalogSave = null; app._busy = false; app._editorError = error?.message ?? "";
      if (!error && app._draftBanks === save.draft) {
        if (unchanged) app._draftBanks = null;
        app._catalogToken = save.savedToken;
      }
      if (app !== this) app.requestRender({ focus: false });
    }
    const session = this.constructor.sessions.get(this.holdingId);
    if (session?.saving === save) {
      session.saving = null;
      if (!error && session.draft === save.draft) { if (unchanged) session.draft = null; session.token = save.savedToken; }
    }
  }
  _review() {
    const view = this._view;
    if (!view?.canTransact) throw new Error("Операции с казной сейчас недоступны.");
    const product = ["borrow", "deposit"].includes(this._bankViewState.tab);
    const details = product ? prepareBankComparison({ ...view, state: this._bankViewState, canTransact: true, blocked: false }).selected
      : prepareBankContracts({ holding: view.holding, state: this._bankViewState, canTransact: true, blocked: false }).payment;
    if (!details?.canReview) throw new Error(details?.message || "Проверьте предложение и сумму операции.");
    const label = product ? this._bankViewState.tab === "borrow" ? "Получить заём" : "Разместить деньги" : details.deposits ? "Снять деньги со вклада" : "Внести платёж";
    this._confirmation = { label, bankName: details.bankName, name: details.name ?? details.offerName,
      message: details.early ? "Досрочное закрытие: начисленные проценты не выплачиваются." : details.terms,
      amountText: money(details.operation.amountCopper), totalText: details.totalText, treasuryAfterText: details.treasuryAfterText,
      receivedText: details.receivedText, interestText: details.interestText, feeText: details.feeText,
      rateText: details.rateText, termText: details.termText, termTotalText: details.termTotalText,
      operation: { ...details.operation, operationId: makeId("bank-operation", 20), holdingId: this.holdingId, expectedRevision: view.revision, sourceToken: view.sourceToken } };
  }
  async _submit(retry = false) {
    if (!retry) {
      if (this._pendingOperation) throw new Error("Повторите неподтверждённую операцию с прежним идентификатором.");
      if (!this._confirmation || !this._view?.canTransact) return;
      this._pendingOperation = this._confirmation.operation;
    }
    if (!this._pendingOperation) return;
    const operationId = this._pendingOperation.operationId;
    // A reopened window shares the original wait, rather than submitting it again.
    if (this.constructor.inFlight.has(operationId)) return;
    this.constructor.inFlight.add(operationId);
    this._busy = true; this.requestRender({ focus: false });
    let result;
    try { result = await requestMarketOperation(this._pendingOperation); }
    finally {
      this.constructor.inFlight.delete(operationId);
      for (const app of new Set([this, this.constructor.instances.get(this.holdingId)])) {
        if (app?._pendingOperation?.operationId !== operationId) continue;
        app._busy = Boolean(app._catalogSave);
        if (app !== this) app.requestRender({ focus: false });
      }
    }
    if (!result?.ok) throw new Error("Банковская операция не подтверждена.");
    this._clearPendingOperation(operationId);
    this._confirmation = null; this._bankViewState.payment = null; this._bankViewState.tab = "contracts"; this._bankViewState.history = false;
    this._bankViewState.contractKind = result.depositId ? "deposits" : "loans"; this._bankViewState.contractId = result.depositId ?? result.loanId; this._bankViewState.contractPage = 0;
    requestSkyholdAppRender(); SkyholdBankApp.rerenderOpen();
  }
  /** A late reply also settles the matching request retained by a reopened window. */
  _clearPendingOperation(operationId) {
    if (!operationId) return;
    for (const app of new Set([this, this.constructor.instances.get(this.holdingId)])) {
      if (app?._pendingOperation?.operationId !== operationId) continue;
      app._pendingOperation = null;
      if (app._confirmation?.operation?.operationId === operationId) app._confirmation = null;
      if (app !== this) app.requestRender({ focus: false });
    }
    const session = this.constructor.sessions.get(this.holdingId);
    if (session?.pending?.operationId === operationId) session.pending = null;
  }
  async _action(event, target) {
    event.preventDefault(); const action = target.dataset.action;
    if (this._busy || !ACTIONS.includes(action)) return;
    try {
      if (EDIT_ACTIONS.includes(action)) { await this._edit(action, target); return; }
      if (action === "bank-tab") { this._bankViewState.tab = target.dataset.tab; this._confirmation = null; }
      if (action === "bank-select") { this._bankViewState.selected = target.dataset.key; this._confirmation = null; }
      if (action === "bank-page") { const key = target.dataset.scope === "contracts" ? "contractPage" : target.dataset.scope === "editor" ? "editorPage" : "page"; this._bankViewState[key] = Math.max(0, this._bankViewState[key] + Number(target.dataset.delta)); }
      if (action === "bank-editor-select") this._bankViewState.editorId = target.dataset.bankId;
      if (action === "bank-contract-kind") { this._bankViewState.contractKind = target.dataset.kind; this._bankViewState.contractId = ""; this._bankViewState.payment = null; this._bankViewState.contractPage = 0; this._confirmation = null; }
      if (action === "bank-history") { this._bankViewState.history = !this._bankViewState.history; this._bankViewState.contractId = ""; this._bankViewState.contractPage = 0; this._confirmation = null; }
      if (action === "bank-contract") { this._bankViewState.contractId = target.dataset.id; this._bankViewState.payment = null; this._confirmation = null; }
      if (action === "bank-payment-max") {
        const payment = prepareBankContracts({ holding: this._view.holding, state: this._bankViewState }).payment;
        this._bankViewState.contractId = payment.id; this._bankViewState.payment = payment.deposits ? payment.principalCopper : target.dataset.cash ? Math.min(bankLoanBalance(payment), this._view.holding.storage?.moneyCopper ?? 0) : bankLoanBalance(payment); this._confirmation = null;
      }
      if (action === "bank-review") { if (this._pendingOperation) throw new Error("Сначала повторите неподтверждённую операцию с тем же идентификатором."); this._review(); }
      if (action === "bank-cancel") this._confirmation = null;
      if (action === "bank-confirm" || action === "bank-retry") await this._submit(action === "bank-retry");
    } catch (error) {
      if (["bank-confirm", "bank-retry"].includes(action) && ["conflict", "invalid", "forbidden", "execution-failed"].includes(error?.code)) {
        this._clearPendingOperation(this._pendingOperation?.operationId); this._confirmation = null;
      }
      if (action === "bank-save") this._editorError = error.message;
      globalThis.ui?.notifications?.warn?.(error.message || "Операция не выполнена.");
    } finally { this._busy = false; this.requestRender({ focus: false }); }
  }
  async close(options) {
    this._listeners?.abort(); this._disclosures.close();
    this.constructor.sessions.set(this.holdingId, { state: { ...this._bankViewState }, draft: this._draftBanks, token: this._catalogToken, pending: this._pendingOperation, saving: this._catalogSave });
    if (this.constructor.instances.get(this.holdingId) === this) this.constructor.instances.delete(this.holdingId);
    return super.close(options);
  }
}
