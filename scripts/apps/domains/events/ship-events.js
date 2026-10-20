import { SkyholdData, requestShipOperation } from "../../../data/store.js";
import { makeId } from "../../../data/utils.js";
import { holdingPermissionContext } from "../../../data/holding-permissions.js";
import { foundryDialogV2 } from "../../../integrations/foundry-runtime.js";
import { escapeHtml } from "../../../core/helpers.js";
import { openShipWindow } from "../../lazy-apps.js";
import { buildShipWorldContext, quoteWorldShipBundle, quoteWorldShipRelocation, repriceWorldShipOffer } from "../../../engines/ships/world-market.js";
import { formatShipGold, parseShipGoldInput } from "../../../core/ship-gold.js";

export function shipOperationIntent({ type, holding, ship = null, card = null, button }) {
  const shipId = String(ship?.id ?? "");
  const offerNode = button.closest("[data-ship-offer]");
  const scope = offerNode ?? button.closest("[data-ship-manual]") ?? card;
  const number = (selector) => parseShipGoldInput(scope?.querySelector(selector)?.value ?? "0");
  if (type === "generate") return { type, holdingId: holding.id };
  if (type === "create-profile") return {
    type, holdingId: holding.id,
    profileId: String(button.dataset.shipProfile ?? "merchant-barque"),
    shipName: String(button.dataset.shipName ?? "").trim()
  };
  if (type === "adopt") return {
    type, holdingId: holding.id, shipId,
    profileId: String(button.dataset.shipProfile ?? "merchant-barque")
  };
  if (["install-magnifique-crew", "delete"].includes(type)) return { type, holdingId: holding.id, shipId };
  if (type === "crew") {
    const controls = [...(card?.querySelectorAll?.("[data-ship-crew]") ?? [])];
    const crewResidentIds = controls.length === 1 && controls[0]?.multiple
      ? [...(controls[0].selectedOptions ?? [])].map((option) => String(option.value))
      : controls.filter((control) => control.checked && !control.disabled).map((control) => String(control.value));
    return { type, holdingId: holding.id, shipId, crewResidentIds };
  }
  if (["generate-world", "reroll-world"].includes(type)) return {
    type, holdingId: holding.id, shipId,
    locationKind: String(ship?.location?.kind ?? ""), locationId: String(ship?.location?.id ?? "")
  };
  if (type === "return-home") return {
    type, holdingId: holding.id, shipId,
    locationKind: String(ship?.location?.kind ?? ""), locationId: String(ship?.location?.id ?? "")
  };
  if (type === "relocate-world") return {
    type, holdingId: holding.id, shipId,
    destinationId: String(card?.querySelector("[data-ship-relocation-port]")?.value ?? ""),
    locationKind: String(ship?.location?.kind ?? ""), locationId: String(ship?.location?.id ?? "")
  };
  if (type === "depart-world" && button?.dataset?.shipPlanned !== undefined) {
    const selected = [...(card?.querySelectorAll("[data-ship-bundle-select]:checked") ?? [])];
    if (selected.length !== 1) throw new Error("Для одиночного рейса выберите один заказ.");
    const value = String(card?.querySelector("[data-ship-bundle-budget]")?.value ?? "").trim();
    return { type, holdingId: holding.id, shipId, offerId: String(selected[0].value),
      style: card?.querySelector("[data-ship-bundle-style]")?.value ?? "normal",
      budgetCopper: value ? parseShipGoldInput(value) : null,
      locationKind: String(ship?.location?.kind ?? ""), locationId: String(ship?.location?.id ?? "") };
  }
  if (type === "depart-world") return {
    type, holdingId: holding.id, shipId,
    budgetCopper: (() => {
      const node = offerNode?.querySelector("[data-ship-budget]");
      const value = String(node?.value ?? "").trim();
      const automatic = Number(node?.dataset?.shipAutoBudget);
      return !value || (Number.isSafeInteger(automatic) && parseShipGoldInput(value) === automatic) ? null : parseShipGoldInput(value);
    })(),
    offerId: offerNode?.dataset.shipOffer ?? "",
    style: offerNode?.querySelector("[data-ship-style]")?.value ?? "normal",
    locationKind: String(ship?.location?.kind ?? ""), locationId: String(ship?.location?.id ?? "")
  };
  if (type === "depart-bundle") {
    const budgetText = String(card?.querySelector("[data-ship-bundle-budget]")?.value ?? "").trim();
    return {
      type, holdingId: holding.id, shipId,
      offerIds: [...(card?.querySelectorAll("[data-ship-bundle-select]:checked") ?? [])].map((field) => String(field.value)),
      style: card?.querySelector("[data-ship-bundle-style]")?.value ?? "normal",
      budgetCopper: budgetText ? parseShipGoldInput(budgetText) : null,
      locationKind: String(ship?.location?.kind ?? ""), locationId: String(ship?.location?.id ?? "")
    };
  }
  if (["continue-bundle", "resolve-bundle"].includes(type)) return {
    type, holdingId: holding.id, shipId, voyageId: String(ship?.orderBundle?.id ?? ""),
    locationKind: String(ship?.location?.kind ?? ""), locationId: String(ship?.location?.id ?? "")
  };
  if (type === "resolve-world") return { type, holdingId: holding.id, shipId, voyageId: card?.dataset.shipVoyage ?? "" };
  if (type === "depart") return {
    type, holdingId: holding.id, shipId,
    budgetCopper: number("[data-ship-budget]"),
    offerId: offerNode?.dataset.shipOffer ?? "",
    style: offerNode?.querySelector("[data-ship-style]")?.value ?? "normal"
  };
  if (type === "resolve") return { type, holdingId: holding.id, shipId, voyageId: card?.dataset.shipVoyage ?? "" };
  return {
    type, holdingId: holding.id, shipId, voyageId: card?.dataset.shipVoyage ?? "",
    locationKind: String(ship?.location?.kind ?? ""), locationId: String(ship?.location?.id ?? ""),
    kind: card?.querySelector("[data-ship-kind]")?.value,
    amountCopper: parseShipGoldInput(card?.querySelector("[data-ship-amount]")?.value ?? "0"),
    reason: card?.querySelector("[data-ship-reason]")?.value ?? ""
  };
}

