const LABELS = Object.freeze({ saved: "Сохранено", dirty: "Есть изменения", saving: "Сохраняется…", error: "Ошибка сохранения" });

export function saveStatusContext(mode, state) {
  const prefix = mode === "auto" ? "Авто" : "По кнопке";
  const help = mode === "auto" ? "Автосохранение после завершения правки поля." : "Изменения сохраняются кнопкой «Сохранить».";
  const detail = state === "error" ? "Изменение не сохранено. Повторите правку или сохранение; подробности в уведомлении."
    : state === "dirty" ? "В окне есть изменения, ещё не подтверждённые сохранением."
    : state === "saving" ? "Ожидается подтверждение сохранения."
    : "Текущие изменения подтверждены сохранением.";
  return { state, label: `${prefix} · ${LABELS[state]}`, tooltip: `${help} ${detail}` };
}

/** View state only: persistence, permissions and retries remain with the editor. */
export class SaveStatus {
  constructor({ mode = "auto", onChange = () => {} } = {}) {
    this.mode = mode;
    this.onChange = onChange;
    this.revision = 0;
    this.dirty = new Map();
    this.failed = new Map();
    this.latest = new Map();
    this.pending = new Set();
  }

  get context() {
    const state = this.pending.size ? "saving" : this.failed.size ? "error" : this.dirty.size ? "dirty" : "saved";
    return saveStatusContext(this.mode, state);
  }

  markDirty(key = "draft") {
    this.dirty.set(key, ++this.revision);
    this.onChange();
  }

  async track(operation, { key = "draft" } = {}) {
    if (!this.dirty.has(key)) this.markDirty(key);
    const revision = this.dirty.get(key);
    const attempt = {};
    this.latest.set(key, attempt);
    this.pending.add(attempt);
    this.onChange();
    try {
      const result = await operation();
      if (this.latest.get(key) === attempt) {
        if (result) {
          this.failed.delete(key);
          if (this.dirty.get(key) === revision) this.dirty.delete(key);
        } else this.failed.set(key, true);
      }
      return result;
    } catch (error) {
      if (this.latest.get(key) === attempt) this.failed.set(key, true);
      throw error;
    } finally {
      this.pending.delete(attempt);
      if (this.latest.get(key) === attempt) this.latest.delete(key);
      this.onChange();
    }
  }
}

export function syncSaveStatus(root, status) {
  const context = status.context;
  for (const chip of root?.querySelectorAll?.("[data-save-status]") ?? []) {
    chip.dataset.saveState = context.state;
    chip.dataset.fblsTooltip = context.tooltip;
    chip.setAttribute("aria-label", context.label);
    if (chip.textContent !== context.label) chip.textContent = context.label;
  }
  for (const button of root?.querySelectorAll?.("[data-save-trigger]") ?? []) button.disabled = context.state === "saving";
}
