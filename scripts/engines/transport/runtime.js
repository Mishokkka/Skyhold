import { unreservedCargoArrivals, availableTransportCargo, allArrivalCargo, cargoQuantitiesMatch, ageTransportCargo as ageLot } from "./cargo-flow.js";
import { cargoLoad, cargoValue, transportInteger, transportMoney, shipTransportFunding, TRANSPORT_LIMITS } from "./quantities.js";
import { planTransportChain, validateTransportPlan, TransportPlanningUnavailableError } from "./planner.js";
import { activeTransportOrder, transportOrders } from "../../data/transport/state.js";
import { deterministicUnit as deterministicMarketShipmentUnit } from "../../core/seeded-unit.js";

const clone = (value) => JSON.parse(JSON.stringify(value));
const totalQty = (cargo) => cargo.reduce((sum, lot) => sum + lot.qty, 0);
const runFor = (state, id) => state.runs.find((run) => run.id === id);

function committedAllocation(run, claim) {
  return claim?.manifestReady === true && Boolean(run.incident || run.riskChecked || ["travelling", "arrived"].includes(run.status));
}

/** Physical facts are immutable even while this holding has not recorded its local receipt. */
function committedRunIds(state, order, stage) {
  const ids = new Set(stage.receipts.map(receipt => receipt.runId));
  for (const planned of stage.runs) {
    const physical = runFor(state, planned.id);
    const claim = physical?.claims.find(claim => claim.holdingId === order.holdingId && claim.orderId === order.id && claim.stage === stage.index);
    if (physical && committedAllocation(physical, claim)) ids.add(planned.id);
  }
  return ids;
}

function reserveRuns(state, order, stages) {
  for (const stage of stages) for (const planned of stage.runs) {
    let run = runFor(state, planned.id);
    if (!run) {
      const { cargo: _cargo, charge: _charge, ...physical } = planned;
      run = { ...clone(physical), reservedLoad: 0, claims: [], incident: null };
      state.runs.push(run);
    }
    if (run.status === "cancelled" || run.reservedLoad + planned.reservedLoad > run.capacity) throw new Error("Место на рейсе уже занято.");
    run.reservedLoad += planned.reservedLoad;
    run.claims.push({ holdingId: order.holdingId, orderId: order.id, stage: stage.index, load: planned.reservedLoad,
      manifestReady: stage.index === 0 && order.direction === "inbound",
      cargo: planned.cargo.map(lot => ({ lotId: lot.lotId, qty: lot.qty, ageQd: lot.ageQd ?? 0,
        ageAtQd: lot.ageAtQd ?? order.plan.startQd, shelfLifeQd: lot.shelfLifeQd ?? 0, spoiledQty: lot.spoiledQty ?? 0 })) });
  }
}

function releaseRuns(state, order, fromStage = 0, keepIds = new Set(), throughStage = Infinity) {
  for (const run of state.runs) {
    if (keepIds.has(run.id)) continue;
    const removed = run.claims.filter((claim) => claim.orderId === order.id && claim.holdingId === order.holdingId && claim.stage >= fromStage && claim.stage <= throughStage);
    if (removed.some(claim => committedAllocation(run, claim))) throw new Error("Нельзя снять груз с подтверждённого физического рейса.");
    run.reservedLoad -= removed.reduce((sum, claim) => sum + claim.load, 0);
    run.claims = run.claims.filter((claim) => !removed.includes(claim));
  }
  state.runs = state.runs.filter((run) => run.claims.length || run.status !== "booked");
}

/** Reserve a forecast event's real prerequisites before a GM freezes its outcome.
 * Only unstarted booking metadata is adopted; no receipt, warehouse, wallet or clock is copied.
 */
