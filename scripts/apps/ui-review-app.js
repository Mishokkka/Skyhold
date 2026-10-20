import { MODULE_ID } from "../data/constants.js";
import { formatShipGold } from "../core/ship-gold.js";
import { WindowFrameMixin } from "./common/window-frame.js";
import { RenderSchedulerMixin } from "./common/render-scheduler.js";
import { focusApplicationContent } from "./common/window-focus-keeper.js";
import { FloatingTooltipsMixin } from "./common/floating-tooltip.js";
import { saveStatusContext } from "./common/save-status.js";
import { reviewCardSamples } from "./domains/ui-review-building-samples.js";
import { renderEditorReviewSample } from "./domains/ui-review-editor-samples.js";
import { prepareEditorReviewLayouts } from "./domains/ui-review-editor-layout.js";
import { createShipReviewState, shipReviewContext, renderShipReviewCurrent, renderShipReviewMap, formatShipReviewSummary, bindShipReview } from "./domains/ui-review-ships.js";
import { ensureSkyholdTemplateGroup } from "./template-preload.js";
import { bindFloatingTooltips } from "./common/floating-tooltip.js";
import {
  UI_COMPONENT_PROPOSALS,
  UI_AUDIT_PROPOSALS,
  UI_BEHAVIOR_PROPOSALS,
  UI_ROW_CARD_PROPOSALS,
  UI_BUILDING_EDITOR_PROPOSALS,
  UI_REVIEW_CHOICES,
  UI_REVIEW_PROPOSALS,
  countUiReviewDecisions,
  createUiReviewDraft,
  formatUiReviewSummary
} from "./domains/ui-review-proposals.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const PROPOSAL_IDS = new Set(UI_BUILDING_EDITOR_PROPOSALS.map(({ id }) => id));
const CHOICE_IDS = new Set(UI_REVIEW_CHOICES.map(({ id }) => id));
let savedDraft = createUiReviewDraft();
const savedDemoDisclosures = new Map();
const savedCardDemoView = { buildingCase: "mill", permission: "edit" };
const savedEditorDemoView = { proposal: "editor-main", permission: "gm", kind: "building", flock: "sheep", narrow: false, comparison: "both" };
const savedShipReview = createShipReviewState();
let savedReviewMode = "ships";

function auditSample(proposal) {
  return { ...proposal, status: "Внесено",
    ...Object.fromEntries(["fields", "search", "buttons", "headings", "callouts", "type", "density", "choices", "navigation", "responsive"].map((kind) => [`is${kind[0].toUpperCase()}${kind.slice(1)}`, proposal.id === `audit-${kind}`])) };
}

function behaviorSample(proposal) {
  return { ...proposal, status: "Внесено", isSave: proposal.id === "behavior-save", isGm: proposal.id === "behavior-gm",
    saveDemos: [ { id: "building", title: "Здание", field: "Название", value: "Мельница", mode: "auto", isAuto: true },
      { id: "resident", title: "Житель", field: "Имя", value: "Руна", mode: "auto", isAuto: true },
      { id: "event", title: "Событие", field: "Название", value: "Караван", mode: "manual", isAuto: false } ]
      .map(demo => ({ ...demo, saveStatus: saveStatusContext(demo.mode, "saved") })) };
}

function selectDemoTab(button, focus = false) {
  const list = button.closest("[data-review-demo-tablist]");
  const sample = list?.closest(".fbls-ui-review-sample");
  if (!list || !sample) return;
  for (const tab of list.querySelectorAll("[data-review-demo-tab]")) {
    const selected = tab === button;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    const panel = sample.querySelector(`[id="${tab.getAttribute("aria-controls")}"]`);
    if (panel) panel.hidden = !selected;
  }
  if (focus) button.focus();
}

export class SkyholdUiReviewApp extends FloatingTooltipsMixin(WindowFrameMixin(RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2)))) {
  static instance = null;

