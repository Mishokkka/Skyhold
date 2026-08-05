// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { createSafeIcon } from "../../core/helpers.js";
import { bindGlobalInputGuard, bindInputGuards, sanitizeTextBlock, unbindGlobalInputGuard } from "../../utils/input-guards.js";
import { bindFloatingTooltips, hideFloatingTooltip } from "../common/floating-tooltip.js";

function createRunbarButton({ qd, icon, label, title }, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "fbls-titlebar-runbar-button";
  button.dataset.action = "run-economy-period";
  button.dataset.qd = String(qd);
  button.dataset.fblsTooltip = title;
  button.setAttribute("aria-label", title);
  const text = document.createElement("span");
  text.textContent = label;
  button.append(createSafeIcon(icon), text);
  button.addEventListener("click", onClick);
  return button;
}

export const UiDomain = {
_safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
},

_sanitizeTextBlock(value = "") {
  return sanitizeTextBlock(value);
},

_bindInputGuards(root) {
  bindInputGuards(root, {
    textareaSanitizer: (value) => this._sanitizeTextBlock?.(value) ?? sanitizeTextBlock(value),
    textareaSelectionMode: "clamp"
  });
},

_bindGlobalInputGuard(root) {
  bindGlobalInputGuard(this, root);
},

_unbindGlobalInputGuard() {
  unbindGlobalInputGuard(this);
},

_bindFloatingTooltips(root) {
  bindFloatingTooltips(this, root, { followPointer: true });
},



_syncTitlebarRunbar({ canEdit = false, hasHolding = false } = {}) {
  const appShell = this.element?.closest?.(".application, .app, .window-app") ?? this.element?.parentElement?.closest?.(".application, .app, .window-app");
  const header = appShell?.querySelector?.(".window-header");
  if (!header) return;

  header.querySelector(".fbls-titlebar-runbar")?.remove();
  if (!canEdit || !hasHolding) return;

  const bar = document.createElement("div");
  bar.className = "fbls-titlebar-runbar";
  const runPeriod = (event) => {
    // ApplicationV2 may include the titlebar in this.element; without this guard
    // the same button can receive both the direct titlebar listener and the
    // normal app listener, advancing time twice.
    event.stopImmediatePropagation();
    return this._onRunEconomyPeriod(event);
  };
  bar.append(
    createRunbarButton({ qd: 40, icon: "fa-solid fa-rotate", label: "Десятник", title: "Рассчитать прогноз и провести следующий десятник" }, runPeriod)
  );
  this._bindFloatingTooltips(bar);

  const controls = header.querySelector(".window-controls, .header-control, .window-header-buttons");
  if (controls?.parentElement === header) header.insertBefore(bar, controls);
  else header.appendChild(bar);
},

_removeTitlebarRunbar() {
  const appShell = this.element?.closest?.(".application, .app, .window-app") ?? document.querySelector(".fbl-skyhold")?.closest?.(".application, .app, .window-app");
  appShell?.querySelector?.(".fbls-titlebar-runbar")?.remove();
},

_hideTooltip() {
  hideFloatingTooltip(this);
}
};
