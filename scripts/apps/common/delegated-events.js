const USER_NOTIFIED_ERRORS = new WeakSet();
const DEFAULT_ACTION_ERROR_MESSAGE = "Не удалось выполнить действие. Подробности в консоли.";

export function delegatedEvent(event, currentTarget) {
  return new Proxy(event, {
    get(target, prop) {
      if (prop === "currentTarget" || prop === "delegateTarget") return currentTarget;
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

export function markDelegatedActionErrorNotified(error) {
  if (error && (typeof error === "object" || typeof error === "function")) USER_NOTIFIED_ERRORS.add(error);
  return error;
}

function delegatedActionLabel(element, handlerName) {
  const action = String(element?.dataset?.action ?? "").trim();
  if (action) return action;
  if (typeof handlerName === "string" && handlerName.trim()) return handlerName.trim();
  if (typeof handlerName === "function" && handlerName.name) return handlerName.name;
  return "unknown";
}

function reportDelegatedActionError(error, { element, handlerName } = {}) {
  const label = delegatedActionLabel(element, handlerName);
  globalThis.console?.error?.(`FBL Skyhold | Delegated action "${label}" failed`, error);
  const alreadyNotified = Boolean(error && (typeof error === "object" || typeof error === "function") && USER_NOTIFIED_ERRORS.has(error));
  if (!alreadyNotified) globalThis.ui?.notifications?.error?.(DEFAULT_ACTION_ERROR_MESSAGE);
}

function isPromiseLike(value) {
  return Boolean(value && (typeof value === "object" || typeof value === "function") && typeof value.then === "function");
}

export function dispatchDelegatedAction(app, event, element, handlerName) {
  try {
    const handler = typeof handlerName === "function" ? handlerName : app?.[handlerName];
    if (typeof handler !== "function") return false;
    const result = handler.call(app, delegatedEvent(event, element));
    if (!isPromiseLike(result)) return result ?? true;
    return Promise.resolve(result).catch((error) => {
      reportDelegatedActionError(error, { element, handlerName });
      return false;
    });
  } catch (error) {
    reportDelegatedActionError(error, { element, handlerName });
    return false;
  }
}

export function unbindDelegatedActions(app, { controllerProperty = "_delegatedActionAbortController" } = {}) {
  app?.[controllerProperty]?.abort?.();
  if (app) app[controllerProperty] = null;
}

export function bindDelegatedActions(app, root, actions = {}, {
  controllerProperty = "_delegatedActionAbortController"
} = {}) {
  unbindDelegatedActions(app, { controllerProperty });
  if (!root?.addEventListener) return null;

  const controller = new AbortController();
  app[controllerProperty] = controller;
  root.addEventListener("click", (event) => {
    const element = event.target?.closest?.("[data-action]");
    if (!element || !root.contains?.(element)) return;
    const handlerName = actions[String(element.dataset?.action ?? "")];
    if (!handlerName) return;
    dispatchDelegatedAction(app, event, element, handlerName);
  }, { signal: controller.signal });
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target?.closest?.("button, input, textarea, select, a[href], [contenteditable='true']")) return;
    const element = event.target?.closest?.("[data-action][role='button']");
    if (!element || !root.contains?.(element)) return;
    event.preventDefault();
    element.click?.();
  }, { signal: controller.signal });
  return controller;
}
