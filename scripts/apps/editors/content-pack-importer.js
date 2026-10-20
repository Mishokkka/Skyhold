import { dispatchDelegatedAction } from "../common/delegated-events.js";
import { MODULE_ID } from "../../data/constants.js";
import { SkyholdData } from "../../data/store.js";
import { applyContentPackImport, planContentPackImport } from "../../data/content-packs.js";
import { appendHoldingOperation } from "../../data/operations.js";
import { makeId } from "../../data/utils.js";
import { RenderSchedulerMixin } from "../common/render-scheduler.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const MAX_PACK_BYTES = 5 * 1024 * 1024;
const BUNDLED_CONTENT_PACKS = [
  {
    id: "air-islands-materials-markets",
    label: "Материалы и характеры рынков Воздушных Островов",
    description: "Чистый каталог 115 материалов с УРС и 16 редактируемых национальных профилей рынка 882 года.",
    path: "examples/content-packs/air-islands-materials-and-country-markets.json",
    icon: "fa-solid fa-boxes-stacked"
  },
  {
    id: "air-islands-trade-network",
    label: "Торговая сеть Воздушных Островов",
    description: "Чистая установка: материалы с УРС, 16 государств, 69 локаций и новая экономика без готовых связей.",
    path: "examples/content-packs/air-islands-trade-network-template.json",
    icon: "fa-solid fa-route"
  },
  {
    id: "companion-example",
    label: "Учебный пример content pack",
    description: "Небольшой пакет для проверки и знакомства с импортом.",
    path: "examples/content-packs/skyhold-companion-example.json",
    icon: "fa-solid fa-flask"
  }
];

function statusLabel(status = "") {
  return ({ add: "Добавить", update: "Обновить", remove: "Удалить", skip: "Пропустить", conflict: "Конфликт" })[status] ?? status;
}

export class SkyholdContentPackImporter extends RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  constructor({ holdingId = "", owner = null } = {}, options = {}) {
    super(options);
    this.holdingId = String(holdingId ?? "");
    this.owner = owner;
    this.plan = null;
    this.fileName = "";
    this.error = "";
    this.resolutions = {};
    this._previewGeneration = 0;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const changes = (this.plan?.changes ?? []).map((row) => ({
      ...row,
      statusLabel: statusLabel(row.status),
      isConflict: row.status === "conflict",
      isRetirement: row.retire === true,
      isReset: Boolean(row.resetScope),
      resolution: String(this.resolutions[row.key] ?? "existing"),
      chooseExisting: String(this.resolutions[row.key] ?? "existing") === "existing",
      chooseIncoming: String(this.resolutions[row.key] ?? "existing") === "incoming"
    }));
    const preview = this.plan ? applyContentPackImport({ data: SkyholdData.get(), plan: this.plan, resolutions: this.resolutions }) : null;
    return {
      ...context,
      hasPlan: Boolean(this.plan),
      fileName: this.fileName,
      error: this.error || (preview?.ok === false ? preview.message : ""),
      pack: this.plan?.pack ?? null,
      counts: this.plan?.counts ?? { add: 0, update: 0, remove: 0, skip: 0, conflict: 0 },
      changes,
      canImport: Boolean(this.plan?.hasChanges && preview?.ok && !this._importPromise),
      bundledPacks: BUNDLED_CONTENT_PACKS
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    this._delegatedAbortController?.abort?.();
    const controller = new AbortController();
    this._delegatedAbortController = controller;
    root.addEventListener("change", (event) => {
      const target = event.target;
      if (target?.matches?.("[data-content-pack-file]")) dispatchDelegatedAction(this, event, target, "_onFileChange");
      else if (target?.matches?.("[data-content-pack-resolution]")) dispatchDelegatedAction(this, event, target, "_onResolutionChange");
    }, { signal: controller.signal });
    root.addEventListener("click", (event) => {
      const element = event.target?.closest?.("[data-action]");
      const action = element?.dataset?.action;
      if (action === "content-pack-import") dispatchDelegatedAction(this, event, element, "_onImport");
      else if (action === "content-pack-clear") dispatchDelegatedAction(this, event, element, "_onClear");
      else if (action === "content-pack-bundled") dispatchDelegatedAction(this, event, element, (e) => this._onBundledPack(e, element));
    }, { signal: controller.signal });
  }

