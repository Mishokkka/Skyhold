import { recordFleetFunds } from "./fleet-accounting.js";
import { applyShipFundsOperation } from "./funds.js";
import { attentionLabel, contractGuidance, resolveContractOutcome } from "./contracts.js";
import { getShipProfile, shipCapacityLoadPoints } from "./profiles.js";
import { bundleOperatingShares } from "./bundle-accounting.js";
import { beginShipOuting, ensurePartialShipOuting, planShipOutingLeg, planShipOutingBundleRewards, recordShipOutingFunds, completeShipOutingLeg } from "./outing-report.js";

const MAX_MONEY = 1_000_000_000;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function integer(value, name, min = 0, max = MAX_MONEY) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`Некорректное значение: ${name}.`);
  }
  return value;
}

function finiteNumber(value, name, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`Некорректное значение: ${name}.`);
  }
  return value;
}

function operationId(value) {
  const id = String(value ?? "").trim();
  if (!id || id.length > 128) throw new Error("Некорректный ID операции.");
  return id;
}

function clone(value) {
  return globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function endpoint(value, name) {
  if (!value || typeof value !== "object" || !["home", "market"].includes(value.kind)) {
    throw new Error(`Некорректный пункт: ${name}.`);
  }
  const id = String(value.id ?? "").trim().slice(0, 160);
  const label = String(value.label ?? "").trim().slice(0, 160);
  if (!id || FORBIDDEN_KEYS.has(id) || !label) throw new Error(`Некорректный пункт: ${name}.`);
  return {
    kind: value.kind,
    id,
    regionId: String(value.regionId ?? "").trim().slice(0, 160),
    label
  };
}

function sameEndpoint(left, right) {
  return left?.kind === right?.kind && String(left?.id ?? "") === String(right?.id ?? "");
}

function fundsFor(holding, ship) {
  return {
    settlementCopper: integer(holding?.storage?.moneyCopper, "казна поселения"),
    onboardCopper: integer(ship?.onboardCopper ?? 0, "бортовая казна"),
    status: ship?.status,
    receipts: Array.isArray(ship?.worldLedger) ? ship.worldLedger : []
  };
}

function writeFunds(holding, ship, state) {
  holding.storage.moneyCopper = state.settlementCopper;
  ship.onboardCopper = state.onboardCopper;
  ship.status = state.status;
  ship.worldLedger = state.receipts;
}

function pruneIdleLedger(ship) {
  if (!ship.activeVoyage && Array.isArray(ship.worldLedger) && ship.worldLedger.length > 200) {
    ship.worldLedger = ship.worldLedger.slice(-200);
  }
}

function applyFunds(holding, ship, operation, reason = "", clockQd = null) {
  const result = applyShipFundsOperation(fundsFor(holding, ship), operation);
  if (!result.replay && reason) result.receipt.reason = String(reason).trim().slice(0, 300);
  if (!result.replay) recordFleetFunds(ship, result.receipt, {
    clockQd: clockQd ?? worldShipTimelineQd(holding, ship),
    idle: reason === "Содержание корабля в порту" ? "port" : ""
  });
  if (!result.replay && !["depart", "deposit", "withdraw"].includes(operation.kind)) {
    const clock = clockQd ?? Math.max(holding.gm?.calendaria?.lastQd ?? 0, ship.activeVoyage?.lastProcessedQd ?? 0, ship.portBilling?.lastCalculatedQd ?? 0);
    ensurePartialShipOuting(ship, { voyageId: ship.activeVoyage?.id || String(operation.id).slice(0, 128), clockQd: clock });
    recordShipOutingFunds(ship, result.receipt, { clockQd: clock, reason });
  }
  writeFunds(holding, ship, result.state);
  return result;
}

function homeEndpoint(holding) {
  const id = String(holding?.id ?? "").trim();
  if (!id) throw new Error("У поселения отсутствует ID.");
  return {
    kind: "home",
    id,
    regionId: String(holding?.overview?.region ?? "").trim().slice(0, 160),
    label: String(holding?.name ?? "Поселение").trim().slice(0, 160) || "Поселение"
  };
}

/** Older saves have already accounted for time through the settlement date. */
export function worldShipTimelineQd(holding, ship) {
  const legacyClock = Math.max(
    Number(holding.gm?.calendaria?.lastQd ?? 0),
    Number(ship?.activeVoyage?.lastProcessedQd ?? 0),
    Number(ship?.portBilling?.lastCalculatedQd ?? 0)
  );
  return integer(ship?.timelineQd ?? legacyClock,
    "время корабля", 0, Number.MAX_SAFE_INTEGER);
}

function billing(scope, sinceQd, dailyCopper, carriedCopper = 0) {
  return {
    scope,
    sinceQd: integer(sinceQd, "начало стоянки", 0, Number.MAX_SAFE_INTEGER),
    dailyCopper: integer(dailyCopper, "дневные расходы стоянки"),
    chargedCopper: 0,
    carriedCopper: integer(carriedCopper, "долг стоянки"),
    lastCalculatedQd: integer(sinceQd, "начало стоянки", 0, Number.MAX_SAFE_INTEGER)
  };
}

function startIdleBilling(ship, location, clockQd) {
  const carried = integer(ship.pendingPortBillCopper ?? 0, "долг стоянки");
  const daily = location.kind === "home"
    ? (ship.homeUpkeepEnabled === false ? 0 : integer(ship.homeUpkeepCopperPerDay ?? 0, "домашнее содержание"))
    : integer(ship.idleUpkeepCopperPerDay ?? 0, "содержание в порту");
  ship.portBilling = billing(location.kind, clockQd, daily, carried);
}

function billingOutstanding(row, targetQd) {
  const effectiveQd = Math.max(row.sinceQd, integer(targetQd, "время", 0, Number.MAX_SAFE_INTEGER));
  const accrued = integer(Math.ceil(row.dailyCopper * (effectiveQd - row.sinceQd) / 4), "расходы стоянки");
  const total = integer(row.carriedCopper + accrued, "расходы стоянки");
  return { effectiveQd, total, outstanding: Math.max(0, total - row.chargedCopper) };
}

/** Read-only departure bill at the command's ship time, using the settlement calculation. */
export function worldShipPortDebtCopper(ship, targetQd) {
  return ship.portBilling ? billingOutstanding(ship.portBilling, targetQd).outstanding
    : integer(ship.pendingPortBillCopper ?? 0, "долг стоянки");
}

function settleIdleBilling(holding, ship, targetQd) {
  const row = ship.portBilling;
  if (!row) return { paidCopper: 0, pendingCopper: integer(ship.pendingPortBillCopper ?? 0, "долг стоянки") };
  const due = billingOutstanding(row, targetQd);
  row.lastCalculatedQd = Math.max(row.lastCalculatedQd, due.effectiveQd);
  if (!due.outstanding) {
    ship.pendingPortBillCopper = 0;
    return { paidCopper: 0, pendingCopper: 0 };
  }
  const available = row.scope === "home"
    ? integer(holding.storage.moneyCopper, "казна поселения") + integer(ship.onboardCopper ?? 0, "бортовой кошелёк")
    : integer(ship.onboardCopper, "бортовая казна");
  if (available < due.outstanding) {
    ship.pendingPortBillCopper = due.outstanding;
    return { paidCopper: 0, pendingCopper: due.outstanding };
  }
  const receiptId = `${ship.id}:idle:${row.scope}:${row.sinceQd}:${due.effectiveQd}:${row.chargedCopper}`;
  const onboardPaidCopper = row.scope === "home"
    ? Math.min(integer(ship.onboardCopper ?? 0, "бортовой кошелёк"), due.outstanding)
    : due.outstanding;
  const treasuryPaidCopper = due.outstanding - onboardPaidCopper;
  if (row.scope === "home") {
    const fromWallet = onboardPaidCopper;
    ship.onboardCopper -= fromWallet;
    holding.storage.moneyCopper -= due.outstanding - fromWallet;
    ship.worldLedger ??= [];
    ship.worldLedger.push({
      id: receiptId,
      signature: JSON.stringify(["home-upkeep", due.outstanding]),
      kind: "expense",
      externalDeltaCopper: -due.outstanding,
      transferToShipCopper: -fromWallet,
      reason: "Содержание корабля в поселении"
    });
    recordFleetFunds(ship, ship.worldLedger.at(-1), { clockQd: due.effectiveQd, idle: "home" });
  } else {
    applyFunds(holding, ship, { id: receiptId, kind: "expense", amountCopper: due.outstanding }, "Содержание корабля в порту", due.effectiveQd);
  }
  row.chargedCopper = due.total;
  ship.pendingPortBillCopper = 0;
  return { paidCopper: due.outstanding, treasuryPaidCopper, onboardPaidCopper, pendingCopper: 0 };
}

function normalizedQuote(ship, offer) {
  if (!offer || typeof offer !== "object" || offer.mode !== "world" || String(offer.shipId ?? "") !== ship.id) {
    throw new Error("Предложение относится к другому кораблю.");
  }
  const id = String(offer.id ?? "").trim().slice(0, 240);
  if (!id) throw new Error("У предложения отсутствует ID.");
  const from = endpoint(offer.from, "отправление");
  const to = endpoint(offer.to, "назначение");
  if (!sameEndpoint(from, ship.location)) throw new Error("Корабль находится в другом порту.");
  if (sameEndpoint(from, to)) throw new Error("Пункт назначения совпадает с текущим портом.");
  const source = offer.quote ?? {};
  const durationQd = integer(source.durationQd, "длительность", 1, 100_000);
  const operatingCopper = integer(source.operatingCopper, "расходы рейса");
  const preparationCopper = integer(source.preparationCopper ?? 0, "подготовка");
  const rewardCopper = integer(source.rewardCopper ?? 0, "награда");
  const recommendedBudgetCopper = integer(source.recommendedBudgetCopper ?? operatingCopper, "рекомендуемый бюджет");
  if (recommendedBudgetCopper < operatingCopper) throw new Error("Рекомендуемый бюджет меньше расходов рейса.");
  const contract = offer.contract == null ? null : clone(offer.contract);
  if (!contract && rewardCopper !== 0) throw new Error("Возвратный рейс не может обещать награду.");
  if (contract) {
    // Manual legacy contracts can omit a physical manifest. Generated cargo must fit at acceptance.
    if (contract.cargo != null) {
      const load = integer(contract.cargo.loadPoints, "груз контракта");
      if (load > shipCapacityLoadPoints(ship)
        || (contract.kind === "smuggling" && load > Number(ship.hiddenCapacityLoadPoints ?? 0))) {
        throw new Error("Кораблю не хватает вместимости для этого заказа.");
      }
    }
    if (contract.pickup) {
      contract.pickup = endpoint(contract.pickup, "погрузка");
      if (contract.pickup.kind !== "market" || contract.pickup.regionId === from.regionId
        || contract.pickup.regionId === to.regionId) throw new Error("Некорректный порт погрузки.");
    }
    if (contract.rewardCopper !== rewardCopper) throw new Error("Награда контракта изменилась.");
    const direction = String(contract.directionKey ?? "").trim();
    if (!direction || FORBIDDEN_KEYS.has(direction)) throw new Error("Некорректное направление внимания.");
    const guidance = contractGuidance(contract, "normal");
    if (guidance.operatingCopper !== operatingCopper || guidance.preparationCopper !== preparationCopper) {
      throw new Error("Расходы контракта изменились.");
    }
  }
  const costs = source.costs && typeof source.costs === "object" ? clone(source.costs) : { totalCopper: operatingCopper };
  const costTotal = integer(costs.totalCopper ?? costs.operatingCopper ?? operatingCopper, "итог расходов");
  if (costTotal !== operatingCopper) throw new Error("Разбивка расходов не совпадает с итогом.");
  const idleUpkeepCopperPerDay = integer(source.idleUpkeepCopperPerDay ?? 0, "содержание в порту");
  return deepFreeze({
    offerId: id,
    period: String(offer.period ?? "").trim().slice(0, 80),
    from,
    to,
    durationQd,
    distanceKm: finiteNumber(source.distanceKm, "расстояние", 1, 1_000_000),
    speedKmPerDay: integer(source.speedKmPerDay, "скорость", 1, 10_000),
    operatingCopper,
    preparationCopper,
    rewardCopper,
    costs,
    idleUpkeepCopperPerDay,
    idleReserveCopper: integer(source.idleReserveCopper ?? idleUpkeepCopperPerDay * 2, "резерв стоянки"),
    recommendedBudgetCopper,
    returnReserveCopper: integer(source.returnReserveCopper ?? 0, "резерв на возвращение"),
    contract
  });
}

function ensureWorldReady(ship, bundleId = null) {
  if (ship?.navigationMode !== "world") throw new Error("Корабль ещё не подключён к мировому рынку.");
  if (ship?.condition !== "ready" || ship?.activeVoyage) throw new Error("Корабль занят или требует ремонта.");
  if (ship.orderBundle && ship.orderBundle.id !== bundleId) throw new Error("Сначала завершите принятые составные заказы.");
  if (!ship.location || !["home", "market"].includes(ship.location.kind)) throw new Error("Неизвестно местоположение корабля.");
}

/** Explicitly adopt an idle, home ship into the world-route model. */
export function initializeWorldShip(holding, ship, { profileId, clockQd }) {
  const clock = integer(clockQd, "время", 0, Number.MAX_SAFE_INTEGER);
  if (!ship || typeof ship !== "object" || !String(ship.id ?? "").trim()) throw new Error("У корабля отсутствует ID.");
  if (ship.navigationMode === "world") throw new Error("Корабль уже подключён к мировому рынку.");
  if (ship.activeVoyage || ship.status !== "docked") throw new Error("Подключить можно только свободный корабль в поселении.");
  if (integer(ship.onboardCopper ?? 0, "бортовая казна") !== 0) throw new Error("В поселении бортовая казна должна быть общей.");
  const profile = getShipProfile(profileId);
  ship.navigationMode = "world";
  ship.profileId = profile.id;
  for (const field of ["speedKmPerDay", "crewTarget", "capacityLoadPoints", "cargoTonnes"]) {
    if (ship[field] === null || ship[field] === undefined || ship[field] === 0) ship[field] = profile[field];
  }
  ship.location = homeEndpoint(holding);
  ship.timelineQd = clock;
  ship.worldLedger = Array.isArray(ship.worldLedger) ? ship.worldLedger : [];
  ship.pendingPortBillCopper = integer(ship.pendingPortBillCopper ?? 0, "долг стоянки");
  ship.homeUpkeepCopperPerDay = integer(ship.homeUpkeepCopperPerDay ?? profile.upkeepDailyCopper, "домашнее содержание");
  ship.idleUpkeepCopperPerDay = integer(ship.idleUpkeepCopperPerDay ?? profile.upkeepDailyCopper, "содержание в порту");
  startIdleBilling(ship, ship.location, clock);
  return { shipId: ship.id, profileId: profile.id, location: clone(ship.location), clockQd: clock };
}

/** Call only inside an authorized transaction or on a detached tenday snapshot. */
export function departWorldShip(holding, ship, {
  operationId: suppliedOperationId,
  offer,
  style = "normal",
  budgetCopper = null,
  clockQd,
  bundleId = null
}) {
  ensureWorldReady(ship, bundleId);
  const id = operationId(suppliedOperationId);
  const clock = integer(clockQd, "время", 0, Number.MAX_SAFE_INTEGER);
  if (clock < worldShipTimelineQd(holding, ship)) throw new Error("Приказ не может вернуться в прошлое корабля.");
  const quote = normalizedQuote(ship, offer);
  const idle = settleIdleBilling(holding, ship, clock);
  if (idle.pendingCopper > 0) {
    return { ok: false, blocked: true, shipId: ship.id, pendingPortBillCopper: idle.pendingCopper };
  }
  const isHome = ship.location.kind === "home";
  let budget = budgetCopper == null ? quote.recommendedBudgetCopper : integer(budgetCopper, "бортовой бюджет");
  if (budgetCopper == null && quote.contract) {
    const styledMinimum = integer(
      contractGuidance(quote.contract, style).suggestedBudgetCopper
        + quote.returnReserveCopper
        + quote.idleReserveCopper,
      "рекомендуемый бюджет"
    );
    budget = Math.max(budget, styledMinimum);
  }
  if (isHome) {
    if (budget < quote.operatingCopper) throw new Error("Бортового бюджета недостаточно для плановых расходов рейса.");
    const funding = applyFunds(holding, ship, {
      id,
      kind: "depart",
      amountCopper: budget,
      preparationCopper: quote.preparationCopper
    }, "Передача рейсового бюджета на борт");
    beginShipOuting(ship, { voyageId: id, clockQd: clock, budgetCopper: ship.onboardCopper, preparationCopper: quote.preparationCopper });
    if (!funding.replay) recordShipOutingFunds(ship, funding.receipt, { clockQd: clock, reason: "Подготовка к выходу" });
  } else if (ship.onboardCopper < quote.operatingCopper) {
    return { ok: false, blocked: true, shipId: ship.id, pendingPortBillCopper: 0, requiredCopper: quote.operatingCopper };
  }
  const ledgerStart = Math.max(0, ship.worldLedger.length - (isHome ? 1 : 0));
  applyFunds(holding, ship, {
    id: `${id}:operating`,
    kind: "expense",
    amountCopper: quote.operatingCopper
  }, `Автоматические расходы: ${quote.from.label} — ${quote.to.label}`, clock);
  ship.idleUpkeepCopperPerDay = quote.idleUpkeepCopperPerDay;
  ship.pendingPortBillCopper = 0;
  ship.portBilling = null;
  ship.location = {
    kind: "transit",
    id: `${quote.from.id}:${quote.to.id}`.slice(0, 160),
    regionId: "",
    label: `${quote.from.label} — ${quote.to.label}`.slice(0, 160)
  };
  ship.activeVoyage = {
    id,
    mode: "world",
    style,
    quote,
    startedAtQd: clock,
    arrivalQd: integer(clock + quote.durationQd, "прибытие", 0, Number.MAX_SAFE_INTEGER),
    lastProcessedQd: clock,
    elapsedQd: 0,
    remainingQd: quote.durationQd,
    ledgerStart
  };
  ship.timelineQd = clock;
  planShipOutingLeg(ship, ship.activeVoyage);
  return {
    ok: true,
    voyageId: id,
    onboardCopper: ship.onboardCopper,
    durationQd: quote.durationQd,
    arrivalQd: ship.activeVoyage.arrivalQd
  };
}

/** Accept all contracts together, then fly only the first physical leg. */
export function departWorldShipBundle(holding, ship, { operationId: suppliedOperationId, plan, style = "normal", budgetCopper = null, clockQd }) {
  const id = operationId(suppliedOperationId);
  if (ship?.orderBundle || !Array.isArray(plan?.offers) || plan.offers.length < 2 || plan.offers.length > 3
    || !Array.isArray(plan.stops) || !plan.stops.length) throw new Error("Некорректный составной рейс.");
  const capacity = shipCapacityLoadPoints(ship);
  const plannedLoads = [plan.initialLoadPoints ?? 0, ...plan.stops.flatMap((stop) => [stop.loadOnLegPoints ?? 0, stop.loadAfterPoints ?? 0]),
    ...plan.offers.map((offer) => offer.contract?.cargo?.loadPoints ?? 0)];
  if (plannedLoads.some((load) => integer(load, "груз составного рейса") > capacity)
    || plan.offers.some((offer) => offer.contract?.kind === "smuggling"
      && offer.contract.cargo.loadPoints > Number(ship.hiddenCapacityLoadPoints ?? 0))) {
    throw new Error("Кораблю не хватает вместимости для составного рейса.");
  }
  const first = clone(plan.stops[0].legOffer);
  first.id = `${id}:leg:0`;
  const departure = departWorldShip(holding, ship, { operationId: id, offer: first, style, budgetCopper, clockQd });
  if (!departure.ok) return departure;
  const orders = plan.offers.map((offer) => ({
    offerId: offer.id, offer: clone(offer), style,
    state: offer.contract.pickup ? "waiting-pickup" : "loaded",
    outcome: null, outcomeApplied: false, deliveredAtQd: null
  }));
  ship.orderBundle = {
    id, orders, stops: clone(plan.stops), nextStopIndex: 0, status: "travelling",
    totalDurationQd: plan.totalDurationQd, totalOperatingCopper: plan.totalOperatingCopper,
    recommendedBudgetCopper: plan.recommendedBudgetCopper,
    returnReserveCopper: plan.returnReserveCopper, idleReserveCopper: plan.idleReserveCopper,
    delayUntilQd: null
  };
  planShipOutingBundleRewards(ship, {
    rewardCopper: integer(orders.reduce((sum, order) => sum + order.offer.contract.rewardCopper, 0), "плата составного рейса"),
    clockQd
  });
  return { ...departure, bundleId: id, orderCount: orders.length, stopCount: plan.stops.length };
}

/** Resume a frozen leg from a real port after resolving deliveries there. */
export function continueWorldShipBundle(holding, ship, { operationId: suppliedOperationId, bundleId, clockQd }) {
  const id = operationId(suppliedOperationId);
  const bundle = ship?.orderBundle;
  if (!bundle || bundle.id !== bundleId || bundle.status !== "at-port" || ship.activeVoyage) {
    throw new Error("Корабль не готов к следующему участку составного рейса.");
  }
  const clock = integer(clockQd, "время", 0, Number.MAX_SAFE_INTEGER);
  if (bundle.delayUntilQd != null && clock < bundle.delayUntilQd) {
    throw new Error("Корабль задержан в порту до окончания происшествия.");
  }
  const next = bundle.stops[bundle.nextStopIndex];
  if (!next) throw new Error("Все заказы составного рейса уже доставлены.");
  const leg = clone(next.legOffer);
  leg.id = `${bundle.id}:leg:${bundle.nextStopIndex}`;
  if (!sameEndpoint(leg.from, ship.location)) throw new Error("Корабль находится не в запланированном порту.");
  const result = departWorldShip(holding, ship, { operationId: id, offer: leg, style: "normal", clockQd: clock, bundleId });
  if (result.ok) {
    bundle.status = "travelling";
    bundle.delayUntilQd = null;
  }
  return { ...result, bundleId, stopIndex: bundle.nextStopIndex };
}

function drawDie(random, sides) {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError("Генератор случайных чисел вернул значение вне диапазона 0–1.");
  }
  return Math.floor(value * sides) + 1;
}

