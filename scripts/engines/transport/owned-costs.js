import { transportOperatingCharge, transportWaitingCharge } from "./quantities.js";

export function ownedTransportActualCosts(order, state) {
  const owned = order.stages.filter((stage) => stage.service.kind === "owned");
  const first = owned[0];
  const runs = owned.flatMap((stage) => stage.receipts.map((receipt) => ({
    service: stage.service, planned: stage.runs.find((run) => run.id === receipt.runId),
    physical: state.runs.find((run) => run.id === receipt.runId)
  }))).filter((row) => row.planned && row.physical).sort((a, b) => a.physical.startQd - b.physical.startQd);
  const approachEnd = order.plan.startQd + (first.service.approachQd ?? 0);
  const waitingEnd = runs[0]?.physical.startQd ?? order.shipAbort?.decidedQd ?? approachEnd;
  let actualCopper = order.plan.shipApproachCopper + transportWaitingCharge(first.service, Math.max(0, waitingEnd - approachEnd));
  for (const [index, row] of runs.entries()) {
    actualCopper += row.planned.charge.totalCopper;
    const baseDuration = row.planned.arrivalQd - row.planned.startQd;
    const actualDuration = baseDuration + Math.max(0, row.physical.releaseQd - row.planned.releaseQd);
    actualCopper += transportOperatingCharge(row.service, actualDuration) - transportOperatingCharge(row.service, baseDuration);
    if (index) actualCopper += transportWaitingCharge(row.service, Math.max(0, row.physical.startQd - runs[index - 1].physical.releaseQd));
  }
  actualCopper += order.shipAbort?.returnCopper ?? 0;
  const paidCopper = owned.filter((stage) => stage.receipts.length).reduce((sum, stage) => sum + stage.totalCopper, 0)
    + (order.history.some((row) => row.kind === "departed") ? order.plan.approachCopper : 0);
  return { actualCopper, paidCopper, differenceCopper: actualCopper - paidCopper };
}

export function prepareOwnedTransportAbort(order, state) {
  const owned = order.stages.filter((stage) => stage.service.kind === "owned");
  if (!order.ownShipId || order.shipReleased || order.shipAbort || order.abortedFromStage == null || owned.every((stage) => stage.status === "arrived")) return;
  const first = owned[0];
  const completed = owned.flatMap((stage) => stage.receipts.filter((receipt) => receipt.status === "arrived").map((receipt) => ({ stage,
    run: state.runs.find((run) => run.id === receipt.runId) }))).filter((row) => row.run).sort((a, b) => a.run.releaseQd - b.run.releaseQd).at(-1);
  const decidedQd = order.finishedQd;
  const freeQd = Math.max(decidedQd, completed?.run.releaseQd ?? order.plan.startQd + (first.service.approachQd ?? 0));
  const service = completed?.stage.service ?? first.service;
  const returnKind = completed ? "endReturn" : "abortReturn";
  const returnBlocked = Boolean(first.service.returnAtEnd && (service[`${returnKind}Available`] === false
    || (service[`${returnKind}AccessCost`] ?? 0) > (service.emptyAccessLimit ?? Infinity)));
  const returnHome = first.service.returnAtEnd && !returnBlocked;
  const returnQd = returnHome ? completed ? completed.stage.service.endReturnQd ?? 0 : first.service.abortReturnQd ?? 0 : 0;
  order.shipAbort = { decidedQd, releaseQd: freeQd + returnQd, returnBlocked,
    location: returnHome ? service.endReturnLocation : completed?.run.to ?? first.from,
    idleUpkeepCopperPerDay: completed ? service.idleUpkeepCopperPerDay : service.startIdleUpkeepCopperPerDay ?? service.idleUpkeepCopperPerDay,
    returnCopper: transportOperatingCharge(service, returnQd, Boolean(completed)) };
}
