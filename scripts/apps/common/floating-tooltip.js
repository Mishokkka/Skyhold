const TOOLTIP_SELECTOR = "[data-fbls-tooltip], [title]:not(option)";
const TOOLTIP_BINDINGS = new WeakMap();
const DEFAULT_TOOLTIP_DELAY = 300;

export function stripNativeTooltip(element) {
  if (!element?.hasAttribute?.("title")) return;
  const title = element.getAttribute("title") ?? "";
  if (!String(element.dataset?.fblsTooltip ?? "").trim() && title.trim()) element.dataset.fblsTooltip = title.trim();
  element.dataset.fblsNativeTitle = title;
  element.removeAttribute("title");
  if (!element.getAttribute("aria-label")) {
    const label = String(element.dataset?.fblsTooltip ?? "").trim();
    if (label) element.setAttribute("aria-label", label);
  }
}

export function hideFloatingTooltip(owner) {
  if (owner?._tooltipTimer) clearTimeout(owner._tooltipTimer);
  if (owner) owner._tooltipTimer = null;
  owner?._activeTooltip?.remove?.();
  if (owner) owner._activeTooltip = null;
}

export function positionFloatingTooltip(owner, element, { margin = 10 } = {}) {
  const tooltip = owner?._activeTooltip;
  if (!tooltip || !element) return;

  const rect = element.getBoundingClientRect();
  const maxLeft = window.innerWidth - tooltip.offsetWidth - margin;
  let left = rect.left + rect.width / 2 - tooltip.offsetWidth / 2;
  left = Math.max(margin, Math.min(maxLeft, left));

  let top = rect.top - tooltip.offsetHeight - margin;
  if (top < margin) top = rect.bottom + margin;
  top = Math.max(margin, Math.min(window.innerHeight - tooltip.offsetHeight - margin, top));

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

export function showFloatingTooltip(owner, element, options = {}) {
  const text = String(element?.dataset?.fblsTooltip ?? "").trim();
  if (!owner || !text) return null;

  hideFloatingTooltip(owner);
  const tooltip = document.createElement("div");
  tooltip.className = "fbl-skyhold fbls-floating-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.textContent = text;
  document.body.appendChild(tooltip);
  owner._activeTooltip = tooltip;
  positionFloatingTooltip(owner, element, options);
  return tooltip;
}

export function bindFloatingTooltips(owner, root, { followPointer = false, margin = 10, signal } = {}) {
  hideFloatingTooltip(owner);
  if (!root?.querySelectorAll) return;
  TOOLTIP_BINDINGS.get(root)?.abort();
  const controller = new AbortController();
  TOOLTIP_BINDINGS.set(root, controller);
  const listenerOptions = { signal: controller.signal };
  controller.signal.addEventListener("abort", () => hideFloatingTooltip(owner), { once: true });
  if (signal?.aborted) { controller.abort(); return; }
  signal?.addEventListener("abort", () => controller.abort(), { ...listenerOptions, once: true });

  for (const element of root.querySelectorAll(TOOLTIP_SELECTOR)) {
    stripNativeTooltip(element);
    if (!String(element.dataset?.fblsTooltip ?? "").trim()) continue;
    element.addEventListener("mouseenter", (event) => {
      const target = event.currentTarget;
      const requestedDelay = Number(target?.dataset?.fblsTooltipDelay);
      const delay = Number.isFinite(requestedDelay) ? Math.max(0, requestedDelay) : DEFAULT_TOOLTIP_DELAY;
      if (!delay) return showFloatingTooltip(owner, target, { margin });
      hideFloatingTooltip(owner);
      owner._tooltipTimer = setTimeout(() => {
        owner._tooltipTimer = null;
        if (target?.isConnected && target.matches?.(":hover")) showFloatingTooltip(owner, target, { margin });
      }, delay);
    }, listenerOptions);
    if (followPointer) {
      element.addEventListener("mousemove", (event) => positionFloatingTooltip(owner, event.currentTarget, { margin }), listenerOptions);
    }
    element.addEventListener("mouseleave", () => hideFloatingTooltip(owner), listenerOptions);
    element.addEventListener("focusin", () => showFloatingTooltip(owner, element, { margin }), listenerOptions);
    element.addEventListener("focusout", (event) => {
      if (!element.contains(event.relatedTarget)) hideFloatingTooltip(owner);
    }, listenerOptions);
    element.addEventListener("keydown", (event) => {
      if (event.key === "Escape") hideFloatingTooltip(owner);
    }, listenerOptions);
  }
}

/** Standalone editors share the same tooltip styling and render/close cleanup. */
export function FloatingTooltipsMixin(Base) {
  return class FloatingTooltipsApplication extends Base {
    async _onRender(context, options) {
      await super._onRender(context, options);
      bindFloatingTooltips(this, this.element);
    }

    async _onClose(options) {
      const root = this.element;
      try { return await super._onClose(options); }
      finally {
        if (root) TOOLTIP_BINDINGS.get(root)?.abort();
        hideFloatingTooltip(this);
      }
    }
  };
}