function outcomeDice(random) {
  return { commercialDice: [drawDie(random, 6), drawDie(random, 6)], incidentRoll: drawDie(random, 12) };
}

function attentionChange(ship, contract, outcome, clockQd) {
  const key = String(contract.directionKey ?? "").trim();
  if (!key || FORBIDDEN_KEYS.has(key)) throw new Error("Некорректное направление внимания.");
  const map = ship.attentionByDirection && typeof ship.attentionByDirection === "object" ? ship.attentionByDirection : {};
  const prior = Object.prototype.hasOwnProperty.call(map, key) ? map[key] : 0;
  const raw = prior && typeof prior === "object" ? prior.level : prior;
  const before = Number.isSafeInteger(raw) ? Math.max(0, Math.min(10, raw)) : 0;
  const after = Math.max(0, Math.min(10, before + outcome.attentionDelta));
  return {
    key,
    before,
    after,
    record: {
      level: after,
      label: attentionLabel(after),
      updatedAtQd: clockQd,
      reason: `${outcome.commercialLabel}; ${outcome.eventLabel}`
    }
  };
}

function appendHistory(holding, summary) {
  const collection = holding.special?.ships;
  if (!collection) throw new Error("В поселении отсутствует реестр кораблей.");
  collection.history = [...(collection.history ?? []), summary].slice(-100);
}