  static open() {
    if (!globalThis.game?.user?.isGM) return null;
    if (this.instance) {
      this.instance.render({ force: true, focus: true });
      return this.instance;
    }
    const app = new this();
    this.instance = app;
    app.render({ force: true, focus: true }).then(() => {
      if (!app.element) return;
      app.setPosition(this.DEFAULT_OPTIONS.position);
      app._bindWindowFrameSync(app.element);
    }).catch((error) => {
      if (this.instance === app) this.instance = null;
      console.error("FBL Skyhold | Failed to open UI review", error);
      globalThis.ui?.notifications?.error?.("Не удалось открыть согласование интерфейса.");
    });
    return app;
  }

  constructor(options = {}) {
    super(options);
    this.reviewDraft = savedDraft;
    this.reviewMode = savedReviewMode;
    this._saveDemoTimers = new Map();
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    await ensureSkyholdTemplateGroup("buildingEditor");
    let shipReview = null;
    if (this.reviewMode === "ships") {
      await ensureSkyholdTemplateGroup("shipWindow");
      await ensureSkyholdTemplateGroup("uiReview");
      shipReview = shipReviewContext(savedShipReview);
      shipReview.mapHtml = renderShipReviewMap(shipReview);
      if (shipReview.isCurrent) shipReview.currentHtml = renderShipReviewCurrent(shipReview);
      else globalThis.Handlebars?.registerHelper?.("fblsShipGold", formatShipGold);
    }
    const proposals = UI_BUILDING_EDITOR_PROPOSALS.map(proposal => ({
      ...proposal, status: "Внесено", active: proposal.id === savedEditorDemoView.proposal,
      isLivestock: proposal.tab === "livestock",
      flockOptions: [["sheep", "Овцы · молоко и шерсть"], ["cows", "Коровы · молоко"], ["hens", "Куры · яйца"]].map(([value, label]) => ({ value, label, selected: value === savedEditorDemoView.flock })),
      sampleHtml: renderEditorReviewSample(proposal.tab, savedEditorDemoView),
      note: this.reviewDraft.decisions[proposal.id]?.note ?? "",
      choices: UI_REVIEW_CHOICES.map(choice => ({ ...choice, selected: this.reviewDraft.decisions[proposal.id]?.choice === choice.id }))
    }));
    const approvedRows = UI_ROW_CARD_PROPOSALS.map((proposal) => {
      const samples = proposal.id.startsWith("cards-") ? reviewCardSamples(proposal.id.replace("cards-", "")) : {};
      if (samples.detailCases) samples.detailCases = samples.detailCases.map(row => ({ ...row, selected: row.id === savedCardDemoView.buildingCase }));
      return {
        ...proposal,
        status: proposal.id.startsWith("cards-") ? "Оставлено" : "Внесено",
        ...Object.fromEntries(["rows-chips", "rows-baselines", "rows-actions", "cards-header", "cards-details", "cards-layout"]
          .map(id => ["is" + id.split("-").map(word => word[0].toUpperCase() + word.slice(1)).join(""), proposal.id === id])),
        ...samples,
        demoViewOnly: proposal.id === "cards-details" && savedCardDemoView.permission === "view",
        note: this.reviewDraft.decisions[proposal.id]?.note ?? "",
        choices: UI_REVIEW_CHOICES.map((choice) => ({
          ...choice,
          selected: this.reviewDraft.decisions[proposal.id]?.choice === choice.id
        }))
      };
    });
    const history = UI_REVIEW_PROPOSALS.map((proposal) => ({
      ...proposal,
      status: proposal.id === "tiny-type" ? "Оставлено" : "Внесено"
    }));
    return {
      ...context,
      shipReview,
      isShipReview: this.reviewMode === "ships",
      proposals,
      approvedRows,
      editorView: { ...savedEditorDemoView,
        permissions: [["gm", "ГМ"], ["edit", "Редактирование без прав ГМа"], ["view", "Только просмотр"]].map(([value, label]) => ({ value, label, selected: value === savedEditorDemoView.permission })),
        kinds: [["building", "Здание"], ["template", "Шаблон"]].map(([value, label]) => ({ value, label, selected: value === savedEditorDemoView.kind })),
        comparisons: [["both", "Исходная и принятая"], ["before", "Исходная компоновка"], ["after", "Принятый вид"]].map(([value, label]) => ({ value, label, selected: value === savedEditorDemoView.comparison })) },
      history,
      approvedAudits: UI_AUDIT_PROPOSALS.map(auditSample),
      approvedBehaviors: UI_BEHAVIOR_PROPOSALS.map(behaviorSample),
      approvedComponents: UI_COMPONENT_PROPOSALS.map((proposal) => ({ ...proposal,
        ...Object.fromEntries(["tabs", "chips", "empty", "fields", "metrics", "icon-actions"].map((kind) => [kind === "icon-actions" ? "isIconActions" : `is${kind[0].toUpperCase()}${kind.slice(1)}`, proposal.id === `component-${kind}`])),
        status: proposal.id === "component-fields" ? "Внесено: подпись 10 px, зазор 2 px" : proposal.id === "component-icon-actions" ? "Внесено: 32 px, с плотными исключениями" : "Внесено" })),
      decisionCount: countUiReviewDecisions(this.reviewDraft),
      proposalCount: UI_BUILDING_EDITOR_PROPOSALS.length,
      summary: formatUiReviewSummary(this.reviewDraft),
      generalNote: this.reviewDraft.generalNote
    };
  }

