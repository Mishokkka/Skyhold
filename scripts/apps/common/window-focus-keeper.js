const WINDOW_FRAME_SELECTOR = ".application, .app, .window-app";
const PROTECTED_SKYHOLD_WINDOW_SELECTOR = [
  ".fbl-skyhold:not(.fbl-skyhold-app)",
  ".fbls-person-editor.v2",
  ".fbl-skyhold-mass-combat"
].join(", ");

let installed = false;
let lastProtectedWindow = null;

function elementReference(element) {
  return typeof globalThis.WeakRef === "function"
    ? new globalThis.WeakRef(element)
    : { deref: () => element };
}

function rememberedProtectedWindow() {
  if (!lastProtectedWindow) return null;
  const protectedWindow = lastProtectedWindow.protectedWindowRef?.deref?.() ?? null;
  const frame = lastProtectedWindow.frameRef?.deref?.() ?? null;
  const target = lastProtectedWindow.targetRef?.deref?.() ?? null;
  if (!protectedWindow || !frame) {
    lastProtectedWindow = null;
    return null;
  }
  return { protectedWindow, frame, target, time: lastProtectedWindow.time };
}

function now() {
  return Date.now?.() ?? new Date().getTime();
}

export function windowFrameForElement(element = null) {
  return element?.closest?.(WINDOW_FRAME_SELECTOR) ?? null;
}

function protectedWindowForElement(element = null) {
  return element?.closest?.(PROTECTED_SKYHOLD_WINDOW_SELECTOR) ?? null;
}

export function rememberProtectedSkyholdWindow(target = null) {
  const protectedWindow = protectedWindowForElement(target);
  const frame = windowFrameForElement(protectedWindow ?? target);
  if (!protectedWindow || !frame) return null;
  const descriptor = { protectedWindow, frame, target, time: now() };
  lastProtectedWindow = {
    protectedWindowRef: elementReference(protectedWindow),
    frameRef: elementReference(frame),
    targetRef: elementReference(target),
    time: descriptor.time
  };
  return descriptor;
}

export function forgetProtectedSkyholdWindow(element = null) {
  const remembered = rememberedProtectedWindow();
  if (!remembered) return false;
  if (element) {
    const frame = windowFrameForElement(element) ?? element;
    if (remembered.frame !== frame && remembered.protectedWindow !== element && remembered.target !== element) return false;
  }
  lastProtectedWindow = null;
  return true;
}

export function getActiveProtectedSkyholdWindow({ recentMs = 5000 } = {}) {
  const active = globalThis.document?.activeElement;
  const activeProtected = protectedWindowForElement(active);
  if (activeProtected) {
    const frame = windowFrameForElement(activeProtected);
    if (frame) return { protectedWindow: activeProtected, frame, target: active, time: now(), active: true };
  }

  const remembered = rememberedProtectedWindow();
  if (!remembered?.frame?.isConnected) {
    lastProtectedWindow = null;
    return null;
  }
  if (recentMs >= 0 && now() - Number(remembered.time ?? 0) > recentMs) {
    lastProtectedWindow = null;
    return null;
  }
  return remembered;
}

export function hasActiveProtectedSkyholdWindow(options = {}) {
  return Boolean(getActiveProtectedSkyholdWindow(options));
}

export function bringWindowFrameToFront(frame = null) {
  if (!frame?.isConnected) return false;
  const frames = Array.from(globalThis.document?.querySelectorAll?.(WINDOW_FRAME_SELECTOR) ?? []);
  const maxZ = frames
    .map((element) => Number(globalThis.getComputedStyle?.(element)?.zIndex ?? element?.style?.zIndex ?? 0))
    .filter(Number.isFinite)
    .reduce((max, value) => Math.max(max, value), 0);
  frame.style.zIndex = String(Math.max(maxZ + 1, 101));
  return true;
}

export function focusApplicationContent(app, {
  root = app?.element,
  options = {},
  preferredSelector = ""
} = {}) {
  if (options?.focus !== true || !root?.querySelector) return false;
  const frame = app?._getWindowFrameElement?.(root) ?? windowFrameForElement(root);
  bringWindowFrameToFront(frame);
  const apply = () => {
    if (!root?.isConnected) return;
    const active = globalThis.document?.activeElement;
    if (active && root.contains?.(active)) return;
    const preferred = preferredSelector ? root.querySelector(preferredSelector) : null;
    const target = preferred ?? root.querySelector([
      "[autofocus]",
      "button:not([disabled])",
      "select:not([disabled])",
      "input:not([disabled]):not([type='hidden'])",
      "textarea:not([disabled])",
      "[role='button'][tabindex='0']"
    ].join(", "));
    if (typeof target?.focus !== "function") return;
    target.focus({ preventScroll: true });
  };
  if (globalThis.requestAnimationFrame) globalThis.requestAnimationFrame(apply);
  else globalThis.setTimeout?.(apply, 0);
  return true;
}

function focusReturnSelector(element = null) {
  if (!element?.getAttribute) return "";
  const escape = (value) => String(value ?? "").replace(/["\\]/g, "\\$&");
  const attributes = ["data-action", "data-id", "data-building-id", "data-row-id", "aria-label"]
    .map((name) => [name, element.getAttribute(name)])
    .filter(([, value]) => String(value ?? "").trim());
  if (!attributes.length) return "";
  const tag = String(element.tagName ?? "").toLowerCase();
  return `${tag || "*"}${attributes.map(([name, value]) => `[${name}="${escape(value)}"]`).join("")}`;
}

export function rememberApplicationFocusReturn(app, element = globalThis.document?.activeElement) {
  if (!app || !element) return null;
  const descriptor = { element, selector: focusReturnSelector(element) };
  app._applicationFocusReturn = descriptor;
  return descriptor;
}

export function restoreApplicationFocus(app, { root = null } = {}) {
  const descriptor = app?._applicationFocusReturn;
  if (!descriptor) return false;
  app._applicationFocusReturn = null;
  const direct = descriptor.element?.isConnected ? descriptor.element : null;
  const target = direct
    ?? (descriptor.selector ? root?.querySelector?.(descriptor.selector) : null)
    ?? (descriptor.selector ? globalThis.document?.querySelector?.(descriptor.selector) : null);
  if (typeof target?.focus !== "function") return false;
  target.focus({ preventScroll: true });
  return true;
}

export function installSkyholdWindowFocusKeeper() {
  if (installed || !globalThis.document?.addEventListener) return;
  installed = true;
  const remember = (event) => rememberProtectedSkyholdWindow(event.target);
  globalThis.document.addEventListener("focusin", remember, true);
  globalThis.document.addEventListener("pointerdown", remember, true);
  globalThis.document.addEventListener("change", remember, true);
}
