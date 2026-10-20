import { bringWindowFrameToFront, windowFrameForElement } from "./window-focus-keeper.js";

function captureFocusState(app = null, options = {}) {
  if (options?.focus !== false) return null;
  const doc = globalThis.document;
  const activeElement = doc?.activeElement;
  if (!activeElement || activeElement === doc.body || activeElement === doc.documentElement) return null;

  const activeFrame = windowFrameForElement(activeElement);
  const appFrame = app?._getWindowFrameElement?.() ?? windowFrameForElement(app?.element);
  const selection = Number.isFinite(activeElement.selectionStart) && Number.isFinite(activeElement.selectionEnd)
    ? { start: activeElement.selectionStart, end: activeElement.selectionEnd, direction: activeElement.selectionDirection }
    : null;

  return { activeElement, activeFrame, appFrame, selection };
}

function restoreFocusState(state = null) {
  if (!state) return;
  const doc = globalThis.document;
  const { activeElement, activeFrame, appFrame, selection } = state;

  if (activeFrame?.isConnected && activeFrame !== appFrame) {
    bringWindowFrameToFront(activeFrame);
  }

  if (!activeElement?.isConnected || doc?.activeElement === activeElement || typeof activeElement.focus !== "function") return;
  try {
    activeElement.focus({ preventScroll: true });
    if (selection && typeof activeElement.setSelectionRange === "function") {
      activeElement.setSelectionRange(selection.start, selection.end, selection.direction ?? "none");
    }
  } catch (_error) {
    // Some Foundry/DOM controls cannot be programmatically refocused; ignore.
  }
}

function captureScrollState(app = null, options = {}) {
  if (options?.focus !== false || options?.preserveScroll === false) return [];
  const root = app?.element;
  if (!root?.querySelectorAll) return [];
  return [...root.querySelectorAll("[data-render-scroll-key]")].map((element) => ({
    key: String(element.dataset.renderScrollKey ?? ""),
    top: Number(element.scrollTop) || 0,
    left: Number(element.scrollLeft) || 0
  })).filter((row) => row.key);
}

function restoreScrollState(app = null, rows = []) {
  if (!rows.length) return;
  const elements = [...(app?.element?.querySelectorAll?.("[data-render-scroll-key]") ?? [])];
  const byKey = new Map(elements.map((element) => [String(element.dataset.renderScrollKey ?? ""), element]));
  for (const row of rows) {
    const element = byKey.get(row.key);
    if (!element) continue;
    element.scrollTop = row.top;
    element.scrollLeft = row.left;
  }
}

export function requestApplicationRender(app, options = {}) {
  if (!app || typeof app.render !== "function" || app._renderSchedulerClosed) return null;
  const generation = app._renderSchedulerGeneration ?? 0;

  const nextOptions = {
    force: true,
    ...(app._queuedRenderOptions ?? {}),
    ...options
  };
  nextOptions.focus = Object.hasOwn(options ?? {}, "focus") ? options.focus : false;
  app._queuedRenderOptions = nextOptions;
  app._renderRequestedDuringQueue = true;

  if (app._queuedRenderPromise) return app._queuedRenderPromise;

  const queueState = {};
  app._renderQueueState = queueState;

  app._queuedRenderPromise = new Promise((resolve, reject) => {
    const flush = async () => {
      let result = null;
      try {
        do {
          if (app._renderSchedulerClosed || (app._renderSchedulerGeneration ?? 0) !== generation) break;
          app._renderRequestedDuringQueue = false;
          const renderOptions = app._queuedRenderOptions ?? { force: true, focus: false };
          app._queuedRenderOptions = null;
          const focusState = captureFocusState(app, renderOptions);
          const scrollState = captureScrollState(app, renderOptions);
          result = await app.render(renderOptions);
          if (!app._renderSchedulerClosed && (app._renderSchedulerGeneration ?? 0) === generation) {
            restoreScrollState(app, scrollState);
            restoreFocusState(focusState);
          }
        } while (app._renderRequestedDuringQueue);
        resolve(result);
      } catch (error) {
        reject(error);
      } finally {
        if (app._renderQueueState === queueState) {
          app._queuedRenderPromise = null;
          app._queuedRenderOptions = null;
          app._renderRequestedDuringQueue = false;
          app._renderQueueState = null;
        }
      }
    };

    if (globalThis.requestAnimationFrame) globalThis.requestAnimationFrame(flush);
    else globalThis.setTimeout(flush, 0);
  });

  return app._queuedRenderPromise;
}

export function RenderSchedulerMixin(Base) {
  return class RenderScheduledApplication extends Base {
    render(...args) {
      this._renderSchedulerClosed = false;
      return super.render(...args);
    }

    async _onClose(options) {
      this._renderSchedulerClosed = true;
      this._renderSchedulerGeneration = (this._renderSchedulerGeneration ?? 0) + 1;
      this._renderQueueState = null;
      this._queuedRenderPromise = null;
      this._queuedRenderOptions = null;
      this._renderRequestedDuringQueue = false;
      return super._onClose(options);
    }

    requestRender(options = {}) {
      return requestApplicationRender(this, options);
    }
  };
}