function finalizeArrival(holding, ship, arrivalQd) {
  const voyage = ship.activeVoyage;
  const bundle = ship.orderBundle?.status === "travelling" ? ship.orderBundle : null;
  const destination = clone(voyage.quote.to);
  const stop = bundle?.stops?.[bundle.nextStopIndex];
  if (bundle && (!sameEndpoint(stop?.point, destination) || stop.pickupOfferIds.some((offerId) =>
    !bundle.orders.some((order) => order.offerId === offerId && order.state === "waiting-pickup")))) {
    throw new Error("Маршрут составного рейса изменился.");
  }
  ensurePartialShipOuting(ship, { voyageId: voyage.id, clockQd: arrivalQd });
  const home = destination.kind === "home";
  const ledgerEndBeforeReturn = ship.worldLedger.length;
  let returnedCopper = 0;
  if (home) {
    returnedCopper = ship.onboardCopper;
    applyFunds(holding, ship, { id: `${voyage.id}:return`, kind: "return", amountCopper: 0 }, "Возвращение бортовой казны в поселение", arrivalQd);
  } else {
    ship.status = "away";
  }
  const summary = {
    id: voyage.id,
    mode: "world",
    shipId: ship.id,
    shipName: ship.name,
    from: clone(voyage.quote.from),
    to: destination,
    startedAtQd: voyage.startedAtQd,
    arrivedAtQd: arrivalQd,
    returnedCopper,
    netCopper: ship.worldLedger.slice(voyage.ledgerStart, home ? ship.worldLedger.length : ledgerEndBeforeReturn)
      .reduce((total, row) => total + integer(Math.abs(row.externalDeltaCopper ?? 0), "операция") * Math.sign(row.externalDeltaCopper ?? 0), 0),
    ledger: clone(ship.worldLedger.slice(voyage.ledgerStart, home ? ship.worldLedger.length : ledgerEndBeforeReturn))
  };
  if (voyage.quote.contract) {
    summary.contract = clone(voyage.quote.contract);
    summary.style = voyage.style;
    summary.outcome = clone(voyage.outcome);
    summary.attention = clone(voyage.attentionChange);
  }
  completeShipOutingLeg(ship, summary);
  ship.location = destination;
  ship.activeVoyage = null;
  ship.timelineQd = arrivalQd;
  if (bundle) {
    for (const offerId of stop.pickupOfferIds) {
      const order = bundle.orders.find((row) => row.offerId === offerId);
      order.state = "loaded";
    }
    bundle.nextStopIndex++;
    bundle.status = stop.deliveryOfferIds.length ? "awaiting-outcome" : "at-port";
  }
  appendHistory(holding, summary);
  startIdleBilling(ship, destination, arrivalQd);
  ship.portBilling.lastCalculatedQd = Math.max(arrivalQd, Number(holding.gm?.calendaria?.lastQd ?? arrivalQd));
  pruneIdleLedger(ship);
  return { summary, home, location: clone(destination) };
}

