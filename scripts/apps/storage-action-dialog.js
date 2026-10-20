import { MODULE_ID } from "../data/constants.js";
import { WindowFrameMixin } from "./common/window-frame.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function finitePositive(value, fallback = 1) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export class SkyholdStorageActionDialog extends WindowFrameMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  static open(config = {}) {
    return new Promise((resolve) => {
      const app = new this({ config, resolve });
      const failed = (error) => {
        console.error("FBL Skyhold | Failed to open storage dialog", error);
        app._settled = true;
        app._resultResolver = null;
        resolve(null);
      };
      try { Promise.resolve(app.render({ force: true, focus: true })).catch(failed); }
      catch (error) { failed(error); }
    });
  }

  constructor({ config = {}, resolve = null } = {}, options = {}) {
    super(options);
    this.config = { ...config };
    this._resultResolver = typeof resolve === "function" ? resolve : null;
    this._settled = false;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const mode = String(this.config.mode ?? "confirm");
    const max = Math.max(1, Math.floor(finitePositive(this.config.max, 1)));
    const value = Math.max(1, Math.min(max, Math.floor(finitePositive(this.config.value, 1))));
    const allowQuantity = mode === "move" && Boolean(this.config.allowQuantity);
    return {
      ...context,
      title: String(this.config.title ?? "Действие с хранилищем"),
      description: String(this.config.description ?? ""),
      icon: String(this.config.icon ?? "fa-solid fa-box"),
      confirmLabel: String(this.config.confirmLabel ?? "Применить"),
      danger: Boolean(this.config.danger),
      mode,
      isMove: mode === "move",
      isQuantity: mode === "quantity" || allowQuantity,
      allowQuantity,
      isNote: mode === "note",
      isConfirm: mode === "confirm",
      options: Array.isArray(this.config.options) ? this.config.options : [],
      value,
      max,
      note: String(this.config.note ?? ""),
      quantityHint: String(this.config.quantityHint ?? "")
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    this._centerOnAnchor();
    this._bindWindowFrameSync(root);
    const form = root.querySelector("[data-storage-action-form]");
    form?.addEventListener("submit", (event) => this._onSubmit(event));
    root.querySelector("[data-action='storage-dialog-cancel']")?.addEventListener("click", (event) => {
      event.preventDefault();
      this._finish(null);
    });
    root.querySelector("[data-action='storage-dialog-confirm']")?.addEventListener("click", (event) => {
      event.preventDefault();
      if (form?.reportValidity?.() !== false) this._finish(this._readResult(form));
    });
    const focusPrimaryField = () => root.querySelector("[autofocus]")?.focus?.({ preventScroll: true });
    if (globalThis.queueMicrotask) globalThis.queueMicrotask(focusPrimaryField);
    else globalThis.setTimeout(focusPrimaryField, 0);
  }

  _centerOnAnchor() {
    if (this._positionedAtAnchor) return;
    const anchor = this.config.anchor;
    const anchorFrame = anchor?._captureWindowFrame?.()
      ?? anchor?.element?.getBoundingClientRect?.()
      ?? null;
    if (!anchorFrame) return;

    const dialogFrame = this._captureWindowFrame() ?? this.position ?? {};
    const width = finitePositive(dialogFrame.width, 440);
    const height = finitePositive(dialogFrame.height, 280);
    const anchorWidth = finitePositive(anchorFrame.width, width);
    const anchorHeight = finitePositive(anchorFrame.height, height);
    const margin = 12;
    const viewportWidth = finitePositive(globalThis.innerWidth, anchorFrame.left + anchorWidth + margin);
    const viewportHeight = finitePositive(globalThis.innerHeight, anchorFrame.top + anchorHeight + margin);
    const left = Math.max(margin, Math.min(
      viewportWidth - width - margin,
      Number(anchorFrame.left ?? 0) + ((anchorWidth - width) / 2)
    ));
    const top = Math.max(margin, Math.min(
      viewportHeight - height - margin,
      Number(anchorFrame.top ?? 0) + ((anchorHeight - height) / 2)
    ));

    this._positionedAtAnchor = true;
    this.setPosition({ left: Math.round(left), top: Math.round(top) });
  }

  _readResult(form) {
    const mode = String(this.config.mode ?? "confirm");
    if (mode === "move") {
      const destination = String(form?.elements?.destination?.value ?? "");
      if (!this.config.allowQuantity) return destination;
      return { destination, quantity: this._readQuantity(form) };
    }
    if (mode === "note") return String(form?.elements?.note?.value ?? "");
    if (mode === "quantity") return this._readQuantity(form);
    return true;
  }

  _readQuantity(form) {
    const max = Math.max(1, Math.floor(finitePositive(this.config.max, 1)));
    return Math.max(1, Math.min(max, Math.floor(finitePositive(form?.elements?.quantity?.value, 1))));
  }

  _onSubmit(event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget?.reportValidity?.() !== false) this._finish(this._readResult(event.currentTarget));
  }

  async _finish(value) {
    if (this._settled) return;
    this._settled = true;
    const resolve = this._resultResolver;
    this._resultResolver = null;
    try { await this.close(); }
    catch (error) { console.error("FBL Skyhold | Failed to close storage dialog", error); }
    finally { resolve?.(value); }
  }

  async _onClose(options) {
    await super._onClose(options);
    this._unbindWindowFrameSync();
    if (this._settled) return;
    this._settled = true;
    const resolve = this._resultResolver;
    this._resultResolver = null;
    resolve?.(null);
  }
}

SkyholdStorageActionDialog.DEFAULT_OPTIONS = {
  id: "fbl-skyhold-storage-action",
  classes: ["fbl-skyhold", "fbls-storage-action-dialog"],
  tag: "section",
  window: { title: "Хранилище", icon: "fa-solid fa-box-archive", resizable: false },
  position: { width: 440, height: 330 }
};

SkyholdStorageActionDialog.PARTS = {
  body: { template: `modules/${MODULE_ID}/templates/storage-action-dialog.hbs` }
};
