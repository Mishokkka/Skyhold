import { FloatingTooltipsMixin } from "../common/floating-tooltip.js";
import { MODULE_ID } from "../../data/constants.js";
import { SkyholdData } from "../../data/store.js";
import { findReadableHoldingEntry } from "../../data/access-guard.js";
import { makeId } from "../../data/utils.js";
import {
  normalizePoliticsBalance, POLITICS_ARCHETYPES, POLITICS_BUILTIN_ROWS,
  POLITICS_CORE_FIELDS, POLITICS_EFFECT_FIELDS, POLITICS_PARAMETER_FIELDS,
  POLITICS_REQUIREMENTS, resolvedPoliticsCatalog, resolvedPoliticsCore
} from "../../data/politics-balance.js";
import { executePoliticsBalanceOperation } from "../politics-balance-executor.js";
import { RenderSchedulerMixin } from "../common/render-scheduler.js";
import { WindowFrameMixin } from "../common/window-frame.js";
import { focusApplicationContent } from "../common/window-focus-keeper.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const GROUPS = [
  { id: "system", label: "Системы правления" },
  { id: "directive", label: "Директивы" },
  { id: "decree", label: "Указы" },
  { id: "perk", label: "Перки" }
];
const SLOT_LABELS = { supply: "Снабжение", order: "Порядок", labor: "Труд", external: "Внешние" };

function parameterApplies(kind, id) {
  if (kind === "system") return ["duration", "cultureMin", "reputationMin", "technologyMin"].includes(id);
  if (kind === "directive") return id === "upkeepCopper" || ["cultureMin", "reputationMin", "technologyMin"].includes(id);
  if (kind === "decree") return id !== "upkeepCopper";
  return ["cultureMin", "reputationMin", "technologyMin"].includes(id);
}

function readFields(form) {
  const data = new FormData(form);
  return Object.fromEntries([...data.entries()].map(([key, value]) => [key, String(value)]));
}

export class SkyholdPoliticsBalanceEditor extends FloatingTooltipsMixin(WindowFrameMixin(RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2)))) {
  static instances = new Map();

  static open({ holdingId = "" } = {}) {
    const key = String(holdingId ?? "");
    const existing = this.instances.get(key);
    if (existing) {
      existing.render({ force: true, focus: true });
      return existing;
    }
    const app = new this({ holdingId: key });
    this.instances.set(key, app);
    app.render({ force: true, focus: true }).then(() => {
      if (!app.element) return;
      app.setPosition(this.DEFAULT_OPTIONS.position);
      app._bindWindowFrameSync(app.element);
    }).catch((error) => {
      this.instances.delete(key);
      console.error("FBL Skyhold | Failed to open politics balance editor", error);
      globalThis.ui?.notifications?.error?.("Не удалось открыть редактор Политики.");
    });
    return app;
  }

  static rerenderOpen() {
    for (const app of this.instances.values()) app.requestRender({ focus: false });
  }

