import { SkyholdData, requestShipOperation } from "../../../data/store.js";
import { makeId } from "../../../data/utils.js";
import { holdingPermissionContext } from "../../../data/holding-permissions.js";
import { foundryDialogV2 } from "../../../integrations/foundry-runtime.js";
import { escapeHtml } from "../../../core/helpers.js";
import { openShipWindow } from "../../lazy-apps.js";
import { buildShipWorldContext, quoteWorldShipBundle, quoteWorldShipRelocation, repriceWorldShipOffer } from "../../../engines/ships/world-market.js";
import { formatShipMoney, formatShipMoneyHtml, parseShipGoldInput } from "../../../core/ship-gold.js";

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
  if (["install-magnifique-crew", "delete", "gm-arrive", "gm-cancel-voyage", "gm-clear-bills", "gm-sync-clock"].includes(type)) {
    return { type, holdingId: holding.id, shipId };
  }
  if (type === "gm-move") {
    const rawDest = String(card?.querySelector("[data-ship-gm-destination]")?.value ?? "");
    const sep = rawDest.indexOf(":");
    const destinationKind = sep > 0 ? rawDest.slice(0, sep) : "";
    const destinationId = sep > 0 ? rawDest.slice(sep + 1) : "";
    if (!["home", "market"].includes(destinationKind)) throw new Error("Выберите точку назначения для перемещения.");
    return { type, holdingId: holding.id, shipId, destinationKind, destinationId: destinationKind === "market" ? destinationId : "" };
  }
  if (type === "gm-condition") {
    return { type, holdingId: holding.id, shipId, condition: String(card?.querySelector("[data-ship-gm-condition]")?.value ?? "") };
  }
  if (type === "gm-funds") {
    return {
      type, holdingId: holding.id, shipId,
      fundsMode: String(card?.querySelector("[data-ship-gm-funds-mode]")?.value ?? "set"),
      amountCopper: parseShipGoldInput(card?.querySelector("[data-ship-gm-funds-amount]")?.value ?? "0"),
      reason: String(card?.querySelector("[data-ship-gm-funds-reason]")?.value ?? "").trim()
    };
  }
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
    "ship-resolve": "_onShipOperation",
    "ship-gm-move": "_onShipOperation",
    "ship-gm-condition": "_onShipOperation",
    "ship-gm-funds": "_onShipOperation",
    "ship-gm-arrive": "_onShipOperation",
    "ship-gm-cancel-voyage": "_onShipOperation",
    "ship-gm-clear-bills": "_onShipOperation",
    "ship-gm-sync-clock": "_onShipOperation"
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
      "ship-generate-offers": "generate", "ship-resolve": "resolve",
      "ship-gm-move": "gm-move", "ship-gm-condition": "gm-condition", "ship-gm-funds": "gm-funds",
      "ship-gm-arrive": "gm-arrive", "ship-gm-cancel-voyage": "gm-cancel-voyage",
      "ship-gm-clear-bills": "gm-clear-bills", "ship-gm-sync-clock": "gm-sync-clock"
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
    catch (error) { ui.notifications?.error?.(error.message || "Некорректная сумма."); return; }
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
        const styleFeeText = reviewedPlan.guaranteedStyleCostCopper
          ? ` + осторожный подход ${formatShipMoneyHtml(reviewedPlan.guaranteedStyleCostCopper)}` : "";
        if (!await foundryDialogV2().confirm({
          classes: ["fbl-skyhold"],
          window: { title: "Принять выбранные заказы" }, modal: true,
          content: `<ol>${orders}</ol><p>${stops}</p><p>${reviewedPlan.totalDurationQd / 4} дн. · расходы рейса ${formatShipMoneyHtml(reviewedPlan.totalOperatingCopper)}${styleFeeText} · плата по договорам ${formatShipMoneyHtml(reviewedPlan.rewardCopper)} до случайных исходов.</p><p>Подход: ${escapeHtml(({ cautious: "Осторожно", normal: "Обычно", bold: "С риском" })[intent.style])}. ${reviewedPlan.atHome ? `На борт к выходу: ${formatShipMoneyHtml(reviewedPlan.effectiveBudgetCopper)} (включая запас ${formatShipMoneyHtml(reviewedPlan.plannedReserveCopper)}). Из казны сейчас: ${formatShipMoneyHtml(reviewedPlan.settlementWithdrawalCopper)}${reviewedPlan.homeDebtCopper ? ` (в том числе стоянка ${formatShipMoneyHtml(reviewedPlan.homeDebtCopper)})` : ""}.` : "Расходы оплачиваются с борта."} Конечный порт: ${escapeHtml(reviewedPlan.finalPoint.label)}. Возвращение домой — отдельный приказ.</p><p>Промежуточные решения остаются за игроком. Экипаж уйдёт с работ поселения; после возвращения жильё и работы не восстановятся автоматически. ${reviewedPlan.departingAssignments?.length ? `Затронуто жителей: ${reviewedPlan.departingAssignments.length}. ${reviewedPlan.departingAssignments.slice(0, 5).map((row) => `${escapeHtml(row.name)}: ${escapeHtml(row.label)}`).join("; ")}.` : ""} Запас не списывается заранее и возвращается в казну дома.</p>`
        })) { this._shipRetries.delete(key); return; }
      }
      if (type === "relocate-world") {
        const context = buildShipWorldContext(data, holding, { offerLocationIds: [ship.location?.id, ship.location?.regionId] });
        const offer = quoteWorldShipRelocation(data, holding, ship, intent.destinationId, { context });
        const quote = offer.quote;
        if (!await foundryDialogV2().confirm({
          classes: ["fbl-skyhold"],
          window: { title: `Передислокация: ${ship.name}` }, modal: true,
          content: `<p>${escapeHtml(offer.from.label)} → ${escapeHtml(offer.to.label)} · ${quote.distanceKm} км · ${quote.durationQd / 4} дн.</p><p>Плановые расходы: ${formatShipMoneyHtml(quote.operatingCopper)}. ${ship.location?.kind === "home" ? `На борт с запасом: ${formatShipMoneyHtml(quote.recommendedBudgetCopper)} (путь и запас на возвращение и стоянку).` : `Расходы спишутся с бортового кошелька; на борту ${formatShipMoneyHtml(ship.onboardCopper ?? 0)}.`} Платы заказчика нет.</p>`
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
        const rows = plan.stops.map((stop) => `<li>${escapeHtml(stop.legOffer.from.label)} → ${escapeHtml(stop.point.label)} — ${stop.legOffer.quote.durationQd / 4} дн., трюм ${stop.loadOnLegPoints}/${plan.capacityLoadPoints}, расходы ${formatShipMoneyHtml(stop.legOffer.quote.operatingCopper)}</li>`).join("");
        const reward = selected.reduce((sum, offer) => sum + Number(offer.contract.rewardCopper ?? 0), 0);
        const budget = intent.budgetCopper == null ? plan.recommendedBudgetCopper : intent.budgetCopper;
        const recommendedReserve = Math.max(0, plan.recommendedBudgetCopper - plan.totalOperatingCopper);
        if (budget < plan.stops[0].legOffer.quote.operatingCopper) throw new Error("Бортового бюджета недостаточно для первого участка.");
        if (!await foundryDialogV2().confirm({
          classes: ["fbl-skyhold"],
          window: { title: "Принять составной рейс" }, modal: true,
          content: `<p>${selected.length} заказа · ${plan.totalDurationQd / 4} дн. · ${plan.distanceKm} км.</p><ol>${rows}</ol><p>Расходы рейса: ${formatShipMoneyHtml(plan.totalOperatingCopper)}; плата по договорам: ${formatShipMoneyHtml(reward)} до случайных исходов. Рекомендуемый запас сверх рейса: ${formatShipMoneyHtml(recommendedReserve)} (итого с запасом ${formatShipMoneyHtml(plan.recommendedBudgetCopper)}); на борт: ${formatShipMoneyHtml(budget)}.</p><p>Запас остаётся на борту до необходимости и возвращается в казну дома. Заказы оплачиваются по мере доставки; стоянки и события могут изменить результат.</p>`
        })) {
          this._shipRetries.delete(key);
          return;
        }
      }
      if (type === "gm-move") {
        const destSelect = card?.querySelector("[data-ship-gm-destination]");
        const destLabel = destSelect?.selectedOptions?.[0]?.textContent?.trim() || (intent.destinationKind === "home" ? holding.name : intent.destinationId);
        const activeWarning = ship.activeVoyage || ship.orderBundle
          ? "<p>Активный рейс или составной заказ будет отменён без броска исходов.</p>" : "";
        if (!await foundryDialogV2().confirm({
          classes: ["fbl-skyhold"],
          window: { title: `ГМ · Переместить «${ship.name}»` }, modal: true,
          content: `<p>Переместить корабль «${escapeHtml(ship.name)}» в точку <strong>${escapeHtml(destLabel)}</strong> в обход обычных правил?</p>${activeWarning}<p>Статус экипажа и расчёт стоянки обновятся для нового места; бортовой кошелёк (${formatShipMoneyHtml(ship.onboardCopper ?? 0)}) сохранится без изменений.</p>`
        })) { this._shipRetries.delete(key); return; }
      }
      if (type === "gm-arrive" && !await foundryDialogV2().confirm({
        classes: ["fbl-skyhold"],
        window: { title: `ГМ · Завершить перелёт «${ship.name}»` }, modal: true,
        content: `<p>Мгновенно завершить текущий перелёт или задержку корабля «${escapeHtml(ship.name)}»?</p><p>Если везётся контракт, откроется подведение итогов в порту прибытия; если это возвращение или порожний переход, прибытие завершится сразу.</p>`
      })) { this._shipRetries.delete(key); return; }
      if (type === "gm-cancel-voyage" && !await foundryDialogV2().confirm({
        classes: ["fbl-skyhold"],
        window: { title: `ГМ · Отменить рейс «${ship.name}»` }, modal: true,
        content: `<p>Отменить текущий рейс или составной заказ корабля «${escapeHtml(ship.name)}» без броска исходов?</p><p>Корабль вернётся в порт отправления текущего участка (или останется в текущем порту), а уже проведённые списания останутся в журнале.</p>`
      })) { this._shipRetries.delete(key); return; }
      if (type === "gm-clear-bills" && !await foundryDialogV2().confirm({
        classes: ["fbl-skyhold"],
        window: { title: `ГМ · Списать долги стоянки «${ship.name}»` }, modal: true,
        content: `<p>Обнулить накопленный долг стоянки корабля «${escapeHtml(ship.name)}» и начать отсчёт стоянки заново с текущей даты?</p>`
      })) { this._shipRetries.delete(key); return; }
      if (type === "gm-sync-clock" && !await foundryDialogV2().confirm({
        classes: ["fbl-skyhold"],
        window: { title: `ГМ · Синхронизировать время «${ship.name}»` }, modal: true,
        content: `<p>Приравнять корабельное время «${escapeHtml(ship.name)}» к текущей дате поселения?</p><p>Это снимает блокировку расхождения календаря и пропускает накопленный остаток корабельных дней без начисления стоянки.</p>`
      })) { this._shipRetries.delete(key); return; }
      if (type === "gm-funds") {
        const modeLabel = ({ set: "Задать точную сумму", income: "Добавить на борт", expense: "Списать с борта" })[intent.fundsMode] ?? intent.fundsMode;
        if (!await foundryDialogV2().confirm({
          classes: ["fbl-skyhold"],
          window: { title: `ГМ · Кошелёк «${ship.name}»` }, modal: true,
          content: `<p><strong>${escapeHtml(modeLabel)}:</strong> ${formatShipMoneyHtml(intent.amountCopper)} (сейчас на борту ${formatShipMoneyHtml(ship.onboardCopper ?? 0)}).</p><p>Казна поселения не изменяется; операция запишется в журнал корабля.</p>`
        })) { this._shipRetries.delete(key); return; }
      }
      if (type === "reroll-world" && !await foundryDialogV2().confirm({
        classes: ["fbl-skyhold"],
        window: { title: "Обновить свободные заказы" }, modal: true,
        content: "<p>Заменить свободные предложения этого корабля в текущем порту? Выбранный план потребуется проверить заново.</p>"
      })) { this._shipRetries.delete(key); return; }
      if (type === "delete" && !await foundryDialogV2().confirm({
        classes: ["fbl-skyhold"],
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
        const shortage = Number(response.shortageCopper || 0);
        const totalDue = Number(response.pendingPortBillCopper || response.requiredCopper || 0);
        ui.notifications?.warn?.(shortage > 0
          ? `Кораблю не хватает ${formatShipMoney(shortage)} для расходов и продолжения рейса.`
          : totalDue > 0
            ? `Недостаточно средств для продолжения рейса. Нужно к оплате: ${formatShipMoney(totalDue)}.`
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
