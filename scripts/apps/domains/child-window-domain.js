import { HoldingService } from "../../data/holding-service.js";
import { escapeHtml } from "../../core/helpers.js";
import { foundryDialogV2, downloadFoundryJson } from "../../integrations/foundry-runtime.js";
import { makeId } from "../../data/utils.js";
import { getSkyholdAuthorityState } from "../../data/authority.js";
import { ensureSkyholdStylesheet } from "../lazy-styles.js";

const MAX_ECONOMY_BACKUP_BYTES = 100 * 1024 * 1024;

function stopEvent(event) {
  event.preventDefault();
  event.stopPropagation();
}

function activeHoldingId(app) {
  return String(app.activeHoldingId ?? "") || String(HoldingService.getData()?.holdings?.[0]?.id ?? "");
}

function integer(value) {
  return Math.round(Number(value) || 0).toLocaleString("ru-RU");
}

function activationSummaryHtml(plan = {}) {
  const before = plan.before ?? {};
  const after = plan.after ?? {};
  return `<div class="fbls-dialog-text">
    <p><strong>Economy V2 обновит ресурсный контракт, двусторонний рынок и только безопасно распознанные, ещё не начатые рецепты зданий. Запасы, долги, проекты и snapshot уже отправленных заказов не меняются.</strong></p>
    <table class="fbls-table compact"><thead><tr><th>Показатель</th><th>До</th><th>После</th></tr></thead><tbody>
      <tr><td>Версия экономики</td><td>${integer(before.economyVersion)}</td><td>${integer(after.economyVersion)}</td></tr>
      <tr><td>Версия активации</td><td>${integer(before.activationVersion)}</td><td>${integer(after.activationVersion)}</td></tr>
      <tr><td>Legacy-ресурсы</td><td>${integer(before.legacyResources)}</td><td>${integer(after.legacyResources)}</td></tr>
      <tr><td>Торгуемые ресурсы / сумма опорных цен</td><td>${integer(before.tradableResources)} / ${integer(before.catalogReferencePriceCopper)} мед.</td><td>${integer(after.tradableResources)} / ${integer(after.catalogReferencePriceCopper)} мед.</td></tr>
      <tr><td>Legacy-рецепты зданий</td><td>${integer(before.legacyBuildingRecipes)}</td><td>${integer(after.legacyBuildingRecipes)}</td></tr>
      <tr><td>Изменённые GM-рецепты</td><td>${integer(before.customizedBuildingRecipes)}</td><td>${integer(after.customizedBuildingRecipes)}</td></tr>
      <tr><td>Единицы запасов</td><td>${escapeHtml(String(before.stockUnits ?? 0))}</td><td>${escapeHtml(String(after.stockUnits ?? 0))}</td></tr>
      <tr><td>Активные доставки</td><td>${integer(before.activeOrders)}</td><td>${integer(after.activeOrders)}</td></tr>
      <tr><td>Экспорт в броне / пути</td><td>${integer(before.activeExports)}</td><td>${integer(after.activeExports)}</td></tr>
      <tr><td>Остаток ask / спрос bid</td><td>${integer(before.marketAskStock)} / ${integer(before.marketBidDemand)}</td><td>${integer(after.marketAskStock)} / ${integer(after.marketBidDemand)}</td></tr>
      <tr><td>Производственные линии / проекты</td><td>${integer(before.productionLines)} / ${integer(before.activeProjects)}</td><td>${integer(after.productionLines)} / ${integer(after.activeProjects)}</td></tr>
      <tr><td>Зарплатные счета / долг</td><td>${integer(before.payrollAccounts)} / ${integer(before.payrollArrearsCopper)} мед.</td><td>${integer(after.payrollAccounts)} / ${integer(after.payrollArrearsCopper)} мед.</td></tr>
      <tr><td>Касса / резерв флота</td><td>${integer(before.fleetCashCopper)} / ${integer(before.fleetReserveCopper)} мед.</td><td>${integer(after.fleetCashCopper)} / ${integer(after.fleetReserveCopper)} мед.</td></tr>
      <tr><td>Здания / жители</td><td>${integer(before.buildings)} / ${integer(before.residents)}</td><td>${integer(after.buildings)} / ${integer(after.residents)}</td></tr>
    </tbody></table>
    <p>Ресурсных строк: <strong>${integer(plan.changes?.length)}</strong>. Операций с рецептами: <strong>${integer(plan.buildingRecipeChanges?.length)}</strong> (замена только точного старого fingerprint; начатые и оплаченные проекты получают исторический snapshot без смены цены).</p>
    <p>На следующем шаге автоматически скачается полная JSON-копия мира Skyhold.</p>
  </div>`;
}

