import { fieldValue } from "../../../core/helpers.js";
import { MODULE_ID } from "../../../data/constants.js";
import {
  EVENT_THRESHOLD_KEYS,
  eventRequirementFacts,
  eventTagThresholdRows,
  normalizeEventRegionOptions,
  normalizeEventTagThresholds
} from "../../../data/random-events.js";
import { SkyholdData } from "../../../data/store.js";
import { bindGlobalInputGuard, bindInputGuards, unbindGlobalInputGuard } from "../../../utils/input-guards.js";
import { RenderSchedulerMixin } from "../../common/render-scheduler.js";
import { FloatingTooltipsMixin } from "../../common/floating-tooltip.js";
import { tagsFromEventFacts } from "./context.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const THRESHOLD_FIELDS = new Set(["lowMax", "highMin"]);
const THRESHOLD_KEYS = new Set(EVENT_THRESHOLD_KEYS.map(({ key }) => key));

export class SkyholdRandomEventContextEditor extends FloatingTooltipsMixin(RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2))) {
  constructor({ holdingId = "", owner = null } = {}, options = {}) {
    super(options);
    this.holdingId = String(holdingId ?? "");
    this.owner = owner;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const data = SkyholdData.view();
    const holding = data.holdings.find((item) => String(item?.id ?? "") === this.holdingId) ?? data.holdings[0] ?? null;
    if (holding) this.holdingId = String(holding.id ?? "");
    const regionOptions = normalizeEventRegionOptions(data?.catalog?.eventRegions);
    const facts = holding ? eventRequirementFacts(holding, { regionOptions }) : null;
    const eventTagThresholds = normalizeEventTagThresholds(holding?.gm?.eventTagThresholds);
    const factChips = holding
      ? Array.from(tagsFromEventFacts(facts)).sort((a, b) => a.localeCompare(b, "ru")).map((tag) => ({ tag }))
      : [];

    return {
      ...context,
      hasHolding: Boolean(holding),
      holdingId: this.holdingId,
      holdingName: holding?.name ?? "Владение",
      thresholdRows: eventTagThresholdRows(eventTagThresholds),
      factChips
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    bindInputGuards(root);
    bindGlobalInputGuard(this, root);
    this._bindEvents(root);
  }

  _bindEvents(root) {
    this._delegatedAbortController?.abort?.();
    const controller = new AbortController();
    this._delegatedAbortController = controller;
    root.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const threshold = target.closest?.("[data-event-threshold-field]");
      if (threshold && root.contains(threshold)) this._onThresholdChange(event, threshold);
    }, { signal: controller.signal });
  }

  async _onThresholdChange(event, target) {
    event.preventDefault();
    if (!game.user?.isGM || !this.holdingId) return;
    const key = String(target.dataset.eventThresholdKey ?? "");
    const field = String(target.dataset.eventThresholdField ?? "");
    if (!THRESHOLD_KEYS.has(key) || !THRESHOLD_FIELDS.has(field)) return;
    const value = Math.floor(Number(fieldValue(target)) || 0);
    const saved = await SkyholdData.updateHolding(this.holdingId, (holding) => {
      if (!holding.gm || typeof holding.gm !== "object") holding.gm = {};
      const thresholds = normalizeEventTagThresholds(holding.gm.eventTagThresholds);
      thresholds[key][field] = value;
      holding.gm.eventTagThresholds = normalizeEventTagThresholds(thresholds);
      return true;
    }, { fallback: false, reason: `event-context-editor:threshold:${key}:${field}` });
    if (!saved) return;
    this.owner?._refreshDataCaches?.();
    this.owner?._requestRenderPreservingPosition?.();
    this.requestRender({ focus: false });
  }

  async _onClose(options) {
    await super._onClose(options);
    this._delegatedAbortController?.abort?.();
    this._delegatedAbortController = null;
    unbindGlobalInputGuard(this);
    if (this.owner?._contextEditor === this) this.owner._contextEditor = null;
  }
}

SkyholdRandomEventContextEditor.DEFAULT_OPTIONS = {
  classes: ["fbl-skyhold", "fbl-skyhold-random-event-context-editor"],
  tag: "section",
  window: {
    title: "Факты событий",
    icon: "fa-solid fa-fingerprint",
    resizable: true
  },
  position: {
    width: 680,
    height: 520
  }
};

SkyholdRandomEventContextEditor.PARTS = {
  body: {
    template: `modules/${MODULE_ID}/templates/random-event-context-editor.hbs`
  }
};
