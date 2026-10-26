/** Keep a pending button click alive when a preceding blur saves and rerenders. */
export function HeldActionRenderMixin(Base) {
  return class HeldActionRenderApplication extends Base {
    requestRender(options = {}) {
      if (this._pressedAction) { this._deferredRenderOptions = { ...this._deferredRenderOptions, ...options }; return null; }
      return super.requestRender(options);
    }

    async _onRender(context, options) {
      await super._onRender(context, options);
      this._actionClickController?.abort();
      this._actionClickController = new AbortController();
      const signal = this._actionClickController.signal, root = this.element;
      const release = () => {
        this._pressedAction = false;
        const deferred = this._deferredRenderOptions; this._deferredRenderOptions = null;
        if (deferred) this.requestRender(deferred);
      };
      root?.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        const button = event.target.closest?.("button[data-action]");
        this._pressedAction = Boolean(button && !button.disabled);
      }, { capture: true, signal });
      for (const name of ["pointerup", "pointercancel"]) {
        root?.addEventListener(name, release, { signal });
        root?.ownerDocument?.addEventListener?.(name, release, { signal });
      }
      globalThis.window?.addEventListener?.("blur", release, { signal });
    }

    async close(options) {
      const result = await super.close(options);
      this._actionClickController?.abort();
      this._pressedAction = false; this._deferredRenderOptions = null;
      return result;
    }
  };
}