export const ShipEventActions = {
  click: {
    "ship-open": "_onOpenShip",
    "ship-create-profile": "_onShipOperation",
    "ship-delete": "_onShipOperation",
    "ship-adopt": "_onShipOperation",
    "ship-install-magnifique-crew": "_onShipOperation",
    "ship-save-crew": "_onShipOperation",
    "ship-generate-world": "_onShipOperation",
    "ship-reroll-world": "_onShipOperation",
    "ship-depart-world": "_onShipOperation",
    "ship-depart-bundle": "_onShipOperation",
    "ship-continue-bundle": "_onShipOperation",
    "ship-resolve-bundle": "_onShipOperation",
    "ship-return-home": "_onShipOperation",
    "ship-relocate-world": "_onShipOperation",
    "ship-resolve-world": "_onShipOperation",
    "ship-depart": "_onShipOperation",
    "ship-adjust": "_onShipOperation",
    "ship-generate-offers": "_onShipOperation",
    "ship-resolve": "_onShipOperation"
  },
  publicClick: ["ship-open", "ship-generate-world", "ship-depart-world", "ship-depart-bundle", "ship-continue-bundle", "ship-resolve-bundle", "ship-return-home", "ship-relocate-world", "ship-resolve-world", "ship-depart", "ship-resolve", "ship-adjust"]
};
export const ShipEventDomain = {
  async _onOpenShip(event) {
    event.preventDefault();
    const button = event.currentTarget;
    const card = button.closest?.("[data-ship-card]");
    const holdingId = String(card?.dataset.shipHolding ?? button.dataset.shipHolding ?? "");
    const shipId = String(card?.dataset.shipCard ?? button.dataset.shipId ?? "");
    if (!holdingId || !shipId) return;
    await openShipWindow({ holdingId, shipId });
  },

  async _onShipOperation(event) {
    event.preventDefault();
    const button = event.currentTarget;
    const card = button.closest("[data-ship-card]");
    const action = button.dataset.action;
    const holdingId = card?.dataset.shipHolding ?? button.dataset.shipHolding;
    const planned = button.dataset.shipPlanned !== undefined;
    const revision = Number(planned ? button.dataset.shipRevision : (card?.dataset.shipRevision ?? button.dataset.shipRevision));
    if (!holdingId || !Number.isSafeInteger(revision)) return;
    const shipId = card?.dataset.shipCard ?? "";
    const busyKey = shipId || `offers:${holdingId}`;
    if (this._busyShips?.has(busyKey)) return;
    const data = SkyholdData.view();
    const holding = data.holdings.find((row) => row.id === holdingId);
    if (!holding) return;
    const permissions = holdingPermissionContext(holding);
    const type = ({
      "ship-create-profile": "create-profile", "ship-delete": "delete", "ship-adopt": "adopt", "ship-install-magnifique-crew": "install-magnifique-crew", "ship-save-crew": "crew",
      "ship-generate-world": "generate-world", "ship-reroll-world": "reroll-world", "ship-depart-world": "depart-world",
      "ship-depart-bundle": "depart-bundle", "ship-continue-bundle": "continue-bundle", "ship-resolve-bundle": "resolve-bundle", "ship-return-home": "return-home", "ship-relocate-world": "relocate-world",
      "ship-resolve-world": "resolve-world", "ship-depart": "depart", "ship-adjust": "adjust",
      "ship-generate-offers": "generate", "ship-resolve": "resolve"
    })[action];
    if (!type) return;
    const managerOperation = ["generate-world", "depart-world", "depart-bundle", "continue-bundle", "resolve-bundle", "return-home", "relocate-world", "resolve-world", "depart", "resolve"].includes(type)
      || (type === "adjust" && ["deposit", "withdraw"].includes(button.closest("[data-ship-card]")?.querySelector("[data-ship-kind]")?.value));
    if (managerOperation ? !permissions.canManageShips : !permissions.isGM) return;
    const shipless = type === "generate" || type === "create-profile";
    const ship = shipless ? null : holding.special?.ships?.list?.find((row) => row.id === shipId);
    if (!shipless && !ship) return;
    let reviewedPlan = null;
    if (planned) {
      try { reviewedPlan = this._shipPlanner.assertReviewed().plan; }
      catch (error) {
        this._shipPlanner?.update();
        ui.notifications?.warn?.(error.message || "Проверьте обновлённый план рейса.");
        this.requestRender({ focus: false });
        return;
      }
    }
    let intent;
    try { intent = shipOperationIntent({ type, holding, ship, card, button }); }
    catch (error) { ui.notifications?.error?.(error.message || "Некорректная сумма в ЗМ."); return; }
    const key = JSON.stringify(intent);
    this._shipRetries ??= new Map();
    this._busyShips ??= new Set();
    const operation = this._shipRetries.get(key) ?? { ...intent, operationId: makeId("ship-op", 20), expectedRevision: revision };
    this._shipRetries.set(key, operation);
    this._busyShips.add(busyKey);
    button.disabled = true;
    try {
      if (reviewedPlan) {
        const stops = reviewedPlan.stops.map((stop) => escapeHtml(stop.point.label)).join(" → ");
        const orders = reviewedPlan.offers.map((offer) => `<li>${escapeHtml(offer.title)}: ${escapeHtml((offer.contract.pickup ?? offer.from).label)} → ${escapeHtml(offer.to.label)}</li>`).join("");
        if (!await foundryDialogV2().confirm({
          window: { title: "Принять выбранные заказы" }, modal: true,
          content: `<ol>${orders}</ol><p>${stops}</p><p>${reviewedPlan.totalDurationQd / 4} дн. · расходы ${formatShipGold(reviewedPlan.totalOperatingCopper)} ЗМ · плата по договорам ${formatShipGold(reviewedPlan.rewardCopper)} ЗМ до случайных исходов.</p><p>Подход: ${escapeHtml(({ cautious: "Осторожно", normal: "Обычно", bold: "С риском" })[intent.style])}. ${reviewedPlan.atHome ? `На борт дополнительно ${formatShipGold(reviewedPlan.transferCopper)} ЗМ; из казны на стоянку ${formatShipGold(reviewedPlan.homeDebtCopper)} ЗМ.` : "Расходы оплачиваются с борта."} Конечный порт: ${escapeHtml(reviewedPlan.finalPoint.label)}. Возвращение домой не включено.</p><p>Промежуточные решения остаются за игроком. Экипаж уйдёт с работ поселения; после возвращения жильё и работы не восстановятся автоматически. ${reviewedPlan.departingAssignments?.length ? `Затронуто жителей: ${reviewedPlan.departingAssignments.length}. ${reviewedPlan.departingAssignments.slice(0, 5).map((row) => `${escapeHtml(row.name)}: ${escapeHtml(row.label)}`).join("; ")}.` : ""} Резервы не списываются заранее.</p>`
        })) { this._shipRetries.delete(key); return; }
      }
      if (type === "relocate-world") {
        const context = buildShipWorldContext(data, holding, { offerLocationIds: [ship.location?.id, ship.location?.regionId] });
        const offer = quoteWorldShipRelocation(data, holding, ship, intent.destinationId, { context });
        const quote = offer.quote;
        if (!await foundryDialogV2().confirm({
          window: { title: `Передислокация: ${ship.name}` }, modal: true,
          content: `<p>${escapeHtml(offer.from.label)} → ${escapeHtml(offer.to.label)} · ${quote.distanceKm} км · ${quote.durationQd / 4} дн.</p><p>Плановые расходы: ${formatShipGold(quote.operatingCopper)} ЗМ. ${ship.location?.kind === "home" ? `Рекомендуемый бортовой бюджет: ${formatShipGold(quote.recommendedBudgetCopper)} ЗМ (путь, возвращение и стоянка).` : `Расходы спишутся с бортового кошелька; на борту ${formatShipGold(ship.onboardCopper ?? 0)} ЗМ.`} Платы заказчика нет.</p>`
        })) { this._shipRetries.delete(key); return; }
      }
      if (type === "depart-bundle" && !planned) {
        if (intent.offerIds.length < 2 || intent.offerIds.length > 3) throw new Error("Отметьте два или три заказа для составного рейса.");
        const selected = intent.offerIds.map((id) => holding.special?.ships?.offers?.find((offer) => offer.id === id));
        if (selected.some((offer) => !offer)) throw new Error("Одно из предложений больше недоступно. Обновите окно.");
        const locationIds = selected.flatMap((offer) => [offer.from?.id, offer.from?.regionId,
          offer.contract?.pickup?.id, offer.contract?.pickup?.regionId, offer.to?.id, offer.to?.regionId]).filter(Boolean);
        const context = buildShipWorldContext(data, holding, { offerLocationIds: locationIds });
        const plan = quoteWorldShipBundle(data, holding, ship,
          selected.map((offer) => repriceWorldShipOffer(data, holding, ship, offer, { context })), { context });
        const rows = plan.stops.map((stop) => `<li>${escapeHtml(stop.legOffer.from.label)} → ${escapeHtml(stop.point.label)} — ${stop.legOffer.quote.durationQd / 4} дн., трюм ${stop.loadOnLegPoints}/${plan.capacityLoadPoints}, расходы ${formatShipGold(stop.legOffer.quote.operatingCopper)} ЗМ</li>`).join("");
        const reward = selected.reduce((sum, offer) => sum + Number(offer.contract.rewardCopper ?? 0), 0);
        const budget = intent.budgetCopper == null ? plan.recommendedBudgetCopper : intent.budgetCopper;
        if (budget < plan.stops[0].legOffer.quote.operatingCopper) throw new Error("Бортового бюджета недостаточно для первого участка.");
        if (!await foundryDialogV2().confirm({
          window: { title: "Принять составной рейс" }, modal: true,
          content: `<p>${selected.length} заказа · ${plan.totalDurationQd / 4} дн. · ${plan.distanceKm} км.</p><ol>${rows}</ol><p>Плановые расходы: ${formatShipGold(plan.totalOperatingCopper)} ЗМ; плата по договорам: ${formatShipGold(reward)} ЗМ до случайных исходов. Рекомендуемый бюджет: ${formatShipGold(plan.recommendedBudgetCopper)} ЗМ = ${formatShipGold(plan.totalOperatingCopper)} ЗМ на участки + ${formatShipGold(plan.returnReserveCopper)} ЗМ домой + ${formatShipGold(plan.idleReserveCopper)} ЗМ на стоянку + ${formatShipGold(plan.outcomeReserveCopper)} ЗМ на исходы; на борт: ${formatShipGold(budget)} ЗМ.</p><p>Запас остаётся на борту до необходимости и не считается расходом. Заказы оплачиваются по мере доставки; стоянки и события могут изменить результат.</p>`
        })) {
          this._shipRetries.delete(key);
          return;
        }
      }
      if (type === "reroll-world" && !await foundryDialogV2().confirm({
        window: { title: "Обновить свободные заказы" }, modal: true,
        content: "<p>Заменить свободные предложения этого корабля в текущем порту? Выбранный план потребуется проверить заново.</p>"
      })) { this._shipRetries.delete(key); return; }
      if (type === "delete" && !await foundryDialogV2().confirm({
        window: { title: "Удалить корабль" },
        content: `<p>Удалить корабль «${escapeHtml(ship.name)}» и его предложения?</p><p>Экипаж останется жителями поселения, рабочие назначения и история завершённых рейсов сохранятся.</p>`,
        modal: true
      })) {
        this._shipRetries.delete(key);
        return;
      }
      const response = await requestShipOperation(operation);
      this._shipRetries.delete(key);
      if (response?.ok === false) {
        const amount = Number(response.pendingPortBillCopper || response.requiredCopper || 0);
        ui.notifications?.warn?.(amount > 0
          ? `Кораблю не хватает ${formatShipGold(amount)} ЗМ для расходов и продолжения рейса.`
          : "Корабль не может продолжить рейс: проверьте бортовую казну и расходы порта.");
        this.requestRender();
        return;
      }
      this._shipViewState?.clearOperation?.(operation);
      if (["depart-world", "depart-bundle"].includes(operation.type)) this._shipPlanner?.clear();
      this.requestRender();
    } catch (error) {
      if (!error.retryable) this._shipRetries.delete(key);
      if (error.code === "conflict") this.requestRender();
      ui.notifications?.error?.(error.message || "Не удалось выполнить операцию корабля.");
    } finally {
      this._busyShips.delete(busyKey);
      button.disabled = false;
    }
  }
};
