import { normalizeEventRegionOptions } from "../../data/random-events.js";
import { residentShipAssignment } from "../../data/resident-presence.js";
import { disembarkShipCrew, embarkShipCrew, markCrewResidentAway } from "./crew.js";
import { recordFleetFunds } from "./fleet-accounting.js";
import { recordShipOutingFunds, settleShipOutingByGm } from "./outing-report.js";
import { configureWorldShipEconomy } from "./world-market.js";
import {
  finalizeWorldShipArrival,
  startWorldShipIdleBilling,
  worldShipHomeEndpoint,
  worldShipPortDebtCopper,
  worldShipTimelineQd
} from "./world-voyage.js";

const MAX_MONEY = 1_000_000_000;
const SHIP_CONDITIONS = new Set(["ready", "damaged", "maintenance"]);
const GM_FUNDS_MODES = new Set(["set", "income", "expense"]);

function integer(value, name, min = 0, max = MAX_MONEY) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`Некорректное значение: ${name}.`);
  }
  return value;
}

function clone(value) {
  return globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function hasPendingOwnSale(holding, shipId) {
  return (holding?.special?.market?.outbound?.orders ?? []).some((order) => order?.ownShipId === shipId
    && !["delivered", "lost", "cancelled"].includes(order.status));
}

function assertNoExternalBinding(holding, ship) {
  if (ship?.transportOrderId) throw new Error("Корабль занят транспортным заказом. Сначала завершите или отмените его в окне перевозок.");
  if (hasPendingOwnSale(holding, ship?.id)) throw new Error("У корабля есть активная продажа собственного товара. Сначала завершите её во «Внешнем рынке».");
}

export function gmShipClockBlockReason(ship, clockQd) {
  const { activeVoyage, currentOuting } = ship;
  const arrivedAtQd = activeVoyage?.arrivedAtQd ?? (activeVoyage?.awaitingOutcome ? activeVoyage.arrivalQd : 0);
  const details = Array.isArray(currentOuting?.details) ? currentOuting.details : [];
  const lastEventQd = details.reduce((latest, row) => Math.max(latest, row?.clockQd ?? 0),
    Math.max(activeVoyage?.startedAtQd ?? 0, arrivedAtQd ?? 0, currentOuting?.startedAtQd ?? 0));
  return clockQd < lastEventQd
    ? "Дата поселения раньше уже записанных событий рейса. Установите дату последнего события или более позднюю."
    : "";
}

function gmVoyageClock(ship, clockQd) {
  const clock = integer(clockQd, "время", 0, Number.MAX_SAFE_INTEGER);
  const reason = gmShipClockBlockReason(ship, clock);
  if (reason) throw new Error(reason);
  return clock;
}

function syncCrewForForeignPort(holding, ship, clockQd) {
  try {
    return embarkShipCrew(holding, ship, clockQd);
  } catch (_error) {
    // GM manual move must still succeed even if legacy crewResidentIds contain a missing or conflicting resident.
    const shipId = String(ship?.id ?? "").trim();
    const peopleById = new Map((holding?.people?.list ?? []).map((person) => [String(person?.id ?? ""), person]));
    let changed = 0;
    for (const residentId of ship?.crewResidentIds ?? []) {
      const person = peopleById.get(String(residentId));
      if (!person) continue;
      const assignment = residentShipAssignment(person);
      if (assignment?.away === true && String(assignment.shipId ?? "") !== shipId) continue;
      if (assignment?.away === true && String(assignment.shipId ?? "") === shipId) continue;
      markCrewResidentAway(holding, person, shipId, integer(clockQd, "время", 0, Number.MAX_SAFE_INTEGER));
      changed += 1;
    }
    return { ok: true, changed, shipId };
  }
}

function resolveGmDestination(data, holding, destinationKind, destinationId) {
  if (destinationKind === "home") return worldShipHomeEndpoint(holding);
  if (destinationKind !== "market") throw new Error("Укажите домашнее поселение или порт на карте.");
  const regions = normalizeEventRegionOptions(data?.catalog?.eventRegions ?? [], { fallback: false });
  const targetId = String(destinationId ?? "").trim();
  const region = regions.find((row) => String(row.value) === targetId);
  if (!region) throw new Error("Выбранный порт не найден в каталоге регионов.");
  return {
    kind: "market",
    id: String(region.value),
    regionId: String(region.value),
    label: String(region.label || region.value).slice(0, 160)
  };
}

function refreshBillingAfterGmChange(data, holding, ship, clockQd) {
  try {
    configureWorldShipEconomy(data, holding, ship);
  } catch (_error) {
    // Allow GM placement even if the route catalog is temporarily incomplete.
  }
  startWorldShipIdleBilling(ship, ship.location, clockQd);
  ship.portBilling.lastCalculatedQd = clockQd;
}

function carryOutstandingPortBill(ship, clockQd) {
  const pending = integer(ship.pendingPortBillCopper ?? 0, "долг стоянки");
  // The old billing row may have accrued charges that were never posted as pending.
  ship.pendingPortBillCopper = Math.max(pending, worldShipPortDebtCopper(ship, clockQd));
}

/** GM manual placement: move a world ship immediately to home or any known region regardless of normal workflow rules. */
export function gmMoveWorldShip(data, holding, ship, { destinationKind, destinationId = "", clockQd } = {}) {
  if (ship?.navigationMode !== "world") throw new Error("Ручное перемещение доступно для кораблей мирового рынка.");
  assertNoExternalBinding(holding, ship);
  const clock = gmVoyageClock(ship, clockQd);
  const target = resolveGmDestination(data, holding, destinationKind, destinationId);
  carryOutstandingPortBill(ship, clock);
  const cancelledVoyage = Boolean(ship.activeVoyage || ship.orderBundle);
  ship.activeVoyage = null;
  ship.orderBundle = null;
  ship.location = target;
  ship.status = target.kind === "home" ? "docked" : "away";
  ship.timelineQd = clock;
  if (target.kind === "home") {
    disembarkShipCrew(holding, ship, clock);
    settleShipOutingByGm(ship, { clockQd: clock, reason: `ГМ переместил корабль домой: ${target.label}`, finish: true });
  } else {
    syncCrewForForeignPort(holding, ship, clock);
    settleShipOutingByGm(ship, { clockQd: clock, reason: `ГМ переместил корабль в порт: ${target.label}`, finish: false });
  }
  refreshBillingAfterGmChange(data, holding, ship, clock);
  return {
    shipId: ship.id,
    location: clone(target),
    status: ship.status,
    cancelledVoyage,
    clockQd: clock
  };
}

/** GM manual condition override: switch between ready, damaged and maintenance at any time. */
export function gmSetShipCondition(ship, { condition } = {}) {
  const next = String(condition ?? "").trim();
  if (!SHIP_CONDITIONS.has(next)) throw new Error("Некорректное состояние корабля.");
  const previous = String(ship?.condition ?? "ready");
  ship.condition = next;
  return { shipId: ship.id, previousCondition: previous, condition: next };
}

/** GM manual onboard wallet override: set exact balance or add/subtract copper independently of docked/away restrictions. */
export function gmAdjustShipFunds(holding, ship, { operationId, mode = "set", amountCopper = 0, reason = "", clockQd } = {}) {
  if (ship?.navigationMode !== "world") throw new Error("Ручная корректировка кошелька доступна для кораблей мирового рынка.");
  const id = String(operationId ?? "").trim();
  if (!id || id.length > 128) throw new Error("Некорректный ID операции.");
  if (!GM_FUNDS_MODES.has(mode)) throw new Error("Некорректный режим корректировки кошелька.");
  const amount = integer(amountCopper, "сумма");
  const clock = integer(clockQd, "время", 0, Number.MAX_SAFE_INTEGER);
  const before = integer(ship.onboardCopper ?? 0, "бортовой кошелёк");
  let after = before;
  if (mode === "set") after = amount;
  else if (mode === "income") after = integer(before + amount, "итоговый бортовой кошелёк");
  else {
    if (amount > before) throw new Error("Нельзя списать больше, чем есть в бортовом кошельке.");
    after = before - amount;
  }
  const delta = after - before;
  const note = String(reason ?? "").trim().slice(0, 300) || (mode === "set" ? "ГМ задал бортовой кошелёк" : "Ручная корректировка ГМа");
  ship.onboardCopper = after;
  ship.worldLedger ??= [];
  if (delta !== 0) {
    const receipt = {
      id: `${id}:gm-funds`,
      signature: JSON.stringify(["gm-funds", mode, before, after]),
      kind: delta > 0 ? "income" : "expense",
      externalDeltaCopper: delta,
      transferToShipCopper: 0,
      reason: note
    };
    ship.worldLedger.push(receipt);
    recordFleetFunds(ship, receipt, { clockQd: clock });
    if (ship.currentOuting) recordShipOutingFunds(ship, receipt, { clockQd: clock, reason: note });
  }
  return { shipId: ship.id, mode, beforeCopper: before, onboardCopper: after, deltaCopper: delta };
}

/** GM manual instant arrival: finish in-flight travel or port delay immediately. */
export function gmArriveWorldShip(holding, ship, { clockQd } = {}) {
  if (ship?.navigationMode !== "world") throw new Error("Ускорение прибытия доступно для кораблей мирового рынка.");
  assertNoExternalBinding(holding, ship);
  const clock = gmVoyageClock(ship, clockQd);
  const voyage = ship.activeVoyage;
  if (voyage) {
    if (voyage.awaitingOutcome) throw new Error("Корабль уже прибыл и ожидает подведения итога.");
    const durationQd = integer(voyage.durationQd ?? voyage.quote?.durationQd ?? 0, "длительность", 0, 100_100);
    voyage.elapsedQd = durationQd;
    voyage.remainingQd = 0;
    voyage.lastProcessedQd = clock;
    voyage.arrivalQd = clock;
    ship.timelineQd = clock;
    if (voyage.quote?.contract && !voyage.outcomeApplied) {
      voyage.awaitingOutcome = true;
      voyage.arrivedAtQd = clock;
      ship.location = clone(voyage.quote.to);
      startWorldShipIdleBilling(ship, voyage.quote.to, clock);
      ship.portBilling.lastCalculatedQd = clock;
      return { shipId: ship.id, arrived: true, awaitingOutcome: true, location: clone(ship.location) };
    }
    const completed = finalizeWorldShipArrival(holding, ship, clock);
    if (completed.home) disembarkShipCrew(holding, ship, clock);
    return { shipId: ship.id, arrived: true, awaitingOutcome: false, home: completed.home, location: completed.location };
  }
  const bundle = ship.orderBundle;
  if (bundle?.status === "final-delay") {
    ship.orderBundle = null;
    ship.timelineQd = clock;
    if (ship.portBilling) ship.portBilling.lastCalculatedQd = clock;
    return { shipId: ship.id, arrived: true, clearedDelay: true, bundleFinished: true, location: clone(ship.location) };
  }
  if (bundle?.delayUntilQd != null && bundle.delayUntilQd > clock) {
    bundle.delayUntilQd = null;
    ship.timelineQd = clock;
    return { shipId: ship.id, arrived: true, clearedDelay: true, bundleFinished: false, location: clone(ship.location) };
  }
  throw new Error("У корабля нет активного перелёта или задержки.");
}

/** GM manual voyage/bundle cancel: cleanly clear active voyage or bundle and return the ship to port. */
export function gmCancelWorldShipVoyage(data, holding, ship, { clockQd } = {}) {
  if (ship?.navigationMode !== "world") throw new Error("Отмена рейса доступна для кораблей мирового рынка.");
  assertNoExternalBinding(holding, ship);
  if (!ship.activeVoyage && !ship.orderBundle) throw new Error("У корабля нет активного рейса или составного заказа.");
  const clock = gmVoyageClock(ship, clockQd);
  const target = ship.location?.kind === "transit"
    ? clone(ship.activeVoyage?.quote?.from ?? worldShipHomeEndpoint(holding))
    : clone(ship.location ?? worldShipHomeEndpoint(holding));
  carryOutstandingPortBill(ship, clock);
  ship.activeVoyage = null;
  ship.orderBundle = null;
  ship.location = target;
  ship.status = target.kind === "home" ? "docked" : "away";
  ship.timelineQd = clock;
  if (target.kind === "home") {
    disembarkShipCrew(holding, ship, clock);
    settleShipOutingByGm(ship, { clockQd: clock, reason: "ГМ отменил активный рейс; корабль дома", finish: true });
  } else {
    syncCrewForForeignPort(holding, ship, clock);
    settleShipOutingByGm(ship, { clockQd: clock, reason: `ГМ отменил активный рейс в порту ${target.label}`, finish: false });
  }
  refreshBillingAfterGmChange(data, holding, ship, clock);
  return { shipId: ship.id, location: clone(target), status: ship.status, clockQd: clock };
}

/** GM manual bill forgiveness: zero out pending port debt and restart idle billing cleanly from current clock. */
export function gmClearWorldShipBills(data, holding, ship, { clockQd } = {}) {
  if (ship?.navigationMode !== "world") throw new Error("Списание долгов стоянки доступно для кораблей мирового рынка.");
  const clock = integer(clockQd, "время", 0, Number.MAX_SAFE_INTEGER);
  const previousPending = integer(ship.pendingPortBillCopper ?? 0, "долг стоянки");
  ship.pendingPortBillCopper = 0;
  if (ship.portBilling) {
    ship.portBilling = {
      ...ship.portBilling,
      sinceQd: clock,
      carriedCopper: 0,
      chargedCopper: 0,
      lastCalculatedQd: clock
    };
  } else if (ship.location && ["home", "market"].includes(ship.location.kind)) {
    refreshBillingAfterGmChange(data, holding, ship, clock);
  }
  return { shipId: ship.id, clearedPendingCopper: previousPending, clockQd: clock };
}

/** GM manual clock sync: align ship timeline and billing/voyage clock markers to the current settlement date. */
export function gmSyncWorldShipClock(holding, ship, { clockQd } = {}) {
  if (ship?.navigationMode !== "world") throw new Error("Синхронизация времени доступна для кораблей мирового рынка.");
  const clock = gmVoyageClock(ship, clockQd);
  const previousQd = worldShipTimelineQd(holding, ship);
  ship.timelineQd = clock;
  if (ship.portBilling) {
    ship.portBilling.sinceQd = Math.min(ship.portBilling.sinceQd, clock);
    ship.portBilling.lastCalculatedQd = clock;
  }
  if (ship.activeVoyage) {
    ship.activeVoyage.lastProcessedQd = clock;
    if (!ship.activeVoyage.awaitingOutcome) {
      ship.activeVoyage.arrivalQd = integer(clock + Math.max(0, Number(ship.activeVoyage.remainingQd ?? 0)), "прибытие", 0, Number.MAX_SAFE_INTEGER);
    }
  }
  return { shipId: ship.id, previousQd, clockQd: clock };
}