export function adoptProjectedTransportBookings({ state, holdings, projectedData, runId, runIds = [], prefixClaims = [], atQd = 0 }) {
  const projectedRun = projectedData.meta.transportV2.runs.find(run => run.id === runId)
    ?? (prefixClaims.length ? { claims: [], arrivalQd: atQd } : null);
  if (!projectedRun) throw new Error("Не найден расчёт происшествия.");
  const affected = [...new Set([runId, ...runIds])].flatMap(id => [
    ...(runFor(state, id)?.claims ?? []), ...(runFor(projectedData.meta.transportV2, id)?.claims ?? [])
  ]).concat(prefixClaims);
  const prefixes = new Map();
  for (const claim of affected) {
    const key = JSON.stringify([claim.holdingId, claim.orderId]);
    prefixes.set(key, Math.max(prefixes.get(key) ?? -1, claim.stage));
  }
  // A moved booking can take a slot (or a finite vehicle's time) released by
  // another forecast prefix. Adopt that dependency in the same release/reserve
  // batch, including displaced future bookings, before freezing physical facts.
  let expanded;
  do {
    expanded = false;
    for (const [key, through] of prefixes) {
      const [holdingId, orderId] = JSON.parse(key);
      const forecast = transportOrders(projectedData.holdings.find(row => row.id === holdingId)).find(row => row.id === orderId);
      for (const planned of forecast?.stages.slice(0, through + 1).flatMap(stage => stage.runs) ?? []) {
        for (const live of state.runs) {
          const sameVehicle = planned.kind !== "regular" && live.kind !== "regular"
            && (planned.shipId ? planned.shipId === live.shipId : planned.serviceId === live.serviceId && planned.vehicle === live.vehicle);
          if (live.id !== planned.id && !(sameVehicle && planned.startQd < live.releaseQd && live.startQd < planned.releaseQd)) continue;
          const projected = runFor(projectedData.meta.transportV2, live.id);
          for (const claim of live.claims) {
            const remains = projected?.claims.find(row => row.holdingId === claim.holdingId && row.orderId === claim.orderId && row.stage === claim.stage);
            if (remains?.load === claim.load && projected.startQd === live.startQd && projected.releaseQd === live.releaseQd) continue;
            const dependency = JSON.stringify([claim.holdingId, claim.orderId]);
            if ((prefixes.get(dependency) ?? -1) >= claim.stage) continue;
            prefixes.set(dependency, claim.stage); expanded = true;
          }
        }
      }
    }
  } while (expanded);
  const changes = [];
  const projectedIds = new Set(projectedData.meta.transportV2.runs.map(run => run.id));
  for (const [key, through] of prefixes) {
    const [holdingId, orderId] = JSON.parse(key);
    const order = transportOrders(holdings.find(row => row.id === holdingId)).find(row => row.id === orderId);
    const forecast = transportOrders(projectedData.holdings.find(row => row.id === holdingId)).find(row => row.id === orderId);
    if (!order || !forecast) throw new Error("Связанный заказ перевозки изменился.");
    for (const stage of order.stages.slice(0, through + 1)) {
      const forecastStage = forecast.stages[stage.index];
      const started = committedRunIds(state, order, stage);
      const planned = { ...forecastStage, runs: forecastStage.runs.filter(run => projectedIds.has(run.id)
        || forecastStage.receipts.some(receipt => receipt.runId === run.id))
        .map(run => started.has(run.id) ? stage.runs.find(original => original.id === run.id) : run) };
      if (JSON.stringify(stage.runs) === JSON.stringify(planned.runs)) continue;
      if ([...started].some(id => !planned.runs.some(run => run.id === id))) throw new Error("Расчёт изменил уже отправленную часть груза.");
      changes.push({ order, stage, planned, started, through });
    }
  }
  for (const { order, stage, started } of changes) releaseRuns(state, order, stage.index, started, stage.index);
  for (const { order, stage, through } of changes) if (stage.service.kind === "owned") {
    for (const next of order.stages.slice(stage.index + 1)) {
      if (next.service.kind !== "owned") break;
      if (next.index > through) releaseRuns(state, order, next.index, committedRunIds(state, order, next), next.index);
    }
  }
  for (const { order, stage, planned, started } of changes) {
    reserveRuns(state, order, [{ ...stage, runs: planned.runs.filter(run => !started.has(run.id)) }]);
    stage.runs = clone(planned.runs);
    delete stage.needsRebooking;
    for (const next of order.stages.slice(stage.index + 1)) next.needsRebooking = true;
    order.history.push({ kind: "rebooked", stage: stage.index, qd: Math.min(...stage.runs.map(run => run.startQd), projectedRun.incident?.atQd ?? projectedRun.arrivalQd) });
  }
  for (const [key, through] of prefixes) {
    const [holdingId, orderId] = JSON.parse(key);
    const order = transportOrders(holdings.find(row => row.id === holdingId)).find(row => row.id === orderId);
    const forecast = transportOrders(projectedData.holdings.find(row => row.id === holdingId)).find(row => row.id === orderId);
    for (const stage of order.stages.slice(0, through + 1)) {
      if (!forecast.stages[stage.index].needsRebooking) delete stage.needsRebooking;
    }
  }
}

function waitForVehicle(state, planned) {
  if (planned.kind === "regular") return { readyQd: planned.startQd };
  const preceding = state.runs.filter((run) => run.id !== planned.id && run.status !== "cancelled"
    && (planned.shipId ? run.shipId === planned.shipId : run.serviceId === planned.serviceId && run.vehicle === planned.vehicle)
    && run.startQd < planned.startQd);
  const blockedRuns = preceding.filter(run => run.status !== "arrived" || run.incident?.status === "pending");
  return { readyQd: Math.max(planned.startQd, ...preceding.map((run) => run.releaseQd)),
    pending: blockedRuns.length > 0, blockedRuns };
}

