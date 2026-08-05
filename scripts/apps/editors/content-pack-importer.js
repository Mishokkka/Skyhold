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
    id: "skyhold-native-economy-full-reset",
    label: "Полная собственная экономика Skyhold",
    description: "Чистая установка собственных ресурсов, 66 шаблонов зданий и всей торговой сети. Удаляет прежние пользовательские материалы, шаблоны и рынки; включает животных и новый кристаллический ассортимент.",
    path: "examples/content-packs/skyhold-native-economy-full-reset.json",
    icon: "fa-solid fa-arrows-rotate"
  },
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
    return {
      ...context,
      hasPlan: Boolean(this.plan),
      fileName: this.fileName,
      error: this.error,
      pack: this.plan?.pack ?? null,
      counts: this.plan?.counts ?? { add: 0, update: 0, remove: 0, skip: 0, conflict: 0 },
      changes,
      canImport: Boolean(this.plan?.hasChanges),
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
      if (target?.matches?.("[data-content-pack-file]")) this._onFileChange(event);
      else if (target?.matches?.("[data-content-pack-resolution]")) this._onResolutionChange(event);
    }, { signal: controller.signal });
    root.addEventListener("click", (event) => {
      const element = event.target?.closest?.("[data-action]");
      const action = element?.dataset?.action;
      if (action === "content-pack-import") this._onImport(event);
      else if (action === "content-pack-clear") this._onClear(event);
      else if (action === "content-pack-bundled") this._onBundledPack(event, element);
    }, { signal: controller.signal });
  }

  async _onFileChange(event) {
    if (!game.user?.isGM) return;
    const file = event.currentTarget?.files?.[0];
    if (!file) return;
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
      this._preparePlan(JSON.parse(text));
    } catch (error) {
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
    if (!game.user?.isGM) return;
    const id = String(element?.dataset?.packId ?? "");
    const pack = BUNDLED_CONTENT_PACKS.find((row) => row.id === id);
    if (!pack) return;
    this.fileName = pack.label;
    this.error = "";
    this.plan = null;
    this.resolutions = {};
    try {
      const response = await fetch(`modules/${MODULE_ID}/${pack.path}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Не удалось загрузить встроенный пакет (${response.status}).`);
      this._preparePlan(await response.json());
    } catch (error) {
      console.error("FBL Skyhold | Bundled content pack preview failed", error);
      this.error = error?.message ?? String(error);
    }
    this.requestRender({ focus: false });
  }

  _onResolutionChange(event) {
    const key = String(event.currentTarget?.dataset?.contentPackResolution ?? "");
    if (!key) return;
    this.resolutions[key] = event.currentTarget.value === "incoming" ? "incoming" : "existing";
  }

  async _onImport(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM || !this.plan) return;
    if (this.plan.pack.install.replaceMarket || this.plan.pack.install.replaceResources || this.plan.pack.install.replaceBuildings) {
      const scopes = [
        this.plan.pack.install.replaceMarket ? "рынки, государства, компании, рыночные локации и связи" : "",
        this.plan.pack.install.replaceResources ? "пользовательский каталог материалов" : "",
        this.plan.pack.install.replaceBuildings ? "пользовательский каталог шаблонов зданий" : ""
      ].filter(Boolean).join("; ");
      const message = `Этот импорт полностью очистит: ${scopes}. Затем набор будет установлен заново. Склады и поселения сохранятся. Продолжить?`;
      const DialogV2 = foundry?.applications?.api?.DialogV2;
      const confirmed = DialogV2?.confirm
        ? await DialogV2.confirm({ window: { title: "Чистая установка набора" }, content: `<p>${message}</p>`, modal: true })
        : window.confirm(message);
      if (!confirmed) return;
    }
    const operationId = makeId("content-import", 20);
    const plan = this.plan;
    const resolutions = { ...this.resolutions };
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
    }, { reason: `content-pack:${operationId}` });
    if (!result?.ok) {
      ui.notifications.warn(result?.message || "Не удалось импортировать content pack.");
      if (result?.stale) {
        const data = SkyholdData.get();
        this.plan = planContentPackImport({ data, holdingId: this.holdingId, rawPack: plan.pack });
        this.requestRender({ focus: false });
      }
      return;
    }
    ui.notifications.info(`Content pack импортирован: ${result.count} записей.`);
    this.owner?.requestRender?.();
    this.plan = null;
    this.fileName = "";
    this.resolutions = {};
    this.requestRender({ focus: false });
  }

  _onClear(event) {
    event.preventDefault();
    this.plan = null;
    this.fileName = "";
    this.error = "";
    this.resolutions = {};
    this.requestRender({ focus: false });
  }

  async _onClose(options) {
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
