import { MODULE_ID } from "../data/constants.js";
import { requestMarketOperation, SkyholdData } from "../data/store.js";
import { findReadableHoldingEntry } from "../data/access-guard.js";
import { holdingPermissionContext } from "../data/holding-permissions.js";
import { BANK_PRESETS, bankCatalog, normalizeBank } from "../data/banks.js";
import { bankState, bankRelationship, bankLoanBalance, bankTermsToken, quoteBankLoan } from "../engines/economy/banking.js";
import { stableDataHash } from "../data/storage-commit.js";
import { makeId } from "../data/utils.js";
import { formatCopperCurrencyCompact as money } from "../core/currency.js";
import { DisclosureState } from "./common/disclosure-state.js";
import { RenderSchedulerMixin } from "./common/render-scheduler.js";
import { restoreApplicationFocus } from "./common/window-focus-keeper.js";
import { requestSkyholdAppRender } from "./registry.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
export class SkyholdBankApp extends RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  static instances = new Map();
  static DEFAULT_OPTIONS = {
    id: "fbls-banks", classes: ["fbl-skyhold", "fbls-secondary"], tag: "div",
    window: { title: "Банки поселения", resizable: true }, position: { width: 820, height: 700 },
    actions: Object.fromEntries(["bank-borrow", "bank-repay", "bank-retry", "bank-add", "bank-save", "bank-add-offer"]
      .map((id) => [id, function(event, target) { return this._action(event, target); }]))
  };
  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/bank-app.hbs` } };
  static open({ holdingId } = {}) {
    const id = String(holdingId ?? "");
    let app = this.instances.get(id);
    if (!app) { app = new this({ holdingId: id }); this.instances.set(id, app); }
    app.render({ force: true, focus: true });
    return app;
  }
  static rerenderOpen({ skipFocused = false } = {}) {
    for (const app of this.instances.values()) {
      if (skipFocused && app.element?.contains(globalThis.document?.activeElement)) continue;
      app.requestRender({ focus: false });
    }
  }
  constructor({ holdingId } = {}, options = {}) {
    super({ ...options, id: `fbls-banks-${holdingId}` }); this.holdingId = holdingId; this.amounts = {}; this.payments = {}; this._disclosures = new DisclosureState();
  }
  async _prepareContext(options) {
    const base = await super._prepareContext(options);
    const data = SkyholdData.view();
    const { holding } = findReadableHoldingEntry(data, this.holdingId);
    if (!holding) return { ...base, hasHolding: false };
    const permissions = holdingPermissionContext(holding);
    const canTransact = permissions.isGM || Boolean(holding.gm?.playersCanUseStorage && permissions.canUseStorage);
    this._view = { data, holding, revision: data.meta?.revision, sourceToken: bankTermsToken(data, holding) };
    const banks = bankCatalog(data).filter((bank) => permissions.isGM || bank.active).map((bank) => ({
      ...bank, relationship: bankRelationship(holding, bank.id),
      offers: bank.offers.filter((offer) => permissions.isGM || offer.active).map((offer) => {
        const key = bank.id + ":" + offer.id;
        const amount = this.amounts[key] ?? Math.min(1000, offer.limitCopper);
        const quote = quoteBankLoan({ data, holding, bankId: bank.id, offerId: offer.id, amountCopper: amount });
        return { ...offer, key, bankId: bank.id, amount, rateText: (offer.annualRateBps / 100).toFixed(2),
          limitText: money(offer.limitCopper), eligible: quote.ok && canTransact && !this._busy && !this._pendingOperation,
          message: quote.message, receivedText: money(quote.receivedCopper), feeText: money(quote.feeCopper),
          dueText: money(quote.totalAtTermCopper), costText: money(quote.costAtTermCopper) };
      })
    }));
    const loans = (bankState(holding).loans ?? []).filter((loan) => loan.status !== "paid").map((loan) => ({
      ...loan, balanceText: money(bankLoanBalance(loan)), payment: this.payments[loan.id] ?? bankLoanBalance(loan),
      remainingDays: Math.max(0, (loan.termDays * 4 - loan.elapsedQd) / 4), overdue: loan.status === "overdue",
      rateText: (loan.annualRateBps / 100).toFixed(2), canPay: canTransact && !this._busy && !this._pendingOperation
    }));
    return { ...base, hasHolding: true, holdingName: holding.name, isGM: permissions.isGM, banks, loans,
      treasuryText: money(holding.storage?.moneyCopper), pending: Boolean(this._pendingOperation),
      presets: BANK_PRESETS, editors: (this._draftBanks ?? bankCatalog(data)).map((bank) => ({ ...bank, offers: bank.offers.map((offer) => ({ ...offer, annualRatePct: offer.annualRateBps / 100, feePct: offer.feeBps / 100 })) })), dirty: Boolean(this._draftBanks) };
  }
  async _onRender(context, options) {
    await super._onRender(context, options);
    this._listeners?.abort(); this._listeners = new AbortController();
    this._disclosures.bind(this.element);
    const updateField = (event) => {
      const field = event.target;
      if (field.dataset.loanAmount) { this.amounts[field.dataset.loanAmount] = Number(field.value); if (event.type === "change") this.requestRender({ focus: false }); }
      if (field.dataset.loanPayment) this.payments[field.dataset.loanPayment] = Number(field.value);
      if (field.dataset.bankField && globalThis.game?.user?.isGM) {
        this._ensureDraft();
        const bank = this._draftBanks.find((row) => row.id === field.closest("[data-bank-id]")?.dataset.bankId);
        const offerId = field.closest("[data-offer-id]")?.dataset.offerId;
        const row = offerId ? bank?.offers.find((offer) => offer.id === offerId) : bank;
        if (row) row[field.dataset.bankField] = field.type === "checkbox" ? field.checked : field.type === "number" ? Number(field.value) * (field.hasAttribute("data-bank-percent") ? 100 : 1) : field.value;
      }
    };
    this.element?.addEventListener("input", updateField, { signal: this._listeners.signal });
    this.element?.addEventListener("change", updateField, { signal: this._listeners.signal });
    restoreApplicationFocus(this, options);
  }
  _ensureDraft() {
    if (this._draftBanks) return;
    const current = bankCatalog(SkyholdData.view());
    this._catalogToken = stableDataHash(current); this._draftBanks = structuredClone(current);
  }
  async _action(event, target) {
    event.preventDefault();
    const action = target.dataset.action;
    if (this._busy) return;
    try {
      if (["bank-add", "bank-save", "bank-add-offer"].includes(action)) {
        if (!globalThis.game?.user?.isGM) return;
        this._ensureDraft();
        if (action === "bank-add") {
          const presetId = this.element.querySelector("[data-bank-preset]")?.value;
          const preset = BANK_PRESETS.find((row) => row.id === presetId) ?? BANK_PRESETS[0];
          this._disclosures.states.set("bank-editor", true);
          this._draftBanks.push(normalizeBank({ ...structuredClone(preset), id: makeId("bank", 16) }));
        } else if (action === "bank-add-offer") {
          const bank = this._draftBanks.find((row) => row.id === target.dataset.bankId);
          if (bank && bank.offers.length < 20) bank.offers.push({ ...BANK_PRESETS[0].offers[0], id: makeId("offer", 16) });
        } else {
          const draft = this._draftBanks.map(normalizeBank);
          await SkyholdData.transaction((data) => {
            if (stableDataHash(bankCatalog(data)) !== this._catalogToken) throw new Error("Каталог банков изменился в другом окне. Закройте и откройте редактор перед повторением.");
            data.catalog.banks = draft;
          }, { reason: "bank-catalog", scope: "catalog" });
          this._draftBanks = null;
          SkyholdBankApp.rerenderOpen();
        }
        return this.requestRender({ focus: false });
      }
      if (this._pendingOperation && action !== "bank-retry") throw new Error("Сначала повторите неподтверждённую операцию с тем же идентификатором.");
      if (action !== "bank-retry") {
        const view = this._view;
        if (!view?.holding) return;
        const bankId = String(target.dataset.bankId ?? ""), offerId = String(target.dataset.offerId ?? ""), loanId = String(target.dataset.loanId ?? "");
        const offer = bankCatalog(view.data).find((row) => row.id === bankId)?.offers.find((row) => row.id === offerId);
        const loan = bankState(view.holding).loans?.find((row) => row.id === loanId);
        const amountCopper = action === "bank-borrow" ? this.amounts[bankId + ":" + offerId] ?? Math.min(1000, offer?.limitCopper ?? 0)
          : this.payments[loanId] ?? bankLoanBalance(loan);
        this._pendingOperation = { type: action, operationId: makeId("bank-operation", 20), holdingId: this.holdingId,
          expectedRevision: view.revision, sourceToken: view.sourceToken, bankId, offerId, loanId, amountCopper };
      }
      if (!this._pendingOperation) return;
      this._busy = true;
      const result = await requestMarketOperation(this._pendingOperation);
      if (!result?.ok) throw new Error("Банковская операция не подтверждена.");
      this._pendingOperation = null;
      requestSkyholdAppRender(); SkyholdBankApp.rerenderOpen();
    } catch (error) {
      if (["conflict", "invalid", "forbidden", "execution-failed"].includes(error?.code)) this._pendingOperation = null;
      globalThis.ui?.notifications?.warn?.(error.message || "Операция не выполнена.");
    } finally {
      this._busy = false;
      this.requestRender({ focus: false });
    }
  }
  async close(options) {
    this._listeners?.abort(); this._disclosures.close();
    if (this.constructor.instances.get(this.holdingId) === this) this.constructor.instances.delete(this.holdingId);
    return super.close(options);
  }
}
