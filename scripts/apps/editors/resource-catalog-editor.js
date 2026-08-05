import { MODULE_ID } from "../../data/constants.js";
import { SkyholdData } from "../../data/store.js";
import { makeId } from "../../data/utils.js";
import { BUILTIN_RESOURCE_DEFS } from "../../data/resources/builtin-resources.js";
import { RESOURCE_ECONOMY_VERSION } from "../../data/resources/resource-economy-contract.js";
import { prepareResourceCatalogEditor } from "../../data/resources/resource-editor.js";
import { normalizeResourceCatalogRow } from "../../core/resources.js";
import { fieldValue } from "../../core/helpers.js";
import { requestSkyholdAppRender } from "../registry.js";
import { RenderSchedulerMixin } from "../common/render-scheduler.js";
import { bindImageFallbacks } from "../common/image-fallback.js";
import { bindGlobalInputGuard, bindInputGuards, sanitizeTextBlock, unbindGlobalInputGuard } from "../../utils/input-guards.js";
import { renderFoundryFilePicker } from "../../integrations/foundry-runtime.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class SkyholdResourceCatalogEditor extends RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  constructor({ picker = null, ...options } = {}) {
    super(options);
    this.search = "";
    this.picker = picker && typeof picker === "object" ? picker : null;
  }

  static open(options = {}) {
    const app = new this(options);
    app.render({ force: true, focus: true });
    return app;
  }

  static pick({ selectedId = "", onSelect = null } = {}) {
    return this.open({ picker: { selectedId: String(selectedId ?? ""), onSelect } });
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const data = SkyholdData.get();
    const catalog = prepareResourceCatalogEditor(data?.catalog?.resources, { canEdit: Boolean(game.user?.isGM) });
    if (this.picker && !catalog.rows.some((row) => String(row.id) === "custom")) {
      catalog.rows.push({ id: "custom", label: "Другой материал…", category: "Особое", unit: "ед.", icon: "fa-solid fa-pen", img: "", searchText: "custom другой материал особое", isBuiltin: true, isOverride: false });
    }
    catalog.rows = catalog.rows.map((row) => ({
      ...row,
      selected: Boolean(this.picker) && String(row.id) === String(this.picker?.selectedId ?? "")
    }));
    return {
      ...context,
      canEdit: Boolean(game.user?.isGM),
      pickerMode: Boolean(this.picker),
      search: this.search,
      catalog
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    bindInputGuards(root, { textareaSanitizer: sanitizeTextBlock });
    bindGlobalInputGuard(this, root);
    this._bindEvents(root);
    this._applySearch(root, this.search);
    bindImageFallbacks(root);
  }

  _bindEvents(root) {
    this._resourceAbortController?.abort?.();
    const controller = new AbortController();
    this._resourceAbortController = controller;
    const options = { signal: controller.signal };
    root.addEventListener("click", (event) => {
      const element = event.target?.closest?.("[data-action]");
      if (!element || !root.contains(element)) return;
      const action = String(element.dataset.action ?? "");
      if (action === "resource-edit") this._onEdit(event, element);
      else if (action === "resource-add") this._onAdd(event);
      else if (action === "resource-select") this._onSelect(event, element);
    }, options);
    root.addEventListener("input", (event) => {
      const field = event.target?.closest?.("[data-resource-search]");
      if (!field || !root.contains(field)) return;
      this.search = String(field.value ?? "");
      this._applySearch(root, this.search);
    }, options);
  }

  async _onSelect(event, element) {
    event.preventDefault();
    if (!this.picker) return;
    const id = String(element.dataset.resourceId ?? "");
    const resource = prepareResourceCatalogEditor(SkyholdData.get()?.catalog?.resources, { canEdit: false }).rows
      .find((row) => String(row.id) === id);
    if (!resource) return;
    const callback = this.picker.onSelect;
    if (typeof callback === "function") await callback(resource);
    await this.close();
  }

  _applySearch(root, value = "") {
    const search = String(value ?? "").trim().toLocaleLowerCase("ru");
    const rows = Array.from(root?.querySelectorAll?.("[data-resource-search-text]") ?? []);
    let visible = 0;
    for (const row of rows) {
      const show = !search || String(row.dataset.resourceSearchText ?? "").includes(search);
      row.hidden = !show;
      if (show) visible += 1;
    }
    const count = root?.querySelector?.("[data-resource-visible-count]");
    if (count) count.textContent = String(visible);
  }

  async _ensureEditableResource(id) {
    if (!game.user?.isGM) return;
    const builtin = BUILTIN_RESOURCE_DEFS.find((row) => row.id === id);
    if (!builtin) return true;
    return SkyholdData.transaction((data) => {
      if (!data.catalog || typeof data.catalog !== "object") data.catalog = {};
      if (!Array.isArray(data.catalog.resources)) data.catalog.resources = [];
      if (data.catalog.resources.some((row) => String(row?.id ?? "") === id)) return SkyholdData.skipTransaction(true);
      data.catalog.resources.push(normalizeResourceCatalogRow({ ...builtin, aliases: [...(builtin.aliases ?? [])] }));
      return true;
    }, { reason: "resource-editor:customize" });
  }

  async _onEdit(event, element) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    const id = String(element.dataset.resourceId ?? "");
    if (!id || !await this._ensureEditableResource(id)) return;
    new SkyholdResourceRowEditor({ resourceId: id, owner: this }).render({ force: true, focus: true });
  }

  async _onAdd(event) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    const id = makeId("resource", 12);
    const added = await SkyholdData.transaction((data) => {
      if (!data.catalog || typeof data.catalog !== "object") data.catalog = {};
      if (!Array.isArray(data.catalog.resources)) data.catalog.resources = [];
      data.catalog.resources.push(normalizeResourceCatalogRow({ id, label: "Новый ресурс", img: "", economyVersion: RESOURCE_ECONOMY_VERSION }));
      return true;
    }, { reason: "resource-editor:add" });
    if (!added) return;
    new SkyholdResourceRowEditor({ resourceId: id, owner: this }).render({ force: true, focus: true });
  }

  async _confirm(content) {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (DialogV2?.confirm) return DialogV2.confirm({ window: { title: "Каталог ресурсов" }, content: `<p>${content}</p>`, modal: true });
    return window.confirm(content);
  }

  async _onClose(options) {
    await super._onClose(options);
    this._resourceAbortController?.abort?.();
    unbindGlobalInputGuard(this);
  }
}

