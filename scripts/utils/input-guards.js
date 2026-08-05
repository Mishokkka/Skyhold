export const INPUT_GUARD_EVENTS = [
  "keydown",
  "keyup",
  "keypress",
  "input",
  "beforeinput",
  "paste",
  "copy",
  "cut",
  "mousedown",
  "mouseup",
  "click",
  "dblclick"
];

export const GLOBAL_INPUT_GUARD_EVENTS = ["keydown", "keyup", "keypress"];
export const EDITABLE_INPUT_SELECTOR = "input, textarea, select, [contenteditable='true']";
export const TEXTAREA_PASTE_SANITIZE_DELAY_MS = 0;
const GUARDED_INPUT_ROOTS = new WeakSet();

export function sanitizeTextBlock(value = "") {
  return String(value ?? "").replace(/\t/g, " ").replace(/\u00a0/g, " ").replace(/[ \t]+$/gm, "");
}

export function replaceTabs(value = "", replacement = "  ") {
  return String(value ?? "").replace(/\t/g, replacement);
}

export function applyTextareaSanitizer(field, sanitizer, { selectionMode = "mapped" } = {}) {
  if (!(field instanceof HTMLTextAreaElement) || typeof sanitizer !== "function") return;
  const value = String(field.value ?? "");
  const clean = sanitizer(value);
  if (clean === value) return;

  const start = field.selectionStart;
  const end = field.selectionEnd;
  field.value = clean;
  if (selectionMode === "clamp") {
    field.selectionStart = Math.max(0, Math.min(clean.length, start));
    field.selectionEnd = Math.max(0, Math.min(clean.length, end));
    return;
  }

  field.selectionStart = Math.max(0, Math.min(clean.length, sanitizer(value.slice(0, start)).length));
  field.selectionEnd = Math.max(0, Math.min(clean.length, sanitizer(value.slice(0, end)).length));
}

export function bindInputGuards(root, { textareaSanitizer = null, textareaSelectionMode = "mapped" } = {}) {
  if (!root?.querySelectorAll) return;
  const stop = (event) => event.stopPropagation();
  const sanitize = (field) => applyTextareaSanitizer(field, textareaSanitizer, { selectionMode: textareaSelectionMode });

  root.querySelectorAll("input, textarea, select").forEach((field) => {
    if (field instanceof HTMLTextAreaElement && textareaSanitizer) {
      field.addEventListener("input", () => sanitize(field));
      field.addEventListener("paste", () => setTimeout(() => sanitize(field), TEXTAREA_PASTE_SANITIZE_DELAY_MS));
    }
  });

  // Stop Foundry/canvas handlers only after the event has reached this
  // application root. Delegated application listeners attached to the same
  // root still run, while events do not escape into the surrounding UI.
  // Stopping at the field itself used to swallow input events before search
  // and other delegated controls could observe them.
  if (!GUARDED_INPUT_ROOTS.has(root)) {
    GUARDED_INPUT_ROOTS.add(root);
    for (const eventName of INPUT_GUARD_EVENTS) root.addEventListener(eventName, stop);
  }
}

export function bindGlobalInputGuard(owner, root) {
  if (!owner || !root) return;
  unbindGlobalInputGuard(owner);

  owner._globalInputGuard = (event) => {
    const target = event.target;
    const active = document.activeElement;
    const targetInside = target instanceof Element && root.contains(target);
    const activeInside = active instanceof Element && root.contains(active);
    const targetEditable = target instanceof Element && Boolean(target.closest(EDITABLE_INPUT_SELECTOR));
    const activeEditable = active instanceof Element && Boolean(active.closest(EDITABLE_INPUT_SELECTOR));
    if ((targetInside && targetEditable) || (activeInside && activeEditable)) event.stopImmediatePropagation();
  };

  for (const eventName of GLOBAL_INPUT_GUARD_EVENTS) {
    window.addEventListener(eventName, owner._globalInputGuard, true);
  }
}

export function unbindGlobalInputGuard(owner) {
  if (!owner?._globalInputGuard) return;
  for (const eventName of GLOBAL_INPUT_GUARD_EVENTS) {
    window.removeEventListener(eventName, owner._globalInputGuard, true);
  }
  owner._globalInputGuard = null;
}
