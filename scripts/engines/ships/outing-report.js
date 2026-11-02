const VERSION = 1;
const MAX_DETAILS = 40;
const MAX_TEXT = 300;

function id(value, name = "ID") {
  const result = String(value ?? "").trim();
  if (!result || result.length > 128) throw new TypeError(`Некорректный ${name}.`);
  return result;
}

function integer(value, name, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) throw new RangeError(`Некорректное значение: ${name}.`);
  return value;
}

function signedInteger(value, name) {
  if (!Number.isSafeInteger(value)) throw new RangeError(`Некорректное значение: ${name}.`);
  return value;
}

function add(left, right, name) {
  const result = integer(left, name) + integer(right, name);
  if (!Number.isSafeInteger(result)) throw new RangeError(`Значение «${name}» превышает безопасный предел.`);
  return result;
}

function text(value, fallback = "") {
  return String(value ?? fallback).trim().slice(0, MAX_TEXT);
}

function clone(value) {
  return globalThis.structuredClone ? globalThis.structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function current(ship) {
  const report = ship?.currentOuting;
  if (!report || report.version !== VERSION) throw new Error("Для корабля не начат сводный отчёт выхода.");
  return report;
}

function update(ship, change) {
  const report = clone(current(ship));
  change(report);
  ship.currentOuting = report;
  return report;
}

function appendDetail(report, { kind, clockQd, amountCopper = 0, reason }) {
  const detail = {
    kind: text(kind, "note") || "note",
    clockQd: integer(clockQd, "время пояснения"),
    amountCopper: signedInteger(amountCopper, "сумма пояснения"),
    reason: text(reason, "Операция корабля") || "Операция корабля"
  };
  report.details = Array.isArray(report.details) ? [...report.details, detail] : [detail];
  if (report.details.length > MAX_DETAILS) {
    const omitted = report.details.length - MAX_DETAILS;
    report.details = report.details.slice(-MAX_DETAILS);
    report.omittedDetails = add(report.omittedDetails ?? 0, omitted, "число скрытых пояснений");
  }
}

function blankReport({ voyageId, clockQd, partial }) {
  const startedAtQd = integer(clockQd, "начало учёта");
  return {
    version: VERSION,
    id: id(voyageId, "ID выхода"),
    startedAtQd,
    completedAtQd: null,
    knownSinceQd: startedAtQd,
    partial: Boolean(partial),
    scopeLabel: partial ? "С момента начала учёта" : "Полный выход из поселения",
    fundingCopper: 0,
    incomeCopper: 0,
    expenseCopper: 0,
    portExpenseCopper: 0,
    returnedCopper: 0,
    plannedOperatingCopper: 0,
    plannedPreparationCopper: 0,
    plannedRewardCopper: 0,
    plannedDurationQd: 0,
    startedLegs: 0,
    completedLegs: 0,
    lastLegId: "",
    lastCompletedLegId: "",
    details: [],
    omittedDetails: 0
  };
}

/** Begin a complete report immediately after a successful departure from home. */
export function beginShipOuting(ship, { voyageId, clockQd, budgetCopper, preparationCopper = 0 } = {}) {
  if (!ship || typeof ship !== "object") throw new TypeError("Не указан корабль для отчёта выхода.");
  const firstVoyageId = id(voyageId, "ID первого участка");
  const existing = ship.currentOuting;
  if (existing) {
    if (existing.version === VERSION && existing.id === firstVoyageId) return existing;
    throw new Error("Предыдущий выход корабля ещё не завершён.");
  }
  const budget = integer(budgetCopper, "бортовой бюджет");
  const preparation = integer(preparationCopper, "подготовка");
  const report = blankReport({ voyageId: firstVoyageId, clockQd, partial: false });
  report.fundingCopper = add(budget, preparation, "выделенные средства");
  appendDetail(report, {
    kind: "funding",
    clockQd,
    amountCopper: report.fundingCopper,
    reason: "Выделено из казны поселения: бортовой бюджет и подготовка"
  });
  ship.currentOuting = report;
  return report;
}

/** Start honest forward-only accounting for a ship that was already away. */
export function ensurePartialShipOuting(ship, { voyageId, clockQd } = {}) {
  if (!ship || typeof ship !== "object") throw new TypeError("Не указан корабль для отчёта выхода.");
  if (ship.currentOuting) return current(ship);
  const activeLegId = ship?.activeVoyage?.id ? id(ship.activeVoyage.id, "ID текущего участка") : "";
  const report = blankReport({ voyageId: voyageId || activeLegId, clockQd, partial: true });
  report.lastLegId = activeLegId;
  report.startedLegs = activeLegId ? 1 : 0;
  appendDetail(report, {
    kind: "partial-start",
    clockQd,
    amountCopper: 0,
    reason: activeLegId
      ? "Неполный отчёт: текущий участок начался до учёта, его плановые суммы неизвестны"
      : "Неполный отчёт: известны только операции с момента начала учёта"
  });
  ship.currentOuting = report;
  return report;
}

/** Add the frozen plan of one accepted leg. Repeating the current leg is a no-op. */
export function planShipOutingLeg(ship, voyage = {}) {
  const voyageId = id(voyage?.id, "ID участка");
  const existing = current(ship);
  if (existing.lastLegId === voyageId) return existing;
  if (existing.lastLegId && existing.lastCompletedLegId !== existing.lastLegId) {
    throw new Error("Предыдущий участок выхода ещё не завершён.");
  }
  const quote = voyage?.quote ?? {};
  const operating = integer(quote.operatingCopper ?? quote.costs?.totalCopper ?? 0, "плановые расходы участка");
  const preparation = integer(quote.preparationCopper ?? 0, "плановая подготовка участка");
  const reward = integer(quote.rewardCopper ?? quote.contract?.rewardCopper ?? 0, "договорная плата участка");
  const durationQd = integer(quote.durationQd, "плановая длительность участка", 1);
  const clockQd = integer(voyage?.startedAtQd, "начало участка");
  const from = text(quote?.from?.label, "Неизвестный порт") || "Неизвестный порт";
  const to = text(quote?.to?.label, "Неизвестный порт") || "Неизвестный порт";
  return update(ship, (report) => {
    report.plannedOperatingCopper = add(report.plannedOperatingCopper, operating, "плановые расходы");
    report.plannedPreparationCopper = add(report.plannedPreparationCopper, preparation, "плановая подготовка");
    report.plannedRewardCopper = add(report.plannedRewardCopper, reward, "договорная плата");
    report.plannedDurationQd = add(report.plannedDurationQd, durationQd, "плановая длительность");
    report.startedLegs = add(report.startedLegs, 1, "начатые участки");
    report.lastLegId = voyageId;
    appendDetail(report, { kind: "leg-start", clockQd, amountCopper: 0, reason: `${from} → ${to}` });
  });
}

/** Record fees promised by a bundle once; its physical legs have no contract fee. */
export function planShipOutingBundleRewards(ship, { rewardCopper, clockQd } = {}) {
  const reward = integer(rewardCopper, "плата составного рейса");
  const clock = integer(clockQd, "начало составного рейса");
  return update(ship, (report) => {
    report.plannedRewardCopper = add(report.plannedRewardCopper, reward, "плановая плата заказов");
    appendDetail(report, { kind: "bundle-plan", clockQd: clock, reason: `Приняты составные заказы: ожидаемая плата ${reward}` });
  });
}

/**
 * Record a receipt that has already been successfully applied by the funds
 * engine. The caller must skip replay receipts; this helper keeps no ID ledger.
 */
export function recordShipOutingFunds(ship, receipt = {}, { clockQd, reason = "", category = "" } = {}) {
  const external = signedInteger(receipt?.externalDeltaCopper ?? 0, "внешнее изменение казны");
  const transfer = signedInteger(receipt?.transferToShipCopper ?? 0, "внутренний перевод");
  const internal = receipt?.internalTransfer === true || receipt?.meta?.internalTransfer === true;
  const receiptId = text(receipt?.id);
  const kind = text(receipt?.kind);
  const port = category === "port" || receiptId.includes(":idle:market:");
  const actualExternal = internal ? 0 : external;
  return update(ship, (report) => {
    if (actualExternal > 0 && kind === "expense-refund") report.expenseCopper = Math.max(0, report.expenseCopper - actualExternal);
    else if (actualExternal > 0) report.incomeCopper = add(report.incomeCopper, actualExternal, "внешние поступления");
    if (actualExternal < 0) {
      const expense = Math.abs(actualExternal);
      report.expenseCopper = add(report.expenseCopper, expense, "фактические расходы");
      if (port) report.portExpenseCopper = add(report.portExpenseCopper, expense, "расходы стоянки");
    }
    if (kind === "return" || transfer < 0) {
      report.returnedCopper = add(report.returnedCopper, Math.abs(transfer), "возвращено в поселение");
    }
    const detailAmount = actualExternal || (transfer < 0 ? transfer : 0);
    if (detailAmount !== 0) {
      appendDetail(report, {
        kind: port ? "port-expense" : (kind || (detailAmount > 0 ? "income" : "expense")),
        clockQd,
        amountCopper: detailAmount,
        reason: reason || receipt?.reason || "Денежная операция корабля"
      });
    }
  });
}

/** Complete one leg; arrival home atomically moves currentOuting to lastOuting. */
export function completeShipOutingLeg(ship, summary = {}) {
  const voyageId = id(summary?.id, "ID завершённого участка");
  if (!ship?.currentOuting) {
    if (ship?.lastOuting?.version === VERSION && ship.lastOuting.lastCompletedLegId === voyageId) return ship.lastOuting;
    return null;
  }
  const existing = current(ship);
  if (existing.lastCompletedLegId === voyageId) return existing;
  if (existing.lastLegId !== voyageId) throw new Error("Завершённый участок не совпадает с текущим планом выхода.");
  const arrivedAtQd = integer(summary?.arrivedAtQd, "время прибытия");
  const from = text(summary?.from?.label, "Неизвестный порт") || "Неизвестный порт";
  const to = text(summary?.to?.label, "Неизвестный порт") || "Неизвестный порт";
  const home = summary?.to?.kind === "home";
  const returned = integer(summary?.returnedCopper ?? 0, "возвращённые средства");
  const report = update(ship, (next) => {
    next.completedLegs = add(next.completedLegs, 1, "завершённые участки");
    next.lastCompletedLegId = voyageId;
    if (home && returned > next.returnedCopper) next.returnedCopper = returned;
    appendDetail(next, { kind: home ? "outing-complete" : "leg-complete", clockQd: arrivedAtQd, amountCopper: 0, reason: `${from} → ${to}` });
    if (home) next.completedAtQd = arrivedAtQd;
  });
  if (!home) return report;
  ship.lastOuting = report;
  delete ship.currentOuting;
  return ship.lastOuting;
}

export const SHIP_OUTING_REPORT_VERSION = VERSION;
export const SHIP_OUTING_DETAIL_LIMIT = MAX_DETAILS;
