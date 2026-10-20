import { MODULE_ID } from "../../data/constants.js";
import { SkyholdData } from "../../data/store.js";
import { makeId } from "../../data/utils.js";
import {
  BUILDING_CATALOG_MIGRATION_VERSION,
  applyBuildingCatalogMigration,
  planBuildingCatalogMigration
} from "../../workflows/buildings/catalog-migration.js";
import { RenderSchedulerMixin } from "../common/render-scheduler.js";
import { FloatingTooltipsMixin } from "../common/floating-tooltip.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function errorText(error) {
  const byCode = {
    "plan-blocked": "Preview содержит нерешённые состояния. Исправьте перечисленные пункты и обновите расчёт.",
    "target-revision": "Данные мира изменились после Preview. Расчёт обновлён без записи.",
    "target-catalog-hash": "Каталог изменился после Preview. Расчёт обновлён без записи.",
    "target-holdings-hash": "Поселения изменились после Preview. Расчёт обновлён без записи.",
    "operation-mismatch": "Идентификатор операции не совпадает с Preview."
  };
  return byCode[String(error?.code ?? "")] ?? error?.message ?? String(error);
}

async function confirmApply() {
  const message = "Всё дерево шаблонов будет заменено утверждённым каталогом. Связанные постройки получат новые характеристики. Жители, казна, имущество, названия и состояния построек сохранятся. Старое общее обслуживание будет снято, его QD освободятся для назначения конкретным зданиям. Перед записью будет создана rollback-копия. Продолжить?";
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (DialogV2?.confirm) {
    return DialogV2.confirm({
      window: { title: "Применить миграцию зданий" },
      content: `<p>${message}</p>`,
      modal: true
    });
  }
  return window.confirm(message);
}

export class SkyholdBuildingCatalogMigration extends FloatingTooltipsMixin(RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2))) {
  constructor({ owner = null } = {}, options = {}) {
    super(options);
    this.owner = owner;
    this.plan = null;
    this.error = "";
    this.status = "";
    this._preparePlan();
    this._dataHookId = globalThis.Hooks?.on?.("fblSkyholdDataChanged", () => this._onDataChanged());
  }

  _preparePlan({ operationId = this.plan?.operationId || makeId("building-catalog-migration", 20) } = {}) {
    this.plan = planBuildingCatalogMigration({
      currentData: SkyholdData.get(),
      replaceCatalog: true,
      operationId,
      createdAt: new Date().toISOString()
    });
    this.error = "";
    this._previewDirty = false;
    return this.plan;
  }

