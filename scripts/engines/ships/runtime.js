import { recordFleetFunds } from "./fleet-accounting.js";
import { planShipVoyage } from "./voyage.js";
import { applyShipFundsOperation } from "./funds.js";
import { attentionLabel, contractGuidance, resolveContractOutcome } from "./contracts.js";

function whole(value, name, max = 1_000_000_000) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new RangeError(`Некорректное значение: ${name}.`);
  return value;
}

export function quoteShipDeparture(ship) {
  const route = ship?.routePlan ?? {};
  const destination = String(route.destination ?? "").trim();
  if (!destination) throw new Error("Укажите пункт назначения.");
  const distanceKm = whole(route.distanceKm, "расстояние", 1_000_000);
  if (!distanceKm) throw new Error("Расстояние должно быть больше нуля.");
  const portDays = whole(route.portDays ?? 0, "дни в порту", 1000);
  const speedKmPerDay = whole(ship.speedKmPerDay, "скорость", 10000);
  const upkeepPerDayCopper = whole(route.upkeepPerDayCopper ?? 0, "содержание");
  const preparationCopper = whole(route.preparationCopper ?? 0, "подготовка");
  const rewardCopper = whole(route.rewardCopper ?? 0, "награда");
  const legs = [{ type: "flight", distanceMeters: distanceKm * 1000 }, { type: "port", durationQd: portDays * 4 }, { type: "flight", distanceMeters: distanceKm * 1000 }];
  const plan = planShipVoyage({ legs, startQd: 0, speedKmPerDay });
  whole(plan.durationQd, "длительность", 100000);
  const operatingCopper = whole(Math.ceil(upkeepPerDayCopper * plan.durationQd / 4), "расходы рейса");
  return { destination, distanceKm, portDays, speedKmPerDay, legs, durationQd: plan.durationQd, operatingCopper, preparationCopper, rewardCopper };
}

function fundsFor(holding, ship) {
  return { settlementCopper: holding.storage.moneyCopper, onboardCopper: ship.onboardCopper, status: ship.status, receipts: ship.activeVoyage?.ledger ?? [] };
}

function writeFunds(holding, ship, state) {
  const recorded = new Set((ship.activeVoyage?.ledger ?? []).map((row) => row.id));
  for (const receipt of state.receipts) if (!recorded.has(receipt.id)) {
    recordFleetFunds(ship, receipt, { clockQd: ship.activeVoyage?.lastProcessedQd ?? holding.gm?.calendaria?.lastQd ?? 0 });
  }
  holding.storage.moneyCopper = state.settlementCopper;
  ship.onboardCopper = state.onboardCopper;
  ship.status = state.status;
  ship.activeVoyage.ledger = state.receipts;
}

