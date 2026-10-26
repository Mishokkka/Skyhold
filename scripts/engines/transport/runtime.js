import { cargoValue, transportInteger, transportMoney, shipTransportFunding } from "./quantities.js";
import { planTransportChain, validateTransportPlan } from "./planner.js";
import { activeTransportOrder, transportOrders } from "../../data/transport/state.js";
import { deterministicMarketShipmentUnit } from "../market/shipment.js";

const clone = (value) => JSON.parse(JSON.stringify(value));
const totalQty = (cargo) => cargo.reduce((sum, lot) => sum + lot.qty, 0);
const runFor = (state, id) => state.runs.find((run) => run.id === id);

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
    run.claims.push({ holdingId: order.holdingId, orderId: order.id, stage: stage.index, load: planned.reservedLoad });
  }
}

function releaseRuns(state, order, fromStage = 0, keepIds = new Set()) {
  for (const run of state.runs) {
    if (keepIds.has(run.id)) continue;
    const removed = run.claims.filter((claim) => claim.orderId === order.id && claim.holdingId === order.holdingId && claim.stage >= fromStage);
    run.reservedLoad -= removed.reduce((sum, claim) => sum + claim.load, 0);
    run.claims = run.claims.filter((claim) => !removed.includes(claim));
  }
  state.runs = state.runs.filter((run) => run.claims.length || run.status !== "booked");
}

function waitForVehicle(state, planned) {
  if (planned.kind === "regular") return { readyQd: planned.startQd };
  const preceding = state.runs.filter((run) => run.id !== planned.id && run.status !== "cancelled"
    && (planned.shipId ? run.shipId === planned.shipId : run.serviceId === planned.serviceId && run.vehicle === planned.vehicle)
    && run.startQd < planned.startQd);
  if (preceding.some((run) => run.status === "booked" || run.incident?.status === "pending")) return { pending: true };
  return { readyQd: Math.max(planned.startQd, ...preceding.map((run) => run.releaseQd)) };
}

function rebookStageRemainder(state, order, stage, readyQd) {
  const started = new Set(stage.receipts.map((row) => row.runId));
  const pending = stage.runs.filter((run) => !started.has(run.id));
  releaseRuns(state, order, stage.index, started);
  const service = { ...stage.service, approachQd: 0, approachCopper: 0,
    returnAtEnd: stage.service.returnAtEnd && order.stages[stage.index + 1]?.service.kind !== "owned" };
  const replanned = planTransportChain({ cargo: pending.flatMap((run) => run.cargo).reduce((lots, lot) => {
    const existing = lots.find((row) => row.lotId === lot.lotId);
    if (existing) existing.qty += lot.qty; else lots.push({ ...lot });
    return lots;
  }, []), services: [service], startQd: readyQd, runs: state.runs }).stages[0];
  stage.runs = [...stage.runs.filter((run) => started.has(run.id)), ...replanned.runs];
  reserveRuns(state, order, [{ ...stage, runs: replanned.runs }]);
  for (const next of order.stages.slice(stage.index + 1)) next.needsRebooking = true;
  order.history.push({ kind: "vehicle-rebooked", qd: readyQd });
}

/** Runs, treasury and ship wallet must be saved by the caller's single authoritative transaction. */
export function bookTransportOrder({ state, holding, plan, services, id, direction, commercial = {}, ship = null }) {
  if (!state?.enabled || state.version !== 2) throw new Error("Перевозки v2 не включены.");
  if (!id || transportOrders(holding).some((order) => order.id === id)) throw new Error("Заказ с этим номером уже существует.");
  if (!["inbound", "outbound"].includes(direction)) throw new Error("Неизвестное направление заказа.");
  validateTransportPlan(plan, { services, runs: state.runs, startQd: state.clockQd });
  if (plan.ownShipId && (!ship || ship.id !== plan.ownShipId || ship.transportOrderId || ship.activeVoyage || ship.orderBundle)) throw new Error("Собственный корабль занят.");
  const own = shipTransportFunding({ expensesCopper: plan.ownExpensesCopper, reserveCopper: plan.ownShipId ? commercial.reserveCopper ?? 0 : 0,
    onboardCopper: ship?.onboardCopper ?? 0 });
  const paidCommercial = transportMoney([direction === "inbound" ? cargoValue(plan.cargo) : 0, commercial.taxCopper ?? 0, commercial.insuranceCopper ?? 0]);
  const treasury = transportMoney([paidCommercial, plan.totalCopper - plan.ownExpensesCopper, own.treasuryCopper]);
  if ((holding.storage?.moneyCopper ?? 0) < treasury) throw new Error(`В казне нужно ${treasury} ММ.`);
  const order = { id, holdingId: holding.id, version: 2, direction, status: "booked", plan: clone(plan), cargo: clone(plan.cargo),
    commercial: clone(commercial), dispatched: {}, stages: clone(plan.stages).map((stage) => ({ ...stage, status: "booked", receipts: [], received: [] })),
    stageIndex: 0, lastProcessedQd: plan.startQd, received: [], lostQty: 0, spoiledQty: 0, insurancePaidCopper: 0,
    money: { treasuryCopper: treasury, boardCopper: own.fromShipCopper, commercialSpentCopper: paidCommercial,
      escrowCopper: plan.totalCopper + own.reserveCopper, spentCopper: 0, reserveCopper: own.reserveCopper, refundedCopper: 0 },
    ownShipId: plan.ownShipId, history: [{ kind: "booked", qd: plan.startQd }] };
  reserveRuns(state, order, order.stages);
  holding.storage.moneyCopper -= treasury;
  if (plan.ownShipId) { ship.onboardCopper -= own.fromShipCopper; ship.transportOrderId = id; }
  holding.special ??= {}; holding.special.transportV2 ??= { version: 2, orders: [] };
  holding.special.transportV2.orders.push(order);
  return order;
}

