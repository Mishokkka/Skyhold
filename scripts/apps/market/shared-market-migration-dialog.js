import { SkyholdData } from "../../data/store.js";
import { previewSharedMarketMigration, applySharedMarketMigration } from "../../data/market/shared-migration.js";
import { escapeHtml } from "../../core/helpers.js";
import { foundryDialogV2 } from "../../integrations/foundry-runtime.js";
import { requestSkyholdAppRender } from "../registry.js";
import { rerenderLoadedSkyholdApps } from "../lazy-apps.js";

/** GM-only preview; the existing world migration still requires explicit confirmation. */
export async function showSharedMarketMigration() {
  if (!globalThis.game?.user?.isGM) return;
  const preview = previewSharedMarketMigration(SkyholdData.view());
  if (preview.active) return ui.notifications?.info?.("Единые остатки и спрос уже действуют для всех поселений.");
  const notices = [...(preview.warnings ?? []), ...(preview.blockers ?? [])].map((row) => `<p>${escapeHtml(row)}</p>`).join("");
  const content = `<p>Объединить внешние рынки всех поселений: ${preview.stockCount} остатков, ${preview.demandCount} записей спроса.</p><p>Существующие поставки и брони сохранятся. Запасы будут восстанавливаться по общему игровому времени, без повторного восстановления при проведении второго поселения. Раздельные записи сохранятся как исторические данные и перестанут использоваться.</p>${notices}`;
  if (!preview.ok) return foundryDialogV2().prompt({ window: { title: "Единые рынки: переход пока невозможен" }, content, modal: true });
  const confirmed = await foundryDialogV2().confirm({ window: { title: "Единые рынки: применить переход" }, content, modal: true });
  if (!confirmed) return;
  await SkyholdData.transaction((data) => applySharedMarketMigration(data, preview.sourceToken),
    { reason: "shared-market-migration", scope: "holdings", forceRollbackSnapshot: true });
  requestSkyholdAppRender();
  rerenderLoadedSkyholdApps();
}
