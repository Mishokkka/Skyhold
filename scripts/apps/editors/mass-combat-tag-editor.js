import { MODULE_ID } from "../../data/store.js";
import {
  addMassCombatCustomTag,
  prepareMassCombatTagEditorContext,
  resetMassCombatTagConfig,
  saveMassCombatTagConfigFromForm
} from "../mass-combat/tag-config.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class SkyholdMassCombatTagEditor extends HandlebarsApplicationMixin(ApplicationV2) {
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    return {
      ...context,
      canEdit: Boolean(game.user?.isGM),
      editor: prepareMassCombatTagEditorContext()
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    this._bindDelegatedEvents(root);
  }

  _bindDelegatedEvents(root) {
    this._delegatedAbortController?.abort?.();
    const controller = new AbortController();
    this._delegatedAbortController = controller;
    const actions = {
      "save-mass-tags": "_onSave",
      "add-mass-tag": "_onAddTag",
      "reset-mass-tags": "_onReset"
    };
    root.addEventListener("click", (event) => {
      const element = event.target?.closest?.("[data-action]");
      if (!element || !root.contains(element)) return;
      const handler = this?.[actions[String(element.dataset.action ?? "")]];
      if (typeof handler === "function") handler.call(this, this._delegatedEvent(event, element));
    }, { signal: controller.signal });
  }

  _delegatedEvent(event, currentTarget) {
    return new Proxy(event, {
      get(target, prop) {
        if (prop === "currentTarget" || prop === "delegateTarget") return currentTarget;
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  }

  async _onClose(options) {
    await super._onClose(options);
    this._delegatedAbortController?.abort?.();
    this._delegatedAbortController = null;
  }

  async _onSave(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    try {
      await saveMassCombatTagConfigFromForm(this.element);
      ui.notifications?.info?.("Матрица контров сохранена.");
      this.render({ force: true, focus: false });
    } catch (error) {
      console.error("FBL Skyhold | Failed to save mass combat tag config", error);
      ui.notifications?.error?.("Не удалось сохранить матрицу контров. Подробности в консоли.");
    }
  }

  async _onAddTag(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    await addMassCombatCustomTag();
    this.render({ force: true, focus: false });
  }

  async _onReset(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    const confirmed = await this._confirmReset();
    if (!confirmed) return;
    await resetMassCombatTagConfig();
    ui.notifications?.info?.("Матрица контров сброшена к дефолту.");
    this.render({ force: true, focus: false });
  }

  async _confirmReset() {
    const content = "<p>Сбросить теги и контры боя к дефолтной матрице модуля?</p>";
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (DialogV2?.confirm) {
      try {
        return await DialogV2.confirm({
          window: { title: "Сбросить матрицу контров" },
          content,
          modal: true
        });
      } catch (_error) {
        return false;
      }
    }
    return Boolean(globalThis.window?.confirm?.("Сбросить теги и контры боя к дефолту?"));
  }
}

SkyholdMassCombatTagEditor.DEFAULT_OPTIONS = {
  classes: ["fbl-skyhold", "fbl-skyhold-mass-tag-editor"],
  tag: "section",
  window: {
    title: "Теги и контры боя",
    icon: "fa-solid fa-circle-nodes",
    resizable: true
  },
  position: {
    width: 1060,
    height: 720
  }
};

SkyholdMassCombatTagEditor.PARTS = {
  body: {
    template: `modules/${MODULE_ID}/templates/mass-combat-tag-editor.hbs`
  }
};