/** Resolve one arrived world-market contract. The random result is saved before any funding check. */
export function resolveWorldShip(holding, ship, { operationId: suppliedOperationId, random = Math.random }) {
  operationId(suppliedOperationId);
  const voyage = ship?.activeVoyage;
  if (ship?.navigationMode !== "world" || ship?.status !== "away" || voyage?.mode !== "world"
    || !voyage?.quote?.contract || (!voyage.awaitingOutcome && !(voyage.outcome && !voyage.outcomeApplied))) {
    throw new Error("Корабль не ожидает исхода контракта.");
  }
  const clockQd = worldShipTimelineQd(holding, ship);
  settleIdleBilling(holding, ship, clockQd);
  if (!voyage.outcome) {
    voyage.outcome = resolveContractOutcome(voyage.quote.contract, voyage.style, outcomeDice(random));
    voyage.outcomeOperationId = suppliedOperationId;
  }
  const outcome = voyage.outcome;
  integer(outcome.expenseCopper, "расходы исхода");
  integer(outcome.rewardCopper, "награда исхода");
  integer(outcome.delayQd, "задержка", 0, 100_000);
  const attention = attentionChange(ship, voyage.quote.contract, outcome, clockQd);
  if (ship.onboardCopper < outcome.expenseCopper) {
    voyage.awaitingOutcome = true;
    voyage.waitingFunds = true;
    return {
      voyageId: voyage.id,
      pending: true,
      waitingFunds: true,
      outcome: clone(outcome),
      arrived: null,
      delayQd: outcome.delayQd,
      pendingPortBillCopper: ship.pendingPortBillCopper
    };
  }
  applyFunds(holding, ship, {
    id: `${voyage.id}:contract-expense`,
    kind: "expense",
    amountCopper: outcome.expenseCopper
  }, outcome.eventLabel, clockQd);
  applyFunds(holding, ship, {
    id: `${voyage.id}:contract-reward`,
    kind: "income",
    amountCopper: outcome.rewardCopper
  }, outcome.commercialLabel, clockQd);
  ship.attentionByDirection ??= {};
  Object.defineProperty(ship.attentionByDirection, attention.key, {
    value: attention.record,
    writable: true,
    enumerable: true,
    configurable: true
  });
  voyage.attentionChange = {
    directionKey: attention.key,
    before: attention.before,
    after: attention.after,
    delta: attention.after - attention.before,
    reason: attention.record.reason
  };
  voyage.outcomeApplied = true;
  voyage.awaitingOutcome = false;
  voyage.waitingFunds = false;
  if (outcome.delayQd > 0) {
    // Waiting before the authorized outcome was ordinary port idle time. The event's
    // own delay upkeep is already part of outcome.expenseCopper.
    ship.portBilling = null;
    voyage.durationQd = integer(voyage.quote.durationQd + outcome.delayQd, "длительность с задержкой", 1, 100_100);
    voyage.elapsedQd = voyage.quote.durationQd;
    voyage.remainingQd = outcome.delayQd;
    voyage.lastProcessedQd = clockQd;
    voyage.arrivalQd = integer(clockQd + outcome.delayQd, "прибытие", 0, Number.MAX_SAFE_INTEGER);
    return {
      voyageId: voyage.id,
      pending: false,
      waitingFunds: false,
      outcome: clone(outcome),
      arrived: null,
      delayQd: outcome.delayQd,
      pendingPortBillCopper: ship.pendingPortBillCopper
    };
  }
  const completed = finalizeArrival(holding, ship, clockQd);
  return {
    voyageId: completed.summary.id,
    pending: false,
    waitingFunds: false,
    outcome: clone(outcome),
    arrived: completed.summary,
    returned: completed.home ? completed.summary : null,
    delayQd: 0,
    pendingPortBillCopper: ship.pendingPortBillCopper
  };
}