function backupRestoreSummaryHtml(plan = {}, fileName = "backup.json") {
  const summary = plan.summary ?? {};
  return `<div class="fbls-dialog-text">
    <p><strong>Будет восстановлена полная логическая копия Skyhold из файла ${escapeHtml(fileName)}.</strong></p>
    <table class="fbls-table compact"><tbody>
      <tr><th>Revision текущего мира</th><td>${integer(summary.currentRevision)}</td></tr>
      <tr><th>Revision backup</th><td>${integer(summary.sourceRevision)}</td></tr>
      <tr><th>Владения</th><td>${integer(summary.holdings)}</td></tr>
      <tr><th>Ресурсы каталога</th><td>${integer(summary.resources)}</td></tr>
      <tr><th>Здания / жители</th><td>${integer(summary.buildings)} / ${integer(summary.residents)}</td></tr>
      <tr><th>Создан</th><td>${escapeHtml(String(plan.createdAt ?? "—"))}</td></tr>
    </tbody></table>
    <p>Контрольные суммы файла и полного payload, внутренний source revision и состояние мира на момент предпросмотра проверены. Продолжение ещё не изменяет данные.</p>
  </div>`;
}

async function readJsonFile(file) {
  if (Number(file?.size) > MAX_ECONOMY_BACKUP_BYTES) throw new Error("Backup-файл больше 100 МБ.");
  if (typeof file?.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Не удалось прочитать backup-файл."));
    reader.readAsText(file, "utf-8");
  });
}

async function chooseLegacyResourceResolution(change = {}) {
  const row = change.after ?? change.before ?? {};
  const content = `<div class="fbls-dialog-text">
    <p><strong>${escapeHtml(String(row.label ?? row.id ?? "Ресурс"))}</strong> не совпадает с неизменённой встроенной строкой V1.</p>
    <p>Рассчитано: цена ${integer(row.referencePriceCopper)} медн.; груз ${integer(row.cargoPoints)}; рационов ${integer(row.rationPoints)}.</p>
    <p>Выбери: подтвердить расчёт или оставить ресурс неторговым до ручной настройки.</p>
  </div>`;
  return foundryDialogV2().wait({
    window: { title: "Economy V2: решение по ресурсу" },
    content,
    modal: true,
    buttons: [
      { action: "accept-inferred", label: "Принять расчёт", icon: "fa-solid fa-check", default: true, callback: () => "accept-inferred" },
      { action: "non-tradable", label: "Отключить торговлю", icon: "fa-solid fa-ban", callback: () => "non-tradable" },
      { action: "cancel", label: "Отмена", icon: "fa-solid fa-xmark", callback: () => "" }
    ],
    close: () => ""
  });
}

async function showActivationBlockers(blockers = []) {
  const items = blockers.map((row) => `<li>${escapeHtml(String(row.message ?? row.code ?? "Неизвестная ошибка"))}</li>`).join("");
  return foundryDialogV2().wait({
    window: { title: "Economy V2: активация заблокирована" },
    content: `<div class="fbls-dialog-text"><p>Исправь ошибки каталога и повтори активацию:</p><ul>${items}</ul></div>`,
    buttons: [{ action: "close", label: "Закрыть", default: true }]
  });
}