  _refreshReviewOutput() {
    const root = this.element;
    if (!root) return;
    for (const button of root.querySelectorAll("[data-review-choice]")) {
      const { reviewId, reviewChoice } = button.dataset;
      button.setAttribute("aria-pressed", String(this.reviewDraft.decisions[reviewId]?.choice === reviewChoice));
    }
    const count = root.querySelector("[data-review-count]");
    if (count) count.textContent = `${countUiReviewDecisions(this.reviewDraft)}/${UI_BUILDING_EDITOR_PROPOSALS.length} решений`;
    const summary = root.querySelector("[data-review-summary]");
    if (summary) summary.value = formatUiReviewSummary(this.reviewDraft);
    savedDraft = this.reviewDraft;
  }

  _setSaveDemoState(sample, state) {
    const timer = this._saveDemoTimers.get(sample);
    if (timer !== undefined) clearTimeout(timer);
    this._saveDemoTimers.delete(sample);
    sample.dataset.reviewSaveState = state;
    const status = sample.querySelector("[data-review-save-status]");
    const context = saveStatusContext(sample.dataset.reviewSaveMode, state);
    if (status) {
      status.textContent = context.label;
      status.dataset.saveState = context.state;
      status.dataset.fblsTooltip = context.tooltip;
      status.setAttribute("aria-label", context.label);
    }
    const button = sample.querySelector("[data-review-save-submit]");
    if (button) {
      button.disabled = state === "saved" || state === "saving";
      button.hidden = sample.dataset.reviewSaveMode === "auto" && state !== "error";
    }
  }

  _runSaveDemo(sample) {
    this._setSaveDemoState(sample, "saving");
    this._saveDemoTimers.set(sample, setTimeout(() => {
      this._saveDemoTimers.delete(sample);
      if (sample.isConnected && !this._reviewAbortController?.signal.aborted) this._setSaveDemoState(sample, "saved");
    }, 650));
  }

  _clearSaveDemoTimers() {
    for (const timer of this._saveDemoTimers.values()) clearTimeout(timer);
    this._saveDemoTimers.clear();
  }