export function cancelTransportOrder({ state, holding, order, refundCommercial = () => {} }) {
  if (order.status === "cancelled") return { replay: true };
  if (order.history.some((row) => row.kind === "departed") || order.shipStarted) throw new Error("Перевозка уже началась; отмена недоступна.");
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

function availableForNext(stage) {
  const merged = new Map();
  for (const lot of stage.received) {
    const previous = merged.get(lot.lotId);
    if (previous) { previous.qty += lot.qty; previous.ageQd = Math.max(previous.ageQd, lot.ageQd); previous.ageAtQd = Math.max(previous.ageAtQd, lot.ageAtQd); }
    else merged.set(lot.lotId, { ...lot });
  }
  return [...merged.values()];
}

function ageLot(lot, at, fallbackQd) {
  const ageQd = (lot.ageQd ?? 0) + Math.max(0, at - (lot.ageAtQd ?? fallbackQd));
  return { ...lot, ageQd, ageAtQd: at };
}

function spend(order, amount) {
  if (amount > order.money.escrowCopper) throw new Error("Недостаточно зарезервированных денег перевозки.");
  order.money.escrowCopper -= amount;
  order.money.spentCopper += amount;
}

function rebookRemaining(state, order, index, cargo, readyQd) {
  releaseRuns(state, order, index);
  const services = order.plan.stages.slice(index).map((stage) => ({ ...stage.service, approachQd: 0, approachCopper: 0 }));
  const remaining = planTransportChain({ cargo, services, startQd: readyQd, runs: state.runs });
  // Hired contracts keep their original price when a carrier misses a connection.
  const stages = remaining.stages.map((stage, offset) => ({ ...stage, index: index + offset, status: "booked", receipts: [], received: [],
    totalCopper: order.plan.stages[index + offset].totalCopper }));
  order.stages.splice(index, order.stages.length - index, ...stages);
  reserveRuns(state, order, stages);
  order.history.push({ kind: "rebooked", qd: readyQd });
}

function evaluateIncident(run) {
  if (run.incident || run.riskChecked) return;
  run.riskChecked = true;
  if (deterministicMarketShipmentUnit(`transport-v2:${run.id}`) * 10000 < (run.riskBps ?? 0)) {
    run.incident = { status: "pending", atQd: run.arrivalQd };
  }
}

/** A physical run has one outcome, shared by every holding and order aboard it. */
export function resolveTransportIncident(state, runId, { outcome, delayQd = 0, lossBps = 0, atQd = state.clockQd } = {}) {
  const run = runFor(state, runId);
  if (!run?.incident || run.incident.status !== "pending") throw new Error("Этот рейс не ожидает решения.");
  if (!["success", "delay", "loss"].includes(outcome)) throw new Error("Неизвестный исход.");
  transportInteger(delayQd, "задержка", 0, 1440); transportInteger(lossBps, "потери", 0, 10000);
  const previous = run.arrivalQd;
  run.arrivalQd = Math.max(previous, atQd) + (outcome === "delay" ? delayQd : 0);
  run.releaseQd += run.arrivalQd - previous;
  run.incident = { status: "resolved", outcome, lossBps: outcome === "loss" ? lossBps : 0, atQd: run.arrivalQd };
  return run;
}

/** Pure world draft executor; dependencies handle storage placement and ship lifecycle. */
export function advanceTransportOrders({ state, holding, targetQd, dependencies = {} }) {
  if (!state?.enabled) return [];
  transportInteger(targetQd, "дата исполнения");
  state.clockQd = Math.max(state.clockQd, targetQd);
  const report = [];
  for (const order of transportOrders(holding)) {
    if (order.status === "cancelled") continue;
    if (targetQd < order.lastProcessedQd) throw new Error("Нельзя переместить перевозку в прошлое.");
    if (order.ownShipId) dependencies.advanceShip?.(order, targetQd);
    if (!activeTransportOrder(order)) continue;
    if (typeof dependencies.receiveCargo !== "function" || (order.direction === "outbound" && typeof dependencies.dispatchCargo !== "function")) {
      throw new Error("Не подключён складской исполнитель перевозки.");
    }
    while (order.stageIndex < order.stages.length) {
      let stage = order.stages[order.stageIndex];
      const prior = order.stages[order.stageIndex - 1];
      if (!stage.receipts.length && prior) {
        const cargo = availableForNext(prior);
        if (!cargo.length) {
          releaseRuns(state, order, order.stageIndex);
          order.abortedFromStage = order.stageIndex;
          order.stageIndex = order.stages.length; break;
        }
        const ready = Math.max(...prior.receipts.map((row) => row.arrivalQd));
        if (stage.needsRebooking || ready > Math.min(...stage.runs.map((run) => run.startQd)) || totalQty(cargo) !== totalQty(stage.runs.flatMap((run) => run.cargo))) {
          rebookRemaining(state, order, order.stageIndex, cargo, Math.max(ready, order.lastProcessedQd));
          stage = order.stages[order.stageIndex];
        }
      }
      let replanned = false;
      for (const scheduled of stage.runs) {
        let receipt = stage.receipts.find((row) => row.runId === scheduled.id);
        const physical = runFor(state, scheduled.id);
        if (!physical) throw new Error("Отсутствует забронированный рейс.");
        if (!receipt && physical.departureQd <= targetQd) {
          const vehicle = waitForVehicle(state, physical);
          if (vehicle.pending) { order.status = "waitingCarrier"; break; }
          if (vehicle.readyQd > physical.startQd) {
            rebookStageRemainder(state, order, stage, vehicle.readyQd);
            replanned = true; break;
          }
          const cargo = scheduled.cargo.map((lot) => ageLot(lot, physical.departureQd, order.plan.startQd));
          if (stage.index === 0 && order.direction === "outbound") dependencies.dispatchCargo?.(order, cargo, physical.departureQd);
          if (!stage.receipts.length) spend(order, stage.totalCopper + (stage.index === 0 ? order.plan.approachCopper : 0));
          if (stage.index === 0) for (const lot of cargo) order.dispatched[lot.lotId] = (order.dispatched[lot.lotId] ?? 0) + lot.qty;
          receipt = { runId: scheduled.id, cargo, departureQd: physical.departureQd, status: "travelling" };
          stage.receipts.push(receipt);
          physical.status = "travelling";
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
          const lost = Math.floor(insurableQty * (physical.incident?.lossBps ?? 0) / 10000);
          const spoiled = expired ? lot.qty - lost : Math.min(lot.qty - lost, lot.spoiledQty ?? 0);
          order.lostQty += lost;
          order.spoiledQty += spoiled;
          if (!expired && lost && order.commercial.insuranceCoverageBps) {
            const payout = Math.floor(lost * lot.unitCopper * order.commercial.insuranceCoverageBps / 10000);
            order.insurancePaidCopper += payout;
            holding.storage.moneyCopper += payout;
          }
          if (!expired && lot.qty > lost + spoiled) delivered.push({ ...lot, spoiledQty: 0, qty: lot.qty - lost - spoiled, deliveryRunId: physical.id });
        }
        receipt.status = "arrived"; receipt.arrivalQd = physical.arrivalQd;
        stage.received.push(...delivered);
        if (stage.index === order.stages.length - 1) {
          dependencies.receiveCargo?.(order, delivered, physical.arrivalQd);
          order.received.push(...delivered);
        }
        physical.status = "arrived";
      }
      if (replanned) continue;
      if (stage.receipts.length !== stage.runs.length || stage.receipts.some((row) => row.status !== "arrived")) break;
      stage.status = "arrived";
      order.stageIndex++;
    }
    order.lastProcessedQd = targetQd;
    if (order.stageIndex >= order.stages.length) {
      order.status = order.received.length ? "delivered" : "lost";
      order.finishedQd = Math.max(order.plan.startQd, ...order.stages.flatMap((stage) => stage.receipts.map((row) => row.arrivalQd ?? 0)));
      dependencies.completeOrder?.(order);
      const refund = order.fundingNeededCopper ? 0 : Math.max(0, order.money.escrowCopper - order.money.reserveCopper);
      holding.storage.moneyCopper += refund;
      order.money.escrowCopper -= refund; order.money.refundedCopper += refund;
      report.push({ orderId: order.id, status: order.status, receivedQty: totalQty(order.received), spentCopper: order.money.spentCopper });
    }
  }
  return report;
}