  constructor({ holdingId = "" } = {}, options = {}) {
    super(options);
    this.holdingId = String(holdingId ?? "");
    this.selectedRowId = "system:governor";
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const data = SkyholdData.view();
    const { holding } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
    if (!game.user?.isGM || !holding) return { ...context, canEdit: false, hasHolding: Boolean(holding) };
    const balance = normalizePoliticsBalance(holding.gm?.politicsBalance);
    const catalog = resolvedPoliticsCatalog(balance);
    const row = catalog.find((item) => item.id === this.selectedRowId) ?? catalog[0];
    this.selectedRowId = row?.id ?? "";
    const isCustom = !POLITICS_BUILTIN_ROWS.some((item) => item.id === row?.id);
    const archetype = POLITICS_ARCHETYPES.find((item) => item.id === row?.archetypeId);
    const core = resolvedPoliticsCore(balance);
    return {
      ...context,
      hasHolding: true,
      canEdit: true,
      holdingName: holding.name || "Поселение",
      revision: Number(data.meta?.revision),
      coreFields: POLITICS_CORE_FIELDS.map((field) => ({ ...field, value: core[field.id], changed: Object.hasOwn(balance.core, field.id) })),
      groups: GROUPS.map((group) => ({ ...group, rows: catalog.filter((item) => item.kind === group.id).map((item) => ({
        id: item.id, label: item.label, archetypeLabel: POLITICS_ARCHETYPES.find((type) => type.id === item.archetypeId)?.label ?? "",
        selected: item.id === row?.id, custom: !POLITICS_BUILTIN_ROWS.some((builtin) => builtin.id === item.id)
      })) })),
      row: row ? {
        ...row, custom: isCustom, archetypeLabel: archetype?.label ?? "Все типажи",
        kindLabel: GROUPS.find((group) => group.id === row.kind)?.label ?? row.kind,
        slotLabel: SLOT_LABELS[row.slot] ?? "Личная директива",
        requirementLabels: (row.requires ?? []).map((id) => POLITICS_REQUIREMENTS.find((condition) => condition.id === id)?.label ?? id).join(" · ") || "Нет",
        effects: POLITICS_EFFECT_FIELDS.map((field) => ({ ...field, value: row.effects[field.id] })),
        parameters: POLITICS_PARAMETER_FIELDS.filter((field) => parameterApplies(row.kind, field.id)).map((field) => ({ ...field, value: row[field.id] })),
        archetypeOptions: [{ id: "", label: "Все типажи", selected: !row.archetypeId }, ...POLITICS_ARCHETYPES.map((item) => ({ ...item, selected: item.id === row.archetypeId }))],
        slotOptions: row.kind === "directive" ? Object.entries(SLOT_LABELS).map(([id, label]) => ({ id, label, selected: row.slot === id })) : null,
        requirementOptions: POLITICS_REQUIREMENTS.map((item) => ({ ...item, selected: (row.requires ?? []).includes(item.id) })),
        systemSlots: row.kind === "system" ? Object.entries(SLOT_LABELS).map(([id, label]) => ({ id, label, selected: row.slots.includes(id) })) : null
      } : null,
      newArchetypeOptions: [{ id: "", label: "Все типажи" }, ...POLITICS_ARCHETYPES],
      newSlotOptions: Object.entries(SLOT_LABELS).map(([id, label]) => ({ id, label })),
      customCount: balance.custom.length
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    if (!options?.isFirstRender) this._bindWindowFrameSync(root);
    this._balanceAbortController?.abort?.();
    const controller = new AbortController();
    this._balanceAbortController = controller;
    root.addEventListener("change", (event) => {
      const picker = event.target?.closest?.("[data-politics-balance-select]");
      if (!picker || !root.contains(picker)) return;
      this.selectedRowId = String(picker.value ?? "");
      this.requestRender({ focus: false });
    }, { signal: controller.signal });
    root.addEventListener("click", (event) => {
      const button = event.target?.closest?.("[data-politics-balance-submit]");
      if (button && root.contains(button)) {
        event.preventDefault();
        button.closest("form")?.requestSubmit();
        return;
      }
      const reset = event.target?.closest?.("[data-politics-balance-reset]");
      if (reset && root.contains(reset)) {
        event.preventDefault();
        void this._save("reset", { id: this.selectedRowId }, context.revision);
      }
    }, { signal: controller.signal });
    root.addEventListener("submit", async (event) => {
      const form = event.target?.closest?.("form[data-politics-balance-form]");
      if (!form || !root.contains(form)) return;
      event.preventDefault();
      if (!game.user?.isGM) return;
      const kind = form.dataset.politicsBalanceForm;
      const fields = readFields(form);
      let payload;
      if (kind === "core") payload = { fields };
      else if (kind === "row") payload = {
        id: this.selectedRowId, fields, label: fields.label, summary: fields.summary,
        archetypeId: fields.archetypeId ?? "", slot: fields.slot ?? "",
        requires: new FormData(form).getAll("requires").map(String), enabled: new FormData(form).has("enabled"),
        ...(context.row?.kind === "system" ? { slots: new FormData(form).getAll("systemSlots").map(String) } : {})
      };
      else if (kind === "create") payload = {
        id: makeId(`custom-${fields.kind}`, 12).toLowerCase(), kind: fields.kind, label: fields.label,
        archetypeId: fields.archetypeId ?? "", slot: fields.kind === "directive" && fields.archetypeId ? "" : fields.slot ?? ""
      };
      else return;
      const button = form.querySelector("[data-politics-balance-submit]");
      if (button) button.disabled = true;
      await this._save(kind, payload, context.revision, button);
    }, { signal: controller.signal });
    focusApplicationContent(this, { root, options, preferredSelector: "[data-politics-balance-select]" });
  }

  async _save(action, payload, revision, button = null) {
    try {
      const result = await executePoliticsBalanceOperation({
        operationId: makeId("politics-balance", 20), holdingId: this.holdingId,
        expectedRevision: revision, action, payload
      });
      if (!result.ok) globalThis.ui?.notifications?.warn?.(result.reason || "Настройка Политики не сохранена.");
      else if (!result.noop) globalThis.ui?.notifications?.info?.(result.summary || "Настройка Политики сохранена.");
      if (result.rowId) this.selectedRowId = result.rowId;
      this.requestRender({ focus: false });
    } catch (error) {
      console.error("FBL Skyhold | Failed to save politics balance", error);
      globalThis.ui?.notifications?.error?.("Не удалось сохранить баланс Политики.");
      if (button) button.disabled = false;
    }
  }

  async _onClose(options) {
    this._balanceAbortController?.abort?.();
    this._unbindWindowFrameSync();
    await super._onClose(options);
    SkyholdPoliticsBalanceEditor.instances.delete(this.holdingId);
  }
}

SkyholdPoliticsBalanceEditor.DEFAULT_OPTIONS = {
  classes: ["fbl-skyhold", "fbl-skyhold-politics-balance"], tag: "section",
  window: { title: "Баланс Политики", icon: "fa-solid fa-sliders", resizable: true },
  position: { width: 1120, height: 760 }
};
SkyholdPoliticsBalanceEditor.PARTS = {
  body: { template: `modules/${MODULE_ID}/templates/politics-balance-editor.hbs` }
};