  async _copySummary() {
    const summary = this.reviewMode === "ships" ? formatShipReviewSummary(savedShipReview) : formatUiReviewSummary(this.reviewDraft);
    try {
      if (!globalThis.navigator?.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await globalThis.navigator.clipboard.writeText(summary);
      globalThis.ui?.notifications?.info?.("Решения скопированы. Вставьте их в чат для согласования.");
    } catch (_error) {
      const field = this.element?.querySelector("[data-review-summary]");
      field?.focus?.();
      field?.select?.();
      globalThis.ui?.notifications?.warn?.("Текст выделен. Скопируйте его клавишами Ctrl+C.");
    }
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    this._clearSaveDemoTimers();
    if (!options?.isFirstRender) this._bindWindowFrameSync(root);
    this._reviewAbortController?.abort?.();
    const controller = new AbortController();
    this._reviewAbortController = controller;
    bindShipReview(this, root, savedShipReview, controller.signal);
    prepareEditorReviewLayouts(root);
    bindFloatingTooltips(this, root);
    for (const section of root.querySelectorAll("[data-review-gm-section], [data-review-disclosure-key]")) {
      const key = section.dataset.reviewGmSection ?? section.dataset.reviewDisclosureKey;
      if (savedDemoDisclosures.has(key)) section.open = savedDemoDisclosures.get(key);
      section.addEventListener("toggle", () => savedDemoDisclosures.set(key, section.open), { signal: controller.signal });
    }

    root.addEventListener("click", (event) => {
      const mode = event.target?.closest?.("[data-review-mode]");
      if (mode && ["ships", "archive"].includes(mode.dataset.reviewMode)) {
        this.reviewMode = savedReviewMode = mode.dataset.reviewMode;
        this._reviewModeFocus = this.reviewMode;
        this.requestRender();
        return;
      }
      const editorTab = event.target?.closest?.("[data-review-editor-proposal]");
      if (editorTab && root.contains(editorTab)) {
        event.preventDefault();
        savedEditorDemoView.proposal = editorTab.dataset.reviewEditorProposal;
        for (const card of root.querySelectorAll("[data-review-editor-card]")) card.hidden = card.dataset.reviewEditorCard !== savedEditorDemoView.proposal;
        for (const button of root.querySelectorAll("[data-review-editor-proposal]")) {
          button.setAttribute("aria-pressed", String(button === editorTab));
          button.classList.toggle("active", button === editorTab);
        }
        return;
      }
      const narrowEditor = event.target?.closest?.("[data-review-editor-width]");
      if (narrowEditor && root.contains(narrowEditor)) {
        event.preventDefault();
        savedEditorDemoView.narrow = !savedEditorDemoView.narrow;
        narrowEditor.setAttribute("aria-pressed", String(savedEditorDemoView.narrow));
        root.querySelector("[data-review-editor-gallery]").classList.toggle("is-narrow", savedEditorDemoView.narrow);
        return;
      }
      const saveAction = event.target?.closest?.("[data-review-save-submit], [data-review-save-error]");
      if (saveAction && root.contains(saveAction)) {
        event.preventDefault();
        const sample = saveAction.closest("[data-review-save-demo]");
        if (saveAction.hasAttribute("data-review-save-error")) this._setSaveDemoState(sample, "error");
        else this._runSaveDemo(sample);
        return;
      }
      const tab = event.target?.closest?.("[data-review-demo-tab]");
      if (tab && root.contains(tab)) { event.preventDefault(); selectDemoTab(tab); return; }
      const width = event.target?.closest?.("[data-review-demo-width]");
      if (width && root.contains(width)) {
        event.preventDefault();
        const narrow = width.getAttribute("aria-pressed") !== "true";
        width.setAttribute("aria-pressed", String(narrow));
        width.setAttribute("aria-label", narrow ? "Развернуть оба образца окна" : "Сузить оба образца окна");
        width.textContent = narrow ? "Широкое окно" : "Узкое окно";
        for (const sample of width.closest("[data-review-card]").querySelectorAll(".fbls-ui-audit-window")) sample.classList.toggle("is-narrow", narrow);
        return;
      }
      const choice = event.target?.closest?.("[data-review-choice]");
      if (choice && root.contains(choice)) {
        event.preventDefault();
        const { reviewId, reviewChoice } = choice.dataset;
        if (!PROPOSAL_IDS.has(reviewId) || !CHOICE_IDS.has(reviewChoice)) return;
        this.reviewDraft.decisions[reviewId].choice = reviewChoice;
        this._refreshReviewOutput();
        if (reviewChoice === "custom") root.querySelector(`[data-review-note="${reviewId}"]`)?.focus?.();
        return;
      }
      if (event.target?.closest?.("[data-review-copy]")) {
        event.preventDefault();
        void this._copySummary();
      }
    }, { signal: controller.signal });

    root.addEventListener("keydown", (event) => {
      const tab = event.target?.closest?.("[data-review-demo-tab]");
      if (!tab || !root.contains(tab)) return;
      const tabs = [...tab.closest("[data-review-demo-tablist]").querySelectorAll("[data-review-demo-tab]")];
      const index = tabs.indexOf(tab);
      const next = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length,
        Home: 0, End: tabs.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      selectDemoTab(tabs[next], true);
    }, { signal: controller.signal });

    root.addEventListener("change", (event) => {
      const target = event.target;
      if (target?.matches?.("[data-review-editor-setting]")) {
        const key = target.dataset.reviewEditorSetting;
        const valid = { permission: ["gm", "edit", "view"], kind: ["building", "template"], flock: ["sheep", "cows", "hens"], comparison: ["both", "before", "after"] };
        if (!valid[key]?.includes(target.value)) return;
        savedEditorDemoView[key] = target.value;
        if (key === "comparison") root.querySelector("[data-review-editor-gallery]").dataset.reviewEditorComparison = target.value;
        else {
          this._editorDemoFocus = key;
          this.requestRender();
        }
      } else if (target?.matches?.("[data-review-building-case]")) {
        savedCardDemoView.buildingCase = target.value;
        for (const panel of target.closest("[data-review-card]").querySelectorAll("[data-review-building-panel]")) {
          panel.hidden = panel.dataset.reviewBuildingPanel !== target.value;
        }
      } else if (target?.matches?.("[data-review-card-permission]")) {
        savedCardDemoView.permission = target.value;
        target.closest("[data-review-card]").classList.toggle("is-view-only", target.value === "view");
      }
    }, { signal: controller.signal });

    root.addEventListener("input", (event) => {
      const target = event.target;
      if (target?.matches?.("[data-review-save-field]")) {
        const sample = target.closest("[data-review-save-demo]");
        if (sample.dataset.reviewSaveMode === "auto") this._runSaveDemo(sample);
        else this._setSaveDemoState(sample, "dirty");
      } else if (target?.matches?.("[data-review-note]")) {
        const id = target.dataset.reviewNote;
        if (!PROPOSAL_IDS.has(id)) return;
        this.reviewDraft.decisions[id].note = target.value;
        this._refreshReviewOutput();
      } else if (target?.matches?.("[data-review-general-note]")) {
        this.reviewDraft.generalNote = target.value;
        this._refreshReviewOutput();
      }
    }, { signal: controller.signal });

    focusApplicationContent(this, { root, options, preferredSelector: "[data-review-choice][aria-pressed='true']" });
    if (this._reviewModeFocus) {
      root.querySelector(`[data-review-mode="${this._reviewModeFocus}"]`)?.focus({ preventScroll: true });
      this._reviewModeFocus = null;
    }
    if (this._editorDemoFocus) {
      root.querySelector(`[data-review-editor-setting="${this._editorDemoFocus}"]`)?.focus({ preventScroll: true });
      this._editorDemoFocus = null;
    }
  }

  async _onClose(options) {
    this._clearSaveDemoTimers();
    this._reviewAbortController?.abort?.();
    this._unbindWindowFrameSync();
    savedDraft = this.reviewDraft;
    await super._onClose(options);
    if (SkyholdUiReviewApp.instance === this) SkyholdUiReviewApp.instance = null;
  }
}

SkyholdUiReviewApp.DEFAULT_OPTIONS = {
  classes: ["fbl-skyhold", "fbl-skyhold-ui-review"],
  tag: "section",
  window: { title: "Согласование элементов интерфейса", icon: "fa-solid fa-shapes", resizable: true },
  position: { width: 1080, height: 760 }
};
SkyholdUiReviewApp.PARTS = {
  body: { template: `modules/${MODULE_ID}/templates/ui-review-app.hbs` }
};
