// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.

export const UiDomain = {
_safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
},

_sanitizeTextBlock(value = "") {
  return String(value ?? "").replace(/\t/g, " ").replace(/\u00a0/g, " ").replace(/[ \t]+$/gm, "");
},

_bindInputGuards(root) {
  const stop = (event) => event.stopPropagation();
  const sanitizeTabs = (event) => {
    const field = event.currentTarget;
    if (!(field instanceof HTMLTextAreaElement)) return;
    const value = String(field.value ?? "");
    const clean = this._sanitizeTextBlock ? this._sanitizeTextBlock(value) : value.replace(/	/g, " ").replace(/ /g, " ").replace(/[ 	]+$/gm, "");
    if (clean === value) return;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    field.value = clean;
    field.selectionStart = Math.max(0, Math.min(clean.length, start));
    field.selectionEnd = Math.max(0, Math.min(clean.length, end));
  };  root.querySelectorAll("input, textarea, select").forEach((field) => {
    if (field instanceof HTMLTextAreaElement) {
      field.addEventListener("input", sanitizeTabs);
      field.addEventListener("paste", () => setTimeout(() => sanitizeTabs({ currentTarget: field }), 0));
    }
    for (const eventName of ["keydown", "keyup", "keypress", "input", "beforeinput", "paste", "copy", "cut", "mousedown", "mouseup", "click", "dblclick"]) {
      field.addEventListener(eventName, stop, { capture: true });
      field.addEventListener(eventName, stop);
    }
  });
},

_bindGlobalInputGuard(root) {
  this._unbindGlobalInputGuard();

  const editableSelector = "input, textarea, select, [contenteditable='true']";
  this._globalInputGuard = (event) => {
    const target = event.target;
    const active = document.activeElement;
    const targetInside = target instanceof Element && root.contains(target);
    const activeInside = active instanceof Element && root.contains(active);
    const targetEditable = target instanceof Element && Boolean(target.closest(editableSelector));
    const activeEditable = active instanceof Element && Boolean(active.closest(editableSelector));

    if ((targetInside && targetEditable) || (activeInside && activeEditable)) {
      event.stopImmediatePropagation();
    }
  };

  for (const eventName of ["keydown", "keyup", "keypress"]) {
    window.addEventListener(eventName, this._globalInputGuard, true);
  }
},

_unbindGlobalInputGuard() {
  if (!this._globalInputGuard) return;
  for (const eventName of ["keydown", "keyup", "keypress"]) {
    window.removeEventListener(eventName, this._globalInputGuard, true);
  }
  this._globalInputGuard = null;
},

_bindFloatingTooltips(root) {
  root.querySelectorAll("[data-fbls-tooltip]").forEach((element) => {
    element.addEventListener("mouseenter", (event) => this._showTooltip(event.currentTarget));
    element.addEventListener("mousemove", (event) => this._positionTooltip(event.currentTarget));
    element.addEventListener("mouseleave", () => this._hideTooltip());
  });
},



_syncTitlebarRunbar({ canEdit = false, hasHolding = false } = {}) {
  const appShell = this.element?.closest?.(".application, .app, .window-app") ?? this.element?.parentElement?.closest?.(".application, .app, .window-app");
  const header = appShell?.querySelector?.(".window-header");
  if (!header) return;

  header.querySelector(".fbls-titlebar-runbar")?.remove();
  if (!canEdit || !hasHolding) return;

  const bar = document.createElement("div");
  bar.className = "fbls-titlebar-runbar";
  bar.innerHTML = `
    <button type="button" class="fbls-titlebar-runbar-button" data-action="run-economy-period" data-qd="1" title="Провести производство за 1 четверть дня"><i class="fa-solid fa-clock"></i><span>1 QD</span></button>
    <button type="button" class="fbls-titlebar-runbar-button" data-action="run-economy-period" data-qd="4" title="Провести производство за 1 день"><i class="fa-solid fa-sun"></i><span>День</span></button>
    <button type="button" class="fbls-titlebar-runbar-button" data-action="run-economy-period" data-qd="40" title="Провести производство за десятник"><i class="fa-solid fa-rotate"></i><span>Десятник</span></button>
  `;
  bar.querySelectorAll("button[data-action='run-economy-period']").forEach((button) => {
    button.addEventListener("click", (event) => {
      // ApplicationV2 may include the titlebar in this.element; without this guard
      // the same button can receive both the direct titlebar listener and the
      // normal app listener, advancing time twice.
      event.stopImmediatePropagation();
      return this._onRunEconomyPeriod(event);
    });
  });

  const controls = header.querySelector(".window-controls, .header-control, .window-header-buttons");
  if (controls?.parentElement === header) header.insertBefore(bar, controls);
  else header.appendChild(bar);
},

_removeTitlebarRunbar() {
  const appShell = this.element?.closest?.(".application, .app, .window-app") ?? document.querySelector(".fbl-skyhold")?.closest?.(".application, .app, .window-app");
  appShell?.querySelector?.(".fbls-titlebar-runbar")?.remove();
},

_showTooltip(element) {
  const text = String(element?.dataset?.fblsTooltip ?? "").trim();
  if (!text) return;

  this._hideTooltip();
  const tooltip = document.createElement("div");
  tooltip.className = "fbls-floating-tooltip";
  tooltip.textContent = text;
  document.body.appendChild(tooltip);
  this._activeTooltip = tooltip;
  this._positionTooltip(element);
},

_positionTooltip(element) {
  const tooltip = this._activeTooltip;
  if (!tooltip || !element) return;

  const rect = element.getBoundingClientRect();
  const margin = 10;
  const maxLeft = window.innerWidth - tooltip.offsetWidth - margin;
  let left = rect.left + rect.width / 2 - tooltip.offsetWidth / 2;
  left = Math.max(margin, Math.min(maxLeft, left));

  let top = rect.top - tooltip.offsetHeight - margin;
  if (top < margin) top = rect.bottom + margin;
  top = Math.max(margin, Math.min(window.innerHeight - tooltip.offsetHeight - margin, top));

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
},

_hideTooltip() {
  if (this._activeTooltip) {
    this._activeTooltip.remove();
    this._activeTooltip = null;
  }
}
};