export const ChildWindowDomain = {
async _onOpenBuildingTemplateBrowser(event) {
  stopEvent(event);
  const holdingId = activeHoldingId(this);
  if (!holdingId) return;
  await ensureSkyholdStylesheet("templateBrowser");
  const { SkyholdBuildingTemplateBrowser } = await import("../editors/template-browser.js");
  new SkyholdBuildingTemplateBrowser({ holdingId }).render({ force: true, focus: true });
},

async _onOpenMassCombatTagEditor(event) {
  stopEvent(event);
  if (!game.user?.isGM) return;
  await ensureSkyholdStylesheet("secondary");
  const { SkyholdMassCombatTagEditor } = await import("../editors/mass-combat-tag-editor.js");
  new SkyholdMassCombatTagEditor().render({ force: true, focus: true });
},

async _onOpenRandomEventEditor(event) {
  stopEvent(event);
  if (!game.user?.isGM) return;
  const holdingId = activeHoldingId(this);
  if (!holdingId) return;
  await ensureSkyholdStylesheet("secondary");
  const { SkyholdRandomEventEditor } = await import("../editors/random-event-editor.js");
  new SkyholdRandomEventEditor({ holdingId }).render({ force: true, focus: true });
},

async _onOpenRegionCatalogEditor(event) {
  stopEvent(event);
  if (!game.user?.isGM) return;
  await ensureSkyholdStylesheet("secondary");
  const { SkyholdRegionCatalogEditor } = await import("../editors/region-catalog-editor.js");
  new SkyholdRegionCatalogEditor({ owner: this }).render({ force: true, focus: true });
},

async _onOpenResourceCatalogEditor(event) {
  stopEvent(event);
  if (!game.user?.isGM) return;
  await ensureSkyholdStylesheet("secondary");
  const { SkyholdResourceCatalogEditor } = await import("../editors/resource-catalog-editor.js");
  SkyholdResourceCatalogEditor.open();
},

async _onOpenMarketCatalogEditor(event) {
  stopEvent(event);
  if (!game.user?.isGM) return;
  await ensureSkyholdStylesheet("secondary");
  const { SkyholdMarketCatalogEditor } = await import("../editors/market-catalog-editor.js");
  SkyholdMarketCatalogEditor.open();
},

async _onOpenContentPackImporter(event) {
  stopEvent(event);
  if (!game.user?.isGM) return;
  const holdingId = activeHoldingId(this);
  if (!holdingId) return;
  await ensureSkyholdStylesheet("secondary");
  const { SkyholdContentPackImporter } = await import("../editors/content-pack-importer.js");
  new SkyholdContentPackImporter({ holdingId, owner: this }).render({ force: true, focus: true });
},

async _onActivateEconomyV2(event) {
  stopEvent(event);
  if (!game.user?.isGM || !getSkyholdAuthorityState().isAuthorityGm) return;
  const [{ previewEconomyV2Activation, executeEconomyV2ActivationCommand }, backupApi] = await Promise.all([
    import("../../data/economy-v2-activation-command.js"),
    import("../../data/economy-v2-backup.js")
  ]);
  const operationId = makeId("economy-v2", 20);
  const now = new Date().toISOString();
  const resolutions = {};
  let preview = previewEconomyV2Activation({ operationId, resolutions, now });
  if (!preview.ok) {
    ui.notifications?.error?.(preview.message || "Не удалось подготовить Economy V2.");
    return;
  }

  for (const blocker of preview.plan.blockers.filter((row) => row.code === "resource-resolution")) {
    const change = preview.plan.changes.find((row) => String(row.id) === String(blocker.resourceId));
    const resolution = await chooseLegacyResourceResolution(change);
    if (!resolution) return;
    resolutions[String(blocker.resourceId)] = resolution;
  }
  preview = previewEconomyV2Activation({ operationId, resolutions, now });
  if (!preview.plan.canApply) {
    await showActivationBlockers(preview.plan.blockers);
    return;
  }

  const firstConfirmation = await foundryDialogV2().confirm({
    window: { title: "Economy V2: предпросмотр" },
    content: activationSummaryHtml(preview.plan),
    modal: true
  });
  if (!firstConfirmation) return;

  let backup = backupApi.createEconomyV2Backup(HoldingService.getData(), { now });
  try {
    downloadFoundryJson(backup.json, backup.receipt.fileName);
    backup = backupApi.markEconomyV2BackupDownloadInitiated(backup);
  } catch (error) {
    console.error("FBL Skyhold | Economy V2 backup download failed", error);
    ui.notifications?.error?.("Активация отменена: JSON-копию не удалось скачать.");
    return;
  }

  const secondConfirmation = await foundryDialogV2().confirm({
    window: { title: "Economy V2: окончательное подтверждение" },
    content: `<div class="fbls-dialog-text"><p>Браузеру передана команда скачать <strong>${escapeHtml(backup.receipt.fileName)}</strong>.</p><p><strong>Модуль не может доказать, что браузер действительно сохранил файл: проверь загрузки самостоятельно.</strong> Новые партии ресурсов станут целочисленными. Точные старые калибровки неначатых зданий вернутся к исходным рецептам; начатые, оплаченные и изменённые GM проекты сохранят свои условия.</p></div>`,
    modal: true
  });
  if (!secondConfirmation) return;

  const result = await executeEconomyV2ActivationCommand({ plan: preview.plan, backup });
  if (!result.ok) {
    ui.notifications?.error?.(result.message || "Economy V2 не активирована.");
    return;
  }
  ui.notifications?.info?.(result.replay ? "Economy V2 уже была активирована этой операцией." : "Economy V2 активирована. Запасы, активные доставки и условия начатых проектов сохранены.");
  this.requestRender?.();
},

async _onEconomyV2BackupFileChange(event) {
  if (!game.user?.isGM || !getSkyholdAuthorityState().isAuthorityGm) return;
  const input = event.currentTarget;
  const file = input?.files?.[0];
  if (!file) return;
  const operationId = makeId("economy-v2-restore", 20);
  try {
    const rawBackup = await readJsonFile(file);
    const { previewEconomyV2BackupRestoreCommand, executeEconomyV2BackupRestoreCommand } = await import("../../data/economy-v2-backup-restore-command.js");
    const preview = previewEconomyV2BackupRestoreCommand({ rawBackup, operationId });
    if (!preview.ok) {
      ui.notifications?.error?.(preview.message || "Backup не прошёл проверку.");
      return;
    }
    const previewConfirmed = await foundryDialogV2().confirm({
      window: { title: "Economy V2 backup: предпросмотр восстановления" },
      content: backupRestoreSummaryHtml(preview.plan, String(file.name ?? "backup.json")),
      modal: true
    });
    if (!previewConfirmed) return;
    const finalConfirmed = await foundryDialogV2().confirm({
      window: { title: "Economy V2 backup: окончательное подтверждение" },
      content: `<div class="fbls-dialog-text"><p><strong>Восстановить полную копию revision ${integer(preview.plan.sourceRevision)}?</strong></p><p>Текущие holdings, catalog и meta будут заменены содержимым проверенного файла одной транзакцией. Изменения, сделанные после backup, исчезнут.</p></div>`,
      modal: true
    });
    if (!finalConfirmed) return;
    const result = await executeEconomyV2BackupRestoreCommand({ plan: preview.plan, rawBackup, confirmed: true });
    if (!result.ok) {
      ui.notifications?.error?.(result.message || "Не удалось восстановить backup.");
      return;
    }
    ui.notifications?.info?.(result.replay ? "Эта полная копия уже соответствует текущим данным." : "Полная копия Economy V2 восстановлена.");
    this.requestRender?.();
  } catch (error) {
    console.error("FBL Skyhold | Economy V2 backup restore preview failed", error);
    ui.notifications?.error?.(error?.message || "Не удалось прочитать backup-файл.");
  } finally {
    if (input) input.value = "";
  }
}
};
