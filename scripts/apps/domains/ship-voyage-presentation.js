const amount = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const label = (point) => point?.label || "Неизвестный порт";
const cargoName = (order) => order?.offer?.contract?.cargo?.name || order?.offer?.title || "Груз заказчика";

function stop(point, number, fields = {}) {
  return { number, label: label(point), statusLabel: "Впереди", current: false, complete: false, ...fields };
}

function portStatus({ waitingFunds, awaiting, delayed }) {
  return waitingFunds ? "Нужны средства · исход сохранён" : awaiting ? "Ожидает итогов"
    : delayed ? "Задержан в порту" : "В порту · ждёт приказа";
}

function bundleStops(bundle, voyage, delayed) {
  const orders = bundle.orders ?? [];
  const stops = bundle.stops ?? [];
  const next = amount(bundle.nextStopIndex);
  const cargoText = (ids) => (ids ?? []).map((id) => cargoName(orders.find((order) => order.offerId === id))).join(" · ");
  const origin = stops[0]?.legOffer?.from;
  const rows = origin ? [stop(origin, 0, { complete: true, statusLabel: "Отправление",
    pickupText: orders.filter((order) => !order.offer?.contract?.pickup).map(cargoName).join(" · ") })] : [];
  for (const [index, saved] of stops.entries()) {
    const reached = index < next;
    const current = voyage ? index === next : index === next - 1;
    rows.push(stop(saved.point, index + 1, {
      current, complete: reached,
      statusLabel: current ? (voyage ? "Следующий порт" : portStatus({ waitingFunds: bundle.waitingFunds,
        awaiting: bundle.status === "awaiting-outcome", delayed })) : reached ? "Пройден" : "Впереди",
      pickupText: cargoText(saved.pickupOfferIds), deliveryText: cargoText(saved.deliveryOfferIds),
      incomingLabel: `${label(saved.legOffer?.from)} → ${label(saved.point)}`,
      durationDays: amount(saved.legOffer?.quote?.durationQd) / 4,
      hasLoadPlan: Number.isFinite(saved.loadOnLegPoints) && Number.isFinite(saved.loadAfterPoints),
      loadOnLegPoints: saved.loadOnLegPoints, loadAfterPoints: saved.loadAfterPoints
    }));
  }
  return rows;
}

function singleStops(voyage, ownSale, delayed) {
  const quote = voyage?.quote;
  if (!quote) return ownSale ? [stop({ label: ownSale.marketLabel }, 1, { current: true, complete: true,
    statusLabel: ownSale.status === "needsResolution" ? "Требуется решение ГМа" : amount(ownSale.delayRemainingQd) > 0 ? "Продажа задержана" : "Ожидает расчёта продажи" })] : [];
  const contract = quote.contract;
  const arrived = voyage.awaitingOutcome === true || delayed;
  const rows = [stop(quote.from, 0, { complete: true, statusLabel: "Отправление",
    pickupText: !contract?.pickup ? contract?.cargo?.name : "" })];
  if (contract?.pickup) rows.push(stop(contract.pickup, 1, { complete: arrived,
    statusLabel: arrived ? "Пройден" : "Погрузка в составе участка", pickupText: contract.cargo?.name }));
  rows.push(stop(quote.to, rows.length, { current: true, complete: arrived,
    statusLabel: arrived ? portStatus({ waitingFunds: voyage.waitingFunds, awaiting: voyage.awaitingOutcome, delayed }) : "Следующий порт",
    deliveryText: contract?.cargo?.name }));
  return rows;
}