/** Earlier physical trips that still prevent this order's departures inside the period. */
export function transportVehicleDependencies(state, order, targetQd) {
  const blockers = new Map();
  for (const stage of order.stages) for (const scheduled of pendingRuns(stage)) {
    const physical = runFor(state, scheduled.id);
    if (!physical || physical.departureQd > targetQd) continue;
    const vehicle = waitForVehicle(state, physical);
    // A known late return already puts departure outside this period, even without another incident.
    if (!vehicle.pending || vehicle.readyQd + physical.departureQd - physical.startQd > targetQd) continue;
    for (const run of vehicle.blockedRuns) blockers.set(run.id, run);
  }
  return [...blockers.values()];
}

/** Runs, treasury and ship wallet must be saved by the caller's single authoritative transaction. */
export function bookTransportOrder({ state, holding, plan, services, id, direction, commercial = {}, ship = null, clockOffsetQd = 0 }) {
  if (state?.version !== 2) throw new Error("Не подготовлено состояние перевозок.");
  if (!id || transportOrders(holding).some((order) => order.id === id)) throw new Error("Заказ с этим номером уже существует.");
  if (!["inbound", "outbound"].includes(direction)) throw new Error("Неизвестное направление заказа.");
  if (plan.startQd < state.clockQd) throw new Error("Дата заказа раньше общей даты перевозок.");
  validateTransportPlan(plan, { services, runs: state.runs });
  if (plan.ownShipId && (!ship || ship.id !== plan.ownShipId || ship.transportOrderId || ship.activeVoyage || ship.orderBundle)) throw new Error("Собственный корабль занят.");
  const own = shipTransportFunding({ expensesCopper: plan.ownExpensesCopper, reserveCopper: plan.ownShipId ? commercial.reserveCopper ?? 0 : 0,
    onboardCopper: ship?.onboardCopper ?? 0 });
  const paidCommercial = transportMoney([direction === "inbound" ? cargoValue(plan.cargo) : 0, commercial.taxCopper ?? 0, commercial.insuranceCopper ?? 0]);
  const treasury = transportMoney([paidCommercial, plan.totalCopper - plan.ownExpensesCopper, own.treasuryCopper]);
  if ((holding.storage?.moneyCopper ?? 0) < treasury) throw new Error(`В казне нужно ${treasury} ММ.`);
  const order = { id, holdingId: holding.id, version: 2, clockOffsetQd, direction, status: "booked", plan: clone(plan), cargo: clone(plan.cargo),
    commercial: clone(commercial), dispatched: {}, stages: clone(plan.stages).map((stage) => ({ ...stage, status: "booked", receipts: [], received: [] })),
    stageIndex: 0, lastProcessedQd: plan.startQd, received: [], lostQty: 0, spoiledQty: 0, insurancePaidCopper: 0,
    money: { treasuryCopper: treasury, boardCopper: own.fromShipCopper, commercialSpentCopper: paidCommercial,
      escrowCopper: plan.totalCopper + own.reserveCopper, spentCopper: 0, reserveCopper: own.reserveCopper, refundedCopper: 0 },
    ownShipId: plan.ownShipId, history: [{ kind: "booked", qd: plan.startQd }] };
  reserveRuns(state, order, order.stages);
  state.clockQd = Math.max(state.clockQd, plan.startQd);
  holding.storage.moneyCopper -= treasury;
  if (plan.ownShipId) { ship.onboardCopper -= own.fromShipCopper; ship.transportOrderId = id; }
  holding.special ??= {}; holding.special.transportV2 ??= { version: 2, orders: [] };
  holding.special.transportV2.orders.push(order);
  return order;
}

/** Local receipts can lag behind a shared departure. Use the same rule in UI and authority. */
export function canCancelTransportOrder(state, order, currentQd = state?.clockQd ?? 0) {
  if (!order || !activeTransportOrder(order) || order.shipStarted || order.history.some(row => row.kind === "departed")) return false;
  const first = order.stages[0], clockQd = Math.max(state?.clockQd ?? 0, currentQd);
  if (!Number.isSafeInteger(clockQd) || !Array.isArray(state?.runs) || !first?.runs.length || first.receipts.length) return false;
  if (order.stages.some(stage => stage.runs.some(run => runFor(state, run.id)?.incident))) return false;
  return first.runs.every(planned => {
    const physical = runFor(state, planned.id);
    if (!physical || physical.status !== "booked" || physical.incident) return false;
    if (physical.departureQd > clockQd) return true;
    const vehicle = waitForVehicle(state, physical);
    // A queued charter cannot have left while its preceding vehicle is blocked.
    // Known return dates shift its earliest departure, including loading time.
    return vehicle.pending || vehicle.readyQd + physical.departureQd - physical.startQd > clockQd;
  });
}