function clone(value) {
  return globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function contractQuote(ship, offer, style) {
  if (!offer || typeof offer !== "object" || offer.shipId !== ship.id) throw new Error("Предложение относится к другому кораблю.");
  if (!String(offer.directionKey ?? "").trim() || ["__proto__", "prototype", "constructor"].includes(offer.directionKey)) throw new Error("Некорректное направление предложения.");
  const guidance = contractGuidance(offer, style);
  const quoted = quoteShipDeparture({ speedKmPerDay: whole(offer.speedKmPerDay, "скорость предложения", 10000), routePlan: offer.routePlan });
  if (quoted.durationQd !== offer.durationQd
    || quoted.operatingCopper !== guidance.operatingCopper
    || quoted.preparationCopper !== guidance.preparationCopper
    || quoted.rewardCopper !== offer.rewardCopper) throw new Error("Условия предложения повреждены или изменились.");
  quoted.contract = clone(offer);
  quoted.style = style;
  return quoted;
}

/** Call only inside an authorized transaction or on a detached tenday snapshot. */
export function departShip(holding, ship, { operationId, budgetCopper, clockQd, offer = null, style = "normal" }) {
  if (ship.status !== "docked" || ship.activeVoyage || ship.condition !== "ready") throw new Error("Корабль занят или требует ремонта.");
  const quote = offer ? contractQuote(ship, offer, style) : quoteShipDeparture(ship);
  whole(budgetCopper, "бортовой бюджет");
  whole(clockQd, "время", Number.MAX_SAFE_INTEGER);
  if (budgetCopper < quote.operatingCopper) throw new Error("Бортового бюджета недостаточно для плановых расходов рейса.");
  let result = applyShipFundsOperation(fundsFor(holding, ship), { id: operationId, kind: "depart", amountCopper: budgetCopper, preparationCopper: quote.preparationCopper });
  result = applyShipFundsOperation(result.state, { id: `${operationId}:provision`, kind: "expense", amountCopper: quote.operatingCopper });
  ship.activeVoyage = {
    id: operationId, quote, startedAtQd: clockQd, lastProcessedQd: clockQd,
    elapsedQd: 0, remainingQd: quote.durationQd, ledger: []
  };
  writeFunds(holding, ship, result.state);
  return { voyageId: operationId, onboardCopper: ship.onboardCopper, durationQd: quote.durationQd };
}

export function adjustShipFunds(holding, ship, { operationId, voyageId, kind, amountCopper, reason }) {
  if (!ship.activeVoyage || ship.activeVoyage.id !== voyageId) throw new Error("Этот рейс уже завершён или изменился.");
  if (!["expense", "income"].includes(kind)) throw new Error("Неизвестная денежная операция.");
  if (!String(reason ?? "").trim()) throw new Error("Укажите причину операции.");
  whole(amountCopper, "сумма");
  const result = applyShipFundsOperation(fundsFor(holding, ship), { id: operationId, kind, amountCopper });
  if (!result.replay) result.receipt.reason = String(reason).trim().slice(0, 300);
  writeFunds(holding, ship, result.state);
  return { voyageId, onboardCopper: ship.onboardCopper };
}

function voyageDuration(voyage) {
  return whole(voyage.durationQd ?? voyage.quote.durationQd, "длительность", 100100);
}

function finalizeVoyage(holding, ship, collection, returnedAtQd, { payManualReward = false } = {}) {
  const voyage = ship.activeVoyage;
  let result = fundsFor(holding, ship);
  if (payManualReward) result = applyShipFundsOperation(result, { id: `${voyage.id}:reward`, kind: "income", amountCopper: voyage.quote.rewardCopper }).state;
  const returnedCopper = result.onboardCopper;
  result = applyShipFundsOperation(result, { id: `${voyage.id}:return`, kind: "return" }).state;
  const summary = {
    id: voyage.id, shipId: ship.id, shipName: ship.name, destination: voyage.quote.destination,
    startedAtQd: voyage.startedAtQd, returnedAtQd,
    returnedCopper, netCopper: result.receipts.reduce((total, row) => total + row.externalDeltaCopper, 0),
    ledger: result.receipts
  };
  if (voyage.quote.contract) {
    summary.contract = clone(voyage.quote.contract);
    summary.style = voyage.quote.style;
    summary.outcome = clone(voyage.outcome);
    summary.attention = clone(voyage.attentionChange);
  }
  writeFunds(holding, ship, result);
  ship.activeVoyage = null;
  collection.history = [...(collection.history ?? []), summary].slice(-100);
  return summary;
}

export function advanceShipVoyages(holding, targetQd) {
  whole(targetQd, "время", Number.MAX_SAFE_INTEGER);
  const report = { returned: [], underway: [], blocked: [], awaiting: [] };
  const collection = holding.special?.ships;
  for (const ship of collection?.list ?? []) {
    if (ship?.navigationMode === "world" || ship?.activeVoyage?.mode === "world") continue;
    if (ship?.status !== "away" || !ship.activeVoyage) continue;
    const voyage = ship.activeVoyage;
    try {
      whole(voyage.lastProcessedQd, "обработанное время", Number.MAX_SAFE_INTEGER);
      if (voyage.awaitingOutcome) {
        voyage.lastProcessedQd = Math.max(voyage.lastProcessedQd, targetQd);
        report.awaiting.push({ shipId: ship.id, name: ship.name, waitingFunds: Boolean(voyage.waitingFunds), expenseCopper: voyage.outcome?.expenseCopper ?? null });
        continue;
      }
      if (targetQd <= voyage.lastProcessedQd) continue;
      whole(voyage.elapsedQd, "прогресс", 100100);
      const durationQd = voyageDuration(voyage);
      const elapsedQd = Math.min(durationQd, voyage.elapsedQd + targetQd - voyage.lastProcessedQd);
      if (elapsedQd < durationQd) {
        voyage.elapsedQd = elapsedQd;
        voyage.remainingQd = durationQd - elapsedQd;
        voyage.lastProcessedQd = targetQd;
        report.underway.push(ship.name);
        continue;
      }
      const arrivedAtQd = voyage.lastProcessedQd + durationQd - voyage.elapsedQd;
      voyage.elapsedQd = durationQd;
      voyage.remainingQd = 0;
      voyage.lastProcessedQd = targetQd;
      if (voyage.quote.contract && !voyage.outcomeApplied) {
        voyage.awaitingOutcome = true;
        voyage.arrivedAtQd = arrivedAtQd;
        report.awaiting.push({ shipId: ship.id, name: ship.name, waitingFunds: false, expenseCopper: null });
      } else {
        report.returned.push(finalizeVoyage(holding, ship, collection, arrivedAtQd, { payManualReward: !voyage.quote.contract }));
      }
    } catch (error) {
      report.blocked.push({ shipId: ship.id, name: ship.name, message: error.message });
    }
  }
  return report;
}

function outcomeDice(random) {
  const draw = (sides) => {
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new RangeError("Генератор случайных чисел вернул значение вне диапазона 0–1.");
    return Math.floor(value * sides) + 1;
  };
  return { commercialDice: [draw(6), draw(6)], incidentRoll: draw(12) };
}

function attentionRecord(ship, contract, outcome, clockQd) {
  const key = String(contract.directionKey ?? "");
  if (!key || ["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Некорректное направление внимания.");
  const map = ship.attentionByDirection && typeof ship.attentionByDirection === "object" ? ship.attentionByDirection : {};
  const prior = Object.prototype.hasOwnProperty.call(map, key) ? map[key] : 0;
  const before = typeof prior === "object" && prior !== null ? prior.level : prior;
  const safeBefore = Number.isSafeInteger(before) ? Math.max(0, Math.min(10, before)) : 0;
  const after = Math.max(0, Math.min(10, safeBefore + outcome.attentionDelta));
  return {
    key, before: safeBefore, after,
    record: { level: after, label: attentionLabel(after), updatedAtQd: clockQd, reason: `${outcome.commercialLabel}; ${outcome.eventLabel}` }
  };
}

/** Resolve a generated contract once. Call only on the authority GM inside a transaction. */
export function resolveShipContract(holding, ship, { operationId, random = Math.random }) {
  if (typeof operationId !== "string" || !operationId.trim() || operationId.length > 128) throw new Error("Некорректный ID операции.");
  const voyage = ship?.activeVoyage;
  if (ship?.status !== "away" || !voyage?.quote?.contract || (!voyage.awaitingOutcome && !(voyage.outcome && !voyage.outcomeApplied))) {
    throw new Error("Корабль не ожидает исхода контракта.");
  }
  const clockQd = Math.max(
    whole(holding.gm?.calendaria?.lastQd ?? 0, "время поселения", Number.MAX_SAFE_INTEGER),
    whole(voyage.lastProcessedQd, "обработанное время", Number.MAX_SAFE_INTEGER)
  );
  if (!voyage.outcome) {
    voyage.outcome = resolveContractOutcome(voyage.quote.contract, voyage.quote.style, outcomeDice(random));
    voyage.outcomeOperationId = operationId;
  }
  const outcome = voyage.outcome;
  whole(outcome.expenseCopper, "расходы исхода");
  whole(outcome.rewardCopper, "награда исхода");
  whole(outcome.delayQd, "задержка", 100000);
  whole(voyage.quote.durationQd + outcome.delayQd, "длительность с задержкой", 100100);
  const attention = attentionRecord(ship, voyage.quote.contract, outcome, clockQd);
  if (ship.onboardCopper < outcome.expenseCopper) {
    voyage.awaitingOutcome = true;
    voyage.waitingFunds = true;
    return { voyageId: voyage.id, pending: true, waitingFunds: true, outcome: clone(outcome), returned: null, delayQd: outcome.delayQd };
  }
  let result = applyShipFundsOperation(fundsFor(holding, ship), { id: `${voyage.id}:contract-expense`, kind: "expense", amountCopper: outcome.expenseCopper });
  if (!result.replay) result.receipt.reason = outcome.eventLabel;
  result = applyShipFundsOperation(result.state, { id: `${voyage.id}:contract-reward`, kind: "income", amountCopper: outcome.rewardCopper });
  if (!result.replay) result.receipt.reason = outcome.commercialLabel;
  writeFunds(holding, ship, result.state);
  if (!ship.attentionByDirection || typeof ship.attentionByDirection !== "object") ship.attentionByDirection = {};
  Object.defineProperty(ship.attentionByDirection, attention.key, { value: attention.record, writable: true, enumerable: true, configurable: true });
  voyage.attentionChange = { directionKey: attention.key, before: attention.before, after: attention.after, delta: attention.after - attention.before, reason: attention.record.reason };
  voyage.outcomeApplied = true;
  voyage.awaitingOutcome = false;
  voyage.waitingFunds = false;
  if (outcome.delayQd > 0) {
    voyage.durationQd = whole(voyage.quote.durationQd + outcome.delayQd, "длительность с задержкой", 100100);
    voyage.elapsedQd = voyage.quote.durationQd;
    voyage.remainingQd = outcome.delayQd;
    voyage.lastProcessedQd = clockQd;
    return { voyageId: voyage.id, pending: false, waitingFunds: false, outcome: clone(outcome), returned: null, delayQd: outcome.delayQd };
  }
  const summary = finalizeVoyage(holding, ship, holding.special.ships, clockQd);
  return { voyageId: summary.id, pending: false, waitingFunds: false, outcome: clone(outcome), returned: summary, delayQd: 0 };
}
