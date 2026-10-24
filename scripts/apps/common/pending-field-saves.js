class PendingFieldSaveError extends Error {}

/** Wait for field saves and retain editors whose save status still records a failure. */
export function PendingFieldSavesMixin(Base) {
  return class PendingFieldSavesApplication extends Base {
    _trackFieldSave(result) {
      this._pendingFieldSaves ??= new Set();
      const pending = Promise.resolve(result).finally(() => this._pendingFieldSaves.delete(pending));
      this._pendingFieldSaves.add(pending);
      return pending;
    }

    async _preClose(options) {
      try {
        while (this._pendingFieldSaves?.size) await Promise.all([...this._pendingFieldSaves]);
      } catch (error) {
        throw new PendingFieldSaveError("Field save failed while closing", { cause: error });
      }
      if (this._saveStatus?.context.state === "error") {
        throw new PendingFieldSaveError("Unresolved field save failure prevents closing");
      }
      return super._preClose(options);
    }

    async close(options) {
      try { return await super.close(options); }
      catch (error) {
        if (!(error instanceof PendingFieldSaveError)) throw error;
        return this;
      }
    }
  };
}