  async _onFileChange(event) {
    if (!game.user?.isGM || this._importPromise) return;
    const file = event.currentTarget?.files?.[0];
    if (!file) return;
    const generation = ++this._previewGeneration;
    this.fileName = String(file.name ?? "content-pack.json");
    this.error = "";
    this.plan = null;
    this.resolutions = {};
    try {
      if (Number(file.size) > MAX_PACK_BYTES) throw new Error("Файл content pack больше 5 МБ.");
      const text = typeof file.text === "function" ? await file.text() : await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(reader.error ?? new Error("Не удалось прочитать файл."));
        reader.readAsText(file, "utf-8");
      });
      if (generation !== this._previewGeneration) return;
      this._preparePlan(JSON.parse(text));
    } catch (error) {
      if (generation !== this._previewGeneration) return;
      console.error("FBL Skyhold | Content pack preview failed", error);
      this.error = error?.message ?? String(error);
    }
    this.requestRender({ focus: false });
  }

  _preparePlan(rawPack) {
    const data = SkyholdData.get();
    this.plan = planContentPackImport({ data, holdingId: this.holdingId, rawPack });
    this.holdingId = this.plan.holdingId;
    this.resolutions = {};
    for (const row of this.plan.changes) if (row.status === "conflict") this.resolutions[row.key] = "existing";
  }

  async _onBundledPack(event, element) {
    event.preventDefault();
    if (!game.user?.isGM || this._importPromise) return;
    const id = String(element?.dataset?.packId ?? "");
    const pack = BUNDLED_CONTENT_PACKS.find((row) => row.id === id);
    if (!pack) return;
    const generation = ++this._previewGeneration;
    this.fileName = pack.label;
    this.error = "";
    this.plan = null;
    this.resolutions = {};
    try {
      const response = await fetch(`modules/${MODULE_ID}/${pack.path}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Не удалось загрузить встроенный пакет (${response.status}).`);
      const raw = await response.json();
      if (generation !== this._previewGeneration) return;
      this._preparePlan(raw);
    } catch (error) {
      if (generation !== this._previewGeneration) return;
      console.error("FBL Skyhold | Bundled content pack preview failed", error);
      this.error = error?.message ?? String(error);
    }
    this.requestRender({ focus: false });
  }

  _onResolutionChange(event) {
    const key = String(event.currentTarget?.dataset?.contentPackResolution ?? "");
    if (!key) return;
    if (this._importPromise) return;
    this.resolutions[key] = event.currentTarget.value === "incoming" ? "incoming" : "existing";
    this.requestRender({ focus: false });
  }

  _onImport(event) {
    if (this._importPromise) return this._importPromise;
    this._previewGeneration += 1;
    this.error = "";
    this._importPromise = this._importOnce(event).catch((error) => {
      this.error = error?.message ?? String(error);
      ui.notifications.error(this.error);
      return false;
    }).finally(() => {
      this._importPromise = null;
      this.requestRender({ focus: false });
    });
    return this._importPromise;
  }

  async _preClose(options) {
    if (this._importPromise && await this._importPromise === false) {
      throw Object.assign(new Error("Не удалось импортировать набор; предпросмотр сохранён."), { code: "content-import-unsaved" });
    }
    return super._preClose(options);
  }

  async close(options) {
    try { return await super.close(options); }
    catch (error) {
      if (error.code !== "content-import-unsaved") throw error;
      return this;
    }
  }

  async _importOnce(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM || !this.plan) return;
    const plan = this.plan;
    const resolutions = { ...this.resolutions };
    if (plan.pack.install.replaceMarket || plan.pack.install.replaceResources) {
      const scopes = [
        plan.pack.install.replaceMarket ? "рынки, государства, компании, рыночные локации и связи" : "",
        plan.pack.install.replaceResources ? "пользовательский каталог материалов" : ""
      ].filter(Boolean).join("; ");
      const message = `Этот импорт полностью очистит: ${scopes}. Затем набор будет установлен заново. Склады и поселения сохранятся. Продолжить?`;
      const DialogV2 = foundry?.applications?.api?.DialogV2;
      const confirmed = DialogV2?.confirm
        ? await DialogV2.confirm({ window: { title: "Чистая установка набора" }, content: `<p>${message}</p>`, modal: true })
        : window.confirm(message);
      if (!confirmed) return;
    }
    const operationId = makeId("content-import", 20);
    const result = await SkyholdData.transaction((data) => {
      const applied = applyContentPackImport({ data, plan, resolutions });
      if (!applied.ok) return SkyholdData.skipTransaction(applied);
      const holding = (data?.holdings ?? []).find((row) => String(row?.id ?? "") === String(plan.holdingId ?? ""));
      if (holding) appendHoldingOperation(holding, {
        operationId,
        type: "content-import",
        createdAt: new Date().toISOString(),
        title: `Content pack: ${plan.pack.name}`,
        summary: `Импортировано записей: ${applied.count}; версия ${plan.pack.version}.`,
        payload: { packId: plan.pack.id, source: plan.pack.source, version: plan.pack.version, applied: applied.applied }
      });
      return applied;
    }, { reason: `content-pack:${operationId}`, scope: "both" });
    if (!result?.ok) {
      this.error = result?.message || "Не удалось импортировать content pack.";
      ui.notifications.warn(this.error);
      if (result?.stale) {
        const data = SkyholdData.get();
        this.plan = planContentPackImport({ data, holdingId: this.holdingId, rawPack: plan.pack });
        this.requestRender({ focus: false });
      }
      return false;
    }
    ui.notifications.info(`Content pack импортирован: ${result.count} записей.`);
    this.owner?.requestRender?.();
    this.plan = null;
    this.fileName = "";
    this.resolutions = {};
    this.requestRender({ focus: false });
    return true;
  }

  _onClear(event) {
    event.preventDefault();
    if (this._importPromise) return;
    this._previewGeneration += 1;
    this.plan = null;
    this.fileName = "";
    this.error = "";
    this.resolutions = {};
    this.requestRender({ focus: false });
  }

  async _onClose(options) {
    this._previewGeneration += 1;
    await super._onClose(options);
    this._delegatedAbortController?.abort?.();
    this._delegatedAbortController = null;
  }
}

SkyholdContentPackImporter.DEFAULT_OPTIONS = {
  classes: ["fbl-skyhold", "fbl-skyhold-content-pack-importer"],
  tag: "section",
  window: { title: "Content packs", icon: "fa-solid fa-box-open", resizable: true },
  position: { width: 820, height: 720 }
};

SkyholdContentPackImporter.PARTS = {
  body: { template: `modules/${MODULE_ID}/templates/content-pack-importer.hbs` }
};