/** Resolve only deliveries at the current stop; each fee and roll is saved separately. */
export function resolveWorldShipBundleStop(holding, ship, { operationId: suppliedOperationId, bundleId, random = Math.random }) {
  operationId(suppliedOperationId);
  const bundle = ship?.orderBundle;
  if (!bundle || bundle.id !== bundleId || bundle.status !== "awaiting-outcome" || ship.activeVoyage
    || ship.location?.kind !== "market") throw new Error("Здесь нет заказов для подведения итогов.");
  const stop = bundle.stops[bundle.nextStopIndex - 1];
  if (!sameEndpoint(stop?.point, ship.location)) throw new Error("Корабль находится не в порту доставки.");
  const clockQd = worldShipTimelineQd(holding, ship);
  settleIdleBilling(holding, ship, clockQd);
  const due = stop.deliveryOfferIds.map((offerId) => bundle.orders.find((row) => row.offerId === offerId));
  if (due.some((order) => !order || order.state !== "loaded" && order.state !== "delivered")) {
    throw new Error("Состав груза в порту не совпадает с планом.");
  }
  due.sort((a, b) => Number(b.offer.contract.kind === "smuggling") - Number(a.offer.contract.kind === "smuggling")
    || a.offerId.localeCompare(b.offerId));
  const shares = bundleOperatingShares(bundle.orders.map((order) => order.offer), bundle.totalOperatingCopper);
  const completedOrders = [];
  for (const [index, order] of due.entries()) {
    if (order.outcomeApplied) continue;
    if (!order.outcome) {
      const share = shares[bundle.orders.indexOf(order)];
      const contract = clone(order.offer.contract);
      contract.guidance = { ...contract.guidance, operatingCopper: share, preparationCopper: 0 };
      const dice = index === 0 ? outcomeDice(random) : {
        commercialDice: [drawDie(random, 6), drawDie(random, 6)],
        incidentRoll: due[0].outcome.incidentRoll
      };
      order.outcome = resolveContractOutcome(contract, order.style, { ...dice, commercialOnly: index > 0,
        sharedPassageAllowsBonus: index === 0 || Number(due[0].outcome.effectiveIncidentRoll) >= 8 });
    }
    const outcome = order.outcome;
    integer(outcome.expenseCopper, "расходы исхода");
    integer(outcome.rewardCopper, "плата заказа");
    if (ship.onboardCopper < outcome.expenseCopper) {
      bundle.waitingFunds = true;
      return { bundleId, pending: true, waitingFunds: true, requiredCopper: outcome.expenseCopper - ship.onboardCopper,
        completedOrders, pendingPortBillCopper: ship.pendingPortBillCopper ?? 0 };
    }
    applyFunds(holding, ship, { id: `${bundle.id}:${order.offerId}:expense`, kind: "expense", amountCopper: outcome.expenseCopper },
      outcome.eventLabel, clockQd);
    applyFunds(holding, ship, { id: `${bundle.id}:${order.offerId}:reward`, kind: "income", amountCopper: outcome.rewardCopper },
      outcome.commercialLabel, clockQd);
    const attention = attentionChange(ship, order.offer.contract, outcome, clockQd);
    ship.attentionByDirection ??= {};
    Object.defineProperty(ship.attentionByDirection, attention.key, {
      value: attention.record, writable: true, enumerable: true, configurable: true
    });
    order.attentionChange = {
      directionKey: attention.key, before: attention.before, after: attention.after,
      delta: attention.after - attention.before, reason: attention.record.reason
    };
    order.outcomeApplied = true;
    order.state = "delivered";
    order.deliveredAtQd = clockQd;
    completedOrders.push(order.offerId);
    appendHistory(holding, {
      id: `${bundle.id}:${order.offerId}`, mode: "world",
      shipId: ship.id, shipName: ship.name, from: clone(order.offer.from), to: clone(order.offer.to),
      contract: clone(order.offer.contract), style: order.style, outcome: clone(outcome),
      attention: clone(order.attentionChange), arrivedAtQd: clockQd,
      netCopper: outcome.rewardCopper - outcome.expenseCopper
    });
  }
  bundle.waitingFunds = false;
  const delayQd = Math.max(0, ...due.map((order) => Number(order.outcome?.delayQd ?? 0)));
  if (delayQd) {
    bundle.delayUntilQd = integer(clockQd + delayQd, "окончание задержки", 0, Number.MAX_SAFE_INTEGER);
    const carried = integer(ship.pendingPortBillCopper ?? 0, "долг стоянки");
    const daily = integer(ship.portBilling?.dailyCopper ?? ship.idleUpkeepCopperPerDay ?? 0, "содержание в порту");
    ship.portBilling = billing("market", bundle.delayUntilQd, daily, carried);
  }
  if (bundle.nextStopIndex >= bundle.stops.length) {
    if (delayQd) bundle.status = "final-delay";
    else ship.orderBundle = null;
  } else bundle.status = "at-port";
  return { bundleId, pending: false, waitingFunds: false, completedOrders, delayQd,
    delayUntilQd: bundle.delayUntilQd, finished: !ship.orderBundle };
}