export function cancelTransportOrder({ state, holding, order, refundCommercial = () => {} }) {
  if (order.status === "cancelled") return { replay: true };
  if (!canCancelTransportOrder(state, order)) throw new Error("Перевозка уже началась по общей дате или требует обработки; отмена недоступна.");
  releaseRuns(state, order);
  const ship = (holding.special?.ships?.list ?? []).find((row) => row.id === order.ownShipId);
  if (order.ownShipId && !ship) throw new Error("Не найден корабль для возврата денег.");
  holding.storage.moneyCopper += order.money.treasuryCopper;
  if (ship) { ship.onboardCopper += order.money.boardCopper; delete ship.transportOrderId; }
  refundCommercial(order);
  order.money.refundedCopper = order.money.treasuryCopper + order.money.boardCopper;
  order.money.escrowCopper = 0;
  order.status = "cancelled";
  return { ok: true };
}

function spend(order, amount) {
  if (amount > order.money.escrowCopper) throw new Error("Недостаточно зарезервированных денег перевозки.");
  order.money.escrowCopper -= amount;
  order.money.spentCopper += amount;
}

function incomingCargo(state, order, stage, targetQd, { includeUnreadyInputs = false } = {}) {
  if (!stage.index) return [{ arrivalQd: order.plan.startQd, cargo: order.cargo }];
  const prior = order.stages[stage.index - 1];
  return prior.runs.flatMap(planned => {
    const receipt = prior.receipts.find(row => row.runId === planned.id), physical = runFor(state, planned.id);
    if (receipt?.status === "arrived") return [{ arrivalQd: receipt.arrivalQd,
      cargo: prior.received.filter(lot => lot.deliveryRunId === planned.id) }];
    if (!physical) return includeUnreadyInputs ? [{ arrivalQd: planned.arrivalQd, cargo: planned.cargo }] : [];
    if (physical.incident?.status === "pending" && physical.incident.atQd <= targetQd
      || (!receipt && physical.departureQd <= targetQd)) {
      if (!includeUnreadyInputs) return [];
      return [{ arrivalQd: physical.arrivalQd, cargo: receipt?.cargo ?? planned.cargo }];
    }
    return [{ arrivalQd: physical.arrivalQd, cargo: receipt?.cargo ?? planned.cargo }];
  });
}

const pendingRuns = stage => stage.runs.filter(run => !stage.receipts.some(receipt => receipt.runId === run.id));

/** Late trips can be recorded first; they must not consume stock needed by earlier departures. */
function unforwardedArrivals(state, stage, arrivals) {
  return unreservedCargoArrivals(arrivals, stage.receipts.map(receipt => ({
    startQd: (runFor(state, receipt.runId) ?? stage.runs.find(run => run.id === receipt.runId)).startQd,
    cargo: receipt.cargo
  })));
}

/** Reserve ready cargo for earlier bookings before a later manifest becomes physical.
 * An unresolved early booking can claim only cargo present at its loading date.
 */
function departureCargo(state, stage, arrivals, scheduled) {
  let remaining = unforwardedArrivals(state, stage, arrivals);
  const index = stage.runs.indexOf(scheduled), startQd = runFor(state, scheduled.id).startQd;
  const earlier = pendingRuns(stage).filter(run => {
    const start = runFor(state, run.id).startQd;
    return start < startQd || start === startQd && stage.runs.indexOf(run) < index;
  }).sort((a, b) => runFor(state, a.id).startQd - runFor(state, b.id).startQd);
  for (const run of earlier) {
    const atQd = runFor(state, run.id).startQd;
    const available = new Map(availableTransportCargo(remaining, [], atQd, { age: false }).map(lot => [lot.lotId, lot.qty]));
    const cargo = run.cargo.flatMap(lot => {
      const qty = Math.min(lot.qty, available.get(lot.lotId) ?? 0);
      return qty ? [{ ...lot, qty }] : [];
    });
    remaining = unreservedCargoArrivals(remaining, [{ startQd: atQd, cargo }]);
  }
  return availableTransportCargo(remaining, [], startQd);
}

function uncommittedArrivals(state, order, stage, arrivals) {
  const committed = committedRunIds(state, order, stage);
  return unreservedCargoArrivals(unforwardedArrivals(state, stage, arrivals),
    pendingRuns(stage).filter(run => committed.has(run.id)).map(run => ({ startQd: runFor(state, run.id).startQd, cargo: run.cargo })));
}

function unknownIncoming(state, prior, targetQd) {
  return prior?.runs.some(planned => {
    const receipt = prior.receipts.find(receipt => receipt.runId === planned.id), physical = runFor(state, planned.id);
    return receipt?.status !== "arrived" && (!physical || physical.incident?.status === "pending" && physical.incident.atQd <= targetQd
      || !receipt && physical.departureQd <= targetQd);
  });
}