/** Present only accepted snapshots. Never reprice, move time, settle bills or infer a position along a flight. */
export function prepareShipVoyagePresentation(holding, ship, { ownSale = null } = {}) {
  if (ship.navigationMode !== "world") return null;
  const voyage = ship.activeVoyage?.mode === "world" ? ship.activeVoyage : null;
  const bundle = ship.orderBundle;
  if (!voyage && !bundle && !ownSale) return null;
  const settlementQd = amount(holding.gm?.calendaria?.lastQd);
  // Match the existing cursor fallback for saves which predate timelineQd.
  const shipQd = ship.timelineQd == null ? Math.max(settlementQd, amount(voyage?.lastProcessedQd), amount(ship.portBilling?.lastCalculatedQd))
    : amount(ship.timelineQd);
  const catchUpDays = Math.max(0, settlementQd - shipQd) / 4;
  const soloDelay = Boolean(voyage?.outcomeApplied && voyage.outcome?.delayQd > 0 && voyage.remainingQd > 0);
  const delayQd = bundle ? Math.max(0, amount(bundle.delayUntilQd) - settlementQd)
    : soloDelay ? amount(voyage.remainingQd) : amount(ownSale?.delayRemainingQd);
  const delayed = soloDelay || delayQd > 0 || bundle?.status === "final-delay";
  const awaiting = voyage?.awaitingOutcome === true || bundle?.status === "awaiting-outcome";
  const waitingFunds = Boolean(voyage?.waitingFunds || bundle?.waitingFunds);
  const title = bundle ? `Принятый маршрут · ${bundle.orders?.length ?? 0} заказа`
    : ownSale ? "Продажа товара поселения" : voyage?.quote?.contract ? "Принятый заказ"
      : voyage?.quote?.to?.kind === "home" ? "Возвращение домой" : "Передислокация";
  const statusLabel = ownSale?.status === "needsResolution" ? "Требуется решение ГМа по продаже"
    : ownSale && !voyage ? (delayed ? "Продажа задержана" : "Ожидает расчёта продажи")
      : portStatus({ waitingFunds, awaiting, delayed });
  let leg = null;
  if (voyage) {
    const totalQd = soloDelay ? amount(voyage.outcome.delayQd) : amount(voyage.durationQd ?? voyage.quote?.durationQd);
    const remainingQd = Math.min(totalQd, amount(voyage.remainingQd));
    const elapsedQd = soloDelay ? totalQd - remainingQd : Math.min(totalQd, amount(voyage.elapsedQd));
    leg = {
      label: soloDelay ? `Задержка · ${label(voyage.quote?.to)}` : `${label(voyage.quote?.from)} → ${label(voyage.quote?.to)}`,
      isDelay: soloDelay, totalQd, elapsedQd, durationDays: totalQd / 4,
      elapsedDays: elapsedQd / 4, remainingDays: remainingQd / 4, hasProgress: totalQd > 0,
      progressText: `${elapsedQd / 4} из ${totalQd / 4} дн.`,
      statusLabel: awaiting || soloDelay ? statusLabel : "В пути"
    };
  }
  const unflownStops = bundle ? (bundle.stops ?? []).slice(amount(bundle.nextStopIndex) + (voyage ? 1 : 0)) : [];
  const remainingPlannedDays = bundle ? (amount(voyage?.remainingQd)
    + unflownStops.reduce((sum, row) => sum + amount(row.legOffer?.quote?.durationQd), 0)) / 4 : null;
  const timeExplanation = waitingFunds ? "Корабль прибыл. Исход уже сохранён; сначала нужно покрыть его расходы. Повторное подтверждение продолжит тот же исход."
    : awaiting ? "Корабль прибыл. Время пути закончено, но доставка требует отдельного подтверждения исхода. Следующий участок сам не начинается."
      : soloDelay ? "Путь уже пройден, исход применён. Осталось учесть задержку в порту; это время не означает новый перелёт."
        : bundle?.status === "final-delay" ? "Все грузы доставлены. Рейс закроется после учёта последней задержки."
          : ownSale && !voyage ? "Корабль в порту назначения. Расчёт продажи, её задержка и решение возможного происшествия ведутся во «Внешнем рынке»."
          : ownSale && voyage ? "Показано учтённое время пути корабля с портовыми работами. Продажа и возможная задержка её расчёта ведутся отдельно во «Внешнем рынке»."
          : delayed ? "Продолжение заблокировано до окончания задержки. Решение о следующем участке остаётся за вами."
            : bundle && !voyage ? "Работы этого порта учтены. Для следующего участка нужен приказ «Следующий порт»; новый заказ не заменяет принятый маршрут."
                : "Время включает перелёт и предусмотренные портовые работы. Прогресс показывает учтённые дни всего участка; точная фаза и позиция внутри перелёта отдельно не отслеживаются.";
  const snapshotIssue = bundle?.status === "travelling" && !voyage
    ? "В принятом рейсе отсутствует текущий участок. ГМу нужно проверить состояние корабля; просмотр не восстанавливает рейс автоматически." : "";
  const stops = bundle ? bundleStops(bundle, voyage, delayed) : singleStops(voyage, ownSale, soloDelay);
  return {
    title, statusLabel: snapshotIssue ? "Требуется проверка ГМа" : statusLabel,
    leg, awaiting, delayed, snapshotIssue, traveling: Boolean(voyage && !awaiting && !soloDelay),
    stops, startNumber: stops[0]?.number ?? 0,
    delayDays: delayQd / 4, catchUpDays, clockReversed: shipQd > settlementQd,
    timeExplanation, remainingPlannedDays, isBundle: Boolean(bundle),
    hasRemotePickup: Boolean(voyage?.quote?.contract?.pickup && !awaiting && !soloDelay)
  };
}
