import { MODULE_ID } from "../../data/constants.js";
import { SkyholdData } from "../../data/store.js";
import { makeId } from "../../data/utils.js";
import {
  LAPUTA_MARKET_PACK_PATH,
  LAPUTA_MIGRATION_NAMESPACE,
  LAPUTA_MIGRATION_VERSION,
  LAPUTA_MARKET_PACK_VERSION,
  applyLaputaEconomyMigration,
  isCurrentLaputaMigrationMarker,
  planLaputaEconomyMigration
} from "../../workflows/economy/laputa-migration.js";
import { RenderSchedulerMixin } from "../common/render-scheduler.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const MAX_SNAPSHOT_BYTES = 25 * 1024 * 1024;
let canonicalMarketPackPromise = null;

async function loadCanonicalMarketPack() {
  if (!canonicalMarketPackPromise) {
    canonicalMarketPackPromise = fetch(`modules/${MODULE_ID}/${LAPUTA_MARKET_PACK_PATH}`, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`Не удалось загрузить встроенный рынок (${response.status}).`);
        return response.json();
      })
      .catch((error) => {
        canonicalMarketPackPromise = null;
        throw error;
      });
  }
  return canonicalMarketPackPromise;
}

async function fileBytes(file) {
  if (typeof file?.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error ?? new Error("Не удалось прочитать снимок."));
    reader.readAsArrayBuffer(file);
  });
}

async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle?.digest) throw new Error("В этой версии среды недоступна проверка SHA-256.");
  const digest = await subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function migrationMarker(data = SkyholdData.view()) {
  const laputa = (data?.holdings ?? []).find((holding) => String(holding?.id ?? "") === "laputa");
  return laputa?.gm?.migrationMetadata?.[LAPUTA_MIGRATION_NAMESPACE] ?? null;
}

function errorText(error) {
  const code = String(error?.code ?? "");
  const byCode = {
    "source-hash": "Выбран не утверждённый снимок Лапуты: контрольная сумма не совпала.",
    "source-revision": "Снимок имеет другую revision и не может быть безопасно перенесён.",
    "source-schema": "Снимок имеет другую версию схемы.",
    "source-building-map": "Состав зданий Лапуты в снимке отличается от утверждённой карты.",
    "target-market-pack": "Встроенный пакет нового рынка повреждён или имеет неожиданную версию. Миграция остановлена до записи.",
    "target-templates": "В новом каталоге отсутствует один из обязательных шаблонов зданий.",
    "target-revision": "Данные мира изменились после Preview. Предварительный расчёт обновлён.",
    "target-catalog-hash": "Каталог изменился после Preview. Предварительный расчёт обновлён.",
    "target-data-hash": "Данные мира изменились после Preview. Предварительный расчёт обновлён.",
    "already-applied": "Эта миграция уже была применена другой операцией."
  };
  return byCode[code] ?? error?.message ?? String(error);
}

async function confirmAction({ title, message }) {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (DialogV2?.confirm) {
    return DialogV2.confirm({ window: { title }, content: `<p>${message}</p>`, modal: true });
  }
  return window.confirm(message);
}