function stageNeedsRebooking(state, order, stage, arrivals) {
  const committed = committedRunIds(state, order, stage), pending = pendingRuns(stage).filter(run => !committed.has(run.id));
  const remaining = uncommittedArrivals(state, order, stage, arrivals);
  if (stage.needsRebooking || !cargoQuantitiesMatch(allArrivalCargo(remaining), pending.flatMap(run => run.cargo))) return true;
  const assigned = [];
  for (const planned of [...pending].sort((a, b) => a.startQd - b.startQd)) {
    const atQd = runFor(state, planned.id)?.startQd ?? planned.startQd;
    const available = new Map(availableTransportCargo(remaining, assigned, atQd).map(lot => [lot.lotId, lot.qty]));
    if (planned.cargo.some(lot => (available.get(lot.lotId) ?? 0) < lot.qty)) return true;
    assigned.push(...planned.cargo);
  }
  return false;
}

/** A shared departure can have physical facts before this claimant's manifest is ready.
 * Keep its catchable allocation; consider earlier bookings first so a later trip cannot hold early cargo.
 */
function retainSharedAllocations(state, order, stage, arrivals) {
  const retained = [];
  if (stage.service.kind !== "regular") return { retained, remaining: arrivals };
  let unassigned = arrivals, remaining = arrivals;
  for (const planned of [...pendingRuns(stage)].sort((a, b) => a.startQd - b.startQd)) {
    const physical = runFor(state, planned.id);
    const claim = physical?.claims.find(row => row.holdingId === order.holdingId && row.orderId === order.id && row.stage === stage.index);
    if (!claim || committedAllocation(physical, claim)) continue;
    const available = new Map(availableTransportCargo(unassigned, [], physical.startQd, { age: false }).map(lot => [lot.lotId, lot.qty]));
    const booked = new Map(claim.cargo.map(lot => [lot.lotId, lot.qty]));
    const cargo = planned.cargo.flatMap(lot => {
      const qty = Math.min(lot.qty, available.get(lot.lotId) ?? 0, booked.get(lot.lotId) ?? 0);
      return qty > 0 ? [{ ...lot, qty }] : [];
    });
    if (!cargo.length) continue;
    const reservation = [{ startQd: physical.startQd, cargo }];
    unassigned = unreservedCargoArrivals(unassigned, reservation);
    if (!physical.incident && !physical.riskChecked && !["travelling", "arrived"].includes(physical.status)) continue;
    retained.push({ ...planned, cargo, reservedLoad: cargoLoad(cargo) });
    remaining = unreservedCargoArrivals(remaining, reservation);
  }
  return { retained, remaining };
}

/** Rebook only unstarted allocations of this stage; other physical receipts remain immutable. */
function rebookStage(state, order, stage, arrivals, minimumQd = 0, kind = "rebooked") {
  const started = committedRunIds(state, order, stage);
  const shared = retainSharedAllocations(state, order, stage, uncommittedArrivals(state, order, stage, arrivals));
  const remaining = shared.remaining;
  const draft = { ...state, runs: clone(state.runs) };
  releaseRuns(draft, order, stage.index, started, stage.index);
  reserveRuns(draft, order, [{ ...stage, runs: shared.retained }]);
  if (stage.service.kind === "owned") {
    // Downstream reservations of this same vessel must not occupy the time
    // needed to finish its delayed feeder shuttles.
    for (const next of order.stages.slice(stage.index + 1)) {
      if (next.service.kind !== "owned") break;
      releaseRuns(draft, order, next.index, committedRunIds(state, order, next), next.index);
    }
  }
  const service = { ...stage.service, approachQd: 0, approachCopper: 0, approachSeasonal: null,
    approachAvailable: true, approachAccessCost: 0,
    returnAtEnd: stage.service.returnAtEnd && order.stages[stage.index + 1]?.service.kind !== "owned" };
  const originalStart = Math.min(...order.plan.stages[stage.index].runs.map(run => run.startQd));
  const startQd = Math.max(order.lastProcessedQd, minimumQd, originalStart);
  const replanned = remaining.length ? planTransportChain({ cargo: allArrivalCargo(remaining),
    cargoArrivals: remaining, services: [service], startQd, runs: draft.runs }).stages[0].runs : [];
  const retained = [...stage.runs.filter(run => started.has(run.id)), ...shared.retained];
  if (order.stages.reduce((sum, row) => sum + (row === stage ? retained.length + replanned.length : row.runs.length), 0) > TRANSPORT_LIMITS.runs) {
    throw new TransportPlanningUnavailableError("run-limit", "Слишком много отправлений оставшегося груза.");
  }
  reserveRuns(draft, order, [{ ...stage, runs: replanned }]);
  state.runs = draft.runs;
  stage.runs = [...retained, ...replanned].sort((a, b) => a.startQd - b.startQd);
  delete stage.needsRebooking;
  for (const next of order.stages.slice(stage.index + 1)) next.needsRebooking = true;
  order.history.push({ kind, qd: startQd, stage: stage.index });
}


