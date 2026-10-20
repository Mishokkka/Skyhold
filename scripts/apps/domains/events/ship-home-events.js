import { SkyholdData } from "../../../data/store.js";
import { escapeHtml } from "../../../core/helpers.js";
import { foundryDialogV2 } from "../../../integrations/foundry-runtime.js";
import { requestSkyholdAppRender } from "../../registry.js";
import { previewShipHomePlacement, applyShipHomePlacement } from "../ship-home-location.js";

export async function placeShipHome(app, event) {
  event.preventDefault();
  if (!globalThis.game?.user?.isGM || app._placingShipHome) return;
  app._placingShipHome = true;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const root = app.element;
    const revision = Number(root.querySelector("[data-ship-card]")?.dataset.shipRevision);
    const route = root.querySelector("[data-ship-home-route]")?.value;
    const percent = root.querySelector("[data-ship-home-percent]")?.value;
    const data = SkyholdData.view();
    if (!Number.isSafeInteger(revision) || revision !== Number(data.meta?.revision)) throw new Error("Данные изменились. Обновите окно перед размещением.");
    const holding = data.holdings.find((row) => row.id === app.holdingId);
    if (!holding) throw new Error("Владение больше не найдено.");
    const preview = previewShipHomePlacement(data, holding, route, percent);
    if (!await foundryDialogV2().confirm({ window: { title: "Домашняя точка на карте" }, modal: true,
      content: `<p>${escapeHtml(holding.name)}: ${escapeHtml(preview.route.from.label)} ← ${preview.fromKm} км · дом · ${preview.toKm} км → ${escapeHtml(preview.route.to.label)}.</p><p>Будет сохранена отдельная локация без рынка. Она станет регионом поселения и домашней точкой всех его кораблей. Существующая торговая связь останется.</p><p>Свободные предложения будут сброшены. При переносе прежние связи домашней точки заменятся двумя показанными. Принятые договоры и история сохранятся.</p>`
    })) return;
    await SkyholdData.transaction((draft) => {
      if (!globalThis.game?.user?.isGM) throw new Error("Размещение доступно только ГМ.");
      if (Number(draft.meta?.revision) !== revision) throw new Error("Данные изменились после просмотра. Проверьте положение заново.");
      const current = draft.holdings.find((row) => row.id === app.holdingId);
      if (!current) throw new Error("Владение больше не найдено.");
      applyShipHomePlacement(draft, current, route, percent);
      return true;
    }, { reason: "ship-home:place", scope: "both" });
    app._shipPlanner.clear();
    requestSkyholdAppRender();
  } catch (error) {
    globalThis.ui?.notifications?.error?.(error.message || "Не удалось разместить домашнюю точку.");
  } finally {
    app._placingShipHome = false;
    button.disabled = false;
    app.requestRender({ focus: false });
  }
}