export class SkyholdLaputaMigrationImporter extends RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  constructor({ owner = null } = {}, options = {}) {
    super(options);
    this.owner = owner;
    this.plan = null;
    this.snapshot = null;
    this.sourceHash = "";
    this.canonicalMarketPack = null;
    this.fileName = "";
    this.error = "";
    this.status = "";
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const marker = migrationMarker();
    const migrationApplied = isCurrentLaputaMigrationMarker(marker);
    const expectedRollbackHash = String(marker?.target?.rollbackDataHash ?? "");
    const rollback = expectedRollbackHash
      ? SkyholdData.getRollbackSnapshotInfo({ expectedDataHash: expectedRollbackHash })
      : { ok: false, reason: "missing-marker" };
    const preview = this.plan?.preview ?? null;
    return {
      ...context,
      hasPlan: Boolean(this.plan),
      canApply: Boolean(this.plan),
      fileName: this.fileName,
      sourceHash: this.sourceHash,
      error: this.error,
      status: this.status,
      preview,
      removedHoldingIds: preview?.holdingsRemoved ?? [],
      hasRemovedHoldings: Boolean(preview?.holdingsRemoved?.length),
      markerExists: Boolean(marker),
      migrationApplied,
      migrationUpgradeAvailable: Boolean(marker) && !migrationApplied,
      migrationVersion: Number(marker?.version ?? 0) || 0,
      targetMigrationVersion: LAPUTA_MIGRATION_VERSION,
      targetMarketPackVersion: LAPUTA_MARKET_PACK_VERSION,
      migrationOperationId: String(marker?.operationId ?? ""),
      migrationCreatedAt: String(marker?.createdAt ?? ""),
      canRollback: rollback.ok === true,
      rollbackRevision: rollback.revision ?? 0,
      rollbackUnavailable: Boolean(marker) && rollback.ok !== true
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
      if (event.target?.matches?.("[data-laputa-migration-file]")) this._onFileChange(event);
    }, { signal: controller.signal });
    root.addEventListener("click", (event) => {
      const action = event.target?.closest?.("[data-action]")?.dataset?.action;
      if (action === "laputa-migration-apply") this._onApply(event);
      else if (action === "laputa-migration-clear") this._onClear(event);
      else if (action === "laputa-migration-rollback") this._onRollback(event);
    }, { signal: controller.signal });
  }

  async _onFileChange(event) {
    if (!game.user?.isGM) return;
    const file = event.target?.files?.[0];
    if (!file) return;
    this.fileName = String(file.name ?? "laputa-snapshot.json");
    this.plan = null;
    this.snapshot = null;
    this.sourceHash = "";
    this.error = "";
    this.status = "";
    try {
      if (Number(file.size) > MAX_SNAPSHOT_BYTES) throw new Error("Файл снимка больше 25 МБ.");
      const bytes = await fileBytes(file);
      const sourceHash = await sha256Hex(bytes);
      const snapshot = JSON.parse(new globalThis.TextDecoder("utf-8", { fatal: true }).decode(bytes));
      const canonicalMarketPack = await loadCanonicalMarketPack();
      this._preparePlan({ snapshot, sourceHash, canonicalMarketPack, operationId: makeId("laputa-economy-migration", 20) });
    } catch (error) {
      console.error("FBL Skyhold | Laputa migration preview failed", error);
      this.error = errorText(error);
    }
    this.requestRender({ focus: false });
  }

  _preparePlan({
    snapshot = this.snapshot,
    sourceHash = this.sourceHash,
    canonicalMarketPack = this.canonicalMarketPack,
    operationId = this.plan?.operationId
  } = {}) {
    this.snapshot = snapshot;
    this.sourceHash = String(sourceHash ?? "");
    this.canonicalMarketPack = canonicalMarketPack;
    this.plan = planLaputaEconomyMigration({
      snapshot,
      sourceHash: this.sourceHash,
      currentData: SkyholdData.get(),
      canonicalMarketPack,
      operationId: String(operationId || makeId("laputa-economy-migration", 20)),
      createdAt: new Date().toISOString()
    });
    this.error = "";
  }

  async _onApply(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM || !this.plan) return;
    const confirmed = await confirmAction({
      title: "Миграция экономики Лапуты",
      message: "Будут удалены все поселения кроме Лапуты. Старые материалы, страны, рынки, организации, локации и маршруты будут полностью заменены встроенной экономикой Воздушных Островов. Перед записью модуль сохранит точную rollback-копию текущего мира. Продолжить?"
    });
    if (!confirmed) return;

    const plan = this.plan;
    try {
      const result = await SkyholdData.transaction((data, { skip }) => {
        const applied = applyLaputaEconomyMigration({ currentData: data, plan, operationId: plan.operationId });
        if (!applied.commitRequired) return skip(applied);
        data.meta = applied.data.meta;
        data.holdings = applied.data.holdings;
        data.catalog = applied.data.catalog;
        return applied;
      }, {
        reason: `laputa-economy-migration:${plan.operationId}`,
        scope: "both",
        forceRollbackSnapshot: true
      });
      this.plan = null;
      this.snapshot = null;
      this.sourceHash = "";
      this.canonicalMarketPack = null;
      this.fileName = "";
      this.error = "";
      this.status = result?.alreadyApplied
        ? "Миграция уже была применена этой операцией. Повторной записи не было."
        : "Миграция Лапуты применена. Предыдущее состояние сохранено для точного отката.";
      ui.notifications.info(this.status);
      this.owner?.requestRender?.();
    } catch (error) {
      console.error("FBL Skyhold | Laputa migration apply failed", error);
      this.error = errorText(error);
      if (["target-revision", "target-catalog-hash", "target-data-hash"].includes(String(error?.code ?? ""))) {
        try {
          this._preparePlan({ snapshot: this.snapshot, sourceHash: this.sourceHash, operationId: plan.operationId });
        } catch (refreshError) {
          this.plan = null;
          this.error = errorText(refreshError);
        }
      }
      ui.notifications.error(this.error);
    }
    this.requestRender({ focus: false });
  }

  async _onRollback(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    const marker = migrationMarker();
    const expectedDataHash = String(marker?.target?.rollbackDataHash ?? "");
    if (!expectedDataHash) return;
    const confirmed = await confirmAction({
      title: "Откатить миграцию Лапуты",
      message: "Будет целиком восстановлено состояние мира непосредственно перед миграцией. Все изменения после миграции будут заменены; текущее состояние станет новой rollback-копией. Продолжить?"
    });
    if (!confirmed) return;
    try {
      const result = await SkyholdData.restoreRollbackSnapshot({
        expectedDataHash
      });
      if (!result?.ok) throw new Error(result?.reason === "hash-mismatch"
        ? "Rollback-копия больше не соответствует этой миграции. Откат заблокирован."
        : "Rollback-копия недоступна.");
      this.plan = null;
      this.status = `Восстановлено состояние до миграции (revision ${result.previousRevision}).`;
      this.error = "";
      ui.notifications.info(this.status);
      this.owner?.requestRender?.();
    } catch (error) {
      console.error("FBL Skyhold | Laputa migration rollback failed", error);
      this.error = errorText(error);
      ui.notifications.error(this.error);
    }
    this.requestRender({ focus: false });
  }

  _onClear(event) {
    event.preventDefault();
    this.plan = null;
    this.snapshot = null;
    this.sourceHash = "";
    this.canonicalMarketPack = null;
    this.fileName = "";
    this.error = "";
    this.status = "";
    this.requestRender({ focus: false });
  }

  async _onClose(options) {
    await super._onClose(options);
    this._delegatedAbortController?.abort?.();
    this._delegatedAbortController = null;
  }
}

SkyholdLaputaMigrationImporter.DEFAULT_OPTIONS = {
  classes: ["fbl-skyhold", "fbl-skyhold-content-pack-importer", "fbl-skyhold-laputa-migration-importer"],
  tag: "section",
  window: { title: "Миграция экономики Лапуты", icon: "fa-solid fa-shield-halved", resizable: true },
  position: { width: 760, height: 700 }
};

SkyholdLaputaMigrationImporter.PARTS = {
  body: { template: `modules/${MODULE_ID}/templates/laputa-migration-importer.hbs` }
};
