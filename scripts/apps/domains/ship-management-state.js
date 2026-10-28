import { shipNextAction } from "../../engines/ships/summary.js";
import { prepareShipCommandAvailability, shipPresentationTimelineQd } from "./ship-command-availability.js";
import { transportOrders } from "../../data/transport/state.js";

export function shipTransportState(holding, ship) {
  const busy = Boolean(ship.transportOrderId);
  const order = busy ? transportOrders(holding).find(row => row.id === ship.transportOrderId) : null;
  return { busy, order, inTransit: busy && !order?.shipArrived };
}

/** Shared, read-only presentation. The fleet overview must not compose markets. */
export function prepareShipManagementState(holding, ship, { permissions, readiness, money, offers = [], returnOffer = null } = {}) {
  const transport = shipTransportState(holding, ship);
  const inTransit = Boolean(ship.activeVoyage || transport.inTransit);
  const atHome = ship.location?.kind === "home" && !inTransit;
  const atForeignPort = ship.location?.kind === "market" && !inTransit;
  const settlementQd = Number(holding.gm?.calendaria?.lastQd ?? 0);
  const shipQd = shipPresentationTimelineQd(holding, ship);
  const period = Math.floor(shipQd / 40);
  const lockKey = `${ship.id}|${ship.location?.kind ?? ""}:${ship.location?.id ?? ""}|${period}`;
  const worldOffersGenerated = Boolean(holding.special?.ships?.worldOfferLocks?.[lockKey]);
  const ownSale = (holding.special?.market?.outbound?.orders ?? []).find((order) => order.ownShipId === ship.id
    && !["delivered", "lost", "cancelled"].includes(order.status)) ?? null;
  const bundle = ship.orderBundle;
  const soloDelayed = ship.activeVoyage?.outcomeApplied === true && Number(ship.activeVoyage?.remainingQd ?? 0) > 0
    && Number(ship.activeVoyage?.outcome?.delayQd ?? 0) > 0;
  const delayed = soloDelayed || bundle?.status === "final-delay"
    || bundle?.status === "at-port" && settlementQd < Number(bundle.delayUntilQd ?? 0);
  const awaitingOutcome = ship.activeVoyage?.awaitingOutcome === true;
  let statusLabel = ownSale ? (inTransit && !awaitingOutcome ? "Везёт товар поселения" : "Ожидает исхода продажи")
    : delayed ? "Задержан в порту" : bundle?.status === "awaiting-outcome" ? "Заказы ждут итога"
      : awaitingOutcome ? "Ожидает итога" : inTransit ? "В пути" : atHome ? "В поселении" : "В чужом порту";
  const permissionReason = !permissions || permissions.canManageShips ? "" : !permissions.mayManageShips
    ? "Доступен просмотр. ГМ не разрешил управление кораблями этого поселения."
    : "Управление временно недоступно: нужен активный ГМ и соединение с ним.";
  const commands = prepareShipCommandAvailability(holding, ship, { permissions, permissionReason, returnOffer, ownSale });
  // A pinned foreign-port command settles its bill at ship time, not the later settlement projection.
  const commandMoney = commands.departurePortBillCopper === null ? money
    : { ...money, obligationsCopper: commands.departurePortBillCopper };
  let nextAction = shipNextAction(ship, { readiness, money: commandMoney, offers });
  if (ownSale) nextAction = ownSale.status === "needsResolution" ? "Требуется решение ГМа по продаже собственного товара"
    : inTransit && !awaitingOutcome ? "Дождаться доставки товара поселения" : "Дождаться расчёта продажи во «Внешнем рынке»";
  else if (delayed) nextAction = "Дождаться окончания задержки в порту";
  else if (!inTransit && !bundle && money?.calculationValid === false) nextAction = "Проверить финансовые данные с ГМом";
  else if (!inTransit && !bundle && atForeignPort && readiness && !readiness.ready) nextAction = "Проверить готовность команды и возможность возвращения домой";
  else if (!inTransit && !bundle && ship.condition === "ready" && readiness?.ready && !(commandMoney?.obligationsCopper > commandMoney?.balanceCopper)) {
    if (worldOffersGenerated && !offers.length) nextAction = atForeignPort
      ? "Новых заказов пока нет; проверить возвращение или дождаться следующей декады"
      : "Новых заказов пока нет; дождаться следующей декады";
    else if (!offers.length && atForeignPort) nextAction = "Узнать местные предложения или проверить возвращение домой";
  }
  if (commands.clockBlocked) nextAction = "Проверить дату корабля и поселения с ГМом";
  else if (!delayed && commands.continueBundle && !commands.continueBundle.allowed && permissions?.canManageShips) {
    nextAction = commands.continueBundle.needsFunds ? "Пополнить бортовые деньги перед следующим участком"
      : "Проверить возможность продолжения маршрута с ГМом";
  }
  const residentPermissionReason = transport.busy ? "Экипаж занят перевозкой; дождитесь освобождения корабля."
    : !permissions || permissions.canEditResidents ? "" : !permissions.mayEditResidents
    ? "Для береговой работы нужно отдельное разрешение ГМа."
    : "Береговая работа временно недоступна: нужен активный ГМ и соединение с ним.";
  const departureIssues = [];
  if (!inTransit && !bundle && !ownSale && !transport.busy) {
    if (ship.condition !== "ready") departureIssues.push("Корабль требует обслуживания; необходимо решение ГМа.");
    if (readiness && !readiness.ready) departureIssues.push(...readiness.issues.map((issue) => issue.message));
    if (commandMoney?.obligationsCopper > commandMoney?.balanceCopper) departureIssues.push("Не хватает доступных денег для оплаты счетов к отправлению.");
    if (commands.clockIssue) departureIssues.push(commands.clockIssue);
  }
  if (money?.calculationValid === false) departureIssues.push("Финансовые данные требуют проверки ГМа; свободные средства не рассчитаны.");
  const transportStageText = transport.order ? transport.order.stageIndex < transport.order.stages.length
    ? `Участок ${transport.order.stageIndex + 1} из ${transport.order.stages.length}`
    : "Груз обработан; завершение рейса и расчётов" : "";
  if (transport.busy) {
    statusLabel = transport.order?.fundingNeededCopper ? "Ожидает оплаты перевозки"
      : transport.order?.status === "needsResolution" ? "Перевозка ждёт решения ГМа"
        : transport.order?.status === "waitingCarrier" ? "Ожидает транспорта"
          : transport.order?.shipArrived ? "Перевозка завершает расчёт" : "Выполняет перевозку";
    nextAction = transport.order?.fundingNeededCopper ? "Открыть «Перевозки своего груза» и покрыть дополнительные расходы"
      : "Открыть «Перевозки своего груза» для состояния заказа и дальнейших действий";
  }
  return {
    transportBusy: transport.busy, transportStageText,
    ownSale, statusLabel, nextAction, permissionReason, residentPermissionReason, departureIssues, worldOffersGenerated, commands,
    needsCrewAttention: Boolean(readiness && !readiness.ready),
    needsMoneyAttention: Boolean(money?.shortageCopper || money?.calculationValid === false),
    canManageResidents: Boolean(permissions?.canEditResidents && !transport.busy)
  };
}