export class SkyholdResourceRowEditor extends RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  constructor({ resourceId = "", owner = null } = {}, options = {}) {
    super(options);
    this.resourceId = String(resourceId ?? "");
    this.owner = owner;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const catalog = prepareResourceCatalogEditor(SkyholdData.get()?.catalog?.resources, { canEdit: Boolean(game.user?.isGM) });
    return { ...context, canEdit: Boolean(game.user?.isGM), resource: catalog.rows.find((row) => String(row.id) === this.resourceId) ?? null };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    bindInputGuards(root, { textareaSanitizer: sanitizeTextBlock });
    bindGlobalInputGuard(this, root);
    bindImageFallbacks(root);
    this._bindEvents(root);
  }

  _bindEvents(root) {
    this._resourceRowAbortController?.abort?.();
    const controller = new AbortController();
    this._resourceRowAbortController = controller;
    const options = { signal: controller.signal };
    root.addEventListener("change", (event) => {
      const field = event.target?.closest?.("[data-resource-field]");
      if (field && root.contains(field)) this._onFieldChange(event, field);
    }, options);
    root.addEventListener("click", (event) => {
      const element = event.target?.closest?.("[data-action]");
      if (!element || !root.contains(element)) return;
      const action = String(element.dataset.action ?? "");
      if (action === "resource-pick-image") this._onPickImage(event);
      else if (action === "resource-restore") this._onRestore(event);
      else if (action === "resource-delete") this._onDelete(event);
    }, options);
  }

  async _onFieldChange(event, field) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    const key = String(field.dataset.resourceField ?? "");
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || (key === "id" && BUILTIN_RESOURCE_DEFS.some((row) => row.id === this.resourceId))) return;
    let value = fieldValue(field);
    if (key === "quantityStep") value = 1;
    if (key === "id") value = String(value ?? "").trim();
    if (field instanceof HTMLTextAreaElement) value = sanitizeTextBlock(value);
    const oldId = this.resourceId;
    const updated = await SkyholdData.transaction((data) => {
      const rows = Array.isArray(data?.catalog?.resources) ? data.catalog.resources : [];
      const index = rows.findIndex((row) => String(row?.id ?? "") === oldId);
      if (index < 0) return SkyholdData.skipTransaction(false);
      if (key === "id") {
        const identity = String(value ?? "").toLocaleLowerCase("en");
        if (!identity || rows.some((row, rowIndex) => rowIndex !== index && String(row?.id ?? "").trim().toLocaleLowerCase("en") === identity)) {
          ui.notifications?.warn?.("ID ресурса должен быть непустым и уникальным. Склад, рецепты и заказы не были изменены.");
          return SkyholdData.skipTransaction(false);
        }
      }
      rows[index][key] = value;
      if (["quantityStep", "referencePriceCopper", "tradable", "cargoClass", "cargoPoints", "rationPoints", "shelfLifeTendays"].includes(key)) {
        rows[index].economyVersion = RESOURCE_ECONOMY_VERSION;
        rows[index].legacyEconomy = false;
        rows[index].legacyEconomyVersion = 0;
      }
      if (key === "cargoClass" && /^\d+$/.test(String(value))) rows[index].cargoPoints = Number(value);
      if (key === "cargoPoints") rows[index].cargoClass = Number(value) > 40 ? "oversized" : "";
      return true;
    }, { reason: `resource-row-editor:field:${key}` });
    if (!updated) return;
    if (key === "id") this.resourceId = String(value ?? "");
    requestSkyholdAppRender();
  }

  _onPickImage(event) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    const field = this.element?.querySelector?.("[data-resource-field='img']");
    if (!field) return;
    renderFoundryFilePicker({
      type: "image",
      current: String(field.value ?? ""),
      callback: (picked) => {
        field.value = String(picked ?? "");
        field.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
  }

  async _onRestore(event) {
    event.preventDefault();
    if (!game.user?.isGM || !BUILTIN_RESOURCE_DEFS.some((row) => row.id === this.resourceId)) return;
    if (!await this._confirm("Восстановить встроенные значения этого ресурса?")) return;
    await this._removeOverride("resource-row-editor:restore");
    await this.close();
  }

  async _onDelete(event) {
    event.preventDefault();
    if (!game.user?.isGM || BUILTIN_RESOURCE_DEFS.some((row) => row.id === this.resourceId)) return;
    if (!await this._confirm("Удалить пользовательский ресурс из каталога?")) return;
    await this._removeOverride("resource-row-editor:delete");
    await this.close();
  }

  async _removeOverride(reason) {
    await SkyholdData.transaction((data) => {
      const rows = Array.isArray(data?.catalog?.resources) ? data.catalog.resources : [];
      data.catalog.resources = rows.filter((row) => String(row?.id ?? "") !== this.resourceId);
      return true;
    }, { reason });
    requestSkyholdAppRender();
  }

  async _confirm(content) {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (DialogV2?.confirm) return DialogV2.confirm({ window: { title: "Ресурс" }, content: `<p>${content}</p>`, modal: true });
    return window.confirm(content);
  }

  async _onClose(options) {
    await super._onClose(options);
    this._resourceRowAbortController?.abort?.();
    unbindGlobalInputGuard(this);
    if (this.owner?.rendered) this.owner.requestRender?.({ focus: false });
  }
}

SkyholdResourceCatalogEditor.DEFAULT_OPTIONS = {
  id: "fbl-skyhold-resource-catalog-editor",
  classes: ["fbl-skyhold", "fbl-skyhold-resource-editor"],
  tag: "section",
  window: { title: "Каталог ресурсов", icon: "fa-solid fa-boxes-stacked", resizable: true },
  position: { width: 1180, height: 780 }
};

SkyholdResourceCatalogEditor.PARTS = {
  body: { template: `modules/${MODULE_ID}/templates/resource-catalog-editor.hbs` }
};

SkyholdResourceRowEditor.DEFAULT_OPTIONS = {
  classes: ["fbl-skyhold", "fbl-skyhold-resource-row-editor"],
  tag: "section",
  window: { title: "Редактор ресурса", icon: "fa-solid fa-box", resizable: true },
  position: { width: 760, height: 720 }
};

SkyholdResourceRowEditor.PARTS = {
  body: { template: `modules/${MODULE_ID}/templates/resource-row-editor.hbs` }
};