/** Advance deterministic world travel and idle upkeep. This function never rolls outcomes. */
export function advanceWorldShips(holding, targetQd, { shipId = null } = {}) {
  const target = integer(targetQd, "время", 0, Number.MAX_SAFE_INTEGER);
  const report = { returned: [], arrived: [], underway: [], awaiting: [], blocked: [], expenses: [] };
  for (const ship of holding.special?.ships?.list ?? []) {
    if (ship?.navigationMode !== "world" || (shipId && ship.id !== shipId)) continue;
    try {
      const timeline = worldShipTimelineQd(holding, ship);
      if (target < timeline) throw new Error("Дата поселения раньше уже обработанного времени корабля.");
      ship.timelineQd = timeline;
      const voyage = ship.activeVoyage;
      if (!voyage) {
        if (ship.orderBundle?.status === "travelling") {
          report.blocked.push({ shipId: ship.id, name: ship.name, message: "У составного рейса отсутствует текущий участок." });
          continue;
        }
        if (ship.orderBundle?.status === "final-delay" && target >= ship.orderBundle.delayUntilQd) {
          ship.timelineQd = ship.orderBundle.delayUntilQd;
          ship.orderBundle = null;
          if (ship.portBilling) ship.portBilling.lastCalculatedQd = Math.max(ship.portBilling.lastCalculatedQd, target);
          continue;
        }
        if (ship.orderBundle) {
          if (ship.portBilling && target > ship.portBilling.lastCalculatedQd) {
            const expense = settleIdleBilling(holding, ship, target);
            ship.timelineQd = target;
            if (expense.paidCopper) report.expenses.push({ shipId: ship.id, name: ship.name, amountCopper: expense.paidCopper, treasuryPaidCopper: expense.treasuryPaidCopper, onboardPaidCopper: expense.onboardPaidCopper, scope: ship.location?.kind });
            if (expense.pendingCopper) report.blocked.push({ shipId: ship.id, name: ship.name, message: "Недостаточно средств для содержания корабля.", pendingPortBillCopper: expense.pendingCopper });
          }
          continue;
        }
        const expense = settleIdleBilling(holding, ship, target);
        ship.timelineQd = target;
        if (expense.paidCopper) report.expenses.push({ shipId: ship.id, name: ship.name, amountCopper: expense.paidCopper, treasuryPaidCopper: expense.treasuryPaidCopper, onboardPaidCopper: expense.onboardPaidCopper, scope: ship.location?.kind });
        if (expense.pendingCopper) report.blocked.push({ shipId: ship.id, name: ship.name, message: "Недостаточно средств для содержания корабля.", pendingPortBillCopper: expense.pendingCopper });
        pruneIdleLedger(ship);
        continue;
      }
      if (voyage.mode !== "world") continue;
      integer(voyage.lastProcessedQd, "обработанное время", 0, Number.MAX_SAFE_INTEGER);
      if (voyage.awaitingOutcome) {
        if (!ship.portBilling) startIdleBilling(ship, voyage.quote.to, voyage.arrivalQd);
        if (target > ship.portBilling.lastCalculatedQd) {
          const expense = settleIdleBilling(holding, ship, target);
          ship.timelineQd = target;
          if (expense.paidCopper) report.expenses.push({ shipId: ship.id, name: ship.name, amountCopper: expense.paidCopper, treasuryPaidCopper: expense.treasuryPaidCopper, onboardPaidCopper: expense.onboardPaidCopper, scope: ship.location?.kind });
          if (expense.pendingCopper) report.blocked.push({ shipId: ship.id, name: ship.name, message: "Недостаточно средств для содержания корабля.", pendingPortBillCopper: expense.pendingCopper });
        }
        report.awaiting.push({
          shipId: ship.id,
          name: ship.name,
          plannedArrivalQd: voyage.arrivalQd,
          waitingFunds: Boolean(voyage.waitingFunds),
          pendingPortBillCopper: ship.pendingPortBillCopper ?? 0
        });
        continue;
      }
      if (target <= voyage.lastProcessedQd) continue;
      const elapsedDelta = target - voyage.lastProcessedQd;
      const durationQd = integer(voyage.durationQd ?? voyage.quote.durationQd, "длительность", 1, 100_100);
      const elapsedQd = Math.min(durationQd, integer(voyage.elapsedQd, "прогресс", 0, durationQd) + elapsedDelta);
      if (elapsedQd < durationQd) {
        voyage.elapsedQd = elapsedQd;
        voyage.remainingQd = durationQd - elapsedQd;
        voyage.lastProcessedQd = target;
        ship.timelineQd = target;
        voyage.arrivalQd = integer(target + voyage.remainingQd, "прибытие", 0, Number.MAX_SAFE_INTEGER);
        report.underway.push({ shipId: ship.id, name: ship.name, arrivalQd: voyage.arrivalQd, remainingQd: voyage.remainingQd });
        continue;
      }
      const arrivalQd = voyage.lastProcessedQd + durationQd - voyage.elapsedQd;
      voyage.elapsedQd = durationQd;
      voyage.remainingQd = 0;
      voyage.lastProcessedQd = arrivalQd;
      ship.timelineQd = arrivalQd;
      voyage.arrivalQd = arrivalQd;
      if (voyage.quote.contract && !voyage.outcomeApplied) {
        voyage.awaitingOutcome = true;
        voyage.arrivedAtQd = arrivalQd;
        ship.location = clone(voyage.quote.to);
        startIdleBilling(ship, voyage.quote.to, arrivalQd);
        ship.portBilling.lastCalculatedQd = target;
        report.awaiting.push({
          shipId: ship.id,
          name: ship.name,
          plannedArrivalQd: arrivalQd,
          waitingFunds: false,
          pendingPortBillCopper: ship.pendingPortBillCopper ?? 0
        });
        continue;
      }
      const completed = finalizeArrival(holding, ship, arrivalQd);
      ship.portBilling.lastCalculatedQd = Math.max(ship.portBilling.lastCalculatedQd, target);
      const arrival = { shipId: ship.id, name: ship.name, arrivalQd, location: completed.location, summary: completed.summary };
      report.arrived.push(arrival);
      if (completed.home) report.returned.push(arrival);
    } catch (error) {
      report.blocked.push({ shipId: ship?.id, name: ship?.name, message: error.message });
    }
  }
  return report;
}

