const FRAME_KEYS = ["left", "top", "width", "height"];

function frameValue(value, { requirePositive = false } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (requirePositive && numeric <= 0) return null;
  return Math.round(numeric);
}

function shouldPreserveMovingSize(app, position, frame, key) {
  if (!Object.prototype.hasOwnProperty.call(position, key)) return true;
  const incoming = Number(position[key]);
  if (!Number.isFinite(incoming) || incoming <= 0) return true;
  const defaultValue = Number(app.constructor?.DEFAULT_OPTIONS?.position?.[key]);
  const current = Number(frame?.[key]);
  return Number.isFinite(defaultValue)
    && Number.isFinite(current)
    && Math.round(incoming) === Math.round(defaultValue)
    && Math.abs(Math.round(current) - Math.round(incoming)) > 1;
}

export function WindowFrameMixin(Base) {
  return class WindowFrameApplication extends Base {
    async render(options = {}) {
      const frame = this.rendered ? this._captureWindowFrame() : null;
      const result = await super.render(options);
      if (frame) this._restoreWindowFrame(frame);
      this._windowFrameHasRendered = true;
      this._queueWindowFrameSync();
      return result;
    }

    setPosition(position = {}) {
      const nextPosition = position ?? {};
      const hasPositionKey = (key) => Object.prototype.hasOwnProperty.call(nextPosition, key);
      const moving = this._windowFrameHasRendered
        && this.rendered
        && this.element
        && (hasPositionKey("left") || hasPositionKey("top"));

      if (moving) {
        const liveFrame = this._captureWindowFrame();
        const rememberedFrame = this._lastWindowFrame ?? {};
        const frame = liveFrame ? {
          ...liveFrame,
          width: rememberedFrame.width ?? liveFrame.width,
          height: rememberedFrame.height ?? liveFrame.height
        } : this._lastWindowFrame;

        if (frame) {
          const preserveWidth = shouldPreserveMovingSize(this, nextPosition, frame, "width");
          const preserveHeight = shouldPreserveMovingSize(this, nextPosition, frame, "height");
          if (preserveWidth || preserveHeight) {
            const positionWithSize = { ...nextPosition };
            if (preserveWidth && Number.isFinite(Number(frame.width)) && Number(frame.width) > 0) positionWithSize.width = frame.width;
            if (preserveHeight && Number.isFinite(Number(frame.height)) && Number(frame.height) > 0) positionWithSize.height = frame.height;
            const result = super.setPosition(positionWithSize);
            this._queueWindowFrameSync();
            return result;
          }
        }
      }

      const result = super.setPosition(nextPosition);
      this._queueWindowFrameSync();
      return result;
    }

    _getWindowFrameElement(root = this.element) {
      return root?.closest?.(".application, .app, .window-app") ?? root?.parentElement?.closest?.(".application, .app, .window-app") ?? root;
    }

    _queueWindowFrameSync() {
      const sync = () => this._syncWindowFrameState();
      if (globalThis.requestAnimationFrame) requestAnimationFrame(sync);
      else setTimeout(sync, 0);
    }

    _bindWindowFrameSync(root = this.element) {
      this._unbindWindowFrameSync();
      const frame = this._getWindowFrameElement(root);
      if (!frame) return;

      const sync = () => this._syncWindowFrameState();
      this._windowFrameSyncHandler = sync;
      const header = frame.querySelector?.(".window-header") ?? frame;
      header.addEventListener?.("pointerdown", sync, true);
      header.addEventListener?.("mousedown", sync, true);

      if (typeof globalThis.ResizeObserver === "function") {
        this._windowFrameResizeObserver = new ResizeObserver(sync);
        this._windowFrameResizeObserver.observe(frame);
      }

      sync();
    }

    _unbindWindowFrameSync() {
      const sync = this._windowFrameSyncHandler;
      if (sync) {
        const frame = this._getWindowFrameElement();
        const header = frame?.querySelector?.(".window-header") ?? frame;
        header?.removeEventListener?.("pointerdown", sync, true);
        header?.removeEventListener?.("mousedown", sync, true);
      }
      this._windowFrameResizeObserver?.disconnect?.();
      this._windowFrameResizeObserver = null;
      this._windowFrameSyncHandler = null;
    }

    _syncWindowFrameState() {
      if (!this._windowFrameHasRendered) return null;
      const frame = this._captureWindowFrame();
      if (!frame) return null;
      this._lastWindowFrame = frame;
      if (this.position && typeof this.position === "object") {
        for (const key of FRAME_KEYS) {
          const numeric = Number(frame[key]);
          if (!Number.isFinite(numeric)) continue;
          if ((key === "width" || key === "height") && numeric <= 0) continue;
          try { this.position[key] = Math.round(numeric); }
          catch (_error) {}
        }
      }
      return frame;
    }

    _captureWindowFrame() {
      const appShell = this._getWindowFrameElement();
      const rect = appShell?.getBoundingClientRect?.();
      const position = this.position ?? {};
      const frame = {};
      const setFrameValue = (key, value) => {
        const numeric = frameValue(value, { requirePositive: key === "width" || key === "height" });
        if (numeric !== null) frame[key] = numeric;
      };

      if (rect) {
        setFrameValue("left", rect.left);
        setFrameValue("top", rect.top);
        setFrameValue("width", rect.width);
        setFrameValue("height", rect.height);
      }

      for (const key of FRAME_KEYS) {
        if (frame[key] === undefined) setFrameValue(key, position[key]);
      }

      return Object.keys(frame).length ? frame : null;
    }

    _restoreWindowFrame(frame = null) {
      if (!frame || typeof this.setPosition !== "function") return;
      const position = {};
      for (const key of FRAME_KEYS) {
        const numeric = frameValue(frame[key], { requirePositive: key === "width" || key === "height" });
        if (numeric !== null) position[key] = numeric;
      }
      if (Object.keys(position).length) super.setPosition(position);
    }
  };
}