function attemptRebooking(order, atQd, rebook, stageIndex = order.stageIndex) {
  try {
    rebook();
    if (order.replanFailure?.stage === stageIndex) delete order.replanFailure;
    return true;
  } catch (error) {
    if (!(error instanceof TransportPlanningUnavailableError)) throw error;
    const message = error.code === "run-limit" ? "Для оставшегося груза пока недостаточно свободной вместимости в допустимом числе отправлений." : error.message;
    const previous = order.history.findLast(row => row.stage === stageIndex
      && ["rebooking-wait", "rebooked", "vehicle-rebooked"].includes(row.kind));
    if (previous?.kind !== "rebooking-wait" || previous.reason !== message) {
      order.history.push({ kind: "rebooking-wait", qd: atQd, stage: stageIndex, reason: message });
    }
    order.replanFailure = { code: error.code, stage: stageIndex, message };
    order.status = "waitingCarrier";
    return false;
  }
}

function evaluateIncident(run) {
  if (run.incident || run.riskChecked) return;
  run.riskChecked = true;
  if (deterministicMarketShipmentUnit(`transport-v2:${run.id}`) * 10000 < (run.riskBps ?? 0)) {
    run.incident = { status: "pending", atQd: run.arrivalQd };
  }
}

const lossKey = (holdingId, orderId, stage, lotId) => JSON.stringify([holdingId, orderId, stage, lotId]);

/** Allocate one integer physical loss, independent of FIFO splitting and holding execution order. */
function allocateRunLoss(run, lossBps) {
  let scaled = 0n;
  const allocations = {};
  const lots = run.claims.flatMap(claim => (claim.cargo ?? []).map(lot => ({ ...lot,
    key: lossKey(claim.holdingId, claim.orderId, claim.stage, lot.lotId) }))).sort((a, b) => a.key.localeCompare(b.key));
  for (const lot of lots) {
    const age = lot.ageQd + Math.max(0, run.arrivalQd - lot.ageAtQd);
    const qty = lot.shelfLifeQd > 0 && age >= lot.shelfLifeQd ? 0 : Math.max(0, lot.qty - lot.spoiledQty);
    const next = scaled + BigInt(qty) * BigInt(lossBps);
    allocations[lot.key] = Number(next / 10000n - scaled / 10000n);
    scaled = next;
  }
  return allocations;
}

/** A physical run has one outcome, shared by every holding and order aboard it. */
export function resolveTransportIncident(state, runId, { outcome, delayQd = 0, lossBps = 0, atQd = state.clockQd } = {}) {
  const run = runFor(state, runId);
  if (!run?.incident || run.incident.status !== "pending") throw new Error("Этот рейс не ожидает решения.");
  if (!["success", "delay", "loss"].includes(outcome)) throw new Error("Неизвестный исход.");
  transportInteger(delayQd, "задержка", 0, 1440); transportInteger(lossBps, "потери", 0, 10000);
  if (outcome === "loss" && run.claims.some(claim => claim.manifestReady !== true)) {
    throw new Error("Сначала обработайте отправления и предыдущие участки связанных заказов: состав груза на общем рейсе ещё не определён.");
  }
  const previous = run.arrivalQd;
  run.arrivalQd = Math.max(previous, atQd) + (outcome === "delay" ? delayQd : 0);
  run.releaseQd += run.arrivalQd - previous;
  run.incident = { status: "resolved", outcome, lossBps: outcome === "loss" ? lossBps : 0, atQd: run.arrivalQd };
  if (outcome === "loss") run.incident.lossAllocations = allocateRunLoss(run, lossBps);
  return run;
}