/** Record an authorized expense or income while a world ship is away. */
export function adjustWorldShipFunds(holding, ship, {
  operationId: suppliedOperationId,
  voyageId = null,
  kind,
  amountCopper,
  reason
}) {
  if (ship?.navigationMode !== "world") throw new Error("Корабль не подключён к мировому рынку.");
  if (["deposit", "withdraw"].includes(kind)) {
    if (ship.status !== "docked" || ship.location?.kind !== "home" || ship.activeVoyage || ship.orderBundle) throw new Error("Перевод доступен только дома между рейсами.");
    const amount = integer(amountCopper, "сумма", 1);
    applyFunds(holding, ship, { id: operationId(suppliedOperationId), kind, amountCopper: amount }, kind === "deposit" ? "Перевод из казны на корабль" : "Перевод с корабля в казну");
    const clockQd = Math.max(worldShipTimelineQd(holding, ship), ship.portBilling?.lastCalculatedQd ?? 0);
    const bill = settleIdleBilling(holding, ship, clockQd);
    return { shipId: ship.id, onboardCopper: ship.onboardCopper, pendingPortBillCopper: bill.pendingCopper, paidPortBillCopper: bill.paidCopper };
  }
  if (ship.status !== "away") throw new Error("Расходы и поступления проводятся только вне поселения.");
  const currentId = ship.orderBundle?.id ?? ship.activeVoyage?.id ?? "";
  if (String(voyageId ?? "") !== String(currentId)) throw new Error("Этот рейс уже завершён или изменился.");
  if (!["expense", "income"].includes(kind)) throw new Error("Неизвестная денежная операция.");
  const note = String(reason ?? "").trim();
  if (!note) throw new Error("Укажите причину операции.");
  const amount = integer(amountCopper, "сумма");
  const clockQd = worldShipTimelineQd(holding, ship);
  applyFunds(holding, ship, { id: operationId(suppliedOperationId), kind, amountCopper: amount }, note, clockQd);
  const billingQd = Math.max(clockQd, ship.portBilling?.lastCalculatedQd ?? 0);
  const bill = settleIdleBilling(holding, ship, billingQd);
  return {
    shipId: ship.id,
    voyageId: currentId || null,
    onboardCopper: ship.onboardCopper,
    pendingPortBillCopper: integer(ship.pendingPortBillCopper ?? 0, "долг стоянки"),
    paidPortBillCopper: bill.paidCopper
  };
}