  _onDataChanged() {
    this._previewDirty = true;
    if (this.rendered) this.requestRender({ focus: false });
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    if (this._previewDirty) {
      try {
        this._preparePlan({ operationId: makeId("building-catalog-migration", 20) });
      } catch (error) {
        this.plan = null;
        this.error = errorText(error);
      }
    }
    const plan = this.plan;
    const preview = plan?.preview ?? {};
    const issueRows = (plan?.blockingIssues ?? []).slice(0, 80).map((row) => ({
      ...row,
      label: `${row.buildingName || row.buildingId || "Здание"}: ${row.detail || row.code}`
    }));
    const changedRows = (plan?.rows ?? []).filter((row) => row.changed).slice(0, 80).map((row) => ({
      ...row,
      mapping: row.sourceTemplateId && row.sourceTemplateId !== row.targetTemplateId
        ? `${row.sourceTemplateId} → ${row.targetTemplateId}`
        : row.targetTemplateId,
      modeLabel: row.mode === "alias" ? "прямой alias"
        : row.mode === "known-instance" ? "известный старый экземпляр"
          : "тот же templateId"
    }));
    return {
      ...context,
      preview,
      error: this.error,
      status: this.status,
      canApply: game.user?.isGM === true && plan?.canApply === true,
      hasChanges: plan?.hasChanges === true,
      noChanges: plan?.hasChanges === false,
      hasIssues: issueRows.length > 0,
      issueRows,
      decisions: plan?.decisions ?? [],
      issuesTruncated: (plan?.blockingIssues?.length ?? 0) > issueRows.length,
      changedRows,
      rowsTruncated: (plan?.rows?.filter((row) => row.changed).length ?? 0) > changedRows.length,
      operationId: String(plan?.operationId ?? ""),
      targetVersion: plan?.target?.templateCatalogVersion ?? BUILDING_CATALOG_MIGRATION_VERSION,
      canResolve: game.user?.isGM === true
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    this._delegatedAbortController?.abort?.();
    const controller = new AbortController();
    this._delegatedAbortController = controller;
    root.addEventListener("click", (event) => {
      const action = event.target?.closest?.("[data-action]")?.dataset?.action;
      if (action === "building-catalog-migration-refresh") this._onRefresh(event);
      else if (action === "building-catalog-migration-apply") this._onApply(event);
    }, { signal: controller.signal });
  }

  _onRefresh(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    try {
      this._preparePlan({ operationId: makeId("building-catalog-migration", 20) });
      this.status = "Preview обновлён. Записи в мир не было.";
    } catch (error) {
      console.error("FBL Skyhold | Building catalog migration preview failed", error);
      this.plan = null;
      this.error = errorText(error);
    }
    this.requestRender({ focus: false });
  }

  async _onApply(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM || this._previewDirty || !this.plan?.canApply) return;
    // Confirm this exact preview; changes while the dialog is open must fail the
    // transaction's revision/hash checks, never silently apply a newer preview.
    const plan = this.plan;
    if (!await confirmApply()) return;
    try {
      const result = await SkyholdData.transaction((data, { skip }) => {
        const applied = applyBuildingCatalogMigration({ currentData: data, plan, operationId: plan.operationId });
        if (!applied.commitRequired) return skip(applied);
        data.meta = applied.data.meta;
        data.holdings = applied.data.holdings;
        data.catalog = applied.data.catalog;
        return applied;
      }, {
        reason: `building-catalog-migration:${plan.operationId}`,
        scope: "both",
        forceRollbackSnapshot: true
      });
      this.status = result?.alreadyApplied
        ? "Эта операция уже была применена; повторной записи не было."
        : `Каталог и ${result?.preview?.changedInstances ?? 0} экземпляров переведены на версию ${BUILDING_CATALOG_MIGRATION_VERSION}.`;
      ui.notifications.info(this.status);
      this._preparePlan({ operationId: makeId("building-catalog-migration", 20) });
      this.status = result?.alreadyApplied
        ? "Эта операция уже была применена; повторной записи не было."
        : `Миграция версии ${BUILDING_CATALOG_MIGRATION_VERSION} применена. Предыдущее состояние сохранено для отката.`;
      this.owner?.requestRender?.();
    } catch (error) {
      console.error("FBL Skyhold | Building catalog migration apply failed", error);
      this.error = errorText(error);
      if (["target-revision", "target-catalog-hash", "target-holdings-hash"].includes(String(error?.code ?? ""))) {
        try {
          this._preparePlan({ operationId: plan.operationId });
          this.error = errorText(error);
        } catch (refreshError) {
          this.plan = null;
          this.error = errorText(refreshError);
        }
      }
      ui.notifications.error(this.error);
    }
    this.requestRender({ focus: false });
  }

  async _onClose(options) {
    await super._onClose(options);
    this._delegatedAbortController?.abort?.();
    this._delegatedAbortController = null;
    if (this._dataHookId !== undefined && this._dataHookId !== null) globalThis.Hooks?.off?.("fblSkyholdDataChanged", this._dataHookId);
    this._dataHookId = null;
  }
}

SkyholdBuildingCatalogMigration.DEFAULT_OPTIONS = {
  classes: ["fbl-skyhold", "fbl-skyhold-content-pack-importer", "fbl-skyhold-building-catalog-migration"],
  tag: "section",
  window: { title: "Миграция каталога зданий", icon: "fa-solid fa-building-circle-check", resizable: true },
  position: { width: 780, height: 720 }
};

SkyholdBuildingCatalogMigration.PARTS = {
  body: { template: `modules/${MODULE_ID}/templates/building-catalog-migration.hbs` }
};