/** Pure world draft executor; dependencies handle storage placement and ship lifecycle. */
export function advanceTransportOrders({ state, holding, targetQd, dependencies = {} }) {
  if (state?.version !== 2) return [];
  // Common calendar coordinates before the fixed epoch are valid backfill dates.
  // New bookings still require a date at or after the nonnegative common clock.
  transportInteger(targetQd, "дата исполнения", -Number.MAX_SAFE_INTEGER);
  state.clockQd = Math.max(state.clockQd, targetQd);
  const report = [];
  const queue = [...transportOrders(holding)], waiting = new Map(), processed = new Set();
  for (const order of queue) {
    if (order.status === "cancelled") continue;
    if (targetQd < order.lastProcessedQd) throw new Error("Нельзя переместить перевозку в прошлое.");
    if (order.ownShipId) dependencies.advanceShip?.(order, targetQd);
    if (!activeTransportOrder(order)) continue;
    if (typeof dependencies.receiveCargo !== "function" || (order.direction === "outbound" && typeof dependencies.dispatchCargo !== "function")) {
      throw new Error("Не подключён складской исполнитель перевозки.");
    }
    processed.add(order);
    let waitingForVehicle = false;
    const blockedBookings = new Set();
    for (let index = 0; index < order.stages.length; index++) {
      const stage = order.stages[index], prior = order.stages[index - 1];
      if (stage.status === "arrived") continue;
      if (stage.service.kind === "owned" && prior && prior.status !== "arrived"
        && (prior.service.kind === "owned" || order.stages[index + 1]?.service.kind === "owned")) {
        waitingForVehicle = true;
        continue;
      }
      const arrivals = incomingCargo(state, order, stage, targetQd);
      // Replan against both known cargo and tentative feeder promises, but dispatch
      // only actual arrivals. Unknown stock cannot erase the remainder or hold ready cargo.
      const upstreamBookingBlocked = blockedBookings.has(index - 1);
      if (upstreamBookingBlocked) blockedBookings.add(index);
      const waitingRebooking = upstreamBookingBlocked || stage.service.kind === "owned" && prior && prior.status !== "arrived"
        || prior?.runs.some(run => runFor(state, run.id)?.incident?.status === "pending")
        && pendingRuns(stage).some(run => runFor(state, run.id)?.incident?.status === "pending");
      const unknownManifest = unknownIncoming(state, prior, targetQd);
      const waitingManifest = waitingRebooking || unknownManifest;
      const planningArrivals = unknownManifest ? incomingCargo(state, order, stage, targetQd, { includeUnreadyInputs: true }) : arrivals;
      if (prior?.status === "arrived" && !allArrivalCargo(arrivals).length && !stage.receipts.length) {
        order.abortedFromStage ??= stage.index;
        releaseRuns(state, order, stage.index);
        break;
      }
      if (!waitingRebooking && stageNeedsRebooking(state, order, stage, planningArrivals)
        && !attemptRebooking(order, targetQd, () => rebookStage(state, order, stage, planningArrivals), stage.index)) {
        waitingForVehicle = true;
        blockedBookings.add(stage.index);
        continue;
      }
      let replanned = false;
      for (const scheduled of stage.runs) {
        let receipt = stage.receipts.find((row) => row.runId === scheduled.id);
        const physical = runFor(state, scheduled.id);
        if (!physical) throw new Error("Отсутствует забронированный рейс.");
        if (!receipt && physical.departureQd <= targetQd) {
          const claim = physical.claims.find(row => row.holdingId === order.holdingId && row.orderId === order.id && row.stage === stage.index);
          const committed = committedAllocation(physical, claim);
          const vehicle = waitForVehicle(state, physical);
          if (!committed && vehicle.pending) {
            waitingForVehicle = true;
            const runs = waiting.get(order) ?? new Set();
            runs.add(physical.id); waiting.set(order, runs);
            continue;
          }
          if (!committed && vehicle.readyQd > physical.startQd) {
            if (waitingRebooking) { waitingForVehicle = true; continue; }
            if (!attemptRebooking(order, targetQd, () => rebookStage(state, order, stage, planningArrivals, vehicle.readyQd, "vehicle-rebooked"), stage.index)) { waitingForVehicle = true; blockedBookings.add(stage.index); break; }
            replanned = true; break;
          }
          const available = new Map(departureCargo(state, stage, arrivals, scheduled)
            .map(lot => [lot.lotId, lot]));
          if (scheduled.cargo.some(lot => (available.get(lot.lotId)?.qty ?? 0) < lot.qty)) {
            if (waitingManifest) { waitingForVehicle = true; continue; }
            if (committed) throw new Error("В учёте не хватает груза подтверждённого рейса. Проверьте предыдущие участки перевозки.");
            if (!attemptRebooking(order, targetQd, () => rebookStage(state, order, stage, arrivals), stage.index)) { waitingForVehicle = true; blockedBookings.add(stage.index); break; }
            replanned = true; break;
          }
          const cargo = scheduled.cargo.map(lot => ageLot({ ...available.get(lot.lotId), qty: lot.qty }, physical.departureQd, order.plan.startQd));
          if (stage.index === 0 && order.direction === "outbound") dependencies.dispatchCargo?.(order, cargo, physical.departureQd);
          if (claim) claim.manifestReady = true;
          if (claim && !committed) claim.cargo = cargo.map(lot => ({ lotId: lot.lotId, qty: lot.qty,
            ageQd: lot.ageQd, ageAtQd: lot.ageAtQd, shelfLifeQd: lot.shelfLifeQd ?? 0, spoiledQty: lot.spoiledQty ?? 0 }));
          if (!stage.receipts.length) spend(order, stage.totalCopper + (stage.index === 0 ? order.plan.approachCopper : 0));
          if (stage.index === 0) for (const lot of cargo) order.dispatched[lot.lotId] = (order.dispatched[lot.lotId] ?? 0) + lot.qty;
          receipt = { runId: scheduled.id, cargo, departureQd: physical.departureQd, status: "travelling" };
          stage.receipts.push(receipt);
          if (physical.status !== "arrived") physical.status = "travelling";
          order.status = "travelling";
          order.history.push({ kind: "departed", runId: physical.id, qd: physical.departureQd });
        }
        if (!receipt || receipt.status === "arrived" || physical.arrivalQd > targetQd) continue;
        evaluateIncident(physical);
        if (physical.incident?.status === "pending") { order.status = "needsResolution"; continue; }
        const delivered = [];
        for (const original of receipt.cargo) {
          const lot = ageLot(original, physical.arrivalQd, order.plan.startQd);
          const expired = lot.shelfLifeQd > 0 && lot.ageQd >= lot.shelfLifeQd;
          const insurableQty = expired ? 0 : Math.max(0, lot.qty - (lot.spoiledQty ?? 0));
          const lost = Math.min(insurableQty, physical.incident?.lossAllocations?.[lossKey(order.holdingId, order.id, stage.index, lot.lotId)] ?? 0);
          const spoiled = expired ? lot.qty - lost : Math.min(lot.qty - lost, lot.spoiledQty ?? 0);
          order.lostQty += lost;
          order.spoiledQty += spoiled;
          if (!expired && lost && order.commercial.insuranceCoverageBps) {
            // Carry fractions of a copper across lots and receipts of the same insurance policy.
            const covered = BigInt(order.insuranceRemainder ?? 0)
              + BigInt(lost * lot.unitCopper) * BigInt(order.commercial.insuranceCoverageBps);
            const payout = Number(covered / 10000n);
            order.insuranceRemainder = Number(covered % 10000n);
            order.insurancePaidCopper += payout;
            holding.storage.moneyCopper += payout;
          }
          if (!expired && lot.qty > lost + spoiled) delivered.push({ ...lot, spoiledQty: 0, qty: lot.qty - lost - spoiled, deliveryRunId: physical.id });
        }
        receipt.status = "arrived"; receipt.arrivalQd = physical.arrivalQd;
        stage.received.push(...delivered);
        if (stage.index === order.stages.length - 1) {
          dependencies.receiveCargo?.(order, delivered, physical.arrivalQd, receipt);
          order.received.push(...delivered);
        }
        physical.status = "arrived";
      }
      if (replanned) { index--; continue; }
      const upstreamComplete = !prior || prior.status === "arrived";
      if (upstreamComplete && stage.receipts.length === stage.runs.length
        && stage.receipts.every(receipt => receipt.status === "arrived")
        && !allArrivalCargo(unforwardedArrivals(state, stage, arrivals)).length) stage.status = "arrived";
    }
    const unfinished = order.stages.findIndex(stage => stage.status !== "arrived");
    order.stageIndex = order.abortedFromStage != null || unfinished < 0 ? order.stages.length : unfinished;
    if (order.stageIndex >= order.stages.length) {
      delete order.replanFailure;
      order.status = order.received.length ? "delivered" : "lost";
      order.finishedQd = Math.max(order.plan.startQd, ...order.stages.flatMap((stage) => stage.receipts.map((row) => row.arrivalQd ?? 0)));
      dependencies.completeOrder?.(order);
      const refund = order.fundingNeededCopper ? 0 : Math.max(0, order.money.escrowCopper - order.money.reserveCopper);
      holding.storage.moneyCopper += refund;
      order.money.escrowCopper -= refund; order.money.refundedCopper += refund;
      report.push({ orderId: order.id, status: order.status, receivedQty: totalQty(order.received), spentCopper: order.money.spentCopper });
    } else {
      const inFlight = order.stages.flatMap(stage => stage.receipts).filter(receipt => receipt.status !== "arrived");
      const pending = inFlight.some(receipt => runFor(state, receipt.runId)?.incident?.status === "pending");
      order.status = pending ? "needsResolution" : waitingForVehicle || order.replanFailure ? "waitingCarrier"
        : inFlight.length ? "travelling" : "booked";
    }
    // Revisit only orders whose actual vehicle dependency became ready. A later-created
    // trip may sail first; no clock, random outcome or household action is repeated here.
    for (const [blocked, runs] of waiting) if ([...runs].some(id => {
      const physical = runFor(state, id);
      return !physical || !waitForVehicle(state, physical).pending;
    })) {
      waiting.delete(blocked);
      queue.push(blocked);
    }
  }
  // A retry still belongs to this execution interval; its rebooking floor is not the period's end.
  for (const order of processed) order.lastProcessedQd = targetQd;
  return report;
}
